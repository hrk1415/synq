'use client';

import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { nexotiqFactoryABI } from '@/lib/contracts/abis';
import { CONTRACT_ADDRESSES, SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';

/**
 * Returns undefined on chains with no deployment. Do NOT fall back to the
 * hardhat address — those addresses do not exist on Mainnet/Base, so reads
 * return empty and the UI silently shows "no deals" instead of "wrong network".
 */
export function getFactoryAddress(chainId: number): `0x${string}` | undefined {
  return chainId === SEPOLIA_CHAIN_ID
    ? CONTRACT_ADDRESSES.sepolia.NexotiqFactory as `0x${string}`
    : undefined;
}

export function useFactoryContract() {
  const factoryAddress = CONTRACT_ADDRESSES.sepolia.NexotiqFactory as `0x${string}`;
  const onSupportedChain = true;

  const config = { address: factoryAddress, abi: nexotiqFactoryABI, chainId: SEPOLIA_CHAIN_ID } as const;
  const enabled = { query: { enabled: onSupportedChain } } as const;

  const { data: dealCount, refetch: refetchCount } = useReadContract({ ...config, functionName: 'getDealCount', ...enabled });
  const { data: dealImplementation } = useReadContract({ ...config, functionName: 'dealImplementation', ...enabled });
  const { data: feeBps } = useReadContract({ ...config, functionName: 'feeBps', ...enabled });
  const { data: feeCollector } = useReadContract({ ...config, functionName: 'feeCollector', ...enabled });

  const { ensureSepolia, networkReady, isSwitching, error: networkError } = useSepoliaNetwork();
  const write = useWriteContract();
  const { data: txHash, writeContractAsync, isPending, error: writeError } = write;
  const txReceipt = useWaitForTransactionReceipt({ hash: txHash, chainId: SEPOLIA_CHAIN_ID });

  // Writes must never be attempted against a missing deployment — the wallet
  // would pop a confirmation for a transaction that is guaranteed to revert.
  const guardWrite = <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) => async (...args: A) => {
    try {
      await ensureSepolia();
      return await fn(...args);
    } catch {
      return undefined;
    }
  };

  const guardWritePropagate = <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) => async (...args: A) => {
    await ensureSepolia();
    return await fn(...args);
  };
  const writeAddress = CONTRACT_ADDRESSES.sepolia.NexotiqFactory as `0x${string}`;

  return {
    factoryAddress,
    onSupportedChain,
    dealCount,
    dealImplementation,
    feeBps,
    feeCollector,
    config,
    networkReady,
    isSwitching,
    error: networkError ?? writeError,
    isPending: isPending || txReceipt.isLoading || isSwitching,
    txReceipt,
    refetchCount,
    createDeal: guardWritePropagate((seller: `0x${string}`, title: string, description: string, totalValue: bigint, deadline: bigint, protectionEnabled: boolean, asset: `0x${string}`) =>
      writeContractAsync({ ...config, address: writeAddress, functionName: 'createDeal', args: [seller, title, description, totalValue, deadline, protectionEnabled, asset] })),
    resolveClaim: guardWrite((dealAddress: `0x${string}`, approved: boolean) =>
      writeContractAsync({ ...config, address: writeAddress, functionName: 'resolveClaim', args: [dealAddress, approved] })),
    forceResolve: guardWrite((dealAddress: `0x${string}`, resolution: string) =>
      writeContractAsync({ ...config, address: writeAddress, functionName: 'forceResolve', args: [dealAddress, resolution] })),
  };
}
