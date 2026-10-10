/**
 * Synq Deal Events Outbox Repository (B.12.3.2 / B.12.3.5)
 *
 * Durable outbox persistence for off-chain proposal notifications and asynchronous events.
 * Decouples proposal state changes from notification dispatch to guarantee delivery
 * without executing external side-effects (like SMTP) within database transactions.
 * Includes lease-based claiming, exponential backoff, and max retry ceiling.
 */

import { getDb } from '@/db';
import { dealEventsOutbox } from '@/db/schema';
import { eq, and, or, sql, lt, lte, gt, inArray } from 'drizzle-orm';
import { normalizeWallet } from '@/lib/utils';
import { isNotificationAllowed } from './notification-preferences-db';

export type OutboxStatus = 'pending' | 'processing' | 'processed' | 'failed' | 'skipped' | 'cancelled';
export type OutboxOrigin = 'on_chain' | 'off_chain';

export const OUTBOX_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000; // 5-minute crash recovery
export const MAX_OUTBOX_RETRIES = 5;

export interface DealOutboxEvent {
  id: string;
  chainId: number;
  dealId: string;
  event: string;
  recipientWallet: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  retryCount: number;
  claimToken?: string | null;
  claimedAt?: Date | null;
  nextRetryAt?: Date;
  lastError?: string | null;
  origin?: OutboxOrigin;
  blockNumber?: bigint | null;
  blockHash?: string | null;
  txHash?: string | null;
  logIndex?: number | null;
  createdAt: Date;
  updatedAt: Date;
  processedAt?: Date | null;
}

export class DealOutboxPersistenceError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'DealOutboxPersistenceError';
  }
}

/**
 * Derives a canonical deterministic event ID for an outbox entry.
 * Prevents duplicate events across retried client requests.
 */
export function deriveOutboxEventId(params: {
  chainId?: number;
  dealId: string;
  event: string;
  recipientWallet: string;
  actionId?: string;
}): string {
  const chain = params.chainId || 11155111;
  const deal = params.dealId.trim().toLowerCase();
  const wallet = normalizeWallet(params.recipientWallet);
  const parts = [`outbox:${chain}:${deal}:${params.event.trim().toLowerCase()}:${wallet}`];
  if (params.actionId) {
    parts.push(params.actionId.trim().toLowerCase());
  }
  return parts.join(':');
}

export interface IDealOutboxRepository {
  enqueue(event: {
    id: string;
    chainId: number;
    dealId: string;
    event: string;
    recipientWallet: string;
    payload: Record<string, unknown>;
    origin?: OutboxOrigin;
    blockNumber?: bigint;
    blockHash?: string;
    txHash?: string;
    logIndex?: number;
  }): Promise<'enqueued' | 'duplicate'>;

  get(id: string): Promise<DealOutboxEvent | null>;
  getPending(limit?: number): Promise<DealOutboxEvent[]>;
  claim(id: string, claimToken?: string): Promise<boolean>;
  releaseClaim(id: string, delaySeconds?: number, claimToken?: string): Promise<void>;
  markProcessed(id: string, claimToken?: string): Promise<void>;
  markFailed(id: string, error: string, claimToken?: string, permanent?: boolean): Promise<void>;
  markSkipped(id: string, reason?: string, claimToken?: string): Promise<void>;
  invalidateOrphanedEvents(chainId: number, aboveBlock: bigint): Promise<number>;
}

export class InMemoryDealOutboxRepository implements IDealOutboxRepository {
  private events = new Map<string, DealOutboxEvent>();

  async enqueue(event: {
    id: string;
    chainId: number;
    dealId: string;
    event: string;
    recipientWallet: string;
    payload: Record<string, unknown>;
    origin?: OutboxOrigin;
    blockNumber?: bigint;
    blockHash?: string;
    txHash?: string;
    logIndex?: number;
  }): Promise<'enqueued' | 'duplicate'> {
    if (this.events.has(event.id)) {
      return 'duplicate';
    }

    const now = new Date();
    const allowed = await isNotificationAllowed(event.recipientWallet, event.event);
    const created: DealOutboxEvent = {
      id: event.id,
      chainId: event.chainId,
      dealId: event.dealId.toLowerCase(),
      event: event.event.toLowerCase(),
      recipientWallet: normalizeWallet(event.recipientWallet),
      payload: { ...event.payload },
      status: allowed ? 'pending' : 'skipped',
      retryCount: 0,
      claimToken: null,
      claimedAt: null,
      nextRetryAt: now,
      lastError: allowed ? null : 'Skipped at staging: recipient opted out of notification category',
      origin: event.origin || 'off_chain',
      blockNumber: event.blockNumber ?? null,
      blockHash: event.blockHash ?? null,
      txHash: event.txHash ?? null,
      logIndex: event.logIndex ?? null,
      createdAt: now,
      updatedAt: now,
      processedAt: null,
    };
    this.events.set(event.id, created);
    return 'enqueued';
  }

