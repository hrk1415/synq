/**
 * Synq Standard V2 Deal Details & Exact USDC Funding Engine
 *
 * Core primitives, read model, pure validation rules, and preflight checks
 * for Standard V2 Deal instances deployed via SynqFactoryV2.
 *
 * Canonical Protocol Rules:
 * - Deal instances are deployed as ERC-1167 clones of SynqDealV1
 * - Membership verified via canonical SynqFactoryV2.isSynqDeal(address)
 * - Escrow asset is strictly canonical Sepolia USDC (0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238)
 * - Funding requires exact approval amount (totalEscrow), NEVER MaxUint256
 * - fundDeal() is nonpayable, takes zero arguments, and requires DealState.Draft
 * - All financial values are strictly bigint base units (6 decimals)
 */

import { isAddress, getAddress, keccak256, toHex, decodeEventLog } from 'viem';
import { SYNQ_V2_SEPOLIA_CONFIG, SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { synqDealV1ABI, synqFactoryV2ABI, erc20ABI } from '@/lib/contracts/abis';
import { formatUsdcAmount, ZERO_BYTES32 } from '@/lib/deals/v2';

// --- Solidity Enums (contracts/v1/SynqDealTypes.sol) ---

export enum DealState {
  Draft = 0,
  Active = 1,
  Completed = 2,
  TerminatedEarly = 3,
  Cancelled = 4,
}

export const DEAL_STATE_LABELS: Record<DealState, string> = {
  [DealState.Draft]: 'Draft',
  [DealState.Active]: 'Active',
  [DealState.Completed]: 'Completed',
  [DealState.TerminatedEarly]: 'Terminated Early',
  [DealState.Cancelled]: 'Cancelled',
} as const;

export enum MilestoneStatus {
  Pending = 0,
  InProgress = 1,
  Submitted = 2,
  RevisionRequested = 3,
  Disputed = 4,
  ResolutionProposed = 5,
  FinalReview = 6,
  SettledPaid = 7,
  SettledRefunded = 8,
  SettledSplit = 9,
  AssessmentPending = 10,
  AssessmentProposed = 11,
}

export const MILESTONE_STATUS_LABELS: Record<MilestoneStatus, string> = {
  [MilestoneStatus.Pending]: 'Pending',
  [MilestoneStatus.InProgress]: 'In Progress',
  [MilestoneStatus.Submitted]: 'Submitted',
  [MilestoneStatus.RevisionRequested]: 'Revision Requested',
  [MilestoneStatus.Disputed]: 'Disputed',
  [MilestoneStatus.ResolutionProposed]: 'Resolution Proposed',
  [MilestoneStatus.FinalReview]: 'Final Review',
  [MilestoneStatus.SettledPaid]: 'Settled (Paid)',
  [MilestoneStatus.SettledRefunded]: 'Settled (Refunded)',
  [MilestoneStatus.SettledSplit]: 'Settled (Split)',
  [MilestoneStatus.AssessmentPending]: 'Assessment Pending',
  [MilestoneStatus.AssessmentProposed]: 'Assessment Proposed',
} as const;

export enum SettlementType {
  None = 0,
  ClientApproval = 1,
  StandardReviewTimeout = 2,
  ExpiredRefund = 3,
  MutualSettlement = 4,
  ResolverResolution = 5,
  AssessmentSettlement = 6,
}

export const SETTLEMENT_TYPE_LABELS: Record<SettlementType, string> = {
  [SettlementType.None]: 'None',
  [SettlementType.ClientApproval]: 'Client Approval',
  [SettlementType.StandardReviewTimeout]: 'Review Timeout',
  [SettlementType.ExpiredRefund]: 'Expired Refund',
  [SettlementType.MutualSettlement]: 'Mutual Settlement',
  [SettlementType.ResolverResolution]: 'Resolver Resolution',
  [SettlementType.AssessmentSettlement]: 'Assessment Settlement',
} as const;


// --- Data Types ---

export interface StandardV2OnChainMilestone {
  index: number;
  amount: bigint;
  workDeadline: bigint;
  reviewWindow: bigint;
  gracePeriod: bigint;
  status: MilestoneStatus;
  specHash: `0x${string}`;
  evidenceRootHash: `0x${string}`;
  submittedAt: bigint;
  version: number;
  proposedRevisionDeadline?: bigint;
  revisionRequestedAt?: bigint;
}

export interface StandardV2DealData {
  dealAddress: `0x${string}`;
  client: `0x${string}`;
  freelancer: `0x${string}`;
  usdc: `0x${string}`;
  state: DealState;
  totalEscrow: bigint;
  totalSettled: bigint;
  milestoneCount: number;
  milestones: StandardV2OnChainMilestone[];
  isProtected: boolean;
  policyId: `0x${string}`;
  primaryResolver: `0x${string}`;
  emergencyResolver: `0x${string}`;
}

export interface StandardV2ResolutionProposal {
  freelancerAmount: bigint;
  clientAmount: bigint;
  justificationHash: `0x${string}`;
  proposedAt: bigint;
  reconsiderationDeadline: bigint;
  resolver: `0x${string}`;
}

export type DealParticipantRole = 'client' | 'freelancer' | 'third_party' | 'unconnected';

export interface FundingEligibilityResult {
  canFund: boolean;
  role: DealParticipantRole;
  requiresApproval: boolean;
  approvalAmount: bigint;
  hasInsufficientBalance: boolean;
  reason?: string;
}

/** Revision response window on Synq Deal V1 contracts (48 hours). */
export const REVISION_RESPONSE_WINDOW = 48n * 3600n; // 172800 seconds

// --- Topic 0 for DealFunded(address indexed dealAddress, uint256 totalEscrow) ---
export const DEAL_FUNDED_TOPIC0 = keccak256(toHex('DealFunded(address,uint256)'));

// --- Topic 0 for MilestoneStarted(uint256 indexed milestoneId) ---
export const MILESTONE_STARTED_TOPIC0 = keccak256(toHex('MilestoneStarted(uint256)'));

// --- Topic 0 for MilestoneSubmitted(uint256 indexed milestoneId, bytes32 indexed evidenceRootHash, bytes32 specHash, uint8 version) ---
export const MILESTONE_SUBMITTED_TOPIC0 = keccak256(toHex('MilestoneSubmitted(uint256,bytes32,bytes32,uint8)'));

// --- Topic 0 for MilestoneSettled(uint256 indexed milestoneId, uint256 paidToFreelancer, uint256 refundedToClient, SettlementType settlementType) ---
export const MILESTONE_SETTLED_TOPIC0 = keccak256(toHex('MilestoneSettled(uint256,uint256,uint256,uint8)'));

// --- Topic 0 for RevisionAccepted(uint256 indexed milestoneId, uint64 newDeadline) ---
export const REVISION_ACCEPTED_TOPIC0 = keccak256(toHex('RevisionAccepted(uint256,uint64)'));

// --- Topic 0 for RevisionDeclined(uint256 indexed milestoneId) ---
export const REVISION_DECLINED_TOPIC0 = keccak256(toHex('RevisionDeclined(uint256)'));

// --- Topic 0 for MilestoneDisputed(uint256 indexed milestoneId, address indexed opener, bytes32 reasonHash) ---
export const MILESTONE_DISPUTED_TOPIC0 = keccak256(toHex('MilestoneDisputed(uint256,address,bytes32)'));

// --- Topic 0 for ResolutionProposed(uint256 indexed milestoneId, address indexed resolver, uint256 freelancerAmount, uint256 clientAmount, bytes32 justificationHash, uint64 reconsiderationDeadline) ---
export const RESOLUTION_PROPOSED_TOPIC0 = keccak256(toHex('ResolutionProposed(uint256,address,uint256,uint256,bytes32,uint64)'));

// --- Topic 0 for FinalReconsiderationRequested(uint256 indexed milestoneId, address indexed participant) ---
export const FINAL_RECONSIDERATION_REQUESTED_TOPIC0 = keccak256(toHex('FinalReconsiderationRequested(uint256,address)'));

// --- Topic 0 for ResolutionExecuted(uint256 indexed milestoneId, address indexed resolver, uint256 freelancerAmount, uint256 clientAmount) ---
export const RESOLUTION_EXECUTED_TOPIC0 = keccak256(toHex('ResolutionExecuted(uint256,address,uint256,uint256)'));


// --- Pure Helper Functions ---

/**
 * Pure validation of V2 Deal Identity given known on-chain parameters.
 * Fail-closed if address is malformed, not factory registered, or USDC token differs from canonical.
 */
export function verifyV2DealIdentitySync(params: {
  dealAddress: string;
  isFactoryRegistered: boolean;
  dealUsdc: string;
}): { valid: boolean; error?: string } {
  if (!isAddress(params.dealAddress)) {
    return { valid: false, error: `Invalid deal address: ${params.dealAddress}` };
  }

  if (!params.isFactoryRegistered) {
    return {
      valid: false,
      error: `Deal ${params.dealAddress} is not registered in canonical SynqFactoryV2 (${SYNQ_V2_SEPOLIA_CONFIG.factory})`,
    };
  }

  if (params.dealUsdc.toLowerCase() !== SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc.toLowerCase()) {
    return {
      valid: false,
      error: `Deal USDC address (${params.dealUsdc}) does not match canonical Sepolia USDC (${SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc})`,
    };
  }

  return { valid: true };
}

/**
 * Determine caller role on a Standard V2 Deal.
 */
export function determineDealRole(
  connectedWallet: string | undefined | null,
  clientAddress: string,
  freelancerAddress: string
): DealParticipantRole {
  if (!connectedWallet || !isAddress(connectedWallet)) {
    return 'unconnected';
  }
  const normalizedConnected = connectedWallet.toLowerCase();
  if (normalizedConnected === clientAddress.toLowerCase()) {
    return 'client';
  }
  if (normalizedConnected === freelancerAddress.toLowerCase()) {
    return 'freelancer';
  }
  return 'third_party';
}

/**
 * Determine funding eligibility and required UX steps for a connected user.
 * Pure logic using exact bigint arithmetic.
 */
export function determineFundingEligibility(params: {
  connectedWallet: string | undefined | null;
  clientAddress: string;
  freelancerAddress: string;
  chainId: number | undefined;
  dealState: DealState;
  totalEscrow: bigint;
  usdcBalance: bigint;
  usdcAllowance: bigint;
}): FundingEligibilityResult {
  const role = determineDealRole(params.connectedWallet, params.clientAddress, params.freelancerAddress);

  if (role === 'unconnected') {
    return {
      canFund: false,
      role: 'unconnected',
      requiresApproval: false,
      approvalAmount: 0n,
      hasInsufficientBalance: false,
      reason: 'Wallet not connected. Connect your wallet to fund this deal.',
    };
  }

  if (role !== 'client') {
    return {
      canFund: false,
      role,
      requiresApproval: false,
      approvalAmount: 0n,
      hasInsufficientBalance: false,
      reason: 'Awaiting client funding. Only the designated client can fund this deal.',
    };
  }

  if (params.chainId !== SEPOLIA_CHAIN_ID) {
    return {
      canFund: false,
      role: 'client',
      requiresApproval: false,
      approvalAmount: 0n,
      hasInsufficientBalance: false,
      reason: 'Please switch your wallet to Ethereum Sepolia to fund this deal.',
    };
  }

  if (params.dealState !== DealState.Draft) {
    const stateLabel = DEAL_STATE_LABELS[params.dealState] ?? `Unknown (${params.dealState})`;
    return {
      canFund: false,
      role: 'client',
      requiresApproval: false,
      approvalAmount: 0n,
      hasInsufficientBalance: false,
      reason: params.dealState === DealState.Active
        ? 'Deal is already funded and active.'
        : `Deal cannot be funded in state: ${stateLabel}.`,
    };
  }

  if (params.usdcBalance < params.totalEscrow) {
    return {
      canFund: false,
      role: 'client',
      requiresApproval: false,
      approvalAmount: params.totalEscrow,
      hasInsufficientBalance: true,
      reason: `Insufficient USDC balance (${formatUsdcAmount(params.usdcBalance)} available, ${formatUsdcAmount(params.totalEscrow)} required).`,
    };
  }

  if (params.usdcAllowance < params.totalEscrow) {
    return {
      canFund: false,
      role: 'client',
      requiresApproval: true,
      approvalAmount: params.totalEscrow, // Exact required amount, NEVER MaxUint256
      hasInsufficientBalance: false,
      reason: 'USDC allowance required before funding.',
    };
  }

  return {
    canFund: true,
    role: 'client',
    requiresApproval: false,
    approvalAmount: 0n,
    hasInsufficientBalance: false,
  };
}

/**
 * Preflight validation before wallet prompt for USDC approve().
 * Enforces:
 * - Connected wallet == on-chain client
 * - Chain == Sepolia
 * - Canonical V2 Deal verified
 * - Deal USDC == canonical USDC
 * - Deal state == Draft
 * - Balance >= required
 * - Current allowance < required (fails closed if already sufficient to avoid wasted txs)
 */
export function validateApprovalPreflight(params: {
  connectedWallet: string | undefined | null;
  clientAddress: string;
  chainId: number | undefined;
  isCanonicalV2Deal: boolean;
  dealUsdc: string;
  dealState: DealState;
  totalEscrow: bigint;
  balance: bigint;
  currentAllowance: bigint;
}): { valid: boolean; error?: string } {
  if (!params.connectedWallet || !isAddress(params.connectedWallet)) {
    return { valid: false, error: 'Wallet not connected' };
  }

  if (params.connectedWallet.toLowerCase() !== params.clientAddress.toLowerCase()) {
    return { valid: false, error: 'Unauthorized: Only the designated client may approve USDC for this deal' };
  }

  if (params.chainId !== SEPOLIA_CHAIN_ID) {
    return { valid: false, error: `Invalid network: Must be connected to Sepolia (chainId ${SEPOLIA_CHAIN_ID})` };
  }

  if (!params.isCanonicalV2Deal) {
    return { valid: false, error: 'Deal identity failure: Deal is not a canonical V2 instance from SynqFactoryV2' };
  }

  if (params.dealUsdc.toLowerCase() !== SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc.toLowerCase()) {
    return { valid: false, error: 'Asset mismatch: Deal USDC contract does not match canonical Sepolia USDC' };
  }

  if (params.dealState !== DealState.Draft) {
    return { valid: false, error: `Deal is not in Draft state (current: ${DEAL_STATE_LABELS[params.dealState]})` };
  }

  if (params.balance < params.totalEscrow) {
    return { valid: false, error: `Insufficient USDC balance: have ${params.balance.toString()}, need ${params.totalEscrow.toString()}` };
  }

  if (params.currentAllowance >= params.totalEscrow) {
    return { valid: false, error: 'USDC allowance is already sufficient. No additional approval needed.' };
  }

  return { valid: true };
}

/**
 * Preflight validation before wallet prompt for fundDeal().
 * Enforces:
 * - Canonical V2 Deal
 * - Deal state == Draft
 * - Connected wallet == on-chain client
 * - Chain == Sepolia
 * - Canonical USDC token
 * - Expected total escrow matches contract
 * - Balance >= totalEscrow
 * - Allowance >= totalEscrow
 */
export function validateFundingPreflight(params: {
  connectedWallet: string | undefined | null;
  clientAddress: string;
  chainId: number | undefined;
  isCanonicalV2Deal: boolean;
  dealUsdc: string;
  dealState: DealState;
  contractTotalEscrow: bigint;
  expectedTotalEscrow: bigint;
  balance: bigint;
  allowance: bigint;
}): { valid: boolean; error?: string } {
  if (!params.connectedWallet || !isAddress(params.connectedWallet)) {
    return { valid: false, error: 'Wallet not connected' };
  }

  if (params.connectedWallet.toLowerCase() !== params.clientAddress.toLowerCase()) {
    return { valid: false, error: 'Unauthorized: Only the client can fund this deal' };
  }

  if (params.chainId !== SEPOLIA_CHAIN_ID) {
    return { valid: false, error: `Invalid network: Must be connected to Sepolia (chainId ${SEPOLIA_CHAIN_ID})` };
  }

  if (!params.isCanonicalV2Deal) {
    return { valid: false, error: 'Deal identity failure: Deal is not a canonical V2 instance from SynqFactoryV2' };
  }

  if (params.dealUsdc.toLowerCase() !== SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc.toLowerCase()) {
    return { valid: false, error: 'Asset mismatch: Deal USDC contract does not match canonical Sepolia USDC' };
  }

  if (params.dealState !== DealState.Draft) {
    return {
      valid: false,
      error: params.dealState === DealState.Active
        ? 'Deal is already funded'
        : `Deal is not in Draft state (current: ${DEAL_STATE_LABELS[params.dealState]})`,
    };
  }

  if (params.contractTotalEscrow !== params.expectedTotalEscrow) {
    return {
      valid: false,
      error: `Total escrow mismatch: expected ${params.expectedTotalEscrow.toString()}, contract has ${params.contractTotalEscrow.toString()}`,
    };
  }

  if (params.balance < params.contractTotalEscrow) {
    return { valid: false, error: 'Insufficient USDC balance' };
  }

  if (params.allowance < params.contractTotalEscrow) {
    return { valid: false, error: 'Insufficient USDC allowance. Please complete approval first.' };
  }

  return { valid: true };
}

/**
 * Verifies confirmed transaction receipt for fundDeal().
 * Validates that DealFunded event was emitted by the exact Deal address with the expected totalEscrow.
 */
export function verifyFundingReceipt(
  receipt: { status: string | number; logs: readonly any[] },
  dealAddress: string,
  expectedTotalEscrow: bigint
): {
  valid: boolean;
  error?: string;
  dealFundedEvent?: {
    dealAddress: `0x${string}`;
    totalEscrow: bigint;
  };
} {
  const isSuccess = receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1';
  if (!isSuccess) {
    return { valid: false, error: 'Transaction reverted on-chain' };
  }

  const normalizedDeal = dealAddress.toLowerCase();

  for (const log of receipt.logs) {
    if (!log.address || log.address.toLowerCase() !== normalizedDeal) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: synqDealV1ABI,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === 'DealFunded') {
        const args = decoded.args as unknown as { dealAddress: string; totalEscrow: bigint };
        if (args.dealAddress.toLowerCase() !== normalizedDeal) {
          return { valid: false, error: `DealFunded emitted for unexpected deal address: ${args.dealAddress}` };
        }
        if (args.totalEscrow !== expectedTotalEscrow) {
          return {
            valid: false,
            error: `DealFunded emitted with unexpected amount: ${args.totalEscrow.toString()} (expected ${expectedTotalEscrow.toString()})`,
          };
        }
        return {
          valid: true,
          dealFundedEvent: {
            dealAddress: getAddress(args.dealAddress),
            totalEscrow: args.totalEscrow,
          },
        };
      }
    } catch {
      // Not a SynqDealV1 event or not DealFunded, continue searching
    }
  }

  return { valid: false, error: 'Transaction confirmed but DealFunded event was not found from the deal contract' };
}

