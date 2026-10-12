/**
 * Notification Preferences Repository (B.12.3.26)
 *
 * Provides wallet-scoped, persistent notification preferences for Synq deal lifecycles.
 * Sensible defaults: all categories default to true.
 * Evaluated at both staging time and delivery time.
 */

import { getDb } from '@/db';
import { notificationPreferences, type NotificationPreferencesRow } from '@/db/schema';
import { normalizeWallet } from '@/lib/utils';
import { eq, sql } from 'drizzle-orm';
import {
  type NotificationPreferences,
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationCategory,
  getCategoryForEvent,
  SUPPORTED_NOTIFICATION_EVENTS,
  type SupportedNotificationEvent,
  isNotificationSupported,
} from './notification-preferences-types';

export {
  type NotificationPreferences,
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationCategory,
  getCategoryForEvent,
  SUPPORTED_NOTIFICATION_EVENTS,
  type SupportedNotificationEvent,
  isNotificationSupported,
};

export interface INotificationPreferencesRepository {
  getPreferences(wallet: string): Promise<NotificationPreferences>;
  updatePreferences(wallet: string, patch: Partial<NotificationPreferences>): Promise<NotificationPreferences>;
  reset(wallet?: string): Promise<void>;
}

export class DrizzleNotificationPreferencesRepository implements INotificationPreferencesRepository {
  async getPreferences(wallet: string): Promise<NotificationPreferences> {
    if (!wallet) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    const normalized = normalizeWallet(wallet);
    try {
      const db = getDb();
      const rows = await db
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.walletAddress, normalized))
        .limit(1);

      if (!rows || rows.length === 0) {
        return { ...DEFAULT_NOTIFICATION_PREFERENCES };
      }

      const row = rows[0];
      return {
        dealProposalsAndConfirmations: Boolean(row.dealProposalsAndConfirmations),
        milestoneSubmissionsAndRevisions: Boolean(row.milestoneSubmissionsAndRevisions),
        paymentsAndCompletions: Boolean(row.paymentsAndCompletions),
        disputesAndResolutions: Boolean(row.disputesAndResolutions),
      };
    } catch {
      // Fail open to safe defaults if DB connection is unavailable
      return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    }
  }

  async updatePreferences(
    wallet: string,
    patch: Partial<NotificationPreferences>,
  ): Promise<NotificationPreferences> {
    if (!wallet) throw new Error('Wallet address is required to update notification preferences');
    const normalized = normalizeWallet(wallet);
    const db = getDb();
    const current = await this.getPreferences(normalized);
    const updated: NotificationPreferences = {
      dealProposalsAndConfirmations:
        typeof patch.dealProposalsAndConfirmations === 'boolean'
          ? patch.dealProposalsAndConfirmations
          : current.dealProposalsAndConfirmations,
      milestoneSubmissionsAndRevisions:
        typeof patch.milestoneSubmissionsAndRevisions === 'boolean'
          ? patch.milestoneSubmissionsAndRevisions
          : current.milestoneSubmissionsAndRevisions,
      paymentsAndCompletions:
        typeof patch.paymentsAndCompletions === 'boolean'
          ? patch.paymentsAndCompletions
          : current.paymentsAndCompletions,
      disputesAndResolutions:
        typeof patch.disputesAndResolutions === 'boolean'
          ? patch.disputesAndResolutions
          : current.disputesAndResolutions,
    };

    const now = new Date();
    await db
      .insert(notificationPreferences)
      .values({
        walletAddress: normalized,
        dealProposalsAndConfirmations: updated.dealProposalsAndConfirmations,
        milestoneSubmissionsAndRevisions: updated.milestoneSubmissionsAndRevisions,
        paymentsAndCompletions: updated.paymentsAndCompletions,
        disputesAndResolutions: updated.disputesAndResolutions,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: notificationPreferences.walletAddress,
        set: {
          dealProposalsAndConfirmations: updated.dealProposalsAndConfirmations,
          milestoneSubmissionsAndRevisions: updated.milestoneSubmissionsAndRevisions,
          paymentsAndCompletions: updated.paymentsAndCompletions,
          disputesAndResolutions: updated.disputesAndResolutions,
          updatedAt: now,
        },
      });

    return updated;
  }

  async reset(wallet?: string): Promise<void> {
    const db = getDb();
    if (wallet) {
      const normalized = normalizeWallet(wallet);
      await db.delete(notificationPreferences).where(eq(notificationPreferences.walletAddress, normalized));
    } else {
      await db.delete(notificationPreferences);
    }
  }
}

