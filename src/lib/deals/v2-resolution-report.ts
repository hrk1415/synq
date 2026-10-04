import { isAddress, keccak256, stringToBytes, decodeEventLog } from 'viem';
import { canonicalizeValue } from '@/lib/deals/v2-evidence';
import { synqDealV1ABI } from '@/lib/contracts/abis';
import { DealState, MilestoneStatus } from '@/lib/deals/v2-deal';

/**
 * SYNQ CANONICAL RESOLUTION REPORT V1 (Phase 3M-B)
 *
 * Defines the immutable, deterministic resolution report schema whose cryptographic
 * hash forms the justificationHash committed on-chain via:
 * 1. INITIAL_RESOLUTION: proposeMilestoneResolution(uint256, uint256, uint256, bytes32)
 * 2. FINAL_RESOLUTION:   executeFinalResolution(uint256, uint256, uint256, bytes32)
 */

export const RESOLUTION_REPORT_SCHEMA_VERSION = 1 as const;

export const RESOLUTION_REPORT_PHASES = ['INITIAL_RESOLUTION', 'FINAL_RESOLUTION'] as const;
export type ResolutionReportPhase = (typeof RESOLUTION_REPORT_PHASES)[number];

export const RESOLUTION_REPORT_LIMITS = {
  MIN_SUMMARY_LENGTH: 1,
  MAX_SUMMARY_LENGTH: 2000,
  MIN_FINDINGS_LENGTH: 1,
  MAX_FINDINGS_LENGTH: 4000,
  MIN_JUSTIFICATION_LENGTH: 1,
  MAX_JUSTIFICATION_LENGTH: 4000,
  MAX_REFERENCES_COUNT: 20,
  MIN_REFERENCE_TITLE_LENGTH: 1,
  MAX_REFERENCE_TITLE_LENGTH: 100,
  MIN_REFERENCE_URL_LENGTH: 1,
  MAX_REFERENCE_URL_LENGTH: 500,
  MAX_SERIALIZED_BYTES: 32768, // 32 KB
} as const;

export const PRIMARY_RESOLVER_SLA_SECONDS = 14n * 86400n; // 1,209,600 seconds (14 days)

export const synqResolutionCommitteeReadABI = [
  {
    inputs: [{ name: '', type: 'address' }],
    name: 'isSigner',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getSigners',
    outputs: [{ name: '', type: 'address[3]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'committeeEpoch',
    outputs: [{ name: '', type: 'uint64' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'THRESHOLD',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export interface CanonicalEvidenceReference {
  title: string;
  url: string;
  hash?: `0x${string}`;
}

export interface CanonicalResolutionReportV1 {
  schemaVersion: 1;
  phase: ResolutionReportPhase;
  chainId: number;
  committeeAddress: `0x${string}`;
  dealAddress: `0x${string}`;
  milestoneId: number;
  submissionVersion: number;
  specHash: `0x${string}`;
  evidenceRootHash: `0x${string}`;
  freelancerAmount: string; // Canonical integer base-unit string (6 decimals USDC)
  clientAmount: string;     // Canonical integer base-unit string (6 decimals USDC)
  summary: string;
  findings: string;
  justification: string;
  evidenceReferences?: CanonicalEvidenceReference[];
}

export class ResolutionReportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolutionReportValidationError';
  }
}

export class ResolutionReportAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolutionReportAuthError';
  }
}

export class ResolutionReportConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolutionReportConflictError';
  }
}

export class ResolutionReportIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolutionReportIntegrityError';
  }
}

/**
 * Validates and normalizes an evidence reference pointer.
 */
