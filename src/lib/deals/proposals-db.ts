/**
 * Synq Standard V2 Deal Proposal Persistence & Server Verification Layer
 *
 * CRYPTOGRAPHIC & DATA BOUNDARIES:
 * - SIGNED / CRYPTOGRAPHICALLY BOUND:
 *   client, freelancer, canonicalUsdc, dealImplementation, primaryResolver,
 *   emergencyResolver, milestonesHash, isProtected, protectionModule, policyId,
 *   proposalNonce, expiry.
 *
 * - MILESTONE PREIMAGE BOUND (via milestonesHash):
 *   amount, workDeadline, reviewWindow, gracePeriod, specHash.
 *
 * - SIGNATURE:
 *   clientSignature (EOA ECDSA over EIP-712 DealProposal).
 *
 * - APPLICATION METADATA NOT DIRECTLY EIP-712 BOUND:
 *   title, scope, milestone title/description.
 *   (Stored durably off-chain alongside proposal).
 */

import { getAddress } from 'viem';
import { getDb } from '@/db';
import {
  dealProposals,
  conversations,
  messages,
  type DealProposalRow,
  type NewDealProposalRow,
  type PersistedMilestoneV2,
} from '@/db/schema';
import type {
  DealProposalV2,
  StandardV2MilestoneInit,
  ProtectionSelection,
} from '@/types/deal-v2';
import { SYNQ_V2_SEPOLIA_CONFIG } from '@/lib/contracts/addresses';
import {
  ZERO_ADDRESS,
  ZERO_BYTES32,
  hashStandardV2Milestones,
  hashDealProposalV2,
  verifyDealProposalSignature,
  validateStandardV2ProtocolRules,
  validateStandardV2UxRules,
} from '@/lib/deals/v2';
import { normalizeWallet } from '@/lib/utils';
import { eq, and } from 'drizzle-orm';
import { synqFactoryV2ABI } from '@/lib/contracts/abis';
import { sepoliaPublicClient } from '@/lib/chain';
import { canonicalizeConversationPair } from '@/lib/conversation-pair';
import {
  deriveConversationPreview,
  validateTrustedMessageData,
  type SynqDealProposalPayload,
} from '@/lib/synq-message';

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

export class ProposalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalValidationError';
  }
}

export class ProposalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalConflictError';
  }
}

export class ProposalAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalAuthError';
  }
}

// ---------------------------------------------------------------------------
// Strict Primitive Parsers
// ---------------------------------------------------------------------------

const UINT256_MAX = 2n ** 256n - 1n;

export function parseStrictUint256String(value: unknown, fieldName: string): bigint {
  if (typeof value !== 'string') {
    throw new ProposalValidationError(`Field '${fieldName}' must be a decimal string`);
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ProposalValidationError(`Field '${fieldName}' must contain only decimal digits`);
  }
  const big = BigInt(trimmed);
  if (big < 0n || big > UINT256_MAX) {
    throw new ProposalValidationError(`Field '${fieldName}' out of uint256 bounds`);
  }
  return big;
}

export function parseStrictAddress(value: unknown, fieldName: string): `0x${string}` {
  if (typeof value !== 'string') {
    throw new ProposalValidationError(`Field '${fieldName}' must be a string address`);
  }
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new ProposalValidationError(`Field '${fieldName}' must be a valid 20-byte hex address`);
  }
  if (trimmed === ZERO_ADDRESS && fieldName !== 'protectionModule') {
    throw new ProposalValidationError(`Field '${fieldName}' cannot be zero address`);
  }
  return getAddress(trimmed);
}

export function parseStrictBytes32(value: unknown, fieldName: string): `0x${string}` {
  if (typeof value !== 'string') {
    throw new ProposalValidationError(`Field '${fieldName}' must be a string bytes32`);
  }
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new ProposalValidationError(`Field '${fieldName}' must be a valid 32-byte hex string`);
  }
  return trimmed.toLowerCase() as `0x${string}`;
}

export function parseStrictSignature(value: unknown, fieldName: string): `0x${string}` {
  if (typeof value !== 'string') {
    throw new ProposalValidationError(`Field '${fieldName}' must be a string signature`);
  }
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{130}$/.test(trimmed)) {
    throw new ProposalValidationError(`Field '${fieldName}' must be a valid 65-byte hex signature (130 hex chars)`);
  }
  return trimmed as `0x${string}`;
}

