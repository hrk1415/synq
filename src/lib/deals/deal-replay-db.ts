/**
 * Synq Historical Deal Replay Repository (B.12.3.22)
 *
 * PostgreSQL-backed durable replay queue for deal contracts discovered behind an advanced scanner cursor.
 * Features:
 * - Deterministic, bounded progress watermark (lastProcessedBlock)
 * - Atomic worker leases with fencing tokens
 * - Stale worker protection (claimToken validation)
 * - Automatic crash recovery and backoff retry logic
 * - Preservation of factory generation and creation block
 */

import crypto from 'node:crypto';
import { getDb } from '@/db';
import {
  dealReplayJobs,
  type DealReplayJobRow,
  type DealReplayJobStatus,
  type DealReplayGeneration,
  type DealReplayContractType,
} from '@/db/schema';
import { eq, and, or, sql, lte, lt } from 'drizzle-orm';
import { normalizeWallet } from '@/lib/utils';

export const DEFAULT_REPLAY_CLAIM_DURATION_MS = 60_000; // 60-second lease
export const DEFAULT_MAX_REPLAY_RETRIES = 5;

export interface DealReplayJob {
  id: string; // `${chainId}:${contractAddress.toLowerCase()}`
  chainId: number;
  contractAddress: string;
  contractType: DealReplayContractType;
  generation: DealReplayGeneration;
  fromBlock: bigint;
  toBlock: bigint;
  lastProcessedBlock: bigint | null;
  status: DealReplayJobStatus;
  retryCount: number;
  maxRetries: number;
  claimToken?: string | null;
  claimExpiresAt?: Date | null;
  lastError?: string | null;
  nextRetryAt: Date;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateReplayJobParams {
  chainId: number;
  contractAddress: string;
  contractType: DealReplayContractType;
  generation: DealReplayGeneration;
  fromBlock: bigint;
  toBlock: bigint;
  maxRetries?: number;
}

export function formatReplayJobId(chainId: number, contractAddress: string): string {
  return `${chainId}:${normalizeWallet(contractAddress)}`;
}

export interface IDealReplayRepository {
  createJob(params: CreateReplayJobParams): Promise<{ status: 'created' | 'exists'; job: DealReplayJob }>;
  getJob(chainId: number, contractAddress: string): Promise<DealReplayJob | null>;
  getJobById(id: string): Promise<DealReplayJob | null>;
  claimPendingJobs(params?: {
    chainId?: number;
    limit?: number;
    claimDurationMs?: number;
    workerId?: string;
  }): Promise<DealReplayJob[]>;
  updateProgress(params: {
    id: string;
    claimToken: string;
    lastProcessedBlock: bigint;
  }): Promise<{ success: boolean; error?: string }>;
  markCompleted(params: {
    id: string;
    claimToken: string;
    finalProcessedBlock: bigint;
  }): Promise<{ success: boolean; error?: string }>;
  markFailed(params: {
    id: string;
    claimToken: string;
    error: string;
    retryable?: boolean;
    backoffSeconds?: number;
  }): Promise<{ success: boolean; error?: string }>;
  rewindProgress(params: {
    id: string;
    claimToken: string;
    rewindToBlock: bigint;
  }): Promise<{ success: boolean; error?: string }>;
  listJobs(params?: {
    chainId?: number;
    status?: DealReplayJobStatus;
    limit?: number;
  }): Promise<DealReplayJob[]>;
  clear?(): Promise<void>;
}

export class InMemoryDealReplayRepository implements IDealReplayRepository {
  private jobs = new Map<string, DealReplayJob>();

