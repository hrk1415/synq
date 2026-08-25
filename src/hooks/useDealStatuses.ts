'use client';

import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';

/**
 * Just `status()`, declared `as const` rather than pulled from the generated
 * artifact: the artifact JSON widens `type` to `string`, which `useReadContracts`
 * rejects (unlike the single-read `useReadContract`).
 */
const dealStatusABI = [
  {
    type: 'function',
    name: 'status',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8', internalType: 'enum NexotiqDeal.DealStatus' }],
  },
] as const;

export const DEAL_STATUS_LABELS = ['Draft', 'Active', 'Completed', 'Disputed', 'Cancelled'] as const;

export type DealStatusNum = 0 | 1 | 2 | 3 | 4;

export function dealStatusLabel(status: number | undefined): string {
  if (status === undefined) return 'Unknown';
  return DEAL_STATUS_LABELS[status] ?? `Status ${status}`;
}

/** Completed, Disputed and Cancelled deals accept no further party actions. */
export function isTerminalStatus(status: number | undefined): boolean {
  return status === 2 || status === 3 || status === 4;
}

/**
 * Reads each deal's real `status()` from the deal contract itself.
 *
 * The factory's `DealInfo.active` flag is not a substitute: it is only cleared by
 * `onDealSettled`, which the factory deployed on Sepolia never receives, so every
 * deal there reports `active: true` forever — including Completed and Cancelled
 * ones. Anything that gates UI on liveness has to ask the deal.
 */
export function useDealStatuses(addresses: readonly string[]) {
  const contracts = useMemo(
    () =>
      addresses.map((address) => ({
        address: address as `0x${string}`,
        abi: dealStatusABI,
        functionName: 'status' as const,
      })),
    [addresses],
  );

  const { data, isLoading, refetch } = useReadContracts({
    contracts,
    query: { enabled: addresses.length > 0 },
  });

  const statuses = useMemo(() => {
    const map: Record<string, number> = {};
    if (!data) return map;
    data.forEach((result, i) => {
      const key = addresses[i]?.toLowerCase();
      if (!key) return;
      // A failed read stays absent rather than defaulting to 0/Draft — an
      // unreachable deal must not be presented as an actionable one.
      if (result.status === 'success') map[key] = Number(result.result);
    });
    return map;
  }, [data, addresses]);

  return { statuses, isLoading, refetch };
}
