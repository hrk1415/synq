'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, useChainId, useReadContract } from 'wagmi';
import { nexotiqDealABI, nexotiqFactoryABI, nexotiqReputationABI } from '@/lib/contracts/abis';
import { CONTRACT_ADDRESSES, chainKeyForId, getTokenInfo, isSupportedChain } from '@/lib/contracts/addresses';
import { getPublicClient } from '@/lib/chain';
import { getFactoryAddress } from '@/hooks/useFactoryContract';

const REPUTATION_BY_CHAIN: Record<number, string> = {
  31337: CONTRACT_ADDRESSES.hardhat.NexotiqReputation,
  11155111: CONTRACT_ADDRESSES.sepolia.NexotiqReputation,
};

export function getReputationAddress(chainId: number): `0x${string}` | undefined {
  return REPUTATION_BY_CHAIN[chainId] as `0x${string}` | undefined;
}

/** NexotiqDeal.status enum */
const STATUS = { DRAFT: 0, ACTIVE: 1, COMPLETED: 2, DISPUTED: 3, CANCELLED: 4 } as const;

export interface ReputationStats {
  /** 0-100. Derived from real on-chain deal outcomes unless the contract has a record. */
  score: number;
  totalDeals: number;
  completed: number;
  active: number;
  disputed: number;
  cancelled: number;
  /** Volume of settled deals, in the unit of `volumeSymbol`. */
  volume: number;
  volumeSymbol: string;
  /** True when more than one asset is involved, so `volume` is a partial figure. */
  mixedAssets: boolean;
  successRate: number | null;
  /** 'contract' when NexotiqReputation holds a record, 'derived' when computed from deals. */
  source: 'contract' | 'derived';
  /** No settled deals yet — the score is a starting value, not earned. */
  provisional: boolean;
  loading: boolean;
}

const EMPTY: ReputationStats = {
  score: 85, totalDeals: 0, completed: 0, active: 0, disputed: 0, cancelled: 0,
  volume: 0, volumeSymbol: 'ETH', mixedAssets: false, successRate: null,
  source: 'derived', provisional: true, loading: false,
};

/** Stable empty map so the memo below does not re-run on every render. */
const NO_STATUSES: Record<string, number> = {};

/**
 * Mirrors NexotiqReputation._recalculateScore so a derived score and a future
 * on-chain score agree: success rate, + up to 10 for volume, - 5 per dispute
 * (capped at half the score).
 */
function computeScore(completed: number, settled: number, volumeEth: number, disputes: number): number {
  if (settled === 0) return 85;
  let score = Math.floor((completed * 100) / settled);
  const volumeBonus = Math.min(Math.floor(volumeEth / 1000), 10);
  score += volumeBonus;
  if (disputes > 0) {
    const penalty = Math.min(disputes * 5, Math.floor(score / 2));
    score -= penalty;
  }
  return Math.max(0, Math.min(100, score));
}

/**
 * Real reputation for a wallet.
 *
 * The deployed NexotiqReputation contract was constructed with a non-factory
 * address as its `factory`, and NexotiqFactory never calls it, so it holds no
 * records and cannot be written to. Rather than show a hardcoded trust score,
 * this derives the numbers from the user's actual deals on chain. If a correctly
 * wired Reputation contract is ever deployed, its record wins automatically.
 */
