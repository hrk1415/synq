'use client';

import { Briefcase, Users, Star, ArrowRight, MessageSquare, Pencil } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatUnits } from 'viem';
import Link from 'next/link';

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
}) {
  const wallet = String(profile.wallet);
  const isMe = !!me && wallet.toLowerCase() === me.toLowerCase();
  const effectiveMatch = matchPercentage ?? (typeof profile.match === 'number' ? profile.match : undefined);
  const rate = Number(formatUnits(BigInt(profile.rate || 0), 18));
  const skills: string[] = Array.isArray(profile.skills) ? profile.skills : [];
  const topSkills = skills.slice(0, 3);
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
      className="group hover:border-blue-500/40 transition-all cursor-pointer h-full focus:outline-none focus:ring-1 focus:ring-blue-500/50 border-zinc-800 bg-zinc-900/70"
    >
      <CardContent className="p-5 flex flex-col h-full">
        {/* TOP IDENTITY ROW */}
        <div className="flex items-start gap-3 mb-3">
          <Avatar name={String(profile.name || '')} avatar={avatar} />
          <div className="flex-1 min-w-0">
            {/* Line 1: Provider Name + Badges */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <h3 className="text-base font-bold text-white group-hover:text-blue-400 transition-colors truncate">
                {String(profile.name || 'Anonymous')}
              </h3>
              {effectiveMatch !== undefined && (
                <Badge variant="info" className="text-[10px] px-1.5 py-0 bg-blue-500/20 text-blue-400 border-blue-500/30">
                  {effectiveMatch}% match
                </Badge>
              )}
              {isMe && <Badge variant="info" className="text-[10px] px-1.5 py-0">You</Badge>}
              {!profile.available && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Busy</Badge>}
            </div>
            {/* Line 2: Synq Handle directly UNDER provider name */}
            {synqHandle ? (
              <div className="text-xs font-mono text-blue-400 mt-0.5 truncate">
                @{synqHandle}
              </div>
            ) : (
              <div className="h-0" />
            )}
          </div>
          <div className="text-right shrink-0">
            <div className="text-sm font-bold text-white">{rate} <span className="text-xs text-zinc-400 font-normal">ETH</span></div>
            <div className="text-[10px] text-zinc-500">rate/project</div>
          </div>
        </div>

        {/* PRIMARY PROFESSION / CATEGORY */}
        <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-300 mb-3">
          <Briefcase size={14} className="text-blue-400 shrink-0" />
          <span className="truncate">{String(profile.category || '-')}</span>
        </div>

        {/* SKILLS CHIPS */}
        <div className="flex flex-wrap gap-1.5 mb-4">
          {topSkills.map((s: string) => (
            <span key={s} className="px-2 py-0.5 rounded-md bg-zinc-800/80 text-[10px] text-zinc-300 border border-zinc-700/40">
              {s}
            </span>
          ))}
          {extraSkillsCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-md bg-zinc-800/40 text-[10px] text-zinc-400 border border-zinc-800">
              +{extraSkillsCount}
            </span>
          )}
        </div>

        {/* FOOTER SIGNAL: Completed Deals & Review Count */}
        <div className="flex items-center gap-4 text-xs text-zinc-400 mt-auto mb-4 font-medium">
          <span className="flex items-center gap-1">
            <Users size={12} className="text-blue-400" />
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
                className="flex-1 gap-2 border-zinc-700 hover:bg-zinc-800 text-white"
              >
                <Pencil size={14} /> Edit Profile
              </Button>
            ) : (
              <Button
                asChild
                variant="outline"
                onClick={(e) => e.stopPropagation()}
                className="flex-1 gap-2 border-zinc-700 hover:bg-zinc-800 text-white"
              >
                <Link href="/settings">
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
              className="flex-1 gap-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold"
            >
              <ArrowRight size={14} /> Order This Freelancer
            </Button>
          )}

          {/* Safe Message Icon Affordance (Non-writing, preparative UI) */}
          <button
            type="button"
            disabled
            title="Messaging coming soon"
            aria-label="Messaging coming soon"
            onClick={(e) => e.stopPropagation()}
            className="p-2.5 rounded-xl border border-zinc-800 bg-zinc-800/40 text-zinc-500 cursor-not-allowed opacity-70 hover:opacity-70 shrink-0"
          >
            <MessageSquare size={16} />
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
