'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { cn, shortenAddress } from '@/lib/utils';
import {
  Brain,
  FileCheck,
  MessageSquare,
  User,
  HelpCircle,
  ChevronLeft,
  ChevronRight,
  Menu,
  X,
  Store,
  ArrowLeftRight,
  Settings,
  Info,
  Zap,
} from 'lucide-react';

import { useSidebar } from '@/context/SidebarContext';
import { useAccount } from 'wagmi';
import { useSynqIdentity } from '@/hooks/useSynqIdentity';
import { Avatar } from '@/components/shared/Avatar';

const navItems = [
  { icon: Brain, label: 'AI Negotiator', href: '/negotiator' },
  { icon: Store, label: 'Deal Port', href: '/marketplace' },
  { icon: FileCheck, label: 'My Deals', href: '/deals' },
  // Living Protection (/protection) is intentionally not in the nav: the pool
  // deployed on Sepolia holds no ETH, so no claim it accepts can pay out. The
  // page still works if navigated to directly.
  { icon: MessageSquare, label: 'SynqChat', href: '/messages' },
  { icon: Zap, label: 'Agent Controller', href: '/agent-controller' },
  { icon: ArrowLeftRight, label: 'Swap', href: '/swap' },
];

function getScopedDisplayName(walletAddress?: string): string {
  if (typeof window === 'undefined' || !walletAddress) return '';
  try {
    const raw = window.localStorage.getItem(`settings:username:${walletAddress.toLowerCase()}`);
    return raw !== null && raw !== undefined ? (JSON.parse(raw) as string) : '';
  } catch { return ''; }
}

