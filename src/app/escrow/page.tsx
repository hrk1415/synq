'use client';

import { motion } from 'framer-motion';
import { ShieldCheck, Lock, CheckCircle, Clock, AlertTriangle, ExternalLink, Loader2, Play, Send, ThumbsUp, RotateCcw, XCircle, Plus, FileText, Gavel, Sparkles, ArrowRight } from 'lucide-react';
import { useState, useMemo, useEffect, useRef } from 'react';
import { parseUnits, formatUnits } from 'viem';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { useAccount, useChainId, useReadContract, useSimulateContract } from 'wagmi';
import { getFactoryAddress, useFactoryContract } from '@/hooks/useFactoryContract';
import { nexotiqFactoryABI } from '@/lib/contracts/abis';
import { shortenAddress, cn, evidenceUrl } from '@/lib/utils';
import { getTokenInfo, chainKeyForId, isSupportedChain } from '@/lib/contracts/addresses';
import { useDealContract } from '@/hooks/useDealContract';
import { useDealStatuses, dealStatusLabel } from '@/hooks/useDealStatuses';
import { ChainGuard } from '@/components/shared/ChainGuard';

const ZERO = '0x0000000000000000000000000000000000000000';

const fmtNum = (v: number) =>
  v.toLocaleString('en-US', { maximumFractionDigits: v >= 1000 ? 2 : 4 });

