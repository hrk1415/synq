import { createPublicClient, http, fallback } from 'viem';
import { sepolia } from 'viem/chains';
import { SEPOLIA_CHAIN_ID } from './contracts/addresses';

const envRpc = typeof process !== 'undefined'
  ? (process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || process.env.SEPOLIA_RPC_URL)?.trim()
  : undefined;

const rpcTransports = [
  ...(envRpc ? [http(envRpc, { batch: true, timeout: 8_000, retryCount: 2 })] : []),
  http('https://ethereum-sepolia-rpc.publicnode.com', { batch: true, timeout: 8_000, retryCount: 2 }),
  http('https://11155111.rpc.thirdweb.com', { batch: true, timeout: 8_000, retryCount: 2 }),
  http('https://gateway.tenderly.co/public/sepolia', { batch: true, timeout: 8_000, retryCount: 2 }),
];

/** Canonical client for all imperative Synq application reads with resilient public RPC fallback and request batching. */
export const sepoliaPublicClient = createPublicClient({
  chain: sepolia,
  transport: fallback(rpcTransports, { rank: false }),
});

/** Explorer URLs for Synq application data are always Ethereum Sepolia. */
export function getSepoliaExplorerUrl(type: 'tx' | 'address', hash: string): string {
  return `${sepolia.blockExplorers.default.url}/${type}/${hash}`;
}

export { SEPOLIA_CHAIN_ID };
