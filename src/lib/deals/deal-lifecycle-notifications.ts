/**
 * Synq V2 Deal Lifecycle Automatic Notification Dispatcher (B.12.3.64)
 *
 * Implements server-side and lifecycle-integrated email notifications across:
 * 1. proposal_received (proposal created -> freelancer notified, outbox reconciled)
 * 2. deal_confirmed (proposal accepted/reconciled -> freelancer notified)
 * 3. work_submitted (milestone submission reconciled -> client notified)
 * 4. payment_released (milestone approval -> freelancer notified)
 * 5. deal_completed & deal_completed_seller (final milestone completed -> client and freelancer notified)
 *
 * Security & Reliability Invariants:
 * - Authoritative state only: never trusts arbitrary client-supplied payloads
 * - Strict deduplication: canonical event keys bound to dealAddress, event, milestone, and version
 * - Recipient preferences and verified email enforced before delivery
 * - Fault isolation: notification errors never roll back or fail on-chain deal state or API responses
 */

import {
  notifyProposalReceived,
  notifyBuyerDealConfirmed,
  notifyDealConfirmedToSeller,
  notifyBuyerWorkSubmitted,
  notifySellerPaymentReleased,
  notifyBuyerDealCompleted,
  notifySellerDealCompleted,
  resolveEmailFromDb,
  formatDealAmount,
  formatUsdcBaseUnits,
  type MailResult,
} from '@/lib/notify';
import {
  getNotificationsRepository,
  generateCanonicalDealEventKey,
  type NotificationClaimResult,
} from '@/lib/deals/notifications-db';
import { getDealOutboxRepository, deriveOutboxEventId } from '@/lib/deals/outbox-db';
import { isNotificationAllowed } from '@/lib/deals/notification-preferences-db';
import type { DealProposalRow } from '@/lib/deals/proposals-db';
import { normalizeWallet } from '@/lib/utils';

export interface LifecycleNotificationResult {
  event: string;
  recipientWallet: string;
  dispatched: boolean;
  skipped: boolean;
  reason?: string;
  deliveryStatus?: string;
  messageId?: string;
}

/**
 * 1. Proposal Created -> Notify Freelancer (proposal_received)
 */
export async function dispatchProposalCreatedNotification(
  proposal: DealProposalRow,
): Promise<LifecycleNotificationResult> {
  const event = 'proposal_received';
  const recipientWallet = normalizeWallet(proposal.freelancerWallet);
  const chainId = proposal.chainId || 11155111;
  const dealId = proposal.proposalId.toLowerCase();

  try {
    const notifRepo = getNotificationsRepository();
    const eventKey = generateCanonicalDealEventKey({
      chainId,
      dealId,
      event,
      recipientRole: 'seller',
    });

    const claim: NotificationClaimResult = await notifRepo.claimPending(
      eventKey,
      {
        dealId,
        event,
        recipientWallet,
      },
      { fenced: true },
    );

    if (claim.status === 'duplicate_delivered' || String(claim) === 'duplicate_delivered') {
      return { event, recipientWallet, dispatched: false, skipped: true, reason: 'Duplicate event already delivered' };
    }

    if (claim.status === 'duplicate_pending' || String(claim) === 'duplicate_pending') {
      return { event, recipientWallet, dispatched: false, skipped: true, reason: 'Notification delivery in-flight' };
    }

    // Check verified email and preferences
    const email = await resolveEmailFromDb(recipientWallet);
    const allowed = await isNotificationAllowed(recipientWallet, event);

    const outboxId = deriveOutboxEventId({
      chainId,
      dealId,
      event,
      recipientWallet,
    });
    const outboxRepo = getDealOutboxRepository();

    if (!email) {
      await notifRepo.markSkipped(eventKey, 'No verified email linked to recipient wallet', claim.claimToken);
      try { await outboxRepo.markSkipped(outboxId, 'No verified email linked'); } catch {}
      return { event, recipientWallet, dispatched: false, skipped: true, reason: 'No verified email' };
    }

    if (!allowed) {
      await notifRepo.markSkipped(eventKey, `Recipient opted out of ${event} notifications`, claim.claimToken);
      try { await outboxRepo.markSkipped(outboxId, 'Recipient opted out'); } catch {}
      return { event, recipientWallet, dispatched: false, skipped: true, reason: 'Recipient opted out' };
    }

    const displayAmount = formatDealAmount(proposal.totalAmount);
    const mailRes: MailResult = await notifyProposalReceived({
      event,
      dealId,
      recipientWallet,
      dealTitle: proposal.title || 'Untitled deal',
      dealAmount: displayAmount,
      note: 'A client created a new proposal for you.',
    });

    if (mailRes.deliveryStatus === 'delivered' || (mailRes.mode === 'smtp' && !mailRes.error)) {
      await notifRepo.markDelivered(eventKey, mailRes.messageId, mailRes.to, claim.claimToken);
      try { await outboxRepo.markProcessed(outboxId); } catch {}
      return { event, recipientWallet, dispatched: true, skipped: false, deliveryStatus: 'delivered', messageId: mailRes.messageId };
    } else if (mailRes.deliveryStatus === 'log_only' || mailRes.mode === 'log') {
      await notifRepo.markDeferred(eventKey, mailRes.error || 'SMTP delivery disabled (log mode)', claim.claimToken);
      return { event, recipientWallet, dispatched: true, skipped: false, deliveryStatus: 'log_only' };
    } else {
      await notifRepo.markFailed(eventKey, mailRes.error || 'Transient delivery failure', claim.claimToken);
      return { event, recipientWallet, dispatched: false, skipped: false, deliveryStatus: 'failed', reason: mailRes.error };
    }
  } catch (err: any) {
    console.warn('[LifecycleNotify] Failed to dispatch proposal_received:', err?.message || err);
    return { event, recipientWallet, dispatched: false, skipped: false, reason: err?.message || 'Dispatch error' };
  }
}

