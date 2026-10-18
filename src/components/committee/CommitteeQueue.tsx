'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { shortenAddress } from '@/lib/utils';
import { formatUsdcAmount } from '@/lib/deals/v2';
import type { CommitteeQueueItem } from '@/lib/deals/committee-queue';
import {
  Scale,
  ArrowRight,
  Clock,
  ShieldAlert,
  CheckCircle2,
  Check,
  Search,
  X,
  Filter,
  AlertTriangle,
  History,
} from 'lucide-react';

export const PRIMARY_RESOLVER_SLA_SECONDS = 14 * 86400; // 1,209,600 seconds (14 days)

export type CommitteeDeadlineState =
  | 'normal'
  | 'approaching_handoff'
  | 'emergency_handoff'
  | 'final_review'
  | 'unknown';

export interface CommitteeTimingInfo {
  deadlineState: CommitteeDeadlineState;
  disputeAgeText: string;
  deadlineText: string;
  responsibleCommitteeLabel: string;
  isEmergencyEligible: boolean;
  handoffAt?: number;
  openedAt?: number;
  remainingSeconds?: number;
}

export function formatDisputeAge(elapsedSec: number): string {
  if (elapsedSec < 60) return 'Dispute opened just now';
  const mins = Math.floor(elapsedSec / 60);
  if (mins < 60) return `Dispute opened ${mins}m ago`;
  const hours = Math.floor(elapsedSec / 3600);
  if (hours < 24) return `Dispute opened ${hours}h ago`;
  const days = Math.floor(elapsedSec / 86400);
  if (days === 1) return 'Dispute opened 1 day ago';
  return `Dispute opened ${days} days ago`;
}

export function formatRemainingHandoff(remainingSec: number): string {
  if (remainingSec <= 0) return 'Primary review window ended';
  const days = Math.floor(remainingSec / 86400);
  const hours = Math.floor((remainingSec % 86400) / 3600);
  const mins = Math.floor((remainingSec % 3600) / 60);

  if (days > 1) {
    return `Primary review: ${days} days remaining`;
  }
  if (days === 1) {
    return `Primary review: 1 day ${hours}h remaining`;
  }
  if (hours > 0) {
    return `Primary review ends in ${hours}h ${mins}m`;
  }
  return `Primary review ends in ${Math.max(1, mins)}m`;
}

export function getCommitteeTimingInfo(
  item: CommitteeQueueItem,
  nowSec: number
): CommitteeTimingInfo {
  if (item.phase === 'FINAL_RESOLUTION') {
    return {
      deadlineState: 'final_review',
      disputeAgeText: 'Final Reconsideration',
      deadlineText: 'No on-chain review deadline',
      responsibleCommitteeLabel: 'Proposing Committee',
      isEmergencyEligible: false,
    };
  }

  const openedAtSec = Number(item.disputeOpenedAt || '0');
  if (!openedAtSec || isNaN(openedAtSec) || openedAtSec <= 0) {
    return {
      deadlineState: 'unknown',
      disputeAgeText: 'Dispute opened date unrecorded',
      deadlineText: 'SLA deadline unavailable',
      responsibleCommitteeLabel: 'Authorized Committee',
      isEmergencyEligible: false,
    };
  }

  const elapsedSec = Math.max(0, nowSec - openedAtSec);
  const disputeAgeText = formatDisputeAge(elapsedSec);

  const handoffAtSec = openedAtSec + PRIMARY_RESOLVER_SLA_SECONDS;
  const remainingSec = handoffAtSec - nowSec;

  if (remainingSec <= 0) {
    return {
      deadlineState: 'emergency_handoff',
      disputeAgeText,
      deadlineText: 'Primary review window ended',
      responsibleCommitteeLabel: 'Emergency Committee Eligible',
      isEmergencyEligible: true,
      handoffAt: handoffAtSec,
      openedAt: openedAtSec,
      remainingSeconds: 0,
    };
  }

  if (remainingSec <= 48 * 3600) {
    return {
      deadlineState: 'approaching_handoff',
      disputeAgeText,
      deadlineText: formatRemainingHandoff(remainingSec),
      responsibleCommitteeLabel: 'Primary Committee (Review closing)',
      isEmergencyEligible: false,
      handoffAt: handoffAtSec,
      openedAt: openedAtSec,
      remainingSeconds: remainingSec,
    };
  }

  return {
    deadlineState: 'normal',
    disputeAgeText,
    deadlineText: formatRemainingHandoff(remainingSec),
    responsibleCommitteeLabel: 'Primary Committee Responsible',
    isEmergencyEligible: false,
    handoffAt: handoffAtSec,
    openedAt: openedAtSec,
    remainingSeconds: remainingSec,
  };
}

