import {
  isAddress,
  decodeEventLog,
  recoverTypedDataAddress,
  verifyTypedData,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
} from 'viem';
import { synqDealV1ABI } from '@/lib/contracts/abis';
import { DealState, MilestoneStatus, SettlementType } from '@/lib/deals/v2-deal';

/**
 * SYNQ MUTUAL SETTLEMENT EIP-712 TYPED DATA DEFINITIONS
 *
 * Matches exact Solidity implementation in contracts/v1/SynqDealV1Sequential.sol:
 * constructor() EIP712("SynqDealV1", "1")
 *
 * MUTUAL_SETTLEMENT_TYPEHASH = keccak256(
 *   "MutualSettlementProposal(address dealAddress,uint256 chainId,uint256 milestoneId,address proposer,uint256 freelancerAmount,uint256 clientAmount,uint64 proposalNonce,uint64 validUntil)"
 * );
 */

export const MUTUAL_SETTLEMENT_EIP712_NAME = 'SynqDealV1' as const;
export const MUTUAL_SETTLEMENT_EIP712_VERSION = '1' as const;
export const MUTUAL_SETTLEMENT_PRIMARY_TYPE = 'MutualSettlementProposal' as const;

export const MUTUAL_SETTLEMENT_TYPES = {
  MutualSettlementProposal: [
    { name: 'dealAddress', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'milestoneId', type: 'uint256' },
    { name: 'proposer', type: 'address' },
    { name: 'freelancerAmount', type: 'uint256' },
    { name: 'clientAmount', type: 'uint256' },
    { name: 'proposalNonce', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
  ],
} as const;

export interface MutualSettlementProposalData {
  dealAddress: `0x${string}`;
  chainId: bigint;
  milestoneId: bigint;
  proposer: `0x${string}`;
  freelancerAmount: bigint;
  clientAmount: bigint;
  proposalNonce: bigint;
  validUntil: bigint;
}

export class MutualSettlementValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MutualSettlementValidationError';
  }
}

/**
 * Generates the authoritative EIP-712 domain for a given Deal clone.
 */
export function getDealEIP712Domain(dealAddress: string, chainId: number) {
  if (!isAddress(dealAddress)) {
    throw new MutualSettlementValidationError('Invalid dealAddress for EIP-712 domain');
  }
  return {
    name: MUTUAL_SETTLEMENT_EIP712_NAME,
    version: MUTUAL_SETTLEMENT_EIP712_VERSION,
    chainId: BigInt(chainId),
    verifyingContract: dealAddress.toLowerCase() as `0x${string}`,
  };
}

export const getMutualSettlementEIP712Domain = getDealEIP712Domain;

/**
 * Returns typed data object for signing with viem.
 */
export function getMutualSettlementTypedData(proposal: MutualSettlementProposalData) {
  return {
    domain: getDealEIP712Domain(proposal.dealAddress, Number(proposal.chainId)),
    types: MUTUAL_SETTLEMENT_TYPES,
    primaryType: MUTUAL_SETTLEMENT_PRIMARY_TYPE,
    message: {
      dealAddress: proposal.dealAddress,
      chainId: proposal.chainId,
      milestoneId: proposal.milestoneId,
      proposer: proposal.proposer,
      freelancerAmount: proposal.freelancerAmount,
      clientAmount: proposal.clientAmount,
      proposalNonce: proposal.proposalNonce,
      validUntil: proposal.validUntil,
    },
  };
}

/**
 * Normalizes and validates mutual settlement proposal values without floating-point arithmetic.
 */
