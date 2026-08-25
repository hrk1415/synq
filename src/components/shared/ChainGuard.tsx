'use client';

import { AlertTriangle, Loader2, ArrowRightLeft } from 'lucide-react';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import { Button } from '@/components/ui/button';
import { DEFAULT_CHAIN_ID, chainLabel, isSupportedChain } from '@/lib/contracts/addresses';

/**
 * Tells the user their wallet is on a network where Synq has no contracts, and
 * offers a one-click switch. Without this the app reads a chain with no
 * deployment and renders an empty state that looks like "you have no deals".
 *
 * Renders nothing when disconnected (pages already prompt to connect) or when
 * the chain is supported.
 */
export function ChainGuard({ what = 'Synq contracts are' }: { what?: string }) {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected || isSupportedChain(chainId)) return null;

  return (
    <div className="p-3 rounded-xl bg-amber-600/10 border border-amber-500/25 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-amber-300 flex items-start gap-2">
        <AlertTriangle size={15} className="shrink-0 mt-0.5" />
        <span>
          Wrong network — your wallet is on <b>{chainLabel(chainId)}</b>, where {what} not deployed.
          Nothing on this page will load until you switch to <b>Ethereum Sepolia</b>.
        </span>
      </p>
      <Button
        size="sm"
        className="gap-1.5 shrink-0"
        disabled={isPending}
        onClick={() => switchChain({ chainId: DEFAULT_CHAIN_ID })}
      >
        {isPending ? <Loader2 size={14} className="animate-spin" /> : <ArrowRightLeft size={14} />}
        Switch to Sepolia
      </Button>
    </div>
  );
}

export default ChainGuard;
