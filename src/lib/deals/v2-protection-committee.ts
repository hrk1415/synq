/**
 * Synq Premium Protection Committee Cryptographic & Decision Layer (Phase 3D.1)
 *
 * Implements pure EIP-712 typed-data definitions, deterministic decision report hashing,
 * signature recovery, and threshold bundle construction for SynqProtectionCommittee.sol.
 */

import {
  isAddress,
  getAddress,
  keccak256,
  stringToBytes,
  encodeAbiParameters,
  parseAbiParameters,
  hashTypedData,
  recoverTypedDataAddress,
  decodeEventLog,
} from 'viem';
import { canonicalizeValue } from '@/lib/deals/v2-evidence';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';

// ---------------------------------------------------------------------------
// Constants & Deployed Contracts
// ---------------------------------------------------------------------------

export const PROTECTION_COMMITTEE_EIP712_NAME = 'SynqProtectionCommittee' as const;
export const PROTECTION_COMMITTEE_EIP712_VERSION = '1' as const;

export const CANONICAL_PROTECTION_COMMITTEE_SEPOLIA: `0x${string}` =
  '0x8e77aFf09Dd37EEa35d2931Ac1aA624abBF94e12';

export const CANONICAL_PROTECTION_MANAGER_V1_1_SEPOLIA: `0x${string}` =
  '0x462D1b8c1047d05FbE61e15809f4E6A26B12ED00';

export const CANONICAL_PROTECTION_POOL_SEPOLIA: `0x${string}` =
  '0xA1f4991597869ba11EbD94edED4d69960063cbc2';

export const PROTECTION_COMMITTEE_THRESHOLD = 2 as const;
export const DEFAULT_PROTECTION_DECISION_EXPIRATION_SECONDS = 7n * 86400n; // 7 days

export const UINT64_MAX = 18446744073709551615n;

// ---------------------------------------------------------------------------
// Enums & Structs
// ---------------------------------------------------------------------------

export enum ProtectionCommitteeDecision {
  None = 0,
  Approve = 1,
  Reject = 2,
}

export type ProtectionDecisionString = 'APPROVE' | 'REJECT';

export function parseProtectionDecision(input: unknown): ProtectionCommitteeDecision {
  if (input === undefined || input === null) {
    throw new ProtectionDecisionValidationError('Decision is required (APPROVE or REJECT)');
  }
  if (input === 1 || input === '1' || String(input).trim().toUpperCase() === 'APPROVE') {
    return ProtectionCommitteeDecision.Approve;
  }
  if (input === 2 || input === '2' || String(input).trim().toUpperCase() === 'REJECT') {
    return ProtectionCommitteeDecision.Reject;
  }
  throw new ProtectionDecisionValidationError(
    `Invalid decision: "${input}". Must be APPROVE (1) or REJECT (2).`
  );
}

export interface ProtectionClaimDecisionAuthData {
  committee: `0x${string}`;
  chainId: bigint;
  manager: `0x${string}`;
  deal: `0x${string}`;
  milestoneId: bigint;
  decision: number; // 1 = Approve, 2 = Reject
  decisionReportHash: `0x${string}`;
  decisionNonce: bigint;
  validUntil: bigint;
}

export const PROTECTION_CLAIM_DECISION_PRIMARY_TYPE = 'ProtectionClaimDecisionAuth' as const;

export const PROTECTION_CLAIM_DECISION_AUTH_TYPES = {
  ProtectionClaimDecisionAuth: [
    { name: 'committee', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'manager', type: 'address' },
    { name: 'deal', type: 'address' },
    { name: 'milestoneId', type: 'uint256' },
    { name: 'decision', type: 'uint8' },
    { name: 'decisionReportHash', type: 'bytes32' },
    { name: 'decisionNonce', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
  ],
} as const;

export const PROTECTION_CLAIM_DECISION_TYPEHASH = keccak256(
  stringToBytes(
    'ProtectionClaimDecisionAuth(address committee,uint256 chainId,address manager,address deal,uint256 milestoneId,uint8 decision,bytes32 decisionReportHash,uint64 decisionNonce,uint64 validUntil)'
  )
);

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

export class ProtectionDecisionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectionDecisionValidationError';
  }
}

