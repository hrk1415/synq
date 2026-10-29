import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import {
  HISTORICAL_RECOVERY_TARGET,
  executeHistoricalAuthorizationRecovery,
  isAuthorizedAdminForHistoricalRecovery,
  verifyHistoricalAuthorizationSignatures,
  verifyCommitteeResolutionProposalCalldata,
  HistoricalRecoveryTargetError,
  HistoricalRecoveryAdminError,
  HistoricalRecoveryIntegrityError,
  HistoricalRecoveryOnChainError,
  HistoricalRecoveryInconsistentStateError,
  type IHistoricalRecoveryDbRepository,
} from '../src/lib/deals/historical-recovery';
import { MilestoneStatus } from '../src/lib/deals/v2-deal';
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters, hashTypedData, encodeFunctionData } from 'viem';
import { synqDealV1ABI, synqResolutionCommitteeABI } from '../src/lib/contracts/abis';
import {
  getResolutionProposalTypedData,
  type ResolutionProposalAuthData,
} from '../src/lib/deals/v2-committee-auth';
import {
  hashResolutionReport,
  type CanonicalResolutionReportV1,
} from '../src/lib/deals/v2-resolution-report';

const target = HISTORICAL_RECOVERY_TARGET;

// Standard mock committee signers
const SIGNER_A = privateKeyToAccount('0x1111111111111111111111111111111111111111111111111111111111111111');
const SIGNER_B = privateKeyToAccount('0x2222222222222222222222222222222222222222222222222222222222222222');
const UNAUTHORIZED_SIGNER = privateKeyToAccount('0x3333333333333333333333333333333333333333333333333333333333333333');

// Helper to create mock on-chain receipt with both Committee and Deal logs
function createMockReceipt(params?: {
  status?: 'success' | 'reverted';
  to?: string;
  contractAddress?: string; // deal address for Deal log
  committeeAddress?: string; // committee address for Committee log
  resolverAddress?: string;
  dealAddressArg?: string;
  omitLog?: boolean;
  omitCommitteeLog?: boolean;
  omitDealLog?: boolean;
  blockNumber?: bigint;
  resolutionNonce?: bigint;
  justificationHash?: string;
  freelancerAmount?: bigint;
  clientAmount?: bigint;
  reconsiderationDeadline?: bigint;
}) {
  const status = params?.status ?? 'success';
  const to = params?.to ?? target.committeeAddress;
  const blockNumber = params?.blockNumber ?? 6950000n;

  if (params?.omitLog) {
    return {
      status,
      to,
      blockNumber,
      logs: [],
    };
  }

  const dealAddressArg = params?.dealAddressArg ?? target.dealAddress;
  const dealLogAddress = params?.contractAddress ?? target.dealAddress;
  const committeeAddress = params?.committeeAddress ?? target.committeeAddress;
  const resolver = params?.resolverAddress ?? target.committeeAddress;
  const nonce = params?.resolutionNonce ?? BigInt(target.resolutionNonce);
  const justHash = params?.justificationHash ?? target.justificationHash;
  const flAmount = params?.freelancerAmount ?? BigInt(target.freelancerAmount);
  const clAmount = params?.clientAmount ?? BigInt(target.clientAmount);

  const logs: any[] = [];

  // 1. Committee event: ResolutionProposalSubmitted(deal, milestoneId, flAmount, clAmount, justHash, resolutionNonce)
  if (!params?.omitCommitteeLog) {
    const committeeTopics = encodeEventTopics({
      abi: synqResolutionCommitteeABI,
      eventName: 'ResolutionProposalSubmitted',
      args: {
        deal: dealAddressArg as `0x${string}`,
        milestoneId: BigInt(target.milestoneId),
      },
    });

    const committeeData = encodeAbiParameters(
      parseAbiParameters('uint256 freelancerAmount, uint256 clientAmount, bytes32 justificationHash, uint64 resolutionNonce'),
      [
        flAmount,
        clAmount,
        justHash as `0x${string}`,
        nonce,
      ]
    );

    logs.push({
      address: committeeAddress,
      topics: committeeTopics,
      data: committeeData,
    });
  }

  // 2. Deal event: ResolutionProposed(milestoneId, resolver, flAmount, clAmount, justHash, reconsiderationDeadline)
  if (!params?.omitDealLog) {
    const dealTopics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'ResolutionProposed',
      args: {
        milestoneId: BigInt(target.milestoneId),
        resolver: resolver as `0x${string}`,
      },
    });

    const dealData = encodeAbiParameters(
      parseAbiParameters('uint256 freelancerAmount, uint256 clientAmount, bytes32 justificationHash, uint64 reconsiderationDeadline'),
      [
        flAmount,
        clAmount,
        justHash as `0x${string}`,
        params?.reconsiderationDeadline ?? 1730000000n,
      ]
    );

    logs.push({
      address: dealLogAddress,
      topics: dealTopics,
      data: dealData,
    });
  }

  return {
    status,
    to,
    blockNumber,
    logs,
  };
}

// Canonical 20/5 draft report matching target.boundReportJustificationHash ('0x10a0f9dd4b9c57e8f1bbc6c408b580376e6e57067eb976b529a2d3f58b4cd153')
function createValidCanonical20_5Report(): CanonicalResolutionReportV1 {
  return {
    schemaVersion: 1,
    phase: 'INITIAL_RESOLUTION',
    chainId: 11155111,
    dealAddress: target.dealAddress as `0x${string}`,
    milestoneId: 0,
    submissionVersion: 2,
    specHash: '0x9e72259dd6e1b13cd2c094fbb1cadfdcda59a49648e055962122e8d7663b9e3e',
    evidenceRootHash: '0x8d5a305b96060655ba48842763393901ceb0be123ad5ea69019f44019b4fc328',
    committeeAddress: target.committeeAddress as `0x${string}`,
    freelancerAmount: '20000000',
    clientAmount: '5000000',
    summary: 'fair  solutio n',
    findings: 'fair  solutio n',
    justification: 'fair  solutio n',
  };
}

let cachedValidSignatures: { signerWallet: string; signature: string }[] = [];

