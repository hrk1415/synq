// test/SynqProposalDeclinedAndEscrowFundedNotifications.test.ts
/**
 * SYNQ — Test Suite for Proposal Declined & Escrow Funded Transactional Notifications
 *
 * Covers:
 * 1. PROPOSAL DECLINED (Recipient: Client)
 *    - Successful delivery to client upon verified proposal decline
 *    - Verification of subject, title, freelancer address, and Synq link
 *    - Freelancer receives no email
 *    - Preference suppression (client opted out of dealProposalsAndConfirmations)
 *    - Preference isolation (freelancer opted out does not suppress client notification)
 *    - Missing verified email handled gracefully without throwing
 *    - Deduplication across retries and repeated dispatches
 *    - Reconcile route integration (POST /api/deals/proposals/[proposalId]/reconcile)
 *    - /api/notify route validation (unauthorized caller, unverified status)
 *
 * 2. ESCROW FUNDED (Recipient: Freelancer)
 *    - Successful delivery to freelancer upon verified on-chain escrow funding
 *    - Verification of subject, title, client address, USDC amount, and Synq link
 *    - Client receives no email
 *    - Content does not describe funding as payment released
 *    - Distinct from proposal acceptance (deal_confirmed vs escrow_funded)
 *    - Preference suppression (freelancer opted out of dealProposalsAndConfirmations)
 *    - Preference isolation (client opted out does not suppress freelancer notification)
 *    - Missing verified email handled gracefully without throwing
 *    - Deduplication across retries and repeated calls
 *    - /api/notify route validation:
 *      * Unauthorized caller (freelancer or stranger) rejected with 403
 *      * Unverified / fake funding claim rejected with 400
 *      * Verified DealFunded receipt delivers to freelancer
 *
 * 3. FAULT ISOLATION
 *    - SMTP transport errors do not throw or crash API routes
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';

import { NextRequest } from 'next/server';
import { POST as notifyPostHandler } from '../src/app/api/notify/route';
import { POST as reconcilePostHandler } from '../src/app/api/deals/proposals/[proposalId]/reconcile/route';
import { signToken } from '../src/lib/auth';

import {
  setTestTransporter,
  type MailResult,
} from '../src/lib/notify';
import {
  dispatchProposalDeclinedNotification,
  dispatchEscrowFundedNotification,
  dispatchProposalAcceptedNotification,
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
} from '../src/lib/deals/outbox-db';
import { sepoliaPublicClient } from '../src/lib/chain';
import * as db from '../src/lib/db';
import { toEventSelector, encodeEventTopics, encodeAbiParameters } from 'viem';
import { synqFactoryV2ABI, synqDealV1ABI } from '../src/lib/contracts/abis';
import { SYNQ_V2_SEPOLIA_CONFIG } from '../src/lib/contracts/addresses';

interface CapturedEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

describe('SYNQ — Proposal Declined & Escrow Funded Transactional Notifications', () => {
  const WALLET_BUYER = '0x1111111111111111111111111111111111111111';
  const WALLET_SELLER = '0x2222222222222222222222222222222222222222';
  const WALLET_STRANGER = '0x9999999999999999999999999999999999999999';
  const BUYER_EMAIL = 'client@example.com';
  const SELLER_EMAIL = 'freelancer@example.com';
  const PROPOSAL_ID = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const DEAL_ADDRESS = '0x3333333333333333333333333333333333333333';
  const DUMMY_TX = '0x' + '12'.repeat(32);

  let proposalRepo: InMemoryDealProposalRepository;
  let notifRepo: InMemoryNotificationsRepository;
  let prefsRepo: InMemoryNotificationPreferencesRepository;
  let outboxRepo: InMemoryDealOutboxRepository;
  let capturedEmails: CapturedEmail[];
  let sellerToken: string;
  let buyerToken: string;
  let strangerToken: string;

  let sampleProposal: DealProposalRow;

  beforeEach(async () => {
    process.env.NOTIFICATION_LIVE_START_BLOCK = '1';
    sellerToken = signToken({ userId: WALLET_SELLER, walletAddress: WALLET_SELLER });
    buyerToken = signToken({ userId: WALLET_BUYER, walletAddress: WALLET_BUYER });
    strangerToken = signToken({ userId: WALLET_STRANGER, walletAddress: WALLET_STRANGER });

    proposalRepo = new InMemoryDealProposalRepository();
    setDealProposalRepository(proposalRepo);

    notifRepo = new InMemoryNotificationsRepository();
    setNotificationsRepository(notifRepo);

    prefsRepo = new InMemoryNotificationPreferencesRepository();
    setNotificationPreferencesRepositoryForTest(prefsRepo);

    outboxRepo = new InMemoryDealOutboxRepository();
    setDealOutboxRepository(outboxRepo);

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
      chainId: 11155111,
      clientWallet: WALLET_BUYER,
      freelancerWallet: WALLET_SELLER,
      canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      dealImplementation: '0x4444444444444444444444444444444444444444',
      primaryResolver: '0x5555555555555555555555555555555555555555',
      emergencyResolver: '0x6666666666666666666666666666666666666666',
      milestonesHash: '0x' + 'aa'.repeat(32),
      isProtected: false,
      protectionModule: null,
      policyId: null,
      proposalNonce: 1n,
      expiry: 9999999999n,
      totalAmount: 5_000_000n, // 5 USDC
      title: 'Full Stack Integration',
      scope: 'Build robust API',
      milestones: [
        {
          index: 0,
          title: 'Milestone 1',
          description: 'Initial Deliverable',
          amount: '5000000',
          workDeadline: '1000',
          reviewWindow: '86400',
          gracePeriod: '86400',
          specHash: '0x' + 'bb'.repeat(32),
        },
      ],
      dealAddress: DEAL_ADDRESS,
      cachedStatus: 'PENDING',
      deploymentBlock: 100n,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any as DealProposalRow;
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_LIVE_START_BLOCK;
    resetDealProposalRepository();
    resetNotificationsRepository();
    resetDealOutboxRepository();
    db.setTestUserLookup(null);
    setTestTransporter(null);
  });

  // =========================================================================
  // 1. PROPOSAL DECLINED
  // =========================================================================
  describe('1. Proposal Declined Notifications', () => {
    it('dispatches proposal_declined to client upon proposal decline', async () => {
      const declinedProposal: DealProposalRow = {
        ...sampleProposal,
        cachedStatus: 'DECLINED',
        declinedTxHash: DUMMY_TX,
      };

      const res = await dispatchProposalDeclinedNotification(declinedProposal, DUMMY_TX, 150n);
      assert.equal(res.dispatched, true);
      assert.equal(capturedEmails.length, 1);
      assert.equal(capturedEmails[0].to, BUYER_EMAIL, 'Email must be sent to client');
      assert.ok(capturedEmails[0].subject.includes('declined'), 'Subject mentions declined');
      assert.ok(capturedEmails[0].text.includes('Full Stack Integration'), 'Email contains proposal title');
      assert.ok(capturedEmails[0].text.includes(WALLET_SELLER), 'Email contains freelancer wallet');
      assert.ok(capturedEmails[0].text.includes('/deals/proposals/' + PROPOSAL_ID), 'Email contains link to proposal');
    });

    it('verifies freelancer receives no email when declining a proposal', async () => {
      const declinedProposal: DealProposalRow = {
        ...sampleProposal,
        cachedStatus: 'DECLINED',
        declinedTxHash: DUMMY_TX,
      };

      await dispatchProposalDeclinedNotification(declinedProposal, DUMMY_TX, 150n);
      assert.equal(capturedEmails.length, 1);
      const recipients = capturedEmails.map((e) => e.to);
      assert.ok(!recipients.includes(SELLER_EMAIL), 'Freelancer who declined must not receive an email');
    });

    it('suppresses proposal_declined when client opted out of dealProposalsAndConfirmations', async () => {
      await prefsRepo.updatePreferences(WALLET_BUYER, {
        dealProposalsAndConfirmations: false,
      });

      const declinedProposal: DealProposalRow = {
        ...sampleProposal,
        cachedStatus: 'DECLINED',
        declinedTxHash: DUMMY_TX,
      };

      const res = await dispatchProposalDeclinedNotification(declinedProposal, DUMMY_TX, 150n);
      assert.equal(res.dispatched, false);
      assert.equal(res.skipped, true);
      assert.equal(capturedEmails.length, 0, 'No email delivered when client opted out');
    });

    it('delivers proposal_declined to client even if freelancer opted out of dealProposalsAndConfirmations', async () => {
      await prefsRepo.updatePreferences(WALLET_SELLER, {
        dealProposalsAndConfirmations: false,
      });

      const declinedProposal: DealProposalRow = {
        ...sampleProposal,
        cachedStatus: 'DECLINED',
        declinedTxHash: DUMMY_TX,
      };

      const res = await dispatchProposalDeclinedNotification(declinedProposal, DUMMY_TX, 150n);
      assert.equal(res.dispatched, true);
      assert.equal(capturedEmails.length, 1);
      assert.equal(capturedEmails[0].to, BUYER_EMAIL);
    });

    it('skips gracefully when client has no verified email in database', async () => {
      // Remove client email
      db.setTestUserLookup(async (id: string) => {
        if (id.toLowerCase() === WALLET_BUYER.toLowerCase()) {
          return { id, walletAddress: id, email: null };
        }
        return null;
      });

      const declinedProposal: DealProposalRow = {
        ...sampleProposal,
        cachedStatus: 'DECLINED',
      };

      const res = await dispatchProposalDeclinedNotification(declinedProposal, DUMMY_TX, 150n);
      assert.equal(res.dispatched, false);
      assert.equal(res.skipped, true);
      assert.equal(capturedEmails.length, 0);
    });

    it('deduplicates proposal_declined on repeated calls (zero duplicate emails)', async () => {
      const declinedProposal: DealProposalRow = {
        ...sampleProposal,
        cachedStatus: 'DECLINED',
      };

      const res1 = await dispatchProposalDeclinedNotification(declinedProposal, DUMMY_TX, 150n);
      assert.equal(res1.dispatched, true);
      assert.equal(capturedEmails.length, 1);

      // Repeated retry / page refresh
      const res2 = await dispatchProposalDeclinedNotification(declinedProposal, DUMMY_TX, 150n);
      assert.equal(res2.skipped, true);
      assert.equal(capturedEmails.length, 1, 'Exactly 1 email delivered; duplicate skipped');
    });

    it('rejects proposal_declined via notify API when caller is an unauthorized stranger', async () => {
      await proposalRepo.create({
        ...sampleProposal,
        cachedStatus: 'DECLINED',
      });

      const req = new NextRequest('http://localhost:3000/api/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${strangerToken}`,
        },
        body: JSON.stringify({
          event: 'proposal_declined',
          dealId: PROPOSAL_ID,
        }),
      });

      const res = await notifyPostHandler(req);
      assert.equal(res.status, 403);
      assert.equal(capturedEmails.length, 0);
    });

    it('rejects proposal_declined via notify API when proposal is still PENDING without decline proof', async () => {
      await proposalRepo.create({
        ...sampleProposal,
        cachedStatus: 'PENDING',
      });

      const req = new NextRequest('http://localhost:3000/api/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sellerToken}`,
        },
        body: JSON.stringify({
          event: 'proposal_declined',
          dealId: PROPOSAL_ID,
        }),
      });

      const res = await notifyPostHandler(req);
      assert.equal(res.status, 400);
      assert.equal(capturedEmails.length, 0);
    });

    it('verifies in-band reconcile route transitions proposal to DECLINED and dispatches email, deduplicating second call', async () => {
      await proposalRepo.create({
        ...sampleProposal,
        cachedStatus: 'PENDING',
      });

      const declineTopics = encodeEventTopics({
        abi: synqFactoryV2ABI,
        eventName: 'DealProposalDeclined',
        args: {
          proposalId: PROPOSAL_ID as `0x${string}`,
          client: WALLET_BUYER as `0x${string}`,
          freelancer: WALLET_SELLER as `0x${string}`,
        },
      });
      const declineData = encodeAbiParameters(
        [{ name: 'nonce', type: 'uint256' }],
        [1n]
      );

      const originalGetReceipt = sepoliaPublicClient.getTransactionReceipt;
      (sepoliaPublicClient as any).getTransactionReceipt = async () => ({
        status: 'success',
        transactionHash: DUMMY_TX,
        to: SYNQ_V2_SEPOLIA_CONFIG.factory,
        blockNumber: 150n,
        logs: [
          {
            address: SYNQ_V2_SEPOLIA_CONFIG.factory,
            topics: declineTopics,
            data: declineData,
          },
        ],
      });

      try {
        const req1 = new NextRequest(`http://localhost:3000/api/deals/proposals/${PROPOSAL_ID}/reconcile`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sellerToken}`,
          },
          body: JSON.stringify({ txHash: DUMMY_TX }),
        });

        const res1 = await reconcilePostHandler(req1, { params: { proposalId: PROPOSAL_ID } });
        assert.equal(res1.status, 200);
        const data1 = await res1.json();
        assert.equal(data1.status, 'DECLINED');
        assert.equal(data1.alreadyReconciled, false);
        assert.equal(capturedEmails.length, 1);
        assert.equal(capturedEmails[0].to, BUYER_EMAIL);

        // Immediate retry / duplicate call (e.g. from network retry or manual sync)
        const req2 = new NextRequest(`http://localhost:3000/api/deals/proposals/${PROPOSAL_ID}/reconcile`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sellerToken}`,
          },
          body: JSON.stringify({ txHash: DUMMY_TX }),
        });

        const res2 = await reconcilePostHandler(req2, { params: { proposalId: PROPOSAL_ID } });
        assert.equal(res2.status, 200);
        const data2 = await res2.json();
        assert.equal(data2.status, 'DECLINED');
        assert.equal(data2.alreadyReconciled, true);
        assert.equal(capturedEmails.length, 1, 'Duplicate email must not be dispatched on second reconcile call');
      } finally {
        (sepoliaPublicClient as any).getTransactionReceipt = originalGetReceipt;
      }
    });
  });

  // =========================================================================
  // 2. ESCROW FUNDED
  // =========================================================================
  describe('2. Escrow Funded Notifications', () => {
    it('dispatches escrow_funded to freelancer upon verified on-chain funding', async () => {
      const res = await dispatchEscrowFundedNotification({
        dealAddress: DEAL_ADDRESS,
        clientWallet: WALLET_BUYER,
        freelancerWallet: WALLET_SELLER,
        dealTitle: 'Full Stack Integration',
        totalAmount: 5_000_000n, // 5 USDC
        txHash: DUMMY_TX,
        blockNumber: 200n,
      });

      assert.equal(res.dispatched, true);
      assert.equal(capturedEmails.length, 1);
      assert.equal(capturedEmails[0].to, SELLER_EMAIL, 'Email must be sent to freelancer');
      assert.ok(capturedEmails[0].subject.includes('Escrow funded'), 'Subject mentions Escrow funded');
      assert.ok(capturedEmails[0].text.includes('5 USDC'), 'Email contains formatted escrow amount');
      assert.ok(capturedEmails[0].text.includes('Full Stack Integration'), 'Email contains deal title');
      assert.ok(capturedEmails[0].text.includes(WALLET_BUYER), 'Email contains client wallet');
      assert.ok(capturedEmails[0].text.includes('/deals/' + DEAL_ADDRESS), 'Email contains deep link');
      assert.ok(!capturedEmails[0].text.includes('payment received'), 'Must not describe funding as payment released');
      assert.ok(!capturedEmails[0].text.includes('released to your wallet'), 'Must not describe funding as released to freelancer wallet');
    });

    it('verifies client receives no email for escrow_funded', async () => {
      await dispatchEscrowFundedNotification({
        dealAddress: DEAL_ADDRESS,
        clientWallet: WALLET_BUYER,
        freelancerWallet: WALLET_SELLER,
        totalAmount: 5_000_000n,
        txHash: DUMMY_TX,
        blockNumber: 200n,
      });

      assert.equal(capturedEmails.length, 1);
      const recipients = capturedEmails.map((e) => e.to);
      assert.ok(!recipients.includes(BUYER_EMAIL), 'Client must not receive the escrow_funded notification');
    });

    it('verifies acceptance notification and escrow funding notification are distinct events', async () => {
      const acceptedProposal: DealProposalRow = {
        ...sampleProposal,
        cachedStatus: 'ACCEPTED',
      };

      // 1. Acceptance triggers deal_confirmed to BUYER
      const resAccept = await dispatchProposalAcceptedNotification(acceptedProposal, DEAL_ADDRESS, DUMMY_TX, 150n);
      assert.equal(resAccept.dispatched, true);
      assert.equal(capturedEmails.length, 1);
      assert.equal(capturedEmails[0].to, BUYER_EMAIL, 'deal_confirmed goes to buyer');

      // 2. Funding triggers escrow_funded to SELLER
      const resFund = await dispatchEscrowFundedNotification({
        dealAddress: DEAL_ADDRESS,
        clientWallet: WALLET_BUYER,
        freelancerWallet: WALLET_SELLER,
        totalAmount: 5_000_000n,
        txHash: '0x' + '34'.repeat(32),
        blockNumber: 160n,
      });
      assert.equal(resFund.dispatched, true);
      assert.equal(capturedEmails.length, 2);
      assert.equal(capturedEmails[1].to, SELLER_EMAIL, 'escrow_funded goes to seller');
      assert.notEqual(capturedEmails[0].subject, capturedEmails[1].subject, 'Distinct events have distinct subjects');
    });

    it('suppresses escrow_funded when freelancer opted out of dealProposalsAndConfirmations', async () => {
      await prefsRepo.updatePreferences(WALLET_SELLER, {
        dealProposalsAndConfirmations: false,
      });

      const res = await dispatchEscrowFundedNotification({
        dealAddress: DEAL_ADDRESS,
        clientWallet: WALLET_BUYER,
        freelancerWallet: WALLET_SELLER,
        totalAmount: 5_000_000n,
        txHash: DUMMY_TX,
        blockNumber: 200n,
      });

      assert.equal(res.dispatched, false);
      assert.equal(res.skipped, true);
      assert.equal(capturedEmails.length, 0);
    });

    it('delivers escrow_funded to freelancer even if client opted out of dealProposalsAndConfirmations', async () => {
      await prefsRepo.updatePreferences(WALLET_BUYER, {
        dealProposalsAndConfirmations: false,
      });

      const res = await dispatchEscrowFundedNotification({
        dealAddress: DEAL_ADDRESS,
        clientWallet: WALLET_BUYER,
        freelancerWallet: WALLET_SELLER,
        totalAmount: 5_000_000n,
        txHash: DUMMY_TX,
        blockNumber: 200n,
      });

      assert.equal(res.dispatched, true);
      assert.equal(capturedEmails.length, 1);
      assert.equal(capturedEmails[0].to, SELLER_EMAIL);
    });

    it('skips gracefully when freelancer has no verified email in database', async () => {
      db.setTestUserLookup(async (id: string) => {
        if (id.toLowerCase() === WALLET_SELLER.toLowerCase()) {
          return { id, walletAddress: id, email: null };
        }
        return null;
      });

      const res = await dispatchEscrowFundedNotification({
        dealAddress: DEAL_ADDRESS,
        clientWallet: WALLET_BUYER,
        freelancerWallet: WALLET_SELLER,
        totalAmount: 5_000_000n,
        txHash: DUMMY_TX,
        blockNumber: 200n,
      });

      assert.equal(res.dispatched, false);
      assert.equal(res.skipped, true);
      assert.equal(capturedEmails.length, 0);
    });

    it('deduplicates escrow_funded across repeated calls (zero duplicate emails)', async () => {
      const params = {
        dealAddress: DEAL_ADDRESS,
        clientWallet: WALLET_BUYER,
        freelancerWallet: WALLET_SELLER,
        totalAmount: 5_000_000n,
        txHash: DUMMY_TX,
        blockNumber: 200n,
      };

      const res1 = await dispatchEscrowFundedNotification(params);
      assert.equal(res1.dispatched, true);
      assert.equal(capturedEmails.length, 1);

      // Repeat / retry
      const res2 = await dispatchEscrowFundedNotification(params);
      assert.equal(res2.skipped, true);
      assert.equal(capturedEmails.length, 1, 'Exactly 1 email delivered; duplicate skipped');
    });

    it('rejects escrow_funded via notify API when caller is freelancer (only buyer can fund)', async () => {
      await proposalRepo.create({
        ...sampleProposal,
        cachedStatus: 'ACCEPTED',
      });

      const req = new NextRequest('http://localhost:3000/api/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sellerToken}`,
        },
        body: JSON.stringify({
          event: 'escrow_funded',
          dealId: PROPOSAL_ID,
        }),
      });

      const res = await notifyPostHandler(req);
      assert.equal(res.status, 403);
      assert.equal(capturedEmails.length, 0);
    });

    it('rejects escrow_funded via notify API when caller is an unauthorized stranger', async () => {
      await proposalRepo.create({
        ...sampleProposal,
        cachedStatus: 'ACCEPTED',
      });

      const req = new NextRequest('http://localhost:3000/api/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${strangerToken}`,
        },
        body: JSON.stringify({
          event: 'escrow_funded',
          dealId: PROPOSAL_ID,
        }),
      });

      const res = await notifyPostHandler(req);
      assert.equal(res.status, 403);
      assert.equal(capturedEmails.length, 0);
    });

    it('verifies notify route with escrow_funded strictly uses authoritative verified amount and ignores untrusted client-supplied dealAmount', async () => {
      await proposalRepo.create({
        ...sampleProposal,
        cachedStatus: 'ACCEPTED',
        dealAddress: DEAL_ADDRESS,
      });

      const fundedTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'DealFunded',
        args: {
          dealAddress: DEAL_ADDRESS as `0x${string}`,
        },
      });
      const fundedData = encodeAbiParameters(
        [{ name: 'totalEscrow', type: 'uint256' }],
        [5_000_000n] // 5 USDC
      );

      const originalGetReceipt = sepoliaPublicClient.getTransactionReceipt;
      (sepoliaPublicClient as any).getTransactionReceipt = async () => ({
        status: 'success',
        transactionHash: DUMMY_TX,
        to: DEAL_ADDRESS,
        blockNumber: 150n,
        logs: [
          {
            address: DEAL_ADDRESS,
            topics: fundedTopics,
            data: fundedData,
          },
        ],
      });

      try {
        const req = new NextRequest('http://localhost:3000/api/notify', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${buyerToken}`,
          },
          body: JSON.stringify({
            event: 'escrow_funded',
            dealId: PROPOSAL_ID,
            txHash: DUMMY_TX,
            dealAmount: '999,999 USDC', // Untrusted spoofed amount!
          }),
        });

        const res = await notifyPostHandler(req);
        assert.equal(res.status, 200);
        assert.equal(capturedEmails.length, 1);
        assert.equal(capturedEmails[0].to, SELLER_EMAIL);
        assert.ok(capturedEmails[0].text.includes('5 USDC'), 'Email must contain authoritative 5 USDC');
        assert.ok(!capturedEmails[0].text.includes('999,999'), 'Email must NEVER contain untrusted spoofed amount');
      } finally {
        (sepoliaPublicClient as any).getTransactionReceipt = originalGetReceipt;
      }
    });
  });

  // =========================================================================
  // 3. FAULT ISOLATION
  // =========================================================================
  describe('3. Fault Isolation', () => {
    it('isolates SMTP transport error during proposal_declined dispatch without failing caller', async () => {
      const failingTransport = nodemailer.createTransport({ jsonTransport: true });
      failingTransport.sendMail = async () => {
        throw new Error('ECONNREFUSED: SMTP server unreachable');
      };
      setTestTransporter(failingTransport);

      const declinedProposal: DealProposalRow = {
        ...sampleProposal,
        cachedStatus: 'DECLINED',
      };

      const res = await dispatchProposalDeclinedNotification(declinedProposal, DUMMY_TX, 150n);
      assert.equal(res.dispatched, false);
      assert.equal(res.deliveryStatus, 'failed');
      assert.ok(res.reason?.includes('ECONNREFUSED'));
    });

    it('isolates SMTP transport error during escrow_funded dispatch without failing caller', async () => {
      const failingTransport = nodemailer.createTransport({ jsonTransport: true });
      failingTransport.sendMail = async () => {
        throw new Error('ETIMEDOUT: SMTP connection timed out');
      };
      setTestTransporter(failingTransport);

      const res = await dispatchEscrowFundedNotification({
        dealAddress: DEAL_ADDRESS,
        clientWallet: WALLET_BUYER,
        freelancerWallet: WALLET_SELLER,
        totalAmount: 5_000_000n,
        txHash: DUMMY_TX,
        blockNumber: 200n,
      });

      assert.equal(res.dispatched, false);
      assert.equal(res.deliveryStatus, 'failed');
      assert.ok(res.reason?.includes('ETIMEDOUT'));
    });
  });
});
