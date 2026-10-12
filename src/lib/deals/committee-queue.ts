import { isAddress, getAddress } from 'viem';
import { getDb } from '@/db';
import {
  dealProposals,
  milestoneDisputes,
  milestoneResolutionReports,
  committeeResolutionAuthorizations,
  type ResolutionReportPhase,
} from '@/db/schema';
import { SEPOLIA_CHAIN_ID, SYNQ_V2_SEPOLIA_CONFIG } from '@/lib/contracts/addresses';
import {
  readStandardV2DealData,
  readResolutionProposal,
  MilestoneStatus,
  DealState,
  type PublicClientLike,
  type StandardV2DealData,
} from '@/lib/deals/v2-deal';
import {
  deriveAuthorizedCommittee,
  synqResolutionCommitteeReadABI,
} from '@/lib/deals/v2-resolution-report';
import { synqDealV1ABI } from '@/lib/contracts/abis';
import { sepoliaPublicClient } from '@/lib/chain';
import { eq, and, desc, sql, isNotNull } from 'drizzle-orm';

import {
  type CommitteeQueueItem,
  type CommitteeSignerStatus,
  checkCommitteeSignerStatus,
} from './v2-committee-signer';

export {
  type CommitteeQueueItem,
  type CommitteeSignerStatus,
  checkCommitteeSignerStatus,
};


/**
 * Enumerates distinct candidate deal addresses from existing persisted records:
 * 1. Accepted dealProposals (where dealAddress IS NOT NULL)
 * 2. Confirmed/staged milestoneDisputes
 * 3. Confirmed/staged milestoneResolutionReports
 * 4. committeeResolutionAuthorizations
 *
 * This provides a bounded, safe enumerable set of canonical Standard V2 deals without
 * scanning blockchain logs from genesis.
 */
export async function getCandidateDealAddresses(
  limit: number = 50,
  dbInstance?: any
): Promise<string[]> {
  const db = dbInstance ?? getDb();
  const addressSet = new Set<string>();

  try {
    // 1. From dealProposals
    const proposalDeals = await db
      .select({ dealAddress: dealProposals.dealAddress })
      .from(dealProposals)
      .where(and(eq(dealProposals.chainId, SEPOLIA_CHAIN_ID), isNotNull(dealProposals.dealAddress)))
      .limit(limit);

    for (const row of proposalDeals) {
      if (row.dealAddress && isAddress(row.dealAddress)) {
        addressSet.add(row.dealAddress.toLowerCase());
      }
    }
  } catch (err) {
    // Graceful fallback if table is empty or mock db
  }

  try {
    // 2. From milestoneDisputes
    const disputeDeals = await db
      .select({ dealAddress: milestoneDisputes.dealAddress })
      .from(milestoneDisputes)
      .where(eq(milestoneDisputes.chainId, SEPOLIA_CHAIN_ID))
      .limit(limit);

    for (const row of disputeDeals) {
      if (row.dealAddress && isAddress(row.dealAddress)) {
        addressSet.add(row.dealAddress.toLowerCase());
      }
    }
  } catch (err) {}

  try {
    // 3. From milestoneResolutionReports
    const reportDeals = await db
      .select({ dealAddress: milestoneResolutionReports.dealAddress })
      .from(milestoneResolutionReports)
      .where(eq(milestoneResolutionReports.chainId, SEPOLIA_CHAIN_ID))
      .limit(limit);

    for (const row of reportDeals) {
      if (row.dealAddress && isAddress(row.dealAddress)) {
        addressSet.add(row.dealAddress.toLowerCase());
      }
    }
  } catch (err) {}

  return Array.from(addressSet);
}

/**
 * Loads actionable committee queue items for an authenticated committee signer.
 *
 * Rules:
 * - INITIAL: milestone status == Disputed (4).
 *   Authorized resolver derived via 14-day SLA window from disputeOpenedAt vs chain block timestamp.
 * - FINAL: milestone status == FinalReview (6).
 *   Authorized resolver derived strictly from stored resolutionProposal.resolver.
 *   The 14-day rule is NOT applied to FinalReview.
 *
 * Signer Authorization:
 * - Signer must be an active signer on the authorized committee.
 */