/**
 * Checks whether a milestone status is settled / terminal.
 * Solidity: SettledPaid (7), SettledRefunded (8), SettledSplit (9).
 */
export function isMilestoneSettled(status: MilestoneStatus): boolean {
  return (
    status === MilestoneStatus.SettledPaid ||
    status === MilestoneStatus.SettledRefunded ||
    status === MilestoneStatus.SettledSplit
  );
}

/**
 * Returns the index of the first unsettled milestone in sequential order,
 * or null if all milestones are settled.
 */
export function getCurrentMilestoneIndex(
  milestones: readonly StandardV2OnChainMilestone[]
): number | null {
  for (let i = 0; i < milestones.length; i++) {
    if (!isMilestoneSettled(milestones[i].status)) {
      return i;
    }
  }
  return null;
}

export interface MilestoneStartEligibilityResult {
  canStart: boolean;
  role: DealParticipantRole;
  targetMilestoneIndex: number | null;
  reason?: string;
}

/**
 * Pure evaluation of milestone start eligibility for the connected user.
 * Solidity rule: onlyFreelancer, inDealState(DealState.Active), validMilestone, status == Pending.
 */
export function determineMilestoneStartEligibility(params: {
  connectedWallet: string | undefined | null;
  freelancerAddress: string;
  clientAddress: string;
  chainId: number | undefined;
  dealState: DealState;
  milestones: readonly StandardV2OnChainMilestone[];
}): MilestoneStartEligibilityResult {
  const role = determineDealRole(params.connectedWallet, params.clientAddress, params.freelancerAddress);

  if (params.dealState !== DealState.Active) {
    const stateLabel = DEAL_STATE_LABELS[params.dealState] ?? `State (${params.dealState})`;
    return {
      canStart: false,
      role,
      targetMilestoneIndex: null,
      reason: params.dealState === DealState.Draft
        ? 'Deal is awaiting client funding. Milestones cannot be started on an unfunded deal.'
        : `Deal is in terminal state: ${stateLabel}. No milestones can be started.`,
    };
  }

  const currentIndex = getCurrentMilestoneIndex(params.milestones);
  if (currentIndex === null) {
    return {
      canStart: false,
      role,
      targetMilestoneIndex: null,
      reason: 'All milestones for this deal have been settled.',
    };
  }

  const currentMilestone = params.milestones[currentIndex];

  if (currentMilestone.status !== MilestoneStatus.Pending) {
    const statusLabel = MILESTONE_STATUS_LABELS[currentMilestone.status] ?? `Status (${currentMilestone.status})`;
    return {
      canStart: false,
      role,
      targetMilestoneIndex: currentIndex,
      reason: currentMilestone.status === MilestoneStatus.InProgress
        ? `Milestone ${currentIndex + 1} is already in progress.`
        : `Milestone ${currentIndex + 1} is currently ${statusLabel}.`,
    };
  }

  // Ensure all preceding milestones are settled
  for (let i = 0; i < currentIndex; i++) {
    if (!isMilestoneSettled(params.milestones[i].status)) {
      return {
        canStart: false,
        role,
        targetMilestoneIndex: currentIndex,
        reason: `Cannot start milestone ${currentIndex + 1}: preceding milestone ${i + 1} is not settled.`,
      };
    }
  }

  // Role check
  if (role === 'unconnected') {
    return {
      canStart: false,
      role: 'unconnected',
      targetMilestoneIndex: currentIndex,
      reason: 'Wallet not connected. Connect as freelancer to start work.',
    };
  }

  if (role !== 'freelancer') {
    return {
      canStart: false,
      role,
      targetMilestoneIndex: currentIndex,
      reason: role === 'client'
        ? 'Awaiting freelancer to start work on this milestone.'
        : 'Only the designated freelancer can start work on this milestone.',
    };
  }

  // Network check
  if (params.chainId !== SEPOLIA_CHAIN_ID) {
    return {
      canStart: false,
      role: 'freelancer',
      targetMilestoneIndex: currentIndex,
      reason: 'Please switch your wallet to Ethereum Sepolia to start this milestone.',
    };
  }

  return {
    canStart: true,
    role: 'freelancer',
    targetMilestoneIndex: currentIndex,
  };
}

/**
 * Preflight validation immediately before prompting wallet for startMilestone().
 * Solidity rules:
 * - connected wallet == freelancer
 * - chainId == 11155111
 * - canonical V2 Deal
 * - canonical USDC
 * - DealState == Active
 * - target milestone index valid (< milestoneCount)
 * - target milestone status == Pending
 * - all preceding milestones settled
 * - no other milestone currently InProgress
 */
export function validateStartMilestonePreflight(params: {
  connectedWallet: string | undefined | null;
  freelancerAddress: string;
  chainId: number | undefined;
  isCanonicalV2Deal: boolean;
  dealUsdc: string;
  dealState: DealState;
  targetMilestoneIndex: number;
  milestones: readonly StandardV2OnChainMilestone[];
}): { valid: boolean; error?: string } {
  if (!params.connectedWallet || !isAddress(params.connectedWallet)) {
    return { valid: false, error: 'Wallet not connected' };
  }

  if (params.connectedWallet.toLowerCase() !== params.freelancerAddress.toLowerCase()) {
    return { valid: false, error: 'Unauthorized: Only the designated freelancer can start milestone work' };
  }

  if (params.chainId !== SEPOLIA_CHAIN_ID) {
    return { valid: false, error: `Invalid network: Must be connected to Sepolia (chainId ${SEPOLIA_CHAIN_ID})` };
  }

  if (!params.isCanonicalV2Deal) {
    return { valid: false, error: 'Deal identity failure: Deal is not a canonical V2 instance from SynqFactoryV2' };
  }

  if (params.dealUsdc.toLowerCase() !== SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc.toLowerCase()) {
    return { valid: false, error: 'Asset mismatch: Deal USDC contract does not match canonical Sepolia USDC' };
  }

  if (params.dealState !== DealState.Active) {
    return {
      valid: false,
      error: params.dealState === DealState.Draft
        ? 'Deal is not funded (DealState is Draft)'
        : `Deal is not Active (DealState is ${DEAL_STATE_LABELS[params.dealState] ?? params.dealState})`,
    };
  }

  if (params.targetMilestoneIndex < 0 || params.targetMilestoneIndex >= params.milestones.length) {
    return { valid: false, error: `Invalid milestone index: ${params.targetMilestoneIndex}` };
  }

  const targetMilestone = params.milestones[params.targetMilestoneIndex];
  if (targetMilestone.status !== MilestoneStatus.Pending) {
    return {
      valid: false,
      error: `Milestone ${params.targetMilestoneIndex + 1} is not Pending (current: ${MILESTONE_STATUS_LABELS[targetMilestone.status] ?? targetMilestone.status})`,
    };
  }

  // Sequential order check: all previous milestones must be settled
  for (let i = 0; i < params.targetMilestoneIndex; i++) {
    if (!isMilestoneSettled(params.milestones[i].status)) {
      return {
        valid: false,
        error: `Cannot start milestone ${params.targetMilestoneIndex + 1}: preceding milestone ${i + 1} is not settled`,
      };
    }
  }

  // Ensure no other milestone is currently InProgress
  for (let i = 0; i < params.milestones.length; i++) {
    if (i !== params.targetMilestoneIndex && params.milestones[i].status === MilestoneStatus.InProgress) {
      return {
        valid: false,
        error: `Cannot start milestone ${params.targetMilestoneIndex + 1}: milestone ${i + 1} is already in progress`,
      };
    }
  }

  return { valid: true };
}

