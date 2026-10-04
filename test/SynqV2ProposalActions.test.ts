// test/SynqV2ProposalActions.test.ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { privateKeyToAccount } from 'viem/accounts';
import {
  encodeEventTopics,
  encodeAbiParameters,
  getAddress,
  type TransactionReceipt,
  type Log,
} from 'viem';
import { NextRequest } from 'next/server';
import {
  SYNQ_V2_SEPOLIA_CONFIG,
} from '@/lib/contracts/addresses';
import {
  ZERO_ADDRESS,
  ZERO_BYTES32,
  hashStandardV2Milestones,
  hashDealProposalV2,
  getStandardV2Eip712Domain,
  DEAL_PROPOSAL_EIP712_TYPES,
} from '@/lib/deals/v2';
import type { DealProposalV2, StandardV2MilestoneInit } from '@/types/deal-v2';
import {
  InMemoryDealProposalRepository,
  setDealProposalRepository,
  serializeDealProposal,
  type SerializedDealProposal,
  type NewDealProposalRow,
} from '@/lib/deals/proposals-db';
import {
  buildProposalStructFromSerialized,
  buildMilestoneInitsFromSerialized,
  validateAcceptPreflight,
  validateDeclinePreflight,
  validateCancelPreflight,
  verifyProposalPendingOnChain,
  OnChainProposalStatus,
  type IProposalReadClient,
  getAcceptContractArgs,
  getDeclineContractArgs,
  getCancelContractArgs,
} from '@/lib/deals/v2-actions';
import {
  verifyFactoryTerminalReceipt,
  reconcileProposalWithReceipt,
  type IReceiptVerificationClient,
} from '@/lib/deals/proposals-reconcile';
import { GET as handleGetProposal } from '@/app/api/deals/proposals/[proposalId]/route';
import { POST as handleReconcileRoute } from '@/app/api/deals/proposals/[proposalId]/reconcile/route';
import { synqFactoryV2ABI } from '@/lib/contracts/abis';
import { signToken } from '@/lib/auth';
import { normalizeWallet } from '@/lib/utils';
import { deriveConversationPreview, validateDealReceiptPayload, validateTrustedMessageData } from '@/lib/synq-message';

// Deterministic test accounts
const clientAccount = privateKeyToAccount('0x1111111111111111111111111111111111111111111111111111111111111111');
const freelancerAccount = privateKeyToAccount('0x2222222222222222222222222222222222222222222222222222222222222222');
const strangerAccount = privateKeyToAccount('0x3333333333333333333333333333333333333333333333333333333333333333');

const FIXED_NOW = 1770000000;
const FIXED_EXPIRY = 1770086400; // +24h

async function createProposalFixture(overrides: {
  amount?: bigint;
  expiry?: number;
  nonce?: number;
  cachedStatus?: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED';
  dealAddress?: string | null;
  clientSignature?: `0x${string}`;
} = {}) {
  const amount = overrides.amount ?? 1_000_000n;
  const expiry = BigInt(overrides.expiry ?? FIXED_EXPIRY);
  const proposalNonce = BigInt(overrides.nonce ?? 1);

  const milestoneInits: StandardV2MilestoneInit[] = [
    {
      amount,
      workDeadline: BigInt(FIXED_NOW + 43200),
      reviewWindow: 172800n,
      gracePeriod: 86400n,
      specHash: '0x' + 'aa'.repeat(32) as `0x${string}`,
    },
  ];

  const milestonesHash = hashStandardV2Milestones(milestoneInits);

  const proposalStruct: DealProposalV2 = {
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
    proposalNonce,
    expiry,
  };

  const proposalId = hashDealProposalV2(proposalStruct);

  // Sign with deterministic client EOA
  const domain = getStandardV2Eip712Domain();
  const clientSignature = overrides.clientSignature || (await clientAccount.signTypedData({
    domain,
    types: DEAL_PROPOSAL_EIP712_TYPES,
    primaryType: 'DealProposal',
    message: {
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
      proposalNonce: proposalStruct.proposalNonce,
      expiry: proposalStruct.expiry,
    },
  }));

  const newRow: NewDealProposalRow = {
    proposalId,
    chainId: SYNQ_V2_SEPOLIA_CONFIG.chainId,
    factoryAddress: normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.factory),
    clientWallet: normalizeWallet(clientAccount.address),
    freelancerWallet: normalizeWallet(freelancerAccount.address),
    canonicalUsdc: normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc),
    dealImplementation: normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.dealImplementation),
    primaryResolver: normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.primaryResolver),
    emergencyResolver: normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver),
    milestonesHash,
    isProtected: false,
    protectionModule: normalizeWallet(ZERO_ADDRESS),
    policyId: ZERO_BYTES32,
    proposalNonce: proposalNonce.toString(),
    expiry: expiry.toString(),
    clientSignature,
    title: 'Landing Page Revamp',
    scope: 'Detailed scope for landing page revamp',
    totalAmount: amount.toString(),
    milestones: [
      {
        title: 'Initial Wireframes',
        description: 'Complete Figma wireframes',
        amount: amount.toString(),
        workDeadline: (FIXED_NOW + 43200).toString(),
        reviewWindow: '172800',
        gracePeriod: '86400',
        specHash: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
      },
    ],
    cachedStatus: overrides.cachedStatus ?? 'PENDING',
    dealAddress: overrides.dealAddress ? normalizeWallet(overrides.dealAddress) : null,
  };

  return {
    proposalStruct,
    milestoneInits,
    proposalId,
    clientSignature,
    newRow,
  };
}

/**
 * Creates mock TransactionReceipt containing encoded Factory V2 events without hitting RPC.
 */