function createMockTransaction(params?: {
  to?: string;
  authArg?: any;
  sig1?: `0x${string}`;
  sig2?: `0x${string}`;
  input?: `0x${string}`;
  signatures?: { signature: string }[];
}) {
  const to = params?.to ?? target.committeeAddress;
  if (params?.input !== undefined) {
    return { to, input: params.input };
  }
  const authArg = params?.authArg ?? {
    committee: target.committeeAddress as `0x${string}`,
    chainId: BigInt(target.chainId),
    deal: target.dealAddress as `0x${string}`,
    milestoneId: BigInt(target.milestoneId),
    freelancerAmount: BigInt(target.freelancerAmount),
    clientAmount: BigInt(target.clientAmount),
    justificationHash: target.justificationHash as `0x${string}`,
    resolutionNonce: BigInt(target.resolutionNonce),
    validUntil: 1730000000n,
    evidenceRootHash: '0x8d5a305b96060655ba48842763393901ceb0be123ad5ea69019f44019b4fc328' as `0x${string}`,
    specHash: '0x9e72259dd6e1b13cd2c094fbb1cadfdcda59a49648e055962122e8d7663b9e3e' as `0x${string}`,
    submissionVersion: 1,
  };
  const sigs = params?.signatures ?? cachedValidSignatures;
  const sig1 = params?.sig1 ?? (sigs[0]?.signature as `0x${string}` | undefined) ?? ('0x1111' as `0x${string}`);
  const sig2 = params?.sig2 ?? (sigs[1]?.signature as `0x${string}` | undefined) ?? ('0x2222' as `0x${string}`);

  const input = encodeFunctionData({
    abi: synqResolutionCommitteeABI,
    functionName: 'submitResolutionProposal',
    args: [authArg, sig1, sig2],
  });

  return { to, input };
}

// Helper to create mock public client
function createMockClient(overrides?: {
  receipt?: any;
  transaction?: any;
  omitGetTransaction?: boolean;
  milestoneStatus?: number;
  milestoneFormat?: 'struct' | 'tuple';
  isNonceUsed?: boolean;
  onChainProposal?: readonly [
    freelancerAmount: bigint,
    clientAmount: bigint,
    justificationHash: `0x${string}`,
    proposedAt: bigint,
    reconsiderationDeadline: bigint,
    resolver: `0x${string}`,
  ];
  authorizedSigners?: string[];
  historicalAuthorizedSigners?: string[];
  preBlockAuthorizedSigners?: string[];
  historicalThreshold?: bigint;
  simulateHistoricalStateUnavailable?: boolean;
  chainId?: number;
}) {
  const receipt = overrides?.receipt !== undefined ? overrides.receipt : createMockReceipt();
  const tx = overrides?.transaction !== undefined
    ? overrides.transaction
    : createMockTransaction();
  const milestoneStatus = overrides?.milestoneStatus ?? MilestoneStatus.ResolutionProposed; // 5
  const isNonceUsed = overrides?.isNonceUsed !== undefined ? overrides.isNonceUsed : true;
  const onChainProposal = overrides?.onChainProposal ?? [
    BigInt(target.freelancerAmount),
    BigInt(target.clientAmount),
    target.justificationHash as `0x${string}`,
    1000000n, // proposedAt
    1000000n + 86400n, // reconsiderationDeadline
    target.committeeAddress as `0x${string}`,
  ];

  const authorizedSigners = (
    overrides?.authorizedSigners ?? [
      SIGNER_A.address.toLowerCase(),
      SIGNER_B.address.toLowerCase(),
    ]
  ).map((s) => s.toLowerCase());

  const historicalSigners = (
    overrides?.historicalAuthorizedSigners ?? authorizedSigners
  ).map((s) => s.toLowerCase());

  const preBlockSigners = overrides?.preBlockAuthorizedSigners
    ? overrides.preBlockAuthorizedSigners.map((s) => s.toLowerCase())
    : historicalSigners;

  const historicalThreshold = overrides?.historicalThreshold ?? 2n;
  const clientChainId = overrides?.chainId ?? target.chainId;

  return {
    getChainId: async () => clientChainId,
    getTransactionReceipt: async (args: { hash: string }) => {
      if (args.hash.toLowerCase() === target.executionTxHash.toLowerCase()) {
        return receipt;
      }
      return null;
    },
    ...(overrides?.omitGetTransaction
      ? {}
      : {
          getTransaction: async (args: { hash: string }) => {
            if (overrides?.transaction === null) return null;
            if (overrides?.transaction === 'throw') {
              throw new Error('RPC network error: transaction unavailable');
            }
            if (args.hash.toLowerCase() === target.executionTxHash.toLowerCase()) {
              return tx;
            }
            return null;
          },
        }),
    readContract: async (args: { address: string; functionName: string; args?: any[]; blockNumber?: bigint }) => {
      if (args.functionName === 'resolutionProposals') {
        return onChainProposal;
      }
      if (args.functionName === 'getMilestone') {
        if (overrides?.milestoneFormat === 'tuple') {
          return [
            25000000n,
            1000000n,
            86400n,
            86400n,
            milestoneStatus,
            '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`,
            '0x0000000000000000000000000000000000000000000000000000000000000002' as `0x${string}`,
            900000n,
            1,
          ];
        }
        return {
          amount: 25000000n,
          workDeadline: 1000000n,
          reviewWindow: 86400n,
          gracePeriod: 86400n,
          status: milestoneStatus,
          specHash: '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`,
          evidenceRootHash: '0x0000000000000000000000000000000000000000000000000000000000000002' as `0x${string}`,
          submittedAt: 900000n,
          version: 1,
        };
      }
      if (args.functionName === 'usedProposalNonces') {
        return isNonceUsed;
      }
      if (args.functionName === 'THRESHOLD') {
        if (overrides?.simulateHistoricalStateUnavailable && args.blockNumber !== undefined) {
          throw new Error('Historical state unavailable: block state pruned on archive node');
        }
        return historicalThreshold;
      }
      if (args.functionName === 'isSigner') {
        if (overrides?.simulateHistoricalStateUnavailable && args.blockNumber !== undefined) {
          throw new Error('Historical state unavailable: block state pruned on archive node');
        }
        const querySigner = String(args.args?.[0] || '').toLowerCase();
        if (args.blockNumber !== undefined) {
          if (args.blockNumber === 6950000n - 1n) {
            return preBlockSigners.includes(querySigner);
          }
          return historicalSigners.includes(querySigner);
        }
        return authorizedSigners.includes(querySigner);
      }
      if (args.functionName === 'getSigners') {
        return authorizedSigners;
      }
      if (args.functionName === 'dealData') {
        return {
          client: '0x1111111111111111111111111111111111111111',
          freelancer: '0x2222222222222222222222222222222222222222',
        };
      }
      return null;
    },
  };
}

