// test/SynqEmailAmountFormatting.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { NextRequest } from 'next/server';

import {
  formatUsdcBaseUnits,
  formatDealAmount,
  setTestTransporter,
  notifyDealConfirmedToSeller,
  notifyBuyerWorkSubmitted,
  notifyFreelancerRevisionRequested,
  notifyBuyerDealCompleted,
  notifySellerDealCompleted,
  notifyDealCancelled,
  notifySellerPaymentReleased,
  notifyBuyerOrderConfirmed,
  notifyProposalReceived,
  notifyBuyerMilestoneRefunded,
  notifyMutualSettlementProposed,
  notifyMutualSettlementExecuted,
} from '../src/lib/notify';

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
  DefaultNotificationDispatcher,
} from '../src/lib/deals/outbox-processor';
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

describe('SYNQ — B.12.3.59: USDC Amount Formatter Safety & Unit Ambiguity Review', () => {
  const WALLET_BUYER = '0x1111111111111111111111111111111111111111';
  const WALLET_SELLER = '0x2222222222222222222222222222222222222222';
  const BUYER_EMAIL = 'buyer@example.com';
  const SELLER_EMAIL = 'seller@example.com';

  let proposalRepo: InMemoryDealProposalRepository;
  let notifRepo: InMemoryNotificationsRepository;
  let prefsRepo: InMemoryNotificationPreferencesRepository;
  let subRepo: InMemoryMilestoneSubmissionRepository;
  let capturedEmails: CapturedEmail[];

  beforeEach(() => {
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
      name: 'Test Buyer',
      email: BUYER_EMAIL,
    });
    userMap.set(WALLET_SELLER.toLowerCase(), {
      id: WALLET_SELLER.toLowerCase(),
      walletAddress: WALLET_SELLER.toLowerCase(),
      name: 'Test Seller',
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
  });

  afterEach(() => {
    resetDealProposalRepository();
    resetNotificationsRepository();
    resetMilestoneSubmissionRepository();
    db.setTestUserLookup(null);
    setTestTransporter(null);
  });

  // =========================================================================
  // 1. Explicit Raw Base Units Formatter (formatUsdcBaseUnits)
  // =========================================================================
  describe('1. Explicit raw base-units formatter (formatUsdcBaseUnits)', () => {
    it('converts raw 10 USDC base units exactly once (10000000 -> 10 USDC)', () => {
      assert.equal(formatUsdcBaseUnits('10000000'), '10 USDC');
      assert.equal(formatUsdcBaseUnits(10000000n), '10 USDC');
      assert.equal(formatUsdcBaseUnits(10000000), '10 USDC');
    });

    it('converts raw 0.5 USDC base units without float loss (500000 -> 0.5 USDC)', () => {
      assert.equal(formatUsdcBaseUnits('500000'), '0.5 USDC');
      assert.equal(formatUsdcBaseUnits(500000n), '0.5 USDC');
      assert.equal(formatUsdcBaseUnits(500000), '0.5 USDC');
    });

    it('converts raw 1,000 USDC base units with comma grouping (1000000000 -> 1,000 USDC)', () => {
      assert.equal(formatUsdcBaseUnits('1000000000'), '1,000 USDC');
      assert.equal(formatUsdcBaseUnits(1000000000n), '1,000 USDC');
      assert.equal(formatUsdcBaseUnits(1000000000), '1,000 USDC');
    });

    it('converts zero base units to "0 USDC"', () => {
      assert.equal(formatUsdcBaseUnits('0'), '0 USDC');
      assert.equal(formatUsdcBaseUnits(0n), '0 USDC');
      assert.equal(formatUsdcBaseUnits(0), '0 USDC');
    });

    it('throws when negative base units are provided', () => {
      assert.throws(() => formatUsdcBaseUnits(-1n), /negative/i);
    });
  });

  // =========================================================================
  // 2. Unit Ambiguity & Display String Safety Tests (Requirement 2, 3, 4, 6)
  // =========================================================================
  describe('2. Unit ambiguity and display-string non-heuristic safety', () => {
    it('specifically tests raw "10000000", "10 USDC", "10000000 USDC", and "$10000000 USDC"', () => {
      // 1. Raw integer string is base units: converted exactly once to "10 USDC"
      assert.equal(formatDealAmount('10000000'), '10 USDC');

      // 2. Already-formatted display string "10 USDC": NEVER interpreted as base units
      assert.equal(formatDealAmount('10 USDC'), '10 USDC');

      // 3. Already-formatted display string "10000000 USDC" (10 million USDC deal):
      // Must NEVER be interpreted as base units (i.e. must NOT become "10 USDC")
      assert.equal(formatDealAmount('10000000 USDC'), '10,000,000 USDC');

      // 4. Already-formatted display string with leading dollar "$10000000 USDC":
      // Misleading $ is sanitized, but value is NEVER interpreted as base units
      assert.equal(formatDealAmount('$10000000 USDC'), '10,000,000 USDC');
    });

    it('confirms already-formatted display strings are converted exactly once and never double-converted', () => {
      const baseUnitsConverted = formatUsdcBaseUnits('10000000'); // "10 USDC"
      assert.equal(baseUnitsConverted, '10 USDC');

      // Passing the converted display string into formatDealAmount must preserve it identically
      const displayProcessed = formatDealAmount(baseUnitsConverted);
      assert.equal(displayProcessed, '10 USDC');

      // Repeated processing must remain idempotent
      assert.equal(formatDealAmount(displayProcessed), '10 USDC');
    });

    it('preserves settlement split descriptions verbatim without corruption', () => {
      assert.equal(
        formatDealAmount('3000 USDC / 2000 USDC Split'),
        '3000 USDC / 2000 USDC Split',
      );
      assert.equal(
        formatDealAmount('50/50 Split (5 USDC / 5 USDC)'),
        '50/50 Split (5 USDC / 5 USDC)',
      );
      assert.equal(
        formatDealAmount('Escrow released: 8 USDC to seller, 2 USDC refund to buyer'),
        'Escrow released: 8 USDC to seller, 2 USDC refund to buyer',
      );
    });

    it('sanitizes misleading currency prefixes on already-formatted numbers', () => {
      assert.equal(formatDealAmount('$500 USDC'), '500 USDC');
      assert.equal(formatDealAmount('$10 USDC'), '10 USDC');
      assert.equal(formatDealAmount('$1,000 USDC'), '1,000 USDC');
      assert.equal(formatDealAmount('$0.5 USDC'), '0.5 USDC');
      assert.equal(formatDealAmount('$10'), '10 USDC');
      assert.equal(formatDealAmount('$1,000'), '1,000 USDC');
    });

    it('returns empty string for empty, undefined, null, or placeholder inputs', () => {
      assert.equal(formatDealAmount(undefined), '');
      assert.equal(formatDealAmount(null), '');
      assert.equal(formatDealAmount(''), '');
      assert.equal(formatDealAmount('   '), '');
      assert.equal(formatDealAmount('—'), '');
      assert.equal(formatDealAmount('-'), '');
    });
  });

  // =========================================================================
  // 3. Email Template Rendering Regression Tests
  // =========================================================================
  describe('3. Email template rendering regression tests', () => {
    it('notifyBuyerWorkSubmitted renders "10 USDC" and never "$10000000 USDC"', async () => {
      await notifyBuyerWorkSubmitted({
        event: 'work_submitted',
        recipientWallet: WALLET_BUYER,
        dealTitle: 'Smart Contract Audit',
        dealAmount: '10000000', // raw 6-decimal base units
        dealId: 'deal-001',
      });

      assert.equal(capturedEmails.length, 1);
      const email = capturedEmails[0];
      assert.ok(email.text.includes('Amount: 10 USDC'), 'Text body must contain "Amount: 10 USDC"');
      assert.ok(email.html.includes('>10 USDC<'), 'HTML table must render ">10 USDC<"');
      assert.ok(!email.text.includes('10000000'), 'Must not contain raw base units');
      assert.ok(!email.html.includes('10000000'), 'Must not contain raw base units');
      assert.ok(!email.text.includes('$10'), 'Must not contain leading dollar sign');
      assert.ok(!email.html.includes('$10'), 'Must not contain leading dollar sign');
    });

    it('notifyBuyerWorkSubmitted renders "0.5 USDC" for fractional 500,000 base units', async () => {
      await notifyBuyerWorkSubmitted({
        event: 'work_submitted',
        recipientWallet: WALLET_BUYER,
        dealTitle: 'Bug Triage',
        dealAmount: '500000', // raw 6-decimal base units
        dealId: 'deal-002',
      });

      assert.equal(capturedEmails.length, 1);
      const email = capturedEmails[0];
      assert.ok(email.text.includes('Amount: 0.5 USDC'));
      assert.ok(email.html.includes('>0.5 USDC<'));
      assert.ok(!email.text.includes('500000'));
    });

    it('notifyBuyerWorkSubmitted renders "1,000 USDC" for 1,000,000,000 base units', async () => {
      await notifyBuyerWorkSubmitted({
        event: 'work_submitted',
        recipientWallet: WALLET_BUYER,
        dealTitle: 'Enterprise Integration',
        dealAmount: '1000000000', // raw 6-decimal base units
        dealId: 'deal-003',
      });

      assert.equal(capturedEmails.length, 1);
      const email = capturedEmails[0];
      assert.ok(email.text.includes('Amount: 1,000 USDC'));
      assert.ok(email.html.includes('>1,000 USDC<'));
      assert.ok(!email.text.includes('1000000000'));
    });

    it('Audits all other deal notification templates for consistent amount formatting', async () => {
      await notifyDealConfirmedToSeller({
        event: 'deal_confirmed',
        recipientWallet: WALLET_SELLER,
        dealTitle: 'Full App',
        dealAmount: '10000000',
        dealId: 'deal-t1',
      });
      await notifyFreelancerRevisionRequested({
        event: 'revision_requested',
        recipientWallet: WALLET_SELLER,
        dealTitle: 'Full App',
        dealAmount: '10000000',
        dealId: 'deal-t2',
      });
      await notifyBuyerDealCompleted({
        event: 'deal_completed',
        recipientWallet: WALLET_BUYER,
        dealTitle: 'Full App',
        dealAmount: '10000000',
        dealId: 'deal-t3',
      });
      await notifySellerDealCompleted({
        event: 'deal_completed_seller',
        recipientWallet: WALLET_SELLER,
        dealTitle: 'Full App',
        dealAmount: '10000000',
        dealId: 'deal-t4',
      });
      await notifyDealCancelled({
        event: 'deal_cancelled',
        recipientWallet: WALLET_SELLER,
        dealTitle: 'Full App',
        dealAmount: '10000000',
        dealId: 'deal-t5',
      });
      await notifySellerPaymentReleased({
        event: 'payment_released',
        recipientWallet: WALLET_SELLER,
        dealTitle: 'Full App',
        dealAmount: '10000000',
        dealId: 'deal-t6',
      });
      await notifyBuyerOrderConfirmed({
        event: 'order_confirmed',
        recipientWallet: WALLET_BUYER,
        dealTitle: 'Design Brief',
        dealAmount: '10000000',
        dealId: 'deal-t7',
      });
      await notifyProposalReceived({
        event: 'proposal_received',
        recipientWallet: WALLET_SELLER,
        dealTitle: 'Proposal Title',
        dealAmount: '10000000',
        dealId: 'deal-t8',
      });
      await notifyBuyerMilestoneRefunded({
        event: 'milestone_refunded',
        recipientWallet: WALLET_BUYER,
        dealTitle: 'Refunded Milestone',
        dealAmount: '10000000',
        dealId: 'deal-t9',
      });
      await notifyMutualSettlementProposed({
        event: 'mutual_settlement_proposed',
        recipientWallet: WALLET_SELLER,
        dealTitle: 'Settlement',
        dealAmount: '10000000',
        dealId: 'deal-t10',
      });
      await notifyMutualSettlementExecuted({
        event: 'mutual_settlement_executed',
        recipientWallet: WALLET_BUYER,
        dealTitle: 'Settlement Done',
        dealAmount: '10000000',
        dealId: 'deal-t11',
      });

      assert.equal(capturedEmails.length, 11);
      for (const email of capturedEmails) {
        assert.ok(
          email.text.includes('10 USDC'),
          `Email "${email.subject}" text must contain "10 USDC"`,
        );
        assert.ok(
          !email.text.includes('$10000000'),
          `Email "${email.subject}" text must not contain "$10000000"`,
        );
        assert.ok(
          !email.html.includes('$10000000'),
          `Email "${email.subject}" HTML must not contain "$10000000"`,
        );
      }
    });
  });

  // =========================================================================
  // 4. Milestone vs Total Deal Amount Separation (Requirement 7)
  // =========================================================================
  describe('4. Milestone notifications display milestone amount, not total deal amount (Requirement 7)', () => {
    async function seedMultiMilestoneProposal() {
      // Total deal: 10 USDC (10,000,000 base units)
      // Milestone 0: 3 USDC (3,000,000 base units)
      // Milestone 1: 7 USDC (7,000,000 base units)
      const created = await proposalRepo.create({
        proposalId: 'prop-multi-ms',
        proposalNonce: '99',
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
        title: 'Multi-Milestone Project',
        scope: 'Design & Code',
        totalAmount: '10000000', // 10 USDC total
        milestones: [
          {
            amount: '3000000', // 3 USDC for Milestone 1
            workDeadline: '1000',
            reviewWindow: '500',
            gracePeriod: '500',
            specHash: '0x123',
            title: 'Milestone 1 - Design',
            description: 'Figma mockups',
          } as any,
          {
            amount: '7000000', // 7 USDC for Milestone 2
            workDeadline: '2000',
            reviewWindow: '500',
            gracePeriod: '500',
            specHash: '0x456',
            title: 'Milestone 2 - Code',
            description: 'Next.js frontend',
          } as any,
        ],
        dealAddress: '0x4444444444444444444444444444444444444444',
        cachedStatus: 'ACCEPTED',
      });

      await subRepo.create({
        chainId: 11155111,
        dealAddress: '0x4444444444444444444444444444444444444444',
        milestoneId: 0,
        version: 1,
        freelancerWallet: WALLET_SELLER,
        specHash: '0x123',
        evidenceRootHash: '0xabc',
        manifest: { summary: 'Design done', links: ['ipfs://QmSampleDesignEvidence1'] },
        status: 'confirmed',
      });

      await subRepo.create({
        chainId: 11155111,
        dealAddress: '0x4444444444444444444444444444444444444444',
        milestoneId: 1,
        version: 1,
        freelancerWallet: WALLET_SELLER,
        specHash: '0x456',
        evidenceRootHash: '0xdef',
        manifest: { summary: 'Code done', links: ['ipfs://QmSampleCodeEvidence2'] },
        status: 'confirmed',
      });
      return created;
    }

    it('work_submitted for Milestone 0 displays "3 USDC" (milestone amount), NOT "10 USDC" (total deal amount)', async () => {
      await seedMultiMilestoneProposal();
      const sellerToken = signToken({ userId: WALLET_SELLER, walletAddress: WALLET_SELLER });

      const req = new NextRequest('http://localhost:3000/api/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sellerToken}`,
        },
        body: JSON.stringify({
          event: 'work_submitted',
          dealId: 'prop-multi-ms',
          milestone: 0,
          evidence: 'ipfs://QmSampleDesignEvidence1',
        }),
      });

      const res = await notifyPostHandler(req);
      assert.equal(res.status, 200);

      assert.equal(capturedEmails.length, 1);
      const email = capturedEmails[0];
      assert.ok(email.text.includes('Amount: 3 USDC'), 'Milestone 0 submission must display "3 USDC"');
      assert.ok(!email.text.includes('Amount: 10 USDC'), 'Milestone 0 submission must NOT substitute total deal amount "10 USDC"');
    });

    it('work_submitted for Milestone 1 displays "7 USDC" (milestone amount), NOT "10 USDC"', async () => {
      await seedMultiMilestoneProposal();
      const sellerToken = signToken({ userId: WALLET_SELLER, walletAddress: WALLET_SELLER });

      const req = new NextRequest('http://localhost:3000/api/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sellerToken}`,
        },
        body: JSON.stringify({
          event: 'work_submitted',
          dealId: 'prop-multi-ms',
          milestone: 1,
          evidence: 'ipfs://QmSampleCodeEvidence2',
        }),
      });

      const res = await notifyPostHandler(req);
      assert.equal(res.status, 200);

      assert.equal(capturedEmails.length, 1);
      const email = capturedEmails[0];
      assert.ok(email.text.includes('Amount: 7 USDC'), 'Milestone 1 submission must display "7 USDC"');
      assert.ok(!email.text.includes('Amount: 10 USDC'), 'Milestone 1 submission must NOT substitute total deal amount "10 USDC"');
    });

    it('deal-level event deal_confirmed displays total deal amount "10 USDC" even if milestone parameter is passed', async () => {
      await seedMultiMilestoneProposal();
      const buyerToken = signToken({ userId: WALLET_BUYER, walletAddress: WALLET_BUYER });

      const req = new NextRequest('http://localhost:3000/api/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${buyerToken}`,
        },
        body: JSON.stringify({
          event: 'deal_confirmed',
          dealId: 'prop-multi-ms',
          milestone: 0, // Ignored for deal-level confirmation
        }),
      });

      const res = await notifyPostHandler(req);
      assert.equal(res.status, 200);

      assert.equal(capturedEmails.length, 1);
      const email = capturedEmails[0];
      assert.ok(email.text.includes('Amount: 10 USDC'), 'Deal confirmation must display total deal amount "10 USDC"');
      assert.ok(!email.text.includes('Amount: 3 USDC'), 'Deal confirmation must NOT substitute milestone amount');
    });
  });

  // =========================================================================
  // 5. Outbox Dispatcher Regression Tests
  // =========================================================================
  describe('5. Outbox dispatcher amount formatting', () => {
    it('dispatches proposal_received with formatted 10 USDC total amount', async () => {
      const dispatcher = new DefaultNotificationDispatcher();
      await dispatcher.dispatch('proposal_received', {
        dealId: 'deal-outbox-1',
        dealTitle: 'Proposal 10 USDC',
        dealAmount: formatDealAmount('10000000'),
        recipientWallet: WALLET_SELLER,
      });

      assert.equal(capturedEmails.length, 1);
      const email = capturedEmails[0];
      assert.ok(email.text.includes('Amount: 10 USDC'));
      assert.ok(!email.text.includes('10000000'));
    });

    it('dispatches work_submitted with formatted 1,000 USDC milestone amount', async () => {
      const dispatcher = new DefaultNotificationDispatcher();
      await dispatcher.dispatch('work_submitted', {
        dealId: 'deal-outbox-2',
        dealTitle: 'Proposal 1000 USDC',
        dealAmount: formatDealAmount('1000000000'),
        recipientWallet: WALLET_BUYER,
      });

      assert.equal(capturedEmails.length, 1);
      const email = capturedEmails[0];
      assert.ok(email.text.includes('Amount: 1,000 USDC'));
      assert.ok(!email.text.includes('1000000000'));
    });
  });
});
