'use client';

import { useMemo, useState, useEffect, useRef } from 'react';
import { Press_Start_2P } from 'next/font/google';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Search, Loader2, SlidersHorizontal, Check } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useAccount, useReadContracts } from 'wagmi';
import { useDirectoryContract } from '@/hooks/useDirectoryContract';
import { ChainGuard } from '@/components/shared/ChainGuard';
import { SellerCard } from '@/components/marketplace/SellerCard';
import { ProviderProfileModal } from '@/components/marketplace/ProviderProfileModal';
import { CONTRACT_ADDRESSES, SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { registryABI } from '@/hooks/useRegistryContract';
import { useBatchFreelancerCompletedDeals } from '@/hooks/useFreelancerStats';
import { FreelancerPricing, getSuggestedDealBudget } from '@/lib/deals/pricing';

const pressStart2P = Press_Start_2P({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

const categories = ['All', 'Web Development', 'Design', 'Smart Contract', 'Content'];

export default function MarketplacePage() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    document.body.classList.add('marketplace-page');
    return () => {
      document.body.classList.remove('marketplace-page');
    };
  }, []);

  const { address, isConnected, status } = useAccount();
  const isAccountRestoring = status === 'connecting' || status === 'reconnecting';

  // Deterministic connection & address during SSR and initial client render to prevent hydration mismatches
  const effectiveIsConnected = mounted && isConnected && !isAccountRestoring;
  const effectiveAddress = effectiveIsConnected && !!address ? address : undefined;

  const directory = useDirectoryContract(effectiveAddress as `0x${string}` | undefined);

  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  const [avatarsMap, setAvatarsMap] = useState<Record<string, string>>({});
  const [pricingMap, setPricingMap] = useState<Record<string, FreelancerPricing>>({});
  const [reviewCountsMap, setReviewCountsMap] = useState<Record<string, number>>({});
  const [selectedWallet, setSelectedWallet] = useState<string | null>(null);

  const profiles = useMemo(() => (directory.profiles || []).filter((p: any) => p && p.wallet), [directory.profiles]);

  const sellerWallets = useMemo(() => profiles.map((p: any) => String(p.wallet)), [profiles]);
  const { completedCountsMap } = useBatchFreelancerCompletedDeals(sellerWallets);

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

  // Strategy A: Batch read Registry usernames in ONE multicall request for all loaded profiles
  const registryContracts = useMemo(
    () =>
      profiles.map((p: any) => ({
        address: CONTRACT_ADDRESSES.sepolia.NexotiqRegistry as `0x${string}`,
        abi: registryABI,
        functionName: 'getUsername' as const,
        args: [p.wallet as `0x${string}`],
        chainId: SEPOLIA_CHAIN_ID,
      })),
    [profiles]
  );

  const { data: registryData } = useReadContracts({
    contracts: registryContracts,
    chainId: SEPOLIA_CHAIN_ID,
    query: { enabled: profiles.length > 0 },
  });

  const handlesMap = useMemo(() => {
    const map: Record<string, string> = {};
    if (!registryData) return map;
    registryData.forEach((res, i) => {
      const walletKey = String(profiles[i]?.wallet).toLowerCase();
      if (res.status === 'success' && typeof res.result === 'string' && res.result.trim()) {
        map[walletKey] = res.result.trim();
      }
    });
    return map;
  }, [registryData, profiles]);

  // Unique wallets key for batch HTTP requests
  const uniqueWalletsKey = useMemo(() => {
    const list = Array.from(new Set(profiles.map((p: any) => String(p.wallet).toLowerCase()))).sort();
    return list.join(',');
  }, [profiles]);

  // Fetch public avatars in ONE batch HTTP request for all unique provider addresses
  useEffect(() => {
    if (!uniqueWalletsKey) return;
    const uniqueWallets = uniqueWalletsKey.split(',');
    let cancelled = false;

    fetch('/api/profile/public', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallets: uniqueWallets }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !Array.isArray(data?.profiles)) return;
        const aMap: Record<string, string> = {};
        const pMap: Record<string, FreelancerPricing> = {};
        for (const item of data.profiles) {
          const wLower = String(item.wallet).toLowerCase();
          if (item?.avatar) {
            aMap[wLower] = item.avatar;
          }
          if (item?.startingRateAmount && item?.startingRateType) {
            pMap[wLower] = {
              amount: String(item.startingRateAmount),
              currency: 'USDC',
              rateType: item.startingRateType,
            };
          }
        }
        setAvatarsMap(aMap);
        setPricingMap(pMap);
      })
      .catch(() => { /* keep initials fallback on error */ });

    return () => { cancelled = true; };
  }, [uniqueWalletsKey]);

  // Fetch review counts in ONE batch HTTP GET request for all unique provider addresses
  useEffect(() => {
    if (!uniqueWalletsKey) return;
    let cancelled = false;

    fetch(`/api/reviews?sellers=${uniqueWalletsKey}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.counts) return;
        setReviewCountsMap(data.counts);
      })
      .catch(() => { /* fallback gracefully to 0 on error */ });

    return () => { cancelled = true; };
  }, [uniqueWalletsKey]);

  const filtered = useMemo(() => {
    return profiles.filter((p: any) => {
      const matchesCategory = category === 'All' || p.category === category;
      const q = search.toLowerCase();
      const skills = (p.skills || []).join(' ').toLowerCase();
      const matchesSearch = !q || String(p.name || '').toLowerCase().includes(q) || skills.includes(q) || String(p.bio || '').toLowerCase().includes(q);
      return matchesCategory && matchesSearch;
    });
  }, [profiles, category, search]);

  const order = (p: any) => {
    const walletLower = String(p.wallet).toLowerCase();
    const pricing = pricingMap[walletLower];
    const suggestedBudget = getSuggestedDealBudget(pricing);

    const q = new URLSearchParams({
      seller: String(p.wallet),
      type: String(p.category || ''),
      budget: suggestedBudget || '',
      name: String(p.name || ''),
    });
    router.push(`/deal/new?${q.toString()}`);
  };

  return (
    <div className="space-y-4 pt-0 pb-12 min-h-screen">
      {/* DEAL PORT BACKGROUND: /bg2.jpg with #101010 charcoal fallback */}
      <div
        className="fixed inset-0 bg-[#101010] bg-cover bg-center bg-no-repeat -z-10 pointer-events-none"
        style={{
          backgroundImage: 'url(/bg2.jpg)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          backgroundAttachment: 'fixed',
        }}
        aria-hidden="true"
      />

      {/* COMPACT TITLE ROW WITH HOVER/FOCUS TOOLTIP */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <h1 className={`${pressStart2P.className} text-xl md:text-2xl font-normal text-white tracking-tight`}>
            Deal Port
          </h1>
          <div className="relative group inline-block">
            <button
              type="button"
              tabIndex={0}
              aria-label="About Deal Port"
              className="w-5 h-5 rounded-full bg-[#1B1B1B] hover:bg-[#252525] border border-[#383838] hover:border-zinc-500 text-[#A3A3A3] hover:text-white text-[11px] font-bold font-mono inline-flex items-center justify-center shrink-0 transition-colors focus:outline-none focus:ring-1 focus:ring-white/40"
            >
              ?
            </button>
            <div className="absolute left-0 top-full mt-2 w-72 sm:w-80 p-3 rounded-xl bg-[#1B1B1B] border border-[#383838] text-[#A3A3A3] text-xs leading-relaxed shadow-2xl opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-all duration-150 z-30">
              Find the right professional, check their on-chain profile, and start a secure deal in seconds. Synq keeps every connection and escrow deal transparent, simple and protected.
            </div>
          </div>
        </div>
      </div>

      {/* SYSTEM MESSAGES */}
      {!effectiveIsConnected && (
        <div className="p-3 rounded-lg bg-[#1B1B1B] border border-[#383838] text-sm text-zinc-300">
          Connect your wallet to order from a freelancer, or register your own on-chain profile from your Profile page.
        </div>
      )}
      {effectiveIsConnected && <ChainGuard what="the freelancer directory is" />}
      {effectiveIsConnected && !directory.myRegistered && directory.myProfile !== undefined && (
        <div className="p-3 rounded-lg bg-[#2A1719] border border-[#8B4048] text-[#FF9DA5] text-sm">
          You have no on-chain profile yet — create one from your Profile page to start receiving orders.
        </div>
      )}

      {/* COMPACT SEARCH & FILTER ROW */}
      <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A3A3A3]" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, skill, or bio..."
            className="pl-10 h-10 text-sm bg-[#1B1B1B] border border-white/50 hover:border-white/70 focus-visible:border-white/90 text-white placeholder:text-[#737373] focus-visible:ring-1 focus-visible:ring-white/50 transition-colors"
          />
        </div>

        {/* FILTER DROPDOWN CONTAINER */}
        <div ref={filterRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setFilterOpen(!filterOpen)}
            className={`h-10 px-3.5 rounded-xl border text-xs font-medium flex items-center gap-2 transition-all ${
              category !== 'All'
                ? 'bg-white text-[#101010] border-white font-semibold shadow-sm'
                : 'bg-[#1B1B1B] text-zinc-300 border-white/50 hover:border-white/80 hover:bg-[#252525] hover:text-white'
            }`}
          >
            <SlidersHorizontal size={14} />
            <span>Filter</span>
            {category !== 'All' && (
              <span className="w-1.5 h-1.5 rounded-full bg-[#101010]" />
            )}
          </button>

          {filterOpen && (
            <div className="absolute right-0 top-full mt-2 w-48 rounded-xl bg-[#1B1B1B] border border-white/50 shadow-2xl p-1.5 z-30 space-y-0.5">
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    setCategory(c);
                    setFilterOpen(false);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg transition-colors ${
                    category === c
                      ? 'bg-white text-[#101010] font-semibold'
                      : 'text-zinc-300 hover:bg-[#252525] hover:text-white'
                  }`}
                >
                  <span>{c}</span>
                  {category === c && <Check size={14} className="text-[#101010]" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* + NEW DEAL ACTION */}
        <button
          type="button"
          onClick={() => router.push('/deal/new')}
          className="h-10 px-4 rounded-xl bg-white hover:bg-zinc-200 text-[#101010] font-semibold text-xs sm:text-sm inline-flex items-center transition-all shadow-sm shrink-0 focus:outline-none focus:ring-2 focus:ring-white/50"
        >
          + New Deal
        </button>
      </div>

      {/* PROVIDER CARDS GRID */}
      {directory.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={24} className="animate-spin text-white" />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 pt-1">
          {filtered.map((p: any, i: number) => {
            const walletLower = String(p.wallet).toLowerCase();
            return (
              <motion.div key={String(p.wallet)} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
                <SellerCard
                  profile={p}
                  me={effectiveAddress}
                  isConnected={effectiveIsConnected}
                  onOrder={order}
                  onOpenProfile={(wallet) => setSelectedWallet(wallet)}
                  avatar={avatarsMap[walletLower]}
                  synqHandle={handlesMap[walletLower]}
                  pricing={pricingMap[walletLower]}
                  reviewCount={reviewCountsMap[walletLower] ?? 0}
                  completedDeals={completedCountsMap[walletLower]}
                />
              </motion.div>
            );
          })}
        </div>
      )}

      {!directory.isLoading && filtered.length === 0 && (
        <div className="text-center py-16">
          <p className="text-zinc-200 text-sm">No on-chain profiles found. Register yours from the Profile page to be the first!</p>
        </div>
      )}

      {/* LARGE PROVIDER PROFILE MODAL */}
      <ProviderProfileModal
        wallet={selectedWallet}
        onClose={() => setSelectedWallet(null)}
      />
    </div>
  );
}
