// test/SynqV2ProposalPersistence.test.ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex } from 'viem';
import {
  SYNQ_V2_SEPOLIA_CONFIG,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  getStandardV2Eip712Domain,
  DEAL_PROPOSAL_EIP712_TYPES,
  hashStandardV2Milestones,
  hashDealProposalV2,
  buildStandardV2Proposal,
} from '@/lib/deals/v2';
import type { DealProposalV2, StandardV2MilestoneInit } from '@/types/deal-v2';
import {
  parseStrictUint256String,
  parseStrictAddress,
  parseStrictBytes32,
  parseStrictSignature,
  parseStrictMetadata,
  parseStrictMilestones,
  parseStrictProposal,
  verifyServerProposalSubmission,
  evaluateProposalPersistence,
  serializeDealProposal,
  InMemoryDealProposalRepository,
  ProposalValidationError,
  ProposalAuthError,
  ProposalConflictError,
  type SerializedDealProposal,
  setDealProposalRepository,
  resetDealProposalRepository,
} from '@/lib/deals/proposals-db';
import { normalizeWallet } from '@/lib/utils';
import type { NewDealProposalRow } from '@/db/schema';
import { POST as handlePostProposal } from '@/app/api/deals/proposals/route';
import { GET as handleGetProposal } from '@/app/api/deals/proposals/[proposalId]/route';
import { signToken } from '@/lib/auth';
import { NextRequest } from 'next/server';

// Local deterministic test accounts
const clientAccount = privateKeyToAccount('0x1111111111111111111111111111111111111111111111111111111111111111');
const freelancerAccount = privateKeyToAccount('0x2222222222222222222222222222222222222222222222222222222222222222');
const attackerAccount = privateKeyToAccount('0x3333333333333333333333333333333333333333333333333333333333333333');

const DEFAULT_NOW = Math.floor(Date.now() / 1000);
const FIXED_NOW = DEFAULT_NOW;

async function createValidProposalFixtures(overrides: {
  now?: number;
  nonce?: bigint;
  expiry?: bigint;
  amount?: bigint;
  workDeadline?: bigint;
  reviewWindow?: bigint;
  gracePeriod?: bigint;
  specHash?: `0x${string}`;
  signer?: typeof clientAccount;
} = {}) {
  const now = overrides.now ?? DEFAULT_NOW;
  const nonce = overrides.nonce ?? 0n;
  const expiry = overrides.expiry ?? BigInt(now + 86400 * 7);
  const amount = overrides.amount ?? 1_000_000n; // 1 USDC
  const workDeadline = overrides.workDeadline ?? BigInt(now + 86400 * 3);
  const reviewWindow = overrides.reviewWindow ?? 259200n; // 3 days
  const gracePeriod = overrides.gracePeriod ?? 86400n; // 1 day
  const specHash = overrides.specHash ?? keccak256(toHex('Agreed milestone criteria v1'));

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
  const signer = overrides.signer ?? clientAccount;
  const clientSignature = await signer.signTypedData({
    domain,
    types: DEAL_PROPOSAL_EIP712_TYPES,
    primaryType: 'DealProposal',
    message: proposal,
  });

  const proposalId = hashDealProposalV2(proposal);

  const rawRequestBody = {
    proposal: {
      client: proposal.client,
      freelancer: proposal.freelancer,
      canonicalUsdc: proposal.canonicalUsdc,
      dealImplementation: proposal.dealImplementation,
      primaryResolver: proposal.primaryResolver,
      emergencyResolver: proposal.emergencyResolver,
      milestonesHash: proposal.milestonesHash,
      isProtected: proposal.isProtected,
      protectionModule: proposal.protectionModule,
      policyId: proposal.policyId,
      proposalNonce: proposal.proposalNonce.toString(),
      expiry: proposal.expiry.toString(),
    },
    milestones: [
      {
        amount: amount.toString(),
        workDeadline: workDeadline.toString(),
        reviewWindow: reviewWindow.toString(),
        gracePeriod: gracePeriod.toString(),
        specHash,
        title: 'Milestone 1: Web App Design',
        description: 'Complete UI layout and user review flow',
      },
    ],
    clientSignature,
    metadata: {
      title: 'Synq V2 Integration Deal',
      scope: 'Standard milestone escrow workflow',
    },
  };

  return {
    proposal,
    milestones,
    milestonesHash,
    proposalId,
    clientSignature,
    rawRequestBody,
  };
}

