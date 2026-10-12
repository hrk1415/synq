import { isAddress, decodeEventLog } from 'viem';
import { getDb } from '@/db';
import { milestoneRevisions, type MilestoneRevisionRow, type NewMilestoneRevisionRow } from '@/db/schema';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import {
  readStandardV2DealData,
  DealState,
  MilestoneStatus,
  type PublicClientLike,
} from '@/lib/deals/v2-deal';
import {
  normalizeRevisionManifest,
  hashRevisionManifest,
  verifyRevisionRequestedReceipt,
  type CanonicalRevisionManifestV1,
  RevisionValidationError,
} from '@/lib/deals/v2-revision';
import { synqDealV1ABI } from '@/lib/contracts/abis';
import { sepoliaPublicClient } from '@/lib/chain';
import { and, eq } from 'drizzle-orm';

export class RevisionAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevisionAuthError';
  }
}

export class RevisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevisionConflictError';
  }
}

export class RevisionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevisionIntegrityError';
  }
}

export { RevisionValidationError };

// ---------------------------------------------------------------------------
// Repository Pattern
// ---------------------------------------------------------------------------

export interface IMilestoneRevisionRepository {
  getByMilestoneVersion(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    submissionVersion: number
  ): Promise<MilestoneRevisionRow | null>;

  create(row: NewMilestoneRevisionRow): Promise<MilestoneRevisionRow>;

  updateStaged(
    id: string,
    data: {
      reasonHash: string;
      proposedRevisionDeadline: string;
      manifest: Record<string, unknown>;
      updatedAt: Date;
    }
  ): Promise<MilestoneRevisionRow>;

  confirm(
    id: string,
    data: {
      txHash: string | null;
      requestedAt: Date;
      updatedAt: Date;
    }
  ): Promise<MilestoneRevisionRow>;
}

