'use client';

import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { wagmiConfig } from '@/config/wagmi';
import { SidebarProvider } from '@/context/SidebarContext';

const queryClient = new QueryClient();

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          {children}
        </SidebarProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