export function CommitteeTimingBadge({
  timing,
}: {
  timing: CommitteeTimingInfo;
}) {
  const { deadlineState, disputeAgeText, deadlineText, responsibleCommitteeLabel } = timing;

  if (deadlineState === 'final_review') {
    return (
      <div className="flex items-center justify-between flex-wrap gap-2 rounded-md border border-indigo-500/25 bg-indigo-500/5 px-2.5 py-1.5 text-xs text-indigo-300">
        <div className="flex items-center gap-2 flex-wrap">
          <History className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
          <span className="font-semibold text-indigo-200">{disputeAgeText}</span>
          <span className="text-zinc-600">•</span>
          <span className="text-zinc-300">{deadlineText}</span>
        </div>
        <div className="text-[11px] font-mono text-zinc-400">
          <span className="text-zinc-500 mr-1.5 font-sans">Resolver:</span>
          <span className="text-indigo-300 font-medium">{responsibleCommitteeLabel}</span>
        </div>
      </div>
    );
  }

  if (deadlineState === 'emergency_handoff') {
    return (
      <div className="flex items-center justify-between flex-wrap gap-2 rounded-md border border-orange-500/35 bg-orange-500/10 px-2.5 py-1.5 text-xs text-orange-200">
        <div className="flex items-center gap-2 flex-wrap">
          <ShieldAlert className="h-3.5 w-3.5 text-orange-400 shrink-0" />
          <span className="font-semibold text-orange-300">{disputeAgeText}</span>
          <span className="text-zinc-600">•</span>
          <span className="text-orange-200 font-medium">{deadlineText}</span>
        </div>
        <div className="text-[11px] font-mono">
          <span className="text-orange-400/80 mr-1.5 font-sans">Active:</span>
          <span className="text-orange-300 font-semibold">{responsibleCommitteeLabel}</span>
        </div>
      </div>
    );
  }

  if (deadlineState === 'approaching_handoff') {
    return (
      <div className="flex items-center justify-between flex-wrap gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-200">
        <div className="flex items-center gap-2 flex-wrap">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
          <span className="font-medium text-amber-300">{disputeAgeText}</span>
          <span className="text-zinc-600">•</span>
          <span className="font-semibold text-amber-200">{deadlineText}</span>
        </div>
        <div className="text-[11px] font-mono">
          <span className="text-zinc-500 mr-1.5 font-sans">Active:</span>
          <span className="text-amber-300 font-medium">{responsibleCommitteeLabel}</span>
        </div>
      </div>
    );
  }

  if (deadlineState === 'normal') {
    return (
      <div className="flex items-center justify-between flex-wrap gap-2 rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-zinc-300">
        <div className="flex items-center gap-2 flex-wrap">
          <Clock className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
          <span className="text-zinc-400">{disputeAgeText}</span>
          <span className="text-zinc-600">•</span>
          <span className="text-zinc-200 font-medium">{deadlineText}</span>
        </div>
        <div className="text-[11px] font-mono text-zinc-400">
          <span className="text-zinc-500 mr-1.5 font-sans">Active:</span>
          <span className="text-zinc-300 font-medium">{responsibleCommitteeLabel}</span>
        </div>
      </div>
    );
  }

  // Unknown / fallback
  return (
    <div className="flex items-center justify-between flex-wrap gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-zinc-400">
      <div className="flex items-center gap-2 flex-wrap">
        <Clock className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
        <span>{disputeAgeText}</span>
        <span className="text-zinc-600">•</span>
        <span>{deadlineText}</span>
      </div>
    </div>
  );
}

export type CommitteeQueueFilter = 'all' | 'awaiting_my_signature' | 'ready_to_submit';

interface CommitteeQueueProps {
  items: CommitteeQueueItem[];
  activeTab: 'initial' | 'final';
  onSelectMilestone: (item: CommitteeQueueItem) => void;
  isLoading?: boolean;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  quickFilter?: CommitteeQueueFilter;
  onFilterChange?: (filter: CommitteeQueueFilter) => void;
}

