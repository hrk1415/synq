'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ArrowLeft, Shield, Clock, CheckCircle, AlertTriangle, Bot, MessageSquare, ExternalLink, Loader2, Wallet as WalletIcon, KeyRound, Ban, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import { useDealContract } from '@/hooks/useDealContract';
import { useAccount, useChainId, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatCurrency, shortenAddress, cn, evidenceUrl } from '@/lib/utils';
import { getTokenInfo, chainKeyForId } from '@/lib/contracts/addresses';

const dealStatusLabels = ['Draft', 'Active', 'Completed', 'Disputed', 'Cancelled'];
const msStatusLabels = ['Pending', 'In Progress', 'Completed', 'Approved', 'Rejected'];

const ZERO = '0x0000000000000000000000000000000000000000';

export default function DealDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { address } = useAccount();
  const chainId = useChainId();
  const dealAddress = (params.id as string) as `0x${string}`;
  const deal = useDealContract(dealAddress);
  const [actionError, setActionError] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelNotifyTo, setCancelNotifyTo] = useState<string | null>(null);
  const [cancelNotifyRole, setCancelNotifyRole] = useState<string>('seller');
  const cancelHashRef = useRef<string | null>(null);

  // The receipt hook stays isSuccess for older txs, so wait for a NEW hash
  // before emailing — otherwise a previous transaction would trigger it.
  useEffect(() => {
    if (!cancelNotifyTo || !deal.txReceipt.isSuccess) return;
    const hash = deal.txReceipt.data?.transactionHash ? String(deal.txReceipt.data.transactionHash) : null;
    if (hash && hash !== cancelHashRef.current) {
      const recipient = cancelNotifyTo;
      const role = cancelNotifyRole;
      setCancelNotifyTo(null);
      cancelHashRef.current = null;
      fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'deal_cancelled',
          recipientWallet: recipient,
          recipientName: role,
          dealTitle: String(deal.title || ''),
          dealAmount: deal.totalValue ? fmt(deal.totalValue) : '',
        }),
      }).catch(() => {});
    }
  }, [cancelNotifyTo, cancelNotifyRole, deal.txReceipt.isSuccess, deal.txReceipt.data, deal.title, deal.totalValue]);

  const tokenApprove = useWriteContract();
  const approveReceipt = useWaitForTransactionReceipt({ hash: tokenApprove.data });

  const assetAddress = String(deal.asset || ZERO);
  const token = getTokenInfo(chainKeyForId(chainId), assetAddress);
  const isToken = assetAddress !== ZERO;
  const isBuyer = !!address && !!deal.buyer && address.toLowerCase() === String(deal.buyer).toLowerCase();
  const isSeller = !!address && !!deal.seller && address.toLowerCase() === String(deal.seller).toLowerCase();
  const isParty = isBuyer || isSeller;
  const isActive = Number(deal.status) === 1;
  const funded = !!deal.escrowBalance && !!deal.totalValue && BigInt(String(deal.escrowBalance)) >= BigInt(String(deal.totalValue));
  const approveRequired = isToken && isBuyer && isActive && !funded;

  const fmt = (raw: unknown) => {
    if (!raw) return '0 ' + token.symbol;
    const v = Number(raw) / 10 ** token.decimals;
    return formatCurrency(v) + ' ' + token.symbol;
  };

  if (deal.title === undefined && !deal.isPending) {
    return (
      <div className="text-center py-20">
        <AlertTriangle size={40} className="mx-auto text-amber-400 mb-4" />
        <h2 className="text-xl font-bold text-white mb-2">Deal Not Found</h2>
        <p className="text-zinc-400 text-sm mb-4">The deal at address {shortenAddress(dealAddress)} doesn't exist or has no data.</p>
        <Button onClick={() => router.push('/deals')}>Back to Deals</Button>
      </div>
    );
  }

  if (deal.isPending || deal.title === undefined) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-blue-400" />
      </div>
    );
  }

  const msList = (deal.milestones || []) as any[];
  const progress = msList.length > 0
    ? Math.round(msList.filter((m: any) => m.msStatus === 3).length / msList.length * 100)
    : 0;

  return (
    <div className="space-y-6">
      <button onClick={() => router.back()} className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors">
        <ArrowLeft size={16} /> Back to Deals
      </button>

      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono text-zinc-500">{shortenAddress(dealAddress)}</span>
            <Badge variant={Number(deal.status) === 2 ? 'success' : Number(deal.status) === 1 ? 'info' : 'secondary'}>
              {dealStatusLabels[Number(deal.status)] || 'Unknown'}
            </Badge>
          </div>
          <h1 className="text-2xl font-bold text-white">{String(deal.title || 'Untitled Deal')}</h1>
          <p className="text-zinc-400 text-sm mt-1">{String(deal.description || '')}</p>
        </div>
        <div className="text-right">
          <div className="text-3xl font-bold text-white">{fmt(deal.totalValue)}</div>
          <div className="text-xs text-zinc-500 mt-1">Deadline: {deal.deadline ? new Date(Number(deal.deadline) * 1000).toLocaleDateString() : 'N/A'}</div>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Milestones</CardTitle>
            <CardDescription>{progress}% complete</CardDescription>
          </CardHeader>
          <CardContent>
            <Progress value={progress} className="mb-4" />
            {msList.length === 0 ? (
              <p className="text-sm text-zinc-500 text-center py-4">No milestones added yet.</p>
            ) : (
              <div className="space-y-3">
                {msList.map((ms: any, i: number) => (
                  <div
                    key={i}
                    className={cn(
                      'p-4 rounded-xl border transition-all',
                      ms.msStatus === 3 ? 'border-green-500/20 bg-green-600/5' :
                      ms.msStatus === 1 ? 'border-blue-500/30 bg-blue-600/5' :
                      'border-zinc-700/50 bg-zinc-800/30'
                    )}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className={cn(
                          'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold',
                          ms.msStatus === 3 ? 'bg-green-400/20 text-green-400' :
                          ms.msStatus === 1 ? 'bg-blue-400/20 text-blue-400' :
                          'bg-zinc-700/50 text-zinc-500'
                        )}>
                          {i + 1}
                        </div>
                        <span className="text-sm font-medium text-white">{ms.title || `Milestone ${i + 1}`}</span>
                        <span className="text-xs text-zinc-500">{ms.amount ? fmt(ms.amount) : ''}</span>
                      </div>
                      <Badge variant={ms.msStatus === 3 ? 'success' : ms.msStatus === 1 ? 'info' : 'secondary'} className="text-[10px]">
                        {msStatusLabels[ms.msStatus] || 'Pending'}
                      </Badge>
                    </div>
                    <p className="text-xs text-zinc-500 ml-9">{ms.description || ''}</p>
                    {ms.evidenceHash && (
                      <div className="ml-9 mt-2 flex items-center gap-1 text-xs text-blue-400">
                        <CheckCircle size={10} />
                        {evidenceUrl(String(ms.evidenceHash)) ? (
                          <a
                            href={evidenceUrl(String(ms.evidenceHash)) as string}
                            target="_blank"
                            rel="noreferrer"
                            className="underline underline-offset-2 hover:text-blue-300 transition-colors break-all"
                          >
                            {String(ms.evidenceHash).length > 40
                              ? `${String(ms.evidenceHash).substring(0, 40)}...`
                              : String(ms.evidenceHash)}
                          </a>
                        ) : (
                          <span className="break-all">{ms.evidenceHash.substring(0, 40)}...</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Deal Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-zinc-400">Buyer</span><span className="text-white">{isBuyer ? 'You' : 'Buyer'}</span></div>
              <div className="flex justify-between"><span className="text-zinc-400">Seller</span><span className="text-white">{!isBuyer && address ? 'You' : 'Seller'}</span></div>
              <div className="flex justify-between"><span className="text-zinc-400">Protection</span><Badge variant={deal.protectionEnabled ? 'info' : 'secondary'} className="text-[10px]">{deal.protectionEnabled ? 'Enabled' : 'Disabled'}</Badge></div>
              <div className="flex justify-between"><span className="text-zinc-400">Risk Score</span><span className="text-white">{String(deal.riskScore || '0')}/100</span></div>
              <div className="flex justify-between"><span className="text-zinc-400">Escrow Balance</span><span className="text-white">{fmt(deal.escrowBalance)}</span></div>
              <div className="flex justify-between"><span className="text-zinc-400">Asset</span><Badge variant={isToken ? 'info' : 'secondary'} className="text-[10px]">{token.symbol}{isToken ? ' (ERC-20)' : ' (native)'}</Badge></div>
              <Separator />
              <div className="flex justify-between"><span className="text-zinc-400">Current Ms</span><span className="text-white">{String(deal.currentMilestone || '0')}</span></div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {isActive && isBuyer && !funded && (
                <>
                  {isToken && (
                    <Button
                      className="w-full justify-start gap-2"
                      size="sm"
                      variant="outline"
                      disabled={tokenApprove.isPending || approveReceipt.isSuccess}
                      onClick={() => {
                        setActionError('');
                        tokenApprove.writeContract({
                          address: assetAddress as `0x${string}`,
                          abi: [{ inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], name: 'approve', outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable', type: 'function' } as const],
                          functionName: 'approve',
                          args: [dealAddress, BigInt(String(deal.totalValue))],
                        });
                      }}
                    >
                      {(tokenApprove.isPending || approveReceipt.isLoading) ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                      {approveReceipt.isSuccess ? 'Approved — done' : `Approve ${token.symbol} for escrow`}
                    </Button>
                  )}
                  <Button
                    className="w-full justify-start gap-2"
                    size="sm"
                    disabled={deal.isPending || (isToken && !approveReceipt.isSuccess) || (deal.isPending && approveReceipt.isLoading)}
                    onClick={() => {
                      setActionError('');
                      if (isToken) {
                        deal.fundEscrow(BigInt(0));
                      } else {
                        deal.fundEscrow(BigInt(String(deal.totalValue)));
                      }
                    }}
                  >
                    {deal.isPending ? <Loader2 size={14} className="animate-spin" /> : <WalletIcon size={14} />}
                    {deal.isPending ? 'Funding...' : `Fund Escrow (${fmt(deal.totalValue)})`}
                  </Button>
                </>
              )}
              {isActive && isBuyer && funded && (
                <div className="p-2 rounded-lg bg-green-600/10 border border-green-500/20 text-xs text-green-400 flex items-center gap-1.5">
                  <CheckCircle size={12} /> Escrow funded and locked
                </div>
              )}
              <Button className="w-full justify-start gap-2" size="sm" disabled><MessageSquare size={14} /> View Escrow</Button>
              <Button className="w-full justify-start gap-2" size="sm" variant="outline" disabled><Shield size={14} /> View Protection</Button>
              <Button className="w-full justify-start gap-2" size="sm" variant="outline" disabled><Bot size={14} /> AI Analysis</Button>
              <Separator />
              {isParty && isActive && (
                <Button
                  className="w-full justify-start gap-2"
                  size="sm"
                  variant="destructive"
                  disabled={deal.isPending}
                  onClick={() => { setActionError(''); setConfirmCancel(true); }}
                >
                  {deal.isPending ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />}
                  {deal.isPending ? 'Cancelling...' : 'Cancel Deal'}
                </Button>
              )}
              {deal.txReceipt.isSuccess && (
                <div className="p-2 rounded-lg bg-green-600/10 border border-green-500/20 text-xs text-green-400 flex items-center gap-1.5">
                  <CheckCircle size={12} /> Transaction confirmed
                </div>
              )}

              {confirmCancel && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
                  onClick={() => setConfirmCancel(false)}
                >
                  <div className="w-full max-w-sm rounded-2xl border border-zinc-700/50 bg-zinc-900 shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2 mb-3">
                      <AlertTriangle size={18} className="text-red-400" />
                      <h3 className="font-semibold text-white">Cancel this deal?</h3>
                    </div>
                    <p className="text-sm text-zinc-400 mb-1">
                      {Number(deal.escrowBalance) > 0
                        ? `Any escrow balance (~${fmt(deal.escrowBalance)}) will be refunded back to the buyer's wallet.`
                        : 'The deal will be marked as Cancelled on-chain.'}
                    </p>
                    <p className="text-xs text-zinc-500 mb-4">This action cannot be undone. The {isBuyer ? 'seller' : 'buyer'} will see the deal as cancelled.</p>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" className="flex-1 gap-1" onClick={() => setConfirmCancel(false)} disabled={deal.isPending}>
                        <X size={14} /> Keep Deal
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="flex-1 gap-1"
                        disabled={deal.isPending}
                        onClick={() => {
                          setActionError('');
                          setConfirmCancel(false);
                          cancelHashRef.current = deal.txReceipt.data?.transactionHash ? String(deal.txReceipt.data.transactionHash) : null;
                          // Notify the counterparty (the other side of the deal).
                          const counterparty = isBuyer ? String(deal.seller || '') : String(deal.buyer || '');
                          const role = isBuyer ? 'seller' : 'buyer';
                          setCancelNotifyTo(counterparty);
                          setCancelNotifyRole(role);
                          deal.cancelDeal();
                        }}
                      >
                        {deal.isPending ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />}
                        {deal.isPending ? 'Cancelling...' : 'Yes, Cancel Deal'}
                      </Button>
                    </div>
                  </div>
                </motion.div>
              )}
            </CardContent>
          </Card>

          {actionError && (
            <div className="p-3 rounded-lg bg-red-600/10 border border-red-500/20 text-xs text-red-400">
              {actionError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
