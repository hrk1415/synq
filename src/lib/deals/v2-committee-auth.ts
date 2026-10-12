import {
  isAddress,
  keccak256,
  stringToBytes,
  encodeAbiParameters,
  parseAbiParameters,
  hashTypedData,
  recoverTypedDataAddress,
  decodeEventLog,
} from 'viem';
import type { ResolutionReportPhase, CommitteeAuthorizationType } from '@/db/schema';
import { synqResolutionCommitteeABI, synqDealV1ABI } from '@/lib/contracts/abis';
import { SettlementType, type PublicClientLike } from '@/lib/deals/v2-deal';
import {
  PRIMARY_RESOLVER_SLA_SECONDS,
  verifyResolutionProposedReceipt,
  verifyFinalResolutionExecutedReceipt,
} from '@/lib/deals/v2-resolution-report';

/**
 * SYNQ PHASE 3M-C: COMMITTEE AUTHORIZATION EXCHANGE LAYER
 * Pure EIP-712 typed-data definitions, hashing, cryptographic verification,
 * and deterministic threshold signature bundle construction.
 */

export const RESOLUTION_COMMITTEE_EIP712_NAME = 'SynqResolutionCommittee' as const;
export const RESOLUTION_COMMITTEE_EIP712_VERSION = '1' as const;

export const RESOLUTION_PROPOSAL_PRIMARY_TYPE = 'ResolutionProposalAuth' as const;
export const FINAL_RESOLUTION_PRIMARY_TYPE = 'FinalResolutionAuth' as const;

export const RESOLUTION_PROPOSAL_AUTH_TYPES = {
  ResolutionProposalAuth: [
    { name: 'committee', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'deal', type: 'address' },
    { name: 'milestoneId', type: 'uint256' },
    { name: 'freelancerAmount', type: 'uint256' },
    { name: 'clientAmount', type: 'uint256' },
    { name: 'justificationHash', type: 'bytes32' },
    { name: 'resolutionNonce', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'evidenceRootHash', type: 'bytes32' },
    { name: 'specHash', type: 'bytes32' },
    { name: 'submissionVersion', type: 'uint8' },
  ],
} as const;

export const FINAL_RESOLUTION_AUTH_TYPES = {
  FinalResolutionAuth: [
    { name: 'committee', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'deal', type: 'address' },
    { name: 'milestoneId', type: 'uint256' },
    { name: 'freelancerAmount', type: 'uint256' },
    { name: 'clientAmount', type: 'uint256' },
    { name: 'justificationHash', type: 'bytes32' },
    { name: 'resolutionNonce', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'evidenceRootHash', type: 'bytes32' },
    { name: 'specHash', type: 'bytes32' },
    { name: 'submissionVersion', type: 'uint8' },
  ],
} as const;

// Precomputed typehashes matching SynqResolutionCommittee.sol lines 22-28
export const RESOLUTION_PROPOSAL_TYPEHASH = keccak256(
  stringToBytes(
    'ResolutionProposalAuth(address committee,uint256 chainId,address deal,uint256 milestoneId,uint256 freelancerAmount,uint256 clientAmount,bytes32 justificationHash,uint64 resolutionNonce,uint64 validUntil,bytes32 evidenceRootHash,bytes32 specHash,uint8 submissionVersion)'
  )
);

export const FINAL_RESOLUTION_TYPEHASH = keccak256(
  stringToBytes(
    'FinalResolutionAuth(address committee,uint256 chainId,address deal,uint256 milestoneId,uint256 freelancerAmount,uint256 clientAmount,bytes32 justificationHash,uint64 resolutionNonce,uint64 validUntil,bytes32 evidenceRootHash,bytes32 specHash,uint8 submissionVersion)'
  )
);

export const COMMITTEE_THRESHOLD = 2n;

export { synqResolutionCommitteeABI };

// Default authorization expiration window: 7 days in seconds
export const DEFAULT_AUTH_EXPIRATION_SECONDS = 7n * 86400n; // 604,800 seconds

// Advisory buffer for 14-day SLA boundary: 15 minutes (900 seconds) - UX/advisory only
export const RESOLVER_SLA_ADVISORY_BUFFER_SECONDS = 15n * 60n;

