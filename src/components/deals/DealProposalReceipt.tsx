'use client';

import React from 'react';
import Link from 'next/link';
import { FileSignature, Clock, Coins, Layers, ArrowRight } from 'lucide-react';
import { cn, shortenAddress } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatUnits } from 'viem';
import type { SynqDealProposalPayload } from '@/lib/synq-message';

export interface DealProposalReceiptProps {
  payload: SynqDealProposalPayload;
  isSender?: boolean;
  client?: {
    wallet?: string | null;
    name?: string | null;
    handle?: string | null;
    avatar?: string | null;
  };
  freelancer?: {
    wallet?: string | null;
    name?: string | null;
    handle?: string | null;
    avatar?: string | null;
  };
  onView?: () => void;
  className?: string;
}

export function DealProposalReceipt({
  payload,
  isSender = false,
  client,
  freelancer,
  onView,
  className,
}: DealProposalReceiptProps) {
  // Format 6-decimal USDC base units safely
  let formattedAmount = '0';
  try {
    formattedAmount = formatUnits(BigInt(payload.totalAmount), 6);
  } catch {
    formattedAmount = payload.totalAmount;
  }

  // Format exact expiry timestamp into readable date
  let formattedExpiry = 'Pending';
  try {
    const expirySec = Number(payload.expiry);
    if (!Number.isNaN(expirySec) && expirySec > 0) {
      formattedExpiry = new Date(expirySec * 1000).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
  } catch {
    formattedExpiry = payload.expiry;
  }

  const clientDisplay = client?.name || (client?.wallet ? shortenAddress(client.wallet) : shortenAddress(payload.clientWallet));
  const freelancerDisplay = freelancer?.name || (freelancer?.wallet ? shortenAddress(freelancer.wallet) : shortenAddress(payload.freelancerWallet));
  const statusLabel = payload.cachedStatus || 'Pending';

  return (
    <div
      className={cn(
        'w-full max-w-[440px] rounded-xl border border-zinc-700/70 bg-gradient-to-b from-zinc-900/95 to-zinc-950/95 p-4 text-zinc-100 shadow-2xl backdrop-blur-md',
        className,
      )}
    >
      {/* Header Badge & Title */}
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800/80 pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">
            <FileSignature className="h-4 w-4" />
          </div>
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
            Deal Proposal
          </span>
        </div>
        <Badge
          variant="outline"
          className={cn(
            'text-[11px] font-medium',
            statusLabel.toUpperCase() === 'ACCEPTED'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
              : statusLabel.toUpperCase() === 'DECLINED'
              ? 'border-rose-500/30 bg-rose-500/10 text-rose-400'
              : statusLabel.toUpperCase() === 'CANCELLED' || statusLabel.toUpperCase() === 'EXPIRED'
              ? 'border-zinc-500/30 bg-zinc-500/10 text-zinc-400'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-400',
          )}
        >
          {statusLabel}
        </Badge>
      </div>

      {/* Proposal Title */}
      <div className="mt-3">
        <h4 className="text-sm font-semibold text-white line-clamp-2">
          {payload.title}
        </h4>
        <p className="mt-1 text-[11px] text-zinc-400">
          Proposed by <span className="font-medium text-zinc-300">{clientDisplay}</span> to{' '}
          <span className="font-medium text-zinc-300">{freelancerDisplay}</span>
        </p>
      </div>

      {/* Proposal Key Terms Grid */}
      <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-zinc-900/60 p-2.5 border border-zinc-800/60 text-xs">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-400">
            <Coins className="h-3 w-3 text-blue-400" /> Proposed Escrow
          </div>
          <div className="text-sm font-bold text-white">
            {formattedAmount} <span className="text-xs font-medium text-blue-400">USDC</span>
          </div>
        </div>

        <div className="space-y-0.5">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-400">
            <Layers className="h-3 w-3 text-purple-400" /> Milestones
          </div>
          <div className="text-sm font-semibold text-zinc-200">
            {payload.milestoneCount} {payload.milestoneCount === 1 ? 'milestone' : 'milestones'}
          </div>
        </div>

        <div className="col-span-2 pt-1 border-t border-zinc-800/50 flex items-center justify-between text-[11px] text-zinc-400">
          <span className="flex items-center gap-1 text-[10px]">
            <Clock className="h-3 w-3 text-amber-400/80" /> Valid Until
          </span>
          <span className="font-mono text-zinc-300">{formattedExpiry}</span>
        </div>
      </div>

      {/* Educational Notice */}
      <div className="mt-2 text-[10px] leading-tight text-zinc-500">
        Proposed terms. No funds move until the freelancer accepts and deploys on-chain.
      </div>

      {/* Action Button */}
      <div className="mt-3 pt-2 border-t border-zinc-800/60">
        {onView ? (
          <Button
            type="button"
            size="sm"
            onClick={onView}
            className="w-full h-8 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white gap-1.5 shadow-sm"
          >
            View Proposal <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Link
            href={`/deals/proposals/${payload.proposalId}`}
            className="flex items-center justify-center w-full h-8 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md gap-1.5 transition-colors shadow-sm"
          >
            View Proposal <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
    </div>
  );
}
