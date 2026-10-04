'use client';

import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';

/**
 * Just `status()`, declared `as const` rather than pulled from the generated
 * artifact: the artifact JSON widens `type` to `string`, which `useReadContracts`
 * rejects (unlike the single-read `useReadContract`).
 */
const dealInfoABI = [
  {
    type: 'function',
    name: 'status',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8', internalType: 'enum NexotiqDeal.DealStatus' }],
  },
  {
    type: 'function',
    name: 'title',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string', internalType: 'string' }],
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
 * Reads each deal's real `status()` and `title()` from the deal contract itself.
 *
 * The factory's `DealInfo.active` flag is not a substitute: it is only cleared by
 * `onDealSettled`, which the factory deployed on Sepolia never receives, so every
 * deal there reports `active: true` forever — including Completed and Cancelled
 * ones. Anything that gates UI on liveness has to ask the deal.
 */
export function useDealStatuses(addresses: readonly string[]) {
  const contracts = useMemo(
    () =>
      addresses.flatMap((address) => [
        {
          address: address as `0x${string}`,
          abi: dealInfoABI,
          functionName: 'status' as const,
          chainId: SEPOLIA_CHAIN_ID,
        },
        {
          address: address as `0x${string}`,
          abi: dealInfoABI,
          functionName: 'title' as const,
          chainId: SEPOLIA_CHAIN_ID,
        },
      ]),
    [addresses],
  );

  const { data, isLoading, refetch } = useReadContracts({
    contracts,
    chainId: SEPOLIA_CHAIN_ID,
    query: { enabled: addresses.length > 0 },
  });

  const { statuses, titles } = useMemo(() => {
    const statusMap: Record<string, number> = {};
    const titleMap: Record<string, string> = {};
    if (!data) return { statuses: statusMap, titles: titleMap };

    addresses.forEach((addr, i) => {
      const key = addr.toLowerCase();
      const statusRes = data[i * 2];
      const titleRes = data[i * 2 + 1];

      if (statusRes && statusRes.status === 'success') {
        statusMap[key] = Number(statusRes.result);
      }

      if (
        titleRes &&
        titleRes.status === 'success' &&
        typeof titleRes.result === 'string' &&
        titleRes.result.trim() !== ''
      ) {
        titleMap[key] = titleRes.result.trim();
      }
    });

    return { statuses: statusMap, titles: titleMap };
  }, [data, addresses]);

  return { statuses, titles, isLoading, refetch };
}
