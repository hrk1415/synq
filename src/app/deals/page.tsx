'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Press_Start_2P } from 'next/font/google';
import { motion } from 'framer-motion';
import Link from 'next/link';
import {
  Search,
  ArrowRight,
  Loader2,
  SlidersHorizontal,
  Check,
  RefreshCw,
  AlertCircle,
  Shield,
  ShieldCheck,
  RotateCcw,
  FileText,
  Wallet,
  Clock,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useAccount } from 'wagmi';
import { shortenAddress } from '@/lib/utils';
import { SYNQ_V2_SEPOLIA_CONFIG, getSynqPremiumConfig } from '@/lib/contracts/addresses';
import { ChainGuard } from '@/components/shared/ChainGuard';
import { useSynqIdentities } from '@/hooks/useSynqIdentity';
import { useAuthSession } from '@/hooks/useAuthSession';
import { sepoliaPublicClient } from '@/lib/chain';
import { formatUsdcAmount } from '@/lib/deals/v2';
import { batchReadDealPremiumPolicies, type PremiumPolicyState } from '@/lib/deals/v2-protection';
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
import { type PendingProposalCardData } from '@/lib/deals/proposals-db';
import { synqFactoryV2ABI } from '@/lib/contracts/abis';
import { getAddress } from 'viem';

