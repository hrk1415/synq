/**
 * Synq Premium Protection Committee Database & Verification Layer (Phase 3D.3)
 *
 * Implements authenticated, transaction-safe database persistence and on-chain verification
 * for Protection Committee claim reviews, canonical decision reports, 2-of-3 EIP-712 typed-data
 * authorizations, signature collection, and idempotent execution reconciliation.
 */

import { isAddress, getAddress, decodeEventLog } from 'viem';
import { getDb } from '@/db';
import {
  protectionClaimDecisions,
  protectionClaimSignatures,
  protectionClaims,
  type ProtectionClaimDecisionRow,
  type NewProtectionClaimDecisionRow,
  type ProtectionClaimSignatureRow,
  type NewProtectionClaimSignatureRow,
  type ProtectionDecisionStatus,
  type ProtectionClaimRow,
} from '@/db/schema';
import { SEPOLIA_CHAIN_ID, getSynqPremiumConfig } from '@/lib/contracts/addresses';
import {
  ProtectionCommitteeDecision,
  normalizeProtectionDecisionReport,
  hashProtectionDecisionReport,
  getProtectionClaimDecisionTypedData,
  hashProtectionClaimDecisionAuth,
  recoverProtectionDecisionSigner,
  verifyProtectionThresholdBundle,
  formatSubmitClaimDecisionTx,
  computeDecisionNonceKey,
  synqProtectionCommitteeFullABI,
  CANONICAL_PROTECTION_COMMITTEE_SEPOLIA,
  CANONICAL_PROTECTION_MANAGER_V1_1_SEPOLIA,
  DEFAULT_PROTECTION_DECISION_EXPIRATION_SECONDS,
  UINT64_MAX,
  serializeProtectionDecisionTypedDataForJson,
  serializeProtectionThresholdBundleForJson,
  type ProtectionClaimDecisionAuthData,
  type VerifiedProtectionThresholdBundle,
  type CanonicalProtectionDecisionReportV1,
} from '@/lib/deals/v2-protection-committee';
import { checkCommitteeSignerStatus } from '@/lib/deals/v2-committee-signer';
import { sepoliaPublicClient } from '@/lib/chain';
import { and, eq, desc, sql, inArray } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

export class ProtectionCommitteeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectionCommitteeAuthError';
  }
}

export class ProtectionCommitteeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectionCommitteeValidationError';
  }
}

export class ProtectionCommitteeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectionCommitteeConflictError';
  }
}

export class ProtectionCommitteeIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectionCommitteeIntegrityError';
  }
}

export class ProtectionCommitteeExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectionCommitteeExpiredError';
  }
}

export class ProtectionCommitteeInvalidatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectionCommitteeInvalidatedError';
  }
}

export class ProtectionCommitteeExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectionCommitteeExecutionError';
  }
}

// ---------------------------------------------------------------------------
// Manager Contract Read ABIs
// ---------------------------------------------------------------------------

export const synqProtectionManagerClaimABI = [
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
    anonymous: false,
    inputs: [
      { indexed: true, name: 'deal', type: 'address' },
      { indexed: true, name: 'milestoneId', type: 'uint256' },
      { indexed: false, name: 'payout', type: 'uint256' },
      { indexed: false, name: 'decisionReportHash', type: 'bytes32' },
    ],
    name: 'ClaimApproved',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'deal', type: 'address' },
      { indexed: true, name: 'milestoneId', type: 'uint256' },
      { indexed: false, name: 'decisionReportHash', type: 'bytes32' },
    ],
    name: 'ClaimRejected',
    type: 'event',
  },
] as const;

// ---------------------------------------------------------------------------
// Repository Pattern
// ---------------------------------------------------------------------------

export interface IProtectionClaimDecisionRepository {
  getDecisionById(id: string): Promise<ProtectionClaimDecisionRow | null>;

  getActiveDecision(
    chainId: number,
    managerAddress: string,
    dealAddress: string,
    milestoneId: number
  ): Promise<ProtectionClaimDecisionRow | null>;

  getDecisionByNonce(
    chainId: number,
    managerAddress: string,
    dealAddress: string,
    milestoneId: number,
    nonce: string
  ): Promise<ProtectionClaimDecisionRow | null>;

  getMaxNonce(
    chainId: number,
    managerAddress: string,
    dealAddress: string,
    milestoneId: number
  ): Promise<bigint | null>;

  listDecisionsByMilestone(
    chainId: number,
    dealAddress: string,
    milestoneId: number
  ): Promise<ProtectionClaimDecisionRow[]>;

  listExecutedDecisions(limit?: number, offset?: number): Promise<ProtectionClaimDecisionRow[]>;

  countExecutedDecisions(): Promise<number>;

  createDecision(row: NewProtectionClaimDecisionRow): Promise<ProtectionClaimDecisionRow>;

  updateDecisionStatus(
    id: string,
    status: ProtectionDecisionStatus
  ): Promise<ProtectionClaimDecisionRow>;

  updateDecisionExecution(
    id: string,
    data: {
      executionTxHash: string;
      executedByWallet: string | null;
      executedAt: Date | null;
      status: 'executed';
    }
  ): Promise<ProtectionClaimDecisionRow>;

  getSignaturesByDecisionId(decisionId: string): Promise<ProtectionClaimSignatureRow[]>;

  createSignature(row: NewProtectionClaimSignatureRow): Promise<ProtectionClaimSignatureRow>;

  getSignerSignature(
    decisionId: string,
    signerWallet: string
  ): Promise<ProtectionClaimSignatureRow | null>;
}