export function useReputation(userAddress?: `0x${string}`) {
  const { address: connected } = useAccount();
  const address = userAddress ?? connected;
  const chainId = useChainId();
  const factoryAddress = getFactoryAddress(chainId);
  const reputationAddress = getReputationAddress(chainId);
  const onSupportedChain = isSupportedChain(chainId) && !!factoryAddress;

  const { data: rawDeals } = useReadContract({
    address: factoryAddress,
    abi: nexotiqFactoryABI,
    functionName: 'getUserDeals',
    args: address ? [address] : undefined,
    query: { enabled: !!address && onSupportedChain },
  });

  const { data: onChainRep } = useReadContract({
    address: reputationAddress,
    abi: nexotiqReputationABI,
    functionName: 'getReputation',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!reputationAddress && onSupportedChain },
  });

  const [statuses, setStatuses] = useState<Record<string, number> | null>(null);

  const deals = useMemo(() => {
    if (!rawDeals || !address) return [];
    const seen = new Set<string>();
    return (rawDeals as any[]).filter((d) => {
      if (!d?.dealAddress) return false;
      const k = String(d.dealAddress).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [rawDeals, address]);

  const dealKey = deals.map((d) => String(d.dealAddress)).join(',');
  const needsStatuses = onSupportedChain && deals.length > 0;

  /** Reads each deal's status. Returns the map instead of setting state so the
   *  effect below never writes state synchronously during its own run. */
  const load = useCallback(async (): Promise<Record<string, number>> => {
    const client = getPublicClient(chainId);
    if (!client) return {};
    const entries: Record<string, number> = {};
    await Promise.all(deals.map(async (d) => {
      try {
        const s = await client.readContract({
          address: d.dealAddress as `0x${string}`,
          abi: nexotiqDealABI,
          functionName: 'status',
        });
        entries[String(d.dealAddress)] = Number(s);
      } catch { /* unreadable deal is left out rather than counted as a failure */ }
    }));
    return entries;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealKey, chainId]);

  useEffect(() => {
    if (!needsStatuses) return;
    let alive = true;
    load()
      .then((entries) => { if (alive) setStatuses(entries); })
      .catch(() => { if (alive) setStatuses({}); });
    return () => { alive = false; };
  }, [load, needsStatuses]);

  // Nothing to read means "no records", not "still loading".
  const statusMap = needsStatuses ? statuses : NO_STATUSES;

  return useMemo<ReputationStats>(() => {
    if (!address || !onSupportedChain) return EMPTY;
    if (statusMap === null) return { ...EMPTY, loading: true };
    const statuses = statusMap;

    const rep = onChainRep as any;
    if (rep?.exists) {
      const total = Number(rep.totalDeals || 0);
      const ok = Number(rep.successfulDeals || 0);
      return {
        score: Number(rep.score || 0),
        totalDeals: total,
        completed: ok,
        active: 0,
        disputed: Number(rep.disputesOpened || 0),
        cancelled: Number(rep.failedDeals || 0),
        volume: Number(rep.totalVolume || 0) / 1e18,
        volumeSymbol: 'ETH',
        mixedAssets: false,
        successRate: total > 0 ? Math.round((ok * 100) / total) : null,
        source: 'contract',
        provisional: total === 0,
        loading: false,
      };
    }

    let completed = 0, active = 0, disputed = 0, cancelled = 0;
    let volume = 0;
    const symbols = new Set<string>();
    let volumeSymbol = 'ETH';

    for (const d of deals) {
      const st = statuses[String(d.dealAddress)];
      if (st === undefined) continue;
      if (st === STATUS.COMPLETED) completed++;
      else if (st === STATUS.ACTIVE) active++;
      else if (st === STATUS.DISPUTED) disputed++;
      else if (st === STATUS.CANCELLED) cancelled++;

      const token = getTokenInfo(chainKeyForId(chainId), String(d.asset || ''));
      symbols.add(token.symbol);
      if (st === STATUS.COMPLETED) {
        volumeSymbol = token.symbol;
        volume += Number(d.totalValue || 0) / 10 ** token.decimals;
      }
    }

    const settled = completed + disputed + cancelled;
    return {
      score: computeScore(completed, settled, volume, disputed),
      totalDeals: Object.keys(statuses).length,
      completed,
      active,
      disputed,
      cancelled,
      volume,
      volumeSymbol,
      mixedAssets: symbols.size > 1,
      successRate: settled > 0 ? Math.round((completed * 100) / settled) : null,
      source: 'derived',
      provisional: settled === 0,
      loading: false,
    };
  }, [address, onSupportedChain, statusMap, onChainRep, deals, chainId]);
}
