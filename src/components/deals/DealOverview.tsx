'use client';

import React, { useState } from 'react';
import {
  FileText,
  Users,
  Shield,
  Clock,
  ArrowRight,
  Lock,
  AlertTriangle,
  Ban,
  Copy,
  Check,
  Sparkles,
  ExternalLink,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { shortenAddress } from '@/lib/utils';
import { DealUXState, MilestoneStructInput } from '@/lib/deals/deriveDealUX';
import { DealCompletionSummary } from '@/components/deals/DealCompletionSummary';

interface DealOverviewProps {
  uxState: DealUXState;
  dealAddress: `0x${string}`;
  title: string;
  description: string;
  statusNum: number;
  statusLabel: string;
  buyerAddress: string;
  sellerAddress: string;
  buyerHandle?: string | null;
  sellerHandle?: string | null;
  formattedTotalValue: string;
  formattedEscrowBalance: string;
  formattedReleasedAmount: string;
  deadlineTimestamp: number;
  riskScore: number | bigint;
  protectionEnabled: boolean;
  tokenInfo: { symbol: string; decimals: number } | null;
  isToken: boolean;
  msList: MilestoneStructInput[];
  isBuyer: boolean;
  isSeller: boolean;
  isActive: boolean;
  isParty: boolean;
  onNavigateSection: (section: 'overview' | 'escrow' | 'milestones' | 'dispute') => void;
  onCancelClick: () => void;
}

export function DealOverview({
  uxState,
  dealAddress,
  title,
  description,
  statusNum,
  statusLabel,
  buyerAddress,
  sellerAddress,
  buyerHandle,
  sellerHandle,
  formattedTotalValue,
  formattedEscrowBalance,
  formattedReleasedAmount,
  deadlineTimestamp,
  riskScore,
  protectionEnabled,
  tokenInfo,
  isToken,
  msList,
  isBuyer,
  isSeller,
  isActive,
  isParty,
  onNavigateSection,
  onCancelClick,
}: DealOverviewProps) {
  const [copiedBuyer, setCopiedBuyer] = useState(false);
  const [copiedSeller, setCopiedSeller] = useState(false);

  const copyAddress = (addr: string, isBuyerAddr: boolean) => {
    void navigator.clipboard.writeText(addr);
    if (isBuyerAddr) {
      setCopiedBuyer(true);
      setTimeout(() => setCopiedBuyer(false), 2000);
    } else {
      setCopiedSeller(true);
      setTimeout(() => setCopiedSeller(false), 2000);
    }
  };

  const symbol = tokenInfo?.symbol ?? 'asset';
  const approvedCount = (msList || []).filter((m) => Number(m.msStatus) === 3).length;
  const progressPct = msList.length > 0 ? Math.round((approvedCount / msList.length) * 100) : 0;

  const currentIdx = uxState.currentMilestoneIndex;
  const currentMs = currentIdx !== null && msList[currentIdx] ? msList[currentIdx] : null;

  const getWorkSnapshotText = () => {
    if (msList.length === 0) return 'No milestones have been defined yet.';
    if (!currentMs) return `${approvedCount} of ${msList.length} milestones approved.`;

    const msStatusNum = Number(currentMs.msStatus ?? 0);
    const msTitle = currentMs.title || `Milestone #${currentIdx! + 1}`;

    if (msStatusNum === 2) return `Milestone #${currentIdx! + 1} (${msTitle}) submitted — awaiting client review.`;
    if (msStatusNum === 1 && currentMs.evidenceHash) return `Milestone #${currentIdx! + 1} (${msTitle}) — revision in progress.`;
    if (msStatusNum === 1) return `Milestone #${currentIdx! + 1} (${msTitle}) — work in progress.`;
    if (msStatusNum === 0) return `Milestone #${currentIdx! + 1} (${msTitle}) — ready to start.`;
    return `${approvedCount} of ${msList.length} milestones approved.`;
  };

  if (statusNum === 2) {
    return (
      <DealCompletionSummary
        dealAddress={dealAddress}
        title={title}
        buyerAddress={buyerAddress}
        sellerAddress={sellerAddress}
        buyerHandle={buyerHandle}
        sellerHandle={sellerHandle}
        formattedTotalValue={formattedTotalValue}
        formattedEscrowBalance={formattedEscrowBalance}
        formattedReleasedAmount={formattedReleasedAmount}
        rawEscrowBalanceWei={BigInt(uxState.rawState?.escrowBalance || 0)}
        tokenSymbol={symbol}
        msList={msList}
        disputeData={uxState.rawState?.dispute}
        isBuyer={isBuyer}
        isSeller={isSeller}
        onNavigateSection={onNavigateSection}
      />
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* Left 2 Columns: Agreement Context & Work Snapshots */}
      <div className="lg:col-span-2 space-y-6">
        {/* Agreement Terms Summary Card */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-bold text-white flex items-center gap-2">
              <FileText size={16} className="text-blue-400" /> Agreement Scope & Terms
            </CardTitle>
            <CardDescription className="text-xs text-zinc-400">
              Contract specifications and agreed parameters.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-4 space-y-2">
              <h3 className="text-sm font-semibold text-white">{title || 'Untitled Deal'}</h3>
              <p className="text-xs text-zinc-400 leading-relaxed">
                {description || 'No detailed description provided.'}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-3 space-y-1">
                <span className="text-[11px] text-zinc-400 font-medium">Agreed Deal Value</span>
                <p className="text-sm font-bold text-white">{formattedTotalValue}</p>
              </div>

              <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-3 space-y-1">
                <span className="text-[11px] text-zinc-400 font-medium">Agreement Deadline</span>
                <p className="text-sm font-bold text-white">
                  {deadlineTimestamp && deadlineTimestamp > 0
                    ? new Date(deadlineTimestamp * 1000).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })
                    : 'No deadline set'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Current Work Snapshot Card */}
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="text-base font-bold text-white flex items-center gap-2">
                <Clock size={16} className="text-blue-400" /> Current Work Snapshot
              </CardTitle>
              <CardDescription className="text-xs text-zinc-400">
                Milestone progress overview.
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="gap-1 text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-800"
              onClick={() => onNavigateSection('milestones')}
            >
              View Milestones <ArrowRight size={13} />
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Progress value={progressPct} />
              <div className="flex justify-between text-xs text-zinc-400 font-medium">
                <span>{progressPct}% Approved</span>
                <span>{approvedCount} of {msList.length} milestones completed</span>
              </div>
            </div>

            <div className="rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-3.5 text-xs text-zinc-300">
              <span className="font-semibold text-white block mb-0.5">Active Work Status:</span>
              <p className="text-zinc-400">{getWorkSnapshotText()}</p>
            </div>
          </CardContent>
        </Card>

        {/* Financial Escrow Snapshot Card */}
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="text-base font-bold text-white flex items-center gap-2">
                <Lock size={16} className="text-emerald-400" /> Payment & Escrow Snapshot
              </CardTitle>
              <CardDescription className="text-xs text-zinc-400">
                Current escrow status and released funds.
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="gap-1 text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-800"
              onClick={() => onNavigateSection('escrow')}
            >
              View Escrow <ArrowRight size={13} />
            </Button>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-3.5 space-y-1">
                <span className="text-xs text-zinc-400 font-medium">Released to Freelancer</span>
                <p className="text-base font-bold text-emerald-400">{formattedReleasedAmount}</p>
              </div>

              <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-3.5 space-y-1">
                <span className="text-xs text-zinc-400 font-medium">Remaining in Escrow</span>
                <p className="text-base font-bold text-blue-400">{formattedEscrowBalance}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Right Column: Participants, Protection & Safety Controls */}
      <div className="space-y-6">
        {/* Participants Identity Card */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-bold text-white flex items-center gap-2">
              <Users size={16} className="text-violet-400" /> Agreement Parties
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-3 space-y-1">
              <div className="flex justify-between items-center text-zinc-400">
                <span className="font-semibold text-zinc-300">Client</span>
                {isBuyer && <Badge variant="secondary" className="text-[10px]">You</Badge>}
              </div>
              {buyerHandle ? (
                <div className="flex items-center justify-between text-xs">
                  <div className="space-y-0.5 min-w-0">
                    <div className="text-sm font-bold text-white truncate">{buyerHandle}</div>
                    <div className="font-mono text-[11px] text-zinc-400">{shortenAddress(buyerAddress)}</div>
                  </div>
                  <button
                    onClick={() => copyAddress(buyerAddress, true)}
                    className="text-zinc-500 hover:text-white transition-colors shrink-0 ml-2"
                  >
                    {copiedBuyer ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between font-mono text-xs text-zinc-200">
                  <span>{shortenAddress(buyerAddress)}</span>
                  <button
                    onClick={() => copyAddress(buyerAddress, true)}
                    className="text-zinc-500 hover:text-white transition-colors"
                  >
                    {copiedBuyer ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                  </button>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-3 space-y-1">
              <div className="flex justify-between items-center text-zinc-400">
                <span className="font-semibold text-zinc-300">Freelancer</span>
                {isSeller && <Badge variant="secondary" className="text-[10px]">You</Badge>}
              </div>
              {sellerHandle ? (
                <div className="flex items-center justify-between text-xs">
                  <div className="space-y-0.5 min-w-0">
                    <div className="text-sm font-bold text-blue-400 truncate">{sellerHandle}</div>
                    <div className="font-mono text-[11px] text-zinc-400">{shortenAddress(sellerAddress)}</div>
                  </div>
                  <button
                    onClick={() => copyAddress(sellerAddress, false)}
                    className="text-zinc-500 hover:text-white transition-colors shrink-0 ml-2"
                  >
                    {copiedSeller ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between font-mono text-xs text-zinc-200">
                  <span>{shortenAddress(sellerAddress)}</span>
                  <button
                    onClick={() => copyAddress(sellerAddress, false)}
                    className="text-zinc-500 hover:text-white transition-colors"
                  >
                    {copiedSeller ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                  </button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Protection & Risk Specification */}
        <Card className="border-zinc-800/80 bg-zinc-900/20">
          <CardHeader className="pb-3">
            <CardTitle className="text-xs font-bold text-white flex items-center gap-2">
              <Shield size={14} className="text-blue-400" /> Deal Risk & Protection
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div className="flex justify-between items-center">
              <span className="text-zinc-400">Protection Status</span>
              <Badge variant={protectionEnabled ? 'info' : 'secondary'} className="text-[10px]">
                {protectionEnabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-zinc-400">Risk Score</span>
              <span className="font-semibold text-white">{String(riskScore || 0)} / 100</span>
            </div>
            <Separator />
            <p className="text-[11px] text-zinc-400 leading-relaxed pt-1">
              On-chain score computed deterministically based on deal value, deadline, and asset type.
            </p>
          </CardContent>
        </Card>

        {/* Safety & Secondary Deal Controls */}
        <Card className="border-zinc-800/80 bg-zinc-900/20">
          <CardHeader className="pb-3">
            <CardTitle className="text-xs font-bold text-zinc-300">Deal Safety & Resolution</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button
              size="sm"
              variant="outline"
              className="w-full justify-start gap-2 text-xs border-zinc-800 text-zinc-300 hover:bg-zinc-800"
              onClick={() => onNavigateSection('dispute')}
            >
              <AlertTriangle size={13} className="text-amber-400" /> Dispute Resolution
            </Button>
            {isActive && isParty && (
              <Button
                size="sm"
                variant="outline"
                className="w-full justify-start gap-2 text-xs border-red-500/30 text-red-400 hover:bg-red-500/10"
                onClick={onCancelClick}
              >
                <Ban size={13} /> Cancel Deal
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
