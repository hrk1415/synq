import { getAddress, isAddress } from 'viem';
import { getDb } from '@/db';
import { milestoneSubmissions, type MilestoneSubmissionRow, type NewMilestoneSubmissionRow } from '@/db/schema';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import {
  readStandardV2DealData,
  isMilestoneSettled,
  verifySubmitWorkReceipt,
  DealState,
  MilestoneStatus,
  type PublicClientLike,
} from '@/lib/deals/v2-deal';
import {
  normalizeEvidenceManifest,
  hashEvidenceManifest,
  CanonicalEvidenceManifestV1,
  EvidenceValidationError,
} from '@/lib/deals/v2-evidence';
import { sepoliaPublicClient } from '@/lib/chain';
import { and, eq } from 'drizzle-orm';

export class SubmissionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionValidationError';
  }
}

export class SubmissionAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionAuthError';
  }
}

export class SubmissionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionConflictError';
  }
}

export class SubmissionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionIntegrityError';
  }
}

// ---------------------------------------------------------------------------
// Repository Pattern
// ---------------------------------------------------------------------------

export interface IMilestoneSubmissionRepository {
  getByMilestoneVersion(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    version: number,
  ): Promise<MilestoneSubmissionRow | null>;

  create(row: NewMilestoneSubmissionRow): Promise<MilestoneSubmissionRow>;

  updateStaged(
    id: string,
    data: {
      specHash: string;
      evidenceRootHash: string;
      manifest: Record<string, unknown>;
      updatedAt: Date;
    }
  ): Promise<MilestoneSubmissionRow>;

  confirm(
    id: string,
    data: {
      txHash: string | null;
      submittedAt: Date;
      updatedAt: Date;
    }
  ): Promise<MilestoneSubmissionRow>;
}