export function parseStrictProtectionSelection(value: unknown): ProtectionSelection {
  if (value === undefined || value === null || value === '') {
    // Missing or legacy values safely normalize to STANDARD
    return 'STANDARD';
  }
  if (typeof value !== 'string') {
    throw new ProposalValidationError("Field 'protectionSelection' must be a string");
  }
  const trimmed = value.trim();
  if (trimmed !== 'STANDARD' && trimmed !== 'PREMIUM') {
    throw new ProposalValidationError("Field 'protectionSelection' must be 'STANDARD' or 'PREMIUM'");
  }
  return trimmed;
}

export function parseStrictMetadata(metadata: unknown): { title: string; scope: string } {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new ProposalValidationError('Metadata must be an object');
  }
  const m = metadata as Record<string, unknown>;
  if (typeof m.title !== 'string' || !m.title.trim() || m.title.trim().length > 140) {
    throw new ProposalValidationError('Metadata title must be a non-empty string up to 140 characters');
  }
  if (typeof m.scope !== 'string' || !m.scope.trim() || m.scope.trim().length > 10000) {
    throw new ProposalValidationError('Metadata scope must be a non-empty string up to 10000 characters');
  }
  return {
    title: m.title.trim(),
    scope: m.scope.trim(),
  };
}

export function parseStrictMilestones(rawMilestones: unknown): {
  milestoneInits: StandardV2MilestoneInit[];
  persistedMilestones: PersistedMilestoneV2[];
} {
  if (!Array.isArray(rawMilestones) || rawMilestones.length === 0) {
    throw new ProposalValidationError('Milestones must be a non-empty array');
  }
  if (rawMilestones.length > 10) {
    throw new ProposalValidationError('Milestones count exceeds maximum of 10');
  }

  const milestoneInits: StandardV2MilestoneInit[] = [];
  const persistedMilestones: PersistedMilestoneV2[] = [];

  for (let i = 0; i < rawMilestones.length; i++) {
    const rm = rawMilestones[i];
    if (!rm || typeof rm !== 'object' || Array.isArray(rm)) {
      throw new ProposalValidationError(`Milestone[${i}] must be an object`);
    }

    const amount = parseStrictUint256String(rm.amount, `milestones[${i}].amount`);
    const workDeadline = parseStrictUint256String(rm.workDeadline, `milestones[${i}].workDeadline`);
    const reviewWindow = parseStrictUint256String(rm.reviewWindow, `milestones[${i}].reviewWindow`);
    const gracePeriod = parseStrictUint256String(rm.gracePeriod, `milestones[${i}].gracePeriod`);
    const specHash = parseStrictBytes32(rm.specHash, `milestones[${i}].specHash`);

    const title = typeof rm.title === 'string' && rm.title.trim() ? rm.title.trim().slice(0, 140) : undefined;
    const description = typeof rm.description === 'string' && rm.description.trim() ? rm.description.trim().slice(0, 1000) : undefined;

    milestoneInits.push({
      amount,
      workDeadline,
      reviewWindow,
      gracePeriod,
      specHash,
    });

    persistedMilestones.push({
      amount: amount.toString(),
      workDeadline: workDeadline.toString(),
      reviewWindow: reviewWindow.toString(),
      gracePeriod: gracePeriod.toString(),
      specHash,
      title,
      description,
    });
  }

  return { milestoneInits, persistedMilestones };
}

