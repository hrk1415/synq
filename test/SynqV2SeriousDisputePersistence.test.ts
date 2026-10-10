import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSeriousDisputeManifest,
  canonicalizeSeriousDisputeManifest,
  hashSeriousDisputeManifest,
  determineSeriousDisputeEligibility,
  verifySeriousDisputeOpenedReceipt,
  DisputeValidationError,
  DISPUTE_SCHEMA_VERSION,
  DISPUTE_LIMITS,
} from '../src/lib/deals/v2-dispute';
import {
  stageMilestoneDispute,
  reconcileMilestoneDispute,
  getMilestoneDispute,
  DisputeAuthError,
  DisputeConflictError,
  DisputeIntegrityError,
  type IMilestoneDisputeRepository,
} from '../src/lib/deals/disputes-db';
import { DealState, MilestoneStatus } from '../src/lib/deals/v2-deal';
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters } from 'viem';
import { synqDealV1ABI } from '../src/lib/contracts/abis';
import type { MilestoneDisputeRow, NewMilestoneDisputeRow } from '../src/db/schema';

// Mock In-Memory Repository for unit testing
class MockDisputeRepository implements IMilestoneDisputeRepository {
  private rows: Map<string, MilestoneDisputeRow> = new Map();

  private key(chainId: number, dealAddress: string, milestoneId: number): string {
    return `${chainId}:${dealAddress.toLowerCase()}:${milestoneId}`;
  }

  async getByMilestone(
    chainId: number,
    dealAddress: string,
    milestoneId: number
  ): Promise<MilestoneDisputeRow | null> {
    const k = this.key(chainId, dealAddress, milestoneId);
    return this.rows.get(k) ?? null;
  }