export class DrizzleProtectionClaimDecisionRepository
  implements IProtectionClaimDecisionRepository
{
  async getDecisionById(id: string): Promise<ProtectionClaimDecisionRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(protectionClaimDecisions)
      .where(eq(protectionClaimDecisions.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async getActiveDecision(
    chainId: number,
    managerAddress: string,
    dealAddress: string,
    milestoneId: number
  ): Promise<ProtectionClaimDecisionRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(protectionClaimDecisions)
      .where(
        and(
          eq(protectionClaimDecisions.chainId, chainId),
          eq(protectionClaimDecisions.managerAddress, managerAddress.toLowerCase()),
          eq(protectionClaimDecisions.dealAddress, dealAddress.toLowerCase()),
          eq(protectionClaimDecisions.milestoneId, milestoneId),
          inArray(protectionClaimDecisions.status, ['collecting', 'threshold_ready'])
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async getDecisionByNonce(
    chainId: number,
    managerAddress: string,
    dealAddress: string,
    milestoneId: number,
    nonce: string
  ): Promise<ProtectionClaimDecisionRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(protectionClaimDecisions)
      .where(
        and(
          eq(protectionClaimDecisions.chainId, chainId),
          eq(protectionClaimDecisions.managerAddress, managerAddress.toLowerCase()),
          eq(protectionClaimDecisions.dealAddress, dealAddress.toLowerCase()),
          eq(protectionClaimDecisions.milestoneId, milestoneId),
          eq(protectionClaimDecisions.decisionNonce, nonce)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async getMaxNonce(
    chainId: number,
    managerAddress: string,
    dealAddress: string,
    milestoneId: number
  ): Promise<bigint | null> {
    const db = getDb();
    const rows = await db
      .select({ maxNonce: sql<string>`MAX(${protectionClaimDecisions.decisionNonce})` })
      .from(protectionClaimDecisions)
      .where(
        and(
          eq(protectionClaimDecisions.chainId, chainId),
          eq(protectionClaimDecisions.managerAddress, managerAddress.toLowerCase()),
          eq(protectionClaimDecisions.dealAddress, dealAddress.toLowerCase()),
          eq(protectionClaimDecisions.milestoneId, milestoneId)
        )
      );
    const raw = rows[0]?.maxNonce;
    return raw ? BigInt(raw) : null;
  }

  async listDecisionsByMilestone(
    chainId: number,
    dealAddress: string,
    milestoneId: number
  ): Promise<ProtectionClaimDecisionRow[]> {
    const db = getDb();
    return await db
      .select()
      .from(protectionClaimDecisions)
      .where(
        and(
          eq(protectionClaimDecisions.chainId, chainId),
          eq(protectionClaimDecisions.dealAddress, dealAddress.toLowerCase()),
          eq(protectionClaimDecisions.milestoneId, milestoneId)
        )
      )
      .orderBy(desc(protectionClaimDecisions.createdAt));
  }

  async listExecutedDecisions(limit = 50, offset = 0): Promise<ProtectionClaimDecisionRow[]> {
    const db = getDb();
    return await db
      .select()
      .from(protectionClaimDecisions)
      .where(eq(protectionClaimDecisions.status, 'executed'))
      .orderBy(desc(protectionClaimDecisions.executedAt), desc(protectionClaimDecisions.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async countExecutedDecisions(): Promise<number> {
    const db = getDb();
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(protectionClaimDecisions)
      .where(eq(protectionClaimDecisions.status, 'executed'));
    return Number(rows[0]?.count || 0);
  }

  async createDecision(
    row: NewProtectionClaimDecisionRow
  ): Promise<ProtectionClaimDecisionRow> {
    const db = getDb();
    const inserted = await db.insert(protectionClaimDecisions).values(row).returning();
    return inserted[0];
  }

  async updateDecisionStatus(
    id: string,
    status: ProtectionDecisionStatus
  ): Promise<ProtectionClaimDecisionRow> {
    const db = getDb();
    const updated = await db
      .update(protectionClaimDecisions)
      .set({ status, updatedAt: new Date() })
      .where(eq(protectionClaimDecisions.id, id))
      .returning();
    return updated[0];
  }

  async updateDecisionExecution(
    id: string,
    data: {
      executionTxHash: string;
      executedByWallet: string | null;
      executedAt: Date | null;
      status: 'executed';
    }
  ): Promise<ProtectionClaimDecisionRow> {
    const db = getDb();
    const updated = await db
      .update(protectionClaimDecisions)
      .set({
        executionTxHash: data.executionTxHash.toLowerCase(),
        executedByWallet: data.executedByWallet ? data.executedByWallet.toLowerCase() : null,
        executedAt: data.executedAt,
        status: data.status,
        updatedAt: new Date(),
      })
      .where(eq(protectionClaimDecisions.id, id))
      .returning();
    return updated[0];
  }

  async getSignaturesByDecisionId(
    decisionId: string
  ): Promise<ProtectionClaimSignatureRow[]> {
    const db = getDb();
    return await db
      .select()
      .from(protectionClaimSignatures)
      .where(eq(protectionClaimSignatures.decisionId, decisionId))
      .orderBy(protectionClaimSignatures.createdAt);
  }

  async createSignature(
    row: NewProtectionClaimSignatureRow
  ): Promise<ProtectionClaimSignatureRow> {
    const db = getDb();
    const inserted = await db.insert(protectionClaimSignatures).values(row).returning();
    return inserted[0];
  }

  async getSignerSignature(
    decisionId: string,
    signerWallet: string
  ): Promise<ProtectionClaimSignatureRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(protectionClaimSignatures)
      .where(
        and(
          eq(protectionClaimSignatures.decisionId, decisionId),
          eq(protectionClaimSignatures.signerWallet, signerWallet.toLowerCase())
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Business Services
// ---------------------------------------------------------------------------

/**
 * Lists confirmed client claims awaiting committee decisions.
 * Only returns claims that remain in on-chain status 'Submitted' (1).
 */
export async function listPendingProtectionClaims(params: {
  callerWallet: string;
  chainId?: number;
  publicClient?: any;
  repo?: IProtectionClaimDecisionRepository;
}): Promise<
  Array<{
    claim: ProtectionClaimRow;
    onChainStatus: number;
    activeDecision: ProtectionClaimDecisionRow | null;
    signatureCount: number;
  }>
> {
  const caller = params.callerWallet.toLowerCase();
  const chainId = params.chainId ?? SEPOLIA_CHAIN_ID;
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleProtectionClaimDecisionRepository();

  if (!isAddress(caller)) {
    throw new ProtectionCommitteeAuthError('Invalid caller wallet address');
  }

  // Verify caller is active Protection Committee signer
  const signerStatus = await checkCommitteeSignerStatus(caller, client);
  if (!signerStatus.isProtectionSigner) {
    throw new ProtectionCommitteeAuthError('Caller is not an authorized Protection Committee signer');
  }

  const db = getDb();
  // Fetch all confirmed claims
  const confirmedClaims = await db
    .select()
    .from(protectionClaims)
    .where(and(eq(protectionClaims.chainId, chainId), eq(protectionClaims.status, 'confirmed')))
    .orderBy(desc(protectionClaims.submittedAt));

  const results: Array<{
    claim: ProtectionClaimRow;
    onChainStatus: number;
    activeDecision: ProtectionClaimDecisionRow | null;
    signatureCount: number;
  }> = [];

  for (const claim of confirmedClaims) {
    try {
      const rawClaim = (await client.readContract({
        address: getAddress(claim.managerAddress),
        abi: synqProtectionManagerClaimABI,
        functionName: 'getClaim',
        args: [getAddress(claim.dealAddress), BigInt(claim.milestoneId)],
      })) as { status: number };

      const onChainStatus = Number(rawClaim.status);

      // Only interested in claims currently Submitted (1) or actively being decided
      const activeDecision = await repo.getActiveDecision(
        chainId,
        claim.managerAddress,
        claim.dealAddress,
        claim.milestoneId
      );

      let signatureCount = 0;
      if (activeDecision) {
        const sigs = await repo.getSignaturesByDecisionId(activeDecision.id);
        signatureCount = sigs.length;
      }

      if (onChainStatus === 1 || activeDecision) {
        results.push({
          claim,
          onChainStatus,
          activeDecision,
          signatureCount,
        });
      }
    } catch (err) {
      console.warn(`[listPendingProtectionClaims] Error reading claim for deal ${claim.dealAddress} ms ${claim.milestoneId}:`, err);
    }
  }

  return results;
}

/**
 * Retrieves specific claim details, on-chain state, and private evidence.
 * Restricted to verified Protection Committee signers and the deal client.
 */
export async function getProtectionClaimDetail(params: {
  dealAddress: string;
  milestoneId: number;
  callerWallet: string;
  chainId?: number;
  publicClient?: any;
  repo?: IProtectionClaimDecisionRepository;
}): Promise<{
  claim: ProtectionClaimRow;
  onChainClaim: {
    status: number;
    milestoneId: number;
    milestoneAmount: string;
    evidenceHash: string;
    decisionReportHash: string;
    submittedAt: number;
    resolvedAt: number;
    payout: string;
  };
  activeDecision:
    | (ProtectionClaimDecisionRow & { signatures: ProtectionClaimSignatureRow[] })
    | null;
  executedDecision?:
    | (ProtectionClaimDecisionRow & { signatures: ProtectionClaimSignatureRow[] })
    | null;
}> {
  const chainId = params.chainId ?? SEPOLIA_CHAIN_ID;
  const dealAddress = params.dealAddress.toLowerCase();
  const caller = params.callerWallet.toLowerCase();
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleProtectionClaimDecisionRepository();

  if (!isAddress(dealAddress) || !isAddress(caller)) {
    throw new ProtectionCommitteeValidationError('Invalid deal or caller address');
  }

  const db = getDb();
  const claimRows = await db
    .select()
    .from(protectionClaims)
    .where(
      and(
        eq(protectionClaims.chainId, chainId),
        eq(protectionClaims.dealAddress, dealAddress),
        eq(protectionClaims.milestoneId, params.milestoneId)
      )
    )
    .limit(1);

  const claim = claimRows[0];
  if (!claim) {
    throw new ProtectionCommitteeValidationError('Protection claim not found');
  }

  // Authorization check: client or active Protection Committee signer
  const isClient = caller === claim.clientWallet.toLowerCase();
  const signerStatus = await checkCommitteeSignerStatus(caller, client);
  const isSigner = signerStatus.isProtectionSigner;

  if (!isClient && !isSigner) {
    throw new ProtectionCommitteeAuthError(
      'Unauthorized: claim details and evidence are restricted to the client and Protection Committee signers'
    );
  }

  // Read on-chain claim
  const rawClaim = (await client.readContract({
    address: getAddress(claim.managerAddress),
    abi: synqProtectionManagerClaimABI,
    functionName: 'getClaim',
    args: [getAddress(dealAddress), BigInt(params.milestoneId)],
  })) as any;

  const onChainClaim = {
    status: Number(rawClaim.status),
    milestoneId: Number(rawClaim.milestoneId),
    milestoneAmount: String(rawClaim.milestoneAmount),
    evidenceHash: String(rawClaim.evidenceHash).toLowerCase(),
    decisionReportHash: String(rawClaim.decisionReportHash).toLowerCase(),
    submittedAt: Number(rawClaim.submittedAt),
    resolvedAt: Number(rawClaim.resolvedAt),
    payout: String(rawClaim.payout),
  };

  // Get active decision if any
  const activeDecisionRow = await repo.getActiveDecision(
    chainId,
    claim.managerAddress,
    dealAddress,
    params.milestoneId
  );

  let activeDecisionWithSigs:
    | (ProtectionClaimDecisionRow & { signatures: ProtectionClaimSignatureRow[] })
    | null = null;

  if (activeDecisionRow) {
    const sigs = await repo.getSignaturesByDecisionId(activeDecisionRow.id);
    activeDecisionWithSigs = {
      ...activeDecisionRow,
      signatures: sigs,
    };
  }

  // Get executed decision if any
  const executedDecisions = await db
    .select()
    .from(protectionClaimDecisions)
    .where(
      and(
        eq(protectionClaimDecisions.chainId, chainId),
        eq(protectionClaimDecisions.dealAddress, dealAddress),
        eq(protectionClaimDecisions.milestoneId, params.milestoneId),
        eq(protectionClaimDecisions.status, 'executed')
      )
    )
    .orderBy(desc(protectionClaimDecisions.executedAt), desc(protectionClaimDecisions.createdAt))
    .limit(1);

  let executedDecisionWithSigs:
    | (ProtectionClaimDecisionRow & { signatures: ProtectionClaimSignatureRow[] })
    | null = null;

  if (executedDecisions[0]) {
    const sigs = await repo.getSignaturesByDecisionId(executedDecisions[0].id);
    executedDecisionWithSigs = {
      ...executedDecisions[0],
      signatures: sigs,
    };
  }

  return {
    claim,
    onChainClaim,
    activeDecision: activeDecisionWithSigs,
    executedDecision: executedDecisionWithSigs,
  };
}

/**
 * Creates a new decision draft with a canonical written report and EIP-712 typed-data commitment.
 * Enforces:
 * - Caller is an active on-chain Protection Committee signer.
 * - Claim is confirmed and on-chain status is Submitted (1).
 * - No active decision already exists for this claim.
 * - Rationale length and decision validity (Approve or Reject).
 * - Nonce uniqueness (checks both DB and on-chain usedDecisionNonces).
 */
export async function createProtectionDecisionDraft(params: {
  dealAddress: string;
  milestoneId: number;
  decision: number | 'APPROVE' | 'REJECT';
  rationale: string;
  callerWallet: string;
  chainId?: number;
  customNonce?: bigint;
  validUntilSeconds?: bigint;
  publicClient?: any;
  repo?: IProtectionClaimDecisionRepository;
}): Promise<{
  decision: ProtectionClaimDecisionRow;
  typedData: any;
  typedDataHash: `0x${string}`;
}> {
  const chainId = params.chainId ?? SEPOLIA_CHAIN_ID;
  const dealAddress = params.dealAddress.toLowerCase();
  const caller = params.callerWallet.toLowerCase();
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleProtectionClaimDecisionRepository();

  if (!isAddress(dealAddress) || !isAddress(caller)) {
    throw new ProtectionCommitteeValidationError('Invalid deal or caller address');
  }

  // 1. Authoritative signer check
  const signerStatus = await checkCommitteeSignerStatus(caller, client);
  if (!signerStatus.isProtectionSigner) {
    throw new ProtectionCommitteeAuthError('Caller is not an authorized Protection Committee signer');
  }

  // 2. Fetch confirmed claim record
  const db = getDb();
  const claimRows = await db
    .select()
    .from(protectionClaims)
    .where(
      and(
        eq(protectionClaims.chainId, chainId),
        eq(protectionClaims.dealAddress, dealAddress),
        eq(protectionClaims.milestoneId, params.milestoneId)
      )
    )
    .limit(1);

  const claim = claimRows[0];
  if (!claim) {
    throw new ProtectionCommitteeValidationError('Protection claim not found');
  }

  const managerAddress = claim.managerAddress.toLowerCase();
  const committeeAddress = (
    getSynqPremiumConfig().committee || CANONICAL_PROTECTION_COMMITTEE_SEPOLIA
  ).toLowerCase() as `0x${string}`;

  // 3. Verify on-chain claim status is Submitted (1)
  const rawClaim = (await client.readContract({
    address: getAddress(managerAddress),
    abi: synqProtectionManagerClaimABI,
    functionName: 'getClaim',
    args: [getAddress(dealAddress), BigInt(params.milestoneId)],
  })) as { status: number; evidenceHash: `0x${string}` };

  if (Number(rawClaim.status) !== 1) {
    throw new ProtectionCommitteeConflictError(
      `Cannot create decision: on-chain claim is not in Submitted status (status: ${rawClaim.status})`
    );
  }

  const onChainEvidenceHash = String(rawClaim.evidenceHash).toLowerCase();
  if (onChainEvidenceHash !== claim.evidenceHash.toLowerCase()) {
    throw new ProtectionCommitteeIntegrityError(
      `On-chain claim evidence hash (${onChainEvidenceHash}) does not match stored claim evidence (${claim.evidenceHash})`
    );
  }

  // 4. Parse and validate decision
  let decisionEnum: ProtectionCommitteeDecision;
  if (typeof params.decision === 'number') {
    decisionEnum =
      params.decision === 1
        ? ProtectionCommitteeDecision.Approve
        : params.decision === 2
          ? ProtectionCommitteeDecision.Reject
          : ProtectionCommitteeDecision.None;
  } else {
    const normalizedStr = String(params.decision).trim().toUpperCase();
    decisionEnum =
      normalizedStr === 'APPROVE'
        ? ProtectionCommitteeDecision.Approve
        : normalizedStr === 'REJECT'
          ? ProtectionCommitteeDecision.Reject
          : ProtectionCommitteeDecision.None;
  }

  if (
    decisionEnum !== ProtectionCommitteeDecision.Approve &&
    decisionEnum !== ProtectionCommitteeDecision.Reject
  ) {
    throw new ProtectionCommitteeValidationError('Decision must be either APPROVE (1) or REJECT (2)');
  }

  // 5. Build and validate canonical decision report
  const rawReport: CanonicalProtectionDecisionReportV1 = {
    schemaVersion: 1,
    chainId,
    committeeAddress: getAddress(committeeAddress),
    managerAddress: getAddress(managerAddress),
    dealAddress: getAddress(dealAddress),
    milestoneId: params.milestoneId,
    claimEvidenceHash: claim.evidenceHash.toLowerCase() as `0x${string}`,
    decision: decisionEnum === ProtectionCommitteeDecision.Approve ? 'APPROVE' : 'REJECT',
    rationale: params.rationale,
    authorSigner: getAddress(caller),
  };

  const normalizedReport = normalizeProtectionDecisionReport(rawReport);
  const decisionReportHash = hashProtectionDecisionReport(normalizedReport);

  // 6. Check for existing active draft — handle identical draft retry idempotently
  const activeDecision = await repo.getActiveDecision(
    chainId,
    managerAddress,
    dealAddress,
    params.milestoneId
  );
  if (activeDecision) {
    if (activeDecision.decisionReportHash.toLowerCase() === decisionReportHash.toLowerCase()) {
      return {
        decision: activeDecision,
        typedData: activeDecision.typedData,
        typedDataHash: activeDecision.typedDataHash as `0x${string}`,
      };
    }
    throw new ProtectionCommitteeConflictError(
      `An active decision draft (${activeDecision.id}) already exists for this claim in status "${activeDecision.status}"`
    );
  }

  // 7. Nonce calculation, bounded collision avoidance and persistence
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validUntil =
    now + (params.validUntilSeconds ?? DEFAULT_PROTECTION_DECISION_EXPIRATION_SECONDS);

  if (validUntil > UINT64_MAX) {
    throw new ProtectionCommitteeValidationError('validUntil exceeds uint64 bounds');
  }

  let candidateNonce: bigint;
  if (params.customNonce !== undefined) {
    candidateNonce = params.customNonce;
    if (candidateNonce < 0n || candidateNonce > UINT64_MAX) {
      throw new ProtectionCommitteeValidationError('Decision nonce exceeds uint64 bounds');
    }
  } else {
    const maxNonce = await repo.getMaxNonce(chainId, managerAddress, dealAddress, params.milestoneId);
    candidateNonce = maxNonce !== null ? maxNonce + 1n : 1n;
  }

  const MAX_RETRIES = 5;
  let attempt = 0;
  let finalDecision: ProtectionClaimDecisionRow | null = null;
  let finalTypedData: any = null;
  let finalTypedDataHash: `0x${string}` = '0x';

  while (attempt < MAX_RETRIES) {
    attempt++;

    // 1. Check on-chain usedDecisionNonces
    const nonceKey = computeDecisionNonceKey({
      manager: managerAddress,
      deal: dealAddress,
      milestoneId: params.milestoneId,
      decisionNonce: candidateNonce,
    });

    const isNonceUsedOnChain = (await client.readContract({
      address: getAddress(committeeAddress),
      abi: synqProtectionCommitteeFullABI,
      functionName: 'usedDecisionNonces',
      args: [nonceKey],
    })) as boolean;

    if (isNonceUsedOnChain) {
      if (params.customNonce !== undefined) {
        throw new ProtectionCommitteeConflictError(
          `Custom decision nonce ${candidateNonce} has already been used on-chain for this claim`
        );
      }
      candidateNonce++;
      continue;
    }

    // 2. Check local DB nonce
    const existingNonceRow = await repo.getDecisionByNonce(
      chainId,
      managerAddress,
      dealAddress,
      params.milestoneId,
      candidateNonce.toString()
    );
    if (existingNonceRow) {
      if (params.customNonce !== undefined) {
        throw new ProtectionCommitteeConflictError(
          `Custom decision nonce ${candidateNonce} already exists in database for this claim`
        );
      }
      candidateNonce++;
      continue;
    }

    // 3. Build EIP-712 typed data
    const authData: ProtectionClaimDecisionAuthData = {
      committee: getAddress(committeeAddress),
      chainId: BigInt(chainId),
      manager: getAddress(managerAddress),
      deal: getAddress(dealAddress),
      milestoneId: BigInt(params.milestoneId),
      decision: Number(decisionEnum),
      decisionReportHash,
      decisionNonce: candidateNonce,
      validUntil,
    };

    const typedData = getProtectionClaimDecisionTypedData({ auth: authData });
    const typedDataHash = hashProtectionClaimDecisionAuth(authData);
    const jsonSafeTypedData = serializeProtectionDecisionTypedDataForJson(typedData);

    const newRow: NewProtectionClaimDecisionRow = {
      claimId: claim.id,
      chainId,
      committeeAddress: committeeAddress.toLowerCase(),
      managerAddress: managerAddress.toLowerCase(),
      dealAddress: dealAddress.toLowerCase(),
      milestoneId: params.milestoneId,
      claimEvidenceHash: claim.evidenceHash.toLowerCase(),
      decision: Number(decisionEnum),
      decisionNonce: candidateNonce.toString(),
      validUntil: validUntil.toString(),
      decisionReportHash: decisionReportHash.toLowerCase(),
      canonicalReport: normalizedReport as unknown as Record<string, unknown>,
      typedData: jsonSafeTypedData as unknown as Record<string, unknown>,
      typedDataHash: typedDataHash.toLowerCase(),
      status: 'collecting',
      createdBySigner: caller.toLowerCase(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    try {
      finalDecision = await repo.createDecision(newRow);
      finalTypedData = jsonSafeTypedData;
      finalTypedDataHash = typedDataHash;
      break;
    } catch (insertErr: any) {
      const errMsg = String(insertErr?.message || '');
      if (errMsg.includes('uq_prot_dec_active_claim')) {
        const concurrentActive = await repo.getActiveDecision(
          chainId,
          managerAddress,
          dealAddress,
          params.milestoneId
        );
        if (
          concurrentActive &&
          concurrentActive.decisionReportHash.toLowerCase() === decisionReportHash.toLowerCase()
        ) {
          return {
            decision: concurrentActive,
            typedData: concurrentActive.typedData,
            typedDataHash: concurrentActive.typedDataHash as `0x${string}`,
          };
        }
        throw new ProtectionCommitteeConflictError(
          'An active decision draft was created concurrently for this claim'
        );
      }
      if (errMsg.includes('uq_prot_dec_nonce')) {
        if (params.customNonce !== undefined) {
          throw new ProtectionCommitteeConflictError(
            `Decision nonce ${candidateNonce} collided concurrently`
          );
        }
        candidateNonce++;
        continue;
      }
      throw insertErr;
    }
  }

  if (!finalDecision || !finalTypedData) {
    throw new ProtectionCommitteeConflictError(
      'Unable to allocate an unused decision nonce after multiple attempts. Please retry.'
    );
  }

  return {
    decision: finalDecision,
    typedData: finalTypedData,
    typedDataHash: finalTypedDataHash,
  };
}

/**
 * Submits an authorized EIP-712 signer signature for an active decision.
 * Enforces:
 * - Signer is verified active on-chain Protection Committee member.
 * - Decision status is 'collecting'.
 * - Decision has not expired or been used on-chain.
 * - Signature recovers to the submitted signer wallet against the stored immutable typed data.
 * - Prevents duplicate signatures from the same signer.
 * - If threshold (2) distinct signatures reached, advances status to 'threshold_ready'.
 */
export async function submitProtectionDecisionSignature(params: {
  decisionId: string;
  signature: `0x${string}`;
  signerWallet: string;
  chainId?: number;
  publicClient?: any;
  repo?: IProtectionClaimDecisionRepository;
}): Promise<{
  signature: ProtectionClaimSignatureRow;
  decisionStatus: ProtectionDecisionStatus;
  thresholdMet: boolean;
  thresholdBundle?: ReturnType<typeof serializeProtectionThresholdBundleForJson>;
}> {
  const chainId = params.chainId ?? SEPOLIA_CHAIN_ID;
  const signer = params.signerWallet.toLowerCase();
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleProtectionClaimDecisionRepository();

  if (!isAddress(signer)) {
    throw new ProtectionCommitteeValidationError('Invalid signer wallet address');
  }

  if (!/^0x[0-9a-fA-F]{130}$/.test(params.signature)) {
    throw new ProtectionCommitteeValidationError('Invalid signature format: must be 65-byte hex');
  }

  const decision = await repo.getDecisionById(params.decisionId);
  if (!decision) {
    throw new ProtectionCommitteeValidationError('Protection claim decision not found');
  }

  if (decision.status !== 'collecting') {
    throw new ProtectionCommitteeConflictError(
      `Cannot submit signature: decision status is "${decision.status}" (must be "collecting")`
    );
  }

  // 1. Authoritative on-chain signer check
  const signerStatus = await checkCommitteeSignerStatus(signer, client);
  if (!signerStatus.isProtectionSigner) {
    throw new ProtectionCommitteeAuthError('Signer is not an authorized Protection Committee member');
  }

  // 2. Check on-chain claim status remains Submitted
  const rawClaim = (await client.readContract({
    address: getAddress(decision.managerAddress),
    abi: synqProtectionManagerClaimABI,
    functionName: 'getClaim',
    args: [getAddress(decision.dealAddress), BigInt(decision.milestoneId)],
  })) as { status: number };

  if (Number(rawClaim.status) !== 1) {
    await repo.updateDecisionStatus(decision.id, 'invalidated');
    throw new ProtectionCommitteeInvalidatedError(
      'Claim status on-chain is no longer Submitted; decision draft has been invalidated'
    );
  }

  // 3. Expiry check
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validUntil = BigInt(decision.validUntil);
  if (now > validUntil) {
    await repo.updateDecisionStatus(decision.id, 'expired');
    throw new ProtectionCommitteeExpiredError('Authorization validity window has expired');
  }

  // 4. Nonce reuse check
  const nonceKey = computeDecisionNonceKey({
    manager: decision.managerAddress,
    deal: decision.dealAddress,
    milestoneId: decision.milestoneId,
    decisionNonce: BigInt(decision.decisionNonce),
  });

  const isNonceUsed = (await client.readContract({
    address: getAddress(decision.committeeAddress),
    abi: synqProtectionCommitteeFullABI,
    functionName: 'usedDecisionNonces',
    args: [nonceKey],
  })) as boolean;

  if (isNonceUsed) {
    await repo.updateDecisionStatus(decision.id, 'invalidated');
    throw new ProtectionCommitteeConflictError('Decision nonce was already used on-chain');
  }

  // 5. Build auth data for verification and threshold checking
  const authData: ProtectionClaimDecisionAuthData = {
    committee: getAddress(decision.committeeAddress),
    chainId: BigInt(decision.chainId),
    manager: getAddress(decision.managerAddress),
    deal: getAddress(decision.dealAddress),
    milestoneId: BigInt(decision.milestoneId),
    decision: decision.decision,
    decisionReportHash: decision.decisionReportHash as `0x${string}`,
    decisionNonce: BigInt(decision.decisionNonce),
    validUntil: BigInt(decision.validUntil),
  };

  // 6. Existing signature check — handle idempotent retries safely without creating duplicate rows
  let targetSig = await repo.getSignerSignature(decision.id, signer);

  if (!targetSig) {
    // Cryptographic signature recovery against the stored immutable typed data
    const recoveredSigner = await recoverProtectionDecisionSigner({
      auth: authData,
      signature: params.signature,
    });

    if (recoveredSigner.toLowerCase() !== signer) {
      throw new ProtectionCommitteeIntegrityError(
        `Recovered signer (${recoveredSigner}) does not match submitted signer wallet (${signer})`
      );
    }

    // Persist new signature
    targetSig = await repo.createSignature({
      decisionId: decision.id,
      signerWallet: signer,
      signature: params.signature,
      createdAt: new Date(),
    });
  }

  // 7. Threshold evaluation
  const allSigs = await repo.getSignaturesByDecisionId(decision.id);
  const distinctSigners = new Set(allSigs.map((s) => s.signerWallet.toLowerCase()));

  let updatedStatus: ProtectionDecisionStatus = decision.status as ProtectionDecisionStatus;
  let thresholdBundle: ReturnType<typeof serializeProtectionThresholdBundleForJson> | undefined;

  if (distinctSigners.size >= 2) {
    updatedStatus = 'threshold_ready';
    await repo.updateDecisionStatus(decision.id, 'threshold_ready');

    const [first, second] = allSigs;
    const rawBundle = await verifyProtectionThresholdBundle({
      auth: authData,
      signatures: [first.signature as `0x${string}`, second.signature as `0x${string}`],
      currentTimestampSeconds: now,
    });
    thresholdBundle = serializeProtectionThresholdBundleForJson(rawBundle);
  }

  return {
    signature: targetSig,
    decisionStatus: updatedStatus,
    thresholdMet: distinctSigners.size >= 2,
    thresholdBundle,
  };
}

/**
 * Verifies that a transaction receipt contains valid and consistent events from both
 * the Protection Committee and Protection Manager contracts.
 */
function verifyProtectionDecisionReceipt(params: {
  receipt: any;
  decision: ProtectionClaimDecisionRow;
}) {
  const { receipt, decision } = params;
  if (!receipt || receipt.status !== 'success') {
    throw new ProtectionCommitteeExecutionError('Transaction receipt not found or status is not success');
  }

  const expectedCommittee = getAddress(decision.committeeAddress);
  const expectedManager = getAddress(decision.managerAddress);
  const expectedDeal = getAddress(decision.dealAddress);

  if (!receipt.to || getAddress(receipt.to) !== expectedCommittee) {
    throw new ProtectionCommitteeIntegrityError(
      `Transaction target (${receipt.to}) does not match authorized Protection Committee (${expectedCommittee})`
    );
  }

  // 1. Verify ClaimDecisionSubmitted event on Protection Committee contract
  let matchedCommitteeEvent = false;
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

      if (
        decoded.eventName === 'ClaimDecisionSubmitted' &&
        getAddress(decoded.args.manager) === expectedManager &&
        getAddress(decoded.args.deal) === expectedDeal &&
        Number(decoded.args.milestoneId) === decision.milestoneId &&
        Number(decoded.args.decision) === decision.decision &&
        (decoded.args.decisionReportHash as string).toLowerCase() === decision.decisionReportHash.toLowerCase() &&
        BigInt(decoded.args.decisionNonce) === BigInt(decision.decisionNonce)
      ) {
        matchedCommitteeEvent = true;
        break;
      }
    } catch {
      // Continue
    }
  }

  if (!matchedCommitteeEvent) {
    throw new ProtectionCommitteeIntegrityError(
      'Transaction receipt did not contain matching ClaimDecisionSubmitted event from Protection Committee'
    );
  }

  // 2. Verify corresponding ClaimApproved or ClaimRejected event on Protection Manager
  let matchedManagerEvent = false;
  const expectedEventName = decision.decision === 1 ? 'ClaimApproved' : 'ClaimRejected';

  for (const log of receipt.logs || []) {
    if (log.address && getAddress(log.address) !== expectedManager) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: synqProtectionManagerClaimABI,
        eventName: expectedEventName,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === expectedEventName) {
        const deal = getAddress(decoded.args.deal);
        const milestoneId = Number(decoded.args.milestoneId);
        const repHash = (decoded.args.decisionReportHash as string).toLowerCase();

        if (
          deal === expectedDeal &&
          milestoneId === decision.milestoneId &&
          repHash === decision.decisionReportHash.toLowerCase()
        ) {
          matchedManagerEvent = true;
          break;
        }
      }
    } catch {
      // Continue
    }
  }

  if (!matchedManagerEvent) {
    throw new ProtectionCommitteeIntegrityError(
      `Transaction receipt did not contain corresponding ${expectedEventName} event from Protection Manager`
    );
  }
}

/**
 * Reconciles an on-chain execution with the database decision record.
 * Mode 1: txHash provided -> verifies receipt, target committee, committee event, manager event, and on-chain claim state.
 * Mode 2: txHash omitted (crash recovery) -> bounded getLogs search on Protection Committee contract, followed by full verification.
 * Transitions decision status to 'executed'.
 */
export async function reconcileProtectionDecision(params: {
  decisionId: string;
  txHash?: string | null;
  callerWallet?: string;
  chainId?: number;
  publicClient?: any;
  repo?: IProtectionClaimDecisionRepository;
}): Promise<ProtectionClaimDecisionRow> {
  const chainId = params.chainId ?? SEPOLIA_CHAIN_ID;
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleProtectionClaimDecisionRepository();

  const decision = await repo.getDecisionById(params.decisionId);
  if (!decision) {
    throw new ProtectionCommitteeValidationError('Protection claim decision not found');
  }

  if (decision.status === 'executed') {
    return decision;
  }

  let verifiedTxHash: string | null = null;
  let executedByWallet: string | null = params.callerWallet ? params.callerWallet.toLowerCase() : null;

  if (params.txHash && /^0x[0-9a-fA-F]{64}$/.test(params.txHash)) {
    // Mode 1: Explicit tx receipt verification
    const receipt = await client.getTransactionReceipt({ hash: params.txHash as `0x${string}` });
    verifyProtectionDecisionReceipt({ receipt, decision });

    verifiedTxHash = receipt.transactionHash.toLowerCase();
    executedByWallet = receipt.from ? receipt.from.toLowerCase() : executedByWallet;
  } else {
    // Mode 2: Hash-free recovery via on-chain state and bounded getLogs
    const rawClaim = (await client.readContract({
      address: getAddress(decision.managerAddress),
      abi: synqProtectionManagerClaimABI,
      functionName: 'getClaim',
      args: [getAddress(decision.dealAddress), BigInt(decision.milestoneId)],
    })) as { status: number; decisionReportHash: `0x${string}` };

    const onChainStatus = Number(rawClaim.status);
    if (onChainStatus !== 2 && onChainStatus !== 3 && onChainStatus !== 4) {
      throw new ProtectionCommitteeExecutionError(
        `On-chain claim status is ${onChainStatus} (not Approved, Rejected, or Paid). Transaction has not executed.`
      );
    }

    const onChainReportHash = String(rawClaim.decisionReportHash).toLowerCase();
    if (onChainReportHash !== decision.decisionReportHash.toLowerCase()) {
      throw new ProtectionCommitteeIntegrityError(
        `On-chain report hash (${onChainReportHash}) does not match decision record (${decision.decisionReportHash})`
      );
    }

    // Bounded search for mined ClaimDecisionSubmitted event
    const latestBlock = await client.getBlockNumber();
    const CHUNK_SIZE = 5000n;
    const MAX_LOOKBACK = 50000n;
    const minBlock = latestBlock > MAX_LOOKBACK ? latestBlock - MAX_LOOKBACK : 0n;
    let currentTo = latestBlock;

    while (currentTo >= minBlock) {
      const currentFrom =
        currentTo >= CHUNK_SIZE && currentTo - CHUNK_SIZE + 1n >= minBlock
          ? currentTo - CHUNK_SIZE + 1n
          : minBlock;

      try {
        const chunkLogs = await client.getLogs({
          address: getAddress(decision.committeeAddress),
          abi: synqProtectionCommitteeFullABI,
          eventName: 'ClaimDecisionSubmitted',
          args: {
            manager: getAddress(decision.managerAddress),
            deal: getAddress(decision.dealAddress),
            milestoneId: BigInt(decision.milestoneId),
          },
          fromBlock: currentFrom,
          toBlock: currentTo,
        });

        if (Array.isArray(chunkLogs) && chunkLogs.length > 0) {
          for (const l of chunkLogs) {
            const repHash = String(l.args?.decisionReportHash || '').toLowerCase();
            const nonceVal = BigInt(l.args?.decisionNonce || 0);

            if (
              repHash === decision.decisionReportHash.toLowerCase() &&
              nonceVal === BigInt(decision.decisionNonce) &&
              l.transactionHash
            ) {
              verifiedTxHash = l.transactionHash.toLowerCase();
              break;
            }
          }
        }

        if (verifiedTxHash) break;
      } catch (logErr) {
        console.warn('[reconcileProtectionDecision] Chunk getLogs error:', logErr);
      }

      if (currentFrom <= minBlock) break;
      currentTo = currentFrom - 1n;
    }

    if (!verifiedTxHash) {
      throw new ProtectionCommitteeExecutionError(
        'Could not locate ClaimDecisionSubmitted event within search window. Please provide the transaction hash.'
      );
    }

    // Full verification of recovered transaction receipt
    const recoveredReceipt = await client.getTransactionReceipt({ hash: verifiedTxHash as `0x${string}` });
    verifyProtectionDecisionReceipt({ receipt: recoveredReceipt, decision });
    executedByWallet = recoveredReceipt.from ? recoveredReceipt.from.toLowerCase() : executedByWallet;
  }

  // 3. Final verification: Check on-chain claim status strictly agrees with decision
  const finalClaim = (await client.readContract({
    address: getAddress(decision.managerAddress),
    abi: synqProtectionManagerClaimABI,
    functionName: 'getClaim',
    args: [getAddress(decision.dealAddress), BigInt(decision.milestoneId)],
  })) as { status: number };

  const finalStatus = Number(finalClaim.status);
  if (decision.decision === 1) {
    // Approve: Status must be Approved (2) or Paid (4)
    if (finalStatus !== 2 && finalStatus !== 4) {
      throw new ProtectionCommitteeIntegrityError(
        `Final on-chain claim status (${finalStatus}) does not agree with Approve decision (expected 2 or 4)`
      );
    }
  } else if (decision.decision === 2) {
    // Reject: Status must be Rejected (3)
    if (finalStatus !== 3) {
      throw new ProtectionCommitteeIntegrityError(
        `Final on-chain claim status (${finalStatus}) does not agree with Reject decision (expected 3)`
      );
    }
  }

  // Update record to executed
  const executedRecord = await repo.updateDecisionExecution(decision.id, {
    executionTxHash: verifiedTxHash,
    executedByWallet,
    executedAt: new Date(),
    status: 'executed',
  });

  return executedRecord;
}

// ---------------------------------------------------------------------------
// Protection Claim Decision History
// ---------------------------------------------------------------------------

export interface ProtectionClaimHistoryItem {
  id: string; // decisionId
  dealAddress: string;
  milestoneId: number;
  clientWallet: string;
  decision: number; // 1 = Approve, 2 = Reject
  decisionLabel: 'Approved' | 'Rejected';
  approvedPayoutAmount: string | null;
  executedAt: string | null; // ISO string
  executedByWallet: string | null;
  executionTxHash: string | null;
  signatureCount: number;
  signaturesThresholdAchieved: boolean;
  signerWallets: string[];
  onChainStatus: number; // 2 = Approved, 3 = Rejected, 4 = Paid, etc.
  onChainStatusLabel: string; // 'Approved', 'Rejected', 'Paid'
  payoutOnChain: string | null;
  decisionReportHash: string;
  evidenceHash: string;
  canonicalReport: any;
}

export interface ProtectionClaimHistoryResult {
  items: ProtectionClaimHistoryItem[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

/**
 * Lists executed Protection Committee decisions with on-chain status, client addresses,
 * verified signatures, and execution transaction links.
 * Restricted to verified Protection Committee signers.
 */
export async function listProtectionClaimHistory(params: {
  callerWallet: string;
  chainId?: number;
  page?: number;
  limit?: number;
  publicClient?: any;
  repo?: IProtectionClaimDecisionRepository;
}): Promise<ProtectionClaimHistoryResult> {
  const caller = params.callerWallet.toLowerCase();
  const chainId = params.chainId ?? SEPOLIA_CHAIN_ID;
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleProtectionClaimDecisionRepository();

  if (!isAddress(caller)) {
    throw new ProtectionCommitteeAuthError('Invalid caller wallet address');
  }

  // Verify caller is active Protection Committee signer
  const signerStatus = await checkCommitteeSignerStatus(caller, client);
  if (!signerStatus.isProtectionSigner) {
    throw new ProtectionCommitteeAuthError('Caller is not an authorized Protection Committee signer');
  }

  const limit = Math.min(Math.max(1, params.limit ?? 20), 50);
  const page = Math.max(1, params.page ?? 1);
  const offset = (page - 1) * limit;

  const db = getDb();

  const totalCount = await repo.countExecutedDecisions();
  const totalPages = Math.ceil(totalCount / limit) || 1;

  const executedDecisions = await repo.listExecutedDecisions(limit, offset);

  if (executedDecisions.length === 0) {
    return {
      items: [],
      pagination: {
        total: totalCount,
        page,
        limit,
        totalPages,
      },
    };
  }

  // 1. Batch query signatures
  const decisionIds = executedDecisions.map((d) => d.id);
  const allSigs = await db
    .select()
    .from(protectionClaimSignatures)
    .where(inArray(protectionClaimSignatures.decisionId, decisionIds));

  const sigsByDecision = new Map<string, typeof allSigs>();
  for (const sig of allSigs) {
    const list = sigsByDecision.get(sig.decisionId) || [];
    list.push(sig);
    sigsByDecision.set(sig.decisionId, list);
  }

  // 2. Batch query claims to resolve clientWallet and coverageAmount
  const dealAddresses = Array.from(new Set(executedDecisions.map((d) => d.dealAddress.toLowerCase())));
  const matchingClaims = await db
    .select()
    .from(protectionClaims)
    .where(
      and(
        eq(protectionClaims.chainId, chainId),
        inArray(protectionClaims.dealAddress, dealAddresses)
      )
    );

  const claimsByKey = new Map<string, typeof matchingClaims[0]>();
  for (const c of matchingClaims) {
    claimsByKey.set(`${c.dealAddress.toLowerCase()}-${c.milestoneId}`, c);
  }

  // 3. Multicall on-chain getClaim to avoid N+1 RPC requests
  const multicallContracts = executedDecisions.map((d) => ({
    address: getAddress(d.managerAddress),
    abi: synqProtectionManagerClaimABI,
    functionName: 'getClaim',
    args: [getAddress(d.dealAddress), BigInt(d.milestoneId)],
  }));

  let multicallResults: any[] = [];
  try {
    multicallResults = await client.multicall({
      contracts: multicallContracts,
      allowFailure: true,
    });
  } catch (mcErr) {
    console.warn('[listProtectionClaimHistory] Multicall getClaim error:', mcErr);
  }

  const items: ProtectionClaimHistoryItem[] = [];

  for (let i = 0; i < executedDecisions.length; i++) {
    const dec = executedDecisions[i];
    const claimRow = claimsByKey.get(`${dec.dealAddress.toLowerCase()}-${dec.milestoneId}`);
    const sigs = sigsByDecision.get(dec.id) || [];
    const mc = multicallResults[i];

    let onChainStatus = dec.decision === 1 ? 2 : 3;
    let payoutOnChain: string | null = null;

    if (mc && mc.status === 'success' && mc.result) {
      onChainStatus = Number(mc.result.status);
      payoutOnChain = String(mc.result.payout);
    }

    let onChainStatusLabel = 'Executed';
    if (onChainStatus === 4) {
      onChainStatusLabel = 'Paid';
    } else if (onChainStatus === 2) {
      onChainStatusLabel = 'Approved';
    } else if (onChainStatus === 3) {
      onChainStatusLabel = 'Rejected';
    }

    const decisionLabel: 'Approved' | 'Rejected' = dec.decision === 1 ? 'Approved' : 'Rejected';

    let approvedPayoutAmount: string | null = null;
    if (dec.decision === 1) {
      if (payoutOnChain && payoutOnChain !== '0') {
        approvedPayoutAmount = payoutOnChain;
      } else {
        const manifest = claimRow?.canonicalManifest as any;
        if (manifest?.coverageAmount) {
          approvedPayoutAmount = String(manifest.coverageAmount);
        }
      }
    }

    const clientWallet = claimRow?.clientWallet || (dec.canonicalReport as any)?.client || '';

    items.push({
      id: dec.id,
      dealAddress: dec.dealAddress,
      milestoneId: dec.milestoneId,
      clientWallet,
      decision: dec.decision,
      decisionLabel,
      approvedPayoutAmount,
      executedAt: dec.executedAt ? dec.executedAt.toISOString() : null,
      executedByWallet: dec.executedByWallet || null,
      executionTxHash: dec.executionTxHash || null,
      signatureCount: sigs.length,
      signaturesThresholdAchieved: sigs.length >= 2,
      signerWallets: sigs.map((s) => s.signerWallet),
      onChainStatus,
      onChainStatusLabel,
      payoutOnChain,
      decisionReportHash: dec.decisionReportHash,
      evidenceHash: dec.claimEvidenceHash,
      canonicalReport: dec.canonicalReport,
    });
  }

  return {
    items,
    pagination: {
      total: totalCount,
      page,
      limit,
      totalPages,
    },
  };
}