export function normalizeEvidenceReference(ref: unknown, index: number): CanonicalEvidenceReference {
  if (!ref || typeof ref !== 'object') {
    throw new ResolutionReportValidationError(`Evidence reference at index ${index} must be an object`);
  }

  const { title, url, hash } = ref as Record<string, unknown>;

  if (typeof title !== 'string') {
    throw new ResolutionReportValidationError(`Evidence reference at index ${index} must have a string title`);
  }
  const trimmedTitle = title.normalize('NFC').trim();
  if (trimmedTitle.length < RESOLUTION_REPORT_LIMITS.MIN_REFERENCE_TITLE_LENGTH) {
    throw new ResolutionReportValidationError(`Evidence reference at index ${index} title cannot be empty`);
  }
  if (trimmedTitle.length > RESOLUTION_REPORT_LIMITS.MAX_REFERENCE_TITLE_LENGTH) {
    throw new ResolutionReportValidationError(
      `Evidence reference at index ${index} title exceeds max length of ${RESOLUTION_REPORT_LIMITS.MAX_REFERENCE_TITLE_LENGTH}`
    );
  }

  if (typeof url !== 'string') {
    throw new ResolutionReportValidationError(`Evidence reference at index ${index} must have a string url`);
  }
  const trimmedUrl = url.normalize('NFC').trim();
  if (trimmedUrl.length < RESOLUTION_REPORT_LIMITS.MIN_REFERENCE_URL_LENGTH) {
    throw new ResolutionReportValidationError(`Evidence reference at index ${index} url cannot be empty`);
  }
  if (trimmedUrl.length > RESOLUTION_REPORT_LIMITS.MAX_REFERENCE_URL_LENGTH) {
    throw new ResolutionReportValidationError(
      `Evidence reference at index ${index} url exceeds max length of ${RESOLUTION_REPORT_LIMITS.MAX_REFERENCE_URL_LENGTH}`
    );
  }
  if (!/^https?:\/\/\S+$/i.test(trimmedUrl)) {
    throw new ResolutionReportValidationError(
      `Evidence reference at index ${index} url must be a valid http:// or https:// URL`
    );
  }

  let canonicalHash: `0x${string}` | undefined;
  if (hash !== undefined && hash !== null) {
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new ResolutionReportValidationError(
        `Evidence reference at index ${index} hash must be a 0x-prefixed 32-byte hex string`
      );
    }
    canonicalHash = hash.toLowerCase() as `0x${string}`;
  }

  return {
    title: trimmedTitle,
    url: trimmedUrl,
    ...(canonicalHash ? { hash: canonicalHash } : {}),
  };
}

/**
 * Validates and normalizes the full canonical resolution report.
 *
 * Normalization Rules:
 * - schemaVersion strictly 1
 * - phase: 'INITIAL_RESOLUTION' | 'FINAL_RESOLUTION'
 * - chainId: positive integer
 * - committeeAddress: valid EVM address, lowercase
 * - dealAddress: valid EVM address, lowercase
 * - milestoneId: non-negative integer
 * - submissionVersion: non-negative integer (>= 0)
 * - specHash: valid lowercase 32-byte hex
 * - evidenceRootHash: valid lowercase 32-byte hex
 * - freelancerAmount / clientAmount: strictly integer strings (USDC base units). No floats, no negatives, no decimals.
 * - If expectedMilestoneAmount is provided: freelancerAmount + clientAmount === expectedMilestoneAmount exactly.
 * - summary, findings, justification: Unicode NFC, trimmed outer whitespace, internal whitespace preserved, within explicit bounds.
 * - evidenceReferences: optional array, max 20, validated pointers preserving authored order.
 * - Total serialized byte length <= 32768 bytes.
 */
