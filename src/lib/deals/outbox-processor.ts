/**
 * Synq Outbox Processor (B.12.3.3 / B.12.3.5)
 *
 * Bounded processor for deal_events_outbox with lease claiming, backoff scheduling,
 * duplicate suppression, and non-blocking duplicate_pending deferral.
 */

import {
  getDealOutboxRepository,
  type IDealOutboxRepository,
  type DealOutboxEvent,
} from './outbox-db';
import { parseNotificationLiveStartBlock } from './chain-scanner';
import {
  getNotificationsRepository,
  type INotificationsRepository,
  generateCanonicalDealEventKey,
  getEquivalentNotificationKeys,
} from './notifications-db';
import {
  notifyProposalReceived,
  notifyBuyerDealConfirmed,
  notifyDealConfirmedToSeller,
  notifyBuyerWorkSubmitted,
  notifyFreelancerRevisionRequested,
  notifySellerPaymentReleased,
  notifyBuyerDealCompleted,
  notifySellerDealCompleted,
  notifyDealCancelled,
  notifyMilestoneDisputed,
  notifyBuyerMilestoneRefunded,
  notifyMutualSettlementProposed,
  notifyMutualSettlementExecuted,
  notifyMutualSettlementCancelled,
  notifyResolutionReportFiled,
  notifyCommitteeAuthorizationRequested,
  notifyResolutionFinalized,
  formatDealAmount,
  type MailResult,
  type DeliveryStatus,
} from '@/lib/notify';

export interface DispatchResult {
  success: boolean;
  deliveryStatus?: DeliveryStatus;
  skipped?: boolean;
  reason?: string;
  error?: string;
  messageId?: string;
}

export interface INotificationDispatcher {
  dispatch(
    event: string,
    params: {
      dealId: string;
      dealTitle?: string;
      dealAmount?: string;
      recipientWallet: string;
      recipientRole?: 'buyer' | 'seller';
      milestoneIndex?: number;
      evidence?: string;
      note?: string;
    },
  ): Promise<DispatchResult>;
}

/**
 * Default production dispatcher using notify.ts templates.
 */
