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
  RESOLUTION_COMMITTEE_EIP712_NAME,
  RESOLUTION_COMMITTEE_EIP712_VERSION,
  RESOLUTION_PROPOSAL_PRIMARY_TYPE,
  FINAL_RESOLUTION_PRIMARY_TYPE,
  RESOLUTION_PROPOSAL_AUTH_TYPES,
  FINAL_RESOLUTION_AUTH_TYPES,
  RESOLUTION_PROPOSAL_TYPEHASH,
  FINAL_RESOLUTION_TYPEHASH,
  COMMITTEE_THRESHOLD,
  getCommitteeEIP712Domain,
  getResolutionProposalTypedData,
  getFinalResolutionTypedData,
  hashResolutionProposalAuth,
  hashFinalResolutionAuth,
  computeNonceKey,
  verifyCommitteeSignerSignature,
  buildVerifiedThresholdBundle,
  CommitteeAuthValidationError,
  CommitteeAuthAuthError,
  CommitteeAuthConflictError,
  CommitteeAuthIntegrityError,
  CommitteeAuthExpiredError,
  CommitteeAuthInvalidatedError,
  type ResolutionProposalAuthData,
  type FinalResolutionAuthData,
} from '../src/lib/deals/v2-committee-auth';
import {
  createCommitteeAuthorization,
  submitCommitteeSignature,
  getCommitteeAuthorization,
  getVerifiedThresholdBundle,
  type ICommitteeAuthorizationRepository,
} from '../src/lib/deals/committee-authorizations-db';
import {
  verifyResolutionProposedReceipt,
  verifyFinalResolutionExecutedReceipt,
  synqResolutionCommitteeReadABI,
  hashResolutionReport,
} from '../src/lib/deals/v2-resolution-report';
import {
  reconcileResolutionReport,
  type IMilestoneResolutionReportRepository,
} from '../src/lib/deals/resolution-reports-db';
import { DealState, MilestoneStatus } from '../src/lib/deals/v2-deal';
import { synqDealV1ABI } from '../src/lib/contracts/abis';
import type {
  CommitteeResolutionAuthorizationRow,
  NewCommitteeResolutionAuthorizationRow,
  CommitteeResolutionSignatureRow,
  NewCommitteeResolutionSignatureRow,
  MilestoneResolutionReportRow,
  ResolutionReportPhase,
  CommitteeAuthorizationStatus,
} from '../src/db/schema';

// Deterministic local test accounts (never real committee private keys)
const SIGNER_A = privateKeyToAccount('0x1111111111111111111111111111111111111111111111111111111111111111');
const SIGNER_B = privateKeyToAccount('0x2222222222222222222222222222222222222222222222222222222222222222');
const SIGNER_C = privateKeyToAccount('0x3333333333333333333333333333333333333333333333333333333333333333');
const ROTATED_NEW_SIGNER = privateKeyToAccount('0x4444444444444444444444444444444444444444444444444444444444444444');
const OUTSIDER = privateKeyToAccount('0x5555555555555555555555555555555555555555555555555555555555555555');
const CLIENT_ACC = privateKeyToAccount('0x6666666666666666666666666666666666666666666666666666666666666666');
const FREELANCER_ACC = privateKeyToAccount('0x7777777777777777777777777777777777777777777777777777777777777777');

const TEST_PRIMARY_COMMITTEE = '0xd60bbcc7c8aca633a6d158b6f7f7367e36207676' as `0x${string}`;
const TEST_EMERGENCY_COMMITTEE = '0x5dcb412ba5f032bc9095cdc95046168a076ff952' as `0x${string}`;
const TEST_DEAL = '0x8888888888888888888888888888888888888888' as `0x${string}`;
const VALID_SPEC_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
const VALID_EVIDENCE_HASH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;

