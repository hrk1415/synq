'use client';

import React, { useState, useMemo } from 'react';
import {
  Scale,
  Handshake,
  Clock,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  ChevronDown,
  ChevronUp,
  Info,
  ShieldAlert,
  Check,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { shortenAddress, cn } from '@/lib/utils';
import { formatUsdcAmount } from '@/lib/deals/v2';
import {
  MilestoneStatus,
  StandardV2OnChainMilestone,
  StandardV2ResolutionProposal,
} from '@/lib/deals/v2-deal';
import type { CanonicalResolutionReportV1 } from '@/lib/deals/v2-resolution-report';
import type { MutualSettlementProposalView } from '@/lib/deals/mutual-settlements-db';
import { MilestoneSettledSplitCard } from '@/components/deals/settlement/MilestoneSettledSplitCard';

export interface ActiveDisputeWorkspaceProps {
  dealAddress?: string;
  currentIndex: number;
  milestone: StandardV2OnChainMilestone;
  clientAddress: string;
  freelancerAddress: string;
  currentUserAddress?: string;
  isClient: boolean;
  isFreelancer: boolean;
  isParticipant: boolean;
  canUseMutualSettlement: boolean;
  canRequestReconsideration: boolean;
  canExecuteResolution: boolean;
  disputeRecord?: {
    dispute?: any;
    manifest?: any;
  } | null;
  loadingDisputeRecord?: boolean;
  disputeRecordError?: string | null;
  onRetryLoadDisputeRecord?: () => void;
  resolutionProposal?: StandardV2ResolutionProposal | null;
  loadingResolutionProposal?: boolean;
  resolutionProposalError?: string | null;
  onRetryLoadResolutionProposal?: () => void;
  isReconsiderationWindowClosed?: boolean;
  isReconsiderationWindowClosingSoon?: boolean;
  remainingReconsiderationSeconds?: bigint | null;
  initialReport?: CanonicalResolutionReportV1 | null;
  loadingInitialReport?: boolean;
  initialReportNotice?: string | null;
  finalReport?: CanonicalResolutionReportV1 | null;
  loadingFinalReport?: boolean;
  proposals: MutualSettlementProposalView[];
  loadingProposals?: boolean;
  actionInProgress?: boolean;
  onOpenProposeModal: () => void;
  onAcceptProposal: (proposal: MutualSettlementProposalView) => void;
  onCancelProposal: (proposal: MutualSettlementProposalView) => void;
  onRequestReconsideration: () => void;
  onExecuteResolution: () => void;
  onAgreeToCommitteeSplit?: () => void;
  agreeToSplitInProgress?: boolean;
  agreeToSplitError?: string | null;
  className?: string;
}

function isSafeHttpUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  return /^https?:\/\/\S+/i.test(trimmed);
}

export function formatProposalDate(timestamp: bigint | number | undefined | null): string {
  if (!timestamp || timestamp === 0n) return '—';
  const s = typeof timestamp === 'bigint' ? Number(timestamp) : timestamp;
  if (!s || s <= 0) return '—';
  try {
    const d = new Date(s * 1000);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return '—';
  }
}

function formatCountdown(diffSeconds: bigint | null | undefined): string {
  if (diffSeconds === null || diffSeconds === undefined) return '—';
  const s = Number(diffSeconds);
  if (s <= 0) return 'Window closed';
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days > 0) {
    return `${days}d ${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m`;
  }
  return `${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`;
}

export function parseTimestampSec(val: Date | string | number | undefined | null): number | null {
  if (!val) return null;
  if (typeof val === 'number') {
    if (isNaN(val) || val <= 0) return null;
    return val > 1e11 ? Math.floor(val / 1000) : Math.floor(val);
  }
  const d = typeof val === 'string' ? new Date(val) : val;
  if (d instanceof Date) {
    const ms = d.getTime();
    if (isNaN(ms) || ms <= 0) return null;
    return Math.floor(ms / 1000);
  }
  return null;
}

