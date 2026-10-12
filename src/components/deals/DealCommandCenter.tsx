'use client';

import React, { useState } from 'react';
import { Copy, Check, Calendar, DollarSign, User, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { shortenAddress, cn } from '@/lib/utils';
import { DealUXState, MilestoneStructInput } from '@/lib/deals/deriveDealUX';
import { DealLifecycleVisualizer } from '@/components/deals/DealLifecycleVisualizer';
import { DealNextAction } from '@/components/deals/DealNextAction';

interface DealCommandCenterProps {
  dealAddress: `0x${string}`;
  title: string;
  description: string;
  statusNum: number;
  statusLabel: string;
  uxState: DealUXState;
  msList: MilestoneStructInput[];
  formattedTotalValue: string;
  deadlineTimestamp: number;
  buyerAddress: string;
  sellerAddress: string;
  isPendingTx: boolean;
  onTriggerPrimaryAction: (action: string, milestoneIndex: number | null) => void;
}

export function DealCommandCenter({
  dealAddress,
  title,
  description,
  statusNum,
  statusLabel,
  uxState,
  msList,
  formattedTotalValue,
  deadlineTimestamp,
  buyerAddress,
  sellerAddress,
  isPendingTx,
  onTriggerPrimaryAction,
}: DealCommandCenterProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(dealAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // User-facing role label
  const getUiRoleLabel = () => {
    switch (uxState.role) {
      case 'buyer':
        return 'Client View';
      case 'seller':
        return 'Freelancer View';
      case 'buyer_and_seller':
        return 'Client & Freelancer (Test Mode)';
      case 'third_party':
        return 'Spectator View';
      case 'disconnected':
        return 'Disconnected';
      default:
        return 'Viewer';
    }
  };

  // Deadline calculation
  const getDeadlineText = () => {
    if (!deadlineTimestamp || deadlineTimestamp <= 0) return 'No deadline';
    const dateStr = new Date(deadlineTimestamp * 1000).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const nowSec = Math.floor(Date.now() / 1000);
    const diffSec = deadlineTimestamp - nowSec;
    if (diffSec < 0 && statusNum === 1) {
      return `${dateStr} (Past due)`;
    } else if (diffSec > 0 && diffSec < 86400) {
      return `${dateStr} (Due today)`;
    } else if (diffSec >= 86400 && statusNum === 1) {
      const days = Math.ceil(diffSec / 86400);
      return `${dateStr} (${days}d left)`;
    }
    return dateStr;
  };

  // Suppress duplicate anomalies that repeat Next Action headline/description
  const filteredAnomalies = (uxState.anomalies || []).filter((a) => {
    if (a.code === 'ACTIVE_FUNDED_NO_MILESTONES' && uxState.phase === 'NEEDS_MILESTONES') {
      return false; // Already explained by Next Action banner!
    }
    return true;
  });

  return (
    <div className="rounded-2xl border border-zinc-800/80 bg-gradient-to-b from-zinc-900/60 via-zinc-900/40 to-zinc-950/80 p-5 space-y-5 shadow-xl">
      {/* Top Header Row: Identity & Status */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-400">
              Deal Workspace
            </span>
            <span className="text-zinc-600">·</span>
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1 text-xs font-mono text-zinc-400 hover:text-white transition-colors group"
              title="Copy deal contract address"
            >
              <span>{shortenAddress(dealAddress)}</span>
              {copied ? (
                <Check size={12} className="text-green-400" />
              ) : (
                <Copy size={12} className="text-zinc-500 group-hover:text-zinc-300" />
              )}
            </button>
          </div>
          <h1 className="text-2xl font-black text-white tracking-tight">{title || 'Untitled Deal'}</h1>
          {description && (
            <p className="text-zinc-400 text-xs leading-relaxed max-w-3xl line-clamp-2">{description}</p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          <Badge
            variant={
              statusNum === 2
                ? 'success'
                : statusNum === 1
                  ? 'info'
                  : statusNum === 3
                    ? 'destructive'
                    : 'secondary'
            }
            className="text-xs font-semibold"
          >
            {statusLabel}
          </Badge>
          <Badge variant="outline" className="text-xs border-zinc-700 text-zinc-300 bg-zinc-800/40">
            {getUiRoleLabel()}
          </Badge>
        </div>
      </div>

      {/* Integrated Lifecycle Stepper */}
      <DealLifecycleVisualizer
        stages={uxState.lifecycleStages}
        phase={uxState.phase}
        statusNum={statusNum}
      />

      {/* Integrated Next Action Area */}
      <DealNextAction
        nextAction={uxState.nextAction}
        attention={uxState.attention}
        role={uxState.role}
        milestones={msList}
        anomalies={filteredAnomalies}
        onTriggerPrimaryAction={onTriggerPrimaryAction}
        isPending={isPendingTx}
      />

      {/* Compact Key Facts Grid */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 pt-1 border-t border-zinc-800/60">
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-2.5 space-y-0.5">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
            <DollarSign size={12} className="text-emerald-400" /> Value
          </div>
          <p className="text-sm font-bold text-white truncate">{formattedTotalValue}</p>
        </div>

        <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-2.5 space-y-0.5">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
            <Calendar size={12} className="text-blue-400" /> Deadline
          </div>
          <p className="text-xs font-semibold text-zinc-200 truncate">{getDeadlineText()}</p>
        </div>

        <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-2.5 space-y-0.5">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
            <User size={12} className="text-violet-400" /> Client
          </div>
          <p className="text-xs font-mono font-medium text-zinc-200 truncate">
            {uxState.role === 'buyer' || uxState.role === 'buyer_and_seller' ? 'You · ' : ''}
            {shortenAddress(buyerAddress)}
          </p>
        </div>

        <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-2.5 space-y-0.5">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
            <User size={12} className="text-amber-400" /> Freelancer
          </div>
          <p className="text-xs font-mono font-medium text-zinc-200 truncate">
            {uxState.role === 'seller' || uxState.role === 'buyer_and_seller' ? 'You · ' : ''}
            {shortenAddress(sellerAddress)}
          </p>
        </div>
      </div>
    </div>
  );
}
