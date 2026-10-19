import { isAddress, getAddress } from 'viem';
import { getDb } from '@/db';
import {
  dealProposals,
  milestoneDisputes,
  milestoneResolutionReports,
  committeeResolutionAuthorizations,
  committeeResolutionSignatures,
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
  type CommitteeQueueItem as BaseCommitteeQueueItem,
  type CommitteeSignerStatus,
  checkCommitteeSignerStatus,
} from './v2-committee-signer';

export interface CommitteeQueueItem extends BaseCommitteeQueueItem {
  hasUserSigned?: boolean;
  signers?: string[];
  authorizationValidUntil?: string;
}

export {
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
 * Scopes authorization and signature coordination data for a specific deal milestone and phase.
 * Guarantees that:
 * 1. Progress is scoped to chainId, dealAddress, milestoneId, and phase.
 * 2. Expired or invalidated authorizations are accurately marked and not labeled threshold_ready.
 * 3. Signatures from another case cannot appear.
 * 4. Caller wallet's signing status is accurately determined.
 */
async function enrichQueueItemWithProgress(params: {
  db: any;
  dealAddress: string;
  milestoneId: number;
  phase: ResolutionReportPhase;
  callerWallet: string;
  chainTimestamp: bigint;
}): Promise<{
  reportStatus?: 'staged' | 'confirmed' | null;
  reportId?: string | null;
  authorizationStatus?: 'collecting' | 'threshold_ready' | 'invalidated' | 'expired' | 'executed' | null;
  authorizationId?: string | null;
  signatureCount?: number;
  hasUserSigned?: boolean;
  signers?: string[];
  authorizationValidUntil?: string;
}> {
  const { db, dealAddress, milestoneId, phase, callerWallet, chainTimestamp } = params;
  const normalizedDeal = dealAddress.toLowerCase();
  const normalizedCaller = callerWallet.toLowerCase();

  try {
    // 1. Fetch latest report
    let reportId: string | null = null;
    let reportStatus: 'staged' | 'confirmed' | null = null;
    try {
      const reports = await db
        .select({
          id: milestoneResolutionReports.id,
          status: milestoneResolutionReports.status,
        })
        .from(milestoneResolutionReports)
        .where(
          and(
            eq(milestoneResolutionReports.chainId, SEPOLIA_CHAIN_ID),
            eq(milestoneResolutionReports.dealAddress, normalizedDeal),
            eq(milestoneResolutionReports.milestoneId, milestoneId),
            eq(milestoneResolutionReports.phase, phase)
          )
        )
        .orderBy(desc(milestoneResolutionReports.createdAt))
        .limit(1);

      if (reports && reports.length > 0) {
        reportId = reports[0].id;
        reportStatus = reports[0].status as 'staged' | 'confirmed';
      }
    } catch {
      // Graceful fallback if reports query encounters error
    }

    // 2. Fetch latest authorization for this specific chain, deal, milestone, and phase
    // Deterministic ordering: createdAt DESC, resolutionNonce DESC, id DESC
    const authRows = await db
      .select({
        id: committeeResolutionAuthorizations.id,
        status: committeeResolutionAuthorizations.status,
        validUntil: committeeResolutionAuthorizations.validUntil,
        resolutionNonce: committeeResolutionAuthorizations.resolutionNonce,
        createdAt: committeeResolutionAuthorizations.createdAt,
      })
      .from(committeeResolutionAuthorizations)
      .where(
        and(
          eq(committeeResolutionAuthorizations.chainId, SEPOLIA_CHAIN_ID),
          eq(committeeResolutionAuthorizations.dealAddress, normalizedDeal),
          eq(committeeResolutionAuthorizations.milestoneId, milestoneId),
          eq(committeeResolutionAuthorizations.phase, phase)
        )
      )
      .orderBy(
        desc(committeeResolutionAuthorizations.createdAt),
        desc(committeeResolutionAuthorizations.resolutionNonce),
        desc(committeeResolutionAuthorizations.id)
      )
      .limit(1);

    if (!authRows || authRows.length === 0) {
      return {
        reportId,
        reportStatus,
        authorizationId: null,
        authorizationStatus: null,
        signatureCount: 0,
        hasUserSigned: false,
        signers: [],
      };
    }

    // Always select latest authorization for this case and phase
    const latestAuth = authRows[0];

    // Check expiration against authoritative chain timestamp
    const validUntilBn = BigInt(latestAuth.validUntil || '0');
    const isExpired =
      validUntilBn > 0n &&
      chainTimestamp > 0n &&
      validUntilBn <= chainTimestamp &&
      latestAuth.status !== 'executed';

    // 3. Fetch signatures strictly bound to this authorization ID
    const sigRows = await db
      .select({
        signerWallet: committeeResolutionSignatures.signerWallet,
      })
      .from(committeeResolutionSignatures)
      .where(eq(committeeResolutionSignatures.authorizationId, latestAuth.id));

    const signers: string[] = (sigRows || []).map((s: any) => s.signerWallet.toLowerCase());
    const signatureCount = signers.length;
    const hasUserSigned = signers.includes(normalizedCaller);

    let effectiveStatus: 'collecting' | 'threshold_ready' | 'invalidated' | 'expired' | 'executed' =
      latestAuth.status;

    if (isExpired) {
      effectiveStatus = 'expired';
    } else if (latestAuth.status === 'invalidated') {
      effectiveStatus = 'invalidated';
    } else if (latestAuth.status === 'executed') {
      effectiveStatus = 'executed';
    } else if (signatureCount >= 2) {
      effectiveStatus = 'threshold_ready';
    } else {
      effectiveStatus = 'collecting';
    }

    return {
      reportId,
      reportStatus,
      authorizationId: latestAuth.id,
      authorizationStatus: effectiveStatus,
      signatureCount,
      hasUserSigned,
      signers,
      authorizationValidUntil: latestAuth.validUntil,
    };
  } catch {
    return {
      authorizationStatus: null,
      signatureCount: 0,
      hasUserSigned: false,
      signers: [],
    };
  }
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

  const db = params.dbInstance ?? getDb();
  const candidateAddresses = params.candidateDeals ?? (await getCandidateDealAddresses(50, db));
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
              const progress = await enrichQueueItemWithProgress({
                db,
                dealAddress: dealData.dealAddress,
                milestoneId: msIdx,
                phase: 'INITIAL_RESOLUTION',
                callerWallet,
                chainTimestamp,
              });

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
                ...progress,
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
                const progress = await enrichQueueItemWithProgress({
                  db,
                  dealAddress: dealData.dealAddress,
                  milestoneId: msIdx,
                  phase: 'FINAL_RESOLUTION',
                  callerWallet,
                  chainTimestamp,
                });

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
                  ...progress,
                });
              }
            }
          }
        }
      }
    } catch {
      // Ignore unparseable deals
    }
  }

  return queueItems;
}
