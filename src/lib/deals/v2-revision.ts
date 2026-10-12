import { getAddress, isAddress, keccak256, stringToBytes, decodeEventLog } from 'viem';
import { canonicalizeValue } from '@/lib/deals/v2-evidence';
import { synqDealV1ABI } from '@/lib/contracts/abis';

/**
 * SYNQ CANONICAL REVISION REQUEST MANIFEST V1
 *
 * Defines the immutable, deterministic revision request manifest committed
 * on-chain via requestRevision(uint256 milestoneId, bytes32 reasonHash, uint64 proposedRevisionDeadline).
 */

export const REVISION_SCHEMA_VERSION = 1 as const;

export const REVISION_LIMITS = {
  MIN_FEEDBACK_LENGTH: 1,
  MAX_FEEDBACK_LENGTH: 4000,
  MAX_SERIALIZED_BYTES: 16384, // 16 KB
} as const;

export interface CanonicalRevisionManifestV1 {
  schemaVersion: 1;
  chainId: number;
  dealAddress: `0x${string}`;
  milestoneId: number;
  submissionVersion: number;
  specHash: `0x${string}`;
  evidenceRootHash: `0x${string}`;
  clientWallet: `0x${string}`;
  freelancerWallet: `0x${string}`;
  feedback: string;
  proposedRevisionDeadline: number;
}

export class RevisionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevisionValidationError';
  }
}

/**
 * Validates and normalizes the full canonical revision manifest.
 *
 * Normalization Rules:
 * - schemaVersion strictly 1
 * - chainId positive integer
 * - dealAddress valid EVM address, lowercase
 * - milestoneId non-negative integer
 * - submissionVersion positive integer >= 1 (binds the current submitted version being revised)
 * - specHash valid lowercase 32-byte hex (0x<64-hex>)
 * - evidenceRootHash valid lowercase 32-byte hex (0x<64-hex>)
 * - clientWallet valid EVM address, lowercase
 * - freelancerWallet valid EVM address, lowercase
 * - feedback: Unicode NFC, trimmed leading/trailing, internal whitespace preserved, 1..4000 chars
 * - proposedRevisionDeadline: positive integer timestamp in seconds
 * - Total serialized byte length <= 16384 bytes
 */
export function normalizeRevisionManifest(input: unknown): CanonicalRevisionManifestV1 {
  if (!input || typeof input !== 'object') {
    throw new RevisionValidationError('Manifest must be a non-null object');
  }

  const raw = input as Record<string, unknown>;

  // 1. schemaVersion
  if (raw.schemaVersion !== REVISION_SCHEMA_VERSION) {
    throw new RevisionValidationError(
      `Invalid schemaVersion: expected ${REVISION_SCHEMA_VERSION}, got ${String(raw.schemaVersion)}`
    );
  }

  // 2. chainId
  if (typeof raw.chainId !== 'number' || !Number.isInteger(raw.chainId) || raw.chainId <= 0) {
    throw new RevisionValidationError(`Invalid chainId: must be a positive integer`);
  }

  // 3. dealAddress
  if (typeof raw.dealAddress !== 'string' || !isAddress(raw.dealAddress)) {
    throw new RevisionValidationError(`Invalid dealAddress: must be a valid EVM address`);
  }
  const canonicalDealAddress = raw.dealAddress.toLowerCase() as `0x${string}`;

  // 4. milestoneId
  if (typeof raw.milestoneId !== 'number' || !Number.isInteger(raw.milestoneId) || raw.milestoneId < 0) {
    throw new RevisionValidationError(`Invalid milestoneId: must be a non-negative integer`);
  }

  // 5. submissionVersion
  if (typeof raw.submissionVersion !== 'number' || !Number.isInteger(raw.submissionVersion) || raw.submissionVersion < 1) {
    throw new RevisionValidationError(`Invalid submissionVersion: must be an integer >= 1`);
  }

  // 6. specHash
  if (typeof raw.specHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw.specHash)) {
    throw new RevisionValidationError(`Invalid specHash: must be a 0x-prefixed 32-byte hex string`);
  }
  const canonicalSpecHash = raw.specHash.toLowerCase() as `0x${string}`;

  // 7. evidenceRootHash
  if (typeof raw.evidenceRootHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw.evidenceRootHash)) {
    throw new RevisionValidationError(`Invalid evidenceRootHash: must be a 0x-prefixed 32-byte hex string`);
  }
  const canonicalEvidenceRootHash = raw.evidenceRootHash.toLowerCase() as `0x${string}`;

  // 8. clientWallet
  if (typeof raw.clientWallet !== 'string' || !isAddress(raw.clientWallet)) {
    throw new RevisionValidationError(`Invalid clientWallet: must be a valid EVM address`);
  }
  const canonicalClientWallet = raw.clientWallet.toLowerCase() as `0x${string}`;

  // 9. freelancerWallet
  if (typeof raw.freelancerWallet !== 'string' || !isAddress(raw.freelancerWallet)) {
    throw new RevisionValidationError(`Invalid freelancerWallet: must be a valid EVM address`);
  }
  const canonicalFreelancerWallet = raw.freelancerWallet.toLowerCase() as `0x${string}`;

  if (canonicalClientWallet === canonicalFreelancerWallet) {
    throw new RevisionValidationError('clientWallet cannot equal freelancerWallet');
  }

  // 10. feedback
  if (typeof raw.feedback !== 'string') {
    throw new RevisionValidationError('Feedback is required and must be a string');
  }
  const normalizedFeedback = raw.feedback.normalize('NFC').trim();
  if (normalizedFeedback.length < REVISION_LIMITS.MIN_FEEDBACK_LENGTH) {
    throw new RevisionValidationError('Feedback cannot be empty');
  }
  if (normalizedFeedback.length > REVISION_LIMITS.MAX_FEEDBACK_LENGTH) {
    throw new RevisionValidationError(
      `Feedback length (${normalizedFeedback.length}) exceeds maximum of ${REVISION_LIMITS.MAX_FEEDBACK_LENGTH} characters`
    );
  }

  // 11. proposedRevisionDeadline
  if (
    typeof raw.proposedRevisionDeadline !== 'number' ||
    !Number.isFinite(raw.proposedRevisionDeadline) ||
    !Number.isInteger(raw.proposedRevisionDeadline) ||
    raw.proposedRevisionDeadline <= 0
  ) {
    throw new RevisionValidationError('proposedRevisionDeadline must be a positive integer Unix timestamp');
  }

  const normalizedManifest: CanonicalRevisionManifestV1 = {
    schemaVersion: 1,
    chainId: raw.chainId,
    dealAddress: canonicalDealAddress,
    milestoneId: raw.milestoneId,
    submissionVersion: raw.submissionVersion,
    specHash: canonicalSpecHash,
    evidenceRootHash: canonicalEvidenceRootHash,
    clientWallet: canonicalClientWallet,
    freelancerWallet: canonicalFreelancerWallet,
    feedback: normalizedFeedback,
    proposedRevisionDeadline: raw.proposedRevisionDeadline,
  };

  // 12. Size check
  const serialized = canonicalizeRevisionManifest(normalizedManifest);
  const byteLength = stringToBytes(serialized).length;
  if (byteLength > REVISION_LIMITS.MAX_SERIALIZED_BYTES) {
    throw new RevisionValidationError(
      `Serialized manifest size (${byteLength} bytes) exceeds maximum limit of ${REVISION_LIMITS.MAX_SERIALIZED_BYTES} bytes`
    );
  }

  return normalizedManifest;
}