/**
 * Verifies confirmed transaction receipt for startMilestone().
 * Validates that MilestoneStarted event was emitted by the exact Deal address with the expected milestoneId.
 */
export function verifyStartMilestoneReceipt(
  receipt: { status: string | number; logs: readonly any[] },
  dealAddress: string,
  expectedMilestoneId: bigint
): {
  valid: boolean;
  error?: string;
  milestoneStartedEvent?: {
    milestoneId: bigint;
  };
} {
  const isSuccess = receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1';
  if (!isSuccess) {
    return { valid: false, error: 'Transaction reverted on-chain' };
  }

  const normalizedDeal = dealAddress.toLowerCase();

  for (const log of receipt.logs) {
    if (!log.address || log.address.toLowerCase() !== normalizedDeal) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: synqDealV1ABI,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === 'MilestoneStarted') {
        const args = decoded.args as unknown as { milestoneId: bigint };
        if (BigInt(args.milestoneId) !== expectedMilestoneId) {
          return {
            valid: false,
            error: `MilestoneStarted emitted for unexpected milestone ID: ${args.milestoneId.toString()} (expected ${expectedMilestoneId.toString()})`,
          };
        }
        return {
          valid: true,
          milestoneStartedEvent: {
            milestoneId: BigInt(args.milestoneId),
          },
        };
      }
    } catch {
      // Not a SynqDealV1 event or not MilestoneStarted, continue searching
    }
  }

  return {
    valid: false,
    error: 'Transaction confirmed but MilestoneStarted event was not found from the deal contract',
  };
}

// Re-export canonical evidence manifest architecture (Phase 3I-B)
export {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_LIMITS,
  VALID_LINK_TYPES,
  type EvidenceLinkType,
  type CanonicalEvidenceLink,
  type CanonicalEvidenceManifestV1,
  EvidenceValidationError,
  normalizeEvidenceLink,
  normalizeEvidenceManifest,
  canonicalizeValue,
  canonicalizeEvidenceManifest,
  hashEvidenceManifest,
} from './v2-evidence';

// --- Milestone Submission Helpers (Phase 3I & 3I-B) ---

/**
 * @deprecated Legacy Phase 3I harness helper. In production UI and API flows, use
 * hashEvidenceManifest(manifest) from './v2-evidence' which enforces the canonical
 * deterministic manifest schema and database persistence.
 * Retained solely for backward compatibility with isolated test fixtures.
 */
export function hashMilestoneEvidence(evidenceText: string): `0x${string}` {
  const trimmed = (evidenceText || '').trim();
  if (!trimmed) {
    throw new Error('Milestone evidence cannot be empty');
  }
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    if (trimmed.toLowerCase() === ZERO_BYTES32) {
      throw new Error('Empty evidence root hash');
    }
    return trimmed.toLowerCase() as `0x${string}`;
  }
  return keccak256(toHex(trimmed));
}


/**
 * Calculates review window expiration timestamp in seconds.
 * Contract rule: review window ends at submittedAt + reviewWindow.
 */
export function calculateReviewWindowExpiration(submittedAt: bigint, reviewWindow: bigint): bigint {
  if (submittedAt === 0n) return 0n;
  return submittedAt + reviewWindow;
}

/**
 * Calculates effective milestone submission deadline in seconds.
 * Contract rule: block.timestamp <= workDeadline + gracePeriod.
 */
export function calculateEffectiveSubmissionDeadline(workDeadline: bigint, gracePeriod: bigint): bigint {
  return workDeadline + gracePeriod;
}

export interface MilestoneSubmissionEligibilityResult {
  canSubmit: boolean;
  role: DealParticipantRole;
  targetMilestoneIndex: number | null;
  isExpired?: boolean;
  effectiveDeadline?: bigint;
  reason?: string;
}

/**
 * Evaluates whether current connected wallet can submit deliverables for the active milestone.
 * Contract rules:
 * - DealState == Active
 * - Unsettled milestone must be InProgress
 * - Preceding milestones must all be settled
 * - block.timestamp <= workDeadline + gracePeriod
 * - msg.sender == freelancer
 * - Network == Sepolia
 */
export function determineMilestoneSubmissionEligibility(params: {
  connectedWallet: string | undefined | null;
  freelancerAddress: string;
  clientAddress: string;
  chainId: number | undefined;
  dealState: DealState;
  milestones: readonly StandardV2OnChainMilestone[];
  currentTimeSeconds?: bigint;
}): MilestoneSubmissionEligibilityResult {
  const role = determineDealRole(params.connectedWallet, params.clientAddress, params.freelancerAddress);

  if (params.dealState !== DealState.Active) {
    const stateLabel = DEAL_STATE_LABELS[params.dealState] ?? `State (${params.dealState})`;
    return {
      canSubmit: false,
      role,
      targetMilestoneIndex: null,
      reason: params.dealState === DealState.Draft
        ? 'Deal is awaiting client funding. Deliverables cannot be submitted on an unfunded deal.'
        : `Deal is in terminal state: ${stateLabel}. Deliverables cannot be submitted.`,
    };
  }

  const currentIndex = getCurrentMilestoneIndex(params.milestones);
  if (currentIndex === null) {
    return {
      canSubmit: false,
      role,
      targetMilestoneIndex: null,
      reason: 'All milestones for this deal have been settled.',
    };
  }

  const currentMilestone = params.milestones[currentIndex];

  if (currentMilestone.status !== MilestoneStatus.InProgress) {
    const statusLabel = MILESTONE_STATUS_LABELS[currentMilestone.status] ?? `Status (${currentMilestone.status})`;
    return {
      canSubmit: false,
      role,
      targetMilestoneIndex: currentIndex,
      reason: currentMilestone.status === MilestoneStatus.Submitted
        ? `Milestone ${currentIndex + 1} has already been submitted and is currently in client review.`
        : currentMilestone.status === MilestoneStatus.Pending
        ? `Milestone ${currentIndex + 1} has not been started yet.`
        : `Milestone ${currentIndex + 1} is currently ${statusLabel}.`,
    };
  }

  // Preceding milestones must all be settled
  for (let i = 0; i < currentIndex; i++) {
    if (!isMilestoneSettled(params.milestones[i].status)) {
      return {
        canSubmit: false,
        role,
        targetMilestoneIndex: currentIndex,
        reason: `Cannot submit milestone ${currentIndex + 1}: preceding milestone ${i + 1} is not settled.`,
      };
    }
  }

  const effectiveDeadline = currentMilestone.workDeadline + currentMilestone.gracePeriod;
  const now = params.currentTimeSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  if (now > effectiveDeadline) {
    return {
      canSubmit: false,
      role,
      targetMilestoneIndex: currentIndex,
      isExpired: true,
      effectiveDeadline,
      reason: `Work deadline and grace period expired for milestone ${currentIndex + 1}.`,
    };
  }

  if (role === 'unconnected') {
    return {
      canSubmit: false,
      role: 'unconnected',
      targetMilestoneIndex: currentIndex,
      effectiveDeadline,
      reason: 'Wallet not connected. Connect as freelancer to submit deliverables.',
    };
  }

  if (role !== 'freelancer') {
    return {
      canSubmit: false,
      role,
      targetMilestoneIndex: currentIndex,
      effectiveDeadline,
      reason: role === 'client'
        ? 'Awaiting freelancer deliverable submission.'
        : 'Only the designated freelancer can submit milestone deliverables.',
    };
  }

  if (params.chainId !== SEPOLIA_CHAIN_ID) {
    return {
      canSubmit: false,
      role: 'freelancer',
      targetMilestoneIndex: currentIndex,
      effectiveDeadline,
      reason: 'Please switch your wallet to Ethereum Sepolia to submit deliverables.',
    };
  }

  return {
    canSubmit: true,
    role: 'freelancer',
    targetMilestoneIndex: currentIndex,
    effectiveDeadline,
  };
}

/**
 * Preflight validation immediately before prompting wallet for submitWork().
 * Solidity rules:
 * - connected wallet == freelancer
 * - chainId == 11155111
 * - canonical V2 Deal
 * - canonical USDC
 * - DealState == Active
 * - target milestone index valid (< milestoneCount)
 * - target milestone status == InProgress
 * - all preceding milestones settled
 * - evidenceRootHash != bytes32(0)
 * - block.timestamp <= workDeadline + gracePeriod
 */
export function validateSubmitWorkPreflight(params: {
  connectedWallet: string | undefined | null;
  freelancerAddress: string;
  chainId: number | undefined;
  isCanonicalV2Deal: boolean;
  dealUsdc: string;
  dealState: DealState;
  targetMilestoneIndex: number;
  milestones: readonly StandardV2OnChainMilestone[];
  evidenceRootHash: `0x${string}`;
  currentTimeSeconds?: bigint;
}): { valid: boolean; error?: string } {
  if (!params.connectedWallet || !isAddress(params.connectedWallet)) {
    return { valid: false, error: 'Wallet not connected' };
  }

  if (params.connectedWallet.toLowerCase() !== params.freelancerAddress.toLowerCase()) {
    return { valid: false, error: 'Unauthorized: Only the designated freelancer can submit deliverables' };
  }

  if (params.chainId !== SEPOLIA_CHAIN_ID) {
    return { valid: false, error: `Invalid network: Must be connected to Sepolia (chainId ${SEPOLIA_CHAIN_ID})` };
  }

  if (!params.isCanonicalV2Deal) {
    return { valid: false, error: 'Deal identity failure: Deal is not a canonical V2 instance from SynqFactoryV2' };
  }

  if (params.dealUsdc.toLowerCase() !== SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc.toLowerCase()) {
    return { valid: false, error: 'Asset mismatch: Deal USDC contract does not match canonical Sepolia USDC' };
  }

  if (params.dealState !== DealState.Active) {
    return {
      valid: false,
      error: params.dealState === DealState.Draft
        ? 'Deal is not funded (DealState is Draft)'
        : `Deal is not Active (DealState is ${DEAL_STATE_LABELS[params.dealState] ?? params.dealState})`,
    };
  }

  if (params.targetMilestoneIndex < 0 || params.targetMilestoneIndex >= params.milestones.length) {
    return { valid: false, error: `Invalid milestone index: ${params.targetMilestoneIndex}` };
  }

  const targetMilestone = params.milestones[params.targetMilestoneIndex];
  if (targetMilestone.status !== MilestoneStatus.InProgress) {
    return {
      valid: false,
      error: `Milestone ${params.targetMilestoneIndex + 1} is not InProgress (current: ${MILESTONE_STATUS_LABELS[targetMilestone.status] ?? targetMilestone.status})`,
    };
  }

  // Preceding milestones must be settled
  for (let i = 0; i < params.targetMilestoneIndex; i++) {
    if (!isMilestoneSettled(params.milestones[i].status)) {
      return {
        valid: false,
        error: `Cannot submit milestone ${params.targetMilestoneIndex + 1}: preceding milestone ${i + 1} is not settled`,
      };
    }
  }

  // Solidity: require(evidenceRootHash != bytes32(0), "Empty evidence root hash");
  if (!params.evidenceRootHash || params.evidenceRootHash === ZERO_BYTES32 || !/^0x[0-9a-fA-F]{64}$/.test(params.evidenceRootHash)) {
    return { valid: false, error: 'Empty evidence root hash' };
  }

  // Solidity: require(block.timestamp <= m.workDeadline + m.gracePeriod, "Work deadline and grace expired");
  const now = params.currentTimeSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  if (now > targetMilestone.workDeadline + targetMilestone.gracePeriod) {
    return { valid: false, error: 'Work deadline and grace expired' };
  }

  return { valid: true };
}

