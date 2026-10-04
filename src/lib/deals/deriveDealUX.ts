// Pure Deal UX Lifecycle Engine for Synq
// ZERO React hooks, ZERO JSX. Pure deterministic TypeScript.

export type DealViewerRole =
  | 'buyer'
  | 'seller'
  | 'buyer_and_seller'
  | 'third_party'
  | 'disconnected';

export type DerivedDealPhase =
  | 'CANCELLED'
  | 'DISPUTED'
  | 'COMPLETED'
  | 'NEEDS_MILESTONES'
  | 'AWAITING_FUNDING'
  | 'READY_TO_START'
  | 'IN_PROGRESS'
  | 'REVISION_IN_PROGRESS'
  | 'AWAITING_REVIEW';

export type DealAttention =
  | 'action_required'
  | 'waiting_on_counterparty'
  | 'in_progress'
  | 'resolved'
  | 'blocked';

export type FinancialState =
  | 'UNFUNDED'
  | 'FULLY_FUNDED'
  | 'PARTIALLY_RELEASED'
  | 'FULLY_RELEASED'
  | 'REFUNDED_OR_CANCELLED'
  | 'DISPUTE_FROZEN';

export type DealPrimaryAction =
  | 'ADD_MILESTONE'
  | 'FUND_ESCROW'
  | 'START_MILESTONE'
  | 'SUBMIT_MILESTONE'
  | 'APPROVE_MILESTONE'
  | 'DISPUTE_ACTION'
  | 'CONNECT_WALLET'
  | null;

export interface MilestoneStructInput {
  title?: string;
  description?: string;
  amount?: bigint | number | string;
  msStatus?: number;
  dueDate?: bigint | number | string;
  evidenceHash?: string;
  completedAt?: bigint | number | string;
}

export interface DealInputData {
  status?: number;
  buyer?: string;
  seller?: string;
  totalValue?: bigint | number | string;
  escrowBalance?: bigint | number | string;
  milestones?: MilestoneStructInput[];
  dispute?: {
    openedBy?: string;
    reason?: string;
    buyerApproved?: boolean;
    sellerApproved?: boolean;
  };
}

export interface FinancialSummary {
  totalValue: bigint;
  escrowBalance: bigint;
  releasedAmount: bigint;
  accountedValue: bigint;
  hasEverBeenFullyAccounted: boolean;
  state: FinancialState;
}

export interface DealLifecycleStage {
  id: 'AGREED' | 'FUNDED' | 'WORK' | 'REVIEW' | 'COMPLETE';
  label: string;
  status: 'complete' | 'active' | 'upcoming' | 'error';
}

export interface DealNextAction {
  actionOwner: 'buyer' | 'seller' | 'both' | 'none';
  headline: string;
  description: string;
  primaryAction: DealPrimaryAction;
  targetMilestoneIndex: number | null;
}

export interface DealUXAnomaly {
  code: string;
  message: string;
}

export interface DealUXState {
  role: DealViewerRole;
  phase: DerivedDealPhase;
  attention: DealAttention;
  currentMilestoneIndex: number | null;
  financial: FinancialSummary;
  nextAction: DealNextAction;
  lifecycleStages: DealLifecycleStage[];
  anomalies: DealUXAnomaly[];
  rawState?: DealInputData;
}

/**
  * Safely converts value to bigint without floating-point math.
  */
function toBigIntSafely(val: bigint | number | string | undefined | null): bigint {
  if (val === undefined || val === null) return 0n;
  if (typeof val === 'bigint') return val;
  try {
    return BigInt(val);
  } catch {
    return 0n;
  }
}

/**
  * Case-insensitive address role derivation.
  */
export function deriveViewerRole(
  connectedAddress: string | undefined | null,
  buyerAddress: string | undefined | null,
  sellerAddress: string | undefined | null
): DealViewerRole {
  if (!connectedAddress || connectedAddress.trim() === '') {
    return 'disconnected';
  }
  const addr = connectedAddress.toLowerCase();
  const buyer = (buyerAddress || '').toLowerCase();
  const seller = (sellerAddress || '').toLowerCase();

  const isBuyer = buyer !== '' && addr === buyer;
  const isSeller = seller !== '' && addr === seller;

  if (isBuyer && isSeller) return 'buyer_and_seller';
  if (isBuyer) return 'buyer';
  if (isSeller) return 'seller';
  return 'third_party';
}

/**
  * Calculates exact on-chain released payout from approved milestones only.
  */
