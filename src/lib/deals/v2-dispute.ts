import { isAddress, keccak256, stringToBytes, decodeEventLog } from 'viem';
import { canonicalizeValue, normalizeEvidenceLink, type CanonicalEvidenceLink, EVIDENCE_LIMITS } from '@/lib/deals/v2-evidence';
import { synqDealV1ABI } from '@/lib/contracts/abis';
import { DealState, MilestoneStatus } from '@/lib/deals/v2-deal';

/**
 * SYNQ CANONICAL SERIOUS DISPUTE MANIFEST V1
 *
 * Defines the immutable, deterministic serious dispute manifest committed
 * on-chain via openSeriousDispute(uint256 milestoneId, bytes32 reasonHash).
 */

export const DISPUTE_SCHEMA_VERSION = 1 as const;

export const DISPUTE_LIMITS = {
  MIN_EXPLANATION_LENGTH: 1,
  MAX_EXPLANATION_LENGTH: 4000,
  MAX_SERIALIZED_BYTES: 16384, // 16 KB
  MAX_LINKS_COUNT: 20,
} as const;

export const DISPUTE_CATEGORIES = [
  'unresponsive',
  'specification_breach',
  'quality_dispute',
  'bad_faith',
  'other',
] as const;

export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];

export interface CanonicalSeriousDisputeManifestV1 {
  schemaVersion: 1;
  chainId: number;
  dealAddress: `0x${string}`;
  milestoneId: number;
  submissionVersion: number;
  specHash: `0x${string}`;
  evidenceRootHash: `0x${string}`;
  openerWallet: `0x${string}`;
  counterpartyWallet: `0x${string}`;
  explanation: string;
  category?: DisputeCategory;
  links?: CanonicalEvidenceLink[];
}

export class DisputeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisputeValidationError';
  }
}

/**
 * Validates and normalizes the full canonical serious dispute manifest.
 *
 * Normalization Rules:
 * - schemaVersion strictly 1
 * - chainId positive integer
 * - dealAddress valid EVM address, lowercase
 * - milestoneId non-negative integer
 * - submissionVersion non-negative integer (0 for InProgress before submit, >= 1 after submit)
 * - specHash valid lowercase 32-byte hex (0x<64-hex>)
 * - evidenceRootHash valid lowercase 32-byte hex (0x<64-hex>)
 * - openerWallet valid EVM address, lowercase
 * - counterpartyWallet valid EVM address, lowercase
 * - openerWallet !== counterpartyWallet
 * - explanation: Unicode NFC, trimmed leading/trailing, internal whitespace preserved, 1..4000 chars
 * - category: optional string in DISPUTE_CATEGORIES
 * - links: optional array of validated CanonicalEvidenceLink, max 20
 * - Total serialized byte length <= 16384 bytes
 */
