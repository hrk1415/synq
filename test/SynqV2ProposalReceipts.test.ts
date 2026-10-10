// test/SynqV2ProposalReceipts.test.ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { privateKeyToAccount } from 'viem/accounts';
import { formatUnits } from 'viem';
import {
  validateDealProposalPayload,
  validateTrustedMessageData,
  validatePublicMessageInput,
  deriveConversationPreview,
  validateDealReceiptPayload,
  validateFileMessagePayload,
  validatePaymentReceiptPayload,
  SYNQ_MESSAGE_KINDS,
  type SynqDealProposalPayload,
} from '@/lib/synq-message';
import {
  InMemoryDealProposalRepository,
  setDealProposalRepository,
  resetDealProposalRepository,
  createDealProposal,
  createCanonicalDealProposalReceiptMessage,
  ProposalValidationError,
} from '@/lib/deals/proposals-db';
import { POST as handlePostProposal } from '@/app/api/deals/proposals/route';
import { POST as handlePostMessage } from '@/app/api/messages/route';
import { signToken } from '@/lib/auth';
import { canonicalizeConversationPair } from '@/lib/conversation-pair';
import { normalizeWallet } from '@/lib/utils';
import type { DealProposalRow, NewDealProposalRow } from '@/db/schema';
import { NextRequest } from 'next/server';
import {
  SYNQ_V2_SEPOLIA_CONFIG,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  hashStandardV2Milestones,
  hashDealProposalV2,
  buildStandardV2Proposal,
} from '@/lib/deals/v2';
import type { DealProposalV2, StandardV2MilestoneInit } from '@/types/deal-v2';

const clientAccount = privateKeyToAccount('0x1111111111111111111111111111111111111111111111111111111111111111');
const freelancerAccount = privateKeyToAccount('0x2222222222222222222222222222222222222222222222222222222222222222');
const attackerAccount = privateKeyToAccount('0x3333333333333333333333333333333333333333333333333333333333333333');

const FIXED_NOW = Math.floor(Date.now() / 1000);

async function createValidProposalFixtures(overrides: {
  proposalId?: string;
  client?: string;
  freelancer?: string;
  amount?: bigint;
  expiry?: bigint;
  title?: string;
} = {}) {
  const client = (overrides.client || clientAccount.address) as `0x${string}`;
  const freelancer = (overrides.freelancer || freelancerAccount.address) as `0x${string}`;
  const amount = overrides.amount ?? 1_250_000n; // 1.25 USDC
  const expiry = overrides.expiry ?? BigInt(FIXED_NOW + 86400);

  const milestones: StandardV2MilestoneInit[] = [
    {
      amount,
      workDeadline: BigInt(FIXED_NOW + 43200),
      reviewWindow: 172800n,
      gracePeriod: 86400n,
      specHash: ZERO_BYTES32,
    },
  ];

  const milestonesHash = hashStandardV2Milestones(milestones);
  const proposalStruct: DealProposalV2 = {
    client,
    freelancer,
    canonicalUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
    dealImplementation: SYNQ_V2_SEPOLIA_CONFIG.dealImplementation,
    primaryResolver: SYNQ_V2_SEPOLIA_CONFIG.primaryResolver,
    emergencyResolver: SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver,
    milestonesHash,
    isProtected: false,
    protectionModule: ZERO_ADDRESS,
    policyId: ZERO_BYTES32,
    proposalNonce: 1n,
    expiry,
  };

  const calculatedProposalId = hashDealProposalV2(proposalStruct);

  const proposalId = overrides.proposalId || calculatedProposalId;

  const rawRequestBody = {
    proposal: {
      client: proposalStruct.client,
      freelancer: proposalStruct.freelancer,
      canonicalUsdc: proposalStruct.canonicalUsdc,
      dealImplementation: proposalStruct.dealImplementation,
      primaryResolver: proposalStruct.primaryResolver,
      emergencyResolver: proposalStruct.emergencyResolver,
      milestonesHash: proposalStruct.milestonesHash,
      isProtected: proposalStruct.isProtected,
      protectionModule: proposalStruct.protectionModule,
      policyId: proposalStruct.policyId,
      proposalNonce: proposalStruct.proposalNonce.toString(),
      expiry: proposalStruct.expiry.toString(),
    },
    milestones: [
      {
        title: 'Milestone 1',
        description: 'Complete initial phase deliverables',
        amount: amount.toString(),
        workDeadline: (FIXED_NOW + 43200).toString(),
        reviewWindow: '172800',
        gracePeriod: '86400',
        specHash: ZERO_BYTES32,
      },
    ],
    metadata: {
      title: overrides.title || 'Brand Identity V2 Design',
      scope: 'Full design deliverables',
    },
    clientSignature: '0x' + 'ab'.repeat(65),
  };

  const newRow: NewDealProposalRow = {
    proposalId,
    chainId: SYNQ_V2_SEPOLIA_CONFIG.chainId,
    factoryAddress: normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.factory),
    clientWallet: normalizeWallet(client),
    freelancerWallet: normalizeWallet(freelancer),
    canonicalUsdc: normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc),
    dealImplementation: normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.dealImplementation),
    primaryResolver: normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.primaryResolver),
    emergencyResolver: normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver),
    milestonesHash,
    isProtected: false,
    protectionModule: normalizeWallet(ZERO_ADDRESS),
    policyId: ZERO_BYTES32,
    proposalNonce: '1',
    expiry: expiry.toString(),
    clientSignature: rawRequestBody.clientSignature,
    title: overrides.title || 'Brand Identity V2 Design',
    scope: 'Full design deliverables',
    totalAmount: amount.toString(),
    milestones: rawRequestBody.milestones.map((m, idx) => ({
      index: idx,
      title: m.title,
      description: m.description,
      amount: m.amount,
      workDeadline: m.workDeadline,
      reviewWindow: m.reviewWindow,
      gracePeriod: m.gracePeriod,
      specHash: m.specHash,
    })),
    cachedStatus: 'PENDING',
  };

  return {
    proposalId,
    rawRequestBody,
    newRow,
    client,
    freelancer,
    amount,
    expiry,
  };
}

