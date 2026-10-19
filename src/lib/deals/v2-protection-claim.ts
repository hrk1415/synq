/**
 * Synq Premium Protection Claim Canonical Manifest & Hashing Module (Phase 3C)
 *
 * Defines the immutable, deterministic protection claim manifest committed
 * on-chain via SynqPremiumProtectionManagerV1_1.submitClaim(address, uint256, bytes32).
 */

import { isAddress, getAddress, keccak256, stringToBytes, decodeEventLog } from 'viem';
import {
  canonicalizeValue,
  normalizeEvidenceLink,
  type CanonicalEvidenceLink,
  EVIDENCE_LIMITS,
} from '@/lib/deals/v2-evidence';
import { DealState, MilestoneStatus } from '@/lib/deals/v2-deal';
import {
  PremiumPolicyState,
  DEFAULT_COVERAGE_RATE_BPS,
  BPS_DENOMINATOR,
} from '@/lib/deals/v2-protection';

export const PROTECTION_CLAIM_SCHEMA_VERSION = 1 as const;

export const CLAIM_LIMITS = {
  MIN_EXPLANATION_LENGTH: 1,
  MAX_EXPLANATION_LENGTH: 4000,
  MAX_SERIALIZED_BYTES: 16384, // 16 KB
  MAX_LINKS_COUNT: 20,
} as const;

export const CLAIM_FAILURE_REASONS = [
  'missed_deadline',
  'abandonment',
  'unresponsive_freelancer',
  'other',
] as const;

export type ClaimFailureReason = (typeof CLAIM_FAILURE_REASONS)[number];

export interface CanonicalProtectionClaimManifestV1 {
  schemaVersion: 1;
  chainId: number;
  managerAddress: `0x${string}`;
  dealAddress: `0x${string}`;
  milestoneId: number;
  clientWallet: `0x${string}`;
  explanation: string;
  failureReason?: ClaimFailureReason;
  links?: CanonicalEvidenceLink[];
}

export class ProtectionClaimValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectionClaimValidationError';
  }
}

export class ProtectionClaimAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectionClaimAuthError';
  }
}

export class ProtectionClaimConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectionClaimConflictError';
  }
}

export class ProtectionClaimIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectionClaimIntegrityError';
  }
}

/**
 * Validates and normalizes the full canonical protection claim manifest.
 *
 * Enforces:
 * - schemaVersion strictly 1
 * - chainId positive integer
 * - managerAddress valid EVM address, lowercase
 * - dealAddress valid EVM address, lowercase
 * - milestoneId non-negative integer < 16
 * - clientWallet valid EVM address, lowercase
 * - explanation: Unicode NFC, trimmed, 1..4000 chars
 * - failureReason: optional string in CLAIM_FAILURE_REASONS
 * - links: optional array of validated CanonicalEvidenceLink, max 20
 * - Total serialized byte length <= 16384 bytes
 */