export class ProtectionDecisionAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectionDecisionAuthError';
  }
}

export class ProtectionDecisionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectionDecisionIntegrityError';
  }
}

export class ProtectionDecisionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectionDecisionExpiredError';
  }
}

// ---------------------------------------------------------------------------
// Canonical Decision Report Representation & Hashing
// ---------------------------------------------------------------------------

export const PROTECTION_DECISION_REPORT_SCHEMA_VERSION = 1 as const;

export const DECISION_REPORT_LIMITS = {
  MIN_RATIONALE_LENGTH: 1,
  MAX_RATIONALE_LENGTH: 4000,
  MAX_SERIALIZED_BYTES: 16384, // 16 KB
} as const;

export interface CanonicalProtectionDecisionReportV1 {
  schemaVersion: 1;
  chainId: number;
  committeeAddress: `0x${string}`;
  managerAddress: `0x${string}`;
  dealAddress: `0x${string}`;
  milestoneId: number;
  claimEvidenceHash: `0x${string}`;
  decision: ProtectionDecisionString;
  rationale: string;
  authorSigner: `0x${string}`;
}

export function normalizeProtectionDecisionReport(input: unknown): CanonicalProtectionDecisionReportV1 {
  if (!input || typeof input !== 'object') {
    throw new ProtectionDecisionValidationError('Decision report must be a non-null object');
  }

  const raw = input as Record<string, unknown>;

  if (raw.schemaVersion !== 1) {
    throw new ProtectionDecisionValidationError('schemaVersion must strictly be 1');
  }

  if (typeof raw.chainId !== 'number' || !Number.isInteger(raw.chainId) || raw.chainId <= 0) {
    throw new ProtectionDecisionValidationError('chainId must be a positive integer');
  }

  if (typeof raw.committeeAddress !== 'string' || !isAddress(raw.committeeAddress)) {
    throw new ProtectionDecisionValidationError('committeeAddress must be a valid EVM address');
  }
  const canonicalCommittee = getAddress(raw.committeeAddress.toLowerCase());

  if (typeof raw.managerAddress !== 'string' || !isAddress(raw.managerAddress)) {
    throw new ProtectionDecisionValidationError('managerAddress must be a valid EVM address');
  }
  const canonicalManager = getAddress(raw.managerAddress.toLowerCase());

  if (typeof raw.dealAddress !== 'string' || !isAddress(raw.dealAddress)) {
    throw new ProtectionDecisionValidationError('dealAddress must be a valid EVM address');
  }
  const canonicalDeal = getAddress(raw.dealAddress.toLowerCase());

  if (
    typeof raw.milestoneId !== 'number' ||
    !Number.isInteger(raw.milestoneId) ||
    raw.milestoneId < 0 ||
    raw.milestoneId >= 16
  ) {
    throw new ProtectionDecisionValidationError('milestoneId must be an integer between 0 and 15');
  }

  if (
    typeof raw.claimEvidenceHash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(raw.claimEvidenceHash)
  ) {
    throw new ProtectionDecisionValidationError(
      'claimEvidenceHash must be a 32-byte hex string (0x<64 hex>)'
    );
  }
  const canonicalClaimEvidenceHash = raw.claimEvidenceHash.toLowerCase() as `0x${string}`;

  const decisionEnum = parseProtectionDecision(raw.decision);
  const decisionStr: ProtectionDecisionString =
    decisionEnum === ProtectionCommitteeDecision.Approve ? 'APPROVE' : 'REJECT';

  if (typeof raw.rationale !== 'string') {
    throw new ProtectionDecisionValidationError('rationale must be a string');
  }
  const trimmedRationale = raw.rationale.trim().normalize('NFC');
  if (trimmedRationale.length < DECISION_REPORT_LIMITS.MIN_RATIONALE_LENGTH) {
    throw new ProtectionDecisionValidationError('rationale cannot be empty');
  }
  if (trimmedRationale.length > DECISION_REPORT_LIMITS.MAX_RATIONALE_LENGTH) {
    throw new ProtectionDecisionValidationError(
      `rationale exceeds maximum length of ${DECISION_REPORT_LIMITS.MAX_RATIONALE_LENGTH} characters`
    );
  }

  if (typeof raw.authorSigner !== 'string' || !isAddress(raw.authorSigner)) {
    throw new ProtectionDecisionValidationError('authorSigner must be a valid EVM address');
  }
  const canonicalAuthor = getAddress(raw.authorSigner.toLowerCase());

  const normalized: CanonicalProtectionDecisionReportV1 = {
    schemaVersion: 1,
    chainId: raw.chainId,
    committeeAddress: canonicalCommittee,
    managerAddress: canonicalManager,
    dealAddress: canonicalDeal,
    milestoneId: raw.milestoneId,
    claimEvidenceHash: canonicalClaimEvidenceHash,
    decision: decisionStr,
    rationale: trimmedRationale,
    authorSigner: canonicalAuthor,
  };

  const serialized = canonicalizeValue(normalized);
  const serializedBytes = stringToBytes(serialized).length;
  if (serializedBytes > DECISION_REPORT_LIMITS.MAX_SERIALIZED_BYTES) {
    throw new ProtectionDecisionValidationError(
      `Serialized decision report byte length (${serializedBytes}) exceeds maximum of ${DECISION_REPORT_LIMITS.MAX_SERIALIZED_BYTES} bytes`
    );
  }

  return normalized;
}

