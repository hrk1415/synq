import { isAddress, hashTypedData } from 'viem';
import { getDb } from '@/db';
import {
  committeeResolutionAuthorizations,
  committeeResolutionSignatures,
  type CommitteeResolutionAuthorizationRow,
  type NewCommitteeResolutionAuthorizationRow,
  type CommitteeResolutionSignatureRow,
  type NewCommitteeResolutionSignatureRow,
  type CommitteeAuthorizationStatus,
  type CommitteeAuthorizationType,
  type ResolutionReportPhase,
} from '@/db/schema';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import {
  readStandardV2DealData,
  isSynqV2Deal,
  DealState,
  MilestoneStatus,
  type PublicClientLike,
} from '@/lib/deals/v2-deal';
import {
  deriveAuthorizedCommittee,
  synqResolutionCommitteeReadABI,
} from '@/lib/deals/v2-resolution-report';
import {
  type IMilestoneResolutionReportRepository,
  DrizzleMilestoneResolutionReportRepository,
  reconcileResolutionReport,
} from '@/lib/deals/resolution-reports-db';
import {
  getResolutionProposalTypedData,
  getFinalResolutionTypedData,
  hashResolutionProposalAuth,
  hashFinalResolutionAuth,
  verifyCommitteeSignerSignature,
  isNonceUsedOnChain,
  buildVerifiedThresholdBundle,
  formatCommitteeExecutionTransaction,
  verifyCommitteeResolutionProposalReceipt,
  verifyCommitteeFinalResolutionReceipt,
  DEFAULT_AUTH_EXPIRATION_SECONDS,
  COMMITTEE_THRESHOLD,
  CommitteeAuthValidationError,
  CommitteeAuthAuthError,
  CommitteeAuthConflictError,
  CommitteeAuthIntegrityError,
  CommitteeAuthExpiredError,
  CommitteeAuthInvalidatedError,
  CommitteeExecutionReceiptError,
  CommitteeExecutionRecoveryError,
  type ResolutionProposalAuthData,
  type FinalResolutionAuthData,
  type VerifiedThresholdBundle,
  type CommitteeExecutionTransactionRequest,
} from '@/lib/deals/v2-committee-auth';
import { synqDealV1ABI } from '@/lib/contracts/abis';
import { sepoliaPublicClient } from '@/lib/chain';
import { and, eq, desc } from 'drizzle-orm';

export {
  CommitteeAuthValidationError,
  CommitteeAuthAuthError,
  CommitteeAuthConflictError,
  CommitteeAuthIntegrityError,
  CommitteeAuthExpiredError,
  CommitteeAuthInvalidatedError,
  CommitteeExecutionReceiptError,
  CommitteeExecutionRecoveryError,
};

// ---------------------------------------------------------------------------
// Repository Pattern for Isolation and Unit Testing
// ---------------------------------------------------------------------------

export interface ICommitteeAuthorizationRepository {
  getAuthById(id: string): Promise<CommitteeResolutionAuthorizationRow | null>;

  getAuthByNonce(
    chainId: number,
    committeeAddress: string,
    dealAddress: string,
    milestoneId: number,
    phase: ResolutionReportPhase,
    nonce: string
  ): Promise<CommitteeResolutionAuthorizationRow | null>;

  getAuthByReportId(reportId: string): Promise<CommitteeResolutionAuthorizationRow | null>;

  listAuthsByMilestone(
    chainId: number,
    dealAddress: string,
    milestoneId: number
  ): Promise<CommitteeResolutionAuthorizationRow[]>;

  createAuth(row: NewCommitteeResolutionAuthorizationRow): Promise<CommitteeResolutionAuthorizationRow>;

  updateAuthStatus(id: string, status: CommitteeAuthorizationStatus): Promise<CommitteeResolutionAuthorizationRow>;

  updateAuthExecution(
    id: string,
    data: {
      executionTxHash: string;
      executedByWallet: string | null;
      executedAt: Date | null;
      status: 'executed';
    }
  ): Promise<CommitteeResolutionAuthorizationRow>;

  getSignaturesByAuthId(authorizationId: string): Promise<CommitteeResolutionSignatureRow[]>;

  createSignature(row: NewCommitteeResolutionSignatureRow): Promise<CommitteeResolutionSignatureRow>;

  getSignerSignature(authorizationId: string, signerWallet: string): Promise<CommitteeResolutionSignatureRow | null>;
}