export function normalizeResolutionReport(
  input: unknown,
  expectedMilestoneAmount?: bigint
): CanonicalResolutionReportV1 {
  if (!input || typeof input !== 'object') {
    throw new ResolutionReportValidationError('Report must be a non-null object');
  }

  const raw = input as Record<string, unknown>;

  // 1. schemaVersion
  if (raw.schemaVersion !== RESOLUTION_REPORT_SCHEMA_VERSION) {
    throw new ResolutionReportValidationError(
      `Invalid schemaVersion: expected ${RESOLUTION_REPORT_SCHEMA_VERSION}, got ${String(raw.schemaVersion)}`
    );
  }

  // 2. phase
  if (
    typeof raw.phase !== 'string' ||
    !RESOLUTION_REPORT_PHASES.includes(raw.phase as ResolutionReportPhase)
  ) {
    throw new ResolutionReportValidationError(
      `Invalid phase: expected one of ${RESOLUTION_REPORT_PHASES.join(', ')}, got '${String(raw.phase)}'`
    );
  }
  const canonicalPhase = raw.phase as ResolutionReportPhase;

  // 3. chainId
  if (typeof raw.chainId !== 'number' || !Number.isInteger(raw.chainId) || raw.chainId <= 0) {
    throw new ResolutionReportValidationError('Invalid chainId: must be a positive integer');
  }

  // 4. committeeAddress
  if (typeof raw.committeeAddress !== 'string' || !isAddress(raw.committeeAddress, { strict: false })) {
    throw new ResolutionReportValidationError('Invalid committeeAddress: must be a valid EVM address');
  }
  const canonicalCommitteeAddress = raw.committeeAddress.toLowerCase() as `0x${string}`;

  // 5. dealAddress
  if (typeof raw.dealAddress !== 'string' || !isAddress(raw.dealAddress, { strict: false })) {
    throw new ResolutionReportValidationError('Invalid dealAddress: must be a valid EVM address');
  }
  const canonicalDealAddress = raw.dealAddress.toLowerCase() as `0x${string}`;

  // 6. milestoneId
  if (typeof raw.milestoneId !== 'number' || !Number.isInteger(raw.milestoneId) || raw.milestoneId < 0) {
    throw new ResolutionReportValidationError('Invalid milestoneId: must be a non-negative integer');
  }

  // 7. submissionVersion
  if (
    typeof raw.submissionVersion !== 'number' ||
    !Number.isInteger(raw.submissionVersion) ||
    raw.submissionVersion < 0
  ) {
    throw new ResolutionReportValidationError('Invalid submissionVersion: must be an integer >= 0');
  }

  // 8. specHash
  if (typeof raw.specHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw.specHash)) {
    throw new ResolutionReportValidationError('Invalid specHash: must be a 0x-prefixed 32-byte hex string');
  }
  const canonicalSpecHash = raw.specHash.toLowerCase() as `0x${string}`;

  // 9. evidenceRootHash
  if (typeof raw.evidenceRootHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw.evidenceRootHash)) {
    throw new ResolutionReportValidationError(
      'Invalid evidenceRootHash: must be a 0x-prefixed 32-byte hex string'
    );
  }
  const canonicalEvidenceRootHash = raw.evidenceRootHash.toLowerCase() as `0x${string}`;

  // 10. Amounts (freelancerAmount and clientAmount)
  if (typeof raw.freelancerAmount !== 'string' || !/^[0-9]+$/.test(raw.freelancerAmount)) {
    throw new ResolutionReportValidationError(
      'Invalid freelancerAmount: must be a non-negative base-unit integer string'
    );
  }
  if (typeof raw.clientAmount !== 'string' || !/^[0-9]+$/.test(raw.clientAmount)) {
    throw new ResolutionReportValidationError(
      'Invalid clientAmount: must be a non-negative base-unit integer string'
    );
  }

  const fAmount = BigInt(raw.freelancerAmount);
  const cAmount = BigInt(raw.clientAmount);

  if (fAmount < 0n || cAmount < 0n) {
    throw new ResolutionReportValidationError('Amounts cannot be negative');
  }

  if (expectedMilestoneAmount !== undefined) {
    if (fAmount + cAmount !== expectedMilestoneAmount) {
      throw new ResolutionReportValidationError(
        `Split sum mismatch: freelancerAmount (${fAmount.toString()}) + clientAmount (${cAmount.toString()}) !== milestone amount (${expectedMilestoneAmount.toString()})`
      );
    }
  }

  const canonicalFreelancerAmount = fAmount.toString();
  const canonicalClientAmount = cAmount.toString();

  // 11. Narrative: summary
  if (typeof raw.summary !== 'string') {
    throw new ResolutionReportValidationError('Summary is required and must be a string');
  }
  const normalizedSummary = raw.summary.normalize('NFC').trim();
  if (normalizedSummary.length < RESOLUTION_REPORT_LIMITS.MIN_SUMMARY_LENGTH) {
    throw new ResolutionReportValidationError('Summary cannot be empty');
  }
  if (normalizedSummary.length > RESOLUTION_REPORT_LIMITS.MAX_SUMMARY_LENGTH) {
    throw new ResolutionReportValidationError(
      `Summary length (${normalizedSummary.length}) exceeds maximum limit of ${RESOLUTION_REPORT_LIMITS.MAX_SUMMARY_LENGTH}`
    );
  }

  // 12. Narrative: findings
  if (typeof raw.findings !== 'string') {
    throw new ResolutionReportValidationError('Findings is required and must be a string');
  }
  const normalizedFindings = raw.findings.normalize('NFC').trim();
  if (normalizedFindings.length < RESOLUTION_REPORT_LIMITS.MIN_FINDINGS_LENGTH) {
    throw new ResolutionReportValidationError('Findings cannot be empty');
  }
  if (normalizedFindings.length > RESOLUTION_REPORT_LIMITS.MAX_FINDINGS_LENGTH) {
    throw new ResolutionReportValidationError(
      `Findings length (${normalizedFindings.length}) exceeds maximum limit of ${RESOLUTION_REPORT_LIMITS.MAX_FINDINGS_LENGTH}`
    );
  }

  // 13. Narrative: justification
  if (typeof raw.justification !== 'string') {
    throw new ResolutionReportValidationError('Justification is required and must be a string');
  }
  const normalizedJustification = raw.justification.normalize('NFC').trim();
  if (normalizedJustification.length < RESOLUTION_REPORT_LIMITS.MIN_JUSTIFICATION_LENGTH) {
    throw new ResolutionReportValidationError('Justification cannot be empty');
  }
  if (normalizedJustification.length > RESOLUTION_REPORT_LIMITS.MAX_JUSTIFICATION_LENGTH) {
    throw new ResolutionReportValidationError(
      `Justification length (${normalizedJustification.length}) exceeds maximum limit of ${RESOLUTION_REPORT_LIMITS.MAX_JUSTIFICATION_LENGTH}`
    );
  }

  // 14. evidenceReferences (optional)
  let normalizedReferences: CanonicalEvidenceReference[] | undefined;
  if (raw.evidenceReferences !== undefined && raw.evidenceReferences !== null) {
    if (!Array.isArray(raw.evidenceReferences)) {
      throw new ResolutionReportValidationError('evidenceReferences must be an array');
    }
    if (raw.evidenceReferences.length > RESOLUTION_REPORT_LIMITS.MAX_REFERENCES_COUNT) {
      throw new ResolutionReportValidationError(
        `evidenceReferences count (${raw.evidenceReferences.length}) exceeds maximum limit of ${RESOLUTION_REPORT_LIMITS.MAX_REFERENCES_COUNT}`
      );
    }
    normalizedReferences = raw.evidenceReferences.map((ref, idx) => normalizeEvidenceReference(ref, idx));
  }

  const normalizedReport: CanonicalResolutionReportV1 = {
    schemaVersion: 1,
    phase: canonicalPhase,
    chainId: raw.chainId,
    committeeAddress: canonicalCommitteeAddress,
    dealAddress: canonicalDealAddress,
    milestoneId: raw.milestoneId,
    submissionVersion: raw.submissionVersion,
    specHash: canonicalSpecHash,
    evidenceRootHash: canonicalEvidenceRootHash,
    freelancerAmount: canonicalFreelancerAmount,
    clientAmount: canonicalClientAmount,
    summary: normalizedSummary,
    findings: normalizedFindings,
    justification: normalizedJustification,
    ...(normalizedReferences && normalizedReferences.length > 0
      ? { evidenceReferences: normalizedReferences }
      : {}),
  };

  // 15. Check serialized length bounds
  const serialized = canonicalizeResolutionReport(normalizedReport);
  const byteLength = stringToBytes(serialized).length;
  if (byteLength > RESOLUTION_REPORT_LIMITS.MAX_SERIALIZED_BYTES) {
    throw new ResolutionReportValidationError(
      `Serialized report size (${byteLength} bytes) exceeds maximum limit of ${RESOLUTION_REPORT_LIMITS.MAX_SERIALIZED_BYTES} bytes`
    );
  }

  return normalizedReport;
}