export function parseStrictProposal(rawProposal: unknown): DealProposalV2 {
  if (!rawProposal || typeof rawProposal !== 'object' || Array.isArray(rawProposal)) {
    throw new ProposalValidationError('Proposal must be an object');
  }
  const p = rawProposal as Record<string, unknown>;

  const client = parseStrictAddress(p.client, 'client');
  const freelancer = parseStrictAddress(p.freelancer, 'freelancer');
  const milestonesHash = parseStrictBytes32(p.milestonesHash, 'milestonesHash');
  const proposalNonce = parseStrictUint256String(p.proposalNonce, 'proposalNonce');
  const expiry = parseStrictUint256String(p.expiry, 'expiry');

  // Verify Standard V2 address fields if provided in proposal, or fill from canonical config
  if (p.canonicalUsdc !== undefined) {
    const rawUsdc = parseStrictAddress(p.canonicalUsdc, 'canonicalUsdc');
    if (rawUsdc.toLowerCase() !== SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc.toLowerCase()) {
      throw new ProposalValidationError(`canonicalUsdc must match canonical Sepolia V2 USDC (${SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc})`);
    }
  }
  if (p.dealImplementation !== undefined) {
    const rawDealImpl = parseStrictAddress(p.dealImplementation, 'dealImplementation');
    if (rawDealImpl.toLowerCase() !== SYNQ_V2_SEPOLIA_CONFIG.dealImplementation.toLowerCase()) {
      throw new ProposalValidationError(`dealImplementation must match canonical Sepolia V2 implementation (${SYNQ_V2_SEPOLIA_CONFIG.dealImplementation})`);
    }
  }
  if (p.primaryResolver !== undefined) {
    const rawPrimary = parseStrictAddress(p.primaryResolver, 'primaryResolver');
    if (rawPrimary.toLowerCase() !== SYNQ_V2_SEPOLIA_CONFIG.primaryResolver.toLowerCase()) {
      throw new ProposalValidationError(`primaryResolver must match canonical Sepolia V2 resolver (${SYNQ_V2_SEPOLIA_CONFIG.primaryResolver})`);
    }
  }
  if (p.emergencyResolver !== undefined) {
    const rawEmergency = parseStrictAddress(p.emergencyResolver, 'emergencyResolver');
    if (rawEmergency.toLowerCase() !== SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver.toLowerCase()) {
      throw new ProposalValidationError(`emergencyResolver must match canonical Sepolia V2 resolver (${SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver})`);
    }
  }
  if (p.isProtected !== undefined && p.isProtected !== false) {
    throw new ProposalValidationError('Standard V2 proposals must have isProtected = false');
  }
  if (p.protectionModule !== undefined) {
    const rawModule = parseStrictAddress(p.protectionModule, 'protectionModule');
    if (rawModule.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
      throw new ProposalValidationError('Standard V2 proposals must have protectionModule = zero address');
    }
  }
  if (p.policyId !== undefined) {
    const rawPolicy = parseStrictBytes32(p.policyId, 'policyId');
    if (rawPolicy.toLowerCase() !== ZERO_BYTES32.toLowerCase()) {
      throw new ProposalValidationError('Standard V2 proposals must have policyId = zero bytes32');
    }
  }

  return {
    client,
    freelancer,
    canonicalUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
    dealImplementation: SYNQ_V2_SEPOLIA_CONFIG.dealImplementation,
    primaryResolver: SYNQ_V2_SEPOLIA_CONFIG.primaryResolver,
    emergencyResolver: SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver,
    milestonesHash,
    isProtected: false,
    protectionModule: ZERO_ADDRESS,
    policyId: ZERO_BYTES32,
    proposalNonce,
    expiry,
  };
}

// ---------------------------------------------------------------------------
// Verification Pipeline
// ---------------------------------------------------------------------------

export interface VerifiedServerProposal {
  proposal: DealProposalV2;
  milestones: StandardV2MilestoneInit[];
  persistedMilestones: PersistedMilestoneV2[];
  clientSignature: `0x${string}`;
  metadata: { title: string; scope: string };
  milestonesHash: `0x${string}`;
  proposalId: `0x${string}`;
  totalAmount: bigint;
  protectionSelection: ProtectionSelection;
  rowToInsert: NewDealProposalRow;
}

