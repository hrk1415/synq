import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeResolutionReport,
  canonicalizeResolutionReport,
  hashResolutionReport,
  determineResolutionReportEligibility,
  deriveAuthorizedCommittee,
  canAccessResolutionReport,
  verifyResolutionProposedReceipt,
  verifyFinalResolutionExecutedReceipt,
  ResolutionReportValidationError,
  ResolutionReportAuthError,
  ResolutionReportConflictError,
  ResolutionReportIntegrityError,
  RESOLUTION_REPORT_SCHEMA_VERSION,
  RESOLUTION_REPORT_LIMITS,
  PRIMARY_RESOLVER_SLA_SECONDS,
  type CanonicalResolutionReportV1,
} from '../src/lib/deals/v2-resolution-report';
import {
  stageResolutionReport,
  reconcileResolutionReport,
  getResolutionReport,
  listResolutionReports,
  type IMilestoneResolutionReportRepository,
} from '../src/lib/deals/resolution-reports-db';
import { DealState, MilestoneStatus } from '../src/lib/deals/v2-deal';
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters } from 'viem';
import { synqDealV1ABI } from '../src/lib/contracts/abis';
import type { MilestoneResolutionReportRow, NewMilestoneResolutionReportRow, ResolutionReportPhase } from '../src/db/schema';

// Mock In-Memory Repository for isolated unit testing
class MockResolutionReportRepository implements IMilestoneResolutionReportRepository {
  private rows: Map<string, MilestoneResolutionReportRow> = new Map();

  private key(chainId: number, dealAddress: string, milestoneId: number, phase: ResolutionReportPhase): string {
    return `${chainId}:${dealAddress.toLowerCase()}:${milestoneId}:${phase}`;
  }

  async getByMilestoneAndPhase(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    phase: ResolutionReportPhase
  ): Promise<MilestoneResolutionReportRow | null> {
    const k = this.key(chainId, dealAddress, milestoneId, phase);
    return this.rows.get(k) ?? null;
  }

  async getByMilestoneAndHash(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    phase: ResolutionReportPhase,
    justificationHash: string
  ): Promise<MilestoneResolutionReportRow | null> {
    for (const row of this.rows.values()) {
      if (
        row.chainId === chainId &&
        row.dealAddress.toLowerCase() === dealAddress.toLowerCase() &&
        row.milestoneId === milestoneId &&
        row.phase === phase &&
        row.justificationHash.toLowerCase() === justificationHash.toLowerCase()
      ) {
        return row;
      }
    }
    return null;
  }

  async listByMilestone(
    chainId: number,
    dealAddress: string,
    milestoneId: number
  ): Promise<MilestoneResolutionReportRow[]> {
    const results: MilestoneResolutionReportRow[] = [];
    for (const row of this.rows.values()) {
      if (
        row.chainId === chainId &&
        row.dealAddress.toLowerCase() === dealAddress.toLowerCase() &&
        row.milestoneId === milestoneId
      ) {
        results.push(row);
      }
    }
    return results;
  }

  async getById(id: string): Promise<MilestoneResolutionReportRow | null> {
    for (const row of this.rows.values()) {
      if (row.id === id) return row;
    }
    return null;
  }

