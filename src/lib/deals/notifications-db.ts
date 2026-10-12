/**
 * Synq Deal Notification Persistence & Deduplication Layer (B.12.2.3 Hardening)
 *
 * Provides durable, repository-backed idempotency, concurrency management,
 * and delivery tracking across deal notification lifecycles.
 */

import { getDb } from '@/db';
import { dealNotifications } from '@/db/schema';
import { eq, and, or, lt } from 'drizzle-orm';
import { normalizeWallet } from '@/lib/utils';

export type NotificationStatus = 'pending' | 'delivered' | 'skipped' | 'failed' | 'deferred';

export const PENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes recovery threshold
export const DEFERRED_COOLDOWN_MS = 60 * 1000; // 60 seconds minimum backoff between deferred retry attempts

export class NotificationPersistenceError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'NotificationPersistenceError';
  }
}

export interface NotificationRecord {
  id: string;
  dealId: string;
  event: string;
  recipientWallet: string;
  recipientEmail?: string | null;
  status: NotificationStatus;
  claimToken?: string | null;
  messageId?: string | null;
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CanonicalDealEventKeyParams {
  chainId?: number;
  dealId?: string;
  contractAddress?: string;
  event: string;
  milestoneIndex?: number;
  submissionVersion?: number;
  submissionId?: string;
  txHash?: string;
  logIndex?: number;
  recipientRole?: string;
  recipientWallet?: string;
  includeLogIndex?: boolean;
}

export function generateNotificationKey(params: CanonicalDealEventKeyParams): string {
  return generateCanonicalDealEventKey(params);
}

/**
 * Generates a canonical deal event identity for cross-caller (client and autonomous server) compatibility.
 * Policy:
 * 1. Terminal deal events (deal_completed, deal_completed_seller, deal_cancelled) are deduplicated per deal and recipient.
 * 2. Deal funding confirmation (deal_confirmed) is deduplicated as a one-time logical transition per deal.
 * 3. Milestone submissions (work_submitted) include submission version/id for off-chain submissions, or txHash for on-chain.
 * 4. Milestone settlements and disputes include milestone index and on-chain log identity.
 */
export function generateCanonicalDealEventKey(params: CanonicalDealEventKeyParams): string {
  const chain = params.chainId || 11155111;
  const deal = (params.contractAddress || params.dealId || '').toLowerCase();
  const event = params.event.toLowerCase();
  const role = params.recipientRole?.toLowerCase();

  // 1. Terminal deal events: exactly once per deal and recipient role
  if (event === 'deal_completed' || event === 'deal_completed_seller' || event === 'deal_cancelled') {
    const parts = [`${chain}:${deal}:${event}`];
    if (role) {
      parts.push(`role:${role}`);
    } else if (params.recipientWallet) {
      parts.push(`to:${params.recipientWallet.toLowerCase()}`);
    }
    return parts.join(':');
  }

  // 2. Deal funding confirmation: exactly once per deal
  if (event === 'deal_confirmed') {
    const parts = [`${chain}:${deal}:deal_confirmed`];
    if (role) {
      parts.push(`role:${role}`);
    } else if (params.recipientWallet) {
      parts.push(`to:${params.recipientWallet.toLowerCase()}`);
    }
    return parts.join(':');
  }

  // 3. Multi-instance milestone events (work_submitted, revisions, settlements, disputes)
  const parts = [`${chain}:${deal}:${event}`];
  if (params.milestoneIndex !== undefined) {
    parts.push(`ms:${params.milestoneIndex}`);
  }
  if (params.submissionVersion !== undefined) {
    parts.push(`v:${params.submissionVersion}`);
  } else if (params.submissionId) {
    parts.push(`sub:${params.submissionId.toLowerCase()}`);
  }
  if (params.includeLogIndex && params.txHash) {
    parts.push(`tx:${params.txHash.toLowerCase()}`);
    if (params.logIndex !== undefined) {
      parts.push(`log:${params.logIndex}`);
    }
  }
  if (role) {
    parts.push(`role:${role}`);
  } else if (params.recipientWallet) {
    parts.push(`to:${params.recipientWallet.toLowerCase()}`);
  }
  return parts.join(':');
}

export type NotificationClaimStatus = 'claimed' | 'duplicate_delivered' | 'duplicate_pending';

export interface NotificationClaimResult {
  status: NotificationClaimStatus;
  claimToken?: string;
}

export type ClaimPendingOptions = { fenced?: boolean; claimToken?: string; bypassCooldown?: boolean } | string;

export interface INotificationsRepository {
  get(id: string): Promise<NotificationRecord | null>;
  claimPending(
    id: string,
    metadata: { dealId: string; event: string; recipientWallet: string },
    options: { fenced: true; bypassCooldown?: boolean } | { claimToken: string; bypassCooldown?: boolean },
  ): Promise<NotificationClaimResult>;
  claimPending(
    id: string,
    metadata: { dealId: string; event: string; recipientWallet: string },
    options?: ClaimPendingOptions,
  ): Promise<NotificationClaimStatus | NotificationClaimResult>;
  markDelivered(id: string, messageId?: string, recipientEmail?: string, claimToken?: string): Promise<boolean>;
  markSkipped(id: string, reason?: string, claimToken?: string): Promise<boolean>;
  markFailed(id: string, error: string, claimToken?: string): Promise<boolean>;
  markDeferred(id: string, reason?: string, claimToken?: string): Promise<boolean>;
  clear?(): void;
}

export class InMemoryNotificationsRepository implements INotificationsRepository {
  private records = new Map<string, NotificationRecord>();

