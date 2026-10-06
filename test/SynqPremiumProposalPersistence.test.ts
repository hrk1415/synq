// test/SynqPremiumProposalPersistence.test.ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex, getAddress } from 'viem';
import {
  SYNQ_V2_SEPOLIA_CONFIG,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  getStandardV2Eip712Domain,
  DEAL_PROPOSAL_EIP712_TYPES,
  hashStandardV2Milestones,
  hashDealProposalV2,
  verifyDealProposalSignature,
} from '@/lib/deals/v2';
import type { DealProposalV2, StandardV2MilestoneInit, ProtectionSelection } from '@/types/deal-v2';
import {
  parseStrictProtectionSelection,
  verifyServerProposalSubmission,
  evaluateProposalPersistence,
  serializeDealProposal,
  getDealProposalById,
  getDealProposalByDealAddress,
  InMemoryDealProposalRepository,
  ProposalValidationError,
  type SerializedDealProposal,
  setDealProposalRepository,
  createCanonicalDealProposalReceiptMessage,
} from '@/lib/deals/proposals-db';
import { validateDealProposalPayload, type SynqDealProposalPayload } from '@/lib/synq-message';
import { buildProposalStructFromSerialized } from '@/lib/deals/v2-actions';
import { POST as handlePostProposal } from '@/app/api/deals/proposals/route';
import { GET as handleGetProposal } from '@/app/api/deals/proposals/[proposalId]/route';
import { signToken } from '@/lib/auth';
import { NextRequest } from 'next/server';

// Deterministic test accounts
const clientAccount = privateKeyToAccount('0x1111111111111111111111111111111111111111111111111111111111111111');
const freelancerAccount = privateKeyToAccount('0x2222222222222222222222222222222222222222222222222222222222222222');

const DEFAULT_NOW = Math.floor(Date.now() / 1000);

async function createValidProposalFixtures(overrides: {
  nonce?: bigint;
  protectionSelection?: unknown;
} = {}) {
  const now = DEFAULT_NOW;
  const nonce = overrides.nonce ?? 0n;
  const expiry = BigInt(now + 86400 * 7);
  const amount = 2_500_000_000n; // 2500 USDC
  const workDeadline = BigInt(now + 86400 * 3);
  const reviewWindow = 259200n; // 3 days
  const gracePeriod = 86400n; // 1 day
  const specHash = keccak256(toHex('Deliver security audit report'));

  const milestones: StandardV2MilestoneInit[] = [
    {
      amount,
      workDeadline,
      reviewWindow,
      gracePeriod,
      specHash,
    },
  ];

  const milestonesHash = hashStandardV2Milestones(milestones);

  // Canonical Standard V2 proposal struct
  const proposal: DealProposalV2 = {
    client: clientAccount.address,
    freelancer: freelancerAccount.address,
    canonicalUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
    dealImplementation: SYNQ_V2_SEPOLIA_CONFIG.dealImplementation,
    primaryResolver: SYNQ_V2_SEPOLIA_CONFIG.primaryResolver,
    emergencyResolver: SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver,
    milestonesHash,
    isProtected: false,
    protectionModule: ZERO_ADDRESS,
    policyId: ZERO_BYTES32,
    proposalNonce: nonce,
    expiry,
  };

  const domain = getStandardV2Eip712Domain();
  const clientSignature = await clientAccount.signTypedData({
    domain,
    types: DEAL_PROPOSAL_EIP712_TYPES,
    primaryType: 'DealProposal',
    message: proposal,
  });

  const rawBody: Record<string, unknown> = {
    proposal: {
      client: proposal.client,
      freelancer: proposal.freelancer,
      canonicalUsdc: proposal.canonicalUsdc,
      dealImplementation: proposal.dealImplementation,
      primaryResolver: proposal.primaryResolver,
      emergencyResolver: proposal.emergencyResolver,
      milestonesHash: proposal.milestonesHash,
      isProtected: false,
      protectionModule: ZERO_ADDRESS,
      policyId: ZERO_BYTES32,
      proposalNonce: proposal.proposalNonce.toString(),
      expiry: proposal.expiry.toString(),
    },
    milestones: milestones.map((m) => ({
      amount: m.amount.toString(),
      workDeadline: m.workDeadline.toString(),
      reviewWindow: m.reviewWindow.toString(),
      gracePeriod: m.gracePeriod.toString(),
      specHash: m.specHash,
      title: 'Milestone 1',
      description: 'First milestone deliverable',
    })),
    clientSignature,
    metadata: {
      title: 'Smart Contract Audit',
      scope: 'Full comprehensive security audit of protocol v2',
    },
  };

  if (overrides.protectionSelection !== undefined) {
    rawBody.protectionSelection = overrides.protectionSelection;
  }

  return { proposal, milestones, clientSignature, rawBody };
}

