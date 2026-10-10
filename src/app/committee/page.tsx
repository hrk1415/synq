'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';
import { checkCommitteeSignerStatus, type CommitteeQueueItem, type CommitteeSignerStatus } from '@/lib/deals/v2-committee-signer';
import { CommitteeQueue } from '@/components/committee/CommitteeQueue';
import { CommitteeResolutionWorkspace } from '@/components/committee/CommitteeResolutionWorkspace';
import { Scale, ShieldAlert, Loader2, RefreshCw } from 'lucide-react';

export default function CommitteePortalPage() {
  const { address, isConnected } = useAccount();
  const { getToken } = useAuthSession();

  const [checkingAccess, setCheckingAccess] = useState<boolean>(true);
  const [signerStatus, setSignerStatus] = useState<CommitteeSignerStatus | null>(null);

  const [queueItems, setQueueItems] = useState<CommitteeQueueItem[]>([]);
  const [loadingQueue, setLoadingQueue] = useState<boolean>(false);
  const [queueError, setQueueError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'initial' | 'final'>('initial');
  const [selectedMilestone, setSelectedMilestone] = useState<CommitteeQueueItem | null>(null);

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
    } catch {
      setSignerStatus(null);
    } finally {
      setCheckingAccess(false);
    }
  }, [address]);

  useEffect(() => {
    verifySignerAccess();
  }, [verifySignerAccess]);

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

  useEffect(() => {
    if (signerStatus?.isAnySigner) {
      fetchQueue();
    }
  }, [signerStatus?.isAnySigner, fetchQueue]);

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
        <Card className="border-zinc-800 bg-zinc-950/60 text-center p-6 space-y-3">
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
            Connected wallet ({address.slice(0, 6)}…{address.slice(-4)}) is not an active signer on either the Primary or Emergency Synq Resolution Committee contracts.
          </CardDescription>
        </Card>
      </div>
    );
  }

  return (
    <div className="container max-w-4xl mx-auto py-8 px-4 space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-zinc-800 pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <Scale className="h-5 w-5 text-indigo-400" /> Resolution Committee Portal
            </h1>
            <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px]">
              Active Signer
            </Badge>
          </div>
          <p className="text-xs text-zinc-400">
            Adjudicate disputed milestones and final reconsideration reviews.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={fetchQueue}
            disabled={loadingQueue}
            className="h-8 text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-900 flex items-center gap-1.5"
          >
            <RefreshCw className={`h-3 w-3 ${loadingQueue ? 'animate-spin' : ''}`} />
            Refresh Queue
          </Button>
        </div>
      </div>

      {selectedMilestone ? (
        <CommitteeResolutionWorkspace
          item={selectedMilestone}
          onBack={() => {
            setSelectedMilestone(null);
            fetchQueue();
          }}
          onSettled={() => {
            setSelectedMilestone(null);
            fetchQueue();
          }}
        />
      ) : (
        <div className="space-y-4">
          {/* Tabs */}
          <div className="flex border-b border-zinc-800">
            <button
              type="button"
              onClick={() => setActiveTab('initial')}
              className={`pb-2 px-4 text-xs font-semibold border-b-2 transition-colors ${
                activeTab === 'initial'
                  ? 'border-indigo-500 text-white'
                  : 'border-transparent text-zinc-400 hover:text-zinc-300'
              }`}
            >
              Needs Initial Review
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('final')}
              className={`pb-2 px-4 text-xs font-semibold border-b-2 transition-colors ${
                activeTab === 'final'
                  ? 'border-indigo-500 text-white'
                  : 'border-transparent text-zinc-400 hover:text-zinc-300'
              }`}
            >
              Needs Final Review
            </button>
          </div>

          {queueError && (
            <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-xs text-red-300">
              {queueError}
            </div>
          )}

          <CommitteeQueue
            items={queueItems}
            activeTab={activeTab}
            onSelectMilestone={(item) => setSelectedMilestone(item)}
            isLoading={loadingQueue}
          />
        </div>
      )}
    </div>
  );
}