describe('Synq Standard V2 Proposal Persistence & API Suite', () => {
  let inMemoryRepo: InMemoryDealProposalRepository;

  beforeEach(() => {
    inMemoryRepo = new InMemoryDealProposalRepository();
    setDealProposalRepository(inMemoryRepo);
  });

  // 1. Unauthenticated rejected
  it('1. unauthenticated rejected', async () => {
    const { rawRequestBody } = await createValidProposalFixtures();
    await assert.rejects(
      async () => {
        await verifyServerProposalSubmission(rawRequestBody, null, FIXED_NOW);
      },
      (err: any) => err instanceof ProposalAuthError && err.message === 'Unauthorized'
    );
  });

  // 2. Auth wallet != client rejected
  it('2. auth wallet != client rejected', async () => {
    const { rawRequestBody } = await createValidProposalFixtures();
    await assert.rejects(
      async () => {
        await verifyServerProposalSubmission(rawRequestBody, attackerAccount.address, FIXED_NOW);
      },
      (err: any) =>
        err instanceof ProposalAuthError &&
        err.message === 'Authenticated wallet does not match proposal client'
    );
  });

  // 3. Valid proposal accepted by verification pipeline
  it('3. valid proposal accepted by verification pipeline', async () => {
    const { rawRequestBody, proposalId, milestonesHash } = await createValidProposalFixtures();
    const verified = await verifyServerProposalSubmission(rawRequestBody, clientAccount.address, FIXED_NOW);

    assert.strictEqual(verified.proposalId, proposalId);
    assert.strictEqual(verified.milestonesHash, milestonesHash);
    assert.strictEqual(verified.totalAmount, 1_000_000n);
    assert.strictEqual(verified.rowToInsert.clientWallet, normalizeWallet(clientAccount.address));
    assert.strictEqual(verified.rowToInsert.freelancerWallet, normalizeWallet(freelancerAccount.address));
    assert.strictEqual(verified.rowToInsert.cachedStatus, 'PENDING');
  });

  // 4. Malformed address rejected
  it('4. malformed address rejected', async () => {
    assert.throws(
      () => parseStrictAddress('0xnotAnAddress', 'client'),
      (err: any) => err instanceof ProposalValidationError && /valid 20-byte hex address/.test(err.message)
    );
    assert.throws(
      () => parseStrictAddress('12345', 'client'),
      (err: any) => err instanceof ProposalValidationError
    );
  });

  // 5. Zero address rejected
  it('5. zero address rejected for client and freelancer', async () => {
    assert.throws(
      () => parseStrictAddress(ZERO_ADDRESS, 'client'),
      (err: any) => err instanceof ProposalValidationError && /cannot be zero address/.test(err.message)
    );
    assert.throws(
      () => parseStrictAddress(ZERO_ADDRESS, 'freelancer'),
      (err: any) => err instanceof ProposalValidationError && /cannot be zero address/.test(err.message)
    );
  });

  // 6. Self-deal rejected
  it('6. self-deal (client == freelancer) rejected', async () => {
    const { rawRequestBody } = await createValidProposalFixtures();
    const selfDealBody = JSON.parse(JSON.stringify(rawRequestBody));
    selfDealBody.proposal.freelancer = clientAccount.address;

    await assert.rejects(
      async () => {
        await verifyServerProposalSubmission(selfDealBody, clientAccount.address, FIXED_NOW);
      },
      (err: any) => err instanceof ProposalValidationError && /distinct addresses|self-deals/.test(err.message)
    );
  });

  // 7. Malformed bytes32 rejected
  it('7. malformed bytes32 rejected', () => {
    assert.throws(
      () => parseStrictBytes32('0x1234', 'specHash'),
      (err: any) => err instanceof ProposalValidationError && /valid 32-byte hex string/.test(err.message)
    );
    assert.throws(
      () => parseStrictBytes32('notHex', 'policyId'),
      (err: any) => err instanceof ProposalValidationError
    );
  });

  // 8. Malformed signature rejected
  it('8. malformed signature rejected', () => {
    assert.throws(
      () => parseStrictSignature('0xabcd', 'clientSignature'),
      (err: any) => err instanceof ProposalValidationError && /valid 65-byte hex signature/.test(err.message)
    );
  });

  // 9. Wrong signer rejected
  it('9. wrong signer rejected', async () => {
    // Proposal where client is clientAccount, but signature is produced by attackerAccount
    const { rawRequestBody } = await createValidProposalFixtures({ signer: attackerAccount });

    await assert.rejects(
      async () => {
        await verifyServerProposalSubmission(rawRequestBody, clientAccount.address, FIXED_NOW);
      },
      (err: any) => err instanceof ProposalValidationError && err.message === 'Invalid proposal signature'
    );
  });

  // 10. Milestone mutation causes hash mismatch
  it('10. milestone mutation causes hash mismatch', async () => {
    const { rawRequestBody } = await createValidProposalFixtures();
    const tamperedBody = JSON.parse(JSON.stringify(rawRequestBody));
    // Tamper with the milestone amount
    tamperedBody.milestones[0].amount = '2000000';

    await assert.rejects(
      async () => {
        await verifyServerProposalSubmission(tamperedBody, clientAccount.address, FIXED_NOW);
      },
      (err: any) =>
        err instanceof ProposalValidationError &&
        /milestonesHash does not match|Milestones hash mismatch/.test(err.message)
    );
  });

  // 11. Proposal field mutation invalidates signature
  it('11. proposal field mutation invalidates signature', async () => {
    const { rawRequestBody } = await createValidProposalFixtures();
    const tamperedBody = JSON.parse(JSON.stringify(rawRequestBody));
    // Tamper with proposal nonce without resigning
    tamperedBody.proposal.proposalNonce = '999';

    await assert.rejects(
      async () => {
        await verifyServerProposalSubmission(tamperedBody, clientAccount.address, FIXED_NOW);
      },
      (err: any) => err instanceof ProposalValidationError && err.message === 'Invalid proposal signature'
    );
  });

  // 12. Canonical config mismatch rejected
  it('12. canonical config mismatch rejected', async () => {
    const { rawRequestBody } = await createValidProposalFixtures();
    const tamperedBody = JSON.parse(JSON.stringify(rawRequestBody));
    // Mutate primaryResolver
    tamperedBody.proposal.primaryResolver = attackerAccount.address;

    await assert.rejects(
      async () => {
        await verifyServerProposalSubmission(tamperedBody, clientAccount.address, FIXED_NOW);
      },
      (err: any) => err instanceof ProposalValidationError && /primaryResolver must match/.test(err.message)
    );
  });

  // 13. Expired proposal rejected
  it('13. expired proposal rejected', async () => {
    // Expiry in the past relative to FIXED_NOW
    const pastExpiry = BigInt(FIXED_NOW - 100);
    const { rawRequestBody } = await createValidProposalFixtures({ expiry: pastExpiry });

    await assert.rejects(
      async () => {
        await verifyServerProposalSubmission(rawRequestBody, clientAccount.address, FIXED_NOW);
      },
      (err: any) => err instanceof ProposalValidationError && /expiry .* is in the past/.test(err.message)
    );
  });

  // 14. Expiry equality semantics understood and tested
  it('14. expiry equality semantics (expiry == currentTimestamp rejected at creation)', async () => {
    const exactExpiry = BigInt(FIXED_NOW);
    const { rawRequestBody } = await createValidProposalFixtures({ expiry: exactExpiry });

    await assert.rejects(
      async () => {
        await verifyServerProposalSubmission(rawRequestBody, clientAccount.address, FIXED_NOW);
      },
      (err: any) => err instanceof ProposalValidationError && /expiry .* is in the past/.test(err.message)
    );
  });

  // 15. Past milestone deadline rejected
  it('15. past milestone deadline rejected', async () => {
    const pastDeadline = BigInt(FIXED_NOW - 500);
    const { rawRequestBody } = await createValidProposalFixtures({ workDeadline: pastDeadline });

    await assert.rejects(
      async () => {
        await verifyServerProposalSubmission(rawRequestBody, clientAccount.address, FIXED_NOW);
      },
      (err: any) => err instanceof ProposalValidationError && /workDeadline .* is in the past/.test(err.message)
    );
  });

  // 16. Unsafe numeric input rejected
  it('16. unsafe numeric input rejected (decimals, scientific, negatives)', () => {
    assert.throws(
      () => parseStrictUint256String('1.5', 'amount'),
      (err: any) => err instanceof ProposalValidationError && /only decimal digits/.test(err.message)
    );
    assert.throws(
      () => parseStrictUint256String('1e6', 'amount'),
      (err: any) => err instanceof ProposalValidationError && /only decimal digits/.test(err.message)
    );
    assert.throws(
      () => parseStrictUint256String('-100', 'amount'),
      (err: any) => err instanceof ProposalValidationError && /only decimal digits/.test(err.message)
    );
    assert.throws(
      () => parseStrictUint256String('NaN', 'amount'),
      (err: any) => err instanceof ProposalValidationError
    );
    assert.throws(
      () => parseStrictUint256String(1000 as any, 'amount'),
      (err: any) => err instanceof ProposalValidationError && /must be a decimal string/.test(err.message)
    );
  });

  // 17. >uint256 rejected
  it('17. >uint256 rejected', () => {
    const overflowString = (2n ** 256n).toString();
    assert.throws(
      () => parseStrictUint256String(overflowString, 'nonce'),
      (err: any) => err instanceof ProposalValidationError && /out of uint256 bounds/.test(err.message)
    );
  });

  // 18. totalAmount computed server-side
  it('18. totalAmount computed server-side accurately from milestone sum', async () => {
    const { rawRequestBody } = await createValidProposalFixtures({ amount: 5_000_000n });
    const verified = await verifyServerProposalSubmission(rawRequestBody, clientAccount.address, FIXED_NOW);

    assert.strictEqual(verified.totalAmount, 5_000_000n);
    assert.strictEqual(verified.rowToInsert.totalAmount, '5000000');
  });

  // 19. Bigint serializer exact
  it('19. bigint serializer exact decimal strings', async () => {
    const { rawRequestBody } = await createValidProposalFixtures();
    const verified = await verifyServerProposalSubmission(rawRequestBody, clientAccount.address, FIXED_NOW);
    const created = await inMemoryRepo.create(verified.rowToInsert);

    const serialized: SerializedDealProposal = serializeDealProposal(created);
    assert.strictEqual(typeof serialized.proposalNonce, 'string');
    assert.strictEqual(typeof serialized.expiry, 'string');
    assert.strictEqual(typeof serialized.totalAmount, 'string');
    assert.strictEqual(serialized.proposalNonce, '0');
    assert.strictEqual(serialized.totalAmount, '1000000');
    assert.strictEqual(serialized.milestones[0].amount, '1000000');
  });

  // 20. Exact duplicate classified idempotent
  it('20. exact duplicate classified idempotent replay (action IDEMPOTENT_REPLAY)', async () => {
    const { rawRequestBody } = await createValidProposalFixtures();
    const verified = await verifyServerProposalSubmission(rawRequestBody, clientAccount.address, FIXED_NOW);
    const created = await inMemoryRepo.create(verified.rowToInsert);

    const decision = evaluateProposalPersistence(verified.rowToInsert, created, null);
    assert.strictEqual(decision.action, 'IDEMPOTENT_REPLAY');
    if (decision.action === 'IDEMPOTENT_REPLAY') {
      assert.strictEqual(decision.existingRow.proposalId, verified.proposalId);
    }
  });

  // 21. Same proposalId conflicting data rejected
  it('21. same proposalId conflicting data rejected (action CONFLICT_DATA)', async () => {
    const { rawRequestBody } = await createValidProposalFixtures();
    const verified = await verifyServerProposalSubmission(rawRequestBody, clientAccount.address, FIXED_NOW);
    const created = await inMemoryRepo.create(verified.rowToInsert);

    // Candidate has same proposalId but conflicting metadata title
    const tamperedCandidate: NewDealProposalRow = {
      ...verified.rowToInsert,
      title: 'Conflicting Title Substituted',
    };

    const decision = evaluateProposalPersistence(tamperedCandidate, created, null);
    assert.strictEqual(decision.action, 'CONFLICT_DATA');
    if (decision.action === 'CONFLICT_DATA') {
      assert.strictEqual(decision.reason, 'Proposal already exists with conflicting data');
    }
  });

  // 22. Same nonce different proposal conflict
  it('22. same nonce different proposal conflict (action CONFLICT_NONCE)', async () => {
    // Existing proposal with nonce 0
    const fixtureA = await createValidProposalFixtures({ nonce: 0n, amount: 1_000_000n });
    const verifiedA = await verifyServerProposalSubmission(fixtureA.rawRequestBody, clientAccount.address, FIXED_NOW);
    const createdA = await inMemoryRepo.create(verifiedA.rowToInsert);

    // Sibling candidate proposal with nonce 0 but different milestone amount
    const fixtureB = await createValidProposalFixtures({ nonce: 0n, amount: 2_000_000n });
    const verifiedB = await verifyServerProposalSubmission(fixtureB.rawRequestBody, clientAccount.address, FIXED_NOW);

    const decision = evaluateProposalPersistence(verifiedB.rowToInsert, null, createdA);
    assert.strictEqual(decision.action, 'CONFLICT_NONCE');
    if (decision.action === 'CONFLICT_NONCE') {
      assert.match(decision.reason, /Proposal nonce conflict: nonce 0 already allocated/);
    }
  });

  // 23. Standard Protection fields enforced
  it('23. standard protection fields enforced (isProtected=false, module=0, policyId=0)', async () => {
    const { rawRequestBody } = await createValidProposalFixtures();

    const protectedBody = JSON.parse(JSON.stringify(rawRequestBody));
    protectedBody.proposal.isProtected = true;

    await assert.rejects(
      async () => {
        await verifyServerProposalSubmission(protectedBody, clientAccount.address, FIXED_NOW);
      },
      (err: any) => err instanceof ProposalValidationError && /isProtected = false/.test(err.message)
    );

    const moduleBody = JSON.parse(JSON.stringify(rawRequestBody));
    moduleBody.proposal.protectionModule = attackerAccount.address;

    await assert.rejects(
      async () => {
        await verifyServerProposalSubmission(moduleBody, clientAccount.address, FIXED_NOW);
      },
      (err: any) => err instanceof ProposalValidationError && /protectionModule = zero address/.test(err.message)
    );
  });

  // 24. EOA-only limitation preserved
  it('24. EOA-only limitation preserved (ECDSA verification recovers exact signer)', async () => {
    const { proposal, clientSignature } = await createValidProposalFixtures();
    const verified = await verifyServerProposalSubmission(
      (await createValidProposalFixtures()).rawRequestBody,
      clientAccount.address,
      FIXED_NOW
    );
    assert.strictEqual(verified.clientSignature, clientSignature);
    assert.strictEqual(normalizeWallet(verified.proposal.client), normalizeWallet(clientAccount.address));
  });

  // 25. Repository lifecycle cache update (updateStatus)
  it('25. repository updates status and terminal transaction metadata cleanly without altering immutable fields', async () => {
    const { rawRequestBody } = await createValidProposalFixtures();
    const verified = await verifyServerProposalSubmission(rawRequestBody, clientAccount.address, FIXED_NOW);
    const created = await inMemoryRepo.create(verified.rowToInsert);

    const dealInstanceAddress = '0x9999999999999999999999999999999999999999';
    const acceptTx = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const updated = await inMemoryRepo.updateStatus(created.proposalId, 'ACCEPTED', {
      dealAddress: dealInstanceAddress,
      txHash: acceptTx,
      terminalType: 'ACCEPTED',
    });

    assert.ok(updated);
    assert.strictEqual(updated.cachedStatus, 'ACCEPTED');
    assert.strictEqual(updated.dealAddress, normalizeWallet(dealInstanceAddress));
    assert.strictEqual(updated.acceptedTxHash, acceptTx);
    // Immutable fields remain unaltered
    assert.strictEqual(updated.proposalNonce, created.proposalNonce);
    assert.strictEqual(updated.clientSignature, created.clientSignature);
    assert.strictEqual(updated.milestonesHash, created.milestonesHash);
  });

  // 26. POST /api/deals/proposals route returns 401 when unauthenticated
  it('26. POST /api/deals/proposals returns 401 when unauthenticated', async () => {
    const { rawRequestBody } = await createValidProposalFixtures();
    const req = new NextRequest('http://localhost:3000/api/deals/proposals', {
      method: 'POST',
      body: JSON.stringify(rawRequestBody),
    });
    const res = await handlePostProposal(req);
    assert.strictEqual(res.status, 401);
    const data = await res.json();
    assert.strictEqual(data.error, 'Unauthorized');
  });

  // 27. POST /api/deals/proposals route returns 403 when authenticated as wrong caller
  it('27. POST /api/deals/proposals returns 403 when authenticated as stranger', async () => {
    const { rawRequestBody } = await createValidProposalFixtures();
    const attackerToken = signToken({ userId: 'u-attacker', walletAddress: attackerAccount.address });
    const req = new NextRequest('http://localhost:3000/api/deals/proposals', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${attackerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(rawRequestBody),
    });
    const res = await handlePostProposal(req);
    assert.strictEqual(res.status, 403);
    const data = await res.json();
    assert.strictEqual(data.error, 'Authenticated wallet does not match proposal client');
  });

  // 28. POST /api/deals/proposals route returns 201 Created on valid submission
  it('28. POST /api/deals/proposals returns 201 Created and persists proposal', async () => {
    const { rawRequestBody, proposalId } = await createValidProposalFixtures();
    const clientToken = signToken({ userId: 'u-client', walletAddress: clientAccount.address });
    const req = new NextRequest('http://localhost:3000/api/deals/proposals', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${clientToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(rawRequestBody),
    });
    const res = await handlePostProposal(req);
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.strictEqual(data.idempotent, false);
    assert.strictEqual(data.proposal.proposalId, proposalId);
    assert.strictEqual(data.proposal.cachedStatus, 'PENDING');

    // Verify stored in repository
    const stored = await inMemoryRepo.getById(proposalId);
    assert.ok(stored);
    assert.strictEqual(stored.proposalId, proposalId);
  });

  // 29. POST /api/deals/proposals returns 200 OK on duplicate idempotent submission
  it('29. POST /api/deals/proposals returns 200 OK with idempotent=true on exact duplicate replay', async () => {
    const { rawRequestBody } = await createValidProposalFixtures();
    const clientToken = signToken({ userId: 'u-client', walletAddress: clientAccount.address });

    // First submission
    const req1 = new NextRequest('http://localhost:3000/api/deals/proposals', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${clientToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(rawRequestBody),
    });
    const res1 = await handlePostProposal(req1);
    assert.strictEqual(res1.status, 201);

    // Replay duplicate submission
    const req2 = new NextRequest('http://localhost:3000/api/deals/proposals', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${clientToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(rawRequestBody),
    });
    const res2 = await handlePostProposal(req2);
    assert.strictEqual(res2.status, 200);
    const data2 = await res2.json();
    assert.strictEqual(data2.idempotent, true);
  });

  // 30. GET /api/deals/proposals/[proposalId] authorization and retrieval
  it('30. GET /api/deals/proposals/[proposalId] enforces authorization and returns proposal', async () => {
    const { rawRequestBody, proposalId } = await createValidProposalFixtures();
    const clientToken = signToken({ userId: 'u-client', walletAddress: clientAccount.address });
    const freelancerToken = signToken({ userId: 'u-freelancer', walletAddress: freelancerAccount.address });
    const attackerToken = signToken({ userId: 'u-attacker', walletAddress: attackerAccount.address });

    // Seed proposal via POST
    const postReq = new NextRequest('http://localhost:3000/api/deals/proposals', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${clientToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(rawRequestBody),
    });
    await handlePostProposal(postReq);

    // Unauthenticated GET -> 401
    const unauthGet = new NextRequest(`http://localhost:3000/api/deals/proposals/${proposalId}`);
    const unauthRes = await handleGetProposal(unauthGet, { params: { proposalId } });
    assert.strictEqual(unauthRes.status, 401);

    // Stranger GET -> 403
    const strangerGet = new NextRequest(`http://localhost:3000/api/deals/proposals/${proposalId}`, {
      headers: { authorization: `Bearer ${attackerToken}` },
    });
    const strangerRes = await handleGetProposal(strangerGet, { params: { proposalId } });
    assert.strictEqual(strangerRes.status, 403);

    // Client GET -> 200
    const clientGet = new NextRequest(`http://localhost:3000/api/deals/proposals/${proposalId}`, {
      headers: { authorization: `Bearer ${clientToken}` },
    });
    const clientRes = await handleGetProposal(clientGet, { params: { proposalId } });
    assert.strictEqual(clientRes.status, 200);
    const clientData = await clientRes.json();
    assert.strictEqual(clientData.proposal.proposalId, proposalId);

    // Freelancer GET -> 200
    const freelancerGet = new NextRequest(`http://localhost:3000/api/deals/proposals/${proposalId}`, {
      headers: { authorization: `Bearer ${freelancerToken}` },
    });
    const freelancerRes = await handleGetProposal(freelancerGet, { params: { proposalId } });
    assert.strictEqual(freelancerRes.status, 200);
    const freelancerData = await freelancerRes.json();
    assert.strictEqual(freelancerData.proposal.proposalId, proposalId);
  });
});
