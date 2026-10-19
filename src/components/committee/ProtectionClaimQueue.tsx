'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { shortenAddress } from '@/lib/utils';
import { formatUsdcAmount } from '@/lib/deals/v2';
import { useAuthSession } from '@/hooks/useAuthSession';
import {
  ShieldCheck,
  ShieldAlert,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Search,
  X,
  ArrowRight,
  RefreshCw,
  FileText,
  UserCheck,
  History,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  DollarSign,
} from 'lucide-react';
import type { ProtectionClaimRow, ProtectionClaimDecisionRow } from '@/db/schema';
import type { ProtectionClaimHistoryItem } from '@/lib/deals/protection-committee-db';

export interface ProtectionQueueItem {
  claim: ProtectionClaimRow;
  onChainStatus: number;
  activeDecision: ProtectionClaimDecisionRow | null;
  signatureCount: number;
}

export type ProtectionQueueFilter = 'all' | 'awaiting_decision' | 'collecting' | 'ready_to_execute';
export type ProtectionViewMode = 'active' | 'history';

interface ProtectionClaimQueueProps {
  items: ProtectionQueueItem[];
  isLoading: boolean;
  error?: string | null;
  onRefresh: () => void;
  onSelectClaim: (item: ProtectionQueueItem) => void;
}

export function formatClaimStatus(status: number): {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  className: string;
} {
  switch (status) {
    case 1:
      return {
        label: 'Claim Submitted',
        variant: 'outline',
        className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
      };
    case 2:
      return {
        label: 'Approved by Committee',
        variant: 'outline',
        className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
      };
    case 3:
      return {
        label: 'Rejected by Committee',
        variant: 'outline',
        className: 'border-red-500/40 bg-red-950/20 text-red-400',
      };
    case 4:
      return {
        label: 'Disbursed / Paid',
        variant: 'outline',
        className: 'border-blue-500/40 bg-blue-500/10 text-blue-300',
      };
    default:
      return {
        label: 'None / Inactive',
        variant: 'outline',
        className: 'border-zinc-500/30 bg-zinc-800/50 text-zinc-400',
      };
  }
}

