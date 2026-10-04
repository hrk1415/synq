'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import { formatUnits } from 'viem';
import {
  Briefcase,
  Check,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
  Globe,
  Code,
  CircleAlert,
  Sparkles,
  Layers,
  Clock,
  ShieldCheck,
  CircleCheck,
  ExternalLink,
  Power,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { useDirectoryContract } from '@/hooks/useDirectoryContract';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';
import { useAuthSession } from '@/hooks/useAuthSession';

const SELLER_CATEGORIES = ['Web Development', 'Design', 'Smart Contract', 'Content'];
const EMPTY_REG = { name: '', category: 'Web Development', skills: '', rate: '', bio: '' };

function isValidHttpUrl(str: string): boolean {
  if (!str.trim()) return true;
  try {
    const url = new URL(str.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function genLocalProjId(): string {
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface PortfolioProject {
  id: string;
  title: string;
  description: string;
  image: string;
  link: string;
  tags: string[];
}

export interface RichMarketMetadata {
  headline: string;
  secondaryCategories: string[];
  about: string;
  typicalDelivery: string;
  links: {
    website: string;
    github: string;
    twitter: string;
    linkedin: string;
  };
  portfolio: PortfolioProject[];
}

const EMPTY_RICH_METADATA: RichMarketMetadata = {
  headline: '',
  secondaryCategories: [],
  about: '',
  typicalDelivery: '',
  links: {
    website: '',
    github: '',
    twitter: '',
    linkedin: '',
  },
  portfolio: [],
};

export function MarketProfileEditor({
  address,
  open,
}: {
  address: `0x${string}` | undefined;
  open: boolean;
}) {
  const { isConnected } = useAccount();
  const { networkReady } = useSepoliaNetwork();
  const directory = useDirectoryContract(address);
  const { ensureAuthenticated, clearSession } = useAuthSession();

  // On-Chain Directory state
  const [regForm, setRegForm] = useState(EMPTY_REG);
  const [regError, setRegError] = useState('');
  const [directoryTxSubmitted, setDirectoryTxSubmitted] = useState(false);
  const regPrefilled = useRef(false);

  // Availability state & transaction
  const [availBusy, setAvailBusy] = useState(false);
  const [availError, setAvailError] = useState('');

  // Off-Chain Rich Metadata state
  const [richForm, setRichForm] = useState<RichMarketMetadata>(EMPTY_RICH_METADATA);
  const [newSecCat, setNewSecCat] = useState('');
  const [richLoading, setRichLoading] = useState(false);
  const [richSaving, setRichSaving] = useState(false);
  const [richError, setRichError] = useState('');
  const [richSuccess, setRichSuccess] = useState(false);

  // Active expanded portfolio project editor index (-1 means none)
  const [activeProjIdx, setActiveProjIdx] = useState<number>(-1);

  // Reset prefill flag on address change
  useEffect(() => {
    regPrefilled.current = false;
  }, [address]);

  // Refetch directory profile when on-chain transaction succeeds
  useEffect(() => {
    if (directoryTxSubmitted && directory.txReceipt.isSuccess) {
      directory.refetchAll();
      setDirectoryTxSubmitted(false);
    }
  }, [directory.txReceipt.isSuccess, directoryTxSubmitted, directory]);

  // Prefill on-chain form from Directory
  useEffect(() => {
    if (!open || regPrefilled.current) return;
    if (directory.myRegistered && directory.myProfile) {
      let rateVal: string;
      try {
        rateVal = String(Number(formatUnits(BigInt(directory.myProfile.rate || 0), 18)));
      } catch {
        rateVal = '';
      }
      setRegForm({
        name: String(directory.myProfile.name || ''),
        category: String(directory.myProfile.category || 'Web Development'),
        skills: (directory.myProfile.skills || []).join(', '),
        rate: rateVal,
        bio: String(directory.myProfile.bio || ''),
      });
      regPrefilled.current = true;
    }
  }, [open, directory.myRegistered, directory.myProfile]);

  // Load Off-Chain Rich Market Metadata with race condition protection
  useEffect(() => {
    if (!address) {
      setRichForm(EMPTY_RICH_METADATA);
      setRichError('');
      setRichLoading(false);
      return;
    }

    let cancelled = false;
    setRichLoading(true);
    setRichError('');

    fetch(`/api/profile/market/${address}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data && typeof data === 'object') {
          setRichForm({
            headline: typeof data.headline === 'string' ? data.headline : '',
            secondaryCategories: Array.isArray(data.secondaryCategories) ? data.secondaryCategories : [],
            about: typeof data.about === 'string' ? data.about : '',
            typicalDelivery: typeof data.typicalDelivery === 'string' ? data.typicalDelivery : '',
            links: {
              website: typeof data.links?.website === 'string' ? data.links.website : '',
              github: typeof data.links?.github === 'string' ? data.links.github : '',
              twitter: typeof data.links?.twitter === 'string' ? data.links.twitter : '',
              linkedin: typeof data.links?.linkedin === 'string' ? data.links.linkedin : '',
            },
            portfolio: Array.isArray(data.portfolio) ? data.portfolio : [],
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setRichError('Failed to load professional details');
        }
      })
      .finally(() => {
        if (!cancelled) setRichLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [address]);

  // Submit On-Chain Directory Profile
  const submitRegProfile = () => {
    if (!address) {
      setRegError('Connect your wallet first');
      return;
    }
    if (regForm.name.trim().length < 2) {
      setRegError('Enter your name (2-40 chars)');
      return;
    }
    const rate = Number(regForm.rate);
    if (!rate || rate <= 0 || !isFinite(rate)) {
      setRegError('Enter a valid rate');
      return;
    }
    const skills = regForm.skills.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8);
    if (skills.length === 0) {
      setRegError('Add at least one skill');
      return;
    }
    setRegError('');
    try {
      const args = [
        regForm.name.trim(),
        regForm.category,
        skills,
        BigInt(Math.round(rate * 1e18)),
        regForm.bio.trim(),
      ] as const;
      setDirectoryTxSubmitted(true);
      if (directory.myRegistered) directory.updateProfile(...args);
      else directory.registerProfile(...args);
    } catch (e: any) {
      setDirectoryTxSubmitted(false);
      setRegError(`Failed: ${String(e?.message || e).slice(0, 120)}`);
    }
  };

  // Submit Availability Change On-Chain
  const handleSetAvailable = async (newVal: boolean) => {
    if (!address) return;
    setAvailError('');
    setAvailBusy(true);
    try {
      await directory.setAvailable(newVal);
    } catch (err: any) {
      setAvailError(err?.message || 'Failed to update availability');
    } finally {
      setAvailBusy(false);
    }
  };

  // Add Secondary Category
  const addSecondaryCategory = () => {
    const trimmed = newSecCat.trim();
    if (!trimmed) return;
    if (trimmed.length > 40) {
      setRichError('Secondary category item exceeds 40 characters limit');
      return;
    }
    if (richForm.secondaryCategories.length >= 4) {
      setRichError('Maximum 4 secondary categories allowed');
      return;
    }
    if (
      richForm.secondaryCategories.some((c) => c.toLowerCase() === trimmed.toLowerCase()) ||
      trimmed.toLowerCase() === regForm.category.toLowerCase()
    ) {
      setNewSecCat('');
      return;
    }
    setRichForm((prev) => ({
      ...prev,
      secondaryCategories: [...prev.secondaryCategories, trimmed],
    }));
    setNewSecCat('');
    setRichError('');
  };

  // Remove Secondary Category
  const removeSecondaryCategory = (catToRemove: string) => {
    setRichForm((prev) => ({
      ...prev,
      secondaryCategories: prev.secondaryCategories.filter((c) => c !== catToRemove),
    }));
  };

  // Portfolio Management Helpers
  const addPortfolioProject = () => {
    if (richForm.portfolio.length >= 6) {
      setRichError('Maximum 6 portfolio projects allowed');
      return;
    }
    const newProj: PortfolioProject = {
      id: genLocalProjId(),
      title: 'New Project',
      description: '',
      image: '',
      link: '',
      tags: [],
    };
    setRichForm((prev) => ({
      ...prev,
      portfolio: [...prev.portfolio, newProj],
    }));
    setActiveProjIdx(richForm.portfolio.length);
  };

  const updatePortfolioProject = (idx: number, patch: Partial<PortfolioProject>) => {
    setRichForm((prev) => {
      const updated = [...prev.portfolio];
      if (updated[idx]) {
        updated[idx] = { ...updated[idx], ...patch };
      }
      return { ...prev, portfolio: updated };
    });
  };

  const removePortfolioProject = (idx: number) => {
    setRichForm((prev) => ({
      ...prev,
      portfolio: prev.portfolio.filter((_, i) => i !== idx),
    }));
    if (activeProjIdx === idx) setActiveProjIdx(-1);
    else if (activeProjIdx > idx) setActiveProjIdx(activeProjIdx - 1);
  };

  // Save Off-Chain Rich Metadata
  const saveRichProfile = async () => {
    setRichError('');
    setRichSuccess(false);

    if (!address) {
      setRichError('Connect your wallet first');
      return;
    }

    if (!directory.myRegistered) {
      setRichError('Register your Market Profile first to publish professional details.');
      return;
    }

    // Client-side validations
    if (richForm.headline.length > 100) {
      setRichError('Headline exceeds 100 characters limit');
      return;
    }

    if (richForm.about.length > 2000) {
      setRichError('About section exceeds 2000 characters limit');
      return;
    }

    if (richForm.typicalDelivery.length > 60) {
      setRichError('Typical delivery exceeds 60 characters limit');
      return;
    }

    // Validate link formats
    const linkKeys = ['website', 'github', 'twitter', 'linkedin'] as const;
    for (const k of linkKeys) {
      const val = richForm.links[k];
      if (val.trim()) {
        if (val.trim().length > 300) {
          setRichError(`Link '${k}' exceeds 300 characters limit`);
          return;
        }
        if (!isValidHttpUrl(val)) {
          setRichError(`Link '${k}' must start with http:// or https://`);
          return;
        }
      }
    }

    // Validate portfolio
    for (let i = 0; i < richForm.portfolio.length; i++) {
      const p = richForm.portfolio[i];
      if (!p.title.trim()) {
        setRichError(`Portfolio project #${i + 1} requires a title`);
        return;
      }
      if (p.title.length > 100) {
        setRichError(`Portfolio project #${i + 1} title exceeds 100 characters limit`);
        return;
      }
      if (p.description.length > 600) {
        setRichError(`Portfolio project #${i + 1} description exceeds 600 characters limit`);
        return;
      }
      if (p.image.trim() && !isValidHttpUrl(p.image)) {
        setRichError(`Portfolio project #${i + 1} image URL must start with http:// or https://`);
        return;
      }
      if (p.link.trim() && !isValidHttpUrl(p.link)) {
        setRichError(`Portfolio project #${i + 1} link URL must start with http:// or https://`);
        return;
      }
    }

    setRichSaving(true);
    try {
      const token = await ensureAuthenticated();
      const res = await fetch(`/api/profile/market/${address}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          wallet: address,
          headline: richForm.headline,
          secondaryCategories: richForm.secondaryCategories,
          about: richForm.about,
          typicalDelivery: richForm.typicalDelivery,
          links: richForm.links,
          portfolio: richForm.portfolio,
        }),
      });

      if (res.status === 401) {
        clearSession();
        setRichError('Authorization session expired. Please click Save Professional Details to sign in again.');
        setRichSaving(false);
        return;
      }

      const data = await res.json();
      if (!res.ok) {
        setRichError(data.error || 'Failed to save professional details');
        setRichSaving(false);
        return;
      }

      if (data.profile) {
        setRichForm({
          headline: data.profile.headline || '',
          secondaryCategories: Array.isArray(data.profile.secondaryCategories) ? data.profile.secondaryCategories : [],
          about: data.profile.about || '',
          typicalDelivery: data.profile.typicalDelivery || '',
          links: {
            website: data.profile.links?.website || '',
            github: data.profile.links?.github || '',
            twitter: data.profile.links?.twitter || '',
            linkedin: data.profile.links?.linkedin || '',
          },
          portfolio: Array.isArray(data.profile.portfolio) ? data.profile.portfolio : [],
        });
      }

      setRichSuccess(true);
      setTimeout(() => setRichSuccess(false), 3000);
    } catch (err: any) {
      setRichError(err?.message || 'Authentication or network error');
    } finally {
      setRichSaving(false);
    }
  };

  return (
    <div className="space-y-4 pt-1">
      {/* SECTION 1: PUBLIC LISTING */}
      <div className="space-y-3 p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-white uppercase tracking-wider">Public Listing</span>
          {directory.myRegistered && (
            <div className="flex items-center gap-1 text-xs text-emerald-400">
              <CircleCheck size={13} /> Registered
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Provider Name</label>
            <Input
              value={regForm.name}
              onChange={(e) => setRegForm({ ...regForm, name: e.target.value })}
              placeholder="Your name or studio"
              maxLength={40}
            />
          </div>

          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Primary Category</label>
            <select
              value={regForm.category}
              onChange={(e) => setRegForm({ ...regForm, category: e.target.value })}
              className="w-full h-10 rounded-xl border border-zinc-700 bg-zinc-800/50 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
            >
              {SELLER_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Core Skills (Max 8, comma separated)</label>
            <Input
              value={regForm.skills}
              onChange={(e) => setRegForm({ ...regForm, skills: e.target.value })}
              placeholder="React, Next.js, Solidity, UI Design"
            />
          </div>

          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Starting Rate (ETH)</label>
            <Input
              type="number"
              value={regForm.rate}
              onChange={(e) => setRegForm({ ...regForm, rate: e.target.value })}
              placeholder="0.5"
              min="0.001"
              step="0.01"
            />
          </div>
        </div>

        <div>
          <label className="text-xs text-zinc-400 mb-1 flex items-center justify-between">
            <span>Personal Quote</span>
            <span className="text-[10px] text-zinc-500">{regForm.bio.length} / 300</span>
          </label>
          <textarea
            value={regForm.bio}
            onChange={(e) => setRegForm({ ...regForm, bio: e.target.value })}
            placeholder="A short line that represents you or how you work..."
            maxLength={300}
            className="w-full h-14 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-1.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
          />
        </div>

        {/* Compact Availability Row */}
        {directory.myRegistered && (
          <div className="p-2.5 rounded-lg bg-zinc-800/40 border border-zinc-700/50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Power size={13} className={directory.myProfile?.available ? 'text-emerald-400' : 'text-zinc-500'} />
              <div>
                <p className="text-xs font-medium text-white">Available for new client work</p>
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant={directory.myProfile?.available ? 'outline' : 'default'}
              disabled={availBusy || directory.isPending}
              onClick={() => handleSetAvailable(!directory.myProfile?.available)}
              className="h-8 text-xs gap-1.5 shrink-0"
            >
              {availBusy ? <LoaderCircle size={12} className="animate-spin" /> : null}
              {directory.myProfile?.available ? 'Set Unavailable' : 'Set Available'}
            </Button>
          </div>
        )}

        {regError && <p className="text-xs text-red-400">{regError}</p>}
        {directory.writeError && (
          <p className="text-xs text-red-400">
            Transaction error:{' '}
            {String(
              (directory.writeError as any).shortMessage ||
                (directory.writeError as any).message ||
                directory.writeError
            ).slice(0, 120)}
          </p>
        )}
        {directory.txReceipt.isSuccess && (
          <div className="p-2 rounded-lg bg-green-600/10 border border-green-500/20 text-xs text-green-400 flex items-center gap-1.5">
            <Check size={12} /> On-chain profile updated successfully!
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <Button
            type="button"
            onClick={submitRegProfile}
            disabled={directory.isPending || !isConnected || !networkReady}
            className="gap-2 shrink-0"
          >
            {directory.isPending ? (
              <LoaderCircle size={14} className="animate-spin" />
            ) : directory.myRegistered ? (
              <Pencil size={14} />
            ) : (
              <Plus size={14} />
            )}
            {directory.isPending
              ? 'Signing Transaction...'
              : directory.myRegistered
              ? 'Update Public Listing'
              : 'Register Public Listing'}
          </Button>
          <span className="text-[11px] text-zinc-500">Requires wallet confirmation • Sepolia</span>
        </div>
      </div>

      {/* SECTION 2: PROFESSIONAL DETAILS */}
      <div className="space-y-3 p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-white uppercase tracking-wider">Professional Details</span>
          {richLoading && (
            <span className="text-xs text-zinc-400 flex items-center gap-1">
              <LoaderCircle size={12} className="animate-spin" /> Loading...
            </span>
          )}
        </div>

        {!directory.myRegistered && (
          <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center gap-2 text-xs text-amber-300">
            <CircleAlert size={14} className="shrink-0" />
            <span>Register your Market Profile on-chain first to publish professional details.</span>
          </div>
        )}

        <div>
          <label className="text-xs text-zinc-400 mb-1 flex items-center justify-between">
            <span>Professional Headline</span>
            <span className="text-[10px] text-zinc-500">{richForm.headline.length} / 100</span>
          </label>
          <Input
            value={richForm.headline}
            onChange={(e) => setRichForm({ ...richForm, headline: e.target.value })}
            placeholder="e.g. Senior Smart Contract Auditor & Full-Stack Web3 Engineer"
            maxLength={100}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Secondary Professional Areas */}
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Secondary Professional Areas (Max 4)</label>
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {richForm.secondaryCategories.map((cat) => (
                <span
                  key={cat}
                  className="text-[11px] font-medium text-blue-300 bg-blue-500/10 border border-blue-500/20 rounded-md px-2 py-0.5 flex items-center gap-1"
                >
                  {cat}
                  <button
                    type="button"
                    onClick={() => removeSecondaryCategory(cat)}
                    className="text-zinc-400 hover:text-red-400"
                  >
                    &times;
                  </button>
                </span>
              ))}
            </div>

            {richForm.secondaryCategories.length < 4 && (
              <div className="flex items-center gap-1.5">
                <Input
                  value={newSecCat}
                  onChange={(e) => setNewSecCat(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addSecondaryCategory();
                    }
                  }}
                  placeholder="Add area (e.g. Audit, DevOps)"
                  maxLength={40}
                  className="h-9 text-xs"
                />
                <Button type="button" size="sm" variant="outline" onClick={addSecondaryCategory} className="h-9 px-2.5 text-xs shrink-0">
                  Add
                </Button>
              </div>
            )}
          </div>

          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Typical Delivery Time</label>
            <Input
              value={richForm.typicalDelivery}
              onChange={(e) => setRichForm({ ...richForm, typicalDelivery: e.target.value })}
              placeholder="e.g. 2–4 days per milestone"
              maxLength={60}
            />
          </div>
        </div>

        <div>
          <label className="text-xs text-zinc-400 mb-1 flex items-center justify-between">
            <span>Full About</span>
            <span className="text-[10px] text-zinc-500">{richForm.about.length} / 2000</span>
          </label>
          <textarea
            value={richForm.about}
            onChange={(e) => setRichForm({ ...richForm, about: e.target.value })}
            placeholder="Detail your experience, workflow, technology stack, and track record..."
            maxLength={2000}
            className="w-full h-20 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-1.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
          />
        </div>
      </div>

      {/* SECTION 3: LINKS */}
      <div className="space-y-3 p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800">
        <span className="text-xs font-bold text-white uppercase tracking-wider block">Links</span>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-zinc-400 mb-1 flex items-center gap-1.5">
              <Globe size={13} className="text-blue-400" /> Website URL
            </label>
            <Input
              value={richForm.links.website}
              onChange={(e) =>
                setRichForm({
                  ...richForm,
                  links: { ...richForm.links, website: e.target.value },
                })
              }
              placeholder="https://yourwebsite.io"
              maxLength={300}
            />
          </div>

          <div>
            <label className="text-xs text-zinc-400 mb-1 flex items-center gap-1.5">
              <Code size={13} className="text-zinc-300" /> GitHub URL
            </label>
            <Input
              value={richForm.links.github}
              onChange={(e) =>
                setRichForm({
                  ...richForm,
                  links: { ...richForm.links, github: e.target.value },
                })
              }
              placeholder="https://github.com/username"
              maxLength={300}
            />
          </div>

          <div>
            <label className="text-xs text-zinc-400 mb-1 flex items-center gap-1.5">
              <Globe size={13} className="text-sky-400" /> X / Twitter URL
            </label>
            <Input
              value={richForm.links.twitter}
              onChange={(e) =>
                setRichForm({
                  ...richForm,
                  links: { ...richForm.links, twitter: e.target.value },
                })
              }
              placeholder="https://x.com/username"
              maxLength={300}
            />
          </div>

          <div>
            <label className="text-xs text-zinc-400 mb-1 flex items-center gap-1.5">
              <Globe size={13} className="text-blue-500" /> LinkedIn URL
            </label>
            <Input
              value={richForm.links.linkedin}
              onChange={(e) =>
                setRichForm({
                  ...richForm,
                  links: { ...richForm.links, linkedin: e.target.value },
                })
              }
              placeholder="https://linkedin.com/in/username"
              maxLength={300}
            />
          </div>
        </div>
      </div>

      {/* SECTION 4: PORTFOLIO */}
      <div className="space-y-3 p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-white uppercase tracking-wider">Portfolio</span>
            <span className="text-[10px] font-mono text-zinc-400 bg-zinc-800 rounded px-1.5 py-0.5">
              {richForm.portfolio.length} / 6
            </span>
          </div>
          {richForm.portfolio.length < 6 && (
            <Button type="button" size="sm" variant="outline" onClick={addPortfolioProject} className="gap-1 text-xs h-7 px-2.5">
              <Plus size={12} /> Add Project
            </Button>
          )}
        </div>

        {richForm.portfolio.length === 0 ? (
          <p className="text-xs text-zinc-500 py-2 px-3 text-center bg-zinc-800/20 border border-dashed border-zinc-800 rounded-lg">
            No projects yet. Add selected work to strengthen your profile.
          </p>
        ) : (
          <div className="space-y-2.5">
            {richForm.portfolio.map((proj, idx) => (
              <div
                key={proj.id || idx}
                className="p-3 rounded-lg bg-zinc-800/40 border border-zinc-700/60 space-y-2.5"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-blue-400">#{idx + 1}</span>
                    <span className="text-xs font-semibold text-white">{proj.title || 'Untitled Project'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setActiveProjIdx(activeProjIdx === idx ? -1 : idx)}
                      className="text-xs text-blue-400 hover:text-blue-300 font-medium"
                    >
                      {activeProjIdx === idx ? 'Collapse' : 'Edit Details'}
                    </button>
                    <button
                      type="button"
                      onClick={() => removePortfolioProject(idx)}
                      className="text-zinc-400 hover:text-red-400 p-0.5"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {activeProjIdx === idx ? (
                  <div className="space-y-2.5 pt-2 border-t border-zinc-700/40">
                    <div>
                      <label className="text-[11px] text-zinc-400 mb-1 block">Project Title</label>
                      <Input
                        value={proj.title}
                        onChange={(e) => updatePortfolioProject(idx, { title: e.target.value })}
                        placeholder="e.g. DeFi Lending Protocol Frontend"
                        maxLength={100}
                      />
                    </div>

                    <div>
                      <label className="text-[11px] text-zinc-400 mb-1 flex items-center justify-between">
                        <span>Description</span>
                        <span className="text-[10px] text-zinc-500">{proj.description.length} / 600</span>
                      </label>
                      <textarea
                        value={proj.description}
                        onChange={(e) => updatePortfolioProject(idx, { description: e.target.value })}
                        placeholder="Describe your role, stack, and deliverables..."
                        maxLength={600}
                        className="w-full h-16 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-1.5 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <div>
                        <label className="text-[11px] text-zinc-400 mb-1 block">Image URL (Optional)</label>
                        <Input
                          value={proj.image}
                          onChange={(e) => updatePortfolioProject(idx, { image: e.target.value })}
                          placeholder="https://example.com/image.jpg"
                          maxLength={500}
                        />
                      </div>

                      <div>
                        <label className="text-[11px] text-zinc-400 mb-1 block">Live Link URL (Optional)</label>
                        <Input
                          value={proj.link}
                          onChange={(e) => updatePortfolioProject(idx, { link: e.target.value })}
                          placeholder="https://example.com"
                          maxLength={500}
                        />
                      </div>
                    </div>

                    <div>
                      <label className="text-[11px] text-zinc-400 mb-1 block">Project Tags (Comma separated)</label>
                      <Input
                        value={proj.tags.join(', ')}
                        onChange={(e) =>
                          updatePortfolioProject(idx, {
                            tags: e.target.value
                              .split(',')
                              .map((t) => t.trim())
                              .filter(Boolean)
                              .slice(0, 8),
                          })
                        }
                        placeholder="React, Ethers.js, Tailwind"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-zinc-400 flex items-center justify-between">
                    <span className="truncate max-w-md">{proj.description || 'No description added yet.'}</span>
                    {proj.link && (
                      <a
                        href={proj.link}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-400 flex items-center gap-1 shrink-0 text-[11px]"
                      >
                        <ExternalLink size={11} /> Link
                      </a>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* OFF-CHAIN SAVE FOOTER */}
      <div className="pt-1 space-y-2">
        {richError && <p className="text-xs text-red-400 font-medium">{richError}</p>}
        {richSuccess && (
          <div className="p-2 rounded-lg bg-emerald-600/10 border border-emerald-500/20 text-xs text-emerald-400 flex items-center gap-1.5">
            <Check size={13} /> Professional details saved successfully!
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={saveRichProfile}
            disabled={richSaving || !directory.myRegistered || !isConnected}
            className="gap-2 bg-blue-600 hover:bg-blue-500 text-white shrink-0"
          >
            {richSaving ? <LoaderCircle size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {richSaving ? 'Saving...' : 'Save Professional Details'}
          </Button>
          <span className="text-[11px] text-zinc-500">Saved instantly • No gas</span>
        </div>
      </div>
    </div>
  );
}
