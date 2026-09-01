'use client';

import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Wallet, CheckCircle, Bot, User, Loader2, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useAccount, useChainId, useSendTransaction, useWriteContract, useWaitForTransactionReceipt, useReadContract } from 'wagmi';
import { parseEther, parseUnits, isAddress } from 'viem';
import { erc20ABI } from '@/lib/contracts/abis';
import { getRegistryAddress, registryABI } from '@/hooks/useRegistryContract';
import { chainKeyForId } from '@/lib/contracts/addresses';
import { getExplorerUrl } from '@/lib/chain';
import { formatTimeAgo, cn } from '@/lib/utils';

const USDC_SEPOLIA = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as `0x${string}`;

interface PendingPayment {
  recipient: string;
  amount: number;
  asset: 'ETH' | 'USDC';
  reason: string;
}

interface SentPayment {
  id: string;
  recipient: string;
  amount: number;
  asset: string;
  txHash: string;
  timestamp: string;
}

const STORAGE_KEY = 'synq_payments';

interface PaymentAssistantProps {
  sellerAddress?: string | null;
  category?: string | null;
}

export default function PaymentAssistant({ sellerAddress, category }: PaymentAssistantProps) {
  const { address } = useAccount();
  const chainId = useChainId();
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [pending, setPending] = useState<PendingPayment | null>(null);
  const [resolvedAddress, setResolvedAddress] = useState<`0x${string}` | null>(null);
  const [messages, setMessages] = useState<{ role: string; content: string }[]>(
    sellerAddress ? [{ role: 'ai', content: `You are now connected with ${sellerAddress.slice(0,6)}...${sellerAddress.slice(-4)}. You can describe your project requirements here, and send payments directly in this chat.` }] : []
  );
  const [error, setError] = useState('');
  const [sentPayments, setSentPayments] = useState<SentPayment[]>([]);

  const isSupported = chainKeyForId(chainId) === 'sepolia' || chainKeyForId(chainId) === 'hardhat';
  const isEth = pending?.asset === 'ETH';
  const pendingRawAmount = useMemo(() => {
    if (!pending) return 0n;
    return isEth ? parseEther(String(pending.amount)) : parseUnits(String(pending.amount), 6);
  }, [pending, isEth]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setSentPayments(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);

  const persistPayments = (next: SentPayment[]) => {
    setSentPayments(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const recipientNeedsLookup = !!pending && !isAddress(pending.recipient) && pending.recipient !== 'unknown';
  const { data: usernameAddr } = useReadContract({
    address: getRegistryAddress(chainId),
    abi: registryABI,
    functionName: 'getAddress',
    args: recipientNeedsLookup ? [pending.recipient] : undefined,
    query: { enabled: recipientNeedsLookup },
  });

  useEffect(() => {
    if (pending && isAddress(pending.recipient)) {
      setResolvedAddress(pending.recipient as `0x${string}`);
      return;
    }
    if (pending && recipientNeedsLookup) {
      const addr = (usernameAddr || '0x0000000000000000000000000000000000000000') as `0x${string}`;
      setResolvedAddress(addr !== '0x0000000000000000000000000000000000000000' ? addr : null);
      return;
    }
    setResolvedAddress(null);
  }, [pending, usernameAddr, recipientNeedsLookup]);

  const ethTx = useSendTransaction();
  const tokenWrite = useWriteContract();
  const activeHash = (ethTx.data ?? tokenWrite.data) as `0x${string}` | undefined;
  const receipt = useWaitForTransactionReceipt({ hash: activeHash });

  useEffect(() => {
    if (receipt.isSuccess && pending && activeHash) {
      const payment: SentPayment = {
        id: activeHash,
        recipient: pending.recipient,
        amount: pending.amount,
        asset: pending.asset,
        txHash: activeHash,
        timestamp: new Date().toISOString(),
      };
      persistPayments([payment, ...sentPayments]);
      setMessages(prev => [...prev, {
        role: 'ai',
        content: `Payment of ${pending.amount} ${pending.asset} to ${pending.recipient} was sent and confirmed on-chain.`,
      }]);
      setPending(null);
      setResolvedAddress(null);
      setError('');
    }
  }, [receipt.isSuccess, activeHash, pending]);

  const handleSend = async () => {
    if (!input.trim() || isThinking) return;
    setMessages(prev => [...prev, { role: 'user', content: input }]);
    const userInput = input;
    setInput('');
    setIsThinking(true);
    setError('');
    setPending(null);
    setResolvedAddress(null);

    try {
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'chatpay', prompt: userInput }),
      });
      const data = await res.json();
      const parsed = data?.result;

      if (!parsed || !parsed.recipient || parsed.recipient === 'unknown' || parsed.amount <= 0) {
        setMessages(prev => [...prev, {
          role: 'ai',
          content: "I couldn't find a clear recipient and amount in your message. Try something like \"Send Alice 0.05 ETH\" or \"Pay 0x... 100 USDC\".",
        }]);
        setIsThinking(false);
        return;
      }

      setMessages(prev => [...prev, {
        role: 'ai',
        content: `Understood. I found: pay ${parsed.amount} ${parsed.asset} to "${parsed.recipient}". Review the details below and confirm to send the transaction from your wallet.`,
      }]);
      setPending({ recipient: parsed.recipient, amount: parsed.amount, asset: parsed.asset, reason: parsed.reason || '' });
    } catch {
      setMessages(prev => [...prev, {
        role: 'ai',
        content: 'Sorry, the payment assistant is unavailable right now. Please try again.',
      }]);
    }
    setIsThinking(false);
  };

  const handleConfirm = async () => {
    if (!pending || !resolvedAddress || !address) return;
    setError('');
    try {
      if (isEth) {
        await ethTx.sendTransaction({ to: resolvedAddress, value: pendingRawAmount });
      } else {
        await tokenWrite.writeContract({
          address: USDC_SEPOLIA,
          abi: erc20ABI,
          functionName: 'transfer',
          args: [resolvedAddress, pendingRawAmount],
        });
      }
    } catch (e: any) {
      setError(e?.shortMessage || e?.message || 'Transaction failed');
    }
  };

  const explorerUrl = activeHash ? getExplorerUrl(chainId, 'tx', activeHash) : null;
  const sending = ethTx.isPending || tokenWrite.isPending || receipt.isLoading;

  return (
    <div className="space-y-6">
      {!isSupported && (
        <div className="p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-sm text-amber-400 flex items-center gap-2">
          <AlertTriangle size={14} /> ChatPay works on the Sepolia testnet. Switch your wallet network to continue.
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>{sellerAddress ? 'Deal Workspace & Payments' : 'Payment Conversation'}</CardTitle>
                <CardDescription>{sellerAddress ? 'Discuss requirements and pay in one place.' : 'Tell Synq who to pay and why.'}</CardDescription>
              </div>
              <Badge variant="info"><Bot size={12} className="mr-1" /> ChatPay Active</Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="h-[400px] flex flex-col">
              <div className="flex-1 overflow-y-auto space-y-4 p-4">
                {messages.length === 0 && !pending && !sending && (
                  <div className="flex flex-col items-center justify-center h-full text-center py-12">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-green-500 to-blue-600 flex items-center justify-center mb-4">
                      <Wallet size={24} className="text-white" />
                    </div>
                    <p className="text-zinc-400 text-sm max-w-md">
                      {sellerAddress 
                        ? 'State your project requirements here. The seller will be notified, and you can send payments seamlessly.' 
                        : 'Tell Synq who to pay and why. Payments are real transactions from your wallet on Sepolia.'}
                    </p>
                  </div>
                )}

                <AnimatePresence>
                  {messages.map((msg, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={cn('flex gap-3', msg.role === 'user' ? 'justify-end' : 'justify-start')}
                    >
                      {msg.role === 'ai' && (
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-green-500 to-blue-600 flex items-center justify-center shrink-0">
                          <Bot size={16} className="text-white" />
                        </div>
                      )}
                      <div className={cn(
                        'max-w-[80%] rounded-2xl px-4 py-3 text-sm',
                        msg.role === 'user' ? 'bg-blue-600 text-white rounded-tr-md' : 'bg-zinc-800/50 border border-zinc-700/50 text-zinc-200 rounded-tl-md'
                      )}>
                        {msg.content}
                      </div>
                      {msg.role === 'user' && (
                        <div className="w-8 h-8 rounded-lg bg-zinc-700 flex items-center justify-center shrink-0">
                          <User size={16} className="text-zinc-300" />
                        </div>
                      )}
                    </motion.div>
                  ))}

                  {isThinking && (
                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex gap-3">
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-green-500 to-blue-600 flex items-center justify-center shrink-0">
                        <Bot size={16} className="text-white" />
                      </div>
                      <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-2xl rounded-tl-md px-4 py-3">
                        <div className="flex items-center gap-2 text-sm text-zinc-400">
                          <Loader2 size={14} className="animate-spin text-green-400" />
                          Analyzing your payment request...
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {sending && (
                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex gap-3">
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-green-500 to-blue-600 flex items-center justify-center shrink-0">
                        <Bot size={16} className="text-white" />
                      </div>
                      <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-2xl rounded-tl-md px-4 py-3">
                        <div className="flex items-center gap-2 text-sm text-zinc-400">
                          <Loader2 size={14} className="animate-spin text-green-400" />
                          Waiting for your wallet and network confirmation...
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {pending && !sending && (
                  <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="p-4 rounded-xl border border-zinc-700/50 bg-zinc-800/50">
                    <div className="flex items-center gap-2 mb-3">
                      <Wallet size={16} className="text-blue-400" />
                      <span className="text-sm font-medium text-white">Payment Confirmation</span>
                    </div>
                    <div className="space-y-2 text-sm mb-3">
                      <div className="flex justify-between"><span className="text-zinc-400">Recipient</span>
                        <span className="text-white text-right">
                          {pending.recipient}
                          {resolvedAddress && resolvedAddress.toLowerCase() !== pending.recipient.toLowerCase() && (
                            <span className="block text-[10px] font-mono text-zinc-500">{resolvedAddress}</span>
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between"><span className="text-zinc-400">Amount</span><span className="text-white font-semibold">{pending.amount} {pending.asset}</span></div>
                      {pending.reason && <div className="flex justify-between"><span className="text-zinc-400">For</span><span className="text-zinc-300 text-right">{pending.reason}</span></div>}
                      <div className="flex justify-between"><span className="text-zinc-400">Network</span><span className="text-zinc-300">{chainKeyForId(chainId) === 'sepolia' ? 'Ethereum Sepolia' : 'Hardhat Local'}</span></div>
                    </div>
                    {!resolvedAddress && recipientNeedsLookup && (
                      <p className="text-xs text-amber-400 mb-3 flex items-center gap-1">
                        <AlertTriangle size={12} /> Username "@{pending.recipient}" not found in the Synq registry. Make sure they have registered their unique ID.
                      </p>
                    )}
                    {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
                    <Separator className="mb-3" />
                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={handleConfirm} disabled={!resolvedAddress || !address} className="flex-1">Confirm & Send</Button>
                      <Button size="sm" variant="outline" onClick={() => { setPending(null); setResolvedAddress(null); }} className="flex-1">Cancel</Button>
                    </div>
                  </motion.div>
                )}

                {activeHash && receipt.isSuccess && (
                  <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="p-4 rounded-xl border border-green-500/20 bg-green-600/10">
                    <div className="flex items-center gap-2 mb-2">
                      <CheckCircle size={18} className="text-green-400" />
                      <span className="text-sm font-medium text-green-400">Transaction Confirmed</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                      <span className="font-mono">{activeHash.slice(0, 10)}...{activeHash.slice(-6)}</span>
                      <Badge variant="success" className="text-[10px]">Confirmed</Badge>
                      {explorerUrl && <a href={explorerUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">View on Etherscan ↗</a>}
                    </div>
                  </motion.div>
                )}
              </div>

              {!pending && !sending && (
                <div className="p-4 border-t border-zinc-800/50">
                  <div className="flex items-center gap-2 bg-zinc-800/50 border border-zinc-700/50 rounded-xl px-4 py-2 focus-within:border-blue-500/50 transition-all">
                    <input
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                      placeholder="Tell Synq who to pay and why..."
                      className="flex-1 bg-transparent text-sm text-white placeholder:text-zinc-500 outline-none"
                    />
                    <button
                      onClick={handleSend}
                      disabled={!input.trim() || isThinking}
                      className="p-2 rounded-lg bg-green-600 text-white hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                      <Send size={16} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Recent Payments</CardTitle>
              <CardDescription>Your real on-chain payments</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {sentPayments.length === 0 ? (
                <p className="text-sm text-zinc-500">No payments sent yet. Use the chat to make your first one.</p>
              ) : (
                sentPayments.map((pay) => {
                  const url = getExplorerUrl(chainId, 'tx', pay.txHash);
                  return (
                    <div key={pay.id} className="p-3 rounded-lg bg-zinc-800/30 border border-zinc-800/50">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium text-white">{pay.recipient}</span>
                        <span className="text-sm font-semibold text-white">{pay.amount} {pay.asset}</span>
                      </div>
                      <div className="flex items-center justify-between text-xs">
                        <Badge variant="success" className="text-[10px]">Confirmed</Badge>
                        <span className="text-zinc-500">{formatTimeAgo(pay.timestamp)}</span>
                      </div>
                      <div className="flex items-center justify-between text-[10px] mt-1">
                        <span className="font-mono text-zinc-600">{pay.txHash.slice(0, 10)}...{pay.txHash.slice(-6)}</span>
                        {url && <a href={url} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">View ↗</a>}
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Payment Agent</CardTitle>
              <CardDescription>Agent permissions</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Mode</span>
                <Badge variant="info" className="text-[10px]">Manual Approval</Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Assets</span>
                <span className="text-white">ETH, USDC</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Network</span>
                <span className="text-white">Sepolia</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
