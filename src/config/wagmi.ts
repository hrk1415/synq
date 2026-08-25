import { http, createConfig } from 'wagmi';
import { mainnet, sepolia, base, hardhat } from 'wagmi/chains';
import { injected, walletConnect, coinbaseWallet } from 'wagmi/connectors';

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '';

// Sepolia first: chains[0] is what wagmi reads from when no wallet is connected,
// and Sepolia is the only network Synq contracts are deployed on. Mainnet and Base
// stay listed so a wallet already on them can connect and be told to switch —
// see ChainGuard — instead of silently reading a chain with no contracts.
export const wagmiConfig = createConfig({
  chains: [sepolia, hardhat, mainnet, base],
  connectors: [
    injected(),
    coinbaseWallet({ appName: 'Synq' }),
    ...(projectId ? [walletConnect({ projectId })] : []),
  ],
  transports: {
    [sepolia.id]: http(),
    [hardhat.id]: http(),
    [mainnet.id]: http(),
    [base.id]: http(),
  },
});
