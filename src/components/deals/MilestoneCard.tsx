'use client';

import React, { useState } from 'react';
import {
  Clock,
  CheckCircle2,
  AlertCircle,
  Play,
  Send,
  ThumbsUp,
  RotateCcw,
  Sparkles,
  ExternalLink,
  FileText,
  Loader2,
  ChevronDown,
  ChevronUp,
  Info,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn, evidenceUrl } from '@/lib/utils';
import { DealViewerRole } from '@/lib/deals/deriveDealUX';

export interface MilestoneData {
  title?: string;
  description?: string;
  amount?: bigint | number | string;
  msStatus?: number;
  dueDate?: bigint | number | string;
  evidenceHash?: string;
  completedAt?: bigint | number | string;
}

interface MilestoneCardProps {
  index: number;
  milestone: MilestoneData;
  isCurrentMilestone: boolean;
  role: DealViewerRole;
  isActiveDeal: boolean;
  tokenSymbol: string;
  formattedAmount: string;
  verification?: any;
  isVerifying?: boolean;
  onRunAiVerify?: () => void;
  onStartWork: (index: number) => void;
  onSubmitWork: (index: number, evidence: string, isRevision?: boolean) => void;
  onApproveRelease: (index: number, amount: unknown) => void;
  onRequestRevision: (index: number) => void;
  isPendingTx?: boolean;
  autoSubmitPending?: boolean;
  totalMilestones?: number;
  hasUnapprovedEarlierMilestones?: boolean;
  isUnderAllocated?: boolean;
  totalValueText?: string;
  totalAllocatedText?: string;
}