export function normalizeMutualSettlementProposal(input: {
  dealAddress: string;
  chainId: number | bigint;
  milestoneId: number | bigint;
  proposer: string;
  freelancerAmount: string | bigint | number;
  clientAmount: string | bigint | number;
  proposalNonce: string | bigint | number;
  validUntil: string | bigint | number;
  milestoneAmount?: bigint;
}): MutualSettlementProposalData {
  if (!input.dealAddress || !isAddress(input.dealAddress.toLowerCase())) {
    throw new MutualSettlementValidationError('Invalid dealAddress');
  }
  if (!input.proposer || !isAddress(input.proposer.toLowerCase())) {
    throw new MutualSettlementValidationError('Invalid proposer address');
  }

  const chainId = BigInt(input.chainId);
  if (chainId <= 0n) {
    throw new MutualSettlementValidationError('Invalid chainId: must be positive');
  }

  const milestoneId = BigInt(input.milestoneId);
  if (milestoneId < 0n) {
    throw new MutualSettlementValidationError('Invalid milestoneId: must be non-negative');
  }

  const freelancerAmount = BigInt(input.freelancerAmount);
  if (freelancerAmount < 0n) {
    throw new MutualSettlementValidationError('freelancerAmount cannot be negative');
  }

  const clientAmount = BigInt(input.clientAmount);
  if (clientAmount < 0n) {
    throw new MutualSettlementValidationError('clientAmount cannot be negative');
  }

  const proposalNonce = BigInt(input.proposalNonce);
  if (proposalNonce < 0n || proposalNonce > 18446744073709551615n) {
    throw new MutualSettlementValidationError('proposalNonce must be a valid uint64');
  }

  const validUntil = BigInt(input.validUntil);
  if (validUntil <= 0n || validUntil > 18446744073709551615n) {
    throw new MutualSettlementValidationError('validUntil must be a positive uint64 timestamp');
  }

  if (input.milestoneAmount !== undefined) {
    if (freelancerAmount + clientAmount !== input.milestoneAmount) {
      throw new MutualSettlementValidationError(
        `Split sum (${(freelancerAmount + clientAmount).toString()}) does not equal milestone amount (${input.milestoneAmount.toString()})`
      );
    }
  }

  return {
    dealAddress: input.dealAddress.toLowerCase() as `0x${string}`,
    chainId,
    milestoneId,
    proposer: input.proposer.toLowerCase() as `0x${string}`,
    freelancerAmount,
    clientAmount,
    proposalNonce,
    validUntil,
  };
}

/**
 * Recovers signer address from a mutual settlement proposal EIP-712 signature.
 */
export async function verifyMutualSettlementSignature(
  proposal: MutualSettlementProposalData,
  signature: `0x${string}`
): Promise<{
  valid: boolean;
  error?: string;
  recoveredSigner?: `0x${string}`;
}> {
  try {
    const domain = getDealEIP712Domain(proposal.dealAddress, Number(proposal.chainId));
    const recovered = await recoverTypedDataAddress({
      domain,
      types: MUTUAL_SETTLEMENT_TYPES,
      primaryType: MUTUAL_SETTLEMENT_PRIMARY_TYPE,
      message: {
        dealAddress: proposal.dealAddress,
        chainId: proposal.chainId,
        milestoneId: proposal.milestoneId,
        proposer: proposal.proposer,
        freelancerAmount: proposal.freelancerAmount,
        clientAmount: proposal.clientAmount,
        proposalNonce: proposal.proposalNonce,
        validUntil: proposal.validUntil,
      },
      signature,
    });

    const normalizedRecovered = recovered.toLowerCase() as `0x${string}`;
    const normalizedProposer = proposal.proposer.toLowerCase() as `0x${string}`;

    if (normalizedRecovered !== normalizedProposer) {
      return {
        valid: false,
        error: `Recovered signer (${normalizedRecovered}) does not match proposer (${normalizedProposer})`,
        recoveredSigner: normalizedRecovered,
      };
    }

    return {
      valid: true,
      recoveredSigner: normalizedRecovered,
    };
  } catch (err: any) {
    return {
      valid: false,
      error: `Signature recovery failed: ${err?.message || String(err)}`,
    };
  }
}

/**
 * Evaluates whether a mutual settlement proposal can be created or executed for a given milestone.
 *
 * Solidity Invariants (contracts/v1/SynqDealV1Sequential.sol):
 * - DealState must be DealState.Active
 * - Milestone status must be one of:
 *     Submitted (2), RevisionRequested (3), Disputed (4), ResolutionProposed (5), FinalReview (6)
 * - InProgress and Pending are REJECTED.
 * - Terminal statuses (SettledPaid, SettledRefunded, SettledSplit) are REJECTED.
 */
