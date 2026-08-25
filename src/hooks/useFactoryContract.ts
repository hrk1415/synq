'use client';

import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { nexotiqFactoryABI } from '@/lib/contracts/abis';
import { CONTRACT_ADDRESSES, isSupportedChain } from '@/lib/contracts/addresses';
import { useChainId } from 'wagmi';

const FACTORY_BY_CHAIN: Record<number, string> = {
  31337: CONTRACT_ADDRESSES.hardhat.NexotiqFactory,
  11155111: CONTRACT_ADDRESSES.sepolia.NexotiqFactory,
};

/**
 * Returns undefined on chains with no deployment. Do NOT fall back to the
 * hardhat address — those addresses do not exist on Mainnet/Base, so reads
 * return empty and the UI silently shows "no deals" instead of "wrong network".
 */
export function getFactoryAddress(chainId: number): `0x${string}` | undefined {
  return FACTORY_BY_CHAIN[chainId] as `0x${string}` | undefined;
}

export function useFactoryContract() {
  const chainId = useChainId();
  const factoryAddress = getFactoryAddress(chainId);
  const onSupportedChain = isSupportedChain(chainId) && !!factoryAddress;

  const config = { address: factoryAddress, abi: nexotiqFactoryABI } as const;
  const enabled = { query: { enabled: onSupportedChain } } as const;

  const { data: dealCount, refetch: refetchCount } = useReadContract({ ...config, functionName: 'getDealCount', ...enabled });
  const { data: dealImplementation } = useReadContract({ ...config, functionName: 'dealImplementation', ...enabled });
  const { data: feeBps } = useReadContract({ ...config, functionName: 'feeBps', ...enabled });
  const { data: feeCollector } = useReadContract({ ...config, functionName: 'feeCollector', ...enabled });

  const write = useWriteContract();
  const { data: txHash, writeContract, isPending } = write;
  const txReceipt = useWaitForTransactionReceipt({ hash: txHash });

  // Writes must never be attempted against a missing deployment — the wallet
  // would pop a confirmation for a transaction that is guaranteed to revert.
  const guardWrite = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
    if (!onSupportedChain) return;
    fn(...args);
  };

  return {
    factoryAddress,
    onSupportedChain,
    dealCount,
    dealImplementation,
    feeBps,
    feeCollector,
    config,
    writeContract,
    isPending: isPending || txReceipt.isLoading,
    txReceipt,
    refetchCount,
    createDeal: guardWrite((seller: `0x${string}`, title: string, description: string, totalValue: bigint, deadline: bigint, protectionEnabled: boolean, asset: `0x${string}`) =>
      writeContract({ ...config, address: factoryAddress!, functionName: 'createDeal', args: [seller, title, description, totalValue, deadline, protectionEnabled, asset] })),
    resolveClaim: guardWrite((dealAddress: `0x${string}`, approved: boolean) =>
      writeContract({ ...config, address: factoryAddress!, functionName: 'resolveClaim', args: [dealAddress, approved] })),
    forceResolve: guardWrite((dealAddress: `0x${string}`, resolution: string) =>
      writeContract({ ...config, address: factoryAddress!, functionName: 'forceResolve', args: [dealAddress, resolution] })),
  };
}