import { isAddress } from 'viem';
import { getDb } from '@/db';
import {
  mutualSettlementProposals,
  type MutualSettlementProposalRow,
  type NewMutualSettlementProposalRow,
  type MutualSettlementStatus,
} from '@/db/schema';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import {
  readStandardV2DealData,
  DealState,
  MilestoneStatus,
  type PublicClientLike,
} from '@/lib/deals/v2-deal';
import {
  normalizeMutualSettlementProposal,
  verifyMutualSettlementSignature,
  verifyMutualSettlementReceipt,
  verifyProposalCancelledReceipt,
  determineMutualSettlementEligibility,
  type MutualSettlementProposalData,
  MutualSettlementValidationError,
} from '@/lib/deals/v2-mutual-settlement';
import { synqDealV1ABI } from '@/lib/contracts/abis';
import { sepoliaPublicClient } from '@/lib/chain';
import { and, eq, desc } from 'drizzle-orm';

export class MutualSettlementAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MutualSettlementAuthError';
  }
}

export class MutualSettlementConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MutualSettlementConflictError';
  }
}

export class MutualSettlementIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MutualSettlementIntegrityError';
  }
}

export { MutualSettlementValidationError };

// ---------------------------------------------------------------------------
// Repository Pattern
// ---------------------------------------------------------------------------

export interface IMutualSettlementRepository {
  getById(id: string): Promise<MutualSettlementProposalRow | null>;

  getByNonce(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    proposerWallet: string,
    proposalNonce: string
  ): Promise<MutualSettlementProposalRow | null>;

  listByMilestone(
    chainId: number,
    dealAddress: string,
    milestoneId: number
  ): Promise<MutualSettlementProposalRow[]>;

  create(row: NewMutualSettlementProposalRow): Promise<MutualSettlementProposalRow>;

  updateStatus(
    id: string,
    status: MutualSettlementStatus,
    hashes?: { executionTxHash?: string | null; cancellationTxHash?: string | null }
  ): Promise<MutualSettlementProposalRow>;

  invalidateOtherPending(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    executedProposalId: string
  ): Promise<void>;
}

