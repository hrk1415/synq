'use client';

import React from 'react';
import {
  ShieldCheck,
  Lock,
  Clock,
  Wallet,
  KeyRound,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Copy,
  ExternalLink,
  Ban,
  ArrowRight,
  Info,
  DollarSign,
  Plus,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { cn, shortenAddress } from '@/lib/utils';
import { DealUXState, MilestoneStructInput } from '@/lib/deals/deriveDealUX';

interface DealEscrowPanelProps {
  uxState: DealUXState;
  dealAddress: `0x${string}`;
  statusNum: number;
  statusLabel: string;
  isBuyer: boolean;
  isSeller: boolean;
  isActive: boolean;
  tokenInfo: { symbol: string; decimals: number } | null;
  isToken: boolean;
  assetAddress: string;
  formattedTotalValue: string;
  formattedEscrowBalance: string;
  formattedReleasedAmount: string;
  milestones: MilestoneStructInput[];
  networkReady: boolean;
  isSwitching: boolean;
  isPendingTx: boolean;
  isTokenApprovePending: boolean;
  isApproveSuccess: boolean;
  actionError: string;
  onApproveToken: () => void;
  onFundEscrow: () => void;
  onCancelClick: () => void;
  onNavigateSection: (section: 'overview' | 'escrow' | 'milestones' | 'dispute') => void;
}

export function DealEscrowPanel({
  uxState,
  dealAddress,
  statusNum,
  statusLabel,
  isBuyer,
  isSeller,
  isActive,
  tokenInfo,
  isToken,
  assetAddress,
  formattedTotalValue,
  formattedEscrowBalance,
  formattedReleasedAmount,
  milestones,
  networkReady,
  isSwitching,
  isPendingTx,
  isTokenApprovePending,
  isApproveSuccess,
  actionError,
  onApproveToken,
  onFundEscrow,
  onCancelClick,
  onNavigateSection,
}: DealEscrowPanelProps) {
  const { financial, role, phase, anomalies } = uxState;
  const { totalValue, escrowBalance, releasedAmount, hasEverBeenFullyAccounted, state: financialState } = financial;

  // Percentage of total value released to seller
  const releasedPct = totalValue > 0n
    ? Math.min(100, Math.round(Number((releasedAmount * 100n) / totalValue)))
    : 0;

  const symbol = tokenInfo?.symbol ?? 'asset';
  const approvedMilestones = (milestones || []).filter((m) => Number(m.msStatus) === 3);

  // Funding status badge metadata
  const getFundingStatusBadge = () => {
    switch (financialState) {
      case 'UNFUNDED':
        return <Badge variant="warning" className="gap-1 text-xs"><AlertTriangle size={12} /> Funding Required</Badge>;
      case 'FULLY_FUNDED':
        return <Badge variant="success" className="gap-1 text-xs"><ShieldCheck size={12} /> Escrow Funded</Badge>;
      case 'PARTIALLY_RELEASED':
        return <Badge variant="info" className="gap-1 text-xs"><DollarSign size={12} /> Payments In Progress</Badge>;
      case 'FULLY_RELEASED':
        return <Badge variant="success" className="gap-1 text-xs"><CheckCircle2 size={12} /> Fully Released</Badge>;
      case 'REFUNDED_OR_CANCELLED':
        return <Badge variant="secondary" className="gap-1 text-xs text-red-400 border-red-500/20 bg-red-500/10"><Ban size={12} /> Deal Cancelled</Badge>;
      case 'DISPUTE_FROZEN':
        return <Badge variant="destructive" className="gap-1 text-xs"><Lock size={12} /> Escrow Frozen by Dispute</Badge>;
      default:
        return <Badge variant="secondary" className="text-xs">Unknown</Badge>;
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* Primary Financial Overview & Controls */}
      <Card className="lg:col-span-2">
        <CardHeader className="pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-lg font-bold text-white flex items-center gap-2">
                <Lock size={18} className="text-blue-400" /> Escrow & Financial Settlement
              </CardTitle>
              <CardDescription className="text-xs text-zinc-400 mt-0.5">
                Funds are held securely by the deal contract and released as milestones are approved.
              </CardDescription>
            </div>
            {getFundingStatusBadge()}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Primary Financial Metrics Cards */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4 space-y-1">
              <span className="text-xs text-zinc-400 font-medium">Total Deal Value</span>
              <p className="text-lg font-bold text-white truncate">{formattedTotalValue}</p>
              <span className="text-[10px] text-zinc-400">Agreed contract budget</span>
            </div>

            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4 space-y-1">
              <span className="text-xs text-zinc-400 font-medium">Released to Freelancer</span>
              <p className="text-lg font-bold text-emerald-400 truncate">{formattedReleasedAmount}</p>
              <span className="text-[10px] text-zinc-400">{releasedPct}% of deal value</span>
            </div>

            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4 space-y-1">
              <span className="text-xs text-zinc-400 font-medium">Remaining in Escrow</span>
              <p className="text-lg font-bold text-blue-400 truncate">{formattedEscrowBalance}</p>
              <span className="text-[10px] text-zinc-400">Funds locked in contract</span>
            </div>
          </div>

          {/* Restrained Payment Progress Bar */}
          <div className="space-y-2 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-4">
            <div className="flex items-center justify-between text-xs text-zinc-400 font-medium">
              <span>Payout Settlement Progress</span>
              <span className="text-zinc-200 font-semibold">{releasedPct}% Released</span>
            </div>
            <Progress value={releasedPct} />
            <div className="flex items-center justify-between text-[11px] text-zinc-400 pt-0.5">
              <span>0 {symbol}</span>
              <span>{formattedTotalValue}</span>
            </div>
          </div>

          {/* Asset & Token Specification */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-4">
            <div>
              <p className="text-xs font-semibold text-white">Escrow Payment Asset</p>
              <p className="text-xs text-zinc-400 mt-0.5">
                {tokenInfo?.symbol ?? 'Asset'}{isToken ? ' · ERC-20 Smart Token' : ' · Native Sepolia ETH'}
              </p>
            </div>
            <Badge variant={isToken ? 'info' : 'secondary'} className="font-mono text-xs">
              {symbol}
            </Badge>
          </div>

          {/* Anomaly Alerts if present */}
          {anomalies && anomalies.length > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-3.5 space-y-2">
              <span className="text-xs font-semibold text-amber-300 flex items-center gap-1.5">
                <AlertTriangle size={14} /> Attention Items
              </span>
              {anomalies.map((a, i) => (
                <p key={i} className="text-xs text-zinc-300 pl-5">
                  • {a.message}
                </p>
              ))}
            </div>
          )}

          {/* CONTEXTUAL ROLE & FUNDING FLOW AREA */}

          {/* BUYER UNFUNDED FLOW */}
          {isActive && isBuyer && !hasEverBeenFullyAccounted && (
            <div className="space-y-3 rounded-xl border border-blue-500/30 bg-blue-950/25 p-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                    <Wallet size={14} className="text-blue-400" /> Deposit Escrow Funds
                  </h4>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Deposit the agreed deal value into escrow before work begins.
                  </p>
                </div>
                <Badge variant="outline" className="text-xs text-blue-300 border-blue-500/30">
                  Required: {formattedTotalValue}
                </Badge>
              </div>

              {/* Two-step UX for ERC-20 tokens */}
              {isToken && (
                <div className="space-y-2 pt-1">
                  <div className="flex items-center gap-2 text-xs text-zinc-300">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white">1</span>
                    <span>Approve {symbol} token transfer for deal contract</span>
                  </div>
                  <Button
                    className="w-full justify-center gap-2 text-xs font-semibold"
                    size="sm"
                    variant="outline"
                    disabled={!networkReady || isSwitching || isTokenApprovePending || isApproveSuccess}
                    onClick={onApproveToken}
                  >
                    {isTokenApprovePending ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
                    {isApproveSuccess ? `Step 1 Complete: Approved ${symbol}` : `Approve ${symbol} for Escrow`}
                  </Button>
                </div>
              )}

              {/* Step 2 or ETH direct funding */}
              <div className="space-y-2 pt-1">
                {isToken && (
                  <div className="flex items-center gap-2 text-xs text-zinc-300">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white">2</span>
                    <span>Deposit funds into deal escrow contract</span>
                  </div>
                )}
                <Button
                  className="w-full justify-center gap-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-950/40"
                  size="sm"
                  disabled={!networkReady || isSwitching || isPendingTx || (isToken && !isApproveSuccess)}
                  onClick={onFundEscrow}
                >
                  {isPendingTx ? <Loader2 size={13} className="animate-spin" /> : <Wallet size={13} />}
                  {isPendingTx ? 'Funding Escrow...' : `Fund Escrow (${formattedTotalValue})`}
                </Button>
              </div>
            </div>
          )}

          {/* SELLER UNFUNDED FLOW */}
          {isActive && isSeller && !hasEverBeenFullyAccounted && (
            <div className="flex items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-950/20 p-4 text-xs text-zinc-300">
              <Clock size={16} className="text-amber-400 shrink-0" />
              <div>
                <p className="font-semibold text-white">Waiting for Client Funding</p>
                <p className="text-zinc-400 text-[11px] mt-0.5">
                  The client needs to fund the deal escrow ({formattedTotalValue}) before the recommended work flow begins.
                </p>
              </div>
            </div>
          )}

          {/* FUNDED STATE NOTICE (BUYER & SELLER) */}
          {isActive && hasEverBeenFullyAccounted && (
            <div className="flex items-center gap-3 rounded-xl border border-green-500/25 bg-green-950/20 p-4 text-xs text-zinc-300">
              <ShieldCheck size={16} className="text-green-400 shrink-0" />
              <div>
                <p className="font-semibold text-white">Escrow Funds Secured</p>
                <p className="text-zinc-400 text-[11px] mt-0.5">
                  {isBuyer
                    ? 'Agreed funds are locked in the deal contract. Payouts are released as milestones are approved.'
                    : 'Client funds are secured in the deal contract and will be paid upon milestone approval.'}
                </p>
              </div>
            </div>
          )}

          {/* ZERO MILESTONES + FUNDED NOTICE */}
          {isActive && hasEverBeenFullyAccounted && milestones.length === 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-500/25 bg-blue-950/20 p-4">
              <div className="text-xs">
                <p className="font-semibold text-white">Milestone Definitions Required</p>
                <p className="text-zinc-400 text-[11px] mt-0.5">
                  {isBuyer
                    ? 'Funds are secured. Add work milestones to define deliverables and payout releases.'
                    : 'Funds are secured. Waiting for client to define work milestones.'}
                </p>
              </div>
              {isBuyer && (
                <Button
                  size="sm"
                  className="gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white font-semibold"
                  onClick={() => onNavigateSection('milestones')}
                >
                  <Plus size={13} /> Add Milestone
                </Button>
              )}
            </div>
          )}

          {/* DISPUTED FROZEN NOTICE */}
          {statusNum === 3 && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-950/20 p-4">
              <div className="text-xs">
                <p className="font-semibold text-red-300 flex items-center gap-1.5">
                  <Lock size={14} /> Escrow Frozen by Active Dispute
                </p>
                <p className="text-zinc-400 text-[11px] mt-0.5">
                  Normal milestone payouts are paused while the dispute is active. Mutual consent or administrator resolution can finalize the remaining escrow.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="gap-1 text-xs border-red-500/30 text-red-300 hover:bg-red-500/10 shrink-0"
                onClick={() => onNavigateSection('dispute')}
              >
                View Dispute
              </Button>
            </div>
          )}

          {/* COMPLETED DEAL ESCROW STATUS */}
          {statusNum === 2 && (
            <div className={cn(
              'rounded-xl border p-4 text-xs space-y-1.5',
              escrowBalance > 0n
                ? 'border-amber-500/30 bg-amber-950/20'
                : 'border-emerald-500/25 bg-emerald-950/20'
            )}>
              <div className="flex items-center gap-1.5">
                {escrowBalance > 0n ? (
                  <span className="text-amber-300 font-bold flex items-center gap-1.5">
                    <AlertTriangle size={15} /> Remaining Escrow Detected
                  </span>
                ) : (
                  <span className="text-emerald-400 font-bold flex items-center gap-1.5">
                    <CheckCircle2 size={15} /> All Escrow Settled
                  </span>
                )}
              </div>
              <p className="text-zinc-300 text-[11px] leading-relaxed">
                {escrowBalance > 0n
                  ? `This deal is Completed on-chain, but ${formattedEscrowBalance} ${symbol} remains locked in the deal contract. The current deal contract does not expose a post-completion withdrawal action for remaining funds.`
                  : 'All contract escrow funds for this agreement have been fully released and settled on-chain.'}
              </p>
            </div>
          )}

          {/* CANCELLED NOTICE */}
          {statusNum === 4 && (
            <div className="rounded-xl border border-red-500/20 bg-red-950/20 p-4 text-xs space-y-1">
              <p className="font-semibold text-red-300 flex items-center gap-1.5">
                <Ban size={14} /> Deal Cancelled
              </p>
              <p className="text-zinc-400 text-[11px]">
                Any escrow balance remaining at the time of cancellation was returned to the client's wallet.
              </p>
            </div>
          )}

          {/* Transaction status feedback */}
          {actionError && (
            <div className="rounded-lg border border-red-500/20 bg-red-600/10 p-3 text-xs text-red-400">
              {actionError}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Side Column: Approved Payment Breakdown & Contract Transparency */}
      <div className="space-y-6">
        {/* Approved Payout History Breakdown */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
              <CheckCircle2 size={15} className="text-emerald-400" /> Released Payment History
            </CardTitle>
            <CardDescription className="text-xs text-zinc-400">
              Payouts released upon milestone approval.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {approvedMilestones.length === 0 ? (
              <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/20 p-4 text-center text-xs text-zinc-400">
                No milestone payouts have been released yet.
              </div>
            ) : (
              <div className="space-y-2">
                {approvedMilestones.map((m, i) => (
                  <div key={i} className="flex items-center justify-between rounded-lg border border-green-500/20 bg-green-950/10 p-3 text-xs">
                    <div className="min-w-0 pr-2">
                      <p className="font-semibold text-white truncate">{m.title || `Milestone`}</p>
                      <span className="text-[10px] text-zinc-400 font-mono">Released</span>
                    </div>
                    <Badge variant="success" className="text-[10px] shrink-0 font-mono">
                      +{(Number(m.amount) / 10 ** (tokenInfo?.decimals ?? 18)).toFixed(2)} {symbol}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Contract Technical Transparency Card */}
        <Card className="border-zinc-800/80 bg-zinc-900/20">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
              <Info size={15} className="text-zinc-400" /> Smart Contract Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div className="flex justify-between items-center">
              <span className="text-zinc-400">Contract Address</span>
              <span className="font-mono text-zinc-200 text-[11px]">{shortenAddress(dealAddress)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-zinc-400">Asset Address</span>
              <span className="font-mono text-zinc-200 text-[11px]">
                {isToken ? shortenAddress(assetAddress) : 'Native ETH'}
              </span>
            </div>
            <Separator />
            <p className="text-[11px] text-zinc-400 leading-relaxed pt-1">
              Funds are programmatically locked in this smart contract. Payouts require explicit milestone approval signatures.
            </p>
          </CardContent>
        </Card>

        {/* Cancel Deal Danger Action */}
        <Card className="border-red-500/20 bg-zinc-900/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-bold text-red-300">Cancellation Control</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-[11px] text-zinc-400">
              Cancelling is permanent and returns remaining contract balance to the client.
            </p>
            {isActive && (isBuyer || isSeller) ? (
              <Button
                className="w-full justify-center gap-1.5 text-xs"
                size="sm"
                variant="destructive"
                disabled={!networkReady || isSwitching || isPendingTx}
                onClick={onCancelClick}
              >
                <Ban size={13} /> Cancel Deal
              </Button>
            ) : (
              <p className="text-[11px] text-zinc-400 italic">
                {isActive ? 'Only deal parties can cancel.' : `Unavailable while deal is ${statusLabel}.`}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
