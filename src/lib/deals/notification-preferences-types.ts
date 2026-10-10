/**
 * Client-safe notification preferences definitions (B.12.3.26)
 *
 * Contains pure types, default values, and pure category mapping functions
 * safe to import in client components and server code alike.
 */

export interface NotificationPreferences {
  dealProposalsAndConfirmations: boolean;
  milestoneSubmissionsAndRevisions: boolean;
  paymentsAndCompletions: boolean;
  disputesAndResolutions: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: Readonly<NotificationPreferences> = Object.freeze({
  dealProposalsAndConfirmations: true,
  milestoneSubmissionsAndRevisions: true,
  paymentsAndCompletions: true,
  disputesAndResolutions: true,
});

export type NotificationCategory =
  | 'dealProposalsAndConfirmations'
  | 'milestoneSubmissionsAndRevisions'
  | 'paymentsAndCompletions'
  | 'disputesAndResolutions';

export const SUPPORTED_NOTIFICATION_EVENTS = [
  // 1. Deal proposals and confirmations
  'proposal_received',
  'deal_confirmed',
  'deal_cancelled',
  'order_confirmed',
  'order_inquiry',
  'chat_message',
  // 2. Milestone submissions and revision requests
  'work_submitted',
  'revision_requested',
  // 3. Payments and deal completion
  'payment_released',
  'deal_completed',
  'deal_completed_seller',
  'milestone_refunded',
  'mutual_settlement_executed',
  // 4. Disputes and resolution activity
  'milestone_disputed',
  'mutual_settlement_proposed',
  'mutual_settlement_cancelled',
  'resolution_report_filed',
  'committee_authorization_requested',
  'resolution_finalized',
] as const;

export type SupportedNotificationEvent = (typeof SUPPORTED_NOTIFICATION_EVENTS)[number];

export function isNotificationSupported(event: string): boolean {
  const normalized = (event || '').trim().toLowerCase();
  return (SUPPORTED_NOTIFICATION_EVENTS as readonly string[]).includes(normalized);
}

/**
 * Maps event types to their corresponding user-controlled preference category.
 * Returns null for system/transactional events (e.g. OTP verification codes)
 * or unsupported events that are not subject to deal preferences.
 */
export function getCategoryForEvent(event: string): NotificationCategory | null {
  const normalized = (event || '').trim().toLowerCase();
  switch (normalized) {
    case 'proposal_received':
    case 'deal_confirmed':
    case 'deal_cancelled':
    case 'order_confirmed':
    case 'order_inquiry':
    case 'chat_message':
      return 'dealProposalsAndConfirmations';

    case 'work_submitted':
    case 'revision_requested':
      return 'milestoneSubmissionsAndRevisions';

    case 'payment_released':
    case 'deal_completed':
    case 'deal_completed_seller':
    case 'milestone_refunded':
    case 'mutual_settlement_executed':
      return 'paymentsAndCompletions';

    case 'milestone_disputed':
    case 'mutual_settlement_proposed':
    case 'mutual_settlement_cancelled':
    case 'resolution_report_filed':
    case 'committee_authorization_requested':
    case 'resolution_finalized':
      return 'disputesAndResolutions';

    default:
      return null;
  }
}