// In-memory mock DB repository faithfully implementing all transaction boundary rules
class MockHistoricalRecoveryRepository implements IHistoricalRecoveryDbRepository {
  public authState: any;
  public reportState: any;
  public auditState: any = null;
  public signatures: { signerWallet: string; signature: string }[] = [];
  public lockOrder: string[] = [];
  public simulateAuditInsertFailure = false;

  constructor(signatures?: { signerWallet: string; signature: string }[]) {
    const validReport = createValidCanonical20_5Report();
    this.reportState = {
      id: target.boundReportId,
      chainId: target.chainId,
      dealAddress: target.dealAddress,
      milestoneId: target.milestoneId,
      phase: target.phase,
      freelancerAmount: target.boundReportFreelancerAmount,
      clientAmount: target.boundReportClientAmount,
      justificationHash: target.boundReportJustificationHash,
      canonicalReport: validReport,
      status: 'staged',
      txHash: null,
    };

    // Typed data for 25/0 authorization
    const authData: ResolutionProposalAuthData = {
      committee: target.committeeAddress as `0x${string}`,
      chainId: BigInt(target.chainId),
      deal: target.dealAddress as `0x${string}`,
      milestoneId: BigInt(target.milestoneId),
      freelancerAmount: BigInt(target.freelancerAmount),
      clientAmount: BigInt(target.clientAmount),
      justificationHash: target.justificationHash as `0x${string}`,
      resolutionNonce: BigInt(target.resolutionNonce),
      validUntil: 1730000000n,
      evidenceRootHash: '0x8d5a305b96060655ba48842763393901ceb0be123ad5ea69019f44019b4fc328' as `0x${string}`,
      specHash: '0x9e72259dd6e1b13cd2c094fbb1cadfdcda59a49648e055962122e8d7663b9e3e' as `0x${string}`,
      submissionVersion: 1,
    };

    const typedData = getResolutionProposalTypedData(authData);
    const typedDataHash = hashTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    }).toLowerCase();

    this.authState = {
      id: target.authorizationId,
      reportId: target.boundReportId,
      chainId: target.chainId,
      dealAddress: target.dealAddress,
      milestoneId: target.milestoneId,
      phase: target.phase,
      committeeAddress: target.committeeAddress,
      freelancerAmount: target.freelancerAmount,
      clientAmount: target.clientAmount,
      resolutionNonce: target.resolutionNonce,
      justificationHash: target.justificationHash,
      typedData,
      typedDataHash,
      status: 'threshold_ready',
      executionTxHash: null,
      executedByWallet: null,
      executedAt: null,
    };

    this.signatures = signatures ?? [];
  }

  async executeRecoveryTransaction(params: {
    target: typeof HISTORICAL_RECOVERY_TARGET;
    callerWallet: string;
    onChainBlockTimestamp: Date;
    historicalBlockNumber: bigint;
    publicClient: any;
    submittedSignatures?: [`0x${string}`, `0x${string}`];
  }) {
    // 1. Lock Report row FIRST
    this.lockOrder.push('report_lock');
    const boundReport = this.reportState;

    if (!boundReport) {
      throw new HistoricalRecoveryIntegrityError(`Bound report ${params.target.boundReportId} not found`);
    }

    if (
      boundReport.id !== params.target.boundReportId ||
      boundReport.chainId !== params.target.chainId ||
      boundReport.dealAddress.toLowerCase() !== params.target.dealAddress ||
      boundReport.milestoneId !== params.target.milestoneId ||
      boundReport.phase !== params.target.phase ||
      boundReport.status !== 'staged' ||
      boundReport.txHash !== null ||
      boundReport.freelancerAmount !== params.target.boundReportFreelancerAmount ||
      boundReport.clientAmount !== params.target.boundReportClientAmount ||
      boundReport.justificationHash.toLowerCase() !== params.target.boundReportJustificationHash
    ) {
      throw new HistoricalRecoveryIntegrityError(
        `Bound report violates expected target tuple. Database corruption or mismatch detected.`
      );
    }

    // Cryptographic report hash verification
    const computedReportHash = hashResolutionReport(boundReport.canonicalReport as CanonicalResolutionReportV1);
    if (computedReportHash.toLowerCase() !== boundReport.justificationHash.toLowerCase()) {
      throw new HistoricalRecoveryIntegrityError(
        `Bound report canonical JSON hash mismatch: stored ${boundReport.justificationHash}, computed ${computedReportHash}`
      );
    }

    // 2. Lock Authorization row SECOND
    this.lockOrder.push('auth_lock');
    const auth = this.authState;

    if (!auth) {
      throw new HistoricalRecoveryIntegrityError(`Authorization ${params.target.authorizationId} not found`);
    }

    if (
      auth.id !== params.target.authorizationId ||
      auth.reportId !== params.target.boundReportId ||
      auth.chainId !== params.target.chainId ||
      auth.dealAddress.toLowerCase() !== params.target.dealAddress ||
      auth.milestoneId !== params.target.milestoneId ||
      auth.phase !== params.target.phase ||
      auth.committeeAddress.toLowerCase() !== params.target.committeeAddress ||
      auth.freelancerAmount !== params.target.freelancerAmount ||
      auth.clientAmount !== params.target.clientAmount ||
      auth.resolutionNonce.toString() !== params.target.resolutionNonce ||
      auth.justificationHash.toLowerCase() !== params.target.justificationHash
    ) {
      throw new HistoricalRecoveryIntegrityError(
        `Authorization violates expected target tuple. Database corruption or mismatch detected.`
      );
    }

    // 3. Idempotency and Inconsistent State Handling
    if (auth.status === 'executed') {
      if (auth.executionTxHash?.toLowerCase() !== params.target.executionTxHash.toLowerCase()) {
        throw new HistoricalRecoveryInconsistentStateError(
          `Authorization is executed with unexpected transaction ${auth.executionTxHash}; expected ${params.target.executionTxHash}`
        );
      }
      if (!this.auditState) {
        throw new HistoricalRecoveryInconsistentStateError(
          `Authorization is marked executed, but matching historical audit record is absent. Inconsistent state requires manual review.`
        );
      }
      if (
        this.auditState.onChainTxHash.toLowerCase() !== params.target.executionTxHash.toLowerCase() ||
        this.auditState.onChainJustificationHash.toLowerCase() !== params.target.justificationHash.toLowerCase()
      ) {
        throw new HistoricalRecoveryInconsistentStateError(
          `Historical reconciliation audit is inconsistent with target parameters. Manual review required.`
        );
      }

      return {
        isIdempotentNoop: true,
        authorization: auth,
        boundReport,
        auditRecord: this.auditState,
      };
    }

    // If threshold_ready, verify there is no orphaned audit record
    if (this.auditState) {
      throw new HistoricalRecoveryInconsistentStateError(
        `Found orphaned historical audit for unexecuted authorization. Inconsistent state requires manual review.`
      );
    }

    if (auth.status !== 'threshold_ready') {
      throw new HistoricalRecoveryIntegrityError(
        `Cannot recover authorization in status '${auth.status}'; expected 'threshold_ready'`
      );
    }

    // 4. Cryptographic Authorization Signature Verification
    const sigCheck = await verifyHistoricalAuthorizationSignatures({
      auth,
      signatures: this.signatures,
      client: params.publicClient,
      historicalBlockNumber: params.historicalBlockNumber,
      submittedSignatures: params.submittedSignatures,
    });

    if (!sigCheck.valid) {
      throw new HistoricalRecoveryIntegrityError(
        `Cryptographic authorization verification failed: ${sigCheck.error}`
      );
    }

    // 5. Simulate audit insert failure (testing rollback)
    if (this.simulateAuditInsertFailure) {
      throw new Error('Database transaction error: audit table insertion simulated failure');
    }

    // 6. Update authorization
    this.authState.status = 'executed';
    this.authState.executionTxHash = params.target.executionTxHash.toLowerCase();
    this.authState.executedByWallet = params.callerWallet.toLowerCase();
    this.authState.executedAt = params.onChainBlockTimestamp;

    // 7. Insert audit record with explicit notification suppression
    this.auditState = {
      id: 'mock-audit-uuid',
      chainId: params.target.chainId,
      dealAddress: params.target.dealAddress,
      milestoneId: params.target.milestoneId,
      phase: params.target.phase,
      authorizationId: params.target.authorizationId,
      boundReportId: params.target.boundReportId,
      onChainTxHash: params.target.executionTxHash,
      onChainJustificationHash: params.target.justificationHash,
      boundReportJustificationHash: boundReport.justificationHash,
      recoveredByWallet: params.callerWallet.toLowerCase(),
      narrativeAuditStatus: 'unrecoverable_offchain_hash_committed',
      notificationStatus: 'suppressed_historical_sync',
      notificationSuppressionReason: 'historical_synchronization_notification_suppressed',
      recoveredAt: new Date(),
    };

    return {
      isIdempotentNoop: false,
      authorization: this.authState,
      boundReport,
      auditRecord: this.auditState,
    };
  }
}