export function normalizeSeriousDisputeManifest(input: unknown): CanonicalSeriousDisputeManifestV1 {
  if (!input || typeof input !== 'object') {
    throw new DisputeValidationError('Manifest must be a non-null object');
  }

  const raw = input as Record<string, unknown>;

  // 1. schemaVersion
  if (raw.schemaVersion !== DISPUTE_SCHEMA_VERSION) {
    throw new DisputeValidationError(
      `Invalid schemaVersion: expected ${DISPUTE_SCHEMA_VERSION}, got ${String(raw.schemaVersion)}`
    );
  }

  // 2. chainId
  if (typeof raw.chainId !== 'number' || !Number.isInteger(raw.chainId) || raw.chainId <= 0) {
    throw new DisputeValidationError('Invalid chainId: must be a positive integer');
  }

  // 3. dealAddress
  if (typeof raw.dealAddress !== 'string' || !isAddress(raw.dealAddress, { strict: false })) {
    throw new DisputeValidationError('Invalid dealAddress: must be a valid EVM address');
  }
  const canonicalDealAddress = raw.dealAddress.toLowerCase() as `0x${string}`;

  // 4. milestoneId
  if (typeof raw.milestoneId !== 'number' || !Number.isInteger(raw.milestoneId) || raw.milestoneId < 0) {
    throw new DisputeValidationError('Invalid milestoneId: must be a non-negative integer');
  }

  // 5. submissionVersion
  if (typeof raw.submissionVersion !== 'number' || !Number.isInteger(raw.submissionVersion) || raw.submissionVersion < 0) {
    throw new DisputeValidationError('Invalid submissionVersion: must be an integer >= 0');
  }

  // 6. specHash
  if (typeof raw.specHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw.specHash)) {
    throw new DisputeValidationError('Invalid specHash: must be a 0x-prefixed 32-byte hex string');
  }
  const canonicalSpecHash = raw.specHash.toLowerCase() as `0x${string}`;

  // 7. evidenceRootHash
  if (typeof raw.evidenceRootHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw.evidenceRootHash)) {
    throw new DisputeValidationError('Invalid evidenceRootHash: must be a 0x-prefixed 32-byte hex string');
  }
  const canonicalEvidenceRootHash = raw.evidenceRootHash.toLowerCase() as `0x${string}`;

  // 8. openerWallet
  if (typeof raw.openerWallet !== 'string' || !isAddress(raw.openerWallet, { strict: false })) {
    throw new DisputeValidationError('Invalid openerWallet: must be a valid EVM address');
  }
  const canonicalOpenerWallet = raw.openerWallet.toLowerCase() as `0x${string}`;

  // 9. counterpartyWallet
  if (typeof raw.counterpartyWallet !== 'string' || !isAddress(raw.counterpartyWallet, { strict: false })) {
    throw new DisputeValidationError('Invalid counterpartyWallet: must be a valid EVM address');
  }
  const canonicalCounterpartyWallet = raw.counterpartyWallet.toLowerCase() as `0x${string}`;

  if (canonicalOpenerWallet === canonicalCounterpartyWallet) {
    throw new DisputeValidationError('openerWallet cannot equal counterpartyWallet');
  }

  // 10. explanation
  if (typeof raw.explanation !== 'string') {
    throw new DisputeValidationError('Explanation is required and must be a string');
  }
  const normalizedExplanation = raw.explanation.normalize('NFC').trim();
  if (normalizedExplanation.length < DISPUTE_LIMITS.MIN_EXPLANATION_LENGTH) {
    throw new DisputeValidationError('Explanation cannot be empty');
  }
  if (normalizedExplanation.length > DISPUTE_LIMITS.MAX_EXPLANATION_LENGTH) {
    throw new DisputeValidationError(
      `Explanation length (${normalizedExplanation.length}) exceeds maximum of ${DISPUTE_LIMITS.MAX_EXPLANATION_LENGTH} characters`
    );
  }

  // 11. category (optional)
  let normalizedCategory: DisputeCategory | undefined;
  if (raw.category !== undefined && raw.category !== null) {
    if (typeof raw.category !== 'string' || !DISPUTE_CATEGORIES.includes(raw.category as DisputeCategory)) {
      throw new DisputeValidationError(
        `Invalid category: '${String(raw.category)}'. Allowed: ${DISPUTE_CATEGORIES.join(', ')}`
      );
    }
    normalizedCategory = raw.category as DisputeCategory;
  }

  // 12. links (optional)
  let normalizedLinks: CanonicalEvidenceLink[] | undefined;
  if (raw.links !== undefined && raw.links !== null) {
    if (!Array.isArray(raw.links)) {
      throw new DisputeValidationError('Links must be an array');
    }
    if (raw.links.length > DISPUTE_LIMITS.MAX_LINKS_COUNT) {
      throw new DisputeValidationError(
        `Links count (${raw.links.length}) exceeds maximum limit of ${DISPUTE_LIMITS.MAX_LINKS_COUNT}`
      );
    }
    normalizedLinks = raw.links.map((link, idx) => normalizeEvidenceLink(link, idx));
  }

  const normalizedManifest: CanonicalSeriousDisputeManifestV1 = {
    schemaVersion: 1,
    chainId: raw.chainId,
    dealAddress: canonicalDealAddress,
    milestoneId: raw.milestoneId,
    submissionVersion: raw.submissionVersion,
    specHash: canonicalSpecHash,
    evidenceRootHash: canonicalEvidenceRootHash,
    openerWallet: canonicalOpenerWallet,
    counterpartyWallet: canonicalCounterpartyWallet,
    explanation: normalizedExplanation,
    ...(normalizedCategory ? { category: normalizedCategory } : {}),
    ...(normalizedLinks && normalizedLinks.length > 0 ? { links: normalizedLinks } : {}),
  };

  // 13. Size check
  const serialized = canonicalizeSeriousDisputeManifest(normalizedManifest);
  const byteLength = stringToBytes(serialized).length;
  if (byteLength > DISPUTE_LIMITS.MAX_SERIALIZED_BYTES) {
    throw new DisputeValidationError(
      `Serialized manifest size (${byteLength} bytes) exceeds maximum limit of ${DISPUTE_LIMITS.MAX_SERIALIZED_BYTES} bytes`
    );
  }

  return normalizedManifest;
}

