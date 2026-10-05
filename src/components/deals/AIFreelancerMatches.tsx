'use client';

import { useState, useMemo } from 'react';
import { Sparkles, ChevronDown, ChevronUp } from 'lucide-react';
import { SellerCard } from '@/components/marketplace/SellerCard';
import { ProviderProfileModal } from '@/components/marketplace/ProviderProfileModal';
import { cn } from '@/lib/utils';
import type { FreelancerPricing } from '@/lib/deals/pricing';

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);
}

export interface DraftContext {
  title?: string;
  budget?: string;
  deliverables?: string;
  paymentStructure?: string;
  milestones?: Array<{ title: string; description: string; amountUsdc?: string }>;
}

export function calculateFreelancerMatch({
  profile,
  draftContext,
  completedDeals = 0,
}: {
  profile: any;
  draftContext: DraftContext;
  completedDeals?: number;
}): number {
  const title = (draftContext.title || '').trim();
  const deliverables = (draftContext.deliverables || '').trim();
  const budget = (draftContext.budget || '').trim();
  const milestones = draftContext.milestones || [];

  const titleLower = title.toLowerCase();
  const titleTokens = tokenize(title);
  const scopeTokens = tokenize(deliverables).slice(0, 10);
  const milestoneTokens = tokenize(
    milestones.map((m) => `${m.title} ${m.description}`).join(' ')
  ).slice(0, 8);

  let rawScore = 0;
  const cat = String(profile?.category || '').toLowerCase();
  const skills = (profile?.skills || []).map((s: string) => String(s).toLowerCase());
  const bio = String(profile?.bio || '').toLowerCase();
  const name = String(profile?.name || '').toLowerCase();
  const haystack = [name, bio, ...skills].join(' ');

  // 1. Title matching (from Step 1)
  if (titleLower && titleLower !== 'other') {
    if (cat === titleLower) rawScore += 32;
    else if (cat && (cat.includes(titleLower) || titleLower.includes(cat))) rawScore += 20;

    for (const t of titleTokens) {
      if (skills.some((s: string) => s.includes(t) || t.includes(s))) rawScore += 12;
      else if (haystack.includes(t)) rawScore += 6;
    }
  }

  // 2. Deliverables / Scope matching (if user has entered scope)
  if (scopeTokens.length > 0) {
    for (const t of scopeTokens) {
      if (skills.some((s: string) => s.includes(t) || t.includes(s))) rawScore += 8;
      else if (haystack.includes(t)) rawScore += 4;
    }
  }

  // 3. Milestones matching (if user has configured milestones)
  if (milestoneTokens.length > 0) {
    for (const t of milestoneTokens) {
      if (skills.some((s: string) => s.includes(t) || t.includes(s))) rawScore += 6;
      else if (haystack.includes(t)) rawScore += 3;
    }
  }

  // 4. Budget signal (if user has entered a valid budget)
  if (budget && Number(budget) > 0) {
    rawScore += 5;
  }

  // 5. Availability signal
  if (profile?.available !== false) {
    rawScore += 8;
  }

  // 6. Completed deals track record
  rawScore += Math.min(completedDeals * 3, 15);

  // Deterministic percentage mapping
  const baseConfidence = 20;
  const totalPoints = baseConfidence + rawScore;
  return Math.min(99, Math.max(68, Math.round(50 + (totalPoints / 120) * 48)));
}

export interface AIFreelancerMatchesProps {
  draftContext: DraftContext;
  availableProfiles: any[];
  avatarsMap: Record<string, string>;
  namesMap: Record<string, string>;
  sellerIdentities: Record<string, any>;
  completedCountsMap: Record<string, number | undefined>;
  reviewCountsMap?: Record<string, number>;
  pricingMap?: Record<string, FreelancerPricing | null>;
  clientAddress?: string;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onSelectFreelancer: (wallet: string) => void;
  selectedWallet?: string;
  anchoredGrowth?: boolean;
}