/**
 * Deterministically serializes a normalized CanonicalResolutionReportV1 to UTF-8 JSON
 * using the shared RFC 8785 (JCS) canonicalizeValue utility.
 */
export function canonicalizeResolutionReport(report: CanonicalResolutionReportV1): string {
  return canonicalizeValue(report);
}

/**
 * Computes the 32-byte cryptographic justificationHash for a resolution report:
 * keccak256(UTF-8(canonicalizeResolutionReport(normalizeResolutionReport(report))))
 *
 * Always returns a lowercase 0x<64-hex> string.
 */
export function hashResolutionReport(reportInput: unknown, expectedMilestoneAmount?: bigint): `0x${string}` {
  const normalized = normalizeResolutionReport(reportInput, expectedMilestoneAmount);
  const serialized = canonicalizeResolutionReport(normalized);
  const utf8Bytes = stringToBytes(serialized);
  return keccak256(utf8Bytes).toLowerCase() as `0x${string}`;
}

/**
 * Evaluates whether a resolution report can be staged for a milestone given on-chain state.
 */
export function determineResolutionReportEligibility(params: {
  dealState: DealState;
  milestoneStatus: MilestoneStatus;
  phase: ResolutionReportPhase;
  isProtected?: boolean;
}): { eligible: boolean; reason?: string } {
  if (params.dealState !== DealState.Active) {
    return {
      eligible: false,
      reason: `Deal state must be Active (1), current state: ${params.dealState}`,
    };
  }

  if (params.isProtected) {
    return {
      eligible: false,
      reason: 'Protected deals cannot use Standard V2 committee resolution reports',
    };
  }

  if (params.phase === 'INITIAL_RESOLUTION') {
    if (params.milestoneStatus !== MilestoneStatus.Disputed) {
      return {
        eligible: false,
        reason: `Initial resolution requires milestone status Disputed (4), current status: ${params.milestoneStatus}`,
      };
    }
  } else if (params.phase === 'FINAL_RESOLUTION') {
    if (params.milestoneStatus !== MilestoneStatus.FinalReview) {
      return {
        eligible: false,
        reason: `Final resolution requires milestone status FinalReview (6), current status: ${params.milestoneStatus}`,
      };
    }
  } else {
    return {
      eligible: false,
      reason: `Unknown resolution phase: ${String(params.phase)}`,
    };
  }

  return { eligible: true };
}

