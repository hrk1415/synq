'use client';

import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useBalance } from 'wagmi';
import { nexotiqProtectionABI } from '@/lib/contracts/abis';
import { CONTRACT_ADDRESSES, SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { coverageCompatABI, coverageModernABI, toCoverageView } from '@/lib/contracts/protectionCompat';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';

/** undefined on chains with no deployment — see getFactoryAddress for why. */
export function getProtectionAddress(chainId: number): `0x${string}` | undefined {
  return chainId === SEPOLIA_CHAIN_ID
    ? CONTRACT_ADDRESSES.sepolia.NexotiqProtection as `0x${string}`
    : undefined;
}

export function useProtectionContract() {
  const protAddress = CONTRACT_ADDRESSES.sepolia.NexotiqProtection as `0x${string}`;
  const onSupportedChain = true;
  const config = { address: protAddress, abi: nexotiqProtectionABI, chainId: SEPOLIA_CHAIN_ID } as const;
  const enabled = { query: { enabled: onSupportedChain } } as const;

  const { data: totalPremiums } = useReadContract({ ...config, functionName: 'totalPremiums', ...enabled });
  const { data: totalPayouts } = useReadContract({ ...config, functionName: 'totalPayouts', ...enabled });

  /**
   * The pool's real ETH. Read as a plain balance rather than via `poolBalance()`
   * because that view does not exist on the currently deployed pool — and because
   * `totalPremiums` there was incremented when coverage was *quoted*, so it
   * reports 0.004 ETH against a balance of 0. Showing both is the only honest
   * option until the pool is redeployed.
   */
  const { data: poolBalance } = useBalance({ address: protAddress, chainId: SEPOLIA_CHAIN_ID, query: { enabled: onSupportedChain } });

  const { ensureSepolia, networkReady, isSwitching, error: networkError } = useSepoliaNetwork();
  const write = useWriteContract();
  const { data: txHash, writeContractAsync, isPending, error: writeError } = write;
  const txReceipt = useWaitForTransactionReceipt({ hash: txHash, chainId: SEPOLIA_CHAIN_ID });

  const guardWrite = <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) => async (...args: A) => {
    try {
      await ensureSepolia();
      return await fn(...args);
    } catch {
      return undefined;
    }
  };
  const writeAddress = CONTRACT_ADDRESSES.sepolia.NexotiqProtection as `0x${string}`;

  return {
    protAddress,
    onSupportedChain,
    config,
    totalPremiums,
    totalPayouts,
    poolBalance: poolBalance?.value,
    networkReady,
    isSwitching,
    error: networkError ?? writeError,
    isPending: isPending || txReceipt.isLoading || isSwitching,
    txReceipt,
    payPremium: guardWrite((dealAddress: `0x${string}`, value: bigint) =>
      writeContractAsync({ ...config, address: writeAddress, functionName: 'payPremium', args: [dealAddress], value })),
    fileClaim: guardWrite((dealAddress: `0x${string}`) =>
      writeContractAsync({ ...config, address: writeAddress, functionName: 'fileClaim', args: [dealAddress] })),
    resolveClaim: guardWrite((dealAddress: `0x${string}`, approved: boolean) =>
      writeContractAsync({ ...config, address: writeAddress, functionName: 'resolveClaim', args: [dealAddress, approved] })),
    withdrawPremiums: guardWrite(() =>
      writeContractAsync({ ...config, address: writeAddress, functionName: 'withdrawPremiums' })),
  };
}

/**
 * Reads a deal's coverage record.
 *
 * Named `use*` because it calls useReadContract — as `getProtectionCoverage` it
 * broke the rules of hooks: React could not see it as a hook, so neither the
 * linter nor React itself could catch a conditional or looped call, which would
 * desync the hook order and hand a component the wrong query's data.
 *
 * Reads through the version-agnostic ABI shim so the same code works against the
 * pool that is live today and against a redeployed one; see protectionCompat.ts.
 */
export function useProtectionCoverage(dealAddress: `0x${string}` | undefined) {
  const protAddress = CONTRACT_ADDRESSES.sepolia.NexotiqProtection as `0x${string}`;
  const enabled = !!dealAddress;
  const args = dealAddress ? ([dealAddress] as const) : undefined;

  const shared = useReadContract({
    address: protAddress,
    abi: coverageCompatABI,
    functionName: 'getCoverage',
    args,
    chainId: SEPOLIA_CHAIN_ID,
    query: { enabled },
  });

  // Expected to fail against the pool live today — that failure is the signal
  // that premium payment is not tracked, not an error worth surfacing.
  const modern = useReadContract({
    address: protAddress,
    abi: coverageModernABI,
    functionName: 'getCoverage',
    args,
    chainId: SEPOLIA_CHAIN_ID,
    query: { enabled, retry: false },
  });

  const premiumPaid = modern.data ? (modern.data as { premiumPaid: boolean }).premiumPaid : undefined;

  return {
    coverage: toCoverageView(shared.data, premiumPaid),
    isLoading: shared.isLoading,
    isError: shared.isError,
    /** True once the pool is new enough to record premium receipts. */
    tracksPremiumPaid: !!modern.data,
    refetch: shared.refetch,
  };
}
