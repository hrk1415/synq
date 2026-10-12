/**
 * Synq Standard V2 Integration Foundation
 *
 * Canonical TypeScript logic for:
 * - EIP-712 Domain and Type definitions
 * - MilestoneInit hashing parity: keccak256(abi.encode(MilestoneInit[]))
 * - EIP-712 DealProposal hashing (proposalId derivation)
 * - Pure cryptographic signature recovery and verification
 * - Proposal builder and protocol validation rules
 * - Safe 6-decimal USDC integer conversions (no floats)
 *
 * Sourced directly from deployed contracts/v1/SynqFactoryV2.sol and contracts/v1/SynqDealV1.sol.
 */

import { encodeAbiParameters, hashTypedData, isAddress, keccak256, recoverTypedDataAddress, toHex, type TypedDataDomain } from 'viem';
import { SYNQ_V2_SEPOLIA_CONFIG } from '@/lib/contracts/addresses';
import {
  type DealProposalV2,
  type StandardV2MilestoneInit,
  type StandardV2MilestoneInput,
  type StandardV2ProposalCreationParams,
} from '@/types/deal-v2';

export { SYNQ_V2_SEPOLIA_CONFIG };

/**
 * Hashes a human-readable milestone specification into its canonical 32-byte specHash.
 * Uses keccak256(toHex(trimmedText)).
 */
export function hashMilestoneSpec(specText: string): `0x${string}` {
  const trimmed = (specText || '').trim();
  if (!trimmed) {
    throw new Error('Milestone specification text cannot be empty');
  }
  return keccak256(toHex(trimmed));
}

// --- Constants ---
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
export const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

export const MIN_REVIEW_WINDOW_SECONDS = 3600n; // 1 hour (SynqDealV1 protocol invariant)
export const MAX_REVIEW_WINDOW_SECONDS = 2592000n; // 30 days (SynqDealV1 protocol invariant)

// --- EIP-712 Specifications ---

/**
 * Returns the canonical EIP-712 domain for SynqFactoryV2.
 * Defaults to Ethereum Sepolia live deployment.
 */
export function getStandardV2Eip712Domain(
  chainId: number = SYNQ_V2_SEPOLIA_CONFIG.chainId,
  verifyingContract: `0x${string}` = SYNQ_V2_SEPOLIA_CONFIG.factory
) {
  return {
    name: SYNQ_V2_SEPOLIA_CONFIG.eip712DomainName,
    version: SYNQ_V2_SEPOLIA_CONFIG.eip712DomainVersion,
    chainId,
    verifyingContract,
  } as const;
}

/**
 * Exact EIP-712 DealProposal typed-data schema.
 * Matches DEAL_PROPOSAL_TYPEHASH in SynqFactoryV2.sol line 28-30:
 * "DealProposal(address client,address freelancer,address canonicalUsdc,address dealImplementation,address primaryResolver,address emergencyResolver,bytes32 milestonesHash,bool isProtected,address protectionModule,bytes32 policyId,uint256 proposalNonce,uint256 expiry)"
 */
