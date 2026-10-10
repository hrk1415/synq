'use client';

import { useState, useEffect, useMemo } from 'react';
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
  Code,
  Share2,
  Pencil,
  Clock,
  Sparkles,
  CircleAlert,
  LoaderCircle,
  X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { StarRating } from '@/components/shared/StarRating';
import { shortenAddress, formatTimeAgo, cn } from '@/lib/utils';
import { CONTRACT_ADDRESSES, SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { nexotiqDirectoryABI } from '@/lib/contracts/abis';
import { registryABI } from '@/hooks/useRegistryContract';
import { useFreelancerCompletedDeals } from '@/hooks/useFreelancerStats';
import { useSynqIdentities } from '@/hooks/useSynqIdentity';

function Avatar({ name, avatar, className }: { name: string; avatar?: string | null; className?: string }) {
  if (avatar && typeof avatar === 'string' && avatar.trim().length > 0) {
    return (
      <img
        src={avatar}
        alt={name}
        className={cn('rounded-2xl object-cover shrink-0', className || 'w-16 h-16')}
      />
    );
  }
  const initials = (name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const hues = ['from-blue-500 to-violet-600', 'from-emerald-500 to-teal-600', 'from-orange-500 to-red-600', 'from-pink-500 to-rose-600'];
  const hue = hues[((name || '').length + (name || '').charCodeAt(0)) % hues.length];
  return (
    <div className={cn('rounded-2xl bg-gradient-to-br flex items-center justify-center text-white font-bold shrink-0 shadow-md', hue, className || 'w-16 h-16 text-xl')}>
      {initials || '?'}
    </div>
  );
}

function PortfolioCard({ project }: { project: any }) {
  const [imgError, setImgError] = useState(false);
  const hasImg = project.image && typeof project.image === 'string' && project.image.trim() !== '' && !imgError;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/80 overflow-hidden flex flex-col h-full hover:border-zinc-700/80 transition-all">
      {hasImg && (
        <div className="w-full aspect-video relative bg-zinc-950 overflow-hidden">
          <img
            src={project.image}
            alt={project.title}
            onError={() => setImgError(true)}
            className="w-full h-full object-cover"
          />
        </div>
      )}
      <div className="p-4 flex flex-col flex-1">
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <h4 className="text-base font-semibold text-white line-clamp-1">{project.title}</h4>
          {project.link && (
            <a
              href={project.link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 hover:text-blue-400 transition-colors shrink-0 p-0.5"
              title="Open project link"
              aria-label={`Open ${project.title} external link`}
            >
              <ExternalLink size={14} />
            </a>
          )}
        </div>
        {project.description && (
          <p className="text-xs text-zinc-400 line-clamp-3 mb-3 leading-relaxed">{project.description}</p>
        )}
        {Array.isArray(project.tags) && project.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-auto pt-2">
            {project.tags.map((tag: string) => (
              <span key={tag} className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700/50">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export interface ProviderProfileProps {
  wallet: string;
  showBreadcrumb?: boolean;
  showCloseButton?: boolean;
  onClose?: () => void;
  onSelectFreelancer?: (wallet: string) => void;
  selectButtonLabel?: string;
}

export function ProviderProfile({
  wallet: rawWallet,
  showBreadcrumb = false,
  showCloseButton = false,
  onClose,
  onSelectFreelancer,
  selectButtonLabel,
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

  // Malformed address state
  if (!validAddress) {
    return (
      <div className="py-16 text-center">
        <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 flex items-center justify-center mx-auto mb-4">
          <CircleAlert size={32} />
        </div>
        <h2 className="text-2xl font-bold text-white mb-2">Provider not found</h2>
        <p className="text-zinc-400 mb-6">This isn't a valid provider address.</p>
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
        <LoaderCircle size={36} className="animate-spin text-blue-400 mb-4" />
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
        <p className="text-zinc-400 mb-6">This wallet doesn't have a public listing on Deal Port.</p>
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
  const category = String(profile?.category || 'General');
  const skills: string[] = Array.isArray(profile?.skills) ? profile.skills : [];
  const directoryBio = String(profile?.bio || '').trim(); // Treated as Personal Quote
  const available = profile?.available !== false;

  // Identity Hierarchy
  const personalName = publicProfile?.name && typeof publicProfile.name === 'string' ? publicProfile.name.trim() : '';
  const showSecondaryName = personalName.length > 0 && personalName.toLowerCase() !== directoryName.toLowerCase();

  // About Content (Rich About ONLY — no fallback to Personal Quote)
  const aboutContent = richMeta?.about && typeof richMeta.about === 'string' ? richMeta.about.trim() : '';

  // Modern Public Starting Rate (USDC only - no public ETH rate)
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

  // Commercial Action URL (ETH never prefills USDC deal budget; only PER_PROJECT USDC does)
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

  // Links Verification
  const links = richMeta?.links || {};
  const hasLinks = Object.values(links).some((val) => typeof val === 'string' && val.trim() !== '');

  return (
    <div className="space-y-8">
      {/* Top Breadcrumb Navigation (Direct Route Only) */}
      {showBreadcrumb && (
        <div className="flex items-center gap-2 text-xs text-zinc-400 mb-2">
          <Link href="/marketplace" className="hover:text-white transition-colors flex items-center gap-1">
            <ArrowLeft size={14} /> Deal Port
          </Link>
          <span>/</span>
          <span className="text-zinc-200 font-medium truncate">{directoryName}</span>
        </div>
      )}

      {/* HERO / IDENTITY HEADER */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-900 via-zinc-900/90 to-zinc-950 p-6 md:p-8 shadow-xl">
        {showCloseButton && onClose && (
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 text-zinc-400 hover:text-white p-2 rounded-xl bg-zinc-800/50 hover:bg-zinc-800 transition-colors z-10"
            aria-label="Close modal"
          >
            <X size={20} />
          </button>
        )}

        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          {/* Left: Avatar & Main Identity */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6 flex-1 min-w-0">
            <div className="relative shrink-0">
              <Avatar name={directoryName} avatar={publicProfile?.avatar} className="w-20 h-20 md:w-24 md:h-24 text-2xl" />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2.5 mb-1.5 pr-8 md:pr-0">
                <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">
                  {directoryName}
                </h1>
                {showSecondaryName && (
                  <span className="text-sm text-zinc-400 font-normal">({personalName})</span>
                )}
                {registryUsername && (
                  <Badge variant="outline" className="text-xs font-mono border-blue-500/30 text-blue-400 bg-blue-500/5">
                    @{registryUsername}
                  </Badge>
                )}
                {isSelf && (
                  <Badge variant="info" className="text-xs">You</Badge>
                )}
              </div>

              {richMeta?.headline && (
                <p className="text-sm md:text-base text-zinc-300 font-medium mb-3">{richMeta.headline}</p>
              )}

              <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
                {available ? (
                  <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" /> Available for Work
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium">
                    <span className="w-2 h-2 rounded-full bg-amber-400" /> Busy / Currently Unavailable
                  </span>
                )}

                <div className="flex items-center gap-1.5 bg-zinc-800/80 px-2.5 py-1 rounded-full font-mono text-[11px] text-zinc-300 border border-zinc-700/50">
                  <span>{shortenAddress(validAddress)}</span>
                  <button
                    type="button"
                    onClick={copyWallet}
                    className="hover:text-white transition-colors ml-1 p-0.5"
                    title="Copy wallet address"
                    aria-label="Copy wallet address"
                  >
                    {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Right: Personal Quote (Hero Placement) */}
          {directoryBio && (
            <div className="w-full md:w-64 lg:w-72 shrink-0 md:border-l md:border-zinc-800/80 md:pl-6 pt-3 md:pt-0">
              <span className="text-[10px] text-zinc-500 font-mono uppercase tracking-wider block mb-1">Personal Quote</span>
              <p className="text-xs text-zinc-300 italic leading-relaxed">
                "{directoryBio}"
              </p>
            </div>
          )}
        </div>
      </div>

      {/* PAGE LAYOUT — Desktop 2-column, Mobile 1-column */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* MAIN COLUMN (~67%) */}
        <div className="lg:col-span-8 space-y-8">
          {/* ABOUT (Rich About ONLY) */}
          {aboutContent && (
            <Card className="border-zinc-800 bg-zinc-900/60 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg font-semibold text-white flex items-center gap-2">
                  <User size={18} className="text-blue-400" /> About
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-line">{aboutContent}</p>
              </CardContent>
            </Card>
          )}

          {/* EXPERTISE */}
          <Card className="border-zinc-800 bg-zinc-900/60 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg font-semibold text-white flex items-center gap-2">
                <Briefcase size={18} className="text-blue-400" /> Expertise
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <span className="text-xs text-zinc-400 uppercase tracking-wider block mb-1.5 font-medium">Primary Category</span>
                <Badge className="bg-blue-600/20 text-blue-300 border-blue-500/30 text-xs px-3 py-1 font-medium">
                  {category}
                </Badge>
              </div>

              {Array.isArray(richMeta?.secondaryCategories) && richMeta.secondaryCategories.length > 0 && (
                <div>
                  <span className="text-xs text-zinc-400 uppercase tracking-wider block mb-1.5 font-medium">Secondary Specializations</span>
                  <div className="flex flex-wrap gap-2">
                    {richMeta.secondaryCategories.map((cat: string) => (
                      <Badge key={cat} variant="secondary" className="bg-zinc-800 text-zinc-300 text-xs px-2.5 py-1">
                        {cat}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {skills.length > 0 && (
                <div>
                  <span className="text-xs text-zinc-400 uppercase tracking-wider block mb-1.5 font-medium">Skills & Technologies</span>
                  <div className="flex flex-wrap gap-2">
                    {skills.map((skill: string) => (
                      <span key={skill} className="px-2.5 py-1 rounded-md bg-zinc-800/80 text-xs text-zinc-300 border border-zinc-700/50">
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* PORTFOLIO */}
          {Array.isArray(richMeta?.portfolio) && richMeta.portfolio.length > 0 && (
            <Card className="border-zinc-800 bg-zinc-900/60 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg font-semibold text-white flex items-center gap-2">
                  <Sparkles size={18} className="text-blue-400" /> Portfolio
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {richMeta.portfolio.slice(0, 6).map((project: any, idx: number) => (
                    <PortfolioCard key={project.id || idx} project={project} />
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* REVIEWS — READ ONLY */}
          <Card className="border-zinc-800 bg-zinc-900/60 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-lg font-semibold text-white flex items-center gap-2">
                  <Star size={18} className="text-amber-400 fill-amber-400" /> Client Reviews
                </CardTitle>
                {reviewsData?.summary && (
                  <StarRating value={reviewsData.summary.average} readOnly count={reviewsData.summary.count} />
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {reviewsError ? (
                <p className="text-xs text-zinc-500 py-4 text-center">Reviews currently unavailable.</p>
              ) : !reviewsData ? (
                <div className="py-6 text-center text-zinc-500 flex justify-center">
                  <LoaderCircle size={20} className="animate-spin" />
                </div>
              ) : reviewsData.reviews.length === 0 ? (
                <p className="text-sm text-zinc-400 text-center py-6">No client reviews yet.</p>
              ) : (
                <div className="space-y-3">
                  {reviewsData.reviews.map((r: any) => (
                    <div key={r.id} className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4">
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-medium text-white truncate flex items-center gap-1.5">
                            {(() => {
                              const walletStr = String(r.reviewerWallet || '');
                              const identity = reviewerIdentities[walletStr.toLowerCase()];
                              const handle = identity?.displayHandle;
                              if (handle) {
                                return (
                                  <>
                                    <span className="font-semibold text-white">{handle}</span>
                                    {r.reviewerName && r.reviewerName.trim() && (
                                      <span className="text-xs text-zinc-400 font-normal">({r.reviewerName})</span>
                                    )}
                                  </>
                                );
                              }
                              return r.reviewerName || shortenAddress(walletStr);
                            })()}
                          </span>
                          {r.verifiedDeal ? (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-emerald-500/10 text-emerald-400 border-emerald-500/30 shrink-0">
                              Verified Deal
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-zinc-800 text-zinc-400 border-zinc-700 shrink-0">
                              Unverified
                            </Badge>
                          )}
                        </div>
                        <StarRating value={r.rating} readOnly size={12} />
                      </div>
                      {r.comment && (
                        <p className="text-xs text-zinc-300 whitespace-pre-wrap break-words leading-relaxed">{r.comment}</p>
                      )}
                      <p className="text-[10px] text-zinc-500 mt-2 font-mono">{formatTimeAgo(r.updatedAt || r.createdAt)}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* SIDE COLUMN (~33%) */}
        <div className="lg:col-span-4 space-y-6 lg:sticky lg:top-6">
          {/* COMMERCIAL / HIRE CARD */}
          <Card className="border-zinc-800 bg-zinc-900/90 shadow-lg">
            <CardContent className="p-5 space-y-5">
              <div className="flex items-baseline justify-between border-b border-zinc-800 pb-4">
                <span className="text-xs text-zinc-400 font-medium uppercase tracking-wider">Starting Rate</span>
                {formattedPricing ? (
                  <div className="text-right">
                    <span className="text-2xl font-bold text-white">{formattedPricing.amountDisplay}</span>
                    <span className="text-xs font-semibold text-zinc-400 ml-1">USDC</span>
                    <div className="text-[11px] text-zinc-500 font-medium lowercase">
                      {formattedPricing.typeLabel}
                    </div>
                  </div>
                ) : (
                  <div className="text-right">
                    <span className="text-sm font-semibold text-zinc-500">Rate not set</span>
                  </div>
                )}
              </div>

              <div className="space-y-3 text-xs">
                {richMeta?.typicalDelivery && (
                  <div className="flex items-center justify-between text-zinc-300">
                    <span className="text-zinc-400 flex items-center gap-1.5">
                      <Clock size={14} className="text-blue-400" /> Typical Delivery
                    </span>
                    <span className="font-medium text-white">{richMeta.typicalDelivery}</span>
                  </div>
                )}
                <div className="flex items-center justify-between text-zinc-300">
                  <span className="text-zinc-400 flex items-center gap-1.5">
                    <Users size={14} className="text-blue-400" /> Completed Deals
                  </span>
                  <span className="font-medium text-white">
                    {loadingCompletedDeals || authCompletedDeals === undefined ? '—' : authCompletedDeals}
                  </span>
                </div>
                <div className="flex items-center justify-between text-zinc-300">
                  <span className="text-zinc-400 flex items-center gap-1.5">
                    <Briefcase size={14} className="text-blue-400" /> Availability
                  </span>
                  <span className={cn('font-medium', available ? 'text-emerald-400' : 'text-amber-400')}>
                    {available ? 'Available' : 'Busy'}
                  </span>
                </div>
              </div>

              <Separator className="bg-zinc-800" />

              {/* SELF PROFILE CTA VS ORDER FREELANCER CTA */}
              {isSelf ? (
                <Button asChild className="w-full gap-2 bg-blue-600 hover:bg-blue-500 text-white">
                  <Link href="/settings">
                    <Pencil size={16} /> Edit Profile
                  </Link>
                </Button>
              ) : onSelectFreelancer && validAddress ? (
                <Button
                  type="button"
                  onClick={() => {
                    onSelectFreelancer(validAddress);
                    if (onClose) onClose();
                  }}
                  className="w-full gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-md font-semibold"
                >
                  <Check size={16} /> {selectButtonLabel || 'Select This Freelancer'}
                </Button>
              ) : (
                <Button asChild className="w-full gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-md">
                  <Link href={orderUrl}>
                    <ArrowRight size={16} /> Order This Freelancer
                  </Link>
                </Button>
              )}
            </CardContent>
          </Card>

          {/* PROFESSIONAL LINKS */}
          {hasLinks && (
            <Card className="border-zinc-800 bg-zinc-900/60 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold text-white flex items-center gap-2">
                  <Globe size={16} className="text-blue-400" /> Links
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                {links.website && (
                  <a
                    href={links.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-800/40 hover:bg-zinc-800/80 text-zinc-300 hover:text-white transition-colors border border-zinc-800/50"
                  >
                    <span className="flex items-center gap-2">
                      <Globe size={14} className="text-zinc-400" /> Website
                    </span>
                    <ExternalLink size={12} className="text-zinc-500" />
                  </a>
                )}
                {links.github && (
                  <a
                    href={links.github}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-800/40 hover:bg-zinc-800/80 text-zinc-300 hover:text-white transition-colors border border-zinc-800/50"
                  >
                    <span className="flex items-center gap-2">
                      <Code size={14} className="text-zinc-400" /> GitHub
                    </span>
                    <ExternalLink size={12} className="text-zinc-500" />
                  </a>
                )}
                {links.twitter && (
                  <a
                    href={links.twitter}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-800/40 hover:bg-zinc-800/80 text-zinc-300 hover:text-white transition-colors border border-zinc-800/50"
                  >
                    <span className="flex items-center gap-2">
                      <Share2 size={14} className="text-zinc-400" /> X / Twitter
                    </span>
                    <ExternalLink size={12} className="text-zinc-500" />
                  </a>
                )}
                {links.linkedin && (
                  <a
                    href={links.linkedin}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-800/40 hover:bg-zinc-800/80 text-zinc-300 hover:text-white transition-colors border border-zinc-800/50"
                  >
                    <span className="flex items-center gap-2">
                      <Briefcase size={14} className="text-zinc-400" /> LinkedIn
                    </span>
                    <ExternalLink size={12} className="text-zinc-500" />
                  </a>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
