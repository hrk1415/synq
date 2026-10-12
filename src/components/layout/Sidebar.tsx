'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import {
  Brain,
  FileCheck,
  MessageSquare,
  User,
  HelpCircle,
  Menu,
  X,
  Store,
  LayoutGrid,
  Settings,
  Info,
} from 'lucide-react';
import { Press_Start_2P } from 'next/font/google';

const pressStart2P = Press_Start_2P({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

import { useSidebar } from '@/context/SidebarContext';
import { useAccount } from 'wagmi';
import { useSynqIdentity } from '@/hooks/useSynqIdentity';
import { Avatar } from '@/components/shared/Avatar';

export interface NavItem {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  href: string;
}

export const navItems: NavItem[] = [
  { icon: Brain, label: 'Negotiator', href: '/negotiator' },
  { icon: Store, label: 'Deal Port', href: '/marketplace' },
  { icon: FileCheck, label: 'My Deals', href: '/deals' },
  // Living Protection (/protection) is intentionally not in the nav: the pool
  // deployed on Sepolia holds no ETH, so no claim it accepts can pay out. The
  // page still works if navigated to directly.
  { icon: MessageSquare, label: 'SynqChat', href: '/messages' },
  { icon: LayoutGrid, label: 'Hub', href: '/hub' },
];

export function isNavItemActive(itemHref: string, currentPathname: string | null | undefined): boolean {
  if (!currentPathname) return false;
  if (itemHref === '/hub') {
    return (
      currentPathname === '/hub' ||
      currentPathname.startsWith('/hub/') ||
      currentPathname === '/agent-controller' ||
      currentPathname.startsWith('/agent-controller/') ||
      currentPathname === '/swap' ||
      currentPathname.startsWith('/swap/')
    );
  }
  return currentPathname === itemHref;
}

function getScopedDisplayName(walletAddress?: string): string {
  if (typeof window === 'undefined' || !walletAddress) return '';
  try {
    const raw = window.localStorage.getItem(`settings:username:${walletAddress.toLowerCase()}`);
    return raw !== null && raw !== undefined ? (JSON.parse(raw) as string) : '';
  } catch { return ''; }
}

export default function Sidebar() {
  const pathname = usePathname();
  const { mobileOpen, setMobileOpen } = useSidebar();
  const [mounted, setMounted] = useState(false);
  const { address } = useAccount();
  const effectiveAddress = mounted ? address : undefined;
  const identity = useSynqIdentity(effectiveAddress);

  const [displayName, setDisplayName] = useState<string>('');
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Expanded on desktop if hovered, keyboard focused, or account menu open
  const isExpandedDesktop = isHovered || isFocused || menuOpen;
  const isExpanded = mobileOpen || (mounted && isExpandedDesktop);

  const handleMouseEnter = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    hoverTimeoutRef.current = setTimeout(() => {
      const isActuallyHovered = sidebarRef.current?.matches(':hover') ?? false;
      setIsHovered(isActuallyHovered);
      // Clear focus if no element has keyboard focus-visible
      const hasKeyboardFocus = !!sidebarRef.current?.querySelector(':focus-visible');
      if (!hasKeyboardFocus) {
        setIsFocused(false);
      }
    }, 150);
  };

  const handleFocusCapture = (e: React.FocusEvent) => {
    // Only treat as focused if focus was activated via keyboard navigation (:focus-visible)
    if ((e.target as HTMLElement)?.matches?.(':focus-visible')) {
      setIsFocused(true);
    }
  };

  const handleBlurCapture = (e: React.FocusEvent) => {
    if (!sidebarRef.current?.contains(e.relatedTarget as Node)) {
      setIsFocused(false);
    }
  };

  useEffect(() => {
    setMounted(true);
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  // Synchronize collapse state on route navigation
  useEffect(() => {
    setMenuOpen(false);
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }

    // Clear stale click focus from navigation items
    if (sidebarRef.current?.contains(document.activeElement)) {
      const activeEl = document.activeElement as HTMLElement;
      if (!activeEl.matches(':focus-visible')) {
        activeEl.blur();
      }
    }

    if (sidebarRef.current) {
      const isActuallyHovered = sidebarRef.current.matches(':hover');
      const hasKeyboardFocus = !!sidebarRef.current.querySelector(':focus-visible');
      setIsHovered(isActuallyHovered);
      setIsFocused(hasKeyboardFocus);
    } else {
      setIsHovered(false);
      setIsFocused(false);
    }
  }, [pathname]);

  // Global pointer tracking to ensure sidebar collapses when cursor leaves boundaries after route change
  useEffect(() => {
    const handleGlobalPointerMove = (e: PointerEvent) => {
      if (!sidebarRef.current || !isExpandedDesktop || mobileOpen) return;

      const rect = sidebarRef.current.getBoundingClientRect();
      const isInside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;

      if (!isInside) {
        const hasKeyboardFocus = !!sidebarRef.current.querySelector(':focus-visible');
        if (!menuOpen && !hasKeyboardFocus) {
          setIsHovered(false);
          setIsFocused(false);
        }
      }
    };

    window.addEventListener('pointermove', handleGlobalPointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', handleGlobalPointerMove);
  }, [isExpandedDesktop, mobileOpen, menuOpen]);

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

  // Click-outside & Escape key handling for popup menu and mobile drawer
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuOpen && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (menuOpen) setMenuOpen(false);
        if (mobileOpen) setMobileOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen, mobileOpen, setMobileOpen]);

  return (
    <>
      {/* Mobile Toggle Button */}
      <button
        type="button"
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label={mobileOpen ? 'Close navigation menu' : 'Open navigation menu'}
        className="lg:hidden fixed top-4 left-4 z-50 p-2 rounded-lg bg-[#1B1B1B] border border-[#303030] text-zinc-400 hover:text-white transition-colors"
      >
        {mobileOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      {/* Mobile Backdrop */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="lg:hidden fixed inset-0 bg-black/70 z-40"
            onClick={() => setMobileOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Shared Navigation Sidebar */}
      <aside
        ref={sidebarRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onFocusCapture={handleFocusCapture}
        onBlurCapture={handleBlurCapture}
        className={cn(
          'fixed left-0 top-0 h-full bg-[#101010] border-r border-[#303030] z-40 flex flex-col',
          'transition-[width,transform] duration-200 ease-out motion-reduce:transition-none',
          isExpanded ? 'w-[240px] shadow-2xl' : 'w-[68px]',
          'lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
      >
        {/* Brand Header */}
        <div
          className={cn(
            'flex items-center h-16 border-b border-[#252525] shrink-0',
            isExpanded ? 'px-5' : 'justify-center px-0'
          )}
        >
          <Link
            href="/"
            onClick={(e) => {
              setMobileOpen(false);
              (e.currentTarget as HTMLElement)?.blur();
            }}
            className="flex items-center gap-3.5 outline-none group"
            title="Synq"
          >
            <img
              src="/newlogopng.png"
              alt="Synq"
              className="w-9 h-9 rounded-lg object-contain shrink-0"
            />
            {isExpanded && (
              <span
                className={cn(
                  pressStart2P.className,
                  'text-base font-normal text-white tracking-tight text-[19px] leading-none'
                )}
              >
                Synq
              </span>
            )}
          </Link>
        </div>

        {/* Navigation Items */}
        <nav className="flex-1 px-2.5 py-4 space-y-1.5 overflow-y-auto overflow-x-hidden">
          {navItems.map((item) => {
            const isActive = isNavItemActive(item.href, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={(e) => {
                  setMobileOpen(false);
                  (e.currentTarget as HTMLElement)?.blur();
                }}
                title={item.label}
                aria-label={item.label}
                className={cn(
                  'flex items-center h-14 rounded-xl font-medium transition-all duration-150 group outline-none',
                  isExpanded ? 'px-3 gap-4' : 'justify-center px-0 w-full',
                  isActive
                    ? 'bg-white text-[#101010] shadow-sm font-semibold'
                    : 'text-zinc-400 hover:text-white hover:bg-white/10'
                )}
              >
                <item.icon
                  size={24}
                  className={cn(
                    'shrink-0 transition-colors',
                    isActive ? 'text-[#101010]' : 'text-zinc-400 group-hover:text-white'
                  )}
                />
                {isExpanded && (
                  <span
                    className={cn(
                      'truncate text-[14px] font-normal tracking-tight leading-none',
                      pressStart2P.className,
                      isActive ? 'text-[#101010]' : 'text-zinc-400 group-hover:text-white'
                    )}
                  >
                    {item.label}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Bottom Identity Control Container */}
        <div ref={menuRef} className="px-2.5 py-3 border-t border-[#252525] relative shrink-0">
          {/* Popup Menu */}
          <AnimatePresence>
            {menuOpen && (
              <motion.div
                initial={{ opacity: 0, y: isExpanded ? 8 : 0, x: isExpanded ? 0 : 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
                exit={{ opacity: 0, y: isExpanded ? 8 : 0, x: isExpanded ? 0 : 8, scale: 0.96 }}
                transition={{ duration: 0.15 }}
                className={cn(
                  'absolute p-1.5 rounded-xl bg-[#1B1B1B] border border-[#383838] shadow-2xl z-50 space-y-0.5',
                  isExpanded
                    ? 'bottom-full left-2 right-2 mb-2'
                    : 'bottom-1 left-full ml-3 w-44'
                )}
              >
                <Link
                  href="/profile"
                  onClick={(e) => {
                    setMenuOpen(false);
                    setMobileOpen(false);
                    (e.currentTarget as HTMLElement)?.blur();
                  }}
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors',
                    pathname === '/profile'
                      ? 'bg-white text-[#101010] font-semibold'
                      : 'text-zinc-300 hover:text-white hover:bg-[#252525]'
                  )}
                >
                  <User size={14} className={pathname === '/profile' ? 'text-[#101010]' : 'text-zinc-400'} />
                  <span>Profile</span>
                </Link>
                <Link
                  href="/settings"
                  onClick={(e) => {
                    setMenuOpen(false);
                    setMobileOpen(false);
                    (e.currentTarget as HTMLElement)?.blur();
                  }}
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors',
                    pathname === '/settings'
                      ? 'bg-white text-[#101010] font-semibold'
                      : 'text-zinc-300 hover:text-white hover:bg-[#252525]'
                  )}
                >
                  <Settings size={14} className={pathname === '/settings' ? 'text-[#101010]' : 'text-zinc-400'} />
                  <span>Settings</span>
                </Link>
                <Link
                  href="/help"
                  onClick={(e) => {
                    setMenuOpen(false);
                    setMobileOpen(false);
                    (e.currentTarget as HTMLElement)?.blur();
                  }}
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors',
                    pathname === '/help'
                      ? 'bg-white text-[#101010] font-semibold'
                      : 'text-zinc-300 hover:text-white hover:bg-[#252525]'
                  )}
                >
                  <HelpCircle size={14} className={pathname === '/help' ? 'text-[#101010]' : 'text-zinc-400'} />
                  <span>Help</span>
                </Link>
                <div className="flex items-center justify-between px-3 py-2 text-xs font-medium text-zinc-500 rounded-lg cursor-not-allowed opacity-60">
                  <div className="flex items-center gap-2.5">
                    <Info size={14} className="text-zinc-500" />
                    <span>About Us</span>
                  </div>
                  <span className="text-[9px] bg-[#252525] border border-[#383838] text-zinc-400 px-1.5 py-0.5 rounded font-mono">
                    Soon
                  </span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {isExpanded ? (() => {
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
              <div className="flex items-center justify-between p-2 rounded-xl bg-white border border-zinc-200 shadow-sm transition-all">
                <Link
                  href="/profile"
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
                    <span className="text-sm font-bold text-[#101010] group-hover:text-zinc-700 transition-colors truncate leading-tight">
                      {primaryText}
                    </span>
                    {secondaryText && (
                      <span className="text-xs font-mono text-zinc-500 truncate mt-0.5">
                        {secondaryText}
                      </span>
                    )}
                  </div>
                </Link>

                <div className="h-7 w-px bg-zinc-200 mx-1.5 shrink-0" />

                <button
                  type="button"
                  onClick={() => setMenuOpen(!menuOpen)}
                  className={cn(
                    'p-1.5 rounded-lg text-[#101010] transition-colors shrink-0',
                    menuOpen ? 'bg-zinc-200 text-[#101010]' : 'hover:bg-zinc-100 text-zinc-700 hover:text-[#101010]'
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
                <Link
                  href="/profile"
                  onClick={() => setMobileOpen(false)}
                  className="block outline-none"
                  title={effectiveDisplayName || identity.displayHandle || (effectiveAddress ? identity.shortWallet : 'Profile')}
                >
                  <Avatar
                    name={effectiveDisplayName || identity.handle || 'User'}
                    src={effectiveAvatarSrc}
                    size={42}
                    className="rounded-xl transition-all cursor-pointer hover:ring-2 hover:ring-white/40 shadow-sm"
                  />
                </Link>
              </div>
            );
          })()}
        </div>
      </aside>
    </>
  );
}
