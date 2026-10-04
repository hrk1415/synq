'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { useSidebar } from '@/context/SidebarContext';
import Sidebar from '@/components/layout/Sidebar';
import WalletStatus from '@/components/layout/WalletStatus';
import EmailBindModal from '@/components/shared/EmailBindModal';
import { cn } from '@/lib/utils';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { collapsed } = useSidebar();

  if (pathname === '/') {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen relative">
      <Sidebar />
      <EmailBindModal />
      <div className="fixed top-4 right-4 z-30 flex items-center gap-2">
        <WalletStatus />
      </div>
      <main
        className={cn(
          'min-h-screen transition-all duration-300 ease-in-out',
          collapsed ? 'lg:pl-[68px]' : 'lg:pl-[240px]'
        )}
      >
        <div className="max-w-7xl mx-auto p-4 md:p-6 lg:p-8 pt-20 lg:pt-8">
          {children}
        </div>
      </main>
    </div>
  );
}
