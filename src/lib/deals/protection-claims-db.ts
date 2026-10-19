import { isAddress, getAddress } from 'viem';
import { getDb } from '@/db';
import {
  protectionClaims,
  type ProtectionClaimRow,
  type NewProtectionClaimRow,
} from '@/db/schema';
import { SEPOLIA_CHAIN_ID, SYNQ_V2_SEPOLIA_CONFIG, getSynqPremiumConfig } from '@/lib/contracts/addresses';
import { CANONICAL_PROTECTION_MANAGER_V1_1_SEPOLIA } from '@/lib/deals/v2-protection-committee';
import {
  readStandardV2DealData,
  DealState,
  MilestoneStatus,
  type PublicClientLike,
} from '@/lib/deals/v2-deal';
import {
  readDealPremiumPolicy,
  type PremiumPolicyState,
} from '@/lib/deals/v2-protection';
import {
  normalizeProtectionClaimManifest,
  hashProtectionClaimManifest,
  verifyClaimSubmittedReceipt,
  determineProtectionClaimEligibility,
  type CanonicalProtectionClaimManifestV1,
  type ClaimFailureReason,
  synqProtectionClaimManagerABI,
  synqProtectionCommitteeABI,
  ProtectionClaimAuthError,
  ProtectionClaimConflictError,
  ProtectionClaimValidationError,
  ProtectionClaimIntegrityError,
} from '@/lib/deals/v2-protection-claim';
import { sepoliaPublicClient } from '@/lib/chain';
import { and, eq } from 'drizzle-orm';

export {
  ProtectionClaimAuthError,
  ProtectionClaimConflictError,
  ProtectionClaimValidationError,
  ProtectionClaimIntegrityError,
};

// ---------------------------------------------------------------------------
// Repository Pattern
// ---------------------------------------------------------------------------

export interface IProtectionClaimRepository {
  getByMilestone(
    chainId: number,
    dealAddress: string,
    milestoneId: number
  ): Promise<ProtectionClaimRow | null>;

  create(row: NewProtectionClaimRow): Promise<ProtectionClaimRow>;

  updateStaged(
    id: string,
    data: {
      evidenceHash: string;
      canonicalManifest: Record<string, unknown>;
      updatedAt: Date;
    }
  ): Promise<ProtectionClaimRow>;

  confirm(
    id: string,
    data: {
      txHash: string;
      submittedAt: Date;
      updatedAt: Date;
    }
  ): Promise<ProtectionClaimRow>;
}