/**
 * Verifies confirmed transaction receipt for submitWork().
 * Validates that MilestoneSubmitted event was emitted by the exact Deal address with the expected milestoneId and evidenceRootHash.
 */
export function verifySubmitWorkReceipt(
  receipt: { status: string | number; logs: readonly any[] },
  dealAddress: string,
  expectedMilestoneId: bigint,
  expectedEvidenceRootHash: `0x${string}`
): {
  valid: boolean;
  error?: string;
  milestoneSubmittedEvent?: {
    milestoneId: bigint;
    evidenceRootHash: `0x${string}`;
    specHash: `0x${string}`;
    version: number;
  };
} {
  const isSuccess = receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1';
  if (!isSuccess) {
    return { valid: false, error: 'Transaction reverted on-chain' };
  }

  const normalizedDeal = dealAddress.toLowerCase();
  const normalizedExpectedEvidence = expectedEvidenceRootHash.toLowerCase();

  for (const log of receipt.logs) {
    if (!log.address || log.address.toLowerCase() !== normalizedDeal) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: synqDealV1ABI,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === 'MilestoneSubmitted') {
        const args = decoded.args as unknown as {
          milestoneId: bigint;
          evidenceRootHash: `0x${string}`;
          specHash: `0x${string}`;
          version: number;
        };

        if (BigInt(args.milestoneId) !== expectedMilestoneId) {
          return {
            valid: false,
            error: `MilestoneSubmitted emitted for unexpected milestone ID: ${args.milestoneId.toString()} (expected ${expectedMilestoneId.toString()})`,
          };
        }

        if (String(args.evidenceRootHash).toLowerCase() !== normalizedExpectedEvidence) {
          return {
            valid: false,
            error: `MilestoneSubmitted emitted for unexpected evidenceRootHash: ${args.evidenceRootHash} (expected ${expectedEvidenceRootHash})`,
          };
        }

        return {
          valid: true,
          milestoneSubmittedEvent: {
            milestoneId: BigInt(args.milestoneId),
            evidenceRootHash: args.evidenceRootHash,
            specHash: args.specHash,
            version: Number(args.version),
          },
        };
      }
    } catch {
      // Not a SynqDealV1 event or not MilestoneSubmitted, continue searching
    }
  }

  return {
    valid: false,
    error: 'Transaction confirmed but MilestoneSubmitted event was not found from the deal contract',
  };
}

/// --- Milestone Review & Approval Helpers (Phase 3J) ---

export interface MilestoneApprovalEligibilityResult {
  canApprove: boolean;
  role: DealParticipantRole;
  targetMilestoneIndex: number | null;
  reason?: string;
}

/**
 * Determines whether the connected wallet can approve a submitted milestone.
 * Contract rule: only the designated client can call clientApprove(milestoneId) when DealState is Active and milestone is Submitted.
 */
export function determineMilestoneApprovalEligibility(params: {
  connectedWallet: string | undefined | null;
  clientAddress: string;
  freelancerAddress: string;
  chainId: number | undefined;
  dealState: DealState;
  milestones: readonly StandardV2OnChainMilestone[];
  targetMilestoneIndex?: number;
}): MilestoneApprovalEligibilityResult {
  const role = determineDealRole(params.connectedWallet, params.clientAddress, params.freelancerAddress);
  const targetIndex = params.targetMilestoneIndex ?? getCurrentMilestoneIndex(params.milestones);

  if (targetIndex === null || targetIndex < 0 || targetIndex >= params.milestones.length) {
    return {
      canApprove: false,
      role,
      targetMilestoneIndex: null,
      reason: 'No unsettled milestone found.',
    };
  }

  const targetMilestone = params.milestones[targetIndex];

  if (params.dealState !== DealState.Active) {
    return {
      canApprove: false,
      role,
      targetMilestoneIndex: targetIndex,
      reason: params.dealState === DealState.Completed
        ? 'Deal has already completed.'
        : `Deal is not Active (current: ${DEAL_STATE_LABELS[params.dealState] ?? params.dealState}).`,
    };
  }

  if (targetMilestone.status !== MilestoneStatus.Submitted) {
    return {
      canApprove: false,
      role,
      targetMilestoneIndex: targetIndex,
      reason: `Milestone ${targetIndex + 1} is not awaiting review (current: ${MILESTONE_STATUS_LABELS[targetMilestone.status] ?? targetMilestone.status}).`,
    };
  }

  // Preceding milestones must all be settled
  for (let i = 0; i < targetIndex; i++) {
    if (!isMilestoneSettled(params.milestones[i].status)) {
      return {
        canApprove: false,
        role,
        targetMilestoneIndex: targetIndex,
        reason: `Cannot approve milestone ${targetIndex + 1}: preceding milestone ${i + 1} is not settled.`,
      };
    }
  }

  if (role === 'unconnected') {
    return {
      canApprove: false,
      role: 'unconnected',
      targetMilestoneIndex: targetIndex,
      reason: 'Wallet not connected. Connect as client to approve deliverables.',
    };
  }

  if (role !== 'client') {
    return {
      canApprove: false,
      role,
      targetMilestoneIndex: targetIndex,
      reason: role === 'freelancer'
        ? 'Milestone deliverables submitted. Awaiting client review and approval.'
        : 'Only the designated client can approve milestone deliverables.',
    };
  }

  if (params.chainId !== SEPOLIA_CHAIN_ID) {
    return {
      canApprove: false,
      role: 'client',
      targetMilestoneIndex: targetIndex,
      reason: `Invalid network: Must be connected to Sepolia (chainId ${SEPOLIA_CHAIN_ID}).`,
    };
  }

  return {
    canApprove: true,
    role: 'client',
    targetMilestoneIndex: targetIndex,
  };
}

/**
 * Preflight validation immediately before prompting wallet for clientApprove(milestoneId).
 * Solidity rules:
 * - connected wallet == client
 * - chainId == 11155111
 * - canonical V2 Deal
 * - canonical USDC
 * - DealState == Active
 * - target milestone index valid
 * - target milestone status == Submitted
 * - preceding milestones settled
 * - canonical evidence record retrieved and matches on-chain commitment
 */
export function validateClientApprovePreflight(params: {
  connectedWallet: string | undefined | null;
  clientAddress: string;
  chainId: number | undefined;
  isCanonicalV2Deal: boolean;
  dealUsdc: string;
  dealState: DealState;
  targetMilestoneIndex: number;
  milestones: readonly StandardV2OnChainMilestone[];
  canonicalEvidence?: {
    evidenceRootHash: string;
    version: number;
    specHash?: string;
  } | null;
}): { valid: boolean; error?: string } {
  if (!params.connectedWallet || !isAddress(params.connectedWallet)) {
    return { valid: false, error: 'Wallet not connected' };
  }

  if (params.connectedWallet.toLowerCase() !== params.clientAddress.toLowerCase()) {
    return { valid: false, error: 'Unauthorized: Only the designated client can approve deliverables' };
  }

  if (params.chainId !== SEPOLIA_CHAIN_ID) {
    return { valid: false, error: `Invalid network: Must be connected to Sepolia (chainId ${SEPOLIA_CHAIN_ID})` };
  }

  if (!params.isCanonicalV2Deal) {
    return { valid: false, error: 'Deal identity failure: Deal is not a canonical V2 instance from SynqFactoryV2' };
  }

  if (params.dealUsdc.toLowerCase() !== SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc.toLowerCase()) {
    return { valid: false, error: 'Asset mismatch: Deal USDC contract does not match canonical Sepolia USDC' };
  }

  if (params.dealState !== DealState.Active) {
    return {
      valid: false,
      error: `Deal is not Active (DealState is ${DEAL_STATE_LABELS[params.dealState] ?? params.dealState})`,
    };
  }

  if (params.targetMilestoneIndex < 0 || params.targetMilestoneIndex >= params.milestones.length) {
    return { valid: false, error: `Invalid milestone index: ${params.targetMilestoneIndex}` };
  }

  const targetMilestone = params.milestones[params.targetMilestoneIndex];
  if (targetMilestone.status !== MilestoneStatus.Submitted) {
    return {
      valid: false,
      error: `Milestone ${params.targetMilestoneIndex + 1} is not Submitted (current: ${MILESTONE_STATUS_LABELS[targetMilestone.status] ?? targetMilestone.status})`,
    };
  }

  // Preceding milestones must be settled
  for (let i = 0; i < params.targetMilestoneIndex; i++) {
    if (!isMilestoneSettled(params.milestones[i].status)) {
      return {
        valid: false,
        error: `Cannot approve milestone ${params.targetMilestoneIndex + 1}: preceding milestone ${i + 1} is not settled`,
      };
    }
  }

  // Canonical evidence verification before approval
  if (!params.canonicalEvidence) {
    return {
      valid: false,
      error: 'Cannot approve milestone without verified canonical evidence record',
    };
  }

  if (params.canonicalEvidence.evidenceRootHash.toLowerCase() !== targetMilestone.evidenceRootHash.toLowerCase()) {
    return {
      valid: false,
      error: `Evidence root hash mismatch: server record ${params.canonicalEvidence.evidenceRootHash} does not match on-chain commitment ${targetMilestone.evidenceRootHash}`,
    };
  }

  if (params.canonicalEvidence.version !== targetMilestone.version) {
    return {
      valid: false,
      error: `Evidence version mismatch: server record v${params.canonicalEvidence.version} does not match on-chain v${targetMilestone.version}`,
    };
  }

  if (params.canonicalEvidence.specHash && params.canonicalEvidence.specHash.toLowerCase() !== targetMilestone.specHash.toLowerCase()) {
    return {
      valid: false,
      error: `Evidence specHash mismatch: server record ${params.canonicalEvidence.specHash} does not match on-chain specHash ${targetMilestone.specHash}`,
    };
  }

  return { valid: true };
}

/**
 * Verifies confirmed transaction receipt for clientApprove().
 * Validates that MilestoneSettled event was emitted by the exact Deal address with the expected milestoneId, amount, and settlementType.
 */
export function verifyClientApproveReceipt(
  receipt: { status: string | number; logs: readonly any[] },
  dealAddress: string,
  expectedMilestoneId: bigint,
  expectedPaidAmount: bigint
): {
  valid: boolean;
  error?: string;
  milestoneSettledEvent?: {
    milestoneId: bigint;
    paidToFreelancer: bigint;
    refundedToClient: bigint;
    settlementType: SettlementType;
  };
} {
  const isSuccess = receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1';
  if (!isSuccess) {
    return { valid: false, error: 'Transaction reverted on-chain' };
  }

  const normalizedDeal = dealAddress.toLowerCase();

  for (const log of receipt.logs) {
    if (!log.address || log.address.toLowerCase() !== normalizedDeal) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: synqDealV1ABI,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === 'MilestoneSettled') {
        const args = decoded.args as unknown as {
          milestoneId: bigint;
          paidToFreelancer: bigint;
          refundedToClient: bigint;
          settlementType: number;
        };

        if (BigInt(args.milestoneId) !== expectedMilestoneId) {
          return {
            valid: false,
            error: `MilestoneSettled emitted for unexpected milestone ID: ${args.milestoneId.toString()} (expected ${expectedMilestoneId.toString()})`,
          };
        }

        if (BigInt(args.paidToFreelancer) !== expectedPaidAmount) {
          return {
            valid: false,
            error: `MilestoneSettled emitted for unexpected payout: ${args.paidToFreelancer.toString()} (expected ${expectedPaidAmount.toString()})`,
          };
        }

        if (BigInt(args.refundedToClient) !== 0n) {
          return {
            valid: false,
            error: `MilestoneSettled emitted unexpected refunded amount: ${args.refundedToClient.toString()} (expected 0)`,
          };
        }

        if (Number(args.settlementType) !== SettlementType.ClientApproval) {
          return {
            valid: false,
            error: `MilestoneSettled emitted unexpected settlementType: ${args.settlementType} (expected ${SettlementType.ClientApproval})`,
          };
        }

        return {
          valid: true,
          milestoneSettledEvent: {
            milestoneId: BigInt(args.milestoneId),
            paidToFreelancer: BigInt(args.paidToFreelancer),
            refundedToClient: BigInt(args.refundedToClient),
            settlementType: Number(args.settlementType) as SettlementType,
          },
        };
      }
    } catch {
      // Continue searching logs
    }
  }

  return {
    valid: false,
    error: 'Transaction confirmed but MilestoneSettled event was not found from the deal contract',
  };
}

export interface ReviewTimeoutEligibilityResult {
  canSettleTimeout: boolean;
  role: DealParticipantRole;
  targetMilestoneIndex: number | null;
  reviewDeadline: bigint;
  isExpired: boolean;
  hasExpired: boolean;
  reason?: string;
}

