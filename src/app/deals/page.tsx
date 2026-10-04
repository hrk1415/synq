'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { Press_Start_2P } from 'next/font/google';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { Search, ArrowRight, Loader2, SlidersHorizontal, Check } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useAccount, useReadContract } from 'wagmi';
import { nexotiqFactoryABI } from '@/lib/contracts/abis';
import { formatTokenAmount, shortenAddress } from '@/lib/utils';
import { CONTRACT_ADDRESSES, getTokenInfo, SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { ChainGuard } from '@/components/shared/ChainGuard';
import { useDealStatuses } from '@/hooks/useDealStatuses';
import { useSynqIdentities } from '@/hooks/useSynqIdentity';

const pressStart2P = Press_Start_2P({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

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

const filterOptions = [
  { value: 'all', label: 'All Deals' },
  { value: '1', label: 'Active' },
  { value: '2', label: 'Completed' },
  { value: '3', label: 'Disputed' },
  { value: '4', label: 'Cancelled' },
];

export default function DealsPage() {
  const { address } = useAccount();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  const factoryAddress = CONTRACT_ADDRESSES.sepolia.NexotiqFactory as `0x${string}`;
  const onSupportedChain = true;

  // Click-outside & Escape key handling for Filter Dropdown
  useEffect(() => {
    if (!filterOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFilterOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [filterOpen]);

  const formatDealValue = (deal: any) => {
    if (!deal.totalValue) return '-';
    const token = getTokenInfo('sepolia', String(deal.asset || ''));
    if (!token) return '-';
    let b: bigint;
    try {
      b = BigInt(String(deal.totalValue));
    } catch {
      b = 0n;
    }
    return `${formatTokenAmount(b, token.decimals)} ${token.symbol}`;
  };

  const { data: rawDeals, isLoading } = useReadContract({
    address: factoryAddress,
    abi: nexotiqFactoryABI,
    functionName: 'getUserDeals',
    args: address ? [address] : undefined,
    chainId: SEPOLIA_CHAIN_ID,
    query: { enabled: !!address && onSupportedChain },
  });

  const uniqueDealAddresses = useMemo(() => {
    if (!rawDeals) return [];
    const seen = new Set<string>();
    const list: string[] = [];
    for (const d of rawDeals as any[]) {
      if (!d || !d.dealAddress) continue;
      const addr = String(d.dealAddress).toLowerCase();
      if (!seen.has(addr)) {
        seen.add(addr);
        list.push(d.dealAddress);
      }
    }
    return list;
  }, [rawDeals]);

  const { statuses, titles } = useDealStatuses(uniqueDealAddresses);

  const uniqueCounterpartyAddresses = useMemo(() => {
    if (!rawDeals) return [];
    const set = new Set<string>();
    for (const d of rawDeals as any[]) {
      if (d?.buyer) set.add(String(d.buyer));
      if (d?.seller) set.add(String(d.seller));
    }
    return Array.from(set);
  }, [rawDeals]);

  const { identitiesMap } = useSynqIdentities(uniqueCounterpartyAddresses);

  const filtered = useMemo(() => {
    if (!rawDeals) return [];
    const seen = new Set<string>();
    const deals = (rawDeals as any[]).filter((d: any) => {
      if (!d || !d.dealAddress) return false;
      const key = String(d.dealAddress).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return deals.filter((d: any, index: number) => {
      const key = String(d.dealAddress).toLowerCase();
      const st = statuses[key];
      const status = st === undefined ? (d.active ? 1 : 4) : st;
      const realTitle = titles[key] || `Deal #${index + 1}`;

      const matchesFilter = filter === 'all' || String(status) === filter;
      const q = search.trim().toLowerCase();
      const matchesSearch =
        !q || key.includes(q) || realTitle.toLowerCase().includes(q);

      return matchesFilter && matchesSearch;
    });
  }, [rawDeals, statuses, titles, filter, search]);

  return (
    <div className="space-y-4 pt-0">
      {/* COMPACT TITLE ROW WITH HOVER/FOCUS TOOLTIP */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <h1 className={`${pressStart2P.className} text-xl md:text-2xl font-normal text-white tracking-tight`}>
            My Deals
          </h1>
          <div className="relative group inline-block">
            <button
              type="button"
              tabIndex={0}
              aria-label="About My Deals"
              className="w-5 h-5 rounded-full bg-zinc-800/80 hover:bg-zinc-800 border border-zinc-700/60 text-zinc-400 hover:text-white text-[11px] font-bold font-mono inline-flex items-center justify-center shrink-0 transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            >
              ?
            </button>
            <div className="absolute left-0 top-full mt-2 w-72 sm:w-80 p-3 rounded-xl bg-zinc-900 border border-zinc-700/80 text-zinc-200 text-xs leading-relaxed shadow-2xl opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-all duration-150 z-30">
              Track and manage all your on-chain deals. Open any deal to manage its escrow, milestones, disputes, and current status.
            </div>
          </div>
        </div>
      </div>

      <ChainGuard what="your deals are" />

      {/* COMPACT SEARCH & FILTER ROW */}
      <div className="flex items-center gap-2 sm:gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by deal name or address..."
            className="pl-10 h-10 text-sm bg-zinc-900/80 border-zinc-800"
          />
        </div>

        {/* COMPACT FILTER DROPDOWN */}
        <div ref={filterRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setFilterOpen(!filterOpen)}
            className={`h-10 px-3.5 rounded-xl border text-xs font-medium flex items-center gap-2 transition-all ${
              filter !== 'all'
                ? 'bg-blue-600/15 text-blue-400 border-blue-500/30'
                : 'bg-zinc-900/80 text-zinc-300 border-zinc-800 hover:bg-zinc-800 hover:text-white'
            }`}
          >
            <SlidersHorizontal size={14} />
            <span>Filter</span>
            {filter !== 'all' && (
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            )}
          </button>

          {filterOpen && (
            <div className="absolute right-0 top-full mt-2 w-44 rounded-xl bg-zinc-900 border border-zinc-700/80 shadow-2xl p-1.5 z-30 space-y-0.5">
              {filterOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setFilter(opt.value);
                    setFilterOpen(false);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg transition-colors ${
                    filter === opt.value
                      ? 'bg-blue-600/15 text-blue-400 font-semibold'
                      : 'text-zinc-300 hover:bg-zinc-800 hover:text-white'
                  }`}
                >
                  <span>{opt.label}</span>
                  {filter === opt.value && <Check size={14} className="text-blue-400" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {!address ? (
        <Card className="bg-zinc-900/60 border-zinc-800">
          <CardContent className="p-12 text-center">
            <p className="text-zinc-400">Connect your wallet to view your deals.</p>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-blue-400" />
        </div>
      ) : (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3 pt-1">
          {filtered.map((deal: any, i: number) => {
            const key = String(deal.dealAddress).toLowerCase();
            const st = statuses[key];
            const statusVal = st === undefined ? (deal.active ? 1 : 4) : st;
            const realTitle = titles[key] || `Deal #${i + 1}`;

            const userAddr = address?.toLowerCase();
            const buyerAddr = String(deal.buyer || '').toLowerCase();
            const sellerAddr = String(deal.seller || '').toLowerCase();

            const buyerIdent = identitiesMap[buyerAddr];
            const sellerIdent = identitiesMap[sellerAddr];
            const buyerLabel = buyerIdent?.displayHandle || shortenAddress(deal.buyer);
            const sellerLabel = sellerIdent?.displayHandle || shortenAddress(deal.seller);

            let counterpartyText = '';
            let counterpartyRole = '';
            if (userAddr && userAddr === buyerAddr) {
              counterpartyText = sellerLabel;
              counterpartyRole = 'Freelancer';
            } else if (userAddr && userAddr === sellerAddr) {
              counterpartyText = buyerLabel;
              counterpartyRole = 'Client';
            } else {
              counterpartyText = `${buyerLabel} → ${sellerLabel}`;
            }

            const createdDate = deal.createdAt
              ? new Date(Number(deal.createdAt) * 1000).toLocaleDateString()
              : undefined;

            return (
              <motion.div
                key={deal.dealAddress}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
              >
                <Link href={`/deals/${deal.dealAddress}`}>
                  <Card className="group h-full bg-zinc-900/60 border-zinc-800/80 hover:border-zinc-700/80 hover:bg-zinc-900/90 transition-all cursor-pointer flex flex-col justify-between">
                    <CardContent className="p-5 flex flex-col h-full justify-between gap-4">
                      {/* TOP SECTION: TITLE & STATUS */}
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <h3
                            className="text-base font-semibold text-white group-hover:text-blue-400 transition-colors line-clamp-2 leading-snug"
                            title={realTitle}
                          >
                            {realTitle}
                          </h3>
                          <Badge
                            variant={statusBadgeVariant[String(statusVal)] ?? 'secondary'}
                            className="text-[10px] shrink-0 font-medium px-2 py-0.5"
                          >
                            {statusLabels[String(statusVal)] ?? 'Unknown'}
                          </Badge>
                        </div>
                        <div className="text-xs font-mono text-zinc-500">
                          {shortenAddress(deal.dealAddress)}
                        </div>
                      </div>

                      {/* MAIN VALUE */}
                      <div className="py-2 border-y border-zinc-800/60 flex items-baseline justify-between">
                        <span className="text-xs text-zinc-400">Total Value</span>
                        <span className="text-xl font-bold text-white font-mono">
                          {formatDealValue(deal)}
                        </span>
                      </div>

                      {/* RELATIONSHIP & DETAILS */}
                      <div className="space-y-1.5 text-xs text-zinc-400">
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-500">Counterparty</span>
                          <span className="font-mono text-zinc-200">
                            {counterpartyRole ? `With ${counterpartyText} (${counterpartyRole})` : counterpartyText}
                          </span>
                        </div>
                        {createdDate && (
                          <div className="flex items-center justify-between">
                            <span className="text-zinc-500">Created</span>
                            <span className="text-zinc-300">{createdDate}</span>
                          </div>
                        )}
                      </div>

                      {/* BOTTOM ACTION */}
                      <div className="pt-2 flex items-center justify-end text-xs font-medium text-blue-400 group-hover:text-blue-300 transition-colors">
                        <span>Open Deal</span>
                        <ArrowRight size={14} className="ml-1 group-hover:translate-x-0.5 transition-transform" />
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              </motion.div>
            );
          })}
          {filtered.length === 0 && (
            <div className="col-span-full text-center py-20">
              <p className="text-zinc-500 text-sm">No deals found matching your search or filter.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
