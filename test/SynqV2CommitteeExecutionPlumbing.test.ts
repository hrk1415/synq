import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import {
  isAddress,
  keccak256,
  stringToBytes,
  encodeAbiParameters,
  parseAbiParameters,
  encodeEventTopics,
} from 'viem';
import {
  synqResolutionCommitteeABI,
  formatCommitteeExecutionTransaction,
  verifyCommitteeResolutionProposalReceipt,
  verifyCommitteeFinalResolutionReceipt,
  RESOLVER_SLA_ADVISORY_BUFFER_SECONDS,
  EXPIRY_ADVISORY_BUFFER_SECONDS,
  CommitteeAuthValidationError,
  CommitteeAuthAuthError,
  CommitteeAuthConflictError,
  CommitteeAuthIntegrityError,
  CommitteeAuthExpiredError,
  CommitteeAuthInvalidatedError,
  CommitteeExecutionReceiptError,
  CommitteeExecutionRecoveryError,
  type VerifiedThresholdBundle,
} from '../src/lib/deals/v2-committee-auth';
import {
  prepareCommitteeExecutionTransaction,
  reconcileCommitteeAuthorization,
  createCommitteeAuthorization,
  submitCommitteeSignature,
  getVerifiedThresholdBundle,
  type ICommitteeAuthorizationRepository,
} from '../src/lib/deals/committee-authorizations-db';
import {
  hashResolutionReport,
  PRIMARY_RESOLVER_SLA_SECONDS,
  synqResolutionCommitteeReadABI,
} from '../src/lib/deals/v2-resolution-report';
import {
  reconcileResolutionReport,
  type IMilestoneResolutionReportRepository,
} from '../src/lib/deals/resolution-reports-db';
import { DealState, MilestoneStatus, SettlementType } from '../src/lib/deals/v2-deal';
import { synqDealV1ABI } from '../src/lib/contracts/abis';
import { SYNQ_V2_SEPOLIA_CONFIG } from '../src/lib/contracts/addresses';
import type {
  CommitteeResolutionAuthorizationRow,
  NewCommitteeResolutionAuthorizationRow,
  CommitteeResolutionSignatureRow,
  NewCommitteeResolutionSignatureRow,
  MilestoneResolutionReportRow,
  NewMilestoneResolutionReportRow,
  ResolutionReportPhase,
  CommitteeAuthorizationStatus,
} from '../src/db/schema';

// Helper for standard mock public client
function createMockPublicClient(options: {
  status?: MilestoneStatus;
  proposal?: any;
  nonceUsedProposal?: boolean;
  nonceUsedFinal?: boolean;
  signerWallets?: string[];
  receipt?: any;
  logs?: any[];
  timestamp?: bigint;
  blockTimestamp?: bigint;
  dispute?: any;
}) {
  const milestoneStatus = options.status ?? MilestoneStatus.Disputed;
  const timestamp = options.timestamp ?? options.blockTimestamp ?? 1000200n;
  const signers = (options.signerWallets ?? [SIGNER_A.address, SIGNER_B.address, SIGNER_C.address]).map((s) => s.toLowerCase());

  return {
    readContract: async (args: any) => {
      const fn = args.functionName;
      if (fn === 'isSynqDeal') return true;
      if (fn === 'state') return DealState.Active;
      if (fn === 'client') return CLIENT_ACC.address;
      if (fn === 'freelancer') return FREELANCER_ACC.address;
      if (fn === 'usdc') return SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc;
      if (fn === 'totalEscrow') return 100000000n;
      if (fn === 'totalSettled') return 0n;
      if (fn === 'milestoneCount') return 1n;
      if (fn === 'isProtected') return false;
      if (fn === 'policyId') return '0x0000000000000000000000000000000000000000000000000000000000000000';
      if (fn === 'primaryResolver') return TEST_COMMITTEE;
      if (fn === 'emergencyResolver') return '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      if (fn === 'committeeEpoch') return 1n;
      if (fn === 'milestoneDisputeOpenedAt') return 1000000n;
      if (fn === 'isSigner') {
        const targetWallet = (args.args[0] as string).toLowerCase();
        return signers.includes(targetWallet);
      }
      if (fn === 'getMilestone') {
        return {
          amount: 100000000n,
          workDeadline: 2000000n,
          reviewWindow: 604800n,
          gracePeriod: 86400n,
          status: milestoneStatus,
          specHash: VALID_SPEC_HASH,
          evidenceRootHash: VALID_EVIDENCE_HASH,
          submittedAt: 900000n,
          version: 1,
        };
      }
      if (fn === 'getResolutionProposal') {
        return options.proposal ?? {
          freelancerAmount: 60000000n,
          clientAmount: 40000000n,
          justificationHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
          proposedAt: 1000100n,
          reconsiderationDeadline: 1259200n,
          resolver: TEST_COMMITTEE,
        };
      }
      if (fn === 'usedProposalNonces') return Boolean(options.nonceUsedProposal);
      if (fn === 'usedFinalNonces') return Boolean(options.nonceUsedFinal);
      return false;
    },
    getTransactionReceipt: async () => options.receipt,
    getLogs: async () => options.logs ?? [],
    getBlock: async () => ({ timestamp }),
  };
}

// Local deterministic test keys
const SIGNER_A = privateKeyToAccount('0x1111111111111111111111111111111111111111111111111111111111111111');
const SIGNER_B = privateKeyToAccount('0x2222222222222222222222222222222222222222222222222222222222222222');
const SIGNER_C = privateKeyToAccount('0x3333333333333333333333333333333333333333333333333333333333333333');
const CLIENT_ACC = privateKeyToAccount('0x6666666666666666666666666666666666666666666666666666666666666666');
const FREELANCER_ACC = privateKeyToAccount('0x7777777777777777777777777777777777777777777777777777777777777777');
const OUTSIDER = privateKeyToAccount('0x8888888888888888888888888888888888888888888888888888888888888888');

const TEST_COMMITTEE = '0xd60bbcc7c8aca633a6d158b6f7f7367e36207676' as `0x${string}`;
const TEST_DEAL = '0x9999999999999999999999999999999999999999' as `0x${string}`;
const VALID_SPEC_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
const VALID_EVIDENCE_HASH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;
const VALID_TX_HASH = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as `0x${string}`;

class MockAuthRepository implements ICommitteeAuthorizationRepository {
  public auths = new Map<string, CommitteeResolutionAuthorizationRow>();
  public signatures = new Map<string, CommitteeResolutionSignatureRow[]>();

