'use client';

import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useBalance } from 'wagmi';
import { nexotiqProtectionABI } from '@/lib/contracts/abis';
import { CONTRACT_ADDRESSES, isSupportedChain } from '@/lib/contracts/addresses';
import { coverageCompatABI, coverageModernABI, toCoverageView } from '@/lib/contracts/protectionCompat';
import { useChainId } from 'wagmi';

const PROTECTION_BY_CHAIN: Record<number, string> = {
  31337: CONTRACT_ADDRESSES.hardhat.NexotiqProtection,
  11155111: CONTRACT_ADDRESSES.sepolia.NexotiqProtection,
};

/** undefined on chains with no deployment — see getFactoryAddress for why. */
export function getProtectionAddress(chainId: number): `0x${string}` | undefined {
  return PROTECTION_BY_CHAIN[chainId] as `0x${string}` | undefined;
}

export function useProtectionContract() {
  const chainId = useChainId();
  const protAddress = getProtectionAddress(chainId);
  const onSupportedChain = isSupportedChain(chainId) && !!protAddress;
  const config = { address: protAddress, abi: nexotiqProtectionABI } as const;
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
  const { data: poolBalance } = useBalance({ address: protAddress, query: { enabled: onSupportedChain } });

  const write = useWriteContract();
  const { data: txHash, writeContract, isPending } = write;
  const txReceipt = useWaitForTransactionReceipt({ hash: txHash });

  const guardWrite = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
    if (!onSupportedChain) return;
    fn(...args);
  };

  return {
    protAddress,
    onSupportedChain,
    config,
    totalPremiums,
    totalPayouts,
    poolBalance: poolBalance?.value,
    writeContract,
    isPending: isPending || txReceipt.isLoading,
    txReceipt,
    payPremium: guardWrite((dealAddress: `0x${string}`, value: bigint) =>
      writeContract({ ...config, address: protAddress!, functionName: 'payPremium', args: [dealAddress], value })),
    fileClaim: guardWrite((dealAddress: `0x${string}`) =>
      writeContract({ ...config, address: protAddress!, functionName: 'fileClaim', args: [dealAddress] })),
    resolveClaim: guardWrite((dealAddress: `0x${string}`, approved: boolean) =>
      writeContract({ ...config, address: protAddress!, functionName: 'resolveClaim', args: [dealAddress, approved] })),
    withdrawPremiums: guardWrite(() =>
      writeContract({ ...config, address: protAddress!, functionName: 'withdrawPremiums' })),
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
export function useProtectionCoverage(dealAddress: `0x${string}` | undefined, chainId: number) {
  const protAddress = getProtectionAddress(chainId);
  const enabled = !!dealAddress && !!protAddress && isSupportedChain(chainId);
  const args = dealAddress ? ([dealAddress] as const) : undefined;

  const shared = useReadContract({
    address: protAddress,
    abi: coverageCompatABI,
    functionName: 'getCoverage',
    args,
    query: { enabled },
  });

  // Expected to fail against the pool live today — that failure is the signal
  // that premium payment is not tracked, not an error worth surfacing.
  const modern = useReadContract({
    address: protAddress,
    abi: coverageModernABI,
    functionName: 'getCoverage',
    args,
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
