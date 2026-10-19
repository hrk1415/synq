'use client';

import React from 'react';
import {
  Scale,
  Lock,
  Clock,
  User,
  AlertCircle,
  CheckCircle2,
  Calendar,
  FileText,
  Loader2,
  Info,
  ShieldAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { shortenAddress, cn } from '@/lib/utils';
import { formatUsdcAmount } from '@/lib/deals/v2';
import {
  MilestoneStatus,
  StandardV2OnChainMilestone,
  StandardV2ResolutionProposal,
} from '@/lib/deals/v2-deal';
import type { CanonicalResolutionReportV1 } from '@/lib/deals/v2-resolution-report';
import { formatProposalDate } from './ActiveDisputeWorkspace';

export interface DisputeOverviewHeaderProps {
  currentIndex: number;
  totalMilestones?: number;
  milestoneTitle?: string;
  milestone: StandardV2OnChainMilestone;
  clientAddress: string;
  freelancerAddress: string;
  currentUserAddress?: string;
  disputeRecord?: {
    dispute?: any;
    manifest?: any;
  } | null;
  loadingDisputeRecord?: boolean;
  disputeRecordError?: string | null;
  resolutionProposal?: StandardV2ResolutionProposal | null;
  loadingResolutionProposal?: boolean;
  finalReport?: CanonicalResolutionReportV1 | null;
  className?: string;
}

function formatDisputeDate(dateValue: string | Date | number | undefined | null): string {
  if (!dateValue) return '—';
  try {
    const d = new Date(dateValue);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}



export function DisputeOverviewHeader({
  currentIndex,
  totalMilestones,
  milestoneTitle,
  milestone,
  clientAddress,
  freelancerAddress,
  currentUserAddress,
  disputeRecord,
  loadingDisputeRecord,
  disputeRecordError,
  resolutionProposal,
  loadingResolutionProposal,
  finalReport,
  className,
}: DisputeOverviewHeaderProps) {
  const normUser = currentUserAddress?.toLowerCase();
  const normClient = clientAddress.toLowerCase();
  const normFreelancer = freelancerAddress.toLowerCase();

  const isClient = Boolean(normUser && normUser === normClient);
  const isFreelancer = Boolean(normUser && normUser === normFreelancer);
  const isParticipant = isClient || isFreelancer;

  // 1. Status Badge Configuration
  const getStatusConfig = (status: MilestoneStatus) => {
    switch (status) {
      case MilestoneStatus.Disputed:
        return {
          title: 'Dispute Active',
          badgeText: 'Dispute Open',
          badgeVariant: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
          containerBorder: 'border-rose-500/30 bg-rose-950/10',
          icon: <Scale className="h-4 w-4 text-rose-400" />,
        };
      case MilestoneStatus.ResolutionProposed:
        return {
          title: 'Resolution Proposed',
          badgeText: 'Resolution Proposed',
          badgeVariant: 'border-purple-500/40 bg-purple-500/10 text-purple-300',
          containerBorder: 'border-purple-500/30 bg-purple-950/10',
          icon: <Clock className="h-4 w-4 text-purple-400" />,
        };
      case MilestoneStatus.FinalReview:
        return {
          title: 'Reconsideration In Progress',
          badgeText: 'Final Review',
          badgeVariant: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
          containerBorder: 'border-amber-500/30 bg-amber-950/10',
          icon: <AlertCircle className="h-4 w-4 text-amber-400" />,
        };
      case MilestoneStatus.SettledSplit:
        return {
          title: 'Milestone Settled',
          badgeText: 'Settled (Split)',
          badgeVariant: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
          containerBorder: 'border-emerald-500/30 bg-emerald-950/10',
          icon: <CheckCircle2 className="h-4 w-4 text-emerald-400" />,
        };
      default:
        return {
          title: 'Dispute Review',
          badgeText: 'Disputed',
          badgeVariant: 'border-zinc-700 bg-zinc-900 text-zinc-300',
          containerBorder: 'border-zinc-800 bg-zinc-900/40',
          icon: <Scale className="h-4 w-4 text-zinc-400" />,
        };
    }
  };

  const statusConfig = getStatusConfig(milestone.status);

  // 2. Initiator Mapping
  const openerWallet =
    disputeRecord?.manifest?.openerWallet ||
    disputeRecord?.dispute?.openerWallet ||
    disputeRecord?.dispute?.canonicalManifest?.openerWallet;

  let initiatorLabel = '—';
  let initiatorDetail = '';
  let isOpenerCurrentUser = false;

  if (openerWallet) {
    const normOpener = String(openerWallet).toLowerCase();
    isOpenerCurrentUser = Boolean(normUser && normOpener === normUser);

    if (normOpener === normClient) {
      initiatorLabel = 'Client';
      initiatorDetail = shortenAddress(clientAddress);
    } else if (normOpener === normFreelancer) {
      initiatorLabel = 'Freelancer';
      initiatorDetail = shortenAddress(freelancerAddress);
    } else {
      initiatorLabel = 'Authorized Party';
      initiatorDetail = shortenAddress(openerWallet);
    }
  } else if (loadingDisputeRecord) {
    initiatorLabel = 'Checking…';
  } else if (milestone.status === MilestoneStatus.Disputed && !disputeRecord) {
    initiatorLabel = 'Revision Escalation';
    initiatorDetail = 'Declined / Timeout';
  }

  // 3. Category Mapping
  const rawCategory =
    disputeRecord?.manifest?.category ||
    disputeRecord?.dispute?.canonicalManifest?.category ||
    disputeRecord?.dispute?.category;

  let categoryLabel = '—';
  if (rawCategory) {
    categoryLabel = String(rawCategory)
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  } else if (loadingDisputeRecord) {
    categoryLabel = 'Checking…';
  } else if (milestone.status === MilestoneStatus.Disputed && !disputeRecord) {
    categoryLabel = 'Revision Escalation';
  }

  // 4. Opened Date
  const openedAtRaw =
    disputeRecord?.dispute?.openedAt ||
    disputeRecord?.dispute?.createdAt ||
    disputeRecord?.manifest?.createdAt;
  const openedDateLabel = formatDisputeDate(openedAtRaw);

  // 5. User Role Tag
  let userRoleLabel = 'Third-Party Viewer';
  if (isClient) userRoleLabel = 'Client (You)';
  else if (isFreelancer) userRoleLabel = 'Freelancer (You)';
  else if (!normUser) userRoleLabel = 'Wallet Disconnected';

  // 6. Status-Aware Guidance Description
  const renderGuidance = () => {
    switch (milestone.status) {
      case MilestoneStatus.Disputed:
        return (
          <div className="rounded-lg border border-rose-500/20 bg-rose-950/20 p-2.5 text-xs text-zinc-300 flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-rose-400 shrink-0" />
            <span>The Resolution Committee is reviewing this dispute. You can still reach a mutual settlement while review is ongoing.</span>
          </div>
        );

      case MilestoneStatus.ResolutionProposed:
        const deadlineFormatted = resolutionProposal?.reconsiderationDeadline
          ? formatProposalDate(resolutionProposal.reconsiderationDeadline)
          : '72 hours after proposal';

        return (
          <div className="rounded-lg border border-purple-500/20 bg-purple-950/20 p-3 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-purple-300">
              <Clock className="h-4 w-4 text-purple-400 shrink-0" />
              <span>Committee Proposal Active — Reconsideration Window</span>
            </div>
            <p className="text-xs text-zinc-300 leading-relaxed">
              The Resolution Committee has proposed an on-chain split resolution. A 72-hour reconsideration window is active.
              Either participant may review the proposed outcome and request final reconsideration before{' '}
              <span className="font-semibold text-white font-mono">{deadlineFormatted}</span>.
              If no reconsideration is requested, the resolution becomes executable on-chain. Mutual settlement remains available if both parties reach agreement.
            </p>
          </div>
        );

      case MilestoneStatus.FinalReview:
        return (
          <div className="rounded-lg border border-amber-500/20 bg-amber-950/20 p-3 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
              <AlertCircle className="h-4 w-4 text-amber-400 shrink-0" />
              <span>Final Reconsideration In Progress</span>
            </div>
            <p className="text-xs text-zinc-300 leading-relaxed">
              A participant requested final reconsideration within the 72-hour window. The proposing resolver is reviewing the case file and justification report.
              Once finalized, the committee will execute the final binding split directly on-chain. Mutual settlement remains available if participants wish to settle directly before committee execution.
            </p>
          </div>
        );

      case MilestoneStatus.SettledSplit:
        return (
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-950/20 p-3 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-300">
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
              <span>Milestone Settlement Complete</span>
            </div>
            <p className="text-xs text-zinc-300 leading-relaxed">
              This milestone has reached terminal settlement. Escrowed funds have been disbursed on-chain to the client and freelancer according to the confirmed settlement.
              With this milestone finalized, any subsequent sequential milestones in this deal can now proceed.
            </p>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div
      className={cn(
        'rounded-xl border p-4 space-y-4 text-white',
        statusConfig.containerBorder,
        className
      )}
    >
      {/* Top Header: Title, Status Badge, Escrow Badge */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/10 pb-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            {statusConfig.icon}
            <h3 className="text-sm font-bold tracking-tight text-white">
              Dispute & Resolution Overview
            </h3>
            <Badge variant="outline" className={cn('text-[10px] font-medium', statusConfig.badgeVariant)}>
              {statusConfig.badgeText}
            </Badge>
          </div>
          <p className="text-xs text-zinc-400">
            Milestone {currentIndex + 1}
            {totalMilestones ? ` of ${totalMilestones}` : ''}
            {milestoneTitle ? ` • ${milestoneTitle}` : ''}
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <div className="rounded-md border border-white/10 bg-[#1B1B1B] px-3 py-1 text-right">
            <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-medium block">
              {milestone.status === MilestoneStatus.SettledSplit ? 'Settled Escrow' : 'Locked Escrow'}
            </span>
            <span className="font-mono text-sm font-bold text-white flex items-center gap-1 justify-end">
              <Lock className="h-3 w-3 text-zinc-400" />
              {formatUsdcAmount(milestone.amount)} USDC
            </span>
          </div>
        </div>
      </div>

      {/* Metadata Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
        {/* Initiated By */}
        <div className="rounded-lg border border-white/10 bg-[#1B1B1B] p-2.5 space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold flex items-center gap-1">
            <User className="h-3 w-3 text-zinc-500" /> Initiated By
          </span>
          <div className="font-medium text-white flex items-center gap-1.5 flex-wrap">
            <span>{initiatorLabel}</span>
            {isOpenerCurrentUser && (
              <Badge variant="outline" className="border-purple-500/40 bg-purple-500/10 text-[9px] text-purple-300">
                You
              </Badge>
            )}
          </div>
          {initiatorDetail && (
            <div className="text-[10px] font-mono text-zinc-400 truncate" title={openerWallet || ''}>
              {initiatorDetail}
            </div>
          )}
        </div>

        {/* Dispute Category */}
        <div className="rounded-lg border border-white/10 bg-[#1B1B1B] p-2.5 space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold flex items-center gap-1">
            <FileText className="h-3 w-3 text-zinc-500" /> Category
          </span>
          <div className="font-medium text-white truncate" title={categoryLabel}>
            {categoryLabel}
          </div>
          <div className="text-[10px] text-zinc-400">
            {rawCategory ? 'Manifest Verified' : 'Standard'}
          </div>
        </div>

        {/* Date Opened */}
        <div className="rounded-lg border border-white/10 bg-[#1B1B1B] p-2.5 space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold flex items-center gap-1">
            <Calendar className="h-3 w-3 text-zinc-500" /> Opened Date
          </span>
          <div className="font-medium text-white">
            {openedDateLabel}
          </div>
          <div className="text-[10px] text-zinc-400">
            {disputeRecord?.dispute?.status === 'confirmed' ? 'On-Chain Confirmed' : 'Recorded'}
          </div>
        </div>

        {/* Connected Viewer Role */}
        <div className="rounded-lg border border-white/10 bg-[#1B1B1B] p-2.5 space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold flex items-center gap-1">
            <User className="h-3 w-3 text-zinc-500" /> Your Role
          </span>
          <div className="font-medium text-white">
            {userRoleLabel}
          </div>
          <div className="text-[10px] font-mono text-zinc-400 truncate">
            {currentUserAddress ? shortenAddress(currentUserAddress) : 'Connect Wallet'}
          </div>
        </div>
      </div>

      {/* Loading or Error States for Dispute Record */}
      {loadingDisputeRecord && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-xs text-zinc-400 flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-purple-400 shrink-0" />
          <span>Synchronizing verified dispute details from database…</span>
        </div>
      )}

      {disputeRecordError && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-2.5 text-xs text-amber-300 flex items-center gap-2">
          <Info className="h-3.5 w-3.5 text-amber-400 shrink-0" />
          <span>
            Off-chain dispute metadata unavailable. On-chain escrow status remains authoritative.
          </span>
        </div>
      )}

      {/* Status Guidance Banner */}
      {renderGuidance()}
    </div>
  );
}