export class DrizzleMilestoneSubmissionRepository implements IMilestoneSubmissionRepository {
  async getByMilestoneVersion(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    version: number,
  ): Promise<MilestoneSubmissionRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(milestoneSubmissions)
      .where(
        and(
          eq(milestoneSubmissions.chainId, chainId),
          eq(milestoneSubmissions.dealAddress, dealAddress.toLowerCase()),
          eq(milestoneSubmissions.milestoneId, milestoneId),
          eq(milestoneSubmissions.version, version)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async create(row: NewMilestoneSubmissionRow): Promise<MilestoneSubmissionRow> {
    const db = getDb();
    const inserted = await db.insert(milestoneSubmissions).values(row).returning();
    return inserted[0];
  }

  async updateStaged(
    id: string,
    data: {
      specHash: string;
      evidenceRootHash: string;
      manifest: Record<string, unknown>;
      updatedAt: Date;
    }
  ): Promise<MilestoneSubmissionRow> {
    const db = getDb();
    const updated = await db
      .update(milestoneSubmissions)
      .set(data)
      .where(eq(milestoneSubmissions.id, id))
      .returning();
    return updated[0];
  }

  async confirm(
    id: string,
    data: {
      txHash: string | null;
      submittedAt: Date;
      updatedAt: Date;
    }
  ): Promise<MilestoneSubmissionRow> {
    const db = getDb();
    const updated = await db
      .update(milestoneSubmissions)
      .set({
        status: 'confirmed',
        ...data,
      })
      .where(eq(milestoneSubmissions.id, id))
      .returning();
    return updated[0];
  }
}

export class InMemoryMilestoneSubmissionRepository implements IMilestoneSubmissionRepository {
  private records = new Map<string, MilestoneSubmissionRow>();

  private makeKey(chainId: number, dealAddress: string, milestoneId: number, version: number): string {
    return `${chainId}:${dealAddress.toLowerCase()}:${milestoneId}:${version}`;
  }

  async getByMilestoneVersion(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    version: number,
  ): Promise<MilestoneSubmissionRow | null> {
    const key = this.makeKey(chainId, dealAddress, milestoneId, version);
    return this.records.get(key) ?? null;
  }

  async create(row: NewMilestoneSubmissionRow): Promise<MilestoneSubmissionRow> {
    const key = this.makeKey(row.chainId, row.dealAddress, row.milestoneId, row.version);
    if (this.records.has(key)) {
      throw new Error(`Unique constraint violation: key ${key} already exists`);
    }
    const now = new Date();
    const record: MilestoneSubmissionRow = {
      id: row.id ?? crypto.randomUUID(),
      chainId: row.chainId,
      dealAddress: row.dealAddress.toLowerCase(),
      milestoneId: row.milestoneId,
      version: row.version,
      freelancerWallet: row.freelancerWallet.toLowerCase(),
      specHash: row.specHash.toLowerCase(),
      evidenceRootHash: row.evidenceRootHash.toLowerCase(),
      manifest: row.manifest,
      status: row.status ?? 'staged',
      txHash: row.txHash ?? null,
      submittedAt: row.submittedAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(key, record);
    return record;
  }

  async updateStaged(
    id: string,
    data: {
      specHash: string;
      evidenceRootHash: string;
      manifest: Record<string, unknown>;
      updatedAt: Date;
    }
  ): Promise<MilestoneSubmissionRow> {
    for (const [key, record] of this.records.entries()) {
      if (record.id === id) {
        const updated: MilestoneSubmissionRow = {
          ...record,
          specHash: data.specHash.toLowerCase(),
          evidenceRootHash: data.evidenceRootHash.toLowerCase(),
          manifest: data.manifest,
          updatedAt: data.updatedAt,
        };
        this.records.set(key, updated);
        return updated;
      }
    }
    throw new Error(`Submission row ${id} not found`);
  }

  async confirm(
    id: string,
    data: {
      txHash: string | null;
      submittedAt: Date;
      updatedAt: Date;
    }
  ): Promise<MilestoneSubmissionRow> {
    for (const [key, record] of this.records.entries()) {
      if (record.id === id) {
        const updated: MilestoneSubmissionRow = {
          ...record,
          status: 'confirmed',
          txHash: data.txHash,
          submittedAt: data.submittedAt,
          updatedAt: data.updatedAt,
        };
        this.records.set(key, updated);
        return updated;
      }
    }
    throw new Error(`Submission row ${id} not found`);
  }

  clear() {
    this.records.clear();
  }
}

let activeSubmissionRepo: IMilestoneSubmissionRepository = new DrizzleMilestoneSubmissionRepository();

export function setMilestoneSubmissionRepository(repo: IMilestoneSubmissionRepository) {
  activeSubmissionRepo = repo;
}

export function resetMilestoneSubmissionRepository() {
  activeSubmissionRepo = new DrizzleMilestoneSubmissionRepository();
}

/**
 * Stages a canonical evidence manifest in the database.
 *
 * Enforces:
 * 1. Valid normalized manifest schema (schemaVersion 1, summary, links, empty attachments)
 * 2. Recomputed canonical evidenceRootHash matches client claimed hash (if provided)
 * 3. Authoritative on-chain deal state verification:
 *    - Deal is canonical Factory V2 Deal
 *    - DealState is Active
 *    - Caller is designated freelancer
 *    - Target milestone is InProgress
 *    - Preceding milestones are settled
 *    - Manifest chainId, dealAddress, milestoneId match
 *    - Manifest specHash matches on-chain specHash
 *    - Manifest version matches expected next version (targetMilestone.version + 1)
 * 4. Staging lifecycle:
 *    - Staged row can be updated/replaced by the same freelancer
 *    - Confirmed row cannot be mutated or replaced
 */
export async function stageMilestoneSubmission(params: {
  rawManifest: unknown;
  authWallet: string;
  claimedEvidenceRootHash?: string;
  publicClient?: PublicClientLike;
  repo?: IMilestoneSubmissionRepository;
}): Promise<{
  submission: MilestoneSubmissionRow;
  evidenceRootHash: `0x${string}`;
}> {
  const { rawManifest, authWallet, claimedEvidenceRootHash } = params;
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? activeSubmissionRepo;

  if (!authWallet || !isAddress(authWallet)) {
    throw new SubmissionAuthError('Unauthorized: valid wallet session required');
  }
  const normalizedAuthWallet = authWallet.toLowerCase();

  // 1. Normalize and validate manifest schema
  let normalizedManifest: CanonicalEvidenceManifestV1;
  try {
    normalizedManifest = normalizeEvidenceManifest(rawManifest);
  } catch (err: any) {
    throw new SubmissionValidationError(err?.message || 'Invalid evidence manifest');
  }

  // 2. Independently compute canonical evidenceRootHash
  const computedHash = hashEvidenceManifest(normalizedManifest);

  if (claimedEvidenceRootHash) {
    if (claimedEvidenceRootHash.toLowerCase() !== computedHash.toLowerCase()) {
      throw new SubmissionValidationError(
        `Claimed evidence root hash (${claimedEvidenceRootHash}) does not match server-computed hash (${computedHash})`
      );
    }
  }

  // 3. Read authoritative on-chain Deal data
  const deal = await readStandardV2DealData(normalizedManifest.dealAddress, client);

  // 4. Verify deal state and participant role
  if (deal.state !== DealState.Active) {
    throw new SubmissionValidationError(
      `Deal is not Active (current state: ${deal.state})`
    );
  }

  if (deal.freelancer.toLowerCase() !== normalizedAuthWallet) {
    throw new SubmissionAuthError(
      'Unauthorized: Only the designated freelancer can submit deliverables'
    );
  }

  if (normalizedManifest.chainId !== SEPOLIA_CHAIN_ID) {
    throw new SubmissionValidationError(
      `Invalid chainId: ${normalizedManifest.chainId}. Expected ${SEPOLIA_CHAIN_ID}`
    );
  }

  if (
    normalizedManifest.milestoneId < 0 ||
    normalizedManifest.milestoneId >= deal.milestones.length
  ) {
    throw new SubmissionValidationError(
      `Invalid milestoneId: ${normalizedManifest.milestoneId}`
    );
  }

  const targetMilestone = deal.milestones[normalizedManifest.milestoneId];
  if (targetMilestone.status !== MilestoneStatus.InProgress) {
    throw new SubmissionValidationError(
      `Milestone ${normalizedManifest.milestoneId + 1} is not InProgress`
    );
  }

  // Verify preceding milestones are settled
  for (let i = 0; i < normalizedManifest.milestoneId; i++) {
    if (!isMilestoneSettled(deal.milestones[i].status)) {
      throw new SubmissionValidationError(
        `Preceding milestone ${i + 1} is not settled`
      );
    }
  }

  // Next submission version must be current on-chain version + 1
  const expectedNextVersion = targetMilestone.version + 1;
  if (normalizedManifest.version !== expectedNextVersion) {
    throw new SubmissionValidationError(
      `Invalid submission version: manifest has ${normalizedManifest.version}, expected ${expectedNextVersion} (current on-chain: ${targetMilestone.version})`
    );
  }

  // Spec hash must match on-chain specHash
  if (normalizedManifest.specHash.toLowerCase() !== targetMilestone.specHash.toLowerCase()) {
    throw new SubmissionValidationError(
      `Spec hash mismatch: manifest has ${normalizedManifest.specHash}, expected ${targetMilestone.specHash}`
    );
  }

  // Check deadline + grace period
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now > targetMilestone.workDeadline + targetMilestone.gracePeriod) {
    throw new SubmissionValidationError('Work deadline and grace period have expired');
  }

  // 5. Query existing submission record
  const existing = await repo.getByMilestoneVersion(
    normalizedManifest.chainId,
    normalizedManifest.dealAddress,
    normalizedManifest.milestoneId,
    normalizedManifest.version
  );

  if (existing) {
    if (existing.status === 'confirmed') {
      throw new SubmissionConflictError(
        'Cannot modify confirmed submission: this milestone version is already finalized on-chain and is immutable'
      );
    }

    if (existing.freelancerWallet.toLowerCase() !== normalizedAuthWallet) {
      throw new SubmissionAuthError('Unauthorized: cannot overwrite another user staged submission');
    }

    // Check for exact idempotent resubmission
    if (
      existing.evidenceRootHash.toLowerCase() === computedHash.toLowerCase() &&
      existing.specHash.toLowerCase() === normalizedManifest.specHash.toLowerCase()
    ) {
      return { submission: existing, evidenceRootHash: computedHash };
    }

    // Replace staged row
    const updated = await repo.updateStaged(existing.id, {
      specHash: normalizedManifest.specHash.toLowerCase(),
      evidenceRootHash: computedHash.toLowerCase(),
      manifest: normalizedManifest as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    });

    return { submission: updated, evidenceRootHash: computedHash };
  }

  // Insert new staged row
  const rowToInsert: NewMilestoneSubmissionRow = {
    id: crypto.randomUUID(),
    chainId: normalizedManifest.chainId,
    dealAddress: normalizedManifest.dealAddress.toLowerCase(),
    milestoneId: normalizedManifest.milestoneId,
    version: normalizedManifest.version,
    freelancerWallet: normalizedAuthWallet,
    specHash: normalizedManifest.specHash.toLowerCase(),
    evidenceRootHash: computedHash.toLowerCase(),
    manifest: normalizedManifest as unknown as Record<string, unknown>,
    status: 'staged',
    txHash: null,
    submittedAt: null,
  };

  const created = await repo.create(rowToInsert);
  return { submission: created, evidenceRootHash: computedHash };
}

/**
 * Retrieves a milestone submission record.
 * Restricted to deal participants (client or freelancer).
 * Fails closed if stored manifest hash doesn't match stored evidenceRootHash.
 */
export async function getMilestoneSubmission(params: {
  dealAddress: string;
  milestoneId: number;
  version: number;
  authWallet: string;
  publicClient?: PublicClientLike;
  repo?: IMilestoneSubmissionRepository;
}): Promise<{
  submission: MilestoneSubmissionRow;
  manifest: CanonicalEvidenceManifestV1;
} | null> {
  const { dealAddress, milestoneId, version, authWallet } = params;
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? activeSubmissionRepo;

  if (!authWallet || !isAddress(authWallet)) {
    throw new SubmissionAuthError('Unauthorized: valid wallet session required');
  }
  const normalizedAuth = authWallet.toLowerCase();

  if (!dealAddress || !isAddress(dealAddress)) {
    throw new SubmissionValidationError('Invalid deal address');
  }
  const normalizedDeal = dealAddress.toLowerCase();

  // Read deal to verify participant authorization
  const deal = await readStandardV2DealData(normalizedDeal, client);
  const isClient = deal.client.toLowerCase() === normalizedAuth;
  const isFreelancer = deal.freelancer.toLowerCase() === normalizedAuth;

  if (!isClient && !isFreelancer) {
    throw new SubmissionAuthError('Unauthorized: Only deal participants may view evidence submissions');
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
  let normalizedManifest: CanonicalEvidenceManifestV1;
  try {
    normalizedManifest = normalizeEvidenceManifest(row.manifest);
  } catch {
    throw new SubmissionIntegrityError('Stored evidence manifest failed schema validation');
  }

  const recomputedHash = hashEvidenceManifest(normalizedManifest);
  if (recomputedHash.toLowerCase() !== row.evidenceRootHash.toLowerCase()) {
    throw new SubmissionIntegrityError(
      `Evidence integrity error: Stored manifest hash (${recomputedHash}) does not match recorded evidenceRootHash (${row.evidenceRootHash})`
    );
  }

  // If milestone is currently Submitted on chain and version matches, check on-chain hash
  if (milestoneId >= 0 && milestoneId < deal.milestones.length) {
    const onChainMilestone = deal.milestones[milestoneId];
    if (
      onChainMilestone.status === MilestoneStatus.Submitted &&
      onChainMilestone.version === version
    ) {
      if (onChainMilestone.evidenceRootHash.toLowerCase() !== row.evidenceRootHash.toLowerCase()) {
        throw new SubmissionIntegrityError(
          `On-chain evidence hash mismatch: Contract has ${onChainMilestone.evidenceRootHash}, DB has ${row.evidenceRootHash}`
        );
      }
    }
  }

  return {
    submission: row,
    manifest: normalizedManifest,
  };
}

/**
 * Reconciles a staged submission with confirmed on-chain state.
 *
 * Verifies:
 * - MilestoneSubmitted event emitted by deal contract (if txHash provided)
 * - Authoritative on-chain milestone state is MilestoneStatus.Submitted
 * - On-chain evidenceRootHash matches staged manifest hash
 * - On-chain version matches requested version
 * - Transitions status: staged -> confirmed
 * - Idempotent if already confirmed
 */
export async function reconcileMilestoneSubmission(params: {
  dealAddress: string;
  milestoneId: number;
  version: number;
  authWallet: string;
  txHash?: string;
  publicClient?: PublicClientLike;
  repo?: IMilestoneSubmissionRepository;
}): Promise<{
  submission: MilestoneSubmissionRow;
}> {
  const { dealAddress, milestoneId, version, authWallet, txHash } = params;
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? activeSubmissionRepo;

  if (!authWallet || !isAddress(authWallet)) {
    throw new SubmissionAuthError('Unauthorized: valid wallet session required');
  }
  const normalizedAuth = authWallet.toLowerCase();

  if (!dealAddress || !isAddress(dealAddress)) {
    throw new SubmissionValidationError('Invalid deal address');
  }
  const normalizedDeal = dealAddress.toLowerCase();

  // 1. Authoritative deal readback
  const deal = await readStandardV2DealData(normalizedDeal, client);
  const isClient = deal.client.toLowerCase() === normalizedAuth;
  const isFreelancer = deal.freelancer.toLowerCase() === normalizedAuth;

  if (!isClient && !isFreelancer) {
    throw new SubmissionAuthError('Unauthorized: Only deal participants can reconcile submissions');
  }

  if (milestoneId < 0 || milestoneId >= deal.milestones.length) {
    throw new SubmissionValidationError(`Invalid milestoneId: ${milestoneId}`);
  }

  const onChainMilestone = deal.milestones[milestoneId];

  // Milestone must be Submitted on-chain
  if (onChainMilestone.status !== MilestoneStatus.Submitted) {
    throw new SubmissionValidationError(
      `Milestone ${milestoneId + 1} is not in Submitted status on-chain (current: ${onChainMilestone.status})`
    );
  }

  if (onChainMilestone.version !== version) {
    throw new SubmissionValidationError(
      `Milestone on-chain version is ${onChainMilestone.version}, expected ${version}`
    );
  }

  // 2. If txHash provided, verify receipt and event
  let verifiedTxHash = txHash?.toLowerCase();
  if (txHash && typeof (client as any).waitForTransactionReceipt === 'function') {
    const receipt = await (client as any).waitForTransactionReceipt({ hash: txHash as `0x${string}` });
    const eventCheck = verifySubmitWorkReceipt(
      receipt,
      normalizedDeal,
      BigInt(milestoneId),
      onChainMilestone.evidenceRootHash
    );

    if (!eventCheck.valid) {
      throw new SubmissionValidationError(
        eventCheck.error || 'Transaction receipt failed MilestoneSubmitted verification'
      );
    }
  }

  // 3. Find staged/existing DB row
  const existing = await repo.getByMilestoneVersion(
    SEPOLIA_CHAIN_ID,
    normalizedDeal,
    milestoneId,
    version
  );

  if (!existing) {
    throw new SubmissionValidationError(
      `No staged evidence submission found for deal ${normalizedDeal}, milestone ${milestoneId}, version ${version}`
    );
  }

  // Verify DB manifest hashes to on-chain evidenceRootHash
  const normalizedManifest = normalizeEvidenceManifest(existing.manifest);
  const computedHash = hashEvidenceManifest(normalizedManifest);

  if (computedHash.toLowerCase() !== onChainMilestone.evidenceRootHash.toLowerCase()) {
    throw new SubmissionIntegrityError(
      `Staged manifest hash (${computedHash}) does not match on-chain evidenceRootHash (${onChainMilestone.evidenceRootHash})`
    );
  }

  // Idempotency: already confirmed
  if (existing.status === 'confirmed') {
    if (verifiedTxHash && existing.txHash && existing.txHash.toLowerCase() !== verifiedTxHash) {
      throw new SubmissionConflictError(
        'Submission already confirmed with a different transaction hash'
      );
    }
    return { submission: existing };
  }

  // Transition to confirmed
  const onChainSubmittedDate = onChainMilestone.submittedAt > 0n
    ? new Date(Number(onChainMilestone.submittedAt) * 1000)
    : new Date();

  const confirmed = await repo.confirm(existing.id, {
    txHash: verifiedTxHash || existing.txHash || null,
    submittedAt: onChainSubmittedDate,
    updatedAt: new Date(),
  });

  return { submission: confirmed };
}