  async createJob(params: CreateReplayJobParams): Promise<{ status: 'created' | 'exists'; job: DealReplayJob }> {
    const id = formatReplayJobId(params.chainId, params.contractAddress);
    const existing = this.jobs.get(id);
    if (existing) {
      return { status: 'exists', job: { ...existing } };
    }

    const now = new Date();
    const job: DealReplayJob = {
      id,
      chainId: params.chainId,
      contractAddress: normalizeWallet(params.contractAddress),
      contractType: params.contractType,
      generation: params.generation,
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
      lastProcessedBlock: null,
      status: 'pending',
      retryCount: 0,
      maxRetries: params.maxRetries ?? DEFAULT_MAX_REPLAY_RETRIES,
      claimToken: null,
      claimExpiresAt: null,
      lastError: null,
      nextRetryAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(id, job);
    return { status: 'created', job: { ...job } };
  }

  async getJob(chainId: number, contractAddress: string): Promise<DealReplayJob | null> {
    const id = formatReplayJobId(chainId, contractAddress);
    return this.getJobById(id);
  }

  async getJobById(id: string): Promise<DealReplayJob | null> {
    const job = this.jobs.get(id);
    return job ? { ...job } : null;
  }

  async claimPendingJobs(params?: {
    chainId?: number;
    limit?: number;
    claimDurationMs?: number;
    workerId?: string;
  }): Promise<DealReplayJob[]> {
    const limit = params?.limit ?? 5;
    const duration = params?.claimDurationMs ?? DEFAULT_REPLAY_CLAIM_DURATION_MS;
    const now = new Date();
    const claimed: DealReplayJob[] = [];

    for (const job of this.jobs.values()) {
      if (claimed.length >= limit) break;
      if (params?.chainId !== undefined && job.chainId !== params.chainId) continue;

      const isPending = job.status === 'pending';
      const isExpiredProcessing =
        job.status === 'processing' && job.claimExpiresAt !== null && job.claimExpiresAt !== undefined && job.claimExpiresAt <= now;

      if ((isPending || isExpiredProcessing) && job.nextRetryAt <= now && job.retryCount < job.maxRetries) {
        const token = `${params?.workerId ? params.workerId + '-' : ''}${crypto.randomUUID()}`;
        const expires = new Date(now.getTime() + duration);

        job.status = 'processing';
        job.claimToken = token;
        job.claimExpiresAt = expires;
        job.updatedAt = now;

        claimed.push({ ...job });
      }
    }

    return claimed;
  }

  async updateProgress(params: {
    id: string;
    claimToken: string;
    lastProcessedBlock: bigint;
  }): Promise<{ success: boolean; error?: string }> {
    const job = this.jobs.get(params.id);
    if (!job) {
      return { success: false, error: 'Job not found' };
    }

    const now = new Date();
    if (job.claimToken !== params.claimToken || job.status !== 'processing') {
      return { success: false, error: 'Fenced: Stale lease or invalid claim token' };
    }
    if (job.claimExpiresAt && job.claimExpiresAt <= now) {
      return { success: false, error: 'Fenced: Worker lease expired' };
    }

    job.lastProcessedBlock = params.lastProcessedBlock;
    job.updatedAt = now;
    return { success: true };
  }

  async markCompleted(params: {
    id: string;
    claimToken: string;
    finalProcessedBlock: bigint;
  }): Promise<{ success: boolean; error?: string }> {
    const job = this.jobs.get(params.id);
    if (!job) {
      return { success: false, error: 'Job not found' };
    }

    const now = new Date();
    if (job.claimToken !== params.claimToken || job.status !== 'processing') {
      return { success: false, error: 'Fenced: Stale lease or invalid claim token' };
    }
    if (job.claimExpiresAt && job.claimExpiresAt <= now) {
      return { success: false, error: 'Fenced: Worker lease expired' };
    }

    job.status = 'completed';
    job.lastProcessedBlock = params.finalProcessedBlock;
    job.completedAt = now;
    job.claimToken = null;
    job.claimExpiresAt = null;
    job.updatedAt = now;
    return { success: true };
  }

  async markFailed(params: {
    id: string;
    claimToken: string;
    error: string;
    retryable?: boolean;
    backoffSeconds?: number;
  }): Promise<{ success: boolean; error?: string }> {
    const job = this.jobs.get(params.id);
    if (!job) {
      return { success: false, error: 'Job not found' };
    }

    const now = new Date();
    if (job.claimToken !== params.claimToken) {
      return { success: false, error: 'Fenced: Stale lease or invalid claim token' };
    }

    const nextRetryCount = job.retryCount + 1;
    const isTerminal = params.retryable === false || nextRetryCount >= job.maxRetries;

    job.retryCount = nextRetryCount;
    job.lastError = params.error;
    job.claimToken = null;
    job.claimExpiresAt = null;
    job.updatedAt = now;

    if (isTerminal) {
      job.status = 'failed';
    } else {
      job.status = 'pending';
      const backoffSec = params.backoffSeconds ?? Math.min(60 * 60, Math.pow(2, nextRetryCount) * 5);
      job.nextRetryAt = new Date(now.getTime() + backoffSec * 1000);
    }

    return { success: true };
  }

  async rewindProgress(params: {
    id: string;
    claimToken: string;
    rewindToBlock: bigint;
  }): Promise<{ success: boolean; error?: string }> {
    const job = this.jobs.get(params.id);
    if (!job) {
      return { success: false, error: 'Job not found' };
    }

    if (job.claimToken !== params.claimToken || job.status !== 'processing') {
      return { success: false, error: 'Fenced: Stale lease or invalid claim token' };
    }

    job.lastProcessedBlock = params.rewindToBlock;
    job.updatedAt = new Date();
    return { success: true };
  }

  async listJobs(params?: {
    chainId?: number;
    status?: DealReplayJobStatus;
    limit?: number;
  }): Promise<DealReplayJob[]> {
    const limit = params?.limit ?? 100;
    const results: DealReplayJob[] = [];

    for (const job of this.jobs.values()) {
      if (results.length >= limit) break;
      if (params?.chainId !== undefined && job.chainId !== params.chainId) continue;
      if (params?.status !== undefined && job.status !== params.status) continue;
      results.push({ ...job });
    }

    return results;
  }

  async clear(): Promise<void> {
    this.jobs.clear();
  }
}

function mapRowToJob(row: any): DealReplayJob {
  const claimToken = row.claimToken !== undefined ? row.claimToken : (row.claim_token ?? null);
  const claimExpiresAt = row.claimExpiresAt !== undefined
    ? (row.claimExpiresAt ? new Date(row.claimExpiresAt) : null)
    : (row.claim_expires_at ? new Date(row.claim_expires_at) : null);
  const lastError = row.lastError !== undefined ? row.lastError : (row.last_error ?? null);
  const completedAt = row.completedAt !== undefined
    ? (row.completedAt ? new Date(row.completedAt) : null)
    : (row.completed_at ? new Date(row.completed_at) : null);
  const lastProcessedBlock = row.lastProcessedBlock !== undefined
    ? (row.lastProcessedBlock !== null ? BigInt(row.lastProcessedBlock) : null)
    : (row.last_processed_block !== null && row.last_processed_block !== undefined ? BigInt(row.last_processed_block) : null);

  return {
    id: row.id,
    chainId: row.chainId ?? row.chain_id,
    contractAddress: row.contractAddress ?? row.contract_address,
    contractType: (row.contractType ?? row.contract_type) as DealReplayContractType,
    generation: (row.generation ?? row.generation) as DealReplayGeneration,
    fromBlock: BigInt(row.fromBlock ?? row.from_block),
    toBlock: BigInt(row.toBlock ?? row.to_block),
    lastProcessedBlock,
    status: row.status as DealReplayJobStatus,
    retryCount: row.retryCount ?? row.retry_count,
    maxRetries: row.maxRetries ?? row.max_retries,
    claimToken: claimToken ?? null,
    claimExpiresAt,
    lastError: lastError ?? null,
    nextRetryAt: row.nextRetryAt ? new Date(row.nextRetryAt) : new Date(row.next_retry_at),
    completedAt,
    createdAt: row.createdAt ? new Date(row.createdAt) : new Date(row.created_at),
    updatedAt: row.updatedAt ? new Date(row.updatedAt) : new Date(row.updated_at),
  };
}

export class DrizzleDealReplayRepository implements IDealReplayRepository {
  async createJob(params: CreateReplayJobParams): Promise<{ status: 'created' | 'exists'; job: DealReplayJob }> {
    const db = getDb();
    const id = formatReplayJobId(params.chainId, params.contractAddress);
    const normAddr = normalizeWallet(params.contractAddress);

    // Check if job exists
    const existing = await db
      .select()
      .from(dealReplayJobs)
      .where(eq(dealReplayJobs.id, id))
      .limit(1);

    if (existing.length > 0) {
      return { status: 'exists', job: mapRowToJob(existing[0]) };
    }

    const inserted = await db
      .insert(dealReplayJobs)
      .values({
        id,
        chainId: params.chainId,
        contractAddress: normAddr,
        contractType: params.contractType,
        generation: params.generation,
        fromBlock: params.fromBlock.toString(),
        toBlock: params.toBlock.toString(),
        lastProcessedBlock: null,
        status: 'pending',
        retryCount: 0,
        maxRetries: params.maxRetries ?? DEFAULT_MAX_REPLAY_RETRIES,
      })
      .onConflictDoNothing({ target: dealReplayJobs.id })
      .returning();

    if (inserted.length > 0) {
      return { status: 'created', job: mapRowToJob(inserted[0]) };
    }

    // Handled race condition: read back the existing row
    const rechecked = await db
      .select()
      .from(dealReplayJobs)
      .where(eq(dealReplayJobs.id, id))
      .limit(1);

    if (rechecked.length > 0) {
      return { status: 'exists', job: mapRowToJob(rechecked[0]) };
    }

    throw new Error(`Failed to create or retrieve replay job ${id}`);
  }

