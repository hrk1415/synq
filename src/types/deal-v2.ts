/**
 * Synq Standard V2 Protocol Types
 * Source of truth: contracts/v1/SynqFactoryV2.sol & contracts/v1/SynqDealTypes.sol
 */

/**
 * Exact MilestoneInit struct expected by SynqFactoryV2 and SynqDealV1.
 * Matches: tuple(uint256 amount,uint64 workDeadline,uint64 reviewWindow,uint64 gracePeriod,bytes32 specHash)
 */
export interface StandardV2MilestoneInit {
  amount: bigint; // USDC base units (6 decimals)
  workDeadline: bigint; // Unix timestamp in seconds
  reviewWindow: bigint; // Seconds (must be between 1 hour and 30 days)
  gracePeriod: bigint; // Seconds
  specHash: `0x${string}`; // keccak256 hash of agreed acceptance criteria
}

/**
 * Flexible input format for milestones before bigint conversion.
 */
export interface StandardV2MilestoneInput {
  amount: bigint | number | string;
  workDeadline: bigint | number | string;
  reviewWindow: bigint | number | string;
  gracePeriod: bigint | number | string;
  specHash: string;
}

/**
 * Human-friendly milestone definition for application wizard/forms.
 */
export interface StandardV2HumanMilestone {
  title: string;
  description?: string;
  amountUsdc: string; // e.g. "1.00" or "100"
  workDeadline: number; // Unix timestamp in seconds
  reviewWindowSeconds: number; // Seconds, e.g. 86400 (24h)
  gracePeriodSeconds: number; // Seconds, e.g. 86400 (24h)
  specHash?: `0x${string}`; // Optional explicit specHash
}

/**
 * Exact EIP-712 DealProposal struct defined in ISynqFactoryV2.sol & SynqFactoryV2.sol.
 * Field order and types match DEAL_PROPOSAL_TYPEHASH exactly:
 * "DealProposal(address client,address freelancer,address canonicalUsdc,address dealImplementation,address primaryResolver,address emergencyResolver,bytes32 milestonesHash,bool isProtected,address protectionModule,bytes32 policyId,uint256 proposalNonce,uint256 expiry)"
 */
export interface DealProposalV2 {
  client: `0x${string}`;
  freelancer: `0x${string}`;
  canonicalUsdc: `0x${string}`;
  dealImplementation: `0x${string}`;
  primaryResolver: `0x${string}`;
  emergencyResolver: `0x${string}`;
  milestonesHash: `0x${string}`;
  isProtected: boolean;
  protectionModule: `0x${string}`;
  policyId: `0x${string}`;
  proposalNonce: bigint;
  expiry: bigint;
}

/**
 * Creation parameters supplied by application callers to build a Standard V2 proposal.
 */
export interface StandardV2ProposalCreationParams {
  client: string;
  freelancer: string;
  milestones: (StandardV2MilestoneInput | StandardV2MilestoneInit)[];
  proposalNonce: bigint | number | string;
  expiry: bigint | number | string; // Unix timestamp in seconds
}

/**
 * On-chain ProposalStatus enum from ISynqFactoryV2.sol.
 */
export enum DealProposalStatus {
  Pending = 0,
  Accepted = 1,
  Declined = 2,
  Cancelled = 3,
  Expired = 4,
}

/**
 * On-chain DealState enum from SynqDealTypes.sol.
 */
export enum DealStateV2 {
  Draft = 0,
  Active = 1,
  Completed = 2,
  TerminatedEarly = 3,
  Cancelled = 4,
}

/**
 * On-chain MilestoneStatus enum from SynqDealTypes.sol.
 */
export enum MilestoneStatusV2 {
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

/**
 * SettlementType enum from SynqDealTypes.sol.
 */
export enum SettlementTypeV2 {
  None = 0,
  ClientApproval = 1,
  StandardReviewTimeout = 2,
  ExpiredRefund = 3,
  MutualSettlement = 4,
  ResolverResolution = 5,
  AssessmentSettlement = 6,
}