  async get(id: string): Promise<NotificationRecord | null> {
    const r = this.records.get(id);
    return r ? { ...r } : null;
  }

  async claimPending(
    id: string,
    metadata: { dealId: string; event: string; recipientWallet: string },
    options?: ClaimPendingOptions,
  ): Promise<any> {
    const isFenced = Boolean(
      typeof options === 'object' && (options?.fenced || options?.claimToken)
    );
    const customToken = typeof options === 'string' ? options : (typeof options === 'object' ? options?.claimToken : undefined);
    const bypassCooldown = typeof options === 'object' && Boolean(options?.bypassCooldown);
    const token = customToken || crypto.randomUUID();
    const now = new Date();
    const existing = this.records.get(id);

    if (existing) {
      if (existing.status === 'delivered') {
        return isFenced ? { status: 'duplicate_delivered' } : 'duplicate_delivered';
      }
      const isStale = existing.status === 'pending' && (now.getTime() - new Date(existing.updatedAt).getTime() > PENDING_TIMEOUT_MS);
      if (existing.status === 'pending' && !isStale) {
        return isFenced ? { status: 'duplicate_pending' } : 'duplicate_pending';
      }
      const isDeferredCooldown = existing.status === 'deferred' && (now.getTime() - new Date(existing.updatedAt).getTime() < DEFERRED_COOLDOWN_MS);
      if (existing.status === 'deferred' && isDeferredCooldown && !bypassCooldown) {
        return isFenced ? { status: 'duplicate_pending' } : 'duplicate_pending';
      }

      // Atomic claim in memory
      existing.status = 'pending';
      existing.claimToken = token;
      existing.updatedAt = now;
      existing.error = null;
      return isFenced ? { status: 'claimed', claimToken: token } : 'claimed';
    }

    const record: NotificationRecord = {
      id,
      dealId: metadata.dealId,
      event: metadata.event,
      recipientWallet: normalizeWallet(metadata.recipientWallet),
      status: 'pending',
      claimToken: token,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(id, record);
    return isFenced ? { status: 'claimed', claimToken: token } : 'claimed';
  }

  async markDelivered(id: string, messageId?: string, recipientEmail?: string, claimToken?: string): Promise<boolean> {
    const existing = this.records.get(id);
    if (!existing) return false;
    if (existing.status !== 'pending') return false;
    if (claimToken && existing.claimToken && existing.claimToken !== claimToken) return false;

    existing.status = 'delivered';
    existing.messageId = messageId || null;
    existing.recipientEmail = recipientEmail || null;
    existing.claimToken = null;
    existing.error = null;
    existing.updatedAt = new Date();
    return true;
  }

  async markSkipped(id: string, reason?: string, claimToken?: string): Promise<boolean> {
    const existing = this.records.get(id);
    if (!existing) return false;
    if (existing.status !== 'pending') return false;
    if (claimToken && existing.claimToken && existing.claimToken !== claimToken) return false;

    existing.status = 'skipped';
    existing.error = reason || 'Skipped';
    existing.claimToken = null;
    existing.updatedAt = new Date();
    return true;
  }

  async markFailed(id: string, error: string, claimToken?: string): Promise<boolean> {
    const existing = this.records.get(id);
    if (!existing) return false;
    if (existing.status !== 'pending') return false;
    if (claimToken && existing.claimToken && existing.claimToken !== claimToken) return false;

    existing.status = 'failed';
    existing.error = error;
    existing.claimToken = null;
    existing.updatedAt = new Date();
    return true;
  }

  async markDeferred(id: string, reason?: string, claimToken?: string): Promise<boolean> {
    const existing = this.records.get(id);
    if (!existing) return false;
    if (existing.status !== 'pending') return false;
    if (claimToken && existing.claimToken && existing.claimToken !== claimToken) return false;

    existing.status = 'deferred';
    existing.error = reason || 'Deferred (log-only mode)';
    existing.claimToken = null;
    existing.updatedAt = new Date();
    return true;
  }

  setRecord(record: NotificationRecord) {
    this.records.set(record.id, { ...record });
  }

  clear() {
    this.records.clear();
  }
}

export class DrizzleNotificationsRepository implements INotificationsRepository {
  async get(id: string): Promise<NotificationRecord | null> {
    try {
      const db = getDb();
      if (!db) {
        throw new NotificationPersistenceError('Database connection unavailable');
      }
      const rows = await db
        .select()
        .from(dealNotifications)
        .where(eq(dealNotifications.id, id))
        .limit(1);
      if (rows[0]) {
        return {
          id: rows[0].id,
          dealId: rows[0].dealId,
          event: rows[0].event,
          recipientWallet: rows[0].recipientWallet,
          recipientEmail: rows[0].recipientEmail,
          status: rows[0].status as NotificationStatus,
          claimToken: rows[0].claimToken,
          messageId: rows[0].messageId,
          error: rows[0].error,
          createdAt: rows[0].createdAt,
          updatedAt: rows[0].updatedAt,
        };
      }
      return null;
    } catch (err: any) {
      if (err instanceof NotificationPersistenceError) throw err;
      throw new NotificationPersistenceError('Failed to query deal notification from database', err);
    }
  }