// Advisory buffer for validUntil expiry: 5 minutes (300 seconds) - UX/advisory only
export const EXPIRY_ADVISORY_BUFFER_SECONDS = 5n * 60n;

export class CommitteeAuthValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitteeAuthValidationError';
  }
}

export class CommitteeAuthAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitteeAuthAuthError';
  }
}

export class CommitteeAuthConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitteeAuthConflictError';
  }
}

export class CommitteeAuthIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitteeAuthIntegrityError';
  }
}

export class CommitteeAuthExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitteeAuthExpiredError';
  }
}

export class CommitteeAuthInvalidatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitteeAuthInvalidatedError';
  }
}

export class CommitteeExecutionReceiptError extends CommitteeAuthIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = 'CommitteeExecutionReceiptError';
  }
}

export class CommitteeExecutionRecoveryError extends CommitteeAuthIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = 'CommitteeExecutionRecoveryError';
  }
}

export interface CommitteeResolutionAuthData {
  committee: `0x${string}`;
  chainId: bigint;
  deal: `0x${string}`;
  milestoneId: bigint;
  freelancerAmount: bigint;
  clientAmount: bigint;
  justificationHash: `0x${string}`;
  resolutionNonce: bigint;
  validUntil: bigint;
  evidenceRootHash: `0x${string}`;
  specHash: `0x${string}`;
  submissionVersion: number;
}

export type ResolutionProposalAuthData = CommitteeResolutionAuthData;
export type FinalResolutionAuthData = CommitteeResolutionAuthData;

export interface VerifiedThresholdBundle {
  authorizationId: string;
  reportId: string;
  phase: ResolutionReportPhase;
  authorizationType: CommitteeAuthorizationType;
  committeeAddress: `0x${string}`;
  dealAddress: `0x${string}`;
  milestoneId: number;
  auth: CommitteeResolutionAuthData;
  typedDataHash: `0x${string}`;
  signers: [`0x${string}`, `0x${string}`];
  signatures: [`0x${string}`, `0x${string}`];
}

/**
 * Derives the canonical EIP-712 domain for the SynqResolutionCommittee.
 */
export function getCommitteeEIP712Domain(committeeAddress: string, chainId: number | bigint) {
  if (!isAddress(committeeAddress)) {
    throw new CommitteeAuthValidationError(`Invalid committeeAddress for EIP-712 domain: ${committeeAddress}`);
  }
  return {
    name: RESOLUTION_COMMITTEE_EIP712_NAME,
    version: RESOLUTION_COMMITTEE_EIP712_VERSION,
    chainId: BigInt(chainId),
    verifyingContract: committeeAddress.toLowerCase() as `0x${string}`,
  };
}

/**
 * Builds the exact EIP-712 typed data object for ResolutionProposalAuth.
 */
export function getResolutionProposalTypedData(auth: ResolutionProposalAuthData) {
  return {
    domain: getCommitteeEIP712Domain(auth.committee, auth.chainId),
    types: RESOLUTION_PROPOSAL_AUTH_TYPES,
    primaryType: RESOLUTION_PROPOSAL_PRIMARY_TYPE,
    message: {
      committee: auth.committee.toLowerCase() as `0x${string}`,
      chainId: auth.chainId,
      deal: auth.deal.toLowerCase() as `0x${string}`,
      milestoneId: auth.milestoneId,
      freelancerAmount: auth.freelancerAmount,
      clientAmount: auth.clientAmount,
      justificationHash: auth.justificationHash.toLowerCase() as `0x${string}`,
      resolutionNonce: auth.resolutionNonce,
      validUntil: auth.validUntil,
      evidenceRootHash: auth.evidenceRootHash.toLowerCase() as `0x${string}`,
      specHash: auth.specHash.toLowerCase() as `0x${string}`,
      submissionVersion: auth.submissionVersion,
    },
  };
}

/**
 * Builds the exact EIP-712 typed data object for FinalResolutionAuth.
 */