  async get(id: string): Promise<DealOutboxEvent | null> {
    const item = this.events.get(id);
    return item ? { ...item, payload: { ...item.payload } } : null;
  }

  async getPending(limit = 50): Promise<DealOutboxEvent[]> {
    const list: DealOutboxEvent[] = [];
    const now = Date.now();
    for (const item of this.events.values()) {
      if (item.retryCount >= MAX_OUTBOX_RETRIES && item.status === 'failed') {
        continue;
      }

      const isStaleProcessing =
        item.status === 'processing' &&
        item.claimedAt !== null &&
        item.claimedAt !== undefined &&
        now - new Date(item.claimedAt).getTime() > OUTBOX_PROCESSING_TIMEOUT_MS;

      const isRetryableFailed =
        item.status === 'failed' &&
        item.retryCount < MAX_OUTBOX_RETRIES &&
        (!item.nextRetryAt || new Date(item.nextRetryAt).getTime() <= now);

      if (item.status === 'pending' || isRetryableFailed || isStaleProcessing) {
        list.push({ ...item, payload: { ...item.payload } });
        if (list.length >= limit) break;
      }
    }
    return list;
  }

  async claim(id: string, claimToken?: string): Promise<boolean> {
    const item = this.events.get(id);
    if (!item) return false;

    if (item.retryCount >= MAX_OUTBOX_RETRIES && item.status === 'failed') {
      return false;
    }

    const now = Date.now();
    const claimTime = item.claimedAt ? new Date(item.claimedAt).getTime() : new Date(item.createdAt).getTime();
    const isStaleProcessing =
      item.status === 'processing' &&
      now - claimTime > OUTBOX_PROCESSING_TIMEOUT_MS;

    const isRetryableFailed =
      item.status === 'failed' && item.retryCount < MAX_OUTBOX_RETRIES;

    if (item.status === 'pending' || isRetryableFailed || isStaleProcessing) {
      item.status = 'processing';
      item.claimToken = claimToken || 'mock_token';
      item.claimedAt = new Date();
      item.updatedAt = new Date();
      return true;
    }
    return false;
  }

  async releaseClaim(id: string, delaySeconds = 30, claimToken?: string): Promise<void> {
    const item = this.events.get(id);
    if (!item) return;
    if (claimToken && item.claimToken && item.claimToken !== claimToken) {
      return; // Token mismatch; lease stolen
    }
    item.status = 'failed';
    item.claimToken = null;
    item.claimedAt = null;
    item.nextRetryAt = new Date(Date.now() + delaySeconds * 1000);
    item.updatedAt = new Date();
  }

  async markProcessed(id: string, claimToken?: string): Promise<void> {
    const item = this.events.get(id);
    if (!item) return;
    if (claimToken && item.claimToken && item.claimToken !== claimToken) {
      return; // Token mismatch; lease stolen
    }
    item.status = 'processed';
    item.processedAt = new Date();
    item.claimToken = null;
    item.claimedAt = null;
    item.lastError = null;
    item.updatedAt = new Date();
  }

  async markFailed(id: string, error: string, claimToken?: string, permanent = false): Promise<void> {
    const item = this.events.get(id);
    if (!item) return;
    if (claimToken && item.claimToken && item.claimToken !== claimToken) {
      return; // Token mismatch; lease stolen
    }
    item.status = 'failed';
    item.retryCount = permanent ? MAX_OUTBOX_RETRIES : item.retryCount + 1;
    item.claimToken = null;
    item.claimedAt = null;
    item.lastError = error;

    if (permanent) {
      item.nextRetryAt = undefined;
    } else {
      const delaySeconds = Math.min(3600, Math.pow(2, item.retryCount) * 60);
      item.nextRetryAt = new Date(Date.now() + delaySeconds * 1000);
    }
    item.updatedAt = new Date();
  }