export function calculateReleasedAmount(milestones: MilestoneStructInput[] | undefined | null): bigint {
  if (!milestones || milestones.length === 0) return 0n;
  return milestones.reduce((sum, ms) => {
    const statusNum = Number(ms.msStatus ?? 0);
    if (statusNum === 3) {
      // 3 === MilestoneStatus.Approved
      return sum + toBigIntSafely(ms.amount);
    }
    return sum;
  }, 0n);
}

/**
  * Calculates financial state using accountedValue = escrowBalance + releasedAmount.
  */
export function deriveFinancialSummary(
  rawTotalValue: bigint | number | string | undefined,
  rawEscrowBalance: bigint | number | string | undefined,
  milestones: MilestoneStructInput[] | undefined | null,
  statusNum: number
): FinancialSummary {
  const totalValue = toBigIntSafely(rawTotalValue);
  const escrowBalance = toBigIntSafely(rawEscrowBalance);
  const releasedAmount = calculateReleasedAmount(milestones);
  const accountedValue = escrowBalance + releasedAmount;
  const hasEverBeenFullyAccounted = totalValue > 0n && accountedValue >= totalValue;

  let state: FinancialState = 'UNFUNDED';

  if (statusNum === 4) {
    state = 'REFUNDED_OR_CANCELLED';
  } else if (statusNum === 3) {
    state = 'DISPUTE_FROZEN';
  } else if (escrowBalance === 0n && releasedAmount === 0n) {
    state = 'UNFUNDED';
  } else if (hasEverBeenFullyAccounted && escrowBalance === 0n && releasedAmount >= totalValue) {
    state = 'FULLY_RELEASED';
  } else if (releasedAmount > 0n) {
    state = 'PARTIALLY_RELEASED';
  } else if (hasEverBeenFullyAccounted) {
    state = 'FULLY_FUNDED';
  }

  return {
    totalValue,
    escrowBalance,
    releasedAmount,
    accountedValue,
    hasEverBeenFullyAccounted,
    state,
  };
}

/**
  * Derives current actionable milestone index based on priority:
  * 1. First msStatus === Completed (2) [Submitted / awaiting review]
  * 2. First msStatus === InProgress (1) with evidenceHash (Revision)
  * 3. First msStatus === InProgress (1) without evidenceHash (Initial work)
  * 4. First msStatus === Pending (0)
  * 5. Last Approved milestone (3) fallback
  * 6. null if no milestones
  */
export function getCurrentMilestoneIndex(milestones: MilestoneStructInput[] | undefined | null): number | null {
  if (!milestones || milestones.length === 0) return null;

  // 1. Submitted (msStatus === 2)
  const submittedIdx = milestones.findIndex((m) => Number(m.msStatus) === 2);
  if (submittedIdx !== -1) return submittedIdx;

  // 2. Revision In Progress (msStatus === 1 && non-empty evidenceHash)
  const revisionIdx = milestones.findIndex(
    (m) => Number(m.msStatus) === 1 && !!m.evidenceHash && m.evidenceHash.trim() !== ''
  );
  if (revisionIdx !== -1) return revisionIdx;

  // 3. Initial In Progress (msStatus === 1 && empty evidenceHash)
  const initialWorkIdx = milestones.findIndex(
    (m) => Number(m.msStatus) === 1 && (!m.evidenceHash || m.evidenceHash.trim() === '')
  );
  if (initialWorkIdx !== -1) return initialWorkIdx;

  // 4. Pending (msStatus === 0)
  const pendingIdx = milestones.findIndex((m) => Number(m.msStatus) === 0);
  if (pendingIdx !== -1) return pendingIdx;

  // 5. Fallback: last milestone
  return milestones.length - 1;
}

/**
  * Derives overall deal phase based on contract state & milestone precedence.
  */
