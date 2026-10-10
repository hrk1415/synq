import { http, createConfig, fallback } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { injected, walletConnect, coinbaseWallet } from 'wagmi/connectors';

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '';
const envRpc = typeof process !== 'undefined'
  ? (process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || process.env.SEPOLIA_RPC_URL)?.trim()
  : undefined;

const rpcTransports = [
  ...(envRpc ? [http(envRpc, { batch: true })] : []),
  http('https://ethereum-sepolia-rpc.publicnode.com', { batch: true }),
  http('https://11155111.rpc.thirdweb.com', { batch: true }),
  http('https://gateway.tenderly.co/public/sepolia', { batch: true }),
];

// Synq's application data and transactions are Sepolia-only. Connectors may
// still report a wallet that is physically selected to another EVM chain; that
// connection is handled as connected-but-not-network-ready by useSepoliaNetwork.
export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [
    injected(),
    coinbaseWallet({ appName: 'Synq' }),
    ...(projectId ? [walletConnect({ projectId })] : []),
  ],
  transports: {
    [sepolia.id]: fallback(rpcTransports),
  },
});
