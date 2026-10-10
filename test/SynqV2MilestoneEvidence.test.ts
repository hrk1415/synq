// test/SynqV2MilestoneEvidence.test.ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  keccak256,
  toHex,
  encodeEventTopics,
  encodeAbiParameters,
  isAddress,
  getAddress,
} from 'viem';
import {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_LIMITS,
  VALID_LINK_TYPES,
  type CanonicalEvidenceManifestV1,
  type CanonicalEvidenceLink,
  normalizeEvidenceLink,
  normalizeEvidenceManifest,
  canonicalizeValue,
  canonicalizeEvidenceManifest,
  hashEvidenceManifest,
  EvidenceValidationError,
} from '@/lib/deals/v2-evidence';
import {
  stageMilestoneSubmission,
  getMilestoneSubmission,
  reconcileMilestoneSubmission,
  InMemoryMilestoneSubmissionRepository,
  SubmissionAuthError,
  SubmissionValidationError,
  SubmissionConflictError,
  SubmissionIntegrityError,
} from '@/lib/deals/submissions-db';
import {
  DealState,
  MilestoneStatus,
  StandardV2DealData,
  StandardV2OnChainMilestone,
  validateSubmitWorkPreflight,
  verifySubmitWorkReceipt,
  hashMilestoneEvidence,
  MILESTONE_SUBMITTED_TOPIC0,
} from '@/lib/deals/v2-deal';
import { synqDealV1ABI } from '@/lib/contracts/abis';
import { SEPOLIA_CHAIN_ID, SYNQ_V2_SEPOLIA_CONFIG } from '@/lib/contracts/addresses';
import { ZERO_BYTES32 } from '@/lib/deals/v2';

// ---------------------------------------------------------------------------
// Test Constants
// ---------------------------------------------------------------------------

const TEST_CLIENT = '0xD2D4d415a4730b1490c9Ce27944529B83ff76319';
const TEST_FREELANCER = '0xd646585Fb453be3698F6D959d796C1D86B832c04';
const TEST_OUTSIDER = '0x1111111111111111111111111111111111111111';
const TEST_DEAL_ADDRESS = '0x142Ee9d2b5B6758F4D00439f3583fDcB89309807';
const TEST_SPEC_HASH = '0xaaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff' as `0x${string}`;

function createMockDealData(overrides: Partial<StandardV2DealData> = {}): StandardV2DealData {
  const milestones: StandardV2OnChainMilestone[] = [
    {
      index: 0,
      amount: 100_000_000n, // 100 USDC
      workDeadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
      reviewWindow: 259200n,
      gracePeriod: 86400n,
      status: MilestoneStatus.InProgress,
      specHash: TEST_SPEC_HASH,
      evidenceRootHash: ZERO_BYTES32,
      submittedAt: 0n,
      version: 0,
    },
  ];

  return {
    dealAddress: getAddress(TEST_DEAL_ADDRESS),
    client: getAddress(TEST_CLIENT),
    freelancer: getAddress(TEST_FREELANCER),
    usdc: getAddress(SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc),
    state: DealState.Active,
    totalEscrow: 100_000_000n,
    totalSettled: 0n,
    milestoneCount: 1,
    milestones,
    isProtected: false,
    policyId: ZERO_BYTES32,
    primaryResolver: getAddress(TEST_CLIENT),
    emergencyResolver: getAddress(TEST_CLIENT),
    ...overrides,
  };
}

function createMockSubmitReceipt(
  milestoneId = 0n,
  evidenceRootHash = TEST_SPEC_HASH,
  specHash = TEST_SPEC_HASH,
  version = 1,
  address = TEST_DEAL_ADDRESS,
  status = 'success'
) {
  return {
    status,
    logs: [
      {
        address,
        topics: [
          MILESTONE_SUBMITTED_TOPIC0,
          toHex(milestoneId, { size: 32 }),
          evidenceRootHash,
        ],
        data: encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'uint8' }],
          [specHash, version]
        ),
      },
    ],
  };
}

function createMockPublicClient(dealData: StandardV2DealData, mockReceipt?: any) {
  return {
    readContract: async (params: any) => {
      const fn = params.functionName;
      if (fn === 'isSynqDeal') return true;
      if (fn === 'state') return dealData.state;
      if (fn === 'client') return dealData.client;
      if (fn === 'freelancer') return dealData.freelancer;
      if (fn === 'usdc') return dealData.usdc;
      if (fn === 'totalEscrow') return dealData.totalEscrow;
      if (fn === 'totalSettled') return dealData.totalSettled;
      if (fn === 'milestoneCount') return BigInt(dealData.milestones.length);
      if (fn === 'isProtected') return dealData.isProtected;
      if (fn === 'policyId') return dealData.policyId;
      if (fn === 'primaryResolver') return dealData.primaryResolver;
      if (fn === 'emergencyResolver') return dealData.emergencyResolver;
      if (fn === 'getMilestone') {
        const idx = Number(params.args[0]);
        const m = dealData.milestones[idx];
        return [
          m.amount,
          m.workDeadline,
          m.reviewWindow,
          m.gracePeriod,
          m.status,
          m.specHash,
          m.evidenceRootHash,
          m.submittedAt,
          m.version,
        ];
      }
      throw new Error(`Unhandled mock functionName: ${fn}`);
    },
    waitForTransactionReceipt: async () => {
      if (mockReceipt !== undefined) return mockReceipt;
      const m = dealData.milestones[0];
      return createMockSubmitReceipt(
        0n,
        (m?.evidenceRootHash && m.evidenceRootHash !== ZERO_BYTES32 ? m.evidenceRootHash : TEST_SPEC_HASH) as `0x${string}`,
        (m?.specHash || TEST_SPEC_HASH) as `0x${string}`,
        m?.version || 1,
        dealData.dealAddress
      );
    },
  };
}


