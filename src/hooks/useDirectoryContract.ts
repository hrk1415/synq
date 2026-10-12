'use client';

import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { nexotiqDirectoryABI } from '@/lib/contracts/abis';
import { CONTRACT_ADDRESSES, SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';

/** undefined on chains with no deployment — see getFactoryAddress for why. */
export function getDirectoryAddress(chainId: number): `0x${string}` | undefined {
  return chainId === SEPOLIA_CHAIN_ID
    ? CONTRACT_ADDRESSES.sepolia.NexotiqDirectory as `0x${string}`
    : undefined;
}

export function useDirectoryContract(userAddress: `0x${string}` | undefined) {
  const directoryAddress = CONTRACT_ADDRESSES.sepolia.NexotiqDirectory as `0x${string}`;
  const onSupportedChain = true;
  const config = { address: directoryAddress, abi: nexotiqDirectoryABI, chainId: SEPOLIA_CHAIN_ID } as const;

  const { data: profiles, refetch: refetchProfiles, isLoading } = useReadContract({
    ...config,
    functionName: 'getAllProfiles',
    query: { enabled: onSupportedChain },
  });
  const { data: myProfile, refetch: refetchMyProfile } = useReadContract({
    ...config,
    functionName: 'getProfile',
    args: userAddress ? [userAddress] : undefined,
    query: { enabled: !!userAddress && onSupportedChain },
  });
  const { data: myRegistered } = useReadContract({
    ...config,
    functionName: 'isRegistered',
    args: userAddress ? [userAddress] : undefined,
    query: { enabled: !!userAddress && onSupportedChain },
  });

  const { ensureSepolia, networkReady, isSwitching, error: networkError } = useSepoliaNetwork();
  const write = useWriteContract();
  const { data: txHash, writeContractAsync, isPending, error: writeError } = write;
  const txReceipt = useWaitForTransactionReceipt({ hash: txHash, chainId: SEPOLIA_CHAIN_ID });

  const refetchAll = () => { refetchProfiles(); refetchMyProfile(); };

  const guardWrite = <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) => async (...args: A) => {
    try {
      await ensureSepolia();
      return await fn(...args);
    } catch {
      return undefined;
    }
  };
  const writeAddress = CONTRACT_ADDRESSES.sepolia.NexotiqDirectory as `0x${string}`;

  return {
    directoryAddress,
    onSupportedChain,
    config,
    profiles: profiles as any[] | undefined,
    myProfile: (myProfile as any) || undefined,
    myRegistered: !!myRegistered,
    isLoading,
    networkReady,
    isSwitching,
    isPending: isPending || txReceipt.isLoading || isSwitching,
    txReceipt,
    writeError: networkError ?? writeError,
    networkError,
    refetchProfiles,
    refetchMyProfile,
    refetchAll,
    registerProfile: guardWrite((name: string, category: string, skills: string[], rate: bigint, bio: string) =>
      writeContractAsync({ ...config, address: writeAddress, functionName: 'registerProfile', args: [name, category, skills, rate, bio] })),
    updateProfile: guardWrite((name: string, category: string, skills: string[], rate: bigint, bio: string) =>
      writeContractAsync({ ...config, address: writeAddress, functionName: 'updateProfile', args: [name, category, skills, rate, bio] })),
    setAvailable: guardWrite((available: boolean) =>
      writeContractAsync({ ...config, address: writeAddress, functionName: 'setAvailable', args: [available] })),
  };
}