export default function Sidebar() {
  const pathname = usePathname();
  const { collapsed, setCollapsed, mobileOpen, setMobileOpen } = useSidebar();
  const [mounted, setMounted] = useState(false);
  const { address } = useAccount();
  const effectiveAddress = mounted ? address : undefined;
  const identity = useSynqIdentity(effectiveAddress);

  const [displayName, setDisplayName] = useState<string>('');
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!address) {
      setDisplayName('');
      setAvatarSrc(null);
      return;
    }

    let cancelled = false;
    setDisplayName(getScopedDisplayName(address));

    const load = () => {
      fetch('/api/profile/public', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallets: [address] }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          const profile = Array.isArray(d?.profiles) ? d.profiles[0] : null;
          if (profile?.avatar !== undefined) setAvatarSrc(profile.avatar || null);
          if (profile?.name !== undefined && profile.name !== null) {
            setDisplayName(profile.name);
            if (typeof window !== 'undefined') {
              try {
                window.localStorage.setItem(`settings:username:${address.toLowerCase()}`, JSON.stringify(profile.name));
              } catch { /* ignore */ }
            }
          }
        })
        .catch(() => {});
    };

    load();

    const onName = (e: Event) => {
      const detail = (e as CustomEvent<any>).detail;
      if (!address) return;
      if (typeof detail === 'object' && detail !== null) {
        if (detail.wallet && detail.wallet.toLowerCase() === address.toLowerCase()) {
          setDisplayName(detail.name || '');
        }
      } else if (typeof detail === 'string') {
        setDisplayName(detail);
      }
    };

    const onStorage = (e: StorageEvent) => {
      if (!address) return;
      const scopedKey = `settings:username:${address.toLowerCase()}`;
      if (e.key === scopedKey) {
        setDisplayName(getScopedDisplayName(address));
      }
    };

    window.addEventListener('synq:displayname', onName);
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', load);

    return () => {
      cancelled = true;
      window.removeEventListener('synq:displayname', onName);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', load);
    };
  }, [address]);

  // Click-outside & Escape key handling for popup menu
  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

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
          'fixed left-0 top-0 h-full bg-zinc-950 border-r border-white/10 z-40 flex flex-col transition-all duration-300',
          collapsed ? 'w-[68px]' : 'w-[240px]',
          'lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
      >
        <div className={cn("flex items-center h-16 border-b border-zinc-800/50 relative", collapsed ? "justify-center px-0" : "px-6")}>
          <Link href="/" className="flex items-center gap-3 outline-none">
            <img src="/synq-logo.png" alt="Synq" className="w-8 h-8 rounded-lg object-contain mix-blend-lighten" />
            {!collapsed && <span className="text-lg font-bold text-white tracking-tight">Synq</span>}
          </Link>
          
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="hidden lg:flex absolute -right-3 top-1/2 -translate-y-1/2 items-center justify-center w-6 h-6 rounded-full bg-zinc-900 border border-zinc-700 text-zinc-400 hover:text-white hover:bg-zinc-800 hover:border-zinc-500 transition-all shadow-md z-50"
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
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
                  collapsed && 'justify-center px-0',
                  isActive
                    ? 'bg-gradient-to-r from-blue-600 to-violet-600 text-white shadow-lg shadow-blue-600/25 border border-blue-500/30'
                    : 'text-zinc-400 hover:text-white hover:bg-gradient-to-r hover:from-blue-600/15 hover:to-violet-600/15 hover:border hover:border-blue-500/20'
                )}
              >
                <item.icon
                  size={18}
                  className={cn(
                    'shrink-0',
                    isActive ? 'text-white drop-shadow' : 'text-zinc-500 group-hover:text-blue-400 group-hover:drop-shadow'
                  )}
                />
                {!collapsed && <span className={cn('truncate', isActive && 'drop-shadow-sm')}>{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* BOTTOM IDENTITY CONTROL CONTAINER */}
        <div ref={menuRef} className="px-2 py-3 border-t border-zinc-800/50 relative">
          {/* POPUP MENU */}
          <AnimatePresence>
            {menuOpen && (
              <motion.div
                initial={{ opacity: 0, y: collapsed ? 0 : 8, x: collapsed ? 8 : 0, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
                exit={{ opacity: 0, y: collapsed ? 0 : 8, x: collapsed ? 8 : 0, scale: 0.96 }}
                transition={{ duration: 0.15 }}
                className={cn(
                  'absolute p-1.5 rounded-xl bg-zinc-900 border border-zinc-700/80 shadow-2xl z-50 space-y-0.5',
                  collapsed
                    ? 'bottom-1 left-full ml-3 w-44'
                    : 'bottom-full left-2 right-2 mb-2'
                )}
              >
                <div className="flex items-center justify-between px-3 py-2 text-xs font-medium text-zinc-500 rounded-lg cursor-not-allowed opacity-60">
                  <div className="flex items-center gap-2.5">
                    <Settings size={14} className="text-zinc-500" />
                    <span>Settings</span>
                  </div>
                  <span className="text-[9px] bg-zinc-800/80 text-zinc-400 px-1.5 py-0.5 rounded font-mono">
                    Soon
                  </span>
                </div>
                <Link
                  href="/help"
                  onClick={() => {
                    setMenuOpen(false);
                    setMobileOpen(false);
                  }}
                  className="flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-zinc-300 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                >
                  <HelpCircle size={14} className="text-zinc-400" />
                  <span>Help</span>
                </Link>
                <div className="flex items-center justify-between px-3 py-2 text-xs font-medium text-zinc-500 rounded-lg cursor-not-allowed opacity-60">
                  <div className="flex items-center gap-2.5">
                    <Info size={14} className="text-zinc-500" />
                    <span>About Us</span>
                  </div>
                  <span className="text-[9px] bg-zinc-800/80 text-zinc-400 px-1.5 py-0.5 rounded font-mono">
                    Soon
                  </span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {!collapsed ? (() => {
            const effectiveDisplayName = mounted ? displayName : '';
            const effectiveAvatarSrc = mounted ? avatarSrc : null;
            let primaryText = 'Guest User';
            let secondaryText: string | null = 'Connect wallet';

            if (effectiveAddress) {
              if (effectiveDisplayName && identity.displayHandle) {
                primaryText = effectiveDisplayName;
                secondaryText = identity.displayHandle;
              } else if (!effectiveDisplayName && identity.displayHandle) {
                primaryText = identity.displayHandle;
                secondaryText = null;
              } else if (effectiveDisplayName && !identity.displayHandle) {
                primaryText = effectiveDisplayName;
                secondaryText = identity.shortWallet;
              } else {
                primaryText = identity.shortWallet;
                secondaryText = null;
              }
            }

            return (
              /* EXPANDED IDENTITY CONTROL */
              <div className="flex items-center justify-between p-2 rounded-xl bg-zinc-900/80 border border-zinc-800/80 hover:border-zinc-700/80 transition-all">
                <Link
                  href="/settings"
                  onClick={() => setMobileOpen(false)}
                  className="flex items-center gap-3 min-w-0 flex-1 group outline-none"
                >
                  <Avatar
                    name={effectiveDisplayName || identity.handle || 'User'}
                    src={effectiveAvatarSrc}
                    size={42}
                    className="rounded-xl shrink-0"
                  />
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-sm font-bold text-white group-hover:text-blue-400 transition-colors truncate leading-tight">
                      {primaryText}
                    </span>
                    {secondaryText && (
                      <span className="text-xs font-mono text-zinc-400 truncate mt-0.5">
                        {secondaryText}
                      </span>
                    )}
                  </div>
                </Link>

                <div className="h-7 w-px bg-zinc-800/80 mx-1.5 shrink-0" />

                <button
                  type="button"
                  onClick={() => setMenuOpen(!menuOpen)}
                  className={cn(
                    'p-1.5 rounded-lg text-zinc-400 hover:text-white transition-colors shrink-0',
                    menuOpen ? 'bg-zinc-800 text-white' : 'hover:bg-zinc-800/80'
                  )}
                  aria-label="Account menu"
                >
                  <Menu size={16} />
                </button>
              </div>
            );
          })() : (() => {
            const effectiveDisplayName = mounted ? displayName : '';
            const effectiveAvatarSrc = mounted ? avatarSrc : null;
            return (
              /* COLLAPSED IDENTITY CONTROL (PFP) */
              <div className="flex justify-center">
                <div className="relative group">
                  <Link
                    href="/settings"
                    onClick={() => setMobileOpen(false)}
                    className="block outline-none"
                    title={effectiveDisplayName || identity.displayHandle || (effectiveAddress ? identity.shortWallet : 'Profile')}
                  >
                    <Avatar
                      name={effectiveDisplayName || identity.handle || 'User'}
                      src={effectiveAvatarSrc}
                      size={38}
                      className="rounded-xl border border-zinc-800 hover:border-blue-500/50 transition-all cursor-pointer"
                    />
                  </Link>
                  <button
                    type="button"
                    onClick={() => setMenuOpen(!menuOpen)}
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-zinc-400 hover:text-white transition-colors"
                    aria-label="Account menu"
                  >
                    <Menu size={10} />
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      </aside>
    </>
  );
}