export class InMemoryNotificationPreferencesRepository implements INotificationPreferencesRepository {
  private store = new Map<string, NotificationPreferences>();

  async getPreferences(wallet: string): Promise<NotificationPreferences> {
    if (!wallet) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    const normalized = normalizeWallet(wallet);
    const existing = this.store.get(normalized);
    if (!existing) {
      return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    }
    return { ...existing };
  }

  async updatePreferences(
    wallet: string,
    patch: Partial<NotificationPreferences>,
  ): Promise<NotificationPreferences> {
    if (!wallet) throw new Error('Wallet address is required to update notification preferences');
    const normalized = normalizeWallet(wallet);
    const current = await this.getPreferences(normalized);
    const updated: NotificationPreferences = {
      dealProposalsAndConfirmations:
        typeof patch.dealProposalsAndConfirmations === 'boolean'
          ? patch.dealProposalsAndConfirmations
          : current.dealProposalsAndConfirmations,
      milestoneSubmissionsAndRevisions:
        typeof patch.milestoneSubmissionsAndRevisions === 'boolean'
          ? patch.milestoneSubmissionsAndRevisions
          : current.milestoneSubmissionsAndRevisions,
      paymentsAndCompletions:
        typeof patch.paymentsAndCompletions === 'boolean'
          ? patch.paymentsAndCompletions
          : current.paymentsAndCompletions,
      disputesAndResolutions:
        typeof patch.disputesAndResolutions === 'boolean'
          ? patch.disputesAndResolutions
          : current.disputesAndResolutions,
    };
    this.store.set(normalized, updated);
    return { ...updated };
  }

  async reset(wallet?: string): Promise<void> {
    if (wallet) {
      this.store.delete(normalizeWallet(wallet));
    } else {
      this.store.clear();
    }
  }
}

let _overrideRepo: INotificationPreferencesRepository | null = null;
let _defaultDrizzleRepo: INotificationPreferencesRepository | null = null;

export function getNotificationPreferencesRepository(): INotificationPreferencesRepository {
  if (_overrideRepo) return _overrideRepo;
  if (!_defaultDrizzleRepo) {
    _defaultDrizzleRepo = new DrizzleNotificationPreferencesRepository();
  }
  return _defaultDrizzleRepo;
}

export function setNotificationPreferencesRepositoryForTest(
  repo: INotificationPreferencesRepository | null,
): void {
  _overrideRepo = repo;
}

/**
 * Checks whether an email notification for a specific event should be dispatched
 * to the given wallet, based on user-configured preferences.
 *
 * Returns true if allowed, false if suppressed by user opt-out.
 * System events (like OTP verification codes) return true unconditionally.
 */
export async function isNotificationAllowed(wallet: string, event: string): Promise<boolean> {
  if (!wallet) return false;
  const normalized = (event || '').trim().toLowerCase();

  // Transactional account-security events are independent and always allowed
  if (normalized === 'email_verification_code' || normalized === 'email_sign_in_otp') {
    return true;
  }

  // Unsupported event names must not be silently treated as supported functionality
  if (!isNotificationSupported(normalized)) {
    return false;
  }

  const category = getCategoryForEvent(normalized);
  if (!category) return false;

  try {
    const repo = getNotificationPreferencesRepository();
    const prefs = await repo.getPreferences(wallet);
    return Boolean(prefs[category]);
  } catch {
    // Fail open to default enabled if preferences check fails
    return true;
  }
}
