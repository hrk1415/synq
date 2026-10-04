'use client';

import React from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  Scale,
  Shield,
  FileText,
  User,
  Briefcase,
  ArrowRight,
  Info,
  DollarSign,
  Wallet,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { shortenAddress, cn } from '@/lib/utils';
import { DealReviewForm } from './DealReviewForm';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface DealCompletionSummaryProps {
  dealAddress: string;
  title: string;
  buyerAddress: string;
  sellerAddress: string;
  buyerHandle?: string | null;
  sellerHandle?: string | null;
  formattedTotalValue: string;
  formattedEscrowBalance: string;
  formattedReleasedAmount: string;
  rawEscrowBalanceWei: bigint;
  tokenSymbol: string;
  msList: any[];
  disputeData?: any;
  isBuyer: boolean;
  isSeller: boolean;
  onNavigateSection?: (section: 'overview' | 'escrow' | 'milestones' | 'dispute') => void;
}

export function DealCompletionSummary({
  dealAddress,
  title,
  buyerAddress,
  sellerAddress,
  buyerHandle,
  sellerHandle,
  formattedTotalValue,
  formattedEscrowBalance,
  formattedReleasedAmount,
  rawEscrowBalanceWei,
  tokenSymbol,
  msList = [],
  disputeData,
  isBuyer,
  isSeller,
  onNavigateSection,
}: DealCompletionSummaryProps) {
  const isSelf = buyerAddress.toLowerCase() === sellerAddress.toLowerCase();

  // Dispute check: openedBy !== zeroAddress
  const disputeOpener = String(disputeData?.openedBy || disputeData?.[0] || ZERO_ADDRESS);
  const wasDisputed = disputeOpener !== ZERO_ADDRESS;

  // Stranded escrow check
  const hasStrandedEscrow = rawEscrowBalanceWei > 0n;

  // Milestone breakdown
  const totalMilestones = msList.length;
  const approvedCount = msList.filter((m: any) => Number(m.msStatus) === 3).length;
  const submittedCount = msList.filter((m: any) => Number(m.msStatus) === 2).length;
  const inProgressCount = msList.filter((m: any) => Number(m.msStatus) === 1).length;
  const pendingCount = msList.filter((m: any) => Number(m.msStatus) === 0).length;

  const hasUnapprovedMilestones = approvedCount < totalMilestones;

  return (
    <div className="space-y-6">
      {/* TERMINAL COMPLETION HERO */}
      <div
        className={cn(
          'relative overflow-hidden rounded-2xl border p-6 shadow-xl transition-all',
          wasDisputed
            ? 'border-purple-500/30 bg-gradient-to-br from-purple-950/20 via-zinc-900/90 to-zinc-950'
            : 'border-emerald-500/30 bg-gradient-to-br from-emerald-950/20 via-zinc-900/90 to-zinc-950'
        )}
      >
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2.5">
              {wasDisputed ? (
                <Badge className="bg-purple-500/20 text-purple-300 border-purple-500/30 text-xs px-3 py-1 font-bold tracking-wide flex items-center gap-1.5">
                  <Scale size={13} /> DISPUTE RESOLVED
                </Badge>
              ) : (
                <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30 text-xs px-3 py-1 font-bold tracking-wide flex items-center gap-1.5">
                  <CheckCircle2 size={13} /> DEAL COMPLETED
                </Badge>
              )}
              <span className="text-xs text-zinc-400 font-mono">Final Settlement Record</span>
            </div>
            <h2 className="text-2xl font-extrabold text-white tracking-tight">
              {wasDisputed ? 'Dispute Resolution Completed On-Chain' : 'Agreement Completed On-Chain'}
            </h2>
            <p className="text-sm text-zinc-300 leading-relaxed max-w-2xl">
              {wasDisputed
                ? 'This deal agreement was finalized through on-chain dispute resolution.'
                : 'The agreement reached Completed status on-chain.'}
            </p>
          </div>

          {/* Quick Terminal Navigation Buttons */}
          {onNavigateSection && (
            <div className="flex flex-wrap gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="text-xs border-zinc-700 hover:bg-zinc-800 text-zinc-300 gap-1.5"
                onClick={() => onNavigateSection('milestones')}
              >
                <FileText size={13} /> View Milestones
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs border-zinc-700 hover:bg-zinc-800 text-zinc-300 gap-1.5"
                onClick={() => onNavigateSection('escrow')}
              >
                <Wallet size={13} /> Escrow Record
              </Button>
              {wasDisputed && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs border-purple-500/30 hover:bg-purple-950/30 text-purple-300 gap-1.5"
                  onClick={() => onNavigateSection('dispute')}
                >
                  <Scale size={13} /> Dispute Details
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* FINAL FINANCIAL SUMMARY RECORD */}
      <Card className="border-zinc-800 bg-zinc-900/60 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-bold text-white flex items-center gap-2">
            <DollarSign size={18} className="text-emerald-400" /> Final Financial Allocation
          </CardTitle>
          <CardDescription className="text-xs text-zinc-400">
            Authoritative breakdown of agreed deal funds, released milestone payouts, and contract escrow balance.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Total Value */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
              <span className="text-[11px] text-zinc-400 uppercase tracking-wider block mb-1">Total Agreed Value</span>
              <div className="flex items-baseline gap-1">
                <span className="text-xl font-bold text-white">{formattedTotalValue}</span>
                <span className="text-xs font-semibold text-zinc-400">{tokenSymbol}</span>
              </div>
            </div>

            {/* Approved Payouts */}
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-950/10 p-4">
              <span className="text-[11px] text-emerald-400 uppercase tracking-wider block mb-1">Approved Milestone Payouts</span>
              <div className="flex items-baseline gap-1">
                <span className="text-xl font-bold text-emerald-300">{formattedReleasedAmount}</span>
                <span className="text-xs font-semibold text-emerald-400">{tokenSymbol}</span>
              </div>
            </div>

            {/* Remaining Escrow */}
            <div
              className={cn(
                'rounded-xl border p-4',
                hasStrandedEscrow
                  ? 'border-amber-500/30 bg-amber-950/15'
                  : 'border-zinc-800 bg-zinc-950/60'
              )}
            >
              <span
                className={cn(
                  'text-[11px] uppercase tracking-wider block mb-1',
                  hasStrandedEscrow ? 'text-amber-400 font-bold' : 'text-zinc-400'
                )}
              >
                Remaining Contract Escrow
              </span>
              <div className="flex items-baseline gap-1">
                <span className={cn('text-xl font-bold', hasStrandedEscrow ? 'text-amber-300' : 'text-white')}>
                  {formattedEscrowBalance}
                </span>
                <span className="text-xs font-semibold text-zinc-400">{tokenSymbol}</span>
              </div>
            </div>
          </div>

          {/* Normal Zero Escrow Settled note */}
          {!wasDisputed && !hasStrandedEscrow && (
            <p className="text-xs text-emerald-400/90 font-medium flex items-center gap-1.5 pt-1">
              <CheckCircle2 size={13} /> All contract escrow has been settled cleanly.
            </p>
          )}

          {/* Stranded Escrow Warning */}
          {hasStrandedEscrow && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 space-y-2">
              <div className="flex items-center gap-2 text-amber-300 font-bold text-xs">
                <AlertTriangle size={15} /> REMAINING ESCROW DETECTED
              </div>
              <p className="text-xs text-zinc-300 leading-relaxed">
                This deal is already <strong>Completed</strong> on-chain, but <strong>{formattedEscrowBalance} {tokenSymbol}</strong> remains inside the deal contract.
              </p>
              <p className="text-[11px] text-zinc-400 italic">
                The current deal contract does not expose a post-completion withdrawal action for this remaining balance.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* MILESTONE WORK INTEGRITY RECAP */}
      <Card className="border-zinc-800 bg-zinc-900/60 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-bold text-white flex items-center gap-2">
            <FileText size={18} className="text-blue-400" /> Milestone Completion Record
          </CardTitle>
          <CardDescription className="text-xs text-zinc-400">
            Summary of milestone states at the moment of deal completion.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-xs bg-zinc-950/60 p-3 rounded-xl border border-zinc-800">
            <div className="flex items-center gap-1.5">
              <span className="text-zinc-400">Total Milestones:</span>
              <span className="font-bold text-white">{totalMilestones}</span>
            </div>
            <span className="text-zinc-700">|</span>
            <div className="flex items-center gap-1.5">
              <span className="text-emerald-400 font-medium">Approved:</span>
              <span className="font-bold text-emerald-300">{approvedCount}</span>
            </div>
            {submittedCount > 0 && (
              <>
                <span className="text-zinc-700">|</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-amber-400 font-medium">Submitted:</span>
                  <span className="font-bold text-amber-300">{submittedCount}</span>
                </div>
              </>
            )}
            {inProgressCount > 0 && (
              <>
                <span className="text-zinc-700">|</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-blue-400 font-medium">In Progress:</span>
                  <span className="font-bold text-blue-300">{inProgressCount}</span>
                </div>
              </>
            )}
            {pendingCount > 0 && (
              <>
                <span className="text-zinc-700">|</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-400">Pending:</span>
                  <span className="font-bold text-zinc-300">{pendingCount}</span>
                </div>
              </>
            )}
          </div>

          {/* Normal Completion with Unapproved Milestones Warning */}
          {!wasDisputed && hasUnapprovedMilestones && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-950/15 p-3.5 flex items-start gap-2.5 text-xs text-amber-300">
              <Info size={15} className="shrink-0 text-amber-400 mt-0.5" />
              <div>
                <span className="font-bold block mb-0.5">MILESTONE STATE WARNING</span>
                <p className="text-zinc-300 leading-relaxed text-[11px]">
                  The deal reached Completed status on-chain while {totalMilestones - approvedCount} milestone(s) are not recorded as Approved. Approving the final milestone index completed the agreement.
                </p>
              </div>
            </div>
          )}

          {/* Disputed Completion Milestone Explanation */}
          {wasDisputed && (
            <div className="rounded-xl border border-purple-500/20 bg-purple-950/15 p-3.5 flex items-start gap-2.5 text-xs text-purple-300">
              <Info size={15} className="shrink-0 text-purple-400 mt-0.5" />
              <div>
                <span className="font-bold block mb-0.5">DISPUTE RESOLUTION RECORD</span>
                <p className="text-zinc-300 leading-relaxed text-[11px]">
                  Milestone states are preserved from the point when the dispute was opened. Deal-level dispute resolution completed the agreement separately.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* PARTICIPANTS RECAP */}
      <Card className="border-zinc-800 bg-zinc-900/60 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-bold text-white flex items-center gap-2">
            <User size={18} className="text-blue-400" /> Agreement Parties
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-950/60 border border-zinc-800">
              <div className="flex items-center gap-2">
                <User size={14} className="text-zinc-400" />
                <span className="text-zinc-400">Client / Buyer:</span>
              </div>
              <div className="flex flex-col items-end text-xs">
                {buyerHandle ? (
                  <>
                    <span className="font-bold text-white">{buyerHandle}</span>
                    <span className="font-mono text-[11px] text-zinc-400">{shortenAddress(buyerAddress)}</span>
                  </>
                ) : (
                  <span className="font-mono text-zinc-200">{shortenAddress(buyerAddress)}</span>
                )}
                {isBuyer && <Badge variant="info" className="text-[10px] py-0 mt-0.5">You</Badge>}
              </div>
            </div>

            <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-950/60 border border-zinc-800">
              <div className="flex items-center gap-2">
                <Briefcase size={14} className="text-zinc-400" />
                <span className="text-zinc-400">Freelancer / Seller:</span>
              </div>
              <div className="flex flex-col items-end text-xs">
                {sellerHandle ? (
                  <>
                    <span className="font-bold text-blue-400">{sellerHandle}</span>
                    <span className="font-mono text-[11px] text-zinc-400">{shortenAddress(sellerAddress)}</span>
                  </>
                ) : (
                  <span className="font-mono text-zinc-200">{shortenAddress(sellerAddress)}</span>
                )}
                {isSeller && <Badge variant="info" className="text-[10px] py-0 mt-0.5">You</Badge>}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* VERIFIED PROVIDER REVIEW SECTION (Eligible Client Only) */}
      {isBuyer && !isSelf && (
        <DealReviewForm
          dealAddress={dealAddress}
          sellerAddress={sellerAddress}
          buyerAddress={buyerAddress}
          isBuyer={isBuyer}
          isSelf={isSelf}
        />
      )}
    </div>
  );
}
