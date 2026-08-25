'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { Bot, User, Sparkles, Check, X, ArrowRight, Loader2, AlertTriangle, ThumbsUp, Zap, Send, Plus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { useAccount } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import { useFactoryContract } from '@/hooks/useFactoryContract';
import { ChainGuard } from '@/components/shared/ChainGuard';
import { formatCurrency, cn } from '@/lib/utils';

interface Message {
  id: string;
  role: 'user' | 'ai' | 'system';
  content: string;
  timestamp: string;
  suggestions?: Suggestion[];
  sellers?: SellerResult[];
}

interface Suggestion {
  label: string;
  amount: number;
  timeline: string;
  risk: string;
  description: string;
}

interface SellerResult {
  wallet: string;
  name: string;
  category: string;
  skills: string[];
  rate: string;
  bio: string;
  available: boolean;
  match: number;
}

const INITIAL_AI: Message = {
  id: 'init',
  role: 'ai',
  content: "Tell me what you need, your budget and timeline. I will help you find a deal that works for both sides.",
  timestamp: new Date().toISOString(),
};

export default function NegotiatorPage() {
  const router = useRouter();
  const { address } = useAccount();
  const factory = useFactoryContract();
  const [messages, setMessages] = useState<Message[]>([INITIAL_AI]);
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [selectedOffer, setSelectedOffer] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [pendingSellerWallet, setPendingSellerWallet] = useState('');
  const [pendingDeal, setPendingDeal] = useState<{ title: string; amount: string }>({ title: 'Negotiated Deal', amount: '' });
  const notifiedRef = useRef(false);

  const accepted = factory.txReceipt.isSuccess;

  useEffect(() => {
    if (accepted && !notifiedRef.current) {
      notifiedRef.current = true;
      fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'deal_confirmed',
          recipientWallet: pendingSellerWallet,
          recipientName: 'seller',
          dealTitle: pendingDeal.title,
          dealAmount: pendingDeal.amount,
        }),
      }).catch(() => {});
    }
  }, [accepted, pendingSellerWallet, pendingDeal]);

  const handleSend = async () => {
    if (!input.trim() || isThinking) return;
    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: input, timestamp: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    const userInput = input;
    setInput('');
    setIsThinking(true);
    setError('');

    try {
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'negotiate', prompt: userInput }),
      });
      const data = await res.json();

      let suggestions: Suggestion[] = [];
      let sellers: SellerResult[] = [];
      let message = "I've analyzed your request. Here are some options.";

      if (data?.result?.sellers) {
        sellers = data.result.sellers;
        message = data.result.message || message;
      } else if (data?.result?.suggestions) {
        suggestions = data.result.suggestions;
        message = data.result.message || message;
      } else if (data?.result?.message) {
        message = data.result.message;
      }

      const aiMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'ai',
        content: message,
        timestamp: new Date().toISOString(),
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        sellers: sellers.length > 0 ? sellers : undefined,
      };
      setMessages(prev => [...prev, aiMsg]);
    } catch (e) {
      setError('AI service unavailable. Please try again.');
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'system',
        content: 'Sorry, I encountered an error. Please try again.',
        timestamp: new Date().toISOString(),
      }]);
    }
    setIsThinking(false);
  };

  const handleAcceptProposal = async () => {
    if (selectedOffer === null || !address) return;
    const lastMsg = [...messages].reverse().find(m => m.suggestions);
    if (!lastMsg?.suggestions) return;
    const offer = lastMsg.suggestions[selectedOffer];

    setError('');
    if (!factory.onSupportedChain) {
      setError('Switch your wallet to Ethereum Sepolia — Synq contracts are not deployed on this network.');
      return;
    }

    // offer.amount comes from the AI, so it can be a fraction ("0.05"), a
    // formatted string ("1,250 ETH") or a float. BigInt() throws on all three
    // and `* BigInt(1e18)` would truncate anyway — normalise then parseUnits.
    const cleaned = String(offer.amount ?? '').replace(/[^0-9.]/g, '');
    let amountWei: bigint;
    try {
      amountWei = parseUnits(cleaned, 18);
    } catch {
      setError(`Could not read the proposed amount ("${offer.amount}"). Create the deal manually instead.`);
      return;
    }
    if (amountWei <= 0n) {
      setError('The proposed amount is zero. Pick a different offer or create the deal manually.');
      return;
    }

    try {
      const counterparty = prompt('Enter the seller wallet address:');
      if (!counterparty || !counterparty.startsWith('0x') || counterparty.length !== 42) {
        setError('Invalid address');
        return;
      }
      setPendingSellerWallet(counterparty);
      setPendingDeal({ title: offer.description || 'Negotiated Deal', amount: formatUnits(amountWei, 18) });
      const deadline = Math.floor(Date.now() / 1000) + 30 * 86400;
      factory.createDeal(
        counterparty as `0x${string}`,
        'Negotiated Deal',
        offer.description,
        amountWei,
        BigInt(deadline),
        true,
        '0x0000000000000000000000000000000000000000' as `0x${string}`,
      );
    } catch (e: any) {
      setError(e?.message || 'Failed to create deal');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">AI Deal Negotiator</h1>
        <p className="text-zinc-400 text-sm mt-1">Your intelligent negotiation workspace.</p>
      </div>

      <ChainGuard what="the deal factory is" />

      <div className="grid lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Conversation</CardTitle>
                <CardDescription>Describe what you need AI suggests deal structures</CardDescription>
              </div>
              <Badge variant="info" className="gap-1"><Bot size={12} /> AI Agent</Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="h-[500px] flex flex-col">
              <div className="flex-1 overflow-y-auto space-y-4 p-4">
                {messages.map((msg, i) => (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={cn('flex gap-3', msg.role === 'user' ? 'justify-end' : 'justify-start')}
                  >
                    {msg.role === 'ai' && (
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center shrink-0">
                        <Bot size={16} className="text-white" />
                      </div>
                    )}
                    <div className={cn(
                      'max-w-[85%]',
                      msg.role === 'user' ? 'bg-blue-600 text-white rounded-2xl rounded-tr-md px-4 py-3' :
                      msg.role === 'ai' ? 'bg-zinc-800/50 border border-zinc-700/50 rounded-2xl rounded-tl-md px-4 py-3 text-zinc-200' :
                      'bg-zinc-800/30 text-zinc-400 text-center rounded-lg px-4 py-2'
                    )}>
                      <p className="text-sm">{msg.content}</p>

                      {msg.sellers && (
                        <div className="mt-4 space-y-3">
                          <Separator className="bg-zinc-700/50" />
                          <p className="text-xs text-zinc-400">Marketplace matches:</p>
                          <div className="grid gap-3">
                            {msg.sellers.map((s, si) => (
                              <motion.div
                                key={s.wallet}
                                initial={{ opacity: 0, x: -10 }}
                                animate={{ opacity: 1, x: 0 }}
                                className="p-4 rounded-xl border border-zinc-700/50 bg-zinc-800/30 hover:border-blue-500/40 transition-all"
                              >
                                <div className="flex items-start justify-between gap-3 mb-2">
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="font-semibold text-white truncate">
                                        {si === 0 && <span className="text-amber-400 mr-1">★</span>}
                                        {s.name}
                                      </span>
                                      <Badge variant="info" className="text-[10px]">{s.match}% match</Badge>
                                    </div>
                                    <div className="text-xs text-zinc-400 mt-0.5">
                                      {s.category} · {(s.skills || []).join(', ')}
                                    </div>
                                    <div className="font-mono text-[10px] text-zinc-500 mt-0.5">
                                      {s.wallet.slice(0, 8)}...{s.wallet.slice(-6)}
                                    </div>
                                  </div>
                                  <div className="text-right shrink-0">
                                    <div className="text-sm font-bold text-white">{Number(s.rate) / 1e18 || 0} ETH</div>
                                    <div className="text-[10px] text-zinc-500">rate/project</div>
                                  </div>
                                </div>
                                {s.bio && <p className="text-xs text-zinc-400 line-clamp-2 mb-2">{s.bio}</p>}
                                <Button size="sm" className="gap-1" onClick={() => router.push(`/deal/new?seller=${s.wallet}&type=${encodeURIComponent(s.category)}`)}>
                                  <ArrowRight size={14} /> Order {s.name}
                                </Button>
                              </motion.div>
                            ))}
                          </div>
                        </div>
                      )}

                      {msg.suggestions && (
                        <div className="mt-4 space-y-3">
                          <Separator className="bg-zinc-700/50" />
                          <p className="text-xs text-zinc-400">AI suggests these options:</p>
                          <div className="grid gap-3">
                            {msg.suggestions.map((offer, oi) => (
                              <motion.div
                                key={offer.label}
                                initial={{ opacity: 0, x: -10 }}
                                animate={{ opacity: 1, x: 0 }}
                                className={cn(
                                  'p-4 rounded-xl border transition-all cursor-pointer',
                                  selectedOffer === oi
                                    ? 'border-blue-500/50 bg-blue-600/10'
                                    : oi === 1
                                    ? 'border-violet-500/30 bg-violet-600/5 hover:border-violet-500/50'
                                    : 'border-zinc-700/50 bg-zinc-800/30 hover:border-zinc-600'
                                )}
                                onClick={() => setSelectedOffer(oi)}
                              >
                                <div className="flex items-center justify-between mb-2">
                                  <div className="flex items-center gap-2">
                                    <span className="font-semibold text-white">{offer.label}</span>
                                    {oi === 1 && <Badge variant="info" className="text-[10px]">Recommended</Badge>}
                                  </div>
                                  <span className="text-lg font-bold text-white">{formatCurrency(offer.amount)}</span>
                                </div>
                                <p className="text-sm text-zinc-400 mb-2">{offer.description}</p>
                                <div className="flex items-center gap-3 text-xs text-zinc-500">
                                  <span>{offer.timeline}</span>
                                  <span>·</span>
                                  <span className={offer.risk === 'low' ? 'text-green-400' : offer.risk === 'medium' ? 'text-amber-400' : 'text-red-400'}>
                                    {offer.risk.charAt(0).toUpperCase() + offer.risk.slice(1)} Risk
                                  </span>
                                </div>
                              </motion.div>
                            ))}
                          </div>

                          {selectedOffer !== null && (
                            <div className="flex items-center gap-2 pt-2">
                              <Button size="sm" className="gap-1" onClick={handleAcceptProposal} disabled={factory.isPending}>
                                {factory.isPending ? <><Loader2 size={14} className="animate-spin" /> Creating...</> : <><ThumbsUp size={14} /> Accept & Create Deal</>}
                              </Button>
                              <Button variant="outline" size="sm" className="gap-1" disabled><Zap size={14} /> Counter Offer</Button>
                              <Button variant="ghost" size="sm" className="gap-1" onClick={() => setSelectedOffer(null)}><X size={14} /> Dismiss</Button>
                            </div>
                          )}
                        </div>
                      )}
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
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center shrink-0">
                      <Bot size={16} className="text-white" />
                    </div>
                    <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-2xl rounded-tl-md px-4 py-3">
                      <div className="flex items-center gap-2 text-sm text-zinc-400">
                        <Loader2 size={14} className="animate-spin text-blue-400" />
                        Analyzing...
                      </div>
                    </div>
                  </motion.div>
                )}

                {accepted && (
                  <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="p-4 rounded-xl border border-green-500/20 bg-green-600/10">
                    <div className="flex items-center gap-2 mb-1">
                      <Check size={18} className="text-green-400" />
                      <span className="text-sm font-medium text-green-400">Deal Created!</span>
                    </div>
                    <p className="text-xs text-zinc-400">Your deal has been created on-chain.</p>
                    <Button size="sm" variant="outline" className="mt-2 gap-1" onClick={() => router.push('/deals')}>
                      <Plus size={14} /> View My Deals
                    </Button>
                  </motion.div>
                )}
              </div>

              <div className="p-4 border-t border-zinc-800/50">
                {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
                <div className="flex items-center gap-2 bg-zinc-800/50 border border-zinc-700/50 rounded-xl px-4 py-2 focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500/20 transition-all">
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                    placeholder="Describe the deal you want..."
                    className="flex-1 bg-transparent text-sm text-white placeholder:text-zinc-500 outline-none"
                  />
                  <button
                    onClick={handleSend}
                    disabled={!input.trim() || isThinking}
                    className="p-2 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                  >
                    <Send size={16} />
                  </button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>AI Insights</CardTitle>
              <CardDescription>AI-powered assistant</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="p-3 rounded-lg bg-blue-600/10 border border-blue-500/20">
                <div className="flex items-center gap-2 text-sm text-blue-400 mb-1">
                  <Sparkles size={14} />
                  How it works
                </div>
                <p className="text-sm text-zinc-300">Tell the AI what you need, your budget and timeline, it will help you find a deal that works for both sides. Select a proposal and create an on-chain deal with one click.</p>
              </div>

              <Separator />

              <div>
                <h4 className="text-xs text-zinc-500 font-medium uppercase tracking-wider mb-3">Example Prompts</h4>
                <div className="space-y-2">
                  {[
                    'I need a React developer for $5,000, 2 week timeline',
                    'Smart contract audit for 10 ETH, need it in 7 days',
                    'Design a logo and branding for $2,000',
                  ].map((ex, i) => (
                    <button
                      key={i}
                      onClick={() => setInput(ex)}
                      className="w-full text-left p-2 rounded-lg bg-zinc-800/30 border border-zinc-800/50 text-xs text-zinc-400 hover:text-white hover:border-zinc-700 transition-all"
                    >
                      "{ex}"
                    </button>
                  ))}
                </div>
              </div>

              <Separator />

              <div>
                <h4 className="text-xs text-zinc-500 font-medium uppercase tracking-wider mb-3">Agent Activity</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2 text-zinc-400">
                    <Bot size={14} className="text-blue-400" />
                    <span>Connecting to AI agent</span>
                  </div>
                  <div className="flex items-center gap-2 text-zinc-400">
                    <Bot size={14} className="text-violet-400" />
                    <span>Parsing deal suggestions</span>
                  </div>
                  <div className="flex items-center gap-2 text-zinc-400">
                    <Bot size={14} className="text-amber-400" />
                    <span>Ready to create on-chain deal</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Connected Wallet</CardTitle>
              <CardDescription>Deals are created from your wallet</CardDescription>
            </CardHeader>
            <CardContent>
              {address ? (
                <div className="text-sm text-zinc-300 font-mono truncate">{address}</div>
              ) : (
                <p className="text-sm text-zinc-500">Connect your wallet to create deals</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
