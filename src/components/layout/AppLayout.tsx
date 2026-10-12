'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import Sidebar from '@/components/layout/Sidebar';
import WalletStatus from '@/components/layout/WalletStatus';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Landing page exception: preserve existing background, animations, and appearance
  if (pathname === '/') {
    return <>{children}</>;
  }

  // Negotiator exception: preserve existing bg1 background and established styling
  const isNegotiator = pathname?.startsWith('/negotiator');
  const isMarketplace = pathname === '/marketplace';
  // All internal Synq pages receive bg2 except Negotiator (and Landing handled above)
  const useGlobalBg2 = !isNegotiator;

  return (
    <div
      className={`min-h-screen relative ${
        useGlobalBg2 ? 'bg-[#101010] bg-cover bg-center bg-no-repeat bg-fixed' : isMarketplace ? 'bg-[#101010]' : ''
      }`}
      style={
        useGlobalBg2
          ? {
              backgroundImage: 'url(/bg2.jpg)',
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat',
              backgroundAttachment: 'fixed',
            }
          : undefined
      }
    >
      <Sidebar />
      <div className="fixed top-4 right-4 z-30 flex items-center gap-2">
        <WalletStatus />
      </div>
      <main className="min-h-screen lg:pl-[68px]">
        <div className="max-w-7xl mx-auto p-4 md:p-6 lg:p-8 pt-20 lg:pt-8">
          {children}
        </div>
      </main>
    </div>
  );
}