  async getJob(chainId: number, contractAddress: string): Promise<DealReplayJob | null> {
    const id = formatReplayJobId(chainId, contractAddress);
    return this.getJobById(id);
  }

  async getJobById(id: string): Promise<DealReplayJob | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(dealReplayJobs)
      .where(eq(dealReplayJobs.id, id))
      .limit(1);

    return rows.length > 0 ? mapRowToJob(rows[0]) : null;
  }

  async claimPendingJobs(params?: {
    chainId?: number;
    limit?: number;
    claimDurationMs?: number;
    workerId?: string;
  }): Promise<DealReplayJob[]> {
    const db = getDb();
    const limit = params?.limit ?? 5;
    const duration = params?.claimDurationMs ?? DEFAULT_REPLAY_CLAIM_DURATION_MS;
    const workerPrefix = params?.workerId ? `${params.workerId}-` : '';

    const chainFilter = params?.chainId !== undefined
      ? sql`AND chain_id = ${params.chainId}`
      : sql``;

    const result = await db.execute<any>(sql`
      WITH candidate AS (
        SELECT id
        FROM deal_replay_jobs
        WHERE (status = 'pending' OR (status = 'processing' AND claim_expires_at <= now()))
          AND next_retry_at <= now()
          AND retry_count < max_retries
          ${chainFilter}
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE deal_replay_jobs
      SET status = 'processing',
          claim_token = ${workerPrefix} || gen_random_uuid()::text,
          claim_expires_at = now() + (${duration} * interval '1 millisecond'),
          updated_at = now()
      FROM candidate
      WHERE deal_replay_jobs.id = candidate.id
      RETURNING deal_replay_jobs.*
    `);

    const rows = Array.isArray(result) ? result : Array.from((result as any) || []);
    return rows.map((r: any) => mapRowToJob(r));
  }