export default function EscrowPage() {
  const { address } = useAccount();
  const chainId = useChainId();
  const factoryAddress = getFactoryAddress(chainId);
  const onSupportedChain = isSupportedChain(chainId) && !!factoryAddress;

  const { data: rawDeals, isLoading } = useReadContract({
    address: factoryAddress,
    abi: nexotiqFactoryABI,
    functionName: 'getUserDeals',
    args: address ? [address] : undefined,
    query: { enabled: !!address && onSupportedChain },
  });

  const factory = useFactoryContract();
  const isAdmin = !!address && !!factory.feeCollector && String(address).toLowerCase() === String(factory.feeCollector).toLowerCase();

  // Every deal the factory knows about, not only the ones it flags `active`.
  // That flag is only cleared by `onDealSettled`, which the deployed factory
  // never receives, so filtering on it was a no-op today — and on a corrected
  // factory it would silently hide every settled deal from its own parties.
  // Real, per-deal status comes from the deal contracts (useDealStatuses).
  const allDeals = useMemo(() => {
    if (!rawDeals) return [];
    return (rawDeals as any[]).filter(Boolean);
  }, [rawDeals]);

  // dedupe duplicate addresses (self-deals appear twice)
  const dedupedDeals = useMemo(() => {
    const seen = new Set<string>();
    return allDeals.filter((d: any) => {
      const k = String(d.dealAddress).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [allDeals]);

  const dealAddressList = useMemo(() => dedupedDeals.map((d: any) => String(d.dealAddress)), [dedupedDeals]);
  const { statuses: listStatuses } = useDealStatuses(dealAddressList);

  // sort active deals first
  const sortedDeals = useMemo(() => {
    return [...dedupedDeals].sort((a: any, b: any) => {
      const sA = listStatuses[String(a.dealAddress).toLowerCase()] ?? 0;
      const sB = listStatuses[String(b.dealAddress).toLowerCase()] ?? 0;
      return (sA === 1 ? 0 : 1) - (sB === 1 ? 0 : 1);
    });
  }, [dedupedDeals, listStatuses]);

  const [selectedDeal, setSelectedDeal] = useState(0);

  // Keep the active deal selected & highlighted: whenever the on-chain statuses
  // arrive, jump to the first active deal so it stays in view at the top.
  const activeIndex = useMemo(() => {
    const idx = sortedDeals.findIndex((d: any) => {
      const s = listStatuses[String(d.dealAddress).toLowerCase()];
      return s === 1;
    });
    return idx;
  }, [sortedDeals, listStatuses]);

  useEffect(() => {
    if (activeIndex >= 0) setSelectedDeal(activeIndex);
    // eslint-disable-next-line react-hooks/set-state-in-effect
  }, [activeIndex]);

  const currentDeal = sortedDeals[selectedDeal];
  const dealAddr = currentDeal?.dealAddress as `0x${string}` | undefined;

  const deal = useDealContract(dealAddr);

  const isBuyer = !!address && !!deal.buyer && String(address).toLowerCase() === String(deal.buyer).toLowerCase();
  const isSeller = !!address && !!deal.seller && String(address).toLowerCase() === String(deal.seller).toLowerCase();
  const statusNum = Number(deal.status ?? 0);

  const isDisputed = statusNum === 3;
  const { error: forceResolveSimError } = useSimulateContract({
    address: factoryAddress,
    abi: nexotiqFactoryABI,
    functionName: 'forceResolve',
    args: dealAddr && isDisputed ? [dealAddr, 'release_to_seller'] : undefined,
    query: { enabled: isDisputed && isAdmin && !!dealAddr && onSupportedChain },
  });
  const supportsForceResolve = !forceResolveSimError;

  const [evidence, setEvidence] = useState('');
  const [disputeReason, setDisputeReason] = useState('');
  // Form visibility is its own state. It used to be inferred from
  // `disputeReason` being truthy, opened by seeding it with the sentinel
  // '__open__' — which the Input then displayed, so submitting without editing
  // wrote the literal string "__open__" on-chain as the dispute reason.
  const [disputeFormOpen, setDisputeFormOpen] = useState(false);
  const [msTitle, setMsTitle] = useState('');
  const [msDesc, setMsDesc] = useState('');
  const [msAmount, setMsAmount] = useState('');
  const [msError, setMsError] = useState('');
  const [activeForm, setActiveForm] = useState<'ms' | null>(null);
  const [verifications, setVerifications] = useState<Record<number, any>>({});
  const [verifying, setVerifying] = useState<number | null>(null);
  const [submitPending, setSubmitPending] = useState(false);
  const [submitAfterHash, setSubmitAfterHash] = useState<string | null>(null);
  const [dealMeta, setDealMeta] = useState<{ title: string; amount: string; buyer: string; evidence: string; milestone: number }>({ title: '', amount: '', buyer: '', evidence: '', milestone: 0 });
  const [approvePending, setApprovePending] = useState(false);
  const [approveAfterHash, setApproveAfterHash] = useState<string | null>(null);
  const [approveMeta, setApproveMeta] = useState<{ milestone: number; seller: string; amount: string }>({ milestone: 0, seller: '', amount: '' });
  const completedNotified = useRef(false);

  // Must honour the deal's own asset decimals — a USDC deal is denominated in
  // 6 decimals, so dividing by 1e18 would report a 100 USDC deal as 0.0000 USDC.
  const dealLabel = (d: any) => {
    if (!d || d.totalValue === undefined || d.totalValue === null) return '';
    const t = getTokenInfo(chainKeyForId(chainId), String(d.asset || ZERO));
    return `${fmtNum(Number(formatUnits(BigInt(d.totalValue), t.decimals)))} ${t.symbol}`;
  };

  const txHashNow = () => (deal.txReceipt.data?.transactionHash ? String(deal.txReceipt.data.transactionHash) : null);

  // The receipt hook stays isSuccess for the previous tx too, so the email must
  // wait for a NEW transaction hash — otherwise "Start Work" would already
  // trigger the "work submitted" notification.
  useEffect(() => {
    if (!submitPending || !deal.txReceipt.isSuccess) return;
    const hash = txHashNow();
    if (hash && hash !== submitAfterHash) {
      setSubmitPending(false);
      fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'work_submitted',
          recipientWallet: dealMeta.buyer,
          recipientName: 'buyer',
          dealTitle: dealMeta.title || String(deal.title || ''),
          dealAmount: dealMeta.amount || dealLabel(deal),
          evidence: dealMeta.evidence || undefined,
          note: `Milestone ${(dealMeta.milestone ?? 0) + 1}`,
        }),
      }).catch(() => {});
    }
  }, [submitPending, submitAfterHash, deal.txReceipt.isSuccess, deal.txReceipt.data, dealMeta, deal]);

  useEffect(() => {
    if (Number(deal.status) === 2 && !completedNotified.current) {
      completedNotified.current = true;
      const base = {
        dealTitle: String(deal.title || ''),
        dealAmount: dealLabel(deal),
      };
      fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'deal_completed',
          recipientWallet: String(deal.buyer || ''),
          recipientName: 'buyer',
          ...base,
        }),
      }).catch(() => {});
      fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'deal_completed_seller',
          recipientWallet: String(deal.seller || ''),
          recipientName: 'seller',
          ...base,
        }),
      }).catch(() => {});
    }
  }, [deal.status, deal.buyer, deal.seller, deal.title, deal.totalValue, deal]);

  // A Pending milestone needs startMilestone before submitMilestone (two on-chain
  // txs). When the seller submits straight from Pending, chain them: wait for the
  // start tx's receipt hash, then fire the submit tx automatically.
  const [autoSubmit, setAutoSubmit] = useState<{ i: number; afterHash: string | null; evidence: string } | null>(null);

  const startAndSubmit = (i: number, ev: string) => {
    setAutoSubmit({ i, afterHash: txHashNow(), evidence: ev });
    deal.startMilestone(BigInt(i));
  };

  useEffect(() => {
    if (!autoSubmit || !deal.txReceipt.isSuccess) return;
    const hash = txHashNow();
    if (hash && hash !== autoSubmit.afterHash) {
      const { i, evidence: ev } = autoSubmit;
      setAutoSubmit(null);
      submitWork(i, ev || 'ipfs://' + Math.random().toString(36).slice(2, 10));
    }
  }, [autoSubmit, deal.txReceipt.isSuccess, deal.txReceipt.data]);

  const submitWork = (i: number, hash: string) => {
    setSubmitAfterHash(txHashNow());
    setSubmitPending(true);
    setDealMeta({ title: String(deal.title || ''), amount: dealLabel(deal), buyer: String(deal.buyer || ''), evidence: hash, milestone: i });
    deal.submitMilestone(BigInt(i), hash);
  };

  // Buyer approves a milestone: on-chain release + "payment received" email to
  // the seller, fired only once the approval tx's own receipt shows up.
  const approveAndRelease = (i: number, rawAmount: unknown, amountLabel: string) => {
    setApproveAfterHash(txHashNow());
    setApprovePending(true);
    setApproveMeta({ milestone: i, seller: String(deal.seller || ''), amount: amountLabel });
    deal.approveMilestone(BigInt(i));
  };

  useEffect(() => {
    if (!approvePending || !deal.txReceipt.isSuccess) return;
    const hash = txHashNow();
    if (hash && hash !== approveAfterHash) {
      setApprovePending(false);
      fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'payment_released',
          recipientWallet: approveMeta.seller,
          recipientName: 'seller',
          dealTitle: String(deal.title || ''),
          dealAmount: approveMeta.amount,
          note: `Milestone ${(approveMeta.milestone ?? 0) + 1}`,
        }),
      }).catch(() => {});
    }
  }, [approvePending, approveAfterHash, deal.txReceipt.isSuccess, deal.txReceipt.data, approveMeta, deal]);

  /**
   * Converts the typed amount to the deal asset's own base units.
   *
   * This used to hardcode `amt * 1e18`, which is only correct for native ETH.
   * On a USDC deal (6 decimals) it produced a milestone 10^12 times larger than
   * the escrow balance, so `approveMilestone` reverted on release and the seller
   * could never be paid. parseUnits also avoids the float rounding that
   * `Math.round(amt * 1e18)` introduced for values like 0.1.
   */
  const addMilestone = () => {
    setMsError('');
    const raw = msAmount.trim();
    let units: bigint;
    try {
      units = parseUnits(raw, tokenDecimals);
    } catch {
      setMsError(`Enter a valid ${tokenInfo.symbol} amount (max ${tokenDecimals} decimal places).`);
      return;
    }
    if (units <= 0n) {
      setMsError('Amount must be greater than zero.');
      return;
    }
    const alreadyAllocated = milestones.reduce((s: bigint, m: any) => s + BigInt(m.amount || 0), 0n);
    const dealTotal = deal.totalValue ? BigInt(String(deal.totalValue)) : 0n;
    if (dealTotal > 0n && alreadyAllocated + units > dealTotal) {
      const left = formatUnits(dealTotal - alreadyAllocated, tokenDecimals);
      setMsError(`Only ${left} ${tokenInfo.symbol} of the deal total is left to allocate.`);
      return;
    }
    deal.addMilestone(msTitle, msDesc, units, BigInt(Math.floor(Date.now() / 1000) + 30 * 86400));
    setMsTitle(''); setMsDesc(''); setMsAmount(''); setActiveForm(null);
  };

  const milestones = (deal.milestones || []) as any[];
  const dispute = (deal.dispute || {}) as { buyerApproved?: boolean; sellerApproved?: boolean };

  const loadVerification = async (index: number, ms: any) => {
    if (!dealAddr || !ms?.evidenceHash || verifications[index] || verifying === index) return;
    try {
      setVerifying((v) => (v === null ? index : v));
      const res = await fetch(`/api/escrow-verify?dealAddress=${encodeURIComponent(dealAddr)}&milestoneId=${index}`);
      const json = await res.json();
      if (json.verification) setVerifications((v) => ({ ...v, [index]: json.verification }));
    } catch {
      /* ignore */
    } finally {
      setVerifying((v) => (v === index ? null : v));
    }
  };

  const runAiVerify = async (index: number, ms: any) => {
    if (!dealAddr || verifying === index) return;
    setVerifying(index);
    try {
      const res = await fetch('/api/escrow-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dealAddress: dealAddr,
          milestoneId: index,
          title: String(ms.title || `Milestone ${index + 1}`),
          description: String(ms.description || ''),
          evidenceHash: String(ms.evidenceHash || ''),
        }),
      });
      const json = await res.json();
      if (json.verification) setVerifications((v) => ({ ...v, [index]: json.verification }));
    } catch {
      /* ignore */
    } finally {
      setVerifying(null);
    }
  };

  useEffect(() => {
    milestones.forEach((ms: any, i: number) => {
      if (Number(ms.msStatus) === 2 && ms.evidenceHash) loadVerification(i, ms);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [milestones, dealAddr]);
  const tokenInfo = getTokenInfo(chainKeyForId(chainId), String(deal.asset || ZERO));
  const tokenDecimals = tokenInfo.decimals;
  const total = deal.totalValue ? Number(deal.totalValue) / 10 ** tokenDecimals : 0;
  const escrowed = deal.escrowBalance ? Number(deal.escrowBalance) / 10 ** tokenDecimals : 0;
  const fullyFunded = escrowed >= total && total > 0;
  const isTokenDeal = String(deal.asset || ZERO) !== ZERO;
  const msStatusLabels = ['Pending', 'In Progress', 'Completed', 'Approved', 'Rejected'];

  const txPending = deal.isPending;

  /** Why this deal offers no milestone actions, in the deal's own terms. */
  const statusIsWhyText = (() => {
    switch (statusNum) {
      case 0:
        return 'it was never activated, so no funds or milestones can move.';
      case 2:
        return 'it has settled. Escrow was released or refunded, and the contract accepts no further actions.';
      case 3:
        return isBuyer || isSeller
          ? 'escrow is frozen while the dispute is open. Milestone actions resume only if the dispute is resolved — use the dispute panel below.'
          : 'escrow is frozen while the dispute is open, and only the buyer, seller or admin can resolve it.';
      case 4:
        return 'it was cancelled and any escrowed funds were refunded to the buyer.';
      default:
        return 'the contract only accepts party actions while a deal is Active.';
    }
  })();

  const dealRefetchAll = deal.refetchAll;
  useEffect(() => {
    if (factory.txReceipt.isSuccess && factory.txReceipt.data?.transactionHash) {
      dealRefetchAll();
    }
  }, [factory.txReceipt.isSuccess, factory.txReceipt.data?.transactionHash, dealRefetchAll]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Smart Escrow</h1>
        <p className="text-zinc-400 text-sm mt-1">Manage and monitor your on-chain escrowed transactions.</p>
      </div>

      <ChainGuard what="the escrow contracts are" />

      {!address ? (
        <Card>
          <CardContent className="p-12 text-center text-zinc-500">Connect your wallet to view escrows.</CardContent>
        </Card>
      ) : !onSupportedChain ? (
        <Card>
          <CardContent className="p-12 text-center text-zinc-500">
            Switch your wallet to Ethereum Sepolia to load your escrows. Your deals are not lost — they live on Sepolia.
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-20"><Loader2 size={24} className="animate-spin text-blue-400" /></div>
      ) : dedupedDeals.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center text-zinc-500">No deals found for this wallet. Create a deal first.</CardContent>
        </Card>
      ) : (
        <div className="grid lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="font-mono text-sm">{shortenAddress(dealAddr || '')}</CardTitle>
                  <CardDescription>
                    {currentDeal ? `${shortenAddress(String(deal.buyer || ''))} → ${shortenAddress(String(deal.seller || ''))}` : ''}
                  </CardDescription>
                </div>
                <Badge variant={statusNum === 1 ? 'info' : statusNum === 2 ? 'success' : statusNum === 3 ? 'destructive' : 'secondary'}>
                  {['Draft', 'Active', 'Completed', 'Disputed', 'Cancelled'][statusNum] || 'Other'}
                </Badge>
                {isAdmin && supportsForceResolve && <Badge variant="secondary" className="text-[10px]">Admin</Badge>}
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between mb-6 p-4 rounded-xl bg-zinc-800/30 border border-zinc-800/50">
                <div>
                  <div className="text-xs text-zinc-500 mb-1">Total Value</div>
                  <div className="text-2xl font-bold text-white">{total ? `${fmtNum(total)} ${tokenInfo.symbol}` : '-'}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-zinc-500 mb-1">Escrow Balance</div>
                  <div className={cn('text-2xl font-bold', escrowed >= total && total > 0 ? 'text-green-400' : 'text-amber-400')}>
                    {escrowed ? `${fmtNum(escrowed)} ${tokenInfo.symbol}` : `0 ${tokenInfo.symbol}`}
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-blue-400/10">
                  <Lock size={24} className="text-blue-400" />
                </div>
              </div>

              {statusNum === 1 && isBuyer && !fullyFunded && (
                <div className="mb-4 p-3 rounded-xl bg-amber-600/10 border border-amber-500/20 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-amber-300">
                    Escrow is not fully funded yet ({fmtNum(escrowed)} / {fmtNum(total)} {tokenInfo.symbol}). Fund the full total value to lock the deal.
                  </p>
                  {!isTokenDeal ? (
                    <Button size="sm" className="gap-1.5" onClick={() => deal.fundEscrow(BigInt(String(deal.totalValue)))} disabled={txPending}>
                      {txPending ? <><Loader2 size={14} className="animate-spin" /> Funding...</> : <><Send size={14} /> Fund Escrow (ETH)</>}
                    </Button>
                  ) : (
                    <p className="text-xs text-zinc-400">{tokenInfo.symbol} deals need token approval — fund from the deal page first.</p>
                  )}
                </div>
              )}

              {/* Why is nothing clickable? Every party action on the deal contract is
                  guarded by `inStatus(Active)`, so outside that status the page used to
                  simply render no buttons and no explanation — indistinguishable from
                  the app being broken. */}
              {statusNum !== 1 && (
                <div className="mb-4 p-3 rounded-xl bg-zinc-800/40 border border-zinc-700/60">
                  <p className="text-xs text-zinc-300 flex items-start gap-1.5">
                    <AlertTriangle size={13} className="text-zinc-400 shrink-0 mt-0.5" />
                    <span>
                      This deal is <span className="text-white font-medium">{dealStatusLabel(statusNum)}</span> — {statusIsWhyText}
                    </span>
                  </p>
                </div>
              )}

              {statusNum === 1 && !isBuyer && !isSeller && (
                <div className="mb-4 p-3 rounded-xl bg-zinc-800/40 border border-zinc-700/60">
                  <p className="text-xs text-zinc-300 flex items-start gap-1.5">
                    <AlertTriangle size={13} className="text-zinc-400 shrink-0 mt-0.5" />
                    <span>
                      You are neither the buyer nor the seller on this deal, so it is read-only for this wallet.
                      Connected as {shortenAddress(String(address || ''))}.
                    </span>
                  </p>
                </div>
              )}

              <h3 className="text-sm font-medium text-white mb-3">Milestones</h3>
              <div className="space-y-3">
                {milestones.length === 0 ? (
                  statusNum === 1 ? (
                    /* An Active deal with no milestones is a dead end, not an empty
                       list: `approveMilestone` is the only path that releases escrow
                       to the seller, and it needs a milestone to approve. */
                    <div className="p-3 rounded-xl bg-amber-600/10 border border-amber-500/25">
                      <p className="text-xs text-amber-300 flex items-start gap-1.5">
                        <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                        <span>
                          No milestones yet — funds cannot be released. Releasing escrow only happens by approving a
                          milestone, so {isBuyer ? 'add at least one below' : 'the buyer must add at least one'} before
                          any payment can reach the seller.
                          {!isBuyer && ' Once a milestone exists, the Start Work and Submit options will appear here for you.'}
                          {escrowed > 0 && isBuyer ? ' Until then the escrowed funds are only recoverable by cancelling the deal.' : ''}
                        </span>
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-zinc-500 text-center py-4">No milestones were added to this deal.</p>
                  )
                ) : (
                  milestones.map((ms: any, i: number) => {
                    const st = Number(ms.msStatus);
                    const isCurrent = i === Number(deal.currentMilestone);
                    return (
                      <div
                        key={i}
                        className={cn(
                          'p-4 rounded-xl border transition-all',
                          isCurrent ? 'border-blue-500/30 bg-blue-600/5' :
                          st === 3 ? 'border-green-500/20 bg-green-600/5' :
                          'border-zinc-700/50 bg-zinc-800/30'
                        )}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className={cn(
                              'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold',
                              st === 3 ? 'bg-green-400/20 text-green-400' :
                              st === 1 ? 'bg-blue-400/20 text-blue-400' :
                              'bg-zinc-700/50 text-zinc-500'
                            )}>
                              {i + 1}
                            </div>
                            <div>
                              <span className="text-sm font-medium text-white">{ms.title || `Milestone ${i + 1}`}</span>
                              <span className="text-xs text-zinc-500 ml-2">{ms.amount ? `${fmtNum(Number(ms.amount) / 10 ** tokenDecimals)} ${tokenInfo.symbol}` : ''}</span>
                            </div>
                          </div>
                          <Badge variant={st === 3 ? 'success' : st === 1 ? 'info' : st === 0 ? 'secondary' : 'destructive'} className="text-[10px]">
                            {msStatusLabels[st] || 'Pending'}
                          </Badge>
                        </div>
                        <p className="text-xs text-zinc-500 ml-9">{ms.description || ''}</p>

                        {st === 2 && ms.evidenceHash && (
                          <div className="ml-9 mt-2 space-y-2">
                            <div className="flex items-center gap-1.5 text-xs text-blue-400">
                              <FileText size={11} />
                              {evidenceUrl(String(ms.evidenceHash)) ? (
                                <a
                                  href={evidenceUrl(String(ms.evidenceHash)) as string}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="font-mono break-all underline underline-offset-2 hover:text-blue-300 transition-colors"
                                >
                                  {String(ms.evidenceHash).length > 60
                                    ? `${String(ms.evidenceHash).substring(0, 60)}...`
                                    : String(ms.evidenceHash)}
                                </a>
                              ) : (
                                <span className="font-mono break-all">{ms.evidenceHash}</span>
                              )}
                              {evidenceUrl(String(ms.evidenceHash)) && (
                                <ExternalLink size={10} className="shrink-0" />
                              )}
                            </div>
                            {verifications[i] ? (
                              <div
                                className={cn(
                                  'p-2.5 rounded-lg border',
                                  verifications[i].verified ? 'border-emerald-500/25 bg-emerald-600/10' : 'border-amber-500/25 bg-amber-600/10'
                                )}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className={cn('text-xs font-semibold flex items-center gap-1', verifications[i].verified ? 'text-emerald-400' : 'text-amber-400')}>
                                    <Sparkles size={12} /> AI Verifier
                                  </span>
                                  <span className="flex items-center gap-2">
                                    <span className="text-xs font-bold text-white">{verifications[i].completionPct}% complete</span>
                                    <Badge variant={verifications[i].verified ? 'success' : 'destructive'} className="text-[10px]">
                                      {verifications[i].recommendation === 'approve' ? 'Ready to release' : 'Needs revision'}
                                    </Badge>
                                  </span>
                                </div>
                                <p className="text-xs text-zinc-300 mt-1">{verifications[i].summary}</p>
                                {Array.isArray(verifications[i].notes) && verifications[i].notes.length > 0 && (
                                  <ul className="mt-1.5 space-y-0.5">
                                    {verifications[i].notes.map((n: string, j: number) => (
                                      <li key={j} className="text-[11px] text-zinc-500 flex items-center gap-1">
                                        <ArrowRight size={9} className="shrink-0" /> {n}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-1.5 text-violet-400 border-violet-500/30 hover:bg-violet-500/10"
                                disabled={verifying === i}
                                onClick={() => runAiVerify(i, ms)}
                              >
                                {verifying === i ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                                {verifying === i ? 'Analyzing evidence...' : 'AI Verify Work'}
                              </Button>
                            )}
                          </div>
                        )}

                        {statusNum === 1 && (
                          <div className="ml-9 mt-3 flex flex-wrap gap-2">
                            {st === 0 && isSeller && (
                              <>
                                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => deal.startMilestone(BigInt(i))} disabled={txPending || !!autoSubmit}>
                                  {txPending ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Start Work
                                </Button>
                                {evidence ? (
                                  <Button size="sm" className="gap-1.5" onClick={() => startAndSubmit(i, evidence)} disabled={txPending || !!autoSubmit}>
                                    {txPending || autoSubmit ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Start & Submit with Evidence
                                  </Button>
                                ) : (
                                  <Button size="sm" className="gap-1.5" onClick={() => startAndSubmit(i, '')} disabled={txPending || !!autoSubmit}>
                                    {txPending || autoSubmit ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Start & Submit Work
                                  </Button>
                                )}
                                <Input
                                  value={evidence}
                                  onChange={(e) => setEvidence(e.target.value)}
                                  placeholder="Evidence hash / link (optional)"
                                  className="w-52 text-xs"
                                />
                              </>
                            )}
                            {st === 1 && isSeller && (
                              <>
                                {evidence ? (
                                  <Button size="sm" className="gap-1.5" onClick={() => submitWork(i, evidence)} disabled={txPending}>
                                    {txPending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Submit with Evidence
                                  </Button>
                                ) : (
                                  <Button size="sm" className="gap-1.5" onClick={() => submitWork(i, 'ipfs://' + Math.random().toString(36).slice(2, 10))} disabled={txPending}>
                                    {txPending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Submit Work
                                  </Button>
                                )}
                                <Input
                                  value={evidence}
                                  onChange={(e) => setEvidence(e.target.value)}
                                  placeholder="Evidence hash / link (optional)"
                                  className="w-52 text-xs"
                                />
                              </>
                            )}
                            {st === 2 && isBuyer && (
                              <>
                                <Button size="sm" className="gap-1.5 bg-green-600 hover:bg-green-500" onClick={() => approveAndRelease(i, ms.amount, ms.amount ? `${fmtNum(Number(ms.amount) / 10 ** tokenDecimals)} ${tokenInfo.symbol}` : '')} disabled={txPending}>
                                  {txPending ? <Loader2 size={13} className="animate-spin" /> : <ThumbsUp size={13} />} Approve & Release
                                </Button>
                                <Button size="sm" variant="outline" className="gap-1.5 text-amber-400 border-amber-500/30 hover:bg-amber-500/10" onClick={() => deal.requestRevision(BigInt(i))} disabled={txPending}>
                                  <RotateCcw size={13} /> Request Revision
                                </Button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {statusNum === 1 && isBuyer && (
                <div className="mt-4">
                  {activeForm === 'ms' ? (
                    <div className="p-3 rounded-xl bg-zinc-800/40 border border-zinc-700/60 space-y-2">
                      <p className="text-xs text-zinc-400 font-medium">Add Milestone</p>
                      <Input value={msTitle} onChange={(e) => setMsTitle(e.target.value)} placeholder="Title (e.g. Landing page design)" className="text-xs" />
                      <Input value={msDesc} onChange={(e) => setMsDesc(e.target.value)} placeholder="Description" className="text-xs" />
                      <Input value={msAmount} onChange={(e) => { setMsAmount(e.target.value); setMsError(''); }} placeholder={`Amount in ${tokenInfo.symbol} (remaining: ${fmtNum(total - escrowed)})`} type="number" step="any" className="text-xs" />
                      {msError && (
                        <p className="text-xs text-red-400 flex items-center gap-1"><XCircle size={11} /> {msError}</p>
                      )}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          className="gap-1.5 flex-1"
                          disabled={txPending || !msTitle || !msAmount}
                          onClick={addMilestone}
                        >
                          <Plus size={13} /> Add Milestone
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => { setActiveForm(null); setMsError(''); }} disabled={txPending}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setActiveForm('ms')}>
                      <Plus size={13} /> Add Milestone
                    </Button>
                  )}
                </div>
              )}

              {statusNum === 1 && (isBuyer || isSeller) && (
                <div className="mt-4">
                  {disputeFormOpen ? (
                    <div className="p-3 rounded-xl bg-red-950/30 border border-red-500/30 space-y-2">
                      <p className="text-xs text-red-300 font-medium">Open a dispute — escrow stays locked until resolved.</p>
                      <Input value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)} placeholder="Reason for dispute" className="text-xs" />
                      <div className="flex gap-2">
                        <Button size="sm" variant="destructive" className="gap-1.5" disabled={txPending || !disputeReason.trim()} onClick={() => { deal.openDispute(disputeReason.trim()); setDisputeReason(''); setDisputeFormOpen(false); }}>
                          {txPending ? <Loader2 size={13} className="animate-spin" /> : <AlertTriangle size={13} />} Open Dispute
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => { setDisputeReason(''); setDisputeFormOpen(false); }}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <Button size="sm" variant="outline" className="gap-1.5 text-red-400 border-red-500/30 hover:bg-red-500/10" onClick={() => setDisputeFormOpen(true)}>
                      <AlertTriangle size={13} /> Open Dispute
                    </Button>
                  )}
                </div>
              )}

              {isDisputed && (isBuyer || isSeller) && (
                <div className="mt-4 p-3 rounded-xl bg-red-950/30 border border-red-500/30 space-y-2">
                  <p className="text-xs text-red-300 font-medium">Dispute active — both sides must approve, then execute a resolution.</p>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="text-zinc-400">Buyer approved: {String(!!dispute.buyerApproved)}</span>
                    <span className="text-zinc-400">Seller approved: {String(!!dispute.sellerApproved)}</span>
                  </div>
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => deal.approveDisputeResolution()} disabled={txPending}>
                    <CheckCircle size={13} /> {isBuyer === isSeller ? 'Approve (both sides)' : isBuyer ? 'Approve as Buyer' : 'Approve as Seller'}
                  </Button>
                  <Separator className="bg-red-500/20" />
                  <p className="text-xs text-zinc-400">Resolution — releases escrow to the chosen side:</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      className="gap-1.5 bg-green-600 hover:bg-green-500"
                      disabled={txPending || !(dispute.buyerApproved && dispute.sellerApproved)}
                      onClick={() => { deal.executeDisputeResolution('release_to_seller'); }}
                    >
                      <Send size={13} /> Release to Seller
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={txPending || !(dispute.buyerApproved && dispute.sellerApproved)}
                      onClick={() => { deal.executeDisputeResolution('refund_buyer'); }}
                    >
                      <RotateCcw size={13} /> Refund Buyer
                    </Button>
                  </div>
                  {isAdmin && supportsForceResolve && (
                    <>
                      <Separator className="bg-red-500/20" />
                      <p className="text-xs text-amber-300 font-medium flex items-center gap-1">
                        <Gavel size={12} /> Admin override — resolves without party approval:
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
                          disabled={factory.isPending}
                          onClick={() => { factory.forceResolve(dealAddr as `0x${string}`, 'release_to_seller'); }}
                        >
                          {factory.isPending ? <Loader2 size={13} className="animate-spin" /> : <Gavel size={13} />} Force Release to Seller
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
                          disabled={factory.isPending}
                          onClick={() => { factory.forceResolve(dealAddr as `0x${string}`, 'refund_buyer'); }}
                        >
                          {factory.isPending ? <Loader2 size={13} className="animate-spin" /> : <Gavel size={13} />} Force Refund Buyer
                        </Button>
                      </div>
                      {factory.txReceipt.isError && (
                        <p className="text-xs text-red-400 flex items-center gap-1"><XCircle size={12} /> Admin transaction failed.</p>
                      )}
                    </>
                  )}
                </div>
              )}

              {deal.txReceipt.isSuccess && (
                <p className="mt-3 text-xs text-green-400 flex items-center gap-1"><CheckCircle size={12} /> Transaction confirmed on-chain!</p>
              )}
              {deal.txReceipt.isError && (
                <p className="mt-3 text-xs text-red-400 flex items-center gap-1"><XCircle size={12} /> Transaction failed.</p>
              )}

              <div className="mt-4 p-3 rounded-lg bg-blue-600/10 border border-blue-500/20">
                <div className="flex items-center gap-2 text-sm text-blue-400 mb-1">
                  <ShieldCheck size={14} />
                  AI Escrow Agent
                </div>
                <p className="text-sm text-zinc-300">
                  Funds stay locked in the deal contract. Milestone approval releases only that portion to the seller — the rest stays protected until the next approval or the deal completes.
                </p>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Your Deals</CardTitle>
                <CardDescription>Select a deal to view escrow</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 max-h-[260px] overflow-y-auto">
                {sortedDeals.map((d: any, i: number) => {
                  const st = listStatuses[String(d.dealAddress).toLowerCase()];
                  return (
                    <button
                      key={d.dealAddress}
                      onClick={() => { setSelectedDeal(i); setEvidence(''); setDisputeReason(''); setDisputeFormOpen(false); setActiveForm(null); }}
                      className={`w-full p-3 rounded-lg border text-left transition-all ${
                        i === selectedDeal
                          ? 'border-blue-500/70 bg-blue-600/15 shadow-md shadow-blue-500/20'
                          : 'border-zinc-800/50 bg-zinc-800/30 hover:border-zinc-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className={`text-xs font-mono truncate ${i === selectedDeal ? 'text-blue-300 font-semibold' : 'text-zinc-400'}`}>{shortenAddress(d.dealAddress)}</div>
                        <Badge
                          variant={st === 1 ? 'info' : st === 2 ? 'success' : st === 3 ? 'destructive' : 'secondary'}
                          className="text-[10px] shrink-0"
                        >
                          {dealStatusLabel(st)}
                        </Badge>
                      </div>
                      <div className="text-xs text-zinc-500 mt-1">
                        {d.totalValue ? `${fmtNum(Number(formatUnits(BigInt(d.totalValue), getTokenInfo(chainKeyForId(chainId), String(d.asset || ZERO)).decimals)))} ${getTokenInfo(chainKeyForId(chainId), String(d.asset || ZERO)).symbol}` : '-'}
                      </div>
                    </button>
                  );
                })}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Contract Info</CardTitle>
                <CardDescription>On-chain deal data</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-zinc-400">Status</span>
                  <span className="text-white">{['Draft', 'Active', 'Completed', 'Disputed', 'Cancelled'][statusNum] || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Balance</span>
                  <span className="text-white">{escrowed ? `${fmtNum(escrowed)} ${tokenInfo.symbol}` : `0 ${tokenInfo.symbol}`}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Milestones</span>
                  <span className="text-white">{milestones.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Buyer</span>
                  <span className="text-white font-mono text-xs">
                    {isBuyer ? 'You' : deal.buyer ? shortenAddress(String(deal.buyer)) : '-'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Seller</span>
                  <span className="text-white font-mono text-xs">
                    {isSeller ? 'You' : deal.seller ? shortenAddress(String(deal.seller)) : '-'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">You</span>
                  <span className="text-white font-mono text-xs">
                    {isBuyer ? <Badge variant="info" className="text-[10px]">Buyer</Badge> : isSeller ? <Badge variant="secondary" className="text-[10px]">Seller</Badge> : '-'}
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}