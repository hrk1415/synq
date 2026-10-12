'use client';

import React, { useState } from 'react';
import {
  Scale,
  AlertTriangle,
  CheckCircle2,
  Lock,
  Gavel,
  Loader2,
  Sparkles,
  Send,
  RotateCcw,
  X,
  Info,
  Shield,
  FileText,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { shortenAddress } from '@/lib/utils';
import { DealUXState } from '@/lib/deals/deriveDealUX';

interface DealDisputePanelProps {
  uxState: DealUXState;
  dealAddress: `0x${string}`;
  statusNum: number;
  statusLabel: string;
  isBuyer: boolean;
  isSeller: boolean;
  isActive: boolean;
  isDisputed: boolean;
  isParty: boolean;
  isAdmin: boolean;
  buyerAddress: string;
  sellerAddress: string;
  buyerHandle?: string | null;
  sellerHandle?: string | null;
  formattedTotalValue: string;
  formattedEscrowBalance: string;
  formattedReleasedAmount: string;
  dispute: {
    openedBy?: string;
    reason?: string;
    aiSummary?: string;
    aiRecommendation?: string;
    buyerApproved?: boolean;
    sellerApproved?: boolean;
  };
  tokenInfo: { symbol: string; decimals: number } | null;
  supportsForceResolve: boolean;
  forceResolveSimPending: boolean;
  isPendingTx: boolean;
  isFactoryPendingTx: boolean;
  actionError: string;
  disputeActionConfirmed: boolean;
  forceResolveConfirmed: boolean;
  onOpenDispute: (reason: string) => void;
  onApproveConsent: () => void;
  onExecuteResolution: (resolution: 'release_to_seller' | 'refund_buyer') => void;
  onForceResolve: (resolution: 'release_to_seller' | 'refund_buyer') => void;
}

export function DealDisputePanel({
  uxState,
  dealAddress,
  statusNum,
  statusLabel,
  isBuyer,
  isSeller,
  isActive,
  isDisputed,
  isParty,
  isAdmin,
  buyerAddress,
  sellerAddress,
  buyerHandle,
  sellerHandle,
  formattedTotalValue,
  formattedEscrowBalance,
  formattedReleasedAmount,
  dispute,
  tokenInfo,
  supportsForceResolve,
  forceResolveSimPending,
  isPendingTx,
  isFactoryPendingTx,
  actionError,
  disputeActionConfirmed,
  forceResolveConfirmed,
  onOpenDispute,
  onApproveConsent,
  onExecuteResolution,
  onForceResolve,
}: DealDisputePanelProps) {
  const [disputeFormOpen, setDisputeFormOpen] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');
  const [confirmResolveChoice, setConfirmResolveChoice] = useState<'release_to_seller' | 'refund_buyer' | null>(null);
  const [confirmForceChoice, setConfirmForceChoice] = useState<'release_to_seller' | 'refund_buyer' | null>(null);

  const ZERO = '0x0000000000000000000000000000000000000000';
  const hasDisputeRecord = (!!dispute.openedBy && dispute.openedBy !== ZERO) || !!dispute.reason;

  const buyerApproved = dispute.buyerApproved === true;
  const sellerApproved = dispute.sellerApproved === true;
  const bothApproved = buyerApproved && sellerApproved;

  const symbol = tokenInfo?.symbol ?? 'asset';
  const releasedAmountBigInt = uxState.financial.releasedAmount;
  const escrowBalanceBigInt = uxState.financial.escrowBalance;

  const openedByAddress = String(dispute.openedBy || '');
  const isOpenedByBuyer = openedByAddress.toLowerCase() === buyerAddress.toLowerCase();
  const isOpenedBySeller = openedByAddress.toLowerCase() === sellerAddress.toLowerCase();

  const getOpenedByRoleText = () => {
    if (isOpenedByBuyer && isOpenedBySeller) return 'Client & Freelancer (Test Mode)';
    if (isOpenedByBuyer) return 'Client';
    if (isOpenedBySeller) return 'Freelancer';
    return 'Party';
  };

  const handleOpenDisputeSubmit = () => {
    if (!disputeReason.trim()) return;
    onOpenDispute(disputeReason.trim());
    setDisputeReason('');
    setDisputeFormOpen(false);
  };

  return (
    <div className="space-y-6">
      <Card className="border-zinc-800/80 bg-zinc-900/40">
        <CardHeader className="pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-lg font-bold text-white flex items-center gap-2">
                <Scale size={18} className="text-amber-400" /> Dispute & Resolution
              </CardTitle>
              <CardDescription className="text-xs text-zinc-400 mt-0.5">
                On-chain resolution workspace for formal agreement disagreements.
              </CardDescription>
            </div>
            <Badge
              variant={isDisputed ? 'destructive' : hasDisputeRecord ? 'secondary' : 'outline'}
              className="text-xs font-semibold"
            >
              {isDisputed ? 'Dispute Active' : hasDisputeRecord ? 'Historical Dispute' : 'No Active Dispute'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* ============================================================ */}
          {/* 1. NO DISPUTE STATE                                         */}
          {/* ============================================================ */}
          {!isDisputed && !hasDisputeRecord && (
            <div className="space-y-5">
              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-5 space-y-3">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Info size={15} className="text-blue-400" /> Formal Agreement Resolution
                </h3>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Opening a dispute pauses normal milestone and payment operations and freezes remaining escrow until resolved through mutual party consent or protocol administrator resolution.
                </p>

                <div className="grid gap-3 sm:grid-cols-2 pt-2 border-t border-zinc-900">
                  <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-3">
                    <span className="text-[11px] text-zinc-400 font-medium">Already Released via Milestones</span>
                    <p className="text-sm font-bold text-emerald-400 mt-0.5">{formattedReleasedAmount}</p>
                    <span className="text-[10px] text-zinc-500">Already paid to freelancer</span>
                  </div>
                  <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-3">
                    <span className="text-[11px] text-zinc-400 font-medium">Remaining Escrow at Risk</span>
                    <p className="text-sm font-bold text-blue-400 mt-0.5">{formattedEscrowBalance}</p>
                    <span className="text-[10px] text-zinc-500">Subject to dispute freezing</span>
                  </div>
                </div>
              </div>

              {isActive && isParty ? (
                !disputeFormOpen ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-950/10 p-4">
                    <div>
                      <p className="text-sm font-semibold text-white">Need formal dispute resolution?</p>
                      <p className="text-xs text-zinc-400 mt-0.5">
                        Either agreement party (Client or Freelancer) can open an on-chain dispute.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 border-amber-500/30 text-amber-300 hover:bg-amber-500/10 font-semibold"
                      onClick={() => setDisputeFormOpen(true)}
                    >
                      <AlertTriangle size={14} /> Open Dispute
                    </Button>
                  </div>
                ) : (
                  /* Open Dispute Modal Form */
                  <div className="space-y-4 rounded-xl border border-red-500/30 bg-red-950/20 p-5">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-bold text-red-300 flex items-center gap-2">
                        <AlertTriangle size={16} /> Open On-Chain Dispute
                      </h4>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 text-zinc-400 hover:text-white"
                        onClick={() => {
                          setDisputeFormOpen(false);
                          setDisputeReason('');
                        }}
                      >
                        <X size={14} />
                      </Button>
                    </div>
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      Opening a dispute pauses normal milestone and payment operations until the dispute is resolved.
                    </p>

                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-zinc-300 block">
                        Reason for dispute
                      </label>
                      <textarea
                        rows={3}
                        value={disputeReason}
                        onChange={(e) => setDisputeReason(e.target.value)}
                        placeholder="Describe the disagreement clearly. This reason will be stored with the on-chain dispute record."
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950/90 p-3 text-xs text-zinc-200 focus:border-red-500/50 focus:outline-none"
                      />
                      <p className="text-[11px] text-zinc-500">
                        Describe the disagreement clearly. This reason will be stored on-chain.
                      </p>
                    </div>

                    <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-400">
                      Warning: This action changes the deal status to Disputed and cannot be undone through normal milestone workflows.
                    </div>

                    <div className="flex justify-end gap-2 pt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs"
                        onClick={() => {
                          setDisputeFormOpen(false);
                          setDisputeReason('');
                        }}
                        disabled={isPendingTx}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="gap-1.5 text-xs font-semibold"
                        disabled={isPendingTx || !disputeReason.trim()}
                        onClick={handleOpenDisputeSubmit}
                      >
                        {isPendingTx ? <Loader2 size={13} className="animate-spin" /> : <AlertTriangle size={13} />}
                        {isPendingTx ? 'Opening Dispute...' : 'Open Dispute'}
                      </Button>
                    </div>
                  </div>
                )
              ) : (
                <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-4 text-center text-xs text-zinc-400">
                  {!isParty && !isAdmin
                    ? 'Spectator View: Only agreement parties (Client or Freelancer) can open a dispute.'
                    : `Dispute controls unavailable while deal status is ${statusLabel}.`}
                </div>
              )}
            </div>
          )}

          {/* ============================================================ */}
          {/* 2. ACTIVE DISPUTE EXPERIENCE                                */}
          {/* ============================================================ */}
          {isDisputed && (
            <div className="space-y-6">
              {/* Restrained Warning Notice */}
              <div className="rounded-xl border border-red-500/30 bg-red-950/20 p-4 space-y-1">
                <div className="flex items-center gap-2 text-sm font-bold text-red-300">
                  <AlertTriangle size={16} /> Dispute Active
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Normal milestone actions and cancellation are paused while this dispute is active. Existing milestone definitions remain intact.
                </p>
              </div>

              {/* Dispute Record Details */}
              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-4 space-y-4">
                <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                  <FileText size={14} className="text-blue-400" /> Dispute Record
                </h4>

                <div className="grid gap-3 sm:grid-cols-2 text-xs">
                  <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/40 p-3 space-y-1">
                    <span className="text-zinc-500 font-medium">Opened By</span>
                    {(() => {
                      const openedByHandle = openedByAddress.toLowerCase() === buyerAddress.toLowerCase()
                        ? buyerHandle
                        : openedByAddress.toLowerCase() === sellerAddress.toLowerCase()
                          ? sellerHandle
                          : null;

                      return openedByHandle ? (
                        <p className="text-zinc-200 font-medium flex items-baseline gap-1.5 flex-wrap">
                          <span className="font-bold text-white text-xs">{openedByHandle}</span>
                          <span className="font-mono text-[11px] text-zinc-400">({getOpenedByRoleText()} · {shortenAddress(openedByAddress)})</span>
                        </p>
                      ) : (
                        <p className="font-mono text-zinc-200 font-medium">
                          {getOpenedByRoleText()} · {shortenAddress(openedByAddress)}
                        </p>
                      );
                    })()}
                  </div>
                  <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/40 p-3 space-y-1">
                    <span className="text-zinc-500 font-medium">Stated Reason</span>
                    <p className="text-zinc-200 leading-relaxed font-sans">
                      {dispute.reason || 'No reason specified.'}
                    </p>
                  </div>
                </div>

                {/* AI Assessment if available */}
                {(dispute.aiSummary || dispute.aiRecommendation) && (
                  <div className="rounded-lg border border-violet-500/25 bg-violet-950/20 p-3.5 space-y-1.5 text-xs">
                    <p className="flex items-center gap-1.5 font-bold text-violet-300">
                      <Sparkles size={14} /> Protocol AI Assessment
                    </p>
                    {dispute.aiSummary && <p className="text-zinc-300">{dispute.aiSummary}</p>}
                    {dispute.aiRecommendation && (
                      <p className="text-zinc-400 font-mono text-[11px] pt-1">
                        Recommendation: {dispute.aiRecommendation}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Funds At Stake Section */}
              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-4 space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                  <Lock size={14} className="text-emerald-400" /> Funds At Stake
                </h4>

                <div className="grid gap-3 sm:grid-cols-3 text-xs">
                  <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/40 p-3 space-y-1">
                    <span className="text-zinc-500 font-medium">Total Agreed Value</span>
                    <p className="text-sm font-bold text-white">{formattedTotalValue}</p>
                  </div>
                  <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/40 p-3 space-y-1">
                    <span className="text-zinc-500 font-medium">Already Released</span>
                    <p className="text-sm font-bold text-emerald-400">{formattedReleasedAmount}</p>
                  </div>
                  <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/40 p-3 space-y-1">
                    <span className="text-zinc-500 font-medium">Remaining Escrow Frozen</span>
                    <p className="text-sm font-bold text-blue-400">{formattedEscrowBalance}</p>
                  </div>
                </div>

                {/* Warnings based on financials */}
                {releasedAmountBigInt > 0n && (
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300 flex items-start gap-2">
                    <Info size={14} className="shrink-0 mt-0.5" />
                    <span>
                      Previously released milestone payments ({formattedReleasedAmount}) cannot be reversed by dispute resolution. Only remaining escrow ({formattedEscrowBalance}) will be transferred upon resolution.
                    </span>
                  </div>
                )}

                {escrowBalanceBigInt === 0n && (
                  <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-xs text-zinc-300">
                    No escrow remains in the deal contract. Resolution will still finalize the dispute, but there are no remaining funds to transfer.
                  </div>
                )}
              </div>

              {/* Consent Explanation & Status */}
              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-4 space-y-4">
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                    <Scale size={14} className="text-blue-400" /> Resolution Consent
                  </h4>
                  <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                    Consent allows this dispute to move to final resolution once both parties have approved. Consent does not choose who receives the remaining escrow. Once submitted on-chain, consent cannot be revoked.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 text-xs">
                  {/* Client Consent Status */}
                  <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/40 p-3.5 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="font-semibold text-zinc-200">Client Consent</span>
                      <Badge variant={buyerApproved ? 'success' : 'secondary'} className="text-[10px]">
                        {buyerApproved ? 'Consent Approved' : 'Pending Consent'}
                      </Badge>
                    </div>
                    {isBuyer && !buyerApproved && (
                      <Button
                        size="sm"
                        className="w-full justify-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold"
                        disabled={isPendingTx}
                        onClick={onApproveConsent}
                      >
                        {isPendingTx ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                        Approve Resolution Consent
                      </Button>
                    )}
                    {isBuyer && buyerApproved && (
                      <p className="text-[11px] text-emerald-400 font-medium">Your consent is recorded on-chain.</p>
                    )}
                  </div>

                  {/* Freelancer Consent Status */}
                  <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/40 p-3.5 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="font-semibold text-zinc-200">Freelancer Consent</span>
                      <Badge variant={sellerApproved ? 'success' : 'secondary'} className="text-[10px]">
                        {sellerApproved ? 'Consent Approved' : 'Pending Consent'}
                      </Badge>
                    </div>
                    {isSeller && !sellerApproved && (
                      <Button
                        size="sm"
                        className="w-full justify-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold"
                        disabled={isPendingTx}
                        onClick={onApproveConsent}
                      >
                        {isPendingTx ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                        Approve Resolution Consent
                      </Button>
                    )}
                    {isSeller && sellerApproved && (
                      <p className="text-[11px] text-emerald-400 font-medium">Your consent is recorded on-chain.</p>
                    )}
                  </div>
                </div>

                {/* Waiting State */}
                {isParty && !bothApproved && (
                  ((isBuyer && buyerApproved) || (isSeller && sellerApproved)) && (
                    <div className="rounded-lg border border-blue-500/20 bg-blue-950/20 p-3 text-xs text-blue-300 font-medium">
                      Waiting for Counterparty: Your consent is recorded. Waiting for the counterparty to approve resolution consent on-chain.
                    </div>
                  )
                )}

                {!bothApproved && (
                  <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-[11px] text-zinc-400">
                    There is no automatic resolution timeout. Mutual resolution requires both parties' consent; administrator resolution may also finalize the dispute.
                  </div>
                )}
              </div>

              {/* ============================================================ */}
              {/* BOTH PARTIES CONSENTED — FINAL MUTUAL RESOLUTION            */}
              {/* ============================================================ */}
              {bothApproved && (
                <div className="rounded-xl border border-blue-500/40 bg-blue-950/20 p-5 space-y-4">
                  <div>
                    <h4 className="text-sm font-bold text-white flex items-center gap-2">
                      <CheckCircle2 size={16} className="text-blue-400" /> Final Resolution Unlocked
                    </h4>
                    <p className="text-xs text-zinc-300 mt-1 leading-relaxed">
                      Both parties have approved resolution consent. The remaining escrow ({formattedEscrowBalance}) can now be transferred in full to either the Client or the Freelancer.
                    </p>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2 pt-1">
                    {/* Choice 1: Release to Freelancer */}
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3 flex flex-col justify-between">
                      <div className="space-y-1.5">
                        <h5 className="text-xs font-bold text-white flex items-center gap-1.5">
                          <Send size={14} className="text-emerald-400" /> Release to Freelancer
                        </h5>
                        <p className="text-[11px] text-zinc-400 leading-relaxed">
                          Transfers the entire remaining escrow balance of <strong className="text-white">{formattedEscrowBalance}</strong> to the Freelancer.
                        </p>
                        {releasedAmountBigInt > 0n && (
                          <p className="text-[10px] text-zinc-500">
                            Previously released milestone payments remain with the Freelancer.
                          </p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        className="w-full justify-center gap-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white"
                        disabled={isPendingTx}
                        onClick={() => setConfirmResolveChoice('release_to_seller')}
                      >
                        Release {formattedEscrowBalance} to Freelancer
                      </Button>
                    </div>

                    {/* Choice 2: Refund Client */}
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3 flex flex-col justify-between">
                      <div className="space-y-1.5">
                        <h5 className="text-xs font-bold text-white flex items-center gap-1.5">
                          <RotateCcw size={14} className="text-blue-400" /> Refund Client
                        </h5>
                        <p className="text-[11px] text-zinc-400 leading-relaxed">
                          Returns the entire remaining escrow balance of <strong className="text-white">{formattedEscrowBalance}</strong> to the Client.
                        </p>
                        {releasedAmountBigInt > 0n && (
                          <p className="text-[10px] text-zinc-500">
                            Previously released milestone payments are not included in this refund.
                          </p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full justify-center gap-1.5 text-xs font-semibold border-zinc-700 text-zinc-200 hover:bg-zinc-800"
                        disabled={isPendingTx}
                        onClick={() => setConfirmResolveChoice('refund_buyer')}
                      >
                        Refund {formattedEscrowBalance} to Client
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* ============================================================ */}
              {/* ADMIN OVERRIDE SECTION                                      */}
              {/* ============================================================ */}
              {isAdmin && (
                <div className="rounded-xl border border-amber-500/40 bg-amber-950/20 p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-xs font-bold text-amber-300 uppercase tracking-wider flex items-center gap-2">
                      <Gavel size={15} /> Protocol Admin Resolution
                    </h4>
                    <Badge variant="warning" className="text-[10px]">feeCollector</Badge>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    Factory administrator authority can resolve an active dispute without both party consent. Administrator resolution is available at the protocol level.
                  </p>

                  {forceResolveSimPending ? (
                    <p className="flex items-center gap-1.5 text-xs text-zinc-400">
                      <Loader2 size={13} className="animate-spin" /> Verifying factory admin authority…
                    </p>
                  ) : supportsForceResolve ? (
                    <div className="grid gap-3 sm:grid-cols-2 pt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 text-xs font-semibold border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
                        disabled={isFactoryPendingTx}
                        onClick={() => setConfirmForceChoice('release_to_seller')}
                      >
                        <Gavel size={13} /> Force Release ({formattedEscrowBalance}) to Freelancer
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 text-xs font-semibold border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
                        disabled={isFactoryPendingTx}
                        onClick={() => setConfirmForceChoice('refund_buyer')}
                      >
                        <Gavel size={13} /> Force Refund ({formattedEscrowBalance}) to Client
                      </Button>
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-500">Deployed factory does not confirm override authority.</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ============================================================ */}
          {/* 3. HISTORICAL RESOLVED DISPUTE VIEW                          */}
          {/* ============================================================ */}
          {!isDisputed && hasDisputeRecord && (
            <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-950/50 p-5">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-emerald-400" /> Historical Dispute Record
                </h4>
                <Badge variant="outline" className="text-xs text-zinc-400 border-zinc-700">
                  Deal Status: Completed
                </Badge>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 text-xs">
                <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/40 p-3 space-y-1">
                  <span className="text-zinc-500 font-medium">Opened By</span>
                  <p className="font-mono text-zinc-200">
                    {getOpenedByRoleText()} · {shortenAddress(openedByAddress)}
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/40 p-3 space-y-1">
                  <span className="text-zinc-500 font-medium">Dispute Reason</span>
                  <p className="text-zinc-200">{dispute.reason || 'No reason recorded.'}</p>
                </div>
              </div>

              <p className="text-xs text-zinc-400 font-medium">
                Resolution completed on-chain. Deal status finalized to Completed.
              </p>
            </div>
          )}

          {/* Feedback messages */}
          {actionError && (
            <div className="rounded-lg border border-red-500/20 bg-red-600/10 p-3 text-xs text-red-400">
              {actionError}
            </div>
          )}

          {disputeActionConfirmed && (
            <div className="flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-600/10 p-3 text-xs text-green-400">
              <CheckCircle2 size={14} /> Dispute transaction confirmed on-chain.
            </div>
          )}

          {forceResolveConfirmed && (
            <div className="flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-600/10 p-3 text-xs text-green-400">
              <CheckCircle2 size={14} /> Admin override transaction confirmed on-chain.
            </div>
          )}
        </CardContent>
      </Card>

      {/* ============================================================ */}
      {/* INLINE CONFIRMATION MODALS                                  */}
      {/* ============================================================ */}

      {/* Mutual Resolution Confirm Modal */}
      {confirmResolveChoice && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setConfirmResolveChoice(null)}
        >
          <div
            className="w-full max-w-md space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Scale size={16} className="text-blue-400" /> Confirm Final Resolution
              </h3>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 text-zinc-400 hover:text-white"
                onClick={() => setConfirmResolveChoice(null)}
              >
                <X size={14} />
              </Button>
            </div>

            <div className="space-y-2 text-xs text-zinc-300">
              <p>
                <strong>Outcome:</strong>{' '}
                {confirmResolveChoice === 'release_to_seller'
                  ? `Release entire remaining escrow (${formattedEscrowBalance}) to Freelancer`
                  : `Refund entire remaining escrow (${formattedEscrowBalance}) to Client`}
              </p>
              <p>
                <strong>Recipient:</strong>{' '}
                {confirmResolveChoice === 'release_to_seller'
                  ? `Freelancer (${shortenAddress(sellerAddress)})`
                  : `Client (${shortenAddress(buyerAddress)})`}
              </p>
            </div>

            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300">
              Warning: This action transfers the remaining escrow ({formattedEscrowBalance}) in full and marks the deal as Completed. This action cannot be undone.
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                className="text-xs"
                onClick={() => setConfirmResolveChoice(null)}
                disabled={isPendingTx}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className={
                  confirmResolveChoice === 'release_to_seller'
                    ? 'bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold'
                    : 'bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold'
                }
                disabled={isPendingTx}
                onClick={() => {
                  const choice = confirmResolveChoice;
                  setConfirmResolveChoice(null);
                  onExecuteResolution(choice);
                }}
              >
                {isPendingTx ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : confirmResolveChoice === 'release_to_seller' ? (
                  <Send size={13} />
                ) : (
                  <RotateCcw size={13} />
                )}
                Confirm {confirmResolveChoice === 'release_to_seller' ? 'Release' : 'Refund'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Admin Force Resolve Confirm Modal */}
      {confirmForceChoice && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setConfirmForceChoice(null)}
        >
          <div
            className="w-full max-w-md space-y-4 rounded-2xl border border-amber-500/30 bg-zinc-900 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-amber-300 flex items-center gap-2">
                <Gavel size={16} /> Confirm Admin Override
              </h3>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 text-zinc-400 hover:text-white"
                onClick={() => setConfirmForceChoice(null)}
              >
                <X size={14} />
              </Button>
            </div>

            <div className="space-y-2 text-xs text-zinc-300">
              <p>
                <strong>Admin Action:</strong>{' '}
                {confirmForceChoice === 'release_to_seller'
                  ? `Force Release remaining escrow (${formattedEscrowBalance}) to Freelancer`
                  : `Force Refund remaining escrow (${formattedEscrowBalance}) to Client`}
              </p>
              <p>
                <strong>Recipient:</strong>{' '}
                {confirmForceChoice === 'release_to_seller'
                  ? `Freelancer (${shortenAddress(sellerAddress)})`
                  : `Client (${shortenAddress(buyerAddress)})`}
              </p>
            </div>

            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300">
              This action overrides current consent states, transfers remaining escrow directly, and completes the deal.
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                className="text-xs"
                onClick={() => setConfirmForceChoice(null)}
                disabled={isFactoryPendingTx}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-amber-500/40 text-amber-300 hover:bg-amber-500/10 text-xs font-semibold gap-1.5"
                disabled={isFactoryPendingTx}
                onClick={() => {
                  const choice = confirmForceChoice;
                  setConfirmForceChoice(null);
                  onForceResolve(choice);
                }}
              >
                {isFactoryPendingTx ? <Loader2 size={13} className="animate-spin" /> : <Gavel size={13} />}
                Confirm Admin Override
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