export function MilestoneCard({
  index,
  milestone,
  isCurrentMilestone,
  role,
  isActiveDeal,
  tokenSymbol,
  formattedAmount,
  verification,
  isVerifying = false,
  onRunAiVerify,
  onStartWork,
  onSubmitWork,
  onApproveRelease,
  onRequestRevision,
  isPendingTx = false,
  autoSubmitPending = false,
  totalMilestones,
  hasUnapprovedEarlierMilestones = false,
  isUnderAllocated = false,
  totalValueText = '',
  totalAllocatedText = '',
}: MilestoneCardProps) {
  const [evidenceInput, setEvidenceInput] = useState(milestone.evidenceHash || '');
  const [isSubmitFormOpen, setIsSubmitFormOpen] = useState(false);
  const [isReviewOpen, setIsReviewOpen] = useState(true);
  const [showFinalWarning, setShowFinalWarning] = useState(false);

  const statusNum = Number(milestone.msStatus ?? 0);
  const isPending = statusNum === 0;
  const isInProgress = statusNum === 1;
  const isSubmitted = statusNum === 2; // msStatus === 2 in contract
  const isApproved = statusNum === 3; // msStatus === 3 in contract

  const hasPreviousEvidence = !!milestone.evidenceHash && milestone.evidenceHash.trim() !== '';
  const isRevision = isInProgress && hasPreviousEvidence;

  const isBuyerRole = role === 'buyer' || role === 'buyer_and_seller';
  const isSellerRole = role === 'seller' || role === 'buyer_and_seller';

  // Human-facing status metadata
  const getStatusBadge = () => {
    if (isApproved) {
      return <Badge variant="success" className="gap-1 text-[11px]"><CheckCircle2 size={11} /> Approved / Paid</Badge>;
    }
    if (isSubmitted) {
      return <Badge variant="warning" className="gap-1 text-[11px]"><AlertCircle size={11} /> Submitted (Awaiting Review)</Badge>;
    }
    if (isRevision) {
      return <Badge className="gap-1 text-[11px] bg-purple-500/20 text-purple-300 border-purple-500/30"><RotateCcw size={11} /> Revision In Progress</Badge>;
    }
    if (isInProgress) {
      return <Badge variant="info" className="gap-1 text-[11px]"><Clock size={11} /> In Progress</Badge>;
    }
    return <Badge variant="secondary" className="gap-1 text-[11px]"><Clock size={11} /> Pending</Badge>;
  };

  // Due date formatting
  const dueDateNum = Number(milestone.dueDate ?? 0);
  const nowSec = Math.floor(Date.now() / 1000);
  const isPastDue = dueDateNum > 0 && nowSec > dueDateNum && !isApproved;
  const dueDateFormatted = dueDateNum > 0
    ? new Date(dueDateNum * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : 'No due date';

  // Evidence URL formatting
  const evidenceStr = String(milestone.evidenceHash || '').trim();
  const isHttpUrl = evidenceStr.startsWith('http://') || evidenceStr.startsWith('https://');
  const evidenceHref = evidenceUrl(evidenceStr);

  return (
    <Card
      id={`milestone-card-${index}`}
      className={cn(
        'relative overflow-hidden transition-all duration-200',
        isCurrentMilestone
          ? 'border-blue-500/50 bg-gradient-to-r from-blue-950/20 via-zinc-900/60 to-zinc-900/40 ring-1 ring-blue-500/20 shadow-md shadow-blue-950/10'
          : isApproved
            ? 'border-green-500/20 bg-green-950/10'
            : isSubmitted
              ? 'border-amber-500/30 bg-amber-950/10'
              : 'border-zinc-800/80 bg-zinc-900/30'
      )}
    >
      <CardContent className="p-4 sm:p-5 space-y-4">
        {/* Header Row */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <span
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-xs font-bold transition-colors',
                isApproved
                  ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                  : isCurrentMilestone
                    ? 'bg-blue-600 text-white font-black shadow-sm'
                    : 'bg-zinc-800 text-zinc-400 border border-zinc-700/50'
              )}
            >
              #{index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-base font-semibold text-white">
                  {milestone.title || `Milestone ${index + 1}`}
                </h3>
                {isCurrentMilestone && (
                  <Badge variant="outline" className="text-[10px] border-blue-500/40 text-blue-300 bg-blue-500/10">
                    Current Focus
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-zinc-400 leading-relaxed">
                {milestone.description || 'No description provided.'}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-white">{formattedAmount}</span>
              {getStatusBadge()}
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
              <span>{dueDateFormatted}</span>
              {isPastDue && (
                <span className="text-amber-400 font-medium">(Past due)</span>
              )}
            </div>
          </div>
        </div>

        {/* Role-Aware Contextual Guidance */}
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-950/40 px-3 py-2 flex items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 text-zinc-300">
            <Info size={13} className="text-zinc-500 shrink-0" />
            <span>
              {isApproved && "Payout released to seller's wallet."}
              {isSubmitted && (isBuyerRole ? "Work submitted. Review evidence below to release payment or request changes." : "Submitted. Waiting for client to review and approve payout.")}
              {isRevision && (isBuyerRole ? "Revision requested. Waiting for seller to upload updated deliverable." : "Client requested changes. Update your work and submit the revision.")}
              {isInProgress && !isRevision && (isBuyerRole ? "Seller is currently working on this milestone." : "Work in progress. Upload your deliverable evidence when ready.")}
              {isPending && (isBuyerRole ? "Waiting for seller to start this milestone." : "Ready to begin. Click Start Work to begin on-chain tracking.")}
            </span>
          </div>
          <span className="text-[10px] text-zinc-400 shrink-0 uppercase tracking-wider font-mono">
            {isApproved ? 'Released' : 'Not released'}
          </span>
        </div>

        {/* Deliverable Evidence Section (If evidence exists) */}
        {hasPreviousEvidence && (
          <div className="rounded-xl border border-zinc-800/80 bg-black/30 p-3.5 space-y-2">
            <div className="flex items-center justify-between text-xs text-zinc-400 font-medium">
              <span className="flex items-center gap-1.5"><FileText size={13} className="text-blue-400" /> Submitted Deliverable Evidence</span>
              <span className="text-[10px] text-zinc-400 font-mono">
                {milestone.completedAt && Number(milestone.completedAt) > 0
                  ? new Date(Number(milestone.completedAt) * 1000).toLocaleDateString()
                  : 'Submitted'}
              </span>
            </div>
            {evidenceHref ? (
              <a
                href={evidenceHref}
                target="_blank"
                rel="noreferrer"
                className="group flex items-center gap-1.5 rounded-lg border border-blue-500/20 bg-blue-950/20 p-2.5 text-xs text-blue-400 hover:border-blue-500/40 transition-colors break-all"
              >
                <ExternalLink size={13} className="shrink-0 text-blue-400 group-hover:scale-110 transition-transform" />
                <span className="truncate underline underline-offset-2">{evidenceStr}</span>
              </a>
            ) : (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5 text-xs text-zinc-300 font-mono break-all">
                {evidenceStr}
              </div>
            )}
          </div>
        )}

        {/* SELLER ACTION AREA */}
        {isSellerRole && isActiveDeal && (
          <div className="pt-1 border-t border-zinc-800/60">
            {/* Seller Pending: Start Work */}
            {isPending && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-500/20 bg-blue-950/20 p-3.5">
                <div>
                  <p className="text-xs font-semibold text-white">Ready to begin Milestone #{index + 1}?</p>
                  <p className="text-[11px] text-zinc-400 mt-0.5">Starting work notifies the client and updates milestone status on-chain.</p>
                </div>
                <Button
                  size="sm"
                  className="gap-1.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold shrink-0"
                  disabled={isPendingTx || autoSubmitPending}
                  onClick={() => onStartWork(index)}
                >
                  {isPendingTx ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                  Start Work
                </Button>
              </div>
            )}

            {/* Seller In Progress or Revision: Submit Work Form */}
            {isInProgress && (
              <div className="space-y-3 rounded-xl border border-blue-500/30 bg-blue-950/25 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                      <Send size={13} className="text-blue-400" />
                      {isRevision ? 'Submit Revised Work' : 'Submit Deliverable Work'}
                    </h4>
                    <p className="text-[11px] text-zinc-400 mt-0.5">
                      {isRevision
                        ? 'The client requested changes. Provide updated deliverable evidence below.'
                        : 'Provide evidence or a link to your completed deliverable for client review.'}
                    </p>
                  </div>
                  <Badge variant="outline" className="text-[10px] text-blue-300 border-blue-500/30">
                    Payout: {formattedAmount}
                  </Badge>
                </div>

                <div className="space-y-2">
                  <Input
                    value={evidenceInput}
                    onChange={(e) => setEvidenceInput(e.target.value)}
                    placeholder="Deliverable URL, GitHub PR, Google Drive link, IPFS CID..."
                    className="bg-zinc-950/80 border-zinc-800 text-xs"
                  />
                  <p className="text-[10px] text-zinc-400">
                    Helper: Add a link to the completed work, file, repository, document, IPFS content, or evidence the client can review.
                  </p>
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    size="sm"
                    className="gap-1.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs"
                    disabled={isPendingTx || !evidenceInput.trim()}
                    onClick={() => onSubmitWork(index, evidenceInput.trim(), isRevision)}
                  >
                    {isPendingTx ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                    {isRevision ? 'Submit Revision' : 'Submit Work for Review'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* BUYER ACTION AREA: CLIENT REVIEW DRAWER / APPROVE & REVISION */}
        {isBuyerRole && isSubmitted && isActiveDeal && (
          <div className="pt-1 border-t border-zinc-800/60 space-y-3">
            <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/20 pb-3">
                <div>
                  <h4 className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
                    <AlertCircle size={14} /> Client Review Needed
                  </h4>
                  <p className="text-[11px] text-zinc-400 mt-0.5">
                    Review submitted evidence. Approving releases <strong>{formattedAmount}</strong> to the freelancer.
                  </p>
                </div>
                <Badge variant="warning" className="text-[10px]">
                  Release: {formattedAmount}
                </Badge>
              </div>

              {/* AI Verification Tool embedded inside Review */}
              <div className="rounded-lg border border-violet-500/20 bg-violet-950/20 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-violet-300">
                    <Sparkles size={13} /> AI Evidence Check
                  </span>
                  {onRunAiVerify && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1 border-violet-500/30 text-violet-300 hover:bg-violet-500/10"
                      disabled={isVerifying}
                      onClick={onRunAiVerify}
                    >
                      {isVerifying ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                      {verification ? 'Verify Again' : 'Verify Evidence'}
                    </Button>
                  )}
                </div>

                {verification ? (
                  <div className="space-y-1.5 text-xs text-zinc-300 pt-1">
                    <div className="flex items-center gap-2">
                      <Badge variant={verification.verified ? 'success' : 'secondary'} className="text-[10px]">
                        {verification.verified ? 'AI Passed' : 'Review Suggested'}
                      </Badge>
                      <span className="text-zinc-400 text-[11px]">{Number(verification.completionPct || 0)}% completed match</span>
                    </div>
                    <p className="text-zinc-400 text-xs">{String(verification.summary || '')}</p>
                    {verification.recommendation && (
                      <p className="text-zinc-300 text-[11px] italic">Recommendation: {String(verification.recommendation)}</p>
                    )}
                  </div>
                ) : (
                  <p className="text-[11px] text-zinc-400">Optional AI analysis of submitted evidence before approving payout.</p>
                )}
              </div>

              {/* Approval & Revision CTAs */}
              <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs border-zinc-700 hover:bg-zinc-800 text-zinc-300"
                  disabled={isPendingTx}
                  onClick={() => onRequestRevision(index)}
                >
                  <RotateCcw size={13} /> Request Revision
                </Button>
                <Button
                  size="sm"
                  className="gap-1.5 text-xs bg-green-600 hover:bg-green-500 text-white font-semibold shadow-md shadow-green-950/40"
                  disabled={isPendingTx}
                  onClick={() => {
                    const isLastMilestone = typeof totalMilestones === 'number' && index === totalMilestones - 1;
                    const needsWarning = isLastMilestone && (hasUnapprovedEarlierMilestones || isUnderAllocated);
                    if (needsWarning) {
                      setShowFinalWarning(true);
                    } else {
                      onApproveRelease(index, milestone.amount);
                    }
                  }}
                >
                  {isPendingTx ? <Loader2 size={13} className="animate-spin" /> : <ThumbsUp size={13} />}
                  Approve & Release {formattedAmount}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Final Milestone Warning Confirmation Modal */}
        {showFinalWarning && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
            onClick={() => setShowFinalWarning(false)}
          >
            <div
              className="w-full max-w-md rounded-2xl border border-amber-500/40 bg-zinc-900 p-5 shadow-2xl space-y-4 text-white"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 text-amber-300 font-bold text-sm">
                <AlertCircle size={18} className="text-amber-400" />
                <span>Final Milestone Approval Warning</span>
              </div>

              {isUnderAllocated && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-3.5 space-y-1 text-xs text-zinc-300">
                  <p className="font-semibold text-amber-300">Under-Allocated Deal Warning</p>
                  <p className="leading-relaxed">
                    Approving this final milestone will complete the deal, but the milestone allocation does not cover the full deal value. Remaining escrow may become inaccessible after completion.
                  </p>
                  <div className="pt-1 text-[11px] text-zinc-400 font-mono">
                    Total Value: {totalValueText} | Allocated: {totalAllocatedText}
                  </div>
                </div>
              )}

              {hasUnapprovedEarlierMilestones && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-3.5 space-y-1 text-xs text-zinc-300">
                  <p className="font-semibold text-amber-300">Unapproved Earlier Milestones Warning</p>
                  <p className="leading-relaxed">
                    Approving this final milestone will mark the entire deal Completed on-chain even though earlier milestones are not all Approved.
                  </p>
                </div>
              )}

              <p className="text-xs text-zinc-400">
                Are you sure you want to approve milestone #{index + 1} and finalize this deal on-chain?
              </p>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                  onClick={() => setShowFinalWarning(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="gap-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white font-semibold shadow-md"
                  onClick={() => {
                    setShowFinalWarning(false);
                    onApproveRelease(index, milestone.amount);
                  }}
                >
                  <ThumbsUp size={13} /> Confirm & Approve Release
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
