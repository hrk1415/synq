'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useAccount, useReadContract } from 'wagmi';
import { isAddress } from 'viem';
import { getSuggestedDealBudget, formatPublicPricing, type FreelancerPricing } from '@/lib/deals/pricing';
import {
  Briefcase,
  Users,
  User,
  Star,
  Copy,
  Check,
  ArrowRight,
  ArrowLeft,
  ExternalLink,
  Globe,
  Pencil,
  Clock,
  Sparkles,
  CircleAlert,
  LoaderCircle,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StarRating } from '@/components/shared/StarRating';
import { shortenAddress, formatTimeAgo, cn } from '@/lib/utils';
import { CONTRACT_ADDRESSES, SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { nexotiqDirectoryABI } from '@/lib/contracts/abis';
import { registryABI } from '@/hooks/useRegistryContract';
import { useFreelancerCompletedDeals } from '@/hooks/useFreelancerStats';
import { useSynqIdentities } from '@/hooks/useSynqIdentity';
import { Press_Start_2P } from 'next/font/google';
import { ProjectThumbnail } from '@/components/profile/ProjectThumbnail';

const pressStart2P = Press_Start_2P({
  weight: '400',
  subsets: ['latin'],
});

function Avatar({ name, avatar, className }: { name: string; avatar?: string | null; className?: string }) {
  if (avatar && typeof avatar === 'string' && avatar.trim().length > 0) {
    return (
      <img
        src={avatar}
        alt={name}
        className={cn('rounded-2xl object-cover shrink-0 border border-[#383838] shadow-xs', className || 'w-20 h-20 sm:w-24 sm:h-24 lg:w-[116px] lg:h-[116px]')}
      />
    );
  }
  const initials = (name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div
      className={cn(
        'rounded-2xl bg-[#252525] border border-[#383838] flex items-center justify-center text-white font-bold shrink-0 shadow-xs',
        className || 'w-20 h-20 sm:w-24 sm:h-24 lg:w-[116px] lg:h-[116px] text-2xl sm:text-3xl lg:text-4xl'
      )}
    >
      {initials || '?'}
    </div>
  );
}

function GithubIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
      />
    </svg>
  );
}

function XTwitterIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function LinkedInIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.46 8.76a1.64 1.64 0 1 0 0-3.28 1.64 1.64 0 0 0 0 3.28m1.4 9.74v-8.37H5.06v8.37h2.8z" />
    </svg>
  );
}

interface ReviewPopoverData {
  review: any;
  name: string;
  x: number;
  y: number;
}

export interface ProviderProfileProps {
  wallet: string;
  showBreadcrumb?: boolean;
  showCloseButton?: boolean;
  onClose?: () => void;
  onSelectFreelancer?: (wallet: string) => void;
  selectButtonLabel?: string;
  isModal?: boolean;
}