export function determineMutualSettlementEligibility(params: {
  dealState: DealState;
  milestoneStatus: MilestoneStatus;
  isClient: boolean;
  isFreelancer: boolean;
}): {
  eligible: boolean;
  reason?: string;
} {
  if (params.dealState !== DealState.Active) {
    return { eligible: false, reason: 'Deal is not in Active state' };
  }

  if (!params.isClient && !params.isFreelancer) {
    return { eligible: false, reason: 'Only deal participants (client or freelancer) can propose mutual settlement' };
  }

  const eligibleStatuses = [
    MilestoneStatus.Submitted,
    MilestoneStatus.RevisionRequested,
    MilestoneStatus.Disputed,
    MilestoneStatus.ResolutionProposed,
    MilestoneStatus.FinalReview,
  ];

  if (!eligibleStatuses.includes(params.milestoneStatus)) {
    return {
      eligible: false,
      reason: `Milestone status (${MilestoneStatus[params.milestoneStatus] || params.milestoneStatus}) is not eligible for mutual settlement`,
    };
  }

  return { eligible: true };
}

/**
 * Validates that MilestoneSettled event was emitted with SettlementType.MutualSettlement
 * for the expected milestone and financial split.
 */
export function verifyMutualSettlementReceipt(
  receipt: { status: string | number; logs: readonly any[] },
  dealAddress: string,
  expectedMilestoneId: bigint,
  expectedFreelancerAmount: bigint,
  expectedClientAmount: bigint
): {
  valid: boolean;
  error?: string;
  milestoneSettledEvent?: {
    milestoneId: bigint;
    paidToFreelancer: bigint;
    refundedToClient: bigint;
    settlementType: number;
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
            error: `MilestoneSettled milestoneId mismatch: expected ${expectedMilestoneId}, received ${args.milestoneId}`,
          };
        }

        if (BigInt(args.paidToFreelancer) !== expectedFreelancerAmount) {
          return {
            valid: false,
            error: `MilestoneSettled freelancer amount mismatch: expected ${expectedFreelancerAmount}, received ${args.paidToFreelancer}`,
          };
        }

        if (BigInt(args.refundedToClient) !== expectedClientAmount) {
          return {
            valid: false,
            error: `MilestoneSettled client amount mismatch: expected ${expectedClientAmount}, received ${args.refundedToClient}`,
          };
        }

        if (Number(args.settlementType) !== SettlementType.MutualSettlement) {
          return {
            valid: false,
            error: `MilestoneSettled settlementType mismatch: expected MutualSettlement (${SettlementType.MutualSettlement}), received ${args.settlementType}`,
          };
        }

        return {
          valid: true,
          milestoneSettledEvent: {
            milestoneId: BigInt(args.milestoneId),
            paidToFreelancer: BigInt(args.paidToFreelancer),
            refundedToClient: BigInt(args.refundedToClient),
            settlementType: Number(args.settlementType),
          },
        };
      }
    } catch {
      // Ignore unparseable logs from other events
    }
  }

  return {
    valid: false,
    error: 'MilestoneSettled event with SettlementType.MutualSettlement not found in receipt',
  };
}

/**
 * Validates ProposalCancelled event from transaction receipt.
 */
