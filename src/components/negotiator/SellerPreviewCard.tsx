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
        className="w-10 h-10 rounded-xl object-cover shrink-0 border border-[#383838]"
      />
    );
  }
  const initials = (name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div
      className="w-10 h-10 rounded-xl bg-[#252525] border border-[#383838] flex items-center justify-center text-white font-bold text-xs shrink-0 shadow-xs"
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
    <div className="w-[280px] sm:w-[300px] rounded-xl border border-[#383838] bg-[#1B1B1B] p-4 shadow-2xl backdrop-blur-md space-y-3.5 text-white">
      {/* HEADER IDENTITY ROW */}
      <div className="flex items-start gap-3">
        <AvatarBadge name={name} avatar={avatar} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h4 className="text-sm font-bold text-white truncate leading-tight">
              {name}
            </h4>
            {match !== undefined && (
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-white/10 text-white border border-white/20 font-medium">
                {match}% match
              </span>
            )}
          </div>
          {synqHandle ? (
            <p className="text-xs font-mono text-[#A3A3A3] mt-0.5 truncate">
              @{synqHandle}
            </p>
          ) : (
            <p className="text-[11px] font-mono text-[#A3A3A3] mt-0.5 truncate">
              {wallet.slice(0, 6)}...{wallet.slice(-4)}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          {publicPricing ? (
            <>
              <div className="text-sm font-bold text-white leading-tight">
                {publicPricing.amountDisplay} <span className="text-[10px] text-[#A3A3A3] font-semibold">USDC</span>
              </div>
              <div className="text-[10px] text-[#737373]">
                {publicPricing.typeLabel}
              </div>
            </>
          ) : (
            <div className="text-xs font-medium text-[#737373] leading-tight">
              Rate not set
            </div>
          )}
        </div>
      </div>

      {/* CATEGORY & AVAILABILITY */}
      <div className="flex items-center justify-between text-xs text-[#A3A3A3] pt-0.5 border-t border-[#303030]">
        <div className="flex items-center gap-1.5 text-white font-medium truncate">
          <Briefcase size={13} className="text-white shrink-0" />
          <span className="truncate">{category}</span>
        </div>
        {seller.available !== undefined && (
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex items-center gap-1 shrink-0 ${
              seller.available
                ? 'bg-white/10 text-white border border-white/20'
                : 'bg-[#252525] text-[#A3A3A3] border border-[#383838]'
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
              className="px-2 py-0.5 rounded bg-[#252525] text-[10px] text-[#D4D4D4] border border-[#383838]"
            >
              {s}
            </span>
          ))}
          {extraSkills > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-[#202020] text-[10px] text-[#A3A3A3] border border-[#303030]">
              +{extraSkills}
            </span>
          )}
        </div>
      )}

      {/* FOOTER STATS */}
      <div className="flex items-center justify-between text-[11px] text-[#A3A3A3] pt-1 border-t border-[#303030]">
        <span className="flex items-center gap-1">
          <Users size={12} className="text-[#A3A3A3] shrink-0" />
          {completedDeals === undefined
            ? '— deals'
            : `${completedDeals} ${completedDeals === 1 ? 'deal' : 'deals'}`}
        </span>
        <span className="flex items-center gap-1">
          <Star size={12} className="text-white fill-white shrink-0" />
          {reviewCount} {reviewCount === 1 ? 'Review' : 'Reviews'}
        </span>
      </div>

      {/* PRIMARY SELECTION ACTION */}
      {onSelect && (
        <div className="pt-2 border-t border-[#303030]">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSelect(seller);
            }}
            className="w-full py-1.5 px-3 rounded-lg bg-white hover:bg-zinc-200 text-[#101010] font-semibold text-xs transition-colors shadow-sm cursor-pointer flex items-center justify-center gap-1.5"
          >
            Select Freelancer
          </button>
        </div>
      )}
    </div>
  );
}
