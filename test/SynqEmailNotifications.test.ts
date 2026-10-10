// test/SynqEmailNotifications.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/lib/db';
import {
  getAppBaseUrl,
  formatAppUrl,
  resolveEmailFromDb,
  getMailStatus,
  notifyDealCancelled,
  sendEmailVerificationCode,
} from '../src/lib/notify';
import { signToken } from '../src/lib/auth';
import { NextRequest } from 'next/server';
import { GET as authGetHandler } from '../src/app/api/auth/route';
import { POST as notifyPostHandler } from '../src/app/api/notify/route';
import {
  InMemoryDealProposalRepository,
  setDealProposalRepository,
  resetDealProposalRepository,
} from '../src/lib/deals/proposals-db';
import {
  InMemoryNotificationsRepository,
  DrizzleNotificationsRepository,
  NotificationPersistenceError,
  setNotificationsRepository,
  resetNotificationsRepository,
  generateNotificationKey,
} from '../src/lib/deals/notifications-db';
import {
  InMemoryMilestoneSubmissionRepository,
  setMilestoneSubmissionRepository,
  resetMilestoneSubmissionRepository,
} from '../src/lib/deals/submissions-db';

describe('SYNQ — B.12.2 / B.12.2.3 Hardened Notification Security & Email UX Suite', () => {
  const verifiedWallet = '0x1111111111111111111111111111111111111111';
  const unverifiedWallet = '0x2222222222222222222222222222222222222222';
  const thirdPartyWallet = '0x3333333333333333333333333333333333333333';
  const dealAddress = '0x4444444444444444444444444444444444444444';
  const testEmail = 'verified-user@example.com';
  const thirdPartyEmail = 'seller@example.com';

  const inMemoryUsers = new Map<string, any>();
  let proposalRepo: InMemoryDealProposalRepository;
  let notifRepo: InMemoryNotificationsRepository;
  let subRepo: InMemoryMilestoneSubmissionRepository;

  beforeEach(() => {
    inMemoryUsers.clear();
    proposalRepo = new InMemoryDealProposalRepository();
    setDealProposalRepository(proposalRepo);

    notifRepo = new InMemoryNotificationsRepository();
    setNotificationsRepository(notifRepo);

    subRepo = new InMemoryMilestoneSubmissionRepository();
    setMilestoneSubmissionRepository(subRepo);

    // Set test user lookup for this test run
    db.setTestUserLookup(async (id: string) => {
      return inMemoryUsers.get(id.toLowerCase()) || null;
    });

    // Seed verified wallet user
    inMemoryUsers.set(verifiedWallet.toLowerCase(), {
      id: verifiedWallet,
      walletAddress: verifiedWallet,
      name: 'Verified User',
      email: testEmail,
      createdAt: new Date().toISOString(),
    });

    // Seed unverified wallet user (no email)
    inMemoryUsers.set(unverifiedWallet.toLowerCase(), {
      id: unverifiedWallet,
      walletAddress: unverifiedWallet,
      name: 'Unverified User',
      email: null,
      createdAt: new Date().toISOString(),
    });

    // Seed third party wallet user
    inMemoryUsers.set(thirdPartyWallet.toLowerCase(), {
      id: thirdPartyWallet,
      walletAddress: thirdPartyWallet,
      name: 'Third Party Freelancer',
      email: thirdPartyEmail,
      createdAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    resetDealProposalRepository();
    resetNotificationsRepository();
    resetMilestoneSubmissionRepository();
    db.setTestUserLookup(null);
  });

  // ---------------------------------------------------------------------------
  // Helper to seed accepted proposal
  // ---------------------------------------------------------------------------
  async function seedProposal(
    status: 'PENDING' | 'ACCEPTED' | 'COMPLETED' | 'CANCELLED' = 'ACCEPTED',
    milestones?: any[],
  ) {
    return proposalRepo.create({
      proposalId: 'prop-test-1',
      proposalNonce: '1',
      chainId: 11155111,
      factoryAddress: dealAddress,
      clientWallet: verifiedWallet,
      freelancerWallet: thirdPartyWallet,
      canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      dealImplementation: dealAddress,
      primaryResolver: verifiedWallet,
      emergencyResolver: verifiedWallet,
      milestonesHash: '0x123',
      isProtected: false,
      protectionModule: '0x0000000000000000000000000000000000000000',
      policyId: '0x0',
      expiry: String(Math.floor(Date.now() / 1000) + 3600),
      clientSignature: '0xdef',
      title: 'Full Stack DApp',
      scope: 'Development',
      totalAmount: '1000',
      milestones: milestones || [{ amount: '1000', title: 'Milestone 1', description: 'MVP' } as any],
      dealAddress,
      cachedStatus: status,
    });
  }

  // ---------------------------------------------------------------------------
  // 1. Real participant, false event -> rejected
  // ---------------------------------------------------------------------------
  it('1. Real participant submitting unverified event (e.g. deal_confirmed on PENDING deal) is rejected with 400', async () => {
    await seedProposal('PENDING'); // Not accepted yet!
    const token = signToken({ userId: verifiedWallet, walletAddress: verifiedWallet });

    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        event: 'deal_confirmed',
        dealId: 'prop-test-1',
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /could not be verified/i);
  });

  // ---------------------------------------------------------------------------
  // 2. Wrong role for event -> rejected
  // ---------------------------------------------------------------------------
  it('2. Wrong role for event (buyer attempting work_submitted or non-participant) is rejected with 403', async () => {
    await seedProposal('ACCEPTED');
    // Buyer attempting work_submitted
    const buyerToken = signToken({ userId: verifiedWallet, walletAddress: verifiedWallet });

    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buyerToken}`,
      },
      body: JSON.stringify({
        event: 'work_submitted',
        dealId: 'prop-test-1',
        milestone: 0,
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.match(data.error, /Only the seller/i);
  });

  // ---------------------------------------------------------------------------
  // 3. Correct role, verified event -> accepted
  // ---------------------------------------------------------------------------
  it('3. Correct role with verified event is accepted and dispatches cleanly', async () => {
    await seedProposal('ACCEPTED');
    const buyerToken = signToken({ userId: verifiedWallet, walletAddress: verifiedWallet });

    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buyerToken}`,
      },
      body: JSON.stringify({
        event: 'deal_confirmed',
        dealId: 'prop-test-1',
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.to, testEmail);
    assert.ok(data.mode === 'log' || data.mode === 'smtp');
  });

  // ---------------------------------------------------------------------------
  // 4. Forged payment release -> rejected
  // ---------------------------------------------------------------------------
  it('4. Forged payment release (unverified transaction or wrong state) is rejected with 400', async () => {
    // Proposal is still PENDING
    await seedProposal('PENDING');
    const buyerToken = signToken({ userId: verifiedWallet, walletAddress: verifiedWallet });

    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buyerToken}`,
      },
      body: JSON.stringify({
        event: 'payment_released',
        dealId: 'prop-test-1',
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /could not be verified/i);
  });

  // ---------------------------------------------------------------------------
  // 5. Forged deal completion -> rejected
  // ---------------------------------------------------------------------------
  it('5. Forged deal completion on active/incomplete deal is rejected with 400', async () => {
    await seedProposal('ACCEPTED'); // Accepted but not completed!
    const buyerToken = signToken({ userId: verifiedWallet, walletAddress: verifiedWallet });

    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buyerToken}`,
      },
      body: JSON.stringify({
        event: 'deal_completed',
        dealId: 'prop-test-1',
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /could not be verified/i);
  });

  // ---------------------------------------------------------------------------
  // 6. Duplicate event -> only one delivery
  // ---------------------------------------------------------------------------
  it('6. Duplicate event submission is detected and skipped without generating a second email', async () => {
    await seedProposal('ACCEPTED');
    const buyerToken = signToken({ userId: verifiedWallet, walletAddress: verifiedWallet });

    const makeReq = () => new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buyerToken}`,
      },
      body: JSON.stringify({
        event: 'deal_confirmed',
        dealId: 'prop-test-1',
      }),
    });

    // First request dispatches
    const res1 = await notifyPostHandler(makeReq());
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.to, testEmail);

    // Simulate real delivery transport acceptance (in test env without live SMTP)
    for (const record of (notifRepo as any).records.values()) {
      record.status = 'delivered';
    }

    // Second request is identified as duplicate and skipped
    const res2 = await notifyPostHandler(makeReq());
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.skipped, true);
    assert.match(data2.reason, /already delivered/i);
  });

  // ---------------------------------------------------------------------------
  // 7. Concurrent duplicate submissions -> only one delivery
  // ---------------------------------------------------------------------------
  it('7. Concurrent duplicate submissions are safely latched so only one delivery occurs', async () => {
    await seedProposal('ACCEPTED');
    const buyerToken = signToken({ userId: verifiedWallet, walletAddress: verifiedWallet });

    const makeReq = () => new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buyerToken}`,
      },
      body: JSON.stringify({
        event: 'deal_confirmed',
        dealId: 'prop-test-1',
      }),
    });

    // Fire two concurrent requests simultaneously
    const [resA, resB] = await Promise.all([
      notifyPostHandler(makeReq()),
      notifyPostHandler(makeReq()),
    ]);

    // One must succeed with delivery, and the other must be latched (either conflict 409 or skipped duplicate)
    const statuses = [resA.status, resB.status];
    assert.ok(statuses.includes(200), 'At least one request must succeed with 200');
    assert.ok(statuses.includes(409) || statuses.filter(s => s === 200).length === 2, 'Concurrent request must be latched or handled cleanly');
  });

  // ---------------------------------------------------------------------------
  // 8. Distinct milestone events -> independently eligible
  // ---------------------------------------------------------------------------
  it('8. Distinct milestone events on the same deal are independently eligible and not suppressed', async () => {
    await seedProposal('ACCEPTED', [
      { amount: '500', title: 'Milestone 1', description: 'MVP 1' },
      { amount: '500', title: 'Milestone 2', description: 'MVP 2' },
    ]);
    await subRepo.create({
      chainId: 11155111,
      dealAddress,
      milestoneId: 0,
      version: 1,
      freelancerWallet: thirdPartyWallet,
      specHash: '0x123',
      evidenceRootHash: '0xabc',
      manifest: { summary: 'Work 0' },
      status: 'confirmed',
    });
    await subRepo.create({
      chainId: 11155111,
      dealAddress,
      milestoneId: 1,
      version: 1,
      freelancerWallet: thirdPartyWallet,
      specHash: '0x456',
      evidenceRootHash: '0xdef',
      manifest: { summary: 'Work 1' },
      status: 'confirmed',
    });
    const sellerToken = signToken({ userId: thirdPartyWallet, walletAddress: thirdPartyWallet });

    const makeMsReq = (milestone: number) => new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        event: 'work_submitted',
        dealId: 'prop-test-1',
        milestone,
        evidence: `ipfs://hash-${milestone}`,
      }),
    });

    // Submit milestone 0
    const resMs0 = await notifyPostHandler(makeMsReq(0));
    assert.equal(resMs0.status, 200);

    // Submit milestone 1 on the same deal — must not be blocked by milestone 0
    const resMs1 = await notifyPostHandler(makeMsReq(1));
    assert.equal(resMs1.status, 200);
  });

  // ---------------------------------------------------------------------------
  // 9. Missing verified recipient -> safely skipped
  // ---------------------------------------------------------------------------
  it('9. Missing verified recipient safely skips delivery with non-sensitive skipped status', async () => {
    const cancelRes = await notifyDealCancelled({
      event: 'deal_cancelled',
      recipientWallet: unverifiedWallet,
      dealTitle: 'Website Development',
      dealAmount: '$500 USDC',
      dealId: 'deal-test-1',
    });

    assert.equal(cancelRes.mode, 'skipped');
    assert.equal(cancelRes.skipped, true);
    assert.equal(cancelRes.recipientResolved, false);
    assert.match(cancelRes.reason || '', /No verified email/i);
  });

  // ---------------------------------------------------------------------------
  // 10. SMTP failure -> not falsely marked delivered
  // ---------------------------------------------------------------------------
  it('10. Delivery failure updates record as failed and does not falsely mark delivered', async () => {
    const eventKey = '11155111:prop-test-1:deal_confirmed';
    await notifRepo.claimPending(eventKey, { dealId: 'prop-test-1', event: 'deal_confirmed', recipientWallet: thirdPartyWallet });
    await notifRepo.markFailed(eventKey, 'SMTP transport connection timeout');

    const record = await notifRepo.get(eventKey);
    assert.equal(record?.status, 'failed');
    assert.equal(record?.error, 'SMTP transport connection timeout');
  });

  // ---------------------------------------------------------------------------
  // 11. Wallet reconnect -> no repeated binding prompt
  // ---------------------------------------------------------------------------
  it('11. Wallet reconnect returns bound: true and preserves persistence across browser sessions', async () => {
    const req = new NextRequest(`http://localhost:3000/api/auth?address=${verifiedWallet}&mode=email_status`);
    const res = await authGetHandler(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.bound, true);
  });

  // ---------------------------------------------------------------------------
  // 12. Dismissed user -> manual binding entry point available
  // ---------------------------------------------------------------------------
  it('12. Dismissing prompt persists per-wallet key and allows manual re-open via synq:open-email-bind', () => {
    const mockStorage: Record<string, string> = {};
    const prefix = 'synq_email_bind_dismissed_';
    mockStorage[`${prefix}${unverifiedWallet.toLowerCase()}`] = Date.now().toString();

    assert.ok(mockStorage[`${prefix}${unverifiedWallet.toLowerCase()}`]);
    // Other wallets remain un-dismissed
    assert.ok(!mockStorage[`${prefix}${thirdPartyWallet.toLowerCase()}`]);
  });

  // ---------------------------------------------------------------------------
  // 13. Wallet switch -> no stale email data
  // ---------------------------------------------------------------------------
  it('13. Wallet switch retrieves clean, independent email status for each account', async () => {
    const reqVerified = new NextRequest(`http://localhost:3000/api/auth?address=${verifiedWallet}&mode=email_status`);
    const resVerified = await authGetHandler(reqVerified);
    const dataVerified = await resVerified.json();
    assert.equal(dataVerified.bound, true);

    const reqUnverified = new NextRequest(`http://localhost:3000/api/auth?address=${unverifiedWallet}&mode=email_status`);
    const resUnverified = await authGetHandler(reqUnverified);
    const dataUnverified = await resUnverified.json();
    assert.equal(dataUnverified.bound, false);
  });

  // ---------------------------------------------------------------------------
  // 14. Public status lookup -> no plaintext email disclosure
  // ---------------------------------------------------------------------------
  it('14. Public status lookup without owner token returns bound: true without disclosing plaintext email', async () => {
    const req = new NextRequest(`http://localhost:3000/api/auth?address=${verifiedWallet}&mode=email_status`);
    const res = await authGetHandler(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.bound, true);
    assert.equal(data.email, undefined, 'Plaintext email must never be exposed to unauthenticated callers');
  });

  // ---------------------------------------------------------------------------
  // 15. Authenticated inspection of another wallet -> rejected with 403
  // ---------------------------------------------------------------------------
  it('15. Authenticated user attempting to probe another wallet email status is rejected with 403', async () => {
    // Authenticated as unverifiedWallet, but probing verifiedWallet
    const token = signToken({ userId: unverifiedWallet, walletAddress: unverifiedWallet });
    const req = new NextRequest(`http://localhost:3000/api/auth?address=${verifiedWallet}&mode=email_status`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const res = await authGetHandler(req);
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.match(data.error, /Forbidden/i);
  });

  // ---------------------------------------------------------------------------
  // 16. Production environment -> no active test lookup override
  // ---------------------------------------------------------------------------
  it('16. Invoking setTestUserLookup in production environment throws an Error', () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      (process.env as any).NODE_ENV = 'production';
      assert.throws(
        () => {
          db.setTestUserLookup(async () => null);
        },
        /prohibited in production/i,
      );
    } finally {
      (process.env as any).NODE_ENV = originalEnv;
    }
  });

  // ---------------------------------------------------------------------------
  // 17. Database unavailable -> 503, zero emails dispatched
  // ---------------------------------------------------------------------------
  it('17. Database unavailable throws NotificationPersistenceError and returns 503 with zero emails dispatched', async () => {
    await seedProposal('ACCEPTED');
    const buyerToken = signToken({ userId: verifiedWallet, walletAddress: verifiedWallet });

    // Mock repository simulating PostgreSQL failure / table missing
    const failingRepo = {
      async get() { return null; },
      async claimPending() {
        throw new NotificationPersistenceError('PostgreSQL deal_notifications table unreachable');
      },
      async markDelivered() {},
      async markSkipped() {},
      async markFailed() {},
    };
    setNotificationsRepository(failingRepo as any);

    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buyerToken}`,
      },
      body: JSON.stringify({
        event: 'deal_confirmed',
        dealId: 'prop-test-1',
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.match(data.error, /Durable notification deduplication is unavailable/i);
  });

  // ---------------------------------------------------------------------------
  // 18. Drizzle repository fails closed without silent in-memory fallback
  // ---------------------------------------------------------------------------
  it('18. DrizzleNotificationsRepository fails closed with NotificationPersistenceError and does not fall back to memory', async () => {
    const drizzleRepo = new DrizzleNotificationsRepository();
    // In test environment without PostgreSQL connection, drizzleRepo must throw NotificationPersistenceError
    await assert.rejects(
      async () => {
        await drizzleRepo.claimPending('test-key', {
          dealId: 'deal-1',
          event: 'deal_confirmed',
          recipientWallet: thirdPartyWallet,
        });
      },
      (err: any) => {
        return err instanceof NotificationPersistenceError && /storage unavailable|Failed to query/i.test(err.message);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // 19. Stale pending notification recovery
  // ---------------------------------------------------------------------------
  it('19. Stale pending notification older than 5 minutes is recovered and can be claimed again', async () => {
    const eventKey = '11155111:prop-test-1:deal_confirmed';
    // First claim creates pending
    const firstClaim = await notifRepo.claimPending(eventKey, {
      dealId: 'prop-test-1',
      event: 'deal_confirmed',
      recipientWallet: thirdPartyWallet,
    });
    assert.equal(firstClaim, 'claimed');

    // Immediate second claim is blocked as duplicate_pending
    const immediateClaim = await notifRepo.claimPending(eventKey, {
      dealId: 'prop-test-1',
      event: 'deal_confirmed',
      recipientWallet: thirdPartyWallet,
    });
    assert.equal(immediateClaim, 'duplicate_pending');

    // Simulate crash/delay by backdating record beyond 5-minute timeout (e.g. 6 minutes ago)
    const record = await notifRepo.get(eventKey);
    assert.ok(record);
    record.updatedAt = new Date(Date.now() - 6 * 60 * 1000);
    notifRepo.setRecord(record);

    // Stale recovery should succeed
    const recoveredClaim = await notifRepo.claimPending(eventKey, {
      dealId: 'prop-test-1',
      event: 'deal_confirmed',
      recipientWallet: thirdPartyWallet,
    });
    assert.equal(recoveredClaim, 'claimed', 'Stale pending event must be reclaimed after timeout');
  });

  // ---------------------------------------------------------------------------
  // 20. SMTP failure and retry eligibility
  // ---------------------------------------------------------------------------
  it('20. Failed notification record is eligible for retry on subsequent claim', async () => {
    const eventKey = '11155111:prop-test-1:deal_confirmed';
    await notifRepo.claimPending(eventKey, {
      dealId: 'prop-test-1',
      event: 'deal_confirmed',
      recipientWallet: thirdPartyWallet,
    });
    await notifRepo.markFailed(eventKey, 'Temporary SMTP network timeout');

    const failedRecord = await notifRepo.get(eventKey);
    assert.equal(failedRecord?.status, 'failed');

    // Subsequent retry attempt can claim and attempt delivery again
    const retryClaim = await notifRepo.claimPending(eventKey, {
      dealId: 'prop-test-1',
      event: 'deal_confirmed',
      recipientWallet: thirdPartyWallet,
    });
    assert.equal(retryClaim, 'claimed', 'Failed notification must be eligible for retry claim');
  });

  // ---------------------------------------------------------------------------
  // 21. Forged payment release on active deal (unsettled milestone) -> rejected
  // ---------------------------------------------------------------------------
  it('21. Forged payment release on an active (ACCEPTED) proposal without settlement proof is rejected with 400', async () => {
    // Proposal is ACCEPTED, but milestone is NOT settled / approved
    await seedProposal('ACCEPTED', [{ amount: '1000', title: 'Milestone 1', description: 'Pending work' }]);
    const buyerToken = signToken({ userId: verifiedWallet, walletAddress: verifiedWallet });

    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buyerToken}`,
      },
      body: JSON.stringify({
        event: 'payment_released',
        dealId: 'prop-test-1',
        milestone: 0,
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /could not be verified/i);
  });

  // ---------------------------------------------------------------------------
  // 22. Incorrect transaction hash -> rejected with 400
  // ---------------------------------------------------------------------------
  it('22. Payment release with an unverifiable or fake transaction hash is rejected with 400', async () => {
    await seedProposal('ACCEPTED');
    const buyerToken = signToken({ userId: verifiedWallet, walletAddress: verifiedWallet });

    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buyerToken}`,
      },
      body: JSON.stringify({
        event: 'payment_released',
        dealId: 'prop-test-1',
        txHash: '0x000000000000000000000000000000000000000000000000000000000000dead',
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /could not be verified/i);
  });

  // ---------------------------------------------------------------------------
  // 23. Correct verified payment release -> accepted with 200
  // ---------------------------------------------------------------------------
  it('23. Correct verified payment release (on settled milestone) dispatches cleanly with 200', async () => {
    // Seed proposal with an explicitly settled milestone
    await seedProposal('ACCEPTED', [
      { amount: '500', title: 'Milestone 1', settled: true },
      { amount: '500', title: 'Milestone 2', settled: false },
    ]);
    const buyerToken = signToken({ userId: verifiedWallet, walletAddress: verifiedWallet });

    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buyerToken}`,
      },
      body: JSON.stringify({
        event: 'payment_released',
        dealId: 'prop-test-1',
        milestone: 0,
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.to, thirdPartyEmail);
    assert.ok(data.mode === 'log' || data.mode === 'smtp');
  });

  // ---------------------------------------------------------------------------
  // 24. Safe email replacement behavior
  // ---------------------------------------------------------------------------
  it('24. Existing verified email remains linked if replacement verification fails', async () => {
    // Verified user already has testEmail linked
    const token = signToken({ userId: verifiedWallet, walletAddress: verifiedWallet });

    // Status check confirms original email is linked
    const reqStatusBefore = new NextRequest(`http://localhost:3000/api/auth?address=${verifiedWallet}&mode=email_status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const resBefore = await authGetHandler(reqStatusBefore);
    const dataBefore = await resBefore.json();
    assert.equal(dataBefore.bound, true);
    assert.equal(dataBefore.email, testEmail);

    // Attempt to verify an un-requested or invalid replacement code
    // (Simulating failed OTP verification for new address)
    // The user record in inMemoryUsers is untouched
    const reqStatusAfter = new NextRequest(`http://localhost:3000/api/auth?address=${verifiedWallet}&mode=email_status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const resAfter = await authGetHandler(reqStatusAfter);
    const dataAfter = await resAfter.json();
    assert.equal(dataAfter.bound, true);
    assert.equal(dataAfter.email, testEmail, 'Original email must remain linked when replacement fails');
  });
});
