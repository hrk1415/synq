// test/SynqV2MilestoneSubmissionRoute.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { getAddress, isAddress } from 'viem';
import { POST, GET } from '@/app/api/deals/[dealAddress]/milestones/[milestoneId]/submissions/route';
import {
  InMemoryMilestoneSubmissionRepository,
  setMilestoneSubmissionRepository,
  resetMilestoneSubmissionRepository,
} from '@/lib/deals/submissions-db';
import {
  hashEvidenceManifest,
  type CanonicalEvidenceManifestV1,
} from '@/lib/deals/v2-evidence';
import { signToken } from '@/lib/auth';
import { SEPOLIA_CHAIN_ID, SYNQ_V2_SEPOLIA_CONFIG } from '@/lib/contracts/addresses';
import { DealState, MilestoneStatus } from '@/lib/deals/v2-deal';
import { ZERO_BYTES32 } from '@/lib/deals/v2';
import { sepoliaPublicClient } from '@/lib/chain';

describe('SYNQ — B.12.4.12: Milestone Submission Route & Staging Flow Regression', () => {
  const TEST_CLIENT = '0xD2D4d415a4730b1490c9Ce27944529B83ff76319';
  const TEST_FREELANCER = '0xd646585Fb453be3698F6D959d796C1D86B832c04';
  const TEST_OUTSIDER = '0x1111111111111111111111111111111111111111';
  const TEST_DEAL_ADDRESS = '0xa443ebc00647a6a8128224328cd7d75bcd25fcc8';
  const TEST_SPEC_HASH = '0x1111111111111111111111111111111111111111111111111111111111111111' as `0x${string}`;

  let repo: InMemoryMilestoneSubmissionRepository;
  let freelancerToken: string;
  let clientToken: string;
  let outsiderToken: string;
  let originalReadContract: any;

  beforeEach(() => {
    repo = new InMemoryMilestoneSubmissionRepository();
    setMilestoneSubmissionRepository(repo);

    freelancerToken = signToken({
      userId: TEST_FREELANCER.toLowerCase(),
      walletAddress: TEST_FREELANCER.toLowerCase(),
    });
    clientToken = signToken({
      userId: TEST_CLIENT.toLowerCase(),
      walletAddress: TEST_CLIENT.toLowerCase(),
    });
    outsiderToken = signToken({
      userId: TEST_OUTSIDER.toLowerCase(),
      walletAddress: TEST_OUTSIDER.toLowerCase(),
    });

    // Mock readContract on sepoliaPublicClient to simulate active on-chain sequential deal
    originalReadContract = sepoliaPublicClient.readContract;
    (sepoliaPublicClient as any).readContract = async (params: any) => {
      const fn = params.functionName;
      if (fn === 'isDeal' || fn === 'isSynqDeal') return true;
      if (fn === 'client') return getAddress(TEST_CLIENT);
      if (fn === 'freelancer') return getAddress(TEST_FREELANCER);
      if (fn === 'usdc') return getAddress(SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc);
      if (fn === 'state') return DealState.Active;
      if (fn === 'totalEscrow') return 50_000_000n;
      if (fn === 'totalSettled') return 0n;
      if (fn === 'milestoneCount') return 1n;
      if (fn === 'isProtected') return false;
      if (fn === 'policyId') return ZERO_BYTES32;
      if (fn === 'primaryResolver') return getAddress(TEST_CLIENT);
      if (fn === 'emergencyResolver') return getAddress(TEST_CLIENT);
      if (fn === 'getMilestone') {
        return [
          50_000_000n,                         // amount
          1800000000n,                         // workDeadline
          86400n,                              // reviewWindow
          86400n,                              // gracePeriod
          MilestoneStatus.InProgress,          // status
          TEST_SPEC_HASH,                      // specHash
          ZERO_BYTES32,                        // evidenceRootHash
          0n,                                  // submittedAt
          0,                                   // version
        ];
      }
      throw new Error(`Unhandled readContract functionName: ${fn}`);
    };
  });

  afterEach(() => {
    resetMilestoneSubmissionRepository();
    (sepoliaPublicClient as any).readContract = originalReadContract;
  });

  function createValidManifest(overrides: Partial<CanonicalEvidenceManifestV1> = {}): CanonicalEvidenceManifestV1 {
    return {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Completed frontend responsive overhaul deliverable',
      links: [
        {
          type: 'pr',
          value: 'https://github.com/example/synq/pull/42',
          label: 'PR #42',
        },
      ],
      attachments: [],
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------------
  // 1. ROUTE PARAMETER & METHOD TESTS
  // ---------------------------------------------------------------------------

  it('1. POST rejects unauthenticated request with 401', async () => {
    const req = new NextRequest(`http://localhost:3001/api/deals/${TEST_DEAL_ADDRESS}/milestones/0/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: createValidManifest() }),
    });

    const res = await POST(req, {
      params: Promise.resolve({ dealAddress: TEST_DEAL_ADDRESS, milestoneId: '0' }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error, /Unauthorized: valid wallet session required/);
  });

  it('2. POST rejects invalid dealAddress in route parameter with 400', async () => {
    const req = new NextRequest('http://localhost:3001/api/deals/not-an-address/milestones/0/submissions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${freelancerToken}`,
      },
      body: JSON.stringify({ manifest: createValidManifest() }),
    });

    const res = await POST(req, {
      params: { dealAddress: 'not-an-address', milestoneId: '0' },
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Invalid dealAddress in route parameter/);
  });

  it('3. POST rejects invalid milestoneId in route parameter with 400', async () => {
    const req = new NextRequest(`http://localhost:3001/api/deals/${TEST_DEAL_ADDRESS}/milestones/-1/submissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${freelancerToken}`,
      },
      body: JSON.stringify({ manifest: createValidManifest() }),
    });

    const res = await POST(req, {
      params: { dealAddress: TEST_DEAL_ADDRESS, milestoneId: '-1' },
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Invalid milestoneId in route parameter/);
  });

  it('4. POST rejects mismatched manifest dealAddress vs route param with 400', async () => {
    const mismatchedManifest = createValidManifest({
      dealAddress: '0x1111111111111111111111111111111111111111',
    });

    const req = new NextRequest(`http://localhost:3001/api/deals/${TEST_DEAL_ADDRESS}/milestones/0/submissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${freelancerToken}`,
      },
      body: JSON.stringify({ manifest: mismatchedManifest }),
    });

    const res = await POST(req, {
      params: { dealAddress: TEST_DEAL_ADDRESS, milestoneId: '0' },
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /does not match route dealAddress/);
  });

  it('5. POST rejects mismatched manifest milestoneId vs route param with 400', async () => {
    const mismatchedManifest = createValidManifest({
      milestoneId: 1,
    });

    const req = new NextRequest(`http://localhost:3001/api/deals/${TEST_DEAL_ADDRESS}/milestones/0/submissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${freelancerToken}`,
      },
      body: JSON.stringify({ manifest: mismatchedManifest }),
    });

    const res = await POST(req, {
      params: { dealAddress: TEST_DEAL_ADDRESS, milestoneId: '0' },
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /does not match route milestoneId/);
  });

  it('6. POST rejects non-freelancer authorization with 403', async () => {
    const manifest = createValidManifest();

    const req = new NextRequest(`http://localhost:3001/api/deals/${TEST_DEAL_ADDRESS}/milestones/0/submissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${clientToken}`, // Client attempting to submit work
      },
      body: JSON.stringify({ manifest }),
    });

    const res = await POST(req, {
      params: { dealAddress: TEST_DEAL_ADDRESS, milestoneId: '0' },
    });

    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /designated freelancer/i);
  });

  // ---------------------------------------------------------------------------
  // 2. SUCCESSFUL STAGING & RETRIEVAL FLOW
  // ---------------------------------------------------------------------------

  it('7. POST successfully stages canonical evidence manifest for freelancer', async () => {
    const manifest = createValidManifest();
    const expectedHash = hashEvidenceManifest(manifest);

    const req = new NextRequest(`http://localhost:3001/api/deals/${TEST_DEAL_ADDRESS}/milestones/0/submissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${freelancerToken}`,
      },
      body: JSON.stringify({
        manifest,
        claimedEvidenceRootHash: expectedHash,
      }),
    });

    const res = await POST(req, {
      params: Promise.resolve({ dealAddress: TEST_DEAL_ADDRESS, milestoneId: '0' }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.version, 1);
    assert.equal(body.evidenceRootHash.toLowerCase(), expectedHash.toLowerCase());
    assert.equal(body.submission.status, 'staged');
    assert.equal(body.submission.dealAddress.toLowerCase(), TEST_DEAL_ADDRESS.toLowerCase());
    assert.equal(body.submission.milestoneId, 0);

    // Verify persisted in repository
    const stored = await repo.getByMilestoneVersion(SEPOLIA_CHAIN_ID, TEST_DEAL_ADDRESS, 0, 1);
    assert.ok(stored);
    assert.equal(stored.evidenceRootHash.toLowerCase(), expectedHash.toLowerCase());
  });

  it('8. GET returns 404 when no submission is staged or confirmed', async () => {
    const req = new NextRequest(`http://localhost:3001/api/deals/${TEST_DEAL_ADDRESS}/milestones/0/submissions?version=1`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${clientToken}`,
      },
    });

    const res = await GET(req, {
      params: { dealAddress: TEST_DEAL_ADDRESS, milestoneId: '0' },
    });

    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error, /Milestone submission not found/);
  });

  it('9. GET returns staged submission for authorized deal client and freelancer', async () => {
    // Stage first
    const manifest = createValidManifest();
    const expectedHash = hashEvidenceManifest(manifest);

    await repo.create({
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      freelancerWallet: TEST_FREELANCER,
      specHash: TEST_SPEC_HASH,
      evidenceRootHash: expectedHash,
      manifest: manifest as unknown as Record<string, unknown>,
      status: 'staged',
    });

    // Client queries
    const clientReq = new NextRequest(`http://localhost:3001/api/deals/${TEST_DEAL_ADDRESS}/milestones/0/submissions?version=1`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    const clientRes = await GET(clientReq, {
      params: { dealAddress: TEST_DEAL_ADDRESS, milestoneId: '0' },
    });
    assert.equal(clientRes.status, 200);
    const clientBody = await clientRes.json();
    assert.equal(clientBody.submission.evidenceRootHash.toLowerCase(), expectedHash.toLowerCase());

    // Freelancer queries
    const freelancerReq = new NextRequest(`http://localhost:3001/api/deals/${TEST_DEAL_ADDRESS}/milestones/0/submissions?version=1`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${freelancerToken}` },
    });
    const freelancerRes = await GET(freelancerReq, {
      params: { dealAddress: TEST_DEAL_ADDRESS, milestoneId: '0' },
    });
    assert.equal(freelancerRes.status, 200);

    // Outsider queries -> 403
    const outsiderReq = new NextRequest(`http://localhost:3001/api/deals/${TEST_DEAL_ADDRESS}/milestones/0/submissions?version=1`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    const outsiderRes = await GET(outsiderReq, {
      params: { dealAddress: TEST_DEAL_ADDRESS, milestoneId: '0' },
    });
    assert.equal(outsiderRes.status, 403);
  });
});