  async getAuthById(id: string): Promise<CommitteeResolutionAuthorizationRow | null> {
    return this.auths.get(id) ?? null;
  }

  async getAuthByNonce(
    chainId: number,
    committeeAddress: string,
    dealAddress: string,
    milestoneId: number,
    phase: ResolutionReportPhase,
    nonce: string
  ): Promise<CommitteeResolutionAuthorizationRow | null> {
    for (const a of this.auths.values()) {
      if (
        a.chainId === chainId &&
        a.committeeAddress.toLowerCase() === committeeAddress.toLowerCase() &&
        a.dealAddress.toLowerCase() === dealAddress.toLowerCase() &&
        a.milestoneId === milestoneId &&
        a.phase === phase &&
        a.resolutionNonce === nonce
      ) {
        return a;
      }
    }
    return null;
  }

  async getAuthByReportId(reportId: string): Promise<CommitteeResolutionAuthorizationRow | null> {
    for (const a of this.auths.values()) {
      if (a.reportId === reportId) return a;
    }
    return null;
  }

  async listAuthsByMilestone(
    chainId: number,
    dealAddress: string,
    milestoneId: number
  ): Promise<CommitteeResolutionAuthorizationRow[]> {
    const res: CommitteeResolutionAuthorizationRow[] = [];
    for (const a of this.auths.values()) {
      if (a.chainId === chainId && a.dealAddress.toLowerCase() === dealAddress.toLowerCase() && a.milestoneId === milestoneId) {
        res.push(a);
      }
    }
    return res;
  }

  async createAuth(row: NewCommitteeResolutionAuthorizationRow): Promise<CommitteeResolutionAuthorizationRow> {
    const full: CommitteeResolutionAuthorizationRow = {
      id: row.id ?? `auth-${Date.now()}-${Math.random()}`,
      reportId: row.reportId,
      chainId: row.chainId,
      committeeAddress: row.committeeAddress.toLowerCase(),
      dealAddress: row.dealAddress.toLowerCase(),
      milestoneId: row.milestoneId,
      phase: row.phase,
      authorizationType: row.authorizationType,
      resolutionNonce: row.resolutionNonce,
      validUntil: row.validUntil,
      committeeEpoch: row.committeeEpoch,
      submissionVersion: row.submissionVersion,
      specHash: row.specHash.toLowerCase(),
      evidenceRootHash: row.evidenceRootHash.toLowerCase(),
      freelancerAmount: row.freelancerAmount,
      clientAmount: row.clientAmount,
      justificationHash: row.justificationHash.toLowerCase(),
      typedData: row.typedData,
      typedDataHash: row.typedDataHash.toLowerCase(),
      status: row.status ?? 'collecting',
      createdBySigner: row.createdBySigner.toLowerCase(),
      executionTxHash: row.executionTxHash ?? null,
      executedByWallet: row.executedByWallet ?? null,
      executedAt: row.executedAt ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.auths.set(full.id, full);
    return full;
  }

  async updateAuthStatus(id: string, status: CommitteeAuthorizationStatus): Promise<CommitteeResolutionAuthorizationRow> {
    const a = this.auths.get(id);
    if (!a) throw new Error('Auth not found');
    const updated = { ...a, status, updatedAt: new Date() };
    this.auths.set(id, updated);
    return updated;
  }

  async updateAuthExecution(
    id: string,
    data: {
      executionTxHash: string;
      executedByWallet: string | null;
      executedAt: Date | null;
      status: 'executed';
    }
  ): Promise<CommitteeResolutionAuthorizationRow> {
    const a = this.auths.get(id);
    if (!a) throw new Error('Auth not found');
    const updated: CommitteeResolutionAuthorizationRow = {
      ...a,
      executionTxHash: data.executionTxHash.toLowerCase(),
      executedByWallet: data.executedByWallet ? data.executedByWallet.toLowerCase() : null,
      executedAt: data.executedAt,
      status: data.status,
      updatedAt: new Date(),
    };
    this.auths.set(id, updated);
    return updated;
  }

  async getSignaturesByAuthId(authorizationId: string): Promise<CommitteeResolutionSignatureRow[]> {
    return this.signatures.get(authorizationId) ?? [];
  }

  async createSignature(row: NewCommitteeResolutionSignatureRow): Promise<CommitteeResolutionSignatureRow> {
    const full: CommitteeResolutionSignatureRow = {
      id: row.id ?? `sig-${Date.now()}-${Math.random()}`,
      authorizationId: row.authorizationId,
      signerWallet: row.signerWallet.toLowerCase(),
      signature: row.signature,
      createdAt: new Date(),
    };
    const list = this.signatures.get(row.authorizationId) ?? [];
    list.push(full);
    this.signatures.set(row.authorizationId, list);
    return full;
  }

  async getSignerSignature(authorizationId: string, signerWallet: string): Promise<CommitteeResolutionSignatureRow | null> {
    const list = this.signatures.get(authorizationId) ?? [];
    return list.find((s) => s.signerWallet.toLowerCase() === signerWallet.toLowerCase()) ?? null;
  }
}

class MockReportRepository implements IMilestoneResolutionReportRepository {
  public rows = new Map<string, MilestoneResolutionReportRow>();

  async getByMilestoneAndPhase(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    phase: ResolutionReportPhase
  ): Promise<MilestoneResolutionReportRow | null> {
    for (const r of this.rows.values()) {
      if (
        r.chainId === chainId &&
        r.dealAddress.toLowerCase() === dealAddress.toLowerCase() &&
        r.milestoneId === milestoneId &&
        r.phase === phase
      ) {
        return r;
      }
    }
    return null;
  }

  async getByMilestoneAndHash(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    phase: ResolutionReportPhase,
    justificationHash: string
  ): Promise<MilestoneResolutionReportRow | null> {
    for (const r of this.rows.values()) {
      if (
        r.chainId === chainId &&
        r.dealAddress.toLowerCase() === dealAddress.toLowerCase() &&
        r.milestoneId === milestoneId &&
        r.phase === phase &&
        r.justificationHash.toLowerCase() === justificationHash.toLowerCase()
      ) {
        return r;
      }
    }
    return null;
  }

  async listByMilestone(
    chainId: number,
    dealAddress: string,
    milestoneId: number
  ): Promise<MilestoneResolutionReportRow[]> {
    const res: MilestoneResolutionReportRow[] = [];
    for (const r of this.rows.values()) {
      if (r.chainId === chainId && r.dealAddress.toLowerCase() === dealAddress.toLowerCase() && r.milestoneId === milestoneId) {
        res.push(r);
      }
    }
    return res;
  }

