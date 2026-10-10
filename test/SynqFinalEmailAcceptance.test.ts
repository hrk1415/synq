// test/SynqFinalEmailAcceptance.test.ts
/**
 * SYNQ — B.12.3.62: Final Email Notification Acceptance Suite
 *
 * Verifies end-to-end acceptance invariants across:
 * 1. Milestone Submissions & Revisions preference opt-out suppression.
 * 2. Milestone Submissions & Revisions preference opt-in delivery.
 * 3. Exact deduplication of already-delivered events (zero additional SMTP sends).
 * 4. Caller manipulation immunity (caller-supplied evidence, version, or txHash cannot bypass deduplication).
 * 5. Fail-closed rejection when authoritative verification source is unavailable or missing.
 * 6. SMTP authorization safety, OTP console suppression, and dormant background workers.
 * 7. Recipient-centric evaluation: preferences evaluated for recipient, never sender.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { NextRequest } from 'next/server';

import { setTestTransporter, getMailStatus } from '../src/lib/notify';
import { POST as notifyPostHandler } from '../src/app/api/notify/route';
import {
  InMemoryDealProposalRepository,
  setDealProposalRepository,
  resetDealProposalRepository,
} from '../src/lib/deals/proposals-db';
import {
  InMemoryNotificationsRepository,
  setNotificationsRepository,
  resetNotificationsRepository,
} from '../src/lib/deals/notifications-db';
import {
  InMemoryNotificationPreferencesRepository,
  setNotificationPreferencesRepositoryForTest,
} from '../src/lib/deals/notification-preferences-db';
import {
  InMemoryMilestoneSubmissionRepository,
  setMilestoneSubmissionRepository,
  resetMilestoneSubmissionRepository,
} from '../src/lib/deals/submissions-db';
import { checkStagingServices } from '../scripts/staging-services-check';
import { runStagingDevPreflight } from '../scripts/staging-dev';
import { isStagingOtpConsoleAllowed, logStagingOtpIfAllowed } from '../src/lib/staging-otp';
import { APPROVED_STAGING_PROJECT_REF } from '../src/lib/staging-env';
import * as db from '../src/lib/db';
import { signToken } from '../src/lib/auth';

interface CapturedEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

describe('SYNQ — B.12.3.62: Final Email Notification Acceptance', () => {
  const WALLET_BUYER = '0x1111111111111111111111111111111111111111';
  const WALLET_SELLER = '0x2222222222222222222222222222222222222222';
  const BUYER_EMAIL = 'client@example.com';
  const SELLER_EMAIL = 'freelancer@example.com';
  const DEAL_ID = 'prop-final-acc-001';
  const DEAL_ADDRESS = '0x5555555555555555555555555555555555555555';

  let proposalRepo: InMemoryDealProposalRepository;
  let notifRepo: InMemoryNotificationsRepository;
  let prefsRepo: InMemoryNotificationPreferencesRepository;
  let subRepo: InMemoryMilestoneSubmissionRepository;
  let capturedEmails: CapturedEmail[];
  let sellerToken: string;
  let buyerToken: string;

  beforeEach(async () => {
    proposalRepo = new InMemoryDealProposalRepository();
    setDealProposalRepository(proposalRepo);

    notifRepo = new InMemoryNotificationsRepository();
    setNotificationsRepository(notifRepo);

    prefsRepo = new InMemoryNotificationPreferencesRepository();
    setNotificationPreferencesRepositoryForTest(prefsRepo);

    subRepo = new InMemoryMilestoneSubmissionRepository();
    setMilestoneSubmissionRepository(subRepo);

    const userMap = new Map<string, any>();
    userMap.set(WALLET_BUYER.toLowerCase(), {
      id: WALLET_BUYER.toLowerCase(),
      walletAddress: WALLET_BUYER.toLowerCase(),
      name: 'Client A',
      email: BUYER_EMAIL,
    });
    userMap.set(WALLET_SELLER.toLowerCase(), {
      id: WALLET_SELLER.toLowerCase(),
      walletAddress: WALLET_SELLER.toLowerCase(),
      name: 'Freelancer B',
      email: SELLER_EMAIL,
    });

    db.setTestUserLookup(async (id: string) => userMap.get(id.toLowerCase()) || null);
    db.setTestUsersList(async () => Array.from(userMap.values()));

    capturedEmails = [];
    const baseTransport = nodemailer.createTransport({ jsonTransport: true });
    const originalSendMail = baseTransport.sendMail.bind(baseTransport);
    baseTransport.sendMail = async (options: any) => {
      const res = await originalSendMail(options);
      capturedEmails.push({
        to: String(options.to || ''),
        subject: String(options.subject || ''),
        html: String(options.html || ''),
        text: String(options.text || ''),
      });
      return res;
    };
    setTestTransporter(baseTransport);

    sellerToken = signToken({ userId: WALLET_SELLER, walletAddress: WALLET_SELLER });
    buyerToken = signToken({ userId: WALLET_BUYER, walletAddress: WALLET_BUYER });

    // Seed default accepted proposal with 2 milestones
    await proposalRepo.create({
      proposalId: DEAL_ID,
      proposalNonce: '101',
      chainId: 11155111,
      factoryAddress: '0x4444444444444444444444444444444444444444',
      clientWallet: WALLET_BUYER,
      freelancerWallet: WALLET_SELLER,
      canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      dealImplementation: '0x4444444444444444444444444444444444444444',
      primaryResolver: WALLET_BUYER,
      emergencyResolver: WALLET_BUYER,
      milestonesHash: '0x123',
      isProtected: false,
      protectionModule: '0x0000000000000000000000000000000000000000',
      policyId: '0x0',
      expiry: String(Math.floor(Date.now() / 1000) + 3600),
      clientSignature: '0xdef',
      title: 'Final Acceptance Deal',
      scope: 'End-to-End Verification',
      totalAmount: '10000000', // 10 USDC total
      milestones: [
        {
          amount: '4000000', // 4 USDC
          workDeadline: '1000',
          reviewWindow: '500',
          gracePeriod: '500',
          specHash: '0x111',
          title: 'Milestone 1',
        } as any,
        {
          amount: '6000000', // 6 USDC
          workDeadline: '2000',
          reviewWindow: '500',
          gracePeriod: '500',
          specHash: '0x222',
          title: 'Milestone 2',
        } as any,
      ],
      dealAddress: DEAL_ADDRESS,
      cachedStatus: 'ACCEPTED',
    });
  });

  afterEach(() => {
    resetDealProposalRepository();
    resetNotificationsRepository();
    resetMilestoneSubmissionRepository();
    db.setTestUserLookup(null);
    setTestTransporter(null);
  });

  // =========================================================================
  // Requirement 1: Disabling Milestone Submissions & Revisions suppresses email
  // =========================================================================
  it('Req 1: Disabling Milestone Submissions & Revisions prevents work_submitted dispatch', async () => {
    // Seed legitimate verified submission in repo
    await subRepo.create({
      chainId: 11155111,
      dealAddress: DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      freelancerWallet: WALLET_SELLER,
      specHash: '0x111',
      evidenceRootHash: '0xabc',
      manifest: { summary: 'Milestone 1 deliverable' },
      status: 'confirmed',
    });

    // Recipient (buyer) explicitly disables Milestone Submissions & Revisions
    await prefsRepo.updatePreferences(WALLET_BUYER, {
      milestoneSubmissionsAndRevisions: false, // DISABLED
    });

    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        event: 'work_submitted',
        dealId: DEAL_ID,
        milestone: 0,
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.skipped, true);
    assert.equal(data.mode, 'skipped');
    assert.ok(data.reason?.includes('Recipient opted out of work_submitted notifications'));
    assert.equal(capturedEmails.length, 0, 'No email must be sent when recipient opts out');
  });

  // =========================================================================
  // Requirement 2: Enabling the category permits an otherwise valid notification
  // =========================================================================
  it('Req 2: Enabling Milestone Submissions & Revisions permits an otherwise valid notification', async () => {
    // Seed legitimate verified submission in repo
    await subRepo.create({
      chainId: 11155111,
      dealAddress: DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      freelancerWallet: WALLET_SELLER,
      specHash: '0x111',
      evidenceRootHash: '0xabc',
      manifest: { summary: 'Milestone 1 deliverable' },
      status: 'confirmed',
    });

    // Recipient (buyer) has Milestone Submissions & Revisions enabled
    await prefsRepo.updatePreferences(WALLET_BUYER, {
      milestoneSubmissionsAndRevisions: true, // ENABLED
    });

    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        event: 'work_submitted',
        dealId: DEAL_ID,
        milestone: 0,
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.deliveryStatus, 'delivered');
    assert.equal(capturedEmails.length, 1);
    assert.equal(capturedEmails[0].to, BUYER_EMAIL);
    assert.ok(capturedEmails[0].subject.includes('Work submitted'));
  });

  // =========================================================================
  // Requirement 3: Repeating an already-delivered event is deduplicated without SMTP send
  // =========================================================================
  it('Req 3: Repeating an already-delivered event is deduplicated without another SMTP send', async () => {
    await subRepo.create({
      chainId: 11155111,
      dealAddress: DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      freelancerWallet: WALLET_SELLER,
      specHash: '0x111',
      evidenceRootHash: '0xabc',
      manifest: { summary: 'Milestone 1 deliverable' },
      status: 'confirmed',
    });

    // 1st dispatch
    const req1 = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        event: 'work_submitted',
        dealId: DEAL_ID,
        milestone: 0,
      }),
    });
    const res1 = await notifyPostHandler(req1);
    assert.equal(res1.status, 200);
    assert.equal(capturedEmails.length, 1);

    // 2nd dispatch (identical event)
    const req2 = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        event: 'work_submitted',
        dealId: DEAL_ID,
        milestone: 0,
      }),
    });
    const res2 = await notifyPostHandler(req2);
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.messageId, 'duplicate-skipped');
    assert.equal(data2.skipped, true);
    assert.equal(data2.reason, 'Notification already delivered for this event');
    assert.equal(capturedEmails.length, 1, 'Exactly 1 email sent; duplicate call triggered 0 SMTP sends');
  });

  // =========================================================================
  // Requirement 4: Changing caller evidence, version, or txHash cannot bypass deduplication
  // =========================================================================
  it('Req 4: Changing caller-supplied evidence, version, or txHash cannot bypass deduplication', async () => {
    await subRepo.create({
      chainId: 11155111,
      dealAddress: DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      freelancerWallet: WALLET_SELLER,
      specHash: '0x111',
      evidenceRootHash: '0xabc',
      manifest: { summary: 'Original confirmed submission' },
      status: 'confirmed',
    });

    // 1st request delivered
    const req1 = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        event: 'work_submitted',
        dealId: DEAL_ID,
        milestone: 0,
      }),
    });
    const res1 = await notifyPostHandler(req1);
    assert.equal(res1.status, 200);
    assert.equal(capturedEmails.length, 1);

    // Caller attempts to evade deduplication by changing evidence, version, and txHash
    const req2 = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        event: 'work_submitted',
        dealId: DEAL_ID,
        milestone: 0,
        evidence: 'https://attacker.example.com/altered-evidence',
        version: 999, // Forged version
        txHash: '0x9999999999999999999999999999999999999999999999999999999999999999', // Forged txHash
      }),
    });
    const res2 = await notifyPostHandler(req2);
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.messageId, 'duplicate-skipped');
    assert.equal(data2.skipped, true);
    assert.equal(data2.reason, 'Notification already delivered for this event');
    assert.equal(capturedEmails.length, 1, 'Tampered parameters must not bypass deduplication');
  });

  // =========================================================================
  // Requirement 5: Failed or unavailable authoritative verification source never sends email
  // =========================================================================
  it('Req 5: Failed or unavailable authoritative verification source fails closed with 400', async () => {
    // No submission created in subRepo
    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        event: 'work_submitted',
        dealId: DEAL_ID,
        milestone: 0,
        evidence: 'Claimed work without DB or chain record',
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes("could not be verified"));
    assert.equal(capturedEmails.length, 0, 'Zero emails dispatched on failed verification');
  });

  // =========================================================================
  // Requirement 6: SMTP authorization, OTP console suppression, and disabled workers intact
  // =========================================================================
  it('Req 6a: Staging services check confirms safe log-only mode and disabled workers by default', () => {
    const report = checkStagingServices({
      overrideEnv: {
        SYNQ_ENV: 'staging',
        SYNQ_STAGING_ALLOW_SMTP: 'false',
        SMTP_USER: '',
        SMTP_PASS: '',
      },
    });
    assert.equal(report.email.live, false);
    assert.equal(report.email.mode, 'log');
    assert.equal(report.email.isSafeLogOnly, true);
    assert.equal(report.email.stagingSmtpAllowed, false);
    assert.equal(report.backgroundWorkers.allDisabledByDefault, true);
  });

  it('Req 6b: Console OTP suppression is strictly enforced when live SMTP is authorized', () => {
    const allowed = isStagingOtpConsoleAllowed(
      {
        SYNQ_ENV: 'staging',
        NODE_ENV: 'development',
        SYNQ_STAGING_OTP_CONSOLE: 'true',
        SYNQ_STAGING_ALLOW_SMTP: 'true',
        SYNQ_APPROVED_STAGING_PROJECT_REF: APPROVED_STAGING_PROJECT_REF,
        DATABASE_URL: `postgres://user:pass@db.${APPROVED_STAGING_PROJECT_REF}.supabase.co:5432/postgres`,
      },
      false,
    );
    assert.equal(allowed, false, 'Console OTP must be prohibited when real SMTP is authorized');

    let logged = '';
    const result = logStagingOtpIfAllowed(
      '654321',
      false,
      {
        SYNQ_ENV: 'staging',
        NODE_ENV: 'development',
        SYNQ_STAGING_OTP_CONSOLE: 'true',
        SYNQ_STAGING_ALLOW_SMTP: 'true',
        SYNQ_APPROVED_STAGING_PROJECT_REF: APPROVED_STAGING_PROJECT_REF,
        DATABASE_URL: `postgres://user:pass@db.${APPROVED_STAGING_PROJECT_REF}.supabase.co:5432/postgres`,
      },
      (msg) => { logged = msg; },
    );
    assert.equal(result, false);
    assert.equal(logged, '');
  });

  it('Req 6c: Background workers latch to disabled and preflight rejects worker enablement in staging', () => {
    assert.throws(
      () => runStagingDevPreflight({
        overrideEnv: {
          SYNQ_STAGING_ALLOW_SMTP: 'true',
          SMTP_USER: 'synq-staging-test@gmail.com',
          SMTP_PASS: '16charapppasswrd',
          ENABLE_OUTBOX_PROCESSOR: 'true',
        },
      }),
      /Background workers must be disabled in staging/,
    );
  });

  // =========================================================================
  // Requirement 7: Preferences are evaluated for the recipient, not the sender
  // =========================================================================
  it('Req 7a: Notification is sent when recipient has category enabled, even if sender disabled it', async () => {
    await subRepo.create({
      chainId: 11155111,
      dealAddress: DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      freelancerWallet: WALLET_SELLER,
      specHash: '0x111',
      evidenceRootHash: '0xabc',
      manifest: { summary: 'Milestone 1 deliverable' },
      status: 'confirmed',
    });

    // Sender (seller) has Milestone Submissions DISABLED
    await prefsRepo.updatePreferences(WALLET_SELLER, {
      milestoneSubmissionsAndRevisions: false, // SENDER DISABLED
    });

    // Recipient (buyer) has Milestone Submissions ENABLED
    await prefsRepo.updatePreferences(WALLET_BUYER, {
      milestoneSubmissionsAndRevisions: true, // RECIPIENT ENABLED
    });

    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        event: 'work_submitted',
        dealId: DEAL_ID,
        milestone: 0,
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 200);
    assert.equal(capturedEmails.length, 1, 'Email must be sent because recipient has it enabled');
    assert.equal(capturedEmails[0].to, BUYER_EMAIL);
  });

  it('Req 7b: Notification is suppressed when recipient has category disabled, even if sender enabled it', async () => {
    await subRepo.create({
      chainId: 11155111,
      dealAddress: DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      freelancerWallet: WALLET_SELLER,
      specHash: '0x111',
      evidenceRootHash: '0xabc',
      manifest: { summary: 'Milestone 1 deliverable' },
      status: 'confirmed',
    });

    // Sender (seller) has Milestone Submissions ENABLED
    await prefsRepo.updatePreferences(WALLET_SELLER, {
      milestoneSubmissionsAndRevisions: true, // SENDER ENABLED
    });

    // Recipient (buyer) has Milestone Submissions DISABLED
    await prefsRepo.updatePreferences(WALLET_BUYER, {
      milestoneSubmissionsAndRevisions: false, // RECIPIENT DISABLED
    });

    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        event: 'work_submitted',
        dealId: DEAL_ID,
        milestone: 0,
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.skipped, true);
    assert.equal(capturedEmails.length, 0, 'Email must NOT be sent because recipient has it disabled');
  });
});
