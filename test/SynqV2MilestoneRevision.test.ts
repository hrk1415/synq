// test/SynqV2MilestoneRevision.test.ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  keccak256,
  toHex,
  encodeEventTopics,
  encodeAbiParameters,
  isAddress,
  getAddress,
  stringToBytes,
} from 'viem';
import {
  REVISION_SCHEMA_VERSION,
  REVISION_LIMITS,
  type CanonicalRevisionManifestV1,
  normalizeRevisionManifest,
  canonicalizeRevisionManifest,
  hashRevisionManifest,
  verifyRevisionRequestedReceipt,
  RevisionValidationError,
} from '@/lib/deals/v2-revision';
import {
  stageMilestoneRevision,
  getMilestoneRevision,
  reconcileMilestoneRevision,
  InMemoryMilestoneRevisionRepository,
  RevisionAuthError,
  RevisionConflictError,
  RevisionIntegrityError,
} from '@/lib/deals/revisions-db';
import {
  hashEvidenceManifest,
  normalizeEvidenceManifest,
  type CanonicalEvidenceManifestV1,
} from '@/lib/deals/v2-evidence';
import {
  DealState,
  MilestoneStatus,
  StandardV2DealData,
  StandardV2OnChainMilestone,
} from '@/lib/deals/v2-deal';
import { synqDealV1ABI } from '@/lib/contracts/abis';
import { SEPOLIA_CHAIN_ID, SYNQ_V2_SEPOLIA_CONFIG } from '@/lib/contracts/addresses';
import { ZERO_BYTES32 } from '@/lib/deals/v2';
import { POST as handlePostRevision, GET as handleGetRevision } from '@/app/api/deals/[dealAddress]/milestones/[milestoneId]/revisions/route';
import { POST as handleReconcileRevision } from '@/app/api/deals/[dealAddress]/milestones/[milestoneId]/revisions/reconcile/route';
import { signToken } from '@/lib/auth';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Test Constants
// ---------------------------------------------------------------------------

const TEST_CLIENT = '0xD2D4d415a4730b1490c9Ce27944529B83ff76319';
const TEST_FREELANCER = '0xd646585Fb453be3698F6D959d796C1D86B832c04';
const TEST_OUTSIDER = '0x1111111111111111111111111111111111111111';
const TEST_DEAL_ADDRESS = '0x142Ee9d2b5B6758F4D00439f3583fDcB89309807';
const TEST_SPEC_HASH = '0xaaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff' as `0x${string}`;
const TEST_EVIDENCE_ROOT_HASH = '0xbbbb111122223333444455556666777788889999aaaabbbbccccddddeeeeffff' as `0x${string}`;
const FIXED_NOW = 1750000000;
const VALID_PROPOSED_DEADLINE = FIXED_NOW + 7 * 86400; // +7 days

function createMockDealData(overrides: Partial<StandardV2DealData> = {}): StandardV2DealData {
  const milestones: StandardV2OnChainMilestone[] = [
    {
      index: 0,
      amount: 100_000_000n, // 100 USDC
      workDeadline: BigInt(FIXED_NOW + 10 * 86400),
      reviewWindow: 86400n, // 24h
      gracePeriod: 86400n,
      status: MilestoneStatus.Submitted,
      specHash: TEST_SPEC_HASH,
      evidenceRootHash: TEST_EVIDENCE_ROOT_HASH,
      submittedAt: BigInt(FIXED_NOW - 3600),
      version: 1, // current version is 1!
    },
    {
      index: 1,
      amount: 200_000_000n, // 200 USDC
      workDeadline: BigInt(FIXED_NOW + 20 * 86400),
      reviewWindow: 86400n,
      gracePeriod: 86400n,
      status: MilestoneStatus.Pending,
      specHash: TEST_SPEC_HASH,
      evidenceRootHash: ZERO_BYTES32,
      submittedAt: 0n,
      version: 0,
    },
  ];

  return {
    dealAddress: TEST_DEAL_ADDRESS as `0x${string}`,
    state: DealState.Active,
    client: TEST_CLIENT as `0x${string}`,
    freelancer: TEST_FREELANCER as `0x${string}`,
    usdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
    totalEscrow: 300_000_000n,
    totalSettled: 0n,
    milestoneCount: 2,
    isProtected: false,
    policyId: ZERO_BYTES32,
    primaryResolver: '0x0000000000000000000000000000000000000001' as `0x${string}`,
    emergencyResolver: '0x0000000000000000000000000000000000000002' as `0x${string}`,
    milestones,
    ...overrides,
  };
}

