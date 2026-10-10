'use client';

import { useState, useEffect } from 'react';
import { AlertTriangle, Loader2, ArrowRightLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';

/**
 * Tells the user their wallet is on a network where Synq has no contracts, and
 * offers a one-click switch. Without this the app reads a chain with no
 * deployment and renders an empty state that looks like "you have no deals".
 *
 * Renders nothing when disconnected (pages already prompt to connect), when
 * unverified/restoring, or when the chain is supported.
 */
export function ChainGuard({ what = 'Synq contracts are' }: { what?: string }) {
  const [mounted, setMounted] = useState(false);
  const { isConnected, isWrongNetwork, isSwitching, error, requestSepolia } = useSepoliaNetwork();

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || !isConnected || !isWrongNetwork) return null;

  return (
    <div className="p-3 rounded-xl bg-amber-600/10 border border-amber-500/25 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-amber-300 flex items-start gap-2">
        <AlertTriangle size={15} className="shrink-0 mt-0.5" />
        <span>
          <b>Ethereum Sepolia Required.</b> {what} available only on Ethereum Sepolia.
          Switch networks to continue.
          {error && <span className="block mt-1 text-amber-200/80">{error.message}</span>}
        </span>
      </p>
      <Button
        size="sm"
        className="gap-1.5 shrink-0"
        disabled={isSwitching}
        onClick={() => void requestSepolia().catch(() => undefined)}
      >
        {isSwitching ? <Loader2 size={14} className="animate-spin" /> : <ArrowRightLeft size={14} />}
        Switch to Sepolia
      </Button>
    </div>
  );
}

export default ChainGuard;