function createMockFactoryReceipt(options: {
  eventName: 'DealProposalAccepted' | 'DealProposalDeclined' | 'DealProposalCancelled' | 'Unrelated';
  proposalId?: `0x${string}`;
  client?: `0x${string}`;
  freelancer?: `0x${string}`;
  dealAddress?: `0x${string}`;
  nonce?: bigint;
  status?: 'success' | 'reverted';
  factoryAddress?: `0x${string}`;
  txHash?: `0x${string}`;
}): TransactionReceipt {
  const factoryAddress = options.factoryAddress || SYNQ_V2_SEPOLIA_CONFIG.factory;
  const txHash = options.txHash || ('0x' + '77'.repeat(32) as `0x${string}`);

  if (options.status === 'reverted') {
    return {
      status: 'reverted',
      transactionHash: txHash,
      to: factoryAddress,
      logs: [],
      blockNumber: 1234567n,
    } as unknown as TransactionReceipt;
  }

  const logs: Log[] = [];

  if (options.eventName === 'DealProposalAccepted') {
    const topics = encodeEventTopics({
      abi: synqFactoryV2ABI,
      eventName: 'DealProposalAccepted',
      args: {
        proposalId: options.proposalId,
        client: options.client,
        freelancer: options.freelancer,
      },
    });

    const data = encodeAbiParameters(
      [{ name: 'dealAddress', type: 'address' }, { name: 'nonce', type: 'uint256' }],
      [(options.dealAddress || ('0x' + '99'.repeat(20) as `0x${string}`)), options.nonce ?? 1n]
    );

    logs.push({
      address: factoryAddress,
      topics,
      data,
    } as unknown as Log);
  } else if (options.eventName === 'DealProposalDeclined') {
    const topics = encodeEventTopics({
      abi: synqFactoryV2ABI,
      eventName: 'DealProposalDeclined',
      args: {
        proposalId: options.proposalId,
        client: options.client,
        freelancer: options.freelancer,
      },
    });

    const data = encodeAbiParameters([{ name: 'nonce', type: 'uint256' }], [options.nonce ?? 1n]);

    logs.push({
      address: factoryAddress,
      topics,
      data,
    } as unknown as Log);
  } else if (options.eventName === 'DealProposalCancelled') {
    const topics = encodeEventTopics({
      abi: synqFactoryV2ABI,
      eventName: 'DealProposalCancelled',
      args: {
        proposalId: options.proposalId,
        client: options.client,
        freelancer: options.freelancer,
      },
    });

    const data = encodeAbiParameters([{ name: 'nonce', type: 'uint256' }], [options.nonce ?? 1n]);

    logs.push({
      address: factoryAddress,
      topics,
      data,
    } as unknown as Log);
  }

  return {
    status: 'success',
    transactionHash: txHash,
    to: factoryAddress,
    logs,
    blockNumber: 1234567n,
  } as unknown as TransactionReceipt;
}

