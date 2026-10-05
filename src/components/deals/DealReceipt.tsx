'use client';

import React from 'react';
import { Handshake } from 'lucide-react';
import { cn, shortenAddress } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

export const RECEIPT_TEAR_Y_OFFSET = -1;

export const RECEIPT_TEAR_POLYGON = (() => {
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

export interface DealReceiptField<T = string> {
  value?: T | null;
  status?: 'CONFIRMED' | 'PROPOSED' | 'MISSING';
  raw?: string | null;
}

export interface DealReceiptParty {
  wallet?: string | null;
  name?: string | null;
  handle?: string | null;
  displayHandle?: string | null;
  avatar?: string | null;
}

export interface DealReceiptAsset {
  symbol: string;
  isErc20?: boolean;
}

export interface DealReceiptProps {
  variant?: 'compact' | 'expanded' | 'chat';
  title?: string | DealReceiptField<string>;
  client?: DealReceiptParty;
  freelancer?: DealReceiptParty;
  budget?: string | number | DealReceiptField<string | number>;
  asset?: string | DealReceiptAsset;
  scope?: string | DealReceiptField<string>;
  deadline?: string | number | DealReceiptField<string | number>;
  paymentStructure?: string | DealReceiptField<string>;
  protectionEnabled?: boolean | null;
  statusBadge?: string;
  actions?: React.ReactNode;
  className?: string;
}

function parseField<T = string>(field: any): { value: T | null; status: 'CONFIRMED' | 'PROPOSED' | 'MISSING'; raw?: string | null } {
  if (field === null || field === undefined) {
    return { value: null, status: 'MISSING' };
  }
  if (typeof field === 'object' && !Array.isArray(field) && ('value' in field || 'status' in field || 'raw' in field)) {
    const status = field.status || (field.value !== null && field.value !== undefined ? 'CONFIRMED' : 'MISSING');
    return {
      value: field.value ?? null,
      status,
      raw: field.raw || (typeof field.value === 'object' ? field.value?.raw : null),
    };
  }
  return { value: field as T, status: 'CONFIRMED' };
}

export function DealReceipt({
  variant = 'compact',
  title,
  client,
  freelancer,
  budget,
  asset,
  scope,
  deadline,
  paymentStructure,
  protectionEnabled,
  statusBadge,
  actions,
  className,
}: DealReceiptProps) {
  const isExpanded = variant === 'expanded';
  const isChat = variant === 'chat';

  const titleParsed = parseField<string>(title);
  const budgetParsed = parseField<string | number>(budget);
  const scopeParsed = parseField<string>(scope);
  const deadlineParsed = parseField<string | number>(deadline);
  const paymentParsed = parseField<string>(paymentStructure);

  const clientWallet = client?.wallet ? String(client.wallet) : '';
  const freelancerWallet = freelancer?.wallet ? String(freelancer.wallet) : '';

  // Asset formatting
  let assetSymbol = 'ETH';
  let isErc20 = false;
  if (typeof asset === 'string') {
    assetSymbol = asset;
    isErc20 = asset.toUpperCase() !== 'ETH';
  } else if (asset && typeof asset === 'object') {
    assetSymbol = asset.symbol || 'ETH';
    isErc20 = !!asset.isErc20;
  }

  // Scope text extraction
  const scopeText = typeof scopeParsed.value === 'string'
    ? scopeParsed.value.trim()
    : scopeParsed.raw
    ? scopeParsed.raw.trim()
    : '';
  const scopePreviewLimit = isChat ? 28 : 22;

  // Deadline formatting
  let deadlineText = '';
  if (deadlineParsed.value !== null && deadlineParsed.value !== undefined) {
    const num = Number(deadlineParsed.value);
    if (!isNaN(num) && num > 0) {
      const d = new Date(num > 1e11 ? num : num * 1000);
      deadlineText = d.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: isExpanded ? 'numeric' : undefined,
      });
      if (isExpanded) {
        deadlineText += ` · ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      }
    } else if (typeof deadlineParsed.value === 'string') {
      const parsedDate = new Date(deadlineParsed.value);
      if (!isNaN(parsedDate.getTime())) {
        deadlineText = parsedDate.toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: isExpanded ? 'numeric' : undefined,
        });
        if (isExpanded) {
          deadlineText += ` · ${parsedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        }
      } else {
        deadlineText = deadlineParsed.value;
      }
    }
  }
  if (!deadlineText && deadlineParsed.raw) {
    deadlineText = deadlineParsed.raw;
  }

  // Payment structure text
  let paymentText = '';
  if (paymentParsed.value) {
    const val = String(paymentParsed.value).toLowerCase();
    if (val === '50-50' || val === '50/50' || val === 'half') paymentText = '50/50 Milestones';
    else if (val === 'custom') paymentText = 'Custom Stages';
    else if (val === 'single') paymentText = 'Single Release';
    else paymentText = String(paymentParsed.value);
  }

  return (
    <div
      className={cn(
        'relative w-full rounded-t-2xl rounded-b-none bg-zinc-900 border border-b-0 border-zinc-800/80 shadow-2xl transition-all duration-300',
        isExpanded
          ? 'max-w-2xl mx-auto p-8 pb-9 space-y-6'
          : isChat
            ? 'p-3.5 pb-4 space-y-3'
            : 'p-6 pb-7 space-y-5',
        className
      )}
    >
      {/* HEADER */}
      <div className="flex items-center justify-between pb-0.5">
        <span
          className={cn(
            'uppercase tracking-wider block text-center flex-1',
            isExpanded ? 'text-xs font-bold text-zinc-400' : 'text-[10px] font-semibold text-zinc-500'
          )}
        >
          DEAL RECEIPT
        </span>
        {statusBadge && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-zinc-700 text-zinc-400 shrink-0">
            {statusBadge}
          </Badge>
        )}
      </div>

      <div className={isExpanded ? 'space-y-5' : isChat ? 'space-y-2.5' : 'space-y-4'}>
        {/* TITLE SECTION */}
        <div className="space-y-1">
          <span className="text-[10px] text-zinc-400 font-medium uppercase tracking-wider block">Title</span>
          {titleParsed.status === 'MISSING' || !titleParsed.value ? (
            <div className="w-28 h-3.5 bg-zinc-700/60 rounded" />
          ) : (
            <p className={cn('font-semibold truncate', isExpanded ? 'text-sm font-bold' : 'text-xs', titleParsed.status === 'PROPOSED' ? 'text-blue-300' : 'text-white')}>
              {titleParsed.value}
              {titleParsed.status === 'PROPOSED' && (
                <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30 font-mono">
                  proposed
                </span>
              )}
            </p>
          )}
        </div>

        {/* PARTY RELATIONSHIP SECTION (CLIENT ↔ FREELANCER) */}
        <div className={cn(isChat ? 'pt-2 border-t border-zinc-800/60' : 'pt-3 border-t border-zinc-800/60', isExpanded ? 'space-y-3' : isChat ? 'space-y-1' : 'space-y-2')}>
          <div className="flex items-center justify-between text-[10px] text-zinc-400 font-medium uppercase tracking-wider pb-0.5">
            <span>Client</span>
            <span>Freelancer</span>
          </div>

          <div className={cn('flex items-center justify-between pt-0.5', isChat ? 'gap-1.5' : 'gap-2.5')}>
            {/* CLIENT (LEFT) */}
            <div className={cn('flex items-center min-w-0 flex-1', isChat ? 'gap-2' : 'gap-3')}>
              {client?.avatar ? (
                <img
                  src={client.avatar}
                  alt="Client Avatar"
                  className={cn('rounded-full object-cover shrink-0 border border-zinc-700/60', isExpanded ? 'w-14 h-14' : isChat ? 'w-8 h-8' : 'w-11 h-11')}
                />
              ) : clientWallet ? (
                <div
                  className={cn(
                    'rounded-full bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center text-white font-bold shrink-0 border border-zinc-700/60',
                    isExpanded ? 'w-14 h-14 text-sm' : isChat ? 'w-8 h-8 text-[10px]' : 'w-11 h-11 text-xs'
                  )}
                >
                  {((client?.name || client?.handle || clientWallet).slice(0, 2)).toUpperCase()}
                </div>
              ) : (
                <div className={cn('rounded-full bg-zinc-800/60 shrink-0 border border-zinc-800/80', isExpanded ? 'w-14 h-14' : isChat ? 'w-8 h-8' : 'w-11 h-11')} />
              )}
              <div className="min-w-0 flex-1">
                {clientWallet ? (
                  <>
                    <div className={cn('font-bold text-white truncate', isExpanded ? 'text-sm' : 'text-xs')}>
                      {client?.name || client?.displayHandle || shortenAddress(clientWallet)}
                    </div>
                    {(client?.name || client?.displayHandle) && (
                      <div className={cn('font-mono text-zinc-400 truncate', isExpanded ? 'text-xs' : 'text-[10px]')}>
                        {client?.name ? client?.displayHandle || shortenAddress(clientWallet) : shortenAddress(clientWallet)}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-zinc-500 italic truncate">Not connected</div>
                )}
              </div>
            </div>

            {/* HANDSHAKE ICON (CENTER) */}
            <div className="px-1.5 shrink-0 flex items-center justify-center text-blue-400">
              <Handshake size={isExpanded ? 22 : isChat ? 14 : 18} />
            </div>

            {/* FREELANCER (RIGHT) */}
            {freelancerWallet ? (
              <div className={cn('flex items-center justify-end min-w-0 flex-1 text-right', isChat ? 'gap-2' : 'gap-3')}>
                <div className="min-w-0 flex-1">
                  {freelancer?.name && (
                    <div className={cn('font-bold text-white truncate', isExpanded ? 'text-sm' : 'text-xs')}>
                      {freelancer?.name}
                    </div>
                  )}
                  <div className={cn('font-mono text-blue-400 truncate', isExpanded ? 'text-xs' : 'text-[10px]')}>
                    {freelancer?.displayHandle || shortenAddress(freelancerWallet)}
                  </div>
                </div>
                {freelancer?.avatar ? (
                  <img
                    src={freelancer?.avatar}
                    alt="Freelancer Avatar"
                    className={cn('rounded-full object-cover shrink-0 border border-zinc-700/60', isExpanded ? 'w-14 h-14' : isChat ? 'w-8 h-8' : 'w-11 h-11')}
                  />
                ) : (
                  <div
                    className={cn(
                      'rounded-full bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center text-white font-bold shrink-0 border border-zinc-700/60',
                      isExpanded ? 'w-14 h-14 text-sm' : isChat ? 'w-8 h-8 text-[10px]' : 'w-11 h-11 text-xs'
                    )}
                  >
                    {((freelancer?.name || freelancer?.handle || freelancerWallet).slice(0, 2)).toUpperCase()}
                  </div>
                )}
              </div>
            ) : (
              /* SKELETON BEFORE SELECTION */
              <div className={cn('flex items-center justify-end min-w-0 flex-1 text-right', isChat ? 'gap-2' : 'gap-3')}>
                <div className="min-w-0 flex-1 flex flex-col items-end gap-1">
                  <div className="w-16 h-3 bg-zinc-700/60 rounded" />
                  <div className="w-12 h-2.5 bg-zinc-700/40 rounded" />
                </div>
                <div className={cn('rounded-full bg-zinc-700/60 shrink-0 border border-zinc-700/80', isExpanded ? 'w-14 h-14' : isChat ? 'w-8 h-8' : 'w-11 h-11')} />
              </div>
            )}
          </div>
        </div>

        {/* PROGRESSIVELY POPULATED SUMMARY FIELDS */}
        <div className={cn(isChat ? 'pt-2 border-t border-zinc-800/60 text-xs' : 'pt-3 border-t border-zinc-800/60 text-xs', isExpanded ? 'space-y-3' : isChat ? 'space-y-1.5' : 'space-y-2.5')}>
          {isExpanded && (
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Deal Type</span>
              {titleParsed.status === 'MISSING' || !titleParsed.value ? (
                <div className="w-28 h-3.5 bg-zinc-700/60 rounded" />
              ) : (
                <span className="text-white font-medium truncate max-w-[220px]">
                  {titleParsed.value}
                </span>
              )}
            </div>
          )}

          {!isExpanded && (
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Scope</span>
              {scopeParsed.status === 'MISSING' || !scopeText ? (
                <div className="w-24 h-3.5 bg-zinc-700/60 rounded" />
              ) : (
                <div className="relative group inline-block text-right">
                  <span className={cn('font-medium truncate inline-block border-b border-dashed border-zinc-700 hover:border-zinc-400 transition-colors cursor-help', isChat ? 'max-w-[180px]' : 'max-w-[140px]', scopeParsed.status === 'PROPOSED' ? 'text-blue-300' : 'text-white')}>
                    {scopeText.length > scopePreviewLimit ? `${scopeText.slice(0, scopePreviewLimit)}...` : scopeText}
                  </span>
                  {scopeText.length > scopePreviewLimit && (
                    <div className="absolute right-0 bottom-full mb-2 hidden group-hover:block group-focus:block z-50 w-64 p-3 rounded-xl bg-zinc-900/95 border border-zinc-700 text-xs text-zinc-200 shadow-2xl backdrop-blur-md whitespace-pre-wrap leading-relaxed text-left pointer-events-none">
                      <div className="font-semibold text-blue-400 mb-1 text-[10px] uppercase tracking-wider">Full Deliverables / Scope</div>
                      {scopeText}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-zinc-400">Budget</span>
            {budgetParsed.status === 'MISSING' || budgetParsed.value === null || budgetParsed.value === undefined || budgetParsed.value === '' ? (
              <div className="w-16 h-3.5 bg-zinc-700/60 rounded" />
            ) : (
              <span className={cn('font-semibold', budgetParsed.status === 'PROPOSED' ? 'text-blue-300' : 'text-white')}>
                {budgetParsed.value} {assetSymbol}
                {budgetParsed.status === 'PROPOSED' && (
                  <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-blue-500/20 text-blue-400 font-mono">
                    proposed
                  </span>
                )}
              </span>
            )}
          </div>

          {isExpanded && (
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Asset</span>
              <span className="text-white font-medium">
                {assetSymbol} {isErc20 ? '(ERC-20)' : '(native)'}
              </span>
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-zinc-400">Deadline</span>
            {deadlineParsed.status === 'MISSING' || !deadlineText ? (
              <div className="w-20 h-3.5 bg-zinc-700/60 rounded" />
            ) : (
              <span className={cn('font-medium', deadlineParsed.status === 'PROPOSED' ? 'text-blue-300' : 'text-white')}>
                {deadlineText}
                {deadlineParsed.status === 'PROPOSED' && (
                  <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-blue-500/20 text-blue-400 font-mono">
                    proposed
                  </span>
                )}
              </span>
            )}
          </div>

          <div className="flex items-center justify-between">
            <span className="text-zinc-400">Payment</span>
            {paymentParsed.status === 'MISSING' || !paymentText ? (
              isChat ? <span className="text-zinc-500">—</span> : <div className="w-24 h-3.5 bg-zinc-700/60 rounded" />
            ) : (
              <span className={cn('font-medium text-right truncate max-w-[200px]', paymentParsed.status === 'PROPOSED' ? 'text-blue-300' : 'text-white')}>
                {paymentText}
              </span>
            )}
          </div>

          <div className="flex items-center justify-between">
            <span className="text-zinc-400">Protection</span>
            {protectionEnabled === undefined || protectionEnabled === null ? (
              <div className="w-16 h-3.5 bg-zinc-700/60 rounded" />
            ) : (
              <span className={protectionEnabled ? 'text-emerald-400 font-medium' : 'text-zinc-500'}>
                {protectionEnabled ? 'Adaptive ON' : 'None'}
              </span>
            )}
          </div>
        </div>

        {/* EXPANDED ONLY: SCOPE / DELIVERABLES FULL SECTION */}
        {isExpanded && (
          <div className="pt-3 border-t border-zinc-800/60 space-y-2">
            <span className="text-[10px] text-zinc-400 font-medium uppercase tracking-wider block">
              Scope / Deliverables
            </span>
            <div className="text-xs text-zinc-200 leading-relaxed whitespace-pre-wrap break-words p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800/60 max-h-48 overflow-y-auto">
              {scopeText || <span className="text-zinc-500 italic">No scope provided</span>}
            </div>
          </div>
        )}

        {/* ACTIONS / INJECTED SLOTS */}
        {actions && <div className={cn('border-t border-zinc-800/60', isChat ? 'pt-2' : 'pt-4')}>{actions}</div>}
      </div>

      {/* DECORATIVE RECEIPT BOTTOM TEAR ZIGZAG EDGE */}
      <div
        aria-hidden="true"
        className={cn('absolute left-0 right-0 pointer-events-none bg-zinc-900', isChat ? 'h-[7px]' : 'h-[9px]')}
        style={{
          top: `calc(100% + ${RECEIPT_TEAR_Y_OFFSET}px)`,
          clipPath: RECEIPT_TEAR_POLYGON,
        }}
      />
    </div>
  );
}