export function canonicalizeProtectionDecisionReport(
  report: CanonicalProtectionDecisionReportV1
): string {
  return canonicalizeValue(report);
}

export function hashProtectionDecisionReport(reportInput: unknown): `0x${string}` {
  const normalized = normalizeProtectionDecisionReport(reportInput);
  const serialized = canonicalizeProtectionDecisionReport(normalized);
  const utf8Bytes = stringToBytes(serialized);
  return keccak256(utf8Bytes).toLowerCase() as `0x${string}`;
}

// ---------------------------------------------------------------------------
// EIP-712 Typed Data & Signature Operations
// ---------------------------------------------------------------------------

export function getProtectionClaimDecisionDomain(params: {
  committeeAddress: `0x${string}`;
  chainId?: number;
}) {
  return {
    name: PROTECTION_COMMITTEE_EIP712_NAME,
    version: PROTECTION_COMMITTEE_EIP712_VERSION,
    chainId: BigInt(params.chainId ?? SEPOLIA_CHAIN_ID),
    verifyingContract: getAddress(params.committeeAddress),
  } as const;
}

export function getProtectionClaimDecisionTypedData(params: {
  auth: ProtectionClaimDecisionAuthData;
}) {
  const domain = getProtectionClaimDecisionDomain({
    committeeAddress: params.auth.committee,
    chainId: Number(params.auth.chainId),
  });

  return {
    domain,
    types: PROTECTION_CLAIM_DECISION_AUTH_TYPES,
    primaryType: PROTECTION_CLAIM_DECISION_PRIMARY_TYPE,
    message: {
      committee: getAddress(params.auth.committee),
      chainId: BigInt(params.auth.chainId),
      manager: getAddress(params.auth.manager),
      deal: getAddress(params.auth.deal),
      milestoneId: BigInt(params.auth.milestoneId),
      decision: Number(params.auth.decision),
      decisionReportHash: params.auth.decisionReportHash.toLowerCase() as `0x${string}`,
      decisionNonce: BigInt(params.auth.decisionNonce),
      validUntil: BigInt(params.auth.validUntil),
    },
  } as const;
}

