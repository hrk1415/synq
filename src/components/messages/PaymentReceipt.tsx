'use client';

import { ExternalLink } from 'lucide-react';
import { formatUnits } from 'viem';
import { getSepoliaExplorerUrl } from '@/lib/chain';
import type { SynqPaymentReceiptPayload } from '@/lib/synq-message';

export function PaymentReceipt({
  payload,
  sent,
  timestamp,
}: {
  payload: SynqPaymentReceiptPayload;
  sent: boolean;
  timestamp: string;
}) {
  const amount = formatUnits(BigInt(payload.amount), payload.decimals);
  return (
    <div className="w-full max-w-[420px] rounded-xl border border-white/75 bg-[#1B1B1B] p-3 shadow-xl">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold tracking-[0.16em] text-[#A3A3A3]">{sent ? 'AMOUNT SENT' : 'AMOUNT RECEIVED'}</p>
          <p className="mt-0.5 text-xl font-semibold text-white">{amount} {payload.symbol}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pt-0.5 text-[10px]">
          <span className="font-medium text-emerald-400">Completed</span>
          <span aria-hidden="true" className="text-neutral-600">·</span>
          <span className="text-[#A3A3A3]">{timestamp}</span>
        </div>
      </div>
      <div className={payload.note
        ? 'mt-2.5 grid grid-cols-1 gap-2 border-t border-white/10 pt-2 sm:grid-cols-[minmax(0,2fr)_minmax(5rem,1fr)] sm:gap-4'
        : 'mt-2.5 flex justify-end border-t border-white/10 pt-2'}>
        {payload.note && (
          <div className="min-w-0">
            <p className="text-[10px] text-[#A3A3A3]">Note</p>
            <p className="mt-0.5 break-words text-xs leading-snug text-neutral-200">{payload.note}</p>
          </div>
        )}
        <div className="min-w-0 sm:text-right">
          <p className="text-[10px] text-[#A3A3A3]">Network</p>
          <p className="mt-0.5 text-xs text-white">Sepolia</p>
        </div>
      </div>
      <a
        href={getSepoliaExplorerUrl('tx', payload.transactionHash)}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 flex items-center justify-center gap-1.5 rounded-lg border border-white/20 bg-[#252525] px-3 py-1.5 text-xs text-white transition-colors hover:border-white hover:text-white"
      >
        View transaction <ExternalLink size={12} />
      </a>
    </div>
  );
}
