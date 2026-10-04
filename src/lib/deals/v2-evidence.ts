import { getAddress, isAddress, keccak256, stringToBytes } from 'viem';

/**
 * SYNQ CANONICAL EVIDENCE MANIFEST V1
 *
 * Defines the immutable, deterministic evidence manifest schema committed
 * on-chain via submitWork(uint256 milestoneId, bytes32 evidenceRootHash).
 */

export const EVIDENCE_SCHEMA_VERSION = 1 as const;

export const EVIDENCE_LIMITS = {
  MIN_SUMMARY_LENGTH: 1,
  MAX_SUMMARY_LENGTH: 2000,
  MAX_LINKS_COUNT: 20,
  MIN_LINK_VALUE_LENGTH: 1,
  MAX_LINK_VALUE_LENGTH: 500,
  MAX_LINK_LABEL_LENGTH: 100,
  MAX_SERIALIZED_BYTES: 16384, // 16 KB
} as const;

export const VALID_LINK_TYPES = ['pr', 'commit', 'web', 'repository', 'other'] as const;
export type EvidenceLinkType = (typeof VALID_LINK_TYPES)[number];

export interface CanonicalEvidenceLink {
  type: EvidenceLinkType;
  value: string;
  label?: string;
}

export interface CanonicalEvidenceManifestV1 {
  schemaVersion: 1;
  chainId: number;
  dealAddress: `0x${string}`;
  milestoneId: number;
  version: number;
  specHash: `0x${string}`;
  summary: string;
  links: CanonicalEvidenceLink[];
  attachments: [];
}

export class EvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceValidationError';
  }
}

/**
 * Validates and normalizes an evidence link.
 * Preserves user-provided case for URLs and commit identifiers.
 * Normalizes unicode to NFC.
 */
export function normalizeEvidenceLink(link: unknown, index: number): CanonicalEvidenceLink {
  if (!link || typeof link !== 'object') {
    throw new EvidenceValidationError(`Link at index ${index} must be an object`);
  }

  const { type, value, label } = link as Record<string, unknown>;

  if (typeof type !== 'string' || !VALID_LINK_TYPES.includes(type as EvidenceLinkType)) {
    throw new EvidenceValidationError(
      `Link at index ${index} has invalid type: '${String(type)}'. Allowed: ${VALID_LINK_TYPES.join(', ')}`
    );
  }

  if (typeof value !== 'string') {
    throw new EvidenceValidationError(`Link at index ${index} must have a string value`);
  }

  const trimmedValue = value.trim().normalize('NFC');
  if (trimmedValue.length < EVIDENCE_LIMITS.MIN_LINK_VALUE_LENGTH) {
    throw new EvidenceValidationError(`Link at index ${index} value cannot be empty`);
  }
  if (trimmedValue.length > EVIDENCE_LIMITS.MAX_LINK_VALUE_LENGTH) {
    throw new EvidenceValidationError(
      `Link at index ${index} value exceeds maximum length of ${EVIDENCE_LIMITS.MAX_LINK_VALUE_LENGTH} characters`
    );
  }

  // URL format validation for web, pr, repository
  if (type === 'web' || type === 'pr' || type === 'repository') {
    if (!/^https?:\/\/\S+/i.test(trimmedValue)) {
      throw new EvidenceValidationError(
        `Link at index ${index} of type '${type}' must be a valid http:// or https:// URL`
      );
    }
  }

  // Commit validation: non-empty identifier, reasonable length limit (7 to 64 chars)
  if (type === 'commit') {
    if (trimmedValue.length < 4 || trimmedValue.length > 64) {
      throw new EvidenceValidationError(
        `Link at index ${index} of type 'commit' must be between 4 and 64 characters`
      );
    }
  }

  const normalized: CanonicalEvidenceLink = {
    type: type as EvidenceLinkType,
    value: trimmedValue,
  };

  if (typeof label === 'string') {
    const trimmedLabel = label.trim().normalize('NFC');
    if (trimmedLabel.length > 0) {
      if (trimmedLabel.length > EVIDENCE_LIMITS.MAX_LINK_LABEL_LENGTH) {
        throw new EvidenceValidationError(
          `Link at index ${index} label exceeds maximum length of ${EVIDENCE_LIMITS.MAX_LINK_LABEL_LENGTH} characters`
        );
      }
      normalized.label = trimmedLabel;
    }
  }

  return normalized;
}

/**
 * Validates and normalizes the full canonical evidence manifest.
 * Enforces schemaVersion: 1, strict EVM addresses, 32-byte specHash,
 * NFC normalization, bounds, and empty attachments array.
 */
