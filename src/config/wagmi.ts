import { http, createConfig } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { injected, walletConnect, coinbaseWallet } from 'wagmi/connectors';

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '';

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
    [sepolia.id]: http(),
  },
});
