'use client';

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { Search, Loader2 } from 'lucide-react';
import { formatUnits } from 'viem';
import { Input } from '@/components/ui/input';
import { useAccount } from 'wagmi';
import { useDirectoryContract } from '@/hooks/useDirectoryContract';
import { ChainGuard } from '@/components/shared/ChainGuard';
import { SellerCard } from '@/components/marketplace/SellerCard';

const categories = ['All', 'Web Development', 'Design', 'Smart Contract', 'Content'];

export default function MarketplacePage() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const directory = useDirectoryContract(address);
  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');

  const profiles = useMemo(() => (directory.profiles || []).filter((p: any) => p && p.wallet), [directory.profiles]);

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
    // Ordering opens the on-chain deal wizard with the seller's price
    // pre-filled. Once the deal is created the buyer can message the seller.
    const q = new URLSearchParams({
      seller: String(p.wallet),
      type: String(p.category || ''),
      budget: Number(formatUnits(BigInt(p.rate || 0), 18)) > 0 ? String(Number(formatUnits(BigInt(p.rate || 0), 18))) : '',
      name: String(p.name || ''),
    });
    router.push(`/deal/new?${q.toString()}`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Deal Port</h1>
        <p className="text-zinc-300 text-sm mt-1">
          Find the right professional, check their on-chain profile, and start a secure deal in seconds. Synq keeps every connection and escrow deal transparent, simple and protected.
        </p>
      </div>

      {!isConnected && (
        <div className="p-3 rounded-lg bg-blue-600/10 border border-blue-500/20 text-sm text-blue-400">
          Connect your wallet to order from a freelancer, or register your own on-chain profile from your Profile page.
        </div>
      )}
      {isConnected && <ChainGuard what="the freelancer directory is" />}
      {isConnected && !directory.myRegistered && directory.myProfile !== undefined && (
        <div className="p-3 rounded-lg bg-zinc-800/40 border border-zinc-700/50 text-sm text-zinc-200">
          You have no on-chain profile yet — create one from your Profile page to start receiving orders.
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              category === c ? 'bg-blue-600/10 text-blue-400 border border-blue-500/20' : 'text-zinc-300 hover:text-white hover:bg-zinc-800/50'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, skill, or bio..."
          className="pl-10"
        />
      </div>

      {directory.isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-blue-400" />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((p: any, i: number) => (
            <motion.div key={String(p.wallet)} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
              <SellerCard profile={p} me={address} isConnected={isConnected} onOrder={order} />
            </motion.div>
          ))}
        </div>
      )}

      {!directory.isLoading && filtered.length === 0 && (
        <div className="text-center py-20">
          <p className="text-zinc-200 text-sm">No on-chain profiles found. Register yours from the Profile page to be the first!</p>
        </div>
      )}
    </div>
  );
}