// Mock in-memory auth repository
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
    const updated = {
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

// Mock in-memory report repository
class MockReportRepository implements IMilestoneResolutionReportRepository {
  public rows = new Map<string, MilestoneResolutionReportRow>();

  async getByMilestoneAndPhase(): Promise<any> { return null; }
  async getByMilestoneAndHash(): Promise<any> { return null; }
  async listByMilestone(): Promise<any> { return Array.from(this.rows.values()); }
  async getById(id: string): Promise<MilestoneResolutionReportRow | null> { return this.rows.get(id) ?? null; }
  async create(row: any): Promise<any> {
    const r = { ...row, id: row.id ?? 'rep-1' };
    this.rows.set(r.id, r);
    return r;
  }
  async updateStaged(): Promise<any> { return null; }
  async confirm(): Promise<any> { return null; }
}

function createBaseReportRow(phase: ResolutionReportPhase = 'INITIAL_RESOLUTION'): MilestoneResolutionReportRow {
  return {
    id: `rep-${phase.toLowerCase()}-1`,
    chainId: 11155111,
    committeeAddress: TEST_PRIMARY_COMMITTEE,
    dealAddress: TEST_DEAL,
    milestoneId: 0,
    phase,
    submissionVersion: 1,
    specHash: VALID_SPEC_HASH,
    evidenceRootHash: VALID_EVIDENCE_HASH,
    freelancerAmount: '60000000',
    clientAmount: '40000000',
    justificationHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    canonicalReport: { summary: 'test' },
    status: 'staged',
    txHash: null,
    stagedByWallet: SIGNER_A.address.toLowerCase(),
    resolvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// TEST SUITE
// ---------------------------------------------------------------------------

test('SYNQ Phase 3M-C: Committee Authorization Exchange Layer', async (t) => {
  // =========================================================================
  // Section 39 & 41: EXACT TYPE DEFINITIONS & TYPEHASHES
  // =========================================================================
  await t.test('Section 39 & 41: Exact EIP-712 types, primaryType, and typehashes match Solidity', () => {
    // 1. Primary types
    assert.equal(RESOLUTION_PROPOSAL_PRIMARY_TYPE, 'ResolutionProposalAuth');
    assert.equal(FINAL_RESOLUTION_PRIMARY_TYPE, 'FinalResolutionAuth');

    // 2. Type hashes match keccak256 of exact Solidity struct string
    const expectedProposalString =
      'ResolutionProposalAuth(address committee,uint256 chainId,address deal,uint256 milestoneId,uint256 freelancerAmount,uint256 clientAmount,bytes32 justificationHash,uint64 resolutionNonce,uint64 validUntil,bytes32 evidenceRootHash,bytes32 specHash,uint8 submissionVersion)';
    const calculatedProposalTypehash = keccak256(stringToBytes(expectedProposalString));
    assert.equal(RESOLUTION_PROPOSAL_TYPEHASH, calculatedProposalTypehash);

    const expectedFinalString =
      'FinalResolutionAuth(address committee,uint256 chainId,address deal,uint256 milestoneId,uint256 freelancerAmount,uint256 clientAmount,bytes32 justificationHash,uint64 resolutionNonce,uint64 validUntil,bytes32 evidenceRootHash,bytes32 specHash,uint8 submissionVersion)';
    const calculatedFinalTypehash = keccak256(stringToBytes(expectedFinalString));
    assert.equal(FINAL_RESOLUTION_TYPEHASH, calculatedFinalTypehash);

    // 3. Field order & types in RESOLUTION_PROPOSAL_AUTH_TYPES
    const fields = RESOLUTION_PROPOSAL_AUTH_TYPES.ResolutionProposalAuth;
    assert.equal(fields.length, 12);
    assert.deepEqual(fields[0], { name: 'committee', type: 'address' });
    assert.deepEqual(fields[1], { name: 'chainId', type: 'uint256' });
    assert.deepEqual(fields[2], { name: 'deal', type: 'address' });
    assert.deepEqual(fields[3], { name: 'milestoneId', type: 'uint256' });
    assert.deepEqual(fields[4], { name: 'freelancerAmount', type: 'uint256' });
    assert.deepEqual(fields[5], { name: 'clientAmount', type: 'uint256' });
    assert.deepEqual(fields[6], { name: 'justificationHash', type: 'bytes32' });
    assert.deepEqual(fields[7], { name: 'resolutionNonce', type: 'uint64' });
    assert.deepEqual(fields[8], { name: 'validUntil', type: 'uint64' });
    assert.deepEqual(fields[9], { name: 'evidenceRootHash', type: 'bytes32' });
    assert.deepEqual(fields[10], { name: 'specHash', type: 'bytes32' });
    assert.deepEqual(fields[11], { name: 'submissionVersion', type: 'uint8' });
  });

  // =========================================================================
  // Section 42 & 43: DOMAIN SEPARATION & REPORT BINDING
  // =========================================================================
  await t.test('Section 42 & 43: Domain separation and field mutation alters digest', () => {
    const baseAuth: ResolutionProposalAuthData = {
      committee: TEST_PRIMARY_COMMITTEE,
      chainId: 11155111n,
      deal: TEST_DEAL,
      milestoneId: 0n,
      freelancerAmount: 60000000n,
      clientAmount: 40000000n,
      justificationHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      resolutionNonce: 1n,
      validUntil: 2000000000n,
      evidenceRootHash: VALID_EVIDENCE_HASH,
      specHash: VALID_SPEC_HASH,
      submissionVersion: 1,
    };

    const baseDigest = hashResolutionProposalAuth(baseAuth);

    // Changing chainId changes digest
    assert.notEqual(hashResolutionProposalAuth({ ...baseAuth, chainId: 1n }), baseDigest);

    // Changing committee changes digest
    assert.notEqual(hashResolutionProposalAuth({ ...baseAuth, committee: TEST_EMERGENCY_COMMITTEE }), baseDigest);

    // Changing deal changes digest
    assert.notEqual(hashResolutionProposalAuth({ ...baseAuth, deal: '0x9999999999999999999999999999999999999999' }), baseDigest);

    // Changing milestoneId changes digest
    assert.notEqual(hashResolutionProposalAuth({ ...baseAuth, milestoneId: 1n }), baseDigest);

    // Changing split amounts changes digest
    assert.notEqual(hashResolutionProposalAuth({ ...baseAuth, freelancerAmount: 70000000n, clientAmount: 30000000n }), baseDigest);

    // Changing justificationHash changes digest
    assert.notEqual(hashResolutionProposalAuth({ ...baseAuth, justificationHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), baseDigest);

    // Changing nonce changes digest
    assert.notEqual(hashResolutionProposalAuth({ ...baseAuth, resolutionNonce: 2n }), baseDigest);

    // Changing validUntil changes digest
    assert.notEqual(hashResolutionProposalAuth({ ...baseAuth, validUntil: 2000000001n }), baseDigest);

    // Changing snapshots changes digest
    assert.notEqual(hashResolutionProposalAuth({ ...baseAuth, submissionVersion: 2 }), baseDigest);
    assert.notEqual(hashResolutionProposalAuth({ ...baseAuth, specHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }), baseDigest);
  });

  // =========================================================================
  // Section 44 & 45: AUTHORIZATION CREATION & CHAIN TIME
  // =========================================================================
  await t.test('Section 44 & 45: Authorization creation preflight and fail-closed chain time', async () => {
    const authRepo = new MockAuthRepository();
    const reportRepo = new MockReportRepository();
    const initialReport = createBaseReportRow('INITIAL_RESOLUTION');
    await reportRepo.create(initialReport);

    const disputeOpenedTime = 1000000n;
    const currentChainTime = disputeOpenedTime + 500n;

    const mockDealData = {
      dealAddress: TEST_DEAL,
      client: CLIENT_ACC.address,
      freelancer: FREELANCER_ACC.address,
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
      primaryResolver: TEST_PRIMARY_COMMITTEE,
      emergencyResolver: TEST_EMERGENCY_COMMITTEE,
    };

    const makeClient = (timestamp: bigint | null, signerWallet: string) => ({
      getBlock: timestamp !== null ? async () => ({ timestamp }) : undefined,
      readContract: async (args: any) => {
        if (args.functionName === 'isSynqDeal') return true;
        if (args.functionName === 'milestoneDisputeOpenedAt') return disputeOpenedTime;
        if (args.functionName === 'isSigner') {
          return args.args[0].toLowerCase() === signerWallet.toLowerCase();
        }
        if (args.functionName === 'committeeEpoch') return 0n;
        if (args.functionName === 'usedProposalNonces' || args.functionName === 'usedFinalNonces') return false;
        if (args.functionName === 'primaryResolver') return TEST_PRIMARY_COMMITTEE;
        if (args.functionName === 'emergencyResolver') return TEST_EMERGENCY_COMMITTEE;
        if (args.functionName === 'state') return DealState.Active;
        if (args.functionName === 'isProtected') return false;
        if (args.functionName === 'getMilestone') return mockDealData.milestones[0];
        if (args.functionName === 'milestoneCount') return 1n;
        if (args.functionName === 'client') return CLIENT_ACC.address;
        if (args.functionName === 'freelancer') return FREELANCER_ACC.address;
        if (args.functionName === 'usdc') return mockDealData.usdc;
        if (args.functionName === 'totalEscrow') return 100000000n;
        if (args.functionName === 'totalSettled') return 0n;
        return null;
      },
    });

    // 1. Active committee signer accepted
    const validClient = makeClient(currentChainTime, SIGNER_A.address);
    const created = await createCommitteeAuthorization({
      reportId: initialReport.id,
      callerWallet: SIGNER_A.address,
      publicClient: validClient as any,
      authRepo,
      reportRepo,
    });
    assert.equal(created.authorization.status, 'collecting');
    assert.equal(created.authorization.authorizationType, 'ResolutionProposalAuth');

    // 2. Fail closed: no getBlock / cannot obtain chain timestamp -> rejected
    const noBlockClient = makeClient(null, SIGNER_A.address);
    await assert.rejects(
      () => createCommitteeAuthorization({
        reportId: initialReport.id,
        callerWallet: SIGNER_A.address,
        publicClient: noBlockClient as any,
        authRepo,
        reportRepo,
      }),
      /Canonical chain timestamp required; failing closed/
    );

    // 3. Outsider / Participant rejected
    await assert.rejects(
      () => createCommitteeAuthorization({
        reportId: initialReport.id,
        callerWallet: OUTSIDER.address,
        publicClient: validClient as any,
        authRepo,
        reportRepo,
      }),
      /Caller .* is not an active signer/
    );

    await assert.rejects(
      () => createCommitteeAuthorization({
        reportId: initialReport.id,
        callerWallet: CLIENT_ACC.address,
        publicClient: validClient as any,
        authRepo,
        reportRepo,
      }),
      /Caller .* is not an active signer/
    );
  });

  // =========================================================================
  // Section 46, 47 & 48: SIGNATURE SUBMISSION, EXPIRY & 2-OF-3 THRESHOLD
  // =========================================================================
  await t.test('Section 46, 47 & 48: Signature collection, expiry boundaries, and threshold consensus', async () => {
    const authRepo = new MockAuthRepository();
    const reportRepo = new MockReportRepository();
    const initialReport = createBaseReportRow('INITIAL_RESOLUTION');
    await reportRepo.create(initialReport);

    const chainTime = 1000500n;
    const client = {
      getBlock: async () => ({ timestamp: chainTime }),
      readContract: async (args: any) => {
        if (args.functionName === 'isSynqDeal') return true;
        if (args.functionName === 'milestoneDisputeOpenedAt') return 1000000n;
        if (args.functionName === 'isSigner') {
          const w = args.args[0].toLowerCase();
          return w === SIGNER_A.address.toLowerCase() || w === SIGNER_B.address.toLowerCase() || w === SIGNER_C.address.toLowerCase();
        }
        if (args.functionName === 'committeeEpoch') return 0n;
        if (args.functionName === 'usedProposalNonces' || args.functionName === 'usedFinalNonces') return false;
        if (args.functionName === 'primaryResolver') return TEST_PRIMARY_COMMITTEE;
        if (args.functionName === 'emergencyResolver') return TEST_EMERGENCY_COMMITTEE;
        if (args.functionName === 'state') return DealState.Active;
        if (args.functionName === 'isProtected') return false;
        if (args.functionName === 'getMilestone') return {
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
        };
        if (args.functionName === 'milestoneCount') return 1n;
        if (args.functionName === 'client') return CLIENT_ACC.address;
        if (args.functionName === 'freelancer') return FREELANCER_ACC.address;
        if (args.functionName === 'usdc') return '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
        if (args.functionName === 'totalEscrow') return 100000000n;
        if (args.functionName === 'totalSettled') return 0n;
        return null;
      },
    };

    // Create authorization
    const { authorization, typedData } = await createCommitteeAuthorization({
      reportId: initialReport.id,
      callerWallet: SIGNER_A.address,
      validUntilSeconds: 3600n, // Expires at chainTime + 3600
      publicClient: client as any,
      authRepo,
      reportRepo,
    });

    // Signer A signs
    const sigA = await SIGNER_A.signTypedData(typedData as any);
    const subA = await submitCommitteeSignature({
      authorizationId: authorization.id,
      signature: sigA,
      callerWallet: SIGNER_A.address,
      publicClient: client as any,
      authRepo,
    });
    assert.equal(subA.thresholdReady, false);
    assert.equal(subA.authorization.status, 'collecting');

    // Duplicate submission by Signer A with exact same signature is idempotent
    const subAAgain = await submitCommitteeSignature({
      authorizationId: authorization.id,
      signature: sigA,
      callerWallet: SIGNER_A.address,
      publicClient: client as any,
      authRepo,
    });
    assert.equal(subAAgain.thresholdReady, false);

    // Re-submission of DIFFERENT signature by same signer -> REJECTED (immutable)
    const diffSigA = ('0x' + '7'.repeat(130)) as any;
    await assert.rejects(
      () => submitCommitteeSignature({
        authorizationId: authorization.id,
        signature: diffSigA,
        callerWallet: SIGNER_A.address,
        publicClient: client as any,
        authRepo,
      }),
      /has already submitted an immutable signature/
    );
    const sigsForAuth = await authRepo.getSignaturesByAuthId(authorization.id);
    assert.equal(sigsForAuth.length, 1);
    assert.equal(sigsForAuth[0].signature.toLowerCase(), sigA.toLowerCase());

    // Signer B signs -> 2-of-3 threshold reached
    const sigB = await SIGNER_B.signTypedData(typedData as any);
    const subB = await submitCommitteeSignature({
      authorizationId: authorization.id,
      signature: sigB,
      callerWallet: SIGNER_B.address,
      publicClient: client as any,
      authRepo,
    });
    assert.equal(subB.thresholdReady, true);
    assert.equal(subB.authorization.status, 'threshold_ready');

    // Section 47: Expiry boundary tests
    const expiredClient = {
      ...client,
      getBlock: async () => ({ timestamp: BigInt(authorization.validUntil) + 1n }),
    };
    const sigC = await SIGNER_C.signTypedData(typedData as any);
    await assert.rejects(
      () => submitCommitteeSignature({
        authorizationId: authorization.id,
        signature: sigC,
        callerWallet: SIGNER_C.address,
        publicClient: expiredClient as any,
        authRepo,
      }),
      /Authorization expired on-chain/
    );
  });

  // =========================================================================
  // Section 49, 50 & 51: ROTATION, STATE RACES & MULTIPLE REPORTS
  // =========================================================================
  await t.test('Section 49, 50 & 51: Committee rotation, state race conditions, and candidate report isolation', async () => {
    const authRepo = new MockAuthRepository();
    const reportRepo = new MockReportRepository();
    const initialReportA = createBaseReportRow('INITIAL_RESOLUTION');
    const initialReportB = { ...initialReportA, id: 'rep-initial-2', freelancerAmount: '70000000', clientAmount: '30000000' };
    await reportRepo.create(initialReportA);
    await reportRepo.create(initialReportB);

    const client = {
      getBlock: async () => ({ timestamp: 1000500n }),
      readContract: async (args: any) => {
        if (args.functionName === 'isSynqDeal') return true;
        if (args.functionName === 'milestoneDisputeOpenedAt') return 1000000n;
        if (args.functionName === 'isSigner') return true;
        if (args.functionName === 'committeeEpoch') return 0n;
        if (args.functionName === 'usedProposalNonces') return false;
        if (args.functionName === 'primaryResolver') return TEST_PRIMARY_COMMITTEE;
        if (args.functionName === 'emergencyResolver') return TEST_EMERGENCY_COMMITTEE;
        if (args.functionName === 'state') return DealState.Active;
        if (args.functionName === 'isProtected') return false;
        if (args.functionName === 'getMilestone') return {
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
        };
        if (args.functionName === 'milestoneCount') return 1n;
        if (args.functionName === 'client') return CLIENT_ACC.address;
        if (args.functionName === 'freelancer') return FREELANCER_ACC.address;
        if (args.functionName === 'usdc') return '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
        if (args.functionName === 'totalEscrow') return 100000000n;
        if (args.functionName === 'totalSettled') return 0n;
        return null;
      },
    };

    const authA = await createCommitteeAuthorization({
      reportId: initialReportA.id,
      callerWallet: SIGNER_A.address,
      publicClient: client as any,
      authRepo,
      reportRepo,
    });

    const sigA = await SIGNER_A.signTypedData(authA.typedData as any);

    // 1. Rotation invalidation: epoch increments on-chain -> signature rejected, auth invalidated
    const rotatedClient = {
      ...client,
      readContract: async (args: any) => {
        if (args.functionName === 'committeeEpoch') return 1n; // Epoch changed from 0 to 1
        return (client as any).readContract(args);
      },
    };
    await assert.rejects(
      () => submitCommitteeSignature({
        authorizationId: authA.authorization.id,
        signature: sigA,
        callerWallet: SIGNER_A.address,
        publicClient: rotatedClient as any,
        authRepo,
      }),
      /Committee epoch changed on-chain/
    );
    const invalidatedAuth = await authRepo.getAuthById(authA.authorization.id);
    assert.equal(invalidatedAuth?.status, 'invalidated');

    // 2. State race: milestone settles via mutual settlement while collecting -> rejected
    const settledClient = {
      ...client,
      readContract: async (args: any) => {
        if (args.functionName === 'getMilestone') return {
          index: 0,
          amount: 100000000n,
          workDeadline: 2000000000n,
          reviewWindow: 86400n,
          gracePeriod: 86400n,
          status: MilestoneStatus.SettledSplit, // State raced to terminal
          specHash: VALID_SPEC_HASH,
          evidenceRootHash: VALID_EVIDENCE_HASH,
          submittedAt: 1900000000n,
          version: 1,
        };
        return (client as any).readContract(args);
      },
    };
    const freshAuth = await authRepo.createAuth({
      ...authA.authorization,
      id: 'fresh-auth-state-race',
      status: 'collecting',
    });
    await assert.rejects(
      () => submitCommitteeSignature({
        authorizationId: freshAuth.id,
        signature: sigA,
        callerWallet: SIGNER_A.address,
        publicClient: settledClient as any,
        authRepo,
      }),
      /Milestone is no longer in Disputed status/
    );

    // 3. Section 51: Multiple candidate reports isolation
    const authB = await createCommitteeAuthorization({
      reportId: initialReportB.id,
      callerWallet: SIGNER_A.address,
      publicClient: client as any,
      authRepo,
      reportRepo,
    });
    assert.notEqual(authA.typedDataHash, authB.typedDataHash);
    // Signature for Auth A fails against Auth B typed data
    await assert.rejects(
      () => submitCommitteeSignature({
        authorizationId: authB.authorization.id,
        signature: sigA, // signature for Auth A!
        callerWallet: SIGNER_A.address,
        publicClient: client as any,
        authRepo,
      }),
      /Recovered signer .* does not match expected signer/
    );
  });

  // =========================================================================
  // Section 52 & 53: VERIFIED THRESHOLD BUNDLE & PRIVACY
  // =========================================================================
  await t.test('Section 52 & 53: Deterministic threshold bundle assembly and access privacy', async () => {
    const authRepo = new MockAuthRepository();
    const reportRepo = new MockReportRepository();
    const initialReport = createBaseReportRow('INITIAL_RESOLUTION');
    await reportRepo.create(initialReport);

    const client = {
      getBlock: async () => ({ timestamp: 1000500n }),
      readContract: async (args: any) => {
        if (args.functionName === 'isSynqDeal') return true;
        if (args.functionName === 'milestoneDisputeOpenedAt') return 1000000n;
        if (args.functionName === 'isSigner') {
          const w = args.args[0].toLowerCase();
          return w === SIGNER_A.address.toLowerCase() || w === SIGNER_B.address.toLowerCase();
        }
        if (args.functionName === 'committeeEpoch') return 0n;
        if (args.functionName === 'usedProposalNonces') return false;
        if (args.functionName === 'primaryResolver') return TEST_PRIMARY_COMMITTEE;
        if (args.functionName === 'emergencyResolver') return TEST_EMERGENCY_COMMITTEE;
        if (args.functionName === 'state') return DealState.Active;
        if (args.functionName === 'isProtected') return false;
        if (args.functionName === 'getMilestone') return {
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
        };
        if (args.functionName === 'milestoneCount') return 1n;
        if (args.functionName === 'client') return CLIENT_ACC.address;
        if (args.functionName === 'freelancer') return FREELANCER_ACC.address;
        if (args.functionName === 'usdc') return '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
        if (args.functionName === 'totalEscrow') return 100000000n;
        if (args.functionName === 'totalSettled') return 0n;
        return null;
      },
    };

    const { authorization, typedData } = await createCommitteeAuthorization({
      reportId: initialReport.id,
      callerWallet: SIGNER_A.address,
      publicClient: client as any,
      authRepo,
      reportRepo,
    });

    const sigA = await SIGNER_A.signTypedData(typedData as any);
    const sigB = await SIGNER_B.signTypedData(typedData as any);

    await submitCommitteeSignature({
      authorizationId: authorization.id,
      signature: sigA,
      callerWallet: SIGNER_A.address,
      publicClient: client as any,
      authRepo,
    });
    await submitCommitteeSignature({
      authorizationId: authorization.id,
      signature: sigB,
      callerWallet: SIGNER_B.address,
      publicClient: client as any,
      authRepo,
    });

    // 1. Export verified threshold bundle
    const bundle = await getVerifiedThresholdBundle({
      authorizationId: authorization.id,
      callerWallet: SIGNER_A.address,
      publicClient: client as any,
      authRepo,
    });

    assert.equal(bundle.signers.length, 2);
    assert.equal(bundle.signatures.length, 2);
    assert.equal(bundle.authorizationId, authorization.id);
    assert.equal(bundle.reportId, initialReport.id);
    // Bundle signers are deterministically sorted
    assert.equal(bundle.signers[0] < bundle.signers[1], true);

    // 2. Section 53 Privacy: Deal client cannot access raw bundle
    await assert.rejects(
      () => getVerifiedThresholdBundle({
        authorizationId: authorization.id,
        callerWallet: CLIENT_ACC.address,
        publicClient: client as any,
        authRepo,
      }),
      /Unauthorized: caller is not an active committee signer/
    );

    // Outsider cannot access
    await assert.rejects(
      () => getVerifiedThresholdBundle({
        authorizationId: authorization.id,
        callerWallet: OUTSIDER.address,
        publicClient: client as any,
        authRepo,
      }),
      /Unauthorized: caller is not an active committee signer/
    );
  });

  // =========================================================================
  // Section 54: 3M-B REGRESSION GAPS
  // =========================================================================
  await t.test('Section 54: 3M-B regression gap closures', async () => {
    const justificationHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as `0x${string}`;

    // 1. Failed receipt (status: 'reverted' / 0x0) rejected
    const revertedReceipt = {
      status: 'reverted',
      logs: [],
    };
    const failedProposed = verifyResolutionProposedReceipt({
      receipt: revertedReceipt,
      dealAddress: TEST_DEAL,
      expectedMilestoneId: 0n,
      expectedResolver: TEST_PRIMARY_COMMITTEE,
      expectedFreelancerAmount: 60000000n,
      expectedClientAmount: 40000000n,
      expectedJustificationHash: justificationHash,
    });
    assert.equal(failedProposed.valid, false);
    assert.match(failedProposed.error!, /Transaction reverted on-chain/);

    const failedFinal = verifyFinalResolutionExecutedReceipt({
      receipt: revertedReceipt,
      dealAddress: TEST_DEAL,
      expectedMilestoneId: 0n,
      expectedResolver: TEST_PRIMARY_COMMITTEE,
      expectedFreelancerAmount: 70000000n,
      expectedClientAmount: 30000000n,
      expectedJustificationHash: justificationHash,
    });
    assert.equal(failedFinal.valid, false);
    assert.match(failedFinal.error!, /Transaction reverted on-chain/);

    // 2. Mutual settlement receipt cannot false-confirm FINAL report
    const mutualSettlementReceipt = {
      status: 'success',
      logs: [
        {
          address: TEST_DEAL,
          data: encodeAbiParameters(parseAbiParameters('uint256, uint256'), [60000000n, 40000000n]),
          topics: encodeEventTopics({
            abi: synqDealV1ABI,
            eventName: 'MilestoneSettled',
            args: {
              milestoneId: 0n,
            },
          }),
        },
      ],
    };
    const mutualOnFinal = verifyFinalResolutionExecutedReceipt({
      receipt: mutualSettlementReceipt,
      dealAddress: TEST_DEAL,
      expectedMilestoneId: 0n,
      expectedResolver: TEST_PRIMARY_COMMITTEE,
      expectedFreelancerAmount: 60000000n,
      expectedClientAmount: 40000000n,
      expectedJustificationHash: justificationHash,
    });
    assert.equal(mutualOnFinal.valid, false);
    assert.match(mutualOnFinal.error!, /FinalResolutionExecuted event not found in transaction receipt/);

    // 3. Ordinary executeResolution receipt (ResolutionExecuted) cannot false-confirm FINAL report
    const ordinaryExecutionReceipt = {
      status: 'success',
      logs: [
        {
          address: TEST_DEAL,
          data: encodeAbiParameters(parseAbiParameters('uint256, uint256'), [60000000n, 40000000n]),
          topics: encodeEventTopics({
            abi: synqDealV1ABI,
            eventName: 'ResolutionExecuted',
            args: {
              milestoneId: 0n,
              resolver: TEST_PRIMARY_COMMITTEE,
            },
          }),
        },
      ],
    };
    const ordinaryOnFinal = verifyFinalResolutionExecutedReceipt({
      receipt: ordinaryExecutionReceipt,
      dealAddress: TEST_DEAL,
      expectedMilestoneId: 0n,
      expectedResolver: TEST_PRIMARY_COMMITTEE,
      expectedFreelancerAmount: 60000000n,
      expectedClientAmount: 40000000n,
      expectedJustificationHash: justificationHash,
    });
    assert.equal(ordinaryOnFinal.valid, false);
    assert.match(ordinaryOnFinal.error!, /FinalResolutionExecuted event not found in transaction receipt/);
  });

  // =========================================================================
  // Section 20-32 (Phase 3M-C1): SIGNATURE IMMUTABILITY & BUNDLE HARDENING
  // =========================================================================
  await t.test('Section 20-32 (Phase 3M-C1): Signature immutability and threshold-bundle fail-closed hardening', async () => {
    const authRepo = new MockAuthRepository();
    const reportRepo = new MockReportRepository();
    const initialReport = createBaseReportRow('INITIAL_RESOLUTION');
    await reportRepo.create(initialReport);

    const disputeOpenedAt = 1000000n;
    const baseTimestamp = 1000500n;

    const createMockClient = (overrides: Record<string, any> = {}) => {
      const state = {
        blockTimestamp: baseTimestamp,
        isSignerA: true,
        isSignerB: true,
        epoch: 0n,
        nonceUsed: false,
        milestoneStatus: MilestoneStatus.Disputed,
        milestoneDisputeOpenedAt: disputeOpenedAt,
        primaryResolver: TEST_PRIMARY_COMMITTEE,
        emergencyResolver: TEST_EMERGENCY_COMMITTEE,
        dealState: DealState.Active,
        getBlockFails: false,
        storedProposalResolver: TEST_PRIMARY_COMMITTEE,
        ...overrides,
      };

      return {
        getBlock: async () => {
          if (state.getBlockFails) {
            throw new Error('RPC getBlock connection failure');
          }
          return { timestamp: state.blockTimestamp };
        },
        readContract: async (args: any) => {
          if (args.functionName === 'isSynqDeal') return true;
          if (args.functionName === 'milestoneDisputeOpenedAt') return state.milestoneDisputeOpenedAt;
          if (args.functionName === 'isSigner') {
            const w = args.args[0].toLowerCase();
            if (w === SIGNER_A.address.toLowerCase()) return state.isSignerA;
            if (w === SIGNER_B.address.toLowerCase()) return state.isSignerB;
            return false;
          }
          if (args.functionName === 'committeeEpoch') return state.epoch;
          if (args.functionName === 'usedProposalNonces') return state.nonceUsed;
          if (args.functionName === 'primaryResolver') return state.primaryResolver;
          if (args.functionName === 'emergencyResolver') return state.emergencyResolver;
          if (args.functionName === 'state') return state.dealState;
          if (args.functionName === 'isProtected') return false;
          if (args.functionName === 'getMilestone') return {
            index: 0,
            amount: 100000000n,
            workDeadline: 2000000000n,
            reviewWindow: 86400n,
            gracePeriod: 86400n,
            status: state.milestoneStatus,
            specHash: VALID_SPEC_HASH,
            evidenceRootHash: VALID_EVIDENCE_HASH,
            submittedAt: 1900000000n,
            version: 1,
          };
          if (args.functionName === 'getResolutionProposal') {
            return {
              resolver: state.storedProposalResolver,
              freelancerAmount: 60000000n,
              clientAmount: 40000000n,
              justificationHash: initialReport.justificationHash,
            };
          }
          if (args.functionName === 'milestoneCount') return 1n;
          if (args.functionName === 'client') return CLIENT_ACC.address;
          if (args.functionName === 'freelancer') return FREELANCER_ACC.address;
          if (args.functionName === 'usdc') return '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
          if (args.functionName === 'totalEscrow') return 100000000n;
          if (args.functionName === 'totalSettled') return 0n;
          return null;
        },
      };
    };

    const baseClient = createMockClient();

    // Create INITIAL authorization
    const { authorization, typedData } = await createCommitteeAuthorization({
      reportId: initialReport.id,
      callerWallet: SIGNER_A.address,
      publicClient: baseClient as any,
      authRepo,
      reportRepo,
    });

    // 1. Signature Immutability Tests
    const sigA = await SIGNER_A.signTypedData(typedData as any);
    const firstSub = await submitCommitteeSignature({
      authorizationId: authorization.id,
      signature: sigA,
      callerWallet: SIGNER_A.address,
      publicClient: baseClient as any,
      authRepo,
    });
    assert.equal(firstSub.thresholdReady, false);

    // Idempotent re-submission
    const idempotentSub = await submitCommitteeSignature({
      authorizationId: authorization.id,
      signature: sigA,
      callerWallet: SIGNER_A.address,
      publicClient: baseClient as any,
      authRepo,
    });
    assert.equal(idempotentSub.signatureRow.id, firstSub.signatureRow.id);

    // Re-submission of DIFFERENT signature by same signer -> REJECTED
    const fakeDiffSig = ('0x' + 'f'.repeat(130)) as any;
    await assert.rejects(
      () => submitCommitteeSignature({
        authorizationId: authorization.id,
        signature: fakeDiffSig,
        callerWallet: SIGNER_A.address,
        publicClient: baseClient as any,
        authRepo,
      }),
      /has already submitted an immutable signature/
    );

    // Verify stored signature unchanged
    const sigsAfterReject = await authRepo.getSignaturesByAuthId(authorization.id);
    assert.equal(sigsAfterReject.length, 1);
    assert.equal(sigsAfterReject[0].signature.toLowerCase(), sigA.toLowerCase());

    // Signer B signs -> threshold reached
    const sigB = await SIGNER_B.signTypedData(typedData as any);
    const secondSub = await submitCommitteeSignature({
      authorizationId: authorization.id,
      signature: sigB,
      callerWallet: SIGNER_B.address,
      publicClient: baseClient as any,
      authRepo,
    });
    assert.equal(secondSub.thresholdReady, true);

    // Baseline bundle retrieval succeeds
    const validBundle = await getVerifiedThresholdBundle({
      authorizationId: authorization.id,
      callerWallet: SIGNER_A.address,
      publicClient: baseClient as any,
      authRepo,
      reportRepo,
    });
    assert.equal(validBundle.signers.length, 2);
    assert.equal(validBundle.signatures.length, 2);

    // 2. Canonical getBlock fails -> FAIL CLOSED (no wall clock)
    const failingBlockClient = createMockClient({ getBlockFails: true });
    await assert.rejects(
      () => getVerifiedThresholdBundle({
        authorizationId: authorization.id,
        callerWallet: SIGNER_A.address,
        publicClient: failingBlockClient as any,
        authRepo,
      }),
      /Failed to query canonical chain block timestamp/
    );

    // 3. Exact Expiry Boundary:
    // At validUntil: SUCCEEDS
    const boundaryClient = createMockClient({ blockTimestamp: BigInt(authorization.validUntil) });
    const boundaryBundle = await getVerifiedThresholdBundle({
      authorizationId: authorization.id,
      callerWallet: SIGNER_A.address,
      publicClient: boundaryClient as any,
      authRepo,
    });
    assert.equal(boundaryBundle.signers.length, 2);

    // At validUntil + 1: REJECTS / EXPIRED
    const expiredClient = createMockClient({ blockTimestamp: BigInt(authorization.validUntil) + 1n });
    await assert.rejects(
      () => getVerifiedThresholdBundle({
        authorizationId: authorization.id,
        callerWallet: SIGNER_A.address,
        publicClient: expiredClient as any,
        authRepo,
      }),
      /Authorization expired on-chain/
    );

    // 4. Committee Epoch Race:
    const rotatedEpochClient = createMockClient({ epoch: 1n });
    await assert.rejects(
      () => getVerifiedThresholdBundle({
        authorizationId: authorization.id,
        callerWallet: SIGNER_A.address,
        publicClient: rotatedEpochClient as any,
        authRepo,
      }),
      /Committee epoch changed on-chain/
    );

    // 5. Signer Rotation Race:
    // Signer B rotates out (isSigner = false)
    const signerBRotatedClient = createMockClient({ isSignerB: false });
    await assert.rejects(
      () => getVerifiedThresholdBundle({
        authorizationId: authorization.id,
        callerWallet: SIGNER_A.address,
        publicClient: signerBRotatedClient as any,
        authRepo,
      }),
      /Threshold not reached: only 1 \/ 2 valid active signatures available/
    );

    // 6. Nonce Race:
    const nonceUsedClient = createMockClient({ nonceUsed: true });
    await assert.rejects(
      () => getVerifiedThresholdBundle({
        authorizationId: authorization.id,
        callerWallet: SIGNER_A.address,
        publicClient: nonceUsedClient as any,
        authRepo,
      }),
      /Resolution nonce .* has already been used on-chain/
    );

    // 7. State Race (INITIAL):
    const stateRacedClient = createMockClient({ milestoneStatus: MilestoneStatus.SettledPaid });
    await assert.rejects(
      () => getVerifiedThresholdBundle({
        authorizationId: authorization.id,
        callerWallet: SIGNER_A.address,
        publicClient: stateRacedClient as any,
        authRepo,
      }),
      /Milestone is no longer in Disputed status/
    );

    // 8. INITIAL 14-Day Boundary Race:
    // Create an authorization shortly before the 14-day boundary:
    const shortlyBefore14d = disputeOpenedAt + 14n * 86400n - 3600n; // 1 hour before 14-day boundary
    const clientBefore14d = createMockClient({ blockTimestamp: shortlyBefore14d });
    const { authorization: authNear14d, typedData: typedDataNear14d } = await createCommitteeAuthorization({
      reportId: initialReport.id,
      callerWallet: SIGNER_A.address,
      publicClient: clientBefore14d as any,
      authRepo,
      reportRepo,
    });

    const sigNearA = await SIGNER_A.signTypedData(typedDataNear14d as any);
    const sigNearB = await SIGNER_B.signTypedData(typedDataNear14d as any);
    await submitCommitteeSignature({
      authorizationId: authNear14d.id,
      signature: sigNearA,
      callerWallet: SIGNER_A.address,
      publicClient: clientBefore14d as any,
      authRepo,
    });
    await submitCommitteeSignature({
      authorizationId: authNear14d.id,
      signature: sigNearB,
      callerWallet: SIGNER_B.address,
      publicClient: clientBefore14d as any,
      authRepo,
    });

    // Time advances to exactly disputeOpenedAt + 14 days (boundary reached):
    // Auth is NOT expired (chainTimestamp << validUntil), but primary authority has expired!
    const fourteenDaysClient = createMockClient({
      blockTimestamp: disputeOpenedAt + 14n * 86400n,
    });
    await assert.rejects(
      () => getVerifiedThresholdBundle({
        authorizationId: authNear14d.id,
        callerWallet: SIGNER_A.address,
        publicClient: fourteenDaysClient as any,
        authRepo,
      }),
      /Initial resolution committee authority expired or switched at 14-day dispute boundary/
    );

    // 9. FINAL Resolver Stability (Does NOT switch at 14 days):
    const finalReport = createBaseReportRow('FINAL_RESOLUTION');
    finalReport.id = 'rep-final-stability';
    await reportRepo.create(finalReport);

    const finalClient = createMockClient({
      milestoneStatus: MilestoneStatus.FinalReview,
      blockTimestamp: disputeOpenedAt + 30n * 86400n, // 30 days after dispute opened!
      storedProposalResolver: TEST_PRIMARY_COMMITTEE,
    });

    const { authorization: finalAuth, typedData: finalTypedData } = await createCommitteeAuthorization({
      reportId: finalReport.id,
      callerWallet: SIGNER_A.address,
      publicClient: finalClient as any,
      authRepo,
      reportRepo,
    });

    const finalSigA = await SIGNER_A.signTypedData(finalTypedData as any);
    const finalSigB = await SIGNER_B.signTypedData(finalTypedData as any);

    await submitCommitteeSignature({
      authorizationId: finalAuth.id,
      signature: finalSigA,
      callerWallet: SIGNER_A.address,
      publicClient: finalClient as any,
      authRepo,
    });
    await submitCommitteeSignature({
      authorizationId: finalAuth.id,
      signature: finalSigB,
      callerWallet: SIGNER_B.address,
      publicClient: finalClient as any,
      authRepo,
    });

    // FINAL bundle succeeds even at 30 days because it stays bound to stored resolver!
    const finalBundle = await getVerifiedThresholdBundle({
      authorizationId: finalAuth.id,
      callerWallet: SIGNER_A.address,
      publicClient: finalClient as any,
      authRepo,
      reportRepo,
    });
    assert.equal(finalBundle.committeeAddress, TEST_PRIMARY_COMMITTEE);
    assert.equal(finalBundle.signers.length, 2);

    // 10. Stored Typed Data / Digest Corruption:
    const corruptedTypedDataAuth = {
      ...authorization,
      id: 'corrupted-typed-data-auth',
      typedData: {
        ...(authorization.typedData as any),
        message: {
          ...(authorization.typedData as any).message,
          freelancerAmount: 999999999n, // Tampered message!
        },
      },
    };
    await authRepo.createAuth(corruptedTypedDataAuth);
    // Copy signatures to corrupted auth
    await authRepo.createSignature({
      authorizationId: corruptedTypedDataAuth.id,
      signerWallet: SIGNER_A.address.toLowerCase(),
      signature: sigA,
      createdAt: new Date(),
    });
    await authRepo.createSignature({
      authorizationId: corruptedTypedDataAuth.id,
      signerWallet: SIGNER_B.address.toLowerCase(),
      signature: sigB,
      createdAt: new Date(),
    });

    await assert.rejects(
      () => getVerifiedThresholdBundle({
        authorizationId: corruptedTypedDataAuth.id,
        callerWallet: SIGNER_A.address,
        publicClient: baseClient as any,
        authRepo,
      }),
      /Stored typed_data does not match stored typed_data_hash/
    );

    // 11. Stored Signature Cryptographic Corruption:
    const corruptedSigAuth = {
      ...authorization,
      id: 'corrupted-sig-auth',
    };
    await authRepo.createAuth(corruptedSigAuth);
    await authRepo.createSignature({
      authorizationId: corruptedSigAuth.id,
      signerWallet: SIGNER_A.address.toLowerCase(),
      signature: sigA,
      createdAt: new Date(),
    });
    await authRepo.createSignature({
      authorizationId: corruptedSigAuth.id,
      signerWallet: SIGNER_B.address.toLowerCase(),
      signature: ('0x' + '9'.repeat(130)) as any, // Invalid corrupted signature!
      createdAt: new Date(),
    });

    await assert.rejects(
      () => getVerifiedThresholdBundle({
        authorizationId: corruptedSigAuth.id,
        callerWallet: SIGNER_A.address,
        publicClient: baseClient as any,
        authRepo,
      }),
      /failed cryptographic reverification/
    );
  });
});
