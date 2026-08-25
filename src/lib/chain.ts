import { createPublicClient, http } from 'viem';
import { hardhat, sepolia } from 'viem/chains';

export function getPublicClient(chainId: number) {
  if (chainId === 11155111) return createPublicClient({ chain: sepolia, transport: http('https://ethereum-sepolia-rpc.publicnode.com') });
  if (chainId === 31337) return createPublicClient({ chain: hardhat, transport: http('http://127.0.0.1:8545') });
  return undefined;
}

export function getExplorerUrl(chainId: number, type: 'tx' | 'address', hash: string): string | null {
  if (chainId === 11155111) return `https://sepolia.etherscan.io/${type}/${hash}`;
  if (chainId === 31337) return null;
  return null;
}
