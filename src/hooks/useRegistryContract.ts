'use client';

import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useChainId } from 'wagmi';
import { CONTRACT_ADDRESSES, isSupportedChain } from '@/lib/contracts/addresses';

export const registryABI = [
  { inputs: [], stateMutability: 'nonpayable', type: 'constructor' },
  { inputs: [{ internalType: 'address', name: '', type: 'address' }], name: 'addressToUsername', outputs: [{ internalType: 'string', name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ internalType: 'address', name: '_user', type: 'address' }], name: 'getUsername', outputs: [{ internalType: 'string', name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ internalType: 'string', name: '_username', type: 'string' }], name: 'getAddress', outputs: [{ internalType: 'address', name: '', type: 'address' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ internalType: 'string', name: '_username', type: 'string' }], name: 'isUsernameTaken', outputs: [{ internalType: 'bool', name: '', type: 'bool' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ internalType: 'string', name: '_username', type: 'string' }], name: 'register', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [{ internalType: 'string', name: '_newUsername', type: 'string' }], name: 'updateUsername', outputs: [], stateMutability: 'nonpayable', type: 'function' },
] as const;

const REGISTRY_BY_CHAIN: Record<number, string> = {
  31337: CONTRACT_ADDRESSES.hardhat.NexotiqRegistry,
  11155111: CONTRACT_ADDRESSES.sepolia.NexotiqRegistry,
};

/** undefined on chains with no deployment — see getFactoryAddress for why. */
export function getRegistryAddress(chainId: number): `0x${string}` | undefined {
  return REGISTRY_BY_CHAIN[chainId] as `0x${string}` | undefined;
}

export function useRegistry(userAddress: `0x${string}` | undefined) {
  const chainId = useChainId();
  const registryAddress = getRegistryAddress(chainId);
  const onSupportedChain = isSupportedChain(chainId) && !!registryAddress;
  const config = { address: registryAddress, abi: registryABI } as const;

  const { data: username, refetch: refetchUsername, isLoading } = useReadContract({
    ...config,
    functionName: 'getUsername',
    args: userAddress ? [userAddress] : undefined,
    query: { enabled: !!userAddress && onSupportedChain },
  });

  const write = useWriteContract();
  const { data: txHash, writeContract, isPending, error: writeError } = write;
  const txReceipt = useWaitForTransactionReceipt({ hash: txHash });

  return {
    username: username as string | undefined,
    isLoading,
    onSupportedChain,
    registryAddress,
    config,
    writeContract,
    isPending: isPending || txReceipt.isLoading,
    txReceipt,
    error: writeError,
    refetchUsername,
    register: (name: string) => {
      if (!onSupportedChain) return;
      writeContract({ ...config, address: registryAddress!, functionName: 'register', args: [name] });
    },
    updateUsername: (name: string) => {
      if (!onSupportedChain) return;
      writeContract({ ...config, address: registryAddress!, functionName: 'updateUsername', args: [name] });
    },
  };
}
