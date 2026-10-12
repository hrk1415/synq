'use client';

import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { CONTRACT_ADDRESSES, SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';

export const registryABI = [
  { inputs: [], stateMutability: 'nonpayable', type: 'constructor' },
  { inputs: [{ internalType: 'address', name: '', type: 'address' }], name: 'addressToUsername', outputs: [{ internalType: 'string', name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ internalType: 'address', name: '_user', type: 'address' }], name: 'getUsername', outputs: [{ internalType: 'string', name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ internalType: 'string', name: '_username', type: 'string' }], name: 'getAddress', outputs: [{ internalType: 'address', name: '', type: 'address' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ internalType: 'string', name: '_username', type: 'string' }], name: 'isUsernameTaken', outputs: [{ internalType: 'bool', name: '', type: 'bool' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ internalType: 'string', name: '_username', type: 'string' }], name: 'register', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ internalType: 'string', name: '_newUsername', type: 'string' }], name: 'updateUsername', outputs: [], stateMutability: 'nonpayable', type: 'function' },
] as const;

/** undefined on chains with no deployment — see getFactoryAddress for why. */
export function getRegistryAddress(chainId: number): `0x${string}` | undefined {
  return chainId === SEPOLIA_CHAIN_ID
    ? CONTRACT_ADDRESSES.sepolia.NexotiqRegistry as `0x${string}`
    : undefined;
}

export function useRegistry(userAddress: `0x${string}` | undefined) {
  const registryAddress = CONTRACT_ADDRESSES.sepolia.NexotiqRegistry as `0x${string}`;
  const onSupportedChain = true;
  const config = { address: registryAddress, abi: registryABI, chainId: SEPOLIA_CHAIN_ID } as const;

  const { data: username, refetch: refetchUsername, isLoading } = useReadContract({
    ...config,
    functionName: 'getUsername',
    args: userAddress ? [userAddress] : undefined,
    query: { enabled: !!userAddress && onSupportedChain },
  });

  const { ensureSepolia, networkReady, isSwitching, error: networkError } = useSepoliaNetwork();
  const write = useWriteContract();
  const { data: txHash, writeContractAsync, isPending, error: writeError } = write;
  const txReceipt = useWaitForTransactionReceipt({ hash: txHash, chainId: SEPOLIA_CHAIN_ID });

  const guardedWrite = async (name: string, functionName: 'register' | 'updateUsername') => {
    try {
      await ensureSepolia();
      return await writeContractAsync({
        ...config,
        address: CONTRACT_ADDRESSES.sepolia.NexotiqRegistry as `0x${string}`,
        functionName,
        args: [name],
      });
    } catch {
      return undefined;
    }
  };

  return {
    username: username as string | undefined,
    isLoading,
    onSupportedChain,
    registryAddress,
    config,
    networkReady,
    isSwitching,
    isPending: isPending || txReceipt.isLoading || isSwitching,
    txReceipt,
    error: networkError ?? writeError,
    refetchUsername,
    register: (name: string) => guardedWrite(name, 'register'),
    updateUsername: (name: string) => guardedWrite(name, 'updateUsername'),
  };
}