export class DrizzleProtectionClaimRepository implements IProtectionClaimRepository {
  async getByMilestone(
    chainId: number,
    dealAddress: string,
    milestoneId: number
  ): Promise<ProtectionClaimRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(protectionClaims)
      .where(
        and(
          eq(protectionClaims.chainId, chainId),
          eq(protectionClaims.dealAddress, dealAddress.toLowerCase()),
          eq(protectionClaims.milestoneId, milestoneId)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async create(row: NewProtectionClaimRow): Promise<ProtectionClaimRow> {
    const db = getDb();
    const inserted = await db.insert(protectionClaims).values(row).returning();
    return inserted[0];
  }

  async updateStaged(
    id: string,
    data: {
      evidenceHash: string;
      canonicalManifest: Record<string, unknown>;
      updatedAt: Date;
    }
  ): Promise<ProtectionClaimRow> {
    const db = getDb();
    const updated = await db
      .update(protectionClaims)
      .set(data)
      .where(eq(protectionClaims.id, id))
      .returning();
    return updated[0];
  }

  async confirm(
    id: string,
    data: {
      txHash: string;
      submittedAt: Date;
      updatedAt: Date;
    }
  ): Promise<ProtectionClaimRow> {
    const db = getDb();
    const updated = await db
      .update(protectionClaims)
      .set({
        status: 'confirmed',
        txHash: data.txHash,
        submittedAt: data.submittedAt,
        updatedAt: data.updatedAt,
      })
      .where(eq(protectionClaims.id, id))
      .returning();
    return updated[0];
  }
}

// ---------------------------------------------------------------------------
// Business Logic Functions
// ---------------------------------------------------------------------------

export interface StageProtectionClaimParams {
  chainId?: number;
  dealAddress: string;
  milestoneId: number;
  callerWallet: string;
  explanation: string;
  failureReason?: ClaimFailureReason;
  links?: unknown[];
  publicClient?: any;
  repo?: IProtectionClaimRepository;
}

/**
 * Stages a canonical protection claim manifest.
 *
 * Verifies caller is the deal client, policy is active, milestone is covered and SettledRefunded,
 * checks no on-chain claim already exists, computes deterministic evidenceHash,
 * and persists the staged record to the database.
 */
export async function stageProtectionClaim(
  params: StageProtectionClaimParams
): Promise<{
  manifest: CanonicalProtectionClaimManifestV1;
  evidenceHash: `0x${string}`;
  row: ProtectionClaimRow;
}> {
  const chainId = params.chainId ?? SEPOLIA_CHAIN_ID;
  const dealAddress = params.dealAddress.toLowerCase();
  const callerWallet = params.callerWallet.toLowerCase();
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleProtectionClaimRepository();

  if (!isAddress(dealAddress)) {
    throw new ProtectionClaimValidationError('Invalid deal address');
  }
  if (!isAddress(callerWallet)) {
    throw new ProtectionClaimValidationError('Invalid caller wallet address');
  }

  const managerAddress =
    getSynqPremiumConfig().manager ||
    SYNQ_V2_SEPOLIA_CONFIG.premiumProtectionManagerV1_1 ||
    CANONICAL_PROTECTION_MANAGER_V1_1_SEPOLIA;
  if (!managerAddress || !isAddress(managerAddress)) {
    throw new ProtectionClaimValidationError('Premium Protection Manager not configured on this network');
  }

  // 1. Authoritative deal state read
  const dealData = await readStandardV2DealData(dealAddress, client);

  if (callerWallet !== dealData.client.toLowerCase()) {
    throw new ProtectionClaimAuthError('Only the deal client can submit a protection claim');
  }

  const milestone = dealData.milestones[params.milestoneId];
  if (!milestone) {
    throw new ProtectionClaimValidationError(`Milestone ${params.milestoneId} does not exist`);
  }

  // 2. Authoritative on-chain policy read
  const policy = await readDealPremiumPolicy(client, managerAddress, dealAddress, 'V1_1');

  // 3. Authoritative on-chain existing claim read
  let existingOnChainClaimStatus = 0;
  let onChainEvidenceHash: string | null = null;
  try {
    const rawClaim = (await client.readContract({
      address: getAddress(managerAddress),
      abi: synqProtectionClaimManagerABI,
      functionName: 'getClaim',
      args: [getAddress(dealAddress), BigInt(params.milestoneId)],
    })) as { status: number; evidenceHash?: `0x${string}` };
    existingOnChainClaimStatus = Number(rawClaim.status);
    if (rawClaim.evidenceHash) {
      onChainEvidenceHash = String(rawClaim.evidenceHash).toLowerCase();
    }
  } catch (claimErr) {
    console.warn('[stageProtectionClaim] Could not read existing on-chain claim:', claimErr);
  }

  // 4. Build and validate canonical manifest
  const rawManifest = {
    schemaVersion: 1,
    chainId,
    managerAddress: managerAddress.toLowerCase() as `0x${string}`,
    dealAddress: dealAddress as `0x${string}`,
    milestoneId: params.milestoneId,
    clientWallet: callerWallet as `0x${string}`,
    explanation: params.explanation,
    failureReason: params.failureReason,
    links: params.links,
  };

  const normalizedManifest = normalizeProtectionClaimManifest(rawManifest);
  const evidenceHash = hashProtectionClaimManifest(normalizedManifest);

  // 5. Strict eligibility & idempotency verification
  if (existingOnChainClaimStatus !== 0) {
    // If an on-chain claim exists, verify if it matches the current canonical evidence
    if (onChainEvidenceHash && onChainEvidenceHash === evidenceHash.toLowerCase()) {
      // Idempotent resubmission for already submitted on-chain claim
      const existingRow = await repo.getByMilestone(chainId, dealAddress, params.milestoneId);
      if (existingRow) {
        return {
          manifest: normalizedManifest,
          evidenceHash,
          row: existingRow,
        };
      }
      // If DB row missing, recreate staged row for matching on-chain claim
      const now = new Date();
      const restoredRow = await repo.create({
        chainId,
        managerAddress: managerAddress.toLowerCase(),
        dealAddress: dealAddress.toLowerCase(),
        milestoneId: params.milestoneId,
        clientWallet: callerWallet.toLowerCase(),
        evidenceHash,
        canonicalManifest: normalizedManifest as unknown as Record<string, unknown>,
        status: 'staged',
        createdAt: now,
        updatedAt: now,
      });
      return {
        manifest: normalizedManifest,
        evidenceHash,
        row: restoredRow,
      };
    }

    throw new ProtectionClaimConflictError('An on-chain claim has already been recorded for this milestone with different evidence');
  }

  const eligibility = determineProtectionClaimEligibility({
    dealState: dealData.state,
    milestoneStatus: milestone.status,
    milestoneAmount: milestone.amount,
    isClient: true,
    policy,
    milestoneIndex: params.milestoneId,
    existingClaimStatus: existingOnChainClaimStatus,
  });

  if (!eligibility.eligible) {
    throw new ProtectionClaimAuthError(eligibility.reason || 'Milestone not eligible for protection claim');
  }

  // 6. Database persistence
  const existingRow = await repo.getByMilestone(chainId, dealAddress, params.milestoneId);
  const now = new Date();

  let finalRow: ProtectionClaimRow;
  if (existingRow) {
    if (existingRow.status === 'confirmed') {
      if (existingRow.evidenceHash.toLowerCase() === evidenceHash.toLowerCase()) {
        return {
          manifest: normalizedManifest,
          evidenceHash,
          row: existingRow,
        };
      }
      throw new ProtectionClaimConflictError('A confirmed protection claim already exists for this milestone and cannot be mutated');
    }

    if (existingRow.clientWallet.toLowerCase() !== callerWallet.toLowerCase()) {
      throw new ProtectionClaimAuthError('Caller does not match existing claimant wallet');
    }

    // Idempotent check
    if (existingRow.evidenceHash.toLowerCase() === evidenceHash.toLowerCase()) {
      return {
        manifest: normalizedManifest,
        evidenceHash,
        row: existingRow,
      };
    }

    finalRow = await repo.updateStaged(existingRow.id, {
      evidenceHash,
      canonicalManifest: normalizedManifest as unknown as Record<string, unknown>,
      updatedAt: now,
    });
  } else {
    finalRow = await repo.create({
      chainId,
      managerAddress: managerAddress.toLowerCase(),
      dealAddress: dealAddress.toLowerCase(),
      milestoneId: params.milestoneId,
      clientWallet: callerWallet.toLowerCase(),
      evidenceHash,
      canonicalManifest: normalizedManifest as unknown as Record<string, unknown>,
      status: 'staged',
      createdAt: now,
      updatedAt: now,
    });
  }

  return {
    manifest: normalizedManifest,
    evidenceHash,
    row: finalRow,
  };
}

export interface GetProtectionClaimParams {
  chainId?: number;
  dealAddress: string;
  milestoneId: number;
  callerWallet: string;
  publicClient?: any;
  repo?: IProtectionClaimRepository;
}

/**
 * Retrieves a stored protection claim.
 *
 * Restricts private evidence to the deal client and authorized Protection Committee signers.
 */
export async function getProtectionClaim(
  params: GetProtectionClaimParams
): Promise<ProtectionClaimRow | null> {
  const chainId = params.chainId ?? SEPOLIA_CHAIN_ID;
  const dealAddress = params.dealAddress.toLowerCase();
  const callerWallet = params.callerWallet.toLowerCase();
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleProtectionClaimRepository();

  if (!isAddress(dealAddress) || !isAddress(callerWallet)) {
    throw new ProtectionClaimValidationError('Invalid deal or caller address');
  }

  const claimRow = await repo.getByMilestone(chainId, dealAddress, params.milestoneId);
  if (!claimRow) {
    return null;
  }

  // Check authorization: caller must be client or Protection Committee member
  const isClient = callerWallet === claimRow.clientWallet.toLowerCase();
  if (isClient) {
    return claimRow;
  }

  // Check Protection Committee membership
  const managerAddress = claimRow.managerAddress;
  try {
    const committeeAddress = (await client.readContract({
      address: getAddress(managerAddress),
      abi: synqProtectionClaimManagerABI,
      functionName: 'protectionCommittee',
    })) as string;

    if (committeeAddress && isAddress(committeeAddress)) {
      const isSigner = (await client.readContract({
        address: getAddress(committeeAddress),
        abi: synqProtectionCommitteeABI,
        functionName: 'isSigner',
        args: [getAddress(callerWallet)],
      })) as boolean;

      if (isSigner) {
        return claimRow;
      }
    }
  } catch (err) {
    console.warn('[getProtectionClaim] Error checking committee membership:', err);
  }

  throw new ProtectionClaimAuthError('Unauthorized: private claim evidence is restricted to deal client and protection committee');
}

export interface ReconcileProtectionClaimParams {
  chainId?: number;
  dealAddress: string;
  milestoneId: number;
  txHash?: string | null;
  callerWallet: string;
  publicClient?: any;
  repo?: IProtectionClaimRepository;
}

/**
 * Reconciles an on-chain ClaimSubmitted transaction with the staged database record.
 *
 * Mode 1 (txHash provided): Verifies transaction receipt and ClaimSubmitted event parameters on-chain.
 * Mode 2 (txHash omitted / crash recovery): Reads on-chain claim state, asserts evidenceHash match,
 * and performs bounded chunked getLogs search on the manager contract to recover the mined transaction hash.
 *
 * Transitions status to 'confirmed'.
 */
export async function reconcileProtectionClaim(
  params: ReconcileProtectionClaimParams
): Promise<ProtectionClaimRow> {
  const chainId = params.chainId ?? SEPOLIA_CHAIN_ID;
  const dealAddress = params.dealAddress.toLowerCase();
  const callerWallet = params.callerWallet.toLowerCase();
  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleProtectionClaimRepository();

  if (!isAddress(dealAddress) || !isAddress(callerWallet)) {
    throw new ProtectionClaimValidationError('Invalid deal or caller address');
  }

  const claimRow = await repo.getByMilestone(chainId, dealAddress, params.milestoneId);
  if (!claimRow) {
    throw new ProtectionClaimValidationError('No staged claim found for this milestone to reconcile');
  }

  if (claimRow.clientWallet.toLowerCase() !== callerWallet) {
    throw new ProtectionClaimAuthError('Only the claimant client can reconcile this claim');
  }

  if (
    claimRow.status === 'confirmed' &&
    (!params.txHash || claimRow.txHash?.toLowerCase() === params.txHash.toLowerCase())
  ) {
    return claimRow;
  }

  let verifiedTxHash: string | null = null;

  if (params.txHash && /^0x[0-9a-fA-F]{64}$/.test(params.txHash)) {
    // Mode 1: Reconcile with explicit transaction receipt
    const receipt = await client.getTransactionReceipt({ hash: params.txHash as `0x${string}` });
    if (!receipt) {
      throw new ProtectionClaimIntegrityError('Transaction receipt not found on-chain');
    }

    const verifiedEvent = verifyClaimSubmittedReceipt({
      receipt,
      expectedDealAddress: dealAddress,
      expectedMilestoneId: params.milestoneId,
      expectedClient: callerWallet,
      expectedEvidenceHash: claimRow.evidenceHash,
    });

    verifiedTxHash = verifiedEvent.transactionHash.toLowerCase();
  } else {
    // Mode 2: Hash-free crash recovery via on-chain contract state and bounded getLogs
    const managerAddress = claimRow.managerAddress;
    const rawClaim = (await client.readContract({
      address: getAddress(managerAddress),
      abi: synqProtectionClaimManagerABI,
      functionName: 'getClaim',
      args: [getAddress(dealAddress), BigInt(params.milestoneId)],
    })) as { status: number; evidenceHash: `0x${string}` };

    if (!rawClaim || Number(rawClaim.status) === 0) {
      throw new ProtectionClaimIntegrityError('Recovery failed: No on-chain claim exists for this milestone');
    }

    const onChainHash = String(rawClaim.evidenceHash).toLowerCase();
    if (onChainHash !== claimRow.evidenceHash.toLowerCase()) {
      throw new ProtectionClaimIntegrityError(
        `Recovery failed: On-chain claim evidence hash (${onChainHash}) does not match staged manifest (${claimRow.evidenceHash.toLowerCase()})`
      );
    }

    // Bounded chunked getLogs search on manager contract
    const latestBlock = await client.getBlockNumber();
    const CHUNK_SIZE = 5000n;
    const MAX_LOOKBACK = 50000n;
    const minBlock = latestBlock > MAX_LOOKBACK ? latestBlock - MAX_LOOKBACK : 0n;
    let currentTo = latestBlock;

    while (currentTo >= minBlock) {
      const currentFrom =
        currentTo >= CHUNK_SIZE && currentTo - CHUNK_SIZE + 1n >= minBlock
          ? currentTo - CHUNK_SIZE + 1n
          : minBlock;

      try {
        const chunkLogs = await client.getLogs({
          address: getAddress(managerAddress),
          abi: synqProtectionClaimManagerABI,
          eventName: 'ClaimSubmitted',
          args: {
            deal: getAddress(dealAddress),
            milestoneId: BigInt(params.milestoneId),
            client: getAddress(callerWallet),
          },
          fromBlock: currentFrom,
          toBlock: currentTo,
        });

        if (Array.isArray(chunkLogs) && chunkLogs.length > 0) {
          for (const l of chunkLogs) {
            const logHash = String(l.args?.evidenceHash || '').toLowerCase();
            if (logHash === claimRow.evidenceHash.toLowerCase() && l.transactionHash) {
              verifiedTxHash = l.transactionHash.toLowerCase();
              break;
            }
          }
        }

        if (verifiedTxHash) break;
      } catch (logErr) {
        console.warn('[reconcileProtectionClaim] Chunk getLogs error:', logErr);
      }

      if (currentFrom <= minBlock) break;
      currentTo = currentFrom - 1n;
    }

    if (!verifiedTxHash) {
      throw new ProtectionClaimIntegrityError(
        'Could not locate ClaimSubmitted event within search window. Please provide the transaction hash.'
      );
    }
  }

  // 3. Mark database record confirmed
  const confirmedRow = await repo.confirm(claimRow.id, {
    txHash: verifiedTxHash,
    submittedAt: new Date(),
    updatedAt: new Date(),
  });

  return confirmedRow;
}

