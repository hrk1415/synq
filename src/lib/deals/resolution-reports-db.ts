import { isAddress } from 'viem';
import { getDb } from '@/db';
import {
  milestoneResolutionReports,
  type MilestoneResolutionReportRow,
  type NewMilestoneResolutionReportRow,
  type ResolutionReportPhase,
} from '@/db/schema';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import {
  readStandardV2DealData,
  DealState,
  MilestoneStatus,
  type PublicClientLike,
} from '@/lib/deals/v2-deal';
import {
  normalizeResolutionReport,
  canonicalizeResolutionReport,
  hashResolutionReport,
  determineResolutionReportEligibility,
  deriveAuthorizedCommittee,
  canAccessResolutionReport,
  verifyResolutionProposedReceipt,
  verifyFinalResolutionExecutedReceipt,
  synqResolutionCommitteeReadABI,
  ResolutionReportValidationError,
  ResolutionReportAuthError,
  ResolutionReportConflictError,
  ResolutionReportIntegrityError,
  type CanonicalResolutionReportV1,
} from '@/lib/deals/v2-resolution-report';
import { synqDealV1ABI } from '@/lib/contracts/abis';
import { sepoliaPublicClient } from '@/lib/chain';
import { and, eq, desc } from 'drizzle-orm';

export {
  ResolutionReportValidationError,
  ResolutionReportAuthError,
  ResolutionReportConflictError,
  ResolutionReportIntegrityError,
};

// ---------------------------------------------------------------------------
// Repository Pattern for Isolation and Unit Testing
// ---------------------------------------------------------------------------

export interface IMilestoneResolutionReportRepository {
  getByMilestoneAndPhase(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    phase: ResolutionReportPhase
  ): Promise<MilestoneResolutionReportRow | null>;

  getByMilestoneAndHash(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    phase: ResolutionReportPhase,
    justificationHash: string
  ): Promise<MilestoneResolutionReportRow | null>;

  listByMilestone(
    chainId: number,
    dealAddress: string,
    milestoneId: number
  ): Promise<MilestoneResolutionReportRow[]>;

  getById(id: string): Promise<MilestoneResolutionReportRow | null>;

  create(row: NewMilestoneResolutionReportRow): Promise<MilestoneResolutionReportRow>;

  updateStaged(
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
  ): Promise<MilestoneResolutionReportRow>;

  confirm(
    id: string,
    data: {
      txHash: string | null;
      resolvedAt: Date;
      updatedAt: Date;
    }
  ): Promise<MilestoneResolutionReportRow>;
}

