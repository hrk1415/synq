import { isAddress, getAddress } from 'viem';
import { SYNQ_V2_SEPOLIA_CONFIG } from '@/lib/contracts/addresses';
import {
  type ResolutionReportPhase,
  synqResolutionCommitteeReadABI,
} from '@/lib/deals/v2-resolution-report';
import { MilestoneStatus, type PublicClientLike } from '@/lib/deals/v2-deal';
import { sepoliaPublicClient } from '@/lib/chain';

export interface CommitteeQueueItem {
  dealAddress: `0x${string}`;
  milestoneId: number;
  phase: ResolutionReportPhase;
  milestoneAmount: string; // USDC base units
  client: `0x${string}`;
  freelancer: `0x${string}`;
  status: MilestoneStatus;
  statusLabel: string;
  submissionVersion: number;
  specHash: `0x${string}`;
  evidenceRootHash: `0x${string}`;
  authorizedCommittee: `0x${string}`;
  disputeOpenedAt?: string;
  reconsiderationDeadline?: string;
  reportStatus?: 'staged' | 'confirmed' | null;
  reportId?: string | null;
  authorizationStatus?: 'collecting' | 'threshold_ready' | 'invalidated' | 'expired' | 'executed' | null;
  authorizationId?: string | null;
  signatureCount?: number;
}

export interface CommitteeSignerStatus {
  isPrimarySigner: boolean;
  isEmergencySigner: boolean;
  isAnySigner: boolean;
}

/**
 * Checks on-chain whether a wallet is an active signer on Primary and/or Emergency resolvers.
 * Pure contract read — completely client-safe (no DB imports).
 */
export async function checkCommitteeSignerStatus(
  walletAddress: string,
  publicClient: PublicClientLike = sepoliaPublicClient
): Promise<CommitteeSignerStatus> {
  if (!walletAddress || !isAddress(walletAddress)) {
    return { isPrimarySigner: false, isEmergencySigner: false, isAnySigner: false };
  }

  const checksummed = getAddress(walletAddress);
  const primaryResolver = SYNQ_V2_SEPOLIA_CONFIG.primaryResolver as `0x${string}`;
  const emergencyResolver = SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver as `0x${string}`;

  const [isPrimary, isEmergency] = await Promise.all([
    publicClient.readContract({
      address: primaryResolver,
      abi: synqResolutionCommitteeReadABI,
      functionName: 'isSigner',
      args: [checksummed],
    }).catch(() => false) as Promise<boolean>,
    publicClient.readContract({
      address: emergencyResolver,
      abi: synqResolutionCommitteeReadABI,
      functionName: 'isSigner',
      args: [checksummed],
    }).catch(() => false) as Promise<boolean>,
  ]);

  return {
    isPrimarySigner: Boolean(isPrimary),
    isEmergencySigner: Boolean(isEmergency),
    isAnySigner: Boolean(isPrimary || isEmergency),
  };
}