export function ProviderProfile({
  wallet: rawWallet,
  showBreadcrumb = false,
  showCloseButton = false,
  onClose,
  onSelectFreelancer,
  selectButtonLabel,
  isModal = false,
}: ProviderProfileProps) {
  const validAddress = isAddress(rawWallet) ? (rawWallet as `0x${string}`) : undefined;
  const { completedCount: authCompletedDeals, isLoading: loadingCompletedDeals } = useFreelancerCompletedDeals(validAddress);

  const { address: connectedAddress } = useAccount();
  const isSelf = !!connectedAddress && !!validAddress && connectedAddress.toLowerCase() === validAddress.toLowerCase();

  const [copied, setCopied] = useState(false);
  const [richMeta, setRichMeta] = useState<any>(null);
  const [publicProfile, setPublicProfile] = useState<any>(null);
  const [reviewsData, setReviewsData] = useState<{ summary: any; reviews: any[] } | null>(null);
  const [reviewsError, setReviewsError] = useState(false);
  const [activeReviewPopover, setActiveReviewPopover] = useState<ReviewPopoverData | null>(null);

  const reviewerWallets = useMemo(() => {
    if (!reviewsData?.reviews) return [];
    const set = new Set<string>();
    for (const r of reviewsData.reviews) {
      if (r.reviewerWallet) set.add(String(r.reviewerWallet));
    }
    return Array.from(set);
  }, [reviewsData?.reviews]);

  const { identitiesMap: reviewerIdentities } = useSynqIdentities(reviewerWallets);

  const directoryConfig = {
    address: CONTRACT_ADDRESSES.sepolia.NexotiqDirectory as `0x${string}`,
    abi: nexotiqDirectoryABI,
    chainId: SEPOLIA_CHAIN_ID,
  } as const;

  const { data: isRegistered, isLoading: loadingReg, error: regError } = useReadContract({
    ...directoryConfig,
    functionName: 'isRegistered',
    args: validAddress ? [validAddress] : undefined,
    query: { enabled: !!validAddress },
  });

  const { data: rawProfile, isLoading: loadingProfile, error: profileError } = useReadContract({
    ...directoryConfig,
    functionName: 'getProfile',
    args: validAddress ? [validAddress] : undefined,
    query: { enabled: !!validAddress },
  });

  const registryConfig = {
    address: CONTRACT_ADDRESSES.sepolia.NexotiqRegistry as `0x${string}`,
    abi: registryABI,
    chainId: SEPOLIA_CHAIN_ID,
  } as const;

  const { data: rawUsername } = useReadContract({
    ...registryConfig,
    functionName: 'getUsername',
    args: validAddress ? [validAddress] : undefined,
    query: { enabled: !!validAddress },
  });
  const registryUsername = typeof rawUsername === 'string' ? rawUsername.trim() : '';

  useEffect(() => {
    if (!validAddress) return;
    const walletLower = validAddress.toLowerCase();

    // 1. Fetch Rich Market Metadata
    fetch(`/api/profile/market/${walletLower}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && !data.error) setRichMeta(data);
      })
      .catch(() => {
        /* degrade gracefully */
      });

    // 2. Fetch Public Personal Profile
    fetch('/api/profile/public', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallets: [walletLower] }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.profiles && Array.isArray(data.profiles) && data.profiles.length > 0) {
          setPublicProfile(data.profiles[0]);
        }
      })
      .catch(() => {
        /* degrade gracefully */
      });

    // 3. Fetch Read-only Reviews
    fetch(`/api/reviews?seller=${walletLower}`)
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then((data) => {
        if (data) setReviewsData({ summary: data.summary || null, reviews: data.reviews || [] });
      })
      .catch(() => {
        setReviewsError(true);
      });
  }, [validAddress]);

  const copyWallet = () => {
    if (!validAddress) return;
    navigator.clipboard.writeText(validAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const showReviewPopover = (r: any, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const walletStr = String(r.reviewerWallet || '');
    const identity = reviewerIdentities[walletStr.toLowerCase()];
    const displayName = identity?.displayHandle || r.reviewerName || shortenAddress(walletStr);

    const popoverWidth = 280;
    let x = rect.right + 10;
    if (typeof window !== 'undefined' && x + popoverWidth > window.innerWidth - 16) {
      x = Math.max(16, rect.left - popoverWidth - 10);
    }
    let y = rect.top + rect.height / 2;
    if (typeof window !== 'undefined') {
      if (y < 90) y = 90;
      if (y > window.innerHeight - 130) y = window.innerHeight - 130;
    }

    setActiveReviewPopover({
      review: r,
      name: displayName,
      x,
      y,
    });
  };

  const hideReviewPopover = () => {
    setActiveReviewPopover(null);
  };

  const toggleReviewPopover = (r: any, el: HTMLElement) => {
    if (activeReviewPopover?.review?.id === r.id) {
      hideReviewPopover();
    } else {
      showReviewPopover(r, el);
    }
  };

  // Malformed address state
  if (!validAddress) {
    return (
      <div className="py-16 text-center">
        <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 flex items-center justify-center mx-auto mb-4">
          <CircleAlert size={32} />
        </div>
        <h2 className="text-2xl font-bold text-white mb-2">Provider not found</h2>
        <p className="text-zinc-400 mb-6">This isn&apos;t a valid provider address.</p>
        {showBreadcrumb && (
          <Button asChild variant="outline">
            <Link href="/marketplace" className="gap-2">
              <ArrowLeft size={16} /> Back to Deal Port
            </Link>
          </Button>
        )}
      </div>
    );
  }

  // Loading state
  if (loadingReg || loadingProfile) {
    return (
      <div className="py-16 flex flex-col items-center justify-center min-h-[400px]">
        <LoaderCircle size={36} className="animate-spin text-white mb-4" />
        <p className="text-zinc-400 text-sm">Loading provider profile...</p>
      </div>
    );
  }

  // Directory read failure
  if (profileError || regError) {
    return (
      <div className="py-16 text-center">
        <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 flex items-center justify-center mx-auto mb-4">
          <CircleAlert size={32} />
        </div>
        <h2 className="text-2xl font-bold text-white mb-2">Failed to load provider</h2>
        <p className="text-zinc-400 mb-6">Unable to read provider details from Sepolia directory.</p>
        {showBreadcrumb && (
          <Button asChild variant="outline">
            <Link href="/marketplace" className="gap-2">
              <ArrowLeft size={16} /> Back to Deal Port
            </Link>
          </Button>
        )}
      </div>
    );
  }

  // Unregistered Provider state
  if (!isRegistered) {
    return (
      <div className="py-16 text-center">
        <div className="w-16 h-16 rounded-full bg-zinc-800/80 border border-zinc-700/60 text-zinc-400 flex items-center justify-center mx-auto mb-4">
          <CircleAlert size={32} />
        </div>
        <h2 className="text-2xl font-bold text-white mb-2">Provider not found</h2>
        <p className="text-zinc-400 mb-6">This wallet doesn&apos;t have a public listing on Deal Port.</p>
        {showBreadcrumb && (
          <Button asChild variant="outline">
            <Link href="/marketplace" className="gap-2">
              <ArrowLeft size={16} /> Back to Deal Port
            </Link>
          </Button>
        )}
      </div>
    );
  }

  // Canonical Directory Data
  const profile = rawProfile as any;
  const directoryName = String(profile?.name || 'Anonymous Provider');
  const directoryBio = String(profile?.bio || '').trim();
  const category = String(profile?.category || 'General');
  const skills: string[] = Array.isArray(profile?.skills) ? profile.skills : [];
  const available = profile?.available !== false;

  // Identity Hierarchy
  const personalName = publicProfile?.name && typeof publicProfile.name === 'string' ? publicProfile.name.trim() : '';
  const showSecondaryName = personalName.length > 0 && personalName.toLowerCase() !== directoryName.toLowerCase();

  // About Content (Strictly off-chain biography; omitted on-chain quote)
  const aboutContent = richMeta?.about && typeof richMeta.about === 'string' ? richMeta.about.trim() : '';

  // Modern Public Starting Rate (USDC only)
  const rateAmount = richMeta?.startingRateAmount || (publicProfile as any)?.startingRateAmount;
  const rateType = richMeta?.startingRateType || (publicProfile as any)?.startingRateType;
  const publicPricing: FreelancerPricing | null =
    rateAmount && rateType && (rateType === 'PER_PROJECT' || rateType === 'PER_HOUR')
      ? {
          amount: String(rateAmount),
          currency: 'USDC',
          rateType,
        }
      : null;
  const formattedPricing = formatPublicPricing(publicPricing);

  // Commercial Action URL
  const suggestedBudget = getSuggestedDealBudget(publicPricing);
  const searchParamsRecord: Record<string, string> = {
    seller: validAddress,
    type: category,
    name: directoryName,
  };
  if (suggestedBudget) {
    searchParamsRecord.budget = suggestedBudget;
  }
  const orderUrl = `/deal/new?${new URLSearchParams(searchParamsRecord).toString()}`;

  // Portfolio / Projects list (all preserved up to 6 limit)
  const portfolioList: any[] = Array.isArray(richMeta?.portfolio) ? richMeta.portfolio : [];

  // Client Reviews list
  const reviewsList: any[] = reviewsData?.reviews || [];

  // Social Links (Website, GitHub, X/Twitter, LinkedIn)
  const links = richMeta?.links || {};
  const socialItems = [
    {
      key: 'website',
      url: links.website,
      label: 'Website',
      icon: <Globe size={16} />,
    },
    {
      key: 'github',
      url: links.github,
      label: 'GitHub',
      icon: <GithubIcon className="w-4 h-4" />,
    },
    {
      key: 'twitter',
      url: links.twitter,
      label: 'X / Twitter',
      icon: <XTwitterIcon className="w-4 h-4" />,
    },
    {
      key: 'linkedin',
      url: links.linkedin,
      label: 'LinkedIn',
      icon: <LinkedInIcon className="w-4 h-4" />,
    },
  ];

  return (
    <div className={cn('flex flex-col', isModal ? 'h-full min-h-0' : 'space-y-6')}>
      {/* Top Breadcrumb Navigation (Direct Route Only) */}
      {showBreadcrumb && (
        <div className="flex items-center gap-2 text-xs text-zinc-400 mb-2 shrink-0">
          <Link href="/marketplace" className="hover:text-white transition-colors flex items-center gap-1">
            <ArrowLeft size={14} /> Deal Port
          </Link>
          <span>/</span>
          <span className="text-zinc-200 font-medium truncate">{directoryName}</span>
        </div>
      )}

      {/* =========================================================================
          BENTO GRID LAYOUT (6 SECTIONS MATCHING THE SKETCH)
          Row 1: [ Card 1 (Identity: cols 1-8) ] [ Card 2 (Deal Info: cols 9-12, row 1-2) ]
          Row 2: [ Card 3 (About: cols 1-4) ] [ Card 5 (Reviews: cols 5-8) ] [ (Card 2 continues) ]
          Row 3: [ Card 4 (Expertise: cols 1-4) ] [ Card 6 (Projects: cols 5-12) ]
      ========================================================================= */}
      <div
        className={cn(
          'grid grid-cols-1 lg:grid-cols-12 gap-3.5',
          isModal ? 'h-full min-h-0 lg:grid-rows-3' : 'space-y-4'
        )}
      >
        {/* =====================================================================
            1. IDENTITY CARD — UPPER LEFT (ROWS 1, COLS 1-2)
        ===================================================================== */}
        <div
          data-testid="bento-card-identity"
          className="lg:col-span-8 lg:row-start-1 lg:row-end-2 h-full min-h-0 rounded-2xl border border-white/75 bg-[#1B1B1B] p-4 sm:p-5 shadow-xs flex items-center justify-between gap-4 overflow-hidden"
        >
          {/* Avatar on left + Identity info */}
          <div className="flex items-center gap-3.5 sm:gap-4.5 min-w-0 flex-1">
            <Avatar
              name={directoryName}
              avatar={publicProfile?.avatar}
              className="w-20 h-20 sm:w-24 sm:h-24 lg:w-[116px] lg:h-[116px] rounded-2xl text-2xl sm:text-3xl lg:text-4xl shrink-0"
            />

            <div className="min-w-0 flex-1 space-y-1.5">
              {/* Display Name, Handle, Secondary Name */}
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className={cn(pressStart2P.className, "text-[13px] sm:text-[15px] lg:text-[16px] font-normal text-white tracking-tight leading-snug truncate")}>
                  {directoryName}
                </h2>
                {showSecondaryName && (
                  <span className="text-xs text-[#A3A3A3] font-normal truncate hidden sm:inline ml-1 font-sans">
                    ({personalName})
                  </span>
                )}
                {registryUsername && (
                  <Badge variant="outline" className="text-[11px] font-mono border border-[#383838] text-[#A3A3A3] bg-[#252525] px-2 py-0.5 rounded-md">
                    @{registryUsername}
                  </Badge>
                )}
                {isSelf && (
                  <Badge variant="info" className="text-[10px] px-2 py-0.5 bg-white text-[#171717] border border-white rounded-md font-bold">
                    You
                  </Badge>
                )}
              </div>

              {/* Professional Title */}
              <p className="text-[13px] sm:text-[14px] text-[#A3A3A3] font-medium truncate pt-0.5">
                {richMeta?.headline || category}
              </p>

              {/* Availability Indicator & Compact Wallet */}
              <div className="flex items-center gap-2.5 flex-wrap pt-0.5">
                {available ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-400 bg-emerald-950/60 px-2.5 py-0.5 rounded-full border border-emerald-800/80">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Available
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-400 bg-amber-950/60 px-2.5 py-0.5 rounded-full border border-amber-800/80">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Busy
                  </span>
                )}

                <div className="inline-flex items-center gap-1.5 font-mono text-[11.5px] text-white bg-[#252525] px-2.5 py-0.5 rounded-md border border-[#383838]">
                  <span>{shortenAddress(validAddress)}</span>
                  <button
                    type="button"
                    onClick={copyWallet}
                    className="hover:text-white transition-colors ml-0.5 p-0.5 text-[#A3A3A3]"
                    title="Copy wallet address"
                    aria-label="Copy wallet address"
                  >
                    {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Four Clickable Social Icons Aligned on Right (2x2 grid) */}
          <div className="flex items-center gap-2 shrink-0">
            <div
              data-testid="bento-social-icons"
              className="grid grid-cols-2 gap-2 shrink-0"
            >
              {socialItems.map((item) => {
                const isLinked = typeof item.url === 'string' && item.url.trim().length > 0;
                const safeUrl = isLinked
                  ? item.url.startsWith('http://') || item.url.startsWith('https://')
                    ? item.url
                    : `https://${item.url}`
                  : null;

                if (safeUrl) {
                  return (
                    <a
                      key={item.key}
                      href={safeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`${item.label}: ${safeUrl}`}
                      aria-label={`Open ${item.label}`}
                      className="w-9 h-9 rounded-full bg-white hover:bg-neutral-200 border border-neutral-200 hover:border-white text-[#171717] transition-all flex items-center justify-center shadow-xs"
                    >
                      {item.icon}
                    </a>
                  );
                }

                return (
                  <div
                    key={item.key}
                    title={`${item.label} not linked`}
                    aria-label={`${item.label} not linked`}
                    className="w-9 h-9 rounded-full bg-[#252525] border border-[#383838] text-[#666666] cursor-not-allowed flex items-center justify-center opacity-40 select-none"
                  >
                    {item.icon}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* =====================================================================
            2. DEAL INFORMATION — UPPER RIGHT (ROWS 1-2, COL 3)
        ===================================================================== */}
        <div
          data-testid="bento-card-deal"
          className="lg:col-span-4 lg:row-start-1 lg:row-end-3 h-full min-h-0 rounded-2xl border border-white/75 bg-[#1B1B1B] p-4 sm:p-5 shadow-xs flex flex-col justify-between overflow-hidden"
        >
          <div className="space-y-3 min-h-0 overflow-y-auto pr-0.5">
            {/* Header (No X icon) */}
            <div className="pb-2.5 border-b border-[#383838]">
              <h3 className={cn(pressStart2P.className, "text-[11px] sm:text-[12px] text-white flex items-center gap-2")}>
                <Briefcase size={14} className="text-white shrink-0" /> Deal Terms
              </h3>
            </div>

            {/* Starting Rate & Currency (Nested Element: #252525) */}
            <div className="rounded-xl bg-[#252525] border border-[#383838] p-3 space-y-1">
              <span className="text-[11px] font-medium text-[#A3A3A3] block">
                Starting Rate
              </span>
              {formattedPricing ? (
                <div className="flex items-baseline justify-between gap-2 flex-wrap">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[26px] sm:text-[28px] font-black text-white tracking-tight leading-none">
                      ${formattedPricing.amountDisplay}
                    </span>
                    <span className="text-[12px] font-bold text-[#A3A3A3]">USDC</span>
                  </div>
                  <Badge variant="outline" className="text-[10px] bg-[#1B1B1B] border border-[#383838] text-white font-medium px-2 py-0.5 rounded-md">
                    {formattedPricing.typeLabel}
                  </Badge>
                </div>
              ) : (
                <span className="text-[13px] font-semibold text-[#888888]">Rate not set</span>
              )}
            </div>

            {/* Terms List: Delivery, Completed, Availability */}
            <div className="space-y-2.5 pt-0.5">
              <div className="flex items-center justify-between text-[#A3A3A3] pb-2 border-b border-[#383838]">
                <span className="text-[12.5px] text-[#A3A3A3] flex items-center gap-2">
                  <Clock size={14} className="text-[#A3A3A3]" /> Typical Delivery
                </span>
                <span className="font-semibold text-white text-[13.5px] sm:text-[14px]">
                  {richMeta?.typicalDelivery || 'Flexible'}
                </span>
              </div>

              <div className="flex items-center justify-between text-[#A3A3A3] pb-2 border-b border-[#383838]">
                <span className="text-[12.5px] text-[#A3A3A3] flex items-center gap-2">
                  <Users size={14} className="text-[#A3A3A3]" /> Completed Deals
                </span>
                <span className="font-semibold text-white font-mono text-[13.5px] sm:text-[14px]">
                  {loadingCompletedDeals || authCompletedDeals === undefined ? '—' : authCompletedDeals}
                </span>
              </div>

              <div className="flex items-center justify-between text-[#A3A3A3]">
                <span className="text-[12.5px] text-[#A3A3A3] flex items-center gap-2">
                  <Briefcase size={14} className="text-[#A3A3A3]" /> Availability
                </span>
                <span className={cn('font-semibold text-[13px] sm:text-[14px]', available ? 'text-emerald-400' : 'text-amber-400')}>
                  {available ? 'Available' : 'Busy'}
                </span>
              </div>
            </div>
          </div>

          {/* Prominent Order Button strictly inside card */}
          <div className="pt-3 mt-auto shrink-0 border-t border-[#383838]">
            {isSelf ? (
              <Button asChild className="w-full gap-2 bg-white hover:bg-neutral-200 text-[#171717] font-bold text-[13.5px] h-11 shadow-sm rounded-xl transition-all focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-[#1B1B1B]">
                <Link href="/profile?edit=true">
                  <Pencil size={15} className="text-[#171717]" /> Edit Profile
                </Link>
              </Button>
            ) : onSelectFreelancer && validAddress ? (
              <Button
                type="button"
                onClick={() => {
                  onSelectFreelancer(validAddress);
                  if (onClose) onClose();
                }}
                className="w-full gap-2 bg-white hover:bg-neutral-200 text-[#171717] font-bold text-[13.5px] h-11 shadow-sm rounded-xl transition-all focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-[#1B1B1B]"
              >
                <Check size={15} className="text-[#171717]" /> {selectButtonLabel || 'Select This Freelancer'}
              </Button>
            ) : (
              <Button asChild className="w-full gap-2 bg-white hover:bg-neutral-200 text-[#171717] font-bold text-[13.5px] h-11 shadow-sm rounded-xl transition-all focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-[#1B1B1B]">
                <Link href={orderUrl}>
                  <ArrowRight size={15} className="text-[#171717]" /> Order This Freelancer
                </Link>
              </Button>
            )}
          </div>
        </div>

        {/* =====================================================================
            3. ABOUT — MIDDLE LEFT (ROW 2, COL 1)
        ===================================================================== */}
        <div
          data-testid="bento-card-about"
          className="lg:col-span-4 lg:row-start-2 lg:row-end-3 h-full min-h-0 rounded-2xl border border-white/75 bg-[#1B1B1B] p-4 sm:p-4.5 shadow-xs flex flex-col justify-between overflow-hidden"
        >
          <div className="min-h-0 flex-1 flex flex-col">
            <h3 className={cn(pressStart2P.className, "text-[11px] sm:text-[12px] text-white flex items-center gap-2 mb-2 shrink-0")}>
              <User size={14} className="text-white shrink-0" /> About
            </h3>
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 text-[13px] sm:text-[13.5px] text-[#E0E0E0] leading-relaxed whitespace-pre-line break-words [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-[#383838] [&::-webkit-scrollbar-thumb]:rounded-full">
              {aboutContent ? (
                aboutContent
              ) : (
                <p className="text-[#888888] italic">No biography provided yet.</p>
              )}
            </div>
          </div>
        </div>

        {/* =====================================================================
            5. CLIENT REVIEWS — MIDDLE CENTER (ROW 2, COL 2)
        ===================================================================== */}
        <div
          data-testid="bento-card-reviews"
          className="lg:col-span-4 lg:row-start-2 lg:row-end-3 h-full min-h-0 rounded-2xl border border-white/75 bg-[#1B1B1B] p-4 sm:p-4.5 shadow-xs flex flex-col justify-between overflow-hidden"
        >
          {/* Top Rating Summary */}
          <div className="flex items-center justify-between gap-2 mb-2 pb-2 border-b border-[#383838] shrink-0">
            <h3 className={cn(pressStart2P.className, "text-[11px] sm:text-[12px] text-white flex items-center gap-2")}>
              <Star size={14} className="text-amber-400 fill-amber-400 shrink-0" /> Reviews
            </h3>
            {reviewsData?.summary ? (
              <div className="flex items-center gap-1.5">
                <StarRating value={reviewsData.summary.average} count={reviewsData.summary.count} readOnly size={11} />
              </div>
            ) : (
              <span className="text-[11.5px] font-mono text-[#A3A3A3]">0 reviews</span>
            )}
          </div>

          {/* Compact Review Rows */}
          {reviewsError ? (
            <p className="text-sm text-[#A3A3A3] py-6 text-center">Reviews currently unavailable.</p>
          ) : !reviewsData ? (
            <div className="py-6 text-center text-[#A3A3A3] flex justify-center">
              <LoaderCircle size={18} className="animate-spin text-[#A3A3A3]" />
            </div>
          ) : reviewsList.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-sm text-[#888888] py-4">
              No client reviews yet.
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-1.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-[#383838] [&::-webkit-scrollbar-thumb]:rounded-full">
              {reviewsList.map((r: any) => {
                const walletStr = String(r.reviewerWallet || '');
                const identity = reviewerIdentities[walletStr.toLowerCase()];
                const displayName = identity?.displayHandle || r.reviewerName || shortenAddress(walletStr);

                return (
                  <div
                    key={r.id}
                    tabIndex={0}
                    role="button"
                    onMouseEnter={(e) => showReviewPopover(r, e.currentTarget)}
                    onMouseLeave={hideReviewPopover}
                    onFocus={(e) => showReviewPopover(r, e.currentTarget)}
                    onBlur={hideReviewPopover}
                    onClick={(e) => toggleReviewPopover(r, e.currentTarget)}
                    className="p-2 rounded-xl border border-[#383838] bg-[#252525] hover:border-[#555555] hover:bg-[#2C2C2C] transition-all flex items-center justify-between gap-2 cursor-pointer focus:outline-none focus:ring-1 focus:ring-white select-none"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[12.5px] font-semibold text-white truncate max-w-[120px] sm:max-w-[140px]">
                        {displayName}
                      </span>
                      {r.verifiedDeal && (
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-400 border border-emerald-800/80 shrink-0 font-medium">
                          Verified
                        </span>
                      )}
                    </div>
                    <div className="shrink-0 flex items-center gap-1">
                      <StarRating value={r.rating} readOnly size={10} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* =====================================================================
            4. EXPERTISE — LOWER LEFT (ROW 3, COL 1)
        ===================================================================== */}
        <div
          data-testid="bento-card-expertise"
          className="lg:col-span-4 lg:row-start-3 lg:row-end-4 h-full min-h-0 rounded-2xl border border-white/75 bg-[#1B1B1B] p-4 sm:p-4.5 shadow-xs flex flex-col justify-between overflow-hidden"
        >
          <div className="min-h-0 flex-1 flex flex-col">
            <h3 className={cn(pressStart2P.className, "text-[11px] sm:text-[12px] text-white flex items-center gap-2 mb-2 shrink-0")}>
              <Briefcase size={14} className="text-white shrink-0" /> Expertise
            </h3>
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-[#383838] [&::-webkit-scrollbar-thumb]:rounded-full">
              {/* Primary Category */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11.5px] font-medium text-[#A3A3A3]">Primary:</span>
                <span className="bg-white text-[#171717] text-[11.5px] font-bold px-2.5 py-0.5 rounded-md">
                  {category}
                </span>
              </div>

              {/* Specializations / Secondary Categories (Nested: #252525) */}
              {Array.isArray(richMeta?.secondaryCategories) && richMeta.secondaryCategories.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11.5px] font-medium text-[#A3A3A3]">Focus:</span>
                  {richMeta.secondaryCategories.map((cat: string) => (
                    <span key={cat} className="text-[11.5px] px-2 py-0.5 rounded-md bg-[#252525] text-white border border-[#383838]">
                      {cat}
                    </span>
                  ))}
                </div>
              )}

              {/* Skills Badges (Nested: #252525) */}
              {skills.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {skills.map((skill: string) => (
                    <span key={skill} className="px-2 py-0.5 rounded-md bg-[#252525] text-[11px] text-[#E0E0E0] border border-[#383838] hover:border-neutral-400 transition-colors">
                      {skill}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* =====================================================================
            6. PROJECTS — LOWER CENTER/RIGHT (ROW 3, COLS 2-3)
        ===================================================================== */}
        <div
          data-testid="bento-card-projects"
          className="lg:col-span-8 lg:row-start-3 lg:row-end-4 h-full min-h-0 rounded-2xl border border-white/75 bg-[#1B1B1B] p-4 sm:p-4.5 shadow-xs flex flex-col justify-between overflow-hidden"
        >
          <div className="flex items-center justify-between gap-2 mb-2 shrink-0">
            <h3 className={cn(pressStart2P.className, "text-[11px] sm:text-[12px] text-white flex items-center gap-2")}>
              <Sparkles size={14} className="text-white shrink-0" /> Projects
            </h3>
            <span className="text-[11.5px] font-mono text-[#A3A3A3] font-semibold">
              {portfolioList.length} / 6
            </span>
          </div>

          {portfolioList.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-sm text-[#888888] py-6">
              No projects added yet.
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden pr-0.5 pb-0.5 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:bg-[#383838] [&::-webkit-scrollbar-thumb]:rounded-full">
              <div className="grid grid-flow-col auto-cols-[165px] sm:auto-cols-[180px] gap-2.5 h-full min-h-0">
                {portfolioList.map((project: any, idx: number) => (
                  <div
                    key={project.id || idx}
                    tabIndex={0}
                    className="group relative p-2.5 rounded-xl border border-[#383838] bg-[#252525] hover:border-[#555555] hover:bg-[#2C2C2C] transition-all flex flex-col justify-between h-full min-h-0 overflow-hidden focus:outline-none focus:ring-1 focus:ring-white"
                  >
                    {/* Default compact view */}
                    <div className="space-y-1 min-h-0">
                      <div className="flex items-center justify-between gap-1.5">
                        <ProjectThumbnail src={project.image} alt={project.title} size="tile" theme="dark" />
                        <span className="text-[10px] font-mono text-[#888888] font-semibold">#{idx + 1}</span>
                      </div>
                      <h4 className="text-[12.5px] font-bold text-white truncate leading-tight pt-0.5">
                        {project.title}
                      </h4>
                      {project.description ? (
                        <p className="text-[11px] text-[#A3A3A3] truncate leading-tight">
                          {project.description}
                        </p>
                      ) : Array.isArray(project.tags) && project.tags.length > 0 ? (
                        <span className="inline-block text-[10px] text-[#A3A3A3] font-mono truncate max-w-full">
                          #{project.tags[0]}
                        </span>
                      ) : null}
                    </div>

                    {/* Hover / Focus Details Overlay */}
                    <div className="absolute inset-0 bg-[#171717]/95 backdrop-blur-xs p-2.5 rounded-xl opacity-0 group-hover:opacity-100 group-focus:opacity-100 group-focus-within:opacity-100 transition-opacity flex flex-col justify-between z-10 border border-[#383838] text-white">
                      <div className="min-h-0 overflow-y-auto pr-0.5 space-y-1 text-left [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:bg-[#333333]">
                        <p className="text-[12px] font-bold text-white truncate">{project.title}</p>
                        {project.description && (
                          <p className="text-[11px] text-zinc-300 line-clamp-2 leading-relaxed">
                            {project.description}
                          </p>
                        )}
                        {Array.isArray(project.tags) && project.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 pt-0.5">
                            {project.tags.slice(0, 3).map((tag: string) => (
                              <span
                                key={tag}
                                className="text-[9px] px-1.5 py-0.5 rounded bg-[#2A2A2A] text-zinc-300 border border-[#383838]"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      {project.link && (
                        <a
                          href={project.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] font-semibold text-white hover:text-zinc-200 flex items-center justify-between pt-1 border-t border-[#383838] transition-colors"
                          title="Open project link"
                        >
                          <span>Visit</span>
                          <ExternalLink size={11} />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* =========================================================================
          GLOBAL UNCLIPPED REVIEW POPOVER (FIXED POSITIONED)
      ========================================================================= */}
      {activeReviewPopover && (
        <div
          role="tooltip"
          style={{
            position: 'fixed',
            left: `${activeReviewPopover.x}px`,
            top: `${activeReviewPopover.y}px`,
            transform: 'translateY(-50%)',
          }}
          className="z-50 w-72 max-w-[90vw] p-3 rounded-xl bg-[#1B1B1B] border border-[#383838] shadow-[0_12px_36px_rgba(0,0,0,0.85)] text-white pointer-events-none space-y-1.5 animate-in fade-in zoom-in-95 duration-100"
        >
          <div className="flex items-center justify-between gap-2 border-b border-[#2A2A2A] pb-1.5">
            <span className="text-xs font-bold text-white truncate">
              {activeReviewPopover.name}
            </span>
            <span className="text-[10px] font-mono text-zinc-500 shrink-0">
              {formatTimeAgo(activeReviewPopover.review.updatedAt || activeReviewPopover.review.createdAt)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-1.5">
            <StarRating value={activeReviewPopover.review.rating} readOnly size={10} />
            {activeReviewPopover.review.verifiedDeal && (
              <span className="text-[9px] text-emerald-400 font-mono px-1 py-0.5 rounded bg-emerald-950/60 border border-emerald-800/80">
                Verified Deal
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap break-words max-h-36 overflow-y-auto pr-1">
            {activeReviewPopover.review.comment ? (
              activeReviewPopover.review.comment
            ) : (
              <span className="italic text-zinc-500">No written message provided.</span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
