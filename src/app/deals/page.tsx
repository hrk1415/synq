'use client';

import { useState, useMemo, useEffect } from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { Plus, Search, ArrowRight, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { useAccount, useChainId, useReadContract } from 'wagmi';
import { getFactoryAddress } from '@/hooks/useFactoryContract';
import { nexotiqFactoryABI, nexotiqDealABI } from '@/lib/contracts/abis';
import { getPublicClient } from '@/lib/chain';
import { formatCurrency, shortenAddress } from '@/lib/utils';
import { getTokenInfo, chainKeyForId, isSupportedChain } from '@/lib/contracts/addresses';
import { ChainGuard } from '@/components/shared/ChainGuard';

const statusLabels: Record<string, string> = {
  '0': 'Draft',
  '1': 'Active',
  '2': 'Completed',
  '3': 'Disputed',
  '4': 'Cancelled',
};

const statusBadgeVariant: Record<string, any> = {
  '0': 'secondary',
  '1': 'info',
  '2': 'success',
  '3': 'destructive',
  '4': 'secondary',
};

const statusFilters = ['all', '1', '2', '3', '4'];

export default function DealsPage() {
  const { address } = useAccount();
  const chainId = useChainId();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const factoryAddress = getFactoryAddress(chainId);
  const onSupportedChain = isSupportedChain(chainId) && !!factoryAddress;

  const { data: rawDeals, isLoading } = useReadContract({
    address: factoryAddress,
    abi: nexotiqFactoryABI,
    functionName: 'getUserDeals',
    args: address ? [address] : undefined,
    query: { enabled: !!address && onSupportedChain },
  });

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

  const filtered = useMemo(() => {
    if (!rawDeals) return [];
    const seen = new Set<string>();
    const deals = (rawDeals as any[]).filter((d: any) => {
      if (!d) return false;
      const key = String(d.dealAddress).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return deals.filter((d: any) => {
      const st = dealStatuses[String(d.dealAddress)];
      const status = st === undefined ? (d.active ? 1 : 4) : st;
      const matchesFilter = filter === 'all' || String(status) === filter;
      const matchesSearch = String(d.dealAddress).toLowerCase().includes(search.toLowerCase());
      return matchesFilter && matchesSearch;
    });
  }, [rawDeals, dealStatuses, filter, search]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">My Deals</h1>
          <p className="text-zinc-400 text-sm mt-1">Track and manage all your on-chain deals.</p>
        </div>
        <Link href="/deal/new">
          <Button className="gap-2"><Plus size={16} /> New Deal</Button>
        </Link>
      </div>

      <ChainGuard what="your deals are" />

      <div className="flex items-center gap-3 flex-wrap">
        {statusFilters.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              filter === s ? 'bg-blue-600/10 text-blue-400 border border-blue-500/20' : 'text-zinc-400 hover:text-white hover:bg-zinc-800/50'
            }`}
          >
            {s === 'all' ? 'All Deals' : s === '1' ? 'Active' : s === '2' ? 'Completed' : s === '3' ? 'Disputed' : 'Cancelled'}
          </button>
        ))}
      </div>

      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by deal address..."
          className="pl-10 font-mono text-xs"
        />
      </div>

      {!address ? (
        <Card>
          <CardContent className="p-12 text-center">
            <p className="text-zinc-400">Connect your wallet to view your deals.</p>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-blue-400" />
        </div>
      ) : (
        <div className="grid gap-4">
          {filtered.map((deal: any, i: number) => (
            <motion.div
              key={deal.dealAddress}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <Link href={`/deals/${deal.dealAddress}`}>
                <Card className="group hover:border-zinc-700 transition-all cursor-pointer">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-mono text-zinc-500">{shortenAddress(deal.dealAddress)}</span>
                          <Badge variant={statusBadgeVariant[String(dealStatuses[String(deal.dealAddress)] ?? (deal.active ? 1 : 4))] ?? 'secondary'} className="text-[10px]">
                            {statusLabels[String(dealStatuses[String(deal.dealAddress)] ?? (deal.active ? 1 : 4))] ?? 'Unknown'}
                          </Badge>
                        </div>
                        <h3 className="text-base font-semibold text-white group-hover:text-blue-400 transition-colors">
                          Deal #{i + 1}
                        </h3>
                      </div>
                      <span className="text-lg font-bold text-white">
                        {deal.totalValue ? `${formatCurrency(Number(deal.totalValue) / 10 ** getTokenInfo(chainKeyForId(chainId), String(deal.asset || '')).decimals)} ${getTokenInfo(chainKeyForId(chainId), String(deal.asset || '')).symbol}` : '-'}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-zinc-400">
                      <span className="font-mono text-xs">{shortenAddress(deal.buyer)}</span>
                      <ArrowRight size={12} />
                      <span className="font-mono text-xs">{shortenAddress(deal.seller)}</span>
                      <span className="text-zinc-600">|</span>
                      <span>{new Date(Number(deal.createdAt) * 1000).toLocaleDateString()}</span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            </motion.div>
          ))}
          {filtered.length === 0 && (
            <div className="text-center py-20">
              <p className="text-zinc-500 text-sm">No deals found. Create your first deal to get started.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
