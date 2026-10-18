'use client';

import React from 'react';
import {
  Scale,
  Handshake,
  Info,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatUsdcAmount } from '@/lib/deals/v2';
import { cn } from '@/lib/utils';

export interface PaymentDisputeResolutionSectionProps {
  milestoneAmount: bigint;
  canOpenSeriousDispute: boolean;
  canUseMutualSettlement: boolean;
  onOpenDispute: () => void;
  onProposeSettlement: () => void;
  children?: React.ReactNode;
  className?: string;
}

export function PaymentDisputeResolutionSection({
  milestoneAmount,
  canOpenSeriousDispute,
  canUseMutualSettlement,
  onOpenDispute,
  onProposeSettlement,
  children,
  className,
}: PaymentDisputeResolutionSectionProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-white/10 bg-[#1B1B1B] p-4 space-y-4 text-white',
        className
      )}
    >
      {/* Section Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-purple-400" />
          <h3 className="text-sm font-bold tracking-tight text-white">
            Payment & Dispute Resolution
          </h3>
        </div>
        <p className="text-xs text-zinc-400">
          Resolve milestone terms collaboratively through a direct payout split, or escalate serious issues to the Resolution Committee for formal adjudication.
        </p>
      </div>

      {/* Two Responsive Action Panels */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Panel 1: Settle Together */}
        <div className="rounded-lg border border-purple-500/20 bg-zinc-950/60 p-3.5 flex flex-col justify-between space-y-3">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                <Handshake className="h-4 w-4 text-purple-400" /> Settle Together
              </span>
              <Badge
                variant="outline"
                className="border-purple-500/30 bg-purple-500/10 text-[10px] text-purple-300"
              >
                Direct Agreement
              </Badge>
            </div>
            <p className="text-xs text-zinc-300 leading-relaxed">
              Both participants can agree on a custom payout split. Settling directly avoids third-party committee delays and immediately disburses agreed funds on-chain.
            </p>
          </div>

          <div className="pt-1">
            {canUseMutualSettlement ? (
              <Button
                type="button"
                size="sm"
                onClick={onProposeSettlement}
                className="w-full sm:w-auto h-8 text-xs bg-purple-600 hover:bg-purple-500 text-white font-medium flex items-center justify-center gap-1.5"
              >
                <Handshake className="h-3.5 w-3.5" /> Propose Settlement
              </Button>
            ) : (
              <div className="text-[11px] text-zinc-500 flex items-center gap-1.5">
                <Info className="h-3 w-3 shrink-0" />
                <span>Available after deliverables are submitted or in revision.</span>
              </div>
            )}
          </div>
        </div>

        {/* Panel 2: Open a Dispute */}
        <div className="rounded-lg border border-rose-500/20 bg-zinc-950/60 p-3.5 flex flex-col justify-between space-y-3">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                <Scale className="h-4 w-4 text-rose-400" /> Open a Dispute
              </span>
              <Badge
                variant="outline"
                className="border-rose-500/30 bg-rose-500/10 text-[10px] text-rose-300"
              >
                Formal Review
              </Badge>
            </div>
            <p className="text-xs text-zinc-300 leading-relaxed">
              If there is an unresolved specification breach or unresponsive party, escalate to the Resolution Committee. The affected milestone escrow of{' '}
              <span className="font-semibold text-white font-mono">
                {formatUsdcAmount(milestoneAmount)} USDC
              </span>{' '}
              remains securely locked during review.
            </p>
          </div>

          <div className="pt-1">
            {canOpenSeriousDispute ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onOpenDispute}
                className="w-full sm:w-auto h-8 text-xs border-rose-500/40 text-rose-300 hover:bg-rose-950/40 hover:border-rose-500/70 font-medium flex items-center justify-center gap-1.5"
              >
                <Scale className="h-3.5 w-3.5 text-rose-400" /> Open Serious Dispute
              </Button>
            ) : (
              <div className="text-[11px] text-zinc-500 flex items-center gap-1.5">
                <Info className="h-3 w-3 shrink-0" />
                <span>Not eligible for new dispute in current milestone state.</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Render active proposals or children if provided */}
      {children && (
        <div className="pt-2 border-t border-white/10 space-y-2">
          {children}
        </div>
      )}
    </div>
  );
}
