import { createPublicClient, http, fallback } from 'viem';
import { sepolia } from 'viem/chains';
import { SEPOLIA_CHAIN_ID } from './contracts/addresses';

const envRpc = typeof process !== 'undefined'
  ? (process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || process.env.SEPOLIA_RPC_URL)?.trim()
  : undefined;

const rpcTransports = [
  ...(envRpc ? [http(envRpc, { timeout: 8_000, retryCount: 2 })] : []),
  http('https://ethereum-sepolia-rpc.publicnode.com', { timeout: 6_000, retryCount: 1 }),
  http('https://11155111.rpc.thirdweb.com', { timeout: 6_000, retryCount: 1 }),
  http('https://gateway.tenderly.co/public/sepolia', { timeout: 6_000, retryCount: 1 }),
];

/** Canonical client for all imperative Synq application reads with resilient, bounded public RPC fallback. */
export const sepoliaPublicClient = createPublicClient({
  chain: sepolia,
  transport: fallback(rpcTransports, { rank: false, retryCount: 0 }),
});

/** Explorer URLs for Synq application data are always Ethereum Sepolia. */
export function getSepoliaExplorerUrl(type: 'tx' | 'address', hash: string): string {
  return `${sepolia.blockExplorers.default.url}/${type}/${hash}`;
}

export { SEPOLIA_CHAIN_ID };