/**
 * Deterministically serializes a normalized CanonicalSeriousDisputeManifestV1 to UTF-8 JSON
 * using the shared RFC 8785 (JCS) canonicalizeValue utility.
 */
export function canonicalizeSeriousDisputeManifest(manifest: CanonicalSeriousDisputeManifestV1): string {
  return canonicalizeValue(manifest);
}

/**
 * Computes the 32-byte cryptographic reasonHash for a serious dispute manifest:
 * keccak256(UTF-8(canonicalizeSeriousDisputeManifest(normalizeSeriousDisputeManifest(manifest))))
 *
 * Always returns a lowercase 0x<64-hex> string.
 */
export function hashSeriousDisputeManifest(manifestInput: unknown): `0x${string}` {
  const normalized = normalizeSeriousDisputeManifest(manifestInput);
  const serialized = canonicalizeSeriousDisputeManifest(normalized);
  const utf8Bytes = stringToBytes(serialized);
  return keccak256(utf8Bytes).toLowerCase() as `0x${string}`;
}

/**
 * Evaluates whether a serious dispute can be opened for a given milestone.
 *
 * Solidity Invariants (contracts/v1/SynqDealV1Sequential.sol):
 * - onlyParticipant: caller is client or freelancer
 * - inDealState(DealState.Active): dealState === DealState.Active
 * - Milestone status must be InProgress, Submitted, or RevisionRequested
 * - Must NOT be protected deal (Standard V2 only)
 */
export function determineSeriousDisputeEligibility(params: {
  dealState: DealState;
  milestoneStatus: MilestoneStatus;
  isClient: boolean;
  isFreelancer: boolean;
  isProtected?: boolean;
}): {
  eligible: boolean;
  reason?: string;
} {
  if (params.dealState !== DealState.Active) {
    return { eligible: false, reason: 'Deal is not in Active state' };
  }

  if (params.isProtected) {
    return { eligible: false, reason: 'Protected deals cannot use standard serious dispute flow' };
  }

  if (!params.isClient && !params.isFreelancer) {
    return { eligible: false, reason: 'Only deal participants (client or freelancer) can open a dispute' };
  }

  const eligibleStatuses = [
    MilestoneStatus.InProgress,
    MilestoneStatus.Submitted,
    MilestoneStatus.RevisionRequested,
  ];

  if (!eligibleStatuses.includes(params.milestoneStatus)) {
    return {
      eligible: false,
      reason: `Milestone status (${MilestoneStatus[params.milestoneStatus] || params.milestoneStatus}) is not eligible for serious dispute`,
    };
  }

  return { eligible: true };
}

/**
 * Validates that SeriousDisputeOpened event was emitted by the exact Deal address
 * with the expected milestoneId, opener, and reasonHash.
 */