export function normalizeProtectionClaimManifest(input: unknown): CanonicalProtectionClaimManifestV1 {
  if (!input || typeof input !== 'object') {
    throw new ProtectionClaimValidationError('Claim manifest must be a non-null object');
  }

  const raw = input as Record<string, unknown>;

  // 1. schemaVersion
  if (raw.schemaVersion !== PROTECTION_CLAIM_SCHEMA_VERSION) {
    throw new ProtectionClaimValidationError(
      `Invalid schemaVersion: expected ${PROTECTION_CLAIM_SCHEMA_VERSION}, got ${String(raw.schemaVersion)}`
    );
  }

  // 2. chainId
  if (typeof raw.chainId !== 'number' || !Number.isInteger(raw.chainId) || raw.chainId <= 0) {
    throw new ProtectionClaimValidationError('Invalid chainId: must be a positive integer');
  }

  // 3. managerAddress
  if (typeof raw.managerAddress !== 'string' || !isAddress(raw.managerAddress, { strict: false })) {
    throw new ProtectionClaimValidationError('Invalid managerAddress: must be a valid EVM address');
  }
  const canonicalManagerAddress = raw.managerAddress.toLowerCase() as `0x${string}`;

  // 4. dealAddress
  if (typeof raw.dealAddress !== 'string' || !isAddress(raw.dealAddress, { strict: false })) {
    throw new ProtectionClaimValidationError('Invalid dealAddress: must be a valid EVM address');
  }
  const canonicalDealAddress = raw.dealAddress.toLowerCase() as `0x${string}`;

  // 5. milestoneId
  if (
    typeof raw.milestoneId !== 'number' ||
    !Number.isInteger(raw.milestoneId) ||
    raw.milestoneId < 0 ||
    raw.milestoneId >= 16
  ) {
    throw new ProtectionClaimValidationError('Invalid milestoneId: must be an integer between 0 and 15');
  }

  // 6. clientWallet
  if (typeof raw.clientWallet !== 'string' || !isAddress(raw.clientWallet, { strict: false })) {
    throw new ProtectionClaimValidationError('Invalid clientWallet: must be a valid EVM address');
  }
  const canonicalClientWallet = raw.clientWallet.toLowerCase() as `0x${string}`;

  // 7. explanation
  if (typeof raw.explanation !== 'string') {
    throw new ProtectionClaimValidationError('Explanation is required and must be a string');
  }
  const normalizedExplanation = raw.explanation.normalize('NFC').trim();
  if (normalizedExplanation.length < CLAIM_LIMITS.MIN_EXPLANATION_LENGTH) {
    throw new ProtectionClaimValidationError('Explanation cannot be empty');
  }
  if (normalizedExplanation.length > CLAIM_LIMITS.MAX_EXPLANATION_LENGTH) {
    throw new ProtectionClaimValidationError(
      `Explanation length (${normalizedExplanation.length}) exceeds maximum limit of ${CLAIM_LIMITS.MAX_EXPLANATION_LENGTH} characters`
    );
  }

  // 8. failureReason (optional)
  let normalizedFailureReason: ClaimFailureReason | undefined;
  if (raw.failureReason !== undefined && raw.failureReason !== null) {
    if (
      typeof raw.failureReason !== 'string' ||
      !CLAIM_FAILURE_REASONS.includes(raw.failureReason as ClaimFailureReason)
    ) {
      throw new ProtectionClaimValidationError(
        `Invalid failureReason: '${String(raw.failureReason)}'. Allowed: ${CLAIM_FAILURE_REASONS.join(', ')}`
      );
    }
    normalizedFailureReason = raw.failureReason as ClaimFailureReason;
  }

  // 9. links (optional)
  let normalizedLinks: CanonicalEvidenceLink[] | undefined;
  if (raw.links !== undefined && raw.links !== null) {
    if (!Array.isArray(raw.links)) {
      throw new ProtectionClaimValidationError('Links must be an array');
    }
    if (raw.links.length > CLAIM_LIMITS.MAX_LINKS_COUNT) {
      throw new ProtectionClaimValidationError(
        `Links count (${raw.links.length}) exceeds maximum limit of ${CLAIM_LIMITS.MAX_LINKS_COUNT}`
      );
    }
    normalizedLinks = raw.links.map((link, idx) => normalizeEvidenceLink(link, idx));
  }

  const normalizedManifest: CanonicalProtectionClaimManifestV1 = {
    schemaVersion: 1,
    chainId: raw.chainId,
    managerAddress: canonicalManagerAddress,
    dealAddress: canonicalDealAddress,
    milestoneId: raw.milestoneId,
    clientWallet: canonicalClientWallet,
    explanation: normalizedExplanation,
    ...(normalizedFailureReason ? { failureReason: normalizedFailureReason } : {}),
    ...(normalizedLinks && normalizedLinks.length > 0 ? { links: normalizedLinks } : {}),
  };

  // 10. Serialized size check
  const serialized = canonicalizeProtectionClaimManifest(normalizedManifest);
  const byteLength = stringToBytes(serialized).length;
  if (byteLength > CLAIM_LIMITS.MAX_SERIALIZED_BYTES) {
    throw new ProtectionClaimValidationError(
      `Serialized manifest size (${byteLength} bytes) exceeds maximum limit of ${CLAIM_LIMITS.MAX_SERIALIZED_BYTES} bytes`
    );
  }

  return normalizedManifest;
}

/**
 * Deterministically serializes a normalized CanonicalProtectionClaimManifestV1 to UTF-8 JSON
 * using the shared RFC 8785 (JCS) canonicalizeValue utility.
 */
export function canonicalizeProtectionClaimManifest(manifest: CanonicalProtectionClaimManifestV1): string {
  return canonicalizeValue(manifest);
}

/**
 * Computes the 32-byte cryptographic evidenceHash for a protection claim manifest:
 * keccak256(UTF-8(canonicalizeProtectionClaimManifest(normalizeProtectionClaimManifest(manifest))))
 *
 * Always returns a lowercase 0x<64-hex> string.
 */