export class DrizzleMilestoneRevisionRepository implements IMilestoneRevisionRepository {
  async getByMilestoneVersion(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    submissionVersion: number
  ): Promise<MilestoneRevisionRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(milestoneRevisions)
      .where(
        and(
          eq(milestoneRevisions.chainId, chainId),
          eq(milestoneRevisions.dealAddress, dealAddress.toLowerCase()),
          eq(milestoneRevisions.milestoneId, milestoneId),
          eq(milestoneRevisions.submissionVersion, submissionVersion)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async create(row: NewMilestoneRevisionRow): Promise<MilestoneRevisionRow> {
    const db = getDb();
    const inserted = await db.insert(milestoneRevisions).values(row).returning();
    return inserted[0];
  }

  async updateStaged(
    id: string,
    data: {
      reasonHash: string;
      proposedRevisionDeadline: string;
      manifest: Record<string, unknown>;
      updatedAt: Date;
    }
  ): Promise<MilestoneRevisionRow> {
    const db = getDb();
    const updated = await db
      .update(milestoneRevisions)
      .set(data)
      .where(eq(milestoneRevisions.id, id))
      .returning();
    return updated[0];
  }

  async confirm(
    id: string,
    data: {
      txHash: string | null;
      requestedAt: Date;
      updatedAt: Date;
    }
  ): Promise<MilestoneRevisionRow> {
    const db = getDb();
    const updated = await db
      .update(milestoneRevisions)
      .set({
        status: 'confirmed',
        ...data,
      })
      .where(eq(milestoneRevisions.id, id))
      .returning();
    return updated[0];
  }
}

export class InMemoryMilestoneRevisionRepository implements IMilestoneRevisionRepository {
  private records = new Map<string, MilestoneRevisionRow>();

  private makeKey(chainId: number, dealAddress: string, milestoneId: number, submissionVersion: number): string {
    return `${chainId}:${dealAddress.toLowerCase()}:${milestoneId}:${submissionVersion}`;
  }

  async getByMilestoneVersion(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    submissionVersion: number
  ): Promise<MilestoneRevisionRow | null> {
    const key = this.makeKey(chainId, dealAddress, milestoneId, submissionVersion);
    return this.records.get(key) ?? null;
  }

  async create(row: NewMilestoneRevisionRow): Promise<MilestoneRevisionRow> {
    const key = this.makeKey(row.chainId, row.dealAddress, row.milestoneId, row.submissionVersion);
    if (this.records.has(key)) {
      throw new Error(`Unique constraint violation: key ${key} already exists`);
    }
    const now = new Date();
    const record: MilestoneRevisionRow = {
      id: row.id ?? crypto.randomUUID(),
      chainId: row.chainId,
      dealAddress: row.dealAddress.toLowerCase(),
      milestoneId: row.milestoneId,
      submissionVersion: row.submissionVersion,
      clientWallet: row.clientWallet.toLowerCase(),
      freelancerWallet: row.freelancerWallet.toLowerCase(),
      specHash: row.specHash.toLowerCase(),
      evidenceRootHash: row.evidenceRootHash.toLowerCase(),
      reasonHash: row.reasonHash.toLowerCase(),
      manifest: row.manifest,
      proposedRevisionDeadline: String(row.proposedRevisionDeadline),
      status: row.status ?? 'staged',
      txHash: row.txHash ?? null,
      requestedAt: row.requestedAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(key, record);
    return record;
  }

  async updateStaged(
    id: string,
    data: {
      reasonHash: string;
      proposedRevisionDeadline: string;
      manifest: Record<string, unknown>;
      updatedAt: Date;
    }
  ): Promise<MilestoneRevisionRow> {
    for (const [key, record] of this.records.entries()) {
      if (record.id === id) {
        const updated: MilestoneRevisionRow = {
          ...record,
          reasonHash: data.reasonHash.toLowerCase(),
          proposedRevisionDeadline: String(data.proposedRevisionDeadline),
          manifest: data.manifest,
          updatedAt: data.updatedAt,
        };
        this.records.set(key, updated);
        return updated;
      }
    }
    throw new Error(`Revision row ${id} not found`);
  }

  async confirm(
    id: string,
    data: {
      txHash: string | null;
      requestedAt: Date;
      updatedAt: Date;
    }
  ): Promise<MilestoneRevisionRow> {
    for (const [key, record] of this.records.entries()) {
      if (record.id === id) {
        const updated: MilestoneRevisionRow = {
          ...record,
          status: 'confirmed',
          txHash: data.txHash,
          requestedAt: data.requestedAt,
          updatedAt: data.updatedAt,
        };
        this.records.set(key, updated);
        return updated;
      }
    }
    throw new Error(`Revision row ${id} not found`);
  }

  clear() {
    this.records.clear();
  }
}

let activeRevisionRepo: IMilestoneRevisionRepository = new DrizzleMilestoneRevisionRepository();

export function setMilestoneRevisionRepository(repo: IMilestoneRevisionRepository) {
  activeRevisionRepo = repo;
}

export function resetMilestoneRevisionRepository() {
  activeRevisionRepo = new DrizzleMilestoneRevisionRepository();
}

/**
 * Stages a canonical revision request manifest in the database.
 *
 * Enforces:
 * 1. Valid normalized revision manifest schema (schemaVersion 1, feedback, bounds)
 * 2. Recomputed reasonHash matches client claimed hash (if provided)
 * 3. Authoritative on-chain deal state verification:
 *    - Deal is canonical Factory V2 Deal
 *    - Deal is Standard (isProtected === false)
 *    - DealState is Active
 *    - Caller is designated client
 *    - Target milestone is Submitted
 *    - Manifest binds current on-chain targetMilestone.version (NOT version + 1)
 *    - Manifest binds current on-chain targetMilestone.evidenceRootHash
 *    - Manifest binds current on-chain targetMilestone.specHash
 *    - Manifest binds canonical participants
 * 4. Proposed revision deadline validation:
 *    - proposedRevisionDeadline > current chain timestamp
 *    - proposedRevisionDeadline <= current chain timestamp + 365 days
 * 5. Staging lifecycle:
 *    - Staged row can be updated/replaced by the same client
 *    - Confirmed row cannot be mutated or replaced
 */
export async function stageMilestoneRevision(params: {
  rawManifest?: unknown;
  dealAddress?: string;
  milestoneId?: number;
  feedback?: string;
  proposedRevisionDeadline?: number | bigint | string;
  authWallet: string;
  claimedReasonHash?: string;
  publicClient?: PublicClientLike;
  repo?: IMilestoneRevisionRepository;
}): Promise<{
  revision: MilestoneRevisionRow;
  reasonHash: `0x${string}`;
  proposedRevisionDeadline: number;
  submissionVersion: number;
}> {
  const { rawManifest, authWallet, claimedReasonHash } = params;
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? activeRevisionRepo;

  if (!authWallet || !isAddress(authWallet)) {
    throw new RevisionAuthError('Unauthorized: valid wallet session required');
  }
  const normalizedAuthWallet = authWallet.toLowerCase();

  // Extract core parameters from rawManifest or direct arguments
  const rawObj = (rawManifest && typeof rawManifest === 'object') ? (rawManifest as Record<string, unknown>) : null;

  const targetDealAddress = (rawObj?.dealAddress as string) ?? params.dealAddress;
  if (!targetDealAddress || !isAddress(targetDealAddress)) {
    throw new RevisionValidationError('Invalid deal address');
  }
  const normalizedDeal = targetDealAddress.toLowerCase();

  const targetMilestoneId = (rawObj?.milestoneId !== undefined) ? Number(rawObj.milestoneId) : params.milestoneId;
  if (targetMilestoneId === undefined || !Number.isInteger(targetMilestoneId) || targetMilestoneId < 0) {
    throw new RevisionValidationError('Invalid milestoneId');
  }

  const rawFeedback = (rawObj?.feedback as string) ?? params.feedback;
  if (typeof rawFeedback !== 'string') {
    throw new RevisionValidationError('Feedback is required and must be a string');
  }

  const rawDeadline = rawObj?.proposedRevisionDeadline ?? params.proposedRevisionDeadline;
  const deadlineNum = Number(rawDeadline);
  if (!Number.isFinite(deadlineNum) || !Number.isInteger(deadlineNum) || deadlineNum <= 0) {
    throw new RevisionValidationError('proposedRevisionDeadline must be a positive integer Unix timestamp');
  }

  // 1. Authoritative on-chain Deal data verification
  const deal = await readStandardV2DealData(normalizedDeal, client);

  if (deal.isProtected) {
    throw new RevisionValidationError('Protected deals cannot request revision');
  }

  if (deal.state !== DealState.Active) {
    throw new RevisionValidationError(`Deal is not Active (current state: ${deal.state})`);
  }

  if (deal.client.toLowerCase() !== normalizedAuthWallet) {
    throw new RevisionAuthError('Unauthorized: Only the designated client can request revisions');
  }

  if (targetMilestoneId >= deal.milestones.length) {
    throw new RevisionValidationError(`Invalid milestoneId: ${targetMilestoneId}`);
  }

  const targetMilestone = deal.milestones[targetMilestoneId];
  if (targetMilestone.status !== MilestoneStatus.Submitted) {
    throw new RevisionValidationError(
      `Milestone ${targetMilestoneId + 1} is not in Submitted status (current: ${targetMilestone.status})`
    );
  }

  // 2. Validate deadline against current chain timestamp
  let currentChainTimestamp: number;
  if (typeof (client as any).getBlock === 'function') {
    try {
      const block = await (client as any).getBlock({ blockTag: 'latest' });
      currentChainTimestamp = Number(block.timestamp);
    } catch {
      currentChainTimestamp = Math.floor(Date.now() / 1000);
    }
  } else {
    currentChainTimestamp = Math.floor(Date.now() / 1000);
  }

  if (deadlineNum <= currentChainTimestamp) {
    throw new RevisionValidationError(
      `Proposed revision deadline (${deadlineNum}) must be strictly in the future (chain timestamp: ${currentChainTimestamp})`
    );
  }

  const maxDeadline = currentChainTimestamp + 365 * 86400;
  if (deadlineNum > maxDeadline) {
    throw new RevisionValidationError(
      `Proposed revision deadline (${deadlineNum}) exceeds maximum bound of 365 days (${maxDeadline})`
    );
  }

  // 3. Assemble and normalize the canonical revision manifest
  // Note: submissionVersion is CURRENT on-chain targetMilestone.version being revised (NOT version + 1)
  const candidateManifest = {
    schemaVersion: 1,
    chainId: SEPOLIA_CHAIN_ID,
    dealAddress: normalizedDeal as `0x${string}`,
    milestoneId: targetMilestoneId,
    submissionVersion: targetMilestone.version,
    specHash: targetMilestone.specHash.toLowerCase() as `0x${string}`,
    evidenceRootHash: targetMilestone.evidenceRootHash.toLowerCase() as `0x${string}`,
    clientWallet: deal.client.toLowerCase() as `0x${string}`,
    freelancerWallet: deal.freelancer.toLowerCase() as `0x${string}`,
    feedback: rawFeedback,
    proposedRevisionDeadline: deadlineNum,
  };

  let normalizedManifest: CanonicalRevisionManifestV1;
  try {
    normalizedManifest = normalizeRevisionManifest(candidateManifest);
  } catch (err: any) {
    throw new RevisionValidationError(err?.message || 'Invalid revision manifest');
  }

  // If rawManifest supplied explicit parameters, verify consistency
  if (rawObj?.submissionVersion !== undefined && rawObj.submissionVersion !== targetMilestone.version) {
    throw new RevisionValidationError(
      `submissionVersion mismatch: manifest has ${rawObj.submissionVersion}, expected current on-chain version ${targetMilestone.version}`
    );
  }
  if (rawObj?.specHash && String(rawObj.specHash).toLowerCase() !== targetMilestone.specHash.toLowerCase()) {
    throw new RevisionValidationError(
      `specHash mismatch: manifest has ${rawObj.specHash}, expected ${targetMilestone.specHash}`
    );
  }
  if (rawObj?.evidenceRootHash && String(rawObj.evidenceRootHash).toLowerCase() !== targetMilestone.evidenceRootHash.toLowerCase()) {
    throw new RevisionValidationError(
      `evidenceRootHash mismatch: manifest has ${rawObj.evidenceRootHash}, expected ${targetMilestone.evidenceRootHash}`
    );
  }
  if (rawObj?.clientWallet && String(rawObj.clientWallet).toLowerCase() !== deal.client.toLowerCase()) {
    throw new RevisionValidationError(
      `clientWallet mismatch: manifest has ${rawObj.clientWallet}, expected ${deal.client}`
    );
  }
  if (rawObj?.freelancerWallet && String(rawObj.freelancerWallet).toLowerCase() !== deal.freelancer.toLowerCase()) {
    throw new RevisionValidationError(
      `freelancerWallet mismatch: manifest has ${rawObj.freelancerWallet}, expected ${deal.freelancer}`
    );
  }

  // 4. Independently compute canonical reasonHash
  const computedHash = hashRevisionManifest(normalizedManifest);

  if (claimedReasonHash) {
    if (claimedReasonHash.toLowerCase() !== computedHash.toLowerCase()) {
      throw new RevisionValidationError(
        `Claimed reason hash (${claimedReasonHash}) does not match server-computed hash (${computedHash})`
      );
    }
  }

  // 5. Query existing revision record for (chainId, dealAddress, milestoneId, submissionVersion)
  const existing = await repo.getByMilestoneVersion(
    SEPOLIA_CHAIN_ID,
    normalizedDeal,
    targetMilestoneId,
    targetMilestone.version
  );

  if (existing) {
    if (existing.status === 'confirmed') {
      throw new RevisionConflictError(
        'Cannot modify confirmed revision request: this milestone version revision is already finalized on-chain and is immutable'
      );
    }

    if (existing.clientWallet.toLowerCase() !== normalizedAuthWallet) {
      throw new RevisionAuthError('Unauthorized: cannot overwrite another user staged revision');
    }

    // Check for exact idempotent restage
    if (
      existing.reasonHash.toLowerCase() === computedHash.toLowerCase() &&
      BigInt(existing.proposedRevisionDeadline) === BigInt(deadlineNum)
    ) {
      return {
        revision: existing,
        reasonHash: computedHash,
        proposedRevisionDeadline: deadlineNum,
        submissionVersion: targetMilestone.version,
      };
    }

    // Replace staged row
    const updated = await repo.updateStaged(existing.id, {
      reasonHash: computedHash.toLowerCase(),
      proposedRevisionDeadline: String(deadlineNum),
      manifest: normalizedManifest as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    });

    return {
      revision: updated,
      reasonHash: computedHash,
      proposedRevisionDeadline: deadlineNum,
      submissionVersion: targetMilestone.version,
    };
  }

  // Insert new staged row
  const rowToInsert: NewMilestoneRevisionRow = {
    id: crypto.randomUUID(),
    chainId: SEPOLIA_CHAIN_ID,
    dealAddress: normalizedDeal,
    milestoneId: targetMilestoneId,
    submissionVersion: targetMilestone.version,
    clientWallet: normalizedAuthWallet,
    freelancerWallet: deal.freelancer.toLowerCase(),
    specHash: targetMilestone.specHash.toLowerCase(),
    evidenceRootHash: targetMilestone.evidenceRootHash.toLowerCase(),
    reasonHash: computedHash.toLowerCase(),
    manifest: normalizedManifest as unknown as Record<string, unknown>,
    proposedRevisionDeadline: String(deadlineNum),
    status: 'staged',
    txHash: null,
    requestedAt: null,
  };

  const created = await repo.create(rowToInsert);
  return {
    revision: created,
    reasonHash: computedHash,
    proposedRevisionDeadline: deadlineNum,
    submissionVersion: targetMilestone.version,
  };
}

/**
 * Retrieves a milestone revision record.
 * Restricted to deal participants (client or freelancer).
 * Fails closed if stored manifest hash doesn't match stored reasonHash.
 */
export async function getMilestoneRevision(params: {
  dealAddress: string;
  milestoneId: number;
  version: number;
  authWallet: string;
  publicClient?: PublicClientLike;
  repo?: IMilestoneRevisionRepository;
}): Promise<{
  revision: MilestoneRevisionRow;
  manifest: CanonicalRevisionManifestV1;
} | null> {
  const { dealAddress, milestoneId, version, authWallet } = params;
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? activeRevisionRepo;

  if (!authWallet || !isAddress(authWallet)) {
    throw new RevisionAuthError('Unauthorized: valid wallet session required');
  }
  const normalizedAuth = authWallet.toLowerCase();

  if (!dealAddress || !isAddress(dealAddress)) {
    throw new RevisionValidationError('Invalid deal address');
  }
  const normalizedDeal = dealAddress.toLowerCase();

  // Read deal to verify participant authorization
  const deal = await readStandardV2DealData(normalizedDeal, client);
  const isClient = deal.client.toLowerCase() === normalizedAuth;
  const isFreelancer = deal.freelancer.toLowerCase() === normalizedAuth;

  if (!isClient && !isFreelancer) {
    throw new RevisionAuthError('Unauthorized: Only deal participants may view revision requests');
  }

  const row = await repo.getByMilestoneVersion(
    SEPOLIA_CHAIN_ID,
    normalizedDeal,
    milestoneId,
    version
  );

  if (!row) {
    return null;
  }

  // Integrity verification: recompute hash of stored manifest
  let normalizedManifest: CanonicalRevisionManifestV1;
  try {
    normalizedManifest = normalizeRevisionManifest(row.manifest);
  } catch {
    throw new RevisionIntegrityError('Stored revision manifest failed schema validation');
  }

  const recomputedHash = hashRevisionManifest(normalizedManifest);
  if (recomputedHash.toLowerCase() !== row.reasonHash.toLowerCase()) {
    throw new RevisionIntegrityError(
      `Revision integrity error: Stored manifest hash (${recomputedHash}) does not match recorded reasonHash (${row.reasonHash})`
    );
  }

  return {
    revision: row,
    manifest: normalizedManifest,
  };
}

/**
 * Reconciles a staged revision request with confirmed on-chain state.
 *
 * Verifies:
 * - Authoritative on-chain milestone state is MilestoneStatus.RevisionRequested
 * - On-chain milestone version matches requested submissionVersion
 * - On-chain proposedRevisionDeadlines matches staged deadline
 * - RevisionRequested event emitted by deal contract (if txHash provided)
 * - Transitions status: staged -> confirmed
 * - Idempotent if already confirmed
 */
export async function reconcileMilestoneRevision(params: {
  dealAddress: string;
  milestoneId: number;
  version: number;
  authWallet: string;
  txHash?: string;
  fromBlock?: bigint | 'earliest';
  publicClient?: PublicClientLike;
  repo?: IMilestoneRevisionRepository;
}): Promise<{
  revision: MilestoneRevisionRow;
}> {
  const { dealAddress, milestoneId, version, authWallet, txHash, fromBlock } = params;
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? activeRevisionRepo;

  if (!authWallet || !isAddress(authWallet)) {
    throw new RevisionAuthError('Unauthorized: valid wallet session required');
  }
  const normalizedAuth = authWallet.toLowerCase();

  if (!dealAddress || !isAddress(dealAddress)) {
    throw new RevisionValidationError('Invalid deal address');
  }
  const normalizedDeal = dealAddress.toLowerCase();

  // 1. Authoritative deal readback
  const deal = await readStandardV2DealData(normalizedDeal, client);
  const isClient = deal.client.toLowerCase() === normalizedAuth;
  const isFreelancer = deal.freelancer.toLowerCase() === normalizedAuth;

  if (!isClient && !isFreelancer) {
    throw new RevisionAuthError('Unauthorized: Only deal participants can reconcile revision requests');
  }

  if (milestoneId < 0 || milestoneId >= deal.milestones.length) {
    throw new RevisionValidationError(`Invalid milestoneId: ${milestoneId}`);
  }

  const onChainMilestone = deal.milestones[milestoneId];

  // Milestone must be in RevisionRequested status on-chain
  if (onChainMilestone.status !== MilestoneStatus.RevisionRequested) {
    throw new RevisionValidationError(
      `Milestone ${milestoneId + 1} is not in RevisionRequested status on-chain (current: ${onChainMilestone.status})`
    );
  }

  // Version must match current on-chain submission version
  if (onChainMilestone.version !== version) {
    throw new RevisionValidationError(
      `Milestone on-chain version is ${onChainMilestone.version}, expected ${version}`
    );
  }

  // 2. Read on-chain proposedRevisionDeadlines and revisionRequestedAt mappings
  let onChainProposedDeadline = 0n;
  let onChainRequestedAt = 0n;

  if (typeof (client as any).readContract === 'function') {
    try {
      onChainProposedDeadline = await (client as any).readContract({
        address: normalizedDeal as `0x${string}`,
        abi: synqDealV1ABI,
        functionName: 'proposedRevisionDeadlines',
        args: [BigInt(milestoneId)],
      });
      onChainRequestedAt = await (client as any).readContract({
        address: normalizedDeal as `0x${string}`,
        abi: synqDealV1ABI,
        functionName: 'revisionRequestedAt',
        args: [BigInt(milestoneId)],
      });
    } catch (err: any) {
      console.warn('[reconcileMilestoneRevision] Failed reading contract revision mappings:', err?.message);
    }
  }

  if (onChainRequestedAt === 0n) {
    throw new RevisionValidationError(
      `On-chain revisionRequestedAt is zero for deal ${normalizedDeal}, milestone ${milestoneId}`
    );
  }

  // 3. Find staged/existing DB row
  const existing = await repo.getByMilestoneVersion(
    SEPOLIA_CHAIN_ID,
    normalizedDeal,
    milestoneId,
    version
  );

  if (!existing) {
    throw new RevisionValidationError(
      `No staged revision request found for deal ${normalizedDeal}, milestone ${milestoneId}, version ${version}`
    );
  }

  // Verify on-chain anchors match staged row
  if (onChainMilestone.specHash.toLowerCase() !== existing.specHash.toLowerCase()) {
    throw new RevisionValidationError(
      `On-chain specHash mismatch: contract reports ${onChainMilestone.specHash}, DB has ${existing.specHash}`
    );
  }

  if (onChainMilestone.evidenceRootHash.toLowerCase() !== existing.evidenceRootHash.toLowerCase()) {
    throw new RevisionValidationError(
      `On-chain evidenceRootHash mismatch: contract reports ${onChainMilestone.evidenceRootHash}, DB has ${existing.evidenceRootHash}`
    );
  }

  if (onChainProposedDeadline > 0n && BigInt(existing.proposedRevisionDeadline) !== onChainProposedDeadline) {
    throw new RevisionValidationError(
      `On-chain proposed deadline mismatch: contract reports ${onChainProposedDeadline.toString()}, DB has ${existing.proposedRevisionDeadline}`
    );
  }

  // Verify DB manifest hashes to recorded reasonHash
  const normalizedManifest = normalizeRevisionManifest(existing.manifest);
  const computedHash = hashRevisionManifest(normalizedManifest);

  if (computedHash.toLowerCase() !== existing.reasonHash.toLowerCase()) {
    throw new RevisionIntegrityError(
      `Staged manifest hash (${computedHash}) does not match recorded reasonHash (${existing.reasonHash})`
    );
  }

  // 4. Receipt verification vs. No-txHash event recovery
  let verifiedTxHash = txHash?.toLowerCase();

  if (txHash) {
    // PREFERRED PATH: Verify transaction receipt directly
    if (typeof (client as any).waitForTransactionReceipt === 'function') {
      const receipt = await (client as any).waitForTransactionReceipt({ hash: txHash as `0x${string}` });
      const eventCheck = verifyRevisionRequestedReceipt(
        receipt,
        normalizedDeal,
        BigInt(milestoneId),
        existing.reasonHash as `0x${string}`,
        BigInt(existing.proposedRevisionDeadline)
      );

      if (!eventCheck.valid) {
        throw new RevisionValidationError(
          eventCheck.error || 'Transaction receipt failed RevisionRequested verification'
        );
      }
    }
  } else {
    // RECOVERY PATH: No txHash provided (browser crash / reload recovery).
    // Query event logs for RevisionRequested matching exact Deal, milestoneId, reasonHash, and deadline.
    if (typeof (client as any).getLogs !== 'function') {
      throw new RevisionValidationError(
        'Recovery failed: No txHash provided and public client does not support getLogs'
      );
    }

    const rawLogs = await (client as any).getLogs({
      address: normalizedDeal as `0x${string}`,
      fromBlock: fromBlock ?? 'earliest',
      toBlock: 'latest',
    });

    const matchingCandidates: { transactionHash: string; blockTimestamp: bigint }[] = [];

    for (const log of rawLogs) {
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

          if (
            BigInt(args.milestoneId) === BigInt(milestoneId) &&
            args.reasonHash.toLowerCase() === existing.reasonHash.toLowerCase() &&
            BigInt(args.proposedRevisionDeadline) === BigInt(existing.proposedRevisionDeadline)
          ) {
            // Verify event block timestamp exactly matches onChainRequestedAt
            let logBlockTimestamp = 0n;
            if (typeof (client as any).getBlock === 'function') {
              const block = await (client as any).getBlock(
                log.blockHash ? { blockHash: log.blockHash } : { blockNumber: log.blockNumber }
              );
              logBlockTimestamp = BigInt(block.timestamp);
            }

            if (logBlockTimestamp === onChainRequestedAt) {
              matchingCandidates.push({
                transactionHash: String(log.transactionHash),
                blockTimestamp: logBlockTimestamp,
              });
            }
          }
        }
      } catch {
        continue;
      }
    }

    if (matchingCandidates.length === 0) {
      throw new RevisionValidationError(
        `Recovery failed: No matching on-chain RevisionRequested event found with reasonHash ${existing.reasonHash} and block timestamp ${onChainRequestedAt.toString()}`
      );
    }

    if (matchingCandidates.length > 1) {
      throw new RevisionConflictError(
        `Recovery failed: Ambiguous on-chain RevisionRequested events detected (${matchingCandidates.length} matches). Cannot safely recover without explicit transaction hash`
      );
    }

    verifiedTxHash = matchingCandidates[0].transactionHash.toLowerCase();
  }

  // 5. Idempotency: already confirmed
  if (existing.status === 'confirmed') {
    if (verifiedTxHash && existing.txHash && existing.txHash.toLowerCase() !== verifiedTxHash) {
      throw new RevisionConflictError(
        'Revision request already confirmed with a different transaction hash'
      );
    }
    return { revision: existing };
  }

  // 6. Transition to confirmed
  const onChainRequestedDate = onChainRequestedAt > 0n
    ? new Date(Number(onChainRequestedAt) * 1000)
    : new Date();

  const confirmed = await repo.confirm(existing.id, {
    txHash: verifiedTxHash || existing.txHash || null,
    requestedAt: onChainRequestedDate,
    updatedAt: new Date(),
  });

  return { revision: confirmed };
}
