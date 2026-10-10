'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Press_Start_2P } from 'next/font/google';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { Search, ArrowRight, Loader2, SlidersHorizontal, Check, RefreshCw, AlertCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useAccount } from 'wagmi';
import { shortenAddress } from '@/lib/utils';
import { SYNQ_V2_SEPOLIA_CONFIG } from '@/lib/contracts/addresses';
import { ChainGuard } from '@/components/shared/ChainGuard';
import { useSynqIdentities } from '@/hooks/useSynqIdentity';
import { useAuthSession } from '@/hooks/useAuthSession';
import { sepoliaPublicClient } from '@/lib/chain';
import { formatUsdcAmount } from '@/lib/deals/v2';
import {
  type DiscoveredV2Deal,
  type DealProposalMetadata,
  fetchUserDealAddressesFromFactory,
  mergeAndDeduplicateDealAddresses,
  fetchV2DealsSummary,
  enrichDealsWithMetadata,
  V2_DEAL_STATE_LABELS,
  V2_STATUS_BADGE_VARIANT,
} from '@/lib/deals/v2-deals-discovery';

const pressStart2P = Press_Start_2P({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

const filterOptions = [
  { value: 'all', label: 'All Deals' },
  { value: '0', label: 'Draft' },
  { value: '1', label: 'Active' },
  { value: '2', label: 'Completed' },
  { value: '3', label: 'Terminated' },
  { value: '4', label: 'Cancelled' },
];

export default function DealsPage() {
  const { address } = useAccount();
  const { getToken } = useAuthSession();
  const [deals, setDeals] = useState<DiscoveredV2Deal[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const isFetchingRef = useRef(false);
  const lastFetchedAddressRef = useRef<string | null>(null);

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

  // Authoritative Standard V2 Deal Discovery & State Fetching
  const loadDeals = useCallback(
    async (force = false) => {
      if (!address) {
        setDeals([]);
        setIsLoading(false);
        setLoadError(null);
        lastFetchedAddressRef.current = null;
        return;
      }

      // Concurrency guard: avoid firing overlapping batches of RPC calls
      if (isFetchingRef.current && !force) {
        return;
      }

      try {
        isFetchingRef.current = true;
        setIsLoading(true);
        setLoadError(null);

        // 1. Authoritative enumeration on canonical SynqFactoryV2
        const { clientDeals, freelancerDeals } = await fetchUserDealAddressesFromFactory(
          sepoliaPublicClient,
          SYNQ_V2_SEPOLIA_CONFIG.factory,
          address,
        );

        // 2. Case-insensitive merge and deduplication
        const uniqueAddresses = mergeAndDeduplicateDealAddresses(clientDeals, freelancerDeals);

        if (uniqueAddresses.length === 0) {
          setDeals([]);
          lastFetchedAddressRef.current = address.toLowerCase();
          return;
        }

        // 3. Batch-read authoritative V2 Deal contract states
        const onChainStates = await fetchV2DealsSummary(sepoliaPublicClient, uniqueAddresses);

        // 4. Optional PostgreSQL metadata enrichment (non-blocking for cards)
        let metadataMap: Record<string, DealProposalMetadata> = {};
        const token = getToken();
        if (token) {
          try {
            const res = await fetch('/api/deals/metadata', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({ dealAddresses: uniqueAddresses }),
            });
            if (res.ok) {
              const json = await res.json();
              metadataMap = json.metadata || {};
            }
          } catch {
            // Metadata fetch failed or network error; proceed with safe defaults
          }
        }

        // 5. Enrich with metadata while preserving authoritative on-chain contract state
        const enriched = enrichDealsWithMetadata(uniqueAddresses, onChainStates, metadataMap);
        setDeals(enriched);
        lastFetchedAddressRef.current = address.toLowerCase();
      } catch (err: any) {
        console.error('[DealsPage] Error loading Standard V2 deals:', err);
        setLoadError(err?.message || 'Failed to query deals from Sepolia RPC.');
      } finally {
        isFetchingRef.current = false;
        setIsLoading(false);
      }
    },
    [address, getToken],
  );

  useEffect(() => {
    if (address && address.toLowerCase() !== lastFetchedAddressRef.current) {
      loadDeals();
    } else if (!address) {
      loadDeals();
    }
  }, [address, loadDeals]);

  // Extract counterparties for identity lookup
  const uniqueCounterpartyAddresses = useMemo(() => {
    const set = new Set<string>();
    for (const d of deals) {
      if (d.client) set.add(d.client.toLowerCase());
      if (d.freelancer) set.add(d.freelancer.toLowerCase());
    }
    return Array.from(set);
  }, [deals]);

  const { identitiesMap } = useSynqIdentities(uniqueCounterpartyAddresses);

  // Client-side search and status filter
  const filtered = useMemo(() => {
    return deals.filter((d) => {
      const matchesFilter = filter === 'all' || String(d.state) === filter;
      const q = search.trim().toLowerCase();
      const addrMatch = d.dealAddress.toLowerCase().includes(q);
      const titleMatch = d.title.toLowerCase().includes(q);
      const matchesSearch = !q || addrMatch || titleMatch;

      return matchesFilter && matchesSearch;
    });
  }, [deals, filter, search]);

  return (
    <div className="space-y-4 pt-0">
      {/* HEADER SECTION */}
      <div className="flex items-center gap-2.5">
        <h1
          className="text-lg font-bold tracking-tight text-white mb-0.5"
          style={{ fontFamily: pressStart2P.style.fontFamily }}
        >
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
            Track, fund, submit work, and manage your milestone escrow agreements.
          </div>
        </div>
      </div>

      <ChainGuard what="your deals are" />

      {/* ERROR BANNER IF RPC LIMIT OCCURRED */}
      {loadError && deals.length === 0 && (
        <Card className="border-red-800/40 bg-red-950/20">
          <CardContent className="p-5 flex flex-col sm:flex-row items-center justify-between gap-4 text-center sm:text-left">
            <div className="flex items-center gap-3">
              <AlertCircle size={20} className="text-red-400 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-white">Public RPC Limit or Network Delay</p>
                <p className="text-xs text-zinc-400">
                  A public RPC rate limit was encountered while reading Sepolia. Your on-chain deals are safe.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => loadDeals(true)}
              disabled={isLoading}
              className="px-3.5 py-1.5 rounded-lg bg-red-900/60 hover:bg-red-800/80 border border-red-700/50 text-white text-xs font-medium transition-colors shrink-0 flex items-center gap-1.5"
            >
              <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
              <span>Retry Discovery</span>
            </button>
          </CardContent>
        </Card>
      )}

      {/* TOOLBAR CONTROLS: SEARCH & FILTER */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search deals by title or address..."
            className="pl-9 h-9 text-xs bg-zinc-900/40 border-zinc-800/80 rounded-xl focus:border-zinc-700 focus:bg-zinc-900/80"
          />
        </div>

        <div className="relative" ref={filterRef}>
          <button
            type="button"
            onClick={() => setFilterOpen((o) => !o)}
            className={`flex items-center gap-2 px-3 h-9 rounded-xl border text-xs font-medium transition-colors ${
              filter !== 'all'
                ? 'border-blue-500/40 bg-blue-600/10 text-blue-400'
                : 'border-zinc-800/80 bg-zinc-900/40 text-zinc-300 hover:bg-zinc-800/60 hover:text-white'
            }`}
          >
            <SlidersHorizontal size={13} className="text-zinc-400" />
            <span>
              {filter === 'all'
                ? 'Filter Status'
                : filterOptions.find((o) => o.value === filter)?.label || 'Filter'}
            </span>
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
      ) : isLoading && deals.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-blue-400" />
        </div>
      ) : (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3 pt-1">
          {filtered.map((deal, i) => {
            const statusStr = String(deal.state);
            const userAddr = address?.toLowerCase();
            const clientAddr = deal.client.toLowerCase();
            const freelancerAddr = deal.freelancer.toLowerCase();

            const clientIdent = identitiesMap[clientAddr];
            const freelancerIdent = identitiesMap[freelancerAddr];
            const clientLabel = clientIdent?.displayHandle || shortenAddress(deal.client);
            const freelancerLabel = freelancerIdent?.displayHandle || shortenAddress(deal.freelancer);

            let counterpartyText = '';
            let counterpartyRole = '';
            if (userAddr && userAddr === clientAddr) {
              counterpartyText = freelancerLabel;
              counterpartyRole = 'Freelancer';
            } else if (userAddr && userAddr === freelancerAddr) {
              counterpartyText = clientLabel;
              counterpartyRole = 'Client';
            } else {
              counterpartyText = `${clientLabel} → ${freelancerLabel}`;
            }

            const createdDate = deal.createdAt
              ? new Date(deal.createdAt).toLocaleDateString()
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
                            title={deal.title}
                          >
                            {deal.title}
                          </h3>
                          <Badge
                            variant={V2_STATUS_BADGE_VARIANT[statusStr] ?? 'secondary'}
                            className="text-[10px] shrink-0 font-medium px-2 py-0.5"
                          >
                            {V2_DEAL_STATE_LABELS[statusStr] ?? 'Unknown'}
                          </Badge>
                        </div>
                        <div className="text-xs font-mono text-zinc-500">
                          {shortenAddress(deal.dealAddress)}
                        </div>
                      </div>

                      {/* MAIN VALUE */}
                      <div className="py-2 border-y border-zinc-800/60 flex items-baseline justify-between">
                        <span className="text-xs text-zinc-400">Total Escrow</span>
                        <span className="text-xl font-bold text-white font-mono">
                          {formatUsdcAmount(deal.totalEscrow)}
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