export function ActiveDisputeWorkspace({
  dealAddress,
  currentIndex,
  milestone,
  clientAddress,
  freelancerAddress,
  currentUserAddress,
  isClient,
  isFreelancer,
  isParticipant,
  canUseMutualSettlement,
  canRequestReconsideration,
  canExecuteResolution,
  disputeRecord,
  loadingDisputeRecord,
  disputeRecordError,
  onRetryLoadDisputeRecord,
  resolutionProposal,
  loadingResolutionProposal,
  resolutionProposalError,
  onRetryLoadResolutionProposal,
  isReconsiderationWindowClosed,
  isReconsiderationWindowClosingSoon,
  remainingReconsiderationSeconds,
  initialReport,
  loadingInitialReport,
  initialReportNotice,
  finalReport,
  loadingFinalReport,
  proposals,
  loadingProposals,
  actionInProgress,
  onOpenProposeModal,
  onAcceptProposal,
  onCancelProposal,
  onRequestReconsideration,
  onExecuteResolution,
  onAgreeToCommitteeSplit,
  agreeToSplitInProgress,
  agreeToSplitError,
  className,
}: ActiveDisputeWorkspaceProps) {
  const [showReportDrawer, setShowReportDrawer] = useState<boolean>(false);
  const [showDisputeDetails, setShowDisputeDetails] = useState<boolean>(true);

  const isDisputed = milestone.status === MilestoneStatus.Disputed;
  const isResolutionProposed = milestone.status === MilestoneStatus.ResolutionProposed;
  const isFinalReview = milestone.status === MilestoneStatus.FinalReview;
  const isSettledSplit = milestone.status === MilestoneStatus.SettledSplit;

  // Detect matching active mutual settlement proposal for the exact committee split
  const matchingCommitteeProposal = useMemo(() => {
    if (!resolutionProposal || !proposals) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    const proposedAtSec = Number(resolutionProposal.proposedAt);

    return (
      proposals.find((p) => {
        if (p.status !== 'pending' || p.isExpired || Number(p.validUntil) < nowSec) {
          return false;
        }
        if (
          BigInt(p.freelancerAmount) !== resolutionProposal.freelancerAmount ||
          BigInt(p.clientAmount) !== resolutionProposal.clientAmount
        ) {
          return false;
        }

        // Conservative timestamp check: proposal must have been created at or after the committee resolution
        const createdAtSec = parseTimestampSec(p.createdAt);
        if (createdAtSec === null || (proposedAtSec > 0 && createdAtSec < proposedAtSec)) {
          return false;
        }

        return true;
      }) || null
    );
  }, [resolutionProposal, proposals]);

  // ---------------------------------------------------------------------------
  // Render Improved Mutual Settlement Proposals List
  // ---------------------------------------------------------------------------
  const renderProposalsList = () => {
    if (loadingProposals) {
      return (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-center text-xs text-zinc-400 flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-purple-400" />
          <span>Loading settlement proposals…</span>
        </div>
      );
    }

    if (proposals.length === 0) {
      return (
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 py-2.5 px-3 text-center text-xs text-zinc-500">
          No active settlement proposals.
        </div>
      );
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const activeProposalsCount = proposals.filter(
      (p) => p.status === 'pending' && !p.isExpired && Number(p.validUntil) >= nowSec
    ).length;

    return (
      <div className="space-y-3">
        {activeProposalsCount > 0 && (
          <p className="text-[11px] text-zinc-400">
            Counteroffers do not cancel earlier offers. Cancel an active offer to revoke it.
          </p>
        )}
        {proposals.map((p) => {
          const normProposer = p.proposerWallet.toLowerCase();
          const normUser = currentUserAddress?.toLowerCase();
          const normClient = clientAddress.toLowerCase();
          const normFreelancer = freelancerAddress.toLowerCase();

          const isProposer = Boolean(normUser && normProposer === normUser);
          const isCounterparty = Boolean(normUser && normProposer !== normUser && (normUser === normClient || normUser === normFreelancer));

          const proposerLabel = isProposer
            ? 'Proposed by You'
            : normProposer === normClient
            ? 'Proposed by Client'
            : normProposer === normFreelancer
            ? 'Proposed by Freelancer'
            : `Proposed by ${shortenAddress(p.proposerWallet)}`;

          const nowSec = Math.floor(Date.now() / 1000);
          const isExpired = p.isExpired || Number(p.validUntil) < nowSec;
          const isPending = p.status === 'pending' && !isExpired;
          const isExecuted = p.status === 'executed';
          const isCancelled = p.status === 'cancelled';
          const isInvalidated = p.status === 'invalidated';

          return (
            <div
              key={p.id}
              className={cn(
                'rounded-xl border p-3.5 text-xs transition-colors space-y-3',
                isExecuted
                  ? 'border-emerald-500/40 bg-emerald-950/20'
                  : isCancelled || isExpired || isInvalidated
                  ? 'border-zinc-800/80 bg-zinc-950/40 opacity-70'
                  : isCounterparty && p.isExecutable
                  ? 'border-purple-500/40 bg-purple-950/20 shadow-sm'
                  : 'border-zinc-800 bg-zinc-900/60'
              )}
            >
              {/* Proposal Header */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/70 pb-2.5">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-white flex items-center gap-1.5">
                    <Handshake className="h-3.5 w-3.5 text-purple-400" />
                    <span>{proposerLabel}</span>
                  </span>
                  {isProposer && (
                    <Badge variant="outline" className="border-purple-500/40 bg-purple-500/10 text-purple-300 text-[9px]">
                      You
                    </Badge>
                  )}
                  <span className="font-mono text-[10px] text-zinc-500">
                    Nonce #{p.proposalNonce}
                  </span>
                </div>

                {/* Status Badges */}
                <div>
                  {isExecuted ? (
                    <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/15 text-emerald-300 text-[10px] flex items-center gap-1">
                      <Check className="h-3 w-3 stroke-[2.5]" /> Executed On-Chain
                    </Badge>
                  ) : isCancelled ? (
                    <Badge variant="outline" className="border-zinc-700 bg-zinc-800 text-zinc-400 text-[10px]">
                      Cancelled by Proposer
                    </Badge>
                  ) : isExpired ? (
                    <Badge variant="outline" className="border-rose-500/30 bg-rose-950/30 text-rose-300 text-[10px]">
                      Expired
                    </Badge>
                  ) : isInvalidated ? (
                    <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-[10px]">
                      Superseded
                    </Badge>
                  ) : isCounterparty && p.isExecutable ? (
                    <Badge variant="outline" className="border-amber-500/40 bg-amber-500/15 text-amber-300 text-[10px] animate-pulse">
                      Awaiting Your Action
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-purple-500/40 bg-purple-500/10 text-purple-300 text-[10px]">
                      Pending Counterparty
                    </Badge>
                  )}
                </div>
              </div>

              {/* Proposal Amounts Breakdown */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2.5 space-y-1">
                  <div className="text-[10px] text-zinc-400 uppercase font-semibold">Freelancer Payout</div>
                  <div className="text-sm font-bold text-white font-mono flex items-center gap-1.5">
                    <span>{formatUsdcAmount(BigInt(p.freelancerAmount))} USDC</span>
                    {isFreelancer && (
                      <Badge variant="outline" className="border-emerald-500/30 text-[9px] text-emerald-300 font-sans">
                        Your Payout
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2.5 space-y-1">
                  <div className="text-[10px] text-zinc-400 uppercase font-semibold">Client Refund</div>
                  <div className="text-sm font-bold text-white font-mono flex items-center gap-1.5">
                    <span>{formatUsdcAmount(BigInt(p.clientAmount))} USDC</span>
                    {isClient && (
                      <Badge variant="outline" className="border-indigo-500/30 text-[9px] text-indigo-300 font-sans">
                        Your Refund
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2.5 space-y-1">
                  <div className="text-[10px] text-zinc-400 uppercase font-semibold">Validity / Expiry</div>
                  <div className={cn("text-xs font-mono", isExpired ? "text-zinc-500" : "text-zinc-300")}>
                    {formatProposalDate(Number(p.validUntil))}
                  </div>
                </div>
              </div>

              {/* Contextual Proposal Actions */}
              {(isProposer || isCounterparty) && isPending && (
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-zinc-800/60">
                  <span className="text-[11px] text-zinc-400">
                    {isCounterparty && p.isExecutable
                      ? 'Accepting this proposal will settle the milestone immediately on-chain.'
                      : isProposer
                      ? 'You may cancel this proposal before the counterparty accepts it.'
                      : ''}
                  </span>

                  <div className="flex items-center gap-2 ml-auto">
                    {isProposer && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-rose-500/40 text-rose-300 hover:bg-rose-950/40 hover:border-rose-500/70"
                        disabled={actionInProgress}
                        onClick={() => onCancelProposal(p)}
                      >
                        Cancel Proposal
                      </Button>
                    )}

                    {isCounterparty && p.isExecutable && (
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1.5"
                        disabled={actionInProgress}
                        onClick={() => onAcceptProposal(p)}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        <span>Accept & Settle Split</span>
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // 1. DISPUTED STATE
  // ---------------------------------------------------------------------------
  if (isDisputed) {
    return (
      <div className={cn('space-y-3.5 text-white', className)}>
        {/* Dispute Details Section */}
        {isParticipant && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5 space-y-3">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
              <span className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                <FileText className="h-4 w-4 text-rose-400" /> Dispute Escalation Details
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setShowDisputeDetails((prev) => !prev)}
                className="h-6 text-[11px] text-zinc-400 hover:text-white p-1 flex items-center gap-1"
              >
                <span>{showDisputeDetails ? 'Collapse' : 'Expand'}</span>
                {showDisputeDetails ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </Button>
            </div>

            {showDisputeDetails && (
              <>
                {loadingDisputeRecord ? (
                  <div className="rounded-lg border border-zinc-800 p-4 text-center text-xs text-zinc-400 flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-rose-400" />
                    <span>Retrieving dispute record…</span>
                  </div>
                ) : disputeRecordError ? (
                  <div className="rounded-lg border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-300 flex items-center justify-between">
                    <span>{disputeRecordError}</span>
                    {onRetryLoadDisputeRecord && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={onRetryLoadDisputeRecord}
                        className="h-6 text-[11px] border-rose-500/40 text-rose-300 hover:bg-rose-900/40"
                      >
                        Retry
                      </Button>
                    )}
                  </div>
                ) : disputeRecord ? (
                  <div className="space-y-3 text-xs">
                    <div className="space-y-1">
                      <div className="text-[10px] uppercase font-semibold text-zinc-400">Explanation</div>
                      <div className="rounded-lg bg-zinc-950/70 p-3 text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed border border-zinc-800/80">
                        {disputeRecord.dispute?.canonicalManifest?.explanation || disputeRecord.manifest?.explanation}
                      </div>
                    </div>

                    {disputeRecord.manifest?.links && disputeRecord.manifest.links.length > 0 && (
                      <div className="space-y-1.5 pt-1">
                        <div className="text-[10px] uppercase font-semibold text-zinc-400">
                          Supporting Evidence Links ({disputeRecord.manifest.links.length})
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                          {disputeRecord.manifest.links.map((link: any, idx: number) => (
                            <a
                              key={idx}
                              href={link.value}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/50 px-2.5 py-1.5 text-xs text-purple-300 hover:border-purple-500/40 transition-colors"
                            >
                              <span className="truncate">{link.label || link.value}</span>
                              <ExternalLink className="h-3 w-3 shrink-0 ml-1.5 opacity-70" />
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-300 space-y-1">
                    <div className="font-semibold text-white flex items-center gap-1.5">
                      <AlertCircle className="h-3.5 w-3.5 text-amber-400" /> Revision Escalation
                    </div>
                    <p className="text-[11px] text-zinc-400 leading-relaxed">
                      This dispute was triggered after a formal revision request was declined or timed out. Escrow remains held securely while adjudication is pending.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Observer Informational State for Non-Participants */}
        {!isParticipant && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-xs text-zinc-400 space-y-1">
            <div className="font-semibold text-zinc-200 flex items-center gap-1.5">
              <Scale className="h-4 w-4 text-zinc-400" />
              <span>Dispute Under Review</span>
            </div>
            <p className="text-[11px] text-zinc-400 leading-relaxed">
              This milestone is currently in formal dispute. Evidence and settlement negotiations are private to the deal participants.
            </p>
          </div>
        )}

        {/* Mutual Settlement Section */}
        {canUseMutualSettlement && (
          <div className="rounded-xl border border-purple-500/20 bg-zinc-900/50 p-4 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
              <div className="space-y-0.5">
                <span className="text-sm font-bold text-white flex items-center gap-2">
                  <Handshake className="h-4 w-4 text-purple-400" /> Mutual Settlement
                </span>
                <p className="text-xs text-zinc-400">
                  Agree on how to split the escrow without waiting for a committee decision.
                </p>
              </div>

              <Button
                type="button"
                size="sm"
                onClick={onOpenProposeModal}
                disabled={actionInProgress}
                className="h-8 text-xs bg-purple-600 hover:bg-purple-500 text-white font-medium flex items-center gap-1.5"
              >
                <Handshake className="h-3.5 w-3.5" />
                <span>Propose Settlement</span>
              </Button>
            </div>

            {renderProposalsList()}
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // 2. RESOLUTION PROPOSED STATE
  // ---------------------------------------------------------------------------
  if (isResolutionProposed) {
    return (
      <div className={cn('space-y-3.5 text-white', className)}>
        {/* Committee Proposed Split Card */}
        <div className="rounded-lg border border-purple-500/30 bg-purple-950/20 p-4 space-y-3.5">
          <div className="border-b border-purple-500/20 pb-2.5 space-y-0.5">
            <span className="text-sm font-bold text-white flex items-center gap-2">
              <Scale className="h-4 w-4 text-purple-400" /> Committee Resolution Proposed
            </span>
            <p className="text-xs text-zinc-300">
              The Resolution Committee has evaluated this dispute and proposed the following on-chain payout split:
            </p>
          </div>

          {loadingResolutionProposal ? (
            <div className="rounded-lg border border-zinc-800 p-4 text-center text-xs text-zinc-400 flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-purple-400" />
              <span>Loading on-chain proposal…</span>
            </div>
          ) : resolutionProposalError ? (
            <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-xs text-red-300 flex items-center justify-between">
              <span>{resolutionProposalError}</span>
              {onRetryLoadResolutionProposal && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onRetryLoadResolutionProposal}
                  className="h-6 text-[11px] border-red-500/40 text-red-300 hover:bg-red-900/40"
                >
                  Retry
                </Button>
              )}
            </div>
          ) : resolutionProposal ? (
            <div className="space-y-3.5">
              {/* Proposed Split Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="rounded-lg border border-purple-500/20 bg-zinc-950/60 p-3 space-y-1">
                  <div className="text-[10px] text-zinc-400 uppercase font-semibold">Freelancer Receives</div>
                  <div className="text-lg font-bold text-white font-mono flex items-center gap-2">
                    <span>{formatUsdcAmount(resolutionProposal.freelancerAmount)} USDC</span>
                    {isFreelancer && (
                      <Badge variant="outline" className="border-emerald-500/40 text-[9px] text-emerald-300 font-sans">
                        Your Payout
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-purple-500/20 bg-zinc-950/60 p-3 space-y-1">
                  <div className="text-[10px] text-zinc-400 uppercase font-semibold">Client Receives</div>
                  <div className="text-lg font-bold text-white font-mono flex items-center gap-2">
                    <span>{formatUsdcAmount(resolutionProposal.clientAmount)} USDC</span>
                    {isClient && (
                      <Badge variant="outline" className="border-indigo-500/40 text-[9px] text-indigo-300 font-sans">
                        Your Refund
                      </Badge>
                    )}
                  </div>
                </div>
              </div>

              {/* Early Agreement with Committee Split (Section 2) */}
              {isParticipant && !isReconsiderationWindowClosed && (
                <div className="rounded-lg border border-purple-500/30 bg-purple-950/20 p-3.5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-semibold text-xs text-white">
                      <Handshake className="h-4 w-4 text-purple-400" />
                      <span>Early Agreement Option</span>
                    </div>
                    {matchingCommitteeProposal && (
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[10px]',
                          matchingCommitteeProposal.proposerWallet.toLowerCase() === currentUserAddress?.toLowerCase()
                            ? 'border-purple-500/40 text-purple-300 bg-purple-500/10'
                            : 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
                        )}
                      >
                        {matchingCommitteeProposal.proposerWallet.toLowerCase() === currentUserAddress?.toLowerCase()
                          ? 'You Agreed • Awaiting Counterparty'
                          : 'Counterparty Agreed • Ready to Settle'}
                      </Badge>
                    )}
                  </div>

                  <p className="text-[11px] text-zinc-300 leading-relaxed">
                    {matchingCommitteeProposal
                      ? matchingCommitteeProposal.proposerWallet.toLowerCase() === currentUserAddress?.toLowerCase()
                        ? 'You have signed an agreement accepting the committee’s proposed split. If the other participant accepts it, this milestone will settle immediately on-chain.'
                        : 'The other participant has agreed to the committee’s proposed split. You can accept now to settle this milestone immediately on-chain without waiting for the 72-hour review window.'
                      : 'Satisfied with the committee’s split? You can agree to it now. If both participants agree, the funds settle immediately on-chain via mutual settlement without waiting for the 72-hour window.'}
                  </p>

                  {agreeToSplitError && (
                    <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2 text-xs text-red-300 flex items-start gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0 mt-0.5" />
                      <span>{agreeToSplitError}</span>
                    </div>
                  )}

                  <div className="flex items-center gap-2 pt-1">
                    {matchingCommitteeProposal ? (
                      matchingCommitteeProposal.proposerWallet.toLowerCase() !== currentUserAddress?.toLowerCase() ? (
                        <Button
                          type="button"
                          size="sm"
                          className="h-8 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1.5"
                          onClick={() => onAcceptProposal(matchingCommitteeProposal)}
                          disabled={actionInProgress}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>Accept Split & Settle Immediately</span>
                        </Button>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            disabled
                            className="h-8 text-xs bg-purple-900/40 border border-purple-500/30 text-purple-300 opacity-90 cursor-default flex items-center gap-1.5"
                          >
                            <Check className="h-3.5 w-3.5 text-purple-400" />
                            <span>Agreed to Committee Split</span>
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-8 text-[11px] text-zinc-400 hover:text-red-300 hover:bg-red-950/20"
                            onClick={() => onCancelProposal(matchingCommitteeProposal)}
                            disabled={actionInProgress}
                          >
                            Withdraw Agreement
                          </Button>
                        </div>
                      )
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 text-xs bg-purple-600 hover:bg-purple-500 text-white font-medium flex items-center gap-1.5"
                        onClick={onAgreeToCommitteeSplit}
                        disabled={agreeToSplitInProgress || actionInProgress}
                      >
                        {agreeToSplitInProgress ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            <span>Signing Agreement…</span>
                          </>
                        ) : (
                          <>
                            <Handshake className="h-3.5 w-3.5" />
                            <span>Agree to Committee Split</span>
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {/* Reconsideration Window Panel (Section 1 & 4) */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-zinc-200 flex items-center gap-1.5 font-semibold">
                    <Clock className="h-3.5 w-3.5 text-purple-400" />
                    <span>{isReconsiderationWindowClosed ? 'Reconsideration Period Ended' : '72-Hour Reconsideration Window'}</span>
                  </span>

                  <div>
                    {isReconsiderationWindowClosed ? (
                      <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px] flex items-center gap-1">
                        <Check className="h-3 w-3" /> Ready to Settle On-Chain
                      </Badge>
                    ) : isReconsiderationWindowClosingSoon ? (
                      <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px] animate-pulse">
                        Closing Soon
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-purple-500/40 bg-purple-500/10 text-purple-300 text-[10px]">
                        Appeal Window Active
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] pt-1 border-t border-zinc-800">
                  <div>
                    <span className="text-zinc-400">Deadline: </span>
                    <span className="text-zinc-200 font-mono">
                      {formatProposalDate(resolutionProposal.reconsiderationDeadline)}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-400">Remaining: </span>
                    <span className={cn('font-mono font-semibold', isReconsiderationWindowClosed ? 'text-zinc-400' : isReconsiderationWindowClosingSoon ? 'text-amber-300' : 'text-purple-300')}>
                      {formatCountdown(remainingReconsiderationSeconds)}
                    </span>
                  </div>
                </div>

                <p className="text-[11px] text-zinc-400 leading-relaxed pt-0.5">
                  {isReconsiderationWindowClosed
                    ? 'The 72-hour reconsideration period has concluded without an appeal. The committee’s Initial Resolution can now be finalized on-chain by either participant. No further committee decision is required.'
                    : 'Reconsideration is optional. If neither participant appeals before the deadline, this proposed resolution becomes final and ready to execute on-chain. If you agree with the split, no appeal is required.'}
                </p>
              </div>

              {/* Contextual Action Buttons */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-purple-500/20">
                {isParticipant && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowReportDrawer((prev) => !prev)}
                    className="h-8 text-xs text-purple-300 hover:text-purple-100 hover:bg-purple-950/40 flex items-center gap-1.5"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    <span>{showReportDrawer ? 'Hide Resolution Report' : 'View Resolution Report'}</span>
                    {showReportDrawer ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  </Button>
                )}

                <div className="flex items-center gap-2 ml-auto">
                  {/* Secondary/Outline Reconsideration (Appeal) Action */}
                  {canRequestReconsideration && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs border-zinc-700 text-zinc-400 hover:text-amber-300 hover:border-amber-500/60 hover:bg-amber-950/20 font-normal flex items-center gap-1"
                      onClick={onRequestReconsideration}
                      disabled={actionInProgress}
                    >
                      <AlertTriangle className="h-3 w-3" />
                      <span>Request Reconsideration (Appeal)</span>
                    </Button>
                  )}

                  {/* Prominent Execute Resolution when closed, or disabled indicator while window active */}
                  {canExecuteResolution ? (
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1.5 shadow-sm"
                      onClick={onExecuteResolution}
                      disabled={actionInProgress}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>Execute Resolution</span>
                    </Button>
                  ) : !isReconsiderationWindowClosed && (
                    <Button
                      type="button"
                      size="sm"
                      disabled
                      className="h-8 text-xs bg-zinc-800/80 border border-zinc-700/60 text-zinc-400 cursor-not-allowed flex items-center gap-1.5 opacity-80"
                      title="Unlocks automatically when the 72-hour reconsideration period concludes without an appeal."
                    >
                      <Clock className="h-3 w-3 text-zinc-500" />
                      <span>
                        Execute Resolution (Unlocks in{' '}
                        {formatCountdown(remainingReconsiderationSeconds)})
                      </span>
                    </Button>
                  )}
                </div>
              </div>

              {/* Explanatory Report Drawer (Participant Only) */}
              {isParticipant && showReportDrawer && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-3.5 space-y-3">
                  <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                    <span className="text-[11px] font-semibold text-zinc-300 flex items-center gap-1.5">
                      <FileText className="h-3.5 w-3.5 text-purple-400" /> Committee Resolution Explanatory Report
                    </span>
                    <Badge variant="outline" className="border-purple-500/30 bg-purple-500/10 text-[10px] text-purple-300">
                      Confirmed Record
                    </Badge>
                  </div>

                  {loadingInitialReport ? (
                    <div className="p-3 text-center text-xs text-zinc-400 flex items-center justify-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-purple-400" />
                      <span>Loading report…</span>
                    </div>
                  ) : initialReport ? (
                    <div className="space-y-2.5 text-xs">
                      <div className="space-y-1">
                        <div className="text-[10px] uppercase font-semibold text-zinc-400">Summary</div>
                        <div className="rounded bg-zinc-950/70 p-2.5 text-zinc-200 border border-zinc-800 leading-relaxed whitespace-pre-wrap">
                          {initialReport.summary}
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="text-[10px] uppercase font-semibold text-zinc-400">Findings</div>
                        <div className="rounded bg-zinc-950/70 p-2.5 text-zinc-200 border border-zinc-800 leading-relaxed whitespace-pre-wrap">
                          {initialReport.findings}
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="text-[10px] uppercase font-semibold text-zinc-400">Justification</div>
                        <div className="rounded bg-zinc-950/70 p-2.5 text-zinc-200 border border-zinc-800 leading-relaxed whitespace-pre-wrap">
                          {initialReport.justification}
                        </div>
                      </div>

                      {initialReport.evidenceReferences && initialReport.evidenceReferences.length > 0 && (
                        <div className="space-y-1.5 pt-1">
                          <div className="text-[10px] uppercase font-semibold text-zinc-400">
                            Evidence References ({initialReport.evidenceReferences.length})
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                            {initialReport.evidenceReferences.map((ref: any, idx: number) => {
                              const safeUrl = isSafeHttpUrl(ref.url) ? ref.url.trim() : null;
                              const title = ref.title || ref.url || `Evidence Reference #${idx + 1}`;

                              const cardContent = (
                                <div className="space-y-0.5 truncate">
                                  <div className="truncate font-medium text-white">{title}</div>
                                  {ref.hash && (
                                    <div className="font-mono text-[9px] text-zinc-500 truncate" title={ref.hash}>
                                      Hash: {ref.hash}
                                    </div>
                                  )}
                                </div>
                              );

                              return safeUrl ? (
                                <a
                                  key={idx}
                                  href={safeUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/50 px-2.5 py-1.5 text-xs text-purple-300 hover:border-purple-500/40 transition-colors"
                                >
                                  {cardContent}
                                  <ExternalLink className="h-3 w-3 shrink-0 ml-1.5 opacity-70" />
                                </a>
                              ) : (
                                <div
                                  key={idx}
                                  className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/50 px-2.5 py-1.5 text-xs text-zinc-300"
                                >
                                  {cardContent}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-[11px] text-zinc-400 py-1">
                      {initialReportNotice || 'Resolution report details are currently unavailable.'}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* Mutual Settlement Option (Preserved during ResolutionProposed) */}
        {canUseMutualSettlement && (
          <div className="rounded-xl border border-purple-500/20 bg-zinc-900/50 p-4 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
              <div className="space-y-0.5">
                <span className="text-sm font-bold text-white flex items-center gap-2">
                  <Handshake className="h-4 w-4 text-purple-400" /> Mutual Settlement
                </span>
                <p className="text-xs text-zinc-400">
                  Agree on how to split the escrow without waiting for a committee decision.
                </p>
              </div>

              <Button
                type="button"
                size="sm"
                onClick={onOpenProposeModal}
                disabled={actionInProgress}
                className="h-8 text-xs bg-purple-600 hover:bg-purple-500 text-white font-medium flex items-center gap-1.5"
              >
                <Handshake className="h-3.5 w-3.5" />
                <span>Propose Settlement</span>
              </Button>
            </div>

            {renderProposalsList()}
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // 3. FINAL REVIEW STATE
  // ---------------------------------------------------------------------------
  if (isFinalReview) {
    return (
      <div className={cn('space-y-3.5 text-white', className)}>
        {/* Final Review Notice Card */}
        <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-4 space-y-3">
          <div className="border-b border-amber-500/20 pb-2.5">
            <span className="text-sm font-bold text-white flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-400" /> Final Reconsideration In Progress
            </span>
          </div>

          <p className="text-xs text-zinc-300 leading-relaxed">
            A participant requested final reconsideration on the initial resolution proposal. The previous proposed split has been paused and will not execute. The Resolution Committee is conducting a second, comprehensive review of all milestone evidence before submitting a final binding resolution.
          </p>

          {/* Historical Initial Proposal Reference */}
          {resolutionProposal && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-2 text-xs">
              <div className="text-[10px] text-zinc-400 uppercase font-semibold">
                Initial Proposed Split (Paused / Pending Final Outcome)
              </div>
              <div className="grid grid-cols-2 gap-2 font-mono">
                <div className="rounded bg-zinc-950/60 p-2">
                  <div className="text-[10px] text-zinc-400 uppercase font-sans">Freelancer</div>
                  <div className="font-bold text-zinc-300">
                    {formatUsdcAmount(resolutionProposal.freelancerAmount)} USDC
                  </div>
                </div>
                <div className="rounded bg-zinc-950/60 p-2">
                  <div className="text-[10px] text-zinc-400 uppercase font-sans">Client</div>
                  <div className="font-bold text-zinc-300">
                    {formatUsdcAmount(resolutionProposal.clientAmount)} USDC
                  </div>
                </div>
              </div>
            </div>
          )}

          {isParticipant && (
            <div className="pt-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setShowReportDrawer((prev) => !prev)}
                className="h-8 text-xs text-amber-300 hover:text-amber-100 hover:bg-amber-950/40 flex items-center gap-1.5"
              >
                <FileText className="h-3.5 w-3.5" />
                <span>{showReportDrawer ? 'Hide Initial Resolution Report' : 'View Initial Resolution Report'}</span>
                {showReportDrawer ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </Button>
            </div>
          )}

          {isParticipant && showReportDrawer && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-3.5 space-y-3 text-xs">
              <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                <span className="text-[11px] font-semibold text-zinc-300 flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5 text-amber-400" /> Initial Resolution Report (Under Reconsideration)
                </span>
                <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300">
                  Initial Proposal Record
                </Badge>
              </div>

              {loadingInitialReport ? (
                <div className="p-3 text-center text-xs text-zinc-400 flex items-center justify-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
                  <span>Loading report…</span>
                </div>
              ) : initialReport ? (
                <div className="space-y-2.5 text-xs">
                  <div className="space-y-1">
                    <div className="text-[10px] uppercase font-semibold text-zinc-400">Summary</div>
                    <div className="rounded bg-zinc-950/70 p-2.5 text-zinc-200 border border-zinc-800 leading-relaxed whitespace-pre-wrap">
                      {initialReport.summary}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="text-[10px] uppercase font-semibold text-zinc-400">Findings</div>
                    <div className="rounded bg-zinc-950/70 p-2.5 text-zinc-200 border border-zinc-800 leading-relaxed whitespace-pre-wrap">
                      {initialReport.findings}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="text-[10px] uppercase font-semibold text-zinc-400">Justification</div>
                    <div className="rounded bg-zinc-950/70 p-2.5 text-zinc-200 border border-zinc-800 leading-relaxed whitespace-pre-wrap">
                      {initialReport.justification}
                    </div>
                  </div>

                  {initialReport.evidenceReferences && initialReport.evidenceReferences.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      <div className="text-[10px] uppercase font-semibold text-zinc-400">
                        Evidence References ({initialReport.evidenceReferences.length})
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        {initialReport.evidenceReferences.map((ref: any, idx: number) => {
                          const safeUrl = isSafeHttpUrl(ref.url) ? ref.url.trim() : null;
                          const title = ref.title || ref.url || `Evidence Reference #${idx + 1}`;

                          const cardContent = (
                            <div className="space-y-0.5 truncate">
                              <div className="truncate font-medium text-white">{title}</div>
                              {ref.hash && (
                                <div className="font-mono text-[9px] text-zinc-500 truncate" title={ref.hash}>
                                  Hash: {ref.hash}
                                </div>
                              )}
                            </div>
                          );

                          return safeUrl ? (
                            <a
                              key={idx}
                              href={safeUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/50 px-2.5 py-1.5 text-xs text-amber-300 hover:border-amber-500/40 transition-colors"
                            >
                              {cardContent}
                              <ExternalLink className="h-3 w-3 shrink-0 ml-1.5 opacity-70" />
                            </a>
                          ) : (
                            <div
                              key={idx}
                              className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/50 px-2.5 py-1.5 text-xs text-zinc-300"
                            >
                              {cardContent}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-zinc-400 py-1">
                  {initialReportNotice || 'Initial resolution report details are currently unavailable.'}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Mutual Settlement Option (Supported during FinalReview) */}
        {canUseMutualSettlement && (
          <div className="rounded-xl border border-purple-500/20 bg-zinc-900/50 p-4 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
              <div className="space-y-0.5">
                <span className="text-sm font-bold text-white flex items-center gap-2">
                  <Handshake className="h-4 w-4 text-purple-400" /> Mutual Settlement
                </span>
                <p className="text-xs text-zinc-400">
                  Agree on how to split the escrow without waiting for a committee decision.
                </p>
              </div>

              <Button
                type="button"
                size="sm"
                onClick={onOpenProposeModal}
                disabled={actionInProgress}
                className="h-8 text-xs bg-purple-600 hover:bg-purple-500 text-white font-medium flex items-center gap-1.5"
              >
                <Handshake className="h-3.5 w-3.5" />
                <span>Propose Settlement</span>
              </Button>
            </div>

            {renderProposalsList()}
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // 4. SETTLED SPLIT STATE (Shared Summary Component)
  // ---------------------------------------------------------------------------
  if (isSettledSplit) {
    return (
      <div className={cn('space-y-3.5 text-white', className)}>
        <MilestoneSettledSplitCard
          dealAddress={dealAddress || ''}
          milestone={milestone}
          clientAddress={clientAddress}
          freelancerAddress={freelancerAddress}
          currentUserAddress={currentUserAddress}
          initialProposals={proposals}
          initialFinalReport={finalReport}
          initialResolutionProposal={resolutionProposal}
        />
      </div>
    );
  }

  return null;
}