/**
 * Derives the currently-authorized committee address from chain state based on Solidity rules:
 * - INITIAL_RESOLUTION:
 *     Primary resolver if latestBlockTimestamp < disputeOpenedAt + 14 days
 *     Emergency resolver if latestBlockTimestamp >= disputeOpenedAt + 14 days
 * - FINAL_RESOLUTION:
 *     Strictly the resolver recorded in resolutionProposals[milestoneId].resolver.
 */
export function deriveAuthorizedCommittee(params: {
  primaryResolver: string;
  emergencyResolver: string;
  phase: ResolutionReportPhase;
  milestoneDisputeOpenedAt: bigint;
  latestBlockTimestamp: bigint;
  storedResolutionResolver?: string | null;
}): { authorizedCommittee: `0x${string}`; error?: string } {
  if (params.phase === 'INITIAL_RESOLUTION') {
    if (params.milestoneDisputeOpenedAt <= 0n) {
      return {
        authorizedCommittee: '0x0000000000000000000000000000000000000000',
        error: 'Dispute opened timestamp not recorded on-chain',
      };
    }

    const slaBoundary = params.milestoneDisputeOpenedAt + PRIMARY_RESOLVER_SLA_SECONDS;
    if (params.latestBlockTimestamp < slaBoundary) {
      return { authorizedCommittee: params.primaryResolver.toLowerCase() as `0x${string}` };
    } else {
      return { authorizedCommittee: params.emergencyResolver.toLowerCase() as `0x${string}` };
    }
  }

  if (params.phase === 'FINAL_RESOLUTION') {
    if (!params.storedResolutionResolver || !isAddress(params.storedResolutionResolver)) {
      return {
        authorizedCommittee: '0x0000000000000000000000000000000000000000',
        error: 'Final resolution requires existing on-chain resolution proposal resolver',
      };
    }
    return { authorizedCommittee: params.storedResolutionResolver.toLowerCase() as `0x${string}` };
  }

  return {
    authorizedCommittee: '0x0000000000000000000000000000000000000000',
    error: `Unsupported phase: ${String(params.phase)}`,
  };
}