export function ProtectionClaimQueue({
  items,
  isLoading,
  error,
  onRefresh,
  onSelectClaim,
}: ProtectionClaimQueueProps) {
  const { getToken } = useAuthSession();

  // Primary view: Active vs History
  const [viewMode, setViewMode] = useState<ProtectionViewMode>('active');

  // Active queue filters
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeFilter, setActiveFilter] = useState<ProtectionQueueFilter>('all');

  // History state
  const [historyItems, setHistoryItems] = useState<ProtectionClaimHistoryItem[]>([]);
  const [loadingHistory, setLoadingHistory] = useState<boolean>(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyPage, setHistoryPage] = useState<number>(1);
  const [historyPagination, setHistoryPagination] = useState<{
    total: number;
    totalPages: number;
    page: number;
    limit: number;
  }>({ total: 0, totalPages: 1, page: 1, limit: 10 });

  const fetchHistory = useCallback(
    async (pageToFetch = 1) => {
      setLoadingHistory(true);
      setHistoryError(null);
      try {
        const token = await getToken();
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        const res = await fetch(`/api/committee/protection/history?page=${pageToFetch}&limit=10`, {
          headers,
        });
        if (!res.ok) {
          const errJson = await res.json().catch(() => ({}));
          throw new Error(errJson.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setHistoryItems(data.items || []);
        if (data.pagination) {
          setHistoryPagination(data.pagination);
          setHistoryPage(data.pagination.page);
        }
      } catch (err: any) {
        setHistoryError(err?.message || 'Failed to load protection claim history');
      } finally {
        setLoadingHistory(false);
      }
    },
    [getToken]
  );

  useEffect(() => {
    if (viewMode === 'history') {
      fetchHistory(historyPage);
    }
  }, [viewMode, historyPage, fetchHistory]);

  const filteredActiveItems = useMemo(() => {
    let result = items;

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter(
        (i) =>
          i.claim.dealAddress.toLowerCase().includes(q) ||
          i.claim.clientWallet.toLowerCase().includes(q) ||
          i.claim.evidenceHash.toLowerCase().includes(q)
      );
    }

    if (activeFilter === 'awaiting_decision') {
      result = result.filter((i) => !i.activeDecision && i.onChainStatus === 1);
    } else if (activeFilter === 'collecting') {
      result = result.filter((i) => i.activeDecision?.status === 'collecting');
    } else if (activeFilter === 'ready_to_execute') {
      result = result.filter((i) => i.activeDecision?.status === 'threshold_ready');
    }

    return result;
  }, [items, searchQuery, activeFilter]);

  const filteredHistoryItems = useMemo(() => {
    if (!searchQuery.trim()) return historyItems;
    const q = searchQuery.trim().toLowerCase();
    return historyItems.filter(
      (h) =>
        h.dealAddress.toLowerCase().includes(q) ||
        h.clientWallet.toLowerCase().includes(q) ||
        (h.executionTxHash && h.executionTxHash.toLowerCase().includes(q))
    );
  }, [historyItems, searchQuery]);

  const awaitingCount = useMemo(
    () => items.filter((i) => !i.activeDecision && i.onChainStatus === 1).length,
    [items]
  );
  const collectingCount = useMemo(
    () => items.filter((i) => i.activeDecision?.status === 'collecting').length,
    [items]
  );
  const readyCount = useMemo(
    () => items.filter((i) => i.activeDecision?.status === 'threshold_ready').length,
    [items]
  );

  const handleSelectHistoryItem = (hItem: ProtectionClaimHistoryItem) => {
    onSelectClaim({
      claim: {
        id: hItem.id,
        chainId: 11155111,
        managerAddress: '',
        dealAddress: hItem.dealAddress,
        milestoneId: hItem.milestoneId,
        clientWallet: hItem.clientWallet,
        evidenceHash: hItem.evidenceHash,
        canonicalManifest: {},
        status: 'confirmed',
        txHash: hItem.executionTxHash,
        submittedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      onChainStatus: hItem.onChainStatus,
      activeDecision: null,
      signatureCount: hItem.signatureCount,
    });
  };

  return (
    <div className="space-y-4">
      {/* Primary View Switcher: Active vs History */}
      <div className="flex items-center justify-between border-b border-white/10 pb-3">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={viewMode === 'active' ? 'default' : 'outline'}
            onClick={() => setViewMode('active')}
            className={`h-8 text-xs font-semibold px-3.5 ${
              viewMode === 'active'
                ? 'bg-emerald-500 hover:bg-emerald-400 text-black shadow-sm'
                : 'border-white/10 bg-[#1E1E1E] text-zinc-300 hover:text-white'
            }`}
          >
            <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />
            Active Claims ({items.length})
          </Button>

          <Button
            size="sm"
            variant={viewMode === 'history' ? 'default' : 'outline'}
            onClick={() => setViewMode('history')}
            className={`h-8 text-xs font-semibold px-3.5 ${
              viewMode === 'history'
                ? 'bg-emerald-500 hover:bg-emerald-400 text-black shadow-sm'
                : 'border-white/10 bg-[#1E1E1E] text-zinc-300 hover:text-white'
            }`}
          >
            <History className="h-3.5 w-3.5 mr-1.5" />
            Decision History {historyPagination.total > 0 && `(${historyPagination.total})`}
          </Button>
        </div>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (viewMode === 'active') {
              onRefresh();
            } else {
              fetchHistory(historyPage);
            }
          }}
          disabled={isLoading || loadingHistory}
          className="h-8 text-xs text-zinc-400 hover:text-white"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 mr-1 ${isLoading || loadingHistory ? 'animate-spin' : ''}`}
          />
          Refresh
        </Button>
      </div>

      {/* VIEW MODE: ACTIVE CLAIMS */}
      {viewMode === 'active' && (
        <div className="space-y-4">
          {/* Search and Filters */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search active claims by deal address, client, or evidence…"
                className="pl-9 pr-9 h-9 text-xs bg-[#252525] border-white/10 text-white placeholder:text-zinc-500"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-2.5 text-zinc-400 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
              <Button
                size="sm"
                variant={activeFilter === 'all' ? 'secondary' : 'outline'}
                onClick={() => setActiveFilter('all')}
                className={`h-8 text-[11px] px-2.5 ${
                  activeFilter === 'all'
                    ? 'bg-white text-black font-semibold'
                    : 'border-white/10 bg-[#1E1E1E] text-zinc-300 hover:text-white'
                }`}
              >
                All ({items.length})
              </Button>

              <Button
                size="sm"
                variant={activeFilter === 'awaiting_decision' ? 'secondary' : 'outline'}
                onClick={() => setActiveFilter('awaiting_decision')}
                className={`h-8 text-[11px] px-2.5 ${
                  activeFilter === 'awaiting_decision'
                    ? 'bg-amber-400 text-black font-semibold'
                    : 'border-white/10 bg-[#1E1E1E] text-zinc-300 hover:text-white'
                }`}
              >
                Needs Review ({awaitingCount})
              </Button>

              <Button
                size="sm"
                variant={activeFilter === 'collecting' ? 'secondary' : 'outline'}
                onClick={() => setActiveFilter('collecting')}
                className={`h-8 text-[11px] px-2.5 ${
                  activeFilter === 'collecting'
                    ? 'bg-blue-400 text-black font-semibold'
                    : 'border-white/10 bg-[#1E1E1E] text-zinc-300 hover:text-white'
                }`}
              >
                Signing ({collectingCount})
              </Button>

              <Button
                size="sm"
                variant={activeFilter === 'ready_to_execute' ? 'secondary' : 'outline'}
                onClick={() => setActiveFilter('ready_to_execute')}
                className={`h-8 text-[11px] px-2.5 ${
                  activeFilter === 'ready_to_execute'
                    ? 'bg-emerald-400 text-black font-semibold'
                    : 'border-white/10 bg-[#1E1E1E] text-zinc-300 hover:text-white'
                }`}
              >
                Ready to Execute ({readyCount})
              </Button>
            </div>
          </div>

          {error && (
            <div className="p-3 rounded-lg border border-red-500/30 bg-red-950/20 text-xs text-red-300 flex items-center justify-between">
              <span>{error}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={onRefresh}
                className="h-7 text-xs text-red-300"
              >
                <RefreshCw className="h-3 w-3 mr-1" /> Retry
              </Button>
            </div>
          )}

          {/* Active Queue Items */}
          {isLoading ? (
            <div className="py-12 text-center text-xs text-zinc-400 space-y-2">
              <RefreshCw className="h-6 w-6 animate-spin mx-auto text-zinc-500" />
              <p>Loading Protection Committee claim queue…</p>
            </div>
          ) : filteredActiveItems.length === 0 ? (
            <div className="py-12 text-center rounded-xl border border-white/5 bg-[#1B1B1B] p-6 space-y-2">
              <ShieldCheck className="h-8 w-8 mx-auto text-zinc-500" />
              <p className="text-sm font-semibold text-white">No Active Protection Claims</p>
              <p className="text-xs text-zinc-400 max-w-sm mx-auto">
                {searchQuery
                  ? 'No active claims match your search query.'
                  : 'There are currently no submitted client claims awaiting committee adjudication. Switch to Decision History to review completed cases.'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredActiveItems.map((item) => {
                const statusConfig = formatClaimStatus(item.onChainStatus);
                const isReady = item.activeDecision?.status === 'threshold_ready';
                const isCollecting = item.activeDecision?.status === 'collecting';
                const decisionPreview =
                  item.activeDecision?.decision === 1
                    ? 'APPROVE'
                    : item.activeDecision?.decision === 2
                      ? 'REJECT'
                      : null;

                return (
                  <Card
                    key={`${item.claim.dealAddress}-${item.claim.milestoneId}`}
                    className="border border-white/10 bg-[#1E1E1E] hover:border-white/20 transition-all shadow-md overflow-hidden"
                  >
                    <CardContent className="p-4 sm:p-5">
                      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                        <div className="space-y-1.5 flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-mono font-bold text-white">
                              Deal {shortenAddress(item.claim.dealAddress)}
                            </span>
                            <Badge
                              variant="outline"
                              className="text-[10px] bg-white/5 border-white/10 text-zinc-300 font-mono"
                            >
                              Milestone #{item.claim.milestoneId + 1}
                            </Badge>
                            <Badge
                              variant={statusConfig.variant}
                              className={`text-[10px] ${statusConfig.className}`}
                            >
                              {statusConfig.label}
                            </Badge>
                          </div>

                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-400">
                            <span>
                              Client:{' '}
                              <span className="font-mono text-zinc-300">
                                {shortenAddress(item.claim.clientWallet)}
                              </span>
                            </span>
                            {item.claim.submittedAt && (
                              <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3 text-zinc-500" />
                                Submitted: {new Date(item.claim.submittedAt).toLocaleDateString()}
                              </span>
                            )}
                            <span className="font-mono text-[10px] text-zinc-500 truncate max-w-[200px]">
                              Ev: {item.claim.evidenceHash.slice(0, 10)}…
                            </span>
                          </div>

                          {/* Active Decision Status Pill */}
                          {item.activeDecision ? (
                            <div className="pt-2 flex flex-wrap items-center gap-2">
                              <span className="text-[10px] uppercase font-bold text-zinc-400">
                                Draft:
                              </span>
                              <Badge
                                className={`text-[10px] font-bold ${
                                  decisionPreview === 'APPROVE'
                                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                                    : 'bg-red-500/20 text-red-300 border-red-500/40'
                                }`}
                              >
                                {decisionPreview}
                              </Badge>

                              {isReady ? (
                                <Badge className="bg-emerald-500 text-black font-bold text-[10px] flex items-center gap-1">
                                  <CheckCircle2 className="h-3 w-3" /> Ready to Execute (2/2
                                  Signatures)
                                </Badge>
                              ) : isCollecting ? (
                                <Badge
                                  variant="outline"
                                  className="border-blue-500/40 bg-blue-500/10 text-blue-300 text-[10px] flex items-center gap-1"
                                >
                                  <UserCheck className="h-3 w-3" /> Collecting Signatures (
                                  {item.signatureCount}/2)
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-[10px] text-zinc-400">
                                  Status: {item.activeDecision.status}
                                </Badge>
                              )}
                            </div>
                          ) : (
                            <div className="pt-2 text-[11px] text-amber-400/90 flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              <span>No decision drafted yet. Adjudication required.</span>
                            </div>
                          )}
                        </div>

                        <div className="w-full sm:w-auto flex justify-end">
                          <Button
                            size="sm"
                            onClick={() => onSelectClaim(item)}
                            className={`h-9 px-4 text-xs font-semibold flex items-center gap-1.5 w-full sm:w-auto ${
                              isReady
                                ? 'bg-emerald-500 hover:bg-emerald-400 text-black shadow-lg shadow-emerald-500/10'
                                : isCollecting
                                  ? 'bg-blue-600 hover:bg-blue-500 text-white'
                                  : 'bg-white hover:bg-zinc-200 text-black'
                            }`}
                          >
                            <span>
                              {isReady
                                ? 'Execute Decision'
                                : item.activeDecision
                                  ? 'Review & Sign'
                                  : 'Review Claim'}
                            </span>
                            <ArrowRight className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* VIEW MODE: DECISION HISTORY */}
      {viewMode === 'history' && (
        <div className="space-y-4">
          {/* Search in History */}
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search history by deal address, client, or execution transaction…"
              className="pl-9 pr-9 h-9 text-xs bg-[#252525] border-white/10 text-white placeholder:text-zinc-500"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-2.5 text-zinc-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {historyError && (
            <div className="p-3 rounded-lg border border-red-500/30 bg-red-950/20 text-xs text-red-300 flex items-center justify-between">
              <span>{historyError}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => fetchHistory(historyPage)}
                className="h-7 text-xs text-red-300"
              >
                <RefreshCw className="h-3 w-3 mr-1" /> Retry
              </Button>
            </div>
          )}

          {/* History List */}
          {loadingHistory ? (
            <div className="py-12 text-center text-xs text-zinc-400 space-y-2">
              <RefreshCw className="h-6 w-6 animate-spin mx-auto text-zinc-500" />
              <p>Loading completed protection decisions history…</p>
            </div>
          ) : filteredHistoryItems.length === 0 ? (
            <div className="py-12 text-center rounded-xl border border-white/5 bg-[#1B1B1B] p-6 space-y-2">
              <History className="h-8 w-8 mx-auto text-zinc-500" />
              <p className="text-sm font-semibold text-white">No Decision History Found</p>
              <p className="text-xs text-zinc-400 max-w-sm mx-auto">
                {searchQuery
                  ? 'No executed protection claims match your search query.'
                  : 'Executed committee determinations will appear here permanently with verified on-chain execution details.'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredHistoryItems.map((hItem) => {
                const isApproved = hItem.decision === 1;
                const statusConfig = formatClaimStatus(hItem.onChainStatus);
                const payoutUsdc = hItem.approvedPayoutAmount
                  ? formatUsdcAmount(BigInt(hItem.approvedPayoutAmount))
                  : null;

                return (
                  <Card
                    key={hItem.id}
                    className="border border-white/10 bg-[#1E1E1E] hover:border-white/20 transition-all shadow-md overflow-hidden"
                  >
                    <CardContent className="p-4 sm:p-5">
                      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                        <div className="space-y-2 flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-mono font-bold text-white">
                              Deal {shortenAddress(hItem.dealAddress)}
                            </span>
                            <Badge
                              variant="outline"
                              className="text-[10px] bg-white/5 border-white/10 text-zinc-300 font-mono"
                            >
                              Milestone #{hItem.milestoneId + 1}
                            </Badge>

                            {/* Committee Decision Badge */}
                            <Badge
                              className={`text-[10px] font-bold ${
                                isApproved
                                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                                  : 'bg-red-500/20 text-red-300 border-red-500/40'
                              }`}
                            >
                              {isApproved ? 'Approved by Committee' : 'Rejected by Committee'}
                            </Badge>

                            {/* Live On-Chain Status Badge */}
                            <Badge
                              variant={statusConfig.variant}
                              className={`text-[10px] ${statusConfig.className}`}
                            >
                              Status: {statusConfig.label}
                            </Badge>
                          </div>

                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-400">
                            <span>
                              Client:{' '}
                              <span className="font-mono text-zinc-300">
                                {shortenAddress(hItem.clientWallet)}
                              </span>
                            </span>
                            {hItem.executedAt && (
                              <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3 text-zinc-500" />
                                Executed: {new Date(hItem.executedAt).toLocaleString()}
                              </span>
                            )}
                            {payoutUsdc && (
                              <span className="text-emerald-400 font-semibold flex items-center gap-0.5">
                                Payout: {payoutUsdc} USDC
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px]">
                            {/* Signatures Threshold Badge */}
                            <Badge
                              variant="outline"
                              className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px] flex items-center gap-1"
                            >
                              <CheckCircle2 className="h-3 w-3" />
                              <span>2/2 Signatures Verified</span>
                            </Badge>

                            {/* Execution Transaction Link */}
                            {hItem.executionTxHash && (
                              <a
                                href={`https://sepolia.etherscan.io/tx/${hItem.executionTxHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-zinc-300 hover:text-white font-mono text-[11px] flex items-center gap-1 bg-white/5 hover:bg-white/10 px-2 py-0.5 rounded border border-white/10 transition-colors"
                              >
                                <span>Tx: {shortenAddress(hItem.executionTxHash)}</span>
                                <ExternalLink className="h-3 w-3 text-zinc-400" />
                              </a>
                            )}
                          </div>
                        </div>

                        <div className="w-full sm:w-auto flex justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleSelectHistoryItem(hItem)}
                            className="h-9 px-4 text-xs font-semibold flex items-center gap-1.5 w-full sm:w-auto border-white/20 bg-[#252525] text-white hover:bg-neutral-800"
                          >
                            <span>View Decision</span>
                            <ArrowRight className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          {/* Pagination Controls */}
          {historyPagination.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-white/10 pt-4">
              <span className="text-xs text-zinc-400">
                Page {historyPagination.page} of {historyPagination.totalPages} (
                {historyPagination.total} total cases)
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}
                  disabled={historyPage <= 1 || loadingHistory}
                  className="h-8 text-xs border-white/10 text-zinc-300 hover:text-white"
                >
                  <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setHistoryPage((p) => Math.min(historyPagination.totalPages, p + 1))
                  }
                  disabled={historyPage >= historyPagination.totalPages || loadingHistory}
                  className="h-8 text-xs border-white/10 text-zinc-300 hover:text-white"
                >
                  Next <ChevronRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