export function normalizeEvidenceManifest(input: unknown): CanonicalEvidenceManifestV1 {
  if (!input || typeof input !== 'object') {
    throw new EvidenceValidationError('Manifest must be a non-null object');
  }

  const raw = input as Record<string, unknown>;

  // 1. Schema version
  if (raw.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw new EvidenceValidationError(
      `Unsupported schemaVersion: ${String(raw.schemaVersion)}. Expected ${EVIDENCE_SCHEMA_VERSION}`
    );
  }

  // 2. Chain ID
  if (typeof raw.chainId !== 'number' || !Number.isInteger(raw.chainId) || raw.chainId <= 0) {
    throw new EvidenceValidationError('chainId must be a positive integer');
  }

  // 3. Deal Address
  if (typeof raw.dealAddress !== 'string' || !isAddress(raw.dealAddress)) {
    throw new EvidenceValidationError('dealAddress must be a valid EVM address');
  }
  const canonicalDealAddress = raw.dealAddress.toLowerCase() as `0x${string}`;

  // 4. Milestone ID
  if (typeof raw.milestoneId !== 'number' || !Number.isInteger(raw.milestoneId) || raw.milestoneId < 0) {
    throw new EvidenceValidationError('milestoneId must be a non-negative integer');
  }

  // 5. Version (Next submission version >= 1)
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
    throw new EvidenceValidationError('version must be a positive integer (>= 1)');
  }

  // 6. Spec Hash
  if (
    typeof raw.specHash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(raw.specHash)
  ) {
    throw new EvidenceValidationError('specHash must be a 32-byte hex string (0x<64 hex>)');
  }
  const canonicalSpecHash = raw.specHash.toLowerCase() as `0x${string}`;

  // 7. Summary
  if (typeof raw.summary !== 'string') {
    throw new EvidenceValidationError('summary must be a string');
  }
  const trimmedSummary = raw.summary.trim().normalize('NFC');
  if (trimmedSummary.length < EVIDENCE_LIMITS.MIN_SUMMARY_LENGTH) {
    throw new EvidenceValidationError('summary cannot be empty');
  }
  if (trimmedSummary.length > EVIDENCE_LIMITS.MAX_SUMMARY_LENGTH) {
    throw new EvidenceValidationError(
      `summary exceeds maximum length of ${EVIDENCE_LIMITS.MAX_SUMMARY_LENGTH} characters`
    );
  }

  // 8. Links
  if (!Array.isArray(raw.links)) {
    throw new EvidenceValidationError('links must be an array');
  }
  if (raw.links.length > EVIDENCE_LIMITS.MAX_LINKS_COUNT) {
    throw new EvidenceValidationError(
      `links cannot exceed ${EVIDENCE_LIMITS.MAX_LINKS_COUNT} items`
    );
  }
  const normalizedLinks: CanonicalEvidenceLink[] = raw.links.map((link, idx) =>
    normalizeEvidenceLink(link, idx)
  );

  // 9. Attachments
  if (!Array.isArray(raw.attachments) || raw.attachments.length !== 0) {
    throw new EvidenceValidationError(
      'attachments must be an empty array for schemaVersion 1'
    );
  }

  const normalizedManifest: CanonicalEvidenceManifestV1 = {
    schemaVersion: 1,
    chainId: raw.chainId,
    dealAddress: canonicalDealAddress,
    milestoneId: raw.milestoneId,
    version: raw.version,
    specHash: canonicalSpecHash,
    summary: trimmedSummary,
    links: normalizedLinks,
    attachments: [],
  };

  // 10. Check serialized length bounds
  const serialized = canonicalizeEvidenceManifest(normalizedManifest);
  const byteLength = new TextEncoder().encode(serialized).length;
  if (byteLength > EVIDENCE_LIMITS.MAX_SERIALIZED_BYTES) {
    throw new EvidenceValidationError(
      `Serialized manifest size (${byteLength} bytes) exceeds maximum limit of ${EVIDENCE_LIMITS.MAX_SERIALIZED_BYTES} bytes`
    );
  }

  return normalizedManifest;
}

/**
 * Recursively canonicalizes an arbitrary value according to RFC 8785 (JSON Canonicalization Scheme / JCS):
 * - Object keys sorted lexicographically by Unicode code point (UTF-16 code units)
 * - Array element order preserved
 * - Undefined object values omitted
 * - Numbers serialized as finite JSON integers/numbers
 * - Strings JSON-escaped
 * - No whitespace between tokens
 */
export function canonicalizeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  const type = typeof value;

  if (type === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new EvidenceValidationError('Non-finite numbers cannot be canonicalized');
    }
    return JSON.stringify(value);
  }

  if (type === 'string') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const elements = value.map((elem) => {
      if (elem === undefined || typeof elem === 'symbol' || typeof elem === 'function') {
        return 'null';
      }
      return canonicalizeValue(elem);
    });
    return `[${elements.join(',')}]`;
  }

  if (type === 'object') {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined && typeof obj[k] !== 'symbol' && typeof obj[k] !== 'function')
      .sort();

    const pairs = sortedKeys.map((key) => {
      return `${JSON.stringify(key)}:${canonicalizeValue(obj[key])}`;
    });

    return `{${pairs.join(',')}}`;
  }

  throw new EvidenceValidationError(`Unsupported value type: ${type}`);
}

/**
 * Deterministically serializes a normalized CanonicalEvidenceManifestV1 to UTF-8 JSON.
 */
export function canonicalizeEvidenceManifest(manifest: CanonicalEvidenceManifestV1): string {
  return canonicalizeValue(manifest);
}

/**
 * Computes the 32-byte cryptographic evidenceRootHash for a manifest:
 * keccak256(UTF-8(canonicalizeEvidenceManifest(normalizeEvidenceManifest(manifest))))
 *
 * Always returns a lowercase 0x<64-hex> string.
 */
export function hashEvidenceManifest(manifestInput: unknown): `0x${string}` {
  const normalized = normalizeEvidenceManifest(manifestInput);
  const serialized = canonicalizeEvidenceManifest(normalized);
  const utf8Bytes = stringToBytes(serialized);
  return keccak256(utf8Bytes).toLowerCase() as `0x${string}`;
}
