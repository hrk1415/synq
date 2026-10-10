'use client';

import React from 'react';
import { Handshake } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn, shortenAddress } from '@/lib/utils';
import type { NegotiationStateData } from '@/db/schema';

export const DRAFT_TEAR_Y_OFFSET = -1;

export const DRAFT_TEAR_POLYGON = (() => {
  const middleTeethCount = 16;
  const totalUnits = middleTeethCount * 2 + 2;
  const points: string[] = ['0% 0%', '0% 100%'];
  for (let u = 1; u < totalUnits; u++) {
    const x = ((u / totalUnits) * 100).toFixed(3);
    const y = u % 2 === 1 ? '0%' : '100%';
    points.push(`${x}% ${y}`);
  }
  points.push('100% 100%', '100% 0%');
  return `polygon(${points.join(', ')})`;
})();

export interface DraftIdentity {
  wallet?: string | null;
  name?: string | null;
  handle?: string | null;
  displayHandle?: string | null;
  avatar?: string | null;
}

interface DraftPanelProps {
  state: (NegotiationStateData & { cancellationReason?: string }) | null;
  clientIdentity?: DraftIdentity;
  freelancerIdentity?: DraftIdentity;
  onClose?: () => void;
  onEdit?: () => void;
  onProceed?: () => void;
  className?: string;
}

