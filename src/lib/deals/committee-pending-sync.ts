import { isAddress } from 'viem';
import { getDb } from '@/db';
import {
  committeeResolutionAuthorizations,
  committeeResolutionSignatures,
  type ResolutionReportPhase,
  type CommitteeAuthorizationStatus,
} from '@/db/schema';
import { SEPOLIA_CHAIN_ID, SYNQ_V2_SEPOLIA_CONFIG } from '@/lib/contracts/addresses';
import { synqDealV1ABI } from '@/lib/contracts/abis';
import { MilestoneStatus, type PublicClientLike } from '@/lib/deals/v2-deal';
import { sepoliaPublicClient } from '@/lib/chain';
import { checkCommitteeSignerStatus } from '@/lib/deals/committee-queue';
import { and, eq, ne, inArray, desc } from 'drizzle-orm';

export interface PendingSyncItem {
  authorizationId: string;
  reportId: string;
  dealAddress: string;
  milestoneId: number;
  phase: ResolutionReportPhase;
  phaseLabel: string;
  resolutionNonce: string;
  freelancerAmount: string;
  clientAmount: string;
  authorizationStatus: CommitteeAuthorizationStatus;
  onChainMilestoneStatus: number;
  onChainMilestoneStatusLabel: string;
  signatureCount: number;
  createdAt: string;
}

/**
 * Discovers committee authorizations that:
 * 1. Have reached signature threshold (2/2) but have not been reconciled as 'executed'.
 * 2. Have a corresponding on-chain milestone in the post-submission state:
 *    - INITIAL_RESOLUTION -> MilestoneStatus.ResolutionProposed (5)
 *    - FINAL_RESOLUTION -> MilestoneStatus.SettledSplit (9)
 * 3. Are strictly accessible to the authenticated caller wallet.
 */
export async function getPendingSyncAuthorizations(params: {
  callerWallet: string;
  limit?: number;
  offset?: number;
  publicClient?: PublicClientLike;
  dbInstance?: any;
}): Promise<PendingSyncItem[]> {
  const { callerWallet } = params;
  if (!callerWallet || !isAddress(callerWallet)) {
    throw new Error('Valid caller wallet address required');
  }

  const client = params.publicClient ?? sepoliaPublicClient;
  const signerStatus = await checkCommitteeSignerStatus(callerWallet, client);
  if (!signerStatus.isAnySigner) {
    throw new Error('Caller is not an active signer on any resolution committee');
  }

  const authorizedCommittees: string[] = [];
  if (signerStatus.isPrimarySigner) {
    authorizedCommittees.push(SYNQ_V2_SEPOLIA_CONFIG.primaryResolver.toLowerCase());
  }
  if (signerStatus.isEmergencySigner) {
    authorizedCommittees.push(SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver.toLowerCase());
  }

  if (authorizedCommittees.length === 0) {
    return [];
  }

  const db = params.dbInstance ?? getDb();

  const queryLimit = Math.min(Math.max(params.limit ?? 50, 1), 100);
  const queryOffset = Math.max(params.offset ?? 0, 0);

  // Bounded query for threshold_ready authorizations for committees where caller is an active member.
  // Filtering for 'threshold_ready' in SQL ensures draft 'collecting' records (with < 2 signatures)
  // do not starve executed-but-unreconciled authorizations from the candidate window.
  const candidates = await db
    .select({
      id: committeeResolutionAuthorizations.id,
      reportId: committeeResolutionAuthorizations.reportId,
      dealAddress: committeeResolutionAuthorizations.dealAddress,
      milestoneId: committeeResolutionAuthorizations.milestoneId,
      phase: committeeResolutionAuthorizations.phase,
      resolutionNonce: committeeResolutionAuthorizations.resolutionNonce,
      freelancerAmount: committeeResolutionAuthorizations.freelancerAmount,
      clientAmount: committeeResolutionAuthorizations.clientAmount,
      status: committeeResolutionAuthorizations.status,
      createdAt: committeeResolutionAuthorizations.createdAt,
    })
    .from(committeeResolutionAuthorizations)
    .where(
      and(
        eq(committeeResolutionAuthorizations.chainId, SEPOLIA_CHAIN_ID),
        eq(committeeResolutionAuthorizations.status, 'threshold_ready'),
        inArray(committeeResolutionAuthorizations.committeeAddress, authorizedCommittees)
      )
    )
    .orderBy(desc(committeeResolutionAuthorizations.createdAt))
    .limit(queryLimit)
    .offset(queryOffset);

  const pendingItems: PendingSyncItem[] = [];

  for (const auth of candidates) {
    // 1. Signature count verification: Must have at least 2 signatures or threshold_ready
    const sigRows = await db
      .select({ id: committeeResolutionSignatures.id })
      .from(committeeResolutionSignatures)
      .where(eq(committeeResolutionSignatures.authorizationId, auth.id));

    const signatureCount = sigRows.length;
    if (signatureCount < 2 && auth.status !== 'threshold_ready') {
      continue;
    }

    // 2. Read on-chain milestone status via readContract
    try {
      const ms = (await client.readContract({
        address: auth.dealAddress as `0x${string}`,
        abi: synqDealV1ABI,
        functionName: 'getMilestone',
        args: [BigInt(auth.milestoneId)],
      })) as any;

      const onChainStatus = Number(ms.status);
      const isInitial = auth.phase === 'INITIAL_RESOLUTION';
      const expectedStatus = isInitial
        ? MilestoneStatus.ResolutionProposed // 5
        : MilestoneStatus.SettledSplit; // 9

      // Only include if on-chain status matches the post-submission state
      if (onChainStatus === expectedStatus) {
        pendingItems.push({
          authorizationId: auth.id,
          reportId: auth.reportId,
          dealAddress: auth.dealAddress,
          milestoneId: auth.milestoneId,
          phase: auth.phase,
          phaseLabel: isInitial ? 'Initial Resolution' : 'Final Resolution',
          resolutionNonce: auth.resolutionNonce,
          freelancerAmount: auth.freelancerAmount,
          clientAmount: auth.clientAmount,
          authorizationStatus: auth.status,
          onChainMilestoneStatus: onChainStatus,
          onChainMilestoneStatusLabel: isInitial ? 'ResolutionProposed (5)' : 'SettledSplit (9)',
          signatureCount,
          createdAt: auth.createdAt ? auth.createdAt.toISOString() : new Date().toISOString(),
        });
      }
    } catch {
      // Ignore network / contract read errors for individual candidates gracefully
    }
  }

  return pendingItems;
}