function renderQueueProgressBadge(item: CommitteeQueueItem) {
  const { authorizationStatus, signatureCount = 0, hasUserSigned } = item;

  // 1. Expired
  if (authorizationStatus === 'expired') {
    return (
      <Badge
        variant="outline"
        className="border-red-500/40 bg-red-500/10 text-red-300 text-[10px] flex items-center gap-1 font-mono"
      >
        <Clock className="h-3 w-3 text-red-400" />
        <span>Authorization Expired</span>
      </Badge>
    );
  }

  // 2. Invalidated
  if (authorizationStatus === 'invalidated') {
    return (
      <Badge
        variant="outline"
        className="border-zinc-600 bg-zinc-800 text-zinc-400 text-[10px] flex items-center gap-1 font-mono"
      >
        <ShieldAlert className="h-3 w-3 text-zinc-400" />
        <span>Invalidated</span>
      </Badge>
    );
  }

  // 3. Executed
  if (authorizationStatus === 'executed') {
    return (
      <Badge
        variant="outline"
        className="border-purple-500/40 bg-purple-500/10 text-purple-300 text-[10px] flex items-center gap-1 font-mono"
      >
        <CheckCircle2 className="h-3 w-3 text-purple-400" />
        <span>Executed On-Chain</span>
      </Badge>
    );
  }

  // 4. Threshold Ready (2/2)
  if (authorizationStatus === 'threshold_ready' || signatureCount >= 2) {
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge
          variant="outline"
          className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px] flex items-center gap-1 font-mono font-medium"
        >
          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
          <span>Ready to Submit (2/2)</span>
        </Badge>
        {hasUserSigned && (
          <Badge
            variant="outline"
            className="border-white/20 bg-white/5 text-zinc-300 text-[10px] flex items-center gap-1 font-mono"
          >
            <Check className="h-2.5 w-2.5 text-emerald-400" />
            <span>Already Signed</span>
          </Badge>
        )}
      </div>
    );
  }

  // 5. Collecting Signatures (1/2 or 0/2)
  if (authorizationStatus === 'collecting') {
    if (signatureCount === 1) {
      return (
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge
            variant="outline"
            className="border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px] flex items-center gap-1 font-mono"
          >
            <Clock className="h-3 w-3 text-amber-400" />
            <span>Awaiting Signatures (1/2)</span>
          </Badge>
          {hasUserSigned && (
            <Badge
              variant="outline"
              className="border-white/20 bg-white/5 text-zinc-300 text-[10px] flex items-center gap-1 font-mono"
            >
              <Check className="h-2.5 w-2.5 text-emerald-400" />
              <span>Already Signed</span>
            </Badge>
          )}
        </div>
      );
    }
    return (
      <Badge
        variant="outline"
        className="border-sky-500/40 bg-sky-500/10 text-sky-300 text-[10px] flex items-center gap-1 font-mono"
      >
        <Clock className="h-3 w-3 text-sky-400" />
        <span>Awaiting Signatures (0/2)</span>
      </Badge>
    );
  }

  // 6. Not Started (no active authorization)
  return (
    <Badge
      variant="outline"
      className="border-zinc-700 bg-zinc-800/60 text-zinc-400 text-[10px] flex items-center gap-1 font-mono"
    >
      <Clock className="h-3 w-3 text-zinc-500" />
      <span>Not Started</span>
    </Badge>
  );
}