/**
 * Deterministically serializes a normalized CanonicalRevisionManifestV1 to UTF-8 JSON
 * using the shared RFC 8785 (JCS) canonicalizeValue utility.
 */
export function canonicalizeRevisionManifest(manifest: CanonicalRevisionManifestV1): string {
  return canonicalizeValue(manifest);
}

/**
 * Computes the 32-byte cryptographic reasonHash for a revision request manifest:
 * keccak256(UTF-8(canonicalizeRevisionManifest(normalizeRevisionManifest(manifest))))
 *
 * Always returns a lowercase 0x<64-hex> string.
 */
export function hashRevisionManifest(manifestInput: unknown): `0x${string}` {
  const normalized = normalizeRevisionManifest(manifestInput);
  const serialized = canonicalizeRevisionManifest(normalized);
  const utf8Bytes = stringToBytes(serialized);
  return keccak256(utf8Bytes).toLowerCase() as `0x${string}`;
}

/**
 * Validates that RevisionRequested event was emitted by the exact Deal address
 * with the expected milestoneId, reasonHash, and proposedRevisionDeadline.
 */
export function verifyRevisionRequestedReceipt(
  receipt: { status: string | number; logs: readonly any[] },
  dealAddress: string,
  expectedMilestoneId: bigint,
  expectedReasonHash: `0x${string}`,
  expectedProposedDeadline: bigint
): {
  valid: boolean;
  error?: string;
  revisionRequestedEvent?: {
    milestoneId: bigint;
    reasonHash: `0x${string}`;
    proposedRevisionDeadline: bigint;
  };
} {
  const isSuccess = receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1';
  if (!isSuccess) {
    return { valid: false, error: 'Transaction reverted on-chain' };
  }

  const normalizedDeal = dealAddress.toLowerCase();
  const normalizedExpectedReason = expectedReasonHash.toLowerCase();

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

      if (decoded.eventName === 'RevisionRequested') {
        const args = decoded.args as unknown as {
          milestoneId: bigint;
          reasonHash: `0x${string}`;
          proposedRevisionDeadline: bigint;
        };

        if (BigInt(args.milestoneId) !== expectedMilestoneId) {
          return {
            valid: false,
            error: `RevisionRequested emitted for unexpected milestone ID: ${args.milestoneId.toString()} (expected ${expectedMilestoneId.toString()})`,
          };
        }

        if (String(args.reasonHash).toLowerCase() !== normalizedExpectedReason) {
          return {
            valid: false,
            error: `RevisionRequested emitted for unexpected reasonHash: ${args.reasonHash} (expected ${expectedReasonHash})`,
          };
        }

        if (BigInt(args.proposedRevisionDeadline) !== expectedProposedDeadline) {
          return {
            valid: false,
            error: `RevisionRequested emitted for unexpected proposedRevisionDeadline: ${args.proposedRevisionDeadline.toString()} (expected ${expectedProposedDeadline.toString()})`,
          };
        }

        return {
          valid: true,
          revisionRequestedEvent: {
            milestoneId: BigInt(args.milestoneId),
            reasonHash: args.reasonHash.toLowerCase() as `0x${string}`,
            proposedRevisionDeadline: BigInt(args.proposedRevisionDeadline),
          },
        };
      }
    } catch {
      // Skip logs that do not match synqDealV1ABI
      continue;
    }
  }

  return {
    valid: false,
    error: `Transaction receipt did not contain a matching RevisionRequested event for Deal ${dealAddress}, milestone ${expectedMilestoneId.toString()}`,
  };
}
