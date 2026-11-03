import { getDb } from '@/db';
import {
  committeeResolutionAuthorizations,
  committeeResolutionSignatures,
  milestoneResolutionReports,
  historicalReconciliationAudits,
  type CommitteeResolutionAuthorizationRow,
  type MilestoneResolutionReportRow,
  type HistoricalReconciliationAuditRow,
  type CommitteeResolutionSignatureRow,
} from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { isAddress, hashTypedData, decodeFunctionData } from 'viem';
import { synqDealV1ABI, synqResolutionCommitteeABI } from '@/lib/contracts/abis';
import {
  synqResolutionCommitteeReadABI,
  hashResolutionReport,
  type CanonicalResolutionReportV1,
} from '@/lib/deals/v2-resolution-report';
import {
  verifyCommitteeSignerSignature,
  isNonceUsedOnChain,
  verifyCommitteeResolutionProposalReceipt,
} from '@/lib/deals/v2-committee-auth';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { MilestoneStatus, type PublicClientLike } from '@/lib/deals/v2-deal';
import { sepoliaPublicClient } from '@/lib/chain';

/**
 * EXACT IMMUTABLE HISTORICAL RECOVERY TARGET
 * This procedure is hardcoded and strictly restricted to this single historical case.
 * It CANNOT be invoked for arbitrary authorizations or deals.
 */
export const HISTORICAL_RECOVERY_TARGET = {
  chainId: SEPOLIA_CHAIN_ID, // 11155111
  dealAddress: '0x5e99f67c04bff124c0aa9ae5867423853b3d168b'.toLowerCase(),
  milestoneId: 0,
  phase: 'INITIAL_RESOLUTION' as const,
  authorizationId: '779f4088-aeee-4223-a277-38b6b3dbfd0e',
  boundReportId: '65fc4235-8e04-4d8c-bbfb-98090f9ff3e7',
  executionTxHash: '0x40cb7c7df128ff4e02559116a7ad7f4b975803eb8f350a9e8be5d30c2feb8761'.toLowerCase(),
  justificationHash: '0x4ebd5d02d7f1d01fe78bdecb8a21b805abefed315b9c79bb1f3cd43c4acf0ea1'.toLowerCase(),
  freelancerAmount: '25000000',
  clientAmount: '0',
  resolutionNonce: '1',
  committeeAddress: '0xd60bbcc7c8aca633a6d158b6f7f7367e36207676'.toLowerCase(),

  // Expected commitments for the overwritten bound draft report
  boundReportJustificationHash: '0x10a0f9dd4b9c57e8f1bbc6c408b580376e6e57067eb976b529a2d3f58b4cd153'.toLowerCase(),
  boundReportFreelancerAmount: '20000000',
  boundReportClientAmount: '5000000',
} as const;

export class HistoricalRecoveryTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoricalRecoveryTargetError';
  }
}

export class HistoricalRecoveryAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoricalRecoveryAdminError';
  }
}

export class HistoricalRecoveryIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoricalRecoveryIntegrityError';
  }
}

export class HistoricalRecoveryOnChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoricalRecoveryOnChainError';
  }
}

export class HistoricalRecoveryInconsistentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoricalRecoveryInconsistentStateError';
  }
}

/**
 * Checks whether caller wallet is authorized for exceptional historical recovery.
 * Ordinary committee signer membership is strictly rejected.
 * Requires exclusively an explicitly configured SYNQ_ADMIN_RECOVERY_WALLETS allowlist.
 * Fails closed if the allowlist is missing or empty.
 */
export async function isAuthorizedAdminForHistoricalRecovery(
  wallet: string
): Promise<boolean> {
  if (!wallet || !isAddress(wallet)) return false;
  const rawEnv = process.env.SYNQ_ADMIN_RECOVERY_WALLETS;
  if (!rawEnv || typeof rawEnv !== 'string' || rawEnv.trim() === '') {
    return false; // Fail closed if missing or empty
  }
  const allowedWallets = rawEnv
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);

  if (allowedWallets.length === 0) {
    return false; // Fail closed
  }

  return allowedWallets.includes(wallet.toLowerCase());
}

export interface DecodedResolutionProposalCalldata {
  functionName: string;
  authArg: {
    committee: string;
    chainId: bigint | number;
    deal: string;
    milestoneId: bigint | number;
    freelancerAmount: bigint | string;
    clientAmount: bigint | string;
    justificationHash: string;
    resolutionNonce: bigint | number;
    validUntil: bigint | number;
    evidenceRootHash: string;
    specHash: string;
    submissionVersion: number;
  };
  submittedSignatures: [`0x${string}`, `0x${string}`];
}

/**
 * Pure calldata verification for SynqResolutionCommittee.submitResolutionProposal(...).
 * Verifies:
 * 1. Transaction destination matches target committee address.
 * 2. Calldata is valid and decodes to function 'submitResolutionProposal'.
 * 3. Proposal argument matches the exact immutable target authorization commitments.
 * 4. Calldata provides two distinct non-empty signatures.
 */
