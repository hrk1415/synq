'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Press_Start_2P } from 'next/font/google';

const pressStart2P = Press_Start_2P({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});
import { useAccount } from 'wagmi';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';
import { checkCommitteeSignerStatus, type CommitteeQueueItem, type CommitteeSignerStatus } from '@/lib/deals/v2-committee-signer';
import { CommitteeQueue, type CommitteeQueueFilter } from '@/components/committee/CommitteeQueue';
import { CommitteeResolutionWorkspace } from '@/components/committee/CommitteeResolutionWorkspace';
import { CommitteeHistory, type HighlightedCaseTarget } from '@/components/committee/CommitteeHistory';
import { CommitteePendingSync } from '@/components/committee/CommitteePendingSync';
import type { PendingSyncItem } from '@/lib/deals/committee-pending-sync';
import {
  ProtectionClaimQueue,
  type ProtectionQueueItem,
} from '@/components/committee/ProtectionClaimQueue';
import { ProtectionClaimWorkspace } from '@/components/committee/ProtectionClaimWorkspace';
import { Scale, ShieldAlert, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';

export default function CommitteePortalPage() {
  const { address, isConnected } = useAccount();
  const { getToken } = useAuthSession();

  const [checkingAccess, setCheckingAccess] = useState<boolean>(true);
  const [signerStatus, setSignerStatus] = useState<CommitteeSignerStatus | null>(null);

  const [queueItems, setQueueItems] = useState<CommitteeQueueItem[]>([]);
  const [loadingQueue, setLoadingQueue] = useState<boolean>(false);
  const [queueError, setQueueError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'initial' | 'final' | 'history' | 'protection'>('initial');
  const [selectedMilestone, setSelectedMilestone] = useState<CommitteeQueueItem | null>(null);

  // Protection Claims State
  const [protectionQueueItems, setProtectionQueueItems] = useState<ProtectionQueueItem[]>([]);
  const [loadingProtectionQueue, setLoadingProtectionQueue] = useState<boolean>(false);
  const [protectionQueueError, setProtectionQueueError] = useState<string | null>(null);
  const [selectedProtectionClaim, setSelectedProtectionClaim] = useState<ProtectionQueueItem | null>(null);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [quickFilter, setQuickFilter] = useState<CommitteeQueueFilter>('all');
  const [highlightedCase, setHighlightedCase] = useState<HighlightedCaseTarget | null>(null);

  const [pendingSyncItems, setPendingSyncItems] = useState<PendingSyncItem[]>([]);
  const [loadingPendingSync, setLoadingPendingSync] = useState<boolean>(false);
  const [pendingSyncError, setPendingSyncError] = useState<string | null>(null);

  // Active wallet reference and request-generation counter for strict async isolation
  const activeWalletRef = useRef<string | null>(null);
  const pendingSyncReqGenRef = useRef<number>(0);

  // 1. Verify Signer Access
  const verifySignerAccess = useCallback(async () => {
    if (!address) {
      setSignerStatus(null);
      setCheckingAccess(false);
      return;
    }
    setCheckingAccess(true);
    try {
      const status = await checkCommitteeSignerStatus(address);
      setSignerStatus(status);
      if (status.isProtectionSigner && !status.isPrimarySigner && !status.isEmergencySigner) {
        setActiveTab('protection');
      }
    } catch {
      setSignerStatus(null);
    } finally {
      setCheckingAccess(false);
    }
  }, [address]);

  useEffect(() => {
    verifySignerAccess();
  }, [verifySignerAccess]);

  // Reset search, filters, and pending navigation when connected wallet address changes
  useEffect(() => {
    activeWalletRef.current = address ? address.toLowerCase() : null;
    pendingSyncReqGenRef.current += 1;
    setSearchQuery('');
    setQuickFilter('all');
    setHighlightedCase(null);
    setPendingSyncItems([]);
    setPendingSyncError(null);
    setLoadingPendingSync(false);
  }, [address]);

  // 2. Fetch Queue
  const fetchQueue = useCallback(async () => {
    if (!signerStatus?.isAnySigner) return;
    setLoadingQueue(true);
    setQueueError(null);
    try {
      const token = await getToken();
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch('/api/committee/queue', { headers });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      setQueueItems(data.items || []);
    } catch (err: any) {
      setQueueError(err?.message || 'Failed to fetch committee queue');
    } finally {
      setLoadingQueue(false);
    }
  }, [signerStatus?.isAnySigner, getToken]);

  // 3. Fetch Pending Synchronization Authorizations with strict generation & active wallet guards
  const fetchPendingSync = useCallback(async () => {
    if (!signerStatus?.isAnySigner || !address) {
      setPendingSyncItems([]);
      setLoadingPendingSync(false);
      return;
    }
    const reqGen = ++pendingSyncReqGenRef.current;
    const targetWallet = address.toLowerCase();

    setLoadingPendingSync(true);
    setPendingSyncError(null);
    try {
      const token = await getToken();
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch('/api/committee/pending-sync', { headers });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      // Ensure async response strictly matches the active wallet address and request generation
      if (reqGen === pendingSyncReqGenRef.current && activeWalletRef.current === targetWallet) {
        setPendingSyncItems(data.items || []);
      }
    } catch (err: any) {
      if (reqGen === pendingSyncReqGenRef.current && activeWalletRef.current === targetWallet) {
        setPendingSyncError(err?.message || 'Failed to check pending synchronizations');
      }
    } finally {
      if (reqGen === pendingSyncReqGenRef.current && activeWalletRef.current === targetWallet) {
        setLoadingPendingSync(false);
      }
    }
  }, [signerStatus?.isAnySigner, address, getToken]);

  // 4. Fetch Protection Claims Queue
  const fetchProtectionQueue = useCallback(async () => {
    if (!signerStatus?.isProtectionSigner) return;
    setLoadingProtectionQueue(true);
    setProtectionQueueError(null);
    try {
      const token = await getToken();
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch('/api/committee/protection/queue', { headers });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      setProtectionQueueItems(data.items || []);
    } catch (err: any) {
      setProtectionQueueError(err?.message || 'Failed to fetch protection claims queue');
    } finally {
      setLoadingProtectionQueue(false);
    }
  }, [signerStatus?.isProtectionSigner, getToken]);

  const refreshAll = useCallback(async () => {
    const promises: Promise<any>[] = [];
    if (signerStatus?.isPrimarySigner || signerStatus?.isEmergencySigner) {
      promises.push(fetchQueue(), fetchPendingSync());
    }
    if (signerStatus?.isProtectionSigner) {
      promises.push(fetchProtectionQueue());
    }
    await Promise.all(promises);
  }, [fetchQueue, fetchPendingSync, fetchProtectionQueue, signerStatus?.isPrimarySigner, signerStatus?.isEmergencySigner, signerStatus?.isProtectionSigner]);

  useEffect(() => {
    if (signerStatus?.isAnySigner) {
      refreshAll();
    }
  }, [signerStatus?.isAnySigner, refreshAll]);

  if (checkingAccess) {
    return (
      <div className="container max-w-4xl mx-auto py-16 px-4 text-center space-y-3">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-zinc-500" />
        <p className="text-xs text-zinc-400">Verifying on-chain committee membership…</p>
      </div>
    );
  }

  if (!isConnected || !address) {
    return (
      <div className="container max-w-md mx-auto py-16 px-4">
        <Card className="border border-white/75 bg-[#1B1B1B] text-center p-6 space-y-3 shadow-xl">
          <Scale className="mx-auto h-8 w-8 text-zinc-500" />
          <CardTitle className="text-base font-bold text-white">Committee Portal</CardTitle>
          <CardDescription className="text-xs text-zinc-400">
            Connect an authorized committee signer wallet to access resolution cases and voting.
          </CardDescription>
        </Card>
      </div>
    );
  }

  if (!signerStatus?.isAnySigner) {
    return (
      <div className="container max-w-md mx-auto py-16 px-4">
        <Card className="border-red-500/30 bg-red-950/10 text-center p-6 space-y-3">
          <ShieldAlert className="mx-auto h-8 w-8 text-red-400" />
          <CardTitle className="text-base font-bold text-white">Access Restricted</CardTitle>
          <CardDescription className="text-xs text-zinc-400">
            Connected wallet ({address.slice(0, 6)}…{address.slice(-4)}) is not an active signer on the Synq Resolution or Protection Committee contracts.
          </CardDescription>
        </Card>
      </div>
    );
  }

  return (
    <div className="container max-w-4xl mx-auto py-8 px-4 space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-white/10 pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className={`${pressStart2P.className} text-base md:text-lg font-normal text-white flex items-center gap-2.5 tracking-tight`}>
              <Scale className="h-5 w-5 text-white" /> Committee Portal
            </h1>
            <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px]">
              {signerStatus?.isProtectionSigner && (signerStatus.isPrimarySigner || signerStatus.isEmergencySigner)
                ? 'Resolution & Protection Signer'
                : signerStatus?.isProtectionSigner
                  ? 'Protection Signer'
                  : 'Resolution Signer'}
            </Badge>
          </div>
          <p className="text-xs text-zinc-400">
            Adjudicate disputed milestones, reconsideration reviews, and premium protection claims.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={refreshAll}
            disabled={loadingQueue || loadingPendingSync || loadingProtectionQueue}
            className="h-8 text-xs border border-white/20 bg-[#252525] text-white hover:bg-neutral-800 flex items-center gap-1.5"
          >
            <RefreshCw className={`h-3 w-3 ${loadingQueue || loadingPendingSync || loadingProtectionQueue ? 'animate-spin' : ''}`} />
            Refresh Queue
          </Button>
        </div>
      </div>

      {selectedMilestone ? (
        <CommitteeResolutionWorkspace
          item={selectedMilestone}
          onBack={() => {
            setSelectedMilestone(null);
            refreshAll();
          }}
          onSettled={() => {
            setSelectedMilestone(null);
            refreshAll();
          }}
          onViewInHistory={(caseInfo) => {
            setHighlightedCase(caseInfo);
            setActiveTab('history');
            setSelectedMilestone(null);
            refreshAll();
          }}
        />
      ) : selectedProtectionClaim ? (
        <ProtectionClaimWorkspace
          dealAddress={selectedProtectionClaim.claim.dealAddress}
          milestoneId={selectedProtectionClaim.claim.milestoneId}
          onBack={() => {
            setSelectedProtectionClaim(null);
            refreshAll();
          }}
          onDecisionExecuted={() => {
            setSelectedProtectionClaim(null);
            refreshAll();
          }}
        />
      ) : (
        <div className="space-y-4">
          {(signerStatus?.isPrimarySigner || signerStatus?.isEmergencySigner) && activeTab !== 'protection' && (
            <CommitteePendingSync
              connectedWallet={address}
              items={pendingSyncItems}
              isLoading={loadingPendingSync}
              error={pendingSyncError}
              onRefresh={refreshAll}
              onViewInHistory={(caseInfo) => {
                setHighlightedCase(caseInfo);
                setActiveTab('history');
                setSelectedMilestone(null);
                refreshAll();
              }}
            />
          )}

          {/* Tabs */}
          <div className="flex border-b border-white/10 overflow-x-auto">
            {(signerStatus?.isPrimarySigner || signerStatus?.isEmergencySigner) && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('initial');
                    setHighlightedCase(null);
                  }}
                  className={`pb-2 px-4 text-xs font-semibold border-b-2 transition-colors flex items-center gap-2 shrink-0 ${
                    activeTab === 'initial'
                      ? 'border-white text-white'
                      : 'border-transparent text-[#A3A3A3] hover:text-white'
                  }`}
                >
                  <span>Needs Initial Review</span>
                  <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full ${activeTab === 'initial' ? 'bg-white/20 text-white' : 'bg-white/5 text-zinc-400'}`}>
                    {queueItems.filter((item) => item.phase === 'INITIAL_RESOLUTION').length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('final');
                    setHighlightedCase(null);
                  }}
                  className={`pb-2 px-4 text-xs font-semibold border-b-2 transition-colors flex items-center gap-2 shrink-0 ${
                    activeTab === 'final'
                      ? 'border-white text-white'
                      : 'border-transparent text-[#A3A3A3] hover:text-white'
                  }`}
                >
                  <span>Needs Final Review</span>
                  <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full ${activeTab === 'final' ? 'bg-white/20 text-white' : 'bg-white/5 text-zinc-400'}`}>
                    {queueItems.filter((item) => item.phase === 'FINAL_RESOLUTION').length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('history');
                    setHighlightedCase(null);
                  }}
                  className={`pb-2 px-4 text-xs font-semibold border-b-2 transition-colors flex items-center gap-2 shrink-0 ${
                    activeTab === 'history'
                      ? 'border-white text-white'
                      : 'border-transparent text-[#A3A3A3] hover:text-white'
                  }`}
                >
                  <span>Resolution History</span>
                </button>
              </>
            )}

            {signerStatus?.isProtectionSigner && (
              <button
                type="button"
                onClick={() => {
                  setActiveTab('protection');
                  setHighlightedCase(null);
                }}
                className={`pb-2 px-4 text-xs font-semibold border-b-2 transition-colors flex items-center gap-2 shrink-0 ${
                  activeTab === 'protection'
                    ? 'border-emerald-400 text-emerald-400'
                    : 'border-transparent text-[#A3A3A3] hover:text-white'
                }`}
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>Protection Claims</span>
                <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full ${activeTab === 'protection' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/5 text-zinc-400'}`}>
                  {protectionQueueItems.length}
                </span>
              </button>
            )}
          </div>

          {activeTab === 'protection' ? (
            <ProtectionClaimQueue
              items={protectionQueueItems}
              isLoading={loadingProtectionQueue}
              error={protectionQueueError}
              onRefresh={fetchProtectionQueue}
              onSelectClaim={(item) => setSelectedProtectionClaim(item)}
            />
          ) : activeTab === 'history' ? (
            <CommitteeHistory
              onRefresh={fetchQueue}
              highlightedCase={highlightedCase}
              onClearHighlight={() => setHighlightedCase(null)}
            />
          ) : (
            <>
              {queueError && (
                <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-xs text-red-300">
                  {queueError}
                </div>
              )}

              <CommitteeQueue
                items={queueItems}
                activeTab={activeTab}
                onSelectMilestone={(item) => {
                  setSelectedMilestone(item);
                  setHighlightedCase(null);
                }}
                isLoading={loadingQueue}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                quickFilter={quickFilter}
                onFilterChange={setQuickFilter}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