export function verifyProposalCancelledReceipt(
  receipt: { status: string | number; logs: readonly any[] },
  dealAddress: string,
  expectedMilestoneId: bigint,
  expectedProposer: string,
  expectedNonce: bigint
): {
  valid: boolean;
  error?: string;
  proposalCancelledEvent?: {
    milestoneId: bigint;
    proposer: `0x${string}`;
    proposalNonce: bigint;
  };
} {
  const isSuccess = receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1';
  if (!isSuccess) {
    return { valid: false, error: 'Transaction reverted on-chain' };
  }

  const normalizedDeal = dealAddress.toLowerCase();
  const normalizedProposer = expectedProposer.toLowerCase();

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

      if (decoded.eventName === 'ProposalCancelled') {
        const args = decoded.args as unknown as {
          milestoneId: bigint;
          proposer: `0x${string}`;
          proposalNonce: bigint;
        };

        if (BigInt(args.milestoneId) !== expectedMilestoneId) {
          return {
            valid: false,
            error: `ProposalCancelled milestoneId mismatch: expected ${expectedMilestoneId}, received ${args.milestoneId}`,
          };
        }

        if (args.proposer.toLowerCase() !== normalizedProposer) {
          return {
            valid: false,
            error: `ProposalCancelled proposer mismatch: expected ${normalizedProposer}, received ${args.proposer.toLowerCase()}`,
          };
        }

        if (BigInt(args.proposalNonce) !== expectedNonce) {
          return {
            valid: false,
            error: `ProposalCancelled nonce mismatch: expected ${expectedNonce}, received ${args.proposalNonce}`,
          };
        }

        return {
          valid: true,
          proposalCancelledEvent: {
            milestoneId: BigInt(args.milestoneId),
            proposer: args.proposer.toLowerCase() as `0x${string}`,
            proposalNonce: BigInt(args.proposalNonce),
          },
        };
      }
    } catch {
      // Ignore other events
    }
  }

  return {
    valid: false,
    error: 'ProposalCancelled event not found in transaction receipt',
  };
}

/**
 * Preflight validation before invoking executeMutualSettlement on-chain.
 */
export function validateExecuteMutualSettlementPreflight(params: {
  proposal: MutualSettlementProposalData;
  freshDealAddress: string;
  freshDealState: DealState;
  freshMilestoneIndex: number;
  freshMilestoneStatus: MilestoneStatus;
  freshMilestoneAmount: bigint;
  callerAddress: string;
  isClient: boolean;
  isFreelancer: boolean;
  isNonceUsed: boolean;
  currentTimestampSec: bigint;
}): { valid: boolean; error?: string } {
  if (params.proposal.dealAddress.toLowerCase() !== params.freshDealAddress.toLowerCase()) {
    return { valid: false, error: 'Deal address mismatch' };
  }
  if (params.proposal.milestoneId !== BigInt(params.freshMilestoneIndex)) {
    return { valid: false, error: 'Milestone ID mismatch' };
  }
  const normCaller = params.callerAddress.toLowerCase();
  const normProposer = params.proposal.proposer.toLowerCase();
  if (normCaller === normProposer) {
    return { valid: false, error: 'Proposer cannot execute their own settlement proposal' };
  }
  if (!params.isClient && !params.isFreelancer) {
    return { valid: false, error: 'Caller is not a participant in this Deal' };
  }
  if (params.proposal.freelancerAmount + params.proposal.clientAmount !== params.freshMilestoneAmount) {
    return { valid: false, error: 'Settlement split does not equal fresh milestone amount' };
  }
  if (params.isNonceUsed) {
    return { valid: false, error: 'Proposal nonce has already been used on-chain' };
  }
  if (params.currentTimestampSec >= params.proposal.validUntil) {
    return { valid: false, error: 'Proposal has expired' };
  }
  const elig = determineMutualSettlementEligibility({
    dealState: params.freshDealState,
    milestoneStatus: params.freshMilestoneStatus,
    isClient: params.isClient,
    isFreelancer: params.isFreelancer,
  });
  if (!elig.eligible) {
    return { valid: false, error: elig.reason || 'Milestone status is not eligible for mutual settlement execution' };
  }
  return { valid: true };
}

/**
 * Preflight validation before invoking cancelProposal on-chain.
 */
export function validateCancelMutualSettlementPreflight(params: {
  proposal: MutualSettlementProposalData;
  callerAddress: string;
  isNonceUsed: boolean;
}): { valid: boolean; error?: string } {
  if (params.callerAddress.toLowerCase() !== params.proposal.proposer.toLowerCase()) {
    return { valid: false, error: 'Only the proposal creator can cancel this proposal' };
  }
  if (params.isNonceUsed) {
    return { valid: false, error: 'Proposal nonce has already been used on-chain' };
  }
  return { valid: true };
}

export { parseUsdcAmount, formatUsdcAmount } from '@/lib/deals/v2';