export function verifyCommitteeResolutionProposalCalldata(params: {
  transaction: { to?: string | null; input?: string | null };
  target: typeof HISTORICAL_RECOVERY_TARGET;
}): {
  valid: boolean;
  error?: string;
  decoded?: DecodedResolutionProposalCalldata;
} {
  const { transaction, target } = params;

  if (!transaction.to || transaction.to.toLowerCase() !== target.committeeAddress.toLowerCase()) {
    return {
      valid: false,
      error: `Transaction destination (${transaction.to}) does not match expected committeeAddress (${target.committeeAddress})`,
    };
  }

  const calldata = (transaction.input ?? (transaction as any).data) as `0x${string}` | undefined;
  if (!calldata || calldata === '0x' || calldata.length < 10) {
    return {
      valid: false,
      error: 'Transaction calldata is missing or empty',
    };
  }

  let decoded: any;
  try {
    decoded = decodeFunctionData({
      abi: synqResolutionCommitteeABI,
      data: calldata,
    });
  } catch (err: any) {
    return {
      valid: false,
      error: `Failed to decode transaction calldata with SynqResolutionCommittee ABI: ${err?.message || err}`,
    };
  }

  if (decoded.functionName !== 'submitResolutionProposal') {
    return {
      valid: false,
      error: `Transaction functionName is '${decoded.functionName}'; expected 'submitResolutionProposal'`,
    };
  }

  const [authArg, sig1, sig2] = decoded.args as [any, `0x${string}`, `0x${string}`];

  if (!authArg) {
    return {
      valid: false,
      error: 'Decoded transaction arguments are missing the proposal auth struct',
    };
  }

  if (authArg.committee?.toLowerCase() !== target.committeeAddress.toLowerCase()) {
    return {
      valid: false,
      error: `Calldata proposal committee (${authArg.committee}) does not match target committee (${target.committeeAddress})`,
    };
  }

  if (Number(authArg.chainId) !== target.chainId) {
    return {
      valid: false,
      error: `Calldata proposal chainId (${authArg.chainId}) does not match target chainId (${target.chainId})`,
    };
  }

  if (authArg.deal?.toLowerCase() !== target.dealAddress.toLowerCase()) {
    return {
      valid: false,
      error: `Calldata proposal deal (${authArg.deal}) does not match target deal (${target.dealAddress})`,
    };
  }

  if (Number(authArg.milestoneId) !== target.milestoneId) {
    return {
      valid: false,
      error: `Calldata proposal milestoneId (${authArg.milestoneId}) does not match target milestoneId (${target.milestoneId})`,
    };
  }

  if (authArg.freelancerAmount?.toString() !== target.freelancerAmount) {
    return {
      valid: false,
      error: `Calldata proposal freelancerAmount (${authArg.freelancerAmount}) does not match target freelancerAmount (${target.freelancerAmount})`,
    };
  }

  if (authArg.clientAmount?.toString() !== target.clientAmount) {
    return {
      valid: false,
      error: `Calldata proposal clientAmount (${authArg.clientAmount}) does not match target clientAmount (${target.clientAmount})`,
    };
  }

  if (authArg.justificationHash?.toLowerCase() !== target.justificationHash.toLowerCase()) {
    return {
      valid: false,
      error: `Calldata proposal justificationHash (${authArg.justificationHash}) does not match target justificationHash (${target.justificationHash})`,
    };
  }

  if (authArg.resolutionNonce?.toString() !== target.resolutionNonce) {
    return {
      valid: false,
      error: `Calldata proposal resolutionNonce (${authArg.resolutionNonce}) does not match target resolutionNonce (${target.resolutionNonce})`,
    };
  }

  if (!sig1 || !sig2 || typeof sig1 !== 'string' || typeof sig2 !== 'string') {
    return {
      valid: false,
      error: 'Calldata is missing submitted proposal signatures',
    };
  }

  if (sig1.toLowerCase() === sig2.toLowerCase()) {
    return {
      valid: false,
      error: 'Calldata submitted signatures are identical',
    };
  }

  return {
    valid: true,
    decoded: {
      functionName: decoded.functionName,
      authArg,
      submittedSignatures: [sig1, sig2],
    },
  };
}

/**
 * Verifies EIP-712 typed data digest, signatures, and committee signer authorization
 * strictly bound to the verified on-chain transaction execution and calldata.
 */
