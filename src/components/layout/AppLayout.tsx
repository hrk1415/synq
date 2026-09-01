'use client';

import React from 'react';
import { useSidebar } from '@/context/SidebarContext';
import Sidebar from '@/components/layout/Sidebar';
import WalletStatus from '@/components/layout/WalletStatus';
import EmailBindModal from '@/components/shared/EmailBindModal';
import { cn } from '@/lib/utils';
import { usePathname } from 'next/navigation';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { collapsed } = useSidebar();
  const pathname = usePathname();
  const isDashboard = pathname === '/dashboard';

  return (
    <div className={cn('min-h-screen relative', isDashboard && 'bg-[#070709]')}>
      <Sidebar />
      <EmailBindModal />
      <div className="fixed top-4 right-4 z-30 flex items-center gap-2">
        <WalletStatus />
      </div>
      <main
        className={cn(
          'min-h-screen transition-all duration-300 ease-in-out',
          isDashboard ? 'bg-[#070709]' : '',
          collapsed ? 'lg:pl-[68px]' : 'lg:pl-[240px]'
        )}
      >
        {isDashboard ? (
          <div className="w-full h-screen overflow-hidden flex items-center justify-center relative">
            {children}
          </div>
        ) : (
          <div className="max-w-7xl mx-auto p-4 md:p-6 lg:p-8 pt-20 lg:pt-8">
            {children}
          </div>
        )}
      </main>
    </div>
  );
}