  async claimPending(
    id: string,
    metadata: { dealId: string; event: string; recipientWallet: string },
    options?: ClaimPendingOptions,
  ): Promise<any> {
    const isFenced = Boolean(
      typeof options === 'object' && (options?.fenced || options?.claimToken)
    );
    const customToken = typeof options === 'string' ? options : (typeof options === 'object' ? options?.claimToken : undefined);
    const bypassCooldown = typeof options === 'object' && Boolean(options?.bypassCooldown);
    const token = customToken || crypto.randomUUID();

    try {
      const db = getDb();
      if (!db) {
        throw new NotificationPersistenceError('Database connection unavailable');
      }
      const now = new Date();
      const staleCutoff = new Date(Date.now() - PENDING_TIMEOUT_MS);
      const deferredCutoff = new Date(Date.now() - DEFERRED_COOLDOWN_MS);

      // 1. Try to insert new record with onConflictDoNothing
      try {
        const inserted = await db
          .insert(dealNotifications)
          .values({
            id,
            dealId: metadata.dealId,
            event: metadata.event,
            recipientWallet: normalizeWallet(metadata.recipientWallet),
            status: 'pending',
            claimToken: token,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: dealNotifications.id })
          .returning();

        if (inserted && inserted.length > 0) {
          return isFenced ? { status: 'claimed', claimToken: token } : 'claimed';
        }
      } catch (insertErr: any) {
        const isUniqueViolation =
          insertErr?.code === '23505' ||
          String(insertErr?.message || '').toLowerCase().includes('unique') ||
          String(insertErr?.message || '').toLowerCase().includes('duplicate');
        if (!isUniqueViolation) {
          throw insertErr;
        }
      }

      const deferredCondition = bypassCooldown
        ? eq(dealNotifications.status, 'deferred')
        : and(
            eq(dealNotifications.status, 'deferred'),
            lt(dealNotifications.updatedAt, deferredCutoff),
          );

      // 2. Record exists: attempt atomic conditional claim on failed or stale records
      const updated = await db
        .update(dealNotifications)
        .set({ status: 'pending', claimToken: token, updatedAt: now, error: null })
        .where(
          and(
            eq(dealNotifications.id, id),
            or(
              eq(dealNotifications.status, 'failed'),
              deferredCondition,
              and(
                eq(dealNotifications.status, 'pending'),
                lt(dealNotifications.updatedAt, staleCutoff),
              ),
            ),
          ),
        )
        .returning();

      if (updated && updated.length > 0) {
        return isFenced ? { status: 'claimed', claimToken: token } : 'claimed';
      }

      // 3. Update did not claim row: inspect existing row state
      const current = await this.get(id);
      if (current?.status === 'delivered') {
        return isFenced ? { status: 'duplicate_delivered' } : 'duplicate_delivered';
      }
      return isFenced ? { status: 'duplicate_pending' } : 'duplicate_pending';
    } catch (err: any) {
      if (err instanceof NotificationPersistenceError) throw err;
      throw new NotificationPersistenceError('Durable notification claim failed; storage unavailable', err);
    }
  }