  async create(row: NewMilestoneDisputeRow): Promise<MilestoneDisputeRow> {
    const k = this.key(row.chainId, row.dealAddress, row.milestoneId);
    const fullRow: MilestoneDisputeRow = {
      id: row.id ?? `dispute-${Date.now()}-${Math.random()}`,
      chainId: row.chainId,
      dealAddress: row.dealAddress.toLowerCase(),
      milestoneId: row.milestoneId,
      submissionVersion: row.submissionVersion,
      specHash: row.specHash.toLowerCase(),
      evidenceRootHash: row.evidenceRootHash.toLowerCase(),
      openerWallet: row.openerWallet.toLowerCase(),
      counterpartyWallet: row.counterpartyWallet.toLowerCase(),
      reasonHash: row.reasonHash.toLowerCase(),
      canonicalManifest: row.canonicalManifest,
      status: row.status ?? 'staged',
      txHash: row.txHash ?? null,
      openedAt: row.openedAt ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.set(k, fullRow);
    return fullRow;
  }

  async updateStaged(
    id: string,
    data: {
      reasonHash: string;
      canonicalManifest: Record<string, unknown>;
      submissionVersion: number;
      specHash: string;
      evidenceRootHash: string;
      updatedAt: Date;
    }
  ): Promise<MilestoneDisputeRow> {
    for (const [k, row] of this.rows.entries()) {
      if (row.id === id) {
        const updated: MilestoneDisputeRow = {
          ...row,
          reasonHash: data.reasonHash.toLowerCase(),
          canonicalManifest: data.canonicalManifest,
          submissionVersion: data.submissionVersion,
          specHash: data.specHash.toLowerCase(),
          evidenceRootHash: data.evidenceRootHash.toLowerCase(),
          updatedAt: data.updatedAt,
        };
        this.rows.set(k, updated);
        return updated;
      }
    }
    throw new Error('Not found');
  }

  async confirm(
    id: string,
    data: {
      txHash: string | null;
      openedAt: Date;
      updatedAt: Date;
    }
  ): Promise<MilestoneDisputeRow> {
    for (const [k, row] of this.rows.entries()) {
      if (row.id === id) {
        const updated: MilestoneDisputeRow = {
          ...row,
          status: 'confirmed',
          txHash: data.txHash ? data.txHash.toLowerCase() : null,
          openedAt: data.openedAt,
          updatedAt: data.updatedAt,
        };
        this.rows.set(k, updated);
        return updated;
      }
    }
    throw new Error('Not found');
  }
}

// Test fixtures
const CLIENT = '0x1111111111111111111111111111111111111111' as const;
const FREELANCER = '0x2222222222222222222222222222222222222222' as const;
const DEAL_ADDR = '0x3333333333333333333333333333333333333333' as const;
const SPEC_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const ROOT_HASH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

function createMockPublicClient(dealState: DealState, milestoneStatus: MilestoneStatus, milestoneOverrides = {}) {
  return {
    readContract: async ({ functionName, args }: any) => {
      if (functionName === 'isSynqDeal' || functionName === 'isDeal') return true;
      if (functionName === 'state') return dealState;
      if (functionName === 'isProtected') return false;
      if (functionName === 'client') return CLIENT;
      if (functionName === 'freelancer') return FREELANCER;
      if (functionName === 'usdc') return '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
      if (functionName === 'primaryResolver') return '0x4444444444444444444444444444444444444444';
      if (functionName === 'emergencyResolver') return '0x5555555555555555555555555555555555555555';
      if (functionName === 'totalEscrow') return 1000000000n;
      if (functionName === 'totalSettled') return 0n;
      if (functionName === 'milestoneCount') return 1n;
      if (functionName === 'milestones' || functionName === 'getMilestone') {
        return {
          amount: 1000000000n,
          workDeadline: 2000000000n,
          reviewWindow: 604800n,
          gracePeriod: 86400n,
          status: milestoneStatus,
          specHash: SPEC_HASH,
          evidenceRootHash: ROOT_HASH,
          submittedAt: 1900000000n,
          version: 1n,
          ...milestoneOverrides,
        };
      }
      if (functionName === 'proposedRevisionDeadlines') return 0n;
      if (functionName === 'revisionRequestedAt') return 0n;
      if (functionName === 'milestoneDisputeOpenedAt') return 1950000000n;
      if (functionName === 'policyId') return ZERO_HASH;
      if (functionName === 'isDisputed') return milestoneStatus === MilestoneStatus.Disputed;
      throw new Error(`Unhandled mock function ${functionName}`);
    },
    getTransactionReceipt: async () => null,
  };
}

test('SYNQ Phase 3L-B: Serious Dispute Manifest & Persistence Suite', async (t) => {
  await t.test('1. Normalizes valid dispute manifest with all fields', () => {
    const raw = {
      schemaVersion: 1,
      chainId: 11155111,
      dealAddress: ('0x' + DEAL_ADDR.slice(2).toUpperCase()) as `0x${string}`,
      milestoneId: 0,
      submissionVersion: 1,
      specHash: ('0x' + SPEC_HASH.slice(2).toUpperCase()) as `0x${string}`,
      evidenceRootHash: ('0x' + ROOT_HASH.slice(2).toUpperCase()) as `0x${string}`,
      openerWallet: ('0x' + CLIENT.slice(2).toUpperCase()) as `0x${string}`,
      counterpartyWallet: ('0x' + FREELANCER.slice(2).toUpperCase()) as `0x${string}`,
      explanation: '   Work delivered breaches architecture requirements.   ',
      category: 'specification_breach',
      links: [
        { type: 'web', value: 'https://github.com/synq/repo/pull/42', label: 'PR' },
      ],
    };

    const normalized = normalizeSeriousDisputeManifest(raw);
    assert.equal(normalized.schemaVersion, 1);
    assert.equal(normalized.chainId, 11155111);
    assert.equal(normalized.dealAddress, DEAL_ADDR.toLowerCase());
    assert.equal(normalized.milestoneId, 0);
    assert.equal(normalized.submissionVersion, 1);
    assert.equal(normalized.specHash, SPEC_HASH.toLowerCase());
    assert.equal(normalized.evidenceRootHash, ROOT_HASH.toLowerCase());
    assert.equal(normalized.openerWallet, CLIENT.toLowerCase());
    assert.equal(normalized.counterpartyWallet, FREELANCER.toLowerCase());
    assert.equal(normalized.explanation, 'Work delivered breaches architecture requirements.');
    assert.equal(normalized.category, 'specification_breach');
    assert.equal(normalized.links?.length, 1);
  });

  await t.test('2. Accepts version 0 and zero evidenceRootHash for in-progress disputes', () => {
    const raw = {
      schemaVersion: 1,
      chainId: 11155111,
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      submissionVersion: 0,
      specHash: SPEC_HASH,
      evidenceRootHash: ZERO_HASH,
      openerWallet: FREELANCER,
      counterpartyWallet: CLIENT,
      explanation: 'Client is completely unresponsive to critical spec blocking questions.',
      category: 'unresponsive',
    };

    const normalized = normalizeSeriousDisputeManifest(raw);
    assert.equal(normalized.submissionVersion, 0);
    assert.equal(normalized.evidenceRootHash, ZERO_HASH);
  });

  await t.test('3. Rejects invalid schemaVersion', () => {
    assert.throws(
      () =>
        normalizeSeriousDisputeManifest({
          schemaVersion: 2,
          chainId: 11155111,
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          submissionVersion: 1,
          specHash: SPEC_HASH,
          evidenceRootHash: ROOT_HASH,
          openerWallet: CLIENT,
          counterpartyWallet: FREELANCER,
          explanation: 'Reason',
        }),
      /Invalid schemaVersion/
    );
  });

  await t.test('4. Rejects invalid EVM address in dealAddress', () => {
    assert.throws(
      () =>
        normalizeSeriousDisputeManifest({
          schemaVersion: 1,
          chainId: 11155111,
          dealAddress: '0xnotanaddress',
          milestoneId: 0,
          submissionVersion: 1,
          specHash: SPEC_HASH,
          evidenceRootHash: ROOT_HASH,
          openerWallet: CLIENT,
          counterpartyWallet: FREELANCER,
          explanation: 'Reason',
        }),
      /Invalid dealAddress/
    );
  });

  await t.test('5. Rejects opener equal to counterparty', () => {
    assert.throws(
      () =>
        normalizeSeriousDisputeManifest({
          schemaVersion: 1,
          chainId: 11155111,
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          submissionVersion: 1,
          specHash: SPEC_HASH,
          evidenceRootHash: ROOT_HASH,
          openerWallet: CLIENT,
          counterpartyWallet: CLIENT,
          explanation: 'Reason',
        }),
      /openerWallet cannot equal counterpartyWallet/
    );
  });

  await t.test('6. Rejects empty explanation or explanation exceeding 4000 chars', () => {
    assert.throws(
      () =>
        normalizeSeriousDisputeManifest({
          schemaVersion: 1,
          chainId: 11155111,
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          submissionVersion: 1,
          specHash: SPEC_HASH,
          evidenceRootHash: ROOT_HASH,
          openerWallet: CLIENT,
          counterpartyWallet: FREELANCER,
          explanation: '   ',
        }),
      /Explanation cannot be empty/
    );

    const longExplanation = 'a'.repeat(4001);
    assert.throws(
      () =>
        normalizeSeriousDisputeManifest({
          schemaVersion: 1,
          chainId: 11155111,
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          submissionVersion: 1,
          specHash: SPEC_HASH,
          evidenceRootHash: ROOT_HASH,
          openerWallet: CLIENT,
          counterpartyWallet: FREELANCER,
          explanation: longExplanation,
        }),
      /exceeds maximum of 4000 characters/
    );
  });

  await t.test('7. Preserves internal line breaks and Unicode NFC in explanation', () => {
    const raw = {
      schemaVersion: 1,
      chainId: 11155111,
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      submissionVersion: 1,
      specHash: SPEC_HASH,
      evidenceRootHash: ROOT_HASH,
      openerWallet: CLIENT,
      counterpartyWallet: FREELANCER,
      explanation: 'Line 1\n\nLine 2 with Café and résumé',
    };

    const normalized = normalizeSeriousDisputeManifest(raw);
    assert.equal(normalized.explanation, 'Line 1\n\nLine 2 with Café and résumé');
  });

  await t.test('8. Validates category against allowed enum', () => {
    assert.throws(
      () =>
        normalizeSeriousDisputeManifest({
          schemaVersion: 1,
          chainId: 11155111,
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          submissionVersion: 1,
          specHash: SPEC_HASH,
          evidenceRootHash: ROOT_HASH,
          openerWallet: CLIENT,
          counterpartyWallet: FREELANCER,
          explanation: 'Reason',
          category: 'invalid_category',
        }),
      /Invalid category/
    );
  });

  await t.test('9. Rejects exceeding 20 evidence links', () => {
    const links = Array.from({ length: 21 }, (_, i) => ({
      type: 'web',
      value: `https://example.com/item/${i}`,
    }));

    assert.throws(
      () =>
        normalizeSeriousDisputeManifest({
          schemaVersion: 1,
          chainId: 11155111,
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          submissionVersion: 1,
          specHash: SPEC_HASH,
          evidenceRootHash: ROOT_HASH,
          openerWallet: CLIENT,
          counterpartyWallet: FREELANCER,
          explanation: 'Reason',
          links,
        }),
      /exceeds maximum limit of 20/
    );
  });

  await t.test('10. JCS canonicalization produces identical hash regardless of key order', () => {
    const objA = {
      schemaVersion: 1,
      chainId: 11155111,
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      submissionVersion: 1,
      specHash: SPEC_HASH,
      evidenceRootHash: ROOT_HASH,
      openerWallet: CLIENT,
      counterpartyWallet: FREELANCER,
      explanation: 'Breach of agreement',
      category: 'bad_faith',
    };

    const objB = {
      explanation: 'Breach of agreement',
      category: 'bad_faith',
      counterpartyWallet: FREELANCER,
      openerWallet: CLIENT,
      evidenceRootHash: ROOT_HASH,
      specHash: SPEC_HASH,
      submissionVersion: 1,
      milestoneId: 0,
      dealAddress: DEAL_ADDR,
      chainId: 11155111,
      schemaVersion: 1,
    };

    const hashA = hashSeriousDisputeManifest(objA);
    const hashB = hashSeriousDisputeManifest(objB);
    assert.equal(hashA, hashB);
    assert.match(hashA, /^0x[0-9a-f]{64}$/);
  });

  await t.test('11. Eligibility: allows InProgress, Submitted, RevisionRequested', () => {
    const eligible1 = determineSeriousDisputeEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.InProgress,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(eligible1.eligible, true);

    const eligible2 = determineSeriousDisputeEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.Submitted,
      isClient: false,
      isFreelancer: true,
    });
    assert.equal(eligible2.eligible, true);

    const eligible3 = determineSeriousDisputeEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.RevisionRequested,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(eligible3.eligible, true);
  });