export class DefaultNotificationDispatcher implements INotificationDispatcher {
  async dispatch(
    event: string,
    p: {
      dealId: string;
      dealTitle?: string;
      dealAmount?: string;
      recipientWallet: string;
      recipientRole?: 'buyer' | 'seller';
      milestoneIndex?: number;
      evidence?: string;
      note?: string;
    },
  ): Promise<DispatchResult> {
    try {
      let mailRes: MailResult;

      switch (event) {
        case 'proposal_received':
          mailRes = await notifyProposalReceived({
            event,
            dealId: p.dealId,
            dealTitle: p.dealTitle,
            dealAmount: p.dealAmount,
            recipientWallet: p.recipientWallet,
            note: p.note,
          });
          break;

        case 'deal_confirmed':
          if (p.recipientRole === 'seller') {
            mailRes = await notifyDealConfirmedToSeller({
              event,
              dealId: p.dealId,
              dealTitle: p.dealTitle,
              dealAmount: p.dealAmount,
              recipientWallet: p.recipientWallet,
              note: p.note,
            });
          } else {
            mailRes = await notifyBuyerDealConfirmed({
              event,
              dealId: p.dealId,
              dealTitle: p.dealTitle,
              dealAmount: p.dealAmount,
              recipientWallet: p.recipientWallet,
              note: p.note,
            });
          }
          break;

        case 'work_submitted':
          mailRes = await notifyBuyerWorkSubmitted({
            event,
            dealId: p.dealId,
            dealTitle: p.dealTitle,
            dealAmount: p.dealAmount,
            recipientWallet: p.recipientWallet,
            evidence: p.evidence,
            note: p.milestoneIndex !== undefined ? `Milestone #${p.milestoneIndex + 1}` : p.note,
          });
          break;

        case 'revision_requested':
          mailRes = await notifyFreelancerRevisionRequested({
            event,
            dealId: p.dealId,
            dealTitle: p.dealTitle,
            dealAmount: p.dealAmount,
            recipientWallet: p.recipientWallet,
            evidence: p.evidence,
            note: p.milestoneIndex !== undefined ? `Milestone #${p.milestoneIndex + 1}` : p.note,
          });
          break;

        case 'payment_released':
          mailRes = await notifySellerPaymentReleased({
            event,
            dealId: p.dealId,
            dealTitle: p.dealTitle,
            dealAmount: p.dealAmount,
            recipientWallet: p.recipientWallet,
            note: p.milestoneIndex !== undefined ? `Milestone #${p.milestoneIndex + 1}` : p.note,
          });
          break;

        case 'milestone_refunded':
          mailRes = await notifyBuyerMilestoneRefunded({
            event,
            dealId: p.dealId,
            dealTitle: p.dealTitle,
            dealAmount: p.dealAmount,
            recipientWallet: p.recipientWallet,
            note: p.milestoneIndex !== undefined ? `Milestone #${p.milestoneIndex + 1}` : p.note,
          });
          break;

        case 'deal_completed':
          mailRes = await notifyBuyerDealCompleted({
            event,
            dealId: p.dealId,
            dealTitle: p.dealTitle,
            dealAmount: p.dealAmount,
            recipientWallet: p.recipientWallet,
            note: p.note,
          });
          break;

        case 'deal_completed_seller':
          mailRes = await notifySellerDealCompleted({
            event,
            dealId: p.dealId,
            dealTitle: p.dealTitle,
            dealAmount: p.dealAmount,
            recipientWallet: p.recipientWallet,
            note: p.note,
          });
          break;

        case 'deal_cancelled':
          mailRes = await notifyDealCancelled({
            event,
            dealId: p.dealId,
            dealTitle: p.dealTitle,
            dealAmount: p.dealAmount,
            recipientWallet: p.recipientWallet,
            note: p.note,
          });
          break;

        case 'milestone_disputed':
          mailRes = await notifyMilestoneDisputed({
            event,
            dealId: p.dealId,
            dealTitle: p.dealTitle,
            recipientWallet: p.recipientWallet,
            note: p.milestoneIndex !== undefined ? `Milestone #${p.milestoneIndex + 1}` : p.note,
          });
          break;

        case 'mutual_settlement_proposed':
          mailRes = await notifyMutualSettlementProposed({
            event,
            dealId: p.dealId,
            dealTitle: p.dealTitle,
            dealAmount: p.dealAmount,
            recipientWallet: p.recipientWallet,
            note: p.milestoneIndex !== undefined ? `Milestone #${p.milestoneIndex + 1}` : p.note,
          });
          break;

        case 'mutual_settlement_executed':
          mailRes = await notifyMutualSettlementExecuted({
            event,
            dealId: p.dealId,
            dealTitle: p.dealTitle,
            dealAmount: p.dealAmount,
            recipientWallet: p.recipientWallet,
            note: p.milestoneIndex !== undefined ? `Milestone #${p.milestoneIndex + 1}` : p.note,
          });
          break;

        case 'mutual_settlement_cancelled':
          mailRes = await notifyMutualSettlementCancelled({
            event,
            dealId: p.dealId,
            dealTitle: p.dealTitle,
            recipientWallet: p.recipientWallet,
            note: p.milestoneIndex !== undefined ? `Milestone #${p.milestoneIndex + 1}` : p.note,
          });
          break;

        case 'resolution_report_filed':
          mailRes = await notifyResolutionReportFiled({
            event,
            dealId: p.dealId,
            dealTitle: p.dealTitle,
            recipientWallet: p.recipientWallet,
            note: p.milestoneIndex !== undefined ? `Milestone #${p.milestoneIndex + 1}` : p.note,
          });
          break;

        case 'committee_authorization_requested':
          mailRes = await notifyCommitteeAuthorizationRequested({
            event,
            dealId: p.dealId,
            dealTitle: p.dealTitle,
            recipientWallet: p.recipientWallet,
            note: p.note,
          });
          break;

        case 'resolution_finalized':
          mailRes = await notifyResolutionFinalized({
            event,
            dealId: p.dealId,
            dealTitle: p.dealTitle,
            recipientWallet: p.recipientWallet,
            note: p.milestoneIndex !== undefined ? `Milestone #${p.milestoneIndex + 1}` : p.note,
          });
          break;

        default:
          return {
            success: false,
            skipped: true,
            reason: `Unsupported notification event type: ${event}`,
          };
      }

      if (mailRes.skipped) {
        return {
          success: false,
          deliveryStatus: mailRes.deliveryStatus || 'skipped',
          skipped: true,
          reason: mailRes.reason || 'Notification skipped',
        };
      }

      if (mailRes.deliveryStatus === 'log_only') {
        return {
          success: false,
          deliveryStatus: 'log_only',
          error: mailRes.error || 'SMTP delivery disabled (log-only mode)',
        };
      }

      if (mailRes.deliveryStatus === 'permanent_fail') {
        return {
          success: false,
          deliveryStatus: 'permanent_fail',
          error: mailRes.error || 'Permanent delivery failure',
        };
      }

      if (mailRes.error) {
        return {
          success: false,
          deliveryStatus: mailRes.deliveryStatus || 'retryable_fail',
          error: mailRes.error,
        };
      }

      return {
        success: true,
        deliveryStatus: mailRes.deliveryStatus || 'delivered',
        messageId: mailRes.messageId,
      };
    } catch (err: any) {
      return {
        success: false,
        deliveryStatus: 'retryable_fail',
        error: err?.message || 'Dispatch failure',
      };
    }
  }
}