export class DrizzleCommitteeAuthorizationRepository implements ICommitteeAuthorizationRepository {
  async getAuthById(id: string): Promise<CommitteeResolutionAuthorizationRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(committeeResolutionAuthorizations)
      .where(eq(committeeResolutionAuthorizations.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async getAuthByNonce(
    chainId: number,
    committeeAddress: string,
    dealAddress: string,
    milestoneId: number,
    phase: ResolutionReportPhase,
    nonce: string
  ): Promise<CommitteeResolutionAuthorizationRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(committeeResolutionAuthorizations)
      .where(
        and(
          eq(committeeResolutionAuthorizations.chainId, chainId),
          eq(committeeResolutionAuthorizations.committeeAddress, committeeAddress.toLowerCase()),
          eq(committeeResolutionAuthorizations.dealAddress, dealAddress.toLowerCase()),
          eq(committeeResolutionAuthorizations.milestoneId, milestoneId),
          eq(committeeResolutionAuthorizations.phase, phase),
          eq(committeeResolutionAuthorizations.resolutionNonce, nonce)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async getAuthByReportId(reportId: string): Promise<CommitteeResolutionAuthorizationRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(committeeResolutionAuthorizations)
      .where(eq(committeeResolutionAuthorizations.reportId, reportId))
      .orderBy(desc(committeeResolutionAuthorizations.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async listAuthsByMilestone(
    chainId: number,
    dealAddress: string,
    milestoneId: number
  ): Promise<CommitteeResolutionAuthorizationRow[]> {
    const db = getDb();
    return db
      .select()
      .from(committeeResolutionAuthorizations)
      .where(
        and(
          eq(committeeResolutionAuthorizations.chainId, chainId),
          eq(committeeResolutionAuthorizations.dealAddress, dealAddress.toLowerCase()),
          eq(committeeResolutionAuthorizations.milestoneId, milestoneId)
        )
      )
      .orderBy(desc(committeeResolutionAuthorizations.createdAt));
  }

  async createAuth(row: NewCommitteeResolutionAuthorizationRow): Promise<CommitteeResolutionAuthorizationRow> {
    const db = getDb();
    const inserted = await db.insert(committeeResolutionAuthorizations).values(row).returning();
    return inserted[0];
  }

  async updateAuthStatus(id: string, status: CommitteeAuthorizationStatus): Promise<CommitteeResolutionAuthorizationRow> {
    const db = getDb();
    const updated = await db
      .update(committeeResolutionAuthorizations)
      .set({ status, updatedAt: new Date() })
      .where(eq(committeeResolutionAuthorizations.id, id))
      .returning();
    return updated[0];
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
    const db = getDb();
    const updated = await db
      .update(committeeResolutionAuthorizations)
      .set({
        executionTxHash: data.executionTxHash.toLowerCase(),
        executedByWallet: data.executedByWallet ? data.executedByWallet.toLowerCase() : null,
        executedAt: data.executedAt,
        status: 'executed',
        updatedAt: new Date(),
      })
      .where(eq(committeeResolutionAuthorizations.id, id))
      .returning();
    return updated[0];
  }

  async getSignaturesByAuthId(authorizationId: string): Promise<CommitteeResolutionSignatureRow[]> {
    const db = getDb();
    return db
      .select()
      .from(committeeResolutionSignatures)
      .where(eq(committeeResolutionSignatures.authorizationId, authorizationId))
      .orderBy(committeeResolutionSignatures.createdAt);
  }

  async createSignature(row: NewCommitteeResolutionSignatureRow): Promise<CommitteeResolutionSignatureRow> {
    const db = getDb();
    const inserted = await db.insert(committeeResolutionSignatures).values(row).returning();
    return inserted[0];
  }

  async getSignerSignature(authorizationId: string, signerWallet: string): Promise<CommitteeResolutionSignatureRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(committeeResolutionSignatures)
      .where(
        and(
          eq(committeeResolutionSignatures.authorizationId, authorizationId),
          eq(committeeResolutionSignatures.signerWallet, signerWallet.toLowerCase())
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Orchestration & Coordination Services
// ---------------------------------------------------------------------------

/**
 * Creates an immutable EIP-712 committee authorization record for a canonical 3M-B report.
 * Requires fresh chain preflight and caller authorization as an active committee signer.
 */
export async function createCommitteeAuthorization(params: {
  reportId: string;
  callerWallet: string;
  resolutionNonce?: string | number | bigint;
  validUntilSeconds?: number | bigint;
  publicClient?: PublicClientLike;
  authRepo?: ICommitteeAuthorizationRepository;
  reportRepo?: IMilestoneResolutionReportRepository;
}): Promise<{
  authorization: CommitteeResolutionAuthorizationRow;
  typedData: Record<string, unknown>;
  typedDataHash: `0x${string}`;
}> {
  const { reportId, callerWallet } = params;

  if (!isAddress(callerWallet)) {
    throw new CommitteeAuthAuthError('Invalid caller wallet address');
  }

  const client = params.publicClient ?? sepoliaPublicClient;
  const authRepo = params.authRepo ?? new DrizzleCommitteeAuthorizationRepository();
  const reportRepo = params.reportRepo ?? new DrizzleMilestoneResolutionReportRepository();

  // 1. Fetch 3M-B Resolution Report
  const reportRow = await reportRepo.getById(reportId);
  if (!reportRow) {
    throw new CommitteeAuthValidationError(`Resolution report not found: ${reportId}`);
  }

  const phase = reportRow.phase as ResolutionReportPhase;
  const dealAddress = reportRow.dealAddress.toLowerCase() as `0x${string}`;
  const milestoneId = reportRow.milestoneId;

  // 2. Fresh Chain Preflight
  const isFactoryDeal = await isSynqV2Deal(dealAddress, client);
  if (!isFactoryDeal) {
    throw new CommitteeAuthValidationError('Deal is not registered with SynqFactoryV2');
  }

  let chainId: number | bigint = SEPOLIA_CHAIN_ID;
  if (typeof (client as any).getChainId === 'function') {
    try {
      chainId = await (client as any).getChainId();
    } catch {
      chainId = (client as any).chain?.id ?? SEPOLIA_CHAIN_ID;
    }
  } else if ((client as any).chain?.id) {
    chainId = (client as any).chain.id;
  }
  if (Number(chainId) !== SEPOLIA_CHAIN_ID) {
    throw new CommitteeAuthValidationError(`Chain mismatch: expected Sepolia (${SEPOLIA_CHAIN_ID}), got ${chainId}`);
  }

  const dealData = await readStandardV2DealData(dealAddress, client);

  if (dealData.isProtected) {
    throw new CommitteeAuthValidationError('Protected deals are not supported for Standard V2 committee resolution');
  }

  if (dealData.state !== DealState.Active) {
    throw new CommitteeAuthValidationError(`Deal is not Active (state: ${dealData.state})`);
  }

  const milestone = dealData.milestones[milestoneId];
  if (!milestone) {
    throw new CommitteeAuthValidationError(`Milestone ${milestoneId} not found on deal`);
  }

  // Snapshot integrity check against report
  if (milestone.version !== reportRow.submissionVersion) {
    throw new CommitteeAuthValidationError(
      `Snapshot version mismatch: milestone is version ${milestone.version}, report binds version ${reportRow.submissionVersion}`
    );
  }
  if (milestone.specHash.toLowerCase() !== reportRow.specHash.toLowerCase()) {
    throw new CommitteeAuthValidationError('Snapshot specHash mismatch between deal milestone and report');
  }
  if (milestone.evidenceRootHash.toLowerCase() !== reportRow.evidenceRootHash.toLowerCase()) {
    throw new CommitteeAuthValidationError('Snapshot evidenceRootHash mismatch between deal milestone and report');
  }

  const totalSplit = BigInt(reportRow.freelancerAmount) + BigInt(reportRow.clientAmount);
  if (milestone.amount !== totalSplit) {
    throw new CommitteeAuthValidationError(
      `Report split total (${totalSplit.toString()}) does not equal milestone amount (${milestone.amount.toString()})`
    );
  }

  // Phase-specific status check
  if (phase === 'INITIAL_RESOLUTION' && milestone.status !== MilestoneStatus.Disputed) {
    throw new CommitteeAuthValidationError(
      `Milestone is not in Disputed status (current status: ${milestone.status})`
    );
  }
  if (phase === 'FINAL_RESOLUTION' && milestone.status !== MilestoneStatus.FinalReview) {
    throw new CommitteeAuthValidationError(
      `Milestone is not in FinalReview status (current status: ${milestone.status})`
    );
  }

  // 3. Obtain Canonical Chain Timestamp — FAIL CLOSED
  if (typeof (client as any).getBlock !== 'function') {
    throw new CommitteeAuthIntegrityError(
      'PublicClient does not support getBlock. Canonical chain timestamp required; failing closed.'
    );
  }

  let chainTimestamp: bigint;
  try {
    const block = await (client as any).getBlock({ blockTag: 'latest' });
    chainTimestamp = BigInt(block.timestamp);
  } catch (err: any) {
    throw new CommitteeAuthIntegrityError(
      `Failed to query canonical chain block timestamp: ${err?.message || String(err)}. Failing closed.`
    );
  }

  // 4. Derive Authorized Committee & Verify Stored Report Committee
  let disputeOpenedAt = 0n;
  let storedResolver: string | null = null;

  if (phase === 'INITIAL_RESOLUTION') {
    disputeOpenedAt = await client.readContract({
      address: dealAddress,
      abi: synqDealV1ABI,
      functionName: 'milestoneDisputeOpenedAt',
      args: [BigInt(milestoneId)],
    }) as bigint;
  } else if (phase === 'FINAL_RESOLUTION') {
    const proposal = await client.readContract({
      address: dealAddress,
      abi: synqDealV1ABI,
      functionName: 'getResolutionProposal',
      args: [BigInt(milestoneId)],
    }) as any;
    storedResolver = proposal?.resolver ?? null;
  }

  const committeeDerivation = deriveAuthorizedCommittee({
    primaryResolver: dealData.primaryResolver,
    emergencyResolver: dealData.emergencyResolver,
    phase,
    milestoneDisputeOpenedAt: disputeOpenedAt,
    latestBlockTimestamp: chainTimestamp,
    storedResolutionResolver: storedResolver,
  });

  if (committeeDerivation.error || !committeeDerivation.authorizedCommittee) {
    throw new CommitteeAuthConflictError(
      committeeDerivation.error || 'Could not derive authorized resolution committee'
    );
  }

  const authorizedCommittee = committeeDerivation.authorizedCommittee.toLowerCase() as `0x${string}`;
  if (authorizedCommittee !== reportRow.committeeAddress.toLowerCase()) {
    throw new CommitteeAuthConflictError(
      `Report committee (${reportRow.committeeAddress}) does not match current authorized committee (${authorizedCommittee})`
    );
  }

  // 5. Verify Caller is Active Committee Signer
  const isSigner = await client.readContract({
    address: authorizedCommittee,
    abi: synqResolutionCommitteeReadABI,
    functionName: 'isSigner',
    args: [callerWallet as `0x${string}`],
  }) as boolean;

  if (!isSigner) {
    throw new CommitteeAuthAuthError(
      `Caller (${callerWallet}) is not an active signer on authorized committee (${authorizedCommittee})`
    );
  }

  // 6. Query Committee Epoch & Threshold
  const committeeEpoch = await client.readContract({
    address: authorizedCommittee,
    abi: synqResolutionCommitteeReadABI,
    functionName: 'committeeEpoch',
  }) as bigint;

  // 7. Nonce Allocation & Validation
  let resolutionNonce: bigint;
  if (params.resolutionNonce !== undefined) {
    resolutionNonce = BigInt(params.resolutionNonce);
    if (resolutionNonce < 0n || resolutionNonce > 18446744073709551615n) {
      throw new CommitteeAuthValidationError('resolutionNonce must be a valid uint64');
    }
  } else {
    // Propose an unused nonce starting at 1
    resolutionNonce = 1n;
    while (true) {
      const isUsed = await isNonceUsedOnChain({
        committeeAddress: authorizedCommittee,
        dealAddress,
        milestoneId,
        phase,
        nonce: resolutionNonce,
        publicClient: client,
      });
      if (!isUsed) break;
      resolutionNonce += 1n;
    }
  }

  // Check nonce is not used on-chain
  const nonceUsed = await isNonceUsedOnChain({
    committeeAddress: authorizedCommittee,
    dealAddress,
    milestoneId,
    phase,
    nonce: resolutionNonce,
    publicClient: client,
  });

  if (nonceUsed) {
    throw new CommitteeAuthConflictError(
      `Resolution nonce ${resolutionNonce.toString()} is already consumed on-chain for this deal milestone`
    );
  }

  // 8. Expiry Calculation
  const windowSeconds = params.validUntilSeconds ? BigInt(params.validUntilSeconds) : DEFAULT_AUTH_EXPIRATION_SECONDS;
  if (windowSeconds < 3600n || windowSeconds > 14n * 86400n) {
    throw new CommitteeAuthValidationError('validUntilSeconds must be between 1 hour and 14 days');
  }
  const validUntil = chainTimestamp + windowSeconds;
  if (validUntil > 18446744073709551615n) {
    throw new CommitteeAuthValidationError('validUntil exceeds uint64 boundary');
  }

  // 9. Build Exact Typed Data & Digest
  const authorizationType: CommitteeAuthorizationType =
    phase === 'INITIAL_RESOLUTION' ? 'ResolutionProposalAuth' : 'FinalResolutionAuth';

  const authData: ResolutionProposalAuthData | FinalResolutionAuthData = {
    committee: authorizedCommittee,
    chainId: BigInt(SEPOLIA_CHAIN_ID),
    deal: dealAddress,
    milestoneId: BigInt(milestoneId),
    freelancerAmount: BigInt(reportRow.freelancerAmount),
    clientAmount: BigInt(reportRow.clientAmount),
    justificationHash: reportRow.justificationHash.toLowerCase() as `0x${string}`,
    resolutionNonce,
    validUntil,
    evidenceRootHash: reportRow.evidenceRootHash.toLowerCase() as `0x${string}`,
    specHash: reportRow.specHash.toLowerCase() as `0x${string}`,
    submissionVersion: reportRow.submissionVersion,
  };

  let typedData: Record<string, unknown>;
  let typedDataHash: `0x${string}`;

  if (phase === 'INITIAL_RESOLUTION') {
    typedData = getResolutionProposalTypedData(authData) as unknown as Record<string, unknown>;
    typedDataHash = hashResolutionProposalAuth(authData);
  } else {
    typedData = getFinalResolutionTypedData(authData) as unknown as Record<string, unknown>;
    typedDataHash = hashFinalResolutionAuth(authData);
  }

  // 10. Persist Authorization Record
  const newRow: NewCommitteeResolutionAuthorizationRow = {
    reportId,
    chainId: SEPOLIA_CHAIN_ID,
    committeeAddress: authorizedCommittee,
    dealAddress,
    milestoneId,
    phase,
    authorizationType,
    resolutionNonce: resolutionNonce.toString(),
    validUntil: validUntil.toString(),
    committeeEpoch: committeeEpoch.toString(),
    submissionVersion: reportRow.submissionVersion,
    specHash: reportRow.specHash.toLowerCase(),
    evidenceRootHash: reportRow.evidenceRootHash.toLowerCase(),
    freelancerAmount: reportRow.freelancerAmount,
    clientAmount: reportRow.clientAmount,
    justificationHash: reportRow.justificationHash.toLowerCase(),
    typedData,
    typedDataHash: typedDataHash.toLowerCase(),
    status: 'collecting',
    createdBySigner: callerWallet.toLowerCase(),
  };

  const createdAuth = await authRepo.createAuth(newRow);

  return {
    authorization: createdAuth,
    typedData,
    typedDataHash,
  };
}

/**
 * Submits and verifies a committee signer's EIP-712 signature for an active authorization.
 * Re-checks fresh on-chain validity: active signer, current epoch, unused nonce, unexpired timestamp, and milestone status.
 */
export async function submitCommitteeSignature(params: {
  authorizationId: string;
  signature: string;
  callerWallet: string;
  publicClient?: PublicClientLike;
  authRepo?: ICommitteeAuthorizationRepository;
}): Promise<{
  signatureRow: CommitteeResolutionSignatureRow;
  authorization: CommitteeResolutionAuthorizationRow;
  thresholdReady: boolean;
}> {
  const { authorizationId, signature, callerWallet } = params;

  if (!isAddress(callerWallet)) {
    throw new CommitteeAuthAuthError('Invalid caller wallet address');
  }
  if (!signature || typeof signature !== 'string' || !signature.startsWith('0x')) {
    throw new CommitteeAuthValidationError('Invalid signature format: must be 0x-prefixed hex string');
  }

  const client = params.publicClient ?? sepoliaPublicClient;
  const authRepo = params.authRepo ?? new DrizzleCommitteeAuthorizationRepository();

  const auth = await authRepo.getAuthById(authorizationId);
  if (!auth) {
    throw new CommitteeAuthValidationError(`Authorization not found: ${authorizationId}`);
  }

  if (auth.status === 'executed') {
    throw new CommitteeAuthConflictError('Authorization is already executed (status: executed)');
  }

  if (auth.status !== 'collecting' && auth.status !== 'threshold_ready') {
    throw new CommitteeAuthConflictError(`Authorization is not in collecting state (status: ${auth.status})`);
  }

  // 1. Check Canonical Chain Timestamp — FAIL CLOSED
  if (typeof (client as any).getBlock !== 'function') {
    throw new CommitteeAuthIntegrityError(
      'PublicClient does not support getBlock. Canonical chain timestamp required; failing closed.'
    );
  }

  let chainTimestamp: bigint;
  try {
    const block = await (client as any).getBlock({ blockTag: 'latest' });
    chainTimestamp = BigInt(block.timestamp);
  } catch (err: any) {
    throw new CommitteeAuthIntegrityError(
      `Failed to query canonical chain block timestamp: ${err?.message || String(err)}. Failing closed.`
    );
  }

  // 2. Check Expiry against Chain Timestamp
  if (chainTimestamp > BigInt(auth.validUntil)) {
    await authRepo.updateAuthStatus(auth.id, 'expired');
    throw new CommitteeAuthExpiredError(
      `Authorization expired on-chain (validUntil: ${auth.validUntil}, currentChainTime: ${chainTimestamp.toString()})`
    );
  }

  // 3. Check Committee Epoch on-chain
  const currentEpoch = await client.readContract({
    address: auth.committeeAddress as `0x${string}`,
    abi: synqResolutionCommitteeReadABI,
    functionName: 'committeeEpoch',
  }) as bigint;

  if (currentEpoch !== BigInt(auth.committeeEpoch)) {
    await authRepo.updateAuthStatus(auth.id, 'invalidated');
    throw new CommitteeAuthInvalidatedError(
      `Committee epoch changed on-chain (auth epoch: ${auth.committeeEpoch}, current: ${currentEpoch.toString()})`
    );
  }

  // 4. Check Nonce on-chain
  const nonceUsed = await isNonceUsedOnChain({
    committeeAddress: auth.committeeAddress,
    dealAddress: auth.dealAddress,
    milestoneId: auth.milestoneId,
    phase: auth.phase,
    nonce: BigInt(auth.resolutionNonce),
    publicClient: client,
  });

  if (nonceUsed) {
    await authRepo.updateAuthStatus(auth.id, 'invalidated');
    throw new CommitteeAuthInvalidatedError(
      `Resolution nonce ${auth.resolutionNonce} has already been used on-chain`
    );
  }

  // 5. Check Milestone Status on-chain (race condition protection)
  const dealData = await readStandardV2DealData(auth.dealAddress as `0x${string}`, client);
  const milestone = dealData.milestones[auth.milestoneId];
  if (!milestone) {
    throw new CommitteeAuthIntegrityError('Milestone not found on deal');
  }

  if (auth.phase === 'INITIAL_RESOLUTION' && milestone.status !== MilestoneStatus.Disputed) {
    await authRepo.updateAuthStatus(auth.id, 'invalidated');
    throw new CommitteeAuthInvalidatedError(
      `Milestone is no longer in Disputed status (current: ${milestone.status})`
    );
  }
  if (auth.phase === 'FINAL_RESOLUTION' && milestone.status !== MilestoneStatus.FinalReview) {
    await authRepo.updateAuthStatus(auth.id, 'invalidated');
    throw new CommitteeAuthInvalidatedError(
      `Milestone is no longer in FinalReview status (current: ${milestone.status})`
    );
  }

  // 6. Verify Caller is currently an active signer on committee
  const isSigner = await client.readContract({
    address: auth.committeeAddress as `0x${string}`,
    abi: synqResolutionCommitteeReadABI,
    functionName: 'isSigner',
    args: [callerWallet as `0x${string}`],
  }) as boolean;

  if (!isSigner) {
    throw new CommitteeAuthAuthError(
      `Caller (${callerWallet}) is not an active signer on committee (${auth.committeeAddress})`
    );
  }

  // 7. Check Existing Signature Immutability
  const existingSig = await authRepo.getSignerSignature(auth.id, callerWallet);
  if (existingSig) {
    if (existingSig.signature.toLowerCase() === signature.toLowerCase()) {
      const allSigs = await authRepo.getSignaturesByAuthId(auth.id);
      return {
        signatureRow: existingSig,
        authorization: auth,
        thresholdReady: allSigs.length >= Number(COMMITTEE_THRESHOLD) && auth.status === 'threshold_ready',
      };
    } else {
      // Same signer + DIFFERENT signature for same authorization: REJECT
      throw new CommitteeAuthConflictError(
        `Signer (${callerWallet}) has already submitted an immutable signature for authorization (${auth.id}). Signature cannot be replaced or updated.`
      );
    }
  }

  // 8. Verify EIP-712 Signature (only when no signature exists yet)
  const typedData = auth.typedData as any;
  const verification = await verifyCommitteeSignerSignature({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
    signature: signature as `0x${string}`,
    expectedSigner: callerWallet,
  });

  if (!verification.valid || !verification.recoveredSigner) {
    throw new CommitteeAuthValidationError(
      verification.error || 'Cryptographic signature verification failed'
    );
  }

  const savedSig = await authRepo.createSignature({
    authorizationId: auth.id,
    signerWallet: callerWallet.toLowerCase(),
    signature: signature.toLowerCase(),
    createdAt: new Date(),
  });

  // 9. Evaluate Threshold Consensus
  const allSigs = await authRepo.getSignaturesByAuthId(auth.id);
  const activeSignerSigs: CommitteeResolutionSignatureRow[] = [];

  for (const s of allSigs) {
    const active = await client.readContract({
      address: auth.committeeAddress as `0x${string}`,
      abi: synqResolutionCommitteeReadABI,
      functionName: 'isSigner',
      args: [s.signerWallet as `0x${string}`],
    }).catch(() => false);

    if (active) {
      activeSignerSigs.push(s);
    }
  }

  let updatedAuth = auth;
  const thresholdMet = activeSignerSigs.length >= Number(COMMITTEE_THRESHOLD);

  if (thresholdMet && auth.status === 'collecting') {
    updatedAuth = await authRepo.updateAuthStatus(auth.id, 'threshold_ready');
  }

  return {
    signatureRow: savedSig,
    authorization: updatedAuth,
    thresholdReady: thresholdMet,
  };
}

/**
 * Retrieves authorization coordination data with strict committee privacy.
 */
export async function getCommitteeAuthorization(params: {
  authorizationId: string;
  callerWallet: string;
  publicClient?: PublicClientLike;
  authRepo?: ICommitteeAuthorizationRepository;
}): Promise<{
  authorization: CommitteeResolutionAuthorizationRow;
  signatures: CommitteeResolutionSignatureRow[];
  thresholdReady: boolean;
}> {
  const { authorizationId, callerWallet } = params;

  if (!isAddress(callerWallet)) {
    throw new CommitteeAuthAuthError('Invalid caller wallet address');
  }

  const client = params.publicClient ?? sepoliaPublicClient;
  const authRepo = params.authRepo ?? new DrizzleCommitteeAuthorizationRepository();

  const auth = await authRepo.getAuthById(authorizationId);
  if (!auth) {
    throw new CommitteeAuthValidationError(`Authorization not found: ${authorizationId}`);
  }

  const isSigner = await client.readContract({
    address: auth.committeeAddress as `0x${string}`,
    abi: synqResolutionCommitteeReadABI,
    functionName: 'isSigner',
    args: [callerWallet as `0x${string}`],
  }).catch(() => false);

  // Check if caller is historical participating signer
  const existingSig = await authRepo.getSignerSignature(auth.id, callerWallet);
  const hasHistoricalAccess = Boolean(existingSig);

  if (!isSigner && !hasHistoricalAccess) {
    throw new CommitteeAuthAuthError('Unauthorized: caller is not an authorized committee signer');
  }

  const signatures = await authRepo.getSignaturesByAuthId(auth.id);
  const thresholdReady = signatures.length >= Number(COMMITTEE_THRESHOLD) && auth.status === 'threshold_ready';

  return {
    authorization: auth,
    signatures,
    thresholdReady,
  };
}

/**
 * Exports a verified 2-of-3 threshold signature bundle ready for future on-chain submission.
 * Freshly preflights all on-chain conditions (chain time, epoch, nonce, deal/milestone status,
 * committee authority, and cryptographic signature validity).
 *
 * threshold_ready in DB is merely a coordination/cache state.
 * Fresh on-chain preflight and cryptographic reverification are authoritative.
 */
export async function getVerifiedThresholdBundle(params: {
  authorizationId: string;
  callerWallet: string;
  publicClient?: PublicClientLike;
  authRepo?: ICommitteeAuthorizationRepository;
  reportRepo?: IMilestoneResolutionReportRepository;
}): Promise<VerifiedThresholdBundle> {
  const { authorizationId, callerWallet } = params;

  if (!isAddress(callerWallet)) {
    throw new CommitteeAuthAuthError('Invalid caller wallet address');
  }

  const client = params.publicClient ?? sepoliaPublicClient;
  const authRepo = params.authRepo ?? new DrizzleCommitteeAuthorizationRepository();

  const auth = await authRepo.getAuthById(authorizationId);
  if (!auth) {
    throw new CommitteeAuthValidationError(`Authorization not found: ${authorizationId}`);
  }

  if (auth.status === 'executed') {
    throw new CommitteeAuthConflictError('Authorization is already executed (status: executed)');
  }

  // 1. Check Caller is an active signer on the authorized committee
  const isCallerSigner = await client.readContract({
    address: auth.committeeAddress as `0x${string}`,
    abi: synqResolutionCommitteeReadABI,
    functionName: 'isSigner',
    args: [callerWallet as `0x${string}`],
  }).catch(() => false);

  if (!isCallerSigner) {
    throw new CommitteeAuthAuthError('Unauthorized: caller is not an active committee signer');
  }

  // 2. Canonical Chain Timestamp — FAIL CLOSED (strictly no Date.now/wall-clock fallback)
  if (typeof (client as any).getBlock !== 'function') {
    throw new CommitteeAuthIntegrityError(
      'PublicClient does not support getBlock. Canonical chain timestamp required; failing closed.'
    );
  }

  let chainTimestamp: bigint;
  try {
    const block = await (client as any).getBlock({ blockTag: 'latest' });
    chainTimestamp = BigInt(block.timestamp);
  } catch (err: any) {
    throw new CommitteeAuthIntegrityError(
      `Failed to query canonical chain block timestamp: ${err?.message || String(err)}. Failing closed.`
    );
  }

  // 3. Exact Expiry Boundary: block.timestamp <= validUntil is valid; > validUntil is expired
  if (chainTimestamp > BigInt(auth.validUntil)) {
    await authRepo.updateAuthStatus(auth.id, 'expired');
    throw new CommitteeAuthExpiredError(
      `Authorization expired on-chain (validUntil: ${auth.validUntil}, currentChainTime: ${chainTimestamp.toString()})`
    );
  }

  // 4. Committee Epoch Revalidation
  const currentEpoch = await client.readContract({
    address: auth.committeeAddress as `0x${string}`,
    abi: synqResolutionCommitteeReadABI,
    functionName: 'committeeEpoch',
  }) as bigint;

  if (currentEpoch !== BigInt(auth.committeeEpoch)) {
    await authRepo.updateAuthStatus(auth.id, 'invalidated');
    throw new CommitteeAuthInvalidatedError(
      `Committee epoch changed on-chain (auth epoch: ${auth.committeeEpoch}, current: ${currentEpoch.toString()})`
    );
  }

  // 5. Resolution Nonce Revalidation
  const nonceUsed = await isNonceUsedOnChain({
    committeeAddress: auth.committeeAddress,
    dealAddress: auth.dealAddress,
    milestoneId: auth.milestoneId,
    phase: auth.phase,
    nonce: BigInt(auth.resolutionNonce),
    publicClient: client,
  });

  if (nonceUsed) {
    await authRepo.updateAuthStatus(auth.id, 'invalidated');
    throw new CommitteeAuthInvalidatedError(
      `Resolution nonce ${auth.resolutionNonce} has already been used on-chain`
    );
  }

  // 6. Deal Registration & State Preflight
  const isFactoryDeal = await isSynqV2Deal(auth.dealAddress, client);
  if (!isFactoryDeal) {
    throw new CommitteeAuthValidationError('Deal is not registered with SynqFactoryV2');
  }

  const dealData = await readStandardV2DealData(auth.dealAddress as `0x${string}`, client);
  if (dealData.state !== DealState.Active) {
    await authRepo.updateAuthStatus(auth.id, 'invalidated');
    throw new CommitteeAuthInvalidatedError(`Deal is not Active (state: ${dealData.state})`);
  }

  // 7. Milestone State Revalidation
  const milestone = dealData.milestones[auth.milestoneId];
  if (!milestone) {
    throw new CommitteeAuthIntegrityError(`Milestone ${auth.milestoneId} not found on deal`);
  }

  if (auth.phase === 'INITIAL_RESOLUTION' && milestone.status !== MilestoneStatus.Disputed) {
    await authRepo.updateAuthStatus(auth.id, 'invalidated');
    throw new CommitteeAuthInvalidatedError(
      `Milestone is no longer in Disputed status (current: ${milestone.status})`
    );
  }

  if (auth.phase === 'FINAL_RESOLUTION' && milestone.status !== MilestoneStatus.FinalReview) {
    await authRepo.updateAuthStatus(auth.id, 'invalidated');
    throw new CommitteeAuthInvalidatedError(
      `Milestone is no longer in FinalReview status (current: ${milestone.status})`
    );
  }

  // 8. Committee Authority Revalidation (INITIAL 14-day boundary vs FINAL resolver stability)
  if (auth.phase === 'INITIAL_RESOLUTION') {
    const disputeOpenedAt = await client.readContract({
      address: auth.dealAddress as `0x${string}`,
      abi: synqDealV1ABI,
      functionName: 'milestoneDisputeOpenedAt',
      args: [BigInt(auth.milestoneId)],
    }) as bigint;

    const committeeDerivation = deriveAuthorizedCommittee({
      primaryResolver: dealData.primaryResolver,
      emergencyResolver: dealData.emergencyResolver,
      phase: auth.phase,
      milestoneDisputeOpenedAt: disputeOpenedAt,
      latestBlockTimestamp: chainTimestamp,
    });

    if (
      !committeeDerivation.authorizedCommittee ||
      committeeDerivation.authorizedCommittee.toLowerCase() !== auth.committeeAddress.toLowerCase()
    ) {
      await authRepo.updateAuthStatus(auth.id, 'invalidated');
      throw new CommitteeAuthInvalidatedError(
        `Initial resolution committee authority expired or switched at 14-day dispute boundary (openedAt: ${disputeOpenedAt}, chainTime: ${chainTimestamp}). Deal now requires emergency resolver.`
      );
    }
  } else if (auth.phase === 'FINAL_RESOLUTION') {
    const proposal = await client.readContract({
      address: auth.dealAddress as `0x${string}`,
      abi: synqDealV1ABI,
      functionName: 'getResolutionProposal',
      args: [BigInt(auth.milestoneId)],
    }) as any;

    const storedResolver = (proposal?.resolver ?? '').toLowerCase();
    if (!storedResolver || storedResolver !== auth.committeeAddress.toLowerCase()) {
      await authRepo.updateAuthStatus(auth.id, 'invalidated');
      throw new CommitteeAuthInvalidatedError(
        `Final resolution must be resolved by stored proposal resolver (${storedResolver}), not ${auth.committeeAddress}`
      );
    }
  }

  // 9. Report Binding Revalidation (if reportRepo is supplied)
  if (params.reportRepo) {
    const reportRow = await params.reportRepo.getById(auth.reportId);
    if (reportRow) {
      if (
        reportRow.justificationHash.toLowerCase() !== auth.justificationHash.toLowerCase() ||
        reportRow.freelancerAmount !== auth.freelancerAmount ||
        reportRow.clientAmount !== auth.clientAmount ||
        reportRow.dealAddress.toLowerCase() !== auth.dealAddress.toLowerCase() ||
        reportRow.milestoneId !== auth.milestoneId ||
        reportRow.phase !== auth.phase
      ) {
        await authRepo.updateAuthStatus(auth.id, 'invalidated');
        throw new CommitteeAuthIntegrityError(
          'Canonical resolution report fields mismatch stored authorization'
        );
      }
    }
  }

  // 10. Stored Typed Data & Digest Integrity Check
  const typedData = auth.typedData as any;
  if (!typedData || !typedData.domain || !typedData.types || !typedData.message) {
    throw new CommitteeAuthIntegrityError('Malformed typedData in stored authorization record');
  }

  const recomputedDigest = hashTypedData({
    domain: typedData.domain,
    types: typedData.types as any,
    primaryType: typedData.primaryType as any,
    message: typedData.message as any,
  });

  if (recomputedDigest.toLowerCase() !== auth.typedDataHash.toLowerCase()) {
    throw new CommitteeAuthIntegrityError(
      `Stored typed_data does not match stored typed_data_hash: expected ${auth.typedDataHash}, got ${recomputedDigest}`
    );
  }

  // 11. Signatures Cryptographic Reverification & Fresh Active Signer Check
  const rawSignatures = await authRepo.getSignaturesByAuthId(auth.id);
  const verifiedActiveSignatures: Array<{ signerWallet: string; signature: string }> = [];
  const seenSigners = new Set<string>();

  for (const sig of rawSignatures) {
    const signerLower = sig.signerWallet.toLowerCase();
    if (seenSigners.has(signerLower)) {
      continue;
    }

    // Fresh active check
    const isStillSigner = await client.readContract({
      address: auth.committeeAddress as `0x${string}`,
      abi: synqResolutionCommitteeReadABI,
      functionName: 'isSigner',
      args: [sig.signerWallet as `0x${string}`],
    }) as boolean;

    if (!isStillSigner) {
      continue; // Signer rotated out
    }

    // Cryptographic reverification against exact stored typed data
    const reverify = await verifyCommitteeSignerSignature({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature: sig.signature as `0x${string}`,
      expectedSigner: sig.signerWallet,
    });

    if (!reverify.valid || reverify.recoveredSigner?.toLowerCase() !== signerLower) {
      throw new CommitteeAuthIntegrityError(
        `Stored signature for signer ${sig.signerWallet} failed cryptographic reverification`
      );
    }

    seenSigners.add(signerLower);
    verifiedActiveSignatures.push({
      signerWallet: signerLower,
      signature: sig.signature,
    });
  }

  if (verifiedActiveSignatures.length < Number(COMMITTEE_THRESHOLD)) {
    throw new CommitteeAuthConflictError(
      `Threshold not reached: only ${verifiedActiveSignatures.length} / ${COMMITTEE_THRESHOLD.toString()} valid active signatures available`
    );
  }

  return buildVerifiedThresholdBundle({
    authorizationId: auth.id,
    reportId: auth.reportId,
    phase: auth.phase,
    authorizationType: auth.authorizationType,
    committeeAddress: auth.committeeAddress as `0x${string}`,
    dealAddress: auth.dealAddress as `0x${string}`,
    milestoneId: auth.milestoneId,
    auth: {
      committee: auth.committeeAddress as `0x${string}`,
      chainId: BigInt(auth.chainId),
      deal: auth.dealAddress as `0x${string}`,
      milestoneId: BigInt(auth.milestoneId),
      freelancerAmount: BigInt(auth.freelancerAmount),
      clientAmount: BigInt(auth.clientAmount),
      justificationHash: auth.justificationHash as `0x${string}`,
      resolutionNonce: BigInt(auth.resolutionNonce),
      validUntil: BigInt(auth.validUntil),
      evidenceRootHash: auth.evidenceRootHash as `0x${string}`,
      specHash: auth.specHash as `0x${string}`,
      submissionVersion: auth.submissionVersion,
    },
    typedDataHash: auth.typedDataHash as `0x${string}`,
    verifiedSignatures: verifiedActiveSignatures,
  });
}

// ---------------------------------------------------------------------------
// Phase 3M-E: Server Transaction Preparation
// ---------------------------------------------------------------------------

/**
 * Prepares verified execution transaction parameters for an active committee signer.
 * Consumes getVerifiedThresholdBundle, reads canonical chain time fail-closed,
 * and computes advisory buffers.
 */
export async function prepareCommitteeExecutionTransaction(params: {
  authorizationId: string;
  callerWallet: string;
  publicClient?: PublicClientLike;
  authRepo?: ICommitteeAuthorizationRepository;
  reportRepo?: IMilestoneResolutionReportRepository;
}): Promise<CommitteeExecutionTransactionRequest> {
  const client = params.publicClient ?? sepoliaPublicClient;
  const bundle = await getVerifiedThresholdBundle(params);

  // Canonical Chain Timestamp — FAIL CLOSED
  if (typeof (client as any).getBlock !== 'function') {
    throw new CommitteeAuthIntegrityError(
      'PublicClient does not support getBlock. Canonical chain timestamp required; failing closed.'
    );
  }

  let chainTimestamp: bigint;
  try {
    const block = await (client as any).getBlock({ blockTag: 'latest' });
    chainTimestamp = BigInt(block.timestamp);
  } catch (err: any) {
    throw new CommitteeAuthIntegrityError(
      `Failed to query canonical chain block timestamp: ${err?.message || String(err)}. Failing closed.`
    );
  }

  let disputeOpenedAt: bigint | undefined;
  if (bundle.phase === 'INITIAL_RESOLUTION') {
    try {
      const openedAt = await client.readContract({
        address: bundle.dealAddress,
        abi: synqDealV1ABI,
        functionName: 'milestoneDisputeOpenedAt',
        args: [BigInt(bundle.milestoneId)],
      });
      disputeOpenedAt = BigInt(openedAt as any);
    } catch {
      disputeOpenedAt = undefined;
    }
  }

  return formatCommitteeExecutionTransaction({
    bundle,
    latestBlockTimestamp: chainTimestamp,
    disputeOpenedAt,
  });
}

// ---------------------------------------------------------------------------
// Phase 3M-E: Authorization Reconciliation & Crash Recovery
// ---------------------------------------------------------------------------

/**
 * Reconciles committee resolution execution against on-chain receipts and canonical storage.
 *
 * Requirements:
 * - Access: Active committee signer OR deal participant (client / freelancer).
 * - Exact receipt proof: Committee event + Deal consequence event + SettlementType check.
 * - Exact fresh storage proof: Deal milestone status, proposal storage, nonce consumed on committee.
 * - Idempotent: Same txHash returns executed record cleanly; conflicting txHash rejected.
 * - Atomic ordering: Reconciles 3M-B report first; only then marks authorization executed.
 * - Crash recovery: If txHash is omitted, searches unique canonical events on committee.
 */
export async function reconcileCommitteeAuthorization(params: {
  authorizationId: string;
  callerWallet: string;
  txHash?: string;
  publicClient?: PublicClientLike;
  authRepo?: ICommitteeAuthorizationRepository;
  reportRepo?: IMilestoneResolutionReportRepository;
}): Promise<{
  authorization: CommitteeResolutionAuthorizationRow;
  report: any;
  executionTxHash: string;
  executedByWallet: string | null;
  executedAt: Date | null;
  alreadyExecuted?: boolean;
}> {
  const { authorizationId, callerWallet, txHash } = params;

  if (!isAddress(callerWallet)) {
    throw new CommitteeAuthAuthError('Invalid caller wallet address');
  }

  const client = params.publicClient ?? sepoliaPublicClient;
  const authRepo = params.authRepo ?? new DrizzleCommitteeAuthorizationRepository();
  const reportRepo = params.reportRepo ?? new DrizzleMilestoneResolutionReportRepository();

  const auth = await authRepo.getAuthById(authorizationId);
  if (!auth) {
    throw new CommitteeAuthValidationError(`Authorization not found: ${authorizationId}`);
  }

  // Caller access policy: active committee signer on committee contract OR deal participant
  const isCallerSigner = await client.readContract({
    address: auth.committeeAddress as `0x${string}`,
    abi: synqResolutionCommitteeReadABI,
    functionName: 'isSigner',
    args: [callerWallet as `0x${string}`],
  }).catch(() => false);

  const dealData = await readStandardV2DealData(auth.dealAddress as `0x${string}`, client);
  const isParticipant =
    callerWallet.toLowerCase() === dealData.client.toLowerCase() ||
    callerWallet.toLowerCase() === dealData.freelancer.toLowerCase();

  if (!isCallerSigner && !isParticipant) {
    throw new CommitteeAuthAuthError(
      'Unauthorized: caller is neither an active committee signer nor a deal participant'
    );
  }

  // Idempotency: If already executed
  if (auth.status === 'executed') {
    if (txHash && auth.executionTxHash && auth.executionTxHash.toLowerCase() !== txHash.toLowerCase()) {
      throw new CommitteeAuthConflictError(
        `Authorization is already executed with a different transaction hash (${auth.executionTxHash})`
      );
    }
    const reportRow = await reportRepo.getById(auth.reportId);
    return {
      authorization: auth,
      report: reportRow?.canonicalReport ?? null,
      executionTxHash: auth.executionTxHash!,
      executedByWallet: auth.executedByWallet,
      executedAt: auth.executedAt,
      alreadyExecuted: true,
    };
  }

  if (auth.status !== 'threshold_ready' && auth.status !== 'collecting') {
    throw new CommitteeAuthConflictError(
      `Cannot reconcile execution for authorization in status: ${auth.status}`
    );
  }

  let verifiedTxHash: string;
  let receipt: any;

  if (txHash) {
    if (typeof (client as any).getTransactionReceipt !== 'function') {
      throw new CommitteeExecutionReceiptError('PublicClient does not support getTransactionReceipt');
    }
    receipt = await (client as any).getTransactionReceipt({ hash: txHash as `0x${string}` });
    if (!receipt) {
      throw new CommitteeExecutionReceiptError(`Transaction receipt not found for txHash: ${txHash}`);
    }
    const isSuccess = receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1';
    if (!isSuccess) {
      throw new CommitteeExecutionReceiptError('Transaction reverted on-chain');
    }
    if (receipt.to && receipt.to.toLowerCase() !== auth.committeeAddress.toLowerCase()) {
      throw new CommitteeExecutionReceiptError(
        `Transaction target mismatch: expected committee ${auth.committeeAddress}, received ${receipt.to}`
      );
    }
    verifiedTxHash = txHash;
  } else {
    // Event-based Crash Recovery (no txHash supplied)
    if (typeof (client as any).getLogs !== 'function') {
      throw new CommitteeExecutionRecoveryError('PublicClient does not support getLogs');
    }

    const eventName =
      auth.phase === 'INITIAL_RESOLUTION'
        ? 'ResolutionProposalSubmitted'
        : 'FinalResolutionSubmitted';

    const logs = await (client as any).getLogs({
      address: auth.committeeAddress as `0x${string}`,
      event: {
        type: 'event',
        name: eventName,
        inputs: [
          { indexed: true, name: 'deal', type: 'address' },
          { indexed: true, name: 'milestoneId', type: 'uint256' },
          { indexed: false, name: 'freelancerAmount', type: 'uint256' },
          { indexed: false, name: 'clientAmount', type: 'uint256' },
          { indexed: false, name: 'justificationHash', type: 'bytes32' },
          { indexed: false, name: 'resolutionNonce', type: 'uint64' },
        ],
      },
      args: {
        deal: auth.dealAddress as `0x${string}`,
        milestoneId: BigInt(auth.milestoneId),
      },
    });

    const expectedFreelancerAmount = BigInt(auth.freelancerAmount);
    const expectedClientAmount = BigInt(auth.clientAmount);
    const expectedHash = auth.justificationHash.toLowerCase();
    const expectedNonce = BigInt(auth.resolutionNonce);

    const matching = logs.filter((l: any) => {
      const args = l.args;
      return (
        BigInt(args.freelancerAmount) === expectedFreelancerAmount &&
        BigInt(args.clientAmount) === expectedClientAmount &&
        String(args.justificationHash).toLowerCase() === expectedHash &&
        BigInt(args.resolutionNonce) === expectedNonce
      );
    });

    if (matching.length === 0) {
      throw new CommitteeExecutionRecoveryError(
        `Crash recovery failed: zero matching ${eventName} events found on-chain`
      );
    }
    if (matching.length > 1) {
      throw new CommitteeExecutionRecoveryError(
        `Crash recovery failed: ambiguous multiple matching ${eventName} events found`
      );
    }

    verifiedTxHash = matching[0].transactionHash;
    if (typeof (client as any).getTransactionReceipt !== 'function') {
      throw new CommitteeExecutionReceiptError('PublicClient does not support getTransactionReceipt');
    }
    receipt = await (client as any).getTransactionReceipt({ hash: verifiedTxHash as `0x${string}` });
    if (!receipt) {
      throw new CommitteeExecutionReceiptError(
        `Transaction receipt not found for recovered transaction: ${verifiedTxHash}`
      );
    }
  }

  // Exact Receipt Verification
  if (auth.phase === 'INITIAL_RESOLUTION') {
    const vResult = verifyCommitteeResolutionProposalReceipt({
      receipt,
      committeeAddress: auth.committeeAddress,
      dealAddress: auth.dealAddress,
      expectedMilestoneId: BigInt(auth.milestoneId),
      expectedFreelancerAmount: BigInt(auth.freelancerAmount),
      expectedClientAmount: BigInt(auth.clientAmount),
      expectedJustificationHash: auth.justificationHash,
      expectedNonce: BigInt(auth.resolutionNonce),
    });

    if (!vResult.valid) {
      throw new CommitteeExecutionReceiptError(
        vResult.error || 'Failed to verify initial resolution execution receipt'
      );
    }

    // Fresh on-chain state verification
    const milestone = dealData.milestones[auth.milestoneId];
    if (milestone.status !== MilestoneStatus.ResolutionProposed) {
      throw new CommitteeExecutionReceiptError(
        `On-chain milestone status is ${milestone.status}, expected ResolutionProposed (5)`
      );
    }

    const proposal = await client.readContract({
      address: auth.dealAddress as `0x${string}`,
      abi: synqDealV1ABI,
      functionName: 'getResolutionProposal',
      args: [BigInt(auth.milestoneId)],
    }) as any;

    if (proposal.justificationHash.toLowerCase() !== auth.justificationHash.toLowerCase()) {
      throw new CommitteeExecutionReceiptError(
        `On-chain proposal justificationHash mismatch: expected ${auth.justificationHash}, got ${proposal.justificationHash}`
      );
    }
    if (
      BigInt(proposal.freelancerAmount) !== BigInt(auth.freelancerAmount) ||
      BigInt(proposal.clientAmount) !== BigInt(auth.clientAmount)
    ) {
      throw new CommitteeExecutionReceiptError('On-chain proposal split amounts mismatch');
    }
    if (proposal.resolver.toLowerCase() !== auth.committeeAddress.toLowerCase()) {
      throw new CommitteeExecutionReceiptError(
        `On-chain proposal resolver mismatch: expected ${auth.committeeAddress}, got ${proposal.resolver}`
      );
    }

    // Nonce proof
    const nonceUsed = await isNonceUsedOnChain({
      committeeAddress: auth.committeeAddress,
      dealAddress: auth.dealAddress,
      milestoneId: auth.milestoneId,
      phase: auth.phase,
      nonce: BigInt(auth.resolutionNonce),
      publicClient: client,
    });
    if (!nonceUsed) {
      throw new CommitteeExecutionReceiptError(
        `On-chain resolution proposal nonce ${auth.resolutionNonce} was not consumed`
      );
    }
  } else if (auth.phase === 'FINAL_RESOLUTION') {
    const vResult = verifyCommitteeFinalResolutionReceipt({
      receipt,
      committeeAddress: auth.committeeAddress,
      dealAddress: auth.dealAddress,
      expectedMilestoneId: BigInt(auth.milestoneId),
      expectedFreelancerAmount: BigInt(auth.freelancerAmount),
      expectedClientAmount: BigInt(auth.clientAmount),
      expectedJustificationHash: auth.justificationHash,
      expectedNonce: BigInt(auth.resolutionNonce),
    });

    if (!vResult.valid) {
      throw new CommitteeExecutionReceiptError(
        vResult.error || 'Failed to verify final resolution execution receipt'
      );
    }

    // Fresh on-chain state verification
    const milestone = dealData.milestones[auth.milestoneId];
    if (milestone.status !== MilestoneStatus.SettledSplit) {
      throw new CommitteeExecutionReceiptError(
        `On-chain milestone status is ${milestone.status}, expected SettledSplit (9)`
      );
    }

    // Nonce proof
    const nonceUsed = await isNonceUsedOnChain({
      committeeAddress: auth.committeeAddress,
      dealAddress: auth.dealAddress,
      milestoneId: auth.milestoneId,
      phase: auth.phase,
      nonce: BigInt(auth.resolutionNonce),
      publicClient: client,
    });
    if (!nonceUsed) {
      throw new CommitteeExecutionReceiptError(
        `On-chain final resolution nonce ${auth.resolutionNonce} was not consumed`
      );
    }
  }

  // Metadata derivations
  const executedByWallet =
    receipt.from && isAddress(receipt.from) ? (receipt.from.toLowerCase() as string) : null;

  let executedAt: Date | null = null;
  if (receipt.blockNumber !== undefined && typeof (client as any).getBlock === 'function') {
    try {
      const block = await (client as any).getBlock({ blockNumber: receipt.blockNumber });
      executedAt = new Date(Number(block.timestamp) * 1000);
    } catch {
      executedAt = null;
    }
  }

  // Atomicity Ordering:
  // Reconcile 3M-B canonical report FIRST.
  // If report reconciliation fails, authorization status remains untouched.
  // If authorization update fails after report confirms, retry is safe and idempotent.
  const reconciledReport = await reconcileResolutionReport({
    dealAddress: auth.dealAddress,
    milestoneId: auth.milestoneId,
    callerWallet,
    phase: auth.phase,
    txHash: verifiedTxHash,
    publicClient: client,
    repo: reportRepo,
  });

  const updatedAuth = await authRepo.updateAuthExecution(auth.id, {
    executionTxHash: verifiedTxHash,
    executedByWallet,
    executedAt,
    status: 'executed',
  });

  return {
    authorization: updatedAuth,
    report: reconciledReport.report,
    executionTxHash: verifiedTxHash,
    executedByWallet,
    executedAt,
  };
}
