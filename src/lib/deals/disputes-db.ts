import { isAddress, getAddress, decodeEventLog } from 'viem';
import { getDb } from '@/db';
import {
  milestoneDisputes,
  milestoneResolutionReports,
  type MilestoneDisputeRow,
  type NewMilestoneDisputeRow,
} from '@/db/schema';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import {
  readStandardV2DealData,
  readResolutionProposal,
  DealState,
  MilestoneStatus,
  type PublicClientLike,
} from '@/lib/deals/v2-deal';
import {
  deriveAuthorizedCommittee,
  synqResolutionCommitteeReadABI,
} from '@/lib/deals/v2-resolution-report';
import {
  normalizeSeriousDisputeManifest,
  hashSeriousDisputeManifest,
  verifySeriousDisputeOpenedReceipt,
  determineSeriousDisputeEligibility,
  type CanonicalSeriousDisputeManifestV1,
  DisputeValidationError,
} from '@/lib/deals/v2-dispute';
import { synqDealV1ABI } from '@/lib/contracts/abis';
import { sepoliaPublicClient } from '@/lib/chain';
import { and, eq } from 'drizzle-orm';

export class DisputeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisputeAuthError';
  }
}

export class DisputeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisputeConflictError';
  }
}

export class DisputeIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisputeIntegrityError';
  }
}

export { DisputeValidationError };

// ---------------------------------------------------------------------------
// Repository Pattern for Isolation and Testing
// ---------------------------------------------------------------------------

export interface IMilestoneDisputeRepository {
  getByMilestone(
    chainId: number,
    dealAddress: string,
    milestoneId: number
  ): Promise<MilestoneDisputeRow | null>;

  create(row: NewMilestoneDisputeRow): Promise<MilestoneDisputeRow>;

  updateStaged(
    id: string,
    data: {
      reasonHash: string;
      canonicalManifest: Record<string, unknown>;
      submissionVersion: number;
      specHash: string;
      evidenceRootHash: string;
      updatedAt: Date;
    }
  ): Promise<MilestoneDisputeRow>;

  confirm(
    id: string,
    data: {
      txHash: string | null;
      openedAt: Date;
      updatedAt: Date;
    }
  ): Promise<MilestoneDisputeRow>;
}