export function verifySeriousDisputeOpenedReceipt(
  receipt: { status: string | number; logs: readonly any[] },
  dealAddress: string,
  expectedMilestoneId: bigint,
  expectedOpener: string,
  expectedReasonHash: `0x${string}`
): {
  valid: boolean;
  error?: string;
  seriousDisputeOpenedEvent?: {
    milestoneId: bigint;
    opener: `0x${string}`;
    reasonHash: `0x${string}`;
  };
} {
  const isSuccess = receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1';
  if (!isSuccess) {
    return { valid: false, error: 'Transaction reverted on-chain' };
  }

  const normalizedDeal = dealAddress.toLowerCase();
  const normalizedExpectedOpener = expectedOpener.toLowerCase();
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

      if (decoded.eventName === 'SeriousDisputeOpened') {
        const args = decoded.args as unknown as {
          milestoneId: bigint;
          opener: `0x${string}`;
          reasonHash: `0x${string}`;
        };

        if (BigInt(args.milestoneId) !== expectedMilestoneId) {
          return {
            valid: false,
            error: `SeriousDisputeOpened milestoneId mismatch: expected ${expectedMilestoneId}, received ${args.milestoneId}`,
          };
        }

        if (args.opener.toLowerCase() !== normalizedExpectedOpener) {
          return {
            valid: false,
            error: `SeriousDisputeOpened opener mismatch: expected ${normalizedExpectedOpener}, received ${args.opener.toLowerCase()}`,
          };
        }

        if (args.reasonHash.toLowerCase() !== normalizedExpectedReason) {
          return {
            valid: false,
            error: `SeriousDisputeOpened reasonHash mismatch: expected ${normalizedExpectedReason}, received ${args.reasonHash.toLowerCase()}`,
          };
        }

        return {
          valid: true,
          seriousDisputeOpenedEvent: {
            milestoneId: BigInt(args.milestoneId),
            opener: args.opener.toLowerCase() as `0x${string}`,
            reasonHash: args.reasonHash.toLowerCase() as `0x${string}`,
          },
        };
      }
    } catch {
      // Ignore unparseable logs from other event ABIs
    }
  }

  return {
    valid: false,
    error: 'SeriousDisputeOpened event not found in transaction receipt for this Deal clone',
  };
}

/**
 * Preflight validation before invoking openSeriousDispute on-chain.
 */
export function validateSeriousDisputePreflight(params: {
  stagedManifest: CanonicalSeriousDisputeManifestV1;
  freshDealAddress: string;
  freshDealState: DealState;
  freshClientAddress: string;
  freshFreelancerAddress: string;
  freshMilestoneIndex: number;
  freshMilestoneStatus: MilestoneStatus;
  freshMilestoneVersion: number;
  freshSpecHash: `0x${string}`;
  freshEvidenceRootHash: `0x${string}`;
  callerAddress: string;
  isProtected?: boolean;
}): { valid: boolean; error?: string } {
  if (params.stagedManifest.dealAddress.toLowerCase() !== params.freshDealAddress.toLowerCase()) {
    return { valid: false, error: 'Deal address mismatch between staged dispute and on-chain Deal' };
  }
  if (params.stagedManifest.milestoneId !== params.freshMilestoneIndex) {
    return { valid: false, error: 'Milestone ID mismatch between staged dispute and on-chain milestone' };
  }
  if (params.stagedManifest.submissionVersion !== params.freshMilestoneVersion) {
    return { valid: false, error: 'Submission version mismatch between staged dispute and on-chain milestone' };
  }
  if (params.stagedManifest.specHash.toLowerCase() !== params.freshSpecHash.toLowerCase()) {
    return { valid: false, error: 'specHash mismatch between staged dispute and on-chain milestone' };
  }
  if (params.stagedManifest.evidenceRootHash.toLowerCase() !== params.freshEvidenceRootHash.toLowerCase()) {
    return { valid: false, error: 'evidenceRootHash mismatch between staged dispute and on-chain milestone' };
  }
  const normCaller = params.callerAddress.toLowerCase();
  if (normCaller !== params.stagedManifest.openerWallet.toLowerCase()) {
    return { valid: false, error: 'Connected wallet is not the dispute opener' };
  }
  const isClient = normCaller === params.freshClientAddress.toLowerCase();
  const isFreelancer = normCaller === params.freshFreelancerAddress.toLowerCase();
  if (!isClient && !isFreelancer) {
    return { valid: false, error: 'Connected wallet is not a participant in this Deal' };
  }
  const expectedCounterparty = isClient
    ? params.freshFreelancerAddress.toLowerCase()
    : params.freshClientAddress.toLowerCase();
  if (params.stagedManifest.counterpartyWallet.toLowerCase() !== expectedCounterparty) {
    return { valid: false, error: 'Counterparty mismatch between staged dispute and on-chain participants' };
  }
  const elig = determineSeriousDisputeEligibility({
    dealState: params.freshDealState,
    milestoneStatus: params.freshMilestoneStatus,
    isClient,
    isFreelancer,
    isProtected: params.isProtected,
  });
  if (!elig.eligible) {
    return { valid: false, error: elig.reason || 'Milestone is not eligible for serious dispute' };
  }
  return { valid: true };
}