  await t.test('12. Eligibility: rejects Pending, Disputed, SettledPaid, SettledSplit', () => {
    const ineligibles = [
      MilestoneStatus.Pending,
      MilestoneStatus.Disputed,
      MilestoneStatus.SettledPaid,
      MilestoneStatus.SettledRefunded,
      MilestoneStatus.SettledSplit,
    ];

    for (const status of ineligibles) {
      const res = determineSeriousDisputeEligibility({
        dealState: DealState.Active,
        milestoneStatus: status,
        isClient: true,
        isFreelancer: false,
      });
      assert.equal(res.eligible, false);
    }
  });

  await t.test('13. Eligibility: rejects outsider, inactive deal, or protected deal', () => {
    const resOutsider = determineSeriousDisputeEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.Submitted,
      isClient: false,
      isFreelancer: false,
    });
    assert.equal(resOutsider.eligible, false);

    const resInactive = determineSeriousDisputeEligibility({
      dealState: DealState.Completed,
      milestoneStatus: MilestoneStatus.Submitted,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(resInactive.eligible, false);

    const resProtected = determineSeriousDisputeEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.Submitted,
      isClient: true,
      isFreelancer: false,
      isProtected: true,
    });
    assert.equal(resProtected.eligible, false);
  });

  await t.test('14. verifySeriousDisputeOpenedReceipt: successfully decodes and validates event', () => {
    const expectedReasonHash = '0x1234567890123456789012345678901234567890123456789012345678901234' as const;
    const topics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'SeriousDisputeOpened',
      args: {
        milestoneId: 0n,
        opener: CLIENT,
      },
    });
    const data = encodeAbiParameters(parseAbiParameters('bytes32'), [expectedReasonHash]);

    const receipt = {
      status: 'success',
      logs: [{ topics, data, address: DEAL_ADDR }],
    };

    const res = verifySeriousDisputeOpenedReceipt(
      receipt,
      DEAL_ADDR,
      0n,
      CLIENT,
      expectedReasonHash
    );

    assert.equal(res.valid, true);
    assert.equal(res.seriousDisputeOpenedEvent?.milestoneId, 0n);
    assert.equal(res.seriousDisputeOpenedEvent?.opener, CLIENT.toLowerCase());
    assert.equal(res.seriousDisputeOpenedEvent?.reasonHash, expectedReasonHash.toLowerCase());
  });

  await t.test('15. verifySeriousDisputeOpenedReceipt: fails on milestoneId mismatch or reasonHash mismatch', () => {
    const testReasonHash = '0x1234567890123456789012345678901234567890123456789012345678901234' as const;
    const topics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'SeriousDisputeOpened',
      args: {
        milestoneId: 1n,
        opener: CLIENT,
      },
    });
    const data = encodeAbiParameters(parseAbiParameters('bytes32'), [testReasonHash]);

    const receipt = {
      status: 'success',
      logs: [{ topics, data, address: DEAL_ADDR }],
    };

    const res = verifySeriousDisputeOpenedReceipt(
      receipt,
      DEAL_ADDR,
      0n, // expected 0
      CLIENT,
      testReasonHash
    );

    assert.equal(res.valid, false);
    assert.match(res.error!, /milestoneId mismatch/);
  });

  await t.test('16. stageMilestoneDispute: stages a new dispute successfully', async () => {
    const repo = new MockDisputeRepository();
    const mockClient = createMockPublicClient(DealState.Active, MilestoneStatus.Submitted);

    const result = await stageMilestoneDispute({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: CLIENT,
      explanation: 'Work fails core latency and throughput benchmarks',
      category: 'quality_dispute',
      publicClient: mockClient as any,
      repo,
    });

    assert.equal(result.row.status, 'staged');
    assert.equal(result.row.openerWallet, CLIENT.toLowerCase());
    assert.equal(result.row.counterpartyWallet, FREELANCER.toLowerCase());
    assert.equal(result.row.reasonHash, result.reasonHash);
    assert.equal(result.manifest.explanation, 'Work fails core latency and throughput benchmarks');
  });

  await t.test('17. stageMilestoneDispute: re-staging by same opener updates staged manifest', async () => {
    const repo = new MockDisputeRepository();
    const mockClient = createMockPublicClient(DealState.Active, MilestoneStatus.Submitted);

    await stageMilestoneDispute({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: CLIENT,
      explanation: 'Version 1 explanation',
      publicClient: mockClient as any,
      repo,
    });

    const updated = await stageMilestoneDispute({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: CLIENT,
      explanation: 'Version 2 refined explanation with more details',
      publicClient: mockClient as any,
      repo,
    });

    assert.equal(updated.row.status, 'staged');
    assert.equal(updated.manifest.explanation, 'Version 2 refined explanation with more details');
  });

  await t.test('18. stageMilestoneDispute: rejects re-staging by counterparty while unconfirmed', async () => {
    const repo = new MockDisputeRepository();
    const mockClient = createMockPublicClient(DealState.Active, MilestoneStatus.Submitted);

    await stageMilestoneDispute({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: CLIENT,
      explanation: 'Client explanation',
      publicClient: mockClient as any,
      repo,
    });

    await assert.rejects(
      () =>
        stageMilestoneDispute({
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          callerWallet: FREELANCER,
          explanation: 'Competing freelancer explanation',
          publicClient: mockClient as any,
          repo,
        }),
      DisputeConflictError
    );
  });

  await t.test('19. stageMilestoneDispute: rejects staging if already confirmed on-chain', async () => {
    const repo = new MockDisputeRepository();
    const mockClient = createMockPublicClient(DealState.Active, MilestoneStatus.Submitted);

    const staged = await stageMilestoneDispute({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: CLIENT,
      explanation: 'Client explanation',
      publicClient: mockClient as any,
      repo,
    });

    await repo.confirm(staged.row.id, {
      txHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
      openedAt: new Date(),
      updatedAt: new Date(),
    });

    await assert.rejects(
      () =>
        stageMilestoneDispute({
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          callerWallet: CLIENT,
          explanation: 'Attempt to overwrite confirmed dispute',
          publicClient: mockClient as any,
          repo,
        }),
      DisputeConflictError
    );
  });

  await t.test('20. reconcileMilestoneDispute: confirms staged dispute with valid tx receipt', async () => {
    const repo = new MockDisputeRepository();
    const stageClient = createMockPublicClient(DealState.Active, MilestoneStatus.Submitted);

    const staged = await stageMilestoneDispute({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: CLIENT,
      explanation: 'Work fails specifications',
      publicClient: stageClient as any,
      repo,
    });

    const txHash = '0x1212121212121212121212121212121212121212121212121212121212121212' as const;
    const topics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'SeriousDisputeOpened',
      args: {
        milestoneId: 0n,
        opener: CLIENT,
      },
    });
    const data = encodeAbiParameters(parseAbiParameters('bytes32'), [staged.reasonHash as `0x${string}`]);

    const reconcileClient = {
      ...createMockPublicClient(DealState.Active, MilestoneStatus.Disputed),
      getTransactionReceipt: async () => ({
        status: 'success',
        logs: [{ topics, data, address: DEAL_ADDR }],
      }),
    };

    const confirmed = await reconcileMilestoneDispute({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: CLIENT,
      txHash,
      publicClient: reconcileClient as any,
      repo,
    });

    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.txHash, txHash.toLowerCase());
    assert.ok(confirmed.openedAt);
  });

  await t.test('21. reconcileMilestoneDispute: crash recovery without txHash finds log and confirms', async () => {
    const repo = new MockDisputeRepository();
    const stageClient = createMockPublicClient(DealState.Active, MilestoneStatus.Submitted);

    const staged = await stageMilestoneDispute({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: CLIENT,
      explanation: 'Work fails specifications',
      publicClient: stageClient as any,
      repo,
    });

    const crashRecoveryClient = {
      ...createMockPublicClient(DealState.Active, MilestoneStatus.Disputed),
      getLogs: async () => [
        {
          transactionHash: '0x8888888888888888888888888888888888888888888888888888888888888888',
          args: {
            milestoneId: 0n,
            opener: CLIENT,
            reasonHash: staged.reasonHash,
          },
        },
      ],
    };

    const confirmed = await reconcileMilestoneDispute({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: CLIENT,
      publicClient: crashRecoveryClient as any,
      repo,
    });

    assert.equal(confirmed.status, 'confirmed');
    assert.equal(
      confirmed.txHash,
      '0x8888888888888888888888888888888888888888888888888888888888888888'
    );
  });

  await t.test('22. reconcileMilestoneDispute: crash recovery fails closed if 0 events found', async () => {
    const repo = new MockDisputeRepository();
    const stageClient = createMockPublicClient(DealState.Active, MilestoneStatus.Submitted);

    await stageMilestoneDispute({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: CLIENT,
      explanation: 'Work fails specifications',
      publicClient: stageClient as any,
      repo,
    });

    // Milestone is disputed on chain, but zero SeriousDisputeOpened events found (e.g. revision decline)
    const zeroLogsClient = {
      ...createMockPublicClient(DealState.Active, MilestoneStatus.Disputed),
      getLogs: async () => [],
    };

    await assert.rejects(
      () =>
        reconcileMilestoneDispute({
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          callerWallet: CLIENT,
          publicClient: zeroLogsClient as any,
          repo,
        }),
      /Crash recovery failed: No SeriousDisputeOpened event found/
    );
  });

  await t.test('23. Privacy: getMilestoneDispute blocks outsiders and allows participants', async () => {
    const repo = new MockDisputeRepository();
    const mockClient = createMockPublicClient(DealState.Active, MilestoneStatus.Submitted);

    await stageMilestoneDispute({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: CLIENT,
      explanation: 'Private feedback',
      publicClient: mockClient as any,
      repo,
    });

    // Client can view
    const clientView = await getMilestoneDispute({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: CLIENT,
      publicClient: mockClient as any,
      repo,
    });
    assert.ok(clientView);

    // Freelancer can view
    const freelancerView = await getMilestoneDispute({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: FREELANCER,
      publicClient: mockClient as any,
      repo,
    });
    assert.ok(freelancerView);

    // Outsider is rejected
    await assert.rejects(
      () =>
        getMilestoneDispute({
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          callerWallet: '0x9999999999999999999999999999999999999999',
          publicClient: mockClient as any,
          repo,
        }),
      DisputeAuthError
    );
  });

  await t.test('24. False-confirmation protection: declineRevision receipt cannot confirm staged serious dispute', async () => {
    const repo = new MockDisputeRepository();
    const stageClient = createMockPublicClient(DealState.Active, MilestoneStatus.Submitted);

    await stageMilestoneDispute({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: CLIENT,
      explanation: 'Work fails specifications',
      publicClient: stageClient as any,
      repo,
    });

    // Mock receipt emitted by declineRevision: RevisionDeclined and MilestoneDisputed(0, freelancer, bytes32(0))
    // SeriousDisputeOpened is NOT emitted by declineRevision.
    const revisionDeclinedLog = {
      address: DEAL_ADDR,
      topics: encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'RevisionDeclined',
        args: { milestoneId: 0n },
      }),
      data: '0x' as `0x${string}`,
    };
    const milestoneDisputedLog = {
      address: DEAL_ADDR,
      topics: encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'MilestoneDisputed',
        args: {
          milestoneId: 0n,
          opener: FREELANCER,
        },
      }),
      data: encodeAbiParameters(parseAbiParameters('bytes32 reasonHash'), [ZERO_HASH]),
    };

    const declineReceipt = {
      status: 'success',
      logs: [revisionDeclinedLog, milestoneDisputedLog],
    };

    const mockClient = {
      ...createMockPublicClient(DealState.Active, MilestoneStatus.Disputed),
      getTransactionReceipt: async () => declineReceipt,
    };

    await assert.rejects(
      () =>
        reconcileMilestoneDispute({
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          callerWallet: CLIENT,
          txHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
          publicClient: mockClient as any,
          repo,
        }),
      /SeriousDisputeOpened event not found in transaction receipt/
    );
  });

  await t.test('25. False-confirmation protection: timeoutRevisionResponse receipt cannot confirm staged serious dispute', async () => {
    const repo = new MockDisputeRepository();
    const stageClient = createMockPublicClient(DealState.Active, MilestoneStatus.Submitted);

    await stageMilestoneDispute({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: CLIENT,
      explanation: 'Work fails specifications',
      publicClient: stageClient as any,
      repo,
    });

    // Mock receipt emitted by timeoutRevisionResponse: MilestoneDisputed(0, address(0), bytes32(0))
    const timeoutDisputedLog = {
      address: DEAL_ADDR,
      topics: encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'MilestoneDisputed',
        args: {
          milestoneId: 0n,
          opener: '0x0000000000000000000000000000000000000000',
        },
      }),
      data: encodeAbiParameters(parseAbiParameters('bytes32 reasonHash'), [ZERO_HASH]),
    };

    const timeoutReceipt = {
      status: 'success',
      logs: [timeoutDisputedLog],
    };

    const mockClient = {
      ...createMockPublicClient(DealState.Active, MilestoneStatus.Disputed),
      getTransactionReceipt: async () => timeoutReceipt,
    };

    await assert.rejects(
      () =>
        reconcileMilestoneDispute({
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          callerWallet: CLIENT,
          txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          publicClient: mockClient as any,
          repo,
        }),
      /SeriousDisputeOpened event not found in transaction receipt/
    );
  });

  await t.test('26. reconcileMilestoneDispute: ambiguous multiple SeriousDisputeOpened events fail closed', async () => {
    const repo = new MockDisputeRepository();
    const stageClient = createMockPublicClient(DealState.Active, MilestoneStatus.Submitted);

    const staged = await stageMilestoneDispute({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: CLIENT,
      explanation: 'Work fails specifications',
      publicClient: stageClient as any,
      repo,
    });

    // Mock 2 events returned for crash recovery
    const ambiguousLogsClient = {
      ...createMockPublicClient(DealState.Active, MilestoneStatus.Disputed),
      getLogs: async () => [
        {
          transactionHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
          args: { milestoneId: 0n, opener: CLIENT, reasonHash: staged.reasonHash },
        },
        {
          transactionHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
          args: { milestoneId: 0n, opener: CLIENT, reasonHash: staged.reasonHash },
        },
      ],
    };

    await assert.rejects(
      () =>
        reconcileMilestoneDispute({
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          callerWallet: CLIENT,
          publicClient: ambiguousLogsClient as any,
          repo,
        }),
      /Ambiguous SeriousDisputeOpened events found on-chain/
    );
  });
});
