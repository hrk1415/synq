'use client';

import React from 'react';
import { CheckCircle2, Clock, AlertCircle, PlayCircle, DollarSign } from 'lucide-react';

interface MilestoneHeaderSummaryProps {
  totalCount: number;
  approvedCount: number;
  submittedCount: number;
  inProgressCount: number;
  pendingCount: number;
  totalAllocatedText: string;
  totalReleasedText: string;
  totalValueText: string;
}

export function MilestoneHeaderSummary({
  totalCount,
  approvedCount,
  submittedCount,
  inProgressCount,
  totalAllocatedText,
  totalReleasedText,
  totalValueText,
}: MilestoneHeaderSummaryProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3.5">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
          <CheckCircle2 size={14} className="text-green-400" />
          <span>Milestones Approved</span>
        </div>
        <p className="mt-1.5 text-lg font-bold text-white">
          {approvedCount} <span className="text-xs font-normal text-zinc-500">/ {totalCount}</span>
        </p>
      </div>

      <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3.5">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
          <AlertCircle size={14} className="text-amber-400" />
          <span>Awaiting Review</span>
        </div>
        <p className="mt-1.5 text-lg font-bold text-white">{submittedCount}</p>
      </div>

      <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3.5">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
          <PlayCircle size={14} className="text-blue-400" />
          <span>In Progress</span>
        </div>
        <p className="mt-1.5 text-lg font-bold text-white">{inProgressCount}</p>
      </div>

      <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3.5">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
          <DollarSign size={14} className="text-emerald-400" />
          <span>Payout Released</span>
        </div>
        <p className="mt-1.5 text-base font-bold text-white truncate">
          {totalReleasedText} <span className="text-xs font-normal text-zinc-500">of {totalValueText}</span>
        </p>
      </div>
    </div>
  );
}