describe('SYNQ PREMIUM PROTECTION V1 — PHASE 4A: PROPOSAL PERSISTENCE & FLOW INTEGRATION', () => {
  let memoryRepo: InMemoryDealProposalRepository;

  beforeEach(() => {
    memoryRepo = new InMemoryDealProposalRepository();
    setDealProposalRepository(memoryRepo);
  });

  // ---------------------------------------------------------------------------
  // A & B: STANDARD and PREMIUM intent persistence
  // ---------------------------------------------------------------------------
  describe('A & B. STANDARD and PREMIUM intent persistence', () => {
    it('persists STANDARD selection explicitly via verification pipeline', async () => {
      const { rawBody } = await createValidProposalFixtures({ protectionSelection: 'STANDARD' });
      const verified = await verifyServerProposalSubmission(rawBody, clientAccount.address, DEFAULT_NOW);

      assert.strictEqual(verified.protectionSelection, 'STANDARD');
      assert.strictEqual(verified.rowToInsert.protectionSelection, 'STANDARD');
      // Standard V2 invariant strictly preserved
      assert.strictEqual(verified.rowToInsert.isProtected, false);
      assert.strictEqual(verified.rowToInsert.protectionModule.toLowerCase(), ZERO_ADDRESS.toLowerCase());
      assert.strictEqual(verified.rowToInsert.policyId, ZERO_BYTES32);
    });

    it('persists PREMIUM intent explicitly in off-chain record without altering proposal struct', async () => {
      const { rawBody, proposal } = await createValidProposalFixtures({ protectionSelection: 'PREMIUM' });
      const verified = await verifyServerProposalSubmission(rawBody, clientAccount.address, DEFAULT_NOW);

      assert.strictEqual(verified.protectionSelection, 'PREMIUM');
      assert.strictEqual(verified.rowToInsert.protectionSelection, 'PREMIUM');

      // Canonical proposal fields remain 100% Standard V2
      assert.strictEqual(verified.proposal.isProtected, false);
      assert.strictEqual(verified.proposal.protectionModule, ZERO_ADDRESS);
      assert.strictEqual(verified.proposal.policyId, ZERO_BYTES32);
      assert.strictEqual(verified.rowToInsert.isProtected, false);
      assert.strictEqual(verified.rowToInsert.protectionModule.toLowerCase(), ZERO_ADDRESS.toLowerCase());
      assert.strictEqual(verified.rowToInsert.policyId, ZERO_BYTES32);

      // ProposalId matches canonical hash
      assert.strictEqual(verified.proposalId, hashDealProposalV2(proposal));
    });

    it('persists and retrieves PREMIUM intent via POST /api/deals/proposals and GET', async () => {
      const { rawBody } = await createValidProposalFixtures({ protectionSelection: 'PREMIUM' });
      const token = signToken({ userId: 'test-user', walletAddress: clientAccount.address });

      const postReq = new NextRequest('http://localhost:3000/api/deals/proposals', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(rawBody),
      });

      const postRes = await handlePostProposal(postReq);
      assert.strictEqual(postRes.status, 201);
      const postData = await postRes.json();
      assert.strictEqual(postData.proposal.protectionSelection, 'PREMIUM');
      assert.strictEqual(postData.proposal.isProtected, false);

      // Fetch via GET /api/deals/proposals/[proposalId]
      const getReq = new NextRequest(`http://localhost:3000/api/deals/proposals/${postData.proposal.proposalId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const getRes = await handleGetProposal(getReq, { params: { proposalId: postData.proposal.proposalId } });
      assert.strictEqual(getRes.status, 200);
      const getData = await getRes.json();
      assert.strictEqual(getData.proposal.protectionSelection, 'PREMIUM');
      assert.strictEqual(getData.proposal.isProtected, false);
    });
  });

  // ---------------------------------------------------------------------------
  // C: Invalid protection selection rejection
  // ---------------------------------------------------------------------------
  describe('C. Invalid protection selection is rejected', () => {
    it('parseStrictProtectionSelection rejects arbitrary strings', () => {
      assert.throws(
        () => parseStrictProtectionSelection('GOLD'),
        /Field 'protectionSelection' must be 'STANDARD' or 'PREMIUM'/
      );
      assert.throws(
        () => parseStrictProtectionSelection('premium'), // must be exact uppercase
        /Field 'protectionSelection' must be 'STANDARD' or 'PREMIUM'/
      );
      assert.throws(
        () => parseStrictProtectionSelection(123),
        /Field 'protectionSelection' must be a string/
      );
      assert.throws(
        () => parseStrictProtectionSelection({ type: 'PREMIUM' }),
        /Field 'protectionSelection' must be a string/
      );
    });

    it('rejects POST request with invalid protectionSelection', async () => {
      const { rawBody } = await createValidProposalFixtures({ protectionSelection: 'ULTRA_PROTECTED' });
      const token = signToken({ userId: 'test-user', walletAddress: clientAccount.address });

      const postReq = new NextRequest('http://localhost:3000/api/deals/proposals', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(rawBody),
      });

      const postRes = await handlePostProposal(postReq);
      assert.strictEqual(postRes.status, 400);
      const postData = await postRes.json();
      assert.strictEqual(postData.error.includes("Field 'protectionSelection' must be 'STANDARD' or 'PREMIUM'"), true);
    });

    it('rejects malformed protectionSelection in SynqDealProposalPayload', () => {
      const invalidPayload = {
        proposalId: '0x1234567890123456789012345678901234567890123456789012345678901234',
        clientWallet: clientAccount.address,
        freelancerWallet: freelancerAccount.address,
        title: 'Audit',
        totalAmount: '2500000000',
        milestoneCount: 1,
        expiry: '1800000000',
        protectionSelection: 'INVALID',
      };

      assert.throws(
        () => validateDealProposalPayload(invalidPayload),
        /Invalid proposal protection selection/
      );
    });
  });

  // ---------------------------------------------------------------------------
  // D: Missing legacy protection selection safe normalization
  // ---------------------------------------------------------------------------
  describe('D. Missing legacy protection selection safely behaves as STANDARD', () => {
    it('parseStrictProtectionSelection normalizes undefined, null, or empty string to STANDARD', () => {
      assert.strictEqual(parseStrictProtectionSelection(undefined), 'STANDARD');
      assert.strictEqual(parseStrictProtectionSelection(null), 'STANDARD');
      assert.strictEqual(parseStrictProtectionSelection(''), 'STANDARD');
    });

    it('omitted protectionSelection in submission defaults safely to STANDARD', async () => {
      const { rawBody } = await createValidProposalFixtures(); // protectionSelection omitted
      assert.strictEqual(rawBody.protectionSelection, undefined);

      const verified = await verifyServerProposalSubmission(rawBody, clientAccount.address, DEFAULT_NOW);
      assert.strictEqual(verified.protectionSelection, 'STANDARD');
      assert.strictEqual(verified.rowToInsert.protectionSelection, 'STANDARD');
    });

    it('legacy proposal row with undefined or empty protectionSelection serializes to STANDARD', () => {
      const legacyRow: any = {
        proposalId: '0x1234567890123456789012345678901234567890123456789012345678901234',
        proposalNonce: '1',
        chainId: 11155111,
        factoryAddress: SYNQ_V2_SEPOLIA_CONFIG.factory,
        clientWallet: clientAccount.address,
        freelancerWallet: freelancerAccount.address,
        canonicalUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
        dealImplementation: SYNQ_V2_SEPOLIA_CONFIG.dealImplementation,
        primaryResolver: SYNQ_V2_SEPOLIA_CONFIG.primaryResolver,
        emergencyResolver: SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver,
        milestonesHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        isProtected: false,
        protectionModule: ZERO_ADDRESS,
        policyId: ZERO_BYTES32,
        expiry: '1800000000',
        clientSignature: '0x' + '00'.repeat(65),
        title: 'Legacy Proposal',
        scope: 'Legacy Scope',
        totalAmount: '1000000',
        milestones: [],
        protectionSelection: undefined, // legacy row without column populated
        cachedStatus: 'PENDING',
        dealAddress: null,
        acceptedTxHash: null,
        declinedTxHash: null,
        cancelledTxHash: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const serialized = serializeDealProposal(legacyRow);
      assert.strictEqual(serialized.protectionSelection, 'STANDARD');
    });
  });

  // ---------------------------------------------------------------------------
  // E, F, G: Step 8 Unblock & Copy
  // ---------------------------------------------------------------------------
  describe('E, F, G. Step 8 Unblock and explanatory copy', () => {
    const pagePath = path.join(__dirname, '../src/app/deal/new/page.tsx');
    const pageSource = fs.readFileSync(pagePath, 'utf8');

    it('canProceed() permits case 7 when protectionSelection is PREMIUM or STANDARD', () => {
      const canProceedStep8 = (protectionSelection: string) => {
        return protectionSelection === 'STANDARD' || protectionSelection === 'PREMIUM';
      };

      assert.strictEqual(canProceedStep8('PREMIUM'), true);
      assert.strictEqual(canProceedStep8('STANDARD'), true);
      assert.strictEqual(canProceedStep8(''), false);
    });

    it('Step 8 button disabled condition does NOT include form.protectionSelection === PREMIUM', () => {
      assert.strictEqual(
        pageSource.includes("disabled={signing || !canProceed() || !!isReviewTransitioning || form.protectionSelection === 'PREMIUM'}"),
        false
      );
      assert.strictEqual(
        pageSource.includes("disabled={signing || !canProceed() || !!isReviewTransitioning}"),
        true
      );
    });

    it('handleSignAndSendProposal temporary early action guard for Premium is removed', () => {
      assert.strictEqual(
        pageSource.includes("if (form.protectionSelection === 'PREMIUM') {\n      setError(\"Premium Protection activation isn't live yet"),
        false
      );
    });

    it('Step 8 receipt renders subtle explanatory note ONLY for Premium selection', () => {
      const note = 'Premium Protection will be activated when you fund this deal after the freelancer accepts.';
      assert.strictEqual(pageSource.includes(note), true);
      assert.strictEqual(pageSource.includes("form.protectionSelection === 'PREMIUM' && ("), true);

      // Verify the note is secondary and not an error/warning card
      assert.strictEqual(pageSource.includes('text-[11px] text-zinc-400 text-center leading-relaxed px-2'), true);
    });
  });

  // ---------------------------------------------------------------------------
  // H & I: Standard V2 on-chain invariants preserved
  // ---------------------------------------------------------------------------
  describe('H & I. Standard V2 Proposal Invariants Preserved', () => {
    it('Standard V2 proposal hash and EIP-712 signature digest are identical for STANDARD and PREMIUM', async () => {
      const fixtureStandard = await createValidProposalFixtures({ protectionSelection: 'STANDARD' });
      const fixturePremium = await createValidProposalFixtures({ protectionSelection: 'PREMIUM' });

      // Both proposals produce exact same hash
      const hashStandard = hashDealProposalV2(fixtureStandard.proposal);
      const hashPremium = hashDealProposalV2(fixturePremium.proposal);
      assert.strictEqual(hashStandard, hashPremium);

      // Signatures verify against canonical Standard V2 types
      const validSigStandard = await verifyDealProposalSignature(fixtureStandard.proposal, fixtureStandard.clientSignature);
      const validSigPremium = await verifyDealProposalSignature(fixturePremium.proposal, fixturePremium.clientSignature);
      assert.strictEqual(validSigStandard, true);
      assert.strictEqual(validSigPremium, true);

      // Proposal struct fields strictly remain:
      assert.strictEqual(fixturePremium.proposal.isProtected, false);
      assert.strictEqual(fixturePremium.proposal.protectionModule, ZERO_ADDRESS);
      assert.strictEqual(fixturePremium.proposal.policyId, ZERO_BYTES32);
    });

    it('freelancer acceptance reconstruction via buildProposalStructFromSerialized produces canonical Standard V2 struct', async () => {
      const { rawBody } = await createValidProposalFixtures({ protectionSelection: 'PREMIUM' });
      const verified = await verifyServerProposalSubmission(rawBody, clientAccount.address, DEFAULT_NOW);
      const created = await memoryRepo.create(verified.rowToInsert);
      const serialized = serializeDealProposal(created);

      assert.strictEqual(serialized.protectionSelection, 'PREMIUM');

      // When the freelancer accepts on-chain, buildProposalStructFromSerialized reconstructs DealProposalV2:
      const proposalStruct = buildProposalStructFromSerialized(serialized);
      assert.strictEqual(proposalStruct.isProtected, false);
      assert.strictEqual(proposalStruct.protectionModule.toLowerCase(), ZERO_ADDRESS.toLowerCase());
      assert.strictEqual(proposalStruct.policyId, ZERO_BYTES32);

      // Hash matches original
      assert.strictEqual(hashDealProposalV2(proposalStruct), verified.proposalId);
    });
  });

  // ---------------------------------------------------------------------------
  // J: Intent survives post-acceptance and deal lookup
  // ---------------------------------------------------------------------------
  describe('J. Intent survives post-acceptance and deal lookup', () => {
    it('getDealProposalByDealAddress successfully resolves proposal and its protectionSelection', async () => {
      const { rawBody } = await createValidProposalFixtures({ protectionSelection: 'PREMIUM' });
      const verified = await verifyServerProposalSubmission(rawBody, clientAccount.address, DEFAULT_NOW);
      const created = await memoryRepo.create(verified.rowToInsert);

      // Simulate freelancer on-chain acceptance creating Deal at 0x9999...
      const deployedDealAddress = '0x9999999999999999999999999999999999999999';
      await memoryRepo.updateStatus(created.proposalId, 'ACCEPTED', {
        dealAddress: deployedDealAddress,
        txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        terminalType: 'ACCEPTED',
      });

      // Post-funding or post-acceptance query by deal address:
      const retrieved = await getDealProposalByDealAddress(deployedDealAddress);
      assert.notStrictEqual(retrieved, null);
      assert.strictEqual(retrieved!.proposalId, created.proposalId);
      assert.strictEqual(retrieved!.cachedStatus, 'ACCEPTED');
      assert.strictEqual(retrieved!.protectionSelection, 'PREMIUM');

      const serialized = serializeDealProposal(retrieved!);
      assert.strictEqual(serialized.protectionSelection, 'PREMIUM');
      assert.strictEqual(serialized.dealAddress?.toLowerCase(), deployedDealAddress.toLowerCase());
    });

    it('createCanonicalDealProposalReceiptMessage includes protectionSelection in Chat payload', async () => {
      const { rawBody } = await createValidProposalFixtures({ protectionSelection: 'PREMIUM' });
      const verified = await verifyServerProposalSubmission(rawBody, clientAccount.address, DEFAULT_NOW);
      const created = await memoryRepo.create(verified.rowToInsert);

      const { message } = await createCanonicalDealProposalReceiptMessage(created);
      assert.notStrictEqual(message, null);
      assert.strictEqual(message.payload.protectionSelection, 'PREMIUM');
    });
  });

  // ---------------------------------------------------------------------------
  // K: Idempotency with protectionSelection
  // ---------------------------------------------------------------------------
  describe('K. Idempotency evaluation with protectionSelection', () => {
    it('identical candidate with same protectionSelection evaluates to IDEMPOTENT_REPLAY', async () => {
      const { rawBody } = await createValidProposalFixtures({ protectionSelection: 'PREMIUM' });
      const verified = await verifyServerProposalSubmission(rawBody, clientAccount.address, DEFAULT_NOW);
      const created = await memoryRepo.create(verified.rowToInsert);

      const decision = evaluateProposalPersistence(verified.rowToInsert, created, null);
      assert.strictEqual(decision.action, 'IDEMPOTENT_REPLAY');
    });

    it('candidate with conflicting protectionSelection evaluates to CONFLICT_DATA', async () => {
      const { rawBody } = await createValidProposalFixtures({ protectionSelection: 'PREMIUM' });
      const verified = await verifyServerProposalSubmission(rawBody, clientAccount.address, DEFAULT_NOW);
      const created = await memoryRepo.create(verified.rowToInsert);

      // Attempt to replay with STANDARD when DB has PREMIUM
      const conflictingCandidate = {
        ...verified.rowToInsert,
        protectionSelection: 'STANDARD' as const,
      };

      const decision = evaluateProposalPersistence(conflictingCandidate, created, null);
      assert.strictEqual(decision.action, 'CONFLICT_DATA');
    });
  });
});
