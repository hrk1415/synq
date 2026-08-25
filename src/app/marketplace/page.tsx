'use client';

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { Search, Briefcase, Plus, X, Check, Loader2, Users, ArrowRight, Star, Pencil } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAccount, useChainId } from 'wagmi';
import { formatUnits } from 'viem';
import { useDirectoryContract } from '@/hooks/useDirectoryContract';
import { isSupportedChain, chainLabel, DEFAULT_CHAIN_ID } from '@/lib/contracts/addresses';
import { ChainGuard } from '@/components/shared/ChainGuard';
import { shortenAddress } from '@/lib/utils';

const categories = ['All', 'Web Development', 'Design', 'Smart Contract', 'Content'];

const emptyProfile = { name: '', category: 'Web Development', skills: '', rate: '', bio: '' };

function Avatar({ name }: { name: string }) {
  const initials = (name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const hues = ['from-blue-500 to-violet-600', 'from-emerald-500 to-teal-600', 'from-orange-500 to-red-600', 'from-pink-500 to-rose-600'];
  const hue = hues[(name.length + name.charCodeAt(0)) % hues.length];
  return (
    <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${hue} flex items-center justify-center text-white font-bold text-sm shrink-0`}>
      {initials || '?'}
    </div>
  );
}

export default function MarketplacePage() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const directory = useDirectoryContract(address);
  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState('');
  const [profile, setProfile] = useState(emptyProfile);

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

  const openAddForm = () => {
    if (!isConnected) return;
    if (directory.myRegistered && directory.myProfile) {
      let rateRaw = directory.myProfile.rate || '0';
        let rateVal: string;
        try { rateVal = String(Number(formatUnits(BigInt(rateRaw), 18))); } catch { rateVal = String(rateRaw); }
        setProfile({
          name: String(directory.myProfile.name || ''),
          category: String(directory.myProfile.category || 'Web Development'),
          skills: (directory.myProfile.skills || []).join(', '),
          rate: rateVal,
          bio: String(directory.myProfile.bio || ''),
        });
    } else {
      setProfile(emptyProfile);
    }
    setFormError('');
    setShowForm(true);
  };

  const handleSubmitProfile = async () => {
    if (!address) { setFormError('Connect your wallet first'); return; }
    if (profile.name.trim().length < 2) { setFormError('Enter your name (2-40 chars)'); return; }
    const rate = Number(profile.rate);
    if (!rate || rate <= 0 || !isFinite(rate)) { setFormError('Enter a valid rate'); return; }
    const skills = profile.skills.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8);
    if (skills.length === 0) { setFormError('Add at least one skill'); return; }
    setFormError('');
    try {
      const args = [profile.name.trim(), profile.category, skills, BigInt(Math.round(rate * 1e18)), profile.bio.trim()] as const;
      if (directory.myRegistered) {
        directory.updateProfile(...args);
      } else {
        directory.registerProfile(...args);
      }
    } catch (e: any) {
      setFormError(`Failed: ${String(e?.message || e).slice(0, 120)}`);
    }
  };

  const order = (p: any) => {
    router.push(`/deal/new?seller=${p.wallet}&type=${encodeURIComponent(p.category)}`);
  };

  const submitting = directory.isPending;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Freelancer Marketplace</h1>
          <p className="text-zinc-400 text-sm mt-1">
            Profiles live on-chain in Synq's directory contract. Find a professional and open an escrow deal with them.
          </p>
        </div>
        <Button onClick={openAddForm} disabled={!isConnected} className="gap-2">
          {directory.myRegistered ? <Pencil size={16} /> : <Plus size={16} />}
          {directory.myRegistered ? 'Edit My Profile' : 'Register My Profile'}
        </Button>
      </div>

      {!isConnected && (
        <div className="p-3 rounded-lg bg-blue-600/10 border border-blue-500/20 text-sm text-blue-400">
          Connect your wallet to order from a freelancer or register your own on-chain profile.
        </div>
      )}
      {isConnected && <ChainGuard what="the freelancer directory is" />}
      {directory.writeError && (
        <div className="p-3 rounded-lg bg-red-600/10 border border-red-500/20 text-sm text-red-400">
          Transaction failed: {String((directory.writeError as any).shortMessage || (directory.writeError as any).message || directory.writeError).slice(0, 120)}
        </div>
      )}
      {isConnected && !directory.myRegistered && directory.myProfile !== undefined && (
        <div className="p-3 rounded-lg bg-zinc-800/40 border border-zinc-700/50 text-sm text-zinc-300">
          You have no on-chain profile yet — register one to start receiving orders.
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              category === c ? 'bg-blue-600/10 text-blue-400 border border-blue-500/20' : 'text-zinc-400 hover:text-white hover:bg-zinc-800/50'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
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
          {filtered.map((p: any, i: number) => {
            const isMe = !!address && String(p.wallet).toLowerCase() === address.toLowerCase();
            return (
              <motion.div key={String(p.wallet)} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
                <Card className="group hover:border-blue-500/30 transition-all h-full">
                  <CardContent className="p-5 flex flex-col h-full">
                    <div className="flex items-start gap-3 mb-3">
                      <Avatar name={String(p.name || '')} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="text-base font-semibold text-white truncate">{String(p.name || 'Anonymous')}</h3>
                          {isMe && <Badge variant="info" className="text-[10px]">You</Badge>}
                          {!p.available && <Badge variant="secondary" className="text-[10px]">Busy</Badge>}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-zinc-500 mt-0.5">
                          <Briefcase size={12} /> {String(p.category || '-')}
                        </div>
                        <div className="font-mono text-[10px] text-zinc-500 mt-0.5">{shortenAddress(String(p.wallet))}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-bold text-white">{Number(formatUnits(BigInt(p.rate || 0), 18))} <span className="text-xs text-zinc-500">ETH</span></div>
                        <div className="text-[10px] text-zinc-500">rate/project</div>
                      </div>
                    </div>

                    <p className="text-sm text-zinc-400 mb-3 line-clamp-2">{String(p.bio || '')}</p>

                    <div className="flex flex-wrap gap-1.5 mb-4">
                      {(p.skills || []).slice(0, 4).map((s: string) => (
                        <span key={s} className="px-2 py-0.5 rounded-md bg-zinc-800/60 text-[10px] text-zinc-400">{s}</span>
                      ))}
                    </div>

                    <div className="flex items-center gap-4 text-xs text-zinc-400 mt-auto mb-4">
                      <span className="flex items-center gap-1">
                        <Star size={12} className="text-amber-400" /> On-chain
                      </span>
                      <span className="flex items-center gap-1">
                        <Users size={12} className="text-blue-400" /> {Number(p.completedDeals)} deals
                      </span>
                    </div>

                    <Button onClick={() => order(p)} disabled={isMe} className="w-full gap-2">
                      <ArrowRight size={16} />
                      {isMe ? 'This is you' : 'Order This Freelancer'}
                    </Button>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>
      )}

      {!directory.isLoading && filtered.length === 0 && (
        <div className="text-center py-20">
          <p className="text-zinc-500 text-sm">No on-chain profiles found. Be the first to register!</p>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="w-full max-w-md rounded-2xl border border-zinc-700/50 bg-zinc-900 shadow-2xl overflow-hidden"
          >
            <div className="flex items-center justify-between p-5 border-b border-zinc-800">
              <div>
                <h2 className="text-lg font-semibold text-white">{directory.myRegistered ? 'Edit On-Chain Profile' : 'Register On-Chain Profile'}</h2>
                <p className="text-sm text-zinc-400 mt-0.5">Stored on Synq's on-chain directory.</p>
              </div>
              <button onClick={() => setShowForm(false)} className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">Name</label>
                <Input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} placeholder="Your name or studio" maxLength={40} />
              </div>
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">Category</label>
                <select
                  value={profile.category}
                  onChange={(e) => setProfile({ ...profile, category: e.target.value })}
                  className="w-full h-11 rounded-xl border border-zinc-700 bg-zinc-800/50 px-4 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
                >
                  {categories.filter((c) => c !== 'All').map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">Skills (comma separated, max 8)</label>
                <Input value={profile.skills} onChange={(e) => setProfile({ ...profile, skills: e.target.value })} placeholder="React, Next.js, Tailwind" />
              </div>
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">Rate (ETH per project)</label>
                <Input type="number" value={profile.rate} onChange={(e) => setProfile({ ...profile, rate: e.target.value })} placeholder="10" min="1" />
              </div>
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">Bio (max 300 chars)</label>
                <textarea
                  value={profile.bio}
                  onChange={(e) => setProfile({ ...profile, bio: e.target.value })}
                  placeholder="Describe what you offer..."
                  maxLength={300}
                  className="w-full h-24 rounded-lg border border-zinc-700 bg-zinc-800/50 px-4 py-3 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
                />
              </div>
              {formError && <p className="text-xs text-red-400">{formError}</p>}
              <p className="text-xs text-zinc-500">Wallet: {isConnected ? shortenAddress(address!) : 'Connect wallet first'}</p>
              {directory.txReceipt.isSuccess && (
                <div className="p-2 rounded-lg bg-green-600/10 border border-green-500/20 text-xs text-green-400 flex items-center gap-1.5">
                  <Check size={12} /> Profile saved on-chain!
                </div>
              )}
              <Button onClick={handleSubmitProfile} disabled={submitting || !isConnected || !isSupportedChain(chainId)} className="w-full gap-2">
                {submitting ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                {submitting ? 'Signing...' : directory.myRegistered ? 'Update On-Chain Profile' : 'Register On-Chain Profile'}
              </Button>
              {isConnected && !isSupportedChain(chainId) && (
                <p className="text-xs text-amber-400">Switch your wallet to {chainLabel(DEFAULT_CHAIN_ID)} to register.</p>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}