'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { shortenAddress } from '@/lib/utils';
import { formatUsdcAmount } from '@/lib/deals/v2';
import { useAuthSession } from '@/hooks/useAuthSession';
import type { CommitteeHistoryItem } from '@/lib/deals/resolution-reports-db';
import type { ResolutionReportPhase } from '@/db/schema';
import {
  Scale,
  History,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Loader2,
  AlertTriangle,
  FileText,
  Clock,
  ShieldCheck,
  CheckCircle2,
  RefreshCw,
  Info,
  Sparkles,
  X,
} from 'lucide-react';

export interface HighlightedCaseTarget {
  dealAddress: string;
  milestoneId: number;
  phase: ResolutionReportPhase;
}

interface CommitteeHistoryProps {
  onRefresh?: () => void;
  highlightedCase?: HighlightedCaseTarget | null;
  onClearHighlight?: () => void;
}

export function CommitteeHistory({
  onRefresh,
  highlightedCase,
  onClearHighlight,
}: CommitteeHistoryProps) {
  const { getToken } = useAuthSession();

  const [items, setItems] = useState<CommitteeHistoryItem[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [page, setPage] = useState<number>(0);
  const pageSize = 10;

  const [phaseFilter, setPhaseFilter] = useState<'ALL' | ResolutionReportPhase>('ALL');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Expanded report IDs
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // If highlightedCase arrives and filter is incompatible, reset filter to ALL
  useEffect(() => {
    if (highlightedCase) {
      if (phaseFilter !== 'ALL' && phaseFilter !== highlightedCase.phase) {
        setPhaseFilter('ALL');
      }
    }
  }, [highlightedCase]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

      const params = new URLSearchParams();
      params.set('limit', String(pageSize));
      params.set('offset', String(page * pageSize));
      if (phaseFilter !== 'ALL') {
        params.set('phase', phaseFilter);
      }

      const res = await fetch(`/api/committee/history?${params.toString()}`, { headers });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const loadedItems: CommitteeHistoryItem[] = data.items || [];
      setItems(loadedItems);
      setTotal(data.total || 0);

      // Auto-expand matching highlighted case if found
      if (highlightedCase) {
        const match = loadedItems.find(
          (it) =>
            it.dealAddress.toLowerCase() === highlightedCase.dealAddress.toLowerCase() &&
            it.milestoneId === highlightedCase.milestoneId &&
            it.phase === highlightedCase.phase
        );
        if (match) {
          setExpandedIds((prev) => new Set([...prev, match.id]));
        }
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load resolution history');
    } finally {
      setLoading(false);
    }
  }, [getToken, page, phaseFilter, highlightedCase]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const totalPages = Math.ceil(total / pageSize);

  const matchingItemOnPage = items.find(
    (item) =>
      highlightedCase &&
      item.dealAddress.toLowerCase() === highlightedCase.dealAddress.toLowerCase() &&
      item.milestoneId === highlightedCase.milestoneId &&
      item.phase === highlightedCase.phase
  );

  return (
    <div className="space-y-4">
      {/* Top Filter and Controls Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#171717] p-3 shadow-sm">
        {/* Phase Filters */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => {
              setPhaseFilter('ALL');
              setPage(0);
            }}
            className={`h-7 px-2.5 text-xs rounded-full border transition-colors font-medium flex items-center gap-1.5 ${
              phaseFilter === 'ALL'
                ? 'bg-white text-[#101010] border-white shadow-sm'
                : 'bg-[#222222] text-zinc-400 border-white/10 hover:text-white hover:border-white/30'
            }`}
          >
            <span>All Decisions</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setPhaseFilter('INITIAL_RESOLUTION');
              setPage(0);
            }}
            className={`h-7 px-2.5 text-xs rounded-full border transition-colors font-medium flex items-center gap-1.5 ${
              phaseFilter === 'INITIAL_RESOLUTION'
                ? 'bg-amber-400 text-black border-amber-400 shadow-sm'
                : 'bg-[#222222] text-zinc-400 border-white/10 hover:text-amber-300 hover:border-amber-500/30'
            }`}
          >
            <span>Initial Resolutions</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setPhaseFilter('FINAL_RESOLUTION');
              setPage(0);
            }}
            className={`h-7 px-2.5 text-xs rounded-full border transition-colors font-medium flex items-center gap-1.5 ${
              phaseFilter === 'FINAL_RESOLUTION'
                ? 'bg-indigo-400 text-black border-indigo-400 shadow-sm'
                : 'bg-[#222222] text-zinc-400 border-white/10 hover:text-indigo-300 hover:border-indigo-500/30'
            }`}
          >
            <span>Final Reconsiderations</span>
          </button>
        </div>

        {/* Count and Refresh */}
        <div className="flex items-center justify-between sm:justify-end gap-2 text-xs text-zinc-400">
          <span className="font-mono text-[11px]">
            {total} {total === 1 ? 'record' : 'records'}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              fetchHistory();
              onRefresh?.();
            }}
            disabled={loading}
            className="h-7 text-xs border border-white/20 bg-[#252525] text-white hover:bg-neutral-800 flex items-center gap-1.5"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Highlight or Fallback Notification Banner */}
      {highlightedCase && !loading && (
        matchingItemOnPage ? (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/20 p-3 text-xs text-emerald-200 flex items-center justify-between gap-3 shadow-md">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-emerald-400 shrink-0" />
              <span>
                Highlighting newly reconciled decision for <strong>Milestone #{highlightedCase.milestoneId + 1}</strong> ({shortenAddress(highlightedCase.dealAddress)}).
              </span>
            </div>
            {onClearHighlight && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onClearHighlight}
                className="h-6 px-2 text-[11px] text-emerald-300 hover:text-white hover:bg-emerald-500/20"
              >
                <X className="h-3.5 w-3.5 mr-1" />
                <span>Dismiss</span>
              </Button>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-sky-500/30 bg-sky-950/20 p-3 text-xs text-sky-200 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Info className="h-4 w-4 text-sky-400 shrink-0" />
              <span>
                Recently resolved case ({shortenAddress(highlightedCase.dealAddress)} — Milestone #{highlightedCase.milestoneId + 1}, {highlightedCase.phase === 'INITIAL_RESOLUTION' ? 'Initial Review' : 'Final Reconsideration'}) is confirmed on-chain. It may appear on another page or under a different phase filter.
              </span>
            </div>
            {onClearHighlight && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onClearHighlight}
                className="h-6 px-2 text-[11px] text-sky-300 hover:text-white hover:bg-sky-500/20"
              >
                <X className="h-3.5 w-3.5 mr-1" />
                <span>Dismiss</span>
              </Button>
            )}
          </div>
        )
      )}

      {/* Error Banner */}
      {error && (
        <div className="rounded-xl border border-red-500/40 bg-red-950/30 p-3 text-xs text-red-300 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
            <span>{error}</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={fetchHistory}
            className="h-6 text-[11px] border-red-500/40 text-red-300 hover:bg-red-500/10"
          >
            Retry
          </Button>
        </div>
      )}

      {/* Loading State */}
      {loading ? (
        <div className="rounded-xl border border-white/20 bg-[#1B1B1B] p-12 text-center space-y-2">
          <Loader2 className="mx-auto h-7 w-7 animate-spin text-zinc-500" />
          <p className="text-xs text-zinc-400">Loading resolution history…</p>
        </div>
      ) : items.length === 0 ? (
        /* Empty State */
        <div className="rounded-xl border border-white/20 bg-[#1B1B1B] p-12 text-center space-y-2">
          <History className="mx-auto h-8 w-8 text-zinc-500" />
          <h4 className="text-sm font-semibold text-zinc-300">No Resolution History Found</h4>
          <p className="text-xs text-zinc-500 max-w-sm mx-auto">
            {phaseFilter === 'ALL'
              ? 'No confirmed resolution reports were found for your authorized committee.'
              : `No confirmed ${phaseFilter === 'INITIAL_RESOLUTION' ? 'initial resolution' : 'final reconsideration'} reports were found.`}
          </p>
        </div>
      ) : (
        /* History Cards List */
        <div className="space-y-3">
          {items.map((item) => {
            const isFinal = item.phase === 'FINAL_RESOLUTION';
            const isExpanded = expandedIds.has(item.id);
            const isMatch =
              highlightedCase &&
              item.dealAddress.toLowerCase() === highlightedCase.dealAddress.toLowerCase() &&
              item.milestoneId === highlightedCase.milestoneId &&
              item.phase === highlightedCase.phase;

            return (
              <Card
                key={item.id}
                className={`transition-all shadow-xl ${
                  isMatch
                    ? 'border-2 border-emerald-500 bg-[#16211c] ring-1 ring-emerald-500/40 shadow-emerald-950/30'
                    : item.isSuperseded
                    ? 'border border-white/20 bg-[#181818] hover:border-white/40'
                    : 'border border-white/75 bg-[#1B1B1B] hover:border-white'
                }`}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge
                        variant="outline"
                        className={
                          isFinal
                            ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300 text-[10px] font-mono'
                            : 'border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px] font-mono'
                        }
                      >
                        {isFinal ? 'FINAL RESOLUTION' : 'INITIAL RESOLUTION'}
                      </Badge>
                      <span className="text-xs font-mono text-zinc-300 font-medium">
                        Milestone #{item.milestoneId + 1}
                      </span>
                      {isMatch && (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/60 bg-emerald-500/20 text-emerald-300 text-[10px] flex items-center gap-1 font-mono font-medium"
                        >
                          <Sparkles className="h-3 w-3 text-emerald-400" />
                          <span>Newly Resolved</span>
                        </Badge>
                      )}
                    </div>

                    {/* Settlement State Classification Badge */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {isFinal ? (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px] flex items-center gap-1 font-mono font-medium"
                        >
                          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                          <span>Final Decision Confirmed</span>
                        </Badge>
                      ) : item.isSuperseded ? (
                        <>
                          <Badge
                            variant="outline"
                            className="border-amber-500/30 bg-amber-500/5 text-amber-300/80 text-[10px] flex items-center gap-1 font-mono"
                          >
                            <Clock className="h-3 w-3 text-amber-400/80" />
                            <span>Initial Decision Proposed</span>
                          </Badge>
                          <Badge
                            variant="outline"
                            className="border-zinc-500/50 bg-zinc-800/80 text-zinc-300 text-[10px] flex items-center gap-1 font-mono font-medium"
                          >
                            <History className="h-3 w-3 text-zinc-400" />
                            <span>Superseded by Final Resolution</span>
                          </Badge>
                        </>
                      ) : (
                        <Badge
                          variant="outline"
                          className="border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px] flex items-center gap-1 font-mono"
                        >
                          <Clock className="h-3 w-3 text-amber-400" />
                          <span>Initial Decision Proposed</span>
                        </Badge>
                      )}
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="space-y-3 pt-0 text-xs">
                  {/* Context Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div>
                      <div className="text-[10px] text-zinc-500 uppercase">Deal Address</div>
                      <div className="font-mono text-zinc-300" title={item.dealAddress}>
                        {shortenAddress(item.dealAddress)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-zinc-500 uppercase">Total Escrow</div>
                      <div className="font-mono text-white font-medium">
                        {formatUsdcAmount(item.totalAmount)} USDC
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-zinc-500 uppercase">Confirmed Date</div>
                      <div className="text-zinc-300">
                        {item.resolvedAt
                          ? new Date(item.resolvedAt).toLocaleDateString(undefined, {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                            })
                          : 'Confirmed'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-zinc-500 uppercase">Committee Resolver</div>
                      <div className="font-mono text-zinc-300" title={item.committeeAddress}>
                        {shortenAddress(item.committeeAddress)}
                      </div>
                    </div>
                  </div>

                  {/* Split Distribution Box */}
                  <div
                    className={`rounded-lg p-2.5 flex items-center justify-between flex-wrap gap-2 text-xs border ${
                      item.isSuperseded ? 'bg-[#1c1c1c] border-white/5' : 'bg-[#222222] border-white/10'
                    }`}
                  >
                    <div className="flex items-center gap-4 flex-wrap font-mono">
                      <div>
                        <span className="text-[10px] text-zinc-500 uppercase font-sans mr-1.5">
                          {item.isSuperseded ? 'Proposed Freelancer:' : 'Freelancer:'}
                        </span>
                        <strong className={item.isSuperseded ? 'text-zinc-300' : 'text-emerald-300'}>
                          {formatUsdcAmount(item.freelancerAmount)} USDC
                        </strong>
                      </div>
                      <div>
                        <span className="text-[10px] text-zinc-500 uppercase font-sans mr-1.5">
                          {item.isSuperseded ? 'Proposed Client Refund:' : 'Client Refund:'}
                        </span>
                        <strong className={item.isSuperseded ? 'text-zinc-300' : 'text-sky-300'}>
                          {formatUsdcAmount(item.clientAmount)} USDC
                        </strong>
                      </div>
                      {item.isSuperseded && (
                        <span className="text-[10px] font-sans text-zinc-500 italic">
                          (Superseded Proposal)
                        </span>
                      )}
                    </div>

                    {/* Settlement Status Note */}
                    <div className="text-[11px] text-zinc-400">
                      {isFinal ? (
                        <span className="text-emerald-400 font-medium">
                          Settled On-Chain via Final Execution
                        </span>
                      ) : item.isSuperseded ? (
                        <span className="text-zinc-400 font-medium flex items-center gap-1">
                          <Info className="h-3 w-3 text-zinc-500" />
                          <span>Superseded by Final Resolution</span>
                        </span>
                      ) : (
                        <span className="text-amber-400/90 font-medium">
                          Proposal Confirmed (Settlement Not Yet Verified)
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Summary Preview */}
                  {item.summaryPreview && (
                    <div className="text-xs text-zinc-400 bg-[#171717] rounded-md p-2.5 border border-white/5 leading-relaxed">
                      <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold block mb-0.5">
                        Executive Summary
                      </span>
                      {item.summaryPreview}
                    </div>
                  )}

                  {/* Expandable Report Details (Part F) */}
                  {isExpanded && (
                    <div className="rounded-lg bg-[#191919] border border-white/10 p-3 space-y-3 text-xs">
                      {item.isSuperseded && (
                        <div className="rounded border border-zinc-700/60 bg-zinc-900/80 p-2.5 text-[11px] text-zinc-300 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Info className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                            <span>
                              This initial resolution proposal was challenged through final reconsideration and has been superseded by a binding final settlement on-chain.
                            </span>
                          </div>
                          {item.supersedingTxHash && (
                            <a
                              href={`https://sepolia.etherscan.io/tx/${item.supersedingTxHash}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-sky-400 hover:text-sky-300 font-mono text-xs flex items-center gap-1 shrink-0 ml-2"
                            >
                              <span>View Final Tx</span>
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                      )}

                      <div>
                        <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
                          Findings
                        </div>
                        <p className="mt-1 text-zinc-300 whitespace-pre-wrap leading-relaxed">
                          {item.findings || 'No findings recorded.'}
                        </p>
                      </div>

                      <div>
                        <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
                          Justification
                        </div>
                        <p className="mt-1 text-zinc-300 whitespace-pre-wrap leading-relaxed">
                          {item.justification || 'No justification recorded.'}
                        </p>
                      </div>

                      {item.evidenceReferences && item.evidenceReferences.length > 0 && (
                        <div>
                          <div className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
                            Referenced Evidence ({item.evidenceReferences.length})
                          </div>
                          <ul className="mt-1 space-y-1">
                            {item.evidenceReferences.map((ref: any, idx: number) => (
                              <li
                                key={idx}
                                className="flex items-center gap-1.5 text-zinc-400 font-mono text-[11px]"
                              >
                                <span>•</span>
                                <span className="text-zinc-200">{ref.title || `Evidence #${idx + 1}`}</span>
                                {ref.url && (
                                  <a
                                    href={ref.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-sky-400 hover:underline flex items-center gap-0.5 ml-1"
                                  >
                                    <span>[link]</span>
                                    <ExternalLink className="h-2.5 w-2.5" />
                                  </a>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="pt-2 border-t border-white/10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-[11px] font-mono text-zinc-500">
                        <div>
                          <span>Justification Hash: </span>
                          <span className="text-zinc-400">{item.justificationHash.slice(0, 16)}…</span>
                        </div>
                        <div>
                          <span>Author: </span>
                          <span className="text-zinc-400">{shortenAddress(item.stagedByWallet)}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Bottom Action Row */}
                  <div className="flex items-center justify-between pt-2 border-t border-zinc-800/60 flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => toggleExpand(item.id)}
                      className="text-xs text-zinc-400 hover:text-white flex items-center gap-1 transition-colors"
                    >
                      <span>{isExpanded ? 'Hide Decision Report' : 'View Full Decision Report'}</span>
                      {isExpanded ? (
                        <ChevronUp className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                    </button>

                    {item.txHash ? (
                      <a
                        href={`https://sepolia.etherscan.io/tx/${item.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-sky-400 hover:text-sky-300 font-mono flex items-center gap-1 transition-colors"
                      >
                        <span>{item.isSuperseded ? 'View Proposal Tx' : isFinal ? 'View Settlement Tx' : 'View On-Chain Tx'}</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-[11px] text-zinc-500 italic">Tx Hash Unrecorded</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-zinc-400 pt-2 border-t border-white/10">
          <div>
            Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="h-7 text-xs border-white/20 text-zinc-300 hover:text-white"
            >
              Previous
            </Button>
            <span className="font-mono text-zinc-500">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="h-7 text-xs border-white/20 text-zinc-300 hover:text-white"
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