// Generates real cryptographic signatures using viem's privateKeyToAccount
async function generateValidSignatures(authData: ResolutionProposalAuthData) {
  const typedData = getResolutionProposalTypedData(authData);
  const sigA = await SIGNER_A.signTypedData(typedData as any);
  const sigB = await SIGNER_B.signTypedData(typedData as any);
  return [
    { signerWallet: SIGNER_A.address.toLowerCase(), signature: sigA },
    { signerWallet: SIGNER_B.address.toLowerCase(), signature: sigB },
  ];
}

test('SYNQ Historical Recovery Safety & Security Audit Suite', async (t) => {
  const adminWallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const nonAdminSigner = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const deployerWallet = '0xD2D4d415a4730b1490c9Ce27944529B83ff76319'.toLowerCase();

  process.env.SYNQ_ADMIN_RECOVERY_WALLETS = adminWallet;

  // Base auth data for generating signatures
  const baseAuthData: ResolutionProposalAuthData = {
    committee: target.committeeAddress as `0x${string}`,
    chainId: BigInt(target.chainId),
    deal: target.dealAddress as `0x${string}`,
    milestoneId: BigInt(target.milestoneId),
    freelancerAmount: BigInt(target.freelancerAmount),
    clientAmount: BigInt(target.clientAmount),
    justificationHash: target.justificationHash as `0x${string}`,
    resolutionNonce: BigInt(target.resolutionNonce),
    validUntil: 1730000000n,
    evidenceRootHash: '0x8d5a305b96060655ba48842763393901ceb0be123ad5ea69019f44019b4fc328' as `0x${string}`,
    specHash: '0x9e72259dd6e1b13cd2c094fbb1cadfdcda59a49648e055962122e8d7663b9e3e' as `0x${string}`,
    submissionVersion: 1,
  };

  const validSignatures = await generateValidSignatures(baseAuthData);
  cachedValidSignatures = validSignatures;

  await t.test('1. Target allowlisting rejects mismatch on deal, milestone, auth, or txHash', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);
    const publicClient = createMockClient() as any;

    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: '0x9999999999999999999999999999999999999999',
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient,
          dbRepo,
        });
      },
      HistoricalRecoveryTargetError
    );

    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 99,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient,
          dbRepo,
        });
      },
      HistoricalRecoveryTargetError
    );
  });

  await t.test('2. Exceptional administrator authorization: strictly requires SYNQ_ADMIN_RECOVERY_WALLETS allowlist', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);
    const publicClient = createMockClient() as any;

    // A. Unauthorized signer rejected
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: nonAdminSigner,
          publicClient,
          dbRepo,
        });
      },
      HistoricalRecoveryAdminError
    );

    // B. Deployer fallback removed: deployer rejected if not in allowlist
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: deployerWallet,
          publicClient,
          dbRepo,
        });
      },
      HistoricalRecoveryAdminError
    );

    // C. Missing/empty allowlist fails closed
    const prevEnv = process.env.SYNQ_ADMIN_RECOVERY_WALLETS;
    delete process.env.SYNQ_ADMIN_RECOVERY_WALLETS;
    assert.equal(await isAuthorizedAdminForHistoricalRecovery(adminWallet), false);
    process.env.SYNQ_ADMIN_RECOVERY_WALLETS = '   ';
    assert.equal(await isAuthorizedAdminForHistoricalRecovery(adminWallet), false);
    process.env.SYNQ_ADMIN_RECOVERY_WALLETS = prevEnv;
  });

  await t.test('3. Receipt verification rejects reverted tx, deal destination, wrong committee, missing events, or mismatched params', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);

    // Reverted receipt
    const revertedClient = createMockClient({ receipt: createMockReceipt({ status: 'reverted' }) }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: revertedClient,
          dbRepo,
        });
      },
      HistoricalRecoveryOnChainError
    );

    // Wrong destination: to equals deal address instead of committee address
    const dealDestClient = createMockClient({
      receipt: createMockReceipt({ to: target.dealAddress }),
    }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: dealDestClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/does not match expected committeeAddress/.test(err.message));
        return true;
      }
    );

    // Wrong destination: arbitrary address
    const wrongDestClient = createMockClient({
      receipt: createMockReceipt({ to: '0x9999999999999999999999999999999999999999' }),
    }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: wrongDestClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/does not match expected committeeAddress/.test(err.message));
        return true;
      }
    );

    // Missing Committee event (ResolutionProposalSubmitted missing)
    const missingCommitteeLogClient = createMockClient({
      receipt: createMockReceipt({ omitCommitteeLog: true }),
    }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: missingCommitteeLogClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/ResolutionProposalSubmitted event not found/.test(err.message));
        return true;
      }
    );

    // Missing Deal event (ResolutionProposed missing)
    const missingDealLogClient = createMockClient({
      receipt: createMockReceipt({ omitDealLog: true }),
    }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: missingDealLogClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/ResolutionProposed event not found/.test(err.message));
        return true;
      }
    );

    // Wrong Committee event emitter
    const wrongCommitteeEmitterClient = createMockClient({
      receipt: createMockReceipt({ committeeAddress: '0x8888888888888888888888888888888888888888' }),
    }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: wrongCommitteeEmitterClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/ResolutionProposalSubmitted event not found/.test(err.message));
        return true;
      }
    );

    // Wrong Deal event emitter
    const wrongDealEmitterClient = createMockClient({
      receipt: createMockReceipt({ contractAddress: '0x8888888888888888888888888888888888888888' }),
    }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: wrongDealEmitterClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/ResolutionProposed event not found/.test(err.message));
        return true;
      }
    );

    // Incorrect resolution nonce in committee event log (nonce 2 instead of 1)
    const wrongNonceClient = createMockClient({
      receipt: createMockReceipt({ resolutionNonce: 2n }),
    }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: wrongNonceClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/resolutionNonce mismatch/.test(err.message));
        return true;
      }
    );

    // Incorrect justification hash in event log
    const wrongHashClient = createMockClient({
      receipt: createMockReceipt({ justificationHash: '0x0000000000000000000000000000000000000000000000000000000000000000' }),
    }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: wrongHashClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/justificationHash mismatch/.test(err.message));
        return true;
      }
    );

    // Mismatched event amounts (e.g. 20M / 5M instead of 25M / 0)
    const wrongAmountsClient = createMockClient({
      receipt: createMockReceipt({ freelancerAmount: 20000000n, clientAmount: 5000000n }),
    }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: wrongAmountsClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/Amount mismatch/.test(err.message));
        return true;
      }
    );

    // Event log emitted with wrong resolver
    const wrongResolverClient = createMockClient({
      receipt: createMockReceipt({ resolverAddress: '0x7777777777777777777777777777777777777777' }),
    }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: wrongResolverClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/resolver mismatch/.test(err.message));
        return true;
      }
    );
  });

  await t.test('4. On-chain state asserts unconsumed nonce permanence and proposal state', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);

    // Unconsumed nonce
    const unconsumedNonceClient = createMockClient({ isNonceUsed: false }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: unconsumedNonceClient,
          dbRepo,
        });
      },
      HistoricalRecoveryOnChainError
    );

    // Mismatched on-chain resolution proposal amounts
    const wrongProposalClient = createMockClient({
      onChainProposal: [
        20000000n,
        5000000n,
        target.justificationHash as `0x${string}`,
        1000000n,
        1000000n + 86400n,
        target.committeeAddress as `0x${string}`,
      ],
    }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: wrongProposalClient,
          dbRepo,
        });
      },
      HistoricalRecoveryOnChainError
    );

    // Mismatched on-chain resolution proposal justification hash (index [2])
    const wrongHashClient = createMockClient({
      onChainProposal: [
        BigInt(target.freelancerAmount),
        BigInt(target.clientAmount),
        '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
        1000000n,
        1000000n + 86400n,
        target.committeeAddress as `0x${string}`,
      ],
    }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: wrongHashClient,
          dbRepo,
        });
      },
      HistoricalRecoveryOnChainError
    );

    // Mismatched on-chain resolution proposal resolver (index [5])
    const wrongResolverClient = createMockClient({
      onChainProposal: [
        BigInt(target.freelancerAmount),
        BigInt(target.clientAmount),
        target.justificationHash as `0x${string}`,
        1000000n,
        1000000n + 86400n,
        '0x0000000000000000000000000000000000000001' as `0x${string}`,
      ],
    }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: wrongResolverClient,
          dbRepo,
        });
      },
      HistoricalRecoveryOnChainError
    );

    // Milestone status below ResolutionProposed (Pending=0, InProgress=1, Submitted=2, RevisionRequested=3, Disputed=4)
    const invalidStatuses = [
      MilestoneStatus.Pending,
      MilestoneStatus.InProgress,
      MilestoneStatus.Submitted,
      MilestoneStatus.RevisionRequested,
      MilestoneStatus.Disputed,
    ];
    for (const invalidStatus of invalidStatuses) {
      const wrongStatusClient = createMockClient({
        milestoneStatus: invalidStatus,
      }) as any;
      await assert.rejects(
        async () => {
          await executeHistoricalAuthorizationRecovery({
            dealAddress: target.dealAddress,
            milestoneId: 0,
            authorizationId: target.authorizationId,
            executionTxHash: target.executionTxHash,
            callerWallet: adminWallet,
            publicClient: wrongStatusClient,
            dbRepo,
          });
        },
        HistoricalRecoveryOnChainError
      );
    }

    // Verify status code 5 (ResolutionProposed) succeeds with both struct and tuple milestone return
    for (const format of ['struct', 'tuple'] as const) {
      const validClient = createMockClient({
        milestoneStatus: MilestoneStatus.ResolutionProposed,
        milestoneFormat: format,
      }) as any;
      const validRepo = new MockHistoricalRecoveryRepository(validSignatures);
      const res = await executeHistoricalAuthorizationRecovery({
        dealAddress: target.dealAddress,
        milestoneId: 0,
        authorizationId: target.authorizationId,
        executionTxHash: target.executionTxHash,
        callerWallet: adminWallet,
        publicClient: validClient,
        dbRepo: validRepo,
      });
      assert.strictEqual(res.authorization.status, 'executed');
      assert.strictEqual(res.onChainMilestoneStatus, 5);
    }

    // Progression states accepted: FinalReview (6) and SettledSplit (9) in both formats
    for (const validStatus of [MilestoneStatus.FinalReview, MilestoneStatus.SettledSplit]) {
      for (const format of ['struct', 'tuple'] as const) {
        const progClient = createMockClient({
          milestoneStatus: validStatus,
          milestoneFormat: format,
        }) as any;
        const progRepo = new MockHistoricalRecoveryRepository(validSignatures);
        const res = await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: progClient,
          dbRepo: progRepo,
        });
        assert.strictEqual(res.authorization.status, 'executed');
        assert.strictEqual(res.onChainMilestoneStatus, validStatus);
      }
    }
  });

  await t.test('5. Cryptographic verification: corrupted stored 20/5 canonical report is rejected', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);
    const publicClient = createMockClient() as any;

    // Corrupt the canonical report narrative
    dbRepo.reportState.canonicalReport = {
      ...createValidCanonical20_5Report(),
      summary: 'corrupted narrative text',
    };

    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient,
          dbRepo,
        });
      },
      HistoricalRecoveryIntegrityError,
      'Must reject corrupted canonical report failing stored justification hash'
    );
  });

  await t.test('6. Cryptographic verification: incorrect stored report justification hash is rejected', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);
    const publicClient = createMockClient() as any;

    // Alter stored justification hash on bound report
    dbRepo.reportState.justificationHash = '0x0000000000000000000000000000000000000000000000000000000000000000';

    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient,
          dbRepo,
        });
      },
      HistoricalRecoveryIntegrityError,
      'Must reject mismatched stored report justification hash'
    );
  });

  await t.test('7. Cryptographic verification: invalid EIP-712 digest on authorization is rejected', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);
    const publicClient = createMockClient() as any;

    // Tamper with typedDataHash
    dbRepo.authState.typedDataHash = '0x1111111111111111111111111111111111111111111111111111111111111111';

    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient,
          dbRepo,
        });
      },
      HistoricalRecoveryIntegrityError,
      'Must reject tampered typedDataHash'
    );
  });

  await t.test('8. Cryptographic verification: unauthorized or duplicate signatures fail threshold', async () => {
    const publicClient = createMockClient() as any;

    // A. Signatures signed by an outsider / non-committee member
    const typedData = getResolutionProposalTypedData(baseAuthData);
    const outsiderSig = await UNAUTHORIZED_SIGNER.signTypedData(typedData as any);
    const outsiderSignatures = [
      validSignatures[0],
      { signerWallet: UNAUTHORIZED_SIGNER.address.toLowerCase(), signature: outsiderSig },
    ];

    const dbRepoOutsider = new MockHistoricalRecoveryRepository(outsiderSignatures);
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient,
          dbRepo: dbRepoOutsider,
        });
      },
      HistoricalRecoveryIntegrityError,
      'Must reject signature from unauthorized committee member'
    );

    // B. Duplicate signatures from the same signer (fails 2 distinct signers requirement)
    const duplicateSignatures = [validSignatures[0], validSignatures[0]];
    const dbRepoDuplicate = new MockHistoricalRecoveryRepository(duplicateSignatures);
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient,
          dbRepo: dbRepoDuplicate,
        });
      },
      HistoricalRecoveryIntegrityError,
      'Must reject duplicate signatures from identical signer'
    );
  });

  await t.test('9. Full database target verification: rejects wrong amounts, committee, or bound report linkage', async () => {
    const publicClient = createMockClient() as any;

    // Wrong committee address in authorization
    const dbRepoWrongComm = new MockHistoricalRecoveryRepository(validSignatures);
    dbRepoWrongComm.authState.committeeAddress = '0x0000000000000000000000000000000000000001';
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient,
          dbRepo: dbRepoWrongComm,
        });
      },
      HistoricalRecoveryIntegrityError
    );

    // Wrong reportId linkage in authorization
    const dbRepoWrongLink = new MockHistoricalRecoveryRepository(validSignatures);
    dbRepoWrongLink.authState.reportId = '00000000-0000-0000-0000-000000000000';
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient,
          dbRepo: dbRepoWrongLink,
        });
      },
      HistoricalRecoveryIntegrityError
    );
  });

  await t.test('10. Inconsistent state: executed authorization without audit record throws dedicated error', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);
    const publicClient = createMockClient() as any;

    // Authorization is already executed, but auditState is null (missing)
    dbRepo.authState.status = 'executed';
    dbRepo.authState.executionTxHash = target.executionTxHash;
    dbRepo.auditState = null;

    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient,
          dbRepo,
        });
      },
      HistoricalRecoveryInconsistentStateError,
      'Must throw HistoricalRecoveryInconsistentStateError on missing audit record'
    );
  });

  await t.test('11. Inconsistent state: unexecuted authorization with orphaned audit record throws dedicated error', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);
    const publicClient = createMockClient() as any;

    // Authorization is still threshold_ready, but an audit record already exists
    dbRepo.authState.status = 'threshold_ready';
    dbRepo.auditState = {
      id: 'orphaned-audit',
      authorizationId: target.authorizationId,
      onChainTxHash: target.executionTxHash,
      onChainJustificationHash: target.justificationHash,
    };

    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient,
          dbRepo,
        });
      },
      HistoricalRecoveryInconsistentStateError,
      'Must throw HistoricalRecoveryInconsistentStateError on orphaned audit record'
    );
  });

  await t.test('12. Transaction rollback: failure during audit insertion aborts update and leaves state intact', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);
    const publicClient = createMockClient() as any;

    dbRepo.simulateAuditInsertFailure = true;

    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient,
          dbRepo,
        });
      },
      /simulated failure/
    );

    // State remains threshold_ready because transaction was aborted
    assert.equal(dbRepo.authState.status, 'threshold_ready');
    assert.equal(dbRepo.auditState, null);
  });

  await t.test('13. Successful recovery executes atomically and suppresses participant notification', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);
    const publicClient = createMockClient() as any;

    const result = await executeHistoricalAuthorizationRecovery({
      dealAddress: target.dealAddress,
      milestoneId: 0,
      authorizationId: target.authorizationId,
      executionTxHash: target.executionTxHash,
      callerWallet: adminWallet,
      publicClient,
      dbRepo,
    });

    assert.equal(result.success, true);
    assert.equal(result.isIdempotentNoop, false);

    // 1. Lock hierarchy strictly preserved: Report locked FIRST, Auth locked SECOND
    assert.deepEqual(dbRepo.lockOrder, ['report_lock', 'auth_lock']);

    // 2. Authorization updated to executed with correct txHash and original justification hash
    assert.equal(result.authorization.status, 'executed');
    assert.equal(result.authorization.executionTxHash, target.executionTxHash);
    assert.equal(result.authorization.justificationHash, target.justificationHash);

    // 3. Bound report preserved verbatim (staged status, 20/5 split, null txHash)
    assert.equal(result.boundReport.status, 'staged');
    assert.equal(result.boundReport.freelancerAmount, '20000000');
    assert.equal(result.boundReport.clientAmount, '5000000');
    assert.equal(result.boundReport.txHash, null);

    // 4. Audit record records explicit notification suppression
    assert.equal(result.auditRecord.authorizationId, target.authorizationId);
    assert.equal(result.auditRecord.notificationStatus, 'suppressed_historical_sync');
    assert.equal(
      result.auditRecord.notificationSuppressionReason,
      'historical_synchronization_notification_suppressed'
    );
  });

  await t.test('14. Idempotent retry returns safe no-op with matching audit record', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);
    const publicClient = createMockClient() as any;

    // Run 1: initial recovery
    const run1 = await executeHistoricalAuthorizationRecovery({
      dealAddress: target.dealAddress,
      milestoneId: 0,
      authorizationId: target.authorizationId,
      executionTxHash: target.executionTxHash,
      callerWallet: adminWallet,
      publicClient,
      dbRepo,
    });
    assert.equal(run1.isIdempotentNoop, false);

    // Run 2: idempotent retry
    const run2 = await executeHistoricalAuthorizationRecovery({
      dealAddress: target.dealAddress,
      milestoneId: 0,
      authorizationId: target.authorizationId,
      executionTxHash: target.executionTxHash,
      callerWallet: adminWallet,
      publicClient,
      dbRepo,
    });
    assert.equal(run2.success, true);
    assert.equal(run2.isIdempotentNoop, true);
  });

  await t.test('15. Historical committee membership succeeds even when current membership differs', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);
    // Committee was rotated at later blocks: current authorized signers are completely different,
    // but at the historical receipt block, SIGNER_A and SIGNER_B were the authorized signers.
    const publicClient = createMockClient({
      authorizedSigners: [
        '0x4444444444444444444444444444444444444444',
        '0x5555555555555555555555555555555555555555',
      ],
      historicalAuthorizedSigners: [
        SIGNER_A.address.toLowerCase(),
        SIGNER_B.address.toLowerCase(),
      ],
    }) as any;

    const result = await executeHistoricalAuthorizationRecovery({
      dealAddress: target.dealAddress,
      milestoneId: 0,
      authorizationId: target.authorizationId,
      executionTxHash: target.executionTxHash,
      callerWallet: adminWallet,
      publicClient,
      dbRepo,
    });

    assert.equal(result.success, true);
    assert.equal(result.authorization.status, 'executed');
  });

  await t.test('16. Same-block signer rotation: signer rotated out after proposal in the same block remains historically valid via verified receipt execution', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);
    // Simulate that by the end of the block (post-block state 6950000n), SIGNER_B was rotated out in a subsequent tx.
    // However, at pre-block state (6950000n - 1n), SIGNER_B was an authorized signer on the committee.
    // The multi-state signer check and verified receipt ensure that same-block rotation does NOT cause a false negative.
    const publicClient = createMockClient({
      historicalAuthorizedSigners: [SIGNER_A.address.toLowerCase()], // SIGNER_B rotated out by end of block
      preBlockAuthorizedSigners: [SIGNER_A.address.toLowerCase(), SIGNER_B.address.toLowerCase()], // pre-block had both
      authorizedSigners: [SIGNER_A.address.toLowerCase()], // latest also does not have SIGNER_B
    }) as any;

    const result = await executeHistoricalAuthorizationRecovery({
      dealAddress: target.dealAddress,
      milestoneId: 0,
      authorizationId: target.authorizationId,
      executionTxHash: target.executionTxHash,
      callerWallet: adminWallet,
      publicClient,
      dbRepo,
    });

    assert.equal(result.success, true);
    assert.equal(result.authorization.status, 'executed');
    assert.equal(result.auditRecord.narrativeAuditStatus, 'unrecoverable_offchain_hash_committed');
  });

  await t.test('17. Insufficient signatures failing threshold (less than 2) is strictly rejected', async () => {
    // Only 1 signature provided when threshold is 2
    const singleSignature = [validSignatures[0]];
    const dbRepo = new MockHistoricalRecoveryRepository(singleSignature);
    const publicClient = createMockClient() as any;

    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryIntegrityError);
        assert(/Insufficient signatures for recovery: required 2, found 1/.test(err.message));
        return true;
      }
    );
  });

  await t.test('18. Historical RPC archive unavailability does not prevent valid recovery', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);
    // RPC node cannot serve historical block state (pruned non-archive node)
    const publicClient = createMockClient({
      simulateHistoricalStateUnavailable: true,
    }) as any;

    const result = await executeHistoricalAuthorizationRecovery({
      dealAddress: target.dealAddress,
      milestoneId: 0,
      authorizationId: target.authorizationId,
      executionTxHash: target.executionTxHash,
      callerWallet: adminWallet,
      publicClient,
      dbRepo,
    });

    assert.equal(result.success, true);
    assert.equal(result.authorization.status, 'executed');
  });

  await t.test('19. Receipt from wrong chain or wrong contract is rejected', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);

    // Case A: Wrong chain ID (Mainnet 1 instead of Sepolia 11155111)
    const wrongChainClient = createMockClient({
      chainId: 1,
    }) as any;

    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: wrongChainClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/does not match expected target chainId 11155111/.test(err.message));
        return true;
      }
    );

    // Case B: Receipt missing blockNumber
    const missingBlockReceipt = createMockReceipt({
      blockNumber: 0n,
    });
    const missingBlockClient = createMockClient({
      receipt: missingBlockReceipt,
    }) as any;

    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: missingBlockClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/contains invalid blockNumber/.test(err.message));
        return true;
      }
    );

    // Case C: Event emitted from wrong contract
    const wrongContractReceipt = createMockReceipt({
      contractAddress: '0x9999999999999999999999999999999999999999',
    });
    const wrongContractClient = createMockClient({
      receipt: wrongContractReceipt,
    }) as any;

    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: wrongContractClient,
          dbRepo,
        });
      },
      HistoricalRecoveryOnChainError
    );
  });

  await t.test('20. Cryptographic integrity: signatures generated for mismatched payload are rejected', async () => {
    // Generate valid ECDSA signatures, but over a DIFFERENT payload (e.g. milestone 1 instead of 0)
    const mismatchedPayloadData: ResolutionProposalAuthData = {
      ...baseAuthData,
      milestoneId: 1n,
    };
    const mismatchedSignatures = await generateValidSignatures(mismatchedPayloadData);

    const dbRepo = new MockHistoricalRecoveryRepository(mismatchedSignatures);
    const publicClient = createMockClient() as any;

    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryIntegrityError);
        assert(/Invalid signature for signer/.test(err.message));
        return true;
      }
    );
  });

  await t.test('21. Exact transaction calldata and stored signature match: pure verifier and end-to-end recovery succeed', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);
    const mockTx = createMockTransaction({ signatures: validSignatures });

    // Pure calldata verifier
    const calldataResult = verifyCommitteeResolutionProposalCalldata({
      transaction: mockTx,
      target,
    });
    assert.equal(calldataResult.valid, true);
    assert.equal(calldataResult.decoded?.functionName, 'submitResolutionProposal');
    assert.equal(calldataResult.decoded?.submittedSignatures[0], validSignatures[0].signature);
    assert.equal(calldataResult.decoded?.submittedSignatures[1], validSignatures[1].signature);

    // End-to-end recovery execution
    const publicClient = createMockClient({ transaction: mockTx }) as any;
    const result = await executeHistoricalAuthorizationRecovery({
      dealAddress: target.dealAddress,
      milestoneId: 0,
      authorizationId: target.authorizationId,
      executionTxHash: target.executionTxHash,
      callerWallet: adminWallet,
      publicClient,
      dbRepo,
    });
    assert.equal(result.success, true);
    assert.equal(result.authorization.status, 'executed');
    assert.equal(result.auditRecord.notificationStatus, 'suppressed_historical_sync');
    assert.equal(result.auditRecord.notificationSuppressionReason, 'historical_synchronization_notification_suppressed');
  });

  await t.test('22. Mismatched submitted signatures: calldata with outsider or altered signatures is rejected', async () => {
    const outsiderSig = await UNAUTHORIZED_SIGNER.signTypedData(getResolutionProposalTypedData(baseAuthData) as any);
    const mismatchedTx = createMockTransaction({
      sig1: outsiderSig as `0x${string}`,
      sig2: validSignatures[1].signature as `0x${string}`,
    });

    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);
    const publicClient = createMockClient({ transaction: mismatchedTx }) as any;

    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryIntegrityError);
        assert(/Stored database signatures do not match the signatures submitted in on-chain transaction calldata/.test(err.message));
        return true;
      }
    );
  });

  await t.test('23. Mismatched proposal calldata: transaction with mismatched deal, milestone, amount, or nonce is rejected', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);

    // Case A: Mismatched freelancer amount in proposal struct
    const badAmountAuthArg = {
      committee: target.committeeAddress as `0x${string}`,
      chainId: BigInt(target.chainId),
      deal: target.dealAddress as `0x${string}`,
      milestoneId: BigInt(target.milestoneId),
      freelancerAmount: 20000000n, // Mismatched (20M instead of 25M)
      clientAmount: BigInt(target.clientAmount),
      justificationHash: target.justificationHash as `0x${string}`,
      resolutionNonce: BigInt(target.resolutionNonce),
      validUntil: 1730000000n,
      evidenceRootHash: '0x8d5a305b96060655ba48842763393901ceb0be123ad5ea69019f44019b4fc328' as `0x${string}`,
      specHash: '0x9e72259dd6e1b13cd2c094fbb1cadfdcda59a49648e055962122e8d7663b9e3e' as `0x${string}`,
      submissionVersion: 1,
    };
    const badAmountTx = createMockTransaction({ authArg: badAmountAuthArg });
    const badAmountClient = createMockClient({ transaction: badAmountTx }) as any;

    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: badAmountClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/Calldata proposal freelancerAmount/.test(err.message));
        return true;
      }
    );

    // Case B: Mismatched resolutionNonce in proposal struct
    const badNonceAuthArg = {
      ...badAmountAuthArg,
      freelancerAmount: BigInt(target.freelancerAmount),
      resolutionNonce: 2n, // Mismatched nonce
    };
    const badNonceTx = createMockTransaction({ authArg: badNonceAuthArg });
    const badNonceClient = createMockClient({ transaction: badNonceTx }) as any;

    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: badNonceClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/Calldata proposal resolutionNonce/.test(err.message));
        return true;
      }
    );
  });

  await t.test('24. Wrong transaction destination: transaction to deal address or non-committee is rejected', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);
    const wrongDestTx = createMockTransaction({ to: target.dealAddress });
    const publicClient = createMockClient({ transaction: wrongDestTx }) as any;

    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/Transaction destination/.test(err.message));
        assert(/does not match expected committeeAddress/.test(err.message));
        return true;
      }
    );
  });

  await t.test('25. Transaction calldata unavailable: client failing or missing getTransaction is rejected', async () => {
    const dbRepo = new MockHistoricalRecoveryRepository(validSignatures);

    // Subcase A: getTransaction returns null
    const nullTxClient = createMockClient({ transaction: null }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: nullTxClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/Transaction calldata unavailable/.test(err.message));
        return true;
      }
    );

    // Subcase B: getTransaction throws network error
    const throwTxClient = createMockClient({ transaction: 'throw' }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: throwTxClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/Transaction calldata unavailable/.test(err.message));
        assert(/RPC network error/.test(err.message));
        return true;
      }
    );

    // Subcase C: Client does not implement getTransaction
    const missingMethodClient = createMockClient({ omitGetTransaction: true }) as any;
    await assert.rejects(
      async () => {
        await executeHistoricalAuthorizationRecovery({
          dealAddress: target.dealAddress,
          milestoneId: 0,
          authorizationId: target.authorizationId,
          executionTxHash: target.executionTxHash,
          callerWallet: adminWallet,
          publicClient: missingMethodClient,
          dbRepo,
        });
      },
      (err: any) => {
        assert(err instanceof HistoricalRecoveryOnChainError);
        assert(/Client does not implement getTransaction/.test(err.message));
        return true;
      }
    );
  });
});