export function deriveDealPhase(
  statusNum: number,
  milestones: MilestoneStructInput[] | undefined | null,
  financial: FinancialSummary
): DerivedDealPhase {
  // Terminal / Exceptional States
  if (statusNum === 4) return 'CANCELLED';
  if (statusNum === 3) return 'DISPUTED';
  if (statusNum === 2) return 'COMPLETED';

  // Active status (1) or unknown
  const list = milestones || [];
  if (list.length === 0) {
    return 'NEEDS_MILESTONES';
  }

  if (!financial.hasEverBeenFullyAccounted) {
    return 'AWAITING_FUNDING';
  }

  // Active Milestone Precedence
  // 1. Any submitted milestone (msStatus === 2)
  const hasSubmitted = list.some((m) => Number(m.msStatus) === 2);
  if (hasSubmitted) return 'AWAITING_REVIEW';

  // 2. Any revision in progress (msStatus === 1 with evidence)
  const hasRevision = list.some(
    (m) => Number(m.msStatus) === 1 && !!m.evidenceHash && m.evidenceHash.trim() !== ''
  );
  if (hasRevision) return 'REVISION_IN_PROGRESS';

  // 3. Any initial work in progress (msStatus === 1 without evidence)
  const hasWorkInProgress = list.some(
    (m) => Number(m.msStatus) === 1 && (!m.evidenceHash || m.evidenceHash.trim() === '')
  );
  if (hasWorkInProgress) return 'IN_PROGRESS';

  // 4. Any pending milestone (msStatus === 0)
  const hasPending = list.some((m) => Number(m.msStatus) === 0);
  if (hasPending) return 'READY_TO_START';

  // 5. All milestones approved
  const allApproved = list.length > 0 && list.every((m) => Number(m.msStatus) === 3);
  if (allApproved) return 'COMPLETED';

  // Fallback
  return 'IN_PROGRESS';
}

/**
  * Derives attention state for viewer role.
  */
export function deriveDealAttention(
  phase: DerivedDealPhase,
  role: DealViewerRole
): DealAttention {
  if (role === 'disconnected' || role === 'third_party') {
    if (phase === 'COMPLETED' || phase === 'CANCELLED') return 'resolved';
    if (phase === 'DISPUTED') return 'blocked';
    return 'in_progress';
  }

  if (phase === 'COMPLETED' || phase === 'CANCELLED') return 'resolved';
  if (phase === 'DISPUTED') return 'blocked';

  const isBuyerRole = role === 'buyer' || role === 'buyer_and_seller';
  const isSellerRole = role === 'seller' || role === 'buyer_and_seller';

  if (isBuyerRole) {
    if (phase === 'NEEDS_MILESTONES' || phase === 'AWAITING_FUNDING' || phase === 'AWAITING_REVIEW') {
      return 'action_required';
    }
  }

  if (isSellerRole) {
    if (phase === 'READY_TO_START' || phase === 'IN_PROGRESS' || phase === 'REVISION_IN_PROGRESS') {
      return 'action_required';
    }
  }

  return 'waiting_on_counterparty';
}

/**
  * Generates next action content for role and phase.
  */
