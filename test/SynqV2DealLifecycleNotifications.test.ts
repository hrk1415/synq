// test/SynqV2DealLifecycleNotifications.test.ts
/**
 * SYNQ — B.12.3.64: V2 Deal Lifecycle Automatic Notifications Test Suite
 *
 * Comprehensive offline tests verifying automatic email notifications across:
 * 1. Proposal created -> proposal_received to freelancer, outbox reconciled.
 * 2. Proposal accepted -> deal_confirmed to freelancer upon verified reconciliation.
 * 3. Work submitted -> work_submitted to client upon confirmed submission reconciliation.
 * 4. Payment released -> payment_released to freelancer upon verified milestone approval.
 * 5. Final milestone completion -> deal_completed to client, deal_completed_seller to freelancer.
 * 6. Deduplication across retries and refreshes (zero duplicate emails).
 * 7. Recipient preference opt-out suppression.
 * 8. SMTP failure isolation from deal lifecycle state transitions.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';

import { NextRequest } from 'next/server';
import { POST as notifyPostHandler } from '../src/app/api/notify/route';
import { signToken } from '../src/lib/auth';

import {
  setTestTransporter,
  type MailResult,
} from '../src/lib/notify';
import {
  dispatchProposalCreatedNotification,
  dispatchProposalAcceptedNotification,
  dispatchWorkSubmittedNotification,
  dispatchPaymentReleasedNotification,
  dispatchDealCompletedNotifications,
} from '../src/lib/deals/deal-lifecycle-notifications';
import {
  InMemoryDealProposalRepository,
  setDealProposalRepository,
  resetDealProposalRepository,
  type DealProposalRow,
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
  InMemoryDealOutboxRepository,
  setDealOutboxRepository,
  resetDealOutboxRepository,
  deriveOutboxEventId,
} from '../src/lib/deals/outbox-db';
import {
  InMemoryMilestoneSubmissionRepository,
  setMilestoneSubmissionRepository,
  resetMilestoneSubmissionRepository,
} from '../src/lib/deals/submissions-db';
import * as db from '../src/lib/db';

interface CapturedEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

describe('SYNQ — B.12.3.64: V2 Deal Lifecycle Automatic Notifications', () => {
  const WALLET_BUYER = '0x1111111111111111111111111111111111111111';
  const WALLET_SELLER = '0x2222222222222222222222222222222222222222';
  const BUYER_EMAIL = 'client@example.com';
  const SELLER_EMAIL = 'freelancer@example.com';
  const PROPOSAL_ID = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const DEAL_ADDRESS = '0x3333333333333333333333333333333333333333';

  let proposalRepo: InMemoryDealProposalRepository;
  let notifRepo: InMemoryNotificationsRepository;
  let prefsRepo: InMemoryNotificationPreferencesRepository;
  let outboxRepo: InMemoryDealOutboxRepository;
  let subRepo: InMemoryMilestoneSubmissionRepository;
  let capturedEmails: CapturedEmail[];
  let sellerToken: string;
  let buyerToken: string;

  let sampleProposal: DealProposalRow;

  beforeEach(async () => {
    sellerToken = signToken({ userId: WALLET_SELLER, walletAddress: WALLET_SELLER });
    buyerToken = signToken({ userId: WALLET_BUYER, walletAddress: WALLET_BUYER });

    proposalRepo = new InMemoryDealProposalRepository();
    setDealProposalRepository(proposalRepo);

    notifRepo = new InMemoryNotificationsRepository();
    setNotificationsRepository(notifRepo);

    prefsRepo = new InMemoryNotificationPreferencesRepository();
    setNotificationPreferencesRepositoryForTest(prefsRepo);

    outboxRepo = new InMemoryDealOutboxRepository();
    setDealOutboxRepository(outboxRepo);

    subRepo = new InMemoryMilestoneSubmissionRepository();
    setMilestoneSubmissionRepository(subRepo);

    const userMap = new Map<string, any>();
    userMap.set(WALLET_BUYER.toLowerCase(), {
      id: WALLET_BUYER.toLowerCase(),
      walletAddress: WALLET_BUYER.toLowerCase(),
      name: 'Client Alice',
      email: BUYER_EMAIL,
    });
    userMap.set(WALLET_SELLER.toLowerCase(), {
      id: WALLET_SELLER.toLowerCase(),
      walletAddress: WALLET_SELLER.toLowerCase(),
      name: 'Freelancer Bob',
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

    sampleProposal = {
      proposalId: PROPOSAL_ID,
      proposalNonce: '1',
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
      title: 'Full Real Deal Cycle',
      scope: 'Milestone 1 Implementation',
      totalAmount: '1000000', // 1 USDC
      milestones: [
        {
          amount: '1000000',
          workDeadline: '1000',
          reviewWindow: '500',
          gracePeriod: '500',
          specHash: '0x111',
          title: 'Milestone 1 Deliverable',
        } as any,
      ],
      dealAddress: DEAL_ADDRESS,
      cachedStatus: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any as DealProposalRow;
  });

  afterEach(() => {
    resetDealProposalRepository();
    resetNotificationsRepository();
    resetDealOutboxRepository();
    resetMilestoneSubmissionRepository();
    db.setTestUserLookup(null);
    setTestTransporter(null);
  });

  // =========================================================================
  // 1. Proposal Created (proposal_received)
  // =========================================================================
  describe('1. Proposal Created', () => {
    it('dispatches proposal_received to freelancer and marks outbox row processed', async () => {
      // Seed outbox entry as created by proposals-db.ts
      const outboxId = deriveOutboxEventId({
        chainId: sampleProposal.chainId,
        dealId: sampleProposal.proposalId,
        event: 'proposal_received',
        recipientWallet: sampleProposal.freelancerWallet,
      });
      await outboxRepo.enqueue({
        id: outboxId,
        chainId: sampleProposal.chainId,
        dealId: sampleProposal.proposalId,
        event: 'proposal_received',
        recipientWallet: sampleProposal.freelancerWallet,
        payload: { title: sampleProposal.title, totalAmount: sampleProposal.totalAmount },
      });

      const res = await dispatchProposalCreatedNotification(sampleProposal);
      assert.equal(res.dispatched, true);
      assert.equal(capturedEmails.length, 1);
      assert.equal(capturedEmails[0].to, SELLER_EMAIL);
      assert.ok(capturedEmails[0].subject.includes('New deal proposal received'));
      assert.ok(capturedEmails[0].text.includes('1 USDC'));

      // Verify outbox entry is marked processed
      const outboxItem = await outboxRepo.get(outboxId);
      assert.equal(outboxItem?.status, 'processed', 'Outbox row must be marked processed to prevent worker duplication');
    });

    it('suppresses email when freelancer opted out of dealProposalsAndConfirmations', async () => {
      await prefsRepo.updatePreferences(WALLET_SELLER, {
        dealProposalsAndConfirmations: false,
      });

      const res = await dispatchProposalCreatedNotification(sampleProposal);
      assert.equal(res.dispatched, false);
      assert.equal(res.skipped, true);
      assert.equal(capturedEmails.length, 0);
    });

    it('deduplicates proposal created notification across repeated dispatches', async () => {
      await dispatchProposalCreatedNotification(sampleProposal);
      assert.equal(capturedEmails.length, 1);

      // Replay / retry
      const res2 = await dispatchProposalCreatedNotification(sampleProposal);
      assert.equal(res2.skipped, true);
      assert.equal(capturedEmails.length, 1, 'Exactly 1 email sent; duplicate call skipped');
    });
  });

  // =========================================================================
  // 2. Proposal Accepted / Deal Confirmed (deal_confirmed)
  // =========================================================================
  describe('2. Proposal Accepted / Deal Confirmed', () => {
    it('dispatches deal_confirmed to client/buyer and verifies freelancer receives no email', async () => {
      const acceptedProposal: DealProposalRow = {
        ...sampleProposal,
        cachedStatus: 'ACCEPTED',
        acceptedTxHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
      };

      const res = await dispatchProposalAcceptedNotification(acceptedProposal, DEAL_ADDRESS);
      assert.equal(res.dispatched, true);
      assert.equal(res.skipped, false);
      assert.equal(capturedEmails.length, 1);
      assert.equal(capturedEmails[0].to, BUYER_EMAIL, 'Email must be sent to client/buyer');
      assert.ok(
        !capturedEmails.some((e) => e.to === SELLER_EMAIL),
        'Freelancer must NOT receive an acceptance confirmation email',
      );
    });

    it('verifies correct subject, content, deal title, freelancer wallet, USDC amount, and deal link', async () => {
      const acceptedProposal: DealProposalRow = {
        ...sampleProposal,
        cachedStatus: 'ACCEPTED',
        acceptedTxHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
      };

      await dispatchProposalAcceptedNotification(acceptedProposal, DEAL_ADDRESS);
      assert.equal(capturedEmails.length, 1);
      const email = capturedEmails[0];

      // Exact subject verification
      assert.equal(email.subject, 'Your deal proposal has been accepted');

      // Heading and body verification
      assert.ok(email.text.includes('The freelancer has accepted your deal proposal. Funds are locked in escrow and the deal is now active.'));

      // Required fields verification
      assert.ok(email.text.includes('Deal: Full Real Deal Cycle'));
      assert.ok(email.text.includes(`Freelancer: ${WALLET_SELLER}`));
      assert.ok(email.text.includes('Amount: 1 USDC'));
      assert.ok(email.text.includes(`Reference: ${DEAL_ADDRESS.toLowerCase()}`));
      assert.ok(email.text.includes(`/deals/${DEAL_ADDRESS}`));
    });

    it('suppresses deal_confirmed when recipient (client) opted out of dealProposalsAndConfirmations', async () => {
      // Client opts out
      await prefsRepo.updatePreferences(WALLET_BUYER, {
        dealProposalsAndConfirmations: false,
      });

      const acceptedProposal: DealProposalRow = { ...sampleProposal, cachedStatus: 'ACCEPTED' };
      const res = await dispatchProposalAcceptedNotification(acceptedProposal, DEAL_ADDRESS);
      assert.equal(res.dispatched, false);
      assert.equal(res.skipped, true);
      assert.equal(capturedEmails.length, 0, 'No email sent when client is opted out');
    });

    it('delivers email to client even if freelancer opted out of dealProposalsAndConfirmations', async () => {
      // Freelancer opts out; client remains opted in
      await prefsRepo.updatePreferences(WALLET_SELLER, {
        dealProposalsAndConfirmations: false,
      });

      const acceptedProposal: DealProposalRow = { ...sampleProposal, cachedStatus: 'ACCEPTED' };
      const res = await dispatchProposalAcceptedNotification(acceptedProposal, DEAL_ADDRESS);
      assert.equal(res.dispatched, true);
      assert.equal(capturedEmails.length, 1);
      assert.equal(capturedEmails[0].to, BUYER_EMAIL);
    });

    it('deduplicates deal_confirmed on repeated reconciliation calls (zero duplicate emails)', async () => {
      const acceptedProposal: DealProposalRow = { ...sampleProposal, cachedStatus: 'ACCEPTED' };
      await dispatchProposalAcceptedNotification(acceptedProposal, DEAL_ADDRESS);
      assert.equal(capturedEmails.length, 1);

      // Repeated reconciliation call (e.g. page refresh or retried receipt check)
      const res2 = await dispatchProposalAcceptedNotification(acceptedProposal, DEAL_ADDRESS);
      assert.equal(res2.skipped, true);
      assert.equal(capturedEmails.length, 1, 'No duplicate email on repeated reconciliation');
    });

    it('rejects unverified deal_confirmed notification via client notification endpoint', async () => {
      // Proposal exists but is still PENDING (not ACCEPTED)
      await proposalRepo.create({
        ...sampleProposal,
        cachedStatus: 'PENDING',
        acceptedTxHash: null,
      });

      const req = new NextRequest('http://localhost:3000/api/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sellerToken}`,
        },
        body: JSON.stringify({
          event: 'deal_confirmed',
          dealId: sampleProposal.proposalId,
        }),
      });

      const res = await notifyPostHandler(req);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('could not be verified'));
      assert.equal(capturedEmails.length, 0);
    });

    it('delivers verified deal_confirmed to client via notify API when called by freelancer', async () => {
      await proposalRepo.create({
        ...sampleProposal,
        cachedStatus: 'ACCEPTED',
        acceptedTxHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
      });

      const req = new NextRequest('http://localhost:3000/api/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sellerToken}`,
        },
        body: JSON.stringify({
          event: 'deal_confirmed',
          dealId: sampleProposal.proposalId,
        }),
      });

      const res = await notifyPostHandler(req);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.deliveryStatus, 'delivered');
      assert.equal(capturedEmails.length, 1);
      assert.equal(capturedEmails[0].to, BUYER_EMAIL, 'Email delivered to client/buyer');
      assert.ok(capturedEmails[0].subject.includes('Your deal proposal has been accepted'));
      assert.ok(!capturedEmails.some((e) => e.to === SELLER_EMAIL));
    });

    it('isolates SMTP failure during proposal accepted dispatch without failing caller', async () => {
      const failingTransport = {
        sendMail: async () => {
          throw new Error('SMTP transport timeout');
        },
      };
      setTestTransporter(failingTransport as any);

      const acceptedProposal: DealProposalRow = { ...sampleProposal, cachedStatus: 'ACCEPTED' };
      const res = await dispatchProposalAcceptedNotification(acceptedProposal, DEAL_ADDRESS);
      assert.equal(res.dispatched, false);
      assert.equal(res.deliveryStatus, 'failed');
      assert.ok(res.reason?.includes('SMTP transport timeout'));
    });
  });

  // =========================================================================
  // 3. Work Submitted (work_submitted)
  // =========================================================================
  describe('3. Work Submitted', () => {
    it('dispatches work_submitted to client with milestone amount', async () => {
      const res = await dispatchWorkSubmittedNotification({
        dealAddress: DEAL_ADDRESS,
        milestoneIndex: 0,
        version: 1,
        clientWallet: WALLET_BUYER,
        dealTitle: 'Full Real Deal Cycle',
        milestoneAmount: '1000000', // 1 USDC
        evidenceSummary: 'Finished smart contract implementation',
      });

      assert.equal(res.dispatched, true);
      assert.equal(capturedEmails.length, 1);
      assert.equal(capturedEmails[0].to, BUYER_EMAIL);
      assert.ok(capturedEmails[0].subject.includes('Work submitted on your deal'));
      assert.ok(capturedEmails[0].text.includes('1 USDC'));
      assert.ok(capturedEmails[0].text.includes('Finished smart contract implementation'));
    });

    it('suppresses work_submitted when client opted out of milestoneSubmissionsAndRevisions', async () => {
      await prefsRepo.updatePreferences(WALLET_BUYER, {
        milestoneSubmissionsAndRevisions: false,
      });

      const res = await dispatchWorkSubmittedNotification({
        dealAddress: DEAL_ADDRESS,
        milestoneIndex: 0,
        version: 1,
        clientWallet: WALLET_BUYER,
        dealTitle: 'Full Real Deal Cycle',
        milestoneAmount: '1000000',
      });

      assert.equal(res.dispatched, false);
      assert.equal(res.skipped, true);
      assert.equal(capturedEmails.length, 0);
    });

    it('deduplicates work_submitted on repeated reconciliation or page refresh', async () => {
      await dispatchWorkSubmittedNotification({
        dealAddress: DEAL_ADDRESS,
        milestoneIndex: 0,
        version: 1,
        clientWallet: WALLET_BUYER,
        dealTitle: 'Full Real Deal Cycle',
        milestoneAmount: '1000000',
      });
      assert.equal(capturedEmails.length, 1);

      const res2 = await dispatchWorkSubmittedNotification({
        dealAddress: DEAL_ADDRESS,
        milestoneIndex: 0,
        version: 1,
        clientWallet: WALLET_BUYER,
        dealTitle: 'Full Real Deal Cycle',
        milestoneAmount: '1000000',
      });
      assert.equal(res2.skipped, true);
      assert.equal(capturedEmails.length, 1);
    });
  });

  // =========================================================================
  // 4. Payment Released (payment_released)
  // =========================================================================
  describe('4. Payment Released', () => {
    it('dispatches payment_released to freelancer upon verified milestone approval', async () => {
      const res = await dispatchPaymentReleasedNotification({
        dealAddress: DEAL_ADDRESS,
        milestoneIndex: 0,
        freelancerWallet: WALLET_SELLER,
        dealTitle: 'Full Real Deal Cycle',
        milestoneAmount: '1000000', // 1 USDC
      });

      assert.equal(res.dispatched, true);
      assert.equal(capturedEmails.length, 1);
      assert.equal(capturedEmails[0].to, SELLER_EMAIL);
      assert.ok(capturedEmails[0].subject.includes('Payment received'));
      assert.ok(capturedEmails[0].text.includes('1 USDC'));
    });

    it('suppresses payment_released when freelancer opted out of paymentsAndCompletions', async () => {
      await prefsRepo.updatePreferences(WALLET_SELLER, {
        paymentsAndCompletions: false,
      });

      const res = await dispatchPaymentReleasedNotification({
        dealAddress: DEAL_ADDRESS,
        milestoneIndex: 0,
        freelancerWallet: WALLET_SELLER,
        dealTitle: 'Full Real Deal Cycle',
        milestoneAmount: '1000000',
      });

      assert.equal(res.dispatched, false);
      assert.equal(res.skipped, true);
      assert.equal(capturedEmails.length, 0);
    });
  });

  // =========================================================================
  // 5. Deal Completed (deal_completed & deal_completed_seller)
  // =========================================================================
  describe('5. Deal Completed', () => {
    it('dispatches deal_completed to client and deal_completed_seller to freelancer once', async () => {
      const res = await dispatchDealCompletedNotifications({
        dealAddress: DEAL_ADDRESS,
        clientWallet: WALLET_BUYER,
        freelancerWallet: WALLET_SELLER,
        dealTitle: 'Full Real Deal Cycle',
        totalAmount: '1000000', // 1 USDC
      });

      assert.equal(res.buyer.dispatched, true);
      assert.equal(res.seller.dispatched, true);
      assert.equal(capturedEmails.length, 2);

      const buyerEmail = capturedEmails.find((e) => e.to === BUYER_EMAIL);
      const sellerEmail = capturedEmails.find((e) => e.to === SELLER_EMAIL);
      assert.ok(buyerEmail, 'Buyer must receive deal_completed');
      assert.ok(sellerEmail, 'Seller must receive deal_completed_seller');
      assert.ok(buyerEmail.subject.includes('Your deal is complete'));
      assert.ok(sellerEmail.subject.includes('Deal completed - payment received'));

      // Repeating completion call deduplicates both
      const res2 = await dispatchDealCompletedNotifications({
        dealAddress: DEAL_ADDRESS,
        clientWallet: WALLET_BUYER,
        freelancerWallet: WALLET_SELLER,
        dealTitle: 'Full Real Deal Cycle',
        totalAmount: '1000000',
      });
      assert.equal(res2.buyer.skipped, true);
      assert.equal(res2.seller.skipped, true);
      assert.equal(capturedEmails.length, 2, 'No duplicate emails sent');
    });

    it('respects independent opt-out for buyer and seller on completion', async () => {
      // Buyer opts out, seller stays opted in
      await prefsRepo.updatePreferences(WALLET_BUYER, {
        paymentsAndCompletions: false,
      });

      const res = await dispatchDealCompletedNotifications({
        dealAddress: DEAL_ADDRESS,
        clientWallet: WALLET_BUYER,
        freelancerWallet: WALLET_SELLER,
        dealTitle: 'Full Real Deal Cycle',
        totalAmount: '1000000',
      });

      assert.equal(res.buyer.skipped, true);
      assert.equal(res.seller.dispatched, true);
      assert.equal(capturedEmails.length, 1);
      assert.equal(capturedEmails[0].to, SELLER_EMAIL);
    });
  });

  // =========================================================================
  // 6. Fault Isolation: SMTP Failure Does Not Throw or Crash
  // =========================================================================
  describe('6. SMTP Failure Fault Isolation', () => {
    it('isolates SMTP transport error without throwing or failing caller', async () => {
      // Break transport
      const failingTransport = {
        sendMail: async () => {
          throw new Error('Connection refused by SMTP gateway');
        },
      };
      setTestTransporter(failingTransport as any);

      // Dispatch proposal_received must not throw
      const res = await dispatchProposalCreatedNotification(sampleProposal);
      assert.equal(res.dispatched, false);
      assert.ok(res.reason?.includes('Connection refused'));

      // Dispatch deal_confirmed must not throw
      const res2 = await dispatchProposalAcceptedNotification(sampleProposal, DEAL_ADDRESS);
      assert.equal(res2.dispatched, false);
      assert.ok(res2.reason?.includes('Connection refused'));

      // Dispatch work_submitted must not throw
      const res3 = await dispatchWorkSubmittedNotification({
        dealAddress: DEAL_ADDRESS,
        milestoneIndex: 0,
        version: 1,
        clientWallet: WALLET_BUYER,
      });
      assert.equal(res3.dispatched, false);
      assert.ok(res3.reason?.includes('Connection refused'));
    });
  });
});