export interface OutboxBatchResult {
  claimedCount: number;
  processedCount: number;
  skippedCount: number;
  failedCount: number;
  duplicatesCount: number;
  deferredCount: number;
}

/**
 * Authoritatively determines whether an outbox event represents a blockchain-derived event.
 * Inspects explicit origin, block/log coordinates, and smart contract lifecycle semantics.
 */
export function isBlockchainDerivedEvent(item: DealOutboxEvent): boolean {
  // 1. Explicit origin discriminator
  if (item.origin === 'on_chain') return true;

  // 2. Contains block coordinate or log index (top-level or in payload)
  if (item.blockNumber !== null && item.blockNumber !== undefined) return true;
  if (item.logIndex !== null && item.logIndex !== undefined) return true;
  const payload = item.payload || {};
  if (payload.blockNumber !== null && payload.blockNumber !== undefined) return true;
  if (payload.logIndex !== null && payload.logIndex !== undefined) return true;

  // 3. Known on-chain contract lifecycle event types (emitted by deal smart contract)
  const onChainEventTypes = new Set([
    'deal_confirmed',
    'work_submitted',
    'payment_released',
    'deal_completed',
    'deal_completed_seller',
    'deal_cancelled',
    'milestone_refunded',
    'resolution_finalized',
    'mutual_settlement_executed',
    'mutual_settlement_cancelled',
  ]);
  if (onChainEventTypes.has(item.event)) return true;

  // 4. Outbox ID or payload contains transaction hash without being a pure off-chain proposal
  if (item.id.includes(':0x') || item.txHash !== null || (payload as any).txHash !== null) {
    const offChainWorkflows = new Set([
      'proposal_received',
      'committee_authorization_requested',
      'mutual_settlement_proposed',
      'resolution_report_filed',
    ]);
    if (!offChainWorkflows.has(item.event)) {
      return true;
    }
  }

  return false;
}

import { extractSafeBlockNumber } from './notification-freshness';
export { extractSafeBlockNumber };

export class OutboxProcessor {
  constructor(
    private outboxRepo: IDealOutboxRepository = getDealOutboxRepository(),
    private notifRepo: INotificationsRepository = getNotificationsRepository(),
    private dispatcher: INotificationDispatcher = new DefaultNotificationDispatcher(),
  ) {}

  /**
   * Processes a single bounded batch of pending outbox events.
   */
  async processBatch(limit = 25): Promise<OutboxBatchResult> {
    const pending = await this.outboxRepo.getPending(limit);
    const result: OutboxBatchResult = {
      claimedCount: 0,
      processedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      duplicatesCount: 0,
      deferredCount: 0,
    };

    for (const item of pending) {
      // 1. Claim pending event with atomic lease CAS
      const claimToken = crypto.randomUUID();
      const claimed = await this.outboxRepo.claim(item.id, claimToken);
      if (!claimed) {
        // Another worker claimed or item no longer pending
        continue;
      }
      result.claimedCount += 1;

      try {
        await this.processItem(item, claimToken, result);
      } catch (err: any) {
        result.failedCount += 1;
        await this.outboxRepo.markFailed(item.id, err?.message || 'Processing error', claimToken);
      }
    }

    return result;
  }