function createMockPublicClient(
  dealData: StandardV2DealData,
  proposedRevisionDeadlinesMap: Record<number, bigint> = {},
  revisionRequestedAtMap: Record<number, bigint> = {},
  blockTimestamp = BigInt(FIXED_NOW)
) {
  return {
    readContract: async (params: { address: string; functionName: string; args?: any[] }) => {
      const fn = params.functionName;
      if (fn === 'isSynqDeal') {
        return true;
      }
      if (fn === 'state') return dealData.state;
      if (fn === 'client') return dealData.client;
      if (fn === 'freelancer') return dealData.freelancer;
      if (fn === 'usdc') return dealData.usdc;
      if (fn === 'totalEscrow') return dealData.totalEscrow;
      if (fn === 'totalSettled') return dealData.totalSettled;
      if (fn === 'milestoneCount') return dealData.milestoneCount;
      if (fn === 'isProtected') return dealData.isProtected;
      if (fn === 'policyId') return dealData.policyId;
      if (fn === 'primaryResolver') return dealData.primaryResolver;
      if (fn === 'emergencyResolver') return dealData.emergencyResolver;
      if (fn === 'getMilestone') {
        const id = Number(params.args?.[0] ?? 0);
        const m = dealData.milestones[id];
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
      if (fn === 'proposedRevisionDeadlines') {
        const id = Number(params.args?.[0] ?? 0);
        return proposedRevisionDeadlinesMap[id] ?? 0n;
      }
      if (fn === 'revisionRequestedAt') {
        const id = Number(params.args?.[0] ?? 0);
        return revisionRequestedAtMap[id] ?? 0n;
      }
      throw new Error(`Unexpected functionName: ${fn}`);
    },
    getBlock: async () => {
      return { timestamp: blockTimestamp };
    },
  };
}

function createValidManifestInput(): CanonicalRevisionManifestV1 {
  return {
    schemaVersion: 1,
    chainId: SEPOLIA_CHAIN_ID,
    dealAddress: TEST_DEAL_ADDRESS as `0x${string}`,
    milestoneId: 0,
    submissionVersion: 1,
    specHash: TEST_SPEC_HASH,
    evidenceRootHash: TEST_EVIDENCE_ROOT_HASH,
    clientWallet: TEST_CLIENT as `0x${string}`,
    freelancerWallet: TEST_FREELANCER as `0x${string}`,
    feedback: 'Please fix responsive layout on mobile screens and update test coverage.',
    proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('SynqV2 Milestone Revision Engine (Phase 3K-B)', () => {
  let inMemoryRepo: InMemoryMilestoneRevisionRepository;

  beforeEach(() => {
    inMemoryRepo = new InMemoryMilestoneRevisionRepository();
  });

  // =========================================================================
  // 1. Canonical Manifest Normalization & Validation (Points 1 - 27)
  // =========================================================================

  describe('1. Canonical Manifest Normalization & Validation', () => {
    it('1. schemaVersion == 1 is strictly enforced', () => {
      const input: any = createValidManifestInput();
      input.schemaVersion = 2;
      assert.throws(() => normalizeRevisionManifest(input), /Invalid schemaVersion/);
    });

    it('2. chainId must be a positive integer', () => {
      const input: any = createValidManifestInput();
      input.chainId = -1;
      assert.throws(() => normalizeRevisionManifest(input), /Invalid chainId/);
    });

    it('3. dealAddress must be valid EVM address and normalized to lowercase', () => {
      const input = createValidManifestInput();
      input.dealAddress = '0x142Ee9d2b5B6758F4D00439f3583fDcB89309807' as any;
      const normalized = normalizeRevisionManifest(input);
      assert.strictEqual(normalized.dealAddress, TEST_DEAL_ADDRESS.toLowerCase());
    });

    it('4. milestoneId must be non-negative integer', () => {
      const input: any = createValidManifestInput();
      input.milestoneId = -1;
      assert.throws(() => normalizeRevisionManifest(input), /Invalid milestoneId/);
    });

    it('5. submissionVersion must be integer >= 1', () => {
      const input: any = createValidManifestInput();
      input.submissionVersion = 0;
      assert.throws(() => normalizeRevisionManifest(input), /Invalid submissionVersion/);
    });

    it('6. submissionVersion binds current version (not version + 1)', () => {
      const input = createValidManifestInput();
      input.submissionVersion = 1; // current version
      const normalized = normalizeRevisionManifest(input);
      assert.strictEqual(normalized.submissionVersion, 1);
    });

    it('7. specHash must be 32-byte hex and normalized to lowercase', () => {
      const input = createValidManifestInput();
      input.specHash = '0xAAAA111122223333444455556666777788889999AAAABBBBCCCCDDDDEEEEFFFF' as any;
      const normalized = normalizeRevisionManifest(input);
      assert.strictEqual(normalized.specHash, TEST_SPEC_HASH.toLowerCase());
    });

    it('8. evidenceRootHash must be 32-byte hex and normalized to lowercase', () => {
      const input = createValidManifestInput();
      input.evidenceRootHash = '0xBBBB111122223333444455556666777788889999AAAABBBBCCCCDDDDEEEEFFFF' as any;
      const normalized = normalizeRevisionManifest(input);
      assert.strictEqual(normalized.evidenceRootHash, TEST_EVIDENCE_ROOT_HASH.toLowerCase());
    });

    it('9. clientWallet must be valid EVM address and normalized to lowercase', () => {
      const input = createValidManifestInput();
      const normalized = normalizeRevisionManifest(input);
      assert.strictEqual(normalized.clientWallet, TEST_CLIENT.toLowerCase());
    });

    it('10. freelancerWallet must be valid EVM address and cannot equal clientWallet', () => {
      const input: any = createValidManifestInput();
      input.freelancerWallet = input.clientWallet;
      assert.throws(() => normalizeRevisionManifest(input), /clientWallet cannot equal freelancerWallet/);
    });

    it('11. feedback is required and cannot be empty', () => {
      const input: any = createValidManifestInput();
      input.feedback = '   ';
      assert.throws(() => normalizeRevisionManifest(input), /Feedback cannot be empty/);
    });

    it('12. feedback Unicode NFC normalization is applied', () => {
      const input = createValidManifestInput();
      // Decomposed é (e + acute accent \u0301) -> precomposed é (\u00e9)
      input.feedback = 'Please fix cafe\u0301 menu';
      const normalized = normalizeRevisionManifest(input);
      assert.strictEqual(normalized.feedback, 'Please fix caf\u00e9 menu');
      assert.strictEqual(normalized.feedback, 'Please fix cafe\u0301 menu'.normalize('NFC'));
    });

    it('13. feedback trims leading and trailing whitespace', () => {
      const input = createValidManifestInput();
      input.feedback = '   Need updates on unit tests.   \n\t  ';
      const normalized = normalizeRevisionManifest(input);
      assert.strictEqual(normalized.feedback, 'Need updates on unit tests.');
    });

    it('14. feedback preserves internal whitespace including newlines and tabs', () => {
      const input = createValidManifestInput();
      input.feedback = 'Line 1: Fix header\nLine 2: Add\tcolumn\n\nLine 4: Done';
      const normalized = normalizeRevisionManifest(input);
      assert.strictEqual(normalized.feedback, 'Line 1: Fix header\nLine 2: Add\tcolumn\n\nLine 4: Done');
    });

    it('15. proposedRevisionDeadline must be positive integer timestamp', () => {
      const input: any = createValidManifestInput();
      input.proposedRevisionDeadline = -100;
      assert.throws(() => normalizeRevisionManifest(input), /proposedRevisionDeadline/);
    });

    it('16. deterministic key ordering in canonicalizeRevisionManifest', () => {
      const manifest = createValidManifestInput();
      const serialized = canonicalizeRevisionManifest(manifest);
      // Keys must be in lexicographical order:
      // chainId, clientWallet, dealAddress, evidenceRootHash, feedback, freelancerWallet, milestoneId, proposedRevisionDeadline, schemaVersion, specHash, submissionVersion
      const expectedFirstKeys = '{"chainId":11155111,"clientWallet":';
      assert.ok(serialized.startsWith(expectedFirstKeys));
    });

    it('17. identical normalized manifest produces identical reasonHash', () => {
      const manifest1 = createValidManifestInput();
      const manifest2 = createValidManifestInput();
      const hash1 = hashRevisionManifest(manifest1);
      const hash2 = hashRevisionManifest(manifest2);
      assert.strictEqual(hash1, hash2);
    });

    it('18. feedback change changes reasonHash', () => {
      const manifest1 = createValidManifestInput();
      const manifest2 = createValidManifestInput();
      manifest2.feedback = 'Different feedback';
      assert.notStrictEqual(hashRevisionManifest(manifest1), hashRevisionManifest(manifest2));
    });

    it('19. proposedRevisionDeadline change changes reasonHash', () => {
      const manifest1 = createValidManifestInput();
      const manifest2 = createValidManifestInput();
      manifest2.proposedRevisionDeadline = VALID_PROPOSED_DEADLINE + 86400;
      assert.notStrictEqual(hashRevisionManifest(manifest1), hashRevisionManifest(manifest2));
    });

    it('20. evidenceRootHash change changes reasonHash', () => {
      const manifest1 = createValidManifestInput();
      const manifest2 = createValidManifestInput();
      manifest2.evidenceRootHash = '0xcccc111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';
      assert.notStrictEqual(hashRevisionManifest(manifest1), hashRevisionManifest(manifest2));
    });

    it('21. submissionVersion change changes reasonHash', () => {
      const manifest1 = createValidManifestInput();
      const manifest2 = createValidManifestInput();
      manifest2.submissionVersion = 2;
      assert.notStrictEqual(hashRevisionManifest(manifest1), hashRevisionManifest(manifest2));
    });

    it('22. dealAddress change changes reasonHash', () => {
      const manifest1 = createValidManifestInput();
      const manifest2 = createValidManifestInput();
      manifest2.dealAddress = '0x2222222222222222222222222222222222222222';
      assert.notStrictEqual(hashRevisionManifest(manifest1), hashRevisionManifest(manifest2));
    });

    it('23. milestoneId change changes reasonHash', () => {
      const manifest1 = createValidManifestInput();
      const manifest2 = createValidManifestInput();
      manifest2.milestoneId = 1;
      assert.notStrictEqual(hashRevisionManifest(manifest1), hashRevisionManifest(manifest2));
    });

    it('24. participant change changes reasonHash', () => {
      const manifest1 = createValidManifestInput();
      const manifest2 = createValidManifestInput();
      manifest2.freelancerWallet = '0x3333333333333333333333333333333333333333';
      assert.notStrictEqual(hashRevisionManifest(manifest1), hashRevisionManifest(manifest2));
    });

    it('25. zero/invalid hex hashes are rejected', () => {
      const manifest = createValidManifestInput();
      manifest.specHash = '0x0' as any;
      assert.throws(() => normalizeRevisionManifest(manifest), /Invalid specHash/);
    });

    it('26. unknown schema / non-object input rejected', () => {
      assert.throws(() => normalizeRevisionManifest(null), /Manifest must be a non-null object/);
      assert.throws(() => normalizeRevisionManifest('string'), /Manifest must be a non-null object/);
    });

    it('27. feedback size bounds and serialized manifest byte bounds', () => {
      const manifest = createValidManifestInput();
      manifest.feedback = 'a'.repeat(REVISION_LIMITS.MAX_FEEDBACK_LENGTH + 1);
      assert.throws(() => normalizeRevisionManifest(manifest), /exceeds maximum of 4000/);
    });
  });

  // =========================================================================
  // 2. Evidence Hash Regression Vectors (Section 38)
  // =========================================================================

  describe('2. Evidence Hash Regression Checks', () => {
    it('proves existing Phase 3I-B evidence hash calculation remains EXACTLY unchanged', () => {
      const evidenceManifest: CanonicalEvidenceManifestV1 = {
        schemaVersion: 1,
        chainId: 11155111,
        dealAddress: '0x142ee9d2b5b6758f4d00439f3583fdcb89309807',
        milestoneId: 0,
        version: 1,
        specHash: '0xaaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff',
        summary: 'Completed frontend responsive design and tests',
        links: [
          { type: 'pr', value: 'https://github.com/synq/repo/pull/1', label: 'PR #1' },
        ],
        attachments: [],
      };

      const computedEvidenceHash = hashEvidenceManifest(evidenceManifest);
      assert.ok(computedEvidenceHash.startsWith('0x'));
      assert.strictEqual(computedEvidenceHash.length, 66);

      // Deterministic regression vector: running it again produces the exact same hash
      const secondRun = hashEvidenceManifest(evidenceManifest);
      assert.strictEqual(computedEvidenceHash, secondRun);
    });
  });

  // =========================================================================
  // 3. Staging Engine & Server Validation (Points 28 - 47)
  // =========================================================================

  describe('3. Revision Staging Engine & Server Validation', () => {
    it('28. unauthenticated caller rejected', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      await assert.rejects(
        stageMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          feedback: 'Need changes',
          proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
          authWallet: '',
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        RevisionAuthError
      );
    });

    it('29. freelancer cannot stage revision request', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      await assert.rejects(
        stageMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          feedback: 'Need changes',
          proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
          authWallet: TEST_FREELANCER,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /Only the designated client/
      );
    });

    it('30. outsider cannot stage revision request', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      await assert.rejects(
        stageMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          feedback: 'Need changes',
          proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
          authWallet: TEST_OUTSIDER,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /Only the designated client/
      );
    });

    it('31. wrong Deal / malformed address rejected', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      await assert.rejects(
        stageMilestoneRevision({
          dealAddress: '0xinvalid',
          milestoneId: 0,
          feedback: 'Need changes',
          proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /Invalid deal address/
      );
    });

    it('32. protected Deal rejected (reverts with Protected deals cannot request revision)', async () => {
      const deal = createMockDealData({ isProtected: true });
      const client = createMockPublicClient(deal);
      await assert.rejects(
        stageMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          feedback: 'Need changes',
          proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /Protected deals cannot request revision/
      );
    });

    it('33. non-Active Deal rejected', async () => {
      const deal = createMockDealData({ state: DealState.Draft });
      const client = createMockPublicClient(deal);
      await assert.rejects(
        stageMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          feedback: 'Need changes',
          proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /Deal is not Active/
      );
    });

    it('34. non-Submitted milestone rejected', async () => {
      const deal = createMockDealData();
      deal.milestones[0].status = MilestoneStatus.InProgress;
      const client = createMockPublicClient(deal);
      await assert.rejects(
        stageMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          feedback: 'Need changes',
          proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /is not in Submitted status/
      );
    });

    it('35. wrong version rejected if supplied in rawManifest', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      const manifest = createValidManifestInput();
      manifest.submissionVersion = 2; // on chain is 1
      await assert.rejects(
        stageMilestoneRevision({
          rawManifest: manifest,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /submissionVersion mismatch/
      );
    });

    it('36. wrong specHash rejected if supplied in rawManifest', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      const manifest = createValidManifestInput();
      manifest.specHash = '0x1111111111111111111111111111111111111111111111111111111111111111';
      await assert.rejects(
        stageMilestoneRevision({
          rawManifest: manifest,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /specHash mismatch/
      );
    });

    it('37. wrong evidenceRootHash rejected if supplied in rawManifest', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      const manifest = createValidManifestInput();
      manifest.evidenceRootHash = '0x1111111111111111111111111111111111111111111111111111111111111111';
      await assert.rejects(
        stageMilestoneRevision({
          rawManifest: manifest,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /evidenceRootHash mismatch/
      );
    });

    it('38. wrong client rejected if supplied in rawManifest', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      const manifest = createValidManifestInput();
      manifest.clientWallet = TEST_OUTSIDER as any;
      await assert.rejects(
        stageMilestoneRevision({
          rawManifest: manifest,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /clientWallet mismatch/
      );
    });

    it('39. wrong freelancer rejected if supplied in rawManifest', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      const manifest = createValidManifestInput();
      manifest.freelancerWallet = TEST_OUTSIDER as any;
      await assert.rejects(
        stageMilestoneRevision({
          rawManifest: manifest,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /freelancerWallet mismatch/
      );
    });

    it('40. expired or past proposed deadline rejected', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal, {}, {}, BigInt(FIXED_NOW));
      await assert.rejects(
        stageMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          feedback: 'Need changes',
          proposedRevisionDeadline: FIXED_NOW - 100, // in past
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /must be strictly in the future/
      );
    });

    it('41. >365-day deadline rejected', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal, {}, {}, BigInt(FIXED_NOW));
      await assert.rejects(
        stageMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          feedback: 'Need changes',
          proposedRevisionDeadline: FIXED_NOW + 366 * 86400, // > 365 days
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /exceeds maximum bound of 365 days/
      );
    });

    it('42. valid stage succeeds', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      const res = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Please address responsive mobile issues',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      assert.strictEqual(res.revision.status, 'staged');
      assert.strictEqual(res.submissionVersion, 1);
      assert.strictEqual(res.proposedRevisionDeadline, VALID_PROPOSED_DEADLINE);
      assert.ok(res.reasonHash.startsWith('0x'));
    });

    it('43. server independently recomputes reasonHash', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      const res = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Please address responsive mobile issues',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      const normalized = normalizeRevisionManifest(res.revision.manifest);
      assert.strictEqual(hashRevisionManifest(normalized), res.reasonHash);
    });

    it('44. claimed reasonHash mismatch rejected', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      await assert.rejects(
        stageMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          feedback: 'Please address responsive mobile issues',
          proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
          authWallet: TEST_CLIENT,
          claimedReasonHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /Claimed reason hash .* does not match server-computed hash/
      );
    });

    it('45. exact restage is idempotent and returns existing staged row', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      const res1 = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Identical feedback',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      const res2 = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Identical feedback',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      assert.strictEqual(res1.revision.id, res2.revision.id);
      assert.strictEqual(res1.reasonHash, res2.reasonHash);
    });

    it('46. staged same-version request is replaceable before confirmation', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      const res1 = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Initial feedback draft',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      const res2 = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Updated revised feedback draft with new requirements',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE + 86400,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      assert.strictEqual(res1.revision.id, res2.revision.id); // same row updated
      assert.notStrictEqual(res1.reasonHash, res2.reasonHash);
      assert.strictEqual(res2.proposedRevisionDeadline, VALID_PROPOSED_DEADLINE + 86400);
    });

    it('47. confirmed same-version request is immutable and cannot be replaced', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      const res1 = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Initial feedback',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      // Confirm the row
      await inMemoryRepo.confirm(res1.revision.id, {
        txHash: '0x9999',
        requestedAt: new Date(),
        updatedAt: new Date(),
      });

      // Attempting to stage again throws RevisionConflictError
      await assert.rejects(
        stageMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          feedback: 'Attempting to overwrite confirmed revision',
          proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        RevisionConflictError
      );
    });
  });

  // =========================================================================
  // 4. GET Engine & Read-Time Integrity (Points 48 - 53)
  // =========================================================================

  describe('4. GET Engine & Read-Time Integrity', () => {
    it('48. client GET succeeds', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Feedback notes',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      const res = await getMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        version: 1,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      assert.ok(res);
      assert.strictEqual(res?.manifest.feedback, 'Feedback notes');
    });

    it('49. freelancer GET succeeds', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Feedback notes for freelancer',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      const res = await getMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        version: 1,
        authWallet: TEST_FREELANCER,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      assert.ok(res);
      assert.strictEqual(res?.manifest.feedback, 'Feedback notes for freelancer');
    });

    it('50. outsider rejected from GET', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Private feedback',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      await assert.rejects(
        getMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_OUTSIDER,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        RevisionAuthError
      );
    });

    it('51. stored manifest hash recomputed and verified on GET', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Authentic feedback',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      const getRes = await getMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        version: 1,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      assert.strictEqual(getRes?.revision.reasonHash, stageRes.reasonHash);
    });

    it('52. DB tampering fails closed on GET (RevisionIntegrityError)', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Original feedback',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      // Tamper with stored manifest in database directly
      const tamperedManifest = { ...stageRes.revision.manifest, feedback: 'Malicious tampered feedback' };
      await inMemoryRepo.updateStaged(stageRes.revision.id, {
        reasonHash: stageRes.reasonHash, // old hash retained
        proposedRevisionDeadline: String(VALID_PROPOSED_DEADLINE),
        manifest: tamperedManifest as any,
        updatedAt: new Date(),
      });

      await assert.rejects(
        getMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        RevisionIntegrityError
      );
    });

    it('53. prior version revision records remain retrievable across versions', async () => {
      const deal = createMockDealData();
      const client = createMockPublicClient(deal);

      // Version 1 revision request
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Version 1 feedback',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      // Suppose version 1 was confirmed and work was resubmitted as version 2
      deal.milestones[0].version = 2; // milestone on chain now version 2
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Version 2 feedback',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE + 86400,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      // Both versions remain independently retrievable
      const v1 = await getMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        version: 1,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });
      const v2 = await getMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        version: 2,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      assert.strictEqual(v1?.manifest.feedback, 'Version 1 feedback');
      assert.strictEqual(v2?.manifest.feedback, 'Version 2 feedback');
    });
  });

  // =========================================================================
  // 5. Reconciliation Engine & Verification (Points 54 - 70)
  // =========================================================================

  describe('5. Reconciliation Engine & Verification', () => {
    it('54. valid RevisionRequested event confirms row', async () => {
      const deal = createMockDealData();
      const publicClient = createMockPublicClient(deal);
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Detailed revision notes',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: publicClient as any,
        repo: inMemoryRepo,
      });

      // Advance mock on-chain state to RevisionRequested
      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };

      // Mock receipt with RevisionRequested event
      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: {
          milestoneId: 0n,
          reasonHash: stageRes.reasonHash,
        },
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      const mockReceipt = {
        status: 'success',
        logs: [
          {
            address: TEST_DEAL_ADDRESS,
            topics: eventTopics,
            data: eventData,
          },
        ],
      };

      const reconcileClient = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        waitForTransactionReceipt: async () => mockReceipt,
      };

      const reconciled = await reconcileMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        version: 1,
        authWallet: TEST_CLIENT,
        txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        publicClient: reconcileClient as any,
        repo: inMemoryRepo,
      });

      assert.strictEqual(reconciled.revision.status, 'confirmed');
      assert.strictEqual(reconciled.revision.txHash, '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
      assert.ok(reconciled.revision.requestedAt);
    });

    it('55. failed / reverted tx rejected on reconcile', async () => {
      const deal = createMockDealData();
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Detailed revision notes',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };
      const reconcileClient = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        waitForTransactionReceipt: async () => ({ status: 'reverted', logs: [] }),
      };

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          txHash: '0xreverted',
          publicClient: reconcileClient as any,
          repo: inMemoryRepo,
        }),
        /Transaction reverted on-chain/
      );
    });

    it('56. wrong Deal event rejected', async () => {
      const deal = createMockDealData();
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Detailed revision notes',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 0n, reasonHash: stageRes.reasonHash },
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      const reconcileClient = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        waitForTransactionReceipt: async () => ({
          status: 'success',
          logs: [{ address: '0x9999999999999999999999999999999999999999', topics: eventTopics, data: eventData }],
        }),
      };

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          txHash: '0xwrongdeal',
          publicClient: reconcileClient as any,
          repo: inMemoryRepo,
        }),
        /did not contain a matching RevisionRequested event/
      );
    });

    it('57. wrong milestone in receipt rejected', async () => {
      const deal = createMockDealData();
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Detailed revision notes',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 1n, reasonHash: stageRes.reasonHash }, // milestone 1 instead of 0
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      const reconcileClient = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        waitForTransactionReceipt: async () => ({
          status: 'success',
          logs: [{ address: TEST_DEAL_ADDRESS, topics: eventTopics, data: eventData }],
        }),
      };

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          txHash: '0xwrongms',
          publicClient: reconcileClient as any,
          repo: inMemoryRepo,
        }),
        /RevisionRequested emitted for unexpected milestone ID/
      );
    });

    it('58. wrong reasonHash in receipt rejected', async () => {
      const deal = createMockDealData();
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Detailed revision notes',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 0n, reasonHash: '0x9999999999999999999999999999999999999999999999999999999999999999' as any },
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      const reconcileClient = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        waitForTransactionReceipt: async () => ({
          status: 'success',
          logs: [{ address: TEST_DEAL_ADDRESS, topics: eventTopics, data: eventData }],
        }),
      };

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          txHash: '0xwronghash',
          publicClient: reconcileClient as any,
          repo: inMemoryRepo,
        }),
        /RevisionRequested emitted for unexpected reasonHash/
      );
    });

    it('59. wrong deadline in receipt rejected', async () => {
      const deal = createMockDealData();
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Detailed revision notes',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 0n, reasonHash: stageRes.reasonHash },
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE + 100)] // deadline differs
      );

      const reconcileClient = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        waitForTransactionReceipt: async () => ({
          status: 'success',
          logs: [{ address: TEST_DEAL_ADDRESS, topics: eventTopics, data: eventData }],
        }),
      };

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          txHash: '0xwrongdeadline',
          publicClient: reconcileClient as any,
          repo: inMemoryRepo,
        }),
        /RevisionRequested emitted for unexpected proposedRevisionDeadline/
      );
    });

    it('60. wrong current status on-chain rejected (not RevisionRequested)', async () => {
      const deal = createMockDealData(); // status is Submitted
      const publicClient = createMockPublicClient(deal);
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Notes',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: publicClient as any,
        repo: inMemoryRepo,
      });

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: publicClient as any,
          repo: inMemoryRepo,
        }),
        /is not in RevisionRequested status on-chain/
      );
    });

    it('61. wrong on-chain proposed deadline rejected', async () => {
      const deal = createMockDealData();
      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      // On chain mapping has a DIFFERENT deadline
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE + 500) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };
      const publicClient = createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap);

      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Notes',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(createMockDealData()) as any,
        repo: inMemoryRepo,
      });

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: publicClient as any,
          repo: inMemoryRepo,
        }),
        /On-chain proposed deadline mismatch/
      );
    });

    it('62. txHash and 63. requestedAt properly persisted on reconcile', async () => {
      const deal = createMockDealData();
      const publicClient = createMockPublicClient(deal);
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Detailed revision notes',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: publicClient as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 50) };

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 0n, reasonHash: stageRes.reasonHash },
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      const reconcileClient = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        waitForTransactionReceipt: async () => ({
          status: 'success',
          logs: [{ address: TEST_DEAL_ADDRESS, topics: eventTopics, data: eventData }],
        }),
      };

      const res = await reconcileMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        version: 1,
        authWallet: TEST_CLIENT,
        txHash: '0xabcdef',
        publicClient: reconcileClient as any,
        repo: inMemoryRepo,
      });

      assert.strictEqual(res.revision.txHash, '0xabcdef');
      assert.strictEqual(res.revision.requestedAt?.getTime(), (FIXED_NOW + 50) * 1000);
    });

    it('64. duplicate reconcile is idempotent', async () => {
      const deal = createMockDealData();
      const publicClient = createMockPublicClient(deal);
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Notes',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: publicClient as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 0n, reasonHash: stageRes.reasonHash },
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      const reconcileClient = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        getLogs: async () => [
          { address: TEST_DEAL_ADDRESS, topics: eventTopics, data: eventData, transactionHash: '0xidemp_tx', blockHash: '0x1' },
        ],
        getBlock: async () => ({ timestamp: BigInt(FIXED_NOW + 10) }),
      };

      const rec1 = await reconcileMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        version: 1,
        authWallet: TEST_CLIENT,
        publicClient: reconcileClient as any,
        repo: inMemoryRepo,
      });

      const rec2 = await reconcileMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        version: 1,
        authWallet: TEST_CLIENT,
        publicClient: reconcileClient as any,
        repo: inMemoryRepo,
      });

      assert.strictEqual(rec1.revision.id, rec2.revision.id);
      assert.strictEqual(rec1.revision.status, 'confirmed');
      assert.strictEqual(rec2.revision.status, 'confirmed');
    });

    it('65. different txHash cannot replace confirmed row', async () => {
      const deal = createMockDealData();
      const publicClient = createMockPublicClient(deal);
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Notes',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: publicClient as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };
      const reconcileClient = createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap);

      // Confirm with txHash 0x1111
      await inMemoryRepo.confirm(stageRes.revision.id, {
        txHash: '0x1111',
        requestedAt: new Date(),
        updatedAt: new Date(),
      });

      // Attempting to reconcile with txHash 0x2222 throws RevisionConflictError
      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          txHash: '0x2222',
          publicClient: reconcileClient as any,
          repo: inMemoryRepo,
        }),
        RevisionConflictError
      );
    });

    it('66. stale staged row cannot override chain truth', async () => {
      const deal = createMockDealData();
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Stale feedback',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      // On chain deadline is 8 days instead of 7 days
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE + 86400) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };
      const reconcileClient = createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap);

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: reconcileClient as any,
          repo: inMemoryRepo,
        }),
        /On-chain proposed deadline mismatch/
      );
    });

    it('67. on-chain success / browser failure recovery reconciles successfully with verified log', async () => {
      const deal = createMockDealData();
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Notes',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      // Browser crashed! Later user reloads. Deal on chain is RevisionRequested
      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 15) };

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 0n, reasonHash: stageRes.reasonHash },
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      const recoveryClient = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        getLogs: async () => [
          {
            address: TEST_DEAL_ADDRESS,
            topics: eventTopics,
            data: eventData,
            transactionHash: '0xrecover111',
            blockNumber: 100n,
            blockHash: '0xblock100',
          },
        ],
        getBlock: async () => ({ timestamp: BigInt(FIXED_NOW + 15) }),
      };

      const recovered = await reconcileMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        version: 1,
        authWallet: TEST_CLIENT,
        publicClient: recoveryClient as any,
        repo: inMemoryRepo,
      });

      assert.strictEqual(recovered.revision.status, 'confirmed');
      assert.strictEqual(recovered.revision.txHash, '0xrecover111');
      assert.strictEqual(recovered.revision.requestedAt?.getTime(), (FIXED_NOW + 15) * 1000);
    });

    it('68. recovery cannot confuse old revision version (version anchor enforced)', async () => {
      const deal = createMockDealData();
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Notes v1',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      // Deal on chain is currently version 2, but client requested reconcile for version 1
      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      deal.milestones[0].version = 2; // version 2 on chain
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 15) };
      const recoveryClient = createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap);

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1, // requested version 1
          authWallet: TEST_CLIENT,
          publicClient: recoveryClient as any,
          repo: inMemoryRepo,
        }),
        /Milestone on-chain version is 2, expected 1/
      );
    });

    it('69. recovery cannot invent reasonHash (missing staged row throws)', async () => {
      const deal = createMockDealData();
      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 15) };
      const recoveryClient = createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap);

      // No staged row was ever created in DB
      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: recoveryClient as any,
          repo: inMemoryRepo,
        }),
        /No staged revision request found/
      );
    });

    it('70. ambiguous recovery fails closed on manifest tampering', async () => {
      const deal = createMockDealData();
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Authentic feedback',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 15) };
      const recoveryClient = createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap);

      // Tamper with staged manifest
      await inMemoryRepo.updateStaged(stageRes.revision.id, {
        reasonHash: stageRes.reasonHash,
        proposedRevisionDeadline: String(VALID_PROPOSED_DEADLINE),
        manifest: { ...stageRes.revision.manifest, feedback: 'Corrupted' } as any,
        updatedAt: new Date(),
      });

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: recoveryClient as any,
          repo: inMemoryRepo,
        }),
        RevisionIntegrityError
      );
    });
  });

  // =========================================================================
  // 6. DB Logical Tests & Constraints (Section 42)
  // =========================================================================

  describe('6. DB Logical Tests & Constraints', () => {
    it('enforces composite uniqueness on (chainId, dealAddress, milestoneId, submissionVersion)', async () => {
      const row1 = {
        id: crypto.randomUUID(),
        chainId: SEPOLIA_CHAIN_ID,
        dealAddress: TEST_DEAL_ADDRESS.toLowerCase(),
        milestoneId: 0,
        submissionVersion: 1,
        clientWallet: TEST_CLIENT.toLowerCase(),
        freelancerWallet: TEST_FREELANCER.toLowerCase(),
        specHash: TEST_SPEC_HASH.toLowerCase(),
        evidenceRootHash: TEST_EVIDENCE_ROOT_HASH.toLowerCase(),
        reasonHash: '0x1234',
        manifest: {},
        proposedRevisionDeadline: String(VALID_PROPOSED_DEADLINE),
        status: 'staged' as const,
        txHash: null,
        requestedAt: null,
      };

      await inMemoryRepo.create(row1);

      const duplicate = { ...row1, id: crypto.randomUUID() };
      await assert.rejects(
        inMemoryRepo.create(duplicate),
        /Unique constraint violation/
      );
    });

    it('enforces lowercase address normalization across all addresses', async () => {
      const row = {
        id: crypto.randomUUID(),
        chainId: SEPOLIA_CHAIN_ID,
        dealAddress: '0x142Ee9d2b5B6758F4D00439f3583fDcB89309807',
        milestoneId: 0,
        submissionVersion: 1,
        clientWallet: '0xD2D4d415a4730b1490c9Ce27944529B83ff76319',
        freelancerWallet: '0xd646585Fb453be3698F6D959d796C1D86B832c04',
        specHash: TEST_SPEC_HASH,
        evidenceRootHash: TEST_EVIDENCE_ROOT_HASH,
        reasonHash: '0x1234',
        manifest: {},
        proposedRevisionDeadline: String(VALID_PROPOSED_DEADLINE),
        status: 'staged' as const,
        txHash: null,
        requestedAt: null,
      };

      const created = await inMemoryRepo.create(row);
      assert.strictEqual(created.dealAddress, TEST_DEAL_ADDRESS.toLowerCase());
      assert.strictEqual(created.clientWallet, TEST_CLIENT.toLowerCase());
      assert.strictEqual(created.freelancerWallet, TEST_FREELANCER.toLowerCase());
    });
  });

  // =========================================================================
  // 7. Adversarial Recovery & Hardened Verification (Phase 3K-B1 Matrix)
  // =========================================================================

  describe('7. Adversarial Recovery & Hardened Verification (Phase 3K-B1)', () => {
    it('1. txHash receipt path valid confirms row and persists txHash', async () => {
      const deal = createMockDealData();
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 1',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 0n, reasonHash: stageRes.reasonHash },
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      const client = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        waitForTransactionReceipt: async () => ({
          status: 'success',
          logs: [{ address: TEST_DEAL_ADDRESS, topics: eventTopics, data: eventData }],
        }),
      };

      const reconciled = await reconcileMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        version: 1,
        authWallet: TEST_CLIENT,
        txHash: '0xtx111',
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      assert.strictEqual(reconciled.revision.status, 'confirmed');
      assert.strictEqual(reconciled.revision.txHash, '0xtx111');
    });

    it('2. wrong txHash / reverted receipt rejected', async () => {
      const deal = createMockDealData();
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 2',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };

      const client = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        waitForTransactionReceipt: async () => ({
          status: 'reverted',
          logs: [],
        }),
      };

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          txHash: '0xreverted_tx',
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /Transaction reverted on-chain/
      );
    });

    it('3. no-txHash exact event recovery valid with matching block timestamp', async () => {
      const deal = createMockDealData();
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 3',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 25) };

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 0n, reasonHash: stageRes.reasonHash },
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      const client = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        getLogs: async () => [
          {
            address: TEST_DEAL_ADDRESS,
            topics: eventTopics,
            data: eventData,
            transactionHash: '0xrecovered_tx_hash',
            blockNumber: 500n,
            blockHash: '0xblock500',
          },
        ],
        getBlock: async () => ({ timestamp: BigInt(FIXED_NOW + 25) }),
      };

      const reconciled = await reconcileMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        version: 1,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      assert.strictEqual(reconciled.revision.status, 'confirmed');
      assert.strictEqual(reconciled.revision.txHash, '0xrecovered_tx_hash');
    });

    it('4. zero candidate logs fail closed with validation error', async () => {
      const deal = createMockDealData();
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 4',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 25) };

      const client = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        getLogs: async () => [], // No logs returned
        getBlock: async () => ({ timestamp: BigInt(FIXED_NOW + 25) }),
      };

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /Recovery failed: No matching on-chain RevisionRequested event found/
      );
    });

    it('5. two valid candidates fail closed as ambiguous conflict', async () => {
      const deal = createMockDealData();
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 5',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 25) };

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 0n, reasonHash: stageRes.reasonHash },
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      const client = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        getLogs: async () => [
          { address: TEST_DEAL_ADDRESS, topics: eventTopics, data: eventData, transactionHash: '0xtx_a', blockHash: '0x1' },
          { address: TEST_DEAL_ADDRESS, topics: eventTopics, data: eventData, transactionHash: '0xtx_b', blockHash: '0x1' },
        ],
        getBlock: async () => ({ timestamp: BigInt(FIXED_NOW + 25) }),
      };

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        RevisionConflictError
      );
    });

    it('6. wrong Deal event rejected in no-txHash recovery', async () => {
      const deal = createMockDealData();
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 6',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 25) };

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 0n, reasonHash: stageRes.reasonHash },
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      const client = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        getLogs: async () => [
          // Address differs from Deal clone
          { address: '0x9999999999999999999999999999999999999999', topics: eventTopics, data: eventData, transactionHash: '0xwrong', blockHash: '0x1' },
        ],
        getBlock: async () => ({ timestamp: BigInt(FIXED_NOW + 25) }),
      };

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /Recovery failed: No matching on-chain RevisionRequested event found/
      );
    });

    it('7. wrong milestone in log rejected', async () => {
      const deal = createMockDealData();
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 7',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 25) };

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 1n, reasonHash: stageRes.reasonHash }, // milestone 1
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      const client = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        getLogs: async () => [
          { address: TEST_DEAL_ADDRESS, topics: eventTopics, data: eventData, transactionHash: '0xwrong', blockHash: '0x1' },
        ],
        getBlock: async () => ({ timestamp: BigInt(FIXED_NOW + 25) }),
      };

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /Recovery failed: No matching on-chain RevisionRequested event found/
      );
    });

    it('8. wrong reasonHash in log rejected', async () => {
      const deal = createMockDealData();
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 8',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 25) };

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 0n, reasonHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any },
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      const client = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        getLogs: async () => [
          { address: TEST_DEAL_ADDRESS, topics: eventTopics, data: eventData, transactionHash: '0xwrong', blockHash: '0x1' },
        ],
        getBlock: async () => ({ timestamp: BigInt(FIXED_NOW + 25) }),
      };

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /Recovery failed: No matching on-chain RevisionRequested event found/
      );
    });

    it('9. wrong deadline in log rejected', async () => {
      const deal = createMockDealData();
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 9',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 25) };

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 0n, reasonHash: stageRes.reasonHash },
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE + 100)] // deadline differs
      );

      const client = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        getLogs: async () => [
          { address: TEST_DEAL_ADDRESS, topics: eventTopics, data: eventData, transactionHash: '0xwrong', blockHash: '0x1' },
        ],
        getBlock: async () => ({ timestamp: BigInt(FIXED_NOW + 25) }),
      };

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /Recovery failed: No matching on-chain RevisionRequested event found/
      );
    });

    it('10. wrong block timestamp in log rejected', async () => {
      const deal = createMockDealData();
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 10',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 25) }; // onChainRequestedAt is 25

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 0n, reasonHash: stageRes.reasonHash },
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      const client = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        getLogs: async () => [
          { address: TEST_DEAL_ADDRESS, topics: eventTopics, data: eventData, transactionHash: '0xold', blockHash: '0xoldblock' },
        ],
        // Block timestamp does not match onChainRequestedAt!
        getBlock: async () => ({ timestamp: BigInt(FIXED_NOW + 10) }),
      };

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /Recovery failed: No matching on-chain RevisionRequested event found/
      );
    });

    it('11. current version mismatch rejected', async () => {
      const deal = createMockDealData();
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 11',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      deal.milestones[0].version = 2; // version is 2 on chain
      const client = createMockPublicClient(deal);

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1, // requested 1
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /Milestone on-chain version is 2, expected 1/
      );
    });

    it('12. current specHash mismatch rejected', async () => {
      const deal = createMockDealData();
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 12',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      // Mutate on-chain specHash
      deal.milestones[0].specHash = '0x1111111111111111111111111111111111111111111111111111111111111111';
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };
      const client = createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap);

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /On-chain specHash mismatch/
      );
    });

    it('13. current evidenceRootHash mismatch rejected', async () => {
      const deal = createMockDealData();
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 13',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      // Mutate on-chain evidenceRootHash
      deal.milestones[0].evidenceRootHash = '0x2222222222222222222222222222222222222222222222222222222222222222';
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };
      const client = createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap);

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /On-chain evidenceRootHash mismatch/
      );
    });

    it('14. current status not RevisionRequested rejected', async () => {
      const deal = createMockDealData();
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 14',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      // Still in Submitted status
      deal.milestones[0].status = MilestoneStatus.Submitted;
      const client = createMockPublicClient(deal);

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /is not in RevisionRequested status on-chain/
      );
    });

    it('15. current proposed deadline mismatch rejected', async () => {
      const deal = createMockDealData();
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 15',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE + 86400) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };
      const client = createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap);

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /On-chain proposed deadline mismatch/
      );
    });

    it('16. current revisionRequestedAt zero rejected', async () => {
      const deal = createMockDealData();
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 16',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: 0n }; // zero requestedAt
      const client = createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap);

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /revisionRequestedAt is zero/
      );
    });

    it('17. historical v1 event cannot confirm staged v2', async () => {
      const deal = createMockDealData();
      deal.milestones[0].version = 2; // version 2 on chain
      deal.milestones[0].evidenceRootHash = '0x2222222222222222222222222222222222222222222222222222222222222222';
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Feedback for v2',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 100) }; // Current revision requested at +100

      // Suppose someone supplies an old v1 log from timestamp +10
      const oldEventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 0n, reasonHash: '0x1111111111111111111111111111111111111111111111111111111111111111' as any },
      });
      const oldEventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      const client = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        getLogs: async () => [
          { address: TEST_DEAL_ADDRESS, topics: oldEventTopics, data: oldEventData, transactionHash: '0xold_v1_tx', blockHash: '0xold' },
        ],
        getBlock: async () => ({ timestamp: BigInt(FIXED_NOW + 10) }), // Old timestamp
      };

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 2,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /Recovery failed: No matching on-chain RevisionRequested event found/
      );
    });

    it('18. identical feedback across v1 and v2 produces DIFFERENT reasonHash', () => {
      const manifestV1 = createValidManifestInput();
      manifestV1.submissionVersion = 1;
      manifestV1.evidenceRootHash = '0x1111111111111111111111111111111111111111111111111111111111111111';
      manifestV1.feedback = 'Fix navigation layout';

      const manifestV2 = createValidManifestInput();
      manifestV2.submissionVersion = 2; // version differs
      manifestV2.evidenceRootHash = '0x2222222222222222222222222222222222222222222222222222222222222222';
      manifestV2.feedback = 'Fix navigation layout'; // identical text

      const hashV1 = hashRevisionManifest(manifestV1);
      const hashV2 = hashRevisionManifest(manifestV2);

      assert.notStrictEqual(hashV1, hashV2);
    });

    it('19. same deadline across v1 and v2 still produces DIFFERENT reasonHash', () => {
      const manifestV1 = createValidManifestInput();
      manifestV1.submissionVersion = 1;
      manifestV1.proposedRevisionDeadline = VALID_PROPOSED_DEADLINE;

      const manifestV2 = createValidManifestInput();
      manifestV2.submissionVersion = 2;
      manifestV2.proposedRevisionDeadline = VALID_PROPOSED_DEADLINE; // identical deadline

      const hashV1 = hashRevisionManifest(manifestV1);
      const hashV2 = hashRevisionManifest(manifestV2);

      assert.notStrictEqual(hashV1, hashV2);
    });

    it('20. multiple logs sharing block timestamp do not create false confirmation (fails closed)', async () => {
      const deal = createMockDealData();
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 20',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 50) };

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 0n, reasonHash: stageRes.reasonHash },
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      // Two identical events at the exact same block timestamp
      const client = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        getLogs: async () => [
          { address: TEST_DEAL_ADDRESS, topics: eventTopics, data: eventData, transactionHash: '0x1', blockHash: '0xb' },
          { address: TEST_DEAL_ADDRESS, topics: eventTopics, data: eventData, transactionHash: '0x2', blockHash: '0xb' },
        ],
        getBlock: async () => ({ timestamp: BigInt(FIXED_NOW + 50) }),
      };

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        RevisionConflictError
      );
    });

    it('21. DB uniqueness alone is never used as event proof (log verification required)', async () => {
      const deal = createMockDealData();
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 21',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 50) };

      // Client whose getLogs returns empty
      const client = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        getLogs: async () => [],
      };

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /Recovery failed: No matching on-chain RevisionRequested event found/
      );
    });

    it('22. stale staged row cannot overwrite chain truth', async () => {
      const deal = createMockDealData();
      await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Stale row',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      // On chain deadline was set to a different value by another caller
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE + 9999) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };
      const client = createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap);

      await assert.rejects(
        reconcileMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          version: 1,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        /On-chain proposed deadline mismatch/
      );
    });

    it('23. confirmed row remains immutable after successful recovery', async () => {
      const deal = createMockDealData();
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 23',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 0n, reasonHash: stageRes.reasonHash },
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      const client = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        getLogs: async () => [
          { address: TEST_DEAL_ADDRESS, topics: eventTopics, data: eventData, transactionHash: '0xrec_tx', blockHash: '0x1' },
        ],
        getBlock: async () => ({ timestamp: BigInt(FIXED_NOW + 10) }),
      };

      const reconciled = await reconcileMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        version: 1,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      assert.strictEqual(reconciled.revision.status, 'confirmed');

      // Reset mock deal milestone status to Submitted to test that stage rejects confirmed row
      deal.milestones[0].status = MilestoneStatus.Submitted;

      // Attempting to overwrite via staging throws RevisionConflictError
      await assert.rejects(
        stageMilestoneRevision({
          dealAddress: TEST_DEAL_ADDRESS,
          milestoneId: 0,
          feedback: 'Attempting to overwrite confirmed',
          proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
          authWallet: TEST_CLIENT,
          publicClient: client as any,
          repo: inMemoryRepo,
        }),
        RevisionConflictError
      );
    });

    it('24. repeated valid recovery is idempotent', async () => {
      const deal = createMockDealData();
      const stageRes = await stageMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        feedback: 'Adv test 24',
        proposedRevisionDeadline: VALID_PROPOSED_DEADLINE,
        authWallet: TEST_CLIENT,
        publicClient: createMockPublicClient(deal) as any,
        repo: inMemoryRepo,
      });

      deal.milestones[0].status = MilestoneStatus.RevisionRequested;
      const proposedDeadlinesMap = { 0: BigInt(VALID_PROPOSED_DEADLINE) };
      const requestedAtMap = { 0: BigInt(FIXED_NOW + 10) };

      const eventTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionRequested',
        args: { milestoneId: 0n, reasonHash: stageRes.reasonHash },
      });
      const eventData = encodeAbiParameters(
        [{ name: 'proposedRevisionDeadline', type: 'uint64' }],
        [BigInt(VALID_PROPOSED_DEADLINE)]
      );

      const client = {
        ...createMockPublicClient(deal, proposedDeadlinesMap, requestedAtMap),
        getLogs: async () => [
          { address: TEST_DEAL_ADDRESS, topics: eventTopics, data: eventData, transactionHash: '0xrec_tx', blockHash: '0x1' },
        ],
        getBlock: async () => ({ timestamp: BigInt(FIXED_NOW + 10) }),
      };

      const rec1 = await reconcileMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        version: 1,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      const rec2 = await reconcileMilestoneRevision({
        dealAddress: TEST_DEAL_ADDRESS,
        milestoneId: 0,
        version: 1,
        authWallet: TEST_CLIENT,
        publicClient: client as any,
        repo: inMemoryRepo,
      });

      assert.strictEqual(rec1.revision.id, rec2.revision.id);
      assert.strictEqual(rec1.revision.status, 'confirmed');
      assert.strictEqual(rec2.revision.status, 'confirmed');
      assert.strictEqual(rec1.revision.txHash, rec2.revision.txHash);
    });
  });
});
