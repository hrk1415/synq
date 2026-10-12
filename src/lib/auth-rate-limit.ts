/**
 * Server-Enforced OTP Request Rate Limiting (B.12.3.27)
 *
 * Prevents OTP abuse across:
 * - Calling the API directly
 * - Refreshing the browser or clearing client cookies/storage
 * - Switching browser sessions or IP spoofing
 * - Rapid repeated requests targeting the same email
 * - Rapid repeated requests originating from the same authenticated wallet
 *
 * Enforces:
 * 1. 60-second cooldown between successive OTP code requests.
 * 2. Hourly burst limit (maximum 5 requests per hour).
 *
 * Persists in PostgreSQL `otp_rate_limits` table with in-memory fallback for testing.
 */

import { getDb } from '@/db';
import { otpRateLimits, type OtpRateLimitRow } from '@/db/schema';
import { normalizeWallet } from '@/lib/utils';
import { eq, sql } from 'drizzle-orm';

export const OTP_COOLDOWN_SECONDS = 60;
export const OTP_HOURLY_WINDOW_MS = 60 * 60 * 1000;
export const OTP_HOURLY_MAX_REQUESTS = 5;

export interface OtpRateLimitStatus {
  key: string;
  lastRequestedAt: Date;
  requestCount: number;
  windowStart: Date;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfter?: number; // In seconds
  reason?: 'cooldown' | 'hourly_limit';
  target?: 'email' | 'wallet';
}

export interface IOtpRateLimitRepository {
  get(key: string): Promise<OtpRateLimitStatus | null>;
  upsert(key: string, data: { lastRequestedAt: Date; requestCount: number; windowStart: Date }): Promise<void>;
  reset(key: string): Promise<void>;
  clearAll(): Promise<void>;
  checkAndRecord?(
    keysToCheck: { key: string; target: 'email' | 'wallet' }[],
    now: Date,
  ): Promise<RateLimitCheckResult>;
}

export class OtpRateLimitPersistenceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'OtpRateLimitPersistenceError';
  }
}

export class RateLimitCheckRejection extends Error {
  constructor(public readonly result: RateLimitCheckResult) {
    super('RateLimitCheckRejection');
    this.name = 'RateLimitCheckRejection';
  }
}

export class DrizzleOtpRateLimitRepository implements IOtpRateLimitRepository {
  constructor(private customDb?: any) {}

  private getDb() {
    return this.customDb !== undefined ? this.customDb : getDb();
  }