export function DraftPanel({
  state,
  clientIdentity,
  freelancerIdentity,
  onClose,
  onEdit,
  onProceed,
  className,
}: DraftPanelProps) {
  const draftStatus = state?.draftStatus || 'INACTIVE';
  const isActive = draftStatus === 'ACTIVE';
  const isReadyToCreate = Boolean(state?.isReadyToCreate);

  // Parse terms
  const titleVal = state?.title?.value || null;
  const amountVal = state?.amount?.value ? `${state.amount.value.amount} ${state.amount.value.asset}` : null;
  const scopeVal = state?.scope?.value || null;
  const deadlineVal = state?.deadline?.value?.raw || null;
  const payStructVal = state?.paymentStructure?.value || null;

  const getPaymentLabel = (val?: string | null) => {
    if (!val) return null;
    const v = val.toLowerCase();
    if (v === '50-50' || v === '50/50' || v === 'half') return '50/50 Milestones';
    if (v === 'single') return 'Single Release';
    if (v === 'custom') return 'Custom Milestones';
    return val;
  };

  const paymentText = getPaymentLabel(payStructVal);

  const clientWallet = clientIdentity?.wallet || '';
  const clientName = clientIdentity?.name || clientIdentity?.displayHandle || (clientWallet ? shortenAddress(clientWallet) : '');
  const clientHandle = clientIdentity?.handle ? `@${clientIdentity.handle.replace(/^@/, '')}` : null;

  const sellerWallet = freelancerIdentity?.wallet || state?.seller?.value || '';
  const sellerName = freelancerIdentity?.name || (state?.sellerName && !state.sellerName.startsWith('@') ? state.sellerName : '');
  const sellerHandle = freelancerIdentity?.handle
    ? `@${freelancerIdentity.handle.replace(/^@/, '')}`
    : freelancerIdentity?.displayHandle
    ? freelancerIdentity.displayHandle
    : state?.sellerName && state.sellerName.startsWith('@')
    ? state.sellerName
    : sellerWallet
    ? shortenAddress(sellerWallet)
    : '';

  // Button enablement rules:
  // INACTIVE: Edit = disabled, Proceed = disabled
  // ACTIVE + incomplete: Edit = enabled, Proceed = disabled
  // ACTIVE + complete: Edit = enabled, Proceed = enabled
  const canEdit = isActive;
  const canProceed = isActive && isReadyToCreate;

  return (
    <div
      className={cn(
        'relative w-[330px] sm:w-[340px] rounded-t-2xl rounded-b-none bg-zinc-900 border border-b-0 border-zinc-800/80 shadow-2xl p-5 pb-6 space-y-4 text-zinc-200 select-none backdrop-blur-md z-50 transition-all duration-200',
        className
      )}
    >
      {/* HEADER: STATUS BADGES & CENTERED RECEIPT TITLE */}
      <div className="flex items-center justify-between pb-1 border-b border-zinc-800/60">
        {/* COMPLETENESS BADGE */}
        {isReadyToCreate ? (
          <span className="px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-400 text-[9px] font-semibold tracking-wide uppercase">
            Complete
          </span>
        ) : (
          <span className="px-2 py-0.5 rounded-full bg-zinc-800/80 border border-zinc-700/60 text-zinc-400 text-[9px] font-medium tracking-wide uppercase">
            Incomplete
          </span>
        )}

        <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider text-center font-mono">
          DEAL RECEIPT
        </span>

        {/* LIFECYCLE STATUS BADGE */}
        {isActive ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/10 border border-green-500/30 text-green-400 text-[9px] font-bold tracking-wide uppercase">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            ACTIVE
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/30 text-red-400 text-[9px] font-bold tracking-wide uppercase">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
            INACTIVE
          </span>
        )}
      </div>

      {/* TITLE SECTION */}
      <div className="space-y-0.5">
        <span className="text-[10px] text-zinc-400 font-medium uppercase tracking-wider block">
          Title
        </span>
        {titleVal ? (
          <p className="font-semibold text-xs text-white truncate">{titleVal}</p>
        ) : (
          <div className="w-24 h-3 bg-zinc-800 rounded animate-pulse mt-1" />
        )}
      </div>

      {/* PARTY RELATIONSHIP SECTION (CLIENT ↔ HANDSHAKE ↔ FREELANCER) */}
      <div className="pt-3 border-t border-zinc-800/60 space-y-2">
        <div className="flex items-center justify-between text-[10px] text-zinc-400 font-medium uppercase tracking-wider pb-0.5">
          <span>Client</span>
          <span>Freelancer</span>
        </div>

        <div className="flex items-center justify-between gap-2 pt-0.5">
          {/* CLIENT (LEFT) */}
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            {clientIdentity?.avatar ? (
              <img
                src={clientIdentity.avatar}
                alt="Client Avatar"
                className="w-9 h-9 rounded-full object-cover shrink-0 border border-zinc-700/60"
              />
            ) : clientWallet ? (
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center text-white font-bold text-xs shrink-0 border border-zinc-700/60">
                {(clientName || clientWallet).slice(0, 2).toUpperCase()}
              </div>
            ) : (
              <div className="w-9 h-9 rounded-full bg-zinc-800/60 shrink-0 border border-zinc-800/80" />
            )}
            <div className="min-w-0 flex-1">
              {clientWallet ? (
                <>
                  <div className="font-bold text-white text-xs truncate">{clientName}</div>
                  {clientHandle && (
                    <div className="font-mono text-zinc-400 text-[10px] truncate">{clientHandle}</div>
                  )}
                </>
              ) : (
                <div className="text-xs text-zinc-500 italic truncate">Not connected</div>
              )}
            </div>
          </div>

          {/* HANDSHAKE ICON (CENTER) */}
          <div className="px-1 shrink-0 flex items-center justify-center text-blue-400">
            <Handshake size={16} />
          </div>

          {/* FREELANCER (RIGHT) */}
          {sellerWallet || sellerName ? (
            <div className="flex items-center justify-end gap-2.5 min-w-0 flex-1 text-right">
              <div className="min-w-0 flex-1">
                {sellerName && (
                  <div className="font-bold text-white text-xs truncate">{sellerName}</div>
                )}
                <div className="font-mono text-blue-400 text-[10px] truncate">{sellerHandle}</div>
              </div>
              {freelancerIdentity?.avatar ? (
                <img
                  src={freelancerIdentity.avatar}
                  alt="Freelancer Avatar"
                  className="w-9 h-9 rounded-full object-cover shrink-0 border border-zinc-700/60"
                />
              ) : (
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center text-white font-bold text-xs shrink-0 border border-zinc-700/60">
                  {(sellerName || sellerHandle || sellerWallet || 'FL').slice(0, 2).toUpperCase()}
                </div>
              )}
            </div>
          ) : (
            /* SKELETON BEFORE SELECTION */
            <div className="flex items-center justify-end gap-2.5 min-w-0 flex-1 text-right">
              <div className="min-w-0 flex-1 flex flex-col items-end gap-1">
                <div className="w-14 h-3 bg-zinc-800 rounded animate-pulse" />
                <div className="w-10 h-2 bg-zinc-800/60 rounded animate-pulse" />
              </div>
              <div className="w-9 h-9 rounded-full bg-zinc-800/80 shrink-0 border border-zinc-800 animate-pulse" />
            </div>
          )}
        </div>
      </div>

      {/* PROGRESSIVELY POPULATED SUMMARY FIELDS */}
      <div className="pt-3 border-t border-zinc-800/60 text-xs space-y-2.5">
        {/* BUDGET */}
        <div className="flex items-center justify-between">
          <span className="text-zinc-400">Budget</span>
          {amountVal ? (
            <span className="font-semibold text-white font-mono">{amountVal}</span>
          ) : (
            <div className="w-16 h-3 bg-zinc-800 rounded animate-pulse" />
          )}
        </div>

        {/* SCOPE */}
        <div className="flex items-center justify-between">
          <span className="text-zinc-400">Scope</span>
          {scopeVal ? (
            <div className="relative group inline-block text-right">
              <span className="font-medium text-white truncate max-w-[140px] inline-block border-b border-dashed border-zinc-700 hover:border-zinc-400 transition-colors cursor-help">
                {scopeVal.length > 22 ? `${scopeVal.slice(0, 22)}...` : scopeVal}
              </span>
              {scopeVal.length > 22 && (
                <div className="absolute right-0 bottom-full mb-2 hidden group-hover:block group-focus:block z-50 w-64 p-3 rounded-xl bg-zinc-900 border border-zinc-700 text-xs text-zinc-200 shadow-2xl backdrop-blur-md whitespace-pre-wrap leading-relaxed text-left pointer-events-none">
                  <div className="font-semibold text-blue-400 mb-1 text-[10px] uppercase tracking-wider">
                    Full Scope / Deliverables
                  </div>
                  {scopeVal}
                </div>
              )}
            </div>
          ) : (
            <div className="w-24 h-3 bg-zinc-800 rounded animate-pulse" />
          )}
        </div>

        {/* DEADLINE */}
        <div className="flex items-center justify-between">
          <span className="text-zinc-400">Deadline</span>
          {deadlineVal ? (
            <span className="font-medium text-white">{deadlineVal}</span>
          ) : (
            <div className="w-20 h-3 bg-zinc-800 rounded animate-pulse" />
          )}
        </div>

        {/* PAYMENT */}
        <div className="flex items-center justify-between">
          <span className="text-zinc-400">Payment</span>
          {paymentText ? (
            <span className="font-medium text-white">{paymentText}</span>
          ) : (
            <div className="w-24 h-3 bg-zinc-800 rounded animate-pulse" />
          )}
        </div>

        {/* PROTECTION */}
        <div className="flex items-center justify-between">
          <span className="text-zinc-400">Protection</span>
          <span className="text-zinc-500 font-mono">None</span>
        </div>
      </div>

      {/* FOOTER ACTIONS */}
      <div className="pt-3 border-t border-zinc-800 flex items-center justify-between gap-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canEdit}
          onClick={(e) => {
            e.preventDefault();
            if (canEdit && onEdit) {
              if (onClose) onClose();
              onEdit();
            }
          }}
          className={cn(
            'flex-1 font-semibold text-xs py-2 rounded-xl transition-all',
            canEdit
              ? 'border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 hover:text-white'
              : 'border-zinc-800/60 bg-zinc-800/30 text-zinc-600 cursor-not-allowed'
          )}
        >
          Edit
        </Button>

        <Button
          type="button"
          size="sm"
          disabled={!canProceed}
          onClick={(e) => {
            e.preventDefault();
            if (canProceed && onProceed) {
              if (onClose) onClose();
              onProceed();
            }
          }}
          className={cn(
            'flex-1 font-semibold text-xs py-2 rounded-xl transition-all',
            canProceed
              ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-md'
              : 'border-zinc-800/60 bg-zinc-800/30 text-zinc-600 cursor-not-allowed'
          )}
        >
          Proceed
        </Button>
      </div>

      {/* DECORATIVE RECEIPT BOTTOM TEAR ZIGZAG EDGE */}
      <div
        aria-hidden="true"
        className="absolute left-0 right-0 h-[9px] pointer-events-none bg-zinc-900"
        style={{
          top: `calc(100% + ${DRAFT_TEAR_Y_OFFSET}px)`,
          clipPath: DRAFT_TEAR_POLYGON,
        }}
      />
    </div>
  );
}
