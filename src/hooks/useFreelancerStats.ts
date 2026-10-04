'use client';

import { useMemo } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import type { Abi } from 'viem';
import { nexotiqFactoryABI } from '@/lib/contracts/abis';
import { CONTRACT_ADDRESSES, SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import {
  filterSellerDeals,
  STATUS_COMPLETED,
  dealStatusABI,
  RawFactoryDeal,
} from '@/lib/deals/freelancerStats';

/**
 * Single-wallet hook to compute authoritative completed deal count for a freelancer profile.
 *
 * Rules:
 * 1. Target wallet must be the seller
 * 2. buyer != seller (exclude self-deals)
 * 3. deal status == 2 (Completed)
 */
export function useFreelancerCompletedDeals(wallet?: string) {
  const factoryAddress = CONTRACT_ADDRESSES.sepolia.NexotiqFactory as `0x${string}`;
  const validWallet = wallet && wallet.startsWith('0x') ? (wallet as `0x${string}`) : undefined;

  const { data: rawDeals, isLoading: loadingFactory, isError: errorFactory } = useReadContract({
    address: factoryAddress,
    abi: nexotiqFactoryABI,
    functionName: 'getUserDeals',
    args: validWallet ? [validWallet] : undefined,
    chainId: SEPOLIA_CHAIN_ID,
    query: { enabled: !!validWallet },
  });

  // Filter deals where target is seller and buyer != seller
  const sellerDealAddresses = useMemo(() => {
    if (!rawDeals || !validWallet) return [];
    return filterSellerDeals(rawDeals as RawFactoryDeal[], validWallet);
  }, [rawDeals, validWallet]);

  const contracts = useMemo(() => {
    return sellerDealAddresses.map((addr) => ({
      address: addr,
      abi: dealStatusABI,
      functionName: 'status' as const,
      chainId: SEPOLIA_CHAIN_ID,
    }));
  }, [sellerDealAddresses]);

  const { data: statusResults, isLoading: loadingStatuses, isError: errorStatuses } = useReadContracts({
    contracts,
    chainId: SEPOLIA_CHAIN_ID,
    query: { enabled: sellerDealAddresses.length > 0 },
  });

  const completedCount = useMemo(() => {
    if (!validWallet) return undefined;
    if (loadingFactory) return undefined;
    if (errorFactory) return undefined;

    // If seller has 0 relevant seller deals, completed count is 0
    if (sellerDealAddresses.length === 0) return 0;

    if (loadingStatuses || !statusResults) return undefined;
    if (errorStatuses) return undefined;

    let count = 0;
    for (const res of statusResults) {
      if (res.status === 'success' && Number(res.result) === STATUS_COMPLETED) {
        count++;
      }
    }
    return count;
  }, [validWallet, loadingFactory, errorFactory, sellerDealAddresses, loadingStatuses, statusResults, errorStatuses]);

  const isLoading = !!validWallet && (loadingFactory || (sellerDealAddresses.length > 0 && loadingStatuses));
  const isError = !!validWallet && (errorFactory || (sellerDealAddresses.length > 0 && errorStatuses));

  return {
    completedCount,
    isLoading,
    isError,
  };
}

/**
 * Batch hook to compute authoritative completed deal counts for multiple freelancer wallets.
 * Avoids N+1 RPC calls across marketplace seller cards.
 *
 * 1st multicall: getUserDeals for all seller wallets
 * 2nd multicall: status() for all unique relevant deal addresses
 */
export function useBatchFreelancerCompletedDeals(sellerWallets: readonly string[]) {
  const factoryAddress = CONTRACT_ADDRESSES.sepolia.NexotiqFactory as `0x${string}`;

  const validWallets = useMemo(() => {
    return sellerWallets
      .filter((w) => typeof w === 'string' && w.startsWith('0x'))
      .map((w) => w.toLowerCase());
  }, [sellerWallets]);

  const factoryContracts = useMemo(() => {
    return validWallets.map((w) => ({
      address: factoryAddress,
      abi: nexotiqFactoryABI as Abi,
      functionName: 'getUserDeals' as const,
      args: [w as `0x${string}`],
      chainId: SEPOLIA_CHAIN_ID,
    }));
  }, [factoryAddress, validWallets]);

  const { data: factoryResults, isLoading: loadingFactory, isError: errorFactory } = useReadContracts({
    contracts: factoryContracts,
    chainId: SEPOLIA_CHAIN_ID,
    query: { enabled: validWallets.length > 0 },
  });

  // Extract seller-filtered deals per wallet and collect all unique deal addresses
  const { walletDealsMap, allUniqueDealAddresses } = useMemo(() => {
    const map: Record<string, `0x${string}`[]> = {};
    const uniqueAddressesSet = new Set<string>();
    const uniqueAddresses: `0x${string}`[] = [];

    validWallets.forEach((walletLower, idx) => {
      const res = factoryResults?.[idx];
      if (res && res.status === 'success' && Array.isArray(res.result)) {
        const sellerDeals = filterSellerDeals(res.result as RawFactoryDeal[], walletLower);
        map[walletLower] = sellerDeals;
        for (const dealAddr of sellerDeals) {
          const dealAddrLower = dealAddr.toLowerCase();
          if (!uniqueAddressesSet.has(dealAddrLower)) {
            uniqueAddressesSet.add(dealAddrLower);
            uniqueAddresses.push(dealAddr);
          }
        }
      } else {
        map[walletLower] = [];
      }
    });

    return { walletDealsMap: map, allUniqueDealAddresses: uniqueAddresses };
  }, [validWallets, factoryResults]);

  const statusContracts = useMemo(() => {
    return allUniqueDealAddresses.map((addr) => ({
      address: addr,
      abi: dealStatusABI,
      functionName: 'status' as const,
      chainId: SEPOLIA_CHAIN_ID,
    }));
  }, [allUniqueDealAddresses]);

  const { data: statusResults, isLoading: loadingStatuses, isError: errorStatuses } = useReadContracts({
    contracts: statusContracts,
    chainId: SEPOLIA_CHAIN_ID,
    query: { enabled: allUniqueDealAddresses.length > 0 },
  });

  const completedCountsMap = useMemo(() => {
    const map: Record<string, number | undefined> = {};

    // Map status results by lowercase deal address
    const dealStatusMap: Record<string, number> = {};
    if (statusResults) {
      allUniqueDealAddresses.forEach((addr, idx) => {
        const res = statusResults[idx];
        if (res && res.status === 'success') {
          dealStatusMap[addr.toLowerCase()] = Number(res.result);
        }
      });
    }

    validWallets.forEach((walletLower) => {
      // If factory load or status load failed/loading, keep undefined
      if (loadingFactory || errorFactory) {
        map[walletLower] = undefined;
        return;
      }

      const sellerDeals = walletDealsMap[walletLower] || [];
      if (sellerDeals.length === 0) {
        map[walletLower] = 0;
        return;
      }

      if (loadingStatuses || errorStatuses || !statusResults) {
        map[walletLower] = undefined;
        return;
      }

      let count = 0;
      for (const dealAddr of sellerDeals) {
        const st = dealStatusMap[dealAddr.toLowerCase()];
        if (st === STATUS_COMPLETED) {
          count++;
        }
      }
      map[walletLower] = count;
    });

    return map;
  }, [validWallets, loadingFactory, errorFactory, walletDealsMap, allUniqueDealAddresses, loadingStatuses, errorStatuses, statusResults]);

  return {
    completedCountsMap,
    isLoading: loadingFactory || (allUniqueDealAddresses.length > 0 && loadingStatuses),
    isError: errorFactory || (allUniqueDealAddresses.length > 0 && errorStatuses),
  };
}