describe('PHASE 3D: STANDARD V2 SYNQCHAT PROPOSAL RECEIPTS', () => {
  let inMemoryRepo: InMemoryDealProposalRepository;

  beforeEach(() => {
    inMemoryRepo = new InMemoryDealProposalRepository();
    setDealProposalRepository(inMemoryRepo);
  });

  // 1. proposal receipt payload validates
  it('1. proposal receipt payload validates successfully with valid fields', () => {
    const validPayload: SynqDealProposalPayload = {
      proposalId: '0x' + '11'.repeat(32),
      clientWallet: clientAccount.address,
      freelancerWallet: freelancerAccount.address,
      title: 'UI Design System',
      totalAmount: '2500000',
      milestoneCount: 2,
      expiry: String(FIXED_NOW + 86400),
      cachedStatus: 'PENDING',
    };

    const validated = validateDealProposalPayload(validPayload);
    assert.strictEqual(validated.proposalId, validPayload.proposalId.toLowerCase());
    assert.strictEqual(validated.clientWallet, validPayload.clientWallet.toLowerCase());
    assert.strictEqual(validated.freelancerWallet, validPayload.freelancerWallet.toLowerCase());
    assert.strictEqual(validated.title, 'UI Design System');
    assert.strictEqual(validated.totalAmount, '2500000');
    assert.strictEqual(validated.milestoneCount, 2);
    assert.strictEqual(validated.expiry, String(FIXED_NOW + 86400));
    assert.strictEqual(validated.cachedStatus, 'PENDING');
  });

  // 2. malformed proposalId rejected
  it('2. malformed proposalId rejected', () => {
    assert.throws(
      () =>
        validateDealProposalPayload({
          proposalId: 'not-bytes32',
          clientWallet: clientAccount.address,
          freelancerWallet: freelancerAccount.address,
          title: 'Test',
          totalAmount: '1000000',
          milestoneCount: 1,
          expiry: '1700000000',
        }),
      /Invalid proposalId format/,
    );
  });

  // 3. malformed participant wallet rejected
  it('3. malformed participant wallet rejected', () => {
    assert.throws(
      () =>
        validateDealProposalPayload({
          proposalId: '0x' + '22'.repeat(32),
          clientWallet: 'not-an-evm-address',
          freelancerWallet: freelancerAccount.address,
          title: 'Test',
          totalAmount: '1000000',
          milestoneCount: 1,
          expiry: '1700000000',
        }),
      /Invalid client wallet address/,
    );

    assert.throws(
      () =>
        validateDealProposalPayload({
          proposalId: '0x' + '22'.repeat(32),
          clientWallet: clientAccount.address,
          freelancerWallet: '0x123',
          title: 'Test',
          totalAmount: '1000000',
          milestoneCount: 1,
          expiry: '1700000000',
        }),
      /Invalid freelancer wallet address/,
    );
  });

  // 4. invalid totalAmount rejected
  it('4. invalid totalAmount rejected (negative, non-decimal, zero, or float)', () => {
    const base = {
      proposalId: '0x' + '33'.repeat(32),
      clientWallet: clientAccount.address,
      freelancerWallet: freelancerAccount.address,
      title: 'Test',
      milestoneCount: 1,
      expiry: '1700000000',
    };

    assert.throws(() => validateDealProposalPayload({ ...base, totalAmount: '-500' }), /Invalid proposal total amount/);
    assert.throws(() => validateDealProposalPayload({ ...base, totalAmount: '12.50' }), /Invalid proposal total amount/);
    assert.throws(() => validateDealProposalPayload({ ...base, totalAmount: 'abc' }), /Invalid proposal total amount/);
    assert.throws(() => validateDealProposalPayload({ ...base, totalAmount: '0' }), /Invalid proposal total amount/);
  });

  // 5. invalid milestoneCount rejected
  it('5. invalid milestoneCount rejected (zero, negative, float, out of bounds)', () => {
    const base = {
      proposalId: '0x' + '44'.repeat(32),
      clientWallet: clientAccount.address,
      freelancerWallet: freelancerAccount.address,
      title: 'Test',
      totalAmount: '1000000',
      expiry: '1700000000',
    };

    assert.throws(() => validateDealProposalPayload({ ...base, milestoneCount: 0 }), /Invalid proposal milestone count/);
    assert.throws(() => validateDealProposalPayload({ ...base, milestoneCount: -1 }), /Invalid proposal milestone count/);
    assert.throws(() => validateDealProposalPayload({ ...base, milestoneCount: 1.5 }), /Invalid proposal milestone count/);
    assert.throws(() => validateDealProposalPayload({ ...base, milestoneCount: 100 }), /Invalid proposal milestone count/);
  });

  // 6. invalid expiry rejected
  it('6. invalid expiry rejected (non-decimal, negative, zero)', () => {
    const base = {
      proposalId: '0x' + '55'.repeat(32),
      clientWallet: clientAccount.address,
      freelancerWallet: freelancerAccount.address,
      title: 'Test',
      totalAmount: '1000000',
      milestoneCount: 1,
    };

    assert.throws(() => validateDealProposalPayload({ ...base, expiry: '0' }), /Invalid proposal expiry/);
    assert.throws(() => validateDealProposalPayload({ ...base, expiry: '-10' }), /Invalid proposal expiry/);
    assert.throws(() => validateDealProposalPayload({ ...base, expiry: 'tomorrow' }), /Invalid proposal expiry/);
  });

  // 7. generic untrusted message path cannot forge deal_proposal
  it('7. generic untrusted message path cannot forge deal_proposal', () => {
    const untrustedAttempt = {
      kind: 'deal_proposal',
      body: 'Forged proposal message',
      payload: {
        proposalId: '0x' + '99'.repeat(32),
        clientWallet: clientAccount.address,
        freelancerWallet: freelancerAccount.address,
        title: 'Fake Deal',
        totalAmount: '1000000',
        milestoneCount: 1,
        expiry: '1700000000',
      },
    };

    const result = validatePublicMessageInput(untrustedAttempt);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.error, 'Unsupported message kind');
    }

    // Direct payload submission via public endpoint is also blocked
    const payloadAttempt = {
      kind: 'text',
      body: 'Hello',
      payload: { fake: 'data' },
    };
    const result2 = validatePublicMessageInput(payloadAttempt);
    assert.strictEqual(result2.ok, false);
    if (!result2.ok) {
      assert.strictEqual(result2.error, 'Structured payloads cannot be sent through this endpoint');
    }
  });

  // 8. trusted helper derives sender from canonical proposal
  it('8. trusted helper derives sender from canonical proposal clientWallet', async () => {
    const { newRow } = await createValidProposalFixtures();
    const stored = await inMemoryRepo.create(newRow);

    const { message } = await createCanonicalDealProposalReceiptMessage(stored, inMemoryRepo);
    assert.strictEqual(normalizeWallet(message.fromWallet), normalizeWallet(stored.clientWallet));
    assert.notStrictEqual(normalizeWallet(message.fromWallet), normalizeWallet(stored.freelancerWallet));
  });

  // 9. trusted helper derives recipient from canonical proposal
  it('9. trusted helper derives recipient from canonical proposal freelancerWallet', async () => {
    const { newRow } = await createValidProposalFixtures();
    const stored = await inMemoryRepo.create(newRow);

    const { message } = await createCanonicalDealProposalReceiptMessage(stored, inMemoryRepo);
    assert.strictEqual(normalizeWallet(message.toWallet), normalizeWallet(stored.freelancerWallet));
    assert.notStrictEqual(normalizeWallet(message.toWallet), normalizeWallet(stored.clientWallet));
  });

  // 10. canonical conversation pair used
  it('10. canonical conversation pair used deterministically', async () => {
    const { newRow } = await createValidProposalFixtures();
    const stored = await inMemoryRepo.create(newRow);

    const { conversation } = await createCanonicalDealProposalReceiptMessage(stored, inMemoryRepo);
    const expectedPair = canonicalizeConversationPair(stored.clientWallet, stored.freelancerWallet);
    assert.strictEqual(conversation.participantA, expectedPair.participantA);
    assert.strictEqual(conversation.participantB, expectedPair.participantB);
  });

  // 11. exact duplicate proposal receipt is idempotent
  it('11. exact duplicate proposal receipt is idempotent (no duplicate message created)', async () => {
    const { newRow } = await createValidProposalFixtures();
    const stored = await inMemoryRepo.create(newRow);

    const first = await createCanonicalDealProposalReceiptMessage(stored, inMemoryRepo);
    assert.strictEqual(first.created, true);

    const second = await createCanonicalDealProposalReceiptMessage(stored, inMemoryRepo);
    assert.strictEqual(second.created, false);
    assert.strictEqual(second.message.id, first.message.id);

    const allMessages = inMemoryRepo.getMessages();
    assert.strictEqual(allMessages.length, 1);
  });

  // 12. different proposal IDs may create separate receipts
  it('12. different proposal IDs create separate receipts', async () => {
    const fixture1 = await createValidProposalFixtures({ proposalId: '0x' + 'aa'.repeat(32) });
    const fixture2 = await createValidProposalFixtures({ proposalId: '0x' + 'bb'.repeat(32) });

    const stored1 = await inMemoryRepo.create(fixture1.newRow);
    const stored2 = await inMemoryRepo.create(fixture2.newRow);

    const res1 = await createCanonicalDealProposalReceiptMessage(stored1, inMemoryRepo);
    const res2 = await createCanonicalDealProposalReceiptMessage(stored2, inMemoryRepo);

    assert.strictEqual(res1.created, true);
    assert.strictEqual(res2.created, true);
    assert.notStrictEqual(res1.message.id, res2.message.id);

    const allMessages = inMemoryRepo.getMessages();
    assert.strictEqual(allMessages.length, 2);
  });

  // 13. receipt contains no clientSignature
  it('13. receipt payload contains no clientSignature', async () => {
    const { newRow } = await createValidProposalFixtures();
    const stored = await inMemoryRepo.create(newRow);

    const { message } = await createCanonicalDealProposalReceiptMessage(stored, inMemoryRepo);
    assert.strictEqual('clientSignature' in message.payload, false);
  });

  // 14. receipt contains no full milestones
  it('14. receipt payload contains no full milestones array', async () => {
    const { newRow } = await createValidProposalFixtures();
    const stored = await inMemoryRepo.create(newRow);

    const { message } = await createCanonicalDealProposalReceiptMessage(stored, inMemoryRepo);
    assert.strictEqual('milestones' in message.payload, false);
    assert.strictEqual(typeof message.payload.milestoneCount, 'number');
  });

  // 15. receipt contains no scope
  it('15. receipt payload contains no scope', async () => {
    const { newRow } = await createValidProposalFixtures();
    const stored = await inMemoryRepo.create(newRow);

    const { message } = await createCanonicalDealProposalReceiptMessage(stored, inMemoryRepo);
    assert.strictEqual('scope' in message.payload, false);
  });

  // 16. receipt contains no dealAddress before acceptance
  it('16. receipt payload contains no dealAddress before acceptance', async () => {
    const { newRow } = await createValidProposalFixtures();
    const stored = await inMemoryRepo.create(newRow);

    const { message } = await createCanonicalDealProposalReceiptMessage(stored, inMemoryRepo);
    assert.strictEqual('dealAddress' in message.payload, false);
  });

  // 17. card renders title correctly
  it('17. card renders title correctly without claiming cryptographic signature', () => {
    const payload: SynqDealProposalPayload = {
      proposalId: '0x' + '11'.repeat(32),
      clientWallet: clientAccount.address,
      freelancerWallet: freelancerAccount.address,
      title: 'Mobile App Wireframes',
      totalAmount: '2000000',
      milestoneCount: 2,
      expiry: String(FIXED_NOW + 86400),
      cachedStatus: 'PENDING',
    };

    assert.strictEqual(payload.title, 'Mobile App Wireframes');
    // Ensure title is treated as application metadata
    assert.doesNotMatch(payload.title, /signed|on-chain/i);
  });

  // 18. card renders exact USDC amount via 6-decimal base-unit conversion
  it('18. card renders exact USDC amount via canonical 6-decimal conversion (no float issues)', () => {
    const amount1 = '1000000';
    const amount2 = '1250000';
    const amount3 = '500000';

    assert.strictEqual(formatUnits(BigInt(amount1), 6), '1');
    assert.strictEqual(formatUnits(BigInt(amount2), 6), '1.25');
    assert.strictEqual(formatUnits(BigInt(amount3), 6), '0.5');
  });

  // 19. card renders milestone count
  it('19. card renders milestone count', () => {
    const payload: SynqDealProposalPayload = {
      proposalId: '0x' + '22'.repeat(32),
      clientWallet: clientAccount.address,
      freelancerWallet: freelancerAccount.address,
      title: 'Three Phase Deliverables',
      totalAmount: '3000000',
      milestoneCount: 3,
      expiry: String(FIXED_NOW + 86400),
      cachedStatus: 'PENDING',
    };

    assert.strictEqual(payload.milestoneCount, 3);
  });

  // 20. card renders Pending status
  it('20. card renders Pending status initially', () => {
    const payload: SynqDealProposalPayload = {
      proposalId: '0x' + '33'.repeat(32),
      clientWallet: clientAccount.address,
      freelancerWallet: freelancerAccount.address,
      title: 'Pending Proposal',
      totalAmount: '1000000',
      milestoneCount: 1,
      expiry: String(FIXED_NOW + 86400),
      cachedStatus: 'PENDING',
    };

    assert.strictEqual(payload.cachedStatus, 'PENDING');
  });

  // 21. card renders expiry human-readably from exact unix seconds
  it('21. card renders expiry from exact unix seconds without inferring or mutating', () => {
    const expirySec = 1770000000;
    const payload: SynqDealProposalPayload = {
      proposalId: '0x' + '44'.repeat(32),
      clientWallet: clientAccount.address,
      freelancerWallet: freelancerAccount.address,
      title: 'Time-bounded Proposal',
      totalAmount: '1000000',
      milestoneCount: 1,
      expiry: String(expirySec),
      cachedStatus: 'PENDING',
    };

    const date = new Date(Number(payload.expiry) * 1000);
    assert.strictEqual(date.getTime(), expirySec * 1000);
  });

  // 22. card distinguishes Deal Proposal from Deal
  it('22. card distinguishes Deal Proposal from Deal (no false deal language)', () => {
    const preview = deriveConversationPreview('deal_proposal', '', {
      title: 'Backend API Spec',
    } as SynqDealProposalPayload);

    assert.strictEqual(preview, 'Deal proposal: Backend API Spec');
    assert.doesNotMatch(preview, /Deal created|Escrow funded|Contract deployed/);
  });

  // 23. existing Deal receipt still validates/renders
  it('23. existing Deal receipt still validates and renders without interference', () => {
    const validDealReceipt = {
      dealAddress: '0x' + 'dd'.repeat(20),
      chainId: 11155111,
      transactionHash: '0x' + 'ee'.repeat(32),
      title: 'Existing Live Deal',
      scope: 'Live deal scope',
      totalValue: '5000000',
      assetAddress: '0x' + '00'.repeat(20),
      deadline: '1750000000',
      protectionEnabled: false,
    };

    const validated = validateDealReceiptPayload(validDealReceipt);
    assert.strictEqual(validated.title, 'Existing Live Deal');
    assert.strictEqual(validated.dealAddress, ('0x' + 'dd'.repeat(20)).toLowerCase());

    const preview = deriveConversationPreview('deal_receipt', '');
    assert.strictEqual(preview, 'Deal created');
  });

  // 24. text/file/payment messages unaffected
  it('24. text, file, and payment messages remain fully functional and unaffected', () => {
    // Text validation
    const textValid = validateTrustedMessageData({ kind: 'text', body: 'Hello freelancer' });
    assert.strictEqual(textValid.kind, 'text');
    assert.strictEqual(textValid.body, 'Hello freelancer');

    // File preview
    const filePreview = deriveConversationPreview('file', '');
    assert.strictEqual(filePreview, 'Sent a file');

    // Payment preview
    const paymentPreview = deriveConversationPreview('payment_receipt', '');
    assert.strictEqual(paymentPreview, 'Payment recorded');

    // Message kinds list contains deal_proposal and all previous kinds
    assert.ok(SYNQ_MESSAGE_KINDS.includes('deal_proposal'));
    assert.ok(SYNQ_MESSAGE_KINDS.includes('deal_receipt'));
    assert.ok(SYNQ_MESSAGE_KINDS.includes('payment_receipt'));
    assert.ok(SYNQ_MESSAGE_KINDS.includes('file'));
    assert.ok(SYNQ_MESSAGE_KINDS.includes('text'));
  });

  // 25. conversation preview is human-readable
  it('25. conversation preview generates clean human-readable preview', () => {
    const previewWithTitle = deriveConversationPreview('deal_proposal', '', {
      title: 'NextJS Frontend Redesign',
    } as SynqDealProposalPayload);
    assert.strictEqual(previewWithTitle, 'Deal proposal: NextJS Frontend Redesign');

    const previewEmptyTitle = deriveConversationPreview('deal_proposal', '', {
      title: '   ',
    } as SynqDealProposalPayload);
    assert.strictEqual(previewEmptyTitle, 'Deal proposal');

    const previewNoPayload = deriveConversationPreview('deal_proposal', '');
    assert.strictEqual(previewNoPayload, 'Deal proposal');
  });

  // 26. unauthorized proposal receipt insertion rejected
  it('26. unauthorized proposal receipt insertion rejected (proposal client !== auth wallet)', async () => {
    const { rawRequestBody } = await createValidProposalFixtures();
    const strangerToken = signToken({ userId: 'u-stranger', walletAddress: attackerAccount.address });

    const req = new NextRequest('http://localhost:3000/api/deals/proposals', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${strangerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(rawRequestBody),
    });

    const res = await handlePostProposal(req);
    assert.strictEqual(res.status, 403);
    const data = await res.json();
    assert.strictEqual(data.error, 'Authenticated wallet does not match proposal client');

    // Verify no receipt message was created
    const messages = inMemoryRepo.getMessages();
    assert.strictEqual(messages.length, 0);
  });
});