  async markSkipped(id: string, reason?: string, claimToken?: string): Promise<void> {
    const item = this.events.get(id);
    if (!item) return;
    if (claimToken && item.claimToken && item.claimToken !== claimToken) {
      return; // Token mismatch; lease stolen
    }
    item.status = 'skipped';
    item.lastError = reason || null;
    item.claimToken = null;
    item.claimedAt = null;
    item.processedAt = new Date();
    item.updatedAt = new Date();
  }

  async invalidateOrphanedEvents(chainId: number, aboveBlock: bigint): Promise<number> {
    let count = 0;
    const now = new Date();
    for (const item of this.events.values()) {
      if (
        item.chainId === chainId &&
        item.origin === 'on_chain' &&
        item.blockNumber !== undefined &&
        item.blockNumber !== null &&
        item.blockNumber > aboveBlock &&
        (item.status === 'pending' || item.status === 'processing' || item.status === 'failed')
      ) {
        item.status = 'cancelled';
        item.lastError = `Orphaned by blockchain reorganization above block ${aboveBlock}`;
        item.claimToken = null;
        item.claimedAt = null;
        item.updatedAt = now;
        count++;
      }
    }
    return count;
  }

  setEvent(event: DealOutboxEvent): void {
    if (event.status === 'processing') {
      if (
        event.createdAt &&
        event.claimedAt &&
        new Date(event.createdAt).getTime() < new Date(event.claimedAt).getTime() - OUTBOX_PROCESSING_TIMEOUT_MS
      ) {
        event.claimedAt = event.createdAt;
      } else if (event.createdAt && !event.claimedAt) {
        event.claimedAt = event.createdAt;
      }
    }
    this.events.set(event.id, { ...event });
  }

  clear(): void {
    this.events.clear();
  }
}