  async create(row: NewMilestoneResolutionReportRow): Promise<MilestoneResolutionReportRow> {
    const fullRow: MilestoneResolutionReportRow = {
      id: row.id ?? `report-${Date.now()}-${Math.random()}`,
      chainId: row.chainId,
      committeeAddress: row.committeeAddress.toLowerCase(),
      dealAddress: row.dealAddress.toLowerCase(),
      milestoneId: row.milestoneId,
      phase: row.phase,
      submissionVersion: row.submissionVersion,
      specHash: row.specHash.toLowerCase(),
      evidenceRootHash: row.evidenceRootHash.toLowerCase(),
      freelancerAmount: row.freelancerAmount,
      clientAmount: row.clientAmount,
      justificationHash: row.justificationHash.toLowerCase(),
      canonicalReport: row.canonicalReport,
      status: row.status ?? 'staged',
      txHash: row.txHash ?? null,
      stagedByWallet: row.stagedByWallet.toLowerCase(),
      resolvedAt: row.resolvedAt ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const k = this.key(fullRow.chainId, fullRow.dealAddress, fullRow.milestoneId, fullRow.phase);
    this.rows.set(k, fullRow);
    return fullRow;
  }

  async updateStaged(
    id: string,
    data: {
      freelancerAmount: string;
      clientAmount: string;
      justificationHash: string;
      canonicalReport: Record<string, unknown>;
      submissionVersion: number;
      specHash: string;
      evidenceRootHash: string;
      stagedByWallet: string;
      updatedAt: Date;
    }
  ): Promise<MilestoneResolutionReportRow> {
    for (const [k, row] of this.rows.entries()) {
      if (row.id === id) {
        const updated: MilestoneResolutionReportRow = {
          ...row,
          freelancerAmount: data.freelancerAmount,
          clientAmount: data.clientAmount,
          justificationHash: data.justificationHash.toLowerCase(),
          canonicalReport: data.canonicalReport,
          submissionVersion: data.submissionVersion,
          specHash: data.specHash.toLowerCase(),
          evidenceRootHash: data.evidenceRootHash.toLowerCase(),
          stagedByWallet: data.stagedByWallet.toLowerCase(),
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
      resolvedAt: Date;
      updatedAt: Date;
    }
  ): Promise<MilestoneResolutionReportRow> {
    for (const [k, row] of this.rows.entries()) {
      if (row.id === id) {
        const updated: MilestoneResolutionReportRow = {
          ...row,
          status: 'confirmed',
          txHash: data.txHash,
          resolvedAt: data.resolvedAt,
          updatedAt: data.updatedAt,
        };
        this.rows.set(k, updated);
        return updated;
      }
    }
    throw new Error('Not found');
  }
}

// Canonical Fixtures
const TEST_DEAL = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const TEST_CLIENT = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const TEST_FREELANCER = '0x3333333333333333333333333333333333333333' as `0x${string}`;
const TEST_PRIMARY_RESOLVER = '0xd60bbcc7c8aca633a6d158b6f7f7367e36207676' as `0x${string}`;
const TEST_EMERGENCY_RESOLVER = '0x5dcb412ba5f032bc9095cdc95046168a076ff952' as `0x${string}`;
const PRIMARY_SIGNER_A = '0x6f270e8c6de66fb53a97e59e3e89e2a02290e7fa' as `0x${string}`;
const EMERGENCY_SIGNER_A = '0x90d2b8eb2ec109880d7f29474f1e323e156cc659' as `0x${string}`;
const OUTSIDER = '0x9999999999999999999999999999999999999999' as `0x${string}`;

const VALID_SPEC_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
const VALID_EVIDENCE_HASH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;

function createBaseReport(): CanonicalResolutionReportV1 {
  return {
    schemaVersion: 1,
    phase: 'INITIAL_RESOLUTION',
    chainId: 11155111,
    committeeAddress: TEST_PRIMARY_RESOLVER,
    dealAddress: TEST_DEAL,
    milestoneId: 0,
    submissionVersion: 1,
    specHash: VALID_SPEC_HASH,
    evidenceRootHash: VALID_EVIDENCE_HASH,
    freelancerAmount: '60000000', // 60 USDC
    clientAmount: '40000000',     // 40 USDC
    summary: 'Resolution regarding deliverable defect.',
    findings: 'Freelancer delivered 60% of required specifications with acceptable quality.',
    justification: 'Fair split based on completed modules.',
    evidenceReferences: [
      {
        title: 'PR Review',
        url: 'https://github.com/example/repo/pull/1',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// TEST SUITE
// ---------------------------------------------------------------------------

test('SYNQ Phase 3M-B: Canonical Resolution Report Persistence', async (t) => {
  // =========================================================================
  // Section 34: INITIAL VS FINAL REPORT HASH SENSITIVITY
  // =========================================================================
  await t.test('Section 34: Changing any field changes the justificationHash', () => {
    const base = createBaseReport();
    const baseHash = hashResolutionReport(base, 100000000n);

    // 1. Changing phase
    const changedPhase = { ...base, phase: 'FINAL_RESOLUTION' as const };
    assert.notEqual(hashResolutionReport(changedPhase, 100000000n), baseHash);

    // 2. Changing committeeAddress
    const changedCommittee = { ...base, committeeAddress: TEST_EMERGENCY_RESOLVER };
    assert.notEqual(hashResolutionReport(changedCommittee, 100000000n), baseHash);

    // 3. Changing dealAddress
    const changedDeal = { ...base, dealAddress: '0x4444444444444444444444444444444444444444' as `0x${string}` };
    assert.notEqual(hashResolutionReport(changedDeal, 100000000n), baseHash);

    // 4. Changing milestoneId
    const changedMilestone = { ...base, milestoneId: 1 };
    assert.notEqual(hashResolutionReport(changedMilestone, 100000000n), baseHash);

    // 5. Changing submissionVersion
    const changedVersion = { ...base, submissionVersion: 2 };
    assert.notEqual(hashResolutionReport(changedVersion, 100000000n), baseHash);

    // 6. Changing specHash
    const changedSpec = { ...base, specHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' as `0x${string}` };
    assert.notEqual(hashResolutionReport(changedSpec, 100000000n), baseHash);

    // 7. Changing evidenceRootHash
    const changedEvidence = { ...base, evidenceRootHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' as `0x${string}` };
    assert.notEqual(hashResolutionReport(changedEvidence, 100000000n), baseHash);

    // 8. Changing freelancerAmount
    const changedAmounts = { ...base, freelancerAmount: '70000000', clientAmount: '30000000' };
    assert.notEqual(hashResolutionReport(changedAmounts, 100000000n), baseHash);

    // 9. Changing clientAmount
    const changedAmounts2 = { ...base, freelancerAmount: '50000000', clientAmount: '50000000' };
    assert.notEqual(hashResolutionReport(changedAmounts2, 100000000n), baseHash);

    // 10. Changing narrative (summary, findings, justification, evidenceReferences)
    const changedSummary = { ...base, summary: 'Updated executive summary' };
    assert.notEqual(hashResolutionReport(changedSummary, 100000000n), baseHash);

    const changedFindings = { ...base, findings: 'Updated findings narrative' };
    assert.notEqual(hashResolutionReport(changedFindings, 100000000n), baseHash);

    const changedJustification = { ...base, justification: 'Updated justification narrative' };
    assert.notEqual(hashResolutionReport(changedJustification, 100000000n), baseHash);

    const changedReferences = { ...base, evidenceReferences: [{ title: 'Different PR', url: 'https://github.com/example/repo/pull/2' }] };
    assert.notEqual(hashResolutionReport(changedReferences, 100000000n), baseHash);
  });

  // =========================================================================
  // Section 35: DETERMINISM TESTS
  // =========================================================================
  await t.test('Section 35: Deterministic normalization produces identical hash', () => {
    const base = createBaseReport();
    const hash1 = hashResolutionReport(base, 100000000n);

    // Outer whitespace normalization
    const withWhitespace = {
      ...base,
      summary: '  ' + base.summary + ' \n ',
      findings: '\t ' + base.findings + '  ',
      justification: ' ' + base.justification + ' \t\n',
    };
    const hash2 = hashResolutionReport(withWhitespace, 100000000n);
    assert.equal(hash1, hash2, 'Outer whitespace must not affect justificationHash');

    // Unicode NFC normalization
    const nfdString = 'caf\u0065\u0301'; // 'café' in NFD
    const nfcString = 'caf\u00e9';       // 'café' in NFC
    const reportNFD = { ...base, summary: nfdString };
    const reportNFC = { ...base, summary: nfcString };
    assert.equal(
      hashResolutionReport(reportNFD, 100000000n),
      hashResolutionReport(reportNFC, 100000000n),
      'Unicode normalization must produce identical hash'
    );

    // Stable field ordering in serialization (RFC 8785)
    const shuffledKeys: any = {
      justification: base.justification,
      summary: base.summary,
      schemaVersion: base.schemaVersion,
      findings: base.findings,
      chainId: base.chainId,
      phase: base.phase,
      evidenceRootHash: base.evidenceRootHash,
      clientAmount: base.clientAmount,
      dealAddress: base.dealAddress,
      freelancerAmount: base.freelancerAmount,
      submissionVersion: base.submissionVersion,
      committeeAddress: base.committeeAddress,
      specHash: base.specHash,
      milestoneId: base.milestoneId,
      evidenceReferences: base.evidenceReferences,
    };
    assert.equal(
      hashResolutionReport(shuffledKeys, 100000000n),
      hash1,
      'Key insertion order must not affect hash under RFC 8785'
    );
  });

  // =========================================================================
  // Section 36: TEXT BOUNDARY TESTS
  // =========================================================================
  await t.test('Section 36: Text length and formatting boundaries', () => {
    const base = createBaseReport();

    // Empty narrative rejected
    assert.throws(
      () => normalizeResolutionReport({ ...base, summary: '   ' }),
      /Summary cannot be empty/
    );
    assert.throws(
      () => normalizeResolutionReport({ ...base, findings: '   ' }),
      /Findings cannot be empty/
    );
    assert.throws(
      () => normalizeResolutionReport({ ...base, justification: '   ' }),
      /Justification cannot be empty/
    );

    // Max length accepted
    const maxSummary = 'A'.repeat(RESOLUTION_REPORT_LIMITS.MAX_SUMMARY_LENGTH);
    const reportMaxSummary = normalizeResolutionReport({ ...base, summary: maxSummary });
    assert.equal(reportMaxSummary.summary.length, RESOLUTION_REPORT_LIMITS.MAX_SUMMARY_LENGTH);

    // Max + 1 rejected
    assert.throws(
      () => normalizeResolutionReport({ ...base, summary: maxSummary + 'X' }),
      /exceeds maximum limit/
    );

    // Internal multiline whitespace preserved
    const multiline = 'Line 1\n\nLine 2\n  Indented Line 3';
    const reportMultiline = normalizeResolutionReport({ ...base, summary: multiline });
    assert.equal(reportMultiline.summary, multiline);

    // Evidence references count bound
    const tooManyRefs = Array(21).fill({ title: 'Ref', url: 'https://example.com' });
    assert.throws(
      () => normalizeResolutionReport({ ...base, evidenceReferences: tooManyRefs }),
      /evidenceReferences count .* exceeds maximum limit/
    );

    // Invalid evidence reference URL protocol
    assert.throws(
      () => normalizeResolutionReport({
        ...base,
        evidenceReferences: [{ title: 'Bad URL', url: 'javascript:alert(1)' }],
      }),
      /must be a valid http:\/\/ or https:\/\/ URL/
    );
  });

  // =========================================================================
  // Section 37: AMOUNT ARITHMETIC TESTS
  // =========================================================================
  await t.test('Section 37: Exact integer USDC base units validation', () => {
    const base = createBaseReport();
    const milestoneAmount = 100000000n; // 100 USDC

    // 0 / 100 split accepted
    const report0_100 = normalizeResolutionReport(
      { ...base, freelancerAmount: '0', clientAmount: '100000000' },
      milestoneAmount
    );
    assert.equal(report0_100.freelancerAmount, '0');
    assert.equal(report0_100.clientAmount, '100000000');

    // 100 / 0 split accepted
    const report100_0 = normalizeResolutionReport(
      { ...base, freelancerAmount: '100000000', clientAmount: '0' },
      milestoneAmount
    );
    assert.equal(report100_0.freelancerAmount, '100000000');
    assert.equal(report100_0.clientAmount, '0');

    // Sum mismatch rejected
    assert.throws(
      () => normalizeResolutionReport(
        { ...base, freelancerAmount: '60000000', clientAmount: '40000001' },
        milestoneAmount
      ),
      /Split sum mismatch/
    );

    // Decimal point strings rejected
    assert.throws(
      () => normalizeResolutionReport({ ...base, freelancerAmount: '60.5' }),
      /Invalid freelancerAmount: must be a non-negative base-unit integer string/
    );

    // Negative strings rejected
    assert.throws(
      () => normalizeResolutionReport({ ...base, freelancerAmount: '-10' }),
      /Invalid freelancerAmount/
    );

    // Scientific notation rejected
    assert.throws(
      () => normalizeResolutionReport({ ...base, freelancerAmount: '1e6' }),
      /Invalid freelancerAmount/
    );
  });

  // =========================================================================
  // Section 38: AUTHORIZATION TESTS (INITIAL & FINAL STAGING)
  // =========================================================================
  await t.test('Section 38: Staging authorization and committee derivation', async () => {
    const repo = new MockResolutionReportRepository();

    const mockDealData = {
      dealAddress: TEST_DEAL,
      client: TEST_CLIENT,
      freelancer: TEST_FREELANCER,
      usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as `0x${string}`,
      state: DealState.Active,
      totalEscrow: 100000000n,
      totalSettled: 0n,
      milestoneCount: 1,
      milestones: [
        {
          index: 0,
          amount: 100000000n,
          workDeadline: 2000000000n,
          reviewWindow: 86400n,
          gracePeriod: 86400n,
          status: MilestoneStatus.Disputed,
          specHash: VALID_SPEC_HASH,
          evidenceRootHash: VALID_EVIDENCE_HASH,
          submittedAt: 1900000000n,
          version: 1,
        },
      ],
      isProtected: false,
      policyId: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
      primaryResolver: TEST_PRIMARY_RESOLVER,
      emergencyResolver: TEST_EMERGENCY_RESOLVER,
    };

    const disputeOpenedTime = 1000000n;

    // Helper client mock
    const makeClient = (currentBlockTimestamp: bigint) => ({
      getBlock: async () => ({ timestamp: currentBlockTimestamp }),
      readContract: async (args: any) => {
        if (args.functionName === 'isSynqDeal') return true;
        if (args.functionName === 'milestoneDisputeOpenedAt') return disputeOpenedTime;
        if (args.functionName === 'isSigner') {
          const targetCommittee = args.address.toLowerCase();
          const targetWallet = args.args[0].toLowerCase();
          if (targetCommittee === TEST_PRIMARY_RESOLVER.toLowerCase() && targetWallet === PRIMARY_SIGNER_A.toLowerCase()) {
            return true;
          }
          if (targetCommittee === TEST_EMERGENCY_RESOLVER.toLowerCase() && targetWallet === EMERGENCY_SIGNER_A.toLowerCase()) {
            return true;
          }
          return false;
        }
        if (args.functionName === 'primaryResolver') return TEST_PRIMARY_RESOLVER;
        if (args.functionName === 'emergencyResolver') return TEST_EMERGENCY_RESOLVER;
        if (args.functionName === 'state') return DealState.Active;
        if (args.functionName === 'isProtected') return false;
        if (args.functionName === 'policyId') return '0x0000000000000000000000000000000000000000000000000000000000000000';
        if (args.functionName === 'getMilestone') return mockDealData.milestones[0];
        if (args.functionName === 'milestoneCount') return 1n;
        if (args.functionName === 'client') return TEST_CLIENT;
        if (args.functionName === 'freelancer') return TEST_FREELANCER;
        if (args.functionName === 'usdc') return mockDealData.usdc;
        if (args.functionName === 'totalEscrow') return 100000000n;
        if (args.functionName === 'totalSettled') return 0n;
        return null;
      },
    });

    // 1. Before 14 days (T - 1): Primary signer accepted
    const clientBeforeSLA = makeClient(disputeOpenedTime + PRIMARY_RESOLVER_SLA_SECONDS - 1n);
    const result1 = await stageResolutionReport({
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      callerWallet: PRIMARY_SIGNER_A,
      phase: 'INITIAL_RESOLUTION',
      freelancerAmount: '60000000',
      clientAmount: '40000000',
      summary: 'Summary',
      findings: 'Findings',
      justification: 'Justification',
      publicClient: clientBeforeSLA as any,
      repo,
    });
    assert.equal(result1.report.committeeAddress, TEST_PRIMARY_RESOLVER);
    assert.equal(result1.row.status, 'staged');

    // 2. Before 14 days: Emergency signer rejected
    await assert.rejects(
      () => stageResolutionReport({
        dealAddress: TEST_DEAL,
        milestoneId: 0,
        callerWallet: EMERGENCY_SIGNER_A,
        phase: 'INITIAL_RESOLUTION',
        freelancerAmount: '60000000',
        clientAmount: '40000000',
        summary: 'Summary',
        findings: 'Findings',
        justification: 'Justification',
        publicClient: clientBeforeSLA as any,
        repo,
      }),
      /Caller .* is not an active signer on authorized committee/
    );

    // 3. At exact 14 days (T): Primary signer rejected, Emergency signer accepted
    const clientAtSLA = makeClient(disputeOpenedTime + PRIMARY_RESOLVER_SLA_SECONDS);
    await assert.rejects(
      () => stageResolutionReport({
        dealAddress: TEST_DEAL,
        milestoneId: 0,
        callerWallet: PRIMARY_SIGNER_A,
        phase: 'INITIAL_RESOLUTION',
        freelancerAmount: '60000000',
        clientAmount: '40000000',
        summary: 'Summary',
        findings: 'Findings',
        justification: 'Justification',
        publicClient: clientAtSLA as any,
        repo,
      }),
      /is not an active signer on authorized committee/
    );

    // 4. Outsider / Participant rejected
    await assert.rejects(
      () => stageResolutionReport({
        dealAddress: TEST_DEAL,
        milestoneId: 0,
        callerWallet: OUTSIDER,
        phase: 'INITIAL_RESOLUTION',
        freelancerAmount: '60000000',
        clientAmount: '40000000',
        summary: 'Summary',
        findings: 'Findings',
        justification: 'Justification',
        publicClient: clientBeforeSLA as any,
        repo,
      }),
      /is not an active signer on authorized committee/
    );

    await assert.rejects(
      () => stageResolutionReport({
        dealAddress: TEST_DEAL,
        milestoneId: 0,
        callerWallet: TEST_CLIENT,
        phase: 'INITIAL_RESOLUTION',
        freelancerAmount: '60000000',
        clientAmount: '40000000',
        summary: 'Summary',
        findings: 'Findings',
        justification: 'Justification',
        publicClient: clientBeforeSLA as any,
        repo,
      }),
      /is not an active signer on authorized committee/
    );

    // 5. Final resolution staging strictly requires proposing resolver
    const clientFinal = {
      ...clientBeforeSLA,
      readContract: async (args: any) => {
        if (args.functionName === 'getResolutionProposal') {
          return {
            freelancerAmount: 60000000n,
            clientAmount: 40000000n,
            justificationHash: result1.justificationHash,
            proposedAt: 1000500n,
            reconsiderationDeadline: 1000500n + 259200n,
            resolver: TEST_PRIMARY_RESOLVER,
          };
        }
        if (args.functionName === 'getMilestone') {
          return { ...mockDealData.milestones[0], status: MilestoneStatus.FinalReview };
        }
        return (clientBeforeSLA as any).readContract(args);
      },
    };

    const finalResult = await stageResolutionReport({
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      callerWallet: PRIMARY_SIGNER_A,
      phase: 'FINAL_RESOLUTION',
      freelancerAmount: '65000000',
      clientAmount: '35000000',
      summary: 'Final review summary',
      findings: 'Final findings after reconsideration',
      justification: 'Adjusted split',
      publicClient: clientFinal as any,
      repo,
    });
    assert.equal(finalResult.report.phase, 'FINAL_RESOLUTION');
    assert.equal(finalResult.report.committeeAddress, TEST_PRIMARY_RESOLVER);
  });

  // =========================================================================
  // Section 39: CHAIN ANCHOR & ELIGIBILITY TESTS
  // =========================================================================
  await t.test('Section 39: Chain state eligibility invariants', () => {
    // Non-active deal rejected
    const notActive = determineResolutionReportEligibility({
      dealState: DealState.Draft,
      milestoneStatus: MilestoneStatus.Disputed,
      phase: 'INITIAL_RESOLUTION',
    });
    assert.equal(notActive.eligible, false);

    // Protected deal rejected
    const protectedDeal = determineResolutionReportEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.Disputed,
      phase: 'INITIAL_RESOLUTION',
      isProtected: true,
    });
    assert.equal(protectedDeal.eligible, false);

    // Initial resolution with non-disputed status rejected
    const notDisputed = determineResolutionReportEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.Submitted,
      phase: 'INITIAL_RESOLUTION',
    });
    assert.equal(notDisputed.eligible, false);

    // Final resolution with non-final-review status rejected
    const notFinalReview = determineResolutionReportEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.Disputed,
      phase: 'FINAL_RESOLUTION',
    });
    assert.equal(notFinalReview.eligible, false);
  });

  // =========================================================================
  // Section 40: INITIAL REPORT RECONCILIATION TESTS
  // =========================================================================
  await t.test('Section 40: Reconciling INITIAL_RESOLUTION report', async () => {
    const repo = new MockResolutionReportRepository();
    const base = createBaseReport();
    const justificationHash = hashResolutionReport(base, 100000000n);

    // Seed staged report in repo
    await repo.create({
      chainId: 11155111,
      committeeAddress: TEST_PRIMARY_RESOLVER,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'INITIAL_RESOLUTION',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '60000000',
      clientAmount: '40000000',
      justificationHash,
      canonicalReport: base as any,
      status: 'staged',
      stagedByWallet: PRIMARY_SIGNER_A,
    });

    const mockReceipt = {
      status: 'success',
      logs: [
        {
          address: TEST_DEAL,
          data: encodeAbiParameters(
            parseAbiParameters('uint256, uint256, bytes32, uint64'),
            [60000000n, 40000000n, justificationHash, 2000000000n]
          ),
          topics: encodeEventTopics({
            abi: synqDealV1ABI,
            eventName: 'ResolutionProposed',
            args: {
              milestoneId: 0n,
              resolver: TEST_PRIMARY_RESOLVER,
            },
          }),
        },
      ],
    };

    const mockClient = {
      getTransactionReceipt: async () => mockReceipt,
      readContract: async (args: any) => {
        if (args.functionName === 'isSynqDeal') return true;
        if (args.functionName === 'policyId') return '0x0000000000000000000000000000000000000000000000000000000000000000';
        if (args.functionName === 'getMilestone') {
          return {
            index: 0,
            amount: 100000000n,
            workDeadline: 2000000000n,
            reviewWindow: 86400n,
            gracePeriod: 86400n,
            status: MilestoneStatus.ResolutionProposed,
            version: 1,
            specHash: VALID_SPEC_HASH,
            evidenceRootHash: VALID_EVIDENCE_HASH,
            submittedAt: 1900000000n,
          };
        }
        if (args.functionName === 'getResolutionProposal') {
          return {
            freelancerAmount: 60000000n,
            clientAmount: 40000000n,
            justificationHash,
            resolver: TEST_PRIMARY_RESOLVER,
          };
        }
        if (args.functionName === 'state') return DealState.Active;
        if (args.functionName === 'isProtected') return false;
        if (args.functionName === 'primaryResolver') return TEST_PRIMARY_RESOLVER;
        if (args.functionName === 'emergencyResolver') return TEST_EMERGENCY_RESOLVER;
        if (args.functionName === 'client') return TEST_CLIENT;
        if (args.functionName === 'freelancer') return TEST_FREELANCER;
        if (args.functionName === 'usdc') return '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
        if (args.functionName === 'totalEscrow') return 100000000n;
        if (args.functionName === 'totalSettled') return 0n;
        if (args.functionName === 'milestoneCount') return 1n;
        return null;
      },
    };

    // Confirm with receipt
    const reconciled = await reconcileResolutionReport({
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      callerWallet: PRIMARY_SIGNER_A,
      phase: 'INITIAL_RESOLUTION',
      txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      publicClient: mockClient as any,
      repo,
    });
    assert.equal(reconciled.row.status, 'confirmed');
    assert.equal(reconciled.row.txHash, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    // Verification receipt mismatch rejects
    const badReceipt = {
      status: 'success',
      logs: [
        {
          address: TEST_DEAL,
          data: encodeAbiParameters(
            parseAbiParameters('uint256, uint256, bytes32, uint64'),
            [50000000n, 50000000n, justificationHash, 2000000000n] // Wrong amounts
          ),
          topics: encodeEventTopics({
            abi: synqDealV1ABI,
            eventName: 'ResolutionProposed',
            args: {
              milestoneId: 0n,
              resolver: TEST_PRIMARY_RESOLVER,
            },
          }),
        },
      ],
    };
    const badReceiptVerification = verifyResolutionProposedReceipt({
      receipt: badReceipt,
      dealAddress: TEST_DEAL,
      expectedMilestoneId: 0n,
      expectedResolver: TEST_PRIMARY_RESOLVER,
      expectedFreelancerAmount: 60000000n,
      expectedClientAmount: 40000000n,
      expectedJustificationHash: justificationHash,
    });
    assert.equal(badReceiptVerification.valid, false);
    assert.match(badReceiptVerification.error!, /freelancerAmount mismatch/);
  });

  // =========================================================================
  // Section 41: FINAL REPORT RECONCILIATION TESTS
  // =========================================================================
  await t.test('Section 41: Reconciling FINAL_RESOLUTION report and event isolation', async () => {
    const repo = new MockResolutionReportRepository();
    const finalReport = { ...createBaseReport(), phase: 'FINAL_RESOLUTION' as const, freelancerAmount: '70000000', clientAmount: '30000000' };
    const justificationHash = hashResolutionReport(finalReport, 100000000n);

    await repo.create({
      chainId: 11155111,
      committeeAddress: TEST_PRIMARY_RESOLVER,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'FINAL_RESOLUTION',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '70000000',
      clientAmount: '30000000',
      justificationHash,
      canonicalReport: finalReport as any,
      status: 'staged',
      stagedByWallet: PRIMARY_SIGNER_A,
    });

    const mockReceipt = {
      status: 'success',
      logs: [
        {
          address: TEST_DEAL,
          data: encodeAbiParameters(
            parseAbiParameters('uint256, uint256, bytes32'),
            [70000000n, 30000000n, justificationHash]
          ),
          topics: encodeEventTopics({
            abi: synqDealV1ABI,
            eventName: 'FinalResolutionExecuted',
            args: {
              milestoneId: 0n,
              resolver: TEST_PRIMARY_RESOLVER,
            },
          }),
        },
      ],
    };

    const mockClient = {
      getTransactionReceipt: async () => mockReceipt,
      readContract: async (args: any) => {
        if (args.functionName === 'isSynqDeal') return true;
        if (args.functionName === 'policyId') return '0x0000000000000000000000000000000000000000000000000000000000000000';
        if (args.functionName === 'getMilestone') {
          return {
            index: 0,
            amount: 100000000n,
            workDeadline: 2000000000n,
            reviewWindow: 86400n,
            gracePeriod: 86400n,
            status: MilestoneStatus.SettledSplit,
            version: 1,
            specHash: VALID_SPEC_HASH,
            evidenceRootHash: VALID_EVIDENCE_HASH,
            submittedAt: 1900000000n,
          };
        }
        if (args.functionName === 'state') return DealState.Active;
        if (args.functionName === 'isProtected') return false;
        if (args.functionName === 'primaryResolver') return TEST_PRIMARY_RESOLVER;
        if (args.functionName === 'emergencyResolver') return TEST_EMERGENCY_RESOLVER;
        if (args.functionName === 'client') return TEST_CLIENT;
        if (args.functionName === 'freelancer') return TEST_FREELANCER;
        if (args.functionName === 'usdc') return '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
        if (args.functionName === 'totalEscrow') return 100000000n;
        if (args.functionName === 'totalSettled') return 100000000n;
        if (args.functionName === 'milestoneCount') return 1n;
        return null;
      },
    };

    const reconciled = await reconcileResolutionReport({
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      callerWallet: PRIMARY_SIGNER_A,
      phase: 'FINAL_RESOLUTION',
      txHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      publicClient: mockClient as any,
      repo,
    });
    assert.equal(reconciled.row.status, 'confirmed');

    // Terminal SettledSplit status alone without receipt/event fails (tested on fresh staged report)
    const repoCrash = new MockResolutionReportRepository();
    await repoCrash.create({
      chainId: 11155111,
      committeeAddress: TEST_PRIMARY_RESOLVER,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'FINAL_RESOLUTION',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '70000000',
      clientAmount: '30000000',
      justificationHash,
      canonicalReport: finalReport as any,
      status: 'staged',
      stagedByWallet: PRIMARY_SIGNER_A,
    });

    const clientSettledWithoutLogs = {
      ...mockClient,
      getTransactionReceipt: async () => null,
      getLogs: async () => [],
    };
    await assert.rejects(
      () => reconcileResolutionReport({
        dealAddress: TEST_DEAL,
        milestoneId: 0,
        callerWallet: PRIMARY_SIGNER_A,
        phase: 'FINAL_RESOLUTION',
        publicClient: clientSettledWithoutLogs as any,
        repo: repoCrash,
      }),
      /Crash recovery failed: zero matching FinalResolutionExecuted events found on-chain/
    );
  });

  // =========================================================================
  // Section 42: PRIVACY TESTS
  // =========================================================================
  await t.test('Section 42: Read privacy policy enforcement', () => {
    // Client has access
    assert.equal(
      canAccessResolutionReport({
        callerWallet: TEST_CLIENT,
        dealClient: TEST_CLIENT,
        dealFreelancer: TEST_FREELANCER,
        isCommitteeSigner: false,
      }),
      true
    );

    // Freelancer has access
    assert.equal(
      canAccessResolutionReport({
        callerWallet: TEST_FREELANCER,
        dealClient: TEST_CLIENT,
        dealFreelancer: TEST_FREELANCER,
        isCommitteeSigner: false,
      }),
      true
    );

    // Committee signer has access
    assert.equal(
      canAccessResolutionReport({
        callerWallet: PRIMARY_SIGNER_A,
        dealClient: TEST_CLIENT,
        dealFreelancer: TEST_FREELANCER,
        isCommitteeSigner: true,
      }),
      true
    );

    // Historical author (who was later rotated out) has access
    const ROTATED_OUT_SIGNER = '0x8888888888888888888888888888888888888888' as `0x${string}`;
    assert.equal(
      canAccessResolutionReport({
        callerWallet: ROTATED_OUT_SIGNER,
        dealClient: TEST_CLIENT,
        dealFreelancer: TEST_FREELANCER,
        isCommitteeSigner: false,
        stagedByWallet: ROTATED_OUT_SIGNER,
      }),
      true,
      'Historical author must retain read access even if rotated out'
    );

    // Outsider denied access
    assert.equal(
      canAccessResolutionReport({
        callerWallet: OUTSIDER,
        dealClient: TEST_CLIENT,
        dealFreelancer: TEST_FREELANCER,
        isCommitteeSigner: false,
        stagedByWallet: PRIMARY_SIGNER_A,
      }),
      false
    );
  });

  // =========================================================================
  // Section 43: DATABASE REPOSITORY TESTS
  // =========================================================================
  await t.test('Section 43: Initial and Final reports coexist peacefully in DB', async () => {
    const repo = new MockResolutionReportRepository();
    const initialReport = createBaseReport();
    const initialHash = hashResolutionReport(initialReport, 100000000n);

    const finalReport = {
      ...createBaseReport(),
      phase: 'FINAL_RESOLUTION' as const,
      freelancerAmount: '80000000',
      clientAmount: '20000000',
    };
    const finalHash = hashResolutionReport(finalReport, 100000000n);

    // Create Initial Report
    const row1 = await repo.create({
      chainId: 11155111,
      committeeAddress: TEST_PRIMARY_RESOLVER,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'INITIAL_RESOLUTION',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '60000000',
      clientAmount: '40000000',
      justificationHash: initialHash,
      canonicalReport: initialReport as any,
      status: 'confirmed',
      stagedByWallet: PRIMARY_SIGNER_A,
    });

    // Create Final Report
    const row2 = await repo.create({
      chainId: 11155111,
      committeeAddress: TEST_PRIMARY_RESOLVER,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'FINAL_RESOLUTION',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '80000000',
      clientAmount: '20000000',
      justificationHash: finalHash,
      canonicalReport: finalReport as any,
      status: 'confirmed',
      stagedByWallet: PRIMARY_SIGNER_A,
    });

    // Both coexist
    const all = await repo.listByMilestone(11155111, TEST_DEAL, 0);
    assert.equal(all.length, 2);
    assert.equal(all.some((r) => r.phase === 'INITIAL_RESOLUTION'), true);
    assert.equal(all.some((r) => r.phase === 'FINAL_RESOLUTION'), true);

    // Exact amounts round-trip as base units
    assert.equal(row1.freelancerAmount, '60000000');
    assert.equal(row1.clientAmount, '40000000');
    assert.equal(row2.freelancerAmount, '80000000');
    assert.equal(row2.clientAmount, '20000000');
  });

  // =========================================================================
  // Section 40-41 B: CRASH RECOVERY DETAIL TESTS
  // =========================================================================
  await t.test('Section 40-41 B: Event-based crash recovery success and ambiguous failure', async () => {
    const repo = new MockResolutionReportRepository();
    const base = createBaseReport();
    const justificationHash = hashResolutionReport(base, 100000000n);

    // Staged initial report
    await repo.create({
      chainId: 11155111,
      committeeAddress: TEST_PRIMARY_RESOLVER,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'INITIAL_RESOLUTION',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '60000000',
      clientAmount: '40000000',
      justificationHash,
      canonicalReport: base as any,
      status: 'staged',
      stagedByWallet: PRIMARY_SIGNER_A,
    });

    // 1. Success on unique matching log
    const clientUniqueLog = {
      readContract: async (args: any) => {
        if (args.functionName === 'isSynqDeal') return true;
        if (args.functionName === 'policyId') return '0x0000000000000000000000000000000000000000000000000000000000000000';
        if (args.functionName === 'getMilestone') {
          return {
            index: 0,
            amount: 100000000n,
            workDeadline: 2000000000n,
            reviewWindow: 86400n,
            gracePeriod: 86400n,
            status: MilestoneStatus.ResolutionProposed,
            version: 1,
            specHash: VALID_SPEC_HASH,
            evidenceRootHash: VALID_EVIDENCE_HASH,
            submittedAt: 1900000000n,
          };
        }
        if (args.functionName === 'state') return DealState.Active;
        if (args.functionName === 'isProtected') return false;
        if (args.functionName === 'primaryResolver') return TEST_PRIMARY_RESOLVER;
        if (args.functionName === 'emergencyResolver') return TEST_EMERGENCY_RESOLVER;
        if (args.functionName === 'client') return TEST_CLIENT;
        if (args.functionName === 'freelancer') return TEST_FREELANCER;
        if (args.functionName === 'usdc') return '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
        if (args.functionName === 'totalEscrow') return 100000000n;
        if (args.functionName === 'totalSettled') return 0n;
        if (args.functionName === 'milestoneCount') return 1n;
        return null;
      },
      getLogs: async () => [
        {
          transactionHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          args: {
            milestoneId: 0n,
            resolver: TEST_PRIMARY_RESOLVER,
            freelancerAmount: 60000000n,
            clientAmount: 40000000n,
            justificationHash,
            reconsiderationDeadline: 2000000000n,
          },
        },
      ],
    };

    const recovered = await reconcileResolutionReport({
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      callerWallet: PRIMARY_SIGNER_A,
      phase: 'INITIAL_RESOLUTION',
      publicClient: clientUniqueLog as any,
      repo,
    });
    assert.equal(recovered.row.status, 'confirmed');
    assert.equal(recovered.row.txHash, '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');

    // 2. Ambiguous multiple events fail closed
    const repoAmbiguous = new MockResolutionReportRepository();
    await repoAmbiguous.create({
      chainId: 11155111,
      committeeAddress: TEST_PRIMARY_RESOLVER,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'INITIAL_RESOLUTION',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '60000000',
      clientAmount: '40000000',
      justificationHash,
      canonicalReport: base as any,
      status: 'staged',
      stagedByWallet: PRIMARY_SIGNER_A,
    });

    const clientAmbiguous = {
      ...clientUniqueLog,
      getLogs: async () => [
        {
          transactionHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
          args: {
            milestoneId: 0n,
            resolver: TEST_PRIMARY_RESOLVER,
            freelancerAmount: 60000000n,
            clientAmount: 40000000n,
            justificationHash,
            reconsiderationDeadline: 2000000000n,
          },
        },
        {
          transactionHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
          args: {
            milestoneId: 0n,
            resolver: TEST_PRIMARY_RESOLVER,
            freelancerAmount: 60000000n,
            clientAmount: 40000000n,
            justificationHash,
            reconsiderationDeadline: 2000000000n,
          },
        },
      ],
    };

    await assert.rejects(
      () => reconcileResolutionReport({
        dealAddress: TEST_DEAL,
        milestoneId: 0,
        callerWallet: PRIMARY_SIGNER_A,
        phase: 'INITIAL_RESOLUTION',
        publicClient: clientAmbiguous as any,
        repo: repoAmbiguous,
      }),
      /Crash recovery failed: ambiguous multiple matching ResolutionProposed events found/
    );
  });

  // =========================================================================
  // Section 43 B: STAGING UPDATES & QUERY PRIVACY
  // =========================================================================
  await t.test('Section 43 B: Staging updates, candidate idempotency, and query privacy', async () => {
    const repo = new MockResolutionReportRepository();
    const disputeOpenedTime = 1000000n;

    const mockClient = {
      getBlock: async () => ({ timestamp: disputeOpenedTime + 100n }),
      readContract: async (args: any) => {
        if (args.functionName === 'isSynqDeal') return true;
        if (args.functionName === 'milestoneDisputeOpenedAt') return disputeOpenedTime;
        if (args.functionName === 'isSigner') {
          return args.args[0].toLowerCase() === PRIMARY_SIGNER_A.toLowerCase();
        }
        if (args.functionName === 'primaryResolver') return TEST_PRIMARY_RESOLVER;
        if (args.functionName === 'emergencyResolver') return TEST_EMERGENCY_RESOLVER;
        if (args.functionName === 'state') return DealState.Active;
        if (args.functionName === 'isProtected') return false;
        if (args.functionName === 'policyId') return '0x0000000000000000000000000000000000000000000000000000000000000000';
        if (args.functionName === 'getMilestone') {
          return {
            index: 0,
            amount: 100000000n,
            workDeadline: 2000000000n,
            reviewWindow: 86400n,
            gracePeriod: 86400n,
            status: MilestoneStatus.Disputed,
            version: 1,
            specHash: VALID_SPEC_HASH,
            evidenceRootHash: VALID_EVIDENCE_HASH,
            submittedAt: 1900000000n,
          };
        }
        if (args.functionName === 'milestoneCount') return 1n;
        if (args.functionName === 'client') return TEST_CLIENT;
        if (args.functionName === 'freelancer') return TEST_FREELANCER;
        if (args.functionName === 'usdc') return '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
        if (args.functionName === 'totalEscrow') return 100000000n;
        if (args.functionName === 'totalSettled') return 0n;
        return null;
      },
    };

    // Stage draft 1
    const staged1 = await stageResolutionReport({
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      callerWallet: PRIMARY_SIGNER_A,
      phase: 'INITIAL_RESOLUTION',
      freelancerAmount: '60000000',
      clientAmount: '40000000',
      summary: 'Draft 1 summary',
      findings: 'Draft 1 findings',
      justification: 'Draft 1 justification',
      publicClient: mockClient as any,
      repo,
    });
    assert.equal(staged1.row.status, 'staged');

    // Stage draft 1 again (identical): returns existing row (idempotent)
    const staged1Again = await stageResolutionReport({
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      callerWallet: PRIMARY_SIGNER_A,
      phase: 'INITIAL_RESOLUTION',
      freelancerAmount: '60000000',
      clientAmount: '40000000',
      summary: 'Draft 1 summary',
      findings: 'Draft 1 findings',
      justification: 'Draft 1 justification',
      publicClient: mockClient as any,
      repo,
    });
    assert.equal(staged1Again.row.id, staged1.row.id);

    // Stage draft 2 (different amounts): updates staged report
    const staged2 = await stageResolutionReport({
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      callerWallet: PRIMARY_SIGNER_A,
      phase: 'INITIAL_RESOLUTION',
      freelancerAmount: '50000000',
      clientAmount: '50000000',
      summary: 'Draft 2 updated summary',
      findings: 'Draft 2 updated findings',
      justification: 'Draft 2 updated justification',
      publicClient: mockClient as any,
      repo,
    });
    assert.equal(staged2.row.id, staged1.row.id);
    assert.equal(staged2.row.freelancerAmount, '50000000');

    // Confirm staged2
    await repo.confirm(staged2.row.id, {
      txHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      resolvedAt: new Date(),
      updatedAt: new Date(),
    });

    // Attempting to stage when already confirmed throws conflict error
    await assert.rejects(
      () => stageResolutionReport({
        dealAddress: TEST_DEAL,
        milestoneId: 0,
        callerWallet: PRIMARY_SIGNER_A,
        phase: 'INITIAL_RESOLUTION',
        freelancerAmount: '40000000',
        clientAmount: '60000000',
        summary: 'Attempt after confirmed',
        findings: 'Findings',
        justification: 'Justification',
        publicClient: mockClient as any,
        repo,
      }),
      /A confirmed resolution report already exists/
    );

    // getResolutionReport queries
    const clientRead = await getResolutionReport({
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'INITIAL_RESOLUTION',
      callerWallet: TEST_CLIENT,
      publicClient: mockClient as any,
      repo,
    });
    assert.equal(clientRead?.row.status, 'confirmed');

    const signerRead = await getResolutionReport({
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'INITIAL_RESOLUTION',
      callerWallet: PRIMARY_SIGNER_A,
      publicClient: mockClient as any,
      repo,
    });
    assert.equal(signerRead?.row.status, 'confirmed');

    // Outsider denied
    await assert.rejects(
      () => getResolutionReport({
        dealAddress: TEST_DEAL,
        milestoneId: 0,
        phase: 'INITIAL_RESOLUTION',
        callerWallet: OUTSIDER,
        publicClient: mockClient as any,
        repo,
      }),
      /Unauthorized: caller cannot view this resolution report/
    );

    // listResolutionReports: outsider gets empty list
    const outsiderList = await listResolutionReports({
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      callerWallet: OUTSIDER,
      publicClient: mockClient as any,
      repo,
    });
    assert.equal(outsiderList.length, 0);

    // Client gets the list
    const clientList = await listResolutionReports({
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      callerWallet: TEST_CLIENT,
      publicClient: mockClient as any,
      repo,
    });
    assert.equal(clientList.length, 1);
  });
});