/**
 * 2. Proposal Accepted / Deal Confirmed -> Notify Client (deal_confirmed)
 * Freelancer accepted proposal on-chain; client/buyer is notified.
 * Freelancer does NOT receive an acceptance confirmation email.
 */
export async function dispatchProposalAcceptedNotification(
  proposal: DealProposalRow,
  dealAddress?: string,
  txHash?: string,
): Promise<LifecycleNotificationResult> {
  const event = 'deal_confirmed';
  const recipientWallet = normalizeWallet(proposal.clientWallet);
  const freelancerWallet = normalizeWallet(proposal.freelancerWallet);
  const chainId = proposal.chainId || 11155111;
  const targetDeal = (dealAddress || proposal.dealAddress || proposal.proposalId).toLowerCase();

  try {
    const notifRepo = getNotificationsRepository();
    const eventKey = generateCanonicalDealEventKey({
      chainId,
      dealId: targetDeal,
      contractAddress: dealAddress || proposal.dealAddress || undefined,
      event,
      recipientRole: 'buyer',
    });

    const claim: NotificationClaimResult = await notifRepo.claimPending(
      eventKey,
      {
        dealId: targetDeal,
        event,
        recipientWallet,
      },
      { fenced: true },
    );

    if (claim.status === 'duplicate_delivered' || String(claim) === 'duplicate_delivered') {
      return { event, recipientWallet, dispatched: false, skipped: true, reason: 'Duplicate event already delivered' };
    }

    if (claim.status === 'duplicate_pending' || String(claim) === 'duplicate_pending') {
      return { event, recipientWallet, dispatched: false, skipped: true, reason: 'Notification delivery in-flight' };
    }

    const email = await resolveEmailFromDb(recipientWallet);
    const allowed = await isNotificationAllowed(recipientWallet, event);

    if (!email) {
      await notifRepo.markSkipped(eventKey, 'No verified email linked to recipient wallet', claim.claimToken);
      return { event, recipientWallet, dispatched: false, skipped: true, reason: 'No verified email' };
    }

    if (!allowed) {
      await notifRepo.markSkipped(eventKey, `Recipient opted out of ${event} notifications`, claim.claimToken);
      return { event, recipientWallet, dispatched: false, skipped: true, reason: 'Recipient opted out' };
    }

    const displayAmount = formatDealAmount(proposal.totalAmount);
    const mailRes: MailResult = await notifyBuyerDealConfirmed({
      event,
      dealId: targetDeal,
      recipientWallet,
      freelancerWallet,
      dealTitle: proposal.title || 'Untitled deal',
      dealAmount: displayAmount,
      note: 'Funds are locked in escrow and the deal is now active.',
      link: dealAddress || proposal.dealAddress ? `/deals/${dealAddress || proposal.dealAddress}` : `/deals/proposals/${proposal.proposalId}`,
    });

    if (mailRes.deliveryStatus === 'delivered' || (mailRes.mode === 'smtp' && !mailRes.error)) {
      await notifRepo.markDelivered(eventKey, mailRes.messageId, mailRes.to, claim.claimToken);
      return { event, recipientWallet, dispatched: true, skipped: false, deliveryStatus: 'delivered', messageId: mailRes.messageId };
    } else if (mailRes.deliveryStatus === 'log_only' || mailRes.mode === 'log') {
      await notifRepo.markDeferred(eventKey, mailRes.error || 'SMTP delivery disabled (log mode)', claim.claimToken);
      return { event, recipientWallet, dispatched: true, skipped: false, deliveryStatus: 'log_only' };
    } else {
      await notifRepo.markFailed(eventKey, mailRes.error || 'Transient delivery failure', claim.claimToken);
      return { event, recipientWallet, dispatched: false, skipped: false, deliveryStatus: 'failed', reason: mailRes.error };
    }
  } catch (err: any) {
    console.warn('[LifecycleNotify] Failed to dispatch deal_confirmed:', err?.message || err);
    return { event, recipientWallet, dispatched: false, skipped: false, reason: err?.message || 'Dispatch error' };
  }
}