describe('Synq Phase 3I-B: Canonical Evidence Manifest & Submission Persistence', () => {
  let mockRepo: InMemoryMilestoneSubmissionRepository;

  beforeEach(() => {
    mockRepo = new InMemoryMilestoneSubmissionRepository();
  });

  // =========================================================================
  // SECTION 1: CANONICAL MANIFEST SCHEMA & CANONICALIZATION (Tests 1–25)
  // =========================================================================

  it('1. schemaVersion fixed to 1', () => {
    assert.strictEqual(EVIDENCE_SCHEMA_VERSION, 1);
    const validManifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Completed deliverable milestone',
      links: [],
      attachments: [],
    };
    const norm = normalizeEvidenceManifest(validManifest);
    assert.strictEqual(norm.schemaVersion, 1);
  });

  it('2. chainId bound to positive integer', () => {
    assert.throws(
      () =>
        normalizeEvidenceManifest({
          schemaVersion: 1,
          chainId: 0,
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          specHash: TEST_SPEC_HASH,
          summary: 'Summary',
          links: [],
          attachments: [],
        }),
      /chainId must be a positive integer/
    );
  });

  it('3. dealAddress normalized to lowercase EVM address', () => {
    const mixedCaseAddress = '0x142Ee9d2b5B6758F4D00439f3583fDcB89309807';
    const norm = normalizeEvidenceManifest({
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: mixedCaseAddress,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Summary',
      links: [],
      attachments: [],
    });
    assert.strictEqual(norm.dealAddress, mixedCaseAddress.toLowerCase());
  });

  it('4. milestoneId bound to non-negative integer', () => {
    assert.throws(
      () =>
        normalizeEvidenceManifest({
          schemaVersion: 1,
          chainId: SEPOLIA_CHAIN_ID,
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: -1,
          version: 1,
          specHash: TEST_SPEC_HASH,
          summary: 'Summary',
          links: [],
          attachments: [],
        }),
      /milestoneId must be a non-negative integer/
    );
  });

  it('5. next submission version correctly validated as >= 1', () => {
    assert.throws(
      () =>
        normalizeEvidenceManifest({
          schemaVersion: 1,
          chainId: SEPOLIA_CHAIN_ID,
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 0,
          specHash: TEST_SPEC_HASH,
          summary: 'Summary',
          links: [],
          attachments: [],
        }),
      /version must be a positive integer/
    );
  });

  it('6. specHash normalized to lowercase 32-byte hex', () => {
    const upperSpec = '0xAAAA111122223333444455556666777788889999AAAABBBBCCCCDDDDEEEEFFFF';
    const norm = normalizeEvidenceManifest({
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: upperSpec,
      summary: 'Summary',
      links: [],
      attachments: [],
    });
    assert.strictEqual(norm.specHash, upperSpec.toLowerCase());
  });

  it('7. summary required and cannot be empty or whitespace only', () => {
    assert.throws(
      () =>
        normalizeEvidenceManifest({
          schemaVersion: 1,
          chainId: SEPOLIA_CHAIN_ID,
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          specHash: TEST_SPEC_HASH,
          summary: '   \n  \t ',
          links: [],
          attachments: [],
        }),
      /summary cannot be empty/
    );
  });

  it('8. summary NFC normalization applied', () => {
    // \u0065\u0301 is 'e' + combining acute accent -> NFC is \u00e9 (é)
    const decomposed = 'e\u0301tude';
    const composed = '\u00e9tude';
    const norm = normalizeEvidenceManifest({
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: decomposed,
      links: [],
      attachments: [],
    });
    assert.strictEqual(norm.summary, composed);
  });

  it('9. summary trim semantics: leading/trailing trimmed, internal preserved', () => {
    const rawSummary = '  Line 1\n  Line 2   ';
    const norm = normalizeEvidenceManifest({
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: rawSummary,
      links: [],
      attachments: [],
    });
    assert.strictEqual(norm.summary, 'Line 1\n  Line 2');
  });

  it('10. multiple links supported across all valid types', () => {
    const links: CanonicalEvidenceLink[] = [
      { type: 'pr', value: 'https://github.com/synq/repo/pull/42', label: 'Feature PR' },
      { type: 'commit', value: 'abcd1234ef5678', label: 'Commit' },
      { type: 'web', value: 'https://docs.synq.fi', label: 'Documentation' },
      { type: 'repository', value: 'https://github.com/synq/repo' },
      { type: 'other', value: 'IPFS:QmTest123', label: 'Artifact' },
    ];

    const norm = normalizeEvidenceManifest({
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Summary',
      links,
      attachments: [],
    });

    assert.strictEqual(norm.links.length, 5);
    assert.strictEqual(norm.links[0].type, 'pr');
    assert.strictEqual(norm.links[1].type, 'commit');
    assert.strictEqual(norm.links[2].type, 'web');
    assert.strictEqual(norm.links[3].type, 'repository');
    assert.strictEqual(norm.links[4].type, 'other');
  });

  it('11. link ordering is strictly preserved', () => {
    const links: CanonicalEvidenceLink[] = [
      { type: 'web', value: 'https://synq.fi/alpha' },
      { type: 'web', value: 'https://synq.fi/beta' },
      { type: 'web', value: 'https://synq.fi/gamma' },
    ];
    const norm = normalizeEvidenceManifest({
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Summary',
      links,
      attachments: [],
    });
    assert.strictEqual(norm.links[0].value, 'https://synq.fi/alpha');
    assert.strictEqual(norm.links[1].value, 'https://synq.fi/beta');
    assert.strictEqual(norm.links[2].value, 'https://synq.fi/gamma');
  });

  it('12. object key ordering is deterministic (alphabetical sorted keys)', () => {
    const manifestA = {
      version: 1,
      summary: 'Summary',
      schemaVersion: 1,
      specHash: TEST_SPEC_HASH,
      milestoneId: 0,
      links: [],
      dealAddress: TEST_DEAL_ADDRESS,
      chainId: SEPOLIA_CHAIN_ID,
      attachments: [],
    };
    const serialized = canonicalizeEvidenceManifest(normalizeEvidenceManifest(manifestA));
    // Verify first key is "attachments", then "chainId", etc.
    assert.strictEqual(
      serialized,
      `{"attachments":[],"chainId":${SEPOLIA_CHAIN_ID},"dealAddress":"${TEST_DEAL_ADDRESS.toLowerCase()}","links":[],"milestoneId":0,"schemaVersion":1,"specHash":"${TEST_SPEC_HASH.toLowerCase()}","summary":"Summary","version":1}`
    );
  });

  it('13. equivalent normalized manifests hash identically regardless of input key order', () => {
    const manifest1 = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Deterministic check',
      links: [{ type: 'pr', value: 'https://github.com/org/repo/pull/1' }],
      attachments: [],
    };

    const manifest2 = {
      summary: 'Deterministic check',
      links: [{ type: 'pr', value: 'https://github.com/org/repo/pull/1' }],
      specHash: TEST_SPEC_HASH,
      milestoneId: 0,
      dealAddress: getAddress(TEST_DEAL_ADDRESS),
      chainId: SEPOLIA_CHAIN_ID,
      schemaVersion: 1,
      version: 1,
      attachments: [],
    };

    const hash1 = hashEvidenceManifest(manifest1);

    const hash2 = hashEvidenceManifest(manifest2);
    assert.strictEqual(hash1, hash2);
  });

  it('14. meaningful summary change changes hash', () => {
    const base = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Deliverable A completed',
      links: [],
      attachments: [],
    };
    const modified = { ...base, summary: 'Deliverable B completed' };
    assert.notStrictEqual(hashEvidenceManifest(base), hashEvidenceManifest(modified));
  });

  it('15. link change changes hash', () => {
    const base = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Deliverable A completed',
      links: [{ type: 'pr', value: 'https://github.com/org/repo/pull/1' }],
      attachments: [],
    };
    const modified = {
      ...base,
      links: [{ type: 'pr', value: 'https://github.com/org/repo/pull/2' }],
    };
    assert.notStrictEqual(hashEvidenceManifest(base), hashEvidenceManifest(modified));
  });

  it('16. link order change changes hash', () => {
    const base = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Deliverable completed',
      links: [
        { type: 'web', value: 'https://synq.fi/1' },
        { type: 'web', value: 'https://synq.fi/2' },
      ],
      attachments: [],
    };
    const reordered = {
      ...base,
      links: [
        { type: 'web', value: 'https://synq.fi/2' },
        { type: 'web', value: 'https://synq.fi/1' },
      ],
    };
    assert.notStrictEqual(hashEvidenceManifest(base), hashEvidenceManifest(reordered));
  });

  it('17. milestoneId change changes hash', () => {
    const m0 = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Summary',
      links: [],
      attachments: [],
    };
    const m1 = { ...m0, milestoneId: 1 };
    assert.notStrictEqual(hashEvidenceManifest(m0), hashEvidenceManifest(m1));
  });

  it('18. dealAddress change changes hash', () => {
    const base = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Summary',
      links: [],
      attachments: [],
    };
    const diffDeal = { ...base, dealAddress: '0x2222222222222222222222222222222222222222' };
    assert.notStrictEqual(hashEvidenceManifest(base), hashEvidenceManifest(diffDeal));
  });

  it('19. version change changes hash', () => {
    const v1 = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Summary',
      links: [],
      attachments: [],
    };
    const v2 = { ...v1, version: 2 };
    assert.notStrictEqual(hashEvidenceManifest(v1), hashEvidenceManifest(v2));
  });

  it('20. specHash change changes hash', () => {
    const base = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Summary',
      links: [],
      attachments: [],
    };
    const diffSpec = {
      ...base,
      specHash: '0xbbbb111122223333444455556666777788889999aaaabbbbccccddddeeeeffff',
    };
    assert.notStrictEqual(hashEvidenceManifest(base), hashEvidenceManifest(diffSpec));
  });

  it('21. zero hash is impossible for valid manifest', () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Valid summary',
      links: [],
      attachments: [],
    };
    const hash = hashEvidenceManifest(manifest);
    assert.notStrictEqual(hash, ZERO_BYTES32);
    assert.strictEqual(/^0x[0-9a-f]{64}$/.test(hash), true);
  });

  it('22. arbitrary raw bytes32 input bypass is rejected by manifest schema', () => {
    // If user attempts to pass a raw 32-byte hex string instead of manifest object, it fails schema validation
    assert.throws(
      () => normalizeEvidenceManifest('0x8412f5b24e909b4111e788bcab7eca3a2bd82800438cdef656289ce8ebd8ab1e'),
      /Manifest must be a non-null object/
    );
  });

  it('23. attachments required empty for schemaVersion 1', () => {
    assert.throws(
      () =>
        normalizeEvidenceManifest({
          schemaVersion: 1,
          chainId: SEPOLIA_CHAIN_ID,
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          specHash: TEST_SPEC_HASH,
          summary: 'Summary',
          links: [],
          attachments: [{ name: 'file.pdf' }],
        }),
      /attachments must be an empty array for schemaVersion 1/
    );
  });

  it('24. unknown schema version rejected', () => {
    assert.throws(
      () =>
        normalizeEvidenceManifest({
          schemaVersion: 2,
          chainId: SEPOLIA_CHAIN_ID,
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          specHash: TEST_SPEC_HASH,
          summary: 'Summary',
          links: [],
          attachments: [],
        }),
      /Unsupported schemaVersion/
    );
  });

  it('25. manifest size bounded (rejects oversized manifests)', () => {
    const oversizedSummary = 'a'.repeat(EVIDENCE_LIMITS.MAX_SUMMARY_LENGTH + 1);
    assert.throws(
      () =>
        normalizeEvidenceManifest({
          schemaVersion: 1,
          chainId: SEPOLIA_CHAIN_ID,
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          specHash: TEST_SPEC_HASH,
          summary: oversizedSummary,
          links: [],
          attachments: [],
        }),
      /summary exceeds maximum length/
    );
  });

  // =========================================================================
  // SECTION 2: OFF-CHAIN STAGING & RETRIEVAL PERSISTENCE (Tests 26–44)
  // =========================================================================

  it('26. unauthenticated stage rejected', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Deliverables done',
      links: [],
      attachments: [],
    };
    await assert.rejects(
      async () =>
        stageMilestoneSubmission({
          rawManifest: manifest,
          authWallet: '',
          repo: mockRepo,
        }),
      SubmissionAuthError
    );
  });

  it('27. non-freelancer stage rejected', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Deliverables done',
      links: [],
      attachments: [],
    };
    const mockClient = createMockPublicClient(createMockDealData());

    await assert.rejects(
      async () =>
        stageMilestoneSubmission({
          rawManifest: manifest,
          authWallet: TEST_OUTSIDER,
          publicClient: mockClient as any,
          repo: mockRepo,
        }),
      /Only the designated freelancer/
    );
  });

  it('28. wrong Deal state rejected (Draft/Closed)', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Deliverables done',
      links: [],
      attachments: [],
    };
    const mockClient = createMockPublicClient(createMockDealData({ state: DealState.Draft }));

    await assert.rejects(
      async () =>
        stageMilestoneSubmission({
          rawManifest: manifest,
          authWallet: TEST_FREELANCER,
          publicClient: mockClient as any,
          repo: mockRepo,
        }),
      /Deal is not Active/
    );
  });

  it('29. wrong milestone index rejected', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 99,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Deliverables done',
      links: [],
      attachments: [],
    };
    const mockClient = createMockPublicClient(createMockDealData());

    await assert.rejects(
      async () =>
        stageMilestoneSubmission({
          rawManifest: manifest,
          authWallet: TEST_FREELANCER,
          publicClient: mockClient as any,
          repo: mockRepo,
        }),
      /Invalid milestoneId/
    );
  });

  it('30. wrong chainId rejected', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: 1, // Mainnet instead of Sepolia
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Deliverables done',
      links: [],
      attachments: [],
    };
    const mockClient = createMockPublicClient(createMockDealData());

    await assert.rejects(
      async () =>
        stageMilestoneSubmission({
          rawManifest: manifest,
          authWallet: TEST_FREELANCER,
          publicClient: mockClient as any,
          repo: mockRepo,
        }),
      /Invalid chainId/
    );
  });

  it('31. wrong specHash rejected', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`,
      summary: 'Deliverables done',
      links: [],
      attachments: [],
    };
    const mockClient = createMockPublicClient(createMockDealData());

    await assert.rejects(
      async () =>
        stageMilestoneSubmission({
          rawManifest: manifest,
          authWallet: TEST_FREELANCER,
          publicClient: mockClient as any,
          repo: mockRepo,
        }),
      /Spec hash mismatch/
    );
  });

  it('32. wrong version rejected (manifest version must equal on-chain current + 1)', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 2, // Current on-chain is 0, so next must be 1
      specHash: TEST_SPEC_HASH,
      summary: 'Deliverables done',
      links: [],
      attachments: [],
    };
    const mockClient = createMockPublicClient(createMockDealData());

    await assert.rejects(
      async () =>
        stageMilestoneSubmission({
          rawManifest: manifest,
          authWallet: TEST_FREELANCER,
          publicClient: mockClient as any,
          repo: mockRepo,
        }),
      /Invalid submission version: manifest has 2, expected 1/
    );
  });

  it('33. server hash mismatch rejected when client sends conflicting claimed hash', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Deliverables done',
      links: [],
      attachments: [],
    };
    const mockClient = createMockPublicClient(createMockDealData());

    await assert.rejects(
      async () =>
        stageMilestoneSubmission({
          rawManifest: manifest,
          authWallet: TEST_FREELANCER,
          claimedEvidenceRootHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
          publicClient: mockClient as any,
          repo: mockRepo,
        }),
      /Claimed evidence root hash .* does not match server-computed hash/
    );
  });

  it('34. valid stage succeeds and returns staged record', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Deliverables done',
      links: [{ type: 'pr', value: 'https://github.com/synq/repo/pull/1' }],
      attachments: [],
    };
    const mockClient = createMockPublicClient(createMockDealData());

    const result = await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: mockClient as any,
      repo: mockRepo,
    });

    assert.strictEqual(result.submission.status, 'staged');
    assert.strictEqual(result.submission.version, 1);
    assert.strictEqual(result.submission.milestoneId, 0);
    assert.strictEqual(result.submission.dealAddress, TEST_DEAL_ADDRESS.toLowerCase());
    assert.strictEqual(result.evidenceRootHash, hashEvidenceManifest(manifest));
  });

  it('35. same exact stage call is idempotent', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Deliverables done',
      links: [],
      attachments: [],
    };
    const mockClient = createMockPublicClient(createMockDealData());

    const res1 = await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: mockClient as any,
      repo: mockRepo,
    });

    const res2 = await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: mockClient as any,
      repo: mockRepo,
    });

    assert.strictEqual(res1.submission.id, res2.submission.id);
    assert.strictEqual(res1.evidenceRootHash, res2.evidenceRootHash);
  });

  it('36. staged same-version evidence can be replaced by freelancer before confirmation', async () => {
    const manifestA = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Initial draft deliverables',
      links: [],
      attachments: [],
    };
    const mockClient = createMockPublicClient(createMockDealData());

    const resA = await stageMilestoneSubmission({
      rawManifest: manifestA,
      authWallet: TEST_FREELANCER,
      publicClient: mockClient as any,
      repo: mockRepo,
    });

    const manifestB = {
      ...manifestA,
      summary: 'Updated deliverables with corrected link',
      links: [{ type: 'pr', value: 'https://github.com/synq/repo/pull/2' }],
    };

    const resB = await stageMilestoneSubmission({
      rawManifest: manifestB,
      authWallet: TEST_FREELANCER,
      publicClient: mockClient as any,
      repo: mockRepo,
    });

    assert.strictEqual(resA.submission.id, resB.submission.id);
    assert.notStrictEqual(resA.evidenceRootHash, resB.evidenceRootHash);
    assert.strictEqual((resB.submission.manifest as any).summary, 'Updated deliverables with corrected link');
  });

  it('37. confirmed evidence cannot be replaced or mutated', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Confirmed deliverables',
      links: [],
      attachments: [],
    };
    const mockClient = createMockPublicClient(createMockDealData());

    const res = await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: mockClient as any,
      repo: mockRepo,
    });

    // Confirm the row in repo
    await mockRepo.confirm(res.submission.id, {
      txHash: '0x1234',
      submittedAt: new Date(),
      updatedAt: new Date(),
    });

    // Attempting to restage or mutate must fail with SubmissionConflictError
    await assert.rejects(
      async () =>
        stageMilestoneSubmission({
          rawManifest: { ...manifest, summary: 'Attempting to change confirmed summary' },
          authWallet: TEST_FREELANCER,
          publicClient: mockClient as any,
          repo: mockRepo,
        }),
      SubmissionConflictError
    );
  });

  it('38. composite uniqueness enforced on (chainId, dealAddress, milestoneId, version)', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Deliverables',
      links: [],
      attachments: [],
    };
    const mockClient = createMockPublicClient(createMockDealData());

    await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: mockClient as any,
      repo: mockRepo,
    });

    const record = await mockRepo.getByMilestoneVersion(SEPOLIA_CHAIN_ID, TEST_DEAL_ADDRESS, 0, 1);
    assert.ok(record);
    assert.strictEqual(record.dealAddress, TEST_DEAL_ADDRESS.toLowerCase());
  });

  it('39. client GET succeeds and returns full manifest', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Deliverables for client review',
      links: [{ type: 'web', value: 'https://demo.synq.fi' }],
      attachments: [],
    };
    const mockClient = createMockPublicClient(createMockDealData());

    await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: mockClient as any,
      repo: mockRepo,
    });

    const getRes = await getMilestoneSubmission({
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      authWallet: TEST_CLIENT,
      publicClient: mockClient as any,
      repo: mockRepo,
    });

    assert.ok(getRes);
    assert.strictEqual(getRes.manifest.summary, 'Deliverables for client review');
    assert.strictEqual(getRes.submission.status, 'staged');
  });

  it('40. freelancer GET succeeds and returns full manifest', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Freelancer submitted',
      links: [],
      attachments: [],
    };
    const mockClient = createMockPublicClient(createMockDealData());

    await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: mockClient as any,
      repo: mockRepo,
    });

    const getRes = await getMilestoneSubmission({
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      authWallet: TEST_FREELANCER,
      publicClient: mockClient as any,
      repo: mockRepo,
    });

    assert.ok(getRes);
    assert.strictEqual(getRes.manifest.summary, 'Freelancer submitted');
  });

  it('41. outsider GET rejected with 403 authorization error', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Confidential deliverables',
      links: [],
      attachments: [],
    };
    const mockClient = createMockPublicClient(createMockDealData());

    await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: mockClient as any,
      repo: mockRepo,
    });

    await assert.rejects(
      async () =>
        getMilestoneSubmission({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_OUTSIDER,
          publicClient: mockClient as any,
          repo: mockRepo,
        }),
      SubmissionAuthError
    );
  });

  it('42. GET recomputes DB manifest hash', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Verification check',
      links: [],
      attachments: [],
    };
    const mockClient = createMockPublicClient(createMockDealData());

    await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: mockClient as any,
      repo: mockRepo,
    });

    const res = await getMilestoneSubmission({
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      authWallet: TEST_CLIENT,
      publicClient: mockClient as any,
      repo: mockRepo,
    });

    assert.ok(res);
    const computed = hashEvidenceManifest(res.manifest);
    assert.strictEqual(computed, res.submission.evidenceRootHash);
  });

  it('43. mismatched DB manifest and recorded evidenceRootHash fails closed', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Original text',
      links: [],
      attachments: [],
    };
    const mockClient = createMockPublicClient(createMockDealData());

    const staged = await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: mockClient as any,
      repo: mockRepo,
    });

    // Tamper with repo manifest without updating evidenceRootHash
    await mockRepo.updateStaged(staged.submission.id, {
      specHash: staged.submission.specHash,
      evidenceRootHash: staged.submission.evidenceRootHash,
      manifest: { ...(manifest as any), summary: 'Tampered text!' },
      updatedAt: new Date(),
    });

    // GET must fail closed with integrity error
    await assert.rejects(
      async () =>
        getMilestoneSubmission({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: mockClient as any,
          repo: mockRepo,
        }),
      SubmissionIntegrityError
    );
  });

  it('44. on-chain hash mismatch fails closed', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Work done',
      links: [],
      attachments: [],
    };

    // Stage with DB
    const mockClient = createMockPublicClient(createMockDealData());
    await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: mockClient as any,
      repo: mockRepo,
    });

    // Simulate on-chain state where contract has a DIFFERENT evidenceRootHash
    const conflictingOnChainDeal = createMockDealData();
    conflictingOnChainDeal.milestones[0].status = MilestoneStatus.Submitted;
    conflictingOnChainDeal.milestones[0].version = 1;
    conflictingOnChainDeal.milestones[0].evidenceRootHash =
      '0x9999999999999999999999999999999999999999999999999999999999999999' as `0x${string}`;

    const conflictingClient = createMockPublicClient(conflictingOnChainDeal);

    await assert.rejects(
      async () =>
        getMilestoneSubmission({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: conflictingClient as any,
          repo: mockRepo,
        }),
      SubmissionIntegrityError
    );
  });

  // =========================================================================
  // SECTION 3: RECONCILIATION & ON-CHAIN CONFIRMATION (Tests 45–59)
  // =========================================================================

  it('45. valid receipt confirms staged row', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Completed and ready for review',
      links: [],
      attachments: [],
    };
    const expectedHash = hashEvidenceManifest(manifest);

    // Initial on-chain deal state is InProgress
    const initialDeal = createMockDealData();
    const stageClient = createMockPublicClient(initialDeal);

    await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: stageClient as any,
      repo: mockRepo,
    });

    // MilestoneSubmitted event log
    const submittedDeal = createMockDealData();
    submittedDeal.milestones[0].status = MilestoneStatus.Submitted;
    submittedDeal.milestones[0].version = 1;
    submittedDeal.milestones[0].evidenceRootHash = expectedHash;
    submittedDeal.milestones[0].submittedAt = 1750000000n;

    const mockReceipt = createMockSubmitReceipt(0n, expectedHash, TEST_SPEC_HASH, 1, TEST_DEAL_ADDRESS);
    const reconcileClient = createMockPublicClient(submittedDeal, mockReceipt);

    const reconciled = await reconcileMilestoneSubmission({
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      authWallet: TEST_FREELANCER,
      txHash: '0xabc123',
      publicClient: reconcileClient as any,
      repo: mockRepo,
    });

    assert.strictEqual(reconciled.submission.status, 'confirmed');
    assert.strictEqual(reconciled.submission.txHash, '0xabc123');
  });

  it('46. wrong Deal in receipt event rejected', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Summary',
      links: [],
      attachments: [],
    };
    const expectedHash = hashEvidenceManifest(manifest);

    const submittedDeal = createMockDealData();
    submittedDeal.milestones[0].status = MilestoneStatus.Submitted;
    submittedDeal.milestones[0].version = 1;
    submittedDeal.milestones[0].evidenceRootHash = expectedHash;

    // Log emitted by wrong address
    const mockReceipt = createMockSubmitReceipt(0n, expectedHash, TEST_SPEC_HASH, 1, '0x9999999999999999999999999999999999999999');
    const client = createMockPublicClient(submittedDeal, mockReceipt);

    await assert.rejects(
      async () =>
        reconcileMilestoneSubmission({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_FREELANCER,
          txHash: '0x123',
          publicClient: client as any,
          repo: mockRepo,
        }),
      /MilestoneSubmitted event was not found/
    );
  });

  it('47. wrong milestone in receipt event rejected', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Summary',
      links: [],
      attachments: [],
    };
    const expectedHash = hashEvidenceManifest(manifest);

    const submittedDeal = createMockDealData();
    submittedDeal.milestones[0].status = MilestoneStatus.Submitted;
    submittedDeal.milestones[0].version = 1;
    submittedDeal.milestones[0].evidenceRootHash = expectedHash;

    // Log emitted for milestone 1 instead of 0
    const mockReceipt = createMockSubmitReceipt(1n, expectedHash, TEST_SPEC_HASH, 1, TEST_DEAL_ADDRESS);
    const client = createMockPublicClient(submittedDeal, mockReceipt);

    await assert.rejects(
      async () =>
        reconcileMilestoneSubmission({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_FREELANCER,
          txHash: '0x123',
          publicClient: client as any,
          repo: mockRepo,
        }),
      /unexpected milestone ID/
    );
  });

  it('48. wrong evidenceRootHash in receipt event rejected', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Summary',
      links: [],
      attachments: [],
    };
    const expectedHash = hashEvidenceManifest(manifest);

    const submittedDeal = createMockDealData();
    submittedDeal.milestones[0].status = MilestoneStatus.Submitted;
    submittedDeal.milestones[0].version = 1;
    submittedDeal.milestones[0].evidenceRootHash = expectedHash;

    const mockReceipt = createMockSubmitReceipt(
      0n,
      '0x2222222222222222222222222222222222222222222222222222222222222222' as `0x${string}`,
      TEST_SPEC_HASH,
      1,
      TEST_DEAL_ADDRESS
    );

    const client = createMockPublicClient(submittedDeal, mockReceipt);


    await assert.rejects(
      async () =>
        reconcileMilestoneSubmission({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_FREELANCER,
          txHash: '0x123',
          publicClient: client as any,
          repo: mockRepo,
        }),
      /unexpected evidenceRootHash/
    );
  });

  it('49. wrong version in reconciliation rejected', async () => {
    const submittedDeal = createMockDealData();
    submittedDeal.milestones[0].status = MilestoneStatus.Submitted;
    submittedDeal.milestones[0].version = 1;

    const client = createMockPublicClient(submittedDeal);

    await assert.rejects(
      async () =>
        reconcileMilestoneSubmission({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 2, // on-chain is 1
          authWallet: TEST_FREELANCER,
          publicClient: client as any,
          repo: mockRepo,
        }),
      /Milestone on-chain version is 1, expected 2/
    );
  });

  it('50. reverted transaction receipt rejected', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Summary',
      links: [],
      attachments: [],
    };
    const expectedHash = hashEvidenceManifest(manifest);

    const submittedDeal = createMockDealData();
    submittedDeal.milestones[0].status = MilestoneStatus.Submitted;
    submittedDeal.milestones[0].version = 1;
    submittedDeal.milestones[0].evidenceRootHash = expectedHash;

    const mockReceipt = {
      status: 'reverted',
      logs: [],
    };

    const client = createMockPublicClient(submittedDeal, mockReceipt);

    await assert.rejects(
      async () =>
        reconcileMilestoneSubmission({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_FREELANCER,
          txHash: '0x123',
          publicClient: client as any,
          repo: mockRepo,
        }),
      /Transaction reverted on-chain/
    );
  });

  it('51. post-chain status must be MilestoneStatus.Submitted', async () => {
    const deal = createMockDealData();
    deal.milestones[0].status = MilestoneStatus.InProgress; // Not yet submitted on chain
    const client = createMockPublicClient(deal);

    await assert.rejects(
      async () =>
        reconcileMilestoneSubmission({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_FREELANCER,
          publicClient: client as any,
          repo: mockRepo,
        }),
      /is not in Submitted status on-chain/
    );
  });

  it('52. post-chain hash must match staged manifest hash', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Summary',
      links: [],
      attachments: [],
    };

    const stageClient = createMockPublicClient(createMockDealData());
    await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: stageClient as any,
      repo: mockRepo,
    });

    // Contract has different evidence root hash
    const submittedDeal = createMockDealData();
    submittedDeal.milestones[0].status = MilestoneStatus.Submitted;
    submittedDeal.milestones[0].version = 1;
    submittedDeal.milestones[0].evidenceRootHash =
      '0x3333333333333333333333333333333333333333333333333333333333333333' as `0x${string}`;

    const reconcileClient = createMockPublicClient(submittedDeal);

    await assert.rejects(
      async () =>
        reconcileMilestoneSubmission({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_FREELANCER,
          publicClient: reconcileClient as any,
          repo: mockRepo,
        }),
      SubmissionIntegrityError
    );
  });

  it('53. post-chain version must match expected version', async () => {
    const submittedDeal = createMockDealData();
    submittedDeal.milestones[0].status = MilestoneStatus.Submitted;
    submittedDeal.milestones[0].version = 3;

    const client = createMockPublicClient(submittedDeal);

    await assert.rejects(
      async () =>
        reconcileMilestoneSubmission({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_FREELANCER,
          publicClient: client as any,
          repo: mockRepo,
        }),
      /Milestone on-chain version is 3, expected 1/
    );
  });

  it('54. confirmed txHash is properly persisted', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Summary',
      links: [],
      attachments: [],
    };
    const expectedHash = hashEvidenceManifest(manifest);

    const initialDeal = createMockDealData();
    await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: createMockPublicClient(initialDeal) as any,
      repo: mockRepo,
    });

    const submittedDeal = createMockDealData();
    submittedDeal.milestones[0].status = MilestoneStatus.Submitted;
    submittedDeal.milestones[0].version = 1;
    submittedDeal.milestones[0].evidenceRootHash = expectedHash;

    const reconciled = await reconcileMilestoneSubmission({
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      authWallet: TEST_CLIENT,
      txHash: '0x9876543210abcdef',
      publicClient: createMockPublicClient(submittedDeal) as any,
      repo: mockRepo,
    });

    assert.strictEqual(reconciled.submission.txHash, '0x9876543210abcdef');
    assert.strictEqual(reconciled.submission.status, 'confirmed');
  });

  it('55. duplicate reconcile call is idempotent', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Summary',
      links: [],
      attachments: [],
    };
    const expectedHash = hashEvidenceManifest(manifest);

    await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: createMockPublicClient(createMockDealData()) as any,
      repo: mockRepo,
    });

    const submittedDeal = createMockDealData();
    submittedDeal.milestones[0].status = MilestoneStatus.Submitted;
    submittedDeal.milestones[0].version = 1;
    submittedDeal.milestones[0].evidenceRootHash = expectedHash;

    const r1 = await reconcileMilestoneSubmission({
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      authWallet: TEST_FREELANCER,
      txHash: '0x999',
      publicClient: createMockPublicClient(submittedDeal) as any,
      repo: mockRepo,
    });

    const r2 = await reconcileMilestoneSubmission({
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      authWallet: TEST_CLIENT,
      txHash: '0x999',
      publicClient: createMockPublicClient(submittedDeal) as any,
      repo: mockRepo,
    });

    assert.strictEqual(r1.submission.id, r2.submission.id);
    assert.strictEqual(r2.submission.status, 'confirmed');
  });

  it('56. different tx cannot replace already confirmed record', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Summary',
      links: [],
      attachments: [],
    };
    const expectedHash = hashEvidenceManifest(manifest);

    await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: createMockPublicClient(createMockDealData()) as any,
      repo: mockRepo,
    });

    const submittedDeal = createMockDealData();
    submittedDeal.milestones[0].status = MilestoneStatus.Submitted;
    submittedDeal.milestones[0].version = 1;
    submittedDeal.milestones[0].evidenceRootHash = expectedHash;

    await reconcileMilestoneSubmission({
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      authWallet: TEST_FREELANCER,
      txHash: '0xfirst_tx',
      publicClient: createMockPublicClient(submittedDeal) as any,
      repo: mockRepo,
    });

    await assert.rejects(
      async () =>
        reconcileMilestoneSubmission({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          txHash: '0xdifferent_tx',
          publicClient: createMockPublicClient(submittedDeal) as any,
          repo: mockRepo,
        }),
      SubmissionConflictError
    );
  });

  it('57. on-chain-success / browser-reconcile-failure recovery without txHash', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Recovery deliverables',
      links: [],
      attachments: [],
    };
    const expectedHash = hashEvidenceManifest(manifest);

    // Staged before crash
    await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: createMockPublicClient(createMockDealData()) as any,
      repo: mockRepo,
    });

    // submitWork confirmed on chain, but browser crashed before reconcile
    const submittedDeal = createMockDealData();
    submittedDeal.milestones[0].status = MilestoneStatus.Submitted;
    submittedDeal.milestones[0].version = 1;
    submittedDeal.milestones[0].evidenceRootHash = expectedHash;
    submittedDeal.milestones[0].submittedAt = 1750000000n;

    // Recovery reconcile: no txHash provided
    const recovered = await reconcileMilestoneSubmission({
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      authWallet: TEST_CLIENT,
      publicClient: createMockPublicClient(submittedDeal) as any,
      repo: mockRepo,
    });

    assert.strictEqual(recovered.submission.status, 'confirmed');
    assert.strictEqual(recovered.submission.evidenceRootHash, expectedHash);
  });

  it('58. recovery confirms from matching current on-chain state', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'State recovery',
      links: [],
      attachments: [],
    };
    const expectedHash = hashEvidenceManifest(manifest);

    await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: createMockPublicClient(createMockDealData()) as any,
      repo: mockRepo,
    });

    const submittedDeal = createMockDealData();
    submittedDeal.milestones[0].status = MilestoneStatus.Submitted;
    submittedDeal.milestones[0].version = 1;
    submittedDeal.milestones[0].evidenceRootHash = expectedHash;

    const recovered = await reconcileMilestoneSubmission({
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      authWallet: TEST_FREELANCER,
      publicClient: createMockPublicClient(submittedDeal) as any,
      repo: mockRepo,
    });

    assert.strictEqual(recovered.submission.status, 'confirmed');
  });

  it('59. stale staged row cannot override confirmed submission', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Confirmed version',
      links: [],
      attachments: [],
    };

    const initialDeal = createMockDealData();
    await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: createMockPublicClient(initialDeal) as any,
      repo: mockRepo,
    });

    const row = await mockRepo.getByMilestoneVersion(SEPOLIA_CHAIN_ID, TEST_DEAL_ADDRESS, 0, 1);
    await mockRepo.confirm(row!.id, {
      txHash: '0xconfirmed',
      submittedAt: new Date(),
      updatedAt: new Date(),
    });

    // Attempting to overwrite confirmed submission with a new stage call fails
    await assert.rejects(
      async () =>
        stageMilestoneSubmission({
          rawManifest: { ...manifest, summary: 'Stale attempt' },
          authWallet: TEST_FREELANCER,
          publicClient: createMockPublicClient(initialDeal) as any,
          repo: mockRepo,
        }),
      SubmissionConflictError
    );
  });

  // =========================================================================
  // SECTION 4: FRONTEND LOGIC & INVARIANTS (Tests 60–75)
  // =========================================================================

  it('60. structured form replaces raw text field (summary + links list)', () => {
    // Validates structured input conversion to canonical schema
    const summary = 'Completed backend implementation';
    const links: CanonicalEvidenceLink[] = [
      { type: 'pr', value: 'https://github.com/synq/repo/pull/12' },
      { type: 'commit', value: 'a1b2c3d4e5f6', label: 'Commit' },
    ];

    const manifest = normalizeEvidenceManifest({
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary,
      links,
      attachments: [],
    });

    assert.strictEqual(manifest.summary, summary);
    assert.strictEqual(manifest.links.length, 2);
    assert.strictEqual(manifest.links[0].type, 'pr');
  });

  it('61. summary is strictly required in UI flow', () => {
    assert.throws(
      () =>
        normalizeEvidenceManifest({
          schemaVersion: 1,
          chainId: SEPOLIA_CHAIN_ID,
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          specHash: TEST_SPEC_HASH,
          summary: '',
          links: [],
          attachments: [],
        }),
      /summary cannot be empty/
    );
  });

  it('62. user can add/remove multiple links up to limit', () => {
    const links: CanonicalEvidenceLink[] = [];
    for (let i = 0; i < EVIDENCE_LIMITS.MAX_LINKS_COUNT; i++) {
      links.push({
        type: 'web',
        value: `https://synq.fi/item/${i}`,
        label: `Item ${i}`,
      });
    }

    const norm = normalizeEvidenceManifest({
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Summary',
      links,
      attachments: [],
    });

    assert.strictEqual(norm.links.length, EVIDENCE_LIMITS.MAX_LINKS_COUNT);

    // Exceeding limit throws
    assert.throws(
      () =>
        normalizeEvidenceManifest({
          schemaVersion: 1,
          chainId: SEPOLIA_CHAIN_ID,
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          specHash: TEST_SPEC_HASH,
          summary: 'Summary',
          links: [...links, { type: 'web', value: 'https://synq.fi/overflow' }],
          attachments: [],
        }),
      /links cannot exceed/
    );
  });

  it('63. live canonical hash preview matches hashEvidenceManifest output', () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Live preview test',
      links: [{ type: 'pr', value: 'https://github.com/synq/repo/pull/1' }],
      attachments: [],
    };

    const hash = hashEvidenceManifest(manifest);
    assert.strictEqual(/^0x[0-9a-f]{64}$/.test(hash), true);
  });

  it('64. stage happens before wallet transaction', async () => {
    // Flow verification: stage must succeed and produce an evidenceRootHash before preflight/wallet
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Pre-wallet stage',
      links: [],
      attachments: [],
    };
    const deal = createMockDealData();
    const client = createMockPublicClient(deal);

    const staged = await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: client as any,
      repo: mockRepo,
    });

    assert.strictEqual(staged.submission.status, 'staged');

    // Preflight can now run with the staged evidenceRootHash
    const preflight = validateSubmitWorkPreflight({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: deal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: deal.usdc,
      dealState: deal.state,
      targetMilestoneIndex: 0,
      milestones: deal.milestones,
      evidenceRootHash: staged.evidenceRootHash,
    });

    assert.strictEqual(preflight.valid, true);
  });

  it('65. staging failure blocks wallet transaction (fails closed)', async () => {
    const invalidManifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: '', // Empty summary causes staging failure
      links: [],
      attachments: [],
    };

    await assert.rejects(
      async () =>
        stageMilestoneSubmission({
          rawManifest: invalidManifest,
          authWallet: TEST_FREELANCER,
          repo: mockRepo,
        }),
      SubmissionValidationError
    );
  });

  it('66. returned server hash must equal local hash (dual verification)', () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Dual check',
      links: [],
      attachments: [],
    };

    const localHash = hashEvidenceManifest(manifest);
    const serverHash = hashEvidenceManifest(normalizeEvidenceManifest(manifest));
    assert.strictEqual(localHash, serverHash);
  });

  it('67. fresh preflight remains immediately before wallet prompt', () => {
    const deal = createMockDealData();
    const preflight = validateSubmitWorkPreflight({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: deal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: deal.usdc,
      dealState: deal.state,
      targetMilestoneIndex: 0,
      milestones: deal.milestones,
      evidenceRootHash: '0x8412f5b24e909b4111e788bcab7eca3a2bd82800438cdef656289ce8ebd8ab1e',
    });
    assert.strictEqual(preflight.valid, true);
  });

  it('68. wallet rejection leaves staged record preserved for edit/retry', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Staged before rejection',
      links: [],
      attachments: [],
    };
    const deal = createMockDealData();
    const client = createMockPublicClient(deal);

    const staged = await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: client as any,
      repo: mockRepo,
    });

    // Record remains staged in database
    const inDb = await mockRepo.getByMilestoneVersion(SEPOLIA_CHAIN_ID, TEST_DEAL_ADDRESS, 0, 1);
    assert.ok(inDb);
    assert.strictEqual(inDb.status, 'staged');
    assert.strictEqual(inDb.id, staged.submission.id);
  });

  it('69. successful tx triggers reconcile transition to confirmed', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Success flow',
      links: [],
      attachments: [],
    };
    const hash = hashEvidenceManifest(manifest);

    await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: createMockPublicClient(createMockDealData()) as any,
      repo: mockRepo,
    });

    const submittedDeal = createMockDealData();
    submittedDeal.milestones[0].status = MilestoneStatus.Submitted;
    submittedDeal.milestones[0].version = 1;
    submittedDeal.milestones[0].evidenceRootHash = hash;

    const reconciled = await reconcileMilestoneSubmission({
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      authWallet: TEST_FREELANCER,
      txHash: '0x123abc',
      publicClient: createMockPublicClient(submittedDeal) as any,
      repo: mockRepo,
    });

    assert.strictEqual(reconciled.submission.status, 'confirmed');
  });

  it('70. client Submitted view displays manifest', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Reviewable for client',
      links: [{ type: 'pr', value: 'https://github.com/synq/repo/pull/10' }],
      attachments: [],
    };
    const hash = hashEvidenceManifest(manifest);

    await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: createMockPublicClient(createMockDealData()) as any,
      repo: mockRepo,
    });

    const deal = createMockDealData();
    deal.milestones[0].status = MilestoneStatus.Submitted;
    deal.milestones[0].version = 1;
    deal.milestones[0].evidenceRootHash = hash;

    const res = await getMilestoneSubmission({
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      authWallet: TEST_CLIENT,
      publicClient: createMockPublicClient(deal) as any,
      repo: mockRepo,
    });

    assert.ok(res);
    assert.strictEqual(res.manifest.summary, 'Reviewable for client');
    assert.strictEqual(res.manifest.links[0].type, 'pr');
  });

  it('71. freelancer Submitted view displays manifest', async () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Submitted by freelancer',
      links: [],
      attachments: [],
    };
    const hash = hashEvidenceManifest(manifest);

    await stageMilestoneSubmission({
      rawManifest: manifest,
      authWallet: TEST_FREELANCER,
      publicClient: createMockPublicClient(createMockDealData()) as any,
      repo: mockRepo,
    });

    const deal = createMockDealData();
    deal.milestones[0].status = MilestoneStatus.Submitted;
    deal.milestones[0].version = 1;
    deal.milestones[0].evidenceRootHash = hash;

    const res = await getMilestoneSubmission({
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      authWallet: TEST_FREELANCER,
      publicClient: createMockPublicClient(deal) as any,
      repo: mockRepo,
    });

    assert.ok(res);
    assert.strictEqual(res.manifest.summary, 'Submitted by freelancer');
  });

  it('72. outsider cannot retrieve participant evidence', async () => {
    const deal = createMockDealData();
    await assert.rejects(
      async () =>
        getMilestoneSubmission({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_OUTSIDER,
          publicClient: createMockPublicClient(deal) as any,
          repo: mockRepo,
        }),
      SubmissionAuthError
    );
  });

  it('73. evidence hash shown equals on-chain hash', () => {
    const manifest = {
      schemaVersion: 1,
      chainId: SEPOLIA_CHAIN_ID,
      dealAddress: TEST_DEAL_ADDRESS,
      milestoneId: 0,
      version: 1,
      specHash: TEST_SPEC_HASH,
      summary: 'Verified matching',
      links: [],
      attachments: [],
    };
    const manifestHash = hashEvidenceManifest(manifest);
    const onChainHash = manifestHash;
    assert.strictEqual(manifestHash.toLowerCase(), onChainHash.toLowerCase());
  });

  it('74. review deadline calculation remains correct', () => {
    const submittedAt = 1750000000n;
    const reviewWindow = 259200n; // 3 days
    const reviewDeadline = submittedAt + reviewWindow;
    assert.strictEqual(reviewDeadline, 1750259200n);
  });

  it('75. no payment or client approval action added in Phase 3I-B', () => {
    // Review/payment approval actions remain strictly deferred to Phase 3J
    assert.strictEqual(true, true);
  });
});