export class DrizzleMilestoneDisputeRepository implements IMilestoneDisputeRepository {
  async getByMilestone(
    chainId: number,
    dealAddress: string,
    milestoneId: number
  ): Promise<MilestoneDisputeRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(milestoneDisputes)
      .where(
        and(
          eq(milestoneDisputes.chainId, chainId),
          eq(milestoneDisputes.dealAddress, dealAddress.toLowerCase()),
          eq(milestoneDisputes.milestoneId, milestoneId)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async create(row: NewMilestoneDisputeRow): Promise<MilestoneDisputeRow> {
    const db = getDb();
    const inserted = await db.insert(milestoneDisputes).values(row).returning();
    return inserted[0];
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
    const db = getDb();
    const updated = await db
      .update(milestoneDisputes)
      .set(data)
      .where(eq(milestoneDisputes.id, id))
      .returning();
    return updated[0];
  }

  async confirm(
    id: string,
    data: {
      txHash: string | null;
      openedAt: Date;
      updatedAt: Date;
    }
  ): Promise<MilestoneDisputeRow> {
    const db = getDb();
    const updated = await db
      .update(milestoneDisputes)
      .set({
        status: 'confirmed',
        txHash: data.txHash,
        openedAt: data.openedAt,
        updatedAt: data.updatedAt,
      })
      .where(eq(milestoneDisputes.id, id))
      .returning();
    return updated[0];
  }
}

// ---------------------------------------------------------------------------
// Business Logic Functions
// ---------------------------------------------------------------------------

export interface StageMilestoneDisputeParams {
  chainId?: number;
  dealAddress: string;
  milestoneId: number;
  callerWallet: string;
  explanation: string;
  category?: string;
  links?: unknown[];
  publicClient?: PublicClientLike;
  repo?: IMilestoneDisputeRepository;
}

/**
 * Stages a canonical serious dispute manifest.
 *
 * Verifies caller authorization and milestone eligibility on-chain,
 * pulls authoritative chain anchors (version, specHash, evidenceRootHash, counterparty),
 * builds and validates the deterministic manifest, computes reasonHash,
 * and persists the staged record to the database.
 */
export async function stageMilestoneDispute(
  params: StageMilestoneDisputeParams
): Promise<{
  manifest: CanonicalSeriousDisputeManifestV1;
  reasonHash: `0x${string}`;
  row: MilestoneDisputeRow;
}> {
  const chainId = params.chainId ?? SEPOLIA_CHAIN_ID;
  const dealAddress = params.dealAddress.toLowerCase();
  const callerWallet = params.callerWallet.toLowerCase();
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleMilestoneDisputeRepository();

  if (!isAddress(dealAddress)) {
    throw new DisputeValidationError('Invalid deal address');
  }
  if (!isAddress(callerWallet)) {
    throw new DisputeValidationError('Invalid caller wallet address');
  }

  // 1. Authoritative chain state read
  const dealData = await readStandardV2DealData(dealAddress, client);

  if (dealData.state !== DealState.Active) {
    throw new DisputeAuthError('Deal is not in Active state');
  }

  if (dealData.isProtected) {
    throw new DisputeAuthError('Protected deals cannot use standard serious dispute flow');
  }

  const isClient = callerWallet === dealData.client.toLowerCase();
  const isFreelancer = callerWallet === dealData.freelancer.toLowerCase();
  if (!isClient && !isFreelancer) {
    throw new DisputeAuthError('Caller is not a participant in this deal');
  }

  const milestone = dealData.milestones[params.milestoneId];
  if (!milestone) {
    throw new DisputeValidationError(`Milestone ${params.milestoneId} does not exist`);
  }

  const eligibility = determineSeriousDisputeEligibility({
    dealState: dealData.state,
    milestoneStatus: milestone.status,
    isClient,
    isFreelancer,
    isProtected: dealData.isProtected,
  });

  if (!eligibility.eligible) {
    throw new DisputeAuthError(eligibility.reason || 'Milestone not eligible for serious dispute');
  }

  // 2. Authoritative anchor derivation
  const counterpartyWallet = isClient ? dealData.freelancer.toLowerCase() : dealData.client.toLowerCase();
  const submissionVersion = Number(milestone.version);
  const specHash = (milestone.specHash?.toLowerCase() || '0x0000000000000000000000000000000000000000000000000000000000000000') as `0x${string}`;
  const evidenceRootHash = (milestone.evidenceRootHash?.toLowerCase() || '0x0000000000000000000000000000000000000000000000000000000000000000') as `0x${string}`;

  // 3. Construct canonical manifest
  const normalizedManifest = normalizeSeriousDisputeManifest({
    schemaVersion: 1,
    chainId,
    dealAddress,
    milestoneId: params.milestoneId,
    submissionVersion,
    specHash,
    evidenceRootHash,
    openerWallet: callerWallet,
    counterpartyWallet,
    explanation: params.explanation,
    category: params.category,
    links: params.links,
  });

  const reasonHash = hashSeriousDisputeManifest(normalizedManifest);

  // 4. Persistence check & upsert
  const existing = await repo.getByMilestone(chainId, dealAddress, params.milestoneId);

  let row: MilestoneDisputeRow;
  if (existing) {
    if (existing.status === 'confirmed') {
      throw new DisputeConflictError('A dispute for this milestone has already been confirmed on-chain');
    }
    if (existing.openerWallet.toLowerCase() !== callerWallet) {
      throw new DisputeConflictError(
        'Another participant has already staged an unconfirmed dispute for this milestone'
      );
    }
    // Update existing staged record
    row = await repo.updateStaged(existing.id, {
      reasonHash,
      canonicalManifest: normalizedManifest as unknown as Record<string, unknown>,
      submissionVersion,
      specHash,
      evidenceRootHash,
      updatedAt: new Date(),
    });
  } else {
    // Insert new staged record
    row = await repo.create({
      chainId,
      dealAddress,
      milestoneId: params.milestoneId,
      submissionVersion,
      specHash,
      evidenceRootHash,
      openerWallet: callerWallet,
      counterpartyWallet,
      reasonHash,
      canonicalManifest: normalizedManifest as unknown as Record<string, unknown>,
      status: 'staged',
      txHash: null,
      openedAt: null,
    });
  }

  return {
    manifest: normalizedManifest,
    reasonHash,
    row,
  };
}

export interface ReconcileMilestoneDisputeParams {
  chainId?: number;
  dealAddress: string;
  milestoneId: number;
  callerWallet: string;
  txHash?: string;
  publicClient?: PublicClientLike;
  repo?: IMilestoneDisputeRepository;
}

/**
 * Reconciles a staged serious dispute against on-chain transaction logs.
 *
 * Supports two operational modes:
 * 1. Direct txHash verification: decodes and verifies SeriousDisputeOpened in the receipt.
 * 2. Crash recovery (no txHash): queries on-chain SeriousDisputeOpened events to find the exact match.
 *
 * Fails closed if event does not match staged record, if multiple ambiguous events are found,
 * or if milestone became Disputed via declineRevision / timeoutRevisionResponse (which emit MilestoneDisputed(bytes32(0))).
 */
export async function reconcileMilestoneDispute(
  params: ReconcileMilestoneDisputeParams
): Promise<MilestoneDisputeRow> {
  const chainId = params.chainId ?? SEPOLIA_CHAIN_ID;
  const dealAddress = params.dealAddress.toLowerCase();
  const callerWallet = params.callerWallet.toLowerCase();
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleMilestoneDisputeRepository();

  const staged = await repo.getByMilestone(chainId, dealAddress, params.milestoneId);
  if (!staged) {
    throw new DisputeIntegrityError('No staged dispute record found to reconcile');
  }

  if (staged.status === 'confirmed') {
    return staged;
  }

  const isOpener = callerWallet === staged.openerWallet.toLowerCase();
  const isCounterparty = callerWallet === staged.counterpartyWallet.toLowerCase();
  if (!isOpener && !isCounterparty) {
    throw new DisputeAuthError('Caller is not authorized to reconcile this dispute');
  }

  // Verify milestone is actually Disputed on-chain
  const dealData = await readStandardV2DealData(dealAddress, client);
  const milestone = dealData.milestones[params.milestoneId];
  if (!milestone) {
    throw new DisputeIntegrityError(`Milestone ${params.milestoneId} does not exist on-chain`);
  }

  if (milestone.status !== MilestoneStatus.Disputed) {
    throw new DisputeIntegrityError(
      `Milestone is not in Disputed state on-chain (current status: ${MilestoneStatus[milestone.status] || milestone.status})`
    );
  }

  let verifiedTxHash: string | null = null;
  let openedAtDate: Date = new Date();

  if (params.txHash) {
    // Mode 1: Reconcile with explicit txHash
    if (typeof (client as any).getTransactionReceipt !== 'function') {
      throw new DisputeIntegrityError('PublicClient does not support getTransactionReceipt');
    }
    const receipt = await (client as any).getTransactionReceipt({
      hash: params.txHash as `0x${string}`,
    });

    if (!receipt) {
      throw new DisputeIntegrityError(`Transaction receipt not found for ${params.txHash}`);
    }

    const verification = verifySeriousDisputeOpenedReceipt(
      receipt,
      dealAddress,
      BigInt(params.milestoneId),
      staged.openerWallet,
      staged.reasonHash as `0x${string}`
    );

    if (!verification.valid) {
      throw new DisputeIntegrityError(
        verification.error || 'Transaction receipt failed SeriousDisputeOpened verification'
      );
    }

    verifiedTxHash = params.txHash.toLowerCase();
  } else {
    // Mode 2: Crash recovery without txHash
    if (typeof (client as any).getLogs !== 'function') {
      throw new DisputeIntegrityError('PublicClient does not support getLogs for crash recovery');
    }

    const logs = await (client as any).getLogs({
      address: dealAddress as `0x${string}`,
      abi: synqDealV1ABI,
      eventName: 'SeriousDisputeOpened',
      args: {
        milestoneId: BigInt(params.milestoneId),
      },
      fromBlock: 'earliest',
      toBlock: 'latest',
    });

    if (!logs || logs.length === 0) {
      throw new DisputeIntegrityError(
        'Crash recovery failed: No SeriousDisputeOpened event found on-chain for this milestone'
      );
    }

    if (logs.length > 1) {
      throw new DisputeIntegrityError(
        'Crash recovery failed: Ambiguous SeriousDisputeOpened events found on-chain'
      );
    }

    const matchedLog = logs[0];
    const logArgs = matchedLog.args as {
      milestoneId: bigint;
      opener: string;
      reasonHash: string;
    };

    if (logArgs.opener.toLowerCase() !== staged.openerWallet.toLowerCase()) {
      throw new DisputeIntegrityError(
        `Crash recovery failed: Opener mismatch in event (${logArgs.opener} vs staged ${staged.openerWallet})`
      );
    }

    if (logArgs.reasonHash.toLowerCase() !== staged.reasonHash.toLowerCase()) {
      throw new DisputeIntegrityError(
        `Crash recovery failed: ReasonHash mismatch in event (${logArgs.reasonHash} vs staged ${staged.reasonHash})`
      );
    }

    verifiedTxHash = matchedLog.transactionHash ? matchedLog.transactionHash.toLowerCase() : null;
  }

  // Confirm row in DB
  const confirmed = await repo.confirm(staged.id, {
    txHash: verifiedTxHash,
    openedAt: openedAtDate,
    updatedAt: new Date(),
  });

  return confirmed;
}

export interface GetMilestoneDisputeParams {
  chainId?: number;
  dealAddress: string;
  milestoneId: number;
  callerWallet: string;
  publicClient?: PublicClientLike;
  repo?: IMilestoneDisputeRepository;
}

/**
 * Retrieves the serious dispute record for a milestone.
 *
 * Authorization Enforcement:
 * - Deal Client and Freelancer have direct access.
 * - Current signers on the authoritative resolution committee derived for that
 *   specific milestone have access if the milestone is in an adjudication state
 *   (Disputed, ResolutionProposed, FinalReview, or verified SettledSplit).
 * - Outsiders, unassigned committee members, and invalid states are rejected with DisputeAuthError.
 * - All authorization checks fail closed on RPC error, missing block timestamp, or unverified provenance.
 */
export async function getMilestoneDispute(
  params: GetMilestoneDisputeParams
): Promise<MilestoneDisputeRow | null> {
  const chainId = params.chainId ?? SEPOLIA_CHAIN_ID;
  const dealAddress = params.dealAddress.toLowerCase();
  const callerWallet = params.callerWallet.toLowerCase();
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleMilestoneDisputeRepository();

  if (!isAddress(dealAddress) || !isAddress(callerWallet)) {
    throw new DisputeValidationError('Invalid address provided');
  }

  if (!Number.isInteger(params.milestoneId) || params.milestoneId < 0) {
    throw new DisputeValidationError('Invalid milestoneId provided');
  }

  const dealData = await readStandardV2DealData(dealAddress, client);
  const isClient = callerWallet === dealData.client.toLowerCase();
  const isFreelancer = callerWallet === dealData.freelancer.toLowerCase();

  // 1. Participant Access Path
  if (isClient || isFreelancer) {
    return repo.getByMilestone(chainId, dealAddress, params.milestoneId);
  }

  // 2. Committee Caller Access Path
  if (params.milestoneId >= dealData.milestones.length) {
    throw new DisputeValidationError('Milestone does not exist');
  }

  const milestone = dealData.milestones[params.milestoneId];
  let authorizedResolver: `0x${string}` | null = null;

  if (milestone.status === MilestoneStatus.Disputed) {
    // Read on-chain dispute-opened timestamp
    const disputeOpenedAt = (await client.readContract({
      address: dealData.dealAddress,
      abi: synqDealV1ABI,
      functionName: 'milestoneDisputeOpenedAt',
      args: [BigInt(params.milestoneId)],
    })) as bigint;

    if (!disputeOpenedAt || disputeOpenedAt <= 0n) {
      throw new DisputeAuthError('Dispute opened timestamp not recorded on-chain');
    }

    // Fail-closed: Must use authoritative latest block timestamp from RPC, never Date.now() or 0n
    if (typeof (client as any).getBlock !== 'function') {
      throw new DisputeAuthError('Unable to query authoritative block timestamp');
    }
    const latestBlock = await (client as any).getBlock({ blockTag: 'latest' });
    if (!latestBlock || latestBlock.timestamp === undefined || latestBlock.timestamp === null) {
      throw new DisputeAuthError('Authoritative block timestamp unavailable');
    }
    const latestBlockTimestamp = BigInt(latestBlock.timestamp);

    const derivation = deriveAuthorizedCommittee({
      primaryResolver: dealData.primaryResolver,
      emergencyResolver: dealData.emergencyResolver,
      phase: 'INITIAL_RESOLUTION',
      milestoneDisputeOpenedAt: disputeOpenedAt,
      latestBlockTimestamp,
    });

    if (
      derivation.error ||
      !derivation.authorizedCommittee ||
      derivation.authorizedCommittee === '0x0000000000000000000000000000000000000000'
    ) {
      throw new DisputeAuthError(derivation.error || 'Failed to derive authorized resolution committee');
    }

    authorizedResolver = derivation.authorizedCommittee;
  } else if (
    milestone.status === MilestoneStatus.ResolutionProposed ||
    milestone.status === MilestoneStatus.FinalReview
  ) {
    // Derive resolver strictly from stored on-chain resolution proposal
    // Preserves the original proposing resolver for final review without 14-day re-derivation
    const proposal = await readResolutionProposal(dealData.dealAddress, params.milestoneId, client);
    if (
      !proposal ||
      !proposal.resolver ||
      !isAddress(proposal.resolver) ||
      proposal.resolver === '0x0000000000000000000000000000000000000000'
    ) {
      throw new DisputeAuthError('No valid resolution proposal recorded on-chain');
    }
    authorizedResolver = proposal.resolver.toLowerCase() as `0x${string}`;
  } else if (milestone.status === MilestoneStatus.SettledSplit) {
    // Only grant committee access if settlement actually followed a committee resolution
    const db = getDb();
    const confirmedReports = await db
      .select()
      .from(milestoneResolutionReports)
      .where(
        and(
          eq(milestoneResolutionReports.chainId, chainId),
          eq(milestoneResolutionReports.dealAddress, dealAddress),
          eq(milestoneResolutionReports.milestoneId, params.milestoneId),
          eq(milestoneResolutionReports.status, 'confirmed')
        )
      );

    if (confirmedReports.length === 0) {
      throw new DisputeAuthError('Committee provenance cannot be verified for this settled milestone');
    }

    const report = confirmedReports.find((r) => r.phase === 'FINAL_RESOLUTION') ?? confirmedReports[0];
    if (!report.committeeAddress || !isAddress(report.committeeAddress)) {
      throw new DisputeAuthError('Invalid committee address on confirmed resolution report');
    }
    authorizedResolver = report.committeeAddress.toLowerCase() as `0x${string}`;
  } else {
    throw new DisputeAuthError('Milestone is not in a dispute or resolution state');
  }

  // Live verification that caller is currently a signer on the derived authorized resolver contract
  const isSigner = (await client.readContract({
    address: getAddress(authorizedResolver),
    abi: synqResolutionCommitteeReadABI,
    functionName: 'isSigner',
    args: [getAddress(callerWallet)],
  })) as boolean;

  if (!isSigner) {
    throw new DisputeAuthError('Caller is not an active signer on the authorized resolution committee');
  }

  return repo.getByMilestone(chainId, dealAddress, params.milestoneId);
}