export function getFinalResolutionTypedData(auth: FinalResolutionAuthData) {
  return {
    domain: getCommitteeEIP712Domain(auth.committee, auth.chainId),
    types: FINAL_RESOLUTION_AUTH_TYPES,
    primaryType: FINAL_RESOLUTION_PRIMARY_TYPE,
    message: {
      committee: auth.committee.toLowerCase() as `0x${string}`,
      chainId: auth.chainId,
      deal: auth.deal.toLowerCase() as `0x${string}`,
      milestoneId: auth.milestoneId,
      freelancerAmount: auth.freelancerAmount,
      clientAmount: auth.clientAmount,
      justificationHash: auth.justificationHash.toLowerCase() as `0x${string}`,
      resolutionNonce: auth.resolutionNonce,
      validUntil: auth.validUntil,
      evidenceRootHash: auth.evidenceRootHash.toLowerCase() as `0x${string}`,
      specHash: auth.specHash.toLowerCase() as `0x${string}`,
      submissionVersion: auth.submissionVersion,
    },
  };
}

/**
 * Computes the exact EIP-712 digest for ResolutionProposalAuth.
 */
export function hashResolutionProposalAuth(auth: ResolutionProposalAuthData): `0x${string}` {
  const typedData = getResolutionProposalTypedData(auth);
  return hashTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });
}

/**
 * Computes the exact EIP-712 digest for FinalResolutionAuth.
 */
export function hashFinalResolutionAuth(auth: FinalResolutionAuthData): `0x${string}` {
  const typedData = getFinalResolutionTypedData(auth);
  return hashTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });
}

/**
 * Computes the on-chain nonceKey used in SynqResolutionCommittee.sol:
 * keccak256(abi.encode(auth.deal, auth.milestoneId, auth.resolutionNonce))
 */
export function computeNonceKey(
  dealAddress: string,
  milestoneId: number | bigint,
  resolutionNonce: number | bigint
): `0x${string}` {
  if (!isAddress(dealAddress)) {
    throw new CommitteeAuthValidationError(`Invalid dealAddress: ${dealAddress}`);
  }
  const encoded = encodeAbiParameters(
    parseAbiParameters('address, uint256, uint64'),
    [dealAddress.toLowerCase() as `0x${string}`, BigInt(milestoneId), BigInt(resolutionNonce)]
  );
  return keccak256(encoded);
}

/**
 * Recovers the signer address from an EIP-712 signature against committee typed data.
 */