/**
 * Deterministically converts an EIP-712 typed data object into a JSON-safe representation.
 * - Converts large integer values in message (chainId, milestoneId, decisionNonce, validUntil) to exact decimal strings.
 * - Converts domain.chainId to safe JavaScript number (compatible with Viem's getTypesForEIP712Domain and TypedDataDomain).
 * - Preserves all EIP-712 field names, types, primaryType, and hex values exactly.
 */
export function serializeProtectionDecisionTypedDataForJson<
  T extends {
    domain: { name: string; version: string; chainId: number | bigint; verifyingContract: `0x${string}` };
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }
>(typedData: T) {
  const serializedMessage: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(typedData.message)) {
    if (typeof value === 'bigint') {
      serializedMessage[key] = value.toString();
    } else {
      serializedMessage[key] = value;
    }
  }

  return {
    domain: {
      name: typedData.domain.name,
      version: typedData.domain.version,
      chainId: Number(typedData.domain.chainId),
      verifyingContract: typedData.domain.verifyingContract,
    },
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: serializedMessage,
  };
}

export function hashProtectionClaimDecisionAuth(
  auth: ProtectionClaimDecisionAuthData
): `0x${string}` {
  const typedData = getProtectionClaimDecisionTypedData({ auth });
  return hashTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });
}

/**
 * Recovers the signer address from an EIP-712 signature against ProtectionClaimDecisionAuth.
 */
export async function recoverProtectionDecisionSigner(params: {
  auth: ProtectionClaimDecisionAuthData;
  signature: `0x${string}`;
}): Promise<`0x${string}`> {
  const typedData = getProtectionClaimDecisionTypedData({ auth: params.auth });
  const recovered = await recoverTypedDataAddress({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
    signature: params.signature,
  });
  return getAddress(recovered.toLowerCase());
}

export interface VerifiedProtectionThresholdBundle {
  auth: ProtectionClaimDecisionAuthData;
  signatures: [`0x${string}`, `0x${string}`];
  signers: [`0x${string}`, `0x${string}`];
}

/**
 * Validates two signatures for 2-of-3 committee consensus.
 * Enforces:
 * - Both signatures are valid
 * - Signers are distinct (s1 !== s2)
 * - Signers are members of authorizedSigners set (or on-chain isSigner)
 * - validUntil has not elapsed
 * - Nonce within uint64 bounds
 */
export async function verifyProtectionThresholdBundle(params: {
  auth: ProtectionClaimDecisionAuthData;
  signatures: [`0x${string}`, `0x${string}`];
  authorizedSigners?: readonly `0x${string}`[];
  currentTimestampSeconds?: bigint;
}): Promise<VerifiedProtectionThresholdBundle> {
  const { auth, signatures, authorizedSigners } = params;

  if (!signatures || signatures.length !== 2) {
    throw new ProtectionDecisionValidationError('Exactly two committee signatures are required');
  }

  const [sig1, sig2] = signatures;
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig1) || !/^0x[0-9a-fA-F]{130}$/.test(sig2)) {
    throw new ProtectionDecisionValidationError('Invalid signature format (must be 65-byte hex)');
  }

  // Nonce validation
  if (auth.decisionNonce < 0n || auth.decisionNonce > UINT64_MAX) {
    throw new ProtectionDecisionValidationError('decisionNonce exceeds uint64 bounds');
  }

  // Expiration validation
  if (auth.validUntil < 0n || auth.validUntil > UINT64_MAX) {
    throw new ProtectionDecisionValidationError('validUntil exceeds uint64 bounds');
  }
  const now = params.currentTimestampSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  if (now > auth.validUntil) {
    throw new ProtectionDecisionExpiredError(
      `Authorization expired at timestamp ${auth.validUntil} (current: ${now})`
    );
  }

  // Decision enum validation
  if (
    auth.decision !== ProtectionCommitteeDecision.Approve &&
    auth.decision !== ProtectionCommitteeDecision.Reject
  ) {
    throw new ProtectionDecisionValidationError(
      `Invalid decision value: ${auth.decision}. Must be 1 (Approve) or 2 (Reject).`
    );
  }

  // Signature recovery
  const s1 = await recoverProtectionDecisionSigner({ auth, signature: sig1 });
  const s2 = await recoverProtectionDecisionSigner({ auth, signature: sig2 });

  if (s1.toLowerCase() === s2.toLowerCase()) {
    throw new ProtectionDecisionAuthError('Duplicate signer signature: both signatures from same wallet');
  }

  if (authorizedSigners && authorizedSigners.length > 0) {
    const authSet = new Set(authorizedSigners.map((s) => s.toLowerCase()));
    if (!authSet.has(s1.toLowerCase())) {
      throw new ProtectionDecisionAuthError(`Signer 1 (${s1}) is not in the authorized committee set`);
    }
    if (!authSet.has(s2.toLowerCase())) {
      throw new ProtectionDecisionAuthError(`Signer 2 (${s2}) is not in the authorized committee set`);
    }
  }

  return {
    auth,
    signatures: [sig1, sig2],
    signers: [s1, s2],
  };
}