export async function getCommitteeQueueItems(params: {
  callerWallet: string;
  candidateDeals?: string[];
  publicClient?: PublicClientLike;
  dbInstance?: any;
}): Promise<CommitteeQueueItem[]> {
  const { callerWallet } = params;
  if (!callerWallet || !isAddress(callerWallet)) {
    throw new Error('Valid caller wallet address required');
  }

  const client = params.publicClient ?? sepoliaPublicClient;
  const signerStatus = await checkCommitteeSignerStatus(callerWallet, client);
  if (!signerStatus.isAnySigner) {
    throw new Error('Caller is not an active signer on any resolution committee');
  }

  const candidateAddresses = params.candidateDeals ?? (await getCandidateDealAddresses(50, params.dbInstance));
  const queueItems: CommitteeQueueItem[] = [];

  // Get current chain block timestamp
  let chainTimestamp = 0n;
  try {
    if (typeof (client as any).getBlock === 'function') {
      const block = await (client as any).getBlock({ blockTag: 'latest' });
      chainTimestamp = BigInt(block.timestamp);
    } else {
      chainTimestamp = BigInt(Math.floor(Date.now() / 1000));
    }
  } catch {
    chainTimestamp = BigInt(Math.floor(Date.now() / 1000));
  }

  const primaryResolver = SYNQ_V2_SEPOLIA_CONFIG.primaryResolver.toLowerCase();
  const emergencyResolver = SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver.toLowerCase();

  for (const rawDeal of candidateAddresses) {
    try {
      const dealData: StandardV2DealData = await readStandardV2DealData(rawDeal, client);
      if (dealData.state !== DealState.Active || dealData.isProtected) {
        continue;
      }

      for (let msIdx = 0; msIdx < dealData.milestones.length; msIdx++) {
        const ms = dealData.milestones[msIdx];

        // 1. Check INITIAL_RESOLUTION (Disputed)
        if (ms.status === MilestoneStatus.Disputed) {
          let disputeOpenedAt = 0n;
          try {
            disputeOpenedAt = await client.readContract({
              address: dealData.dealAddress,
              abi: synqDealV1ABI,
              functionName: 'milestoneDisputeOpenedAt',
              args: [BigInt(msIdx)],
            }) as bigint;
          } catch {
            disputeOpenedAt = 0n;
          }

          const derivation = deriveAuthorizedCommittee({
            primaryResolver: dealData.primaryResolver,
            emergencyResolver: dealData.emergencyResolver,
            phase: 'INITIAL_RESOLUTION',
            milestoneDisputeOpenedAt: disputeOpenedAt,
            latestBlockTimestamp: chainTimestamp,
          });

          if (!derivation.error && derivation.authorizedCommittee) {
            const authCommittee = derivation.authorizedCommittee.toLowerCase();
            const isAuthorizedForSigner =
              (authCommittee === primaryResolver && signerStatus.isPrimarySigner) ||
              (authCommittee === emergencyResolver && signerStatus.isEmergencySigner);

            if (isAuthorizedForSigner) {
              queueItems.push({
                dealAddress: dealData.dealAddress,
                milestoneId: msIdx,
                phase: 'INITIAL_RESOLUTION',
                milestoneAmount: ms.amount.toString(),
                client: dealData.client,
                freelancer: dealData.freelancer,
                status: ms.status,
                statusLabel: 'Disputed',
                submissionVersion: ms.version,
                specHash: ms.specHash,
                evidenceRootHash: ms.evidenceRootHash,
                authorizedCommittee: derivation.authorizedCommittee,
                disputeOpenedAt: disputeOpenedAt.toString(),
              });
            }
          }
        }

        // 2. Check FINAL_RESOLUTION (FinalReview)
        if (ms.status === MilestoneStatus.FinalReview) {
          let proposal;
          try {
            proposal = await readResolutionProposal(dealData.dealAddress, msIdx, client);
          } catch {
            proposal = null;
          }

          if (proposal && proposal.resolver && isAddress(proposal.resolver)) {
            const derivation = deriveAuthorizedCommittee({
              primaryResolver: dealData.primaryResolver,
              emergencyResolver: dealData.emergencyResolver,
              phase: 'FINAL_RESOLUTION',
              milestoneDisputeOpenedAt: 0n,
              latestBlockTimestamp: chainTimestamp,
              storedResolutionResolver: proposal.resolver,
            });

            if (!derivation.error && derivation.authorizedCommittee) {
              const authCommittee = derivation.authorizedCommittee.toLowerCase();
              const isAuthorizedForSigner =
                (authCommittee === primaryResolver && signerStatus.isPrimarySigner) ||
                (authCommittee === emergencyResolver && signerStatus.isEmergencySigner);

              if (isAuthorizedForSigner) {
                queueItems.push({
                  dealAddress: dealData.dealAddress,
                  milestoneId: msIdx,
                  phase: 'FINAL_RESOLUTION',
                  milestoneAmount: ms.amount.toString(),
                  client: dealData.client,
                  freelancer: dealData.freelancer,
                  status: ms.status,
                  statusLabel: 'Final Review',
                  submissionVersion: ms.version,
                  specHash: ms.specHash,
                  evidenceRootHash: ms.evidenceRootHash,
                  authorizedCommittee: derivation.authorizedCommittee,
                  reconsiderationDeadline: proposal.reconsiderationDeadline.toString(),
                });
              }
            }
          }
        }
      }
    } catch (dealErr) {
      // Ignore unparseable deals
    }
  }

  return queueItems;
}