export const DEAL_PROPOSAL_EIP712_TYPES = {
  DealProposal: [
    { name: 'client', type: 'address' },
    { name: 'freelancer', type: 'address' },
    { name: 'canonicalUsdc', type: 'address' },
    { name: 'dealImplementation', type: 'address' },
    { name: 'primaryResolver', type: 'address' },
    { name: 'emergencyResolver', type: 'address' },
    { name: 'milestonesHash', type: 'bytes32' },
    { name: 'isProtected', type: 'bool' },
    { name: 'protectionModule', type: 'address' },
    { name: 'policyId', type: 'bytes32' },
    { name: 'proposalNonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
  ],
} as const;

// --- Safe USDC Formatting & Parsing (Strict 6-decimal integer logic) ---

/**
 * Converts a human USDC string (e.g. "1.25" or "100") to 6-decimal base units (bigint).
 * Rejects negatives, NaN, scientific notation, empty strings, and >6 decimal places.
 * NEVER uses floating-point arithmetic.
 */
export function parseUsdcAmount(amount: string): bigint {
  if (typeof amount !== 'string') {
    throw new Error('USDC amount must be a string');
  }
  const trimmed = amount.trim();
  if (!trimmed) {
    throw new Error('USDC amount cannot be empty');
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid USDC amount format: "${trimmed}"`);
  }
  const [wholePart, fractionPart = ''] = trimmed.split('.');
  if (fractionPart.length > 6) {
    throw new Error(`USDC amount cannot exceed 6 decimal places (received ${fractionPart.length})`);
  }
  const paddedFraction = fractionPart.padEnd(6, '0');
  return BigInt(wholePart) * 1_000_000n + BigInt(paddedFraction);
}

/**
 * Converts 6-decimal USDC base units (bigint) to a clean human-readable string.
 * e.g. 1000000n -> "1", 1250000n -> "1.25".
 */
export function formatUsdcAmount(baseUnits: bigint | number | string): string {
  const b = typeof baseUnits === 'bigint' ? baseUnits : BigInt(String(baseUnits).trim());
  if (b < 0n) {
    throw new Error('USDC amount cannot be negative');
  }
  const wholePart = b / 1_000_000n;
  const fractionPart = b % 1_000_000n;
  if (fractionPart === 0n) {
    return wholePart.toString();
  }
  const fractionString = fractionPart.toString().padStart(6, '0').replace(/0+$/, '');
  return `${wholePart}.${fractionString}`;
}

// --- Milestone Struct Normalization & Hashing ---

/**
 * Normalizes input milestones into the exact StandardV2MilestoneInit representation.
 */
export function normalizeMilestoneInits(
  milestones: readonly (StandardV2MilestoneInput | StandardV2MilestoneInit)[]
): StandardV2MilestoneInit[] {
  if (!Array.isArray(milestones) || milestones.length === 0) {
    throw new Error('Milestones array must not be empty');
  }

  return milestones.map((m, index) => {
    let specHash = String(m.specHash || '').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(specHash)) {
      throw new Error(`Milestone [${index}] specHash must be a valid 32-byte hex string (0x-prefixed 64 hex chars)`);
    }

    const amount = BigInt(m.amount);
    const workDeadline = BigInt(m.workDeadline);
    const reviewWindow = BigInt(m.reviewWindow);
    const gracePeriod = BigInt(m.gracePeriod);

    if (amount <= 0n) {
      throw new Error(`Milestone [${index}] amount must be greater than zero`);
    }

    return {
      amount,
      workDeadline,
      reviewWindow,
      gracePeriod,
      specHash: specHash.toLowerCase() as `0x${string}`,
    };
  });
}

/**
 * Computes milestonesHash matching Solidity SynqFactoryV2.hashMilestones:
 * keccak256(abi.encode(MilestoneInit[]))
 * where MilestoneInit is tuple(uint256 amount,uint64 workDeadline,uint64 reviewWindow,uint64 gracePeriod,bytes32 specHash)
 */
export function hashStandardV2Milestones(
  milestones: readonly (StandardV2MilestoneInput | StandardV2MilestoneInit)[]
): `0x${string}` {
  const inits = normalizeMilestoneInits(milestones);

  const encoded = encodeAbiParameters(
    [
      {
        type: 'tuple[]',
        components: [
          { name: 'amount', type: 'uint256' },
          { name: 'workDeadline', type: 'uint64' },
          { name: 'reviewWindow', type: 'uint64' },
          { name: 'gracePeriod', type: 'uint64' },
          { name: 'specHash', type: 'bytes32' },
        ],
      },
    ],
    [
      inits.map((m) => ({
        amount: m.amount,
        workDeadline: m.workDeadline,
        reviewWindow: m.reviewWindow,
        gracePeriod: m.gracePeriod,
        specHash: m.specHash,
      })),
    ]
  );

  return keccak256(encoded);
}

// --- Proposal Hashing & Signer Verification ---

/**
 * Computes the EIP-712 proposalId digest matching SynqFactoryV2.hashDealProposal(proposal).
 */
export function hashDealProposalV2(
  proposal: DealProposalV2,
  domain: TypedDataDomain = getStandardV2Eip712Domain()
): `0x${string}` {
  return hashTypedData({
    domain,
    types: DEAL_PROPOSAL_EIP712_TYPES,
    primaryType: 'DealProposal',
    message: {
      client: proposal.client,
      freelancer: proposal.freelancer,
      canonicalUsdc: proposal.canonicalUsdc,
      dealImplementation: proposal.dealImplementation,
      primaryResolver: proposal.primaryResolver,
      emergencyResolver: proposal.emergencyResolver,
      milestonesHash: proposal.milestonesHash,
      isProtected: proposal.isProtected,
      protectionModule: proposal.protectionModule,
      policyId: proposal.policyId,
      proposalNonce: BigInt(proposal.proposalNonce),
      expiry: BigInt(proposal.expiry),
    },
  });
}

/**
 * Recovers the public Ethereum address of the signer of an EIP-712 DealProposal.
 * Uses pure cryptographic ECDSA recovery (matches OpenZeppelin ECDSA.recover in SynqFactoryV2).
 * Note: Contract wallet verification (EIP-1271) is not implemented on Factory V2; EOA signatures only.
 */
export async function recoverDealProposalSigner(
  proposal: DealProposalV2,
  signature: `0x${string}`,
  domain: TypedDataDomain = getStandardV2Eip712Domain()
): Promise<`0x${string}`> {
  return recoverTypedDataAddress({
    domain,
    types: DEAL_PROPOSAL_EIP712_TYPES,
    primaryType: 'DealProposal',
    message: {
      client: proposal.client,
      freelancer: proposal.freelancer,
      canonicalUsdc: proposal.canonicalUsdc,
      dealImplementation: proposal.dealImplementation,
      primaryResolver: proposal.primaryResolver,
      emergencyResolver: proposal.emergencyResolver,
      milestonesHash: proposal.milestonesHash,
      isProtected: proposal.isProtected,
      protectionModule: proposal.protectionModule,
      policyId: proposal.policyId,
      proposalNonce: BigInt(proposal.proposalNonce),
      expiry: BigInt(proposal.expiry),
    },
    signature,
  });
}

/**
 * Validates that the signature over the DealProposal recovers exactly proposal.client.
 */
export async function verifyDealProposalSignature(
  proposal: DealProposalV2,
  signature: `0x${string}`,
  domain: TypedDataDomain = getStandardV2Eip712Domain()
): Promise<boolean> {
  try {
    const signer = await recoverDealProposalSigner(proposal, signature, domain);
    return signer.toLowerCase() === proposal.client.toLowerCase();
  } catch {
    return false;
  }
}

// --- Validation Rules ---

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Protocol Validation Rules:
 * Enforces strict on-chain invariants required by SynqFactoryV2 and SynqDealV1.
 */
export function validateStandardV2ProtocolRules(
  proposal: DealProposalV2,
  milestones: readonly StandardV2MilestoneInit[]
): ValidationResult {
  const errors: string[] = [];

  // 1. Participant Addresses
  if (!isAddress(proposal.client) || proposal.client.toLowerCase() === ZERO_ADDRESS) {
    errors.push('Client address must be a valid non-zero EVM address');
  }
  if (!isAddress(proposal.freelancer) || proposal.freelancer.toLowerCase() === ZERO_ADDRESS) {
    errors.push('Freelancer address must be a valid non-zero EVM address');
  }
  if (
    isAddress(proposal.client) &&
    isAddress(proposal.freelancer) &&
    proposal.client.toLowerCase() === proposal.freelancer.toLowerCase()
  ) {
    errors.push('Client and Freelancer must be distinct addresses (self-deals not allowed)');
  }

  // 2. Canonical Contracts Binding
  if (proposal.canonicalUsdc.toLowerCase() !== SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc.toLowerCase()) {
    errors.push(`Canonical USDC must match configured address: ${SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc}`);
  }
  if (proposal.dealImplementation.toLowerCase() !== SYNQ_V2_SEPOLIA_CONFIG.dealImplementation.toLowerCase()) {
    errors.push(`Deal implementation must match configured address: ${SYNQ_V2_SEPOLIA_CONFIG.dealImplementation}`);
  }
  if (proposal.primaryResolver.toLowerCase() !== SYNQ_V2_SEPOLIA_CONFIG.primaryResolver.toLowerCase()) {
    errors.push(`Primary resolver must match configured address: ${SYNQ_V2_SEPOLIA_CONFIG.primaryResolver}`);
  }
  if (proposal.emergencyResolver.toLowerCase() !== SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver.toLowerCase()) {
    errors.push(`Emergency resolver must match configured address: ${SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver}`);
  }

  // 3. Standard Protection Settings
  if (proposal.isProtected !== false) {
    errors.push('Standard V2 proposals must have isProtected = false');
  }
  if (proposal.protectionModule.toLowerCase() !== ZERO_ADDRESS) {
    errors.push('Standard V2 proposals must have zero protectionModule');
  }
  if (proposal.policyId !== ZERO_BYTES32) {
    errors.push('Standard V2 proposals must have zero policyId');
  }

  // 4. Milestones Array & Constraints
  if (!Array.isArray(milestones) || milestones.length === 0) {
    errors.push('Proposal must contain at least one milestone');
  } else {
    for (let i = 0; i < milestones.length; i++) {
      const m = milestones[i];
      if (m.amount <= 0n) {
        errors.push(`Milestone [${i}] amount must be greater than zero`);
      }
      if (m.reviewWindow < MIN_REVIEW_WINDOW_SECONDS || m.reviewWindow > MAX_REVIEW_WINDOW_SECONDS) {
        errors.push(
          `Milestone [${i}] reviewWindow must be between 1 hour (${MIN_REVIEW_WINDOW_SECONDS}s) and 30 days (${MAX_REVIEW_WINDOW_SECONDS}s)`
        );
      }
      if (!m.specHash || m.specHash === ZERO_BYTES32 || !/^0x[0-9a-fA-F]{64}$/.test(m.specHash)) {
        errors.push(`Milestone [${i}] specHash must be a non-zero bytes32 hex string`);
      }
    }

    // Verify milestonesHash cryptographic match
    try {
      const computedHash = hashStandardV2Milestones(milestones);
      if (computedHash.toLowerCase() !== proposal.milestonesHash.toLowerCase()) {
        errors.push('proposal.milestonesHash does not match computed keccak256(abi.encode(milestones))');
      }
    } catch (err: any) {
      errors.push(`Failed to verify milestones hash: ${err?.message || 'unknown error'}`);
    }
  }

  // 5. Nonce & Expiry
  if (proposal.proposalNonce < 0n) {
    errors.push('proposalNonce must be a non-negative uint256');
  }
  if (proposal.expiry <= 0n) {
    errors.push('proposal expiry must be greater than zero');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Application UX Validation Rules:
 * Validates temporal business expectations (deadlines in the future) without confusing
 * them with immutable smart-contract invariants.
 */
export function validateStandardV2UxRules(
  proposal: DealProposalV2,
  milestones: readonly StandardV2MilestoneInit[],
  currentTimestampSeconds: number = Math.floor(Date.now() / 1000)
): ValidationResult {
  const errors: string[] = [];
  const now = BigInt(currentTimestampSeconds);

  if (proposal.expiry <= now) {
    errors.push(`Proposal expiry (${proposal.expiry}) is in the past (current time: ${now})`);
  }

  for (let i = 0; i < milestones.length; i++) {
    const m = milestones[i];
    if (m.workDeadline <= now) {
      errors.push(`Milestone [${i}] workDeadline (${m.workDeadline}) is in the past (current time: ${now})`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// --- Standard V2 Proposal Builder ---

/**
 * Pure builder function that constructs a complete, valid DealProposalV2 from application parameters.
 * Automatically injects canonical V2 deployment constants:
 * - canonicalUsdc
 * - dealImplementation
 * - primaryResolver
 * - emergencyResolver
 * - isProtected = false
 * - protectionModule = ZERO_ADDRESS
 * - policyId = ZERO_BYTES32
 *
 * Computes milestonesHash and proposalId.
 */
export function buildStandardV2Proposal(params: StandardV2ProposalCreationParams): {
  proposal: DealProposalV2;
  milestones: StandardV2MilestoneInit[];
  proposalId: `0x${string}`;
} {
  const normalizedClient = (params.client || '').trim().toLowerCase() as `0x${string}`;
  const normalizedFreelancer = (params.freelancer || '').trim().toLowerCase() as `0x${string}`;

  const milestones = normalizeMilestoneInits(params.milestones);
  const milestonesHash = hashStandardV2Milestones(milestones);

  const proposal: DealProposalV2 = {
    client: normalizedClient,
    freelancer: normalizedFreelancer,
    canonicalUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
    dealImplementation: SYNQ_V2_SEPOLIA_CONFIG.dealImplementation,
    primaryResolver: SYNQ_V2_SEPOLIA_CONFIG.primaryResolver,
    emergencyResolver: SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver,
    milestonesHash,
    isProtected: false,
    protectionModule: ZERO_ADDRESS,
    policyId: ZERO_BYTES32,
    proposalNonce: BigInt(params.proposalNonce),
    expiry: BigInt(params.expiry),
  };

  const validation = validateStandardV2ProtocolRules(proposal, milestones);
  if (!validation.valid) {
    throw new Error(`Standard V2 proposal construction failed validation:\n- ${validation.errors.join('\n- ')}`);
  }

  const proposalId = hashDealProposalV2(proposal);

  return {
    proposal,
    milestones,
    proposalId,
  };
}