/**
 * Evaluates whether a caller wallet is permitted to read a resolution report.
 * Accessible to:
 * 1. Deal client
 * 2. Deal freelancer
 * 3. Any current committee signer on primary or emergency resolvers
 * 4. Staged-by wallet (historical author, even if later rotated out)
 */
export function canAccessResolutionReport(params: {
  callerWallet: string;
  dealClient: string;
  dealFreelancer: string;
  isCommitteeSigner: boolean;
  stagedByWallet?: string | null;
}): boolean {
  if (!params.callerWallet || !isAddress(params.callerWallet)) {
    return false;
  }
  const caller = params.callerWallet.toLowerCase();
  if (caller === params.dealClient.toLowerCase()) return true;
  if (caller === params.dealFreelancer.toLowerCase()) return true;
  if (params.isCommitteeSigner) return true;
  if (params.stagedByWallet && caller === params.stagedByWallet.toLowerCase()) return true;

  return false;
}

/**
 * Validates transaction receipt logs for an on-chain proposeMilestoneResolution call.
 * Confirms emission of ResolutionProposed(uint256,address,uint256,uint256,bytes32,uint64).
 */
export function verifyResolutionProposedReceipt(params: {
  receipt: { status: string; logs: any[] };
  dealAddress: string;
  expectedMilestoneId: bigint;
  expectedResolver: string;
  expectedFreelancerAmount: bigint;
  expectedClientAmount: bigint;
  expectedJustificationHash: string;
}): {
  valid: boolean;
  error?: string;
  event?: {
    milestoneId: bigint;
    resolver: `0x${string}`;
    freelancerAmount: bigint;
    clientAmount: bigint;
    justificationHash: `0x${string}`;
    reconsiderationDeadline: bigint;
  };
} {
  const isSuccess = params.receipt.status === 'success' || params.receipt.status === '0x1';
  if (!isSuccess) {
    return { valid: false, error: 'Transaction reverted on-chain' };
  }

  const normalizedDeal = params.dealAddress.toLowerCase();
  const normalizedResolver = params.expectedResolver.toLowerCase();
  const normalizedHash = params.expectedJustificationHash.toLowerCase();

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

      if (decoded.eventName === 'ResolutionProposed') {
        const args = decoded.args as unknown as {
          milestoneId: bigint;
          resolver: `0x${string}`;
          freelancerAmount: bigint;
          clientAmount: bigint;
          justificationHash: `0x${string}`;
          reconsiderationDeadline: bigint;
        };

        if (BigInt(args.milestoneId) !== params.expectedMilestoneId) {
          return {
            valid: false,
            error: `ResolutionProposed milestoneId mismatch: expected ${params.expectedMilestoneId}, received ${args.milestoneId}`,
          };
        }

        if (args.resolver.toLowerCase() !== normalizedResolver) {
          return {
            valid: false,
            error: `ResolutionProposed resolver mismatch: expected ${normalizedResolver}, received ${args.resolver.toLowerCase()}`,
          };
        }

        if (BigInt(args.freelancerAmount) !== params.expectedFreelancerAmount) {
          return {
            valid: false,
            error: `ResolutionProposed freelancerAmount mismatch: expected ${params.expectedFreelancerAmount}, received ${args.freelancerAmount}`,
          };
        }

        if (BigInt(args.clientAmount) !== params.expectedClientAmount) {
          return {
            valid: false,
            error: `ResolutionProposed clientAmount mismatch: expected ${params.expectedClientAmount}, received ${args.clientAmount}`,
          };
        }

        if (args.justificationHash.toLowerCase() !== normalizedHash) {
          return {
            valid: false,
            error: `ResolutionProposed justificationHash mismatch: expected ${normalizedHash}, received ${args.justificationHash.toLowerCase()}`,
          };
        }

        return {
          valid: true,
          event: {
            milestoneId: BigInt(args.milestoneId),
            resolver: args.resolver.toLowerCase() as `0x${string}`,
            freelancerAmount: BigInt(args.freelancerAmount),
            clientAmount: BigInt(args.clientAmount),
            justificationHash: args.justificationHash.toLowerCase() as `0x${string}`,
            reconsiderationDeadline: BigInt(args.reconsiderationDeadline),
          },
        };
      }
    } catch {
      // Ignore unparseable logs from other contracts
    }
  }

  return {
    valid: false,
    error: 'ResolutionProposed event not found in transaction receipt for this Deal clone',
  };
}