const pressStart2P = Press_Start_2P({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

const filterOptions = [
  { value: 'all', label: 'All States' },
  { value: '0', label: 'Draft' },
  { value: '1', label: 'Active' },
  { value: '2', label: 'Completed' },
  { value: '3', label: 'Terminated' },
  { value: '4', label: 'Cancelled' },
];

export default function DealsPage() {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected, status } = useAccount();
  const isAccountRestoring = status === 'connecting' || status === 'reconnecting';
  const effectiveAddress = (mounted && isConnected && !!address && !isAccountRestoring) ? address : undefined;
  const { getToken } = useAuthSession();
  const [deals, setDeals] = useState<DiscoveredV2Deal[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<'all' | 'client' | 'freelancer'>('all');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const isFetchingRef = useRef(false);
  const lastFetchedAddressRef = useRef<string | null>(null);

  // Top-Level View State: 'deals' | 'proposals'
  const [activeView, setActiveView] = useState<'deals' | 'proposals'>('deals');

  // Pending Proposals State
  const [pendingProposals, setPendingProposals] = useState<PendingProposalCardData[]>([]);
  const [pendingTotal, setPendingTotal] = useState<number>(0);
  const [isLoadingProposals, setIsLoadingProposals] = useState<boolean>(false);
  const [proposalError, setProposalError] = useState<{ type: 'auth' | 'api'; message: string } | null>(null);
  const [proposalRoleFilter, setProposalRoleFilter] = useState<'all' | 'client' | 'freelancer'>('all');
  const [proposalSearch, setProposalSearch] = useState<string>('');
  const [verificationMap, setVerificationMap] = useState<
    Record<string, 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED' | 'UNVERIFIED' | 'VERIFYING'>
  >({});

  const isFetchingProposalsRef = useRef<boolean>(false);
  const lastFetchedProposalAddressRef = useRef<string | null>(null);
  const hasFetchedProposalsRef = useRef<boolean>(false);

  useEffect(() => {
    setMounted(true);
  }, []);

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
      const targetAddress = effectiveAddress || address;
      if (!targetAddress) {
        setDeals((prev) => (prev.length === 0 ? prev : []));
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
          targetAddress,
        );

        // 2. Case-insensitive merge and deduplication
        const uniqueAddresses = mergeAndDeduplicateDealAddresses(clientDeals, freelancerDeals);

        if (uniqueAddresses.length === 0) {
          setDeals((prev) => (prev.length === 0 ? prev : []));
          lastFetchedAddressRef.current = targetAddress.toLowerCase();
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

        // 5. Batch-read on-chain Premium Protection policies in a single multicall
        let policiesMap = new Map<string, PremiumPolicyState>();
        const premiumConfig = getSynqPremiumConfig();
        if (premiumConfig.isConfigured && premiumConfig.manager) {
          try {
            policiesMap = await batchReadDealPremiumPolicies(
              sepoliaPublicClient,
              premiumConfig.manager,
              uniqueAddresses
            );
          } catch (err) {
            console.warn('[DealsPage] Error batch reading premium policies:', err);
          }
        }

        // 6. Enrich with metadata & authoritative on-chain protection while preserving contract state
        const enriched = enrichDealsWithMetadata(uniqueAddresses, onChainStates, metadataMap, policiesMap);
        setDeals(enriched);
        lastFetchedAddressRef.current = targetAddress.toLowerCase();
      } catch (err: any) {
        console.error('[DealsPage] Error loading Standard V2 deals:', err);
        setLoadError(err?.message || 'Failed to query deals from Sepolia RPC.');
      } finally {
        isFetchingRef.current = false;
        setIsLoading(false);
      }
    },
    [address, effectiveAddress, getToken],
  );

  // On-chain proposal status verifier (bounded to the loaded page of proposals)
  const verifyProposalsOnChain = useCallback(async (proposalsToVerify: PendingProposalCardData[]) => {
    if (proposalsToVerify.length === 0) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const initialMap: Record<
      string,
      'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED' | 'UNVERIFIED' | 'VERIFYING'
    > = {};
    const neededCheck: PendingProposalCardData[] = [];

    for (const p of proposalsToVerify) {
      if (nowSec > Number(p.expiry)) {
        initialMap[p.proposalId] = 'EXPIRED';
      } else {
        initialMap[p.proposalId] = 'VERIFYING';
        neededCheck.push(p);
      }
    }

    setVerificationMap((prev) => ({ ...prev, ...initialMap }));
    if (neededCheck.length === 0) return;

    const results = await Promise.allSettled(
      neededCheck.map(async (p) => {
        try {
          const rawStatus = await sepoliaPublicClient.readContract({
            address: SYNQ_V2_SEPOLIA_CONFIG.factory as `0x${string}`,
            abi: synqFactoryV2ABI,
            functionName: 'getProposalStatusById',
            args: [
              p.proposalId.toLowerCase() as `0x${string}`,
              getAddress(p.clientWallet),
              BigInt(p.proposalNonce),
              BigInt(p.expiry),
            ],
          });
          const statusNum = Number(rawStatus);
          const map: Record<
            number,
            'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED'
          > = {
            0: 'PENDING',
            1: 'ACCEPTED',
            2: 'DECLINED',
            3: 'CANCELLED',
            4: 'EXPIRED',
          };
          return {
            proposalId: p.proposalId,
            status: map[statusNum] || ('UNVERIFIED' as const),
          };
        } catch {
          return { proposalId: p.proposalId, status: 'UNVERIFIED' as const };
        }
      })
    );

    const updates: Record<
      string,
      'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED' | 'UNVERIFIED' | 'VERIFYING'
    > = {};
    for (const r of results) {
      if (r.status === 'fulfilled') {
        updates[r.value.proposalId] = r.value.status;
      }
    }

    setVerificationMap((prev) => ({ ...prev, ...updates }));
  }, []);

  // Authoritative Participant-Scoped Pending Proposals Fetching
  const loadProposals = useCallback(
    async (force = false) => {
      const targetAddress = effectiveAddress || address;
      if (!targetAddress) {
        setPendingProposals([]);
        setIsLoadingProposals(false);
        setProposalError(null);
        lastFetchedProposalAddressRef.current = null;
        hasFetchedProposalsRef.current = false;
        return;
      }

      if (isFetchingProposalsRef.current && !force) return;

      try {
        isFetchingProposalsRef.current = true;
        setIsLoadingProposals(true);
        setProposalError(null);

        const token = getToken();
        if (!token) {
          setProposalError({
            type: 'auth',
            message: 'Sign in to authenticate session and view your pending proposals.',
          });
          setIsLoadingProposals(false);
          return;
        }

        const res = await fetch('/api/deals/proposals?mode=pending&limit=50', {
          headers: {
            authorization: `Bearer ${token}`,
          },
        });

        if (res.status === 401) {
          setProposalError({
            type: 'auth',
            message: 'Authentication required. Please sign in to view your pending proposals.',
          });
          setIsLoadingProposals(false);
          return;
        }

        if (!res.ok) {
          throw new Error(`API error (${res.status})`);
        }

        const data = await res.json();
        const rawProposals: PendingProposalCardData[] = data.proposals || [];
        setPendingProposals(rawProposals);
        setPendingTotal(data.total ?? rawProposals.length);
        hasFetchedProposalsRef.current = true;
        lastFetchedProposalAddressRef.current = targetAddress.toLowerCase();

        // Initiate bounded on-chain validity verification
        verifyProposalsOnChain(rawProposals);
      } catch (err: any) {
        console.error('[DealsPage] Error loading pending proposals:', err);
        setProposalError({
          type: 'api',
          message: err?.message || 'Failed to load pending proposals from server.',
        });
      } finally {
        isFetchingProposalsRef.current = false;
        setIsLoadingProposals(false);
      }
    },
    [address, effectiveAddress, getToken, verifyProposalsOnChain]
  );

  useEffect(() => {
    if (!mounted) return;
    if (effectiveAddress && effectiveAddress.toLowerCase() !== lastFetchedAddressRef.current) {
      loadDeals();
    } else if (!effectiveAddress && lastFetchedAddressRef.current !== null) {
      loadDeals();
    }

    // Proposals cache invalidation & reload if activeView is proposals
    if (effectiveAddress && effectiveAddress.toLowerCase() !== lastFetchedProposalAddressRef.current) {
      hasFetchedProposalsRef.current = false;
      if (activeView === 'proposals') {
        loadProposals();
      }
    } else if (!effectiveAddress && lastFetchedProposalAddressRef.current !== null) {
      setPendingProposals([]);
      hasFetchedProposalsRef.current = false;
      lastFetchedProposalAddressRef.current = null;
    }
  }, [effectiveAddress, mounted, loadDeals, loadProposals, activeView]);

  // Extract counterparties for identity lookup across both deals and pending proposals
  const uniqueCounterpartyAddresses = useMemo(() => {
    const set = new Set<string>();
    for (const d of deals) {
      if (d.client) set.add(d.client.toLowerCase());
      if (d.freelancer) set.add(d.freelancer.toLowerCase());
    }
    for (const p of pendingProposals) {
      if (p.clientWallet) set.add(p.clientWallet.toLowerCase());
      if (p.freelancerWallet) set.add(p.freelancerWallet.toLowerCase());
    }
    return Array.from(set);
  }, [deals, pendingProposals]);

  const { identitiesMap } = useSynqIdentities(uniqueCounterpartyAddresses);

  // Authoritative role counts for deployed deals
  const clientCount = useMemo(() => {
    if (!effectiveAddress) return 0;
    const userAddr = effectiveAddress.toLowerCase();
    return deals.filter((d) => d.client.toLowerCase() === userAddr).length;
  }, [deals, effectiveAddress]);

  const freelancerCount = useMemo(() => {
    if (!effectiveAddress) return 0;
    const userAddr = effectiveAddress.toLowerCase();
    return deals.filter((d) => d.freelancer.toLowerCase() === userAddr).length;
  }, [deals, effectiveAddress]);

  // Sets of deployed deal addresses and proposal IDs to filter out stale accepted proposals
  const deployedDealAddressesSet = useMemo(() => {
    return new Set(deals.map((d) => d.dealAddress.toLowerCase()));
  }, [deals]);

  const deployedProposalIdsSet = useMemo(() => {
    const set = new Set<string>();
    for (const d of deals) {
      if (d.proposalId) {
        set.add(d.proposalId.toLowerCase());
      }
    }
    return set;
  }, [deals]);

  // Actionable pending proposals: exclude those whose deployed contract is already known
  const actionableProposals = useMemo(() => {
    return pendingProposals.filter((p) => {
      if (p.dealAddress && deployedDealAddressesSet.has(p.dealAddress.toLowerCase())) {
        return false;
      }
      if (deployedProposalIdsSet.has(p.proposalId.toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [pendingProposals, deployedDealAddressesSet, deployedProposalIdsSet]);

  // Role counts for pending proposals
  const pendingClientCount = useMemo(() => {
    if (!effectiveAddress) return 0;
    const userAddr = effectiveAddress.toLowerCase();
    return actionableProposals.filter((p) => p.clientWallet.toLowerCase() === userAddr).length;
  }, [actionableProposals, effectiveAddress]);

  const pendingFreelancerCount = useMemo(() => {
    if (!effectiveAddress) return 0;
    const userAddr = effectiveAddress.toLowerCase();
    return actionableProposals.filter((p) => p.freelancerWallet.toLowerCase() === userAddr).length;
  }, [actionableProposals, effectiveAddress]);

  // Clear all filters actions
  const clearFilters = useCallback(() => {
    setRoleFilter('all');
    setFilter('all');
    setSearch('');
  }, []);

  const clearProposalFilters = useCallback(() => {
    setProposalRoleFilter('all');
    setProposalSearch('');
  }, []);

  // Client-side combined search, status filter, and role filter
  const filtered = useMemo(() => {
    const userAddr = (effectiveAddress || address)?.toLowerCase();
    return deals.filter((d) => {
      // 1. Role filter
      if (roleFilter === 'client') {
        if (!userAddr || d.client.toLowerCase() !== userAddr) return false;
      } else if (roleFilter === 'freelancer') {
        if (!userAddr || d.freelancer.toLowerCase() !== userAddr) return false;
      }

      // 2. Status filter
      const matchesFilter = filter === 'all' || String(d.state) === filter;
      if (!matchesFilter) return false;

      // 3. Search query
      const q = search.trim().toLowerCase();
      if (!q) return true;
      const addrMatch = d.dealAddress.toLowerCase().includes(q);
      const titleMatch = d.title.toLowerCase().includes(q);
      return addrMatch || titleMatch;
    });
  }, [deals, roleFilter, filter, search, effectiveAddress, address]);

  // Client-side combined search and role filter for pending proposals
  const filteredProposals = useMemo(() => {
    const userAddr = (effectiveAddress || address)?.toLowerCase();
    return actionableProposals.filter((p) => {
      // 1. Role filter
      if (proposalRoleFilter === 'client') {
        if (!userAddr || p.clientWallet.toLowerCase() !== userAddr) return false;
      } else if (proposalRoleFilter === 'freelancer') {
        if (!userAddr || p.freelancerWallet.toLowerCase() !== userAddr) return false;
      }

      // 2. Search query (title or proposalId)
      const q = proposalSearch.trim().toLowerCase();
      if (!q) return true;
      const idMatch = p.proposalId.toLowerCase().includes(q);
      const titleMatch = p.title.toLowerCase().includes(q);
      return idMatch || titleMatch;
    });
  }, [actionableProposals, proposalRoleFilter, proposalSearch, effectiveAddress, address]);

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
              className="w-5 h-5 rounded-full bg-[#252525] hover:bg-white/10 border border-white/20 text-[#A3A3A3] hover:text-white text-[11px] font-bold font-mono inline-flex items-center justify-center shrink-0 transition-colors focus:outline-none focus:ring-1 focus:ring-white/40"
            >
              ?
            </button>
            <div className="absolute left-0 top-full mt-2 w-72 sm:w-80 p-3 rounded-xl bg-[#1B1B1B] border border-white/75 text-white text-xs leading-relaxed shadow-2xl opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-all duration-150 z-30">
              Track, fund, submit work, and manage your milestone escrow agreements.
            </div>
          </div>
        </div>
      </div>

      <ChainGuard what="your deals are" />

      {/* TOP-LEVEL VIEW SWITCHER: DEPLOYED DEALS VS PENDING PROPOSALS */}
      <div className="flex items-center gap-2 border-b border-white/10 pb-3">
        <button
          type="button"
          onClick={() => setActiveView('deals')}
          className={`px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-medium transition-colors flex items-center gap-2 ${
            activeView === 'deals'
              ? 'bg-white/15 text-white font-semibold border border-white/20 shadow-sm'
              : 'text-[#A3A3A3] hover:text-white hover:bg-white/5 border border-transparent'
          }`}
        >
          <FileText size={14} />
          <span>Deployed Deals</span>
          <span
            className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
              activeView === 'deals' ? 'bg-white/20 text-white' : 'bg-white/10 text-zinc-400'
            }`}
          >
            {effectiveAddress ? deals.length : '—'}
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveView('proposals');
            if (effectiveAddress && !hasFetchedProposalsRef.current) {
              loadProposals();
            }
          }}
          className={`px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-medium transition-colors flex items-center gap-2 ${
            activeView === 'proposals'
              ? 'bg-white/15 text-white font-semibold border border-white/20 shadow-sm'
              : 'text-[#A3A3A3] hover:text-white hover:bg-white/5 border border-transparent'
          }`}
        >
          <Clock size={14} />
          <span>Pending Proposals</span>
          <span
            className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
              activeView === 'proposals' ? 'bg-white/20 text-white' : 'bg-white/10 text-zinc-400'
            }`}
          >
            {effectiveAddress
              ? isLoadingProposals && pendingProposals.length === 0
                ? '...'
                : actionableProposals.length
              : '—'}
          </span>
        </button>
      </div>

      {activeView === 'deals' ? (
        <>
          {/* ERROR BANNER IF RPC LIMIT OCCURRED */}
          {loadError && deals.length === 0 && (
            <Card className="border-red-800/40 bg-red-950/20">
              <CardContent className="p-5 flex flex-col sm:flex-row items-center justify-between gap-4 text-center sm:text-left">
                <div className="flex items-center gap-3">
                  <AlertCircle size={20} className="text-red-400 shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-white">Public RPC Limit or Network Delay</p>
                    <p className="text-xs text-[#A3A3A3]">
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

          {/* TOOLBAR CONTROLS: ROLE TABS, EXPANDED SEARCH & STATUS FILTER */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
            {/* Role Filter Tabs (Natural content width) */}
            <div className="flex items-center p-1 bg-[#252525] border border-white/20 rounded-xl overflow-x-auto shrink-0 gap-1">
              <button
                type="button"
                onClick={() => setRoleFilter('all')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 shrink-0 ${
                  roleFilter === 'all'
                    ? 'bg-white/20 text-white font-semibold'
                    : 'text-[#A3A3A3] hover:text-white hover:bg-white/5'
                }`}
              >
                <span>All Deals</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                    roleFilter === 'all' ? 'bg-white/30 text-white' : 'bg-white/10 text-zinc-400'
                  }`}
                >
                  {effectiveAddress ? deals.length : '—'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setRoleFilter('client')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 shrink-0 ${
                  roleFilter === 'client'
                    ? 'bg-white/20 text-white font-semibold'
                    : 'text-[#A3A3A3] hover:text-white hover:bg-white/5'
                }`}
              >
                <span>As Client</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                    roleFilter === 'client' ? 'bg-white/30 text-white' : 'bg-white/10 text-zinc-400'
                  }`}
                >
                  {effectiveAddress ? clientCount : '—'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setRoleFilter('freelancer')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 shrink-0 ${
                  roleFilter === 'freelancer'
                    ? 'bg-white/20 text-white font-semibold'
                    : 'text-[#A3A3A3] hover:text-white hover:bg-white/5'
                }`}
              >
                <span>As Freelancer</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                    roleFilter === 'freelancer' ? 'bg-white/30 text-white' : 'bg-white/10 text-zinc-400'
                  }`}
                >
                  {effectiveAddress ? freelancerCount : '—'}
                </span>
              </button>
            </div>

            {/* Search Input (Flexible width, fills ALL remaining horizontal space) */}
            <div className="relative flex-1 min-w-0">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A3A3A3]" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search deals by title or address..."
                className="pl-9 h-9 text-xs bg-[#252525] border-white/20 text-white placeholder:text-[#A3A3A3] rounded-xl focus:border-white focus:ring-1 focus:ring-white/40 w-full"
              />
            </div>

            {/* Filter Status Button (Natural content width) */}
            <div className="relative shrink-0" ref={filterRef}>
              <button
                type="button"
                onClick={() => setFilterOpen((o) => !o)}
                className={`flex items-center justify-center gap-2 px-3 h-9 rounded-xl border text-xs font-medium transition-colors w-full sm:w-auto ${
                  filter !== 'all'
                    ? 'border-white bg-white/20 text-white font-semibold'
                    : 'border-white/20 bg-[#252525] text-white hover:bg-white/10'
                }`}
              >
                <SlidersHorizontal size={13} className="text-white" />
                <span>
                  {filter === 'all'
                    ? 'Filter Status'
                    : filterOptions.find((o) => o.value === filter)?.label || 'Filter'}
                </span>
                {filter !== 'all' && (
                  <span className="w-1.5 h-1.5 rounded-full bg-white" />
                )}
              </button>

              {filterOpen && (
                <div className="absolute right-0 top-full mt-2 w-44 rounded-xl bg-[#1B1B1B] border border-white/75 shadow-2xl p-1.5 z-30 space-y-0.5">
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
                          ? 'bg-white/20 text-white font-semibold'
                          : 'text-[#A3A3A3] hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      <span>{opt.label}</span>
                      {filter === opt.value && <Check size={14} className="text-white" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* VIEW STATES FOR DEALS */}
          {!effectiveAddress ? (
            <Card className="bg-[#1B1B1B] border border-white/75">
              <CardContent className="p-12 text-center space-y-2">
                <Wallet className="h-8 w-8 text-[#A3A3A3] mx-auto mb-2" />
                <p className="text-white font-medium text-sm">Wallet Not Connected</p>
                <p className="text-[#A3A3A3] text-xs">Connect your wallet to view your deals.</p>
              </CardContent>
            </Card>
          ) : (isLoading || !lastFetchedAddressRef.current) && deals.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 size={24} className="animate-spin text-white" />
            </div>
          ) : deals.length === 0 ? (
            <Card className="bg-[#1B1B1B] border border-white/75 shadow-xl">
              <CardContent className="p-12 text-center space-y-4 max-w-md mx-auto">
                <div className="w-12 h-12 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mx-auto text-[#A3A3A3]">
                  <FileText className="h-6 w-6" />
                </div>
                <div className="space-y-1.5">
                  <h3 className="text-base font-semibold text-white">No Deployed Deals Yet</h3>
                  <p className="text-xs text-[#A3A3A3] leading-relaxed">
                    Deals deployed on Synq Standard V2 escrow will appear here once proposal terms are accepted and funded.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3 pt-1">
              {filtered.map((deal, i) => {
                const statusStr = String(deal.state);
                const userAddr = (effectiveAddress || address)?.toLowerCase();
                const clientAddr = deal.client.toLowerCase();
                const freelancerAddr = deal.freelancer.toLowerCase();

                // Authoritative viewer role resolution
                let viewerRole: 'Client' | 'Freelancer' | 'Participant' | null = null;
                if (userAddr) {
                  if (userAddr === clientAddr && userAddr !== freelancerAddr) {
                    viewerRole = 'Client';
                  } else if (userAddr === freelancerAddr && userAddr !== clientAddr) {
                    viewerRole = 'Freelancer';
                  } else if (userAddr === clientAddr && userAddr === freelancerAddr) {
                    viewerRole = 'Client';
                  } else {
                    viewerRole = 'Participant';
                  }
                }

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
                  counterpartyRole = 'Parties';
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
                      <Card className="group h-full bg-[#1B1B1B] border border-white/75 hover:border-white transition-all cursor-pointer flex flex-col justify-between shadow-xl">
                        <CardContent className="p-5 flex flex-col h-full justify-between gap-4">
                          {/* TOP SECTION: TITLE & STATUS */}
                          <div className="space-y-2">
                            <div className="flex items-start justify-between gap-2">
                              <h3
                                className="text-base font-semibold text-white group-hover:text-neutral-200 transition-colors line-clamp-2 leading-snug"
                                title={deal.title}
                              >
                                {deal.title}
                              </h3>
                              <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                                {/* Viewer Role Badge */}
                                {viewerRole === 'Client' ? (
                                  <Badge
                                    variant="outline"
                                    className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px] font-medium px-2 py-0.5"
                                  >
                                    Client
                                  </Badge>
                                ) : viewerRole === 'Freelancer' ? (
                                  <Badge
                                    variant="outline"
                                    className="border-blue-500/40 bg-blue-500/10 text-blue-300 text-[10px] font-medium px-2 py-0.5"
                                  >
                                    Freelancer
                                  </Badge>
                                ) : viewerRole ? (
                                  <Badge
                                    variant="outline"
                                    className="border-white/20 bg-white/5 text-zinc-400 text-[10px] font-medium px-2 py-0.5"
                                  >
                                    {viewerRole}
                                  </Badge>
                                ) : null}

                                {/* Premium Protection Badges */}
                                {deal.protectionStatus === 'PREMIUM_ACTIVE' ? (
                                  <Badge
                                    className="bg-purple-500/20 text-purple-300 border-purple-500/40 text-[10px] font-medium px-2 py-0.5 flex items-center gap-1"
                                    title="Active Premium Protection V1.1 policy verified on-chain"
                                  >
                                    <ShieldCheck className="h-3 w-3 text-purple-400" /> Premium Active
                                  </Badge>
                                ) : deal.protectionStatus === 'PREMIUM_SELECTED' ? (
                                  <Badge
                                    variant="outline"
                                    className="border-purple-500/40 bg-purple-500/10 text-purple-300 text-[10px] font-medium px-2 py-0.5 flex items-center gap-1"
                                    title="Premium Protection selected during proposal; policy activation pending"
                                  >
                                    <Shield className="h-3 w-3 text-purple-400" /> Premium Selected
                                  </Badge>
                                ) : deal.protectionStatus === 'VERIFYING' ? (
                                  <Badge
                                    variant="outline"
                                    className="border-zinc-700 bg-zinc-800/40 text-zinc-400 text-[10px] font-medium px-2 py-0.5 flex items-center gap-1"
                                  >
                                    <Loader2 className="h-2.5 w-2.5 animate-spin text-purple-400" /> Verifying
                                  </Badge>
                                ) : null}

                                {/* State Badge with Actionable Draft Treatment */}
                                {deal.state === 0 ? (
                                  viewerRole === 'Client' ? (
                                    <Badge
                                      variant="outline"
                                      className="border-amber-500/40 bg-amber-500/10 text-amber-400 text-[10px] font-medium px-2 py-0.5"
                                      title="Escrow funding required from client"
                                    >
                                      Fund Escrow
                                    </Badge>
                                  ) : (
                                    <Badge
                                      variant="outline"
                                      className="border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px] font-medium px-2 py-0.5"
                                      title="Awaiting client escrow funding"
                                    >
                                      Awaiting Funding
                                    </Badge>
                                  )
                                ) : (
                                  <Badge
                                    variant={V2_STATUS_BADGE_VARIANT[statusStr] ?? 'secondary'}
                                    className="text-[10px] font-medium px-2 py-0.5"
                                  >
                                    {V2_DEAL_STATE_LABELS[statusStr] ?? 'Unknown'}
                                  </Badge>
                                )}
                              </div>
                            </div>
                            <div className="text-xs font-mono text-[#A3A3A3]">
                              {shortenAddress(deal.dealAddress)}
                            </div>
                          </div>

                          {/* MAIN VALUE */}
                          <div className="py-2 border-y border-white/20 flex items-baseline justify-between">
                            <span className="text-xs text-[#A3A3A3]">Total Escrow</span>
                            <span className="text-xl font-bold text-white font-mono">
                              {formatUsdcAmount(deal.totalEscrow)}
                            </span>
                          </div>

                          {/* RELATIONSHIP & DETAILS */}
                          <div className="space-y-1.5 text-xs text-[#A3A3A3]">
                            <div className="flex items-center justify-between">
                              <span className="text-[#A3A3A3]">Your Role</span>
                              <span className="font-medium text-xs">
                                {viewerRole === 'Client' ? (
                                  <span className="text-emerald-400 font-semibold">Client</span>
                                ) : viewerRole === 'Freelancer' ? (
                                  <span className="text-blue-400 font-semibold">Freelancer</span>
                                ) : (
                                  <span className="text-zinc-400">{viewerRole || 'Participant'}</span>
                                )}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[#A3A3A3]">Counterparty</span>
                              <span className="font-mono text-white">
                                {counterpartyRole ? `With ${counterpartyText} (${counterpartyRole})` : counterpartyText}
                              </span>
                            </div>
                            {createdDate && (
                              <div className="flex items-center justify-between">
                                <span className="text-[#A3A3A3]">Created</span>
                                <span className="text-white">{createdDate}</span>
                              </div>
                            )}
                          </div>

                          {/* BOTTOM ACTION */}
                          <div className="pt-2 flex items-center justify-end text-xs font-semibold text-white group-hover:text-neutral-300 transition-colors">
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
                <div className="col-span-full text-center py-16 space-y-3">
                  <div className="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mx-auto text-[#A3A3A3]">
                    <Search size={18} />
                  </div>
                  <div className="space-y-1">
                    <p className="text-white font-medium text-sm">No deals match your filters</p>
                    <p className="text-xs text-[#A3A3A3]">
                      {roleFilter !== 'all' || filter !== 'all' || search.trim()
                        ? 'Try adjusting your search keywords, role selection, or status filters.'
                        : 'No deals found.'}
                    </p>
                  </div>
                  {(roleFilter !== 'all' || filter !== 'all' || search.trim()) && (
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="px-3.5 py-1.5 rounded-lg bg-[#252525] hover:bg-white/10 border border-white/20 text-white text-xs font-medium transition-colors inline-flex items-center gap-1.5"
                    >
                      <RotateCcw size={12} />
                      <span>Clear Filters</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        /* PENDING PROPOSALS VIEW */
        <>
          {/* PROPOSAL API ERROR BANNER (NON-BLOCKING IF PARTIAL DATA LOADED) */}
          {proposalError?.type === 'api' && pendingProposals.length > 0 && (
            <Card className="border-red-800/40 bg-red-950/20">
              <CardContent className="p-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-center sm:text-left">
                <div className="flex items-center gap-2.5">
                  <AlertCircle size={18} className="text-red-400 shrink-0" />
                  <p className="text-xs text-[#A3A3A3]">
                    Unable to refresh latest proposals from server: {proposalError.message}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => loadProposals(true)}
                  disabled={isLoadingProposals}
                  className="px-3 py-1 rounded-lg bg-red-900/60 hover:bg-red-800/80 border border-red-700/50 text-white text-xs font-medium transition-colors shrink-0 flex items-center gap-1.5"
                >
                  <RefreshCw size={11} className={isLoadingProposals ? 'animate-spin' : ''} />
                  <span>Retry</span>
                </button>
              </CardContent>
            </Card>
          )}

          {/* TOOLBAR CONTROLS: PROPOSAL ROLE TABS, EXPANDED SEARCH & REFRESH */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
            {/* Proposal Role Filter Tabs */}
            <div className="flex items-center p-1 bg-[#252525] border border-white/20 rounded-xl overflow-x-auto shrink-0 gap-1">
              <button
                type="button"
                onClick={() => setProposalRoleFilter('all')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 shrink-0 ${
                  proposalRoleFilter === 'all'
                    ? 'bg-white/20 text-white font-semibold'
                    : 'text-[#A3A3A3] hover:text-white hover:bg-white/5'
                }`}
              >
                <span>All Proposals</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                    proposalRoleFilter === 'all' ? 'bg-white/30 text-white' : 'bg-white/10 text-zinc-400'
                  }`}
                >
                  {effectiveAddress ? actionableProposals.length : '—'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setProposalRoleFilter('client')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 shrink-0 ${
                  proposalRoleFilter === 'client'
                    ? 'bg-white/20 text-white font-semibold'
                    : 'text-[#A3A3A3] hover:text-white hover:bg-white/5'
                }`}
              >
                <span>As Client</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                    proposalRoleFilter === 'client' ? 'bg-white/30 text-white' : 'bg-white/10 text-zinc-400'
                  }`}
                >
                  {effectiveAddress ? pendingClientCount : '—'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setProposalRoleFilter('freelancer')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 shrink-0 ${
                  proposalRoleFilter === 'freelancer'
                    ? 'bg-white/20 text-white font-semibold'
                    : 'text-[#A3A3A3] hover:text-white hover:bg-white/5'
                }`}
              >
                <span>As Freelancer</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                    proposalRoleFilter === 'freelancer' ? 'bg-white/30 text-white' : 'bg-white/10 text-zinc-400'
                  }`}
                >
                  {effectiveAddress ? pendingFreelancerCount : '—'}
                </span>
              </button>
            </div>

            {/* Search Input (Flexible width, fills remaining horizontal space) */}
            <div className="relative flex-1 min-w-0">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A3A3A3]" />
              <Input
                value={proposalSearch}
                onChange={(e) => setProposalSearch(e.target.value)}
                placeholder="Search proposals by title or proposal ID..."
                className="pl-9 h-9 text-xs bg-[#252525] border-white/20 text-white placeholder:text-[#A3A3A3] rounded-xl focus:border-white focus:ring-1 focus:ring-white/40 w-full"
              />
            </div>

            {/* Manual Refresh Button */}
            <button
              type="button"
              onClick={() => loadProposals(true)}
              disabled={isLoadingProposals}
              title="Refresh pending proposals"
              className="flex items-center justify-center gap-1.5 px-3 h-9 rounded-xl border border-white/20 bg-[#252525] text-white hover:bg-white/10 text-xs font-medium transition-colors shrink-0"
            >
              <RefreshCw size={12} className={isLoadingProposals ? 'animate-spin' : ''} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>

          {/* VIEW STATES FOR PENDING PROPOSALS */}
          {!effectiveAddress ? (
            <Card className="bg-[#1B1B1B] border border-white/75">
              <CardContent className="p-12 text-center space-y-2">
                <Wallet className="h-8 w-8 text-[#A3A3A3] mx-auto mb-2" />
                <p className="text-white font-medium text-sm">Wallet Not Connected</p>
                <p className="text-[#A3A3A3] text-xs">Connect your wallet to view your pending proposals.</p>
              </CardContent>
            </Card>
          ) : proposalError?.type === 'auth' ? (
            <Card className="bg-[#1B1B1B] border border-amber-500/40">
              <CardContent className="p-10 text-center space-y-3 max-w-md mx-auto">
                <div className="w-10 h-10 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center mx-auto text-amber-400">
                  <AlertCircle size={20} />
                </div>
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold text-white">Authentication Required</h3>
                  <p className="text-xs text-[#A3A3A3] leading-relaxed">
                    Please sign in with your connected wallet session to securely view your pending proposals.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : isLoadingProposals && pendingProposals.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 size={24} className="animate-spin text-white" />
            </div>
          ) : proposalError?.type === 'api' && pendingProposals.length === 0 ? (
            <Card className="border-red-800/40 bg-red-950/20">
              <CardContent className="p-10 text-center space-y-3 max-w-md mx-auto">
                <div className="w-10 h-10 rounded-full bg-red-900/30 border border-red-700/50 flex items-center justify-center mx-auto text-red-400">
                  <AlertCircle size={20} />
                </div>
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold text-white">Failed to Load Proposals</h3>
                  <p className="text-xs text-[#A3A3A3] leading-relaxed">
                    {proposalError.message}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => loadProposals(true)}
                  disabled={isLoadingProposals}
                  className="px-3.5 py-1.5 rounded-lg bg-red-900/60 hover:bg-red-800/80 border border-red-700/50 text-white text-xs font-medium transition-colors inline-flex items-center gap-1.5"
                >
                  <RefreshCw size={12} className={isLoadingProposals ? 'animate-spin' : ''} />
                  <span>Retry</span>
                </button>
              </CardContent>
            </Card>
          ) : actionableProposals.length === 0 ? (
            <Card className="bg-[#1B1B1B] border border-white/75 shadow-xl">
              <CardContent className="p-12 text-center space-y-4 max-w-md mx-auto">
                <div className="w-12 h-12 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mx-auto text-[#A3A3A3]">
                  <Clock className="h-6 w-6" />
                </div>
                <div className="space-y-1.5">
                  <h3 className="text-base font-semibold text-white">No Pending Proposals</h3>
                  <p className="text-xs text-[#A3A3A3] leading-relaxed">
                    You do not currently have any pending deal proposals awaiting response or review.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3 pt-1">
              {filteredProposals.map((proposal, i) => {
                const userAddr = (effectiveAddress || address)?.toLowerCase();
                const clientAddr = proposal.clientWallet.toLowerCase();
                const freelancerAddr = proposal.freelancerWallet.toLowerCase();

                // Viewer role resolution
                let viewerRole: 'Client' | 'Freelancer' | 'Participant' | null = null;
                if (userAddr) {
                  if (userAddr === clientAddr && userAddr !== freelancerAddr) {
                    viewerRole = 'Client';
                  } else if (userAddr === freelancerAddr && userAddr !== clientAddr) {
                    viewerRole = 'Freelancer';
                  } else if (userAddr === clientAddr && userAddr === freelancerAddr) {
                    viewerRole = 'Client';
                  } else {
                    viewerRole = 'Participant';
                  }
                }

                const clientIdent = identitiesMap[clientAddr];
                const freelancerIdent = identitiesMap[freelancerAddr];
                const clientLabel = clientIdent?.displayHandle || shortenAddress(proposal.clientWallet);
                const freelancerLabel = freelancerIdent?.displayHandle || shortenAddress(proposal.freelancerWallet);

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
                  counterpartyRole = 'Parties';
                }

                // Check expiration
                const expSec = Number(proposal.expiry);
                const isExpired = !isNaN(expSec) && expSec > 0 && Math.floor(Date.now() / 1000) > expSec;
                const expirationFormatted =
                  !isNaN(expSec) && expSec > 0 ? new Date(expSec * 1000).toLocaleDateString() : 'None';

                // Status verification resolution
                const vStatus =
                  verificationMap[proposal.proposalId] || (isExpired ? 'EXPIRED' : 'VERIFYING');

                let statusBadge = null;
                if (vStatus === 'VERIFYING') {
                  statusBadge = (
                    <Badge
                      variant="outline"
                      className="border-zinc-700 bg-zinc-800/40 text-zinc-400 text-[10px] font-medium px-2 py-0.5 flex items-center gap-1"
                    >
                      <Loader2 className="h-2.5 w-2.5 animate-spin text-purple-400" /> Verifying
                    </Badge>
                  );
                } else if (vStatus === 'EXPIRED' || isExpired) {
                  statusBadge = (
                    <Badge
                      variant="outline"
                      className="border-zinc-700 bg-zinc-800/40 text-zinc-400 text-[10px] font-medium px-2 py-0.5"
                    >
                      Expired
                    </Badge>
                  );
                } else if (vStatus === 'CANCELLED') {
                  statusBadge = (
                    <Badge
                      variant="outline"
                      className="border-zinc-700 bg-zinc-800/40 text-zinc-400 text-[10px] font-medium px-2 py-0.5"
                    >
                      Cancelled
                    </Badge>
                  );
                } else if (vStatus === 'DECLINED') {
                  statusBadge = (
                    <Badge
                      variant="outline"
                      className="border-red-800/40 bg-red-950/20 text-red-400 text-[10px] font-medium px-2 py-0.5"
                    >
                      Declined
                    </Badge>
                  );
                } else if (vStatus === 'ACCEPTED') {
                  statusBadge = (
                    <Badge
                      variant="outline"
                      className="border-emerald-800/40 bg-emerald-950/20 text-emerald-400 text-[10px] font-medium px-2 py-0.5"
                    >
                      Accepted
                    </Badge>
                  );
                } else if (vStatus === 'PENDING') {
                  if (viewerRole === 'Client') {
                    statusBadge = (
                      <Badge
                        variant="outline"
                        className="border-amber-500/40 bg-amber-500/10 text-amber-400 text-[10px] font-medium px-2 py-0.5"
                        title="Awaiting freelancer response or acceptance"
                      >
                        Awaiting Freelancer Response
                      </Badge>
                    );
                  } else if (viewerRole === 'Freelancer') {
                    statusBadge = (
                      <Badge
                        variant="outline"
                        className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-[10px] font-medium px-2 py-0.5"
                        title="Your review and acceptance are required"
                      >
                        Review Required
                      </Badge>
                    );
                  } else {
                    statusBadge = (
                      <Badge
                        variant="outline"
                        className="border-amber-500/40 bg-amber-500/10 text-amber-400 text-[10px] font-medium px-2 py-0.5"
                      >
                        Pending
                      </Badge>
                    );
                  }
                } else {
                  // UNVERIFIED
                  statusBadge = (
                    <Badge
                      variant="outline"
                      className="border-zinc-700 bg-zinc-800/40 text-zinc-400 text-[10px] font-medium px-2 py-0.5"
                      title="On-chain status could not be verified; view proposal to confirm"
                    >
                      Status Unverified
                    </Badge>
                  );
                }

                return (
                  <motion.div
                    key={proposal.proposalId}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.04 }}
                  >
                    <Link href={`/deals/proposals/${proposal.proposalId}`}>
                      <Card className="group h-full bg-[#1B1B1B] border border-white/75 hover:border-white transition-all cursor-pointer flex flex-col justify-between shadow-xl">
                        <CardContent className="p-5 flex flex-col h-full justify-between gap-4">
                          {/* TOP SECTION: TITLE & STATUS */}
                          <div className="space-y-2">
                            <div className="flex items-start justify-between gap-2">
                              <h3
                                className="text-base font-semibold text-white group-hover:text-neutral-200 transition-colors line-clamp-2 leading-snug"
                                title={proposal.title}
                              >
                                {proposal.title}
                              </h3>
                              <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                                {/* Viewer Role Badge */}
                                {viewerRole === 'Client' ? (
                                  <Badge
                                    variant="outline"
                                    className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px] font-medium px-2 py-0.5"
                                  >
                                    Client
                                  </Badge>
                                ) : viewerRole === 'Freelancer' ? (
                                  <Badge
                                    variant="outline"
                                    className="border-blue-500/40 bg-blue-500/10 text-blue-300 text-[10px] font-medium px-2 py-0.5"
                                  >
                                    Freelancer
                                  </Badge>
                                ) : null}

                                {/* Protection Badge */}
                                {proposal.protectionSelection === 'PREMIUM' ? (
                                  <Badge
                                    variant="outline"
                                    className="border-purple-500/40 bg-purple-500/10 text-purple-300 text-[10px] font-medium px-2 py-0.5 flex items-center gap-1"
                                    title="Premium Protection selected during proposal"
                                  >
                                    <Shield className="h-3 w-3 text-purple-400" /> Premium Selected
                                  </Badge>
                                ) : (
                                  <Badge
                                    variant="outline"
                                    className="border-white/20 bg-white/5 text-zinc-400 text-[10px] font-medium px-2 py-0.5"
                                  >
                                    Standard
                                  </Badge>
                                )}

                                {/* Actionable / Verified Status Badge */}
                                {statusBadge}
                              </div>
                            </div>
                            <div className="text-xs font-mono text-[#A3A3A3]">
                              {shortenAddress(proposal.proposalId)}
                            </div>
                          </div>

                          {/* MAIN VALUE */}
                          <div className="py-2 border-y border-white/20 flex items-baseline justify-between">
                            <span className="text-xs text-[#A3A3A3]">Proposed Escrow</span>
                            <span className="text-xl font-bold text-white font-mono">
                              {formatUsdcAmount(proposal.totalAmount)}{' '}
                              <span className="text-xs text-[#A3A3A3]">USDC</span>
                            </span>
                          </div>

                          {/* RELATIONSHIP & DETAILS */}
                          <div className="space-y-1.5 text-xs text-[#A3A3A3]">
                            <div className="flex items-center justify-between">
                              <span className="text-[#A3A3A3]">Your Role</span>
                              <span className="font-medium text-xs">
                                {viewerRole === 'Client' ? (
                                  <span className="text-emerald-400 font-semibold">Client</span>
                                ) : viewerRole === 'Freelancer' ? (
                                  <span className="text-blue-400 font-semibold">Freelancer</span>
                                ) : (
                                  <span className="text-zinc-400">Participant</span>
                                )}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[#A3A3A3]">Counterparty</span>
                              <span className="font-mono text-white">
                                {counterpartyRole
                                  ? `With ${counterpartyText} (${counterpartyRole})`
                                  : counterpartyText}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[#A3A3A3]">Milestones</span>
                              <span className="text-white font-mono">
                                {proposal.milestonesCount} milestone
                                {proposal.milestonesCount === 1 ? '' : 's'}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[#A3A3A3]">Expiration</span>
                              <span
                                className={
                                  isExpired ? 'text-zinc-500 line-through' : 'text-white'
                                }
                              >
                                {expirationFormatted}
                              </span>
                            </div>
                          </div>

                          {/* BOTTOM ACTION */}
                          <div className="pt-2 flex items-center justify-end text-xs font-semibold text-white group-hover:text-neutral-300 transition-colors">
                            <span>
                              {viewerRole === 'Freelancer' && vStatus === 'PENDING'
                                ? 'Review Proposal'
                                : 'View Proposal'}
                            </span>
                            <ArrowRight
                              size={14}
                              className="ml-1 group-hover:translate-x-0.5 transition-transform"
                            />
                          </div>
                        </CardContent>
                      </Card>
                    </Link>
                  </motion.div>
                );
              })}
              {filteredProposals.length === 0 && (
                <div className="col-span-full text-center py-16 space-y-3">
                  <div className="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mx-auto text-[#A3A3A3]">
                    <Search size={18} />
                  </div>
                  <div className="space-y-1">
                    <p className="text-white font-medium text-sm">No proposals match your filters</p>
                    <p className="text-xs text-[#A3A3A3]">
                      {proposalRoleFilter !== 'all' || proposalSearch.trim()
                        ? 'Try adjusting your search keywords or role selection.'
                        : 'No proposals found.'}
                    </p>
                  </div>
                  {(proposalRoleFilter !== 'all' || proposalSearch.trim()) && (
                    <button
                      type="button"
                      onClick={clearProposalFilters}
                      className="px-3.5 py-1.5 rounded-lg bg-[#252525] hover:bg-white/10 border border-white/20 text-white text-xs font-medium transition-colors inline-flex items-center gap-1.5"
                    >
                      <RotateCcw size={12} />
                      <span>Clear Filters</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