export function hashProtectionClaimManifest(manifestInput: unknown): `0x${string}` {
  const normalized = normalizeProtectionClaimManifest(manifestInput);
  const serialized = canonicalizeProtectionClaimManifest(normalized);
  const utf8Bytes = stringToBytes(serialized);
  return keccak256(utf8Bytes).toLowerCase() as `0x${string}`;
}

/**
 * Evaluates whether a client can file a protection claim for a given milestone.
 *
 * Solidity Invariants (SynqPremiumProtectionManagerV1_1.sol):
 * 1. policy.active == true
 * 2. msg.sender == policy.client
 * 3. milestoneId < 16
 * 4. (policy.coveredBitmap & (1 << milestoneId)) != 0
 * 5. claim.status == ClaimStatus.None (0)
 * 6. milestone.status == MilestoneStatus.SettledRefunded (8)
 * 7. milestone.amount > 0
 * 8. policy.maxCoverage > policy.totalPaid
 */
export function determineProtectionClaimEligibility(params: {
  dealState: DealState;
  milestoneStatus: MilestoneStatus;
  milestoneAmount: bigint;
  isClient: boolean;
  policy: PremiumPolicyState | null;
  milestoneIndex: number;
  existingClaimStatus?: number; // 0 = None, 1 = Submitted, etc.
}): {
  eligible: boolean;
  reason?: string;
  potentialPayout?: bigint;
} {
  const {
    milestoneStatus,
    milestoneAmount,
    isClient,
    policy,
    milestoneIndex,
    existingClaimStatus,
  } = params;

  if (!isClient) {
    return { eligible: false, reason: 'Only the deal client can file a protection claim' };
  }

  if (!policy || !policy.active || policy.purchasedAt === 0n) {
    return { eligible: false, reason: 'No active Premium Protection policy on-chain' };
  }

  if (milestoneIndex < 0 || milestoneIndex >= 16) {
    return { eligible: false, reason: 'Milestone index exceeds maximum protected limit (16)' };
  }

  const bitmap = policy.coveredBitmap ?? 0;
  const isCovered = (bitmap & (1 << milestoneIndex)) !== 0;
  if (!isCovered) {
    return {
      eligible: false,
      reason: 'Milestone was not covered when Premium Protection was purchased',
    };
  }

  if (existingClaimStatus !== undefined && existingClaimStatus !== 0) {
    return { eligible: false, reason: 'A protection claim has already been submitted for this milestone' };
  }

  if (milestoneStatus !== MilestoneStatus.SettledRefunded) {
    if (milestoneStatus === MilestoneStatus.SettledSplit) {
      return {
        eligible: false,
        reason: 'Milestone was resolved via committee split settlement; under V1.1 rules, only SettledRefunded milestones qualify',
      };
    }
    if (milestoneStatus === MilestoneStatus.SettledPaid) {
      return { eligible: false, reason: 'Milestone was settled as paid' };
    }
    return {
      eligible: false,
      reason: 'Milestone must be finalized as SettledRefunded (via expired deadline refund) before a claim can be filed',
    };
  }

  if (milestoneAmount <= 0n) {
    return { eligible: false, reason: 'Milestone amount is zero' };
  }

  const remainingCoverage =
    policy.maxCoverage > policy.totalPaid ? policy.maxCoverage - policy.totalPaid : 0n;
  if (remainingCoverage <= 0n) {
    return { eligible: false, reason: 'Policy coverage cap has been completely exhausted' };
  }

  // Calculate potential payout: 20% of milestone amount, capped at remaining coverage
  const rawPayout = (milestoneAmount * DEFAULT_COVERAGE_RATE_BPS) / BPS_DENOMINATOR;
  const potentialPayout = rawPayout < remainingCoverage ? rawPayout : remainingCoverage;

  return {
    eligible: true,
    potentialPayout,
  };
}

/**
 * ABI definition for SynqPremiumProtectionManagerV1_1 claim functions and events.
 */