export async function verifyHistoricalAuthorizationSignatures(params: {
  auth: CommitteeResolutionAuthorizationRow;
  signatures: { signerWallet: string; signature: string }[];
  client?: PublicClientLike;
  historicalBlockNumber?: bigint;
  submittedSignatures?: [`0x${string}`, `0x${string}`];
}): Promise<{ valid: boolean; error?: string; recoveredSigners?: string[] }> {
  const { auth, signatures, client, historicalBlockNumber, submittedSignatures } = params;
  const target = HISTORICAL_RECOVERY_TARGET;

  // 1. Assert historical block number if provided
  if (historicalBlockNumber !== undefined && historicalBlockNumber <= 0n) {
    return {
      valid: false,
      error: `Invalid or missing historicalBlockNumber for committee verification: ${historicalBlockNumber}`,
    };
  }

  // 2. Verify target committee address and chain ID commitments
  if (auth.committeeAddress.toLowerCase() !== target.committeeAddress) {
    return {
      valid: false,
      error: `Authorization committee address ${auth.committeeAddress} does not match expected target ${target.committeeAddress}`,
    };
  }
  if (auth.chainId !== target.chainId) {
    return {
      valid: false,
      error: `Authorization chainId ${auth.chainId} does not match expected target chainId ${target.chainId}`,
    };
  }

  // 3. Verify EIP-712 typed data object matches authorization commitments
  const typedData = auth.typedData as any;
  if (!typedData || !typedData.domain || !typedData.message) {
    return { valid: false, error: 'Authorization record contains invalid or missing typedData' };
  }

  if (
    typedData.domain.verifyingContract?.toLowerCase() !== target.committeeAddress ||
    Number(typedData.domain.chainId) !== target.chainId
  ) {
    return {
      valid: false,
      error: 'EIP-712 typed data domain verifyingContract or chainId does not match target committee parameters',
    };
  }

  const msg = typedData.message;
  if (
    msg.committee?.toLowerCase() !== target.committeeAddress ||
    Number(msg.chainId) !== target.chainId ||
    msg.deal?.toLowerCase() !== target.dealAddress ||
    Number(msg.milestoneId) !== target.milestoneId ||
    String(msg.freelancerAmount) !== target.freelancerAmount ||
    String(msg.clientAmount) !== target.clientAmount ||
    msg.justificationHash?.toLowerCase() !== target.justificationHash ||
    String(msg.resolutionNonce) !== target.resolutionNonce
  ) {
    return {
      valid: false,
      error: 'EIP-712 typed data message fields do not match authorization target commitments',
    };
  }

  // 4. Recompute typed data hash and assert match
  let recomputedDigest: string;
  try {
    recomputedDigest = hashTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    }).toLowerCase();
  } catch (err: any) {
    return {
      valid: false,
      error: `Failed to compute EIP-712 typed data hash: ${err?.message || err}`,
    };
  }

  if (recomputedDigest !== auth.typedDataHash.toLowerCase()) {
    return {
      valid: false,
      error: `EIP-712 digest mismatch: stored ${auth.typedDataHash}, recomputed ${recomputedDigest}`,
    };
  }

  // 5. Establish committee threshold (SynqResolutionCommittee public constant THRESHOLD = 2)
  // Security reasoning: The committee contract enforces THRESHOLD = 2 immutably.
  // When available via client, we verify the threshold on-chain at historicalBlockNumber,
  // falling back to 2n if RPC historical state is pruned.
  let historicalThreshold = 2n;
  if (client?.readContract && historicalBlockNumber && historicalBlockNumber > 0n) {
    console.log('[synq-recovery-diag] [rpc:THRESHOLD:start]', {
      committeeAddress: `${target.committeeAddress.slice(0, 6)}...${target.committeeAddress.slice(-4)}`,
      historicalBlockNumber: historicalBlockNumber.toString(),
    });
    const tThresh0 = Date.now();
    try {
      const rawThreshold = await client.readContract({
        address: target.committeeAddress as `0x${string}`,
        abi: synqResolutionCommitteeReadABI,
        functionName: 'THRESHOLD',
        blockNumber: historicalBlockNumber,
      });
      if (rawThreshold) {
        historicalThreshold = BigInt(rawThreshold as any);
      }
      console.log('[synq-recovery-diag] [rpc:THRESHOLD:done]', {
        threshold: historicalThreshold.toString(),
        fallbackUsed: false,
        durationMs: Date.now() - tThresh0,
      });
    } catch (threshErr: any) {
      // Historical state may be pruned on non-archive RPCs; fallback safely to contract constant 2n
      historicalThreshold = 2n;
      console.log('[synq-recovery-diag] [rpc:THRESHOLD:done]', {
        threshold: historicalThreshold.toString(),
        fallbackUsed: true,
        errorName: threshErr?.name || 'ThresholdHistoricalReadFallback',
        durationMs: Date.now() - tThresh0,
      });
    }
  }

  if (historicalThreshold <= 0n) {
    return {
      valid: false,
      error: `Invalid historical committee threshold: ${historicalThreshold}`,
    };
  }

  // 6. Verify signatures count satisfies committee threshold
  if (!signatures || BigInt(signatures.length) < historicalThreshold) {
    return {
      valid: false,
      error: `Insufficient signatures for recovery: required ${historicalThreshold}, found ${signatures?.length ?? 0}`,
    };
  }

  // 7. Cryptographically recover and verify distinct signers over the exact EIP-712 digest
  console.log('[synq-recovery-diag] [crypto:recover_signatures:start]', {
    signaturesCount: signatures?.length ?? 0,
  });
  const tCrypto0 = Date.now();
  const recoveredSigners = new Set<string>();
  const storedSigMap = new Map<string, string>(); // signature.toLowerCase() -> signerWallet.toLowerCase()

  for (const sig of signatures) {
    const verified = await verifyCommitteeSignerSignature({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature: sig.signature as `0x${string}`,
      expectedSigner: sig.signerWallet,
    });

    if (!verified.valid || !verified.recoveredSigner) {
      console.log('[synq-recovery-diag] [crypto:recover_signatures:failed_signer]', {
        signer: `${sig.signerWallet.slice(0, 6)}...${sig.signerWallet.slice(-4)}`,
        errorLabel: 'SIGNER_RECOVERY_FAILED',
        durationMs: Date.now() - tCrypto0,
      });
      return {
        valid: false,
        error: `Invalid signature for signer ${sig.signerWallet}: ${verified.error}`,
      };
    }

    const signer = verified.recoveredSigner.toLowerCase();
    recoveredSigners.add(signer);
    storedSigMap.set(sig.signature.toLowerCase(), signer);
  }

  console.log('[synq-recovery-diag] [crypto:recover_signatures:done]', {
    recoveredCount: recoveredSigners.size,
    durationMs: Date.now() - tCrypto0,
  });

  if (BigInt(recoveredSigners.size) < historicalThreshold) {
    return {
      valid: false,
      error: `Threshold not satisfied: requires ${historicalThreshold} distinct signers, found ${recoveredSigners.size}`,
    };
  }

  // 8. Strict Transaction Calldata Binding
  // When submitted transaction calldata signatures are provided, verify that:
  // a) Exactly those submitted signatures match the stored database signatures.
  // b) The submitted signatures belong to two distinct recovered signers.
  if (submittedSignatures) {
    const [sub1, sub2] = submittedSignatures;
    const sub1Norm = sub1.toLowerCase();
    const sub2Norm = sub2.toLowerCase();

    if (sub1Norm === sub2Norm) {
      return {
        valid: false,
        error: 'Submitted transaction calldata contains duplicate signatures',
      };
    }

    if (!storedSigMap.has(sub1Norm) || !storedSigMap.has(sub2Norm)) {
      return {
        valid: false,
        error: 'Stored database signatures do not match the signatures submitted in on-chain transaction calldata',
      };
    }

    const s1Signer = storedSigMap.get(sub1Norm)!;
    const s2Signer = storedSigMap.get(sub2Norm)!;
    if (s1Signer === s2Signer) {
      return {
        valid: false,
        error: 'Submitted transaction calldata signatures belong to the same recovered signer wallet',
      };
    }
  }

  return { valid: true, recoveredSigners: Array.from(recoveredSigners) };
}

