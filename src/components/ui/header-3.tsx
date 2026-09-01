'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Zap,
  LayoutDashboard,
  Brain,
  Store,
  FileCheck,
  ShieldCheck,
  Wallet,
  ArrowLeftRight,
  Activity,
  User,
  HelpCircle,
  Menu,
  X,
  ChevronDown,
  Sparkles,
  ExternalLink,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import WalletStatus from '@/components/layout/WalletStatus';

interface NavItem {
  label: string;
  href: string;
  icon?: React.ElementType;
  badge?: string;
}

interface HeaderProps {
  className?: string;
  navItems?: NavItem[];
}

const defaultNavItems: NavItem[] = [
  { label: 'Overview', href: '/dashboard', icon: LayoutDashboard },
  { label: 'AI Negotiator', href: '/negotiator', icon: Brain, badge: 'AI' },
  { label: 'Deal Port', href: '/marketplace', icon: Store },
  { label: 'My Deals', href: '/deals', icon: FileCheck },
  { label: 'Escrow', href: '/escrow', icon: ShieldCheck },
  { label: 'ChatPay', href: '/chatpay', icon: Wallet },
  { label: 'Swap', href: '/swap', icon: ArrowLeftRight },
  { label: 'Activity', href: '/activity', icon: Activity },
];

export function Header({ className, navItems = defaultNavItems }: HeaderProps) {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 15);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  return (
    <header
      className={cn(
        'sticky top-0 left-0 right-0 z-50 w-full transition-all duration-300',
        scrolled
          ? 'bg-zinc-950/80 backdrop-blur-xl border-b border-white/10 shadow-lg shadow-black/40 py-2.5'
          : 'bg-zinc-950/40 backdrop-blur-md border-b border-white/5 py-3.5',
        className
      )}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between">
        {/* Left: Brand Logo */}
        <Link
          href="/dashboard"
          className="flex items-center gap-2.5 group focus:outline-none"
        >
          <img src="/synq-logo.png" alt="Synq" className="w-9 h-9 rounded-xl object-contain mix-blend-lighten group-hover:scale-105 transition-transform" />
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="text-lg font-bold text-white tracking-tight group-hover:text-indigo-200 transition-colors">
                Synq
              </span>
              <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded-full">
                OS
              </span>
            </div>
          </div>
        </Link>

        {/* Center: Desktop Navigation Links */}
        <nav
          className="hidden xl:flex items-center gap-1 bg-zinc-900/60 p-1.5 rounded-full border border-white/10 backdrop-blur-md"
          onMouseLeave={() => setHoveredIndex(null)}
        >
          {navItems.map((item, index) => {
            const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href));
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                onMouseEnter={() => setHoveredIndex(index)}
                className={cn(
                  'relative px-3.5 py-1.5 text-xs font-medium rounded-full transition-all duration-200 flex items-center gap-1.5 select-none',
                  isActive
                    ? 'text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                )}
              >
                {/* Hover Background Pill */}
                {hoveredIndex === index && (
                  <motion.span
                    layoutId="headerHoverPill"
                    className="absolute inset-0 bg-white/10 rounded-full"
                    transition={{ type: 'spring', bounce: 0.2, duration: 0.3 }}
                  />
                )}

                {/* Active Indicator Pill */}
                {isActive && (
                  <motion.span
                    layoutId="headerActivePill"
                    className="absolute inset-0 bg-gradient-to-r from-blue-600/30 to-violet-600/30 border border-blue-500/40 rounded-full shadow-sm shadow-blue-500/20"
                    transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
                  />
                )}

                <span className="relative z-10 flex items-center gap-1.5">
                  {Icon && <Icon size={14} className={isActive ? 'text-blue-400' : 'text-zinc-400'} />}
                  {item.label}
                  {item.badge && (
                    <span className="text-[9px] px-1 py-0.2 bg-blue-500/20 text-blue-300 rounded-full font-bold">
                      {item.badge}
                    </span>
                  )}
                </span>
              </Link>
            );
          })}
        </nav>

        {/* Right: Actions & Tools */}
        <div className="flex items-center gap-2.5">
          <WalletStatus />

          {/* Mobile Menu Toggle Button */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="xl:hidden p-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors focus:outline-none"
            aria-label="Toggle Menu"
          >
            {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {/* Mobile Drawer / Dropdown Menu */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="xl:hidden border-t border-white/10 bg-zinc-950/95 backdrop-blur-2xl overflow-hidden"
          >
            <div className="max-w-7xl mx-auto px-4 py-4 space-y-1">
              {navItems.map((item) => {
                const isActive = pathname === item.href;
                const Icon = item.icon;

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      'flex items-center justify-between px-4 py-2.5 rounded-xl text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                        : 'text-zinc-300 hover:bg-zinc-900 hover:text-white'
                    )}
                  >
                    <div className="flex items-center gap-3">
                      {Icon && <Icon size={18} className={isActive ? 'text-blue-400' : 'text-zinc-400'} />}
                      <span>{item.label}</span>
                    </div>
                    {item.badge && (
                      <span className="text-[10px] px-2 py-0.5 bg-blue-500/20 text-blue-300 rounded-full font-semibold border border-blue-500/30">
                        {item.badge}
                      </span>
                    )}
                  </Link>
                );
              })}

              <div className="pt-3 mt-2 border-t border-zinc-800 flex items-center justify-between px-2 text-xs text-zinc-400">
                <Link href="/settings" className="flex items-center gap-2 hover:text-white py-1">
                  <User size={15} />
                  <span>Profile & Settings</span>
                </Link>
                <Link href="/help" className="flex items-center gap-2 hover:text-white py-1">
                  <HelpCircle size={15} />
                  <span>Help Center</span>
                </Link>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}

export default Header;
