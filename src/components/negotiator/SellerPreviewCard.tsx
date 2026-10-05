'use client';

import React from 'react';
import { Briefcase, Users, Star, CheckCircle2, Clock } from 'lucide-react';
import type { AiNegotiatorSellerResult } from '@/db/schema';
import { formatPublicPricing } from '@/lib/deals/pricing';

interface SellerPreviewCardProps {
  seller: AiNegotiatorSellerResult;
  synqHandle?: string;
  avatar?: string | null;
  completedDeals?: number;
  reviewCount?: number;
  onSelect?: (seller: AiNegotiatorSellerResult) => void;
}

function AvatarBadge({ name, avatar }: { name: string; avatar?: string | null }) {
  if (avatar && typeof avatar === 'string' && avatar.trim().length > 0) {
    return (
      <img
        src={avatar}
        alt={name}
        className="w-10 h-10 rounded-xl object-cover shrink-0 border border-zinc-700/60"
      />
    );
  }
  const initials = (name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const hues = [
    'from-blue-500 to-violet-600',
    'from-emerald-500 to-teal-600',
    'from-orange-500 to-red-600',
    'from-pink-500 to-rose-600',
  ];
  const hue = hues[(name.length + (name.charCodeAt(0) || 0)) % hues.length];
  return (
    <div
      className={`w-10 h-10 rounded-xl bg-gradient-to-br ${hue} flex items-center justify-center text-white font-bold text-xs shrink-0 shadow-xs`}
    >
      {initials || '?'}
    </div>
  );
}

export function SellerPreviewCard({
  seller,
  synqHandle,
  avatar,
  completedDeals,
  reviewCount = 0,
  onSelect,
}: SellerPreviewCardProps) {
  const wallet = seller.wallet;
  const name = seller.name || 'Anonymous Freelancer';
  const category = seller.category || 'Web3 Specialist';
  const skills: string[] = Array.isArray(seller.skills) ? seller.skills : [];
  const topSkills = skills.slice(0, 3);
  const extraSkills = skills.length - topSkills.length;
  
  const match = typeof seller.match === 'number' ? seller.match : undefined;
  const publicPricing = formatPublicPricing(seller.pricing);

  return (
    <div className="w-[280px] sm:w-[300px] rounded-xl border border-zinc-800 bg-zinc-900/95 p-4 shadow-2xl backdrop-blur-md space-y-3.5 text-zinc-200">
      {/* HEADER IDENTITY ROW */}
      <div className="flex items-start gap-3">
        <AvatarBadge name={name} avatar={avatar} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h4 className="text-sm font-bold text-white truncate leading-tight">
              {name}
            </h4>
            {match !== undefined && (
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30 font-medium">
                {match}% match
              </span>
            )}
          </div>
          {synqHandle ? (
            <p className="text-xs font-mono text-blue-400 mt-0.5 truncate">
              @{synqHandle}
            </p>
          ) : (
            <p className="text-[11px] font-mono text-zinc-500 mt-0.5 truncate">
              {wallet.slice(0, 6)}...{wallet.slice(-4)}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          {publicPricing ? (
            <>
              <div className="text-sm font-bold text-white leading-tight">
                {publicPricing.amountDisplay} <span className="text-[10px] text-zinc-400 font-semibold">USDC</span>
              </div>
              <div className="text-[10px] text-zinc-500">
                {publicPricing.typeLabel}
              </div>
            </>
          ) : (
            <div className="text-xs font-medium text-zinc-500 leading-tight">
              Rate not set
            </div>
          )}
        </div>
      </div>

      {/* CATEGORY & AVAILABILITY */}
      <div className="flex items-center justify-between text-xs text-zinc-400 pt-0.5 border-t border-zinc-800/60">
        <div className="flex items-center gap-1.5 text-zinc-300 font-medium truncate">
          <Briefcase size={13} className="text-blue-400 shrink-0" />
          <span className="truncate">{category}</span>
        </div>
        {seller.available !== undefined && (
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex items-center gap-1 shrink-0 ${
              seller.available
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                : 'bg-zinc-800 text-zinc-400 border border-zinc-700/50'
            }`}
          >
            {seller.available ? (
              <>
                <CheckCircle2 size={10} /> Available
              </>
            ) : (
              <>
                <Clock size={10} /> Busy
              </>
            )}
          </span>
        )}
      </div>

      {/* SKILLS CHIPS */}
      {skills.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {topSkills.map((s) => (
            <span
              key={s}
              className="px-2 py-0.5 rounded bg-zinc-800/80 text-[10px] text-zinc-300 border border-zinc-700/40"
            >
              {s}
            </span>
          ))}
          {extraSkills > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-zinc-800/40 text-[10px] text-zinc-400 border border-zinc-800">
              +{extraSkills}
            </span>
          )}
        </div>
      )}

      {/* FOOTER STATS */}
      <div className="flex items-center justify-between text-[11px] text-zinc-400 pt-1 border-t border-zinc-800/60">
        <span className="flex items-center gap-1">
          <Users size={12} className="text-blue-400 shrink-0" />
          {completedDeals === undefined
            ? '— deals'
            : `${completedDeals} ${completedDeals === 1 ? 'deal' : 'deals'}`}
        </span>
        <span className="flex items-center gap-1">
          <Star size={12} className="text-amber-400 fill-amber-400 shrink-0" />
          {reviewCount} {reviewCount === 1 ? 'Review' : 'Reviews'}
        </span>
      </div>

      {/* PRIMARY SELECTION ACTION */}
      {onSelect && (
        <div className="pt-2 border-t border-zinc-800/60">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSelect(seller);
            }}
            className="w-full py-1.5 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors shadow-sm cursor-pointer flex items-center justify-center gap-1.5"
          >
            Select Freelancer
          </button>
        </div>
      )}
    </div>
  );
}
