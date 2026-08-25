'use client';

import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useChainId } from 'wagmi';
import { nexotiqDirectoryABI } from '@/lib/contracts/abis';
import { CONTRACT_ADDRESSES, isSupportedChain } from '@/lib/contracts/addresses';

const DIRECTORY_BY_CHAIN: Record<number, string> = {
  31337: CONTRACT_ADDRESSES.hardhat.NexotiqDirectory,
  11155111: CONTRACT_ADDRESSES.sepolia.NexotiqDirectory,
};

/** undefined on chains with no deployment — see getFactoryAddress for why. */
export function getDirectoryAddress(chainId: number): `0x${string}` | undefined {
  return DIRECTORY_BY_CHAIN[chainId] as `0x${string}` | undefined;
}

export function useDirectoryContract(userAddress: `0x${string}` | undefined) {
  const chainId = useChainId();
  const directoryAddress = getDirectoryAddress(chainId);
  const onSupportedChain = isSupportedChain(chainId) && !!directoryAddress;
  const config = { address: directoryAddress, abi: nexotiqDirectoryABI } as const;

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

  const write = useWriteContract();
  const { data: txHash, writeContract, isPending, error: writeError } = write;
  const txReceipt = useWaitForTransactionReceipt({ hash: txHash });

  const refetchAll = () => { refetchProfiles(); refetchMyProfile(); };

  const guardWrite = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
    if (!onSupportedChain) return;
    fn(...args);
  };

  return {
    directoryAddress,
    onSupportedChain,
    config,
    profiles: profiles as any[] | undefined,
    myProfile: (myProfile as any) || undefined,
    myRegistered: !!myRegistered,
    isLoading,
    writeContract,
    isPending: isPending || txReceipt.isLoading,
    txReceipt,
    writeError,
    refetchProfiles,
    refetchMyProfile,
    refetchAll,
    registerProfile: guardWrite((name: string, category: string, skills: string[], rate: bigint, bio: string) =>
      writeContract({ ...config, address: directoryAddress!, functionName: 'registerProfile', args: [name, category, skills, rate, bio] })),
    updateProfile: guardWrite((name: string, category: string, skills: string[], rate: bigint, bio: string) =>
      writeContract({ ...config, address: directoryAddress!, functionName: 'updateProfile', args: [name, category, skills, rate, bio] })),
    setAvailable: guardWrite((available: boolean) =>
      writeContract({ ...config, address: directoryAddress!, functionName: 'setAvailable', args: [available] })),
  };
}