/**
 * 3. Work Submitted -> Notify Client (work_submitted)
 */
export async function dispatchWorkSubmittedNotification(params: {
  dealAddress: string;
  milestoneIndex: number;
  version: number;
  clientWallet: string;
  dealTitle?: string;
  milestoneAmount?: string | bigint;
  evidenceSummary?: string;
  txHash?: string;
}): Promise<LifecycleNotificationResult> {
  const event = 'work_submitted';
  const recipientWallet = normalizeWallet(params.clientWallet);
  const chainId = 11155111;
  const dealId = params.dealAddress.toLowerCase();

  try {
    const notifRepo = getNotificationsRepository();
    const eventKey = generateCanonicalDealEventKey({
      chainId,
      dealId,
      contractAddress: params.dealAddress,
      event,
      milestoneIndex: params.milestoneIndex,
      submissionVersion: params.version,
      txHash: params.txHash,
      recipientRole: 'buyer',
    });

    const claim: NotificationClaimResult = await notifRepo.claimPending(
      eventKey,
      {
        dealId,
        event,
        recipientWallet,
      },
      { fenced: true },
    );

    if (claim.status === 'duplicate_delivered' || String(claim) === 'duplicate_delivered') {
      return { event, recipientWallet, dispatched: false, skipped: true, reason: 'Duplicate event already delivered' };
    }

    if (claim.status === 'duplicate_pending' || String(claim) === 'duplicate_pending') {
      return { event, recipientWallet, dispatched: false, skipped: true, reason: 'Notification delivery in-flight' };
    }

    const email = await resolveEmailFromDb(recipientWallet);
    const allowed = await isNotificationAllowed(recipientWallet, event);

    if (!email) {
      await notifRepo.markSkipped(eventKey, 'No verified email linked to recipient wallet', claim.claimToken);
      return { event, recipientWallet, dispatched: false, skipped: true, reason: 'No verified email' };
    }

    if (!allowed) {
      await notifRepo.markSkipped(eventKey, `Recipient opted out of ${event} notifications`, claim.claimToken);
      return { event, recipientWallet, dispatched: false, skipped: true, reason: 'Recipient opted out' };
    }

    const displayAmount = params.milestoneAmount !== undefined
      ? formatDealAmount(params.milestoneAmount)
      : '';

    const mailRes: MailResult = await notifyBuyerWorkSubmitted({
      event,
      dealId,
      recipientWallet,
      dealTitle: params.dealTitle || 'Untitled deal',
      dealAmount: displayAmount,
      evidence: params.evidenceSummary,
      note: `Milestone ${params.milestoneIndex + 1}`,
    });

    if (mailRes.deliveryStatus === 'delivered' || (mailRes.mode === 'smtp' && !mailRes.error)) {
      await notifRepo.markDelivered(eventKey, mailRes.messageId, mailRes.to, claim.claimToken);
      return { event, recipientWallet, dispatched: true, skipped: false, deliveryStatus: 'delivered', messageId: mailRes.messageId };
    } else if (mailRes.deliveryStatus === 'log_only' || mailRes.mode === 'log') {
      await notifRepo.markDeferred(eventKey, mailRes.error || 'SMTP delivery disabled (log mode)', claim.claimToken);
      return { event, recipientWallet, dispatched: true, skipped: false, deliveryStatus: 'log_only' };
    } else {
      await notifRepo.markFailed(eventKey, mailRes.error || 'Transient delivery failure', claim.claimToken);
      return { event, recipientWallet, dispatched: false, skipped: false, deliveryStatus: 'failed', reason: mailRes.error };
    }
  } catch (err: any) {
    console.warn('[LifecycleNotify] Failed to dispatch work_submitted:', err?.message || err);
    return { event, recipientWallet, dispatched: false, skipped: false, reason: err?.message || 'Dispatch error' };
  }
}