export const synqProtectionClaimManagerABI = [
  {
    inputs: [
      { name: 'dealAddress', type: 'address' },
      { name: 'milestoneId', type: 'uint256' },
      { name: 'evidenceHash', type: 'bytes32' },
    ],
    name: 'submitClaim',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'dealAddress', type: 'address' },
      { name: 'milestoneId', type: 'uint256' },
    ],
    name: 'getClaim',
    outputs: [
      {
        components: [
          { name: 'status', type: 'uint8' },
          { name: 'milestoneId', type: 'uint256' },
          { name: 'milestoneAmount', type: 'uint256' },
          { name: 'evidenceHash', type: 'bytes32' },
          { name: 'decisionReportHash', type: 'bytes32' },
          { name: 'submittedAt', type: 'uint64' },
          { name: 'resolvedAt', type: 'uint64' },
          { name: 'payout', type: 'uint256' },
        ],
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'dealAddress', type: 'address' },
      { name: 'milestoneId', type: 'uint256' },
    ],
    name: 'isMilestoneCovered',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'protectionCommittee',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'dealAddress', type: 'address' },
      { name: 'milestoneId', type: 'uint256' },
    ],
    name: 'disburseClaim',
    outputs: [{ name: 'payoutAmount', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'pool',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'usdc',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'deal', type: 'address' },
      { indexed: true, name: 'milestoneId', type: 'uint256' },
      { indexed: true, name: 'client', type: 'address' },
      { indexed: false, name: 'milestoneAmount', type: 'uint256' },
      { indexed: false, name: 'evidenceHash', type: 'bytes32' },
    ],
    name: 'ClaimSubmitted',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'deal', type: 'address' },
      { indexed: true, name: 'milestoneId', type: 'uint256' },
      { indexed: true, name: 'recipient', type: 'address' },
      { indexed: false, name: 'payoutAmount', type: 'uint256' },
    ],
    name: 'ClaimPaid',
    type: 'event',
  },
] as const;

export const erc20TransferEventABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'from', type: 'address' },
      { indexed: true, name: 'to', type: 'address' },
      { indexed: false, name: 'value', type: 'uint256' },
    ],
    name: 'Transfer',
    type: 'event',
  },
] as const;