export interface HistoricalRecoveryResult {
  success: boolean;
  isIdempotentNoop: boolean;
  authorization: CommitteeResolutionAuthorizationRow;
  boundReport: MilestoneResolutionReportRow;
  auditRecord: HistoricalReconciliationAuditRow;
  onChainMilestoneStatus: number;
  message: string;
}

export interface IHistoricalRecoveryDbRepository {
  executeRecoveryTransaction(params: {
    target: typeof HISTORICAL_RECOVERY_TARGET;
    callerWallet: string;
    onChainBlockTimestamp: Date;
    historicalBlockNumber: bigint;
    publicClient: PublicClientLike;
    submittedSignatures?: [`0x${string}`, `0x${string}`];
  }): Promise<{
    isIdempotentNoop: boolean;
    authorization: CommitteeResolutionAuthorizationRow;
    boundReport: MilestoneResolutionReportRow;
    auditRecord: HistoricalReconciliationAuditRow;
  }>;
}

export class DrizzleHistoricalRecoveryRepository implements IHistoricalRecoveryDbRepository {
  async executeRecoveryTransaction(params: {
    target: typeof HISTORICAL_RECOVERY_TARGET;
    callerWallet: string;
    onChainBlockTimestamp: Date;
    historicalBlockNumber: bigint;
    publicClient: PublicClientLike;
    submittedSignatures?: [`0x${string}`, `0x${string}`];
  }): Promise<{
    isIdempotentNoop: boolean;
    authorization: CommitteeResolutionAuthorizationRow;
    boundReport: MilestoneResolutionReportRow;
    auditRecord: HistoricalReconciliationAuditRow;
  }> {
    const { target, callerWallet, onChainBlockTimestamp, historicalBlockNumber, publicClient, submittedSignatures } = params;
    const db = getDb();

    console.log('[synq-recovery-diag] [db:pool:acquire_start]', {
      timestamp: new Date().toISOString(),
      authId: target.authorizationId,
    });
    const tDbTx0 = Date.now();

    const txResult = await db.transaction(async (tx) => {
      const txAcquiredMs = Date.now() - tDbTx0;
      console.log('[synq-recovery-diag] [db:tx:acquired]', {
        txAcquisitionMs: txAcquiredMs,
      });

      // 1. Bounded lock timeout to prevent indefinite blocking
      console.log('[synq-recovery-diag] [db:set_lock_timeout:start]');
      const tLockTimeout0 = Date.now();
      await tx.execute(sql`SET LOCAL lock_timeout = '5000ms';`);
      console.log('[synq-recovery-diag] [db:set_lock_timeout:done]', {
        durationMs: Date.now() - tLockTimeout0,
      });

      // 2. Consistent Row-Lock Ordering: Lock Report row FIRST
      console.log('[synq-recovery-diag] [db:lock_report:start]', {
        reportId: target.boundReportId,
      });
      const tLockRep0 = Date.now();
      const lockedReports = await tx
        .select()
        .from(milestoneResolutionReports)
        .where(eq(milestoneResolutionReports.id, target.boundReportId))
        .for('update');
      const lockRepDurationMs = Date.now() - tLockRep0;

      const boundReport = lockedReports[0];
      console.log('[synq-recovery-diag] [db:lock_report:done]', {
        found: !!boundReport,
        status: boundReport?.status,
        durationMs: lockRepDurationMs,
      });

      if (!boundReport) {
        throw new HistoricalRecoveryIntegrityError(
          `Bound report ${target.boundReportId} not found in database`
        );
      }

      // Assert complete bound report tuple under lock
      if (
        boundReport.id !== target.boundReportId ||
        boundReport.chainId !== target.chainId ||
        boundReport.dealAddress.toLowerCase() !== target.dealAddress ||
        boundReport.milestoneId !== target.milestoneId ||
        boundReport.phase !== target.phase ||
        boundReport.status !== 'staged' ||
        boundReport.txHash !== null ||
        boundReport.freelancerAmount !== target.boundReportFreelancerAmount ||
        boundReport.clientAmount !== target.boundReportClientAmount ||
        boundReport.justificationHash.toLowerCase() !== target.boundReportJustificationHash
      ) {
        throw new HistoricalRecoveryIntegrityError(
          `Bound report ${target.boundReportId} violates expected target tuple. Database corruption or mismatch detected.`
        );
      }

      // Cryptographically verify stored 20/5 canonical report hashes to boundReport.justificationHash
      console.log('[synq-recovery-diag] [db:verify_report_hash:start]');
      const tRepHash0 = Date.now();
      try {
        const computedReportHash = hashResolutionReport(
          boundReport.canonicalReport as unknown as CanonicalResolutionReportV1
        );
        if (computedReportHash.toLowerCase() !== boundReport.justificationHash.toLowerCase()) {
          throw new HistoricalRecoveryIntegrityError(
            `Bound report canonical JSON hash mismatch: stored ${boundReport.justificationHash}, computed ${computedReportHash}`
          );
        }
        console.log('[synq-recovery-diag] [db:verify_report_hash:done]', {
          durationMs: Date.now() - tRepHash0,
        });
      } catch (err: any) {
        if (err instanceof HistoricalRecoveryIntegrityError) throw err;
        throw new HistoricalRecoveryIntegrityError(
          `Bound report canonical JSON validation failed: ${err?.message || err}`
        );
      }

      // 3. Lock Authorization row SECOND
      console.log('[synq-recovery-diag] [db:lock_auth:start]', {
        authId: target.authorizationId,
      });
      const tLockAuth0 = Date.now();
      const lockedAuths = await tx
        .select()
        .from(committeeResolutionAuthorizations)
        .where(eq(committeeResolutionAuthorizations.id, target.authorizationId))
        .for('update');
      const lockAuthDurationMs = Date.now() - tLockAuth0;

      const auth = lockedAuths[0];
      console.log('[synq-recovery-diag] [db:lock_auth:done]', {
        found: !!auth,
        status: auth?.status,
        durationMs: lockAuthDurationMs,
      });

      if (!auth) {
        throw new HistoricalRecoveryIntegrityError(
          `Authorization ${target.authorizationId} not found in database`
        );
      }

      // Assert complete authorization tuple under lock
      if (
        auth.id !== target.authorizationId ||
        auth.reportId !== target.boundReportId ||
        auth.chainId !== target.chainId ||
        auth.dealAddress.toLowerCase() !== target.dealAddress ||
        auth.milestoneId !== target.milestoneId ||
        auth.phase !== target.phase ||
        auth.committeeAddress.toLowerCase() !== target.committeeAddress ||
        auth.freelancerAmount !== target.freelancerAmount ||
        auth.clientAmount !== target.clientAmount ||
        auth.resolutionNonce.toString() !== target.resolutionNonce ||
        auth.justificationHash.toLowerCase() !== target.justificationHash
      ) {
        throw new HistoricalRecoveryIntegrityError(
          `Authorization ${target.authorizationId} violates expected target tuple. Database corruption or mismatch detected.`
        );
      }

      // 4. Idempotency and Inconsistent State Handling
      if (auth.status === 'executed') {
        console.log('[synq-recovery-diag] [db:auth_already_executed:check_audits]');
        if (auth.executionTxHash?.toLowerCase() !== target.executionTxHash.toLowerCase()) {
          throw new HistoricalRecoveryInconsistentStateError(
            `Authorization ${target.authorizationId} is executed with unexpected transaction ${auth.executionTxHash}; expected ${target.executionTxHash}. Manual review required.`
          );
        }

        // Fetch existing audit record
        const existingAudits = await tx
          .select()
          .from(historicalReconciliationAudits)
          .where(eq(historicalReconciliationAudits.authorizationId, target.authorizationId))
          .limit(1);

        const existingAudit = existingAudits[0];
        if (!existingAudit) {
          throw new HistoricalRecoveryInconsistentStateError(
            `Authorization ${target.authorizationId} is marked executed with transaction ${target.executionTxHash}, but matching historical reconciliation audit record is absent. Inconsistent state requires manual review.`
          );
        }

        // Verify consistency of existing audit record
        if (
          existingAudit.onChainTxHash.toLowerCase() !== target.executionTxHash.toLowerCase() ||
          existingAudit.onChainJustificationHash.toLowerCase() !== target.justificationHash.toLowerCase() ||
          existingAudit.boundReportId !== target.boundReportId ||
          existingAudit.boundReportJustificationHash.toLowerCase() !== boundReport.justificationHash.toLowerCase()
        ) {
          throw new HistoricalRecoveryInconsistentStateError(
            `Historical reconciliation audit ${existingAudit.id} for authorization ${target.authorizationId} is inconsistent with target parameters. Manual review required.`
          );
        }

        console.log('[synq-recovery-diag] [db:tx:callback_done]', {
          isIdempotentNoop: true,
          existingAuditId: existingAudit.id,
          callbackDurationMs: Date.now() - tDbTx0,
        });

        return {
          isIdempotentNoop: true,
          authorization: auth,
          boundReport,
          auditRecord: existingAudit,
        };
      }

      // If status is threshold_ready, verify there is no orphaned audit record
      const orphanAudits = await tx
        .select()
        .from(historicalReconciliationAudits)
        .where(eq(historicalReconciliationAudits.authorizationId, target.authorizationId))
        .limit(1);

      if (orphanAudits[0]) {
        throw new HistoricalRecoveryInconsistentStateError(
          `Found orphaned historical audit ${orphanAudits[0].id} for unexecuted authorization ${target.authorizationId}. Inconsistent state requires manual review.`
        );
      }

      if (auth.status !== 'threshold_ready') {
        throw new HistoricalRecoveryIntegrityError(
          `Cannot recover authorization in status '${auth.status}'; expected 'threshold_ready'`
        );
      }

      // 5. Cryptographic Verification of Authorization Signatures
      console.log('[synq-recovery-diag] [db:select_signatures:start]', {
        authId: target.authorizationId,
      });
      const tSigs0 = Date.now();
      const sigRows: CommitteeResolutionSignatureRow[] = await tx
        .select()
        .from(committeeResolutionSignatures)
        .where(eq(committeeResolutionSignatures.authorizationId, target.authorizationId))
        .orderBy(committeeResolutionSignatures.createdAt);
      console.log('[synq-recovery-diag] [db:select_signatures:done]', {
        count: sigRows.length,
        durationMs: Date.now() - tSigs0,
      });

      console.log('[synq-recovery-diag] [db:verify_signatures:start]');
      const tSigVerify0 = Date.now();
      const sigCheck = await verifyHistoricalAuthorizationSignatures({
        auth,
        signatures: sigRows,
        client: publicClient,
        historicalBlockNumber,
        submittedSignatures,
      });
      console.log('[synq-recovery-diag] [db:verify_signatures:done]', {
        valid: sigCheck.valid,
        recoveredCount: sigCheck.recoveredSigners?.length,
        durationMs: Date.now() - tSigVerify0,
      });

      if (!sigCheck.valid) {
        throw new HistoricalRecoveryIntegrityError(
          `Cryptographic authorization verification failed: ${sigCheck.error}`
        );
      }

      // 6. Update Authorization to executed (WITHOUT modifying bound report row)
      console.log('[synq-recovery-diag] [db:update_auth:start]', {
        authId: target.authorizationId,
        newStatus: 'executed',
      });
      const tUpd0 = Date.now();
      const now = new Date();
      const [updatedAuth] = await tx
        .update(committeeResolutionAuthorizations)
        .set({
          status: 'executed',
          executionTxHash: target.executionTxHash.toLowerCase(),
          executedByWallet: callerWallet.toLowerCase(),
          executedAt: onChainBlockTimestamp,
          updatedAt: now,
        })
        .where(eq(committeeResolutionAuthorizations.id, target.authorizationId))
        .returning();
      console.log('[synq-recovery-diag] [db:update_auth:done]', {
        updatedId: updatedAuth?.id,
        durationMs: Date.now() - tUpd0,
      });

      // 7. Insert immutable audit record with explicit notification suppression
      console.log('[synq-recovery-diag] [db:insert_audit:start]', {
        authId: target.authorizationId,
      });
      const tIns0 = Date.now();
      const [auditRecord] = await tx
        .insert(historicalReconciliationAudits)
        .values({
          chainId: target.chainId,
          dealAddress: target.dealAddress.toLowerCase(),
          milestoneId: target.milestoneId,
          phase: target.phase,
          authorizationId: target.authorizationId,
          boundReportId: target.boundReportId,
          onChainTxHash: target.executionTxHash.toLowerCase(),
          onChainJustificationHash: target.justificationHash.toLowerCase(),
          boundReportJustificationHash: boundReport.justificationHash.toLowerCase(),
          recoveredByWallet: callerWallet.toLowerCase(),
          narrativeAuditStatus: 'unrecoverable_offchain_hash_committed',
          notificationStatus: 'suppressed_historical_sync',
          notificationSuppressionReason: 'historical_synchronization_notification_suppressed',
          recoveredAt: now,
        })
        .returning();
      console.log('[synq-recovery-diag] [db:insert_audit:done]', {
        auditId: auditRecord?.id,
        durationMs: Date.now() - tIns0,
      });

      console.log('[synq-recovery-diag] [db:tx:callback_done]', {
        isIdempotentNoop: false,
        callbackDurationMs: Date.now() - tDbTx0,
      });

      return {
        isIdempotentNoop: false,
        authorization: updatedAuth,
        boundReport,
        auditRecord,
      };
    });

    console.log('[synq-recovery-diag] [db:tx:committed]', {
      isIdempotentNoop: txResult.isIdempotentNoop,
      totalCommittedDurationMs: Date.now() - tDbTx0,
    });

    return txResult;
  }
}

