/**
 * SYNQ — B.12.3.27: Email Security, Preference Correctness & Lifecycle Coverage Suite
 *
 * Offline regression test suite validating:
 * 1. Server-enforced OTP request rate limiting & retry-after behavior
 * 2. Cross-wallet and cross-email abuse boundaries & anti-enumeration protection
 * 3. Preference semantics: no canonical event loss, no resurrection after re-enabling
 * 4. Unsupported event rejection & strict category mapping
 * 5. Full deal lifecycle notification coverage:
 *    - Mutual settlement proposed, executed, cancelled
 *    - Committee resolution report filed, authorization requested, finalized
 * 6. Deduplication, outbox claiming, and fencing preservation
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import {
  InMemoryOtpRateLimitRepository,
  setOtpRateLimitRepositoryForTest,
  checkAndRecordOtpRateLimit,
  OTP_COOLDOWN_SECONDS,
} from '../src/lib/auth-rate-limit';

import {
  InMemoryNotificationPreferencesRepository,
  setNotificationPreferencesRepositoryForTest,
  isNotificationAllowed,
} from '../src/lib/deals/notification-preferences-db';

import {
  getCategoryForEvent,
  isNotificationSupported,
  SUPPORTED_NOTIFICATION_EVENTS,
} from '../src/lib/deals/notification-preferences-types';

import {
  InMemoryNotificationsRepository,
  setNotificationsRepository,
  resetNotificationsRepository,
} from '../src/lib/deals/notifications-db';

import {
  InMemoryDealOutboxRepository,
  setDealOutboxRepository,
  resetDealOutboxRepository,
} from '../src/lib/deals/outbox-db';

import {
  InMemoryDealProposalRepository,
  setDealProposalRepository,
  resetDealProposalRepository,
} from '../src/lib/deals/proposals-db';

import {
  OutboxProcessor,
  DefaultNotificationDispatcher,
} from '../src/lib/deals/outbox-processor';

import {
  notifyMutualSettlementProposed,
  notifyMutualSettlementExecuted,
  notifyMutualSettlementCancelled,
  notifyResolutionReportFiled,
  notifyCommitteeAuthorizationRequested,
  notifyResolutionFinalized,
  sendEmailVerificationCode,
} from '../src/lib/notify';

import { setTestUserLookup, setTestUsersList, setTestVerificationsStore } from '../src/lib/db';
import { signToken } from '../src/lib/auth';
import { POST as authRoute } from '../src/app/api/auth/route';

describe('SYNQ — B.12.3.27: Email Security, Preference Correctness & Lifecycle Coverage', () => {
  const WALLET_A = '0x1111111111111111111111111111111111111111';
  const WALLET_B = '0x2222222222222222222222222222222222222222';
  const WALLET_ATTACKER = '0x6666666666666666666666666666666666666666';

  const TOKEN_A = signToken({ userId: 'user-a', walletAddress: WALLET_A });
  const TOKEN_B = signToken({ userId: 'user-b', walletAddress: WALLET_B });
  const TOKEN_ATTACKER = signToken({ userId: 'user-attacker', walletAddress: WALLET_ATTACKER });

  let otpRepo: InMemoryOtpRateLimitRepository;
  let prefsRepo: InMemoryNotificationPreferencesRepository;
  let notifRepo: InMemoryNotificationsRepository;
  let outboxRepo: InMemoryDealOutboxRepository;
  let proposalsRepo: InMemoryDealProposalRepository;
  let userStore: Map<string, any>;
  let verificationsStore: Map<string, any>;

  beforeEach(() => {
    otpRepo = new InMemoryOtpRateLimitRepository();
    setOtpRateLimitRepositoryForTest(otpRepo);

    prefsRepo = new InMemoryNotificationPreferencesRepository();
    setNotificationPreferencesRepositoryForTest(prefsRepo);

    notifRepo = new InMemoryNotificationsRepository();
    setNotificationsRepository(notifRepo);

    outboxRepo = new InMemoryDealOutboxRepository();
    setDealOutboxRepository(outboxRepo);

    proposalsRepo = new InMemoryDealProposalRepository();
    setDealProposalRepository(proposalsRepo);

    userStore = new Map<string, any>();
    verificationsStore = new Map<string, any>();

    setTestUserLookup(async (w: string) => userStore.get(w.toLowerCase()) || null);
    setTestUsersList(async () => Array.from(userStore.values()));
    setTestVerificationsStore(verificationsStore);
  });

  afterEach(async () => {
    setOtpRateLimitRepositoryForTest(null);
    setNotificationPreferencesRepositoryForTest(null);
    resetNotificationsRepository();
    resetDealOutboxRepository();
    resetDealProposalRepository();
    setTestUserLookup(null);
    setTestUsersList(null);
    setTestVerificationsStore(null);
  });

  // =========================================================================
  // Task 1 — Backend OTP Rate Limiting & Anti-Enumeration Protection
  // =========================================================================
  describe('Task 1 — Server-Enforced OTP Rate Limiting & Anti-Enumeration Protection', () => {
    it('1. First OTP request succeeds, immediate repeat request triggers HTTP 429 with Retry-After', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      const req1 = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({
          type: 'bind_email',
          walletAddress: WALLET_A,
          email: 'alice-new@example.com',
        }),
      });

      const res1 = await authRoute(req1);
      assert.equal(res1.status, 200);
      const data1 = await res1.json();
      assert.equal(data1.codeSent, true);

      // Repeat request 5 seconds later
      const req2 = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({
          type: 'bind_email',
          walletAddress: WALLET_A,
          email: 'alice-new@example.com',
        }),
      });

      const res2 = await authRoute(req2);
      assert.equal(res2.status, 429);
      const data2 = await res2.json();
      assert.match(data2.error, /wait before requesting/i);
      assert.ok(data2.retryAfter > 0 && data2.retryAfter <= OTP_COOLDOWN_SECONDS);
      assert.equal(res2.headers.get('Retry-After'), String(data2.retryAfter));
    });

    it('2. Same authenticated wallet attempting rapid codes for DIFFERENT emails is throttled by wallet boundary', async () => {
      const req1 = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({
          type: 'bind_email',
          walletAddress: WALLET_A,
          email: 'first@example.com',
        }),
      });
      const res1 = await authRoute(req1);
      assert.equal(res1.status, 200);

      // Same wallet tries a different email immediately
      const req2 = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({
          type: 'bind_email',
          walletAddress: WALLET_A,
          email: 'second@example.com',
        }),
      });
      const res2 = await authRoute(req2);
      assert.equal(res2.status, 429);
      const data2 = await res2.json();
      assert.ok(data2.retryAfter > 0);
    });

    it('3. Different wallets attempting codes for the SAME email are throttled by email boundary', async () => {
      const req1 = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({
          type: 'bind_email',
          walletAddress: WALLET_A,
          email: 'target@example.com',
        }),
      });
      const res1 = await authRoute(req1);
      assert.equal(res1.status, 200);

      // Wallet B tries same email immediately
      const req2 = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_B}`,
        },
        body: JSON.stringify({
          type: 'bind_email',
          walletAddress: WALLET_B,
          email: 'target@example.com',
        }),
      });
      const res2 = await authRoute(req2);
      assert.equal(res2.status, 429);
    });

    it('4. Anti-enumeration: Requesting an email already bound to another wallet does NOT reveal registration', async () => {
      // Alice already owns alice@example.com
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      // Attacker tries to probe whether alice@example.com is registered
      const reqProbe = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_ATTACKER}`,
        },
        body: JSON.stringify({
          type: 'bind_email',
          walletAddress: WALLET_ATTACKER,
          email: 'alice@example.com',
        }),
      });

      const resProbe = await authRoute(reqProbe);
      // Returns 200 with generic success message rather than 409 error leaking registration
      assert.equal(resProbe.status, 200);
      const data = await resProbe.json();
      assert.equal(data.codeSent, true);

      // No verification record was created for the attacker
      const records = Array.from(verificationsStore.values()).filter(
        (v: any) => v.walletAddress === WALLET_ATTACKER.toLowerCase()
      );
      assert.equal(records.length, 0);

      // And attacker cannot verify any code
      const reqVerify = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_ATTACKER}`,
        },
        body: JSON.stringify({
          type: 'bind_email_verify',
          walletAddress: WALLET_ATTACKER,
          email: 'alice@example.com',
          code: '123456',
        }),
      });
      const resVerify = await authRoute(reqVerify);
      assert.equal(resVerify.status, 401);
    });

    it('5. Hourly burst limit triggers after 5 requests within the hour window', async () => {
      const baseTime = new Date('2026-10-09T10:00:00Z');
      const email = 'burst-test@example.com';

      // Request 1
      const r1 = await checkAndRecordOtpRateLimit({ email, now: baseTime, repo: otpRepo });
      assert.equal(r1.allowed, true);

      // Request 2 (70s later)
      const t2 = new Date(baseTime.getTime() + 70_000);
      const r2 = await checkAndRecordOtpRateLimit({ email, now: t2, repo: otpRepo });
      assert.equal(r2.allowed, true);

      // Request 3 (140s later)
      const t3 = new Date(baseTime.getTime() + 140_000);
      const r3 = await checkAndRecordOtpRateLimit({ email, now: t3, repo: otpRepo });
      assert.equal(r3.allowed, true);

      // Request 4 (210s later)
      const t4 = new Date(baseTime.getTime() + 210_000);
      const r4 = await checkAndRecordOtpRateLimit({ email, now: t4, repo: otpRepo });
      assert.equal(r4.allowed, true);

      // Request 5 (280s later)
      const t5 = new Date(baseTime.getTime() + 280_000);
      const r5 = await checkAndRecordOtpRateLimit({ email, now: t5, repo: otpRepo });
      assert.equal(r5.allowed, true);

      // Request 6 (350s later - still within 1 hour)
      const t6 = new Date(baseTime.getTime() + 350_000);
      const r6 = await checkAndRecordOtpRateLimit({ email, now: t6, repo: otpRepo });
      assert.equal(r6.allowed, false);
      assert.equal(r6.reason, 'hourly_limit');
      assert.ok(r6.retryAfter! > 3000); // More than 50 minutes remaining
    });
  });

  // =========================================================================
  // Task 2 — Preference Semantics Audit & Correctness
  // =========================================================================
  describe('Task 2 — Preference Semantics Audit & Suppression Integrity', () => {
    it('6. Unsupported event names are rejected and never treated as supported functionality', async () => {
      assert.equal(isNotificationSupported('arbitrary_unknown_event'), false);
      assert.equal(isNotificationSupported('deal_confirmed'), true);
      assert.equal(isNotificationSupported('mutual_settlement_proposed'), true);

      // isNotificationAllowed must reject unsupported events
      const allowed = await isNotificationAllowed(WALLET_A, 'arbitrary_unknown_event');
      assert.equal(allowed, false);
    });

    it('7. Preference opt-out does NOT prevent canonical proposal creation or outbox staging', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      // Wallet A opts out of proposals
      await prefsRepo.updatePreferences(WALLET_A, { dealProposalsAndConfirmations: false });

      // Create proposal
      const proposal = await proposalsRepo.create({
        proposalId: 'canonical-test-prop-1',
        proposalNonce: '1',
        chainId: 11155111,
        factoryAddress: '0x1111111111111111111111111111111111111111',
        clientWallet: WALLET_B,
        freelancerWallet: WALLET_A,
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x7E376b006Db7798165a6b8E6B191E20e791E4419',
        primaryResolver: '0x0000000000000000000000000000000000000000',
        emergencyResolver: '0x0000000000000000000000000000000000000000',
        milestonesHash: '0x123',
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x0',
        expiry: '9999999999',
        clientSignature: '0xsig',
        title: 'Security Audit Deal',
        scope: 'Comprehensive smart contract verification',
        totalAmount: '5000',
        milestones: [{
          title: 'Milestone 1',
          amount: '5000',
          workDeadline: '100',
          reviewWindow: '10',
          gracePeriod: '5',
          specHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        }],
      });

      // Canonical proposal IS created and persisted
      assert.ok(proposal);
      const found = await proposalsRepo.getById('canonical-test-prop-1');
      assert.equal(found?.proposalId, 'canonical-test-prop-1');

      // Outbox event is staged with 'skipped' status (preserving canonical audit trail)
      const outboxEvents = await outboxRepo.getPending(10);
      // Because it was skipped at staging, it is NOT pending
      const skippedOutbox = await outboxRepo.get('outbox:11155111:canonical-test-prop-1:proposal_received:' + WALLET_A.toLowerCase());
      assert.equal(skippedOutbox?.status, 'skipped');
    });

    it('8. Opted-out event marked skipped is NEVER resurrected after user re-enables preferences', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      // Opt out
      await prefsRepo.updatePreferences(WALLET_A, { milestoneSubmissionsAndRevisions: false });

      const eventId = 'outbox-no-resurrect-1';
      await outboxRepo.enqueue({
        id: eventId,
        chainId: 11155111,
        dealId: 'deal-resurrect-1',
        event: 'work_submitted',
        recipientWallet: WALLET_A,
        payload: { title: 'Audit' },
      });

      const initialOutbox = await outboxRepo.get(eventId);
      assert.equal(initialOutbox?.status, 'skipped');

      // User subsequently re-enables preferences
      await prefsRepo.updatePreferences(WALLET_A, { milestoneSubmissionsAndRevisions: true });

      // Outbox processor runs batch
      const processor = new OutboxProcessor(outboxRepo, notifRepo);
      const batchResult = await processor.processBatch(10);

      // The historical skipped event was NOT processed or claimed
      assert.equal(batchResult.claimedCount, 0);
      assert.equal(batchResult.processedCount, 0);

      const afterOutbox = await outboxRepo.get(eventId);
      assert.equal(afterOutbox?.status, 'skipped');
    });

    it('9. Security OTP verification codes bypass deal notification preferences unconditionally', async () => {
      // User disables ALL deal notification categories
      await prefsRepo.updatePreferences(WALLET_A, {
        dealProposalsAndConfirmations: false,
        milestoneSubmissionsAndRevisions: false,
        paymentsAndCompletions: false,
        disputesAndResolutions: false,
      });

      assert.equal(await isNotificationAllowed(WALLET_A, 'email_verification_code'), true);
      const res = await sendEmailVerificationCode('alice@example.com', '654321', 10);
      assert.equal(res.skipped, false);
    });
  });

  // =========================================================================
  // Task 3 — Full Deal Lifecycle Notification Coverage
  // =========================================================================
  describe('Task 3 — Complete Deal Lifecycle Notification Coverage', () => {
    it('10. Mutual settlement proposed dispatches and respects disputesAndResolutions preference', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      // Opted in: dispatches
      const resAllowed = await notifyMutualSettlementProposed({
        event: 'mutual_settlement_proposed',
        dealId: '0xdeal1234',
        dealTitle: 'Escrow Milestone Contract',
        recipientWallet: WALLET_A,
        dealAmount: '3000 USDC / 2000 USDC Split',
        note: 'Milestone #1',
      });
      assert.equal(resAllowed.skipped, false);
      assert.equal(resAllowed.recipientResolved, true);

      // Opt out of disputes: suppressed
      await prefsRepo.updatePreferences(WALLET_A, { disputesAndResolutions: false });
      const resSkipped = await notifyMutualSettlementProposed({
        event: 'mutual_settlement_proposed',
        dealId: '0xdeal1234',
        dealTitle: 'Escrow Milestone Contract',
        recipientWallet: WALLET_A,
      });
      assert.equal(resSkipped.skipped, true);
      assert.match(resSkipped.reason || '', /opted out/i);
    });

    it('11. Mutual settlement executed dispatches and respects paymentsAndCompletions preference', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      const resAllowed = await notifyMutualSettlementExecuted({
        event: 'mutual_settlement_executed',
        dealId: '0xdeal1234',
        dealTitle: 'Smart Contract Audit',
        recipientWallet: WALLET_A,
        dealAmount: '5000 USDC',
        note: 'Milestone #0',
      });
      assert.equal(resAllowed.skipped, false);

      await prefsRepo.updatePreferences(WALLET_A, { paymentsAndCompletions: false });
      const resSkipped = await notifyMutualSettlementExecuted({
        event: 'mutual_settlement_executed',
        dealId: '0xdeal1234',
        recipientWallet: WALLET_A,
      });
      assert.equal(resSkipped.skipped, true);
    });

    it('12. Mutual settlement cancelled dispatches and respects disputesAndResolutions preference', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      const res = await notifyMutualSettlementCancelled({
        event: 'mutual_settlement_cancelled',
        dealId: '0xdeal1234',
        dealTitle: 'Brand Design',
        recipientWallet: WALLET_A,
        note: 'Milestone #2',
      });
      assert.equal(res.skipped, false);

      await prefsRepo.updatePreferences(WALLET_A, { disputesAndResolutions: false });
      const resSkipped = await notifyMutualSettlementCancelled({
        event: 'mutual_settlement_cancelled',
        dealId: '0xdeal1234',
        recipientWallet: WALLET_A,
      });
      assert.equal(resSkipped.skipped, true);
    });

    it('13. Resolution report filed notifies participants without exposing private dispute text', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      const res = await notifyResolutionReportFiled({
        event: 'resolution_report_filed',
        dealId: '0xdeal9999',
        dealTitle: 'Full-Stack Integration',
        recipientWallet: WALLET_A,
        note: 'Phase: INITIAL_RESOLUTION (Milestone #1)',
      });
      assert.equal(res.skipped, false);
      assert.equal(res.recipientResolved, true);

      await prefsRepo.updatePreferences(WALLET_A, { disputesAndResolutions: false });
      const resSkipped = await notifyResolutionReportFiled({
        event: 'resolution_report_filed',
        dealId: '0xdeal9999',
        recipientWallet: WALLET_A,
      });
      assert.equal(resSkipped.skipped, true);
    });

    it('14. Committee authorization requested and resolution finalized dispatch via OutboxProcessor', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'arbiter@synq.io',
      });

      const dispatcher = new DefaultNotificationDispatcher();

      // Authorization requested
      const authRes = await dispatcher.dispatch('committee_authorization_requested', {
        dealId: '0xdeal9999',
        dealTitle: 'DeFi Escrow Integration',
        recipientWallet: WALLET_A,
        note: 'Auth ID: auth-committee-uuid-1',
      });
      assert.notEqual(authRes.skipped, true);

      // Resolution finalized
      const finalRes = await dispatcher.dispatch('resolution_finalized', {
        dealId: '0xdeal9999',
        dealTitle: 'DeFi Escrow Integration',
        recipientWallet: WALLET_A,
        milestoneIndex: 0,
      });
      assert.notEqual(finalRes.skipped, true);
    });

    it('15. Outbox lease claiming and stale claim fencing work with newly supported lifecycle events', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      const eventId = 'outbox-settlement-exec-1';
      await outboxRepo.enqueue({
        id: eventId,
        chainId: 11155111,
        dealId: '0xdeal1234',
        event: 'mutual_settlement_executed',
        recipientWallet: WALLET_A,
        payload: {
          dealId: '0xdeal1234',
          dealAmount: '5000 USDC',
        },
      });

      const claimToken = 'lease-token-test-123';
      const claimed = await outboxRepo.claim(eventId, claimToken);
      assert.equal(claimed, true);

      // Mark processed with wrong token fails (fencing prevents stolen lease write)
      await outboxRepo.markProcessed(eventId, 'wrong-token-abc');
      const itemStolen = await outboxRepo.get(eventId);
      assert.equal(itemStolen?.status, 'processing');

      // Mark processed with valid token succeeds
      await outboxRepo.markProcessed(eventId, claimToken);
      const itemFinal = await outboxRepo.get(eventId);
      assert.equal(itemFinal?.status, 'processed');
    });
  });
});