export class DrizzleMutualSettlementRepository implements IMutualSettlementRepository {
  async getById(id: string): Promise<MutualSettlementProposalRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(mutualSettlementProposals)
      .where(eq(mutualSettlementProposals.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async getByNonce(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    proposerWallet: string,
    proposalNonce: string
  ): Promise<MutualSettlementProposalRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(mutualSettlementProposals)
      .where(
        and(
          eq(mutualSettlementProposals.chainId, chainId),
          eq(mutualSettlementProposals.dealAddress, dealAddress.toLowerCase()),
          eq(mutualSettlementProposals.milestoneId, milestoneId),
          eq(mutualSettlementProposals.proposerWallet, proposerWallet.toLowerCase()),
          eq(mutualSettlementProposals.proposalNonce, proposalNonce)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async listByMilestone(
    chainId: number,
    dealAddress: string,
    milestoneId: number
  ): Promise<MutualSettlementProposalRow[]> {
    const db = getDb();
    return db
      .select()
      .from(mutualSettlementProposals)
      .where(
        and(
          eq(mutualSettlementProposals.chainId, chainId),
          eq(mutualSettlementProposals.dealAddress, dealAddress.toLowerCase()),
          eq(mutualSettlementProposals.milestoneId, milestoneId)
        )
      )
      .orderBy(desc(mutualSettlementProposals.createdAt));
  }

  async create(row: NewMutualSettlementProposalRow): Promise<MutualSettlementProposalRow> {
    const db = getDb();
    const inserted = await db.insert(mutualSettlementProposals).values(row).returning();
    return inserted[0];
  }

  async updateStatus(
    id: string,
    status: MutualSettlementStatus,
    hashes?: { executionTxHash?: string | null; cancellationTxHash?: string | null }
  ): Promise<MutualSettlementProposalRow> {
    const db = getDb();
    const updateData: Record<string, unknown> = {
      status,
      updatedAt: new Date(),
    };
    if (hashes?.executionTxHash !== undefined) {
      updateData.executionTxHash = hashes.executionTxHash;
    }
    if (hashes?.cancellationTxHash !== undefined) {
      updateData.cancellationTxHash = hashes.cancellationTxHash;
    }
    const updated = await db
      .update(mutualSettlementProposals)
      .set(updateData)
      .where(eq(mutualSettlementProposals.id, id))
      .returning();
    return updated[0];
  }

  async invalidateOtherPending(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    executedProposalId: string
  ): Promise<void> {
    const db = getDb();
    await db
      .update(mutualSettlementProposals)
      .set({
        status: 'invalidated',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mutualSettlementProposals.chainId, chainId),
          eq(mutualSettlementProposals.dealAddress, dealAddress.toLowerCase()),
          eq(mutualSettlementProposals.milestoneId, milestoneId),
          eq(mutualSettlementProposals.status, 'pending')
        )
      );
  }
}

// ---------------------------------------------------------------------------
// Business Logic Functions
// ---------------------------------------------------------------------------

export interface CreateMutualSettlementProposalParams {
  chainId?: number;
  dealAddress: string;
  milestoneId: number;
  proposerWallet: string;
  freelancerAmount: string | bigint;
  clientAmount: string | bigint;
  proposalNonce: string | bigint;
  validUntil: string | bigint;
  signature: `0x${string}`;
  publicClient?: PublicClientLike;
  repo?: IMutualSettlementRepository;
}

/**
 * Creates and verifies a mutual settlement proposal.
 *
 * Verifies on-chain eligibility, split equivalence to milestone.amount,
 * verifies that proposalNonce is not already used on chain, and verifies
 * that the recovered EIP-712 signer strictly matches the proposerWallet.
 */
export async function createMutualSettlementProposal(
  params: CreateMutualSettlementProposalParams
): Promise<MutualSettlementProposalRow> {
  const chainId = params.chainId ?? SEPOLIA_CHAIN_ID;
  const dealAddress = params.dealAddress.toLowerCase();
  const proposerWallet = params.proposerWallet.toLowerCase();
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleMutualSettlementRepository();

  if (!isAddress(dealAddress)) {
    throw new MutualSettlementValidationError('Invalid deal address');
  }
  if (!isAddress(proposerWallet)) {
    throw new MutualSettlementValidationError('Invalid proposer wallet');
  }

  // 1. Authoritative deal state read
  const dealData = await readStandardV2DealData(dealAddress, client);

  if (dealData.state !== DealState.Active) {
    throw new MutualSettlementAuthError('Deal is not in Active state');
  }

  const isClient = proposerWallet === dealData.client.toLowerCase();
  const isFreelancer = proposerWallet === dealData.freelancer.toLowerCase();
  if (!isClient && !isFreelancer) {
    throw new MutualSettlementAuthError('Proposer is not a participant in this deal');
  }

  const milestone = dealData.milestones[params.milestoneId];
  if (!milestone) {
    throw new MutualSettlementValidationError(`Milestone ${params.milestoneId} does not exist`);
  }

  const eligibility = determineMutualSettlementEligibility({
    dealState: dealData.state,
    milestoneStatus: milestone.status,
    isClient,
    isFreelancer,
  });

  if (!eligibility.eligible) {
    throw new MutualSettlementAuthError(eligibility.reason || 'Milestone ineligible for mutual settlement');
  }

  // 2. Validate proposal amounts & structure
  const milestoneAmount = BigInt(milestone.amount);
  const normalized = normalizeMutualSettlementProposal({
    dealAddress,
    chainId,
    milestoneId: params.milestoneId,
    proposer: proposerWallet,
    freelancerAmount: params.freelancerAmount,
    clientAmount: params.clientAmount,
    proposalNonce: params.proposalNonce,
    validUntil: params.validUntil,
    milestoneAmount,
  });

  // 3. Expiration boundary check against current system time (conservative)
  const currentTimestampSec = BigInt(Math.floor(Date.now() / 1000));
  if (normalized.validUntil <= currentTimestampSec) {
    throw new MutualSettlementValidationError('Proposal validUntil timestamp is already in the past');
  }

  // 4. On-chain Nonce verification: usedProposalNonces[milestoneId][proposer][nonce]
  try {
    const isNonceUsed = (await (client as any).readContract({
      address: dealAddress as `0x${string}`,
      abi: synqDealV1ABI,
      functionName: 'usedProposalNonces',
      args: [BigInt(params.milestoneId), proposerWallet as `0x${string}`, normalized.proposalNonce],
    })) as boolean;

    if (isNonceUsed) {
      throw new MutualSettlementConflictError(
        `Proposal nonce ${normalized.proposalNonce.toString()} is already used or cancelled on-chain`
      );
    }
  } catch (err: any) {
    if (err instanceof MutualSettlementConflictError) throw err;
    throw new MutualSettlementIntegrityError(
      `Failed to verify on-chain proposal nonce: ${err?.message || String(err)}`
    );
  }

  // 5. Verify EIP-712 Signature
  const sigVerification = await verifyMutualSettlementSignature(normalized, params.signature);
  if (!sigVerification.valid) {
    throw new MutualSettlementValidationError(
      sigVerification.error || 'Invalid proposal signature'
    );
  }

  // 6. DB duplicate check
  const existing = await repo.getByNonce(
    chainId,
    dealAddress,
    params.milestoneId,
    proposerWallet,
    normalized.proposalNonce.toString()
  );

  if (existing) {
    throw new MutualSettlementConflictError(
      `A proposal with nonce ${normalized.proposalNonce.toString()} already exists in database`
    );
  }

  const counterpartyWallet = isClient ? dealData.freelancer.toLowerCase() : dealData.client.toLowerCase();

  // 7. Insert pending proposal
  const row = await repo.create({
    chainId,
    dealAddress,
    milestoneId: params.milestoneId,
    proposerWallet,
    counterpartyWallet,
    freelancerAmount: normalized.freelancerAmount.toString(),
    clientAmount: normalized.clientAmount.toString(),
    proposalNonce: normalized.proposalNonce.toString(),
    validUntil: normalized.validUntil.toString(),
    signature: params.signature,
    status: 'pending',
    executionTxHash: null,
  });

  return row;
}

export interface ReconcileMutualSettlementExecutionParams {
  proposalId: string;
  txHash: string;
  publicClient?: PublicClientLike;
  repo?: IMutualSettlementRepository;
}

/**
 * Reconciles execution of a mutual settlement proposal against on-chain transaction receipt.
 */
export async function reconcileMutualSettlementExecution(
  params: ReconcileMutualSettlementExecutionParams
): Promise<MutualSettlementProposalRow> {
  const repo = params.repo ?? new DrizzleMutualSettlementRepository();
  const client = params.publicClient ?? sepoliaPublicClient;

  const proposal = await repo.getById(params.proposalId);
  if (!proposal) {
    throw new MutualSettlementIntegrityError('Proposal not found in database');
  }

  if (proposal.status === 'executed') {
    return proposal;
  }

  if (typeof (client as any).getTransactionReceipt !== 'function') {
    throw new MutualSettlementIntegrityError('PublicClient does not support getTransactionReceipt');
  }
  const receipt = await (client as any).getTransactionReceipt({
    hash: params.txHash as `0x${string}`,
  });

  if (!receipt) {
    throw new MutualSettlementIntegrityError(`Transaction receipt not found for ${params.txHash}`);
  }

  const verification = verifyMutualSettlementReceipt(
    receipt,
    proposal.dealAddress,
    BigInt(proposal.milestoneId),
    BigInt(proposal.freelancerAmount),
    BigInt(proposal.clientAmount)
  );

  if (!verification.valid) {
    throw new MutualSettlementIntegrityError(
      verification.error || 'Transaction receipt failed mutual settlement verification'
    );
  }

  // Update status to executed
  const updated = await repo.updateStatus(proposal.id, 'executed', {
    executionTxHash: params.txHash.toLowerCase(),
  });

  // Invalidate any other pending proposals for this milestone
  await repo.invalidateOtherPending(
    proposal.chainId,
    proposal.dealAddress,
    proposal.milestoneId,
    proposal.id
  );

  return updated;
}

export interface ReconcileMutualSettlementCancelParams {
  proposalId: string;
  callerWallet: string;
  txHash?: string;
  publicClient?: PublicClientLike;
  repo?: IMutualSettlementRepository;
}

/**
 * Reconciles on-chain cancellation of a proposal (cancelProposal).
 */
export async function reconcileMutualSettlementCancel(
  params: ReconcileMutualSettlementCancelParams
): Promise<MutualSettlementProposalRow> {
  const repo = params.repo ?? new DrizzleMutualSettlementRepository();
  const client = params.publicClient ?? sepoliaPublicClient;
  const callerWallet = params.callerWallet.toLowerCase();

  const proposal = await repo.getById(params.proposalId);
  if (!proposal) {
    throw new MutualSettlementIntegrityError('Proposal not found in database');
  }

  if (proposal.status === 'cancelled') {
    if (params.txHash && !proposal.cancellationTxHash) {
      return repo.updateStatus(proposal.id, 'cancelled', {
        cancellationTxHash: params.txHash.toLowerCase(),
      });
    }
    return proposal;
  }

  if (callerWallet !== proposal.proposerWallet.toLowerCase()) {
    throw new MutualSettlementAuthError('Only the proposer can cancel their proposal');
  }

  if (params.txHash) {
    if (typeof (client as any).getTransactionReceipt !== 'function') {
      throw new MutualSettlementIntegrityError('PublicClient does not support getTransactionReceipt');
    }
    const receipt = await (client as any).getTransactionReceipt({
      hash: params.txHash as `0x${string}`,
    });

    if (!receipt) {
      throw new MutualSettlementIntegrityError(`Transaction receipt not found for ${params.txHash}`);
    }

    const verification = verifyProposalCancelledReceipt(
      receipt,
      proposal.dealAddress,
      BigInt(proposal.milestoneId),
      proposal.proposerWallet,
      BigInt(proposal.proposalNonce)
    );

    if (!verification.valid) {
      throw new MutualSettlementIntegrityError(
        verification.error || 'Receipt verification for cancelProposal failed'
      );
    }
  } else {
    // Verify on-chain nonce state
    try {
      const isNonceUsed = (await (client as any).readContract({
        address: proposal.dealAddress as `0x${string}`,
        abi: synqDealV1ABI,
        functionName: 'usedProposalNonces',
        args: [
          BigInt(proposal.milestoneId),
          proposal.proposerWallet as `0x${string}`,
          BigInt(proposal.proposalNonce),
        ],
      })) as boolean;

      if (!isNonceUsed) {
        throw new MutualSettlementIntegrityError(
          'On-chain check shows proposal nonce has not been cancelled or used'
        );
      }
    } catch (err: any) {
      if (err instanceof MutualSettlementIntegrityError) throw err;
      throw new MutualSettlementIntegrityError(
        `Failed to check on-chain nonce state: ${err?.message || String(err)}`
      );
    }
  }

  return repo.updateStatus(proposal.id, 'cancelled', {
    cancellationTxHash: params.txHash ? params.txHash.toLowerCase() : proposal.cancellationTxHash ?? null,
  });
}

export interface GetMutualSettlementProposalsParams {
  chainId?: number;
  dealAddress: string;
  milestoneId: number;
  callerWallet: string;
  publicClient?: PublicClientLike;
  repo?: IMutualSettlementRepository;
}

export interface MutualSettlementProposalView extends MutualSettlementProposalRow {
  isExecutable: boolean;
  isExpired: boolean;
}

/**
 * Retrieves mutual settlement proposals for a milestone with derived live executability.
 *
 * Privacy Enforcement:
 * Outsiders are strictly rejected with MutualSettlementAuthError.
 */
export async function getMutualSettlementProposals(
  params: GetMutualSettlementProposalsParams
): Promise<MutualSettlementProposalView[]> {
  const chainId = params.chainId ?? SEPOLIA_CHAIN_ID;
  const dealAddress = params.dealAddress.toLowerCase();
  const callerWallet = params.callerWallet.toLowerCase();
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleMutualSettlementRepository();

  if (!isAddress(dealAddress) || !isAddress(callerWallet)) {
    throw new MutualSettlementValidationError('Invalid address provided');
  }

  const dealData = await readStandardV2DealData(dealAddress, client);
  const isClient = callerWallet === dealData.client.toLowerCase();
  const isFreelancer = callerWallet === dealData.freelancer.toLowerCase();

  if (!isClient && !isFreelancer) {
    throw new MutualSettlementAuthError('Outsiders cannot view mutual settlement proposals');
  }

  const milestone = dealData.milestones[params.milestoneId];
  const proposals = await repo.listByMilestone(chainId, dealAddress, params.milestoneId);

  const currentTimestampSec = BigInt(Math.floor(Date.now() / 1000));
  const isMilestoneEligible = milestone
    ? [
        MilestoneStatus.Submitted,
        MilestoneStatus.RevisionRequested,
        MilestoneStatus.Disputed,
        MilestoneStatus.ResolutionProposed,
        MilestoneStatus.FinalReview,
      ].includes(milestone.status)
    : false;

  return proposals.map((p) => {
    const isExpired = BigInt(p.validUntil) <= currentTimestampSec;
    const isCounterparty = callerWallet === p.counterpartyWallet.toLowerCase();
    const isExecutable =
      p.status === 'pending' &&
      !isExpired &&
      dealData.state === DealState.Active &&
      isMilestoneEligible &&
      isCounterparty;

    return {
      ...p,
      isExecutable,
      isExpired,
    };
  });
}