export const synqProtectionCommitteeABI = [
  {
    inputs: [{ name: '', type: 'address' }],
    name: 'isSigner',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export interface VerifiedClaimSubmittedReceipt {
  dealAddress: `0x${string}`;
  milestoneId: number;
  clientAddress: `0x${string}`;
  milestoneAmount: bigint;
  evidenceHash: `0x${string}`;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
}

/**
 * Validates a mined transaction receipt for a ClaimSubmitted event.
 * Reconciles strictly against on-chain logs.
 */
export function verifyClaimSubmittedReceipt(params: {
  receipt: any;
  expectedDealAddress: string;
  expectedMilestoneId: number;
  expectedClient: string;
  expectedEvidenceHash: string;
}): VerifiedClaimSubmittedReceipt {
  const { receipt, expectedDealAddress, expectedMilestoneId, expectedClient, expectedEvidenceHash } = params;

  if (!receipt || receipt.status !== 'success') {
    throw new ProtectionClaimIntegrityError('Transaction failed or receipt status is not success');
  }

  const expectedDeal = getAddress(expectedDealAddress.toLowerCase());
  const expectedClientAddr = getAddress(expectedClient.toLowerCase());
  const expectedHash = expectedEvidenceHash.toLowerCase();

  for (const log of receipt.logs || []) {
    try {
      const decoded = decodeEventLog({
        abi: synqProtectionClaimManagerABI,
        eventName: 'ClaimSubmitted',
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === 'ClaimSubmitted') {
        const deal = getAddress(decoded.args.deal);
        const milestoneId = Number(decoded.args.milestoneId);
        const client = getAddress(decoded.args.client);
        const evidenceHash = (decoded.args.evidenceHash as string).toLowerCase();

        if (
          deal === expectedDeal &&
          milestoneId === expectedMilestoneId &&
          client === expectedClientAddr
        ) {
          if (evidenceHash !== expectedHash) {
            throw new ProtectionClaimIntegrityError(
              `Evidence hash mismatch in on-chain event: expected ${expectedHash}, received ${evidenceHash}`
            );
          }

          return {
            dealAddress: deal,
            milestoneId,
            clientAddress: client,
            milestoneAmount: BigInt(decoded.args.milestoneAmount),
            evidenceHash: evidenceHash as `0x${string}`,
            blockNumber: BigInt(receipt.blockNumber),
            transactionHash: receipt.transactionHash,
          };
        }
      }
    } catch (err: any) {
      if (err instanceof ProtectionClaimIntegrityError) throw err;
      // Continue searching other logs
    }
  }

  throw new ProtectionClaimIntegrityError('No matching ClaimSubmitted event found in transaction receipt');
}

export interface VerifiedClaimPaidReceipt {
  dealAddress: `0x${string}`;
  milestoneId: number;
  recipient: `0x${string}`;
  payoutAmount: bigint;
  usdcTransferVerified: boolean;
  poolAddress?: `0x${string}`;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
}

/**
 * Validates a mined transaction receipt for a ClaimPaid event and USDC Transfer event.
 * Reconciles strictly against on-chain logs.
 */
export function verifyClaimPaidReceipt(params: {
  receipt: any;
  expectedManagerAddress: string;
  expectedDealAddress: string;
  expectedMilestoneId: number;
  expectedRecipient: string;
  expectedPayoutAmount: bigint;
  expectedPoolAddress?: string;
  expectedUsdcAddress?: string;
}): VerifiedClaimPaidReceipt {
  const {
    receipt,
    expectedManagerAddress,
    expectedDealAddress,
    expectedMilestoneId,
    expectedRecipient,
    expectedPayoutAmount,
    expectedPoolAddress,
    expectedUsdcAddress,
  } = params;

  if (!receipt || receipt.status !== 'success') {
    throw new ProtectionClaimIntegrityError('Transaction failed or receipt status is not success');
  }

  const expectedManager = getAddress(expectedManagerAddress.toLowerCase());
  const expectedDeal = getAddress(expectedDealAddress.toLowerCase());
  const expectedClientAddr = getAddress(expectedRecipient.toLowerCase());

  let claimPaidFound = false;
  let decodedClaimPaid: any = null;
  let usdcTransferVerified = false;

  for (const log of receipt.logs || []) {
    // 1. Check ClaimPaid from manager
    if (log.address.toLowerCase() === expectedManager.toLowerCase()) {
      try {
        const decoded = decodeEventLog({
          abi: synqProtectionClaimManagerABI,
          eventName: 'ClaimPaid',
          data: log.data,
          topics: log.topics,
        });

        if (decoded.eventName === 'ClaimPaid') {
          const deal = getAddress(decoded.args.deal);
          const milestoneId = Number(decoded.args.milestoneId);
          const recipient = getAddress(decoded.args.recipient);
          const payoutAmount = BigInt(decoded.args.payoutAmount);

          if (
            deal === expectedDeal &&
            milestoneId === expectedMilestoneId &&
            recipient === expectedClientAddr
          ) {
            if (payoutAmount !== expectedPayoutAmount) {
              throw new ProtectionClaimIntegrityError(
                `Payout amount mismatch in on-chain event: expected ${expectedPayoutAmount.toString()}, received ${payoutAmount.toString()}`
              );
            }
            claimPaidFound = true;
            decodedClaimPaid = { deal, milestoneId, recipient, payoutAmount };
          }
        }
      } catch (err: any) {
        if (err instanceof ProtectionClaimIntegrityError) throw err;
      }
    }

    // 2. Check ERC-20 Transfer from Pool to Recipient
    if (
      expectedUsdcAddress &&
      log.address.toLowerCase() === expectedUsdcAddress.toLowerCase()
    ) {
      try {
        const decoded = decodeEventLog({
          abi: erc20TransferEventABI,
          eventName: 'Transfer',
          data: log.data,
          topics: log.topics,
        });

        if (decoded.eventName === 'Transfer') {
          const from = getAddress(decoded.args.from);
          const to = getAddress(decoded.args.to);
          const value = BigInt(decoded.args.value);

          const matchesPool = expectedPoolAddress
            ? from === getAddress(expectedPoolAddress.toLowerCase())
            : true;

          if (matchesPool && to === expectedClientAddr && value === expectedPayoutAmount) {
            usdcTransferVerified = true;
          }
        }
      } catch {
        // Continue searching
      }
    }
  }

  if (!claimPaidFound) {
    throw new ProtectionClaimIntegrityError('No matching ClaimPaid event found in transaction receipt');
  }

  return {
    dealAddress: decodedClaimPaid.deal,
    milestoneId: decodedClaimPaid.milestoneId,
    recipient: decodedClaimPaid.recipient,
    payoutAmount: decodedClaimPaid.payoutAmount,
    usdcTransferVerified,
    poolAddress: expectedPoolAddress ? (getAddress(expectedPoolAddress.toLowerCase()) as `0x${string}`) : undefined,
    blockNumber: BigInt(receipt.blockNumber),
    transactionHash: receipt.transactionHash,
  };
}