export async function verifyCommitteeSignerSignature(params: {
  domain: ReturnType<typeof getCommitteeEIP712Domain>;
  types: typeof RESOLUTION_PROPOSAL_AUTH_TYPES | typeof FINAL_RESOLUTION_AUTH_TYPES;
  primaryType: typeof RESOLUTION_PROPOSAL_PRIMARY_TYPE | typeof FINAL_RESOLUTION_PRIMARY_TYPE;
  message: Record<string, unknown>;
  signature: `0x${string}`;
  expectedSigner?: string;
}): Promise<{
  valid: boolean;
  recoveredSigner?: `0x${string}`;
  error?: string;
}> {
  try {
    const recovered = await recoverTypedDataAddress({
      domain: params.domain,
      types: params.types as any,
      primaryType: params.primaryType as any,
      message: params.message as any,
      signature: params.signature,
    });

    const normalizedRecovered = recovered.toLowerCase() as `0x${string}`;

    if (params.expectedSigner) {
      const normalizedExpected = params.expectedSigner.toLowerCase() as `0x${string}`;
      if (normalizedRecovered !== normalizedExpected) {
        return {
          valid: false,
          recoveredSigner: normalizedRecovered,
          error: `Recovered signer (${normalizedRecovered}) does not match expected signer (${normalizedExpected})`,
        };
      }
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
 * Checks on-chain whether a resolution nonce has already been consumed on the committee contract.
 */
export async function isNonceUsedOnChain(params: {
  committeeAddress: string;
  dealAddress: string;
  milestoneId: number | bigint;
  phase: ResolutionReportPhase;
  nonce: number | bigint;
  publicClient: PublicClientLike;
}): Promise<boolean> {
  const nonceKey = computeNonceKey(params.dealAddress, params.milestoneId, params.nonce);
  const functionName = params.phase === 'INITIAL_RESOLUTION' ? 'usedProposalNonces' : 'usedFinalNonces';

  const used = await params.publicClient.readContract({
    address: params.committeeAddress.toLowerCase() as `0x${string}`,
    abi: [
      {
        inputs: [{ name: '', type: 'bytes32' }],
        name: functionName,
        outputs: [{ name: '', type: 'bool' }],
        stateMutability: 'view',
        type: 'function',
      },
    ],
    functionName,
    args: [nonceKey],
  }) as boolean;

  return Boolean(used);
}

/**
 * Assembles a deterministic 2-of-3 signature bundle sorted by signer address.
 */
export function buildVerifiedThresholdBundle(params: {
  authorizationId: string;
  reportId: string;
  phase: ResolutionReportPhase;
  authorizationType: CommitteeAuthorizationType;
  committeeAddress: `0x${string}`;
  dealAddress: `0x${string}`;
  milestoneId: number;
  auth: CommitteeResolutionAuthData;
  typedDataHash: `0x${string}`;
  verifiedSignatures: Array<{
    signerWallet: string;
    signature: string;
  }>;
}): VerifiedThresholdBundle {
  if (params.verifiedSignatures.length < 2) {
    throw new CommitteeAuthIntegrityError(
      `Cannot build bundle: requires at least 2 verified signatures, found ${params.verifiedSignatures.length}`
    );
  }

  // Deduplicate by signer
  const uniqueBySigner = new Map<string, string>();
  for (const s of params.verifiedSignatures) {
    const sw = s.signerWallet.toLowerCase();
    if (!uniqueBySigner.has(sw)) {
      uniqueBySigner.set(sw, s.signature);
    }
  }

  if (uniqueBySigner.size < 2) {
    throw new CommitteeAuthIntegrityError('Cannot build bundle: requires 2 distinct signers');
  }

  // Sort signers lexicographically for deterministic bundle ordering
  const sortedSigners = Array.from(uniqueBySigner.keys()).sort();
  const signer1 = sortedSigners[0] as `0x${string}`;
  const signer2 = sortedSigners[1] as `0x${string}`;
  const sig1 = uniqueBySigner.get(signer1)! as `0x${string}`;
  const sig2 = uniqueBySigner.get(signer2)! as `0x${string}`;

  return {
    authorizationId: params.authorizationId,
    reportId: params.reportId,
    phase: params.phase,
    authorizationType: params.authorizationType,
    committeeAddress: params.committeeAddress.toLowerCase() as `0x${string}`,
    dealAddress: params.dealAddress.toLowerCase() as `0x${string}`,
    milestoneId: params.milestoneId,
    auth: params.auth,
    typedDataHash: params.typedDataHash.toLowerCase() as `0x${string}`,
    signers: [signer1, signer2],
    signatures: [sig1, sig2],
  };
}

// ---------------------------------------------------------------------------
// Phase 3M-E: Pure Execution Preparation & Transaction Request Formulation
// ---------------------------------------------------------------------------

export interface CommitteeResolutionAuthContractArg {
  committee: `0x${string}`;
  chainId: bigint;
  deal: `0x${string}`;
  milestoneId: bigint;
  freelancerAmount: bigint;
  clientAmount: bigint;
  justificationHash: `0x${string}`;
  resolutionNonce: bigint;
  validUntil: bigint;
  evidenceRootHash: `0x${string}`;
  specHash: `0x${string}`;
  submissionVersion: number;
}

export interface CommitteeExecutionTransactionRequest {
  address: `0x${string}`;
  abi: typeof synqResolutionCommitteeABI;
  functionName: 'submitResolutionProposal' | 'submitFinalResolution';
  args: [CommitteeResolutionAuthContractArg, `0x${string}`, `0x${string}`];
  advisory: {
    nearResolverBoundary?: boolean;
    nearExpiry: boolean;
    recommendedToSubmit: boolean;
    remainingResolverSeconds?: bigint;
    remainingExpirySeconds: bigint;
  };
}

/**
 * Pure transaction request formatter suitable for future publicClient.simulateContract
 * and walletClient.writeContract. Consumes an exact VerifiedThresholdBundle.
 *
 * Advisory fields:
 * - 15-minute buffer before 14-day SLA boundary (INITIAL only)
 * - 5-minute buffer before validUntil expiry
 * IMPORTANT: Advisory only. Does NOT redefine protocol validity.
 */
export function formatCommitteeExecutionTransaction(params: {
  bundle: VerifiedThresholdBundle;
  latestBlockTimestamp: bigint;
  disputeOpenedAt?: bigint;
}): CommitteeExecutionTransactionRequest {
  const { bundle, latestBlockTimestamp, disputeOpenedAt } = params;

  const functionName =
    bundle.phase === 'INITIAL_RESOLUTION'
      ? ('submitResolutionProposal' as const)
      : ('submitFinalResolution' as const);

  const authArg: CommitteeResolutionAuthContractArg = {
    committee: bundle.auth.committee.toLowerCase() as `0x${string}`,
    chainId: BigInt(bundle.auth.chainId),
    deal: bundle.auth.deal.toLowerCase() as `0x${string}`,
    milestoneId: BigInt(bundle.auth.milestoneId),
    freelancerAmount: BigInt(bundle.auth.freelancerAmount),
    clientAmount: BigInt(bundle.auth.clientAmount),
    justificationHash: bundle.auth.justificationHash.toLowerCase() as `0x${string}`,
    resolutionNonce: BigInt(bundle.auth.resolutionNonce),
    validUntil: BigInt(bundle.auth.validUntil),
    evidenceRootHash: bundle.auth.evidenceRootHash.toLowerCase() as `0x${string}`,
    specHash: bundle.auth.specHash.toLowerCase() as `0x${string}`,
    submissionVersion: Number(bundle.auth.submissionVersion),
  };

  // Advisory calculations
  const remainingExpirySeconds =
    authArg.validUntil > latestBlockTimestamp ? authArg.validUntil - latestBlockTimestamp : 0n;
  const nearExpiry = remainingExpirySeconds <= EXPIRY_ADVISORY_BUFFER_SECONDS;

  let nearResolverBoundary: boolean | undefined;
  let remainingResolverSeconds: bigint | undefined;

  if (bundle.phase === 'INITIAL_RESOLUTION' && disputeOpenedAt !== undefined && disputeOpenedAt > 0n) {
    const slaBoundary = disputeOpenedAt + PRIMARY_RESOLVER_SLA_SECONDS;
    remainingResolverSeconds = slaBoundary > latestBlockTimestamp ? slaBoundary - latestBlockTimestamp : 0n;
    nearResolverBoundary = remainingResolverSeconds <= RESOLVER_SLA_ADVISORY_BUFFER_SECONDS;
  }

  const recommendedToSubmit =
    !nearExpiry && (nearResolverBoundary === undefined || !nearResolverBoundary);

  return {
    address: bundle.committeeAddress,
    abi: synqResolutionCommitteeABI,
    functionName,
    args: [authArg, bundle.signatures[0], bundle.signatures[1]],
    advisory: {
      ...(nearResolverBoundary !== undefined ? { nearResolverBoundary } : {}),
      ...(remainingResolverSeconds !== undefined ? { remainingResolverSeconds } : {}),
      nearExpiry,
      recommendedToSubmit,
      remainingExpirySeconds,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 3M-E: Pure Receipt Verification
// ---------------------------------------------------------------------------

/**
 * Verifies transaction receipt for SynqResolutionCommittee.submitResolutionProposal(...).
 * Confirms:
 * 1. Transaction succeeded.
 * 2. If target is available, matches expected committee.
 * 3. Exact ResolutionProposalSubmitted on committee matching deal, milestone, split, hash, and nonce.
 * 4. Exact ResolutionProposed on Deal matching milestone, resolver == committee, split, and hash.
 */
export function verifyCommitteeResolutionProposalReceipt(params: {
  receipt: { status: string | number; logs: readonly any[]; to?: string | null };
  committeeAddress: string;
  dealAddress: string;
  expectedMilestoneId: bigint;
  expectedFreelancerAmount: bigint;
  expectedClientAmount: bigint;
  expectedJustificationHash: string;
  expectedNonce: bigint;
}): {
  valid: boolean;
  error?: string;
  committeeEvent?: {
    deal: `0x${string}`;
    milestoneId: bigint;
    freelancerAmount: bigint;
    clientAmount: bigint;
    justificationHash: `0x${string}`;
    resolutionNonce: bigint;
  };
  dealEvent?: {
    milestoneId: bigint;
    resolver: `0x${string}`;
    freelancerAmount: bigint;
    clientAmount: bigint;
    justificationHash: `0x${string}`;
    reconsiderationDeadline: bigint;
  };
} {
  const isSuccess =
    params.receipt.status === 'success' ||
    params.receipt.status === 1 ||
    params.receipt.status === '0x1';
  if (!isSuccess) {
    return { valid: false, error: 'Transaction reverted on-chain' };
  }

  if (params.receipt.to && params.receipt.to.toLowerCase() !== params.committeeAddress.toLowerCase()) {
    return {
      valid: false,
      error: `Transaction target mismatch: expected committee ${params.committeeAddress}, received ${params.receipt.to}`,
    };
  }

  const normalizedCommittee = params.committeeAddress.toLowerCase();
  const normalizedDeal = params.dealAddress.toLowerCase();
  const normalizedHash = params.expectedJustificationHash.toLowerCase();

  let committeeEvent:
    | {
        deal: `0x${string}`;
        milestoneId: bigint;
        freelancerAmount: bigint;
        clientAmount: bigint;
        justificationHash: `0x${string}`;
        resolutionNonce: bigint;
      }
    | undefined;

  for (const log of params.receipt.logs) {
    if (!log.address || log.address.toLowerCase() !== normalizedCommittee) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: synqResolutionCommitteeABI,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === 'ResolutionProposalSubmitted') {
        const args = decoded.args as unknown as {
          deal: `0x${string}`;
          milestoneId: bigint;
          freelancerAmount: bigint;
          clientAmount: bigint;
          justificationHash: `0x${string}`;
          resolutionNonce: bigint | number;
        };

        if (args.deal.toLowerCase() !== normalizedDeal) {
          return {
            valid: false,
            error: `ResolutionProposalSubmitted deal mismatch: expected ${normalizedDeal}, received ${args.deal.toLowerCase()}`,
          };
        }

        if (BigInt(args.milestoneId) !== params.expectedMilestoneId) {
          return {
            valid: false,
            error: `ResolutionProposalSubmitted milestoneId mismatch: expected ${params.expectedMilestoneId}, received ${args.milestoneId}`,
          };
        }

        if (BigInt(args.freelancerAmount) !== params.expectedFreelancerAmount) {
          return {
            valid: false,
            error: `ResolutionProposalSubmitted freelancerAmount mismatch: expected ${params.expectedFreelancerAmount}, received ${args.freelancerAmount}`,
          };
        }

        if (BigInt(args.clientAmount) !== params.expectedClientAmount) {
          return {
            valid: false,
            error: `ResolutionProposalSubmitted clientAmount mismatch: expected ${params.expectedClientAmount}, received ${args.clientAmount}`,
          };
        }

        if (args.justificationHash.toLowerCase() !== normalizedHash) {
          return {
            valid: false,
            error: `ResolutionProposalSubmitted justificationHash mismatch: expected ${normalizedHash}, received ${args.justificationHash.toLowerCase()}`,
          };
        }

        if (BigInt(args.resolutionNonce) !== params.expectedNonce) {
          return {
            valid: false,
            error: `ResolutionProposalSubmitted resolutionNonce mismatch: expected ${params.expectedNonce}, received ${args.resolutionNonce}`,
          };
        }

        committeeEvent = {
          deal: args.deal.toLowerCase() as `0x${string}`,
          milestoneId: BigInt(args.milestoneId),
          freelancerAmount: BigInt(args.freelancerAmount),
          clientAmount: BigInt(args.clientAmount),
          justificationHash: args.justificationHash.toLowerCase() as `0x${string}`,
          resolutionNonce: BigInt(args.resolutionNonce),
        };
        break;
      }
    } catch {
      // Ignore non-matching logs
    }
  }

  if (!committeeEvent) {
    return {
      valid: false,
      error: 'ResolutionProposalSubmitted event not found in transaction receipt for this committee',
    };
  }

  // Verify corresponding Deal event
  const dealResult = verifyResolutionProposedReceipt({
    receipt: params.receipt as any,
    dealAddress: params.dealAddress,
    expectedMilestoneId: params.expectedMilestoneId,
    expectedResolver: params.committeeAddress,
    expectedFreelancerAmount: params.expectedFreelancerAmount,
    expectedClientAmount: params.expectedClientAmount,
    expectedJustificationHash: params.expectedJustificationHash,
  });

  if (!dealResult.valid) {
    return {
      valid: false,
      error: dealResult.error || 'Failed to verify ResolutionProposed event on Deal contract',
    };
  }

  return {
    valid: true,
    committeeEvent,
    dealEvent: dealResult.event,
  };
}

/**
 * Verifies transaction receipt for SynqResolutionCommittee.submitFinalResolution(...).
 * Confirms:
 * 1. Transaction succeeded.
 * 2. If target is available, matches expected committee.
 * 3. Exact FinalResolutionSubmitted on committee matching deal, milestone, split, hash, and nonce.
 * 4. Exact FinalResolutionExecuted on Deal matching milestone, resolver == committee, split, and hash.
 * 5. Exact MilestoneSettled on Deal with SettlementType.ResolverResolution (5).
 */
export function verifyCommitteeFinalResolutionReceipt(params: {
  receipt: { status: string | number; logs: readonly any[]; to?: string | null };
  committeeAddress: string;
  dealAddress: string;
  expectedMilestoneId: bigint;
  expectedFreelancerAmount: bigint;
  expectedClientAmount: bigint;
  expectedJustificationHash: string;
  expectedNonce: bigint;
}): {
  valid: boolean;
  error?: string;
  committeeEvent?: {
    deal: `0x${string}`;
    milestoneId: bigint;
    freelancerAmount: bigint;
    clientAmount: bigint;
    justificationHash: `0x${string}`;
    resolutionNonce: bigint;
  };
  finalResolutionEvent?: {
    milestoneId: bigint;
    resolver: `0x${string}`;
    freelancerAmount: bigint;
    clientAmount: bigint;
    justificationHash: `0x${string}`;
  };
  milestoneSettledEvent?: {
    milestoneId: bigint;
    paidToFreelancer: bigint;
    refundedToClient: bigint;
    settlementType: number;
  };
} {
  const isSuccess =
    params.receipt.status === 'success' ||
    params.receipt.status === 1 ||
    params.receipt.status === '0x1';
  if (!isSuccess) {
    return { valid: false, error: 'Transaction reverted on-chain' };
  }

  if (params.receipt.to && params.receipt.to.toLowerCase() !== params.committeeAddress.toLowerCase()) {
    return {
      valid: false,
      error: `Transaction target mismatch: expected committee ${params.committeeAddress}, received ${params.receipt.to}`,
    };
  }

  const normalizedCommittee = params.committeeAddress.toLowerCase();
  const normalizedDeal = params.dealAddress.toLowerCase();
  const normalizedHash = params.expectedJustificationHash.toLowerCase();

  let committeeEvent:
    | {
        deal: `0x${string}`;
        milestoneId: bigint;
        freelancerAmount: bigint;
        clientAmount: bigint;
        justificationHash: `0x${string}`;
        resolutionNonce: bigint;
      }
    | undefined;

  for (const log of params.receipt.logs) {
    if (!log.address || log.address.toLowerCase() !== normalizedCommittee) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: synqResolutionCommitteeABI,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === 'FinalResolutionSubmitted') {
        const args = decoded.args as unknown as {
          deal: `0x${string}`;
          milestoneId: bigint;
          freelancerAmount: bigint;
          clientAmount: bigint;
          justificationHash: `0x${string}`;
          resolutionNonce: bigint | number;
        };

        if (args.deal.toLowerCase() !== normalizedDeal) {
          return {
            valid: false,
            error: `FinalResolutionSubmitted deal mismatch: expected ${normalizedDeal}, received ${args.deal.toLowerCase()}`,
          };
        }

        if (BigInt(args.milestoneId) !== params.expectedMilestoneId) {
          return {
            valid: false,
            error: `FinalResolutionSubmitted milestoneId mismatch: expected ${params.expectedMilestoneId}, received ${args.milestoneId}`,
          };
        }

        if (BigInt(args.freelancerAmount) !== params.expectedFreelancerAmount) {
          return {
            valid: false,
            error: `FinalResolutionSubmitted freelancerAmount mismatch: expected ${params.expectedFreelancerAmount}, received ${args.freelancerAmount}`,
          };
        }

        if (BigInt(args.clientAmount) !== params.expectedClientAmount) {
          return {
            valid: false,
            error: `FinalResolutionSubmitted clientAmount mismatch: expected ${params.expectedClientAmount}, received ${args.clientAmount}`,
          };
        }

        if (args.justificationHash.toLowerCase() !== normalizedHash) {
          return {
            valid: false,
            error: `FinalResolutionSubmitted justificationHash mismatch: expected ${normalizedHash}, received ${args.justificationHash.toLowerCase()}`,
          };
        }

        if (BigInt(args.resolutionNonce) !== params.expectedNonce) {
          return {
            valid: false,
            error: `FinalResolutionSubmitted resolutionNonce mismatch: expected ${params.expectedNonce}, received ${args.resolutionNonce}`,
          };
        }

        committeeEvent = {
          deal: args.deal.toLowerCase() as `0x${string}`,
          milestoneId: BigInt(args.milestoneId),
          freelancerAmount: BigInt(args.freelancerAmount),
          clientAmount: BigInt(args.clientAmount),
          justificationHash: args.justificationHash.toLowerCase() as `0x${string}`,
          resolutionNonce: BigInt(args.resolutionNonce),
        };
        break;
      }
    } catch {
      // Ignore non-matching logs
    }
  }

  if (!committeeEvent) {
    return {
      valid: false,
      error: 'FinalResolutionSubmitted event not found in transaction receipt for this committee',
    };
  }

  // Verify corresponding Deal event: FinalResolutionExecuted
  const dealResult = verifyFinalResolutionExecutedReceipt({
    receipt: params.receipt as any,
    dealAddress: params.dealAddress,
    expectedMilestoneId: params.expectedMilestoneId,
    expectedResolver: params.committeeAddress,
    expectedFreelancerAmount: params.expectedFreelancerAmount,
    expectedClientAmount: params.expectedClientAmount,
    expectedJustificationHash: params.expectedJustificationHash,
  });

  if (!dealResult.valid) {
    return {
      valid: false,
      error: dealResult.error || 'Failed to verify FinalResolutionExecuted event on Deal contract',
    };
  }

  // Verify MilestoneSettled with SettlementType.ResolverResolution
  let milestoneSettledEvent:
    | {
        milestoneId: bigint;
        paidToFreelancer: bigint;
        refundedToClient: bigint;
        settlementType: number;
      }
    | undefined;

  for (const log of params.receipt.logs) {
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

        if (BigInt(args.milestoneId) !== params.expectedMilestoneId) {
          return {
            valid: false,
            error: `MilestoneSettled milestoneId mismatch: expected ${params.expectedMilestoneId}, received ${args.milestoneId}`,
          };
        }

        if (BigInt(args.paidToFreelancer) !== params.expectedFreelancerAmount) {
          return {
            valid: false,
            error: `MilestoneSettled freelancer amount mismatch: expected ${params.expectedFreelancerAmount}, received ${args.paidToFreelancer}`,
          };
        }

        if (BigInt(args.refundedToClient) !== params.expectedClientAmount) {
          return {
            valid: false,
            error: `MilestoneSettled client amount mismatch: expected ${params.expectedClientAmount}, received ${args.refundedToClient}`,
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
        break;
      }
    } catch {
      // Ignore non-matching logs
    }
  }

  if (!milestoneSettledEvent) {
    return {
      valid: false,
      error: 'MilestoneSettled event with SettlementType.ResolverResolution not found in receipt',
    };
  }

  return {
    valid: true,
    committeeEvent,
    finalResolutionEvent: dealResult.event,
    milestoneSettledEvent,
  };
}
