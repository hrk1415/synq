'use client';

import { useMemo, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { Plus, Handshake, Send, ShieldCheck, TrendingUp, Clock, Wallet, AlertTriangle, ArrowRight, Bot, Loader2, ArrowLeftRight, Star } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useAccount, useBalance, useReadContract, useChainId } from 'wagmi';
import { getFactoryAddress } from '@/hooks/useFactoryContract';
import { nexotiqFactoryABI, nexotiqDealABI } from '@/lib/contracts/abis';
import { getTokenInfo, chainKeyForId, isSupportedChain } from '@/lib/contracts/addresses';
import { getPublicClient } from '@/lib/chain';
import { useRegistry } from '@/hooks/useRegistryContract';
import { useActivity } from '@/hooks/useActivity';
import { useReputation } from '@/hooks/useReputation';
import AIChat from '@/components/shared/AIChat';
import { ChainGuard } from '@/components/shared/ChainGuard';
import { BorderBeamPanel } from '@/components/ui/border-beam-panel';
import GradientBlobCard from '@/components/ui/gradient-blob-card';
import { formatCurrency, shortenAddress, formatTimeAgo } from '@/lib/utils';

const quickActions = [
  { icon: Plus, label: 'Create Deal', href: '/deal/new', color: 'text-blue-400 bg-blue-400/10', beam: '#3b82f6' },
  { icon: Handshake, label: 'Negotiate', href: '/negotiator', color: 'text-violet-400 bg-violet-400/10', beam: '#8b5cf6' },
  { icon: Send, label: 'Send Payment', href: '/chatpay', color: 'text-green-400 bg-green-400/10', beam: '#22c55e' },
  { icon: ShieldCheck, label: 'Escrow', href: '/escrow', color: 'text-amber-400 bg-amber-400/10', beam: '#f59e0b' },
  { icon: ArrowLeftRight, label: 'Swap', href: '/swap', color: 'text-cyan-400 bg-cyan-400/10', beam: '#22d3ee' },
];

export default function Dashboard() {
  const { address } = useAccount();
  const chainId = useChainId();
  const registry = useRegistry(address);
  const reputation = useReputation(address);
  const { items: activityItems, loading: activityLoading } = useActivity(5);
  const factoryAddress = getFactoryAddress(chainId);
  const onSupportedChain = isSupportedChain(chainId) && !!factoryAddress;

  const { data: rawDeals, isLoading: dealsLoading } = useReadContract({
    address: factoryAddress,
    abi: nexotiqFactoryABI,
    functionName: 'getUserDeals',
    args: address ? [address] : undefined,
    query: { enabled: !!address && onSupportedChain },
  });

  const { data: balance } = useBalance({ address });

  const [dealStatuses, setDealStatuses] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    if (!rawDeals || !address) return;
    const client = getPublicClient(chainId);
    if (!client) return;
    (async () => {
      const entries: Record<string, number> = {};
      for (const d of rawDeals as any[]) {
        if (cancelled) break;
        try {
          const s = (await client.readContract({
            address: d.dealAddress as `0x${string}`,
            abi: nexotiqDealABI,
            functionName: 'status',
          })) as unknown;
          entries[String(d.dealAddress)] = Number(s);
        } catch { /* skip */ }
      }
      if (!cancelled) setDealStatuses(entries);
    })();
    return () => { cancelled = true; };
  }, [rawDeals, address, chainId]);

  const activeDeals = useMemo(() => {
    if (!rawDeals) return [];
    return (rawDeals as any[]).filter(d => {
      if (!d) return false;
      const st = dealStatuses[String(d.dealAddress)];
      return st === undefined ? !!d.active : st === 1;
    });
  }, [rawDeals, dealStatuses]);

  const deals = rawDeals as any[] | undefined;

  const totalValue = useMemo(() => {
    if (!deals || deals.length === 0) return 0;
    const asset = String(deals[0].asset || '');
    const token = getTokenInfo(chainKeyForId(chainId), asset);
    const sum = deals.reduce((s: number, d: any) => s + (d.totalValue ? Number(d.totalValue) : 0), 0);
    return sum / 10 ** token.decimals;
  }, [deals, chainId]);

  const totalValueSymbol = useMemo(() => {
    if (!deals || deals.length === 0) return 'ETH';
    return getTokenInfo(chainKeyForId(chainId), String(deals[0].asset || '')).symbol;
  }, [deals, chainId]);