export async function verifyServerProposalSubmission(
  rawBody: unknown,
  authWallet: string | null,
  currentTimestamp: number = Math.floor(Date.now() / 1000),
): Promise<VerifiedServerProposal> {
  if (!authWallet) {
    throw new ProposalAuthError('Unauthorized');
  }

  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new ProposalValidationError('Request body must be a JSON object');
  }
  const body = rawBody as Record<string, unknown>;

  const proposal = parseStrictProposal(body.proposal);
  const { milestoneInits, persistedMilestones } = parseStrictMilestones(body.milestones);
  const clientSignature = parseStrictSignature(body.clientSignature, 'clientSignature');
  const metadata = parseStrictMetadata(body.metadata);
  const protectionSelection = parseStrictProtectionSelection(body.protectionSelection);

  // Authenticated caller must equal proposal.client (case-insensitive)
  if (normalizeWallet(authWallet) !== normalizeWallet(proposal.client)) {
    throw new ProposalAuthError('Authenticated wallet does not match proposal client');
  }

  // Phase 3B protocol validation rules
  const protocolValidation = validateStandardV2ProtocolRules(proposal, milestoneInits);
  if (!protocolValidation.valid) {
    throw new ProposalValidationError(protocolValidation.errors.join('; '));
  }

  // UX validation rules (deadlines and expiries in the future relative to server time)
  const uxValidation = validateStandardV2UxRules(proposal, milestoneInits, currentTimestamp);
  if (!uxValidation.valid) {
    throw new ProposalValidationError(uxValidation.errors.join('; '));
  }

  // Recompute milestonesHash
  const recomputedMilestonesHash = hashStandardV2Milestones(milestoneInits);
  if (recomputedMilestonesHash.toLowerCase() !== proposal.milestonesHash.toLowerCase()) {
    throw new ProposalValidationError('Milestones hash mismatch');
  }

  // Recompute proposalId
  const recomputedProposalId = hashDealProposalV2(proposal);

  // Verify EOA signature
  const isValidSig = await verifyDealProposalSignature(proposal, clientSignature);
  if (!isValidSig) {
    throw new ProposalValidationError('Invalid proposal signature');
  }

  // Compute total amount server-side
  const totalAmount = milestoneInits.reduce((sum, m) => sum + m.amount, 0n);

  const rowToInsert: NewDealProposalRow = {
    proposalId: recomputedProposalId,
    proposalNonce: proposal.proposalNonce.toString(),
    chainId: SYNQ_V2_SEPOLIA_CONFIG.chainId,
    factoryAddress: normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.factory),
    clientWallet: normalizeWallet(proposal.client),
    freelancerWallet: normalizeWallet(proposal.freelancer),
    canonicalUsdc: normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc),
    dealImplementation: normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.dealImplementation),
    primaryResolver: normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.primaryResolver),
    emergencyResolver: normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver),
    milestonesHash: recomputedMilestonesHash,
    isProtected: false,
    protectionModule: normalizeWallet(ZERO_ADDRESS),
    policyId: ZERO_BYTES32,
    expiry: proposal.expiry.toString(),
    clientSignature,
    title: metadata.title,
    scope: metadata.scope,
    totalAmount: totalAmount.toString(),
    milestones: persistedMilestones,
    protectionSelection,
    cachedStatus: 'PENDING',
    dealAddress: null,
    acceptedTxHash: null,
    declinedTxHash: null,
    cancelledTxHash: null,
  };

  return {
    proposal,
    milestones: milestoneInits,
    persistedMilestones,
    clientSignature,
    metadata,
    milestonesHash: recomputedMilestonesHash,
    proposalId: recomputedProposalId,
    totalAmount,
    protectionSelection,
    rowToInsert,
  };
}

// ---------------------------------------------------------------------------
// Idempotency and Conflict Evaluation
// ---------------------------------------------------------------------------

export type ProposalPersistenceDecision =
  | { action: 'INSERT'; row: NewDealProposalRow }
  | { action: 'IDEMPOTENT_REPLAY'; existingRow: DealProposalRow }
  | { action: 'CONFLICT_DATA'; reason: string }
  | { action: 'CONFLICT_NONCE'; reason: string };