export class DrizzleMilestoneResolutionReportRepository implements IMilestoneResolutionReportRepository {
  async getByMilestoneAndPhase(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    phase: ResolutionReportPhase
  ): Promise<MilestoneResolutionReportRow | null> {
    const db = getDb();
    // Prefer confirmed report, then newest staged report
    const rows = await db
      .select()
      .from(milestoneResolutionReports)
      .where(
        and(
          eq(milestoneResolutionReports.chainId, chainId),
          eq(milestoneResolutionReports.dealAddress, dealAddress.toLowerCase()),
          eq(milestoneResolutionReports.milestoneId, milestoneId),
          eq(milestoneResolutionReports.phase, phase)
        )
      )
      .orderBy(desc(milestoneResolutionReports.status), desc(milestoneResolutionReports.updatedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async getByMilestoneAndHash(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    phase: ResolutionReportPhase,
    justificationHash: string
  ): Promise<MilestoneResolutionReportRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(milestoneResolutionReports)
      .where(
        and(
          eq(milestoneResolutionReports.chainId, chainId),
          eq(milestoneResolutionReports.dealAddress, dealAddress.toLowerCase()),
          eq(milestoneResolutionReports.milestoneId, milestoneId),
          eq(milestoneResolutionReports.phase, phase),
          eq(milestoneResolutionReports.justificationHash, justificationHash.toLowerCase())
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async listByMilestone(
    chainId: number,
    dealAddress: string,
    milestoneId: number
  ): Promise<MilestoneResolutionReportRow[]> {
    const db = getDb();
    return db
      .select()
      .from(milestoneResolutionReports)
      .where(
        and(
          eq(milestoneResolutionReports.chainId, chainId),
          eq(milestoneResolutionReports.dealAddress, dealAddress.toLowerCase()),
          eq(milestoneResolutionReports.milestoneId, milestoneId)
        )
      )
      .orderBy(desc(milestoneResolutionReports.updatedAt));
  }

  async getById(id: string): Promise<MilestoneResolutionReportRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(milestoneResolutionReports)
      .where(eq(milestoneResolutionReports.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(row: NewMilestoneResolutionReportRow): Promise<MilestoneResolutionReportRow> {
    const db = getDb();
    const inserted = await db.insert(milestoneResolutionReports).values(row).returning();
    return inserted[0];
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
    const db = getDb();
    const updated = await db
      .update(milestoneResolutionReports)
      .set(data)
      .where(eq(milestoneResolutionReports.id, id))
      .returning();
    return updated[0];
  }

  async confirm(
    id: string,
    data: {
      txHash: string | null;
      resolvedAt: Date;
      updatedAt: Date;
    }
  ): Promise<MilestoneResolutionReportRow> {
    const db = getDb();
    const updated = await db
      .update(milestoneResolutionReports)
      .set({
        status: 'confirmed',
        txHash: data.txHash,
        resolvedAt: data.resolvedAt,
        updatedAt: data.updatedAt,
      })
      .where(eq(milestoneResolutionReports.id, id))
      .returning();
    return updated[0];
  }
}

// ---------------------------------------------------------------------------
// Business Operations
// ---------------------------------------------------------------------------

/**
 * Stages a canonical resolution report for a disputed or final review milestone.
 * Authenticates that the caller is an active on-chain signer of the authorized committee.
 */
export async function stageResolutionReport(params: {
  dealAddress: string;
  milestoneId: number;
  callerWallet: string;
  phase: ResolutionReportPhase;
  freelancerAmount: string;
  clientAmount: string;
  summary: string;
  findings: string;
  justification: string;
  evidenceReferences?: any[];
  publicClient?: PublicClientLike;
  repo?: IMilestoneResolutionReportRepository;
}): Promise<{
  report: CanonicalResolutionReportV1;
  justificationHash: `0x${string}`;
  row: MilestoneResolutionReportRow;
  reportId: string;
}> {
  const { dealAddress, milestoneId, callerWallet, phase } = params;

  if (!isAddress(callerWallet)) {
    throw new ResolutionReportAuthError('Invalid caller wallet address');
  }
  if (!isAddress(dealAddress)) {
    throw new ResolutionReportValidationError('Invalid deal address');
  }
  if (!Number.isInteger(milestoneId) || milestoneId < 0) {
    throw new ResolutionReportValidationError('Invalid milestone ID');
  }

  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleMilestoneResolutionReportRepository();

  // 1. Read fresh deal data from chain
  const dealData = await readStandardV2DealData(dealAddress as `0x${string}`, client);
  const milestone = dealData.milestones[milestoneId];
  if (!milestone) {
    throw new ResolutionReportValidationError(`Milestone ${milestoneId} not found on deal`);
  }

  // 2. Check general deal eligibility
  const eligibility = determineResolutionReportEligibility({
    dealState: dealData.state,
    milestoneStatus: milestone.status,
    phase,
    isProtected: dealData.isProtected,
  });
  if (!eligibility.eligible) {
    throw new ResolutionReportConflictError(eligibility.reason || 'Milestone not eligible for resolution report');
  }

  // 3. Determine current authorized committee
  let disputeOpenedAt = 0n;
  let storedResolver: string | null = null;

  if (phase === 'INITIAL_RESOLUTION') {
    disputeOpenedAt = await client.readContract({
      address: dealData.dealAddress,
      abi: synqDealV1ABI,
      functionName: 'milestoneDisputeOpenedAt',
      args: [BigInt(milestoneId)],
    }) as bigint;
  } else if (phase === 'FINAL_RESOLUTION') {
    const proposal = await client.readContract({
      address: dealData.dealAddress,
      abi: synqDealV1ABI,
      functionName: 'getResolutionProposal',
      args: [BigInt(milestoneId)],
    }) as any;
    storedResolver = proposal?.resolver ?? null;
  }

  let chainTimestamp: bigint;
  if (typeof (client as any).getBlock === 'function') {
    try {
      const block = await (client as any).getBlock({ blockTag: 'latest' });
      chainTimestamp = BigInt(block.timestamp);
    } catch {
      chainTimestamp = BigInt(Math.floor(Date.now() / 1000));
    }
  } else {
    chainTimestamp = BigInt(Math.floor(Date.now() / 1000));
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
    throw new ResolutionReportConflictError(
      committeeDerivation.error || 'Could not derive authorized resolution committee'
    );
  }
  const authorizedCommittee = committeeDerivation.authorizedCommittee;

  // 4. Verify caller is an active signer on the authorized committee
  const isSigner = await client.readContract({
    address: authorizedCommittee,
    abi: synqResolutionCommitteeReadABI,
    functionName: 'isSigner',
    args: [callerWallet as `0x${string}`],
  }) as boolean;

  if (!isSigner) {
    throw new ResolutionReportAuthError(
      `Caller (${callerWallet}) is not an active signer on authorized committee (${authorizedCommittee})`
    );
  }

  // 5. Construct, normalize, and hash the canonical report
  const rawReport: CanonicalResolutionReportV1 = {
    schemaVersion: 1,
    phase,
    chainId: SEPOLIA_CHAIN_ID,
    committeeAddress: authorizedCommittee,
    dealAddress: dealData.dealAddress,
    milestoneId,
    submissionVersion: milestone.version,
    specHash: milestone.specHash,
    evidenceRootHash: milestone.evidenceRootHash,
    freelancerAmount: params.freelancerAmount,
    clientAmount: params.clientAmount,
    summary: params.summary,
    findings: params.findings,
    justification: params.justification,
    evidenceReferences: params.evidenceReferences,
  };

  const normalized = normalizeResolutionReport(rawReport, milestone.amount);
  const justificationHash = hashResolutionReport(normalized, milestone.amount);

  // 6. Check existing reports for this milestone and phase
  const existingForPhase = await repo.getByMilestoneAndPhase(
    SEPOLIA_CHAIN_ID,
    dealData.dealAddress,
    milestoneId,
    phase
  );

  if (existingForPhase && existingForPhase.status === 'confirmed') {
    throw new ResolutionReportConflictError(
      `A confirmed resolution report already exists for milestone ${milestoneId} and phase ${phase}`
    );
  }

  let row: MilestoneResolutionReportRow;

  if (existingForPhase && existingForPhase.status === 'staged') {
    // If exact same hash, return existing row
    if (existingForPhase.justificationHash.toLowerCase() === justificationHash.toLowerCase()) {
      row = existingForPhase;
    } else {
      // Update staged report with updated draft
      row = await repo.updateStaged(existingForPhase.id, {
        freelancerAmount: normalized.freelancerAmount,
        clientAmount: normalized.clientAmount,
        justificationHash,
        canonicalReport: normalized as unknown as Record<string, unknown>,
        submissionVersion: normalized.submissionVersion,
        specHash: normalized.specHash,
        evidenceRootHash: normalized.evidenceRootHash,
        stagedByWallet: callerWallet.toLowerCase(),
        updatedAt: new Date(),
      });
    }
  } else {
    // Insert new staged report
    const newRow: NewMilestoneResolutionReportRow = {
      chainId: SEPOLIA_CHAIN_ID,
      committeeAddress: authorizedCommittee.toLowerCase(),
      dealAddress: dealData.dealAddress.toLowerCase(),
      milestoneId,
      phase,
      submissionVersion: normalized.submissionVersion,
      specHash: normalized.specHash.toLowerCase(),
      evidenceRootHash: normalized.evidenceRootHash.toLowerCase(),
      freelancerAmount: normalized.freelancerAmount,
      clientAmount: normalized.clientAmount,
      justificationHash: justificationHash.toLowerCase(),
      canonicalReport: normalized as unknown as Record<string, unknown>,
      status: 'staged',
      stagedByWallet: callerWallet.toLowerCase(),
    };
    row = await repo.create(newRow);
  }

  return {
    report: normalized,
    justificationHash,
    row,
    reportId: row.id,
  };
}

/**
 * Reconciles an on-chain proposeMilestoneResolution or executeFinalResolution transaction,
 * promoting a staged resolution report to 'confirmed'.
 * Supports event-based crash recovery when txHash was lost.
 */
export async function reconcileResolutionReport(params: {
  dealAddress: string;
  milestoneId: number;
  callerWallet: string;
  phase: ResolutionReportPhase;
  txHash?: string | null;
  publicClient?: PublicClientLike;
  repo?: IMilestoneResolutionReportRepository;
}): Promise<{
  report: CanonicalResolutionReportV1;
  justificationHash: `0x${string}`;
  row: MilestoneResolutionReportRow;
}> {
  const { dealAddress, milestoneId, callerWallet, phase, txHash } = params;

  if (!isAddress(callerWallet)) {
    throw new ResolutionReportAuthError('Invalid caller wallet address');
  }
  if (!isAddress(dealAddress)) {
    throw new ResolutionReportValidationError('Invalid deal address');
  }
  if (!Number.isInteger(milestoneId) || milestoneId < 0) {
    throw new ResolutionReportValidationError('Invalid milestone ID');
  }

  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleMilestoneResolutionReportRepository();

  // 1. Fetch staged candidate report
  const stagedRow = await repo.getByMilestoneAndPhase(
    SEPOLIA_CHAIN_ID,
    dealAddress,
    milestoneId,
    phase
  );

  if (!stagedRow) {
    throw new ResolutionReportIntegrityError(
      `No resolution report found to reconcile for milestone ${milestoneId} and phase ${phase}`
    );
  }

  if (stagedRow.status === 'confirmed') {
    return {
      report: stagedRow.canonicalReport as unknown as CanonicalResolutionReportV1,
      justificationHash: stagedRow.justificationHash as `0x${string}`,
      row: stagedRow,
    };
  }

  // 2. Fetch fresh deal data
  const dealData = await readStandardV2DealData(dealAddress as `0x${string}`, client);
  const milestone = dealData.milestones[milestoneId];
  if (!milestone) {
    throw new ResolutionReportValidationError(`Milestone ${milestoneId} not found on deal`);
  }

  let verifiedTxHash: string | null = null;
  const expectedFreelancerAmount = BigInt(stagedRow.freelancerAmount);
  const expectedClientAmount = BigInt(stagedRow.clientAmount);
  const expectedHash = stagedRow.justificationHash.toLowerCase();

  if (txHash) {
    // Direct transaction receipt verification
    if (typeof (client as any).getTransactionReceipt !== 'function') {
      throw new ResolutionReportIntegrityError('PublicClient does not support getTransactionReceipt');
    }
    const receipt = await (client as any).getTransactionReceipt({ hash: txHash as `0x${string}` });
    if (!receipt) {
      throw new ResolutionReportIntegrityError(`Transaction receipt not found for txHash: ${txHash}`);
    }

    if (phase === 'INITIAL_RESOLUTION') {
      const result = verifyResolutionProposedReceipt({
        receipt,
        dealAddress: dealData.dealAddress,
        expectedMilestoneId: BigInt(milestoneId),
        expectedResolver: stagedRow.committeeAddress,
        expectedFreelancerAmount,
        expectedClientAmount,
        expectedJustificationHash: expectedHash,
      });

      if (!result.valid) {
        throw new ResolutionReportIntegrityError(result.error || 'Failed to verify ResolutionProposed event in receipt');
      }

      // Verify fresh on-chain status & storage
      if (milestone.status !== MilestoneStatus.ResolutionProposed) {
        throw new ResolutionReportIntegrityError(
          `On-chain milestone status is ${milestone.status}, expected ResolutionProposed (5)`
        );
      }

      const proposal = await client.readContract({
        address: dealData.dealAddress,
        abi: synqDealV1ABI,
        functionName: 'getResolutionProposal',
        args: [BigInt(milestoneId)],
      }) as any;

      if (proposal.justificationHash.toLowerCase() !== expectedHash) {
        throw new ResolutionReportIntegrityError(
          `On-chain proposal justificationHash mismatch: expected ${expectedHash}, got ${proposal.justificationHash.toLowerCase()}`
        );
      }
      if (BigInt(proposal.freelancerAmount) !== expectedFreelancerAmount || BigInt(proposal.clientAmount) !== expectedClientAmount) {
        throw new ResolutionReportIntegrityError('On-chain proposal split amounts mismatch');
      }
    } else if (phase === 'FINAL_RESOLUTION') {
      const result = verifyFinalResolutionExecutedReceipt({
        receipt,
        dealAddress: dealData.dealAddress,
        expectedMilestoneId: BigInt(milestoneId),
        expectedResolver: stagedRow.committeeAddress,
        expectedFreelancerAmount,
        expectedClientAmount,
        expectedJustificationHash: expectedHash,
      });

      if (!result.valid) {
        throw new ResolutionReportIntegrityError(
          result.error || 'Failed to verify FinalResolutionExecuted event in receipt'
        );
      }

      // Verify terminal status
      if (milestone.status !== MilestoneStatus.SettledSplit) {
        throw new ResolutionReportIntegrityError(
          `On-chain milestone status is ${milestone.status}, expected SettledSplit (9)`
        );
      }
    }
    verifiedTxHash = txHash;
  } else {
    // Event-based Crash Recovery (txHash was lost)
    if (phase === 'INITIAL_RESOLUTION') {
      // Must be ResolutionProposed on chain
      if (milestone.status !== MilestoneStatus.ResolutionProposed) {
        throw new ResolutionReportIntegrityError(
          'Crash recovery failed: on-chain milestone is not in ResolutionProposed status'
        );
      }

      // Query logs for ResolutionProposed
      if (typeof (client as any).getLogs !== 'function') {
        throw new ResolutionReportIntegrityError('PublicClient does not support getLogs');
      }
      const logs = await (client as any).getLogs({
        address: dealData.dealAddress,
        event: {
          type: 'event',
          name: 'ResolutionProposed',
          inputs: [
            { indexed: true, name: 'milestoneId', type: 'uint256' },
            { indexed: true, name: 'resolver', type: 'address' },
            { indexed: false, name: 'freelancerAmount', type: 'uint256' },
            { indexed: false, name: 'clientAmount', type: 'uint256' },
            { indexed: false, name: 'justificationHash', type: 'bytes32' },
            { indexed: false, name: 'reconsiderationDeadline', type: 'uint64' },
          ],
        },
        args: {
          milestoneId: BigInt(milestoneId),
          resolver: stagedRow.committeeAddress as `0x${string}`,
        },
      });

      const matching = logs.filter((l: any) => {
        const args = l.args;
        return (
          BigInt(args.freelancerAmount) === expectedFreelancerAmount &&
          BigInt(args.clientAmount) === expectedClientAmount &&
          String(args.justificationHash).toLowerCase() === expectedHash
        );
      });

      if (matching.length === 0) {
        throw new ResolutionReportIntegrityError(
          'Crash recovery failed: zero matching ResolutionProposed events found on-chain'
        );
      }
      if (matching.length > 1) {
        throw new ResolutionReportIntegrityError(
          'Crash recovery failed: ambiguous multiple matching ResolutionProposed events found'
        );
      }
      verifiedTxHash = matching[0].transactionHash;
    } else if (phase === 'FINAL_RESOLUTION') {
      // Terminal SettledSplit status ALONE is never sufficient! Must prove unique FinalResolutionExecuted event!
      if (milestone.status !== MilestoneStatus.SettledSplit) {
        throw new ResolutionReportIntegrityError(
          'Crash recovery failed: on-chain milestone is not in SettledSplit status'
        );
      }

      if (typeof (client as any).getLogs !== 'function') {
        throw new ResolutionReportIntegrityError('PublicClient does not support getLogs');
      }
      const logs = await (client as any).getLogs({
        address: dealData.dealAddress,
        event: {
          type: 'event',
          name: 'FinalResolutionExecuted',
          inputs: [
            { indexed: true, name: 'milestoneId', type: 'uint256' },
            { indexed: true, name: 'resolver', type: 'address' },
            { indexed: false, name: 'freelancerAmount', type: 'uint256' },
            { indexed: false, name: 'clientAmount', type: 'uint256' },
            { indexed: false, name: 'justificationHash', type: 'bytes32' },
          ],
        },
        args: {
          milestoneId: BigInt(milestoneId),
          resolver: stagedRow.committeeAddress as `0x${string}`,
        },
      });

      const matching = logs.filter((l: any) => {
        const args = l.args;
        return (
          BigInt(args.freelancerAmount) === expectedFreelancerAmount &&
          BigInt(args.clientAmount) === expectedClientAmount &&
          String(args.justificationHash).toLowerCase() === expectedHash
        );
      });

      if (matching.length === 0) {
        throw new ResolutionReportIntegrityError(
          'Crash recovery failed: zero matching FinalResolutionExecuted events found on-chain'
        );
      }
      if (matching.length > 1) {
        throw new ResolutionReportIntegrityError(
          'Crash recovery failed: ambiguous multiple matching FinalResolutionExecuted events found'
        );
      }
      verifiedTxHash = matching[0].transactionHash;
    }
  }

  // 3. Confirm in repository
  const confirmedRow = await repo.confirm(stagedRow.id, {
    txHash: verifiedTxHash,
    resolvedAt: new Date(),
    updatedAt: new Date(),
  });

  return {
    report: confirmedRow.canonicalReport as unknown as CanonicalResolutionReportV1,
    justificationHash: confirmedRow.justificationHash as `0x${string}`,
    row: confirmedRow,
  };
}

/**
 * Retrieves a canonical resolution report with strict privacy enforcement.
 */
export async function getResolutionReport(params: {
  dealAddress: string;
  milestoneId: number;
  phase: ResolutionReportPhase;
  callerWallet: string;
  publicClient?: PublicClientLike;
  repo?: IMilestoneResolutionReportRepository;
}): Promise<{
  report: CanonicalResolutionReportV1;
  justificationHash: `0x${string}`;
  row: MilestoneResolutionReportRow;
} | null> {
  const { dealAddress, milestoneId, phase, callerWallet } = params;

  if (!isAddress(callerWallet)) {
    throw new ResolutionReportAuthError('Invalid caller wallet address');
  }
  if (!isAddress(dealAddress)) {
    throw new ResolutionReportValidationError('Invalid deal address');
  }

  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleMilestoneResolutionReportRepository();

  const row = await repo.getByMilestoneAndPhase(SEPOLIA_CHAIN_ID, dealAddress, milestoneId, phase);
  if (!row) {
    return null;
  }

  // Verify access permissions
  const dealData = await readStandardV2DealData(dealAddress as `0x${string}`, client);

  // Check if caller is a signer on primary or emergency committee
  const isPrimarySigner = await client.readContract({
    address: dealData.primaryResolver,
    abi: synqResolutionCommitteeReadABI,
    functionName: 'isSigner',
    args: [callerWallet as `0x${string}`],
  }).catch(() => false);

  const isEmergencySigner = await client.readContract({
    address: dealData.emergencyResolver,
    abi: synqResolutionCommitteeReadABI,
    functionName: 'isSigner',
    args: [callerWallet as `0x${string}`],
  }).catch(() => false);

  const hasAccess = canAccessResolutionReport({
    callerWallet,
    dealClient: dealData.client,
    dealFreelancer: dealData.freelancer,
    isCommitteeSigner: Boolean(isPrimarySigner || isEmergencySigner),
    stagedByWallet: row.stagedByWallet,
  });

  if (!hasAccess) {
    throw new ResolutionReportAuthError('Unauthorized: caller cannot view this resolution report');
  }

  return {
    report: row.canonicalReport as unknown as CanonicalResolutionReportV1,
    justificationHash: row.justificationHash as `0x${string}`,
    row,
  };
}

/**
 * Lists all resolution reports for a milestone (initial and final) with privacy check.
 */
export async function listResolutionReports(params: {
  dealAddress: string;
  milestoneId: number;
  callerWallet: string;
  publicClient?: PublicClientLike;
  repo?: IMilestoneResolutionReportRepository;
}): Promise<MilestoneResolutionReportRow[]> {
  const { dealAddress, milestoneId, callerWallet } = params;

  if (!isAddress(callerWallet)) {
    throw new ResolutionReportAuthError('Invalid caller wallet address');
  }
  if (!isAddress(dealAddress)) {
    throw new ResolutionReportValidationError('Invalid deal address');
  }

  const client = params.publicClient ?? sepoliaPublicClient;
  const repo = params.repo ?? new DrizzleMilestoneResolutionReportRepository();

  const dealData = await readStandardV2DealData(dealAddress as `0x${string}`, client);

  const isPrimarySigner = await client.readContract({
    address: dealData.primaryResolver,
    abi: synqResolutionCommitteeReadABI,
    functionName: 'isSigner',
    args: [callerWallet as `0x${string}`],
  }).catch(() => false);

  const isEmergencySigner = await client.readContract({
    address: dealData.emergencyResolver,
    abi: synqResolutionCommitteeReadABI,
    functionName: 'isSigner',
    args: [callerWallet as `0x${string}`],
  }).catch(() => false);

  const rows = await repo.listByMilestone(SEPOLIA_CHAIN_ID, dealAddress, milestoneId);

  // Filter rows accessible to caller
  return rows.filter((r) =>
    canAccessResolutionReport({
      callerWallet,
      dealClient: dealData.client,
      dealFreelancer: dealData.freelancer,
      isCommitteeSigner: Boolean(isPrimarySigner || isEmergencySigner),
      stagedByWallet: r.stagedByWallet,
    })
  );
}
