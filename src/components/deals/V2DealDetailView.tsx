'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAccount } from 'wagmi';
import {
  ArrowLeft,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Copy,
  Check,
  ExternalLink,
  Clock,
  Layers,
  FileCheck2,
  Info,
  Calendar,
  Scale,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { shortenAddress, cn } from '@/lib/utils';
import { getSepoliaExplorerUrl, sepoliaPublicClient } from '@/lib/chain';
import {
  StandardV2DealData,
  StandardV2OnChainMilestone,
  DealState,
  DEAL_STATE_LABELS,
  MilestoneStatus,
  MILESTONE_STATUS_LABELS,
  readStandardV2DealData,
  determineDealRole,
  getCurrentMilestoneIndex,
} from '@/lib/deals/v2-deal';
import { formatUsdcAmount, ZERO_BYTES32 } from '@/lib/deals/v2';
import { V2DealFunding } from '@/components/deals/V2DealFunding';
import { V2MilestoneLifecycle } from '@/components/deals/V2MilestoneLifecycle';

interface V2DealDetailViewProps {
  dealAddress: `0x${string}`;
}

export function V2DealDetailView({ dealAddress }: V2DealDetailViewProps) {
  const router = useRouter();
  const { address } = useAccount();

  const [dealData, setDealData] = useState<StandardV2DealData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const loadDealData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await readStandardV2DealData(dealAddress, sepoliaPublicClient);
      setDealData(data);
    } catch (err: any) {
      console.error('[V2DealDetailView] Load error:', err);
      setError(err?.message || 'Unable to load current Deal state from chain');
    } finally {
      setLoading(false);
    }
  }, [dealAddress]);

  useEffect(() => {
    loadDealData();
  }, [loadDealData]);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const formatWindowDuration = (seconds: bigint): string => {
    const s = Number(seconds);
    if (s >= 86400) {
      const days = Math.floor(s / 86400);
      const remainingHours = Math.floor((s % 86400) / 3600);
      return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days} day${days > 1 ? 's' : ''}`;
    }
    const hours = Math.floor(s / 3600);
    return `${hours} hour${hours > 1 ? 's' : ''}`;
  };

  const formatTimestamp = (timestamp: bigint): string => {
    if (timestamp === 0n) return '—';
    const date = new Date(Number(timestamp) * 1000);
    return date.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center space-y-4">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        <p className="text-sm text-zinc-400">Loading Standard V2 Deal from Sepolia…</p>
      </div>
    );
  }

  if (error || !dealData) {
    return (
      <div className="max-w-4xl mx-auto py-12 space-y-4">
        <Card className="border-red-500/30 bg-red-950/20 backdrop-blur-md">
          <CardContent className="pt-6 space-y-4 text-center">
            <AlertTriangle className="h-10 w-10 text-red-400 mx-auto" />
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-white">Unable to Load Deal State</h2>
              <p className="text-xs text-red-200">{error || 'An unexpected error occurred while reading on-chain state.'}</p>
            </div>
            <div className="flex items-center justify-center gap-3 pt-2">
              <Button size="sm" variant="outline" onClick={() => router.push('/deals')}>
                Back to Deals
              </Button>
              <Button size="sm" className="bg-red-600 hover:bg-red-500 text-white" onClick={loadDealData}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry Read
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const role = determineDealRole(address, dealData.client, dealData.freelancer);
  const isDraft = dealData.state === DealState.Draft;
  const isActive = dealData.state === DealState.Active;
  const stateLabel = DEAL_STATE_LABELS[dealData.state] ?? `State (${dealData.state})`;

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-12">
      {/* Top Navigation */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => router.push('/deals')}
          className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Deals
        </button>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="border-blue-500/30 bg-blue-500/10 text-xs text-blue-400">
            Standard V2 Deal
          </Badge>
          {role === 'client' && (
            <Badge className="bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 text-xs">
              You are Client
            </Badge>
          )}
          {role === 'freelancer' && (
            <Badge className="bg-purple-600/20 text-purple-400 border border-purple-500/30 text-xs">
              You are Freelancer
            </Badge>
          )}
        </div>
      </div>

      {/* Main Deal Header Card */}
      <Card className="border-zinc-800 bg-zinc-900/60 backdrop-blur-md">
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <CardTitle className="text-xl font-bold text-white">Synq Deal V1 Instance</CardTitle>
                {isDraft ? (
                  <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-xs text-amber-400">
                    Awaiting Client Funding
                  </Badge>
                ) : isActive ? (
                  <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-xs text-emerald-400">
                    Active & Funded
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-zinc-700 text-xs text-zinc-300">
                    {stateLabel}
                  </Badge>
                )}
              </div>
              <CardDescription className="text-xs text-zinc-400 font-mono flex items-center gap-2">
                <span>{dealData.dealAddress}</span>
                <button
                  type="button"
                  onClick={() => copyToClipboard(dealData.dealAddress, 'dealAddress')}
                  className="hover:text-white"
                >
                  {copiedKey === 'dealAddress' ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                </button>
                <a
                  href={getSepoliaExplorerUrl('address', dealData.dealAddress)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-400 hover:underline"
                >
                  <ExternalLink className="h-3 w-3 inline ml-1" />
                </a>
              </CardDescription>
            </div>

            {/* Quick Metrics */}
            <div className="flex items-center gap-6">
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Total Escrow</div>
                <div className="text-lg font-bold text-white">{formatUsdcAmount(dealData.totalEscrow)} USDC</div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Milestones</div>
                <div className="text-lg font-bold text-white">{dealData.milestoneCount}</div>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Parties Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Client</span>
                {role === 'client' && <span className="text-[10px] text-emerald-400 font-semibold">(You)</span>}
              </div>
              <div className="flex items-center justify-between font-mono text-xs text-white">
                <span>{dealData.client}</span>
                <button
                  type="button"
                  onClick={() => copyToClipboard(dealData.client, 'client')}
                  className="text-zinc-400 hover:text-white"
                >
                  {copiedKey === 'client' ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Freelancer</span>
                {role === 'freelancer' && <span className="text-[10px] text-purple-400 font-semibold">(You)</span>}
              </div>
              <div className="flex items-center justify-between font-mono text-xs text-white">
                <span>{dealData.freelancer}</span>
                <button
                  type="button"
                  onClick={() => copyToClipboard(dealData.freelancer, 'freelancer')}
                  className="text-zinc-400 hover:text-white"
                >
                  {copiedKey === 'freelancer' ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                </button>
              </div>
            </div>
          </div>

          {/* Asset & Protection Details */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-2.5 space-y-0.5">
              <span className="text-[10px] uppercase tracking-wider text-zinc-400">Canonical Asset</span>
              <div className="font-semibold text-white">Sepolia USDC (6 decimals)</div>
              <div className="text-[10px] font-mono text-zinc-500">{shortenAddress(dealData.usdc)}</div>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-2.5 space-y-0.5">
              <span className="text-[10px] uppercase tracking-wider text-zinc-400">Protection Status</span>
              <div className="font-semibold text-zinc-300">
                {dealData.isProtected ? (
                  <span className="text-emerald-400">Active Protection</span>
                ) : (
                  'Not enabled / Standard Deal'
                )}
              </div>
              <div className="text-[10px] text-zinc-500">Protection module disabled in V2 Standard</div>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-2.5 space-y-0.5">
              <span className="text-[10px] uppercase tracking-wider text-zinc-400">Primary Resolver</span>
              <div className="font-semibold text-white">{shortenAddress(dealData.primaryResolver)}</div>
              <div className="text-[10px] text-zinc-500">Decentralized Resolution Committee</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Escrow Funding Section */}
      <V2DealFunding dealData={dealData} refetchDealData={loadDealData} />

      {/* Milestone Lifecycle Section */}
      <V2MilestoneLifecycle dealData={dealData} refetchDealData={loadDealData} />

      {/* On-Chain Milestones Section */}
      <Card className="border-zinc-800 bg-zinc-900/60 backdrop-blur-md">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base text-white flex items-center gap-2">
                <Layers className="h-4 w-4 text-blue-400" /> On-Chain Milestones ({dealData.milestones.length})
              </CardTitle>
              <CardDescription className="text-xs text-zinc-400">
                Milestones are initialized at clone deployment and read directly from contract storage.
              </CardDescription>
            </div>
            <Badge variant="outline" className="border-zinc-700 text-xs text-zinc-300">
              Immutable Schedule
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {dealData.milestones.map((m: StandardV2OnChainMilestone) => {
            const statusLabel = MILESTONE_STATUS_LABELS[m.status] ?? `Status (${m.status})`;
            const currentIdx = getCurrentMilestoneIndex(dealData.milestones);
            const isCurrent = dealData.state === DealState.Active && currentIdx === m.index;

            return (
              <div
                key={m.index}
                className={cn(
                  'rounded-xl border p-4 space-y-3 transition-colors',
                  isCurrent
                    ? 'border-purple-500/40 bg-purple-950/10'
                    : 'border-zinc-800 bg-zinc-950/50'
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white">Milestone {m.index + 1}</span>
                    {isCurrent && (
                      <Badge variant="outline" className="border-purple-500/40 bg-purple-500/10 text-[10px] text-purple-300">
                        Current
                      </Badge>
                    )}
                    {m.status === MilestoneStatus.SettledPaid ? (
                      <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-400">
                        Settled & Paid
                      </Badge>
                    ) : m.status === MilestoneStatus.RevisionRequested ? (
                      <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-400">
                        Changes Requested
                      </Badge>
                    ) : m.status === MilestoneStatus.Disputed ? (
                      <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 text-[10px] text-rose-400">
                        Dispute Open
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-300">
                        {statusLabel}
                      </Badge>
                    )}
                    {m.version > 0 && (
                      <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400">
                        v{m.version}
                      </Badge>
                    )}
                  </div>
                  <div className="text-sm font-bold text-white">
                    {formatUsdcAmount(m.amount)} USDC
                  </div>
                </div>

                {/* Status Banners */}
                {m.status === MilestoneStatus.SettledPaid && (
                  <div className="rounded-md border border-emerald-500/30 bg-emerald-950/20 p-2.5 text-xs text-emerald-300 flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                      <span>Approved • Payment Released • {formatUsdcAmount(m.amount)} USDC settled to freelancer</span>
                    </span>
                    <Badge variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-300">
                      Settlement Final
                    </Badge>
                  </div>
                )}

                {m.status === MilestoneStatus.RevisionRequested && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-950/20 p-2.5 text-xs text-amber-300 flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                      <span>Changes Requested • Freelancer response pending (48h protocol window)</span>
                    </span>
                    <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-300">
                      Revision In Review
                    </Badge>
                  </div>
                )}

                {m.status === MilestoneStatus.Disputed && (
                  <div className="rounded-md border border-rose-500/30 bg-rose-950/20 p-2.5 text-xs text-rose-300 flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />
                      <span>Dispute Open • Milestone is in dispute. Escrow remains held pending resolution.</span>
                    </span>
                    <Badge variant="outline" className="border-rose-500/40 text-[10px] text-rose-300">
                      Dispute Pending
                    </Badge>
                  </div>
                )}

                {/* Milestone Parameters Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                  <div className="rounded-md border border-zinc-800/80 bg-zinc-900/50 p-2 space-y-0.5">
                    <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-400">
                      <Calendar className="h-3 w-3" /> Work Deadline
                    </div>
                    <div className="font-semibold text-zinc-200">{formatTimestamp(m.workDeadline)}</div>
                  </div>

                  <div className="rounded-md border border-zinc-800/80 bg-zinc-900/50 p-2 space-y-0.5">
                    <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-400">
                      <Clock className="h-3 w-3" /> Review Window
                    </div>
                    <div className="font-semibold text-zinc-200">{formatWindowDuration(m.reviewWindow)}</div>
                  </div>

                  <div className="rounded-md border border-zinc-800/80 bg-zinc-900/50 p-2 space-y-0.5">
                    <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-400">
                      <Clock className="h-3 w-3" /> Grace Period
                    </div>
                    <div className="font-semibold text-zinc-200">{formatWindowDuration(m.gracePeriod)}</div>
                  </div>
                </div>

                {/* Spec Hash */}
                <div className="rounded-md border border-zinc-800/60 bg-zinc-900/30 p-2 flex items-center justify-between text-[11px]">
                  <span className="text-zinc-400 flex items-center gap-1.5">
                    <FileCheck2 className="h-3.5 w-3.5 text-zinc-500" /> Spec Hash:
                    <span className="font-mono text-zinc-300">{m.specHash}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(m.specHash, `spec_${m.index}`)}
                    className="text-zinc-400 hover:text-white"
                  >
                    {copiedKey === `spec_${m.index}` ? (
                      <Check className="h-3 w-3 text-emerald-400" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                </div>

                {/* Evidence Hash */}
                {m.evidenceRootHash && m.evidenceRootHash !== ZERO_BYTES32 && (
                  <div className="rounded-md border border-purple-900/40 bg-purple-950/20 p-2 flex items-center justify-between text-[11px]">
                    <span className="text-zinc-400 flex items-center gap-1.5 overflow-hidden">
                      <FileCheck2 className="h-3.5 w-3.5 text-purple-400 shrink-0" />
                      <span className="shrink-0 text-purple-300">Evidence Hash:</span>
                      <span className="font-mono text-zinc-200 truncate">{m.evidenceRootHash}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(m.evidenceRootHash, `ev_${m.index}`)}
                      className="text-zinc-400 hover:text-white shrink-0 ml-2"
                      title="Copy Evidence Hash"
                    >
                      {copiedKey === `ev_${m.index}` ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                )}

                {/* Submission and Review Timestamps */}
                {m.submittedAt > 0n && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    <div className="rounded-md border border-zinc-800/80 bg-zinc-900/40 p-2 space-y-0.5">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Submitted At</div>
                      <div className="font-semibold text-zinc-200">{formatTimestamp(m.submittedAt)}</div>
                    </div>
                    <div className="rounded-md border border-zinc-800/80 bg-zinc-900/40 p-2 space-y-0.5">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Review Window Ends</div>
                      <div className="font-semibold text-zinc-200">{formatTimestamp(m.submittedAt + m.reviewWindow)}</div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