export function evaluateProposalPersistence(
  candidate: NewDealProposalRow,
  existingById: DealProposalRow | null,
  existingByNonce: DealProposalRow | null,
): ProposalPersistenceDecision {
  if (existingById) {
    // Check if every immutable field matches exactly
    const isClientMatch = normalizeWallet(existingById.clientWallet) === normalizeWallet(candidate.clientWallet);
    const isFreelancerMatch = normalizeWallet(existingById.freelancerWallet) === normalizeWallet(candidate.freelancerWallet);
    const isNonceMatch = existingById.proposalNonce === candidate.proposalNonce;
    const isExpiryMatch = existingById.expiry === candidate.expiry;
    const isMilestonesHashMatch = existingById.milestonesHash.toLowerCase() === candidate.milestonesHash.toLowerCase();
    const isSignatureMatch = existingById.clientSignature.toLowerCase() === candidate.clientSignature.toLowerCase();
    const isTotalAmountMatch = existingById.totalAmount === candidate.totalAmount;
    const isTitleMatch = existingById.title === candidate.title;
    const isScopeMatch = existingById.scope === candidate.scope;
    const isProtectionMatch = (existingById.protectionSelection || 'STANDARD') === (candidate.protectionSelection || 'STANDARD');

    if (
      isClientMatch &&
      isFreelancerMatch &&
      isNonceMatch &&
      isExpiryMatch &&
      isMilestonesHashMatch &&
      isSignatureMatch &&
      isTotalAmountMatch &&
      isTitleMatch &&
      isScopeMatch &&
      isProtectionMatch
    ) {
      return { action: 'IDEMPOTENT_REPLAY', existingRow: existingById };
    }

    return {
      action: 'CONFLICT_DATA',
      reason: 'Proposal already exists with conflicting data',
    };
  }

  if (existingByNonce) {
    // Sibling proposal using the same nonce slot for this client
    if (existingByNonce.proposalId !== candidate.proposalId) {
      return {
        action: 'CONFLICT_NONCE',
        reason: `Proposal nonce conflict: nonce ${candidate.proposalNonce} already allocated to proposal ${existingByNonce.proposalId}`,
      };
    }
  }

  return { action: 'INSERT', row: candidate };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface SerializedDealProposal {
  proposalId: string;
  proposalNonce: string;
  chainId: number;
  factoryAddress: string;
  clientWallet: string;
  freelancerWallet: string;
  canonicalUsdc: string;
  dealImplementation: string;
  primaryResolver: string;
  emergencyResolver: string;
  milestonesHash: string;
  isProtected: boolean;
  protectionModule: string;
  policyId: string;
  expiry: string;
  clientSignature: string;
  title: string;
  scope: string;
  totalAmount: string;
  milestones: PersistedMilestoneV2[];
  protectionSelection: 'STANDARD' | 'PREMIUM';
  cachedStatus: string;
  dealAddress: string | null;
  acceptedTxHash: string | null;
  declinedTxHash: string | null;
  cancelledTxHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeDealProposal(row: DealProposalRow): SerializedDealProposal {
  return {
    proposalId: row.proposalId,
    proposalNonce: row.proposalNonce.toString(),
    chainId: row.chainId,
    factoryAddress: row.factoryAddress,
    clientWallet: row.clientWallet,
    freelancerWallet: row.freelancerWallet,
    canonicalUsdc: row.canonicalUsdc,
    dealImplementation: row.dealImplementation,
    primaryResolver: row.primaryResolver,
    emergencyResolver: row.emergencyResolver,
    milestonesHash: row.milestonesHash,
    isProtected: row.isProtected,
    protectionModule: row.protectionModule,
    policyId: row.policyId,
    expiry: row.expiry.toString(),
    clientSignature: row.clientSignature,
    title: row.title,
    scope: row.scope,
    totalAmount: row.totalAmount.toString(),
    milestones: row.milestones,
    protectionSelection: (row.protectionSelection as 'STANDARD' | 'PREMIUM') || 'STANDARD',
    cachedStatus: row.cachedStatus,
    dealAddress: row.dealAddress,
    acceptedTxHash: row.acceptedTxHash,
    declinedTxHash: row.declinedTxHash,
    cancelledTxHash: row.cancelledTxHash,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Database Operations / Repository Pattern
// ---------------------------------------------------------------------------

export interface IDealProposalRepository {
  getById(proposalId: string): Promise<DealProposalRow | null>;
  getByClientNonce(
    chainId: number,
    factoryAddress: string,
    clientWallet: string,
    proposalNonce: string,
  ): Promise<DealProposalRow | null>;
  getByDealAddress(dealAddress: string): Promise<DealProposalRow | null>;
  create(data: NewDealProposalRow): Promise<DealProposalRow>;
  updateStatus(
    proposalId: string,
    status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED',
    terminalData?: { dealAddress?: string; txHash?: string; terminalType?: 'ACCEPTED' | 'DECLINED' | 'CANCELLED' },
  ): Promise<DealProposalRow | null>;
  createReceiptMessage(
    proposal: DealProposalRow,
    receiptId: string,
    validatedPayload: SynqDealProposalPayload,
    participantA: string,
    participantB: string,
  ): Promise<{ conversation: any; message: any; created: boolean }>;
}

export class DrizzleDealProposalRepository implements IDealProposalRepository {
  async getById(proposalId: string): Promise<DealProposalRow | null> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(dealProposals)
      .where(eq(dealProposals.proposalId, proposalId))
      .limit(1);
    return row || null;
  }

  async getByClientNonce(
    chainId: number,
    factoryAddress: string,
    clientWallet: string,
    proposalNonce: string,
  ): Promise<DealProposalRow | null> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(dealProposals)
      .where(
        and(
          eq(dealProposals.chainId, chainId),
          eq(dealProposals.factoryAddress, normalizeWallet(factoryAddress)),
          eq(dealProposals.clientWallet, normalizeWallet(clientWallet)),
          eq(dealProposals.proposalNonce, proposalNonce),
        ),
      )
      .limit(1);
    return row || null;
  }

  async getByDealAddress(dealAddress: string): Promise<DealProposalRow | null> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(dealProposals)
      .where(eq(dealProposals.dealAddress, normalizeWallet(dealAddress)))
      .limit(1);
    return row || null;
  }

  async create(data: NewDealProposalRow): Promise<DealProposalRow> {
    const db = getDb();
    const [created] = await db.insert(dealProposals).values(data).returning();
    return created;
  }

  async updateStatus(
    proposalId: string,
    status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED',
    terminalData?: { dealAddress?: string; txHash?: string; terminalType?: 'ACCEPTED' | 'DECLINED' | 'CANCELLED' },
  ): Promise<DealProposalRow | null> {
    const db = getDb();
    const updates: Partial<NewDealProposalRow> & { updatedAt: Date } = {
      cachedStatus: status,
      updatedAt: new Date(),
    };
    if (terminalData?.dealAddress) {
      updates.dealAddress = normalizeWallet(terminalData.dealAddress);
    }
    if (terminalData?.terminalType === 'ACCEPTED' && terminalData.txHash) {
      updates.acceptedTxHash = terminalData.txHash;
    } else if (terminalData?.terminalType === 'DECLINED' && terminalData.txHash) {
      updates.declinedTxHash = terminalData.txHash;
    } else if (terminalData?.terminalType === 'CANCELLED' && terminalData.txHash) {
      updates.cancelledTxHash = terminalData.txHash;
    }

    const [updated] = await db
      .update(dealProposals)
      .set(updates)
      .where(eq(dealProposals.proposalId, proposalId))
      .returning();
    return updated || null;
  }

  async createReceiptMessage(
    proposal: DealProposalRow,
    receiptId: string,
    validatedPayload: SynqDealProposalPayload,
    participantA: string,
    participantB: string,
  ): Promise<{ conversation: any; message: any; created: boolean }> {
    const db = getDb();
    const fromWallet = normalizeWallet(proposal.clientWallet);
    const toWallet = normalizeWallet(proposal.freelancerWallet);
    const preview = deriveConversationPreview('deal_proposal', '', validatedPayload);
    const now = new Date();

    return db.transaction(async (tx) => {
      await tx
        .insert(conversations)
        .values({
          id: crypto.randomUUID(),
          participantA,
          participantB,
          buyerWallet: fromWallet,
          sellerWallet: toWallet,
          lastMessageAt: now,
          lastMessagePreview: preview,
          lastMessageFrom: fromWallet,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [conversations.participantA, conversations.participantB],
        });

      const conversationRows = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.participantA, participantA),
            eq(conversations.participantB, participantB),
          ),
        );
      const conversationRow = conversationRows[0];
      if (!conversationRow) throw new Error('Canonical conversation could not be created or reused');

      const insertedRows = await tx
        .insert(messages)
        .values({
          id: receiptId,
          conversationId: conversationRow.id,
          fromWallet,
          toWallet,
          fromName: null,
          body: '',
          kind: 'deal_proposal',
          payload: validatedPayload as unknown as Record<string, unknown>,
          orderMeta: null,
          readAt: null,
          createdAt: now,
        })
        .onConflictDoNothing({ target: messages.id })
        .returning();

      let messageRow = insertedRows[0];
      const created = !!messageRow;
      if (!messageRow) {
        const existingRows = await tx.select().from(messages).where(eq(messages.id, receiptId));
        messageRow = existingRows[0];
        const existingPayload = messageRow?.payload as Record<string, unknown> | null | undefined;
        if (
          !messageRow ||
          messageRow.conversationId !== conversationRow.id ||
          messageRow.kind !== 'deal_proposal' ||
          normalizeWallet(messageRow.fromWallet) !== fromWallet ||
          normalizeWallet(messageRow.toWallet) !== toWallet ||
          existingPayload?.proposalId !== validatedPayload.proposalId ||
          existingPayload?.totalAmount !== validatedPayload.totalAmount
        ) {
          throw new Error('Deal proposal receipt idempotency conflict');
        }
      } else {
        await tx
          .update(conversations)
          .set({
            lastMessageAt: now,
            lastMessagePreview: preview,
            lastMessageFrom: fromWallet,
            updatedAt: now,
          })
          .where(eq(conversations.id, conversationRow.id));
      }

      return { conversation: conversationRow, message: messageRow, created };
    });
  }
}