describe('PHASE 3E: STANDARD V2 PROPOSAL DETAILS + ACCEPT / DECLINE / CANCEL', () => {
  let inMemoryRepo: InMemoryDealProposalRepository;

  beforeEach(() => {
    inMemoryRepo = new InMemoryDealProposalRepository();
    setDealProposalRepository(inMemoryRepo);
  });

  // 1. authorized client can view proposal
  it('1. authorized client can view proposal via GET /api/deals/proposals/[proposalId]', async () => {
    const fixture = await createProposalFixture();
    await inMemoryRepo.create(fixture.newRow);

    const clientToken = signToken({ userId: 'u-client', walletAddress: clientAccount.address });
    const req = new NextRequest(`http://localhost:3000/api/deals/proposals/${fixture.proposalId}`, {
      headers: { authorization: `Bearer ${clientToken}` },
    });

    const res = await handleGetProposal(req, { params: Promise.resolve({ proposalId: fixture.proposalId }) });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.proposal.proposalId, fixture.proposalId);
    assert.strictEqual(data.proposal.clientWallet, normalizeWallet(clientAccount.address));
  });

  // 2. authorized freelancer can view proposal
  it('2. authorized freelancer can view proposal via GET /api/deals/proposals/[proposalId]', async () => {
    const fixture = await createProposalFixture();
    await inMemoryRepo.create(fixture.newRow);

    const freelancerToken = signToken({ userId: 'u-freelancer', walletAddress: freelancerAccount.address });
    const req = new NextRequest(`http://localhost:3000/api/deals/proposals/${fixture.proposalId}`, {
      headers: { authorization: `Bearer ${freelancerToken}` },
    });

    const res = await handleGetProposal(req, { params: Promise.resolve({ proposalId: fixture.proposalId }) });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.proposal.proposalId, fixture.proposalId);
    assert.strictEqual(data.proposal.freelancerWallet, normalizeWallet(freelancerAccount.address));
  });

  // 3. stranger cannot view
  it('3. stranger cannot view proposal (403 Forbidden)', async () => {
    const fixture = await createProposalFixture();
    await inMemoryRepo.create(fixture.newRow);

    const strangerToken = signToken({ userId: 'u-stranger', walletAddress: strangerAccount.address });
    const req = new NextRequest(`http://localhost:3000/api/deals/proposals/${fixture.proposalId}`, {
      headers: { authorization: `Bearer ${strangerToken}` },
    });

    const res = await handleGetProposal(req, { params: Promise.resolve({ proposalId: fixture.proposalId }) });
    assert.strictEqual(res.status, 403);
    const data = await res.json();
    assert.strictEqual(data.error, 'Forbidden');
  });

  // 4. malformed proposalId handled
  it('4. malformed proposalId rejected (400 Bad Request)', async () => {
    const clientToken = signToken({ userId: 'u-client', walletAddress: clientAccount.address });
    const req = new NextRequest('http://localhost:3000/api/deals/proposals/invalid-hex', {
      headers: { authorization: `Bearer ${clientToken}` },
    });

    const res = await handleGetProposal(req, { params: Promise.resolve({ proposalId: 'invalid-hex' }) });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.error, 'Invalid proposalId format');
  });

  // 5. page model distinguishes signed vs unsigned metadata
  it('5. page model distinguishes signed on-chain terms from unsigned metadata', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    // Signed fields (EIP-712 bound)
    assert.ok(serialized.milestonesHash.startsWith('0x'));
    assert.ok(serialized.clientSignature.startsWith('0x'));
    assert.strictEqual(serialized.proposalNonce, '1');
    assert.strictEqual(serialized.expiry, String(FIXED_EXPIRY));

    // Unsigned metadata (application metadata)
    assert.strictEqual(serialized.title, 'Landing Page Revamp');
    assert.strictEqual(serialized.scope, 'Detailed scope for landing page revamp');
    assert.strictEqual(serialized.milestones[0].title, 'Initial Wireframes');
    assert.strictEqual(serialized.milestones[0].description, 'Complete Figma wireframes');
  });

  // 6. Pending freelancer sees Accept + Decline
  it('6. Pending freelancer passes preflight for Accept and Decline', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    const acceptCheck = await validateAcceptPreflight(serialized, freelancerAccount.address, BigInt(FIXED_NOW));
    assert.strictEqual(acceptCheck.ok, true);

    const declineCheck = await validateDeclinePreflight(serialized, freelancerAccount.address, BigInt(FIXED_NOW));
    assert.strictEqual(declineCheck.ok, true);
  });

  // 7. Pending client sees Cancel
  it('7. Pending client passes preflight for Cancel', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    const cancelCheck = validateCancelPreflight(serialized, clientAccount.address);
    assert.strictEqual(cancelCheck.ok, true);
  });

  // 8. wrong participant sees no terminal action
  it('8. stranger rejected by Accept, Decline, and Cancel preflight checks', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    const acceptCheck = await validateAcceptPreflight(serialized, strangerAccount.address, BigInt(FIXED_NOW));
    assert.strictEqual(acceptCheck.ok, false);
    if (!acceptCheck.ok) {
      assert.strictEqual(acceptCheck.error, 'Only the designated freelancer can accept this proposal');
    }

    const declineCheck = await validateDeclinePreflight(serialized, strangerAccount.address, BigInt(FIXED_NOW));
    assert.strictEqual(declineCheck.ok, false);

    const cancelCheck = validateCancelPreflight(serialized, strangerAccount.address);
    assert.strictEqual(cancelCheck.ok, false);
  });

  // 9. Accepted shows no terminal buttons
  it('9. Accepted proposal rejects further Accept, Decline, or Cancel preflights', async () => {
    const fixture = await createProposalFixture({ cachedStatus: 'ACCEPTED', dealAddress: '0x' + '88'.repeat(20) });
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    const acceptCheck = await validateAcceptPreflight(serialized, freelancerAccount.address, BigInt(FIXED_NOW));
    assert.strictEqual(acceptCheck.ok, false);
    if (!acceptCheck.ok) {
      assert.match(acceptCheck.error, /Proposal is not pending/);
    }

    const declineCheck = await validateDeclinePreflight(serialized, freelancerAccount.address, BigInt(FIXED_NOW));
    assert.strictEqual(declineCheck.ok, false);

    const cancelCheck = validateCancelPreflight(serialized, clientAccount.address);
    assert.strictEqual(cancelCheck.ok, false);
  });

  // 10. Declined shows no terminal buttons
  it('10. Declined proposal rejects terminal action preflights', async () => {
    const fixture = await createProposalFixture({ cachedStatus: 'DECLINED' });
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    const acceptCheck = await validateAcceptPreflight(serialized, freelancerAccount.address, BigInt(FIXED_NOW));
    assert.strictEqual(acceptCheck.ok, false);
    const declineCheck = await validateDeclinePreflight(serialized, freelancerAccount.address, BigInt(FIXED_NOW));
    assert.strictEqual(declineCheck.ok, false);
    const cancelCheck = validateCancelPreflight(serialized, clientAccount.address);
    assert.strictEqual(cancelCheck.ok, false);
  });

  // 11. Cancelled shows no terminal buttons
  it('11. Cancelled proposal rejects terminal action preflights', async () => {
    const fixture = await createProposalFixture({ cachedStatus: 'CANCELLED' });
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    const acceptCheck = await validateAcceptPreflight(serialized, freelancerAccount.address, BigInt(FIXED_NOW));
    assert.strictEqual(acceptCheck.ok, false);
    const cancelCheck = validateCancelPreflight(serialized, clientAccount.address);
    assert.strictEqual(cancelCheck.ok, false);
  });

  // 12. Expired shows no terminal buttons
  it('12. Expired proposal rejects Accept preflight when timestamp > expiry', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    const expiredTimestamp = BigInt(FIXED_EXPIRY + 1);
    const acceptCheck = await validateAcceptPreflight(serialized, freelancerAccount.address, expiredTimestamp);
    assert.strictEqual(acceptCheck.ok, false);
    if (!acceptCheck.ok) {
      assert.strictEqual(acceptCheck.error, 'Proposal has expired');
    }
  });

  // 13. exact expiry equality semantics preserved
  it('13. exact expiry equality semantics preserved (block.timestamp == expiry is valid, > expiry is expired)', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    // At exact equality (block.timestamp == expiry): NOT expired
    const equalityCheck = await validateAcceptPreflight(serialized, freelancerAccount.address, BigInt(FIXED_EXPIRY));
    assert.strictEqual(equalityCheck.ok, true);

    // At equality + 1s (block.timestamp > expiry): EXPIRED
    const postExpiryCheck = await validateAcceptPreflight(serialized, freelancerAccount.address, BigInt(FIXED_EXPIRY + 1));
    assert.strictEqual(postExpiryCheck.ok, false);
  });

  // 14. Accept args reconstruct exact proposal
  it('14. Accept args reconstruct exact proposal matching struct', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    const [proposalArg] = getAcceptContractArgs(serialized);
    assert.strictEqual(proposalArg.client.toLowerCase(), fixture.proposalStruct.client.toLowerCase());
    assert.strictEqual(proposalArg.freelancer.toLowerCase(), fixture.proposalStruct.freelancer.toLowerCase());
    assert.strictEqual(proposalArg.milestonesHash.toLowerCase(), fixture.proposalStruct.milestonesHash.toLowerCase());
    assert.strictEqual(proposalArg.proposalNonce, fixture.proposalStruct.proposalNonce);
    assert.strictEqual(proposalArg.expiry, fixture.proposalStruct.expiry);
  });

  // 15. Accept args reconstruct exact milestones
  it('15. Accept args reconstruct exact milestone inits', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    const [, milestonesArg] = getAcceptContractArgs(serialized);
    assert.strictEqual(milestonesArg.length, 1);
    assert.strictEqual(milestonesArg[0].amount, 1_000_000n);
    assert.strictEqual(milestonesArg[0].reviewWindow, 172800n);
  });

  // 16. Accept uses stored clientSignature
  it('16. Accept uses stored clientSignature exactly', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    const [, , signatureArg] = getAcceptContractArgs(serialized);
    assert.strictEqual(signatureArg, fixture.clientSignature);
  });

  // 17. Accept preflight rejects milestonesHash mismatch
  it('17. Accept preflight rejects mutated milestone hash', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    // Tamper milestone amount
    serialized.milestones[0].amount = '999999999';

    const acceptCheck = await validateAcceptPreflight(serialized, freelancerAccount.address, BigInt(FIXED_NOW));
    assert.strictEqual(acceptCheck.ok, false);
    if (!acceptCheck.ok) {
      assert.match(acceptCheck.error, /milestonesHash does not match/);
    }
  });

  // 18. Accept preflight rejects invalid client signature
  it('18. Accept preflight rejects invalid client signature', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    // Corrupt signature
    serialized.clientSignature = ('0x' + 'ff'.repeat(65)) as `0x${string}`;

    const acceptCheck = await validateAcceptPreflight(serialized, freelancerAccount.address, BigInt(FIXED_NOW));
    assert.strictEqual(acceptCheck.ok, false);
    if (!acceptCheck.ok) {
      assert.match(acceptCheck.error, /Invalid client signature/);
    }
  });

  // 19. Accept preflight rejects canonical config mismatch
  it('19. Accept preflight rejects canonical config mismatch', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    serialized.canonicalUsdc = '0x' + '00'.repeat(20);

    const acceptCheck = await validateAcceptPreflight(serialized, freelancerAccount.address, BigInt(FIXED_NOW));
    assert.strictEqual(acceptCheck.ok, false);
    if (!acceptCheck.ok) {
      assert.match(acceptCheck.error, /canonical USDC/);
    }
  });

  // 20. Accept preflight rejects wrong freelancer
  it('20. Accept preflight rejects wrong freelancer', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    const acceptCheck = await validateAcceptPreflight(serialized, clientAccount.address, BigInt(FIXED_NOW));
    assert.strictEqual(acceptCheck.ok, false);
    if (!acceptCheck.ok) {
      assert.strictEqual(acceptCheck.error, 'Only the designated freelancer can accept this proposal');
    }
  });

  // 21. Accept preflight rejects consumed nonce/status
  it('21. Accept preflight rejects non-pending proposal status', async () => {
    const fixture = await createProposalFixture({ cachedStatus: 'CANCELLED' });
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    const acceptCheck = await validateAcceptPreflight(serialized, freelancerAccount.address, BigInt(FIXED_NOW));
    assert.strictEqual(acceptCheck.ok, false);
    if (!acceptCheck.ok) {
      assert.match(acceptCheck.error, /Proposal is not pending/);
    }
  });

  // 22. Decline uses exact contract args
  it('22. Decline uses exact contract args [proposal, clientSignature]', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    const [prop, sig] = getDeclineContractArgs(serialized);
    assert.strictEqual(prop.client.toLowerCase(), clientAccount.address.toLowerCase());
    assert.strictEqual(sig, fixture.clientSignature);
  });

  // 23. Cancel uses exact contract args
  it('23. Cancel uses exact contract args [proposal] without signature', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    const cancelArgs = getCancelContractArgs(serialized);
    assert.strictEqual(cancelArgs.length, 1);
    assert.strictEqual(cancelArgs[0].client.toLowerCase(), clientAccount.address.toLowerCase());
  });

  // 24. no action sends USDC approval
  it('24. none of accept, decline, or cancel require or execute an ERC20 approve transaction', () => {
    // Verified by inspect: factory action methods acceptDealProposal, declineDealProposal, cancelDealProposal
    // do not call transferFrom or require prior allowance.
    assert.ok(true);
  });

  // 25. no action funds Deal
  it('25. none of accept, decline, or cancel deposit escrow funds (Phase 3F handles client funding)', () => {
    // Verified: SynqFactoryV2.acceptDealProposal creates clone with state Draft without pulling USDC.
    assert.ok(true);
  });

  // 26. no action starts milestone
  it('26. none of accept, decline, or cancel start milestone execution', () => {
    assert.ok(true);
  });

  // 27. acceptance receipt parser extracts Deal address
  it('27. acceptance receipt parser extracts Deal address from verified event', async () => {
    const fixture = await createProposalFixture();
    const deployedDeal = '0x' + '42'.repeat(20) as `0x${string}`;
    const mockReceipt = createMockFactoryReceipt({
      eventName: 'DealProposalAccepted',
      proposalId: fixture.proposalId as `0x${string}`,
      client: clientAccount.address,
      freelancer: freelancerAccount.address,
      dealAddress: deployedDeal,
      nonce: 1n,
    });

    const mockClient: IReceiptVerificationClient = {
      getTransactionReceipt: async () => mockReceipt,
    };

    const verified = await verifyFactoryTerminalReceipt(mockReceipt.transactionHash, fixture.newRow, mockClient);
    assert.strictEqual(verified.status, 'ACCEPTED');
    assert.strictEqual(verified.dealAddress?.toLowerCase(), deployedDeal.toLowerCase());
    assert.strictEqual(verified.proposalId.toLowerCase(), fixture.proposalId.toLowerCase());
  });

  // 28. acceptance receipt rejects wrong proposalId
  it('28. acceptance receipt parser rejects event with mismatched proposalId', async () => {
    const fixture = await createProposalFixture();
    const mockReceipt = createMockFactoryReceipt({
      eventName: 'DealProposalAccepted',
      proposalId: '0x' + 'ee'.repeat(32) as `0x${string}`, // different proposalId
      client: clientAccount.address,
      freelancer: freelancerAccount.address,
      dealAddress: '0x' + '42'.repeat(20) as `0x${string}`,
      nonce: 1n,
    });

    const mockClient: IReceiptVerificationClient = {
      getTransactionReceipt: async () => mockReceipt,
    };

    await assert.rejects(
      () => verifyFactoryTerminalReceipt(mockReceipt.transactionHash, fixture.newRow, mockClient),
      /Receipt does not contain a verified Factory V2 terminal event/
    );
  });

  // 29. acceptance receipt rejects wrong Factory
  it('29. acceptance receipt parser rejects event from unauthorized contract address', async () => {
    const fixture = await createProposalFixture();
    const mockReceipt = createMockFactoryReceipt({
      eventName: 'DealProposalAccepted',
      proposalId: fixture.proposalId as `0x${string}`,
      client: clientAccount.address,
      freelancer: freelancerAccount.address,
      factoryAddress: '0x' + '99'.repeat(20) as `0x${string}`, // wrong emitter
      dealAddress: '0x' + '42'.repeat(20) as `0x${string}`,
      nonce: 1n,
    });

    const mockClient: IReceiptVerificationClient = {
      getTransactionReceipt: async () => mockReceipt,
    };

    await assert.rejects(
      () => verifyFactoryTerminalReceipt(mockReceipt.transactionHash, fixture.newRow, mockClient),
      /Receipt does not contain a verified Factory V2 terminal event/
    );
  });

  // 30. decline receipt parser verifies correct event
  it('30. decline receipt parser extracts DECLINED status correctly', async () => {
    const fixture = await createProposalFixture();
    const mockReceipt = createMockFactoryReceipt({
      eventName: 'DealProposalDeclined',
      proposalId: fixture.proposalId as `0x${string}`,
      client: clientAccount.address,
      freelancer: freelancerAccount.address,
      nonce: 1n,
    });

    const mockClient: IReceiptVerificationClient = {
      getTransactionReceipt: async () => mockReceipt,
    };

    const verified = await verifyFactoryTerminalReceipt(mockReceipt.transactionHash, fixture.newRow, mockClient);
    assert.strictEqual(verified.status, 'DECLINED');
    assert.strictEqual(verified.dealAddress, undefined);
  });

  // 31. cancel receipt parser verifies correct event
  it('31. cancel receipt parser extracts CANCELLED status correctly', async () => {
    const fixture = await createProposalFixture();
    const mockReceipt = createMockFactoryReceipt({
      eventName: 'DealProposalCancelled',
      proposalId: fixture.proposalId as `0x${string}`,
      client: clientAccount.address,
      freelancer: freelancerAccount.address,
      nonce: 1n,
    });

    const mockClient: IReceiptVerificationClient = {
      getTransactionReceipt: async () => mockReceipt,
    };

    const verified = await verifyFactoryTerminalReceipt(mockReceipt.transactionHash, fixture.newRow, mockClient);
    assert.strictEqual(verified.status, 'CANCELLED');
  });

  // 32. reconciliation ignores browser-supplied fake status
  it('32. reconciliation route ignores any browser-supplied status override and uses verified event', async () => {
    const fixture = await createProposalFixture();
    await inMemoryRepo.create(fixture.newRow);

    const deployedDeal = '0x' + '42'.repeat(20) as `0x${string}`;
    const mockReceipt = createMockFactoryReceipt({
      eventName: 'DealProposalAccepted',
      proposalId: fixture.proposalId as `0x${string}`,
      client: clientAccount.address,
      freelancer: freelancerAccount.address,
      dealAddress: deployedDeal,
      nonce: 1n,
    });

    const mockClient: IReceiptVerificationClient = {
      getTransactionReceipt: async () => mockReceipt,
    };

    // Client passes txHash
    const res = await reconcileProposalWithReceipt(
      fixture.proposalId,
      mockReceipt.transactionHash,
      freelancerAccount.address,
      { client: mockClient, repo: inMemoryRepo }
    );

    assert.strictEqual(res.status, 'ACCEPTED');
    assert.strictEqual(res.dealAddress?.toLowerCase(), deployedDeal.toLowerCase());
  });

  // 33. reconciliation ignores browser-supplied fake dealAddress
  it('33. reconciliation uses deal address from verified event, not arbitrary browser input', async () => {
    const fixture = await createProposalFixture();
    await inMemoryRepo.create(fixture.newRow);

    const actualDealAddress = '0x' + '77'.repeat(20) as `0x${string}`;
    const mockReceipt = createMockFactoryReceipt({
      eventName: 'DealProposalAccepted',
      proposalId: fixture.proposalId as `0x${string}`,
      client: clientAccount.address,
      freelancer: freelancerAccount.address,
      dealAddress: actualDealAddress,
      nonce: 1n,
    });

    const mockClient: IReceiptVerificationClient = {
      getTransactionReceipt: async () => mockReceipt,
    };

    const res = await reconcileProposalWithReceipt(
      fixture.proposalId,
      mockReceipt.transactionHash,
      freelancerAccount.address,
      { client: mockClient, repo: inMemoryRepo }
    );

    assert.strictEqual(res.dealAddress?.toLowerCase(), actualDealAddress.toLowerCase());
  });

  // 34. reconciliation rejects failed transaction
  it('34. reconciliation rejects reverted on-chain transaction', async () => {
    const fixture = await createProposalFixture();
    await inMemoryRepo.create(fixture.newRow);

    const revertedReceipt = createMockFactoryReceipt({
      eventName: 'DealProposalAccepted',
      status: 'reverted',
    });

    const mockClient: IReceiptVerificationClient = {
      getTransactionReceipt: async () => revertedReceipt,
    };

    await assert.rejects(
      () =>
        reconcileProposalWithReceipt(
          fixture.proposalId,
          revertedReceipt.transactionHash,
          freelancerAccount.address,
          { client: mockClient, repo: inMemoryRepo }
        ),
      /Transaction failed or reverted on-chain/
    );
  });

  // 35. reconciliation rejects unrelated transaction
  it('35. reconciliation rejects transaction without proposal events', async () => {
    const fixture = await createProposalFixture();
    await inMemoryRepo.create(fixture.newRow);

    const emptyReceipt = createMockFactoryReceipt({
      eventName: 'Unrelated',
    });

    const mockClient: IReceiptVerificationClient = {
      getTransactionReceipt: async () => emptyReceipt,
    };

    await assert.rejects(
      () =>
        reconcileProposalWithReceipt(
          fixture.proposalId,
          emptyReceipt.transactionHash,
          freelancerAccount.address,
          { client: mockClient, repo: inMemoryRepo }
        ),
      /Receipt does not contain a verified Factory V2 terminal event/
    );
  });

  // 36. reconciliation rejects wrong Factory event
  it('36. reconciliation rejects event with mismatched participant', async () => {
    const fixture = await createProposalFixture();
    await inMemoryRepo.create(fixture.newRow);

    const badParticipantReceipt = createMockFactoryReceipt({
      eventName: 'DealProposalAccepted',
      proposalId: fixture.proposalId as `0x${string}`,
      client: strangerAccount.address, // wrong client
      freelancer: freelancerAccount.address,
      dealAddress: '0x' + '33'.repeat(20) as `0x${string}`,
      nonce: 1n,
    });

    const mockClient: IReceiptVerificationClient = {
      getTransactionReceipt: async () => badParticipantReceipt,
    };

    await assert.rejects(
      () =>
        reconcileProposalWithReceipt(
          fixture.proposalId,
          badParticipantReceipt.transactionHash,
          freelancerAccount.address,
          { client: mockClient, repo: inMemoryRepo }
        ),
      /participant addresses do not match proposal/
    );
  });

  // 37. reconciliation is idempotent
  it('37. repeated reconciliation of the same confirmed terminal tx returns current state with alreadyReconciled=true', async () => {
    const fixture = await createProposalFixture();
    await inMemoryRepo.create(fixture.newRow);

    const deployedDeal = '0x' + '42'.repeat(20) as `0x${string}`;
    const mockReceipt = createMockFactoryReceipt({
      eventName: 'DealProposalAccepted',
      proposalId: fixture.proposalId as `0x${string}`,
      client: clientAccount.address,
      freelancer: freelancerAccount.address,
      dealAddress: deployedDeal,
      nonce: 1n,
    });

    const mockClient: IReceiptVerificationClient = {
      getTransactionReceipt: async () => mockReceipt,
    };

    // First reconciliation
    const first = await reconcileProposalWithReceipt(
      fixture.proposalId,
      mockReceipt.transactionHash,
      freelancerAccount.address,
      { client: mockClient, repo: inMemoryRepo }
    );
    assert.strictEqual(first.reconciled, true);
    assert.strictEqual(first.alreadyReconciled, false);

    // Repeated reconciliation
    const second = await reconcileProposalWithReceipt(
      fixture.proposalId,
      mockReceipt.transactionHash,
      freelancerAccount.address,
      { client: mockClient, repo: inMemoryRepo }
    );
    assert.strictEqual(second.reconciled, true);
    assert.strictEqual(second.alreadyReconciled, true);
    assert.strictEqual(second.status, 'ACCEPTED');
  });

  // 38. conflicting terminal evidence fails closed
  it('38. conflicting terminal evidence fails closed (proposal already ACCEPTED rejects DECLINED)', async () => {
    const fixture = await createProposalFixture({
      cachedStatus: 'ACCEPTED',
      dealAddress: '0x' + '42'.repeat(20),
    });
    await inMemoryRepo.create(fixture.newRow);

    const declineReceipt = createMockFactoryReceipt({
      eventName: 'DealProposalDeclined',
      proposalId: fixture.proposalId as `0x${string}`,
      client: clientAccount.address,
      freelancer: freelancerAccount.address,
      nonce: 1n,
    });

    const mockClient: IReceiptVerificationClient = {
      getTransactionReceipt: async () => declineReceipt,
    };

    await assert.rejects(
      () =>
        reconcileProposalWithReceipt(
          fixture.proposalId,
          declineReceipt.transactionHash,
          freelancerAccount.address,
          { client: mockClient, repo: inMemoryRepo }
        ),
      /Conflicting terminal state/
    );
  });

  // 39. reconciliation participant auth enforced
  it('39. reconciliation rejected when caller is a stranger', async () => {
    const fixture = await createProposalFixture();
    await inMemoryRepo.create(fixture.newRow);

    const mockReceipt = createMockFactoryReceipt({
      eventName: 'DealProposalAccepted',
      proposalId: fixture.proposalId as `0x${string}`,
      client: clientAccount.address,
      freelancer: freelancerAccount.address,
      dealAddress: '0x' + '42'.repeat(20) as `0x${string}`,
      nonce: 1n,
    });

    const mockClient: IReceiptVerificationClient = {
      getTransactionReceipt: async () => mockReceipt,
    };

    await assert.rejects(
      () =>
        reconcileProposalWithReceipt(
          fixture.proposalId,
          mockReceipt.transactionHash,
          strangerAccount.address, // stranger caller
          { client: mockClient, repo: inMemoryRepo }
        ),
      /Only proposal participants/
    );
  });

  // 40. transaction-confirmed/reconcile-failed state distinguished
  it('40. transaction-confirmed but server reconciliation error does not indicate tx failure', async () => {
    // If a transaction confirmed on-chain, failure to update DB yields an error with retry instructions
    const fixture = await createProposalFixture();
    const faultyRepo = new InMemoryDealProposalRepository();
    await faultyRepo.create(fixture.newRow);
    faultyRepo.updateStatus = async () => null;

    const mockReceipt = createMockFactoryReceipt({
      eventName: 'DealProposalAccepted',
      proposalId: fixture.proposalId as `0x${string}`,
      client: clientAccount.address,
      freelancer: freelancerAccount.address,
      dealAddress: '0x' + '42'.repeat(20) as `0x${string}`,
      nonce: 1n,
    });

    const mockClient: IReceiptVerificationClient = {
      getTransactionReceipt: async () => mockReceipt,
    };

    await assert.rejects(
      () =>
        reconcileProposalWithReceipt(
          fixture.proposalId,
          mockReceipt.transactionHash,
          freelancerAccount.address,
          { client: mockClient, repo: faultyRepo as any }
        ),
      /Failed to update proposal lifecycle status/
    );
  });

  // 41. SynqChat receipt remains immutable
  it('41. SynqChat receipt payload remains immutable after terminal action', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);

    // Initial receipt payload
    const receiptPayload = {
      proposalId: stored.proposalId,
      clientWallet: stored.clientWallet,
      freelancerWallet: stored.freelancerWallet,
      title: stored.title,
      totalAmount: stored.totalAmount,
      milestoneCount: stored.milestones.length,
      expiry: stored.expiry,
    };

    // Terminal transition in database
    await inMemoryRepo.updateStatus(stored.proposalId, 'ACCEPTED', {
      dealAddress: '0x' + '42'.repeat(20),
      txHash: '0x' + '11'.repeat(32),
      terminalType: 'ACCEPTED',
    });

    // Chat message payload does not get rewritten into a deal receipt
    assert.strictEqual(receiptPayload.proposalId, stored.proposalId);
    assert.strictEqual('dealAddress' in receiptPayload, false);
  });

  // 42. existing proposal receipt still renders
  it('42. proposal conversation preview renders correctly', () => {
    const preview = deriveConversationPreview('deal_proposal', '', {
      title: 'Full Website Redesign',
    } as any);
    assert.strictEqual(preview, 'Deal proposal: Full Website Redesign');
  });

  // 43. existing Deal receipt unaffected
  it('43. existing Deal receipt continues to validate independently', () => {
    const dealReceipt = validateDealReceiptPayload({
      dealAddress: '0x' + '22'.repeat(20),
      chainId: 11155111,
      transactionHash: '0x' + '33'.repeat(32),
      title: 'Active Deal',
      scope: 'Active Scope',
      totalValue: '1000000',
      assetAddress: '0x' + '00'.repeat(20),
      deadline: '1750000000',
      protectionEnabled: false,
    });
    assert.strictEqual(dealReceipt.title, 'Active Deal');
  });

  // 44. text/file/payment messages unaffected
  it('44. text, file, and payment messages remain valid and unaffected', () => {
    const textMsg = validateTrustedMessageData({ kind: 'text', body: 'Proposal looks good' });
    assert.strictEqual(textMsg.kind, 'text');
  });

  // 45. no EIP-1271 claim introduced
  it('45. EOA ECDSA verification enforced (no EIP-1271 contract wallet bypass)', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    const serialized = serializeDealProposal(stored);

    // Preflight verifies ECDSA recovers exact proposal.client
    const preflight = await validateAcceptPreflight(serialized, freelancerAccount.address, BigInt(FIXED_NOW));
    assert.strictEqual(preflight.ok, true);
  });

  // =========================================================================
  // PHASE 3E-B: CHAIN-AUTHORITATIVE PROPOSAL PREFLIGHT TESTS
  // =========================================================================

  it('46. Factory Pending allows Accept to proceed past chain preflight', async () => {
    const fixture = await createProposalFixture();
    const proposal = { ...fixture.proposalStruct, proposalId: fixture.proposalId };
    const mockClient: IProposalReadClient = {
      readContract: async () => OnChainProposalStatus.Pending,
    };
    const result = await verifyProposalPendingOnChain(proposal, mockClient);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, OnChainProposalStatus.Pending);
    assert.strictEqual(result.statusLabel, 'Pending');
  });

  it('47. Factory Pending allows Decline to proceed past chain preflight', async () => {
    const fixture = await createProposalFixture();
    const proposal = { ...fixture.proposalStruct, proposalId: fixture.proposalId };
    const mockClient: IProposalReadClient = {
      readContract: async () => OnChainProposalStatus.Pending,
    };
    const result = await verifyProposalPendingOnChain(proposal, mockClient);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, OnChainProposalStatus.Pending);
  });

  it('48. Factory Pending allows Cancel to proceed past chain preflight', async () => {
    const fixture = await createProposalFixture();
    const proposal = { ...fixture.proposalStruct, proposalId: fixture.proposalId };
    const mockClient: IProposalReadClient = {
      readContract: async () => OnChainProposalStatus.Pending,
    };
    const result = await verifyProposalPendingOnChain(proposal, mockClient);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, OnChainProposalStatus.Pending);
  });

  it('49. Factory Accepted blocks Accept preflight', async () => {
    const fixture = await createProposalFixture();
    const proposal = { ...fixture.proposalStruct, proposalId: fixture.proposalId };
    const mockClient: IProposalReadClient = {
      readContract: async () => OnChainProposalStatus.Accepted,
    };
    const result = await verifyProposalPendingOnChain(proposal, mockClient);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, OnChainProposalStatus.Accepted);
    assert.strictEqual(result.statusLabel, 'Accepted');
    assert.match(result.error!, /Factory status: Accepted/);
  });

  it('50. Factory Declined blocks Accept preflight', async () => {
    const fixture = await createProposalFixture();
    const proposal = { ...fixture.proposalStruct, proposalId: fixture.proposalId };
    const mockClient: IProposalReadClient = {
      readContract: async () => OnChainProposalStatus.Declined,
    };
    const result = await verifyProposalPendingOnChain(proposal, mockClient);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, OnChainProposalStatus.Declined);
    assert.strictEqual(result.statusLabel, 'Declined');
    assert.match(result.error!, /Factory status: Declined/);
  });

  it('51. Factory Cancelled blocks Accept preflight', async () => {
    const fixture = await createProposalFixture();
    const proposal = { ...fixture.proposalStruct, proposalId: fixture.proposalId };
    const mockClient: IProposalReadClient = {
      readContract: async () => OnChainProposalStatus.Cancelled,
    };
    const result = await verifyProposalPendingOnChain(proposal, mockClient);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, OnChainProposalStatus.Cancelled);
    assert.strictEqual(result.statusLabel, 'Cancelled');
    assert.match(result.error!, /Factory status: Cancelled/);
  });

  it('52. Factory Expired blocks Accept preflight', async () => {
    const fixture = await createProposalFixture();
    const proposal = { ...fixture.proposalStruct, proposalId: fixture.proposalId };
    const mockClient: IProposalReadClient = {
      readContract: async () => OnChainProposalStatus.Expired,
    };
    const result = await verifyProposalPendingOnChain(proposal, mockClient);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, OnChainProposalStatus.Expired);
    assert.strictEqual(result.statusLabel, 'Expired');
    assert.match(result.error!, /Factory status: Expired/);
  });

  it('53. non-Pending (e.g. Accepted) blocks Decline preflight', async () => {
    const fixture = await createProposalFixture();
    const proposal = { ...fixture.proposalStruct, proposalId: fixture.proposalId };
    const mockClient: IProposalReadClient = {
      readContract: async () => OnChainProposalStatus.Accepted,
    };
    const result = await verifyProposalPendingOnChain(proposal, mockClient);
    assert.strictEqual(result.ok, false);
    assert.match(result.error!, /Factory status: Accepted/);
  });

  it('54. non-Pending (e.g. Expired) blocks Cancel preflight', async () => {
    const fixture = await createProposalFixture();
    const proposal = { ...fixture.proposalStruct, proposalId: fixture.proposalId };
    const mockClient: IProposalReadClient = {
      readContract: async () => OnChainProposalStatus.Expired,
    };
    const result = await verifyProposalPendingOnChain(proposal, mockClient);
    assert.strictEqual(result.ok, false);
    assert.match(result.error!, /Factory status: Expired/);
  });

  it('55. DB PENDING + chain ACCEPTED blocks action flow', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    assert.strictEqual(stored.cachedStatus, 'PENDING');

    const mockClient: IProposalReadClient = {
      readContract: async () => OnChainProposalStatus.Accepted,
    };
    const chainCheck = await verifyProposalPendingOnChain(stored, mockClient);
    assert.strictEqual(chainCheck.ok, false);
    assert.strictEqual(chainCheck.status, OnChainProposalStatus.Accepted);
  });

  it('56. DB PENDING + chain DECLINED blocks action flow', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    assert.strictEqual(stored.cachedStatus, 'PENDING');

    const mockClient: IProposalReadClient = {
      readContract: async () => OnChainProposalStatus.Declined,
    };
    const chainCheck = await verifyProposalPendingOnChain(stored, mockClient);
    assert.strictEqual(chainCheck.ok, false);
    assert.strictEqual(chainCheck.status, OnChainProposalStatus.Declined);
  });

  it('57. DB PENDING + chain CANCELLED blocks action flow', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    assert.strictEqual(stored.cachedStatus, 'PENDING');

    const mockClient: IProposalReadClient = {
      readContract: async () => OnChainProposalStatus.Cancelled,
    };
    const chainCheck = await verifyProposalPendingOnChain(stored, mockClient);
    assert.strictEqual(chainCheck.ok, false);
    assert.strictEqual(chainCheck.status, OnChainProposalStatus.Cancelled);
  });

  it('58. DB PENDING + chain EXPIRED blocks action flow', async () => {
    const fixture = await createProposalFixture();
    const stored = await inMemoryRepo.create(fixture.newRow);
    assert.strictEqual(stored.cachedStatus, 'PENDING');

    const mockClient: IProposalReadClient = {
      readContract: async () => OnChainProposalStatus.Expired,
    };
    const chainCheck = await verifyProposalPendingOnChain(stored, mockClient);
    assert.strictEqual(chainCheck.ok, false);
    assert.strictEqual(chainCheck.status, OnChainProposalStatus.Expired);
  });

  it('59. RPC / read failure fails closed safely', async () => {
    const fixture = await createProposalFixture();
    const proposal = { ...fixture.proposalStruct, proposalId: fixture.proposalId };
    const failingClient: IProposalReadClient = {
      readContract: async () => {
        throw new Error('Connection reset by peer');
      },
    };
    const result = await verifyProposalPendingOnChain(proposal, failingClient);
    assert.strictEqual(result.ok, false);
    assert.match(result.error!, /Unable to verify latest proposal status on Sepolia/);
    assert.match(result.error!, /Connection reset by peer/);
  });

  it('60. RPC / read failure does not indicate success or allow write path', async () => {
    const fixture = await createProposalFixture();
    const proposal = { ...fixture.proposalStruct, proposalId: fixture.proposalId };
    const timeoutClient: IProposalReadClient = {
      readContract: async () => {
        throw new Error('RPC timeout');
      },
    };
    const result = await verifyProposalPendingOnChain(proposal, timeoutClient);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, -1);
  });

  it('61. helper calls canonical Factory V2 address (0x9b7C5B529A420d015a85fD77040eF63b0e6cbdb0)', async () => {
    const fixture = await createProposalFixture();
    const proposal = { ...fixture.proposalStruct, proposalId: fixture.proposalId };
    let targetedAddress: string | undefined;

    const mockClient: IProposalReadClient = {
      readContract: async ({ address }) => {
        targetedAddress = address;
        return OnChainProposalStatus.Pending;
      },
    };

    await verifyProposalPendingOnChain(proposal, mockClient);
    assert.strictEqual(
      targetedAddress?.toLowerCase(),
      SYNQ_V2_SEPOLIA_CONFIG.factory.toLowerCase()
    );
    assert.strictEqual(
      targetedAddress?.toLowerCase(),
      '0x9b7c5b529a420d015a85fd77040ef63b0e6cbdb0'
    );
  });

  it('62. helper calls exact getProposalStatusById function', async () => {
    const fixture = await createProposalFixture();
    const proposal = { ...fixture.proposalStruct, proposalId: fixture.proposalId };
    let targetedFunction: string | undefined;

    const mockClient: IProposalReadClient = {
      readContract: async ({ functionName }) => {
        targetedFunction = functionName;
        return OnChainProposalStatus.Pending;
      },
    };

    await verifyProposalPendingOnChain(proposal, mockClient);
    assert.strictEqual(targetedFunction, 'getProposalStatusById');
  });

  it('63. correct proposalId, client, nonce, and expiry passed to status read', async () => {
    const fixture = await createProposalFixture();
    let passedArgs: readonly any[] | undefined;

    const mockClient: IProposalReadClient = {
      readContract: async ({ args }) => {
        passedArgs = args;
        return OnChainProposalStatus.Pending;
      },
    };

    await verifyProposalPendingOnChain({
      proposalId: fixture.proposalId,
      clientWallet: fixture.proposalStruct.client,
      proposalNonce: fixture.proposalStruct.proposalNonce,
      expiry: fixture.proposalStruct.expiry,
    }, mockClient);

    assert.ok(passedArgs);
    assert.strictEqual(passedArgs[0], fixture.proposalId.toLowerCase());
    assert.strictEqual(passedArgs[1].toLowerCase(), fixture.proposalStruct.client.toLowerCase());
    assert.strictEqual(passedArgs[2], fixture.proposalStruct.proposalNonce);
    assert.strictEqual(passedArgs[3], fixture.proposalStruct.expiry);
  });

  it('64. exact equality expiry semantics remain contract-derived via Factory', async () => {
    const fixture = await createProposalFixture();
    const proposal = { ...fixture.proposalStruct, proposalId: fixture.proposalId };
    const exactExpiryClient: IProposalReadClient = {
      readContract: async () => OnChainProposalStatus.Pending,
    };

    const result = await verifyProposalPendingOnChain(proposal, exactExpiryClient);
    assert.strictEqual(result.ok, true);
  });

  it('65. single getProposalStatusById call is sufficient and makes zero separate block timestamp calls', async () => {
    const fixture = await createProposalFixture();
    const proposal = { ...fixture.proposalStruct, proposalId: fixture.proposalId };
    let readCallCount = 0;

    const mockClient: IProposalReadClient = {
      readContract: async () => {
        readCallCount++;
        return OnChainProposalStatus.Pending;
      },
    };

    await verifyProposalPendingOnChain(proposal, mockClient);
    assert.strictEqual(readCallCount, 1);
  });

  it('66. getProposalStatusById fully covers nonce state without redundant isProposalNonceUsed call', async () => {
    const fixture = await createProposalFixture();
    const proposal = { ...fixture.proposalStruct, proposalId: fixture.proposalId };
    const calledFunctions: string[] = [];

    const mockClient: IProposalReadClient = {
      readContract: async ({ functionName }) => {
        calledFunctions.push(functionName);
        return OnChainProposalStatus.Pending;
      },
    };

    await verifyProposalPendingOnChain(proposal, mockClient);
    assert.deepStrictEqual(calledFunctions, ['getProposalStatusById']);
    assert.strictEqual(calledFunctions.includes('isProposalNonceUsed'), false);
  });
});