/**
 * Determines whether a submitted milestone is eligible for permissionless review timeout settlement.
 * Contract rule: settleReviewTimeout(milestoneId) is callable by ANY wallet when:
 * - Deal is Active and !isProtected
 * - milestone is Submitted
 * - block.timestamp > submittedAt + reviewWindow (strictly >)
 */
export function determineReviewTimeoutEligibility(params: {
  connectedWallet: string | undefined | null;
  clientAddress?: string;
  freelancerAddress?: string;
  chainId: number | undefined;
  dealState: DealState;
  isProtected: boolean;
  milestones: readonly StandardV2OnChainMilestone[];
  targetMilestoneIndex?: number;
  currentTimeSeconds?: bigint;
}): ReviewTimeoutEligibilityResult {
  const role = determineDealRole(
    params.connectedWallet,
    params.clientAddress || '',
    params.freelancerAddress || ''
  );
  const targetIndex = params.targetMilestoneIndex ?? getCurrentMilestoneIndex(params.milestones);

  if (targetIndex === null || targetIndex < 0 || targetIndex >= params.milestones.length) {
    return {
      canSettleTimeout: false,
      role,
      targetMilestoneIndex: null,
      reviewDeadline: 0n,
      isExpired: false,
      hasExpired: false,
      reason: 'No unsettled milestone found.',
    };
  }

  const targetMilestone = params.milestones[targetIndex];
  const reviewDeadline = targetMilestone.submittedAt + targetMilestone.reviewWindow;
  const now = params.currentTimeSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  const isExpired = targetMilestone.submittedAt > 0n && now > reviewDeadline;

  if (params.isProtected) {
    return {
      canSettleTimeout: false,
      role,
      targetMilestoneIndex: targetIndex,
      reviewDeadline,
      isExpired,
      hasExpired: isExpired,
      reason: 'Protected deals must use assessment routing on timeout.',
    };
  }

  if (params.dealState !== DealState.Active) {
    return {
      canSettleTimeout: false,
      role,
      targetMilestoneIndex: targetIndex,
      reviewDeadline,
      isExpired,
      hasExpired: isExpired,
      reason: `Deal is not Active (current: ${DEAL_STATE_LABELS[params.dealState] ?? params.dealState}).`,
    };
  }

  if (targetMilestone.status !== MilestoneStatus.Submitted) {
    return {
      canSettleTimeout: false,
      role,
      targetMilestoneIndex: targetIndex,
      reviewDeadline,
      isExpired,
      hasExpired: isExpired,
      reason: `Milestone is not in Submitted status (current: ${MILESTONE_STATUS_LABELS[targetMilestone.status] ?? targetMilestone.status}).`,
    };
  }

  // Preceding milestones must all be settled
  for (let i = 0; i < targetIndex; i++) {
    if (!isMilestoneSettled(params.milestones[i].status)) {
      return {
        canSettleTimeout: false,
        role,
        targetMilestoneIndex: targetIndex,
        reviewDeadline,
        isExpired,
        hasExpired: isExpired,
        reason: `Cannot settle timeout for milestone ${targetIndex + 1}: preceding milestone ${i + 1} is not settled.`,
      };
    }
  }

  if (!isExpired) {
    return {
      canSettleTimeout: false,
      role,
      targetMilestoneIndex: targetIndex,
      reviewDeadline,
      isExpired: false,
      hasExpired: false,
      reason: 'Review window is still active. Awaiting client review.',
    };
  }

  if (role === 'unconnected') {
    return {
      canSettleTimeout: false,
      role: 'unconnected',
      targetMilestoneIndex: targetIndex,
      reviewDeadline,
      isExpired: true,
      hasExpired: true,
      reason: 'Wallet not connected. Connect wallet to execute timeout settlement.',
    };
  }

  if (params.chainId !== SEPOLIA_CHAIN_ID) {
    return {
      canSettleTimeout: false,
      role,
      targetMilestoneIndex: targetIndex,
      reviewDeadline,
      isExpired: true,
      hasExpired: true,
      reason: 'Please switch your wallet to Ethereum Sepolia to settle review timeout.',
    };
  }

  return {
    canSettleTimeout: true,
    role,
    targetMilestoneIndex: targetIndex,
    reviewDeadline,
    isExpired: true,
    hasExpired: true,
  };
}

/**
 * Preflight validation immediately before calling settleReviewTimeout(milestoneId).
 * Solidity rules:
 * - callable permissionlessly (by any wallet)
 * - chainId == 11155111
 * - canonical V2 Deal
 * - canonical USDC
 * - DealState == Active
 * - !isProtected
 * - target milestone status == Submitted
 * - block.timestamp > submittedAt + reviewWindow (strictly >)
 */
export function validateSettleReviewTimeoutPreflight(params: {
  connectedWallet: string | undefined | null;
  chainId: number | undefined;
  isCanonicalV2Deal: boolean;
  dealUsdc: string;
  dealState: DealState;
  isProtected: boolean;
  targetMilestoneIndex: number;
  milestones: readonly StandardV2OnChainMilestone[];
  currentTimeSeconds?: bigint;
}): { valid: boolean; error?: string } {
  if (!params.connectedWallet || !isAddress(params.connectedWallet)) {
    return { valid: false, error: 'Wallet not connected' };
  }

  if (params.chainId !== SEPOLIA_CHAIN_ID) {
    return { valid: false, error: `Invalid network: Must be connected to Sepolia (chainId ${SEPOLIA_CHAIN_ID})` };
  }

  if (!params.isCanonicalV2Deal) {
    return { valid: false, error: 'Deal identity failure: Deal is not a canonical V2 instance from SynqFactoryV2' };
  }

  if (params.isProtected) {
    return { valid: false, error: 'Protected deals must use triggerReviewTimeoutProtected' };
  }

  if (params.dealUsdc.toLowerCase() !== SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc.toLowerCase()) {
    return { valid: false, error: 'Asset mismatch: Deal USDC contract does not match canonical Sepolia USDC' };
  }

  if (params.dealState !== DealState.Active) {
    return {
      valid: false,
      error: `Deal is not Active (DealState is ${DEAL_STATE_LABELS[params.dealState] ?? params.dealState})`,
    };
  }

  if (params.targetMilestoneIndex < 0 || params.targetMilestoneIndex >= params.milestones.length) {
    return { valid: false, error: `Invalid milestone index: ${params.targetMilestoneIndex}` };
  }

  const targetMilestone = params.milestones[params.targetMilestoneIndex];
  if (targetMilestone.status !== MilestoneStatus.Submitted) {
    return {
      valid: false,
      error: `Milestone ${params.targetMilestoneIndex + 1} is not Submitted (current: ${MILESTONE_STATUS_LABELS[targetMilestone.status] ?? targetMilestone.status})`,
    };
  }

  // Preceding milestones must be settled
  for (let i = 0; i < params.targetMilestoneIndex; i++) {
    if (!isMilestoneSettled(params.milestones[i].status)) {
      return {
        valid: false,
        error: `Cannot settle timeout for milestone ${params.targetMilestoneIndex + 1}: preceding milestone ${i + 1} is not settled`,
      };
    }
  }

  const now = params.currentTimeSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  const reviewDeadline = targetMilestone.submittedAt + targetMilestone.reviewWindow;

  // Solidity: require(block.timestamp > m.submittedAt + m.reviewWindow, "Review window not expired");
  if (now <= reviewDeadline) {
    return { valid: false, error: 'Review window not expired' };
  }

  return { valid: true };
}

/**
 * Verifies confirmed transaction receipt for settleReviewTimeout().
 * Validates that MilestoneSettled event was emitted by the exact Deal address with the expected milestoneId, amount, and settlementType (StandardReviewTimeout).
 */
export function verifySettleReviewTimeoutReceipt(
  receipt: { status: string | number; logs: readonly any[] },
  dealAddress: string,
  expectedMilestoneId: bigint,
  expectedPaidAmount: bigint
): {
  valid: boolean;
  error?: string;
  milestoneSettledEvent?: {
    milestoneId: bigint;
    paidToFreelancer: bigint;
    refundedToClient: bigint;
    settlementType: SettlementType;
  };
} {
  const isSuccess = receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1';
  if (!isSuccess) {
    return { valid: false, error: 'Transaction reverted on-chain' };
  }

  const normalizedDeal = dealAddress.toLowerCase();

  for (const log of receipt.logs) {
    if (!log.address || log.address.toLowerCase() !== normalizedDeal) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: synqDealV1ABI,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === 'MilestoneSettled') {
        const args = decoded.args as unknown as {
          milestoneId: bigint;
          paidToFreelancer: bigint;
          refundedToClient: bigint;
          settlementType: number;
        };

        if (BigInt(args.milestoneId) !== expectedMilestoneId) {
          return {
            valid: false,
            error: `MilestoneSettled emitted for unexpected milestone ID: ${args.milestoneId.toString()} (expected ${expectedMilestoneId.toString()})`,
          };
        }

        if (BigInt(args.paidToFreelancer) !== expectedPaidAmount) {
          return {
            valid: false,
            error: `MilestoneSettled emitted for unexpected payout: ${args.paidToFreelancer.toString()} (expected ${expectedPaidAmount.toString()})`,
          };
        }

        if (BigInt(args.refundedToClient) !== 0n) {
          return {
            valid: false,
            error: `MilestoneSettled emitted unexpected refunded amount: ${args.refundedToClient.toString()} (expected 0)`,
          };
        }

        if (Number(args.settlementType) !== SettlementType.StandardReviewTimeout) {
          return {
            valid: false,
            error: `MilestoneSettled emitted unexpected settlementType: ${args.settlementType} (expected ${SettlementType.StandardReviewTimeout})`,
          };
        }

        return {
          valid: true,
          milestoneSettledEvent: {
            milestoneId: BigInt(args.milestoneId),
            paidToFreelancer: BigInt(args.paidToFreelancer),
            refundedToClient: BigInt(args.refundedToClient),
            settlementType: Number(args.settlementType) as SettlementType,
          },
        };
      }
    } catch {
      // Continue searching logs
    }
  }

  return {
    valid: false,
    error: 'Transaction confirmed but MilestoneSettled event was not found from the deal contract',
  };
}

// --- Phase 3K-C: Request Changes & Freelancer Revision Response Helpers ---

export interface RequestChangesEligibilityResult {
  canRequestChanges: boolean;
  role: DealParticipantRole;
  targetMilestoneIndex: number | null;
  reason?: string;
}

/**
 * Pure evaluation of Request Changes eligibility for the connected user.
 * Solidity rules: onlyClient, inDealState(DealState.Active), !isProtected, validMilestone, status == Submitted.
 * UI requirement: canonical submitted evidence must be verified before requesting changes.
 */
export function determineRequestChangesEligibility(params: {
  connectedWallet: string | undefined | null;
  clientAddress: string;
  freelancerAddress: string;
  chainId: number | undefined;
  dealState: DealState;
  milestones: readonly StandardV2OnChainMilestone[];
  isProtected?: boolean;
  targetMilestoneIndex?: number;
  hasVerifiedEvidence?: boolean;
}): RequestChangesEligibilityResult {
  const role = determineDealRole(params.connectedWallet, params.clientAddress, params.freelancerAddress);

  if (params.dealState !== DealState.Active) {
    const stateLabel = DEAL_STATE_LABELS[params.dealState] ?? `State (${params.dealState})`;
    return {
      canRequestChanges: false,
      role,
      targetMilestoneIndex: null,
      reason: `Deal is not in Active state (current: ${stateLabel}). Changes cannot be requested.`,
    };
  }

  if (params.isProtected) {
    return {
      canRequestChanges: false,
      role,
      targetMilestoneIndex: null,
      reason: 'Protected deals cannot request revision (use assessment/rejection flow).',
    };
  }

  if (role !== 'client') {
    return {
      canRequestChanges: false,
      role,
      targetMilestoneIndex: null,
      reason: 'Only the client can request changes for this milestone.',
    };
  }

  const targetIndex = params.targetMilestoneIndex ?? getCurrentMilestoneIndex(params.milestones);
  if (targetIndex === null || targetIndex >= params.milestones.length) {
    return {
      canRequestChanges: false,
      role,
      targetMilestoneIndex: null,
      reason: 'No unsettled milestones found in deal schedule.',
    };
  }

  const targetMilestone = params.milestones[targetIndex];
  if (targetMilestone.status !== MilestoneStatus.Submitted) {
    const statusLabel = MILESTONE_STATUS_LABELS[targetMilestone.status] ?? `Status (${targetMilestone.status})`;
    return {
      canRequestChanges: false,
      role,
      targetMilestoneIndex: targetIndex,
      reason: `Milestone ${targetIndex + 1} is not in Submitted status (current: ${statusLabel}). Changes can only be requested on submitted deliverables.`,
    };
  }

  if (params.hasVerifiedEvidence === false) {
    return {
      canRequestChanges: false,
      role,
      targetMilestoneIndex: targetIndex,
      reason: 'Canonical submitted evidence manifest must be cryptographically verified before requesting changes.',
    };
  }

  return {
    canRequestChanges: true,
    role,
    targetMilestoneIndex: targetIndex,
  };
}

