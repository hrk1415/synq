'use client';

import React from 'react';
import { Check, AlertTriangle, XCircle, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DealLifecycleStage, DerivedDealPhase } from '@/lib/deals/deriveDealUX';
import { Badge } from '@/components/ui/badge';

interface DealLifecycleVisualizerProps {
  stages: DealLifecycleStage[];
  phase: DerivedDealPhase;
  statusNum: number;
}

export function DealLifecycleVisualizer({
  stages,
  phase,
  statusNum,
}: DealLifecycleVisualizerProps) {
  const isCancelled = statusNum === 4 || phase === 'CANCELLED';
  const isDisputed = statusNum === 3 || phase === 'DISPUTED';

  return (
    <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400">
          Deal Lifecycle
        </span>
        {isDisputed && (
          <Badge variant="destructive" className="text-[10px] gap-1">
            <AlertTriangle size={11} /> Dispute Active
          </Badge>
        )}
        {isCancelled && (
          <Badge variant="secondary" className="text-[10px] gap-1 text-red-400 border-red-500/20 bg-red-500/10">
            <XCircle size={11} /> Cancelled
          </Badge>
        )}
      </div>

      <div className="relative flex items-center justify-between">
        {/* Connector line background */}
        <div className="absolute left-4 right-4 top-1/2 -z-0 h-0.5 -translate-y-1/2 bg-zinc-800" />

        {stages.map((stage, idx) => {
          const isComplete = stage.status === 'complete';
          const isActive = stage.status === 'active';
          const isError = stage.status === 'error';

          return (
            <div
              key={stage.id}
              className="relative z-10 flex flex-col items-center gap-1.5 bg-zinc-950/80 px-2 py-0.5 rounded-lg"
            >
              <div
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-all duration-200',
                  isComplete
                    ? 'bg-green-500/15 text-green-400 border border-green-500/30'
                    : isActive
                      ? 'bg-blue-600/20 text-blue-400 border border-blue-500/50 ring-2 ring-blue-500/20 animate-pulse'
                      : isError
                        ? 'bg-red-500/20 text-red-400 border border-red-500/40'
                        : 'bg-zinc-800/80 text-zinc-500 border border-zinc-700/50'
                )}
              >
                {isComplete ? (
                  <Check size={13} className="stroke-[2.5]" />
                ) : isError ? (
                  <AlertTriangle size={12} />
                ) : isActive ? (
                  <Clock size={12} />
                ) : (
                  <span>{idx + 1}</span>
                )}
              </div>
              <span
                className={cn(
                  'text-[11px] font-medium tracking-tight',
                  isComplete
                    ? 'text-zinc-300'
                    : isActive
                      ? 'text-blue-300 font-semibold'
                      : isError
                        ? 'text-red-400'
                        : 'text-zinc-500'
                )}
              >
                {stage.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