  async getById(id: string): Promise<MilestoneResolutionReportRow | null> {
    return this.rows.get(id) ?? null;
  }

  async create(row: NewMilestoneResolutionReportRow): Promise<MilestoneResolutionReportRow> {
    const full: MilestoneResolutionReportRow = {
      id: row.id ?? `rep-${Date.now()}-${Math.random()}`,
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
    this.rows.set(full.id, full);
    return full;
  }

  async updateStaged(id: string, data: any): Promise<MilestoneResolutionReportRow> {
    const r = this.rows.get(id);
    if (!r) throw new Error('Report not found');
    const updated = { ...r, ...data, updatedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }

  async confirm(id: string, data: any): Promise<MilestoneResolutionReportRow> {
    const r = this.rows.get(id);
    if (!r) throw new Error('Report not found');
    const updated = { ...r, status: 'confirmed' as const, txHash: data.txHash, resolvedAt: data.resolvedAt, updatedAt: data.updatedAt };
    this.rows.set(id, updated);
    return updated;
  }
}

function createBaseBundle(phase: ResolutionReportPhase = 'INITIAL_RESOLUTION'): VerifiedThresholdBundle {
  return {
    authorizationId: 'auth-1',
    reportId: 'rep-1',
    phase,
    authorizationType: phase === 'INITIAL_RESOLUTION' ? 'ResolutionProposalAuth' : 'FinalResolutionAuth',
    committeeAddress: TEST_COMMITTEE,
    dealAddress: TEST_DEAL,
    milestoneId: 0,
    auth: {
      committee: TEST_COMMITTEE,
      chainId: 11155111n,
      deal: TEST_DEAL,
      milestoneId: 0n,
      freelancerAmount: 60000000n,
      clientAmount: 40000000n,
      justificationHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      resolutionNonce: 1n,
      validUntil: 2000000n,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      specHash: VALID_SPEC_HASH,
      submissionVersion: 1,
    },
    typedDataHash: '0x5555555555555555555555555555555555555555555555555555555555555555',
    signers: [SIGNER_A.address.toLowerCase() as `0x${string}`, SIGNER_B.address.toLowerCase() as `0x${string}`],
    signatures: ['0xaaaa' as `0x${string}`, '0xbbbb' as `0x${string}`],
  };
}

test('SYNQ Phase 3M-E: Committee Resolution Submission Execution Plumbing', async (t) => {
  // =========================================================================
  // Section 43: PURE TRANSACTION PREPARATION
  // =========================================================================
  await t.test('Section 43: Pure transaction preparation INITIAL and FINAL match exact ABI parameters', () => {
    const initialBundle = createBaseBundle('INITIAL_RESOLUTION');
    const initialTx = formatCommitteeExecutionTransaction({
      bundle: initialBundle,
      latestBlockTimestamp: 1000000n,
      disputeOpenedAt: 950000n,
    });

    assert.equal(initialTx.address, TEST_COMMITTEE);
    assert.equal(initialTx.functionName, 'submitResolutionProposal');
    assert.equal(initialTx.args.length, 3);
    assert.equal(initialTx.args[0].committee, TEST_COMMITTEE);
    assert.equal(initialTx.args[0].deal, TEST_DEAL);
    assert.equal(initialTx.args[0].milestoneId, 0n);
    assert.equal(initialTx.args[0].freelancerAmount, 60000000n);
    assert.equal(initialTx.args[0].clientAmount, 40000000n);
    assert.equal(initialTx.args[0].resolutionNonce, 1n);
    assert.equal(initialTx.args[0].validUntil, 2000000n);
    assert.equal(initialTx.args[1], '0xaaaa');
    assert.equal(initialTx.args[2], '0xbbbb');

    const finalBundle = createBaseBundle('FINAL_RESOLUTION');
    const finalTx = formatCommitteeExecutionTransaction({
      bundle: finalBundle,
      latestBlockTimestamp: 1000000n,
    });

    assert.equal(finalTx.address, TEST_COMMITTEE);
    assert.equal(finalTx.functionName, 'submitFinalResolution');
    assert.equal(finalTx.args.length, 3);
    assert.equal(finalTx.args[0].resolutionNonce, 1n);
  });

  // =========================================================================
  // Sections 12 & 13: ADVISORY BUFFERS
  // =========================================================================
  await t.test('Sections 12 & 13: Advisory buffers (15m SLA boundary, 5m expiry)', () => {
    const bundle = {
      ...createBaseBundle('INITIAL_RESOLUTION'),
      auth: {
        ...createBaseBundle('INITIAL_RESOLUTION').auth,
        validUntil: 3000000n,
      },
    };
    // disputeOpenedAt = 1,000,000. 14 days = 1,209,600s. Boundary = 2,209,600.
    const disputeOpenedAt = 1000000n;
    const boundary = disputeOpenedAt + PRIMARY_RESOLVER_SLA_SECONDS;

    // Case A: 20 minutes before boundary (outside 15m buffer) -> recommendedToSubmit = true
    const timeFar = boundary - 1200n;
    const txFar = formatCommitteeExecutionTransaction({
      bundle,
      latestBlockTimestamp: timeFar,
      disputeOpenedAt,
    });
    assert.equal(txFar.advisory.nearResolverBoundary, false);
    assert.equal(txFar.advisory.recommendedToSubmit, true);

    // Case B: 10 minutes before boundary (inside 15m buffer) -> nearResolverBoundary = true, recommendedToSubmit = false
    const timeNear = boundary - 600n;
    const txNear = formatCommitteeExecutionTransaction({
      bundle,
      latestBlockTimestamp: timeNear,
      disputeOpenedAt,
    });
    assert.equal(txNear.advisory.nearResolverBoundary, true);
    assert.equal(txNear.advisory.recommendedToSubmit, false);

    // Case C: 2 minutes before validUntil (inside 5m expiry buffer)
    const txExpiry = formatCommitteeExecutionTransaction({
      bundle: {
        ...bundle,
        auth: { ...bundle.auth, validUntil: 1000200n },
      },
      latestBlockTimestamp: 1000100n, // 100s remaining <= 300s
    });
    assert.equal(txExpiry.advisory.nearExpiry, true);
    assert.equal(txExpiry.advisory.recommendedToSubmit, false);
  });

  // =========================================================================
  // Section 44: ACCESS POLICIES
  // =========================================================================
  await t.test('Section 44: Access policies for preparation and reconciliation', async () => {
    const authRepo = new MockAuthRepository();
    const reportRepo = new MockReportRepository();

    const auth = await authRepo.createAuth({
      reportId: 'rep-1',
      chainId: 11155111,
      committeeAddress: TEST_COMMITTEE,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'INITIAL_RESOLUTION',
      authorizationType: 'ResolutionProposalAuth',
      resolutionNonce: '1',
      validUntil: '3000000',
      committeeEpoch: '1',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '60000000',
      clientAmount: '40000000',
      justificationHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      typedData: {},
      typedDataHash: '0x5555555555555555555555555555555555555555555555555555555555555555',
      status: 'threshold_ready',
      createdBySigner: SIGNER_A.address,
    });

    const mockClient = createMockPublicClient({
      signerWallets: [SIGNER_A.address],
    });

    // Outsider cannot prepare
    await assert.rejects(
      async () => {
        await prepareCommitteeExecutionTransaction({
          authorizationId: auth.id,
          callerWallet: OUTSIDER.address,
          publicClient: mockClient as any,
          authRepo,
          reportRepo,
        });
      },
      (err: any) => err instanceof CommitteeAuthAuthError
    );

    // Participant cannot prepare
    await assert.rejects(
      async () => {
        await prepareCommitteeExecutionTransaction({
          authorizationId: auth.id,
          callerWallet: CLIENT_ACC.address,
          publicClient: mockClient as any,
          authRepo,
          reportRepo,
        });
      },
      (err: any) => err instanceof CommitteeAuthAuthError
    );

    // Outsider cannot reconcile
    await assert.rejects(
      async () => {
        await reconcileCommitteeAuthorization({
          authorizationId: auth.id,
          callerWallet: OUTSIDER.address,
          txHash: VALID_TX_HASH,
          publicClient: mockClient as any,
          authRepo,
          reportRepo,
        });
      },
      (err: any) => err instanceof CommitteeAuthAuthError
    );
  });

  // =========================================================================
  // Section 45: EXACT INITIAL RESOLUTION SUCCESS
  // =========================================================================
  await t.test('Section 45: Exact INITIAL execution receipt & storage verification', async () => {
    const authRepo = new MockAuthRepository();
    const reportRepo = new MockReportRepository();
    const justificationHash = '0x3333333333333333333333333333333333333333333333333333333333333333';

    const report = await reportRepo.create({
      chainId: 11155111,
      committeeAddress: TEST_COMMITTEE,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'INITIAL_RESOLUTION',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '60000000',
      clientAmount: '40000000',
      justificationHash,
      canonicalReport: { summary: 'test' },
      status: 'staged',
      stagedByWallet: SIGNER_A.address,
    });

    const auth = await authRepo.createAuth({
      reportId: report.id,
      chainId: 11155111,
      committeeAddress: TEST_COMMITTEE,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'INITIAL_RESOLUTION',
      authorizationType: 'ResolutionProposalAuth',
      resolutionNonce: '1',
      validUntil: '3000000',
      committeeEpoch: '1',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '60000000',
      clientAmount: '40000000',
      justificationHash,
      typedData: {},
      typedDataHash: '0x5555555555555555555555555555555555555555555555555555555555555555',
      status: 'threshold_ready',
      createdBySigner: SIGNER_A.address,
    });

    const receipt = {
      status: 'success',
      to: TEST_COMMITTEE,
      from: SIGNER_A.address,
      blockNumber: 12345n,
      transactionHash: VALID_TX_HASH,
      logs: [
        {
          address: TEST_COMMITTEE,
          topics: encodeEventTopics({
            abi: synqResolutionCommitteeABI,
            eventName: 'ResolutionProposalSubmitted',
            args: {
              deal: TEST_DEAL,
              milestoneId: 0n,
            },
          }),
          data: encodeAbiParameters(
            parseAbiParameters('uint256, uint256, bytes32, uint64'),
            [60000000n, 40000000n, justificationHash as `0x${string}`, 1n]
          ),
        },
        {
          address: TEST_DEAL,
          topics: encodeEventTopics({
            abi: synqDealV1ABI,
            eventName: 'ResolutionProposed',
            args: {
              milestoneId: 0n,
              resolver: TEST_COMMITTEE,
            },
          }),
          data: encodeAbiParameters(
            parseAbiParameters('uint256, uint256, bytes32, uint64'),
            [60000000n, 40000000n, justificationHash as `0x${string}`, 1259200n]
          ),
        },
      ],
    };

    const mockClient = createMockPublicClient({
      status: MilestoneStatus.ResolutionProposed,
      nonceUsedProposal: true,
      receipt,
      proposal: {
        freelancerAmount: 60000000n,
        clientAmount: 40000000n,
        justificationHash,
        proposedAt: 1000100n,
        reconsiderationDeadline: 1259200n,
        resolver: TEST_COMMITTEE,
      },
    });

    const result = await reconcileCommitteeAuthorization({
      authorizationId: auth.id,
      callerWallet: SIGNER_A.address,
      txHash: VALID_TX_HASH,
      publicClient: mockClient as any,
      authRepo,
      reportRepo,
    });

    assert.equal(result.authorization.status, 'executed');
    assert.equal(result.authorization.executionTxHash, VALID_TX_HASH);
    assert.equal(result.authorization.executedByWallet, SIGNER_A.address.toLowerCase());
    assert.ok(result.authorization.executedAt instanceof Date);

    const updatedReport = await reportRepo.getById(report.id);
    assert.equal(updatedReport?.status, 'confirmed');
    assert.equal(updatedReport?.txHash, VALID_TX_HASH);
  });

  // =========================================================================
  // Section 46: EXACT FINAL RESOLUTION SUCCESS
  // =========================================================================
  await t.test('Section 46: Exact FINAL execution receipt & storage verification', async () => {
    const authRepo = new MockAuthRepository();
    const reportRepo = new MockReportRepository();
    const justificationHash = '0x4444444444444444444444444444444444444444444444444444444444444444';

    const report = await reportRepo.create({
      chainId: 11155111,
      committeeAddress: TEST_COMMITTEE,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'FINAL_RESOLUTION',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '70000000',
      clientAmount: '30000000',
      justificationHash,
      canonicalReport: { summary: 'final' },
      status: 'staged',
      stagedByWallet: SIGNER_A.address,
    });

    const auth = await authRepo.createAuth({
      reportId: report.id,
      chainId: 11155111,
      committeeAddress: TEST_COMMITTEE,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'FINAL_RESOLUTION',
      authorizationType: 'FinalResolutionAuth',
      resolutionNonce: '2',
      validUntil: '3000000',
      committeeEpoch: '1',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '70000000',
      clientAmount: '30000000',
      justificationHash,
      typedData: {},
      typedDataHash: '0x6666666666666666666666666666666666666666666666666666666666666666',
      status: 'threshold_ready',
      createdBySigner: SIGNER_A.address,
    });

    const receipt = {
      status: 'success',
      to: TEST_COMMITTEE,
      from: SIGNER_B.address,
      blockNumber: 12346n,
      transactionHash: VALID_TX_HASH,
      logs: [
        {
          address: TEST_COMMITTEE,
          topics: encodeEventTopics({
            abi: synqResolutionCommitteeABI,
            eventName: 'FinalResolutionSubmitted',
            args: {
              deal: TEST_DEAL,
              milestoneId: 0n,
            },
          }),
          data: encodeAbiParameters(
            parseAbiParameters('uint256, uint256, bytes32, uint64'),
            [70000000n, 30000000n, justificationHash as `0x${string}`, 2n]
          ),
        },
        {
          address: TEST_DEAL,
          topics: encodeEventTopics({
            abi: synqDealV1ABI,
            eventName: 'FinalResolutionExecuted',
            args: {
              milestoneId: 0n,
              resolver: TEST_COMMITTEE,
            },
          }),
          data: encodeAbiParameters(
            parseAbiParameters('uint256, uint256, bytes32'),
            [70000000n, 30000000n, justificationHash as `0x${string}`]
          ),
        },
        {
          address: TEST_DEAL,
          topics: encodeEventTopics({
            abi: synqDealV1ABI,
            eventName: 'MilestoneSettled',
            args: {
              milestoneId: 0n,
            },
          }),
          data: encodeAbiParameters(
            parseAbiParameters('uint256, uint256, uint8'),
            [70000000n, 30000000n, SettlementType.ResolverResolution]
          ),
        },
      ],
    };

    const mockClient = createMockPublicClient({
      status: MilestoneStatus.SettledSplit,
      nonceUsedFinal: true,
      receipt,
    });

    // Client participant can trigger reconciliation
    const result = await reconcileCommitteeAuthorization({
      authorizationId: auth.id,
      callerWallet: CLIENT_ACC.address,
      txHash: VALID_TX_HASH,
      publicClient: mockClient as any,
      authRepo,
      reportRepo,
    });

    assert.equal(result.authorization.status, 'executed');
    assert.equal(result.authorization.executionTxHash, VALID_TX_HASH);
    assert.equal(result.authorization.executedByWallet, SIGNER_B.address.toLowerCase());
  });

  // =========================================================================
  // Section 47 & 48: RECEIPT FAILURES & FALSE POSITIVE RESISTANCE
  // =========================================================================
  await t.test('Section 47 & 48: Receipt failures & false positive resistance', () => {
    const justificationHash = '0x4444444444444444444444444444444444444444444444444444444444444444';

    // 1. Reverted receipt
    const revertedReceipt = { status: 'reverted', logs: [] };
    const r1 = verifyCommitteeFinalResolutionReceipt({
      receipt: revertedReceipt,
      committeeAddress: TEST_COMMITTEE,
      dealAddress: TEST_DEAL,
      expectedMilestoneId: 0n,
      expectedFreelancerAmount: 70000000n,
      expectedClientAmount: 30000000n,
      expectedJustificationHash: justificationHash,
      expectedNonce: 2n,
    });
    assert.equal(r1.valid, false);
    assert.match(r1.error!, /reverted/);

    // 2. Mutual Settlement false positive
    const mutualSettlementReceipt = {
      status: 'success',
      logs: [
        {
          address: TEST_DEAL,
          topics: encodeEventTopics({
            abi: synqDealV1ABI,
            eventName: 'MilestoneSettled',
            args: { milestoneId: 0n },
          }),
          data: encodeAbiParameters(
            parseAbiParameters('uint256, uint256, uint8'),
            [70000000n, 30000000n, SettlementType.MutualSettlement] // 4 != 5
          ),
        },
      ],
    };
    const r2 = verifyCommitteeFinalResolutionReceipt({
      receipt: mutualSettlementReceipt,
      committeeAddress: TEST_COMMITTEE,
      dealAddress: TEST_DEAL,
      expectedMilestoneId: 0n,
      expectedFreelancerAmount: 70000000n,
      expectedClientAmount: 30000000n,
      expectedJustificationHash: justificationHash,
      expectedNonce: 2n,
    });
    assert.equal(r2.valid, false);
    assert.match(r2.error!, /FinalResolutionSubmitted event not found/);

    // 3. Ordinary executeResolution false positive
    const executeResolutionReceipt = {
      status: 'success',
      logs: [
        {
          address: TEST_DEAL,
          topics: encodeEventTopics({
            abi: synqDealV1ABI,
            eventName: 'ResolutionExecuted',
            args: { milestoneId: 0n, resolver: TEST_COMMITTEE },
          }),
          data: encodeAbiParameters(
            parseAbiParameters('uint256, uint256'),
            [70000000n, 30000000n]
          ),
        },
        {
          address: TEST_DEAL,
          topics: encodeEventTopics({
            abi: synqDealV1ABI,
            eventName: 'MilestoneSettled',
            args: { milestoneId: 0n },
          }),
          data: encodeAbiParameters(
            parseAbiParameters('uint256, uint256, uint8'),
            [70000000n, 30000000n, SettlementType.ResolverResolution]
          ),
        },
      ],
    };
    const r3 = verifyCommitteeFinalResolutionReceipt({
      receipt: executeResolutionReceipt,
      committeeAddress: TEST_COMMITTEE,
      dealAddress: TEST_DEAL,
      expectedMilestoneId: 0n,
      expectedFreelancerAmount: 70000000n,
      expectedClientAmount: 30000000n,
      expectedJustificationHash: justificationHash,
      expectedNonce: 2n,
    });
    assert.equal(r3.valid, false);
    assert.match(r3.error!, /FinalResolutionSubmitted event not found/);

    // 4. Committee event alone cannot confirm (missing Deal events)
    const committeeOnlyReceipt = {
      status: 'success',
      logs: [
        {
          address: TEST_COMMITTEE,
          topics: encodeEventTopics({
            abi: synqResolutionCommitteeABI,
            eventName: 'FinalResolutionSubmitted',
            args: {
              deal: TEST_DEAL,
              milestoneId: 0n,
            },
          }),
          data: encodeAbiParameters(
            parseAbiParameters('uint256, uint256, bytes32, uint64'),
            [70000000n, 30000000n, justificationHash as `0x${string}`, 2n]
          ),
        },
      ],
    };
    const r4 = verifyCommitteeFinalResolutionReceipt({
      receipt: committeeOnlyReceipt,
      committeeAddress: TEST_COMMITTEE,
      dealAddress: TEST_DEAL,
      expectedMilestoneId: 0n,
      expectedFreelancerAmount: 70000000n,
      expectedClientAmount: 30000000n,
      expectedJustificationHash: justificationHash,
      expectedNonce: 2n,
    });
    assert.equal(r4.valid, false);
    assert.match(r4.error!, /FinalResolutionExecuted event not found/);
  });

  // =========================================================================
  // Section 49: IDEMPOTENCY & CONFLICTING TRANSACTIONS
  // =========================================================================
  await t.test('Section 49: Idempotent reconciliation and conflicting tx rejection', async () => {
    const authRepo = new MockAuthRepository();
    const reportRepo = new MockReportRepository();

    const auth = await authRepo.createAuth({
      reportId: 'rep-1',
      chainId: 11155111,
      committeeAddress: TEST_COMMITTEE,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'INITIAL_RESOLUTION',
      authorizationType: 'ResolutionProposalAuth',
      resolutionNonce: '1',
      validUntil: '3000000',
      committeeEpoch: '1',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '60000000',
      clientAmount: '40000000',
      justificationHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      typedData: {},
      typedDataHash: '0x5555555555555555555555555555555555555555555555555555555555555555',
      status: 'executed',
      createdBySigner: SIGNER_A.address,
      executionTxHash: VALID_TX_HASH,
      executedByWallet: SIGNER_A.address,
      executedAt: new Date(),
    });

    const mockClient = createMockPublicClient({
      status: MilestoneStatus.ResolutionProposed,
    });

    // Reconciling same txHash is idempotent
    const r1 = await reconcileCommitteeAuthorization({
      authorizationId: auth.id,
      callerWallet: SIGNER_A.address,
      txHash: VALID_TX_HASH,
      publicClient: mockClient as any,
      authRepo,
      reportRepo,
    });
    assert.equal(r1.alreadyExecuted, true);
    assert.equal(r1.executionTxHash, VALID_TX_HASH);

    // Reconciling different txHash throws Conflict
    const conflictingTx = '0x9999999999999999999999999999999999999999999999999999999999999999';
    await assert.rejects(
      async () => {
        await reconcileCommitteeAuthorization({
          authorizationId: auth.id,
          callerWallet: SIGNER_A.address,
          txHash: conflictingTx,
          publicClient: mockClient as any,
          authRepo,
          reportRepo,
        });
      },
      (err: any) => err instanceof CommitteeAuthConflictError
    );
  });

  // =========================================================================
  // Section 50: CRASH RECOVERY (NO-TX RECOVERY)
  // =========================================================================
  await t.test('Section 50: Event-based crash recovery without txHash', async () => {
    const authRepo = new MockAuthRepository();
    const reportRepo = new MockReportRepository();
    const justificationHash = '0x3333333333333333333333333333333333333333333333333333333333333333';

    await reportRepo.create({
      chainId: 11155111,
      committeeAddress: TEST_COMMITTEE,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'INITIAL_RESOLUTION',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '60000000',
      clientAmount: '40000000',
      justificationHash,
      canonicalReport: { summary: 'crash test' },
      status: 'staged',
      stagedByWallet: SIGNER_A.address,
    });

    const auth = await authRepo.createAuth({
      reportId: 'rep-1',
      chainId: 11155111,
      committeeAddress: TEST_COMMITTEE,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'INITIAL_RESOLUTION',
      authorizationType: 'ResolutionProposalAuth',
      resolutionNonce: '1',
      validUntil: '3000000',
      committeeEpoch: '1',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '60000000',
      clientAmount: '40000000',
      justificationHash,
      typedData: {},
      typedDataHash: '0x5555555555555555555555555555555555555555555555555555555555555555',
      status: 'threshold_ready',
      createdBySigner: SIGNER_A.address,
    });

    const mockReceipt = {
      status: 'success',
      to: TEST_COMMITTEE,
      from: SIGNER_A.address,
      blockNumber: 100n,
      transactionHash: VALID_TX_HASH,
      logs: [
        {
          address: TEST_COMMITTEE,
          topics: encodeEventTopics({
            abi: synqResolutionCommitteeABI,
            eventName: 'ResolutionProposalSubmitted',
            args: {
              deal: TEST_DEAL,
              milestoneId: 0n,
            },
          }),
          data: encodeAbiParameters(
            parseAbiParameters('uint256, uint256, bytes32, uint64'),
            [60000000n, 40000000n, justificationHash as `0x${string}`, 1n]
          ),
        },
        {
          address: TEST_DEAL,
          topics: encodeEventTopics({
            abi: synqDealV1ABI,
            eventName: 'ResolutionProposed',
            args: {
              milestoneId: 0n,
              resolver: TEST_COMMITTEE,
            },
          }),
          data: encodeAbiParameters(
            parseAbiParameters('uint256, uint256, bytes32, uint64'),
            [60000000n, 40000000n, justificationHash as `0x${string}`, 1259200n]
          ),
        },
      ],
    };

    // 1. Zero matching events -> throws CommitteeExecutionRecoveryError
    const clientZero = createMockPublicClient({
      logs: [],
    });

    await assert.rejects(
      async () => {
        await reconcileCommitteeAuthorization({
          authorizationId: auth.id,
          callerWallet: SIGNER_A.address,
          publicClient: clientZero as any,
          authRepo,
          reportRepo,
        });
      },
      (err: any) => err instanceof CommitteeExecutionRecoveryError
    );

    // 2. Unique match -> succeeds
    const clientUnique = createMockPublicClient({
      status: MilestoneStatus.ResolutionProposed,
      nonceUsedProposal: true,
      receipt: mockReceipt,
      logs: [
        {
          transactionHash: VALID_TX_HASH,
          args: {
            deal: TEST_DEAL,
            milestoneId: 0n,
            freelancerAmount: 60000000n,
            clientAmount: 40000000n,
            justificationHash,
            resolutionNonce: 1n,
          },
        },
      ],
      proposal: {
        freelancerAmount: 60000000n,
        clientAmount: 40000000n,
        justificationHash,
        proposedAt: 100n,
        reconsiderationDeadline: 1259200n,
        resolver: TEST_COMMITTEE,
      },
    });

    const recoveryResult = await reconcileCommitteeAuthorization({
      authorizationId: auth.id,
      callerWallet: SIGNER_A.address,
      publicClient: clientUnique as any,
      authRepo,
      reportRepo,
    });
    assert.equal(recoveryResult.authorization.status, 'executed');
    assert.equal(recoveryResult.executionTxHash, VALID_TX_HASH);
  });

  // =========================================================================
  // Section 51: PARTIAL DB FAILURE / ATOMICITY ORDERING
  // =========================================================================
  await t.test('Section 51: Safe recovery if authorization update fails after report confirms', async () => {
    const authRepo = new MockAuthRepository();
    const reportRepo = new MockReportRepository();
    const justificationHash = '0x3333333333333333333333333333333333333333333333333333333333333333';

    const report = await reportRepo.create({
      chainId: 11155111,
      committeeAddress: TEST_COMMITTEE,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'INITIAL_RESOLUTION',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '60000000',
      clientAmount: '40000000',
      justificationHash,
      canonicalReport: { summary: 'test' },
      status: 'staged',
      stagedByWallet: SIGNER_A.address,
    });

    const auth = await authRepo.createAuth({
      reportId: report.id,
      chainId: 11155111,
      committeeAddress: TEST_COMMITTEE,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'INITIAL_RESOLUTION',
      authorizationType: 'ResolutionProposalAuth',
      resolutionNonce: '1',
      validUntil: '3000000',
      committeeEpoch: '1',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '60000000',
      clientAmount: '40000000',
      justificationHash,
      typedData: {},
      typedDataHash: '0x5555555555555555555555555555555555555555555555555555555555555555',
      status: 'threshold_ready',
      createdBySigner: SIGNER_A.address,
    });

    const mockReceipt = {
      status: 'success',
      to: TEST_COMMITTEE,
      from: SIGNER_A.address,
      blockNumber: 100n,
      transactionHash: VALID_TX_HASH,
      logs: [
        {
          address: TEST_COMMITTEE,
          topics: encodeEventTopics({
            abi: synqResolutionCommitteeABI,
            eventName: 'ResolutionProposalSubmitted',
            args: { deal: TEST_DEAL, milestoneId: 0n },
          }),
          data: encodeAbiParameters(
            parseAbiParameters('uint256, uint256, bytes32, uint64'),
            [60000000n, 40000000n, justificationHash as `0x${string}`, 1n]
          ),
        },
        {
          address: TEST_DEAL,
          topics: encodeEventTopics({
            abi: synqDealV1ABI,
            eventName: 'ResolutionProposed',
            args: { milestoneId: 0n, resolver: TEST_COMMITTEE },
          }),
          data: encodeAbiParameters(
            parseAbiParameters('uint256, uint256, bytes32, uint64'),
            [60000000n, 40000000n, justificationHash as `0x${string}`, 1259200n]
          ),
        },
      ],
    };

    const mockClient = createMockPublicClient({
      status: MilestoneStatus.ResolutionProposed,
      nonceUsedProposal: true,
      receipt: mockReceipt,
      proposal: {
        freelancerAmount: 60000000n,
        clientAmount: 40000000n,
        justificationHash,
        proposedAt: 100n,
        reconsiderationDeadline: 1259200n,
        resolver: TEST_COMMITTEE,
      },
    });

    // Simulate DB failure on authRepo.updateAuthExecution
    let failedOnce = false;
    const failingAuthRepo = {
      ...authRepo,
      getAuthById: (id: string) => authRepo.getAuthById(id),
      updateAuthExecution: async (id: string, data: any) => {
        if (!failedOnce) {
          failedOnce = true;
          throw new Error('Database connection dropped during auth execution update');
        }
        return authRepo.updateAuthExecution(id, data);
      },
    };

    // First attempt fails at auth update
    await assert.rejects(
      async () => {
        await reconcileCommitteeAuthorization({
          authorizationId: auth.id,
          callerWallet: SIGNER_A.address,
          txHash: VALID_TX_HASH,
          publicClient: mockClient as any,
          authRepo: failingAuthRepo as any,
          reportRepo,
        });
      },
      /Database connection dropped/
    );

    // Report was confirmed
    const reportCheck = await reportRepo.getById(report.id);
    assert.equal(reportCheck?.status, 'confirmed');

    // Auth is NOT marked executed
    const authCheck = await authRepo.getAuthById(auth.id);
    assert.equal(authCheck?.status, 'threshold_ready');

    // Second attempt reruns reconciliation cleanly
    const retryResult = await reconcileCommitteeAuthorization({
      authorizationId: auth.id,
      callerWallet: SIGNER_A.address,
      txHash: VALID_TX_HASH,
      publicClient: mockClient as any,
      authRepo: failingAuthRepo as any,
      reportRepo,
    });
    assert.equal(retryResult.authorization.status, 'executed');
    assert.equal(retryResult.executionTxHash, VALID_TX_HASH);
  });

  // =========================================================================
  // Section 52: TERMINAL EXECUTED STATE
  // =========================================================================
  await t.test('Section 52: Terminal executed state rejects bundle, signatures, and preparation', async () => {
    const authRepo = new MockAuthRepository();

    const auth = await authRepo.createAuth({
      reportId: 'rep-1',
      chainId: 11155111,
      committeeAddress: TEST_COMMITTEE,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'INITIAL_RESOLUTION',
      authorizationType: 'ResolutionProposalAuth',
      resolutionNonce: '1',
      validUntil: '3000000',
      committeeEpoch: '1',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '60000000',
      clientAmount: '40000000',
      justificationHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      typedData: {},
      typedDataHash: '0x5555555555555555555555555555555555555555555555555555555555555555',
      status: 'executed',
      createdBySigner: SIGNER_A.address,
      executionTxHash: VALID_TX_HASH,
    });

    const mockClient = createMockPublicClient({});

    // 1. Bundle retrieval rejected
    await assert.rejects(
      async () => {
        await getVerifiedThresholdBundle({
          authorizationId: auth.id,
          callerWallet: SIGNER_A.address,
          publicClient: mockClient as any,
          authRepo,
        });
      },
      (err: any) => err instanceof CommitteeAuthConflictError && err.message.includes('already executed')
    );

    // 2. Signature submission rejected
    await assert.rejects(
      async () => {
        await submitCommitteeSignature({
          authorizationId: auth.id,
          signature: '0x1234',
          callerWallet: SIGNER_A.address,
          publicClient: mockClient as any,
          authRepo,
        });
      },
      (err: any) => err instanceof CommitteeAuthConflictError && err.message.includes('already executed')
    );

    // 3. Execution preparation rejected
    await assert.rejects(
      async () => {
        await prepareCommitteeExecutionTransaction({
          authorizationId: auth.id,
          callerWallet: SIGNER_A.address,
          publicClient: mockClient as any,
          authRepo,
        });
      },
      (err: any) => err instanceof CommitteeAuthConflictError && err.message.includes('already executed')
    );
  });

  // =========================================================================
  // Section 53: RACES & CONTENTION
  // =========================================================================
  await t.test('Section 53: Races fail closed (nonce consumed, competing state, expiry, SLA passed)', async () => {
    const authRepo = new MockAuthRepository();
    const reportRepo = new MockReportRepository();

    const justificationHash = '0x3333333333333333333333333333333333333333333333333333333333333333';
    const report = await reportRepo.create({
      chainId: 11155111,
      committeeAddress: TEST_COMMITTEE,
      dealAddress: TEST_DEAL,
      milestoneId: 0,
      phase: 'INITIAL_RESOLUTION',
      submissionVersion: 1,
      specHash: VALID_SPEC_HASH,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      freelancerAmount: '60000000',
      clientAmount: '40000000',
      justificationHash,
      canonicalReport: { summary: 'test' },
      status: 'staged',
      stagedByWallet: SIGNER_A.address,
    });

    const initClient = createMockPublicClient({
      blockTimestamp: 2100000n,
      signerWallets: [SIGNER_A.address, SIGNER_B.address],
    });

    const { authorization: auth, typedData } = await createCommitteeAuthorization({
      reportId: report.id,
      callerWallet: SIGNER_A.address,
      validUntilSeconds: 200000n, // valid until 2300000n
      publicClient: initClient as any,
      authRepo,
      reportRepo,
    });

    const sigA = await SIGNER_A.signTypedData(typedData as any);
    await submitCommitteeSignature({
      authorizationId: auth.id,
      signature: sigA,
      callerWallet: SIGNER_A.address,
      publicClient: initClient as any,
      authRepo,
    });

    const sigB = await SIGNER_B.signTypedData(typedData as any);
    await submitCommitteeSignature({
      authorizationId: auth.id,
      signature: sigB,
      callerWallet: SIGNER_B.address,
      publicClient: initClient as any,
      authRepo,
    });

    // Race 1: Authorization expires before preparation
    const expiredClient = createMockPublicClient({
      blockTimestamp: 2300001n, // past validUntil: 2300000n
    });
    await assert.rejects(
      async () => {
        await prepareCommitteeExecutionTransaction({
          authorizationId: auth.id,
          callerWallet: SIGNER_A.address,
          publicClient: expiredClient as any,
          authRepo,
        });
      },
      (err: any) => err instanceof CommitteeAuthExpiredError
    );

    // Race 2: Primary 14-day SLA boundary passes before preparation (before validUntil: 2300000n)
    const slaExpiredClient = createMockPublicClient({
      blockTimestamp: 2210000n, // past 14-day boundary (2209600n), before validUntil (2300000n)
    });
    await assert.rejects(
      async () => {
        await prepareCommitteeExecutionTransaction({
          authorizationId: auth.id,
          callerWallet: SIGNER_A.address,
          publicClient: slaExpiredClient as any,
          authRepo,
        });
      },
      (err: any) => err instanceof CommitteeAuthInvalidatedError
    );

    // Race 3: Receipt matches on-chain events, but proposal storage on Deal was overwritten/different (competing proposal won)
    const validLogs = [
      {
        address: TEST_COMMITTEE,
        topics: encodeEventTopics({
          abi: synqResolutionCommitteeABI,
          eventName: 'ResolutionProposalSubmitted',
          args: { deal: TEST_DEAL, milestoneId: 0n },
        }),
        data: encodeAbiParameters(
          parseAbiParameters('uint256, uint256, bytes32, uint64'),
          [60000000n, 40000000n, justificationHash as `0x${string}`, 1n]
        ),
      },
      {
        address: TEST_DEAL,
        topics: encodeEventTopics({
          abi: synqDealV1ABI,
          eventName: 'ResolutionProposed',
          args: { milestoneId: 0n, resolver: TEST_COMMITTEE },
        }),
        data: encodeAbiParameters(
          parseAbiParameters('uint256, uint256, bytes32, uint64'),
          [60000000n, 40000000n, justificationHash as `0x${string}`, 1259200n]
        ),
      },
    ];

    const competingStorageClient = createMockPublicClient({
      blockTimestamp: 1000150n,
      receipt: {
        status: 'success',
        to: TEST_COMMITTEE,
        from: SIGNER_A.address,
        blockNumber: 100n,
        logs: validLogs,
      },
      status: MilestoneStatus.ResolutionProposed,
      nonceUsedProposal: true,
      proposal: {
        // Storage has DIFFERENT justificationHash (a competing resolution won)
        freelancerAmount: 60000000n,
        clientAmount: 40000000n,
        justificationHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
        proposedAt: 1000100n,
        reconsiderationDeadline: 1259200n,
        resolver: TEST_COMMITTEE,
      },
    });

    // Reset status to threshold_ready for reconciliation tests
    await authRepo.updateAuthStatus(auth.id, 'threshold_ready');

    await assert.rejects(
      async () => {
        await reconcileCommitteeAuthorization({
          authorizationId: auth.id,
          callerWallet: SIGNER_A.address,
          txHash: VALID_TX_HASH,
          publicClient: competingStorageClient as any,
          authRepo,
          reportRepo,
        });
      },
      (err: any) => err instanceof CommitteeExecutionReceiptError && err.message.includes('justificationHash mismatch')
    );

    // Race 4: Nonce was not consumed on chain -> fails closed
    await authRepo.updateAuthStatus(auth.id, 'threshold_ready');
    const nonceNotConsumedClient = createMockPublicClient({
      blockTimestamp: 1000150n,
      receipt: {
        status: 'success',
        to: TEST_COMMITTEE,
        from: SIGNER_A.address,
        blockNumber: 100n,
        logs: validLogs,
      },
      status: MilestoneStatus.ResolutionProposed,
      nonceUsedProposal: false, // nonce NOT consumed!
      proposal: {
        freelancerAmount: 60000000n,
        clientAmount: 40000000n,
        justificationHash,
        proposedAt: 1000100n,
        reconsiderationDeadline: 1259200n,
        resolver: TEST_COMMITTEE,
      },
    });

    await assert.rejects(
      async () => {
        await reconcileCommitteeAuthorization({
          authorizationId: auth.id,
          callerWallet: SIGNER_A.address,
          txHash: VALID_TX_HASH,
          publicClient: nonceNotConsumedClient as any,
          authRepo,
          reportRepo,
        });
      },
      (err: any) => err instanceof CommitteeExecutionReceiptError && err.message.includes('nonce')
    );
  });
});
