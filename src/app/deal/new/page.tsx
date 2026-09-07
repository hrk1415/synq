'use client';

import { useState, useRef, useEffect, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, Sparkles, Bot, Loader2, MessageSquare } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { useAccount, useChainId } from 'wagmi';
import { parseUnits, decodeEventLog } from 'viem';
import { useFactoryContract } from '@/hooks/useFactoryContract';
import { formatCurrency, shortenAddress } from '@/lib/utils';
import { nexotiqFactoryABI } from '@/lib/contracts/abis';
import { getTokenInfo, chainKeyForId, isSupportedChain, DEFAULT_CHAIN_ID } from '@/lib/contracts/addresses';
import { ChainGuard } from '@/components/shared/ChainGuard';
import { useDirectoryContract } from '@/hooks/useDirectoryContract';

const ZERO = '0x0000000000000000000000000000000000000000';

const tokenize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

// Assets available per chain (address(0) = native ETH)
const SUPPORTED_ASSETS: Record<number, { address: string; symbol: string }[]> = {
  31337: [{ address: ZERO, symbol: 'ETH' }],
  11155111: [
    { address: ZERO, symbol: 'ETH' },
    { address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', symbol: 'USDC' },
  ],
};

const steps = [
  { title: 'Type', description: 'What are you buying or selling?' },
  { title: 'Counterparty', description: 'Who is the counterparty?' },
  { title: 'Budget', description: 'What is the budget (in wei)?' },
  { title: 'Deliverables', description: 'What are the deliverables?' },
  { title: 'Deadline', description: 'Pick the deadline date and time' },
  { title: 'Payment', description: 'How should payment be released?' },
  { title: 'Protection', description: 'Do you want Adaptive Protection?' },
  { title: 'Review', description: 'Review your deal terms' },
];

export default function NewDealPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-20"><Loader2 size={24} className="animate-spin text-blue-400" /></div>}>
      <NewDealForm />
    </Suspense>
  );
}

function NewDealForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { address } = useAccount();
  const chainId = useChainId();
  const factory = useFactoryContract();
  const directory = useDirectoryContract(address);
  const [step, setStep] = useState(searchParams.get('seller') ? 1 : 0);
  const [matches, setMatches] = useState<any[]>([]);
  const [matchState, setMatchState] = useState<'idle' | 'matching' | 'done'>('idle');
  const [matchError, setMatchError] = useState('');
  const prefilledDeadline = searchParams.get('deadline') || '';
  const [form, setForm] = useState({
    type: searchParams.get('type') || '',
    counterparty: searchParams.get('seller') || '',
    budget: searchParams.get('budget') || '',
    deliverables: '',
    deadline: prefilledDeadline ? String(Math.floor(new Date(`${prefilledDeadline}T23:59`).getTime() / 1000)) : '',
    paymentStructure: searchParams.get('payment') === '50/50' ? 'half' : 'full',
    protection: true,
    protectionLevel: 'enhanced',
    aiEnhanced: false,
    asset: ZERO,
  });
  const [deadlineDate, setDeadlineDate] = useState(prefilledDeadline);
  const [deadlineTime, setDeadlineTime] = useState('23:59');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  // On an unsupported chain we show the default chain's asset list so the form
  // still renders — ChainGuard tells the user to switch, and handleCreate refuses
  // to submit. Never fall back to hardhat: its addresses don't exist elsewhere.
  const assets = SUPPORTED_ASSETS[chainId] || SUPPORTED_ASSETS[DEFAULT_CHAIN_ID];
  const activeAsset = assets.find((a) => a.address === form.asset) || assets[0];
  const tokenChainKey = chainKeyForId(isSupportedChain(chainId) ? chainId : DEFAULT_CHAIN_ID);
  const assetInfo = getTokenInfo(tokenChainKey, form.asset);
  const assetDecimals = activeAsset.symbol === 'ETH' ? 18 : assetInfo.decimals;

  /**
   * The protection pool is ETH-denominated: it holds ETH, quotes premiums in wei
   * and pays claims in ETH. Pricing coverage off an ERC20 `coverageAmount` mixed
   * base units with wei, so a 100 USDC deal was quoted a premium of a few hundred
   * thousand wei — coverage that was effectively free and could never pay out.
   * Coverage is therefore ETH-only, enforced in the contracts; the form must not
   * offer a checkbox that the factory will reject.
   */
  const isEthDeal = String(form.asset) === ZERO;
  const protectionEnabled = form.protection && isEthDeal;

  const update = (key: string, value: string | boolean) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const canProceed = () => {
    switch (step) {
      case 0: return form.type.length > 0;
      case 1: return form.counterparty.startsWith('0x') && form.counterparty.length === 42;
      case 2: return form.budget.length > 0 && !isNaN(Number(form.budget));
      case 3: return form.deliverables.length > 0;
      case 4: return !!deadlineDate && !isNaN(Number(form.deadline));
      default: return true;
    }
  };

  const scoreSeller = (p: any) => {
    let score = 0;
    const typeLower = form.type.toLowerCase();
    const cat = String(p.category || '').toLowerCase();
    if (typeLower && typeLower !== 'other') {
      if (cat === typeLower) score += 30;
      else if (cat.includes(typeLower) || typeLower.includes(cat)) score += 18;
    }
    const skills = (p.skills || []).map((s: string) => String(s).toLowerCase());
    const bio = String(p.bio || '').toLowerCase();
    const name = String(p.name || '').toLowerCase();
    const terms = [...tokenize(form.type), ...tokenize(form.deliverables), typeLower.replace(/\s/g, '')];
    const haystack = [name, bio, ...skills].join(' ');
    for (const t of terms) {
      if (!t || t.length < 3) continue;
      if (skills.includes(t)) score += 10;
      else if (haystack.includes(t)) score += 6;
    }
    if (p.available) score += 5;
    score += Math.min(Number(p.completedDeals || 0) * 2, 8);
    return score;
  };

  const runMatch = (autoPick = false) => {
    setMatchState('matching');
    setMatchError('');
    if (directory.isLoading) {
      setMatches([]);
      setMatchState('done');
      setMatchError('Loading registered sellers... try again in a moment.');
      return;
    }
    const sellers = (directory.profiles || []).filter(
      (p: any) => p && p.wallet && p.wallet !== address && String(p.wallet) !== ZERO && (p.available || true)
    );
    if (sellers.length === 0) {
      setMatches([]);
      setMatchState('done');
      setMatchError('No sellers are registered in the Deal Port yet. Register a seller profile on the Deal Port page first.');
      return;
    }
    const scored = sellers
      .map((p: any) => ({ p, score: scoreSeller(p) }))
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, 3);
    setMatches(scored);
    setMatchState('done');
    if (autoPick && scored.length > 0) {
      setForm((prev) => ({ ...prev, counterparty: scored[0].p.wallet as string }));
    }
  };

  const handleCreate = async () => {
    if (!address) { setError('Connect your wallet first'); return; }
    if (!factory.onSupportedChain) { setError('Switch your wallet to Ethereum Sepolia — Synq contracts are not deployed on this network.'); return; }
    if (!form.counterparty.startsWith('0x')) { setError('Enter a valid counterparty address'); return; }
    setCreating(true);
    setError('');
    try {
      // parseUnits, not `Number(budget) * 10 ** decimals` — the multiply loses
      // precision above 2^53 (any ETH amount that isn't a round power of ten)
      // and silently truncates extra decimal places on 6-decimal assets.
      const rawBudget = parseUnits(String(form.budget).trim(), assetDecimals);
      if (rawBudget <= 0n) { setError('Budget must be greater than zero'); setCreating(false); return; }
      factory.createDeal(
        form.counterparty as `0x${string}`,
        form.type,
        form.deliverables,
        rawBudget,
        BigInt(form.deadline),
        protectionEnabled,
        form.asset as `0x${string}`,
      );
    } catch (e: any) {
      setError(e?.message?.includes('decimal') || e?.name === 'InvalidDecimalNumberError'
        ? `Enter a valid ${activeAsset.symbol} amount with at most ${assetDecimals} decimal places.`
        : e?.message || 'Transaction failed');
      setCreating(false);
    }
  };

  const txConfirmed = factory.txReceipt.isSuccess;
  const notifiedRef = useRef(false);

  // The factory emits `DealCreated(dealAddr, buyer, seller, totalValue, dealId)`,
  // but writeContract only returns the tx hash. Recover the new deal address from
  // the receipt logs so we can link it to the chat conversation.
  const getCreatedDealAddress = (receipt: any): string | null => {
    const logs = receipt?.logs || [];
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: nexotiqFactoryABI,
          data: (log.data || '0x') as any,
          topics: (log.topics || []) as any,
        });
        if (decoded.eventName === 'DealCreated') {
          const args = decoded.args as any;
          if (args && args.dealAddr) return String(args.dealAddr);
        }
      } catch {
        /* not this event */
      }
    }
    return null;
  };

  const createdDealAddress = txConfirmed ? getCreatedDealAddress(factory.txReceipt.data) : null;

  useEffect(() => {
    if (txConfirmed && !notifiedRef.current) {
      notifiedRef.current = true;
      fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'deal_confirmed',
          recipientWallet: form.counterparty,
          recipientName: 'seller',
          dealTitle: form.type || 'Deal',
          dealAmount: form.budget,
        }),
      }).catch(() => {});

      // Link the on-chain deal to the chat thread. When the buyer opened the
      // wizard from an existing conversation (Messages → "Create escrow deal")
      // we have its id; otherwise the buyer will message the seller next and the
      // deal address is passed along so the thread can link then.
      const dealAddr = getCreatedDealAddress(factory.txReceipt.data);
      const cid = searchParams.get('conversationId');
      if (dealAddr && cid) {
        fetch('/api/conversations/link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: cid,
            buyerWallet: address,
            sellerWallet: form.counterparty,
            dealAddress: dealAddr,
          }),
        }).catch(() => {});
      }
    }
  }, [txConfirmed, form.counterparty, form.type, form.budget, factory.txReceipt.data, address, searchParams]);

  const renderStep = () => {
    switch (step) {
      case 0:
        return (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400 mb-4">Describe what you're buying or selling in natural language, or select a category.</p>
            <div className="grid grid-cols-2 gap-3">
              {['Development', 'Design', 'Marketing', 'Content', 'Consulting', 'Smart Contract', 'Audit', 'Other'].map((cat) => (
                <button
                  key={cat}
                  onClick={() => update('type', cat)}
                  className={`p-3 rounded-xl border text-sm font-medium text-left transition-all ${
                    form.type === cat ? 'border-blue-500/50 bg-blue-600/10 text-blue-400' : 'border-zinc-700/50 bg-zinc-800/30 text-zinc-300 hover:border-zinc-600'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
            <div className="relative mt-2">
              <Input
                value={form.type === 'Other' || (form.type && !['Development', 'Design', 'Marketing', 'Content', 'Consulting', 'Smart Contract', 'Audit'].includes(form.type)) ? form.type : ''}
                onChange={(e) => update('type', e.target.value)}
                placeholder="Or type custom description..."
              />
            </div>
          </div>
        );
      case 1:
        return (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400 mb-4">The AI agent will find the best seller for your deal. No address needed.</p>
            {searchParams.get('seller') && form.counterparty === searchParams.get('seller') && (
              <div className="p-2 rounded-lg bg-emerald-600/10 border border-emerald-500/20 text-xs text-emerald-400">
                Seller selected from the Deal Port — this is the freelancer's wallet address.
              </div>
            )}
            {form.counterparty.length === 42 && !matches.some((m: any) => String(m.p.wallet) === form.counterparty) && (
              <div className="p-2 rounded-lg bg-zinc-800/30 text-xs text-zinc-400">
                Counterparty: {shortenAddress(form.counterparty)}
              </div>
            )}
            {address && (
              <div className="p-2 rounded-lg bg-zinc-800/30 text-xs text-zinc-400">
                You (buyer): {shortenAddress(address)}
              </div>
            )}
            <div className="pt-2 border-t border-zinc-800/60">
              {matches.length === 0 ? (
                <button
                  onClick={() => runMatch(false)}
                  disabled={matchState === 'matching'}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-blue-500/40 bg-blue-600/10 text-sm font-medium text-blue-400 hover:bg-blue-600/20 transition-all disabled:opacity-50"
                >
                  {matchState === 'matching' ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                  {matchState === 'matching' ? 'Searching sellers...' : 'Find My Seller'}
                </button>
              ) : (
                <button
                  onClick={() => runMatch(false)}
                  disabled={matchState === 'matching'}
                  className="flex items-center gap-2 text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors"
                >
                  {matchState === 'matching' ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                  Re-run AI search
                </button>
              )}
              {matchError && (
                <div className="mt-2 p-2 rounded-lg bg-amber-600/10 border border-amber-500/20 text-xs text-amber-400">
                  {matchError}
                </div>
              )}
              {matches.length > 0 && (
                <div className="mt-2 space-y-2">
                  <p className="text-[10px] text-zinc-500 uppercase tracking-wide">Best matches</p>
                  {matches.map(({ p, score }, i) => (
                    <button
                      key={String(p.wallet)}
                      onClick={() => {
                        update('counterparty', String(p.wallet));
                        setStep(2);
                      }}
                      className={`w-full text-left p-2.5 rounded-lg border transition-all ${
                        form.counterparty === p.wallet
                          ? 'border-emerald-500/50 bg-emerald-600/10'
                          : 'border-zinc-700/50 bg-zinc-800/30 hover:border-blue-500/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-white truncate">
                            {i === 0 && <span className="text-amber-400 mr-1">★</span>}
                            {String(p.name || 'Anonymous')}
                            {!p.available && <span className="ml-1 text-[10px] text-zinc-500">(busy)</span>}
                          </div>
                          <div className="text-xs text-zinc-400 truncate">
                            {String(p.category || '-')} · {(p.skills || []).slice(0, 3).join(', ')}
                          </div>
                          <div className="font-mono text-[10px] text-zinc-500">{shortenAddress(String(p.wallet))}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm font-bold text-emerald-400">{Math.min(Math.round(score / 0.6), 99)}% match</div>
                          <div className="text-[10px] text-zinc-500">{Number(p.rate) / 1e18 || 0} ETH</div>
                        </div>
                      </div>
                    </button>
                  ))}
                  <p className="text-[10px] text-zinc-600">Click a seller to select, or enter an address manually above.</p>
                </div>
              )}
            </div>
          </div>
        );
      case 2:
        return (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400 mb-4">Choose the payment asset and enter the deal value in units (e.g. 0.5 ETH, 100 USDC).</p>
            <div className="flex items-center gap-2">
              {assets.map((a) => (
                <button
                  key={a.address}
                  onClick={() => update('asset', a.address)}
                  className={`flex-1 p-3 rounded-xl border text-sm font-medium text-left transition-all ${
                    form.asset === a.address ? 'border-blue-500/50 bg-blue-600/10 text-blue-400' : 'border-zinc-700/50 bg-zinc-800/30 text-zinc-300 hover:border-zinc-600'
                  }`}
                >
                  {a.symbol}
                  {a.symbol !== 'ETH' && <span className="block text-[10px] text-zinc-500 font-normal">ERC-20</span>}
                </button>
              ))}
            </div>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 text-sm">{activeAsset.symbol}</span>
              <Input
                value={form.budget}
                onChange={(e) => update('budget', e.target.value)}
                placeholder={activeAsset.symbol === 'ETH' ? '0.5' : '100'}
                className="pl-10 font-mono text-sm"
                type="number"
                min="0"
                step="any"
              />
            </div>
            {form.budget && !isNaN(Number(form.budget)) && (
              <div className="p-3 rounded-lg bg-zinc-800/30 text-sm">
                <span className="text-zinc-400">Value: </span>
                <span className="text-white font-semibold">{Number(form.budget)} {activeAsset.symbol}</span>
                <span className="text-zinc-500 text-xs ml-2">= {BigInt(Math.round(Number(form.budget) * 10 ** assetDecimals)).toString()} raw</span>
              </div>
            )}
          </div>
        );
      case 3:
        return (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400 mb-4">Describe the deliverables in detail.</p>
            <textarea
              value={form.deliverables}
              onChange={(e) => update('deliverables', e.target.value)}
              placeholder="Describe what the seller will deliver..."
              className="w-full h-32 rounded-lg border border-zinc-700 bg-zinc-800/50 px-4 py-3 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
            />
            <button
              onClick={() => update('deliverables', 'Comprehensive DeFi dashboard with real-time analytics, portfolio tracking, and transaction monitoring.')}
              className="flex items-center gap-2 text-xs text-blue-400 hover:text-blue-300"
            >
              <Sparkles size={12} /> Use AI to generate description
            </button>
            {form.deliverables.length > 5 && (
              <button
                onClick={() => runMatch(true)}
                disabled={matchState === 'matching'}
                className="flex items-center gap-2 text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-50 transition-colors"
              >
                {matchState === 'matching' ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                Auto-select best seller from this description
              </button>
            )}
            {matchState === 'done' && matches.length > 0 && form.counterparty && (
              <div className="flex items-center justify-between p-2.5 rounded-lg border border-emerald-500/30 bg-emerald-600/10">
                <div className="min-w-0">
                  <div className="text-xs text-emerald-400 font-medium">Seller auto-selected</div>
                  <div className="text-sm text-white truncate">
                    {String(matches[0].p.name || 'Anonymous')} · {shortenAddress(String(matches[0].p.wallet))}
                  </div>
                  <div className="text-[10px] text-zinc-500">
                    {(matches[0].p.skills || []).slice(0, 4).join(', ')}
                  </div>
                </div>
                <div className="text-right shrink-0 text-[10px] text-zinc-500">
                  <div className="text-emerald-400 font-bold text-sm">{Math.min(Math.round(matches[0].score / 0.6), 99)}% match</div>
                  <button onClick={() => { setStep(1); setForm(f => ({ ...f, counterparty: '' })); }} className="text-zinc-400 hover:text-white">Change</button>
                </div>
              </div>
            )}
          </div>
        );
      case 4:
        const today = new Date().toISOString().slice(0, 10);
        const onPickDeadline = (date: string, time: string) => {
          setDeadlineDate(date);
          setDeadlineTime(time);
          if (date) {
            const ts = Math.floor(new Date(`${date}T${time || '23:59'}`).getTime() / 1000);
            update('deadline', String(ts));
          } else {
            update('deadline', '');
          }
        };
        return (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400 mb-4">Pick the date and time the seller must deliver by.</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">Date</label>
                <Input
                  type="date"
                  min={today}
                  value={deadlineDate}
                  onChange={(e) => onPickDeadline(e.target.value, deadlineTime)}
                  className="font-mono"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">Time</label>
                <Input
                  type="time"
                  value={deadlineTime}
                  onChange={(e) => onPickDeadline(deadlineDate, e.target.value)}
                  className="font-mono"
                />
              </div>
            </div>
            {form.deadline && !isNaN(Number(form.deadline)) && (
              <div className="p-3 rounded-lg bg-zinc-800/30 text-sm text-zinc-400">
                Deadline: <span className="text-white font-medium">{new Date(Number(form.deadline) * 1000).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span> at <span className="text-white font-medium">{new Date(Number(form.deadline) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            )}
          </div>
        );
      case 5:
        return (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400 mb-4">How should payment be released?</p>
            <div className="space-y-2">
              {[
                { value: 'full', label: 'Full Payment', desc: 'Pay 100% upon completion' },
                { value: 'half', label: '50/50 Split', desc: '50% upfront, 50% on completion' },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => update('paymentStructure', opt.value)}
                  className={`w-full p-3 rounded-xl border text-left transition-all ${
                    form.paymentStructure === opt.value ? 'border-blue-500/50 bg-blue-600/10' : 'border-zinc-700/50 bg-zinc-800/30 hover:border-zinc-600'
                  }`}
                >
                  <div className="text-sm font-medium text-white">{opt.label}</div>
                  <div className="text-xs text-zinc-500">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>
        );
      case 6:
        return (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400 mb-4">Adaptive Protection monitors your deal and provides coverage against risk.</p>
            {!isEthDeal && (
              <div className="p-3 rounded-xl bg-amber-600/10 border border-amber-500/25">
                <p className="text-xs text-amber-300">
                  Coverage is not available for {activeAsset.symbol} deals. The protection pool holds and pays out ETH,
                  so it cannot price or settle a claim denominated in {activeAsset.symbol}. Pick ETH in the asset step
                  if you want coverage — this deal will be created without it.
                </p>
              </div>
            )}
            <div className="space-y-2">
              {[
                { value: true, label: 'Enable Adaptive Protection', desc: 'AI-powered risk monitoring and deal protection' },
                { value: false, label: 'No Protection', desc: 'Proceed without protection coverage' },
              ].map((opt) => (
                <button
                  key={String(opt.value)}
                  onClick={() => isEthDeal && update('protection', opt.value)}
                  disabled={!isEthDeal}
                  className={`w-full p-3 rounded-xl border text-left transition-all ${
                    !isEthDeal
                      ? opt.value === false
                        ? 'border-zinc-700/50 bg-zinc-800/30 opacity-70'
                        : 'border-zinc-800/50 bg-zinc-900/30 opacity-40 cursor-not-allowed'
                      : form.protection === opt.value ? 'border-blue-500/50 bg-blue-600/10' : 'border-zinc-700/50 bg-zinc-800/30 hover:border-zinc-600'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-white">{opt.label}</div>
                      <div className="text-xs text-zinc-500">{opt.desc}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        );
      case 7:
        const selectedMatchInfo = matches.find((m: any) => String(m.p.wallet).toLowerCase() === String(form.counterparty).toLowerCase());
        const sellerName = selectedMatchInfo ? String(selectedMatchInfo.p.name || 'Seller') : 'Seller';
        return (
          <div className="space-y-4">
            <p className="text-sm text-zinc-400 mb-2">Review your deal before creating it.</p>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between p-2"><span className="text-zinc-400">Type</span><span className="text-white">{form.type}</span></div>
              <div className="flex justify-between p-2"><span className="text-zinc-400">Buyer</span><span className="text-white">You</span></div>
              <div className="flex justify-between p-2"><span className="text-zinc-400">Seller</span><span className="text-white">{sellerName}</span></div>
              <div className="flex justify-between p-2"><span className="text-zinc-400">Value</span><span className="text-white font-semibold">{Number(form.budget) || 0} {activeAsset.symbol}</span></div>
              <div className="flex justify-between p-2"><span className="text-zinc-400">Asset</span><span className="text-white">{activeAsset.symbol}{activeAsset.symbol !== 'ETH' ? ' (ERC-20)' : ' (native)'}</span></div>
              <div className="flex justify-between p-2"><span className="text-zinc-400">Deadline</span><span className="text-white text-right">{new Date(Number(form.deadline) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · {new Date(Number(form.deadline) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
              <div className="flex justify-between p-2"><span className="text-zinc-400">Protection</span><span className="text-white">{protectionEnabled ? 'Enabled' : isEthDeal ? 'Disabled' : `Not available for ${activeAsset.symbol}`}</span></div>
            </div>
            <Separator />
            <div className="p-3 rounded-lg bg-blue-600/10 border border-blue-500/20 text-sm text-zinc-300">
              <div className="flex items-center gap-2 text-blue-400 mb-1"><Bot size={14} /> AI Note</div>
              Your deal will be created on-chain via Synq's factory contract. You will need to sign a transaction with your wallet.
            </div>
          </div>
        );
    }
  };

  const showSuccess = txConfirmed;

  return (
    <div className="max-w-2xl mx-auto">
      <button onClick={() => step > 0 ? setStep(step - 1) : router.back()} className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white mb-6 transition-colors">
        <ArrowLeft size={16} /> Back
      </button>

      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Create a Deal</h1>
        <p className="text-zinc-400 text-sm mt-1">Step {step + 1} of {steps.length} · {steps[step].description}</p>
      </div>

      <div className="mb-6">
        <ChainGuard what="the deal factory is" />
      </div>

      <div className="flex items-center gap-2 mb-8">
        {steps.map((_, i) => (
          <div key={i} className="flex items-center gap-2 flex-1">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium transition-all ${
              i < step ? 'bg-green-600 text-white' : i === step ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-500'
            }`}>
              {i < step ? <Check size={14} /> : i + 1}
            </div>
            {i < steps.length - 1 && <div className={`h-px flex-1 ${i < step ? 'bg-green-600' : 'bg-zinc-800'}`} />}
          </div>
        ))}
      </div>

      <Card>
        <CardContent className="p-6">
          {showSuccess ? (
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="text-center py-8">
              <div className="w-16 h-16 rounded-full bg-green-600/20 flex items-center justify-center mx-auto mb-4">
                <Check size={32} className="text-green-400" />
              </div>
              <h2 className="text-xl font-bold text-white mb-2">Deal Created!</h2>
              <p className="text-zinc-400 text-sm mb-4">
                Your deal has been created on-chain. Transaction: {shortenAddress(factory.txReceipt.data?.transactionHash || '')}
              </p>
              <div className="flex items-center justify-center gap-3">
                <Button onClick={() => router.push('/deals')}>View My Deals</Button>
                {form.counterparty && (
                  <Button
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => {
                      const q = new URLSearchParams({ to: form.counterparty });
                      if (form.type) q.set('type', form.type);
                      const nm = searchParams.get('name');
                      if (nm) q.set('name', nm);
                      if (createdDealAddress) q.set('deal', createdDealAddress);
                      router.push(`/messages?${q.toString()}`);
                    }}
                  >
                    <MessageSquare size={16} /> Message Seller
                  </Button>
                )}
              </div>
            </motion.div>
          ) : (
            <AnimatePresence mode="wait">
              <motion.div key={step} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                {renderStep()}

                {error && (
                  <div className="mt-4 p-3 rounded-lg bg-red-600/10 border border-red-500/20 text-sm text-red-400">
                    {error}
                  </div>
                )}

                <div className="flex items-center justify-between mt-8">
                  <Button variant="ghost" onClick={() => step > 0 ? setStep(step - 1) : null} disabled={step === 0}>
                    Previous
                  </Button>
                  {step < steps.length - 1 ? (
                    <Button onClick={() => setStep(step + 1)} disabled={!canProceed()} className="gap-2">
                      Next <ArrowRight size={16} />
                    </Button>
                  ) : (
                    <Button onClick={handleCreate} disabled={creating || factory.isPending} className="gap-2">
                      {creating || factory.isPending ? (
                        <><Loader2 size={16} className="animate-spin" /> {factory.isPending ? 'Confirming...' : 'Creating...'}</>
                      ) : 'Create Deal & Sign'}
                    </Button>
                  )}
                </div>

                {!address && step === 7 && (
                  <p className="text-xs text-zinc-500 mt-2 text-center">Connect your wallet to create a deal</p>
                )}
              </motion.div>
            </AnimatePresence>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