export function deriveNextAction(
  phase: DerivedDealPhase,
  role: DealViewerRole,
  financial: FinancialSummary,
  currentMilestoneIdx: number | null,
  milestones: MilestoneStructInput[] | undefined | null
): DealNextAction {
  if (role === 'disconnected') {
    return {
      actionOwner: 'none',
      headline: 'Connect wallet',
      description: 'Connect the wallet participating in this deal to manage it.',
      primaryAction: 'CONNECT_WALLET',
      targetMilestoneIndex: currentMilestoneIdx,
    };
  }

  if (role === 'third_party') {
    return {
      actionOwner: 'none',
      headline: 'Read-only view',
      description: 'This connected wallet is not a participant in this deal.',
      primaryAction: null,
      targetMilestoneIndex: currentMilestoneIdx,
    };
  }

  const isBuyerRole = role === 'buyer' || role === 'buyer_and_seller';
  const isSellerRole = role === 'seller' || role === 'buyer_and_seller';

  switch (phase) {
    case 'CANCELLED':
      return {
        actionOwner: 'none',
        headline: 'Deal cancelled',
        description: 'This deal was cancelled. Remaining escrow balance was returned to the client.',
        primaryAction: null,
        targetMilestoneIndex: currentMilestoneIdx,
      };

    case 'DISPUTED':
      return {
        actionOwner: 'both',
        headline: 'Dispute active',
        description: 'Escrow is frozen while the dispute is active. Both parties can consent to mutual resolution, or administrator resolution may finalize it.',
        primaryAction: 'DISPUTE_ACTION',
        targetMilestoneIndex: currentMilestoneIdx,
      };

    case 'COMPLETED':
      return {
        actionOwner: 'none',
        headline: 'Deal completed',
        description: 'All milestones approved and escrow balance fully settled.',
        primaryAction: null,
        targetMilestoneIndex: currentMilestoneIdx,
      };

    case 'NEEDS_MILESTONES':
      if (isBuyerRole) {
        return {
          actionOwner: 'buyer',
          headline: 'Add the first milestone',
          description: financial.hasEverBeenFullyAccounted
            ? 'Escrow is funded. Add the first milestone to define the work.'
            : 'Define the first milestone before work begins.',
          primaryAction: 'ADD_MILESTONE',
          targetMilestoneIndex: null,
        };
      } else {
        return {
          actionOwner: 'buyer',
          headline: 'Waiting for client',
          description: 'The client needs to define the work milestones.',
          primaryAction: null,
          targetMilestoneIndex: null,
        };
      }

    case 'AWAITING_FUNDING':
      if (isBuyerRole) {
        return {
          actionOwner: 'buyer',
          headline: 'Fund this deal',
          description: 'Escrow must be funded before work on milestones can begin.',
          primaryAction: 'FUND_ESCROW',
          targetMilestoneIndex: currentMilestoneIdx,
        };
      } else {
        return {
          actionOwner: 'buyer',
          headline: 'Waiting for escrow funding',
          description: 'The client needs to fund escrow before work can begin.',
          primaryAction: null,
          targetMilestoneIndex: currentMilestoneIdx,
        };
      }

    case 'READY_TO_START':
      if (isSellerRole) {
        return {
          actionOwner: 'seller',
          headline: 'Ready to start',
          description: 'Escrow is funded. You can begin work on the current milestone.',
          primaryAction: 'START_MILESTONE',
          targetMilestoneIndex: currentMilestoneIdx,
        };
      } else {
        return {
          actionOwner: 'seller',
          headline: 'Waiting for freelancer',
          description: 'Escrow is funded. Waiting for the freelancer to start work.',
          primaryAction: null,
          targetMilestoneIndex: currentMilestoneIdx,
        };
      }

    case 'IN_PROGRESS':
      if (isSellerRole) {
        return {
          actionOwner: 'seller',
          headline: 'Submit your work',
          description: 'Upload deliverable link or evidence for client review.',
          primaryAction: 'SUBMIT_MILESTONE',
          targetMilestoneIndex: currentMilestoneIdx,
        };
      } else {
        return {
          actionOwner: 'seller',
          headline: 'Work in progress',
          description: 'Freelancer is working on the active milestone.',
          primaryAction: null,
          targetMilestoneIndex: currentMilestoneIdx,
        };
      }

    case 'REVISION_IN_PROGRESS':
      if (isSellerRole) {
        return {
          actionOwner: 'seller',
          headline: 'Submit revised work',
          description: 'Client requested revisions. Upload updated deliverable for review.',
          primaryAction: 'SUBMIT_MILESTONE',
          targetMilestoneIndex: currentMilestoneIdx,
        };
      } else {
        return {
          actionOwner: 'seller',
          headline: 'Revision in progress',
          description: 'Freelancer is working on requested milestone changes.',
          primaryAction: null,
          targetMilestoneIndex: currentMilestoneIdx,
        };
      }

    case 'AWAITING_REVIEW':
      if (isBuyerRole) {
        return {
          actionOwner: 'buyer',
          headline: 'Review submitted work',
          description: 'Freelancer submitted milestone work. Review evidence and approve payment release.',
          primaryAction: 'APPROVE_MILESTONE',
          targetMilestoneIndex: currentMilestoneIdx,
        };
      } else {
        return {
          actionOwner: 'buyer',
          headline: 'Waiting for client review',
          description: 'Work submitted. Waiting for client to approve and release payment.',
          primaryAction: null,
          targetMilestoneIndex: currentMilestoneIdx,
        };
      }
  }
}

/**
  * Derives visualizer stages (5 stable stages: AGREED, FUNDED, WORK, REVIEW, COMPLETE).
  */