/**
 * Preflight validation before broadcasting requestRevision(milestoneId, reasonHash, proposedRevisionDeadline).
 * Verifies caller, state, milestone status, version anchor, and boundary conditions.
 */
export function validateRequestChangesPreflight(params: {
  connectedWallet: string;
  clientAddress: string;
  chainId: number | undefined;
  isCanonicalV2Deal: boolean;
  dealState: DealState;
  isProtected: boolean;
  targetMilestoneIndex: number;
  milestones: readonly StandardV2OnChainMilestone[];
  currentTimeSeconds: bigint;
  stagedRevision: {
    submissionVersion: number;
    specHash: string;
    evidenceRootHash: string;
    proposedRevisionDeadline: bigint;
  };
}): { valid: boolean; error?: string } {
  if (!params.connectedWallet || params.connectedWallet.toLowerCase() !== params.clientAddress.toLowerCase()) {
    return { valid: false, error: 'Unauthorized: Only the designated client can request revision' };
  }

  if (params.chainId !== SEPOLIA_CHAIN_ID) {
    return { valid: false, error: `Invalid network: wallet is connected to chain ${params.chainId}, expected Sepolia (${SEPOLIA_CHAIN_ID})` };
  }

  if (!params.isCanonicalV2Deal) {
    return { valid: false, error: 'Deal contract address is not a registered canonical V2 Deal' };
  }

  if (params.dealState !== DealState.Active) {
    return { valid: false, error: `Deal is not in Active state (current state: ${params.dealState})` };
  }

  if (params.isProtected) {
    return { valid: false, error: 'Protected deals cannot request revision' };
  }

  if (params.targetMilestoneIndex < 0 || params.targetMilestoneIndex >= params.milestones.length) {
    return { valid: false, error: `Invalid target milestone index: ${params.targetMilestoneIndex}` };
  }

  const targetMilestone = params.milestones[params.targetMilestoneIndex];
  if (targetMilestone.status !== MilestoneStatus.Submitted) {
    return { valid: false, error: `Milestone ${params.targetMilestoneIndex + 1} is not in Submitted status (current: ${targetMilestone.status})` };
  }

  if (targetMilestone.version !== params.stagedRevision.submissionVersion) {
    return { valid: false, error: `Milestone version mismatch: on-chain version is v${targetMilestone.version}, staged request is for v${params.stagedRevision.submissionVersion}` };
  }

  if (targetMilestone.specHash.toLowerCase() !== params.stagedRevision.specHash.toLowerCase()) {
    return { valid: false, error: 'Milestone specHash mismatch: on-chain specHash does not match staged revision' };
  }

  if (targetMilestone.evidenceRootHash.toLowerCase() !== params.stagedRevision.evidenceRootHash.toLowerCase()) {
    return { valid: false, error: 'Milestone evidenceRootHash mismatch: on-chain deliverable does not match staged revision' };
  }

  if (params.stagedRevision.proposedRevisionDeadline <= params.currentTimeSeconds) {
    return { valid: false, error: 'Proposed revision deadline must be strictly in the future' };
  }

  if (params.stagedRevision.proposedRevisionDeadline > params.currentTimeSeconds + 365n * 86400n) {
    return { valid: false, error: 'Proposed revision deadline exceeds maximum bound of 365 days' };
  }

  return { valid: true };
}

export interface FreelancerRevisionResponseEligibilityResult {
  canRespond: boolean;
  canAccept: boolean;
  canDecline: boolean;
  role: DealParticipantRole;
  targetMilestoneIndex: number | null;
  isDeadlineExpired: boolean;
  reason?: string;
}

/**
 * Pure evaluation of freelancer response eligibility (Accept / Decline).
 * Solidity rules: onlyFreelancer, inDealState(DealState.Active), status == RevisionRequested.
 * Accept requires: proposedRevisionDeadlines[milestoneId] > block.timestamp.
 * Decline is always available while RevisionRequested.
 */
export function determineFreelancerRevisionResponseEligibility(params: {
  connectedWallet: string | undefined | null;
  clientAddress: string;
  freelancerAddress: string;
  chainId: number | undefined;
  dealState: DealState;
  milestones: readonly StandardV2OnChainMilestone[];
  currentTimeSeconds?: bigint;
  targetMilestoneIndex?: number;
}): FreelancerRevisionResponseEligibilityResult {
  const role = determineDealRole(params.connectedWallet, params.clientAddress, params.freelancerAddress);

  if (params.dealState !== DealState.Active) {
    const stateLabel = DEAL_STATE_LABELS[params.dealState] ?? `State (${params.dealState})`;
    return {
      canRespond: false,
      canAccept: false,
      canDecline: false,
      role,
      targetMilestoneIndex: null,
      isDeadlineExpired: false,
      reason: `Deal is not in Active state (current: ${stateLabel}). Revision response unavailable.`,
    };
  }

  if (role !== 'freelancer') {
    return {
      canRespond: false,
      canAccept: false,
      canDecline: false,
      role,
      targetMilestoneIndex: null,
      isDeadlineExpired: false,
      reason: 'Only the designated freelancer can respond to a revision request.',
    };
  }

  const targetIndex = params.targetMilestoneIndex ?? getCurrentMilestoneIndex(params.milestones);
  if (targetIndex === null || targetIndex >= params.milestones.length) {
    return {
      canRespond: false,
      canAccept: false,
      canDecline: false,
      role,
      targetMilestoneIndex: null,
      isDeadlineExpired: false,
      reason: 'No active milestones found in deal schedule.',
    };
  }

  const targetMilestone = params.milestones[targetIndex];
  if (targetMilestone.status !== MilestoneStatus.RevisionRequested) {
    const statusLabel = MILESTONE_STATUS_LABELS[targetMilestone.status] ?? `Status (${targetMilestone.status})`;
    return {
      canRespond: false,
      canAccept: false,
      canDecline: false,
      role,
      targetMilestoneIndex: targetIndex,
      isDeadlineExpired: false,
      reason: `Milestone ${targetIndex + 1} is not in RevisionRequested status (current: ${statusLabel}).`,
    };
  }

  const now = params.currentTimeSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  const proposedDeadline = targetMilestone.proposedRevisionDeadline ?? 0n;
  const isDeadlineExpired = proposedDeadline > 0n && now >= proposedDeadline;

  return {
    canRespond: true,
    canAccept: !isDeadlineExpired,
    canDecline: true,
    role,
    targetMilestoneIndex: targetIndex,
    isDeadlineExpired,
    reason: isDeadlineExpired
      ? 'The proposed revision deadline has expired on-chain. This revision can no longer be accepted, but it can be declined.'
      : undefined,
  };
}

/**
 * Preflight validation before broadcasting acceptRevision(milestoneId).
 */
export function validateAcceptRevisionPreflight(params: {
  connectedWallet: string;
  freelancerAddress: string;
  chainId: number | undefined;
  isCanonicalV2Deal: boolean;
  dealState: DealState;
  targetMilestoneIndex: number;
  milestones: readonly StandardV2OnChainMilestone[];
  proposedRevisionDeadline: bigint;
  currentTimeSeconds: bigint;
}): { valid: boolean; error?: string } {
  if (!params.connectedWallet || params.connectedWallet.toLowerCase() !== params.freelancerAddress.toLowerCase()) {
    return { valid: false, error: 'Unauthorized: Only the designated freelancer can accept revision' };
  }

  if (params.chainId !== SEPOLIA_CHAIN_ID) {
    return { valid: false, error: `Invalid network: wallet is connected to chain ${params.chainId}, expected Sepolia (${SEPOLIA_CHAIN_ID})` };
  }

  if (!params.isCanonicalV2Deal) {
    return { valid: false, error: 'Deal contract address is not a registered canonical V2 Deal' };
  }

  if (params.dealState !== DealState.Active) {
    return { valid: false, error: `Deal is not in Active state (current state: ${params.dealState})` };
  }

  if (params.targetMilestoneIndex < 0 || params.targetMilestoneIndex >= params.milestones.length) {
    return { valid: false, error: `Invalid target milestone index: ${params.targetMilestoneIndex}` };
  }

  const targetMilestone = params.milestones[params.targetMilestoneIndex];
  if (targetMilestone.status !== MilestoneStatus.RevisionRequested) {
    return { valid: false, error: `Milestone ${params.targetMilestoneIndex + 1} is not in RevisionRequested status (current: ${targetMilestone.status})` };
  }

  if (params.proposedRevisionDeadline <= params.currentTimeSeconds) {
    return { valid: false, error: 'Proposed revision deadline has already expired' };
  }

  return { valid: true };
}

/**
 * Receipt parser for acceptRevision(milestoneId).
 * Decodes RevisionAccepted(uint256 indexed milestoneId, uint64 newDeadline).
 */
export function verifyAcceptRevisionReceipt(
  receipt: { status: string; logs: readonly any[] },
  dealAddress: string,
  expectedMilestoneId: bigint,
  expectedNewDeadline?: bigint
): {
  valid: boolean;
  error?: string;
  revisionAcceptedEvent?: {
    milestoneId: bigint;
    newDeadline: bigint;
  };
} {
  if (receipt.status !== 'success') {
    return { valid: false, error: 'Transaction reverted on-chain' };
  }

  const normalizedDeal = dealAddress.toLowerCase();

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== normalizedDeal) continue;

    try {
      const decoded = decodeEventLog({
        abi: synqDealV1ABI,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === 'RevisionAccepted') {
        const args = decoded.args as unknown as {
          milestoneId: bigint;
          newDeadline: bigint;
        };

        if (BigInt(args.milestoneId) !== expectedMilestoneId) {
          return {
            valid: false,
            error: `RevisionAccepted emitted for unexpected milestone ID: ${args.milestoneId.toString()} (expected ${expectedMilestoneId.toString()})`,
          };
        }

        if (expectedNewDeadline !== undefined && BigInt(args.newDeadline) !== expectedNewDeadline) {
          return {
            valid: false,
            error: `RevisionAccepted emitted for unexpected deadline: ${args.newDeadline.toString()} (expected ${expectedNewDeadline.toString()})`,
          };
        }

        return {
          valid: true,
          revisionAcceptedEvent: {
            milestoneId: BigInt(args.milestoneId),
            newDeadline: BigInt(args.newDeadline),
          },
        };
      }
    } catch {
      // Continue searching logs
    }
  }

  return {
    valid: false,
    error: 'Transaction confirmed but RevisionAccepted event was not found from the deal contract',
  };
}

/**
 * Preflight validation before broadcasting declineRevision(milestoneId).
 */
export function validateDeclineRevisionPreflight(params: {
  connectedWallet: string;
  freelancerAddress: string;
  chainId: number | undefined;
  isCanonicalV2Deal: boolean;
  dealState: DealState;
  targetMilestoneIndex: number;
  milestones: readonly StandardV2OnChainMilestone[];
}): { valid: boolean; error?: string } {
  if (!params.connectedWallet || params.connectedWallet.toLowerCase() !== params.freelancerAddress.toLowerCase()) {
    return { valid: false, error: 'Unauthorized: Only the designated freelancer can decline revision' };
  }

  if (params.chainId !== SEPOLIA_CHAIN_ID) {
    return { valid: false, error: `Invalid network: wallet is connected to chain ${params.chainId}, expected Sepolia (${SEPOLIA_CHAIN_ID})` };
  }

  if (!params.isCanonicalV2Deal) {
    return { valid: false, error: 'Deal contract address is not a registered canonical V2 Deal' };
  }

  if (params.dealState !== DealState.Active) {
    return { valid: false, error: `Deal is not in Active state (current state: ${params.dealState})` };
  }

  if (params.targetMilestoneIndex < 0 || params.targetMilestoneIndex >= params.milestones.length) {
    return { valid: false, error: `Invalid target milestone index: ${params.targetMilestoneIndex}` };
  }

  const targetMilestone = params.milestones[params.targetMilestoneIndex];
  if (targetMilestone.status !== MilestoneStatus.RevisionRequested) {
    return { valid: false, error: `Milestone ${params.targetMilestoneIndex + 1} is not in RevisionRequested status (current: ${targetMilestone.status})` };
  }

  return { valid: true };
}