export class DrizzleDealOutboxRepository implements IDealOutboxRepository {
  async enqueue(event: {
    id: string;
    chainId: number;
    dealId: string;
    event: string;
    recipientWallet: string;
    payload: Record<string, unknown>;
    origin?: OutboxOrigin;
    blockNumber?: bigint;
    blockHash?: string;
    txHash?: string;
    logIndex?: number;
  }): Promise<'enqueued' | 'duplicate'> {
    try {
      const db = getDb();
      if (!db) {
        throw new DealOutboxPersistenceError('Database connection unavailable');
      }

      const now = new Date();
      const allowed = await isNotificationAllowed(event.recipientWallet, event.event);
      const res = await db
        .insert(dealEventsOutbox)
        .values({
          id: event.id,
          chainId: event.chainId,
          dealId: event.dealId.toLowerCase(),
          event: event.event.toLowerCase(),
          recipientWallet: normalizeWallet(event.recipientWallet),
          payload: event.payload,
          status: allowed ? 'pending' : 'skipped',
          retryCount: 0,
          origin: event.origin || 'off_chain',
          blockNumber: event.blockNumber ? event.blockNumber.toString() : null,
          blockHash: event.blockHash || null,
          txHash: event.txHash || null,
          logIndex: event.logIndex ?? null,
          nextRetryAt: now,
          lastError: allowed ? null : 'Skipped at staging: recipient opted out of notification category',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: dealEventsOutbox.id })
        .returning();

      if (!res || res.length === 0) {
        return 'duplicate';
      }
      return 'enqueued';
    } catch (err: any) {
      if (err instanceof DealOutboxPersistenceError) throw err;
      throw new DealOutboxPersistenceError(
        `Failed to enqueue outbox event ${event.id}: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }

  async get(id: string): Promise<DealOutboxEvent | null> {
    try {
      const db = getDb();
      if (!db) {
        throw new DealOutboxPersistenceError('Database connection unavailable');
      }

      const rows = await db
        .select()
        .from(dealEventsOutbox)
        .where(eq(dealEventsOutbox.id, id))
        .limit(1);

      if (!rows || rows.length === 0) return null;
      const row = rows[0];
      return {
        id: row.id,
        chainId: row.chainId,
        dealId: row.dealId,
        event: row.event,
        recipientWallet: row.recipientWallet,
        payload: (row.payload as Record<string, unknown>) || {},
        status: row.status as OutboxStatus,
        retryCount: row.retryCount,
        claimToken: row.claimToken,
        claimedAt: row.claimedAt ? new Date(row.claimedAt) : null,
        nextRetryAt: new Date(row.nextRetryAt),
        lastError: row.lastError,
        origin: row.origin as OutboxOrigin,
        blockNumber: row.blockNumber ? BigInt(row.blockNumber) : null,
        blockHash: row.blockHash,
        txHash: row.txHash,
        logIndex: row.logIndex,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
        processedAt: row.processedAt ? new Date(row.processedAt) : null,
      };
    } catch (err: any) {
      if (err instanceof DealOutboxPersistenceError) throw err;
      throw new DealOutboxPersistenceError(
        `Failed to retrieve outbox event ${id}: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }

  async getPending(limit = 50): Promise<DealOutboxEvent[]> {
    try {
      const db = getDb();
      if (!db) {
        throw new DealOutboxPersistenceError('Database connection unavailable');
      }

      const now = new Date();
      const staleCutoff = new Date(Date.now() - OUTBOX_PROCESSING_TIMEOUT_MS);

      const rows = await db
        .select()
        .from(dealEventsOutbox)
        .where(
          and(
            lt(dealEventsOutbox.retryCount, MAX_OUTBOX_RETRIES),
            or(
              eq(dealEventsOutbox.status, 'pending'),
              and(
                eq(dealEventsOutbox.status, 'failed'),
                lte(dealEventsOutbox.nextRetryAt, now),
              ),
              and(
                eq(dealEventsOutbox.status, 'processing'),
                lt(dealEventsOutbox.claimedAt, staleCutoff),
              ),
            ),
          ),
        )
        .limit(limit);

      return rows.map((row) => ({
        id: row.id,
        chainId: row.chainId,
        dealId: row.dealId,
        event: row.event,
        recipientWallet: row.recipientWallet,
        payload: (row.payload as Record<string, unknown>) || {},
        status: row.status as OutboxStatus,
        retryCount: row.retryCount,
        claimToken: row.claimToken,
        claimedAt: row.claimedAt ? new Date(row.claimedAt) : null,
        nextRetryAt: new Date(row.nextRetryAt),
        lastError: row.lastError,
        origin: row.origin as OutboxOrigin,
        blockNumber: row.blockNumber ? BigInt(row.blockNumber) : null,
        blockHash: row.blockHash,
        txHash: row.txHash,
        logIndex: row.logIndex,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
        processedAt: row.processedAt ? new Date(row.processedAt) : null,
      }));
    } catch (err: any) {
      if (err instanceof DealOutboxPersistenceError) throw err;
      throw new DealOutboxPersistenceError(
        `Failed to query pending outbox events: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }

  async claim(id: string, claimToken = crypto.randomUUID()): Promise<boolean> {
    try {
      const db = getDb();
      if (!db) {
        throw new DealOutboxPersistenceError('Database connection unavailable');
      }

      const now = new Date();
      const staleCutoff = new Date(Date.now() - OUTBOX_PROCESSING_TIMEOUT_MS);

      const result = await db
        .update(dealEventsOutbox)
        .set({
          status: 'processing',
          claimToken,
          claimedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(dealEventsOutbox.id, id),
            lt(dealEventsOutbox.retryCount, MAX_OUTBOX_RETRIES),
            or(
              eq(dealEventsOutbox.status, 'pending'),
              and(
                eq(dealEventsOutbox.status, 'failed'),
                lte(dealEventsOutbox.nextRetryAt, now),
              ),
              and(
                eq(dealEventsOutbox.status, 'processing'),
                lt(dealEventsOutbox.claimedAt, staleCutoff),
              ),
            ),
          ),
        )
        .returning();

      return result.length > 0;
    } catch (err: any) {
      if (err instanceof DealOutboxPersistenceError) throw err;
      throw new DealOutboxPersistenceError(
        `Failed to claim outbox event ${id}: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }

  async releaseClaim(id: string, delaySeconds = 30, claimToken?: string): Promise<void> {
    try {
      const db = getDb();
      if (!db) {
        throw new DealOutboxPersistenceError('Database connection unavailable');
      }

      const now = new Date();
      const nextRetry = new Date(Date.now() + delaySeconds * 1000);
      const conditions = [eq(dealEventsOutbox.id, id)];
      if (claimToken) {
        conditions.push(eq(dealEventsOutbox.claimToken, claimToken));
      }

      await db
        .update(dealEventsOutbox)
        .set({
          status: 'failed',
          nextRetryAt: nextRetry,
          claimToken: null,
          claimedAt: null,
          updatedAt: now,
        })
        .where(and(...conditions));
    } catch (err: any) {
      if (err instanceof DealOutboxPersistenceError) throw err;
      throw new DealOutboxPersistenceError(
        `Failed to release claim on outbox event ${id}: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }

  async markProcessed(id: string, claimToken?: string): Promise<void> {
    try {
      const db = getDb();
      if (!db) {
        throw new DealOutboxPersistenceError('Database connection unavailable');
      }

      const now = new Date();
      const conditions = [eq(dealEventsOutbox.id, id)];
      if (claimToken) {
        conditions.push(eq(dealEventsOutbox.claimToken, claimToken));
      }

      await db
        .update(dealEventsOutbox)
        .set({
          status: 'processed',
          processedAt: now,
          claimToken: null,
          claimedAt: null,
          lastError: null,
          updatedAt: now,
        })
        .where(and(...conditions));
    } catch (err: any) {
      if (err instanceof DealOutboxPersistenceError) throw err;
      throw new DealOutboxPersistenceError(
        `Failed to mark outbox event ${id} processed: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }

  async markFailed(id: string, error: string, claimToken?: string, permanent = false): Promise<void> {
    try {
      const db = getDb();
      if (!db) {
        throw new DealOutboxPersistenceError('Database connection unavailable');
      }

      const now = new Date();
      const current = await this.get(id);
      const newRetries = permanent ? MAX_OUTBOX_RETRIES : (current?.retryCount ?? 0) + 1;
      const delaySeconds = Math.min(3600, Math.pow(2, newRetries) * 60);
      const nextRetry = permanent ? undefined : new Date(Date.now() + delaySeconds * 1000);

      const conditions = [eq(dealEventsOutbox.id, id)];
      if (claimToken) {
        conditions.push(eq(dealEventsOutbox.claimToken, claimToken));
      }

      await db
        .update(dealEventsOutbox)
        .set({
          status: 'failed',
          retryCount: permanent ? MAX_OUTBOX_RETRIES : sql`${dealEventsOutbox.retryCount} + 1`,
          nextRetryAt: nextRetry,
          claimToken: null,
          claimedAt: null,
          lastError: error,
          updatedAt: now,
        })
        .where(and(...conditions));
    } catch (err: any) {
      if (err instanceof DealOutboxPersistenceError) throw err;
      throw new DealOutboxPersistenceError(
        `Failed to mark outbox event ${id} failed: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }

  async markSkipped(id: string, reason?: string, claimToken?: string): Promise<void> {
    try {
      const db = getDb();
      if (!db) {
        throw new DealOutboxPersistenceError('Database connection unavailable');
      }

      const now = new Date();
      const conditions = [eq(dealEventsOutbox.id, id)];
      if (claimToken) {
        conditions.push(eq(dealEventsOutbox.claimToken, claimToken));
      }

      await db
        .update(dealEventsOutbox)
        .set({
          status: 'skipped',
          lastError: reason || null,
          claimToken: null,
          claimedAt: null,
          processedAt: now,
          updatedAt: now,
        })
        .where(and(...conditions));
    } catch (err: any) {
      if (err instanceof DealOutboxPersistenceError) throw err;
      throw new DealOutboxPersistenceError(
        `Failed to mark outbox event ${id} skipped: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }

  async invalidateOrphanedEvents(chainId: number, aboveBlock: bigint): Promise<number> {
    try {
      const db = getDb();
      if (!db) throw new DealOutboxPersistenceError('Database connection unavailable');

      const now = new Date();
      const res = await db
        .update(dealEventsOutbox)
        .set({
          status: 'cancelled',
          lastError: sql`'Orphaned by blockchain reorganization above block ' || ${aboveBlock.toString()}`,
          claimToken: null,
          claimedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(dealEventsOutbox.chainId, chainId),
            eq(dealEventsOutbox.origin, 'on_chain'),
            gt(dealEventsOutbox.blockNumber, aboveBlock.toString()),
            inArray(dealEventsOutbox.status, ['pending', 'processing', 'failed']),
          ),
        )
        .returning();

      return res.length;
    } catch (err: any) {
      if (err instanceof DealOutboxPersistenceError) throw err;
      throw new DealOutboxPersistenceError(
        `Failed to invalidate orphaned outbox events on chain ${chainId} above block ${aboveBlock}: ${err?.message || err}`,
        err,
      );
    }
  }
}

// Global repository singleton
let globalOutboxRepo: IDealOutboxRepository | null = null;

export function getDealOutboxRepository(): IDealOutboxRepository {
  if (globalOutboxRepo) return globalOutboxRepo;
  return new DrizzleDealOutboxRepository();
}

export function setDealOutboxRepository(repo: IDealOutboxRepository | null): void {
  globalOutboxRepo = repo;
}

export function resetDealOutboxRepository(): void {
  globalOutboxRepo = null;
}
