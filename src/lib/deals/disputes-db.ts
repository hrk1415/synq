import { isAddress, decodeEventLog } from 'viem';
import { getDb } from '@/db';
import { milestoneDisputes, type MilestoneDisputeRow, type NewMilestoneDisputeRow } from '@/db/schema';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import {
  readStandardV2DealData,
  DealState,
  MilestoneStatus,
  type PublicClientLike,
} from '@/lib/deals/v2-deal';
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
 * Privacy Enforcement:
 * Outsiders are strictly rejected with DisputeAuthError.
 * Only the client and freelancer can read the human explanation and manifest.
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

  const dealData = await readStandardV2DealData(dealAddress, client);
  const isClient = callerWallet === dealData.client.toLowerCase();
  const isFreelancer = callerWallet === dealData.freelancer.toLowerCase();

  if (!isClient && !isFreelancer) {
    throw new DisputeAuthError('Outsiders cannot view milestone dispute details');
  }

  return repo.getByMilestone(chainId, dealAddress, params.milestoneId);
}
