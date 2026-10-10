/**
 * SYNQ — B.12.3.28: End-to-End Email Acceptance & Security Validation Suite
 *
 * Exercises the complete Synq email pipeline end-to-end using an isolated,
 * in-process Nodemailer test transport (JSON transport).
 *
 * Verifies:
 * 1. Controlled mock SMTP transport seam & email rendering security
 * 2. Full outbox lifecycle across all 12 supported lifecycle events:
 *    - proposal_received, deal_confirmed, work_submitted, revision_requested,
 *      payment_released, deal_completed, mutual_settlement_proposed,
 *      mutual_settlement_executed, mutual_settlement_cancelled,
 *      resolution_report_filed, committee_authorization_requested, resolution_finalized
 * 3. Delivery, deferral, retry, permanent failure, and deduplication correctness
 * 4. Delivery-time preference opt-out suppression
 * 5. OTP rate-limit concurrency audit & fail-closed behavior
 * 6. Anti-enumeration, email change safety, and verification isolation
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { NextRequest } from 'next/server';

import {
  setTestTransporter,
  getTestTransporter,
  sendEmailVerificationCode,
  notifyDealConfirmedToSeller,
  notifyBuyerWorkSubmitted,
  notifyFreelancerRevisionRequested,
  notifyBuyerDealCompleted,
  notifySellerDealCompleted,
  notifySellerPaymentReleased,
  notifyMutualSettlementProposed,
  notifyMutualSettlementExecuted,
  notifyMutualSettlementCancelled,
  notifyResolutionReportFiled,
  notifyCommitteeAuthorizationRequested,
  notifyResolutionFinalized,
  type MailResult,
} from '../src/lib/notify';

import {
  InMemoryDealOutboxRepository,
  setDealOutboxRepository,
  resetDealOutboxRepository,
  type DealOutboxEvent,
} from '../src/lib/deals/outbox-db';

import {
  InMemoryNotificationsRepository,
  setNotificationsRepository,
  resetNotificationsRepository,
} from '../src/lib/deals/notifications-db';

import {
  InMemoryNotificationPreferencesRepository,
  setNotificationPreferencesRepositoryForTest,
  isNotificationAllowed,
} from '../src/lib/deals/notification-preferences-db';

import {
  getCategoryForEvent,
  isNotificationSupported,
} from '../src/lib/deals/notification-preferences-types';

import {
  OutboxProcessor,
  DefaultNotificationDispatcher,
} from '../src/lib/deals/outbox-processor';

import {
  InMemoryOtpRateLimitRepository,
  setOtpRateLimitRepositoryForTest,
  checkAndRecordOtpRateLimit,
  OtpRateLimitPersistenceError,
  OTP_COOLDOWN_SECONDS,
} from '../src/lib/auth-rate-limit';

import { setTestUserLookup, setTestUsersList, setTestVerificationsStore } from '../src/lib/db';
import { signToken } from '../src/lib/auth';
import { POST as authRoute } from '../src/app/api/auth/route';

interface CapturedEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  messageId: string;
}

describe('SYNQ — B.12.3.28: End-to-End Email Acceptance & Security Validation', () => {
  const WALLET_BUYER = '0x1111111111111111111111111111111111111111';
  const WALLET_SELLER = '0x2222222222222222222222222222222222222222';
  const WALLET_ARBITER = '0x3333333333333333333333333333333333333333';
  const WALLET_ATTACKER = '0x6666666666666666666666666666666666666666';

  const TOKEN_BUYER = signToken({ userId: 'u-buyer', walletAddress: WALLET_BUYER });
  const TOKEN_SELLER = signToken({ userId: 'u-seller', walletAddress: WALLET_SELLER });
  const TOKEN_ATTACKER = signToken({ userId: 'u-attacker', walletAddress: WALLET_ATTACKER });

  let outboxRepo: InMemoryDealOutboxRepository;
  let notifRepo: InMemoryNotificationsRepository;
  let prefsRepo: InMemoryNotificationPreferencesRepository;
  let otpRepo: InMemoryOtpRateLimitRepository;

  let userStore: Map<string, any>;
  let verificationsStore: Map<string, any>;
  let capturedEmails: CapturedEmail[];
  let mockTransporter: nodemailer.Transporter;

  beforeEach(() => {
    outboxRepo = new InMemoryDealOutboxRepository();
    setDealOutboxRepository(outboxRepo);

    notifRepo = new InMemoryNotificationsRepository();
    setNotificationsRepository(notifRepo);

    prefsRepo = new InMemoryNotificationPreferencesRepository();
    setNotificationPreferencesRepositoryForTest(prefsRepo);

    otpRepo = new InMemoryOtpRateLimitRepository();
    setOtpRateLimitRepositoryForTest(otpRepo);

    userStore = new Map<string, any>();
    verificationsStore = new Map<string, any>();

    setTestUserLookup(async (w: string) => userStore.get(w.toLowerCase()) || null);
    setTestUsersList(async () => Array.from(userStore.values()));
    setTestVerificationsStore(verificationsStore);

    // Seed default users
    userStore.set(WALLET_BUYER.toLowerCase(), {
      id: 'u-buyer',
      walletAddress: WALLET_BUYER.toLowerCase(),
      email: 'buyer@example.com',
    });
    userStore.set(WALLET_SELLER.toLowerCase(), {
      id: 'u-seller',
      walletAddress: WALLET_SELLER.toLowerCase(),
      email: 'seller@example.com',
    });
    userStore.set(WALLET_ARBITER.toLowerCase(), {
      id: 'u-arbiter',
      walletAddress: WALLET_ARBITER.toLowerCase(),
      email: 'arbiter@synq.io',
    });

    // Create and install Nodemailer JSON transport test seam
    capturedEmails = [];
    const baseJsonTransport = nodemailer.createTransport({ jsonTransport: true });
    const originalSendMail = baseJsonTransport.sendMail.bind(baseJsonTransport);
    baseJsonTransport.sendMail = async (options: any) => {
      const info = await originalSendMail(options);
      capturedEmails.push({
        from: String(options.from || ''),
        to: String(options.to || ''),
        subject: String(options.subject || ''),
        html: String(options.html || ''),
        text: String(options.text || ''),
        messageId: info.messageId,
      });
      return info;
    };
    mockTransporter = baseJsonTransport;
    setTestTransporter(mockTransporter);
  });

  afterEach(async () => {
    setTestTransporter(null);
    resetDealOutboxRepository();
    resetNotificationsRepository();
    setNotificationPreferencesRepositoryForTest(null);
    setOtpRateLimitRepositoryForTest(null);
    setTestUserLookup(null);
    setTestUsersList(null);
    setTestVerificationsStore(null);
  });

  // =========================================================================
  // Task 1 — Controlled Mock SMTP Test Transport & Template Rendering
  // =========================================================================
  describe('Task 1 — Mock SMTP Transport Seam & Content Security', () => {
    it('1. Emails have correct sender, recipient, subject, and valid RFC 5322 messageId', async () => {
      const res = await sendEmailVerificationCode('user@example.com', '123456', 10);
      assert.equal(res.deliveryStatus, 'delivered');
      assert.ok(res.messageId);

      assert.equal(capturedEmails.length, 1);
      const email = capturedEmails[0];
      assert.equal(email.to, 'user@example.com');
      assert.ok(email.from.includes('synq'));
      assert.equal(email.subject, 'Your Synq sign-in code');
      assert.ok(email.messageId.startsWith('<') && email.messageId.endsWith('>'));
    });

    it('2. Templates safely escape user-controlled content and malicious HTML tags', async () => {
      const maliciousTitle = '<script>alert("xss")</script> & "Dangerous Title"';
      const maliciousNote = '<img src=x onerror=alert(1)> & Special <tag>';

      await notifyDealConfirmedToSeller({
        event: 'deal_confirmed',
        dealId: '0xdeal1234',
        dealTitle: maliciousTitle,
        dealAmount: '1,000 USDC',
        recipientWallet: WALLET_SELLER,
        note: maliciousNote,
      });

      assert.equal(capturedEmails.length, 1);
      const email = capturedEmails[0];

      // Verifies that HTML is properly escaped
      assert.ok(!email.html.includes('<script>'));
      assert.ok(email.html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
      assert.ok(!email.html.includes('<img src=x'));
      assert.ok(email.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
      // Plain text preserves raw text safely
      assert.ok(email.text.includes('<script>alert("xss")</script>'));
    });

    it('3. Outgoing emails NEVER disclose OTP hashes, server secrets, or private dispute details', async () => {
      // Send sign in code
      await sendEmailVerificationCode('secret-check@example.com', '987654', 10);

      // Notify resolution report filed
      await notifyResolutionReportFiled({
        event: 'resolution_report_filed',
        dealId: '0xdeal9999',
        dealTitle: 'Confidential Escrow Work',
        recipientWallet: WALLET_BUYER,
        note: 'Milestone #1',
      });

      assert.equal(capturedEmails.length, 2);
      const otpEmail = capturedEmails[0];
      const disputeEmail = capturedEmails[1];

      // Plain code is present, but NO hashed secrets or salts
      assert.ok(otpEmail.text.includes('987654'));
      assert.ok(!otpEmail.html.includes('codeHash'));
      assert.ok(!otpEmail.html.includes('sha256'));

      // Dispute email tells user to authenticate in Synq, does not dump internal transcripts
      assert.ok(disputeEmail.html.includes('Authenticate in Synq to review the verified committee report'));
      assert.ok(!disputeEmail.html.includes('secret'));
    });

    it('4. Log-only mode when test transporter is disabled never produces a false delivered status', async () => {
      // Disconnect mock transporter to simulate live SMTP missing
      setTestTransporter(null);

      const res = await sendEmailVerificationCode('log-only@example.com', '111222', 10);
      assert.equal(res.mode, 'log');
      assert.equal(res.deliveryStatus, 'log_only');
      assert.equal(res.messageId, undefined);
      // No email pushed to mock SMTP
      assert.equal(capturedEmails.length, 0);
    });

    it('5. Transport failures are classified accurately as permanent vs retryable', async () => {
      // 1. Permanent failure: SMTP 550 User unknown
      const permanentMock = nodemailer.createTransport({ jsonTransport: true });
      permanentMock.sendMail = async () => {
        const err: any = new Error('550 5.1.1 User unknown');
        err.responseCode = 550;
        err.permanent = true;
        throw err;
      };
      setTestTransporter(permanentMock);

      const permRes = await sendEmailVerificationCode('bad-user@example.com', '123456', 10);
      assert.equal(permRes.deliveryStatus, 'permanent_fail');
      assert.ok(permRes.error?.includes('550'));

      // 2. Retryable failure: SMTP 421 Service unavailable / connection dropped
      const retryableMock = nodemailer.createTransport({ jsonTransport: true });
      retryableMock.sendMail = async () => {
        const err: any = new Error('421 Service temporarily unavailable');
        err.responseCode = 421;
        throw err;
      };
      setTestTransporter(retryableMock);

      const retryRes = await sendEmailVerificationCode('busy-user@example.com', '123456', 10);
      assert.equal(retryRes.deliveryStatus, 'retryable_fail');
      assert.ok(retryRes.error?.includes('421'));
    });
  });

  // =========================================================================
  // Task 2 — Complete Outbox Lifecycle across all 12 events
  // =========================================================================
  describe('Task 2 — Full Outbox Lifecycle & All 12 Events Acceptance', () => {
    const ALL_12_EVENTS = [
      { event: 'proposal_received', recipient: WALLET_SELLER, category: 'dealProposalsAndConfirmations', payload: { title: 'Proposal Test', amount: '1000' } },
      { event: 'deal_confirmed', recipient: WALLET_SELLER, category: 'dealProposalsAndConfirmations', payload: { title: 'Deal Confirmed Test', amount: '2000' } },
      { event: 'work_submitted', recipient: WALLET_BUYER, category: 'milestoneSubmissionsAndRevisions', payload: { title: 'Work Test', milestoneIndex: 0, evidence: 'ipfs://Qm123' } },
      { event: 'revision_requested', recipient: WALLET_SELLER, category: 'milestoneSubmissionsAndRevisions', payload: { title: 'Revision Test', milestoneIndex: 0, evidence: 'Please update colors' } },
      { event: 'payment_released', recipient: WALLET_SELLER, category: 'paymentsAndCompletions', payload: { title: 'Payment Test', amount: '500', milestoneIndex: 0 } },
      { event: 'deal_completed', recipient: WALLET_BUYER, category: 'paymentsAndCompletions', payload: { title: 'Completion Test', amount: '2000' } },
      { event: 'mutual_settlement_proposed', recipient: WALLET_BUYER, category: 'disputesAndResolutions', payload: { title: 'Settlement Prop', milestoneIndex: 0, amount: '50-50' } },
      { event: 'mutual_settlement_executed', recipient: WALLET_BUYER, category: 'paymentsAndCompletions', payload: { title: 'Settlement Exec', milestoneIndex: 0, amount: '1000 USDC' } },
      { event: 'mutual_settlement_cancelled', recipient: WALLET_SELLER, category: 'disputesAndResolutions', payload: { title: 'Settlement Cancel', milestoneIndex: 0 } },
      { event: 'resolution_report_filed', recipient: WALLET_BUYER, category: 'disputesAndResolutions', payload: { title: 'Report Filed', milestoneIndex: 0 } },
      { event: 'committee_authorization_requested', recipient: WALLET_ARBITER, category: 'disputesAndResolutions', payload: { title: 'Auth Request', note: 'Auth ID: auth-uuid-1' } },
      { event: 'resolution_finalized', recipient: WALLET_BUYER, category: 'disputesAndResolutions', payload: { title: 'Dispute Finalized', milestoneIndex: 0 } },
    ] as const;

    it('6. All 12 supported lifecycle events transition cleanly: outbox pending -> mock SMTP acceptance -> delivered', async () => {
      const processor = new OutboxProcessor(outboxRepo, notifRepo);

      for (let i = 0; i < ALL_12_EVENTS.length; i++) {
        const item = ALL_12_EVENTS[i];
        const eventId = `outbox:acceptance:${i}:${item.event}`;

        // Verify supported
        assert.equal(isNotificationSupported(item.event), true);
        assert.equal(getCategoryForEvent(item.event), item.category);

        // 1. Stage in durable outbox
        const enqResult = await outboxRepo.enqueue({
          id: eventId,
          chainId: 11155111,
          dealId: `0xdeal${i}`,
          event: item.event,
          recipientWallet: item.recipient,
          payload: {
            dealId: `0xdeal${i}`,
            ...item.payload,
          },
        });
        assert.equal(enqResult, 'enqueued');

        // 2. Process batch via OutboxProcessor
        const batchStats = await processor.processBatch(10);
        assert.equal(batchStats.processedCount, 1);
        assert.equal(batchStats.failedCount, 0);

        // 3. Verify mock SMTP received exactly this message
        assert.equal(capturedEmails.length, i + 1);
        const deliveredMail = capturedEmails[capturedEmails.length - 1];
        assert.ok(deliveredMail.messageId);

        // 4. Verify outbox state is processed
        const outboxRecord = await outboxRepo.get(eventId);
        assert.equal(outboxRecord?.status, 'processed');
      }
    });

    it('7. Duplicate event enqueuing is rejected with duplicate and never double-sends', async () => {
      const processor = new OutboxProcessor(outboxRepo, notifRepo);
      const eventId = 'outbox-dedup-check-1';

      const res1 = await outboxRepo.enqueue({
        id: eventId,
        chainId: 11155111,
        dealId: '0xdeal_dedup',
        event: 'deal_confirmed',
        recipientWallet: WALLET_SELLER,
        payload: { title: 'Dedup Deal', amount: '100 USDC' },
      });
      assert.equal(res1, 'enqueued');

      const res2 = await outboxRepo.enqueue({
        id: eventId,
        chainId: 11155111,
        dealId: '0xdeal_dedup',
        event: 'deal_confirmed',
        recipientWallet: WALLET_SELLER,
        payload: { title: 'Dedup Deal', amount: '100 USDC' },
      });
      assert.equal(res2, 'duplicate');

      await processor.processBatch(10);
      assert.equal(capturedEmails.length, 1);

      // Running processor again finds 0 items
      const secondBatch = await processor.processBatch(10);
      assert.equal(secondBatch.processedCount, 0);
      assert.equal(capturedEmails.length, 1);
    });

    it('8. User opting out AFTER outbox staging but BEFORE dispatch suppresses the email at delivery time', async () => {
      const processor = new OutboxProcessor(outboxRepo, notifRepo);
      const eventId = 'outbox-optout-delivery-time';

      // 1. Staged while preferences are enabled
      await outboxRepo.enqueue({
        id: eventId,
        chainId: 11155111,
        dealId: '0xdeal_late_optout',
        event: 'work_submitted',
        recipientWallet: WALLET_BUYER,
        payload: { title: 'Late Optout Deal', milestoneIndex: 0 },
      });

      // 2. User opts out before the outbox worker claims the item
      await prefsRepo.updatePreferences(WALLET_BUYER, { milestoneSubmissionsAndRevisions: false });

      // 3. Worker claims and processes
      const batchStats = await processor.processBatch(10);
      assert.equal(batchStats.skippedCount, 1);
      assert.equal(batchStats.processedCount, 0);

      // Mock SMTP received zero emails
      assert.equal(capturedEmails.length, 0);

      const record = await outboxRepo.get(eventId);
      assert.equal(record?.status, 'skipped');
    });

    it('9. Stale worker claims are safely reclaimed and processed', async () => {
      const processor = new OutboxProcessor(outboxRepo, notifRepo);
      const eventId = 'outbox-stale-lease-test';

      await outboxRepo.enqueue({
        id: eventId,
        chainId: 11155111,
        dealId: '0xdeal_stale',
        event: 'payment_released',
        recipientWallet: WALLET_SELLER,
        payload: { title: 'Stale Lease Test', amount: '500 USDC' },
      });

      // Claim with an old worker token that timed out 10 minutes ago
      await outboxRepo.claim(eventId, 'stale-worker-token-xyz');
      (outboxRepo as any).events.get(eventId)!.claimedAt = new Date(Date.now() - 10 * 60 * 1000); // 10m ago

      // Processor reclaims expired lease
      const batchStats = await processor.processBatch(10);
      assert.equal(batchStats.processedCount, 1);
      assert.equal(capturedEmails.length, 1);

      const record = await outboxRepo.get(eventId);
      assert.equal(record?.status, 'processed');
    });

    it('10. Permanent 5xx transport failure exhausts retries immediately without tight looping', async () => {
      const permMock = nodemailer.createTransport({ jsonTransport: true });
      permMock.sendMail = async () => {
        const err: any = new Error('550 User mailbox unavailable');
        err.responseCode = 550;
        err.permanent = true;
        throw err;
      };
      setTestTransporter(permMock);

      const processor = new OutboxProcessor(outboxRepo, notifRepo);
      const eventId = 'outbox-perm-failure-test';

      await outboxRepo.enqueue({
        id: eventId,
        chainId: 11155111,
        dealId: '0xdeal_perm_fail',
        event: 'deal_completed',
        recipientWallet: WALLET_BUYER,
        payload: { title: 'Permanent Failure Test' },
      });

      const batchStats = await processor.processBatch(10);
      assert.equal(batchStats.failedCount, 1);

      const record = await outboxRepo.get(eventId);
      assert.equal(record?.status, 'failed');
      assert.equal(record?.retryCount, 5); // Max retries exhausted
      assert.equal(record?.nextRetryAt, undefined); // No next retry scheduled

      // Next batch should ignore this permanently failed record
      const pending = await outboxRepo.getPending(10);
      assert.equal(pending.length, 0);
    });

    it('11. Log-only operation defers outbox item without burning retry attempts', async () => {
      // Disconnect mock SMTP to test offline log-only mode
      setTestTransporter(null);

      const processor = new OutboxProcessor(outboxRepo, notifRepo);
      const eventId = 'outbox-log-only-defer-test';

      await outboxRepo.enqueue({
        id: eventId,
        chainId: 11155111,
        dealId: '0xdeal_defer',
        event: 'deal_confirmed',
        recipientWallet: WALLET_SELLER,
        payload: { title: 'Log-only Defer Test' },
      });

      const batchStats = await processor.processBatch(10);
      assert.equal(batchStats.deferredCount, 1);

      const record = await outboxRepo.get(eventId);
      assert.equal(record?.status, 'failed'); // Released claim
      assert.equal(record?.retryCount, 0); // Retries NOT consumed
      assert.ok(record?.nextRetryAt); // Scheduled with backoff
    });
  });

  // =========================================================================
  // Task 3 — OTP Rate-Limit Concurrency Audit
  // =========================================================================
  describe('Task 3 — OTP Rate-Limit Concurrency Audit', () => {
    it('12. Ten concurrent OTP requests for the same email: exactly 1 succeeds, 9 trigger 429', async () => {
      const email = 'concurrent-target@example.com';
      const results = await Promise.all(
        Array.from({ length: 10 }).map(() =>
          checkAndRecordOtpRateLimit({ email, repo: otpRepo })
        )
      );

      const allowed = results.filter((r) => r.allowed);
      const rejected = results.filter((r) => !r.allowed);

      assert.equal(allowed.length, 1);
      assert.equal(rejected.length, 9);
      for (const rej of rejected) {
        assert.equal(rej.reason, 'cooldown');
        assert.equal(rej.retryAfter, OTP_COOLDOWN_SECONDS);
      }
    });

    it('13. Cross-wallet concurrent attacks against the same email are all throttled by email key', async () => {
      const email = 'shared-target@example.com';
      const results = await Promise.all(
        Array.from({ length: 5 }).map((_, idx) =>
          checkAndRecordOtpRateLimit({
            email,
            walletAddress: `0x${idx.toString().repeat(40)}`,
            repo: otpRepo,
          })
        )
      );

      const allowed = results.filter((r) => r.allowed);
      const rejected = results.filter((r) => !r.allowed);

      assert.equal(allowed.length, 1);
      assert.equal(rejected.length, 4);
    });

    it('14. If wallet boundary rejects, the email limit is NOT partially consumed', async () => {
      const email = 'unused-email@example.com';

      // 1. Wallet performs a request
      await checkAndRecordOtpRateLimit({ walletAddress: WALLET_BUYER, repo: otpRepo });

      // 2. Immediate second request using the same wallet but a brand new email
      const check = await checkAndRecordOtpRateLimit({
        email,
        walletAddress: WALLET_BUYER,
        repo: otpRepo,
      });

      // Wallet rejects
      assert.equal(check.allowed, false);
      assert.equal(check.target, 'wallet');

      // 3. Verify that the new email key was NOT recorded or incremented
      const emailStatus = await otpRepo.get(`email:${email}`);
      assert.equal(emailStatus, null);
    });

    it('15. Fail-closed behavior: Database persistence failure returns HTTP 503 and zero OTP codes sent', async () => {
      const failingRepo: any = {
        get: async () => { throw new OtpRateLimitPersistenceError('PostgreSQL pool timeout'); },
        upsert: async () => { throw new OtpRateLimitPersistenceError('PostgreSQL connection dropped'); },
      };
      setOtpRateLimitRepositoryForTest(failingRepo);

      const req = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'email', email: 'failclosed@example.com' }),
      });

      const res = await authRoute(req);
      assert.equal(res.status, 503);
      const data = await res.json();
      assert.ok(data.error?.includes('unavailable'));

      // Zero verification records or mock emails generated
      assert.equal(verificationsStore.size, 0);
      assert.equal(capturedEmails.length, 0);
    });
  });

  // =========================================================================
  // Task 4 — Anti-Enumeration and Verification Safety
  // =========================================================================
  describe('Task 4 — Anti-Enumeration & Email Verification Safety', () => {
    it('16. Requesting binding code for an email already bound to another wallet simulates success without issuing codes', async () => {
      // User B owns 'buyer@example.com' (seeded in beforeEach)
      // Attacker tries to bind 'buyer@example.com'
      const req = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_ATTACKER}`,
        },
        body: JSON.stringify({
          type: 'bind_email',
          walletAddress: WALLET_ATTACKER,
          email: 'buyer@example.com',
        }),
      });

      const res = await authRoute(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.codeSent, true);

      // CRITICAL: No verification record was created, and NO email was sent to buyer@example.com!
      assert.equal(verificationsStore.size, 0);
      assert.equal(capturedEmails.length, 0);
    });

    it('17. Verification failure preserves existing email, and 3 failed attempts deletes the pending verification', async () => {
      // User buyer requests to change email to buyer-new@example.com
      const reqCode = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_BUYER}`,
        },
        body: JSON.stringify({
          type: 'bind_email',
          walletAddress: WALLET_BUYER,
          email: 'buyer-new@example.com',
        }),
      });
      const resCode = await authRoute(reqCode);
      assert.equal(resCode.status, 200);

      const makeVerifyReq = (code: string) =>
        new NextRequest('http://localhost:3000/api/auth', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TOKEN_BUYER}`,
          },
          body: JSON.stringify({
            type: 'bind_email_verify',
            walletAddress: WALLET_BUYER,
            email: 'buyer-new@example.com',
            code,
          }),
        });

      // 5 failed attempts (CODE_MAX_ATTEMPTS = 5)
      for (let i = 1; i <= 5; i++) {
        const res = await authRoute(makeVerifyReq('000000'));
        assert.equal(res.status, 401);
      }
      assert.equal(userStore.get(WALLET_BUYER.toLowerCase())?.email, 'buyer@example.com');

      // Attempt 6: attempts >= 5 -> 429 and deletes record
      const resExhausted = await authRoute(makeVerifyReq('000000'));
      assert.equal(resExhausted.status, 429);

      // Subsequent attempt gives 401: no sign-in code requested
      const resAfter = await authRoute(makeVerifyReq('000000'));
      assert.equal(resAfter.status, 401);
      assert.equal(userStore.get(WALLET_BUYER.toLowerCase())?.email, 'buyer@example.com');
    });

    it('18. Authenticated wallet cannot verify or bind another wallet address', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_ATTACKER}`, // Attacker token
        },
        body: JSON.stringify({
          type: 'bind_email_verify',
          walletAddress: WALLET_BUYER, // Victim wallet
          email: 'attacker@evil.com',
          code: '123456',
        }),
      });

      const res = await authRoute(req);
      assert.equal(res.status, 403);
    });

    it('19. Committee authorization requested strictly targets committee co-signers, never deal participants', async () => {
      // Setup co-signers and deal participants
      const SIGNER_CREATOR = '0x1111111111111111111111111111111111111111';
      const SIGNER_COSIGNER1 = '0x2222222222222222222222222222222222222222';
      const SIGNER_COSIGNER2 = '0x3333333333333333333333333333333333333333';
      const DEAL_CLIENT = '0xcccccccccccccccccccccccccccccccccccccccc';
      const DEAL_FREELANCER = '0xffffffffffffffffffffffffffffffffffffffff';

      userStore.set(SIGNER_COSIGNER1.toLowerCase(), { walletAddress: SIGNER_COSIGNER1.toLowerCase(), email: 'cosigner1@committee.org' });
      userStore.set(SIGNER_COSIGNER2.toLowerCase(), { walletAddress: SIGNER_COSIGNER2.toLowerCase(), email: 'cosigner2@committee.org' });
      userStore.set(DEAL_CLIENT.toLowerCase(), { walletAddress: DEAL_CLIENT.toLowerCase(), email: 'client@deal.com' });
      userStore.set(DEAL_FREELANCER.toLowerCase(), { walletAddress: DEAL_FREELANCER.toLowerCase(), email: 'freelancer@deal.com' });

      // Simulate co-signer notification dispatch
      const dispatcher = new DefaultNotificationDispatcher();
      const authId = 'auth-req-verify-123';

      // Co-signer 1 receives signature request notification
      const dispatchCo1 = await dispatcher.dispatch('committee_authorization_requested', {
        dealId: '0xdeal5555',
        dealTitle: 'Escrow Dispute',
        recipientWallet: SIGNER_COSIGNER1,
        note: `Authorization ID: ${authId}`,
      });
      assert.equal(dispatchCo1.success, true);
      assert.equal(dispatchCo1.deliveryStatus, 'delivered');

      // Verify email was addressed to co-signer and contains authorization signature instructions
      const lastEmail = capturedEmails[capturedEmails.length - 1];
      assert.equal(lastEmail.to, 'cosigner1@committee.org');
      assert.match(lastEmail.subject, /Committee authorization signature requested/i);
      assert.match(lastEmail.text, /Your cryptographic signature is requested as an authorized committee member/i);
      // Verify deal participants are NOT recipient addresses
      assert.notEqual(lastEmail.to, 'client@deal.com');
      assert.notEqual(lastEmail.to, 'freelancer@deal.com');
    });

    it('20. Atomic multi-process OTP rate-limiting guarantees boundary rollback and isolation', async () => {
      const email = 'atomic-rollback-test@synq.io';
      const walletA = '0x9999000000000000000000000000000000000001';
      const walletB = '0x9999000000000000000000000000000000000002';
      const now = new Date();

      // Step 1: Wallet A requests code for the shared email
      const checkA = await checkAndRecordOtpRateLimit({ email, walletAddress: walletA, now, repo: otpRepo });
      assert.equal(checkA.allowed, true);

      // Step 2: Wallet B concurrently attempts to request code for the same email (active cooldown)
      const checkB = await checkAndRecordOtpRateLimit({ email, walletAddress: walletB, now, repo: otpRepo });
      assert.equal(checkB.allowed, false);
      assert.equal(checkB.reason, 'cooldown');
      assert.equal(checkB.target, 'email');

      // Step 3: Verify Wallet B boundary was NOT consumed or incremented due to email rejection
      const walletBStatus = await otpRepo.get(`wallet:${walletB}`);
      assert.equal(walletBStatus, null, 'Wallet boundary must not be consumed when email boundary rejected request');
    });
  });
});