  async updateProgress(params: {
    id: string;
    claimToken: string;
    lastProcessedBlock: bigint;
  }): Promise<{ success: boolean; error?: string }> {
    const db = getDb();
    const now = new Date();

    const updated = await db
      .update(dealReplayJobs)
      .set({
        lastProcessedBlock: params.lastProcessedBlock.toString(),
        updatedAt: now,
      })
      .where(
        and(
          eq(dealReplayJobs.id, params.id),
          eq(dealReplayJobs.claimToken, params.claimToken),
          eq(dealReplayJobs.status, 'processing'),
          sql`${dealReplayJobs.claimExpiresAt} > now()`
        )
      )
      .returning();

    if (updated.length === 0) {
      return { success: false, error: 'Fenced: Stale lease or invalid claim token' };
    }
    return { success: true };
  }

  async markCompleted(params: {
    id: string;
    claimToken: string;
    finalProcessedBlock: bigint;
  }): Promise<{ success: boolean; error?: string }> {
    const db = getDb();
    const now = new Date();

    const updated = await db
      .update(dealReplayJobs)
      .set({
        status: 'completed',
        lastProcessedBlock: params.finalProcessedBlock.toString(),
        completedAt: now,
        claimToken: null,
        claimExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(dealReplayJobs.id, params.id),
          eq(dealReplayJobs.claimToken, params.claimToken),
          eq(dealReplayJobs.status, 'processing'),
          sql`${dealReplayJobs.claimExpiresAt} > now()`
        )
      )
      .returning();

    if (updated.length === 0) {
      return { success: false, error: 'Fenced: Stale lease or invalid claim token' };
    }
    return { success: true };
  }

