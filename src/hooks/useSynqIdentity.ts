'use client';

import { useMemo } from 'react';
import { isAddress } from 'viem';
import { useReadContract, useReadContracts } from 'wagmi';
import { registryABI } from '@/hooks/useRegistryContract';
import { CONTRACT_ADDRESSES, SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { shortenAddress } from '@/lib/utils';

export interface SynqIdentity {
  wallet: string;
  normalizedWallet: string;
  shortWallet: string;

  handle: string | null;
  displayHandle: string | null;
  hasHandle: boolean;

  isLoading: boolean;
  hasError: boolean;
}

export interface SynqIdentitiesResult {
  identitiesMap: Record<string, SynqIdentity>;
  isLoading: boolean;
  hasError: boolean;
}

/** Helper to validate EVM address format safely. */
function isValidAddress(addr: unknown): addr is `0x${string}` {
  return typeof addr === 'string' && isAddress(addr.trim());
}

/** Helper to clean up raw usernames from contract to prevent @@handle duplication. */
function normalizeHandle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const clean = trimmed.startsWith('@') ? trimmed.slice(1).trim() : trimmed;
  return clean.length > 0 ? clean : null;
}

/**
 * Single-wallet Synq handle resolver hook.
 * Reads NexotiqRegistry.getUsername(wallet) via Wagmi caching.
 */
export function useSynqIdentity(walletAddress?: string): SynqIdentity {
  const validAddr = useMemo(
    () => (isValidAddress(walletAddress) ? (walletAddress.trim() as `0x${string}`) : undefined),
    [walletAddress]
  );

  const { data: rawUsername, isLoading, isError } = useReadContract({
    address: CONTRACT_ADDRESSES.sepolia.NexotiqRegistry as `0x${string}`,
    abi: registryABI,
    functionName: 'getUsername',
    args: validAddr ? [validAddr] : undefined,
    chainId: SEPOLIA_CHAIN_ID,
    query: { enabled: !!validAddr },
  });

  return useMemo<SynqIdentity>(() => {
    const rawWallet = walletAddress ? walletAddress.trim() : '';
    const normWallet = validAddr ? validAddr.toLowerCase() : rawWallet.toLowerCase();
    const short = rawWallet ? shortenAddress(rawWallet) : '';

    if (!validAddr || isError) {
      return {
        wallet: rawWallet,
        normalizedWallet: normWallet,
        shortWallet: short,
        handle: null,
        displayHandle: null,
        hasHandle: false,
        isLoading: !!validAddr && isLoading,
        hasError: !!validAddr && isError,
      };
    }

    const cleanHandle = normalizeHandle(rawUsername);

    return {
      wallet: rawWallet,
      normalizedWallet: normWallet,
      shortWallet: short,
      handle: cleanHandle,
      displayHandle: cleanHandle ? `@${cleanHandle}` : null,
      hasHandle: !!cleanHandle,
      isLoading,
      hasError: false,
    };
  }, [walletAddress, validAddr, rawUsername, isLoading, isError]);
}

/**
 * Batch-wallet Synq handle resolver hook.
 * Deduplicates input addresses and issues ONE Wagmi useReadContracts multicall request.
 * Returns a lookup map keyed by normalized lowercase wallet address.
 */
export function useSynqIdentities(walletAddresses?: string[]): SynqIdentitiesResult {
  const normalizedKey = useMemo(() => {
    if (!Array.isArray(walletAddresses) || walletAddresses.length === 0) return '';
    const set = new Set<string>();
    for (const rawAddr of walletAddresses) {
      if (isValidAddress(rawAddr)) {
        set.add(rawAddr.trim().toLowerCase());
      }
    }
    return Array.from(set).sort().join(',');
  }, [walletAddresses]);

  const uniqueValidAddresses = useMemo(() => {
    if (!normalizedKey) return [];
    return normalizedKey.split(',').map((addr) => addr as `0x${string}`);
  }, [normalizedKey]);

  const registryContracts = useMemo(
    () =>
      uniqueValidAddresses.map((addr) => ({
        address: CONTRACT_ADDRESSES.sepolia.NexotiqRegistry as `0x${string}`,
        abi: registryABI,
        functionName: 'getUsername' as const,
        args: [addr],
        chainId: SEPOLIA_CHAIN_ID,
      })),
    [uniqueValidAddresses]
  );

  const { data: registryResults, isLoading, isError } = useReadContracts({
    contracts: registryContracts,
    chainId: SEPOLIA_CHAIN_ID,
    query: { enabled: uniqueValidAddresses.length > 0 },
  });

  const identitiesMap = useMemo(() => {
    const map: Record<string, SynqIdentity> = {};

    // 1. Populate default fallback entries for all input addresses
    if (Array.isArray(walletAddresses)) {
      for (const rawAddr of walletAddresses) {
        if (!rawAddr) continue;
        const trimmed = rawAddr.trim();
        const norm = trimmed.toLowerCase();
        if (!map[norm]) {
          map[norm] = {
            wallet: trimmed,
            normalizedWallet: norm,
            shortWallet: shortenAddress(trimmed),
            handle: null,
            displayHandle: null,
            hasHandle: false,
            isLoading: isValidAddress(trimmed) ? isLoading : false,
            hasError: false,
          };
        }
      }
    }

    if (!registryResults || uniqueValidAddresses.length === 0) {
      return map;
    }

    // 2. Populate multicall results into the lookup map using normalized lowercase keys
    registryResults.forEach((res, i) => {
      const normAddr = uniqueValidAddresses[i];
      if (!normAddr) return;

      const isResError = res.status === 'failure' || isError;
      const cleanHandle = isResError ? null : normalizeHandle(res.result);
      const originalWallet = map[normAddr]?.wallet || normAddr;

      map[normAddr] = {
        wallet: originalWallet,
        normalizedWallet: normAddr,
        shortWallet: shortenAddress(originalWallet),
        handle: cleanHandle,
        displayHandle: cleanHandle ? `@${cleanHandle}` : null,
        hasHandle: !!cleanHandle,
        isLoading: false,
        hasError: isResError,
      };
    });

    return map;
  }, [walletAddresses, uniqueValidAddresses, registryResults, isLoading, isError]);

  return useMemo(
    () => ({
      identitiesMap,
      isLoading: uniqueValidAddresses.length > 0 ? isLoading : false,
      hasError: isError,
    }),
    [identitiesMap, uniqueValidAddresses.length, isLoading, isError]
  );
}