  async processItem(
    item: DealOutboxEvent,
    claimToken: string = item.claimToken || 'token-default',
    stats: OutboxBatchResult = {
      claimedCount: 0,
      processedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      duplicatesCount: 0,
      deferredCount: 0,
    },
  ): Promise<OutboxBatchResult> {
    const payload = item.payload || {};
    const milestoneIndex = payload.milestoneIndex !== undefined ? Number(payload.milestoneIndex) : undefined;
    const submissionVersion = payload.submissionVersion !== undefined ? Number(payload.submissionVersion) : undefined;
    const submissionId = payload.submissionId as string | undefined;
    const txHash = payload.txHash as string | undefined;
    const logIndex = payload.logIndex !== undefined ? Number(payload.logIndex) : undefined;
    const recipientRole = (payload.recipientRole as 'buyer' | 'seller') || (item.event === 'work_submitted' ? 'buyer' : 'seller');

    // 1. Historical safety gate: validate live start block cutoff configuration for blockchain-derived events
    if (isBlockchainDerivedEvent(item)) {
      const cutoff = parseNotificationLiveStartBlock(process.env.NOTIFICATION_LIVE_START_BLOCK);

      if (!cutoff.configured || cutoff.startBlock === undefined) {
        // FAIL-CLOSED: Configuration is missing or invalid.
        // Do NOT dispatch live email! Do NOT permanently mark skipped!
        // Defer with backoff so normal processing safely resumes when configuration is supplied.
        stats.deferredCount += 1;
        console.warn(
          `[OutboxProcessor] FAIL-CLOSED: Blockchain-derived event ${item.id} cannot be delivered: ${cutoff.error}. Releasing claim to retry after configuration is supplied.`
        );
        await this.outboxRepo.releaseClaim(item.id, 60, claimToken);
        return stats;
      }

      // Extract and validate block number coordinate
      const rawBlock = item.blockNumber ?? (payload as any)?.blockNumber;
      const blockCoord = extractSafeBlockNumber(rawBlock);

      if (!blockCoord.valid || blockCoord.blockNumber === undefined) {
        // FAIL-CLOSED: Block coordinate is unverified, null, undefined, or malformed.
        // Do NOT dispatch email! Do NOT permanently mark skipped!
        // Defer in recoverable state so it can be reconciled/retried once block coordinate is established.
        stats.deferredCount += 1;
        console.warn(
          `[OutboxProcessor] FAIL-CLOSED: Blockchain-derived event ${item.id} has unverified or invalid block coordinate (${blockCoord.error}). Deferring in recoverable state.`
        );
        await this.outboxRepo.releaseClaim(item.id, 60, claimToken);
        return stats;
      }

      if (blockCoord.blockNumber < cutoff.startBlock) {
        // Event block is confirmed historical (prior to cutoff): permanently skip email dispatch
        stats.skippedCount += 1;
        await this.outboxRepo.markSkipped(
          item.id,
          `Historical on-chain event prior to live start block (${cutoff.startBlock})`,
          claimToken,
        );
        return stats;
      }
    }

    // 2. Canonical notification identity and equivalent legacy candidate keys
    const canonicalKey = generateCanonicalDealEventKey({
      chainId: item.chainId,
      dealId: item.dealId,
      event: item.event,
      milestoneIndex,
      submissionVersion,
      submissionId,
      txHash,
      logIndex,
      recipientRole,
      includeLogIndex: false,
    });

    const fallbackKeys = getEquivalentNotificationKeys({
      chainId: item.chainId,
      dealId: item.dealId,
      event: item.event,
      milestoneIndex,
      submissionVersion,
      submissionId,
      txHash,
      logIndex,
      recipientRole,
      rawNotifKey: payload.notifKey as string | undefined,
    });

    // 3. Claim in notification repository with cross-key legacy deduplication
    const claim = await this.notifRepo.claimPending(
      canonicalKey,
      {
        dealId: item.dealId,
        event: item.event,
        recipientWallet: item.recipientWallet,
      },
      { fenced: true, fallbackKeys },
    );

    if (claim.status === 'duplicate_delivered' || (claim as any) === 'duplicate_delivered') {
      stats.duplicatesCount += 1;
      await this.outboxRepo.markProcessed(item.id, claimToken);
      return stats;
    }

    if (claim.status === 'duplicate_pending' || (claim as any) === 'duplicate_pending') {
      // Another process (client or parallel worker) is actively delivering this notification.
      // Do NOT send email! Do NOT mark processed!
      // Safely defer this outbox item so it can be re-evaluated later once the in-flight process settles.
      stats.deferredCount += 1;
      await this.outboxRepo.releaseClaim(item.id, 30, claimToken);
      return stats;
    }

    // Pre-dispatch validity check: verify item was not cancelled by a blockchain reorg while in-flight
    const freshItem = await this.outboxRepo.get(item.id);
    if (!freshItem || freshItem.status === 'cancelled' || (claimToken && freshItem.claimToken !== claimToken)) {
      stats.skippedCount += 1;
      await this.notifRepo.markSkipped(canonicalKey, 'Event invalidated by blockchain reorganization', claim.claimToken);
      return stats;
    }

    // 4. Dispatch through notification service abstraction
    const rawAmount = (payload.amount ?? payload.totalAmount) as string | number | bigint | undefined;
    const dispatchRes = await this.dispatcher.dispatch(item.event, {
      dealId: item.dealId,
      dealTitle: payload.title as string | undefined,
      dealAmount: rawAmount !== undefined && rawAmount !== null ? formatDealAmount(rawAmount) : undefined,
      recipientWallet: item.recipientWallet,
      recipientRole,
      milestoneIndex,
      evidence: payload.evidence as string | undefined,
      note: payload.note as string | undefined,
    });

    if (dispatchRes.skipped) {
      stats.skippedCount += 1;
      await this.notifRepo.markSkipped(canonicalKey, dispatchRes.reason, claim.claimToken);
      await this.outboxRepo.markSkipped(item.id, dispatchRes.reason, claimToken);
      return stats;
    }

    if (dispatchRes.deliveryStatus === 'log_only') {
      // In production-oriented outbox processing, log-only mode must not count as successful email delivery.
      // Defers the item with backoff (e.g. 60 seconds) so it remains pending for future delivery once SMTP is live,
      // without burning retries or entering an immediate tight loop.
      stats.deferredCount += 1;
      await this.notifRepo.markDeferred(canonicalKey, 'SMTP transport disabled (log-only mode)', claim.claimToken);
      await this.outboxRepo.releaseClaim(item.id, 60, claimToken);
      return stats;
    }

    if (!dispatchRes.success || dispatchRes.error) {
      stats.failedCount += 1;
      const errMsg = dispatchRes.error || 'Notification delivery failure';
      const isTimeout = /timeout|timed out|etimedout|esockettimedout/i.test(errMsg);
      // Fail permanently on timeout, explicit permanent failure, or reaching retry cap (>=2 retries, 3 total attempts)
      const isPermanent = dispatchRes.deliveryStatus === 'permanent_fail' || isTimeout || item.retryCount >= 2;
      const failReason = isTimeout
        ? `Ambiguous SMTP outcome (timeout): ${errMsg}. Quarantined to prevent duplicate sending.`
        : errMsg;
      await this.notifRepo.markFailed(canonicalKey, failReason, claim.claimToken);
      await this.outboxRepo.markFailed(item.id, failReason, claimToken, isPermanent);
      return stats;
    }

    // 5. Success: SMTP accepted delivery
    stats.processedCount += 1;
    try {
      await this.notifRepo.markDelivered(canonicalKey, dispatchRes.messageId, undefined, claim.claimToken);
      await this.outboxRepo.markProcessed(item.id, claimToken);
    } catch (dbErr: any) {
      console.error(`[OutboxProcessor] CRITICAL: SMTP accepted (${dispatchRes.messageId}) but DB update failed:`, dbErr);
      try {
        await this.outboxRepo.markFailed(
          item.id,
          `SMTP delivered (${dispatchRes.messageId}) but post-delivery DB update failed: ${dbErr?.message || dbErr}`,
          claimToken,
          true, // permanent to prevent retrying already-sent email
        );
      } catch (qErr: any) {
        console.error(
          `[OutboxProcessor] CRITICAL QUARANTINE FAILURE: Failed to persist quarantine for delivered email ${item.id} (${dispatchRes.messageId}):`,
          qErr
        );
      }
    }
    return stats;
  }
}
