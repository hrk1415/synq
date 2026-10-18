'use client';

import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { shortenAddress } from '@/lib/utils';
import { formatUsdcAmount } from '@/lib/deals/v2';
import { useAuthSession } from '@/hooks/useAuthSession';
import type { PendingSyncItem } from '@/lib/deals/committee-pending-sync';
import {
  RotateCcw,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  ArrowRight,
  RefreshCw,
  Clock,
  Sparkles,
  X,
} from 'lucide-react';

export interface ReconciledConfirmation {
  authorizationId: string;
  dealAddress: string;
  milestoneId: number;
  phase: string;
  phaseLabel: string;
  resolutionNonce: string;
  freelancerAmount: string;
  clientAmount: string;
  txHash?: string;
  message: string;
  reconciledAt: string;
}

interface CommitteePendingSyncProps {
  items: PendingSyncItem[];
  isLoading: boolean;
  error?: string | null;
  onRefresh: () => void;
  onViewInHistory?: (caseInfo: { dealAddress: string; milestoneId: number; phase: string }) => void;
  connectedWallet?: string | null;
}

export function CommitteePendingSync({
  items,
  isLoading,
  error,
  onRefresh,
  onViewInHistory,
  connectedWallet,
}: CommitteePendingSyncProps) {
  const { getToken } = useAuthSession();

  // Local state for each item's txHash input, status, and messages keyed by authorizationId
  const [txHashInputs, setTxHashInputs] = useState<Record<string, string>>({});
  const [reconcilingIds, setReconcilingIds] = useState<Record<string, boolean>>({});
  const [itemErrors, setItemErrors] = useState<Record<string, string | null>>({});

  // Fix 1 & 3: Preserved client-side success confirmations isolated to active wallet context
  const [reconciledConfirmations, setReconciledConfirmations] = useState<
    Record<string, ReconciledConfirmation>
  >({});

  // Fix 3: Reset all local states when connected wallet changes or disconnects
  useEffect(() => {
    setTxHashInputs({});
    setItemErrors({});
    setReconcilingIds({});
    setReconciledConfirmations({});
  }, [connectedWallet]);

  const handleTxHashChange = (authId: string, val: string) => {
    setTxHashInputs((prev) => ({ ...prev, [authId]: val }));
    setItemErrors((prev) => ({ ...prev, [authId]: null }));
  };

  const handleDismissConfirmation = (authId: string) => {
    setReconciledConfirmations((prev) => {
      const next = { ...prev };
      delete next[authId];
      return next;
    });
  };

  const handleReconcile = async (item: PendingSyncItem) => {
    const actionWallet = connectedWallet?.toLowerCase();
    if (!actionWallet) return;

    const rawTxHash = (txHashInputs[item.authorizationId] || '').trim();
    if (rawTxHash && !/^0x[0-9a-fA-F]{64}$/.test(rawTxHash)) {
      setItemErrors((prev) => ({
        ...prev,
        [item.authorizationId]:
          'Transaction hash must be a 32-byte hex string (0x followed by 64 hex characters).',
      }));
      return;
    }

    setReconcilingIds((prev) => ({ ...prev, [item.authorizationId]: true }));
    setItemErrors((prev) => ({ ...prev, [item.authorizationId]: null }));

    try {
      const token = await getToken();
      const res = await fetch(
        `/api/deals/${item.dealAddress}/milestones/${item.milestoneId}/authorizations/${item.authorizationId}/reconcile`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(rawTxHash ? { txHash: rawTxHash } : {}),
        }
      );

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || `Reconciliation failed with HTTP ${res.status}`);
      }

      // Fix 3: Strict async check ensuring response belongs to the still-active wallet
      if (connectedWallet?.toLowerCase() !== actionWallet) {
        return;
      }

      const isFinal = item.phase === 'FINAL_RESOLUTION';
      const msg = isFinal
        ? 'Final resolution successfully reconciled and confirmed! Milestone is settled.'
        : 'Initial resolution proposal successfully reconciled and confirmed!';

      // Fix 1: Snapshot confirmed item so success feedback and history actions remain accessible
      const confirmation: ReconciledConfirmation = {
        authorizationId: item.authorizationId,
        dealAddress: item.dealAddress,
        milestoneId: item.milestoneId,
        phase: item.phase,
        phaseLabel: item.phaseLabel,
        resolutionNonce: item.resolutionNonce,
        freelancerAmount: item.freelancerAmount,
        clientAmount: item.clientAmount,
        txHash: data.executionTxHash,
        message: msg,
        reconciledAt: new Date().toISOString(),
      };

      setReconciledConfirmations((prev) => ({
        ...prev,
        [item.authorizationId]: confirmation,
      }));

      // Trigger queue & pending sync refresh immediately to update database and active queues
      onRefresh();
    } catch (err: any) {
      if (connectedWallet?.toLowerCase() === actionWallet) {
        setItemErrors((prev) => ({
          ...prev,
          [item.authorizationId]: err?.message || 'Failed to synchronize authorization',
        }));
      }
    } finally {
      if (connectedWallet?.toLowerCase() === actionWallet) {
        setReconcilingIds((prev) => ({ ...prev, [item.authorizationId]: false }));
      }
    }
  };

  // Separate true pending items from locally confirmed items
  const activePendingItems = items.filter(
    (item) => !reconciledConfirmations[item.authorizationId]
  );
  const confirmedList = Object.values(reconciledConfirmations);

  // If not loading, no error, no active pending items, and no confirmed items, render nothing
  if (!isLoading && !error && activePendingItems.length === 0 && confirmedList.length === 0) {
    return null;
  }

  return (
    <Card className="border border-amber-500/40 bg-amber-950/15 shadow-xl">
      <CardHeader className="pb-3 border-b border-amber-500/20">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4 text-amber-400" />
            <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
              Pending Synchronization
              {activePendingItems.length > 0 && (
                <Badge
                  variant="outline"
                  className="border-amber-500/50 bg-amber-500/20 text-amber-300 text-[10px] px-1.5 py-0 font-mono"
                >
                  {activePendingItems.length} {activePendingItems.length === 1 ? 'case' : 'cases'}
                </Badge>
              )}
              {confirmedList.length > 0 && (
                <Badge
                  variant="outline"
                  className="border-emerald-500/50 bg-emerald-500/20 text-emerald-300 text-[10px] px-1.5 py-0 font-mono flex items-center gap-1"
                >
                  <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                  <span>{confirmedList.length} synchronized</span>
                </Badge>
              )}
            </CardTitle>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={onRefresh}
            disabled={isLoading}
            className="h-7 text-xs text-amber-300 hover:text-white hover:bg-amber-900/40 flex items-center gap-1 px-2"
          >
            <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Check State</span>
          </Button>
        </div>
        <CardDescription className="text-xs text-amber-200/80 mt-1">
          These committee resolutions have reached signature threshold and match confirmed on-chain
          milestone states, but need database synchronization to finalize reports and history.
        </CardDescription>
      </CardHeader>

      <CardContent className="pt-4 space-y-4">
        {isLoading && activePendingItems.length === 0 && confirmedList.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-4 text-xs text-amber-300">
            <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
            <span>Scanning for unreconciled committee executions…</span>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-xs text-red-300 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
              <span>{error}</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={onRefresh}
              className="h-6 text-[11px] border-red-500/30 hover:bg-red-900/30 text-red-200"
            >
              Retry
            </Button>
          </div>
        )}

        {/* Fix 1: Preserved confirmed synchronizations section */}
        {confirmedList.map((c) => (
          <div
            key={`confirmed-${c.authorizationId}`}
            className="rounded-lg border border-emerald-500/40 bg-emerald-950/20 p-4 text-xs space-y-3 shadow-md"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-emerald-500/20 pb-2.5">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-white">Deal {shortenAddress(c.dealAddress)}</span>
                  <span className="text-zinc-400">•</span>
                  <span className="text-zinc-300 font-mono">Milestone #{c.milestoneId + 1}</span>
                </div>
                <div className="text-[11px] text-zinc-400 font-mono">
                  Nonce: {c.resolutionNonce} • Auth ID: {c.authorizationId.slice(0, 8)}…
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge
                  variant="outline"
                  className={
                    c.phase === 'FINAL_RESOLUTION'
                      ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300 text-[10px]'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px]'
                  }
                >
                  {c.phaseLabel}
                </Badge>
                <Badge
                  variant="outline"
                  className="border-emerald-500/40 bg-emerald-500/15 text-emerald-300 text-[10px] flex items-center gap-1"
                >
                  <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                  <span>Reconciled & Confirmed</span>
                </Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDismissConfirmation(c.authorizationId)}
                  className="h-6 w-6 p-0 text-zinc-400 hover:text-white hover:bg-emerald-900/40 rounded-full"
                  title="Dismiss confirmation"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 bg-[#121c16] p-2.5 rounded border border-emerald-500/20 font-mono text-[11px]">
              <div>
                <span className="text-zinc-400 block font-sans text-[10px] uppercase">
                  Freelancer Payout
                </span>
                <span className="text-emerald-400 font-semibold">
                  {formatUsdcAmount(c.freelancerAmount)} USDC
                </span>
              </div>
              <div>
                <span className="text-zinc-400 block font-sans text-[10px] uppercase">
                  Client Refund
                </span>
                <span className="text-sky-400 font-semibold">
                  {formatUsdcAmount(c.clientAmount)} USDC
                </span>
              </div>
              <div className="col-span-2 sm:col-span-1">
                <span className="text-zinc-400 block font-sans text-[10px] uppercase">Reconciled At</span>
                <span className="text-zinc-300 flex items-center gap-1">
                  <Clock className="h-3 w-3 text-zinc-500" />
                  {new Date(c.reconciledAt).toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
              </div>
            </div>

            <div className="space-y-2 pt-1">
              <div className="flex items-center gap-2 font-medium text-emerald-300">
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                <span>{c.message}</span>
              </div>

              {c.txHash && (
                <div className="flex items-center justify-between text-[11px] pt-1">
                  <span className="font-mono text-zinc-300">Tx: {shortenAddress(c.txHash)}</span>
                  <a
                    href={`https://sepolia.etherscan.io/tx/${c.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-emerald-400 hover:text-emerald-300 font-mono flex items-center gap-1"
                  >
                    <span>View on Sepolia Etherscan</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1 flex-wrap">
                {onViewInHistory && (
                  <Button
                    size="sm"
                    onClick={() =>
                      onViewInHistory({
                        dealAddress: c.dealAddress,
                        milestoneId: c.milestoneId,
                        phase: c.phase,
                      })
                    }
                    className="h-7 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1.5"
                  >
                    <span>View in Resolution History</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleDismissConfirmation(c.authorizationId)}
                  className="h-7 text-xs border-emerald-500/30 text-emerald-300 hover:text-white hover:bg-emerald-900/30"
                >
                  Dismiss
                </Button>
              </div>
            </div>
          </div>
        ))}

        {/* Outstanding pending authorizations */}
        {activePendingItems.map((item) => {
          const isFinal = item.phase === 'FINAL_RESOLUTION';
          const isReconciling = Boolean(reconcilingIds[item.authorizationId]);
          const itemError = itemErrors[item.authorizationId];
          const txHashValue = txHashInputs[item.authorizationId] ?? '';

          return (
            <div
              key={item.authorizationId}
              className="rounded-lg border border-white/10 bg-[#1e1e1e] p-4 text-xs space-y-3 shadow-md"
            >
              {/* Header row: Deal, Milestone, and Phase Badge */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-white/5 pb-2.5">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-white">
                      Deal {shortenAddress(item.dealAddress)}
                    </span>
                    <span className="text-zinc-400">•</span>
                    <span className="text-zinc-300 font-mono">Milestone #{item.milestoneId + 1}</span>
                  </div>
                  <div className="text-[11px] text-zinc-400 font-mono">
                    Nonce: {item.resolutionNonce} • Auth ID: {item.authorizationId.slice(0, 8)}…
                  </div>
                </div>

                <div className="flex items-center gap-1.5 flex-wrap">
                  <Badge
                    variant="outline"
                    className={
                      isFinal
                        ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300 text-[10px]'
                        : 'border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px]'
                    }
                  >
                    {item.phaseLabel}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="border-white/20 bg-white/5 text-zinc-300 text-[10px]"
                  >
                    Status: {item.authorizationStatus} ({item.signatureCount}/2 sigs)
                  </Badge>
                  <Badge
                    variant="outline"
                    className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px]"
                  >
                    On-chain: {item.onChainMilestoneStatusLabel}
                  </Badge>
                </div>
              </div>

              {/* Resolution Split Details */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 bg-[#181818] p-2.5 rounded border border-white/5 font-mono text-[11px]">
                <div>
                  <span className="text-zinc-400 block font-sans text-[10px] uppercase">
                    Freelancer Payout
                  </span>
                  <span className="text-emerald-400 font-semibold">
                    {formatUsdcAmount(item.freelancerAmount)} USDC
                  </span>
                </div>
                <div>
                  <span className="text-zinc-400 block font-sans text-[10px] uppercase">
                    Client Refund
                  </span>
                  <span className="text-sky-400 font-semibold">
                    {formatUsdcAmount(item.clientAmount)} USDC
                  </span>
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <span className="text-zinc-400 block font-sans text-[10px] uppercase">Created</span>
                  <span className="text-zinc-300 flex items-center gap-1">
                    <Clock className="h-3 w-3 text-zinc-500" />
                    {new Date(item.createdAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              </div>

              {/* Error Message */}
              {itemError && (
                <div className="rounded border border-red-500/40 bg-red-950/30 p-2.5 text-xs text-red-300 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
                  <span>{itemError}</span>
                </div>
              )}

              {/* Recovery Action Input & Button */}
              <div className="pt-1 space-y-2">
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <div className="flex-1">
                    <Input
                      type="text"
                      placeholder="0x... (optional tx hash for exact verification, or leave blank to scan)"
                      value={txHashValue}
                      onChange={(e) => handleTxHashChange(item.authorizationId, e.target.value)}
                      disabled={isReconciling}
                      className="h-8 text-xs bg-[#141414] border-white/15 text-white placeholder:text-zinc-500 font-mono"
                    />
                  </div>
                  <Button
                    size="sm"
                    onClick={() => handleReconcile(item)}
                    disabled={isReconciling}
                    className="h-8 text-xs bg-amber-600 hover:bg-amber-500 text-white font-medium px-4 shrink-0 flex items-center gap-1.5"
                  >
                    {isReconciling ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Synchronizing…</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-3.5 w-3.5" />
                        <span>Recover / Synchronize</span>
                      </>
                    )}
                  </Button>
                </div>
                <p className="text-[10px] text-zinc-400">
                  Synchronizing verifies the on-chain receipt or event log, confirms the report, marks the
                  authorization executed, and records the case in Resolution History.
                </p>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