export function CommitteeQueue({
  items,
  activeTab,
  onSelectMilestone,
  isLoading,
  searchQuery: externalSearchQuery,
  onSearchChange,
  quickFilter: externalQuickFilter,
  onFilterChange,
}: CommitteeQueueProps) {
  const [internalSearchQuery, setInternalSearchQuery] = useState<string>('');
  const [internalQuickFilter, setInternalQuickFilter] = useState<CommitteeQueueFilter>('all');

  const searchQuery = externalSearchQuery !== undefined ? externalSearchQuery : internalSearchQuery;
  const setSearchQuery = onSearchChange || setInternalSearchQuery;

  const quickFilter = externalQuickFilter !== undefined ? externalQuickFilter : internalQuickFilter;
  const setQuickFilter = onFilterChange || setInternalQuickFilter;

  // Shared live clock for timing indicators (30s interval)
  const [nowSec, setNowSec] = useState<number>(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    setNowSec(Math.floor(Date.now() / 1000));
    const interval = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // 1. Tab-level items (All cases belonging to active tab)
  const tabItems = useMemo(() => {
    return items.filter((item) =>
      activeTab === 'initial' ? item.phase === 'INITIAL_RESOLUTION' : item.phase === 'FINAL_RESOLUTION'
    );
  }, [items, activeTab]);

  // 2. Summary counts for active tab (Part E)
  const summaryCounts = useMemo(() => {
    const total = tabItems.length;
    let awaitingSignature = 0;
    let readyToSubmit = 0;

    for (const item of tabItems) {
      const isExpired = item.authorizationStatus === 'expired';
      const isInvalidated = item.authorizationStatus === 'invalidated';
      const isExecuted = item.authorizationStatus === 'executed';

      if (!isExpired && !isInvalidated && !isExecuted) {
        if (item.authorizationStatus === 'threshold_ready' || (item.signatureCount ?? 0) >= 2) {
          readyToSubmit++;
        } else if (item.authorizationStatus === 'collecting' && !item.hasUserSigned) {
          awaitingSignature++;
        }
      }
    }

    return { total, awaitingSignature, readyToSubmit };
  }, [tabItems]);

  // 3. Apply Quick Filter (Part C)
  const filterMatchedItems = useMemo(() => {
    if (quickFilter === 'all') return tabItems;

    return tabItems.filter((item) => {
      const isExpired = item.authorizationStatus === 'expired';
      const isInvalidated = item.authorizationStatus === 'invalidated';
      const isExecuted = item.authorizationStatus === 'executed';

      if (isExpired || isInvalidated || isExecuted) {
        return false;
      }

      if (quickFilter === 'awaiting_my_signature') {
        return item.authorizationStatus === 'collecting' && !item.hasUserSigned;
      }

      if (quickFilter === 'ready_to_submit') {
        return item.authorizationStatus === 'threshold_ready' || (item.signatureCount ?? 0) >= 2;
      }

      return true;
    });
  }, [tabItems, quickFilter]);

  // 4. Apply Compact Search (Part B)
  const searchMatchedItems = useMemo(() => {
    const trimmed = searchQuery.trim().toLowerCase();
    if (!trimmed) return filterMatchedItems;

    return filterMatchedItems.filter((item) => {
      // Case-insensitive address match
      const dealMatches = item.dealAddress.toLowerCase().includes(trimmed);
      const clientMatches = item.client.toLowerCase().includes(trimmed);
      const freelancerMatches = item.freelancer.toLowerCase().includes(trimmed);

      // Predictable milestone ID matching
      const cleanNum = trimmed.replace(/^(milestone|ms|#|\s)+/i, '').trim();
      const msZero = String(item.milestoneId);
      const msOne = String(item.milestoneId + 1);

      const milestoneMatches =
        cleanNum === msOne ||
        cleanNum === msZero ||
        trimmed === `milestone #${msOne}` ||
        trimmed === `milestone ${msOne}` ||
        trimmed === `#${msOne}` ||
        trimmed === `ms ${msOne}`;

      return dealMatches || clientMatches || freelancerMatches || milestoneMatches;
    });
  }, [filterMatchedItems, searchQuery]);

  // 5. Default Sorting (Part D)
  const sortedItems = useMemo(() => {
    function getPriority(item: CommitteeQueueItem): number {
      const isExpired = item.authorizationStatus === 'expired';
      const isInvalidated = item.authorizationStatus === 'invalidated';
      const isExecuted = item.authorizationStatus === 'executed';

      // 5. Expired or invalidated authorization cases
      if (isExpired || isInvalidated || isExecuted) {
        return 5;
      }

      // 1. Ready to Submit
      if (item.authorizationStatus === 'threshold_ready' || (item.signatureCount ?? 0) >= 2) {
        return 1;
      }

      // 2. Awaiting My Signature
      if (item.authorizationStatus === 'collecting' && !item.hasUserSigned) {
        return 2;
      }

      // 3. Cases without an authorization
      if (!item.authorizationStatus) {
        return 3;
      }

      // 4. Other active cases (e.g. collecting where user already signed)
      return 4;
    }

    return [...searchMatchedItems].sort((a, b) => {
      const pA = getPriority(a);
      const pB = getPriority(b);
      if (pA !== pB) return pA - pB;

      // Stable secondary sort: dealAddress followed by milestoneId
      const dealComp = a.dealAddress.toLowerCase().localeCompare(b.dealAddress.toLowerCase());
      if (dealComp !== 0) return dealComp;

      return a.milestoneId - b.milestoneId;
    });
  }, [searchMatchedItems]);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-white/20 bg-[#1B1B1B] p-8 text-center text-sm text-[#A3A3A3]">
        Loading committee queue items…
      </div>
    );
  }

  if (tabItems.length === 0) {
    return (
      <div className="rounded-xl border border-white/20 bg-[#1B1B1B] p-8 text-center space-y-2">
        <Scale className="mx-auto h-8 w-8 text-zinc-500" />
        <h4 className="text-sm font-semibold text-zinc-300">No Actionable Milestones</h4>
        <p className="text-xs text-zinc-500">
          {activeTab === 'initial'
            ? 'There are currently no disputed milestones requiring initial committee resolution.'
            : 'There are currently no milestones in final review requiring reconsideration.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Queue Summary and Filter Controls (Part B, C, E, G) */}
      <div className="space-y-3 rounded-xl border border-white/10 bg-[#171717] p-3 shadow-sm">
        {/* Summary Badges Row (Part E) */}
        <div className="flex items-center justify-between gap-2 text-xs text-zinc-400 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-zinc-500 uppercase tracking-wider text-[10px] font-medium">
              {activeTab === 'initial' ? 'Initial Review' : 'Final Review'} Queue:
            </span>
            <Badge variant="outline" className="border-white/20 bg-white/5 text-zinc-200 text-[11px] font-mono font-normal">
              <strong className="text-white mr-1">{summaryCounts.total}</strong> Total
            </Badge>
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-300 text-[11px] font-mono font-normal">
              <strong className="text-amber-200 mr-1">{summaryCounts.awaitingSignature}</strong> Awaiting You
            </Badge>
            <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-[11px] font-mono font-normal">
              <strong className="text-emerald-200 mr-1">{summaryCounts.readyToSubmit}</strong> Ready to Submit
            </Badge>
          </div>
        </div>

        {/* Search & Quick Filter Bar (Part B & C) */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 pt-1 border-t border-white/5">
          {/* Quick Filters */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setQuickFilter('all')}
              className={`h-7 px-2.5 text-xs rounded-full border transition-colors font-medium flex items-center gap-1.5 ${
                quickFilter === 'all'
                  ? 'bg-white text-[#101010] border-white shadow-sm'
                  : 'bg-[#222222] text-zinc-400 border-white/10 hover:text-white hover:border-white/30'
              }`}
            >
              <span>All Cases</span>
              <span className={`text-[10px] font-mono px-1 py-0 rounded ${quickFilter === 'all' ? 'bg-black/15 text-black' : 'bg-white/10 text-zinc-300'}`}>
                {summaryCounts.total}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setQuickFilter('awaiting_my_signature')}
              className={`h-7 px-2.5 text-xs rounded-full border transition-colors font-medium flex items-center gap-1.5 ${
                quickFilter === 'awaiting_my_signature'
                  ? 'bg-amber-400 text-black border-amber-400 shadow-sm'
                  : 'bg-[#222222] text-zinc-400 border-white/10 hover:text-amber-300 hover:border-amber-500/30'
              }`}
            >
              <span>Awaiting My Signature</span>
              <span className={`text-[10px] font-mono px-1 py-0 rounded ${quickFilter === 'awaiting_my_signature' ? 'bg-black/15 text-black' : 'bg-white/10 text-zinc-300'}`}>
                {summaryCounts.awaitingSignature}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setQuickFilter('ready_to_submit')}
              className={`h-7 px-2.5 text-xs rounded-full border transition-colors font-medium flex items-center gap-1.5 ${
                quickFilter === 'ready_to_submit'
                  ? 'bg-emerald-400 text-black border-emerald-400 shadow-sm'
                  : 'bg-[#222222] text-zinc-400 border-white/10 hover:text-emerald-300 hover:border-emerald-500/30'
              }`}
            >
              <span>Ready to Submit</span>
              <span className={`text-[10px] font-mono px-1 py-0 rounded ${quickFilter === 'ready_to_submit' ? 'bg-black/15 text-black' : 'bg-white/10 text-zinc-300'}`}>
                {summaryCounts.readyToSubmit}
              </span>
            </button>
          </div>

          {/* Compact Search Input */}
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 pointer-events-none" />
            <Input
              type="text"
              placeholder="Search address or milestone…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-7 pl-8 pr-7 text-xs bg-[#222222] border-white/15 text-white placeholder:text-zinc-500 focus:border-white/40"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white p-0.5"
                title="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Empty States for Search or Filters (Part F) */}
      {sortedItems.length === 0 ? (
        searchQuery.trim() ? (
          <div className="rounded-xl border border-white/10 bg-[#1B1B1B] p-8 text-center space-y-3">
            <Search className="mx-auto h-7 w-7 text-zinc-500" />
            <div className="space-y-1">
              <h4 className="text-sm font-semibold text-zinc-300">No matching cases found</h4>
              <p className="text-xs text-zinc-500">
                No cases in this review tab match &ldquo;{searchQuery}&rdquo;.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSearchQuery('')}
              className="h-7 text-xs border-white/20 text-zinc-300 hover:text-white"
            >
              Clear search
            </Button>
          </div>
        ) : (
          <div className="rounded-xl border border-white/10 bg-[#1B1B1B] p-8 text-center space-y-3">
            <Filter className="mx-auto h-7 w-7 text-zinc-500" />
            <div className="space-y-1">
              <h4 className="text-sm font-semibold text-zinc-300">
                {quickFilter === 'awaiting_my_signature'
                  ? 'No cases awaiting your signature'
                  : 'No cases ready to submit'}
              </h4>
              <p className="text-xs text-zinc-500">
                {quickFilter === 'awaiting_my_signature'
                  ? 'You have already signed or there are no active signature collections in this tab.'
                  : 'No authorizations currently have 2 of 2 signatures collected in this tab.'}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setQuickFilter('all')}
              className="h-7 text-xs border-white/20 text-zinc-300 hover:text-white"
            >
              View all {activeTab === 'initial' ? 'initial review' : 'final review'} cases
            </Button>
          </div>
        )
      ) : (
        /* Queue Cards List (Part D sorted) */
        <div className="space-y-3">
          {sortedItems.map((item) => {
            const isFinal = item.phase === 'FINAL_RESOLUTION';
            return (
              <Card
                key={`${item.dealAddress}-${item.milestoneId}-${item.phase}`}
                className="border border-white/75 bg-[#1B1B1B] hover:border-white transition-colors shadow-xl"
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={
                          isFinal
                            ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300 text-[10px]'
                            : 'border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px]'
                        }
                      >
                        {isFinal ? 'FINAL REVIEW' : 'DISPUTED'}
                      </Badge>
                      <span className="text-xs font-mono text-zinc-400">
                        Milestone #{item.milestoneId + 1}
                      </span>
                    </div>
                    <div className="text-sm font-mono font-bold text-white">
                      {formatUsdcAmount(item.milestoneAmount)} USDC
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div>
                      <div className="text-[10px] text-zinc-500 uppercase">Deal Address</div>
                      <div className="font-mono text-zinc-300" title={item.dealAddress}>
                        {shortenAddress(item.dealAddress)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-zinc-500 uppercase">Client</div>
                      <div className="font-mono text-zinc-300" title={item.client}>
                        {shortenAddress(item.client)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-zinc-500 uppercase">Freelancer</div>
                      <div className="font-mono text-zinc-300" title={item.freelancer}>
                        {shortenAddress(item.freelancer)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-zinc-500 uppercase">Committee</div>
                      <div className="font-mono text-zinc-300" title={item.authorizedCommittee}>
                        {shortenAddress(item.authorizedCommittee)}
                      </div>
                    </div>
                  </div>

                  {/* Review Timing & SLA Section (Phase 2E.2) */}
                  <CommitteeTimingBadge timing={getCommitteeTimingInfo(item, nowSec)} />

                  <div className="flex items-center justify-between pt-2 border-t border-zinc-800/60 gap-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {renderQueueProgressBadge(item)}
                    </div>
                    <Button
                      size="sm"
                      onClick={() => onSelectMilestone(item)}
                      className="h-7 text-xs bg-white hover:bg-neutral-200 text-[#101010] font-semibold flex items-center gap-1.5 shrink-0"
                    >
                      <span>Review & Resolve</span>
                      <ArrowRight className="h-3 w-3" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

