/**
 * SYNQ — B.12.3.26: Email Settings & Notification Preferences Test Suite
 *
 * Comprehensive offline regression test suite verifying:
 * 1. New verified email with default notifications enabled.
 * 2. Existing verified user defaults (safe enabled defaults without DB row).
 * 3. Preference updates and persistence.
 * 4. Unauthorized or cross-wallet requests rejected (401, 403).
 * 5. Notification suppression after opt-out across all categories.
 * 6. Already queued outbox emails suppressed at delivery time after opt-out.
 * 7. Re-enabling notifications restores delivery.
 * 8. Email change preserves old verified address until OTP success.
 * 9. Security OTP verification codes never suppressed by deal preferences.
 * 10. Verification modal dismissal and wallet switching isolation.
 * 11. Existing outbox delivery and claim fencing behavior preserved.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';

import {
  InMemoryNotificationPreferencesRepository,
  setNotificationPreferencesRepositoryForTest,
  getCategoryForEvent,
  isNotificationAllowed,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from '../src/lib/deals/notification-preferences-db';

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
  type INotificationDispatcher,
  type DispatchResult,
} from '../src/lib/deals/outbox-processor';

import {
  notifyDealConfirmedToSeller,
  notifyBuyerWorkSubmitted,
  notifyFreelancerRevisionRequested,
  notifyBuyerDealCompleted,
  notifySellerDealCompleted,
  notifyDealCancelled,
  notifySellerPaymentReleased,
  notifyBuyerMilestoneRefunded,
  notifyProposalReceived,
  notifyMilestoneDisputed,
  sendEmailVerificationCode,
} from '../src/lib/notify';

import { setTestUserLookup, setTestUsersList, setTestVerificationsStore } from '../src/lib/db';
import { signToken } from '../src/lib/auth';
import { GET as getPreferencesRoute, PUT as putPreferencesRoute } from '../src/app/api/notifications/preferences/route';
import { POST as authRoute } from '../src/app/api/auth/route';

describe('SYNQ — B.12.3.26: Email Settings & Notification Preferences', () => {
  const WALLET_A = '0x1111111111111111111111111111111111111111';
  const WALLET_B = '0x2222222222222222222222222222222222222222';
  const TOKEN_A = signToken({ userId: 'user-a', walletAddress: WALLET_A });
  const TOKEN_B = signToken({ userId: 'user-b', walletAddress: WALLET_B });

  let prefsRepo: InMemoryNotificationPreferencesRepository;
  let notifRepo: InMemoryNotificationsRepository;
  let outboxRepo: InMemoryDealOutboxRepository;
  let proposalsRepo: InMemoryDealProposalRepository;
  let userStore: Map<string, any>;
  let verificationsStore: Map<string, any>;

  beforeEach(() => {
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
    setTestUserLookup(async (w: string) => {
      const normalized = w.toLowerCase();
      return userStore.get(normalized) || null;
    });
    setTestUsersList(async () => Array.from(userStore.values()));
    setTestVerificationsStore(verificationsStore);
  });

  afterEach(async () => {
    setNotificationPreferencesRepositoryForTest(null);
    resetNotificationsRepository();
    resetDealOutboxRepository();
    resetDealProposalRepository();
    setTestUserLookup(null);
    setTestUsersList(null);
    setTestVerificationsStore(null);
  });

  describe('1. Default Preferences for New & Existing Verified Users', () => {
    it('1. Returns sensible enabled defaults for existing users without DB preferences row', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      const req = new NextRequest(`http://localhost:3000/api/notifications/preferences?wallet=${WALLET_A}`, {
        headers: { Authorization: `Bearer ${TOKEN_A}` },
      });
      const res = await getPreferencesRoute(req);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.deepEqual(data.preferences, {
        dealProposalsAndConfirmations: true,
        milestoneSubmissionsAndRevisions: true,
        paymentsAndCompletions: true,
        disputesAndResolutions: true,
      });
    });

    it('2. Newly bound email immediately inherits enabled deal notifications', async () => {
      const allowedProposal = await isNotificationAllowed(WALLET_A, 'proposal_received');
      const allowedWork = await isNotificationAllowed(WALLET_A, 'work_submitted');
      const allowedPayment = await isNotificationAllowed(WALLET_A, 'payment_released');
      const allowedDispute = await isNotificationAllowed(WALLET_A, 'milestone_disputed');

      assert.equal(allowedProposal, true);
      assert.equal(allowedWork, true);
      assert.equal(allowedPayment, true);
      assert.equal(allowedDispute, true);
    });
  });

  describe('2. Preference Persistence & API Authorization Security', () => {
    it('3. Persists preference updates atomically via PUT endpoint', async () => {
      const updateReq = new NextRequest('http://localhost:3000/api/notifications/preferences', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({
          walletAddress: WALLET_A,
          preferences: {
            dealProposalsAndConfirmations: false,
            paymentsAndCompletions: false,
          },
        }),
      });

      const updateRes = await putPreferencesRoute(updateReq);
      assert.equal(updateRes.status, 200);
      const updateData = await updateRes.json();
      assert.equal(updateData.ok, true);
      assert.equal(updateData.preferences.dealProposalsAndConfirmations, false);
      assert.equal(updateData.preferences.milestoneSubmissionsAndRevisions, true); // preserved
      assert.equal(updateData.preferences.paymentsAndCompletions, false);
      assert.equal(updateData.preferences.disputesAndResolutions, true); // preserved

      // Verify GET returns persisted state
      const getReq = new NextRequest(`http://localhost:3000/api/notifications/preferences?wallet=${WALLET_A}`, {
        headers: { Authorization: `Bearer ${TOKEN_A}` },
      });
      const getRes = await getPreferencesRoute(getReq);
      assert.equal(getRes.status, 200);
      const getData = await getRes.json();
      assert.equal(getData.preferences.dealProposalsAndConfirmations, false);
      assert.equal(getData.preferences.paymentsAndCompletions, false);
    });

    it('4. Rejects unauthenticated requests with 401', async () => {
      const unauthGet = new NextRequest(`http://localhost:3000/api/notifications/preferences?wallet=${WALLET_A}`);
      const resGet = await getPreferencesRoute(unauthGet);
      assert.equal(resGet.status, 401);

      const unauthPut = new NextRequest('http://localhost:3000/api/notifications/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: { dealProposalsAndConfirmations: false } }),
      });
      const resPut = await putPreferencesRoute(unauthPut);
      assert.equal(resPut.status, 401);
    });

    it('5. Rejects cross-wallet inspect/update attempts with 403 Forbidden', async () => {
      // Wallet A attempts to read Wallet B preferences
      const crossGet = new NextRequest(`http://localhost:3000/api/notifications/preferences?wallet=${WALLET_B}`, {
        headers: { Authorization: `Bearer ${TOKEN_A}` },
      });
      const resGet = await getPreferencesRoute(crossGet);
      assert.equal(resGet.status, 403);
      const dataGet = await resGet.json();
      assert.match(dataGet.error, /Forbidden/);

      // Wallet A attempts to modify Wallet B preferences
      const crossPut = new NextRequest('http://localhost:3000/api/notifications/preferences', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({
          walletAddress: WALLET_B,
          preferences: { dealProposalsAndConfirmations: false },
        }),
      });
      const resPut = await putPreferencesRoute(crossPut);
      assert.equal(resPut.status, 403);
      const dataPut = await resPut.json();
      assert.match(dataPut.error, /Forbidden/);
    });

    it('6. Validates input preference types strictly', async () => {
      const invalidPut = new NextRequest('http://localhost:3000/api/notifications/preferences', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({
          preferences: {
            dealProposalsAndConfirmations: 'invalid_string' as any,
          },
        }),
      });
      const res = await putPreferencesRoute(invalidPut);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /boolean/);
    });
  });

  describe('3. Notification Suppression After Opt-Out Across Categories', () => {
    it('7. Suppresses deal proposals & confirmations notifications when opted out', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      await prefsRepo.updatePreferences(WALLET_A, { dealProposalsAndConfirmations: false });

      const resProposal = await notifyProposalReceived({
        event: 'proposal_received',
        dealId: 'deal-101',
        recipientWallet: WALLET_A,
      });
      assert.equal(resProposal.skipped, true);
      assert.equal(resProposal.mode, 'skipped');
      assert.match(resProposal.reason || '', /opted out/);

      const resConfirmed = await notifyDealConfirmedToSeller({
        event: 'deal_confirmed',
        dealId: 'deal-101',
        recipientWallet: WALLET_A,
      });
      assert.equal(resConfirmed.skipped, true);
      assert.match(resConfirmed.reason || '', /opted out/);

      const resCancelled = await notifyDealCancelled({
        event: 'deal_cancelled',
        dealId: 'deal-101',
        recipientWallet: WALLET_A,
      });
      assert.equal(resCancelled.skipped, true);
    });

    it('8. Suppresses milestone submissions and revisions when opted out', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      await prefsRepo.updatePreferences(WALLET_A, { milestoneSubmissionsAndRevisions: false });

      const resWork = await notifyBuyerWorkSubmitted({
        event: 'work_submitted',
        dealId: 'deal-202',
        recipientWallet: WALLET_A,
      });
      assert.equal(resWork.skipped, true);
      assert.match(resWork.reason || '', /opted out/);

      const resRev = await notifyFreelancerRevisionRequested({
        event: 'revision_requested',
        dealId: 'deal-202',
        recipientWallet: WALLET_A,
      });
      assert.equal(resRev.skipped, true);
      assert.match(resRev.reason || '', /opted out/);
    });

    it('9. Suppresses payments and deal completions when opted out', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      await prefsRepo.updatePreferences(WALLET_A, { paymentsAndCompletions: false });

      const resPay = await notifySellerPaymentReleased({
        event: 'payment_released',
        dealId: 'deal-303',
        recipientWallet: WALLET_A,
      });
      assert.equal(resPay.skipped, true);

      const resCompBuyer = await notifyBuyerDealCompleted({
        event: 'deal_completed',
        dealId: 'deal-303',
        recipientWallet: WALLET_A,
      });
      assert.equal(resCompBuyer.skipped, true);

      const resCompSeller = await notifySellerDealCompleted({
        event: 'deal_completed_seller',
        dealId: 'deal-303',
        recipientWallet: WALLET_A,
      });
      assert.equal(resCompSeller.skipped, true);

      const resRefund = await notifyBuyerMilestoneRefunded({
        event: 'milestone_refunded',
        dealId: 'deal-303',
        recipientWallet: WALLET_A,
      });
      assert.equal(resRefund.skipped, true);
    });

    it('10. Suppresses disputes and resolutions when opted out', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      await prefsRepo.updatePreferences(WALLET_A, { disputesAndResolutions: false });

      const resDispute = await notifyMilestoneDisputed({
        event: 'milestone_disputed',
        dealId: 'deal-404',
        recipientWallet: WALLET_A,
      });
      assert.equal(resDispute.skipped, true);
      assert.match(resDispute.reason || '', /opted out/);
    });
  });

  describe('4. Delivery-Time Suppression of Already Queued Outbox Events', () => {
    it('11. Queued outbox event is suppressed at delivery time if user opted out while in queue', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      // 1. Enqueue event while notifications are allowed
      const outboxEventId = 'outbox-test-queue-1';
      await outboxRepo.enqueue({
        id: outboxEventId,
        chainId: 11155111,
        dealId: 'deal-queue-100',
        event: 'work_submitted',
        recipientWallet: WALLET_A,
        payload: {
          title: 'Smart Contract Audit Deliverable',
          milestoneIndex: 0,
        },
      });

      const enqueued = await outboxRepo.get(outboxEventId);
      assert.equal(enqueued?.status, 'pending');

      // 2. User opts out of milestone notifications while event is queued
      await prefsRepo.updatePreferences(WALLET_A, { milestoneSubmissionsAndRevisions: false });

      // 3. Outbox processor runs to process the batch
      const processor = new OutboxProcessor(outboxRepo, notifRepo);
      const batchResult = await processor.processBatch(10);

      assert.equal(batchResult.claimedCount, 1);
      assert.equal(batchResult.skippedCount, 1);
      assert.equal(batchResult.processedCount, 0);

      // Verify outbox record is marked skipped
      const finishedOutbox = await outboxRepo.get(outboxEventId);
      assert.equal(finishedOutbox?.status, 'skipped');
      assert.match(finishedOutbox?.lastError || '', /opted out/);
    });

    it('12. Re-enabling notifications restores delivery for subsequent events', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      // Opt out
      await prefsRepo.updatePreferences(WALLET_A, { paymentsAndCompletions: false });
      const resSkipped = await notifySellerPaymentReleased({
        event: 'payment_released',
        dealId: 'deal-reenable-1',
        recipientWallet: WALLET_A,
      });
      assert.equal(resSkipped.skipped, true);

      // Re-enable
      await prefsRepo.updatePreferences(WALLET_A, { paymentsAndCompletions: true });
      const resAllowed = await notifySellerPaymentReleased({
        event: 'payment_released',
        dealId: 'deal-reenable-1',
        recipientWallet: WALLET_A,
      });
      // In development test env without live SMTP, delivery mode is log (deferred / log_only), NOT skipped!
      assert.equal(resAllowed.skipped, false);
      assert.equal(resAllowed.mode, 'log');
    });
  });

  describe('5. Transactional Verification Security Independence', () => {
    it('13. Security OTP sign-in codes are NEVER blocked by deal preferences', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      // Turn off ALL optional deal notifications
      await prefsRepo.updatePreferences(WALLET_A, {
        dealProposalsAndConfirmations: false,
        milestoneSubmissionsAndRevisions: false,
        paymentsAndCompletions: false,
        disputesAndResolutions: false,
      });

      const otpResult = await sendEmailVerificationCode('alice@example.com', '123456', 10);
      assert.equal(otpResult.skipped, false);
      assert.notEqual(otpResult.mode, 'skipped');
    });
  });

  describe('6. Email Change & Verification Isolation', () => {
    it('14. Preserves old verified email until new email OTP verification succeeds', async () => {
      // Setup initial verified email
      const initialUser = {
        id: WALLET_A.toLowerCase(),
        walletAddress: WALLET_A.toLowerCase(),
        email: 'old@example.com',
      };
      userStore.set(WALLET_A.toLowerCase(), initialUser);

      // 1. Request code for new email
      const reqBind = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({
          type: 'bind_email',
          walletAddress: WALLET_A,
          email: 'new@example.com',
        }),
      });

      const resBind = await authRoute(reqBind);
      assert.equal(resBind.status, 200);

      // Verify active email in DB is STILL old@example.com
      const userAfterRequest = userStore.get(WALLET_A.toLowerCase());
      assert.equal(userAfterRequest?.email, 'old@example.com');

      // 2. Incorrect code attempt fails and DOES NOT change active email
      const reqFail = new NextRequest('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_A}`,
        },
        body: JSON.stringify({
          type: 'bind_email_verify',
          walletAddress: WALLET_A,
          email: 'new@example.com',
          code: '000000',
        }),
      });
      const resFail = await authRoute(reqFail);
      assert.equal(resFail.status, 401);

      // Verify active email is STILL old@example.com
      const userAfterFail = userStore.get(WALLET_A.toLowerCase());
      assert.equal(userAfterFail?.email, 'old@example.com');
    });

    it('15. Switching wallets guarantees strict state isolation', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });
      userStore.set(WALLET_B.toLowerCase(), {
        walletAddress: WALLET_B.toLowerCase(),
        email: 'bob@example.com',
      });

      // Wallet A opts out of all notifications
      await prefsRepo.updatePreferences(WALLET_A, {
        dealProposalsAndConfirmations: false,
        milestoneSubmissionsAndRevisions: false,
        paymentsAndCompletions: false,
        disputesAndResolutions: false,
      });

      // Wallet B preferences remain default true
      const prefsB = await prefsRepo.getPreferences(WALLET_B);
      assert.deepEqual(prefsB, {
        dealProposalsAndConfirmations: true,
        milestoneSubmissionsAndRevisions: true,
        paymentsAndCompletions: true,
        disputesAndResolutions: true,
      });

      // Wallet A is suppressed
      assert.equal(await isNotificationAllowed(WALLET_A, 'work_submitted'), false);

      // Wallet B is allowed
      assert.equal(await isNotificationAllowed(WALLET_B, 'work_submitted'), true);
    });
  });

  describe('7. Outbox Delivery & Fencing Preservation', () => {
    it('16. Outbox claim token fencing and status transitions remain fully intact', async () => {
      userStore.set(WALLET_A.toLowerCase(), {
        walletAddress: WALLET_A.toLowerCase(),
        email: 'alice@example.com',
      });

      const eventId = 'outbox-fence-1';
      await outboxRepo.enqueue({
        id: eventId,
        chainId: 11155111,
        dealId: 'deal-fence-10',
        event: 'proposal_received',
        recipientWallet: WALLET_A,
        payload: { title: 'Fenced proposal' },
      });

      const claimToken = crypto.randomUUID();
      const claimed = await outboxRepo.claim(eventId, claimToken);
      assert.equal(claimed, true);

      // Marking with wrong claim token must fail (fencing prevents state change)
      await outboxRepo.markProcessed(eventId, 'wrong-token-abc');
      const itemAfterWrong = await outboxRepo.get(eventId);
      assert.equal(itemAfterWrong?.status, 'processing');

      // Marking with valid claim token succeeds
      await outboxRepo.markProcessed(eventId, claimToken);
      const finalItem = await outboxRepo.get(eventId);
      assert.equal(finalItem?.status, 'processed');
    });
  });
});
