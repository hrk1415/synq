'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { isAddress, getAddress } from 'viem';
import { sepoliaPublicClient } from '@/lib/chain';
import { getSynqPremiumConfig } from '@/lib/contracts/addresses';
import {
  readDealPremiumPolicy,
  resolveProtectionTierStatus,
  type ProtectionTierStatus,
  type PremiumPolicyState,
} from '@/lib/deals/v2-protection';
import { useAuthSession } from '@/hooks/useAuthSession';

interface UseDealProtectionStatusOptions {
  dealAddress?: string | null;
  refreshTrigger?: unknown;
}

export interface UseDealProtectionStatusResult {
  status: ProtectionTierStatus;
  policy: PremiumPolicyState | null;
  isPolicyActive: boolean;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Reusable client hook for reading & verifying the authoritative protection tier status of a deal.
 * 
 * Rules:
 * 1. On-chain policy is the ultimate authority. An active verified policy always yields PREMIUM_ACTIVE.
 * 2. If off-chain proposal intent is PREMIUM but no active on-chain policy exists, yields PREMIUM_SELECTED.
 * 3. Default is STANDARD.
 * 4. While on-chain verification is in flight, yields VERIFYING to avoid false positive or false negative displays.
 */
export function useDealProtectionStatus({
  dealAddress,
  refreshTrigger,
}: UseDealProtectionStatusOptions): UseDealProtectionStatusResult {
  const { getToken } = useAuthSession();
  const [status, setStatus] = useState<ProtectionTierStatus>('VERIFYING');
  const [policy, setPolicy] = useState<PremiumPolicyState | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchIdRef = useRef(0);

  const fetchStatus = useCallback(async () => {
    if (!dealAddress || !isAddress(dealAddress.trim())) {
      setStatus('STANDARD');
      setPolicy(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    const currentFetchId = ++fetchIdRef.current;
    const cleanDealAddress = getAddress(dealAddress.trim());
    setIsLoading(true);
    setError(null);

    const premiumConfig = getSynqPremiumConfig();

    try {
      // 1. Fetch off-chain intent & on-chain policy concurrently
      const token = getToken();
      const intentPromise = (async (): Promise<string | null> => {
        try {
          const headers: Record<string, string> = {};
          if (token) headers.Authorization = `Bearer ${token}`;
          const res = await fetch(`/api/deals/${cleanDealAddress}/protection`, { headers });
          if (res.ok) {
            const data = await res.json();
            return data.protectionSelection || null;
          }
          return null;
        } catch {
          return null;
        }
      })();

      const policyPromise = (async (): Promise<PremiumPolicyState | null> => {
        if (!premiumConfig.isConfigured || !premiumConfig.manager) {
          return null;
        }
        return readDealPremiumPolicy(
          sepoliaPublicClient,
          premiumConfig.manager,
          cleanDealAddress,
          'V1_1'
        );
      })();

      const [protectionSelection, onChainPolicy] = await Promise.all([
        intentPromise,
        policyPromise,
      ]);

      // Guard against stale asynchronous resolution after deal switch
      if (currentFetchId !== fetchIdRef.current) return;

      setPolicy(onChainPolicy);

      const resolved = resolveProtectionTierStatus({
        protectionSelection,
        policy: onChainPolicy,
        isVerifying: false,
      });

      setStatus(resolved);
      setIsLoading(false);
    } catch (err: any) {
      if (currentFetchId !== fetchIdRef.current) return;
      console.warn('[useDealProtectionStatus] Verification error for', cleanDealAddress, err);
      setError(err?.message || 'Protection verification failed');
      // If verification encounters an RPC error, do not claim STANDARD or ACTIVE
      setStatus('VERIFYING');
      setIsLoading(false);
    }
  }, [dealAddress, getToken]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus, refreshTrigger]);

  return {
    status,
    policy,
    isPolicyActive: Boolean(policy?.active && policy.purchasedAt > 0n),
    isLoading,
    error,
    refetch: fetchStatus,
  };
}