const stats = [
  { label: 'ETH Balance', value: balance ? `${(Number(balance.value) / 1e18).toFixed(4)} ETH` : '-', change: 'Connected', icon: Wallet, color: 'text-blue-400', blob: ['#3b82f6', '#22d3ee'] },
  { label: 'Total Deal Value', value: totalValue > 0 ? formatCurrency(totalValue) + ' ' + totalValueSymbol : '0 ' + totalValueSymbol, change: `${deals?.length || 0} deals`, icon: TrendingUp, color: 'text-green-400', blob: ['#22c55e', '#84cc16'] },
  { label: 'Active Deals', value: String(activeDeals.length), change: `${activeDeals.length} in progress`, icon: Clock, color: 'text-amber-400', blob: ['#f59e0b', '#f97316'] },
  {
    label: 'Trust Score',
    // Derived from this wallet's real settled deals on chain — see useReputation.
    value: !address ? '-' : reputation.loading ? '...' : String(reputation.score),
    change: !address
      ? 'Connect wallet'
      : reputation.provisional
        ? 'No settled deals yet'
        : `${reputation.completed}/${reputation.completed + reputation.disputed + reputation.cancelled} completed`,
    icon: Star,
    color: 'text-violet-400',
    blob: ['#8b5cf6', '#d946ef'],
  },
];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full overflow-hidden border border-white/15 shadow-lg shadow-blue-500/20 ring-1 ring-white/40 bg-white flex items-center justify-center p-1">
            <img src="/logo.jpg" alt="Synq logo" className="w-full h-full object-contain" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Synq Dashboard</h1>
            <p className="text-zinc-400 text-sm mt-1">
              {address ? (registry.username ? `@${registry.username}` : shortenAddress(address)) : 'Connect your wallet to get started.'}
            </p>
          </div>
        </div>
      </div>

      <ChainGuard />

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        {quickActions.map((action, i) => (
          <motion.div key={action.label} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <Link href={action.href} className="block h-full">
              <BorderBeamPanel className="h-full w-full" beams={2} thickness={2} radius={14} glow color={action.beam}>
                <div className="flex h-full items-center gap-3 p-4 bg-zinc-900/70 backdrop-blur-sm hover:bg-zinc-900/90 transition-colors">
                  <div className={`p-2.5 rounded-xl ${action.color}`}>
                    <action.icon size={20} />
                  </div>
                  <span className="text-sm font-medium text-zinc-300 group-hover:text-white transition-colors">{action.label}</span>
                </div>
              </BorderBeamPanel>
            </Link>
          </motion.div>
        ))}
      </div>

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        {stats.map((stat, i) => (
          <motion.div key={stat.label} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.05 }}>
            <GradientBlobCard className="h-full" colors={stat.blob} intensity={0.4}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-zinc-400 font-medium uppercase tracking-wider">{stat.label}</span>
                  <stat.icon size={16} className={stat.color} />
                </div>
                <div className="text-lg font-bold text-white truncate">{stat.value}</div>
                <div className="text-xs text-green-400 mt-1">{stat.change}</div>
              </CardContent>
            </GradientBlobCard>
          </motion.div>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <Card className="lg:col-span-1">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>AI Assistant</CardTitle>
              <CardDescription>Ask Synq to negotiate, protect, or pay.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="h-[320px]">
              <AIChat />
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <GradientBlobCard colors={['#5C447A', '#9C6A97', '#CB8E9F']} intensity={0.2}>
            <CardHeader className="flex flex-row items-center justify-between bg-zinc-950/50 backdrop-blur-sm border-b border-white/5 rounded-t-xl">
              <div>
                <CardTitle>Active Deals</CardTitle>
                <CardDescription>{activeDeals.length} deal{activeDeals.length !== 1 ? 's' : ''} active</CardDescription>
              </div>
              <Link href="/deals">
                <Button variant="ghost" size="sm" className="text-xs">View All <ArrowRight size={14} className="ml-1" /></Button>
              </Link>
            </CardHeader>
            <CardContent className="space-y-3 max-h-[240px] overflow-y-auto">
              {dealsLoading ? (
                <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-blue-400" /></div>
              ) : activeDeals.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-zinc-500 text-sm">No active deals. Create your first deal to get started.</p>
                </div>
              ) : (
                activeDeals.map((deal: any, i: number) => (
                  <motion.div
                    key={deal.dealAddress}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.1 }}
                  >
                    <Link href={`/deals/${deal.dealAddress}`} className="block p-3 rounded-lg bg-zinc-800/30 border border-zinc-800/50 hover:bg-zinc-800/50 transition-all group">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-zinc-500">{shortenAddress(deal.dealAddress)}</span>
                          <Badge variant="info" className="text-[10px] px-1.5 py-0">Active</Badge>
                        </div>
                        <span className="text-sm font-semibold text-white">
                          {deal.totalValue ? `${formatCurrency(Number(deal.totalValue) / 10 ** getTokenInfo(chainKeyForId(chainId), String(deal.asset || '')).decimals)} ${getTokenInfo(chainKeyForId(chainId), String(deal.asset || '')).symbol}` : '-'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-xs text-zinc-500">
                        <span className="font-mono">{shortenAddress(deal.seller)}</span>
                        <span>{new Date(Number(deal.createdAt) * 1000).toLocaleDateString()}</span>
                      </div>
                    </Link>
                  </motion.div>
                ))
              )}
            </CardContent>
          </GradientBlobCard>

          <GradientBlobCard colors={['#F3B294', '#FFEAA9', '#CB8E9F']} intensity={0.2}>
            <CardHeader className="flex flex-row items-center justify-between bg-zinc-950/50 backdrop-blur-sm border-b border-white/5 rounded-t-xl">
              <div>
                <CardTitle>Recent Activity</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 max-h-[200px] overflow-y-auto">
              {!address ? (
                <div className="text-center py-8">
                  <p className="text-zinc-500 text-xs">Connect your wallet to see on-chain activity.</p>
                </div>
              ) : activityLoading ? (
                <div className="flex justify-center py-8"><Loader2 size={16} className="animate-spin text-blue-400" /></div>
              ) : activityItems.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-zinc-500 text-xs">No on-chain activity yet.</p>
                </div>
              ) : (
                activityItems.map((act) => (
                  <div key={act.id} className="flex items-start gap-3 p-2 rounded-lg bg-zinc-800/20 border border-zinc-800/40">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-white font-medium">{act.title}</p>
                      <p className="text-[10px] text-zinc-500">{act.description}</p>
                    </div>
                    <span className="text-[10px] text-zinc-600 shrink-0">{formatTimeAgo(act.timestamp)}</span>
                  </div>
                ))
              )}
            </CardContent>
          </GradientBlobCard>
        </div>
      </div>
    </div>
  );
}