export function AIFreelancerMatches({
  draftContext,
  availableProfiles,
  avatarsMap,
  namesMap,
  sellerIdentities,
  completedCountsMap,
  reviewCountsMap,
  pricingMap,
  clientAddress,
  isExpanded,
  onToggleExpand,
  onSelectFreelancer,
  selectedWallet,
  anchoredGrowth = false,
}: AIFreelancerMatchesProps) {
  const [inspectingWallet, setInspectingWallet] = useState<string | null>(null);

  // Deterministic matching based strictly on user-entered draft context
  const topRecommendations = useMemo(() => {
    if (!availableProfiles || availableProfiles.length === 0) return [];

    const scored = availableProfiles.map((p: any) => {
      const walletKey = String(p.wallet || '').toLowerCase();
      const completedDeals = completedCountsMap[walletKey] ?? Number(p.completedDeals || 0);
      const matchPercentage = calculateFreelancerMatch({
        profile: p,
        draftContext,
        completedDeals,
      });

      return {
        p,
        rawScore: matchPercentage,
        matchPercentage,
        completedDeals,
      };
    });

    // Sort descending by score, take exactly TWO
    return scored.sort((a, b) => b.rawScore - a.rawScore).slice(0, 2);
  }, [
    availableProfiles,
    draftContext,
    completedCountsMap,
  ]);

  return (
    <>
      <div
        className={cn(
          'rounded-2xl border border-zinc-800/80 bg-zinc-900/60 shadow-xl transition-all',
          anchoredGrowth
            ? isExpanded
              ? 'lg:rounded-b-none relative'
              : 'relative'
            : 'overflow-hidden'
        )}
      >
        {/* COLLAPSED / EXPANDABLE HEADER (MODERATELY THICKER) */}
        <button
          type="button"
          onClick={onToggleExpand}
          className="w-full px-6 py-4.5 sm:py-5 flex items-center justify-between text-left hover:bg-zinc-800/30 transition-colors"
          aria-expanded={isExpanded}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-blue-500/15 border border-blue-500/30 flex items-center justify-center text-blue-400 shrink-0">
              <Sparkles size={16} />
            </div>
            <span className="text-sm sm:text-base font-semibold text-white truncate">
              AI Freelancer Matches
            </span>
            {topRecommendations.length > 0 && !isExpanded && (
              <span className="text-xs text-emerald-400 font-mono font-medium hidden sm:inline shrink-0">
                ({topRecommendations[0].matchPercentage}% top match)
              </span>
            )}
          </div>
          <div className="text-zinc-400 hover:text-white transition-colors shrink-0 ml-3">
            {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
          </div>
        </button>

        {/* EXPANDED CONTENT (ONLY TWO RECOMMENDATIONS) */}
        {isExpanded && (
          <div
            className={cn(
              'px-6 pb-6 pt-1 space-y-4 border-t border-zinc-800/50',
              anchoredGrowth &&
                'lg:absolute lg:top-full lg:left-[-1px] lg:right-[-1px] lg:z-30 lg:bg-zinc-900/98 lg:border lg:border-t-0 lg:border-zinc-800/80 lg:rounded-b-2xl lg:shadow-2xl'
            )}
          >
            <div className="flex items-center justify-between text-xs pt-1">
              <span className="text-zinc-400 font-medium">Based on your deal so far</span>
              <span className="text-[11px] text-zinc-500 hidden sm:inline">
                Click card to inspect profile • Click Select to choose
              </span>
            </div>

            {topRecommendations.length === 0 ? (
              <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-950/40 text-center text-xs text-zinc-500">
                No registered freelancers available to match at this time.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {topRecommendations.map(({ p, matchPercentage, completedDeals }) => {
                  const walletLower = String(p.wallet).toLowerCase();
                  const idInfo = sellerIdentities[walletLower];
                  const handle =
                    idInfo?.handle ||
                    idInfo?.displayHandle?.replace(/^@/, '') ||
                    (namesMap[walletLower] ? namesMap[walletLower].toLowerCase().replace(/\s+/g, '') : undefined);

                  return (
                    <div key={String(p.wallet)} className="h-full">
                      <SellerCard
                        profile={p}
                        me={clientAddress}
                        isConnected={true}
                        onOrder={(profile) => onSelectFreelancer(String(profile.wallet))}
                        onOpenProfile={(wallet) => setInspectingWallet(wallet)}
                        avatar={avatarsMap[walletLower]}
                        synqHandle={handle}
                        pricing={pricingMap?.[walletLower]}
                        reviewCount={reviewCountsMap?.[walletLower] ?? 0}
                        completedDeals={completedDeals}
                        matchPercentage={matchPercentage}
                        prominentMatch={true}
                        actionLabel="Select"
                        showMessageAction={false}
                        compactAiVariant={true}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* FULL FREELANCER PROFILE MODAL (REUSED FROM DEAL PORT) */}
      <ProviderProfileModal
        wallet={inspectingWallet}
        onClose={() => setInspectingWallet(null)}
        onSelectFreelancer={(selected) => {
          onSelectFreelancer(selected);
          setInspectingWallet(null);
        }}
        selectButtonLabel="Select This Freelancer"
      />
    </>
  );
}