/**
 * 4. Payment Released -> Notify Freelancer (payment_released)
 */
export async function dispatchPaymentReleasedNotification(params: {
  dealAddress: string;
  milestoneIndex: number;
  freelancerWallet: string;
  dealTitle?: string;
  milestoneAmount?: string | bigint;
  txHash?: string;
}): Promise<LifecycleNotificationResult> {
  const event = 'payment_released';
  const recipientWallet = normalizeWallet(params.freelancerWallet);
  const chainId = 11155111;
  const dealId = params.dealAddress.toLowerCase();

  try {
    const notifRepo = getNotificationsRepository();
    const eventKey = generateCanonicalDealEventKey({
      chainId,
      dealId,
      contractAddress: params.dealAddress,
      event,
      milestoneIndex: params.milestoneIndex,
      txHash: params.txHash,
      recipientRole: 'seller',
    });

    const claim: NotificationClaimResult = await notifRepo.claimPending(
      eventKey,
      {
        dealId,
        event,
        recipientWallet,
      },
      { fenced: true },
    );

    if (claim.status === 'duplicate_delivered' || String(claim) === 'duplicate_delivered') {
      return { event, recipientWallet, dispatched: false, skipped: true, reason: 'Duplicate event already delivered' };
    }

    if (claim.status === 'duplicate_pending' || String(claim) === 'duplicate_pending') {
      return { event, recipientWallet, dispatched: false, skipped: true, reason: 'Notification delivery in-flight' };
    }

    const email = await resolveEmailFromDb(recipientWallet);
    const allowed = await isNotificationAllowed(recipientWallet, event);

    if (!email) {
      await notifRepo.markSkipped(eventKey, 'No verified email linked to recipient wallet', claim.claimToken);
      return { event, recipientWallet, dispatched: false, skipped: true, reason: 'No verified email' };
    }

    if (!allowed) {
      await notifRepo.markSkipped(eventKey, `Recipient opted out of ${event} notifications`, claim.claimToken);
      return { event, recipientWallet, dispatched: false, skipped: true, reason: 'Recipient opted out' };
    }

    const displayAmount = params.milestoneAmount !== undefined
      ? formatDealAmount(params.milestoneAmount)
      : '';

    const mailRes: MailResult = await notifySellerPaymentReleased({
      event,
      dealId,
      recipientWallet,
      dealTitle: params.dealTitle || 'Untitled deal',
      dealAmount: displayAmount,
      note: `Milestone ${params.milestoneIndex + 1}`,
    });

    if (mailRes.deliveryStatus === 'delivered' || (mailRes.mode === 'smtp' && !mailRes.error)) {
      await notifRepo.markDelivered(eventKey, mailRes.messageId, mailRes.to, claim.claimToken);
      return { event, recipientWallet, dispatched: true, skipped: false, deliveryStatus: 'delivered', messageId: mailRes.messageId };
    } else if (mailRes.deliveryStatus === 'log_only' || mailRes.mode === 'log') {
      await notifRepo.markDeferred(eventKey, mailRes.error || 'SMTP delivery disabled (log mode)', claim.claimToken);
      return { event, recipientWallet, dispatched: true, skipped: false, deliveryStatus: 'log_only' };
    } else {
      await notifRepo.markFailed(eventKey, mailRes.error || 'Transient delivery failure', claim.claimToken);
      return { event, recipientWallet, dispatched: false, skipped: false, deliveryStatus: 'failed', reason: mailRes.error };
    }
  } catch (err: any) {
    console.warn('[LifecycleNotify] Failed to dispatch payment_released:', err?.message || err);
    return { event, recipientWallet, dispatched: false, skipped: false, reason: err?.message || 'Dispatch error' };
  }
}