/**
 * Receipt parser for declineRevision(milestoneId).
 * Decodes RevisionDeclined(uint256 indexed milestoneId) and/or MilestoneDisputed(uint256,address,bytes32).
 */
export function verifyDeclineRevisionReceipt(
  receipt: { status: string; logs: readonly any[] },
  dealAddress: string,
  expectedMilestoneId: bigint
): {
  valid: boolean;
  error?: string;
  milestoneId?: bigint;
} {
  if (receipt.status !== 'success') {
    return { valid: false, error: 'Transaction reverted on-chain' };
  }

  const normalizedDeal = dealAddress.toLowerCase();
  let foundDeclined = false;
  let foundDisputed = false;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== normalizedDeal) continue;

    try {
      const decoded = decodeEventLog({
        abi: synqDealV1ABI,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === 'RevisionDeclined') {
        const args = decoded.args as unknown as { milestoneId: bigint };
        if (BigInt(args.milestoneId) === expectedMilestoneId) {
          foundDeclined = true;
        }
      }

      if (decoded.eventName === 'MilestoneDisputed') {
        const args = decoded.args as unknown as { milestoneId: bigint; opener: string; reasonHash: string };
        if (BigInt(args.milestoneId) === expectedMilestoneId) {
          foundDisputed = true;
        }
      }
    } catch {
      // Continue searching logs
    }
  }

  if (foundDeclined || foundDisputed) {
    return { valid: true, milestoneId: expectedMilestoneId };
  }

  return {
    valid: false,
    error: 'Transaction confirmed but RevisionDeclined / MilestoneDisputed event was not found from the deal contract',
  };
}

export interface TimeoutRevisionResponseEligibilityResult {
  canTimeout: boolean;
  isExpired: boolean;
  targetMilestoneIndex: number | null;
  revisionRequestedAt: bigint;
  responseDeadline: bigint;
  reason?: string;
}

/**
 * Pure evaluation of permissionless revision response timeout eligibility.
 * Solidity rule: inDealState(DealState.Active), validMilestone, status == RevisionRequested,
 * block.timestamp > revisionRequestedAt[milestoneId] + REVISION_RESPONSE_WINDOW (strictly >).
 */
export function determineTimeoutRevisionResponseEligibility(params: {
  dealState: DealState;
  milestones: readonly StandardV2OnChainMilestone[];
  currentTimeSeconds: bigint;
  targetMilestoneIndex?: number;
}): TimeoutRevisionResponseEligibilityResult {
  if (params.dealState !== DealState.Active) {
    return {
      canTimeout: false,
      isExpired: false,
      targetMilestoneIndex: null,
      revisionRequestedAt: 0n,
      responseDeadline: 0n,
      reason: 'Deal is not in Active state.',
    };
  }

  const targetIndex = params.targetMilestoneIndex ?? getCurrentMilestoneIndex(params.milestones);
  if (targetIndex === null || targetIndex >= params.milestones.length) {
    return {
      canTimeout: false,
      isExpired: false,
      targetMilestoneIndex: null,
      revisionRequestedAt: 0n,
      responseDeadline: 0n,
      reason: 'No unsettled milestones found in deal schedule.',
    };
  }

  const targetMilestone = params.milestones[targetIndex];
  if (targetMilestone.status !== MilestoneStatus.RevisionRequested) {
    return {
      canTimeout: false,
      isExpired: false,
      targetMilestoneIndex: targetIndex,
      revisionRequestedAt: 0n,
      responseDeadline: 0n,
      reason: `Milestone ${targetIndex + 1} is not in RevisionRequested status.`,
    };
  }

  const requestedAt = targetMilestone.revisionRequestedAt ?? 0n;
  const responseDeadline = requestedAt + REVISION_RESPONSE_WINDOW;

  // Solidity rule: strictly block.timestamp > revisionRequestedAt + REVISION_RESPONSE_WINDOW
  const isExpired = requestedAt > 0n && params.currentTimeSeconds > responseDeadline;

  return {
    canTimeout: isExpired,
    isExpired,
    targetMilestoneIndex: targetIndex,
    revisionRequestedAt: requestedAt,
    responseDeadline,
    reason: isExpired
      ? undefined
      : 'Revision response window (48 hours) has not yet expired on-chain.',
  };
}

/**
 * Preflight validation before broadcasting timeoutRevisionResponse(milestoneId).
 */
export function validateTimeoutRevisionResponsePreflight(params: {
  chainId: number | undefined;
  isCanonicalV2Deal: boolean;
  dealState: DealState;
  targetMilestoneIndex: number;
  milestones: readonly StandardV2OnChainMilestone[];
  revisionRequestedAt: bigint;
  currentTimeSeconds: bigint;
}): { valid: boolean; error?: string } {
  if (params.chainId !== SEPOLIA_CHAIN_ID) {
    return { valid: false, error: `Invalid network: wallet is connected to chain ${params.chainId}, expected Sepolia (${SEPOLIA_CHAIN_ID})` };
  }

  if (!params.isCanonicalV2Deal) {
    return { valid: false, error: 'Deal contract address is not a registered canonical V2 Deal' };
  }

  if (params.dealState !== DealState.Active) {
    return { valid: false, error: `Deal is not in Active state (current state: ${params.dealState})` };
  }

  if (params.targetMilestoneIndex < 0 || params.targetMilestoneIndex >= params.milestones.length) {
    return { valid: false, error: `Invalid target milestone index: ${params.targetMilestoneIndex}` };
  }

  const targetMilestone = params.milestones[params.targetMilestoneIndex];
  if (targetMilestone.status !== MilestoneStatus.RevisionRequested) {
    return { valid: false, error: `Milestone ${params.targetMilestoneIndex + 1} is not in RevisionRequested status (current: ${targetMilestone.status})` };
  }

  if (params.currentTimeSeconds <= params.revisionRequestedAt + REVISION_RESPONSE_WINDOW) {
    return { valid: false, error: 'Revision response window not expired' };
  }

  return { valid: true };
}

/**
 * Receipt parser for timeoutRevisionResponse(milestoneId).
 * Decodes MilestoneDisputed(uint256,address,bytes32) where opener == address(0).
 */
export function verifyTimeoutRevisionResponseReceipt(
  receipt: { status: string; logs: readonly any[] },
  dealAddress: string,
  expectedMilestoneId: bigint
): {
  valid: boolean;
  error?: string;
  milestoneId?: bigint;
} {
  if (receipt.status !== 'success') {
    return { valid: false, error: 'Transaction reverted on-chain' };
  }

  const normalizedDeal = dealAddress.toLowerCase();

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== normalizedDeal) continue;

    try {
      const decoded = decodeEventLog({
        abi: synqDealV1ABI,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === 'MilestoneDisputed') {
        const args = decoded.args as unknown as { milestoneId: bigint; opener: string; reasonHash: string };

        if (BigInt(args.milestoneId) !== expectedMilestoneId) {
          return {
            valid: false,
            error: `MilestoneDisputed emitted for unexpected milestone ID: ${args.milestoneId.toString()} (expected ${expectedMilestoneId.toString()})`,
          };
        }

        return { valid: true, milestoneId: expectedMilestoneId };
      }
    } catch {
      // Continue searching logs
    }
  }

  return {
    valid: false,
    error: 'Transaction confirmed but MilestoneDisputed event was not found from the deal contract',
  };
}

// --- Blockchain Read Helpers ---

export interface PublicClientLike {
  readContract: (params: {
    address: `0x${string}`;
    abi: any;
    functionName: string;
    args?: any[];
  }) => Promise<any>;
  getTransactionReceipt?: (params: {
    hash: `0x${string}`;
  }) => Promise<any>;
  getLogs?: (params: any) => Promise<any>;
}

/**
 * Checks whether an address is a canonical Synq Deal registered with SynqFactoryV2 on Sepolia.
 */
export async function isSynqV2Deal(
  dealAddress: string,
  publicClient: PublicClientLike
): Promise<boolean> {
  if (!isAddress(dealAddress)) {
    return false;
  }

  try {
    const isDeal = await publicClient.readContract({
      address: SYNQ_V2_SEPOLIA_CONFIG.factory,
      abi: synqFactoryV2ABI,
      functionName: 'isSynqDeal',
      args: [getAddress(dealAddress)],
    });
    return Boolean(isDeal);
  } catch {
    return false;
  }
}

/**
 * Reads full Standard V2 Deal data from the on-chain contract.
 * Fails closed if the deal is not canonical or reads fail.
 */
export async function readStandardV2DealData(
  dealAddress: string,
  publicClient: PublicClientLike
): Promise<StandardV2DealData> {
  if (!isAddress(dealAddress)) {
    throw new Error(`Invalid deal address: ${dealAddress}`);
  }

  const checksummedDeal = getAddress(dealAddress);

  // 1. Verify canonical Factory V2 registration
  const isRegistered = await isSynqV2Deal(checksummedDeal, publicClient);
  if (!isRegistered) {
    throw new Error(`Address ${dealAddress} is not a canonical V2 Deal registered with SynqFactoryV2`);
  }

  // 2. Read core contract variables
  const [
    stateNum,
    client,
    freelancer,
    usdcAddress,
    totalEscrow,
    totalSettled,
    milestoneCountBn,
    isProtected,
    policyId,
    primaryResolver,
    emergencyResolver,
  ] = await Promise.all([
    publicClient.readContract({ address: checksummedDeal, abi: synqDealV1ABI, functionName: 'state' }) as Promise<number>,
    publicClient.readContract({ address: checksummedDeal, abi: synqDealV1ABI, functionName: 'client' }) as Promise<`0x${string}`>,
    publicClient.readContract({ address: checksummedDeal, abi: synqDealV1ABI, functionName: 'freelancer' }) as Promise<`0x${string}`>,
    publicClient.readContract({ address: checksummedDeal, abi: synqDealV1ABI, functionName: 'usdc' }) as Promise<`0x${string}`>,
    publicClient.readContract({ address: checksummedDeal, abi: synqDealV1ABI, functionName: 'totalEscrow' }) as Promise<bigint>,
    publicClient.readContract({ address: checksummedDeal, abi: synqDealV1ABI, functionName: 'totalSettled' }) as Promise<bigint>,
    publicClient.readContract({ address: checksummedDeal, abi: synqDealV1ABI, functionName: 'milestoneCount' }) as Promise<bigint>,
    publicClient.readContract({ address: checksummedDeal, abi: synqDealV1ABI, functionName: 'isProtected' }) as Promise<boolean>,
    publicClient.readContract({ address: checksummedDeal, abi: synqDealV1ABI, functionName: 'policyId' }) as Promise<`0x${string}`>,
    publicClient.readContract({ address: checksummedDeal, abi: synqDealV1ABI, functionName: 'primaryResolver' }) as Promise<`0x${string}`>,
    publicClient.readContract({ address: checksummedDeal, abi: synqDealV1ABI, functionName: 'emergencyResolver' }) as Promise<`0x${string}`>,
  ]);

  // 3. Verify canonical USDC address
  if (usdcAddress.toLowerCase() !== SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc.toLowerCase()) {
    throw new Error(`Deal USDC mismatch: contract reports ${usdcAddress}, expected canonical ${SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc}`);
  }

  // 4. Read each milestone
  const count = Number(milestoneCountBn);
  const milestonePromises = [];
  for (let i = 0; i < count; i++) {
    milestonePromises.push(
      publicClient.readContract({
        address: checksummedDeal,
        abi: synqDealV1ABI,
        functionName: 'getMilestone',
        args: [BigInt(i)],
      })
    );
  }
  const rawMilestones = await Promise.all(milestonePromises);

  // Read revision mappings for milestones in RevisionRequested status
  const revisionMappingPromises = rawMilestones.map(async (raw: any, index: number) => {
    const status = Number(raw[4] ?? raw.status) as MilestoneStatus;
    if (status === MilestoneStatus.RevisionRequested) {
      try {
        const [proposedDeadline, requestedAt] = await Promise.all([
          publicClient.readContract({
            address: checksummedDeal,
            abi: synqDealV1ABI,
            functionName: 'proposedRevisionDeadlines',
            args: [BigInt(index)],
          }),
          publicClient.readContract({
            address: checksummedDeal,
            abi: synqDealV1ABI,
            functionName: 'revisionRequestedAt',
            args: [BigInt(index)],
          }),
        ]);
        return {
          proposedRevisionDeadline: BigInt(proposedDeadline ?? 0),
          revisionRequestedAt: BigInt(requestedAt ?? 0),
        };
      } catch {
        return { proposedRevisionDeadline: 0n, revisionRequestedAt: 0n };
      }
    }
    return { proposedRevisionDeadline: 0n, revisionRequestedAt: 0n };
  });

  const revisionData = await Promise.all(revisionMappingPromises);

  const milestones: StandardV2OnChainMilestone[] = rawMilestones.map((raw: any, index: number) => {
    // raw is tuple: (amount, workDeadline, reviewWindow, gracePeriod, status, specHash, evidenceRootHash, submittedAt, version)
    return {
      index,
      amount: BigInt(raw[0] ?? raw.amount),
      workDeadline: BigInt(raw[1] ?? raw.workDeadline),
      reviewWindow: BigInt(raw[2] ?? raw.reviewWindow),
      gracePeriod: BigInt(raw[3] ?? raw.gracePeriod),
      status: Number(raw[4] ?? raw.status) as MilestoneStatus,
      specHash: (raw[5] ?? raw.specHash) as `0x${string}`,
      evidenceRootHash: (raw[6] ?? raw.evidenceRootHash) as `0x${string}`,
      submittedAt: BigInt(raw[7] ?? raw.submittedAt),
      version: Number(raw[8] ?? raw.version),
      proposedRevisionDeadline: revisionData[index]?.proposedRevisionDeadline,
      revisionRequestedAt: revisionData[index]?.revisionRequestedAt,
    };
  });

  return {
    dealAddress: checksummedDeal,
    client: getAddress(client),
    freelancer: getAddress(freelancer),
    usdc: getAddress(usdcAddress),
    state: Number(stateNum) as DealState,
    totalEscrow: BigInt(totalEscrow),
    totalSettled: BigInt(totalSettled),
    milestoneCount: count,
    milestones,
    isProtected: Boolean(isProtected),
    policyId,
    primaryResolver: getAddress(primaryResolver),
    emergencyResolver: getAddress(emergencyResolver),
  };
}