/**
 * Validates transaction receipt logs for an on-chain executeFinalResolution call.
 * Confirms emission of FinalResolutionExecuted(uint256,address,uint256,uint256,bytes32).
 */
export function verifyFinalResolutionExecutedReceipt(params: {
  receipt: { status: string; logs: any[] };
  dealAddress: string;
  expectedMilestoneId: bigint;
  expectedResolver: string;
  expectedFreelancerAmount: bigint;
  expectedClientAmount: bigint;
  expectedJustificationHash: string;
}): {
  valid: boolean;
  error?: string;
  event?: {
    milestoneId: bigint;
    resolver: `0x${string}`;
    freelancerAmount: bigint;
    clientAmount: bigint;
    justificationHash: `0x${string}`;
  };
} {
  const isSuccess = params.receipt.status === 'success' || params.receipt.status === '0x1';
  if (!isSuccess) {
    return { valid: false, error: 'Transaction reverted on-chain' };
  }

  const normalizedDeal = params.dealAddress.toLowerCase();
  const normalizedResolver = params.expectedResolver.toLowerCase();
  const normalizedHash = params.expectedJustificationHash.toLowerCase();

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

      if (decoded.eventName === 'FinalResolutionExecuted') {
        const args = decoded.args as unknown as {
          milestoneId: bigint;
          resolver: `0x${string}`;
          freelancerAmount: bigint;
          clientAmount: bigint;
          justificationHash: `0x${string}`;
        };

        if (BigInt(args.milestoneId) !== params.expectedMilestoneId) {
          return {
            valid: false,
            error: `FinalResolutionExecuted milestoneId mismatch: expected ${params.expectedMilestoneId}, received ${args.milestoneId}`,
          };
        }

        if (args.resolver.toLowerCase() !== normalizedResolver) {
          return {
            valid: false,
            error: `FinalResolutionExecuted resolver mismatch: expected ${normalizedResolver}, received ${args.resolver.toLowerCase()}`,
          };
        }

        if (BigInt(args.freelancerAmount) !== params.expectedFreelancerAmount) {
          return {
            valid: false,
            error: `FinalResolutionExecuted freelancerAmount mismatch: expected ${params.expectedFreelancerAmount}, received ${args.freelancerAmount}`,
          };
        }

        if (BigInt(args.clientAmount) !== params.expectedClientAmount) {
          return {
            valid: false,
            error: `FinalResolutionExecuted clientAmount mismatch: expected ${params.expectedClientAmount}, received ${args.clientAmount}`,
          };
        }

        if (args.justificationHash.toLowerCase() !== normalizedHash) {
          return {
            valid: false,
            error: `FinalResolutionExecuted justificationHash mismatch: expected ${normalizedHash}, received ${args.justificationHash.toLowerCase()}`,
          };
        }

        return {
          valid: true,
          event: {
            milestoneId: BigInt(args.milestoneId),
            resolver: args.resolver.toLowerCase() as `0x${string}`,
            freelancerAmount: BigInt(args.freelancerAmount),
            clientAmount: BigInt(args.clientAmount),
            justificationHash: args.justificationHash.toLowerCase() as `0x${string}`,
          },
        };
      }
    } catch {
      // Ignore unparseable logs from other contracts
    }
  }

  return {
    valid: false,
    error: 'FinalResolutionExecuted event not found in transaction receipt for this Deal clone',
  };
}