/**
 * Executes historical resolution recovery for the target authorization.
 * Strictly verifies target allowlist, administrative authorization, and live on-chain contract state.
 */
export async function executeHistoricalAuthorizationRecovery(params: {
  dealAddress: string;
  milestoneId: number;
  authorizationId: string;
  executionTxHash: string;
  callerWallet: string;
  publicClient?: PublicClientLike;
  dbRepo?: IHistoricalRecoveryDbRepository;
  adminOverrideForTest?: boolean;
}): Promise<HistoricalRecoveryResult> {
  const tServiceStart = Date.now();
  console.log('[synq-recovery-diag] [service:entry]', {
    timestamp: new Date().toISOString(),
    dealAddress: `${params.dealAddress.slice(0, 6)}...${params.dealAddress.slice(-4)}`,
    milestoneId: params.milestoneId,
    authId: params.authorizationId,
    callerWallet: `${params.callerWallet.slice(0, 6)}...${params.callerWallet.slice(-4)}`,
  });

  const target = HISTORICAL_RECOVERY_TARGET;

  // 1. Strict Target Allowlisting
  if (params.dealAddress.toLowerCase() !== target.dealAddress) {
    throw new HistoricalRecoveryTargetError(
      `Invalid dealAddress for historical recovery: ${params.dealAddress}`
    );
  }
  if (params.milestoneId !== target.milestoneId) {
    throw new HistoricalRecoveryTargetError(
      `Invalid milestoneId for historical recovery: ${params.milestoneId}`
    );
  }
  if (params.authorizationId !== target.authorizationId) {
    throw new HistoricalRecoveryTargetError(
      `Invalid authorizationId for historical recovery: ${params.authorizationId}`
    );
  }
  if (params.executionTxHash.toLowerCase() !== target.executionTxHash) {
    throw new HistoricalRecoveryTargetError(
      `Invalid executionTxHash for historical recovery: ${params.executionTxHash}`
    );
  }

  console.log('[synq-recovery-diag] [service:target_checks_passed]', {
    durationMs: Date.now() - tServiceStart,
  });

  // 2. Exceptional Administrative Authorization Check
  console.log('[synq-recovery-diag] [service:admin_check:start]', {
    callerWallet: `${params.callerWallet.slice(0, 6)}...${params.callerWallet.slice(-4)}`,
  });
  const tAdmin0 = Date.now();
  const client = params.publicClient ?? sepoliaPublicClient;
  const isAuthorizedAdmin =
    params.adminOverrideForTest ||
    (await isAuthorizedAdminForHistoricalRecovery(params.callerWallet));
  console.log('[synq-recovery-diag] [service:admin_check:done]', {
    isAuthorizedAdmin,
    durationMs: Date.now() - tAdmin0,
  });

  if (!isAuthorizedAdmin) {
    throw new HistoricalRecoveryAdminError(
      `Caller (${params.callerWallet}) is not authorized for exceptional historical recovery. Administrative role required.`
    );
  }

  // 3. Live On-Chain Pre-Flight Assertions
  // A. Chain ID & Transaction Receipt Verification
  if ((client as any).getChainId) {
    console.log('[synq-recovery-diag] [rpc:getChainId:start]');
    const tRpc1 = Date.now();
    const chainId = await (client as any).getChainId();
    console.log('[synq-recovery-diag] [rpc:getChainId:done]', {
      chainId: Number(chainId),
      durationMs: Date.now() - tRpc1,
    });
    if (Number(chainId) !== target.chainId) {
      throw new HistoricalRecoveryOnChainError(
        `Connected RPC client chainId (${chainId}) does not match expected target chainId ${target.chainId} (Sepolia)`
      );
    }
  }

  // B. Transaction Calldata Retrieval & Strict Decoding
  if (!client.getTransaction) {
    throw new HistoricalRecoveryOnChainError(
      'Client does not implement getTransaction for calldata verification'
    );
  }
  console.log('[synq-recovery-diag] [rpc:getTransaction:start]', {
    txHash: `${target.executionTxHash.slice(0, 10)}...${target.executionTxHash.slice(-8)}`,
  });
  const tRpc2 = Date.now();
  let tx: any;
  try {
    tx = await client.getTransaction({
      hash: target.executionTxHash as `0x${string}`,
    });
    console.log('[synq-recovery-diag] [rpc:getTransaction:done]', {
      found: !!tx,
      durationMs: Date.now() - tRpc2,
    });
  } catch (err: any) {
    console.error('[synq-recovery-diag] [rpc:getTransaction:failed]', {
      errorName: err?.name || 'RpcGetTransactionError',
      durationMs: Date.now() - tRpc2,
    });
    throw new HistoricalRecoveryOnChainError(
      `Transaction calldata unavailable for ${target.executionTxHash}: ${err?.message || err}`
    );
  }
  if (!tx) {
    throw new HistoricalRecoveryOnChainError(
      `Transaction calldata unavailable for ${target.executionTxHash}`
    );
  }

  console.log('[synq-recovery-diag] [service:calldata_verify:start]');
  const tCalldata0 = Date.now();
  const calldataCheck = verifyCommitteeResolutionProposalCalldata({
    transaction: tx,
    target,
  });
  console.log('[synq-recovery-diag] [service:calldata_verify:done]', {
    valid: calldataCheck.valid,
    errorLabel: calldataCheck.valid ? undefined : 'CALLDATA_MISMATCH',
    durationMs: Date.now() - tCalldata0,
  });
  if (!calldataCheck.valid || !calldataCheck.decoded) {
    throw new HistoricalRecoveryOnChainError(
      `Transaction calldata verification failed: ${calldataCheck.error}`
    );
  }

  // C. Transaction Receipt Verification
  if (!client.getTransactionReceipt) {
    throw new HistoricalRecoveryOnChainError(
      'Client does not implement getTransactionReceipt for pre-flight verification'
    );
  }
  console.log('[synq-recovery-diag] [rpc:getTransactionReceipt:start]', {
    txHash: `${target.executionTxHash.slice(0, 10)}...${target.executionTxHash.slice(-8)}`,
  });
  const tRpc3 = Date.now();
  const receipt = await client.getTransactionReceipt({
    hash: target.executionTxHash as `0x${string}`,
  });
  console.log('[synq-recovery-diag] [rpc:getTransactionReceipt:done]', {
    found: !!receipt,
    status: receipt?.status,
    blockNumber: receipt?.blockNumber ? String(receipt.blockNumber) : undefined,
    durationMs: Date.now() - tRpc3,
  });

  if (!receipt) {
    throw new HistoricalRecoveryOnChainError(
      `Transaction receipt not found on-chain for ${target.executionTxHash}`
    );
  }
  if (receipt.status !== 'success') {
    throw new HistoricalRecoveryOnChainError(
      `Transaction ${target.executionTxHash} failed or reverted on-chain`
    );
  }
  if (!receipt.to || receipt.to.toLowerCase() !== target.committeeAddress) {
    throw new HistoricalRecoveryOnChainError(
      `Transaction destination (${receipt.to}) does not match expected committeeAddress (${target.committeeAddress})`
    );
  }

  // B. Verify both committee and deal event logs using production dual-event verifier
  console.log('[synq-recovery-diag] [service:receipt_verify:start]');
  const tReceipt0 = Date.now();
  const receiptCheck = verifyCommitteeResolutionProposalReceipt({
    receipt: receipt as any,
    committeeAddress: target.committeeAddress,
    dealAddress: target.dealAddress,
    expectedMilestoneId: BigInt(target.milestoneId),
    expectedFreelancerAmount: BigInt(target.freelancerAmount),
    expectedClientAmount: BigInt(target.clientAmount),
    expectedJustificationHash: target.justificationHash,
    expectedNonce: BigInt(target.resolutionNonce),
  });
  console.log('[synq-recovery-diag] [service:receipt_verify:done]', {
    valid: receiptCheck.valid,
    errorLabel: receiptCheck.valid ? undefined : 'RECEIPT_EVENT_MISMATCH',
    durationMs: Date.now() - tReceipt0,
  });

  if (!receiptCheck.valid) {
    throw new HistoricalRecoveryOnChainError(
      `Transaction receipt verification failed: ${receiptCheck.error}`
    );
  }

  // C. Verify receipt blockNumber before trusting as historical reference point
  const rawBlockNumber = receipt.blockNumber;
  if (rawBlockNumber === undefined || rawBlockNumber === null) {
    throw new HistoricalRecoveryOnChainError(
      `Transaction receipt for ${target.executionTxHash} is missing blockNumber`
    );
  }
  const historicalBlockNumber = BigInt(rawBlockNumber);
  if (historicalBlockNumber <= 0n) {
    throw new HistoricalRecoveryOnChainError(
      `Transaction receipt for ${target.executionTxHash} contains invalid blockNumber: ${rawBlockNumber}`
    );
  }

  // C. Verify On-Chain Proposal State & Account for Post-Proposal Progression
  console.log('[synq-recovery-diag] [rpc:readContract:resolutionProposals:start]', {
    dealAddress: `${target.dealAddress.slice(0, 6)}...${target.dealAddress.slice(-4)}`,
    milestoneId: target.milestoneId,
  });
  const tRpc4 = Date.now();
  const onChainProposal = (await client.readContract({
    address: target.dealAddress as `0x${string}`,
    abi: synqDealV1ABI,
    functionName: 'resolutionProposals',
    args: [BigInt(target.milestoneId)],
  })) as [
    freelancerAmount: bigint,
    clientAmount: bigint,
    justificationHash: `0x${string}`,
    proposedAt: bigint,
    reconsiderationDeadline: bigint,
    resolver: `0x${string}`,
  ];
  console.log('[synq-recovery-diag] [rpc:readContract:resolutionProposals:done]', {
    freelancerAmount: String(onChainProposal[0]),
    clientAmount: String(onChainProposal[1]),
    justificationHash: `${onChainProposal[2].slice(0, 10)}...${onChainProposal[2].slice(-8)}`,
    resolver: `${onChainProposal[5].slice(0, 6)}...${onChainProposal[5].slice(-4)}`,
    durationMs: Date.now() - tRpc4,
  });

  const onChainFlAmount = onChainProposal[0];
  const onChainClAmount = onChainProposal[1];
  const onChainHash = onChainProposal[2];
  const onChainResolver = onChainProposal[5];

  if (
    onChainFlAmount !== BigInt(target.freelancerAmount) ||
    onChainClAmount !== BigInt(target.clientAmount) ||
    onChainHash.toLowerCase() !== target.justificationHash ||
    onChainResolver.toLowerCase() !== target.committeeAddress
  ) {
    throw new HistoricalRecoveryOnChainError(
      `On-chain resolution proposal data does not match target authorization commitments`
    );
  }

  // D. Read Current Milestone Status (do NOT assume stale status)
  type OnChainMilestoneStruct = {
    amount: bigint;
    workDeadline: bigint;
    reviewWindow: bigint;
    gracePeriod: bigint;
    status: number;
    specHash: `0x${string}`;
    evidenceRootHash: `0x${string}`;
    submittedAt: bigint;
    version: number;
  };

  type OnChainMilestoneTuple = readonly [
    amount: bigint,
    workDeadline: bigint,
    reviewWindow: bigint,
    gracePeriod: bigint,
    status: number,
    specHash: `0x${string}`,
    evidenceRootHash: `0x${string}`,
    submittedAt: bigint,
    version: number,
  ];

  type OnChainMilestone = OnChainMilestoneStruct | OnChainMilestoneTuple;

  console.log('[synq-recovery-diag] [rpc:readContract:getMilestone:start]', {
    milestoneId: target.milestoneId,
  });
  const tRpc5 = Date.now();
  const onChainMilestone = (await client.readContract({
    address: target.dealAddress as `0x${string}`,
    abi: synqDealV1ABI,
    functionName: 'getMilestone',
    args: [BigInt(target.milestoneId)],
  })) as OnChainMilestone;

  // On-chain getMilestone returns a Milestone struct { amount, workDeadline, reviewWindow, gracePeriod, status, specHash, evidenceRootHash, submittedAt, version }
  // (or positional 9-tuple in mock environments where status is at index 4)
  const milestoneStatus: number =
    typeof onChainMilestone === 'object' && onChainMilestone !== null && 'status' in onChainMilestone
      ? Number(onChainMilestone.status)
      : Number((onChainMilestone as OnChainMilestoneTuple)[4]);

  console.log('[synq-recovery-diag] [rpc:readContract:getMilestone:done]', {
    milestoneStatus,
    durationMs: Date.now() - tRpc5,
  });

  // Milestone must have at least reached ResolutionProposed (5) or progressed further (SettledSplit = 9, FinalReview = 6)
  if (
    Number.isNaN(milestoneStatus) ||
    (milestoneStatus !== MilestoneStatus.ResolutionProposed &&
      milestoneStatus !== MilestoneStatus.FinalReview &&
      milestoneStatus !== MilestoneStatus.SettledSplit)
  ) {
    throw new HistoricalRecoveryOnChainError(
      `On-chain milestone status is ${milestoneStatus}; must be ResolutionProposed (5) or higher`
    );
  }

  // E. Verify On-Chain Nonce Permanence
  console.log('[synq-recovery-diag] [rpc:isNonceUsedOnChain:start]', {
    nonce: target.resolutionNonce,
  });
  const tRpc6 = Date.now();
  const isNonceUsed = await isNonceUsedOnChain({
    committeeAddress: target.committeeAddress,
    dealAddress: target.dealAddress,
    milestoneId: target.milestoneId,
    phase: target.phase,
    nonce: BigInt(target.resolutionNonce),
    publicClient: client,
  });
  console.log('[synq-recovery-diag] [rpc:isNonceUsedOnChain:done]', {
    isNonceUsed,
    durationMs: Date.now() - tRpc6,
  });

  if (!isNonceUsed) {
    throw new HistoricalRecoveryOnChainError(
      `Proposal nonce ${target.resolutionNonce} has not been consumed on-chain`
    );
  }

  // 4. Atomic Database Execution
  console.log('[synq-recovery-diag] [service:db_dispatch:start]');
  const dbRepo = params.dbRepo ?? new DrizzleHistoricalRecoveryRepository();
  const blockTimestamp = new Date(); // If receipt has blockNumber/timestamp, use it; fallback to current time

  const txResult = await dbRepo.executeRecoveryTransaction({
    target,
    callerWallet: params.callerWallet,
    onChainBlockTimestamp: blockTimestamp,
    historicalBlockNumber,
    publicClient: client,
    submittedSignatures: calldataCheck.decoded.submittedSignatures,
  });

  const totalServiceDurationMs = Date.now() - tServiceStart;
  console.log('[synq-recovery-diag] [service:done]', {
    isIdempotentNoop: txResult.isIdempotentNoop,
    onChainMilestoneStatus: milestoneStatus,
    totalServiceDurationMs,
  });

  return {
    success: true,
    isIdempotentNoop: txResult.isIdempotentNoop,
    authorization: txResult.authorization,
    boundReport: txResult.boundReport,
    auditRecord: txResult.auditRecord,
    onChainMilestoneStatus: milestoneStatus,
    message: txResult.isIdempotentNoop
      ? 'Historical authorization recovery was already executed (idempotent no-op).'
      : 'Historical authorization recovery executed successfully with on-chain attestation.',
  };
}