/**
 * Deterministically converts a VerifiedProtectionThresholdBundle into a JSON-safe representation.
 * - Converts large integer values in auth (chainId, milestoneId, decisionNonce, validUntil) to exact decimal strings.
 * - Preserves all signature and signer values exactly.
 */
export function serializeProtectionThresholdBundleForJson<
  T extends {
    auth: {
      committee: `0x${string}`;
      chainId: bigint | number | string;
      manager: `0x${string}`;
      deal: `0x${string}`;
      milestoneId: bigint | number | string;
      decision: number;
      decisionReportHash: `0x${string}`;
      decisionNonce: bigint | number | string;
      validUntil: bigint | number | string;
    };
    signatures: [`0x${string}`, `0x${string}`];
    signers: [`0x${string}`, `0x${string}`];
  }
>(bundle: T) {
  return {
    auth: {
      committee: bundle.auth.committee,
      chainId: bundle.auth.chainId.toString(),
      manager: bundle.auth.manager,
      deal: bundle.auth.deal,
      milestoneId: bundle.auth.milestoneId.toString(),
      decision: Number(bundle.auth.decision),
      decisionReportHash: bundle.auth.decisionReportHash,
      decisionNonce: bundle.auth.decisionNonce.toString(),
      validUntil: bundle.auth.validUntil.toString(),
    },
    signatures: bundle.signatures,
    signers: bundle.signers,
  };
}

// ---------------------------------------------------------------------------
// Transaction Formatting & ABI
// ---------------------------------------------------------------------------

export const synqProtectionCommitteeFullABI = [
  {
    inputs: [
      {
        components: [
          { name: 'committee', type: 'address' },
          { name: 'chainId', type: 'uint256' },
          { name: 'manager', type: 'address' },
          { name: 'deal', type: 'address' },
          { name: 'milestoneId', type: 'uint256' },
          { name: 'decision', type: 'uint8' },
          { name: 'decisionReportHash', type: 'bytes32' },
          { name: 'decisionNonce', type: 'uint64' },
          { name: 'validUntil', type: 'uint64' },
        ],
        name: 'auth',
        type: 'tuple',
      },
      { name: 'sig1', type: 'bytes' },
      { name: 'sig2', type: 'bytes' },
    ],
    name: 'submitClaimDecision',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: '', type: 'address' }],
    name: 'isSigner',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: '', type: 'bytes32' }],
    name: 'usedDecisionNonces',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: '', type: 'uint256' }],
    name: 'signers',
    outputs: [{ name: '', type: 'address' }],
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
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'manager', type: 'address' },
      { indexed: true, name: 'deal', type: 'address' },
      { indexed: true, name: 'milestoneId', type: 'uint256' },
      { indexed: false, name: 'decision', type: 'uint8' },
      { indexed: false, name: 'decisionReportHash', type: 'bytes32' },
      { indexed: false, name: 'decisionNonce', type: 'uint64' },
    ],
    name: 'ClaimDecisionSubmitted',
    type: 'event',
  },
] as const;