export class InMemoryDealProposalRepository implements IDealProposalRepository {
  private records: Map<string, DealProposalRow> = new Map();

  async getById(proposalId: string): Promise<DealProposalRow | null> {
    return this.records.get(proposalId) || null;
  }

  async getByClientNonce(
    chainId: number,
    factoryAddress: string,
    clientWallet: string,
    proposalNonce: string,
  ): Promise<DealProposalRow | null> {
    const targetFactory = normalizeWallet(factoryAddress);
    const targetClient = normalizeWallet(clientWallet);
    for (const record of this.records.values()) {
      if (
        record.chainId === chainId &&
        normalizeWallet(record.factoryAddress) === targetFactory &&
        normalizeWallet(record.clientWallet) === targetClient &&
        record.proposalNonce === proposalNonce
      ) {
        return record;
      }
    }
    return null;
  }

  async getByDealAddress(dealAddress: string): Promise<DealProposalRow | null> {
    const target = normalizeWallet(dealAddress);
    for (const record of this.records.values()) {
      if (record.dealAddress && normalizeWallet(record.dealAddress) === target) {
        return record;
      }
    }
    return null;
  }

  async create(data: NewDealProposalRow): Promise<DealProposalRow> {
    const now = new Date();
    const record: DealProposalRow = {
      ...data,
      protectionSelection: data.protectionSelection ?? 'STANDARD',
      dealAddress: data.dealAddress ?? null,
      acceptedTxHash: data.acceptedTxHash ?? null,
      declinedTxHash: data.declinedTxHash ?? null,
      cancelledTxHash: data.cancelledTxHash ?? null,
      cachedStatus: data.cachedStatus ?? 'PENDING',
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(data.proposalId, record);
    return record;
  }

  async updateStatus(
    proposalId: string,
    status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED',
    terminalData?: { dealAddress?: string; txHash?: string; terminalType?: 'ACCEPTED' | 'DECLINED' | 'CANCELLED' },
  ): Promise<DealProposalRow | null> {
    const existing = this.records.get(proposalId);
    if (!existing) return null;
    const updated: DealProposalRow = {
      ...existing,
      cachedStatus: status,
      dealAddress: terminalData?.dealAddress ? normalizeWallet(terminalData.dealAddress) : existing.dealAddress,
      acceptedTxHash: terminalData?.terminalType === 'ACCEPTED' && terminalData.txHash ? terminalData.txHash : existing.acceptedTxHash,
      declinedTxHash: terminalData?.terminalType === 'DECLINED' && terminalData.txHash ? terminalData.txHash : existing.declinedTxHash,
      cancelledTxHash: terminalData?.terminalType === 'CANCELLED' && terminalData.txHash ? terminalData.txHash : existing.cancelledTxHash,
      updatedAt: new Date(),
    };
    this.records.set(proposalId, updated);
    return updated;
  }

  private conversations: Map<string, any> = new Map();
  private messages: Map<string, any> = new Map();

  async createReceiptMessage(
    proposal: DealProposalRow,
    receiptId: string,
    validatedPayload: SynqDealProposalPayload,
    participantA: string,
    participantB: string,
  ): Promise<{ conversation: any; message: any; created: boolean }> {
    const fromWallet = normalizeWallet(proposal.clientWallet);
    const toWallet = normalizeWallet(proposal.freelancerWallet);
    const preview = deriveConversationPreview('deal_proposal', '', validatedPayload);
    const convKey = `${participantA}:${participantB}`;
    const now = new Date();

    let conv = this.conversations.get(convKey);
    if (!conv) {
      conv = {
        id: `conv-${convKey}`,
        participantA,
        participantB,
        buyerWallet: fromWallet,
        sellerWallet: toWallet,
        lastMessageAt: now.toISOString(),
        lastMessagePreview: preview,
        lastMessageFrom: fromWallet,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      this.conversations.set(convKey, conv);
    }

    const existingMsg = this.messages.get(receiptId);
    if (existingMsg) {
      if (
        existingMsg.conversationId !== conv.id ||
        existingMsg.kind !== 'deal_proposal' ||
        normalizeWallet(existingMsg.fromWallet) !== fromWallet ||
        normalizeWallet(existingMsg.toWallet) !== toWallet ||
        existingMsg.payload?.proposalId !== validatedPayload.proposalId ||
        existingMsg.payload?.totalAmount !== validatedPayload.totalAmount
      ) {
        throw new Error('Deal proposal receipt idempotency conflict');
      }
      return { conversation: conv, message: existingMsg, created: false };
    }

    const newMsg = {
      id: receiptId,
      conversationId: conv.id,
      fromWallet,
      toWallet,
      fromName: null,
      body: '',
      kind: 'deal_proposal',
      payload: validatedPayload,
      orderMeta: null,
      readAt: null,
      createdAt: now.toISOString(),
    };
    this.messages.set(receiptId, newMsg);

    conv.lastMessageAt = now.toISOString();
    conv.lastMessagePreview = preview;
    conv.lastMessageFrom = fromWallet;
    conv.updatedAt = now.toISOString();

    return { conversation: conv, message: newMsg, created: true };
  }

  getMessages(): any[] {
    return Array.from(this.messages.values());
  }

  getConversations(): any[] {
    return Array.from(this.conversations.values());
  }

  clear() {
    this.records.clear();
    this.conversations.clear();
    this.messages.clear();
  }
}

let activeRepo: IDealProposalRepository = new DrizzleDealProposalRepository();

export function setDealProposalRepository(repo: IDealProposalRepository) {
  activeRepo = repo;
}

export function resetDealProposalRepository() {
  activeRepo = new DrizzleDealProposalRepository();
}

export const defaultDealProposalRepository = activeRepo;

export async function createDealProposal(
  rowToInsert: NewDealProposalRow,
  repo: IDealProposalRepository = activeRepo,
): Promise<DealProposalRow> {
  return repo.create(rowToInsert);
}

export async function getDealProposalById(
  proposalId: string,
  repo: IDealProposalRepository = activeRepo,
): Promise<DealProposalRow | null> {
  return repo.getById(proposalId);
}

export async function getDealProposalByDealAddress(
  dealAddress: string,
  repo: IDealProposalRepository = activeRepo,
): Promise<DealProposalRow | null> {
  return repo.getByDealAddress(dealAddress);
}

export async function getDealProposalByClientNonce(
  chainId: number,
  factoryAddress: string,
  clientWallet: string,
  proposalNonce: string,
  repo: IDealProposalRepository = activeRepo,
): Promise<DealProposalRow | null> {
  return repo.getByClientNonce(chainId, factoryAddress, clientWallet, proposalNonce);
}

export async function getNextClientProposalNonce(
  clientWallet: string,
  chainId: number = SYNQ_V2_SEPOLIA_CONFIG.chainId,
  factoryAddress: string = SYNQ_V2_SEPOLIA_CONFIG.factory,
  repo: IDealProposalRepository = activeRepo,
): Promise<bigint> {
  const normClient = normalizeWallet(clientWallet);
  let nonce = 0n;
  while (true) {
    const existingInDb = await repo.getByClientNonce(chainId, factoryAddress, normClient, nonce.toString());
    if (!existingInDb) {
      try {
        const isUsedOnChain = await sepoliaPublicClient.readContract({
          address: factoryAddress as `0x${string}`,
          abi: synqFactoryV2ABI,
          functionName: 'isProposalNonceUsed',
          args: [normClient as `0x${string}`, nonce],
        });
        if (!isUsedOnChain) {
          return nonce;
        }
      } catch {
        return nonce;
      }
    }
    nonce += 1n;
  }
}

export async function updateDealProposalStatus(
  proposalId: string,
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED',
  terminalData?: { dealAddress?: string; txHash?: string; terminalType?: 'ACCEPTED' | 'DECLINED' | 'CANCELLED' },
  repo: IDealProposalRepository = activeRepo,
): Promise<DealProposalRow | null> {
  return repo.updateStatus(proposalId, status, terminalData);
}

export async function createCanonicalDealProposalReceiptMessage(
  proposal: DealProposalRow,
  repo: IDealProposalRepository = activeRepo,
): Promise<{ conversation: any; message: any; created: boolean }> {
  const fromWallet = normalizeWallet(proposal.clientWallet);
  const toWallet = normalizeWallet(proposal.freelancerWallet);
  if (fromWallet === toWallet) {
    throw new ProposalValidationError('Proposal client and freelancer cannot be identical');
  }

  const { participantA, participantB } = canonicalizeConversationPair(fromWallet, toWallet);
  const payload: SynqDealProposalPayload = {
    proposalId: proposal.proposalId,
    clientWallet: fromWallet,
    freelancerWallet: toWallet,
    title: proposal.title,
    totalAmount: proposal.totalAmount,
    milestoneCount: proposal.milestones.length,
    expiry: proposal.expiry,
    cachedStatus: proposal.cachedStatus,
    protectionSelection: (proposal.protectionSelection as 'STANDARD' | 'PREMIUM') || 'STANDARD',
  };

  const validated = validateTrustedMessageData({
    kind: 'deal_proposal',
    body: '',
    payload,
  });

  const receiptId = `deal-proposal:${proposal.proposalId.toLowerCase()}`;
  return repo.createReceiptMessage(
    proposal,
    receiptId,
    validated.payload as SynqDealProposalPayload,
    participantA,
    participantB,
  );
}

export type { DealProposalRow, NewDealProposalRow, PersistedMilestoneV2 };