  async get(key: string): Promise<OtpRateLimitStatus | null> {
    try {
      const db = this.getDb();
      if (!db) {
        throw new OtpRateLimitPersistenceError('Database connection unavailable');
      }
      const rows = await db
        .select()
        .from(otpRateLimits)
        .where(eq(otpRateLimits.key, key.toLowerCase()));
      if (!rows[0] || rows[0].requestCount === 0) return null;
      return {
        key: rows[0].key,
        lastRequestedAt: new Date(rows[0].lastRequestedAt),
        requestCount: rows[0].requestCount,
        windowStart: new Date(rows[0].windowStart),
      };
    } catch (err: any) {
      if (err instanceof OtpRateLimitPersistenceError) throw err;
      throw new OtpRateLimitPersistenceError(
        `Failed to read OTP rate limit for ${key}: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }

  async upsert(
    key: string,
    data: { lastRequestedAt: Date; requestCount: number; windowStart: Date },
  ): Promise<void> {
    try {
      const db = this.getDb();
      if (!db) {
        throw new OtpRateLimitPersistenceError('Database connection unavailable');
      }
      const normalizedKey = key.toLowerCase();
      await db
        .insert(otpRateLimits)
        .values({
          key: normalizedKey,
          lastRequestedAt: data.lastRequestedAt,
          requestCount: data.requestCount,
          windowStart: data.windowStart,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: otpRateLimits.key,
          set: {
            lastRequestedAt: data.lastRequestedAt,
            requestCount: data.requestCount,
            windowStart: data.windowStart,
            updatedAt: new Date(),
          },
        });
    } catch (err: any) {
      if (err instanceof OtpRateLimitPersistenceError) throw err;
      throw new OtpRateLimitPersistenceError(
        `Failed to upsert OTP rate limit for ${key}: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }

  async reset(key: string): Promise<void> {
    try {
      const db = this.getDb();
      if (!db) return;
      await db.delete(otpRateLimits).where(eq(otpRateLimits.key, key.toLowerCase()));
    } catch {
      // Ignore
    }
  }

  async clearAll(): Promise<void> {
    try {
      const db = this.getDb();
      if (!db) return;
      await db.delete(otpRateLimits);
    } catch {
      // Ignore
    }
  }

  async checkAndRecord(
    keysToCheck: { key: string; target: 'email' | 'wallet' }[],
    now: Date,
  ): Promise<RateLimitCheckResult> {
    if (keysToCheck.length === 0) {
      return { allowed: true };
    }

    const db = this.getDb();
    if (!db) {
      throw new OtpRateLimitPersistenceError('Database connection unavailable');
    }

    // 1. Sort keys deterministically to guarantee deadlock-free locking order
    const sortedKeys = [...keysToCheck].sort((a, b) => a.key.localeCompare(b.key));
    const nowMs = now.getTime();

    try {
      return await db.transaction(async (tx: any) => {
        // Enforce bounded lock timeout so transactions never hang indefinitely under contention
        await tx.execute(sql`SET LOCAL lock_timeout = '5000ms';`);

        // 2. Ensure all rows exist using atomic INSERT ... ON CONFLICT DO NOTHING in deterministic order
        for (const item of sortedKeys) {
          await tx
            .insert(otpRateLimits)
            .values({
              key: item.key.toLowerCase(),
              lastRequestedAt: new Date(0),
              requestCount: 0,
              windowStart: new Date(0),
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing({ target: otpRateLimits.key });
        }

        // 3. Lock all keys FOR UPDATE in deterministic order
        const lockedRows = await tx
          .select()
          .from(otpRateLimits)
          .where(
            sql`${otpRateLimits.key} IN (${sql.join(
              sortedKeys.map((k) => sql`${k.key.toLowerCase()}`),
              sql`, `,
            )})`,
          )
          .orderBy(otpRateLimits.key)
          .for('update');

        const rowMap = new Map<string, typeof otpRateLimits.$inferSelect>();
        for (const row of lockedRows) {
          rowMap.set(row.key.toLowerCase(), row);
        }

        // 4. Evaluate limits across all keys
        for (const { key, target } of sortedKeys) {
          const row = rowMap.get(key.toLowerCase());
          if (!row || row.requestCount === 0) {
            continue;
          }

          const lastMs = new Date(row.lastRequestedAt).getTime();
          const elapsedSinceLastSec = (nowMs - lastMs) / 1000;

          // Check 60-second cooldown
          if (elapsedSinceLastSec < OTP_COOLDOWN_SECONDS) {
            const retryAfter = Math.max(1, Math.ceil(OTP_COOLDOWN_SECONDS - elapsedSinceLastSec));
            throw new RateLimitCheckRejection({
              allowed: false,
              retryAfter,
              reason: 'cooldown',
              target,
            });
          }

          // Check hourly limit
          const windowStartMs = new Date(row.windowStart).getTime();
          if (nowMs - windowStartMs < OTP_HOURLY_WINDOW_MS) {
            if (row.requestCount >= OTP_HOURLY_MAX_REQUESTS) {
              const remainingWindowSec = Math.max(
                1,
                Math.ceil((OTP_HOURLY_WINDOW_MS - (nowMs - windowStartMs)) / 1000),
              );
              throw new RateLimitCheckRejection({
                allowed: false,
                retryAfter: remainingWindowSec,
                reason: 'hourly_limit',
                target,
              });
            }
          }
        }

        // 5. If all keys passed, update them within the same atomic transaction
        for (const { key } of sortedKeys) {
          const row = rowMap.get(key.toLowerCase());
          const isFresh =
            !row ||
            row.requestCount === 0 ||
            nowMs - new Date(row.windowStart).getTime() >= OTP_HOURLY_WINDOW_MS;

          if (isFresh) {
            await tx
              .update(otpRateLimits)
              .set({
                lastRequestedAt: now,
                requestCount: 1,
                windowStart: now,
                updatedAt: now,
              })
              .where(eq(otpRateLimits.key, key.toLowerCase()));
          } else {
            await tx
              .update(otpRateLimits)
              .set({
                lastRequestedAt: now,
                requestCount: row.requestCount + 1,
                updatedAt: now,
              })
              .where(eq(otpRateLimits.key, key.toLowerCase()));
          }
        }

        return { allowed: true };
      });
    } catch (err: any) {
      if (err instanceof RateLimitCheckRejection) {
        // Transaction was rolled back cleanly by PostgreSQL
        return err.result;
      }
      if (err instanceof OtpRateLimitPersistenceError) {
        throw err;
      }
      throw new OtpRateLimitPersistenceError(
        `Failed to atomically evaluate OTP rate limit: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }
}

export class InMemoryOtpRateLimitRepository implements IOtpRateLimitRepository {
  private records = new Map<string, OtpRateLimitStatus>();

  async get(key: string): Promise<OtpRateLimitStatus | null> {
    const item = this.records.get(key.toLowerCase());
    return item ? { ...item } : null;
  }

  async upsert(
    key: string,
    data: { lastRequestedAt: Date; requestCount: number; windowStart: Date },
  ): Promise<void> {
    this.records.set(key.toLowerCase(), {
      key: key.toLowerCase(),
      lastRequestedAt: new Date(data.lastRequestedAt),
      requestCount: data.requestCount,
      windowStart: new Date(data.windowStart),
    });
  }

  async reset(key: string): Promise<void> {
    this.records.delete(key.toLowerCase());
  }

  async clearAll(): Promise<void> {
    this.records.clear();
  }

  async checkAndRecord(
    keysToCheck: { key: string; target: 'email' | 'wallet' }[],
    now: Date,
  ): Promise<RateLimitCheckResult> {
    return withKeyLocks(keysToCheck.map((k) => k.key), async () => {
      const nowMs = now.getTime();
      for (const { key, target } of keysToCheck) {
        const status = await this.get(key);
        if (!status) continue;

        const lastMs = status.lastRequestedAt.getTime();
        const elapsedSinceLastSec = (nowMs - lastMs) / 1000;

        if (elapsedSinceLastSec < OTP_COOLDOWN_SECONDS) {
          const retryAfter = Math.max(1, Math.ceil(OTP_COOLDOWN_SECONDS - elapsedSinceLastSec));
          return {
            allowed: false,
            retryAfter,
            reason: 'cooldown',
            target,
          };
        }

        const windowStartMs = status.windowStart.getTime();
        if (nowMs - windowStartMs < OTP_HOURLY_WINDOW_MS) {
          if (status.requestCount >= OTP_HOURLY_MAX_REQUESTS) {
            const remainingWindowSec = Math.max(
              1,
              Math.ceil((OTP_HOURLY_WINDOW_MS - (nowMs - windowStartMs)) / 1000),
            );
            return {
              allowed: false,
              retryAfter: remainingWindowSec,
              reason: 'hourly_limit',
              target,
            };
          }
        }
      }

      for (const { key } of keysToCheck) {
        const existing = await this.get(key);
        if (!existing || nowMs - existing.windowStart.getTime() >= OTP_HOURLY_WINDOW_MS) {
          await this.upsert(key, {
            lastRequestedAt: now,
            requestCount: 1,
            windowStart: now,
          });
        } else {
          await this.upsert(key, {
            lastRequestedAt: now,
            requestCount: existing.requestCount + 1,
            windowStart: existing.windowStart,
          });
        }
      }

      return { allowed: true };
    });
  }
}

let _repoInstance: IOtpRateLimitRepository | null = null;

export function getOtpRateLimitRepository(): IOtpRateLimitRepository {
  if (!_repoInstance) {
    if (process.env.NODE_ENV === 'test' || !process.env.DATABASE_URL) {
      _repoInstance = new InMemoryOtpRateLimitRepository();
    } else {
      _repoInstance = new DrizzleOtpRateLimitRepository();
    }
  }
  return _repoInstance;
}

export function setOtpRateLimitRepositoryForTest(repo: IOtpRateLimitRepository | null): void {
  _repoInstance = repo;
}

const keyLocks = new Map<string, Promise<void>>();

async function withKeyLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const sortedKeys = [...new Set(keys.map(k => k.toLowerCase()))].sort();
  if (sortedKeys.length === 0) {
    return fn();
  }

  while (true) {
    const existing = sortedKeys.map(k => keyLocks.get(k)).filter(Boolean) as Promise<void>[];
    if (existing.length === 0) break;
    await Promise.all(existing);
  }

  let resolveLock!: () => void;
  const lockPromise = new Promise<void>(res => { resolveLock = res; });
  for (const k of sortedKeys) {
    keyLocks.set(k, lockPromise);
  }

  try {
    return await fn();
  } finally {
    for (const k of sortedKeys) {
      if (keyLocks.get(k) === lockPromise) {
        keyLocks.delete(k);
      }
    }
    resolveLock();
  }
}

/**
 * Checks and records an OTP verification code request against both email and wallet boundaries.
 * Returns { allowed: true } if permitted, or { allowed: false, retryAfter: seconds, reason } on rejection.
 */
export async function checkAndRecordOtpRateLimit(params: {
  email?: string;
  walletAddress?: string;
  now?: Date;
  repo?: IOtpRateLimitRepository;
}): Promise<RateLimitCheckResult> {
  const repo = params.repo || getOtpRateLimitRepository();
  const now = params.now || new Date();
  const nowMs = now.getTime();

  const keysToCheck: { key: string; target: 'email' | 'wallet' }[] = [];

  if (params.email) {
    const cleanEmail = params.email.trim().toLowerCase();
    if (cleanEmail) {
      keysToCheck.push({ key: `email:${cleanEmail}`, target: 'email' });
    }
  }

  if (params.walletAddress) {
    const cleanWallet = normalizeWallet(params.walletAddress);
    if (cleanWallet) {
      keysToCheck.push({ key: `wallet:${cleanWallet}`, target: 'wallet' });
    }
  }

  if (keysToCheck.length === 0) {
    return { allowed: true };
  }

  if (typeof repo.checkAndRecord === 'function') {
    return repo.checkAndRecord(keysToCheck, now);
  }

  return withKeyLocks(keysToCheck.map(k => k.key), async () => {
    // 1. Evaluate rate limits across all keys
    for (const { key, target } of keysToCheck) {
      const status = await repo.get(key);
      if (!status) continue;

      const lastMs = status.lastRequestedAt.getTime();
      const elapsedSinceLastSec = (nowMs - lastMs) / 1000;

      // Check 60-second cooldown
      if (elapsedSinceLastSec < OTP_COOLDOWN_SECONDS) {
        const retryAfter = Math.max(1, Math.ceil(OTP_COOLDOWN_SECONDS - elapsedSinceLastSec));
        return {
          allowed: false,
          retryAfter,
          reason: 'cooldown',
          target,
        };
      }

      // Check hourly limit
      const windowStartMs = status.windowStart.getTime();
      if (nowMs - windowStartMs < OTP_HOURLY_WINDOW_MS) {
        if (status.requestCount >= OTP_HOURLY_MAX_REQUESTS) {
          const remainingWindowSec = Math.max(1, Math.ceil((OTP_HOURLY_WINDOW_MS - (nowMs - windowStartMs)) / 1000));
          return {
            allowed: false,
            retryAfter: remainingWindowSec,
            reason: 'hourly_limit',
            target,
          };
        }
      }
    }

    // 2. If all keys passed, record the request
    for (const { key } of keysToCheck) {
      const existing = await repo.get(key);
      if (!existing || nowMs - existing.windowStart.getTime() >= OTP_HOURLY_WINDOW_MS) {
        // Fresh window
        await repo.upsert(key, {
          lastRequestedAt: now,
          requestCount: 1,
          windowStart: now,
        });
      } else {
        // Continuing window
        await repo.upsert(key, {
          lastRequestedAt: now,
          requestCount: existing.requestCount + 1,
          windowStart: existing.windowStart,
        });
      }
    }

    return { allowed: true };
  });
}