export function deriveLifecycleStages(
  phase: DerivedDealPhase,
  statusNum: number,
  financial: FinancialSummary,
  milestones: MilestoneStructInput[] | undefined | null
): DealLifecycleStage[] {
  const isCancelled = statusNum === 4;
  const isDisputed = statusNum === 3;
  const isCompleted = statusNum === 2;

  const fundedComplete = financial.hasEverBeenFullyAccounted;
  const workComplete = isCompleted || (milestones || []).some((m) => Number(m.msStatus) === 3);
  const reviewComplete = isCompleted || ((milestones || []).length > 0 && (milestones || []).every((m) => Number(m.msStatus) === 3));

  let fundedStatus: 'complete' | 'active' | 'upcoming' | 'error' = 'upcoming';
  let workStatus: 'complete' | 'active' | 'upcoming' | 'error' = 'upcoming';
  let reviewStatus: 'complete' | 'active' | 'upcoming' | 'error' = 'upcoming';
  let completeStatus: 'complete' | 'active' | 'upcoming' | 'error' = 'upcoming';

  if (isCancelled || isDisputed) {
    if (fundedComplete) fundedStatus = 'complete';
    else fundedStatus = 'upcoming';

    if (workComplete) workStatus = 'complete';
    else workStatus = 'upcoming';

    if (reviewComplete) reviewStatus = 'complete';
    else reviewStatus = 'upcoming';

    completeStatus = isDisputed ? 'error' : 'upcoming';
  } else if (isCompleted) {
    fundedStatus = 'complete';
    workStatus = 'complete';
    reviewStatus = 'complete';
    completeStatus = 'complete';
  } else {
    // Active states
    if (fundedComplete) {
      fundedStatus = 'complete';
    } else if (phase === 'AWAITING_FUNDING') {
      fundedStatus = 'active';
    } else {
      fundedStatus = 'upcoming';
    }

    if (phase === 'READY_TO_START' || phase === 'IN_PROGRESS' || phase === 'REVISION_IN_PROGRESS') {
      workStatus = 'active';
    } else if (workComplete) {
      workStatus = 'complete';
    }

    if (phase === 'AWAITING_REVIEW') {
      reviewStatus = 'active';
      workStatus = 'complete';
    } else if (reviewComplete) {
      reviewStatus = 'complete';
    }
  }

  return [
    { id: 'AGREED', label: 'Agreement', status: 'complete' },
    { id: 'FUNDED', label: 'Funded', status: fundedStatus },
    { id: 'WORK', label: 'Work', status: workStatus },
    { id: 'REVIEW', label: 'Review', status: reviewStatus },
    { id: 'COMPLETE', label: 'Complete', status: completeStatus },
  ];
}

/**
  * Identifies non-blocking anomalies.
  */
export function deriveAnomalies(
  deal: DealInputData,
  financial: FinancialSummary
): DealUXAnomaly[] {
  const anomalies: DealUXAnomaly[] = [];
  const milestones = deal.milestones || [];
  const statusNum = Number(deal.status ?? 0);

  if (statusNum === 1 && financial.hasEverBeenFullyAccounted && milestones.length === 0) {
    anomalies.push({
      code: 'ACTIVE_FUNDED_NO_MILESTONES',
      message: 'Escrow is funded, but no milestones have been defined yet.',
    });
  }

  if (statusNum === 1 && !financial.hasEverBeenFullyAccounted) {
    const hasStartedWork = milestones.some((m) => Number(m.msStatus) >= 1);
    if (hasStartedWork) {
      anomalies.push({
        code: 'UNFUNDED_WORK_STARTED',
        message: 'Work was started/submitted before escrow funding was completed.',
      });
    }
  }

  if (milestones.length > 0 && financial.totalValue > 0n) {
    const totalMilestoneAllocated = milestones.reduce(
      (sum, m) => sum + toBigIntSafely(m.amount),
      0n
    );
    if (totalMilestoneAllocated > financial.totalValue) {
      anomalies.push({
        code: 'MILESTONES_OVER_ALLOCATED',
        message: 'Total milestone amounts exceed the deal total value.',
      });
    }
  }

  const inProgressCount = milestones.filter((m) => Number(m.msStatus) === 1).length;
  if (inProgressCount > 1) {
    anomalies.push({
      code: 'MULTIPLE_IN_PROGRESS',
      message: 'Multiple milestones are in progress simultaneously.',
    });
  }

  return anomalies;
}

/**
  * Main entry point: pure derivation of full Deal UX state.
  */
export function deriveDealUX(
  connectedAddress: string | undefined | null,
  deal: DealInputData
): DealUXState {
  const statusNum = Number(deal.status ?? 0);
  const role = deriveViewerRole(connectedAddress, deal.buyer, deal.seller);
  const financial = deriveFinancialSummary(
    deal.totalValue,
    deal.escrowBalance,
    deal.milestones,
    statusNum
  );

  const phase = deriveDealPhase(statusNum, deal.milestones, financial);
  const attention = deriveDealAttention(phase, role);
  const currentMilestoneIndex = getCurrentMilestoneIndex(deal.milestones);
  const nextAction = deriveNextAction(
    phase,
    role,
    financial,
    currentMilestoneIndex,
    deal.milestones
  );
  const lifecycleStages = deriveLifecycleStages(
    phase,
    statusNum,
    financial,
    deal.milestones
  );
  const anomalies = deriveAnomalies(deal, financial);

  return {
    role,
    phase,
    attention,
    currentMilestoneIndex,
    financial,
    nextAction,
    lifecycleStages,
    anomalies,
    rawState: deal,
  };
}
