import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { SEPOLIA_CHAIN_ID } from './contracts/addresses';

/** Canonical client for all imperative Synq application reads. */
export const sepoliaPublicClient = createPublicClient({
  chain: sepolia,
  transport: http('https://ethereum-sepolia-rpc.publicnode.com'),
});

/** Explorer URLs for Synq application data are always Ethereum Sepolia. */
export function getSepoliaExplorerUrl(type: 'tx' | 'address', hash: string): string {
  return `${sepolia.blockExplorers.default.url}/${type}/${hash}`;
}

export { SEPOLIA_CHAIN_ID };