export function formatSubmitClaimDecisionTx(params: {
  committeeAddress: `0x${string}`;
  auth: ProtectionClaimDecisionAuthData;
  sig1: `0x${string}`;
  sig2: `0x${string}`;
}) {
  return {
    address: getAddress(params.committeeAddress),
    abi: synqProtectionCommitteeFullABI,
    functionName: 'submitClaimDecision',
    args: [
      {
        committee: getAddress(params.auth.committee),
        chainId: BigInt(params.auth.chainId),
        manager: getAddress(params.auth.manager),
        deal: getAddress(params.auth.deal),
        milestoneId: BigInt(params.auth.milestoneId),
        decision: Number(params.auth.decision),
        decisionReportHash: params.auth.decisionReportHash.toLowerCase() as `0x${string}`,
        decisionNonce: BigInt(params.auth.decisionNonce),
        validUntil: BigInt(params.auth.validUntil),
      },
      params.sig1,
      params.sig2,
    ],
  } as const;
}

export function computeDecisionNonceKey(params: {
  manager: string;
  deal: string;
  milestoneId: number | bigint;
  decisionNonce: number | bigint;
}): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters('address, address, uint256, uint64'),
      [
        getAddress(params.manager),
        getAddress(params.deal),
        BigInt(params.milestoneId),
        BigInt(params.decisionNonce),
      ]
    )
  ).toLowerCase() as `0x${string}`;
}

export interface VerifiedClaimDecisionSubmittedReceipt {
  managerAddress: `0x${string}`;
  dealAddress: `0x${string}`;
  milestoneId: number;
  decision: number;
  decisionReportHash: `0x${string}`;
  decisionNonce: bigint;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
}

export function verifyClaimDecisionSubmittedReceipt(params: {
  receipt: any;
  expectedCommitteeAddress: string;
  expectedDealAddress: string;
  expectedMilestoneId: number;
}): VerifiedClaimDecisionSubmittedReceipt {
  const { receipt, expectedCommitteeAddress, expectedDealAddress, expectedMilestoneId } = params;

  if (!receipt || receipt.status !== 'success') {
    throw new ProtectionDecisionIntegrityError('Transaction failed or receipt status is not success');
  }

  const expectedCommittee = getAddress(expectedCommitteeAddress.toLowerCase());
  const expectedDeal = getAddress(expectedDealAddress.toLowerCase());

  for (const log of receipt.logs || []) {
    if (log.address && getAddress(log.address) !== expectedCommittee) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: synqProtectionCommitteeFullABI,
        eventName: 'ClaimDecisionSubmitted',
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === 'ClaimDecisionSubmitted') {
        const deal = getAddress(decoded.args.deal);
        const milestoneId = Number(decoded.args.milestoneId);

        if (deal === expectedDeal && milestoneId === expectedMilestoneId) {
          return {
            managerAddress: getAddress(decoded.args.manager),
            dealAddress: deal,
            milestoneId,
            decision: Number(decoded.args.decision),
            decisionReportHash: (decoded.args.decisionReportHash as string).toLowerCase() as `0x${string}`,
            decisionNonce: BigInt(decoded.args.decisionNonce),
            blockNumber: BigInt(receipt.blockNumber),
            transactionHash: (receipt.transactionHash as string).toLowerCase() as `0x${string}`,
          };
        }
      }
    } catch {
      // Continue checking other logs
    }
  }

  throw new ProtectionDecisionIntegrityError(
    `ClaimDecisionSubmitted event for deal ${expectedDeal} milestone ${expectedMilestoneId} not found in receipt`
  );
}