/**
 * Reads the client's current canonical USDC balance and allowance for the specific deal contract.
 */
export async function readClientUsdcFundingState(
  clientAddress: string,
  dealAddress: string,
  publicClient: PublicClientLike
): Promise<{ balance: bigint; allowance: bigint }> {
  if (!isAddress(clientAddress) || !isAddress(dealAddress)) {
    return { balance: 0n, allowance: 0n };
  }

  const [balance, allowance] = await Promise.all([
    publicClient.readContract({
      address: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      abi: erc20ABI,
      functionName: 'balanceOf',
      args: [getAddress(clientAddress)],
    }) as Promise<bigint>,
    publicClient.readContract({
      address: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      abi: erc20ABI,
      functionName: 'allowance',
      args: [getAddress(clientAddress), getAddress(dealAddress)],
    }) as Promise<bigint>,
  ]);

  return {
    balance: BigInt(balance),
    allowance: BigInt(allowance),
  };
}

export {
  hashRevisionManifest,
  normalizeRevisionManifest,
  canonicalizeRevisionManifest,
  verifyRevisionRequestedReceipt,
  type CanonicalRevisionManifestV1,
} from '@/lib/deals/v2-revision';

/**
 * Reads the canonical ResolutionProposal for a milestone on a Standard V2 Deal.
 * Preserves exact base-unit financial values without floating point conversion.
 */
export async function readResolutionProposal(
  dealAddress: string,
  milestoneId: number,
  publicClient: PublicClientLike
): Promise<StandardV2ResolutionProposal> {
  if (!isAddress(dealAddress)) {
    throw new Error(`Invalid deal address: ${dealAddress}`);
  }
  if (!Number.isInteger(milestoneId) || milestoneId < 0) {
    throw new Error(`Invalid milestoneId: ${milestoneId}`);
  }

  const raw = (await publicClient.readContract({
    address: getAddress(dealAddress),
    abi: synqDealV1ABI,
    functionName: 'getResolutionProposal',
    args: [BigInt(milestoneId)],
  })) as any;

  return {
    freelancerAmount: BigInt(raw.freelancerAmount ?? raw[0] ?? 0n),
    clientAmount: BigInt(raw.clientAmount ?? raw[1] ?? 0n),
    justificationHash: (raw.justificationHash ?? raw[2] ?? ZERO_BYTES32) as `0x${string}`,
    proposedAt: BigInt(raw.proposedAt ?? raw[3] ?? 0n),
    reconsiderationDeadline: BigInt(raw.reconsiderationDeadline ?? raw[4] ?? 0n),
    resolver: getAddress(raw.resolver ?? raw[5] ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
  };
}

/**
 * Verifies confirmed transaction receipt for requestFinalReconsideration(milestoneId).
 * Validates that FinalReconsiderationRequested was emitted by the exact Deal address with the expected milestoneId and participant.
 */
export function verifyFinalReconsiderationRequestedReceipt(
  receipt: { status: string | number; logs: readonly any[] },
  dealAddress: string,
  expectedMilestoneId: bigint,
  expectedParticipant: string
): {
  valid: boolean;
  error?: string;
  finalReconsiderationRequestedEvent?: {
    milestoneId: bigint;
    participant: `0x${string}`;
  };
} {
  const isSuccess = receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1';
  if (!isSuccess) {
    return { valid: false, error: 'Transaction reverted on-chain' };
  }

  if (!isAddress(dealAddress)) {
    return { valid: false, error: `Invalid dealAddress: ${dealAddress}` };
  }
  if (!isAddress(expectedParticipant)) {
    return { valid: false, error: `Invalid expectedParticipant: ${expectedParticipant}` };
  }

  const normalizedDeal = dealAddress.toLowerCase();
  const normalizedParticipant = expectedParticipant.toLowerCase();

  for (const log of receipt.logs) {
    if (!log.address || log.address.toLowerCase() !== normalizedDeal) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: synqDealV1ABI,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === 'FinalReconsiderationRequested') {
        const args = decoded.args as unknown as {
          milestoneId: bigint;
          participant: `0x${string}`;
        };

        if (BigInt(args.milestoneId) !== expectedMilestoneId) {
          return {
            valid: false,
            error: `FinalReconsiderationRequested emitted for unexpected milestone ID: ${args.milestoneId.toString()} (expected ${expectedMilestoneId.toString()})`,
          };
        }

        if (args.participant.toLowerCase() !== normalizedParticipant) {
          return {
            valid: false,
            error: `FinalReconsiderationRequested emitted for unexpected participant: ${args.participant} (expected ${normalizedParticipant})`,
          };
        }

        return {
          valid: true,
          finalReconsiderationRequestedEvent: {
            milestoneId: BigInt(args.milestoneId),
            participant: getAddress(args.participant) as `0x${string}`,
          },
        };
      }
    } catch {
      // Continue inspecting other logs
    }
  }

  return {
    valid: false,
    error: 'FinalReconsiderationRequested event not found in transaction receipt from the Deal contract',
  };
}

/**
 * Verifies confirmed transaction receipt for executeResolution(milestoneId).
 * Validates that ResolutionExecuted and MilestoneSettled (with SettlementType.ResolverResolution)
 * were emitted by the exact Deal address with the expected milestoneId, resolver, and split amounts.
 *
 * Explicitly rejects:
 * - Receipts containing only FinalResolutionExecuted (this is NOT final committee execution)
 * - Receipts containing SettlementType.MutualSettlement
 */
export function verifyExecuteResolutionReceipt(
  receipt: { status: string | number; logs: readonly any[] },
  dealAddress: string,
  expectedMilestoneId: bigint,
  expectedResolver: string,
  expectedFreelancerAmount: bigint,
  expectedClientAmount: bigint
): {
  valid: boolean;
  error?: string;
  resolutionExecutedEvent?: {
    milestoneId: bigint;
    resolver: `0x${string}`;
    freelancerAmount: bigint;
    clientAmount: bigint;
  };
  milestoneSettledEvent?: {
    milestoneId: bigint;
    paidToFreelancer: bigint;
    refundedToClient: bigint;
    settlementType: SettlementType;
  };
} {
  const isSuccess = receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1';
  if (!isSuccess) {
    return { valid: false, error: 'Transaction reverted on-chain' };
  }

  if (!isAddress(dealAddress)) {
    return { valid: false, error: `Invalid dealAddress: ${dealAddress}` };
  }
  if (!isAddress(expectedResolver)) {
    return { valid: false, error: `Invalid expectedResolver: ${expectedResolver}` };
  }

  const normalizedDeal = dealAddress.toLowerCase();
  const normalizedResolver = expectedResolver.toLowerCase();

  let resolutionExecutedEvent:
    | {
        milestoneId: bigint;
        resolver: `0x${string}`;
        freelancerAmount: bigint;
        clientAmount: bigint;
      }
    | undefined;

  let milestoneSettledEvent:
    | {
        milestoneId: bigint;
        paidToFreelancer: bigint;
        refundedToClient: bigint;
        settlementType: SettlementType;
      }
    | undefined;

  let hasFinalResolutionExecuted = false;

  for (const log of receipt.logs) {
    if (!log.address || log.address.toLowerCase() !== normalizedDeal) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: synqDealV1ABI,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === 'FinalResolutionExecuted') {
        hasFinalResolutionExecuted = true;
      }

      if (decoded.eventName === 'ResolutionExecuted') {
        const args = decoded.args as unknown as {
          milestoneId: bigint;
          resolver: `0x${string}`;
          freelancerAmount: bigint;
          clientAmount: bigint;
        };

        if (BigInt(args.milestoneId) !== expectedMilestoneId) {
          return {
            valid: false,
            error: `ResolutionExecuted emitted for unexpected milestone ID: ${args.milestoneId.toString()} (expected ${expectedMilestoneId.toString()})`,
          };
        }

        if (args.resolver.toLowerCase() !== normalizedResolver) {
          return {
            valid: false,
            error: `ResolutionExecuted resolver mismatch: ${args.resolver} (expected ${normalizedResolver})`,
          };
        }

        if (BigInt(args.freelancerAmount) !== expectedFreelancerAmount) {
          return {
            valid: false,
            error: `ResolutionExecuted freelancer amount mismatch: ${args.freelancerAmount.toString()} (expected ${expectedFreelancerAmount.toString()})`,
          };
        }

        if (BigInt(args.clientAmount) !== expectedClientAmount) {
          return {
            valid: false,
            error: `ResolutionExecuted client amount mismatch: ${args.clientAmount.toString()} (expected ${expectedClientAmount.toString()})`,
          };
        }

        resolutionExecutedEvent = {
          milestoneId: BigInt(args.milestoneId),
          resolver: getAddress(args.resolver) as `0x${string}`,
          freelancerAmount: BigInt(args.freelancerAmount),
          clientAmount: BigInt(args.clientAmount),
        };
      }

      if (decoded.eventName === 'MilestoneSettled') {
        const args = decoded.args as unknown as {
          milestoneId: bigint;
          paidToFreelancer: bigint;
          refundedToClient: bigint;
          settlementType: number;
        };

        if (BigInt(args.milestoneId) !== expectedMilestoneId) {
          return {
            valid: false,
            error: `MilestoneSettled emitted for unexpected milestone ID: ${args.milestoneId.toString()} (expected ${expectedMilestoneId.toString()})`,
          };
        }

        if (BigInt(args.paidToFreelancer) !== expectedFreelancerAmount) {
          return {
            valid: false,
            error: `MilestoneSettled paidToFreelancer mismatch: ${args.paidToFreelancer.toString()} (expected ${expectedFreelancerAmount.toString()})`,
          };
        }

        if (BigInt(args.refundedToClient) !== expectedClientAmount) {
          return {
            valid: false,
            error: `MilestoneSettled refundedToClient mismatch: ${args.refundedToClient.toString()} (expected ${expectedClientAmount.toString()})`,
          };
        }

        if (Number(args.settlementType) !== SettlementType.ResolverResolution) {
          return {
            valid: false,
            error: `MilestoneSettled settlementType mismatch: expected ResolverResolution (${SettlementType.ResolverResolution}), received ${args.settlementType}`,
          };
        }

        milestoneSettledEvent = {
          milestoneId: BigInt(args.milestoneId),
          paidToFreelancer: BigInt(args.paidToFreelancer),
          refundedToClient: BigInt(args.refundedToClient),
          settlementType: Number(args.settlementType),
        };
      }
    } catch {
      // Continue inspecting other logs
    }
  }

  if (hasFinalResolutionExecuted && !resolutionExecutedEvent) {
    return {
      valid: false,
      error: 'Receipt indicates FinalResolutionExecuted instead of ordinary ResolutionExecuted',
    };
  }

  if (!resolutionExecutedEvent) {
    return {
      valid: false,
      error: 'ResolutionExecuted event not found in transaction receipt from the Deal contract',
    };
  }

  if (!milestoneSettledEvent) {
    return {
      valid: false,
      error: 'MilestoneSettled event with SettlementType.ResolverResolution not found in receipt',
    };
  }

  return {
    valid: true,
    resolutionExecutedEvent,
    milestoneSettledEvent,
  };
}