  async markDelivered(id: string, messageId?: string, recipientEmail?: string, claimToken?: string): Promise<boolean> {
    try {
      const db = getDb();
      if (!db) throw new NotificationPersistenceError('Database connection unavailable');

      const conditions = [
        eq(dealNotifications.id, id),
        eq(dealNotifications.status, 'pending'),
      ];
      if (claimToken) {
        conditions.push(eq(dealNotifications.claimToken, claimToken));
      }

      const res = await db
        .update(dealNotifications)
        .set({
          status: 'delivered',
          messageId: messageId || null,
          recipientEmail: recipientEmail || null,
          claimToken: null,
          error: null,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      return res.length > 0;
    } catch (err: any) {
      throw new NotificationPersistenceError('Failed to record delivered notification in database', err);
    }
  }

  async markSkipped(id: string, reason?: string, claimToken?: string): Promise<boolean> {
    try {
      const db = getDb();
      if (!db) throw new NotificationPersistenceError('Database connection unavailable');

      const conditions = [
        eq(dealNotifications.id, id),
        eq(dealNotifications.status, 'pending'),
      ];
      if (claimToken) {
        conditions.push(eq(dealNotifications.claimToken, claimToken));
      }

      const res = await db
        .update(dealNotifications)
        .set({
          status: 'skipped',
          error: reason || 'Skipped',
          claimToken: null,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      return res.length > 0;
    } catch (err: any) {
      throw new NotificationPersistenceError('Failed to record skipped notification in database', err);
    }
  }

  async markFailed(id: string, error: string, claimToken?: string): Promise<boolean> {
    try {
      const db = getDb();
      if (!db) throw new NotificationPersistenceError('Database connection unavailable');

      const conditions = [
        eq(dealNotifications.id, id),
        eq(dealNotifications.status, 'pending'),
      ];
      if (claimToken) {
        conditions.push(eq(dealNotifications.claimToken, claimToken));
      }

      const res = await db
        .update(dealNotifications)
        .set({
          status: 'failed',
          error,
          claimToken: null,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      return res.length > 0;
    } catch (err: any) {
      throw new NotificationPersistenceError('Failed to record failed notification in database', err);
    }
  }

  async markDeferred(id: string, reason?: string, claimToken?: string): Promise<boolean> {
    try {
      const db = getDb();
      if (!db) throw new NotificationPersistenceError('Database connection unavailable');

      const conditions = [
        eq(dealNotifications.id, id),
        eq(dealNotifications.status, 'pending'),
      ];
      if (claimToken) {
        conditions.push(eq(dealNotifications.claimToken, claimToken));
      }

      const res = await db
        .update(dealNotifications)
        .set({
          status: 'deferred',
          error: reason || 'Deferred (log-only mode)',
          claimToken: null,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      return res.length > 0;
    } catch (err: any) {
      throw new NotificationPersistenceError('Failed to record deferred notification in database', err);
    }
  }
}

let activeRepo: INotificationsRepository = new DrizzleNotificationsRepository();

export function setNotificationsRepository(repo: INotificationsRepository) {
  activeRepo = repo;
}

export function resetNotificationsRepository() {
  activeRepo = new DrizzleNotificationsRepository();
}

export function getNotificationsRepository(): INotificationsRepository {
  return activeRepo;
}