/**
 * 5. Deal Completed -> Notify Both Client and Freelancer (deal_completed & deal_completed_seller)
 */
export async function dispatchDealCompletedNotifications(params: {
  dealAddress: string;
  clientWallet: string;
  freelancerWallet: string;
  dealTitle?: string;
  totalAmount?: string | bigint;
  txHash?: string;
}): Promise<{ buyer: LifecycleNotificationResult; seller: LifecycleNotificationResult }> {
  const chainId = 11155111;
  const dealId = params.dealAddress.toLowerCase();
  const clientWallet = normalizeWallet(params.clientWallet);
  const freelancerWallet = normalizeWallet(params.freelancerWallet);
  const displayAmount = params.totalAmount !== undefined ? formatDealAmount(params.totalAmount) : '';
  const notifRepo = getNotificationsRepository();

  // 5a. Buyer Notification (deal_completed)
  let buyerRes: LifecycleNotificationResult = {
    event: 'deal_completed',
    recipientWallet: clientWallet,
    dispatched: false,
    skipped: false,
  };
  try {
    const eventKey = generateCanonicalDealEventKey({
      chainId,
      dealId,
      contractAddress: params.dealAddress,
      event: 'deal_completed',
      txHash: params.txHash,
      recipientRole: 'buyer',
    });

    const claim: NotificationClaimResult = await notifRepo.claimPending(
      eventKey,
      { dealId, event: 'deal_completed', recipientWallet: clientWallet },
      { fenced: true },
    );

    if (claim.status === 'duplicate_delivered' || String(claim) === 'duplicate_delivered') {
      buyerRes = { event: 'deal_completed', recipientWallet: clientWallet, dispatched: false, skipped: true, reason: 'Duplicate event already delivered' };
    } else if (claim.status === 'duplicate_pending' || String(claim) === 'duplicate_pending') {
      buyerRes = { event: 'deal_completed', recipientWallet: clientWallet, dispatched: false, skipped: true, reason: 'Notification delivery in-flight' };
    } else {
      const email = await resolveEmailFromDb(clientWallet);
      const allowed = await isNotificationAllowed(clientWallet, 'deal_completed');

      if (!email) {
        await notifRepo.markSkipped(eventKey, 'No verified email linked to recipient wallet', claim.claimToken);
        buyerRes = { event: 'deal_completed', recipientWallet: clientWallet, dispatched: false, skipped: true, reason: 'No verified email' };
      } else if (!allowed) {
        await notifRepo.markSkipped(eventKey, 'Recipient opted out of deal_completed notifications', claim.claimToken);
        buyerRes = { event: 'deal_completed', recipientWallet: clientWallet, dispatched: false, skipped: true, reason: 'Recipient opted out' };
      } else {
        const mailRes: MailResult = await notifyBuyerDealCompleted({
          event: 'deal_completed',
          dealId,
          recipientWallet: clientWallet,
          dealTitle: params.dealTitle || 'Untitled deal',
          dealAmount: displayAmount,
        });

        if (mailRes.deliveryStatus === 'delivered' || (mailRes.mode === 'smtp' && !mailRes.error)) {
          await notifRepo.markDelivered(eventKey, mailRes.messageId, mailRes.to, claim.claimToken);
          buyerRes = { event: 'deal_completed', recipientWallet: clientWallet, dispatched: true, skipped: false, deliveryStatus: 'delivered', messageId: mailRes.messageId };
        } else if (mailRes.deliveryStatus === 'log_only' || mailRes.mode === 'log') {
          await notifRepo.markDeferred(eventKey, mailRes.error || 'SMTP delivery disabled', claim.claimToken);
          buyerRes = { event: 'deal_completed', recipientWallet: clientWallet, dispatched: true, skipped: false, deliveryStatus: 'log_only' };
        } else {
          await notifRepo.markFailed(eventKey, mailRes.error || 'Delivery failure', claim.claimToken);
          buyerRes = { event: 'deal_completed', recipientWallet: clientWallet, dispatched: false, skipped: false, deliveryStatus: 'failed', reason: mailRes.error };
        }
      }
    }
  } catch (err: any) {
    console.warn('[LifecycleNotify] Failed to dispatch deal_completed to buyer:', err?.message || err);
    buyerRes = { event: 'deal_completed', recipientWallet: clientWallet, dispatched: false, skipped: false, reason: err?.message || 'Dispatch error' };
  }

  // 5b. Seller Notification (deal_completed_seller)
  let sellerRes: LifecycleNotificationResult = {
    event: 'deal_completed_seller',
    recipientWallet: freelancerWallet,
    dispatched: false,
    skipped: false,
  };
  try {
    const eventKey = generateCanonicalDealEventKey({
      chainId,
      dealId,
      contractAddress: params.dealAddress,
      event: 'deal_completed_seller',
      txHash: params.txHash,
      recipientRole: 'seller',
    });

    const claim: NotificationClaimResult = await notifRepo.claimPending(
      eventKey,
      { dealId, event: 'deal_completed_seller', recipientWallet: freelancerWallet },
      { fenced: true },
    );

    if (claim.status === 'duplicate_delivered' || String(claim) === 'duplicate_delivered') {
      sellerRes = { event: 'deal_completed_seller', recipientWallet: freelancerWallet, dispatched: false, skipped: true, reason: 'Duplicate event already delivered' };
    } else if (claim.status === 'duplicate_pending' || String(claim) === 'duplicate_pending') {
      sellerRes = { event: 'deal_completed_seller', recipientWallet: freelancerWallet, dispatched: false, skipped: true, reason: 'Notification delivery in-flight' };
    } else {
      const email = await resolveEmailFromDb(freelancerWallet);
      const allowed = await isNotificationAllowed(freelancerWallet, 'deal_completed_seller');

      if (!email) {
        await notifRepo.markSkipped(eventKey, 'No verified email linked to recipient wallet', claim.claimToken);
        sellerRes = { event: 'deal_completed_seller', recipientWallet: freelancerWallet, dispatched: false, skipped: true, reason: 'No verified email' };
      } else if (!allowed) {
        await notifRepo.markSkipped(eventKey, 'Recipient opted out of deal_completed_seller notifications', claim.claimToken);
        sellerRes = { event: 'deal_completed_seller', recipientWallet: freelancerWallet, dispatched: false, skipped: true, reason: 'Recipient opted out' };
      } else {
        const mailRes: MailResult = await notifySellerDealCompleted({
          event: 'deal_completed_seller',
          dealId,
          recipientWallet: freelancerWallet,
          dealTitle: params.dealTitle || 'Untitled deal',
          dealAmount: displayAmount,
        });

        if (mailRes.deliveryStatus === 'delivered' || (mailRes.mode === 'smtp' && !mailRes.error)) {
          await notifRepo.markDelivered(eventKey, mailRes.messageId, mailRes.to, claim.claimToken);
          sellerRes = { event: 'deal_completed_seller', recipientWallet: freelancerWallet, dispatched: true, skipped: false, deliveryStatus: 'delivered', messageId: mailRes.messageId };
        } else if (mailRes.deliveryStatus === 'log_only' || mailRes.mode === 'log') {
          await notifRepo.markDeferred(eventKey, mailRes.error || 'SMTP delivery disabled', claim.claimToken);
          sellerRes = { event: 'deal_completed_seller', recipientWallet: freelancerWallet, dispatched: true, skipped: false, deliveryStatus: 'log_only' };
        } else {
          await notifRepo.markFailed(eventKey, mailRes.error || 'Delivery failure', claim.claimToken);
          sellerRes = { event: 'deal_completed_seller', recipientWallet: freelancerWallet, dispatched: false, skipped: false, deliveryStatus: 'failed', reason: mailRes.error };
        }
      }
    }
  } catch (err: any) {
    console.warn('[LifecycleNotify] Failed to dispatch deal_completed_seller to seller:', err?.message || err);
    sellerRes = { event: 'deal_completed_seller', recipientWallet: freelancerWallet, dispatched: false, skipped: false, reason: err?.message || 'Dispatch error' };
  }

  return { buyer: buyerRes, seller: sellerRes };
}
