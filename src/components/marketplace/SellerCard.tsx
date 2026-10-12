'use client';

import { useState, useEffect } from 'react';
import { Briefcase, Users, Star, ArrowRight, MessageSquare, Pencil } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAccount } from 'wagmi';
import { formatPublicPricing, FreelancerPricing } from '@/lib/deals/pricing';
import { cn } from '@/lib/utils';

function Avatar({ name, avatar }: { name: string; avatar?: string | null }) {
  if (avatar && typeof avatar === 'string' && avatar.trim().length > 0) {
    return (
      <img
        src={avatar}
        alt={name}
        className="w-12 h-12 rounded-xl object-cover shrink-0"
      />
    );
  }
  const initials = (name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const hues = ['from-blue-500 to-violet-600', 'from-emerald-500 to-teal-600', 'from-orange-500 to-red-600', 'from-pink-500 to-rose-600'];
  const hue = hues[(name.length + name.charCodeAt(0)) % hues.length];
  return (
    <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${hue} flex items-center justify-center text-white font-bold text-sm shrink-0`}>
      {initials || '?'}
    </div>
  );
}

export function SellerCard({
  profile,
  me,
  isConnected,
  onOrder,
  onOpenProfile,
  avatar,
  synqHandle,
  reviewCount = 0,
  completedDeals,
  onEdit,
  matchPercentage,
  actionLabel,
  prominentMatch = false,
  pricing,
  showMessageAction = true,
  compactAiVariant = false,
}: {
  profile: any;
  me?: string;
  isConnected: boolean;
  onOrder: (p: any) => void;
  onOpenProfile?: (wallet: string) => void;
  avatar?: string | null;
  synqHandle?: string;
  reviewCount?: number;
  completedDeals?: number | undefined;
  onEdit?: () => void;
  matchPercentage?: number;
  actionLabel?: string;
  prominentMatch?: boolean;
  pricing?: FreelancerPricing | null;
  showMessageAction?: boolean;
  compactAiVariant?: boolean;
}) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const { address: connectedAddress } = useAccount();

  const wallet = String(profile.wallet);
  const currentWallet = mounted ? (me || connectedAddress) : undefined;
  const isMe = !!currentWallet && wallet.toLowerCase() === currentWallet.toLowerCase();
  const effectiveMatch = matchPercentage ?? (typeof profile.match === 'number' ? profile.match : undefined);

  // Modern Public Pricing: Read from explicit prop, profile.pricing, or profile.startingRateAmount
  const rawPricing =
    pricing ||
    profile.pricing ||
    (profile.startingRateAmount && profile.startingRateType
      ? {
          amount: String(profile.startingRateAmount),
          currency: 'USDC' as const,
          rateType: profile.startingRateType,
        }
      : null);
  const publicPricing = formatPublicPricing(rawPricing);

  const skills: string[] = Array.isArray(profile.skills) ? profile.skills : [];
  const maxSkills = compactAiVariant ? 2 : 3;
  const topSkills = skills.slice(0, maxSkills);
  const extraSkillsCount = skills.length - topSkills.length;

  const handleCardClick = () => {
    if (onOpenProfile) {
      onOpenProfile(wallet);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleCardClick();
    }
  };

  return (
    <Card
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={handleKeyDown}
      className="group relative rounded-2xl border border-white/50 hover:border-white/80 focus:border-white/80 bg-[#1C1C1C] hover:bg-[#202020] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.14),0_6px_20px_rgba(0,0,0,0.45)] hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.24),0_14px_30px_rgba(0,0,0,0.65)] hover:-translate-y-[3px] focus-visible:-translate-y-[3px] focus:outline-none focus:ring-1 focus:ring-white/50 transition-all duration-200 ease-out cursor-pointer h-full"
    >
      <CardContent className="p-5 flex flex-col h-full">
        {/* TOP IDENTITY ROW */}
        <div className="flex items-start gap-3 mb-3">
          <Avatar name={String(profile.name || '')} avatar={avatar} />
          <div className="flex-1 min-w-0">
            {/* Line 1: Provider Name + Badges */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <h3 className="text-base font-bold text-white group-hover:text-white transition-colors truncate">
                {String(profile.name || 'Anonymous')}
              </h3>
              {effectiveMatch !== undefined && !prominentMatch && (
                <Badge variant="info" className="text-[10px] px-1.5 py-0 bg-white/10 text-white border-white/20">
                  {effectiveMatch}% match
                </Badge>
              )}
              {isMe && <Badge variant="info" className="text-[10px] px-1.5 py-0 bg-white/10 text-white border-white/20">You</Badge>}
              {!profile.available && <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-[#252525] text-zinc-400 border-[#383838]">Busy</Badge>}
            </div>
            {/* Line 2: Synq Handle directly UNDER provider name */}
            {synqHandle ? (
              <div className="text-xs font-mono text-[#A3A3A3] mt-0.5 truncate">
                @{synqHandle}
              </div>
            ) : (
              <div className="h-0" />
            )}
          </div>
          <div className="text-right shrink-0">
            {prominentMatch && effectiveMatch !== undefined && (
              <div className="text-right leading-none mb-1.5">
                <div className="text-2xl sm:text-3xl font-black text-emerald-400 font-mono tracking-tight">
                  {effectiveMatch}%
                </div>
                <div className="text-[9px] uppercase tracking-wider text-zinc-500 font-bold mt-0.5">
                  MATCH
                </div>
              </div>
            )}
            {!compactAiVariant && (
              publicPricing ? (
                <div className="text-right">
                  <div className="text-lg sm:text-xl font-bold text-white tracking-tight">
                    ${publicPricing.amountDisplay}
                  </div>
                  <div className="text-[10px] text-zinc-400 font-medium">
                    {publicPricing.typeLabel}
                  </div>
                </div>
              ) : (
                <div className="text-xs font-medium text-zinc-500 py-1">Rate not set</div>
              )
            )}
          </div>
        </div>

        {compactAiVariant ? (
          /* COMPACT AI VARIANT: profession/category + skills (left) & Rate/Skeleton (right) */
          <div className="flex items-start justify-between gap-3 mb-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-300 mb-2">
                <Briefcase size={14} className="text-[#A3A3A3] shrink-0" />
                <span className="truncate">{String(profile.category || '-')}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {topSkills.map((s: string) => (
                  <span key={s} className="px-2 py-0.5 rounded-md bg-[#252525] text-[10px] text-zinc-300 border border-[#383838]">
                    {s}
                  </span>
                ))}
                {extraSkillsCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded-md bg-[#222222] text-[10px] text-[#A3A3A3] border border-[#303030] font-mono">
                    +{extraSkillsCount}
                  </span>
                )}
              </div>
            </div>

            <div className="text-right shrink-0 pt-0.5">
              {publicPricing ? (
                <div>
                  <div className="text-lg sm:text-xl font-bold text-white tracking-tight leading-tight">
                    ${publicPricing.amountDisplay}
                  </div>
                  <div className="text-[10px] text-[#A3A3A3] font-medium mt-0.5">
                    {publicPricing.typeLabel}
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5 flex flex-col items-end py-1">
                  <div className="w-16 h-4.5 rounded bg-zinc-800/80 animate-pulse" />
                  <div className="w-12 h-3 rounded bg-zinc-800/60 animate-pulse" />
                </div>
              )}
            </div>
          </div>
        ) : (
          /* STANDARD / DEAL PORT VARIANT */
          <>
            {/* PRIMARY PROFESSION / CATEGORY */}
            <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-300 mb-3">
              <Briefcase size={14} className="text-[#A3A3A3] shrink-0" />
              <span className="truncate">{String(profile.category || '-')}</span>
            </div>

            {/* SKILLS CHIPS */}
            <div className="flex flex-wrap gap-1.5 mb-4">
              {topSkills.map((s: string) => (
                <span key={s} className="px-2 py-0.5 rounded-md bg-[#252525] text-[10px] text-zinc-300 border border-[#383838]">
                  {s}
                </span>
              ))}
              {extraSkillsCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-md bg-[#222222] text-[10px] text-[#A3A3A3] border border-[#303030]">
                  +{extraSkillsCount}
                </span>
              )}
            </div>
          </>
        )}

        {/* FOOTER SIGNAL: Completed Deals & Review Count */}
        <div className="flex items-center gap-4 text-xs text-[#A3A3A3] mt-auto mb-4 font-medium">
          <span className="flex items-center gap-1">
            <Users size={12} className="text-[#A3A3A3]" />
            {completedDeals === undefined
              ? '— deals completed'
              : `${completedDeals} ${completedDeals === 1 ? 'deal completed' : 'deals completed'}`}
          </span>
          <span className="flex items-center gap-1">
            <Star size={12} className="text-amber-400 fill-amber-400" />
            {reviewCount} {reviewCount === 1 ? 'Review' : 'Reviews'}
          </span>
        </div>

        {/* ACTIONS: Order/Edit Button + Message Icon */}
        <div className="flex items-center gap-2 pt-1">
          {isMe ? (
            onEdit ? (
              <Button
                type="button"
                variant="outline"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
                className="flex-1 gap-2 border-[#383838] bg-[#222222] hover:bg-[#2a2a2a] hover:border-zinc-500 text-white"
              >
                <Pencil size={14} /> Edit Profile
              </Button>
            ) : (
              <Button
                asChild
                variant="outline"
                onClick={(e) => e.stopPropagation()}
                className={cn(showMessageAction ? 'flex-1' : 'w-full', 'gap-2 border-[#383838] bg-[#222222] hover:bg-[#2a2a2a] hover:border-zinc-500 text-white')}
              >
                <Link href="/profile?edit=true">
                  <Pencil size={14} /> Edit Profile
                </Link>
              </Button>
            )
          ) : (
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onOrder(profile);
              }}
              className={cn(
                showMessageAction ? 'flex-1' : 'w-full',
                'gap-2 bg-white hover:bg-zinc-200 text-[#101010] text-xs font-semibold shadow-sm transition-all'
              )}
            >
              <ArrowRight size={14} className="text-[#101010]" /> {actionLabel || 'Order This Freelancer'}
            </Button>
          )}

          {/* Message Icon Button */}
          {showMessageAction && (
            isMe ? (
              <button
                type="button"
                disabled
                aria-disabled="true"
                title="You cannot message yourself"
                aria-label="Cannot message yourself"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                }}
                className="p-2.5 rounded-xl border border-[#383838] bg-[#222222] text-zinc-600 cursor-not-allowed opacity-40 shrink-0"
              >
                <MessageSquare size={16} />
              </button>
            ) : (
              <button
                type="button"
                title={`Message ${String(profile.name || 'freelancer')}`}
                aria-label={`Message ${String(profile.name || 'freelancer')}`}
                onClick={(e) => {
                  e.stopPropagation();
                  const params = new URLSearchParams({ to: wallet });
                  if (profile.name) params.set('name', String(profile.name));
                  router.push(`/messages?${params.toString()}`);
                }}
                className="p-2.5 rounded-xl border border-[#383838] bg-[#222222] hover:bg-[#2a2a2a] hover:border-zinc-500 text-zinc-300 hover:text-white transition-colors shrink-0"
              >
                <MessageSquare size={16} />
              </button>
            )
          )}
        </div>
      </CardContent>
    </Card>
  );
}
