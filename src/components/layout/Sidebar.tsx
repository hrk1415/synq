'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Brain,
  FileCheck,
  ShieldCheck,
  Wallet,
  Activity,
  Settings,
  HelpCircle,
  ChevronLeft,
  ChevronRight,
  Menu,
  X,
  Zap,
  Store,
  ArrowLeftRight,
} from 'lucide-react';

const navItems = [
  { icon: LayoutDashboard, label: 'Overview', href: '/dashboard' },
  { icon: Brain, label: 'AI Negotiator', href: '/negotiator' },
  { icon: Store, label: 'Marketplace', href: '/marketplace' },
  { icon: FileCheck, label: 'My Deals', href: '/deals' },
  { icon: ShieldCheck, label: 'Escrow', href: '/escrow' },
  // Living Protection (/protection) is intentionally not in the nav: the pool
  // deployed on Sepolia holds no ETH, so no claim it accepts can pay out. The
  // page still works if navigated to directly.
  { icon: Wallet, label: 'ChatPay', href: '/chatpay' },
  { icon: ArrowLeftRight, label: 'Swap', href: '/swap' },
  { icon: Activity, label: 'Activity', href: '/activity' },
];

const bottomItems = [
  { icon: Settings, label: 'Settings', href: '/settings' },
  { icon: HelpCircle, label: 'Help', href: '/help' },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="lg:hidden fixed top-4 left-4 z-50 p-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white"
      >
        {mobileOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="lg:hidden fixed inset-0 bg-black/60 z-40"
            onClick={() => setMobileOpen(false)}
          />
        )}
      </AnimatePresence>

      <aside
        className={cn(
          'fixed left-0 top-0 h-full bg-zinc-950/50 border-r border-white/10 backdrop-blur-xl z-40 flex flex-col transition-all duration-300',
          collapsed ? 'w-[68px]' : 'w-[240px]',
          'lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
      >
        <div className="flex items-center justify-between px-4 h-16 border-b border-zinc-800/50">
          <Link href="/" className={cn('flex items-center gap-3', collapsed && 'justify-center w-full')}>
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center">
              <Zap size={18} className="text-white" />
            </div>
            {!collapsed && <span className="text-lg font-bold text-white tracking-tight">Synq</span>}
          </Link>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="hidden lg:flex p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group',
                  isActive
                    ? 'bg-gradient-to-r from-blue-600 to-violet-600 text-white shadow-lg shadow-blue-600/25 border border-blue-500/30'
                    : 'text-zinc-400 hover:text-white hover:bg-gradient-to-r hover:from-blue-600/15 hover:to-violet-600/15 hover:border hover:border-blue-500/20'
                )}
              >
                <item.icon
                  size={18}
                  className={cn(
                    isActive ? 'text-white drop-shadow' : 'text-zinc-500 group-hover:text-blue-400 group-hover:drop-shadow'
                  )}
                />
                {!collapsed && <span className={cn(isActive && 'drop-shadow-sm')}>{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        <div className="px-2 py-4 border-t border-zinc-800/50 space-y-1">
          {bottomItems.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200',
                  isActive
                    ? 'bg-gradient-to-r from-blue-600 to-violet-600 text-white shadow-lg shadow-blue-600/25 border border-blue-500/30'
                    : 'text-zinc-400 hover:text-white hover:bg-gradient-to-r hover:from-blue-600/15 hover:to-violet-600/15 hover:border hover:border-blue-500/20'
                )}
              >
                <item.icon
                  size={18}
                  className={cn(isActive ? 'text-white drop-shadow' : 'text-zinc-500 group-hover:text-blue-400')}
                />
                {!collapsed && <span className={cn(isActive && 'drop-shadow-sm')}>{item.label}</span>}
              </Link>
            );
          })}
        </div>
      </aside>
    </>
  );
}
