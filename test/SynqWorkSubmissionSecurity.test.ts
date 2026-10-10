// test/SynqWorkSubmissionSecurity.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { NextRequest } from 'next/server';

import { setTestTransporter } from '../src/lib/notify';
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
import * as db from '../src/lib/db';
import { signToken } from '../src/lib/auth';

interface CapturedEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

describe('SYNQ — B.12.3.61: Secure Work Submission Notification Validation', () => {
  const WALLET_BUYER = '0x1111111111111111111111111111111111111111';
  const WALLET_SELLER = '0x2222222222222222222222222222222222222222';
  const BUYER_EMAIL = 'client@example.com';
  const SELLER_EMAIL = 'freelancer@example.com';
  const DEAL_ID = 'prop-sec-deal-001';
  const DEAL_ADDRESS = '0x3333333333333333333333333333333333333333';

  let proposalRepo: InMemoryDealProposalRepository;
  let notifRepo: InMemoryNotificationsRepository;
  let prefsRepo: InMemoryNotificationPreferencesRepository;
  let subRepo: InMemoryMilestoneSubmissionRepository;
  let capturedEmails: CapturedEmail[];
  let sellerToken: string;

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

    // Seed default accepted proposal with 2 milestones (Milestone 0: 4 USDC, Milestone 1: 6 USDC)
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
      title: 'Security Review Deal',
      scope: 'Smart Contract Audit',
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

  // -------------------------------------------------------------------------
  // 1. Accepted Deal Without Actual Work Submission
  // -------------------------------------------------------------------------
  it('1. Rejects work_submitted for accepted deal without actual work submission', async () => {
    // Proposal is ACCEPTED, but no submission exists in milestoneSubmissions table
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
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes("Claimed event 'work_submitted' could not be verified"));
    assert.equal(capturedEmails.length, 0, 'No email must be sent for unverified submission');
  });

  // -------------------------------------------------------------------------
  // 2. Arbitrary Evidence String
  // -------------------------------------------------------------------------
  it('2. Rejects work_submitted containing arbitrary evidence string without authoritative proof', async () => {
    // Seller supplies body.evidence, but there is no confirmed persisted submission
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
        evidence: 'https://attacker.example.com/fake-evidence.pdf',
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes("could not be verified"));
    assert.equal(capturedEmails.length, 0, 'No email must be sent based solely on caller evidence');
  });

  // -------------------------------------------------------------------------
  // 3. Forged Submission Version
  // -------------------------------------------------------------------------
  it('3. Ignores forged caller submission version and binds deduplication key to authoritative version', async () => {
    // Seed legitimate submission with version 1
    await subRepo.create({
      chainId: 11155111,
      dealAddress: DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      freelancerWallet: WALLET_SELLER,
      specHash: '0x111',
      evidenceRootHash: '0xabc',
      manifest: { summary: 'Milestone 1 work' },
      status: 'confirmed',
    });

    // Caller attempts to forge version 999
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
        version: 999, // FORGED
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 200);
    assert.equal(capturedEmails.length, 1);

    // Verify the canonical key stored in notifRepo uses authoritative v:1, NOT v:999
    const expectedKey = `11155111:${DEAL_ADDRESS}:work_submitted:ms:0:v:1:role:buyer`;
    const record = await notifRepo.get(expectedKey);
    assert.ok(record, `Notification record must be keyed with authoritative version (expected key: ${expectedKey})`);
    assert.equal(record?.status, 'delivered');

    // Forged key with v:999 must NOT exist
    const forgedKey = `11155111:${DEAL_ADDRESS}:work_submitted:ms:0:v:999:role:buyer`;
    const forgedRecord = await notifRepo.get(forgedKey);
    assert.equal(forgedRecord, null, 'Forged version key must not exist');
  });

  // -------------------------------------------------------------------------
  // 4. Invalid Milestone Indices
  // -------------------------------------------------------------------------
  it('4a. Rejects milestone index out of bounds', async () => {
    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        event: 'work_submitted',
        dealId: DEAL_ID,
        milestone: 5, // Deal has only 2 milestones (0 and 1)
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('out of bounds'));
    assert.equal(capturedEmails.length, 0);
  });

  it('4b. Rejects negative milestone index', async () => {
    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        event: 'work_submitted',
        dealId: DEAL_ID,
        milestone: -1,
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('must be a non-negative integer'));
    assert.equal(capturedEmails.length, 0);
  });

  it('4c. Rejects non-integer milestone index', async () => {
    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        event: 'work_submitted',
        dealId: DEAL_ID,
        milestone: 'invalid_index',
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('Invalid milestone index'));
    assert.equal(capturedEmails.length, 0);
  });

  it('4d. Rejects missing milestone on milestone-specific event', async () => {
    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        event: 'work_submitted',
        dealId: DEAL_ID,
        // milestone omitted
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('Milestone index is required'));
    assert.equal(capturedEmails.length, 0);
  });

  // -------------------------------------------------------------------------
  // 5. Legitimate Verified Submission
  // -------------------------------------------------------------------------
  it('5. Successfully processes and delivers legitimate verified work submission', async () => {
    // Seed confirmed submission for Milestone 0
    await subRepo.create({
      chainId: 11155111,
      dealAddress: DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      freelancerWallet: WALLET_SELLER,
      specHash: '0x111',
      evidenceRootHash: '0xabc',
      manifest: { summary: 'Audit Complete', links: ['ipfs://QmVerifiedManifestRoot'] },
      status: 'confirmed',
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

    assert.equal(capturedEmails.length, 1);
    const email = capturedEmails[0];
    assert.equal(email.to, BUYER_EMAIL);
    assert.ok(email.subject.includes('Work submitted'));
    assert.ok(email.text.includes('Amount: 4 USDC'), 'Displays milestone 0 amount 4 USDC');
    assert.ok(!email.text.includes('Amount: 10 USDC'), 'Does not substitute deal total');
  });

  // -------------------------------------------------------------------------
  // 6. Duplicate Notification Request
  // -------------------------------------------------------------------------
  it('6. Blocks duplicate notification request even when caller alters parameters', async () => {
    // Seed confirmed submission
    await subRepo.create({
      chainId: 11155111,
      dealAddress: DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      freelancerWallet: WALLET_SELLER,
      specHash: '0x111',
      evidenceRootHash: '0xabc',
      manifest: { summary: 'Audit Complete' },
      status: 'confirmed',
    });

    // 1st request -> successfully delivered
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

    // 2nd request -> caller attempts to re-send with forged version and note
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
        version: 2, // Caller tries to bypass deduplication by bumping version
        note: 'Please look again',
      }),
    });
    const res2 = await notifyPostHandler(req2);
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.messageId, 'duplicate-skipped');
    assert.equal(data2.skipped, true);
    assert.equal(data2.reason, 'Notification already delivered for this event');

    // Total emails sent remains strictly 1
    assert.equal(capturedEmails.length, 1, 'Duplicate request must NOT send additional email');
  });

  // -------------------------------------------------------------------------
  // 7. Missing or Unavailable Authoritative Verification Source
  // -------------------------------------------------------------------------
  it('7. Fails closed when deal existence cannot be authoritatively verified', async () => {
    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        event: 'work_submitted',
        dealId: 'non-existent-deal-id',
        milestone: 0,
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('Cannot verify deal existence or participant authorization'));
    assert.equal(capturedEmails.length, 0);
  });
});