  async markFailed(params: {
    id: string;
    claimToken: string;
    error: string;
    retryable?: boolean;
    backoffSeconds?: number;
  }): Promise<{ success: boolean; error?: string }> {
    const db = getDb();
    const now = new Date();

    const current = await this.getJobById(params.id);
    if (!current) {
      return { success: false, error: 'Job not found' };
    }
    if (current.claimToken !== params.claimToken) {
      return { success: false, error: 'Fenced: Stale lease or invalid claim token' };
    }

    const nextRetryCount = current.retryCount + 1;
    const isTerminal = params.retryable === false || nextRetryCount >= current.maxRetries;
    const backoffSec = params.backoffSeconds ?? Math.min(60 * 60, Math.pow(2, nextRetryCount) * 5);
    const nextRetry = new Date(now.getTime() + backoffSec * 1000);

    const updated = await db
      .update(dealReplayJobs)
      .set({
        status: isTerminal ? 'failed' : 'pending',
        retryCount: nextRetryCount,
        lastError: params.error,
        nextRetryAt: isTerminal ? now : nextRetry,
        claimToken: null,
        claimExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(dealReplayJobs.id, params.id),
          eq(dealReplayJobs.claimToken, params.claimToken),
          eq(dealReplayJobs.status, 'processing')
        )
      )
      .returning();

    if (updated.length === 0) {
      return { success: false, error: 'Fenced: Stale lease' };
    }
    return { success: true };
  }

  async rewindProgress(params: {
    id: string;
    claimToken: string;
    rewindToBlock: bigint;
  }): Promise<{ success: boolean; error?: string }> {
    const db = getDb();
    const now = new Date();

    const updated = await db
      .update(dealReplayJobs)
      .set({
        lastProcessedBlock: params.rewindToBlock.toString(),
        updatedAt: now,
      })
      .where(
        and(
          eq(dealReplayJobs.id, params.id),
          eq(dealReplayJobs.claimToken, params.claimToken),
          eq(dealReplayJobs.status, 'processing')
        )
      )
      .returning();

    if (updated.length === 0) {
      return { success: false, error: 'Fenced: Stale lease or invalid claim token' };
    }
    return { success: true };
  }

  async listJobs(params?: {
    chainId?: number;
    status?: DealReplayJobStatus;
    limit?: number;
  }): Promise<DealReplayJob[]> {
    const db = getDb();
    const limit = params?.limit ?? 100;

    let query = db.select().from(dealReplayJobs);
    const conditions = [];

    if (params?.chainId !== undefined) {
      conditions.push(eq(dealReplayJobs.chainId, params.chainId));
    }
    if (params?.status !== undefined) {
      conditions.push(eq(dealReplayJobs.status, params.status));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const rows = await query.limit(limit);
    return rows.map(mapRowToJob);
  }
}

let activeReplayRepo: IDealReplayRepository = new InMemoryDealReplayRepository();

export function getDealReplayRepository(): IDealReplayRepository {
  return activeReplayRepo;
}

export function setDealReplayRepository(repo: IDealReplayRepository): void {
  activeReplayRepo = repo;
}
