'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAccount, useAccountEffect, useConnect, useDisconnect, useConfig, useBalance, useReadContract, useConnectors, type Connector } from 'wagmi';
import { reconnect } from 'wagmi/actions';
import { useAuthSession, getStoredSession, clearAuthSession } from '@/hooks/useAuthSession';
import Link from 'next/link';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Wallet, ChevronDown, ChevronRight, ChevronLeft, LogOut, Copy, Check, X, Loader2, AlertTriangle, ArrowRightLeft, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSynqIdentity } from '@/hooks/useSynqIdentity';
import { useSepoliaNetwork, isRejected, clearRejectedSwitchSession, hasRejectedSwitchSession, getConnectorChainId } from '@/hooks/useSepoliaNetwork';
import { SEPOLIA_CHAIN_ID, SYNQ_V2_SEPOLIA_CONFIG } from '@/lib/contracts/addresses';
import { erc20ABI } from '@/lib/contracts/abis';
import { formatUnits } from 'viem';
import { Press_Start_2P } from 'next/font/google';
import {
  classifyConnectors,
  buildGridWalletItems,
  KNOWN_WALLETS_BY_RDNS,
  isSafeIconUri,
  getWalletDisplayName,
  setStoredWalletPreference,
  getStoredWalletPreference,
  clearStoredWalletPreference,
  findMatchingConnector,
  type GridWalletItem,
} from '@/lib/wallet/discovery';

const pressStart2P = Press_Start_2P({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

declare global {
  interface Window {
    phantom?: { ethereum?: { isPhantom?: boolean } };
  }
}

interface WalletIconStyle {
  scale?: string;
  imgRounded?: string;
}

const WALLET_ICON_STYLES: Record<string, WalletIconStyle> = {
  // MetaMask: Fox head is 117x108 on 263x199 canvas (~44% width, 54% height with baked white padding).
  // Scale up to 1.85x so the fox visual mass matches the 32-34px size of other wallets.
  'io.metamask': {
    scale: 'scale-[1.85]',
  },
  // Coinbase: Circle logo is 314x313 on 863x566 canvas (~36% width with huge transparent margins).
  // Scale up to 2.35x so the circle mark matches the 32-34px size of other wallets.
  'com.coinbase.wallet': {
    scale: 'scale-[2.35]',
  },
  'coinbase': {
    scale: 'scale-[2.35]',
  },
  'coinbaseWalletSDK': {
    scale: 'scale-[2.35]',
  },
  // Rabby: 447x447 solid JPEG badge; round corners so it does not look like a sharp square in the tile.
  'io.rabby': {
    imgRounded: 'rounded-xl',
  },
  // Phantom: 400x400 solid purple badge; round corners for smooth tile harmony.
  'app.phantom': {
    imgRounded: 'rounded-xl',
  },
  // WalletConnect: ~72% fill; subtle 1.15x scale for visual equilibrium.
  'walletConnect': {
    scale: 'scale-[1.15]',
  },
};

function getWalletIconStyle(item?: GridWalletItem, connector?: Connector): WalletIconStyle {
  const rdns = (item?.rdns || (typeof connector?.rdns === 'string' ? connector.rdns : ''))?.toLowerCase();
  const id = (item?.connector?.id || connector?.id || item?.key || '')?.toLowerCase();
  const name = (item?.name || '')?.toLowerCase();

  if (rdns === 'io.metamask' || id.includes('metamask') || name === 'metamask') {
    return WALLET_ICON_STYLES['io.metamask'];
  }
  if (rdns === 'com.coinbase.wallet' || id.includes('coinbase') || name.includes('coinbase')) {
    return WALLET_ICON_STYLES['com.coinbase.wallet'];
  }
  if (rdns === 'io.rabby' || id.includes('rabby') || name.includes('rabby')) {
    return WALLET_ICON_STYLES['io.rabby'];
  }
  if (rdns === 'app.phantom' || id.includes('phantom') || name.includes('phantom')) {
    return WALLET_ICON_STYLES['app.phantom'];
  }
  if (id.includes('walletconnect') || name.includes('walletconnect')) {
    return WALLET_ICON_STYLES['walletConnect'];
  }

  return { imgRounded: 'rounded-lg' };
}

function WalletItemIcon({
  connector,
  fallbackSrc,
  item,
}: {
  connector?: Connector;
  fallbackSrc?: string;
  item?: GridWalletItem;
}) {
  const [imgError, setImgError] = useState(false);
  const iconStyle = getWalletIconStyle(item, connector);

  const src = item?.iconSrc || fallbackSrc;
  if (src && !imgError) {
    return (
      <img
        src={src}
        alt={item?.name || ''}
        className={cn(
          "w-8 h-8 sm:w-9 sm:h-9 object-contain select-none pointer-events-none transition-transform duration-150",
          iconStyle.scale,
          iconStyle.imgRounded
        )}
        onError={() => setImgError(true)}
      />
    );
  }

  const targetConnector = item?.connector || connector;
  if (targetConnector) {
    const rdns = typeof targetConnector.rdns === 'string'
      ? targetConnector.rdns.toLowerCase()
      : (Array.isArray(targetConnector.rdns) ? targetConnector.rdns[0]?.toLowerCase() : '') || targetConnector.id.toLowerCase();
    const curated = KNOWN_WALLETS_BY_RDNS[rdns];
    if (curated && !imgError) {
      return (
        <img
          src={curated.src}
          alt={item?.name || ''}
          className={cn(
            "w-8 h-8 sm:w-9 sm:h-9 object-contain select-none pointer-events-none transition-transform duration-150",
            iconStyle.scale,
            iconStyle.imgRounded
          )}
          onError={() => setImgError(true)}
        />
      );
    }

    const rawIcon = targetConnector.icon;
    if (!imgError && isSafeIconUri(rawIcon)) {
      return (
        <img
          src={rawIcon}
          alt={item?.name || ''}
          className={cn(
            "w-8 h-8 sm:w-9 sm:h-9 object-contain select-none pointer-events-none transition-transform duration-150",
            iconStyle.scale,
            iconStyle.imgRounded
          )}
          onError={() => setImgError(true)}
        />
      );
    }
  }

  return (
    <Wallet size={24} className="text-zinc-600 select-none" />
  );
}

function getScopedDisplayName(walletAddress?: string): string {
  if (typeof window === 'undefined' || !walletAddress) return '';
  try {
    const raw = window.localStorage.getItem(`settings:username:${walletAddress.toLowerCase()}`);
    return raw !== null && raw !== undefined ? (JSON.parse(raw) as string) : '';
  } catch { return ''; }
}

function BalanceRow({
  value,
  symbol,
}: {
  value: string;
  symbol: string;
}) {
  return (
    <div className="flex items-center justify-between text-[10px] sm:text-[10.5px] text-white font-normal tracking-tight">
      <span className="truncate mr-2 min-w-0">{value}</span>
      <span className="text-zinc-400 text-[8.5px] shrink-0 font-normal select-none">{symbol}</span>
    </div>
  );
}

export interface WalletStatusProps {
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export default function WalletStatus({ onOpenChange, className }: WalletStatusProps = {}) {
  const [mounted, setMounted] = useState(false);
  const { address, isConnected, connector, chainId } = useAccount();
  const { connectAsync } = useConnect();
  const config = useConfig();
  const { disconnectAsync } = useDisconnect();
  const isDisconnectingRef = useRef(false);
  const connectAbortRef = useRef(false);
  const { ensureAuthenticated } = useAuthSession();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [authError, setAuthError] = useState('');

  type OnboardingStep = 'idle' | 'connecting' | 'network' | 'verifying' | 'ready';
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>('idle');
  const [onboardingConnector, setOnboardingConnector] = useState<Connector | null>(null);
  const [onboardingWalletName, setOnboardingWalletName] = useState<string>('');
  const [onboardingWalletItem, setOnboardingWalletItem] = useState<GridWalletItem | null>(null);
  const [onboardingAddress, setOnboardingAddress] = useState<string | null>(null);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [onboardingActionLoading, setOnboardingActionLoading] = useState(false);
  const completeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const activeOperationIdRef = useRef<number>(0);
  const isRestoredRef = useRef<boolean>(false);
  const isRestoringRef = useRef<boolean>(false);

  const checkAuth = useCallback(() => {
    if (!address) {
      setIsAuthenticated(false);
      return;
    }
    setIsAuthenticated(Boolean(getStoredSession(address)));
  }, [address]);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const resetOnboarding = useCallback(() => {
    activeOperationIdRef.current = 0;
    if (completeTimerRef.current) {
      clearTimeout(completeTimerRef.current);
      completeTimerRef.current = null;
    }
    setOnboardingStep('idle');
    setOnboardingConnector(null);
    setOnboardingWalletName('');
    setOnboardingWalletItem(null);
    setOnboardingAddress(null);
    setOnboardingError(null);
    setOnboardingActionLoading(false);
    setConnecting(null);
  }, []);

  useAccountEffect({
    onDisconnect() {
      // Avoid false-positive disconnect clearing during initial hydration/restoration
      // If user explicitly initiated disconnect (isDisconnectingRef.current is true) or no preference exists, clear auth.
      // If a stored preference exists and restoration has not settled or failed, avoid wiping the cached JWT.
      const hasStoredPref = Boolean(getStoredWalletPreference());
      if (isDisconnectingRef.current || (!hasStoredPref && isRestoredRef.current)) {
        if (address) clearAuthSession(address);
      }
      if (connector) clearRejectedSwitchSession(connector.uid);
      autoSwitchSessionRef.current = null;
      setIsAuthenticated(false);
      setIsVerifying(false);
      setAuthError('');
      setConnectionError('');
      resetOnboarding();
    },
  });
  const {
    networkReady,
    isWrongNetwork,
    isNetworkUnverified,
    isSwitching,
    error: networkError,
    requestSepolia,
  } = useSepoliaNetwork();
  const autoSwitchSessionRef = useRef<string | null>(null);

  const { data: balance } = useBalance({ address, chainId: SEPOLIA_CHAIN_ID });
  const { data: usdcRawBalance, isLoading: isUsdcLoading } = useReadContract({
    address: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
    abi: erc20ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: SEPOLIA_CHAIN_ID,
    query: {
      enabled: Boolean(address && networkReady),
    },
  });
  const shouldReduceMotion = useReducedMotion();
  const connectors = useConnectors();
  const identity = useSynqIdentity(address);

  const [open, setOpen] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [connectionError, setConnectionError] = useState('');
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });

  const updateDropdownPos = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const width = Math.round(rect.width);
    const left = Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)));
    setDropdownPos({
      top: Math.round(rect.bottom + 6),
      left,
      width,
    });
  }, []);

  const handleClose = useCallback(() => {
    setOpen(false);
    onOpenChange?.(false);
  }, [onOpenChange]);

  const handleOpenModal = useCallback(() => {
    resetOnboarding();
    setShowModal(true);
    onOpenChange?.(true);
  }, [onOpenChange, resetOnboarding]);

  const handleCloseModal = useCallback(() => {
    connectAbortRef.current = true;
    setShowModal(false);
    onOpenChange?.(false);
    resetOnboarding();
  }, [onOpenChange, resetOnboarding]);

  useEffect(() => {
    return () => {
      if (completeTimerRef.current) {
        clearTimeout(completeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    updateDropdownPos();
    window.addEventListener('resize', updateDropdownPos);
    window.addEventListener('scroll', updateDropdownPos, true);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && buttonRef.current) {
      observer = new ResizeObserver(() => {
        updateDropdownPos();
      });
      observer.observe(buttonRef.current);
    }

    return () => {
      window.removeEventListener('resize', updateDropdownPos);
      window.removeEventListener('scroll', updateDropdownPos, true);
      observer?.disconnect();
    };
  }, [open, updateDropdownPos]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, handleClose]);

  useEffect(() => {
    if (!showModal) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCloseModal();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showModal, handleCloseModal]);

  useEffect(() => {
    setMounted(true);
  }, []);

  // ---------------------------------------------------------------------------
  // Controlled Passive Wallet Restoration Across Browser Refresh (Approach B)
  // ---------------------------------------------------------------------------
  const restorationGenRef = useRef<number>(0);
  const discoveryTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Only run on client after mount
    if (!mounted) return;
    if (isRestoredRef.current) return;
    if (isDisconnectingRef.current) return;

    const pref = getStoredWalletPreference();
    if (!pref) {
      if (process.env.NODE_ENV !== 'production') {
        console.log('[SYNQ Wallet Restore] No saved wallet preference found in storage.');
      }
      isRestoredRef.current = true;
      return;
    }

    // If Wagmi already has an active connection (e.g. fast HMR or external sync), mark restored
    if (isConnected && address) {
      if (process.env.NODE_ENV !== 'production') {
        console.log('[SYNQ Wallet Restore] Already connected in Wagmi state on mount. Marking restored.');
      }
      isRestoredRef.current = true;
      return;
    }

    // If an attempt is currently executing, do not duplicate
    if (isRestoringRef.current) return;

    const currentGen = ++restorationGenRef.current;
    isRestoringRef.current = true;

    const attemptRestoration = async () => {
      try {
        if (process.env.NODE_ENV !== 'production') {
          const masked = pref.address ? `${pref.address.slice(0, 6)}...${pref.address.slice(-4)}` : 'none';
          console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) Saved preference detected: connectorId=${pref.connectorId}, rdns=${pref.rdns || 'none'}, address=${masked}`);
          console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) Connectors available: count=${config.connectors.length}, list=`, config.connectors.map(c => ({ id: c.id, name: c.name, rdns: (c as any).rdns })));
        }

        // Use live config.connectors instead of closure-captured connectors array
        let matchedConnector = findMatchingConnector(config.connectors, pref);
        if (!matchedConnector) {
          if (process.env.NODE_ENV !== 'production') {
            console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) Matching connector not found yet. Waiting for EIP-6963 discovery...`);
          }

          // Allow EIP-6963 extension announcements to populate config.connectors over a 1000ms window
          const startTime = Date.now();
          while (!matchedConnector && Date.now() - startTime < 1200) {
            await new Promise((r) => setTimeout(r, 100));
            if (restorationGenRef.current !== currentGen || isDisconnectingRef.current) {
              if (process.env.NODE_ENV !== 'production') {
                console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) Superseded or cancelled during discovery wait.`);
              }
              return;
            }
            matchedConnector = findMatchingConnector(config.connectors, pref);
          }

          if (!matchedConnector) {
            if (process.env.NODE_ENV !== 'production') {
              console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) Matching connector never appeared after 1200ms. Disconnect preserved.`);
            }
            isRestoredRef.current = true;
            return;
          }
        }

        const target = matchedConnector;
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) Target connector matched: id=${target.id}, name=${target.name}. Checking silent authorization via getAccounts()...`);
        }

        // Silent check: check whether provider is already authorized (non-prompting)
        // getAccounts() on an authorized EIP-1193 provider returns existing accounts without a popup
        let authorizedAccounts: readonly string[] = [];
        try {
          authorizedAccounts = (await target.getAccounts()) || [];
        } catch (authErr) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn(`[SYNQ Wallet Restore] (gen ${currentGen}) target.getAccounts() threw:`, authErr);
          }
          authorizedAccounts = [];
        }

        if (restorationGenRef.current !== currentGen || isDisconnectingRef.current) {
          if (process.env.NODE_ENV !== 'production') {
            console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) Superseded after getAccounts().`);
          }
          return;
        }

        if (process.env.NODE_ENV !== 'production') {
          const maskedAccounts = authorizedAccounts.map(a => `${a.slice(0, 6)}...${a.slice(-4)}`);
          console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) getAccounts() returned: count=${authorizedAccounts.length}, accounts=`, maskedAccounts);
        }

        // If no authorized accounts, provider requires user consent. Do NOT prompt passively on refresh.
        if (!authorizedAccounts || authorizedAccounts.length === 0) {
          if (process.env.NODE_ENV !== 'production') {
            console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) Zero authorized accounts returned. Aborting silent restore to prevent prompt.`);
          }
          isRestoredRef.current = true;
          return;
        }

        const activeAccount = authorizedAccounts[0]?.toLowerCase();
        // Strict safety check: account must match the saved preference
        if (!activeAccount || activeAccount !== pref.address.toLowerCase()) {
          if (process.env.NODE_ENV !== 'production') {
            console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) Active account mismatch. expected=${pref.address.slice(0, 6)}..., got=${activeAccount ? activeAccount.slice(0, 6) + '...' : 'none'}`);
          }
          isRestoredRef.current = true;
          return;
        }

        if (process.env.NODE_ENV !== 'production') {
          console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) Starting silent reconnect with target connector: id=${target.id}...`);
        }

        // Silent restoration: use Wagmi core reconnect to restore without triggering eth_requestAccounts or popups
        const connections = await reconnect(config, { connectors: [target] });

        if (restorationGenRef.current !== currentGen || isDisconnectingRef.current) {
          if (process.env.NODE_ENV !== 'production') {
            console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) Superseded or cancelled after silent reconnect.`);
          }
          return;
        }

        // Validate that a connection was returned
        if (!connections || connections.length === 0) {
          if (process.env.NODE_ENV !== 'production') {
            console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) Silent reconnect returned no connection. Aborting passive restore.`);
          }
          isRestoredRef.current = true;
          return;
        }

        // Validate that the reconnected connector matches our target connector
        const restoredConn = connections.find(c => c.connector.uid === target.uid || c.connector.id === target.id);
        if (!restoredConn) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn(`[SYNQ Wallet Restore] (gen ${currentGen}) Unexpected connector restored:`, connections.map(c => c.connector.id));
          }
          isRestoredRef.current = true;
          return;
        }

        // Validate that the restored account matches our expected saved address
        const restoredAccounts = restoredConn.accounts;
        const restoredAddr = (Array.isArray(restoredAccounts) ? restoredAccounts[0] : (typeof restoredAccounts === 'object' && restoredAccounts !== null ? (restoredAccounts as any).address : ''))?.toLowerCase();
        if (!restoredAddr || restoredAddr !== pref.address.toLowerCase()) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn(`[SYNQ Wallet Restore] (gen ${currentGen}) Reconnected account mismatch. expected=${pref.address.slice(0, 6)}..., got=${restoredAddr ? restoredAddr.slice(0, 6) + '...' : 'none'}`);
          }
          isRestoredRef.current = true;
          return;
        }

        if (process.env.NODE_ENV !== 'production') {
          console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) Silent reconnect succeeded! Restored account=${restoredAddr.slice(0, 6)}... chainId=${restoredConn.chainId}`);
          console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) Passive network verification state: chainId=${restoredConn.chainId}, isSepolia=${restoredConn.chainId === SEPOLIA_CHAIN_ID}`);
        }

        isRestoredRef.current = true;

        // Restore authentication session ONLY for the validated matching address
        const storedToken = getStoredSession(restoredAddr);
        if (storedToken) {
          if (process.env.NODE_ENV !== 'production') {
            console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) Valid cached auth token found for ${restoredAddr.slice(0, 6)}... Setting isAuthenticated(true).`);
          }
          setIsAuthenticated(true);
        } else if (process.env.NODE_ENV !== 'production') {
          console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) No valid auth token found in localStorage for ${restoredAddr.slice(0, 6)}...`);
        }
      } catch (err) {
        // Safe fail: never show errors or modals during passive refresh restoration
        console.warn(`[SYNQ Wallet Restore] (gen ${currentGen}) Silent restoration caught error:`, err);
        isRestoredRef.current = true;
      } finally {
        isRestoringRef.current = false;
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[SYNQ Wallet Restore] (gen ${currentGen}) Restoration cycle finished.`);
        }
      }
    };

    attemptRestoration();

    return () => {
      // In development Strict Mode, unmount happens immediately.
      // Reset isRestoringRef so the immediate second mount can execute.
      isRestoringRef.current = false;
    };
  }, [mounted, connectors, connectAsync, isConnected, address, config]);


  const [displayName, setDisplayName] = useState<string>('');
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null);

  const refreshDisplayName = useCallback(() => {
    if (!address) { setDisplayName(''); return; }
    setDisplayName(getScopedDisplayName(address));
  }, [address]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      try { window.localStorage.removeItem('settings:username'); } catch { /* ignore */ }
    }
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

  const formatBalance = (bal: { decimals: number; symbol: string; value: bigint }) =>
    `${(Number(bal.value) / 10 ** bal.decimals).toFixed(4)} ${bal.symbol}`;

  const formatUsdcValue = (raw?: bigint | null): string => {
    if (raw === undefined || raw === null) return '...';
    try {
      const decimals = SYNQ_V2_SEPOLIA_CONFIG.usdcDecimals;
      const formatted = formatUnits(raw, decimals);
      const [intPart, fracPart = ''] = formatted.split('.');
      const formattedInt = Number(intPart).toLocaleString();
      const frac = fracPart.slice(0, 2).padEnd(2, '0');
      return `${formattedInt}.${frac}`;
    } catch {
      return (Number(raw) / 10 ** SYNQ_V2_SEPOLIA_CONFIG.usdcDecimals).toFixed(2);
    }
  };

  const formatEthValue = (bal?: { decimals: number; symbol: string; value: bigint } | null): string => {
    if (!bal) return '...';
    try {
      const formatted = formatUnits(bal.value, bal.decimals);
      const [intPart, fracPart = ''] = formatted.split('.');
      const formattedInt = Number(intPart).toLocaleString();
      const frac = fracPart.slice(0, 4).padEnd(4, '0');
      return `${formattedInt}.${frac}`;
    } catch {
      return (Number(bal.value) / 10 ** bal.decimals).toFixed(4);
    }
  };

  const copyAddress = async () => {
    if (address) {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const truncateAddress = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  const {
    detectedWallets,
    coinbaseSdk,
    walletConnect,
    genericInjected,
  } = React.useMemo(() => classifyConnectors(connectors), [connectors]);

  const gridItems = React.useMemo(() => buildGridWalletItems(connectors), [connectors]);


  const handleVerifyWallet = async () => {
    if (!address) return;
    setIsVerifying(true);
    setAuthError('');
    try {
      await ensureAuthenticated(address);
      setIsAuthenticated(true);
    } catch (err: any) {
      const msg = err?.message || 'Verification failed';
      if (!msg.includes('cancelled') && !msg.includes('rejected')) {
        setAuthError(msg);
      }
    } finally {
      setIsVerifying(false);
    }
  };

  const handleDisconnect = async () => {
    if (isDisconnectingRef.current) return;
    isDisconnectingRef.current = true;
    connectAbortRef.current = true;
    setConnecting(null);
    setIsVerifying(false);
    resetOnboarding();

    try {
      if (address) clearAuthSession(address);

      // Disconnect all connections in Wagmi state to prevent silent fallback to another wallet
      const activeConns = Array.from(config.state.connections.values());
      for (const conn of activeConns) {
        if (Array.isArray(conn.accounts)) {
          for (const acct of conn.accounts) {
            clearAuthSession(acct);
          }
        }
        try {
          await disconnectAsync({ connector: conn.connector });
        } catch {
          // Continue disconnecting remaining connectors
        }
      }

      try {
        await disconnectAsync();
      } catch {}

      try {
        await config.storage?.removeItem('recentConnectorId');
      } catch {}

      clearStoredWalletPreference();

      if (connector) clearRejectedSwitchSession(connector.uid);
      autoSwitchSessionRef.current = null;
      setIsAuthenticated(false);
      setAuthError('');
      setConnectionError('');
      handleClose();
    } catch {
      handleClose();
    } finally {
      isDisconnectingRef.current = false;
    }
  };

  const completeOnboarding = useCallback(() => {
    setOnboardingStep('ready');
    setOnboardingError(null);
    setOnboardingActionLoading(false);
    if (completeTimerRef.current) clearTimeout(completeTimerRef.current);
    completeTimerRef.current = setTimeout(() => {
      handleCloseModal();
    }, 1400);
  }, [handleCloseModal]);

  const proceedToVerification = useCallback(
    async (targetAddr?: string, targetConn?: Connector, opId?: number, autoTrigger: boolean = true) => {
      const addr = targetAddr || address;
      if (!addr) {
        completeOnboarding();
        return;
      }

      // Strictly validate operation scoping to prevent stale or race-condition calls
      if (opId !== undefined && opId !== activeOperationIdRef.current) return;
      if (connectAbortRef.current || isDisconnectingRef.current) return;

      setOnboardingStep('verifying');
      setOnboardingError(null);

      // Check whether a valid SYNQ authentication session already exists for this address
      const existingToken = getStoredSession(addr);
      if (existingToken) {
        // Valid session exists! Skip verification signature completely
        setIsAuthenticated(true);
        completeOnboarding();
        return;
      }

      // If autoTrigger is false (e.g. skipped network switch or manual fallback), pause for user action
      if (!autoTrigger) {
        setOnboardingActionLoading(false);
        return;
      }

      // Validate connector and address before requesting signature
      const conn = targetConn || onboardingConnector || connector;
      if (!conn) {
        setOnboardingActionLoading(false);
        return;
      }

      setOnboardingActionLoading(true);
      try {
        await ensureAuthenticated(addr);
        if (
          connectAbortRef.current ||
          isDisconnectingRef.current ||
          (opId !== undefined && activeOperationIdRef.current !== opId)
        ) {
          return;
        }
        setIsAuthenticated(true);
        completeOnboarding();
      } catch (err: any) {
        if (
          connectAbortRef.current ||
          isDisconnectingRef.current ||
          (opId !== undefined && activeOperationIdRef.current !== opId)
        ) {
          return;
        }
        const isDeclined =
          err?.code === 4001 ||
          err?.message?.includes('rejected') ||
          err?.message?.includes('User rejected');
        const isGestureRequired =
          err?.message?.includes('user gesture') ||
          err?.message?.includes('popup') ||
          err?.message?.includes('user activation') ||
          err?.message?.includes('User activation');

        if (isDeclined) {
          setOnboardingError(
            'SYNQ verification was declined. Your wallet remains connected, but some features require sign-in.'
          );
        } else if (isGestureRequired) {
          setOnboardingError('Your wallet requires an explicit click to open the signature prompt. Click below to sign.');
        } else {
          setOnboardingError(err?.message || 'Verification failed');
        }
      } finally {
        setOnboardingActionLoading(false);
      }
    },
    [address, completeOnboarding, ensureAuthenticated, onboardingConnector, connector]
  );

  const handleStartOnboarding = async (targetConnector: Connector, walletName: string, item?: GridWalletItem) => {
    if (connecting !== null || isDisconnectingRef.current || (onboardingStep !== 'idle' && onboardingStep !== 'ready')) return;
    connectAbortRef.current = false;
    const currentOpId = ++activeOperationIdRef.current;
    const connId = targetConnector.uid || targetConnector.id;
    setConnecting(connId);
    setOnboardingConnector(targetConnector);
    setOnboardingWalletName(walletName);
    setOnboardingWalletItem(item || null);
    setOnboardingStep('connecting');
    setOnboardingError(null);
    setConnectionError('');
    setAuthError('');

    let connectedAddr: string | undefined;

    // Step 1: Connect only the explicitly selected wallet
    try {
      const res = await connectAsync({ connector: targetConnector });
      if (connectAbortRef.current || isDisconnectingRef.current || activeOperationIdRef.current !== currentOpId) return;

      connectedAddr = res?.accounts?.[0] || address;
      const activeAccounts = await targetConnector.getAccounts().catch(() => []);
      const activeAddr = activeAccounts?.[0];
      if (activeAddr && (!connectedAddr || activeAddr.toLowerCase() !== connectedAddr.toLowerCase())) {
        connectedAddr = activeAddr;
      }
      if (!connectedAddr) {
        setOnboardingError('No account found for connected wallet.');
        return;
      }
      setOnboardingAddress(connectedAddr);
      setStoredWalletPreference(targetConnector, connectedAddr);
    } catch (e: any) {
      if (connectAbortRef.current || isDisconnectingRef.current || activeOperationIdRef.current !== currentOpId) return;
      setConnecting(null);
      const isCancelled = e?.code === 4001 || e?.message?.includes('rejected') || e?.message?.includes('User rejected');
      setOnboardingError(
        isCancelled
          ? 'Connection request was cancelled in your wallet.'
          : `Connection failed: ${e?.message || 'Unknown error'}`
      );
      return;
    } finally {
      setConnecting(null);
    }

    if (connectAbortRef.current || isDisconnectingRef.current || activeOperationIdRef.current !== currentOpId) return;

    // Step 2: Validate Network (Sepolia)
    setOnboardingStep('network');
    setOnboardingError(null);

    let currentChainId: number | null = null;
    try {
      currentChainId = (await getConnectorChainId(targetConnector)) ?? null;
    } catch {
      // ignore
    }

    if (currentChainId === SEPOLIA_CHAIN_ID) {
      // Already on Sepolia! Advance directly to automatic verification
      await proceedToVerification(connectedAddr, targetConnector, currentOpId, true);
    } else {
      // Request network switch to Sepolia
      try {
        setOnboardingActionLoading(true);
        await requestSepolia(targetConnector);
        if (connectAbortRef.current || isDisconnectingRef.current || activeOperationIdRef.current !== currentOpId) return;
        // Switch succeeded! Advance to automatic verification
        await proceedToVerification(connectedAddr, targetConnector, currentOpId, true);
      } catch (err: any) {
        if (connectAbortRef.current || isDisconnectingRef.current || activeOperationIdRef.current !== currentOpId) return;
        const isRejectedSwitch = isRejected(err) || err?.code === 4001 || err?.message?.includes('rejected') || err?.message?.includes('User rejected');
        setOnboardingError(
          isRejectedSwitch
            ? 'Network switch to Sepolia was rejected. Sepolia is required to transact on SYNQ.'
            : (err instanceof Error ? err.message : 'Unable to switch to Ethereum Sepolia.')
        );
      } finally {
        setOnboardingActionLoading(false);
      }
    }
  };

  const handleOnboardingRetrySwitch = async () => {
    const targetConn = onboardingConnector || connector;
    if (!targetConn) return;
    const currentOpId = ++activeOperationIdRef.current;
    setOnboardingActionLoading(true);
    setOnboardingError(null);
    try {
      await requestSepolia(targetConn);
      if (connectAbortRef.current || isDisconnectingRef.current || activeOperationIdRef.current !== currentOpId) return;
      await proceedToVerification(onboardingAddress || address, targetConn, currentOpId, true);
    } catch (err: any) {
      if (connectAbortRef.current || isDisconnectingRef.current || activeOperationIdRef.current !== currentOpId) return;
      const isRejectedSwitch = isRejected(err) || err?.code === 4001 || err?.message?.includes('rejected') || err?.message?.includes('User rejected');
      setOnboardingError(
        isRejectedSwitch
          ? 'Network switch to Sepolia was rejected. Sepolia is required to transact on SYNQ.'
          : (err instanceof Error ? err.message : 'Unable to switch to Ethereum Sepolia.')
      );
    } finally {
      setOnboardingActionLoading(false);
    }
  };

  const handleSkipNetwork = () => {
    // If user skips network switching, do not automatically request verification
    proceedToVerification(onboardingAddress || address, onboardingConnector || connector, activeOperationIdRef.current, false);
  };

  const handleOnboardingVerify = async () => {
    const addr = onboardingAddress || address;
    if (!addr) return;
    const currentOpId = ++activeOperationIdRef.current;
    setOnboardingActionLoading(true);
    setOnboardingError(null);
    try {
      await ensureAuthenticated(addr);
      if (connectAbortRef.current || isDisconnectingRef.current || activeOperationIdRef.current !== currentOpId) return;
      setIsAuthenticated(true);
      completeOnboarding();
    } catch (err: any) {
      if (connectAbortRef.current || isDisconnectingRef.current || activeOperationIdRef.current !== currentOpId) return;
      const isDeclined = err?.code === 4001 || err?.message?.includes('rejected') || err?.message?.includes('User rejected');
      setOnboardingError(
        isDeclined
          ? 'SYNQ verification was declined. Your wallet remains connected, but some features require sign-in.'
          : (err?.message || 'Verification failed')
      );
    } finally {
      setOnboardingActionLoading(false);
    }
  };

  const handleOnboardingSkip = useCallback(() => {
    completeOnboarding();
  }, [completeOnboarding]);

  const handleConnect = async (targetConnector: Connector) => {
    return handleStartOnboarding(targetConnector, getWalletDisplayName(targetConnector));
  };

  const handleSwitchToSepolia = async () => {
    setConnectionError('');
    if (connector) clearRejectedSwitchSession(connector.uid);
    try {
      await requestSepolia(connector);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Unable to switch to Ethereum Sepolia.');
    }
  };

  const handleToggleOpen = () => {
    refreshDisplayName();
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const width = Math.round(rect.width);
      const left = Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)));
      setDropdownPos({
        top: Math.round(rect.bottom + 6),
        left,
        width,
      });
    }
    const next = !open;
    setOpen(next);
    onOpenChange?.(next);
  };

  const getStepStatus = (stepKey: 'connecting' | 'network' | 'verifying' | 'ready') => {
    const stepsOrder: OnboardingStep[] = ['connecting', 'network', 'verifying', 'ready'];
    const currentIndex = stepsOrder.indexOf(onboardingStep);
    const targetIndex = stepsOrder.indexOf(stepKey);

    if (targetIndex < currentIndex) return 'completed';
    if (targetIndex === currentIndex) {
      if (onboardingError) return 'error';
      if (onboardingStep === 'ready') return 'completed';
      return 'active';
    }
    return 'pending';
  };

  const isOnboarding = onboardingStep !== 'idle';
  const isConnecting = connecting !== null || isVerifying || isOnboarding;

  const renderWalletModal = () => {
    if (!mounted || typeof document === 'undefined') return null;

    return createPortal(
      <AnimatePresence>
        {showModal && (
          <div key="wallet-modal-portal-root">
            <div
              key="wallet-modal-backdrop"
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100]"
              onClick={handleCloseModal}
              aria-hidden="true"
            />
            <motion.div
              key="wallet-modal-panel"
              initial={{ opacity: 0, scale: 0.95, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 16 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="fixed inset-0 z-[101] flex items-center justify-center p-4 pointer-events-none"
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="wallet-modal-title"
                className="w-full max-w-[500px] rounded-3xl bg-[#303030] border border-[#444444] shadow-2xl overflow-hidden pointer-events-auto flex flex-col max-h-[85vh]"
              >
                {/* Header */}
                <div className="p-6 pb-4 border-b border-[#404040] relative shrink-0">
                  {onboardingStep !== 'idle' && onboardingStep !== 'ready' && (
                    <button
                      type="button"
                      onClick={resetOnboarding}
                      className="absolute left-5 top-5 p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-colors focus-visible:outline-none"
                      aria-label="Back to wallet selection"
                      title="Choose another wallet"
                    >
                      <ChevronLeft size={18} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleCloseModal}
                    className="absolute right-5 top-5 p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50"
                    aria-label="Close modal"
                  >
                    <X size={18} />
                  </button>
                  <h2
                    id="wallet-modal-title"
                    className={cn(
                      pressStart2P.className,
                      "text-[14px] sm:text-[15px] text-white tracking-normal leading-relaxed",
                      onboardingStep !== 'idle' && onboardingStep !== 'ready' && "pl-7"
                    )}
                    style={{ wordSpacing: '-0.35em' }}
                  >
                    {onboardingStep === 'ready'
                      ? 'Wallet Synqd!'
                      : onboardingStep !== 'idle'
                      ? 'Synq Onboarding'
                      : 'Synq your wallet...'}
                  </h2>
                  <p
                    className={cn(
                      pressStart2P.className,
                      "text-[9px] sm:text-[10px] text-zinc-400 mt-2.5 leading-relaxed tracking-tight",
                      onboardingStep !== 'idle' && onboardingStep !== 'ready' && "pl-7"
                    )}
                  >
                    {onboardingStep === 'connecting'
                      ? `Step 1 of 3: Connecting to ${onboardingWalletName || 'Wallet'}`
                      : onboardingStep === 'network'
                      ? 'Step 2 of 3: Validating Sepolia Network'
                      : onboardingStep === 'verifying'
                      ? 'Step 3 of 3: SYNQ Wallet Verification'
                      : onboardingStep === 'ready'
                      ? 'Onboarding completed successfully'
                      : 'Choose a wallet to connect, switch to Sepolia, and verify.'}
                  </p>
                </div>


                {/* Connection error display (for idle mode) */}
                {onboardingStep === 'idle' && connectionError && (
                  <div className="mx-6 mt-3 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-300 flex items-center justify-between shrink-0">
                    <span className="truncate">{connectionError}</span>
                    <button
                      type="button"
                      onClick={() => setConnectionError('')}
                      className="text-red-400 hover:text-red-200 ml-2 shrink-0"
                      aria-label="Dismiss error"
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}

                {/* Body: Wallet Grid OR Guided Onboarding Stepper */}
                {onboardingStep === 'idle' ? (
                  <div className="p-6 py-5 overflow-y-auto flex-1 max-h-[380px]">
                    {gridItems.length > 0 ? (
                      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-y-5 gap-x-3 sm:gap-x-4 place-items-center">
                        {gridItems.map((item) => {
                          const isConnectingThis = connecting === item.key;
                          return (
                            <button
                              key={item.key}
                              type="button"
                              onClick={() => handleStartOnboarding(item.connector, item.name, item)}
                              disabled={connecting !== null}
                              className="group flex flex-col items-center focus-visible:outline-none w-full max-w-[80px]"
                              aria-label={`Connect with ${item.name}`}
                            >
                              <div className="relative w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-white shadow-sm flex items-center justify-center p-2.5 shrink-0 transition-transform duration-150 group-hover:scale-105 group-focus-visible:ring-2 group-focus-visible:ring-white group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-[#303030] overflow-hidden">
                                {isConnectingThis ? (
                                  <Loader2 size={24} className="animate-spin text-zinc-700" />
                                ) : (
                                  <WalletItemIcon item={item} connector={item.connector} />
                                )}
                              </div>
                              <span
                                className={cn(
                                  pressStart2P.className,
                                  "mt-2 text-[8px] sm:text-[8.5px] text-zinc-300 font-normal text-center leading-snug line-clamp-2 w-full max-w-[76px] sm:max-w-[82px] break-words group-hover:text-white transition-colors select-none min-h-[22px] flex items-center justify-center tracking-tight"
                                )}
                                title={item.name}
                              >
                                {item.compactName}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="py-8 text-center">
                        <p className={cn(pressStart2P.className, "text-[9px] text-zinc-400")}>No Web3 wallet extensions found</p>
                        <p className="text-[11px] text-zinc-500 mt-2">Please install a supported browser wallet to continue.</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="p-6 py-5 flex flex-col flex-1">
                    {/* Stepper Progress Bar */}
                    <div className="px-2 pt-1 pb-4">
                      <div className="flex items-center justify-between">
                        {/* 1. Connect */}
                        <div className="flex flex-col items-center gap-1.5 flex-1">
                          <div
                            className={cn(
                              "w-7 h-7 rounded-full flex items-center justify-center transition-all",
                              getStepStatus('connecting') === 'completed'
                                ? "bg-emerald-500/20 border border-emerald-500/60 text-emerald-400"
                                : getStepStatus('connecting') === 'error'
                                ? "bg-red-500/20 border border-red-500/60 text-red-400"
                                : "bg-white text-zinc-900 border border-white shadow-sm shadow-white/20"
                            )}
                          >
                            {getStepStatus('connecting') === 'completed' ? (
                              <Check size={13} className="stroke-[2.5]" />
                            ) : getStepStatus('connecting') === 'error' ? (
                              <AlertTriangle size={13} />
                            ) : (
                              <Loader2 size={13} className="animate-spin text-zinc-900" />
                            )}
                          </div>
                          <span
                            className={cn(
                              pressStart2P.className,
                              "text-[7px] sm:text-[7.5px] tracking-tight transition-colors",
                              getStepStatus('connecting') === 'completed'
                                ? "text-emerald-400"
                                : getStepStatus('connecting') === 'error'
                                ? "text-red-400"
                                : "text-white"
                            )}
                          >
                            Connect
                          </span>
                        </div>

                        {/* Divider 1-2 */}
                        <div
                          className={cn(
                            "h-[2px] w-6 sm:w-8 -mt-4 transition-colors",
                            getStepStatus('connecting') === 'completed'
                              ? "bg-emerald-500/60"
                              : "bg-zinc-700/60"
                          )}
                        />

                        {/* 2. Network */}
                        <div className="flex flex-col items-center gap-1.5 flex-1">
                          <div
                            className={cn(
                              "w-7 h-7 rounded-full flex items-center justify-center transition-all",
                              getStepStatus('network') === 'completed'
                                ? "bg-emerald-500/20 border border-emerald-500/60 text-emerald-400"
                                : getStepStatus('network') === 'error'
                                ? "bg-amber-500/20 border border-amber-500/60 text-amber-400"
                                : getStepStatus('network') === 'active'
                                ? "bg-white text-zinc-900 border border-white shadow-sm shadow-white/20"
                                : "bg-zinc-800 border border-zinc-700/70 text-zinc-500"
                            )}
                          >
                            {getStepStatus('network') === 'completed' ? (
                              <Check size={13} className="stroke-[2.5]" />
                            ) : getStepStatus('network') === 'error' ? (
                              <AlertTriangle size={13} />
                            ) : getStepStatus('network') === 'active' && onboardingActionLoading ? (
                              <Loader2 size={13} className="animate-spin text-zinc-900" />
                            ) : (
                              <span className="text-[10px] font-bold">2</span>
                            )}
                          </div>
                          <span
                            className={cn(
                              pressStart2P.className,
                              "text-[7px] sm:text-[7.5px] tracking-tight transition-colors",
                              getStepStatus('network') === 'completed'
                                ? "text-emerald-400"
                                : getStepStatus('network') === 'error'
                                ? "text-amber-400"
                                : getStepStatus('network') === 'active'
                                ? "text-white"
                                : "text-zinc-500"
                            )}
                          >
                            Network
                          </span>
                        </div>

                        {/* Divider 2-3 */}
                        <div
                          className={cn(
                            "h-[2px] w-6 sm:w-8 -mt-4 transition-colors",
                            getStepStatus('network') === 'completed'
                              ? "bg-emerald-500/60"
                              : "bg-zinc-700/60"
                          )}
                        />

                        {/* 3. Verify */}
                        <div className="flex flex-col items-center gap-1.5 flex-1">
                          <div
                            className={cn(
                              "w-7 h-7 rounded-full flex items-center justify-center transition-all",
                              getStepStatus('verifying') === 'completed'
                                ? "bg-emerald-500/20 border border-emerald-500/60 text-emerald-400"
                                : getStepStatus('verifying') === 'error'
                                ? "bg-amber-500/20 border border-amber-500/60 text-amber-400"
                                : getStepStatus('verifying') === 'active'
                                ? "bg-indigo-500/30 border border-indigo-400/70 text-indigo-300 shadow-sm shadow-indigo-500/20"
                                : "bg-zinc-800 border border-zinc-700/70 text-zinc-500"
                            )}
                          >
                            {getStepStatus('verifying') === 'completed' ? (
                              <Check size={13} className="stroke-[2.5]" />
                            ) : getStepStatus('verifying') === 'error' ? (
                              <AlertTriangle size={13} />
                            ) : getStepStatus('verifying') === 'active' && onboardingActionLoading ? (
                              <Loader2 size={13} className="animate-spin text-indigo-300" />
                            ) : (
                              <ShieldCheck size={13} />
                            )}
                          </div>
                          <span
                            className={cn(
                              pressStart2P.className,
                              "text-[7px] sm:text-[7.5px] tracking-tight transition-colors",
                              getStepStatus('verifying') === 'completed'
                                ? "text-emerald-400"
                                : getStepStatus('verifying') === 'error'
                                ? "text-amber-400"
                                : getStepStatus('verifying') === 'active'
                                ? "text-indigo-300"
                                : "text-zinc-500"
                            )}
                          >
                            Verify
                          </span>
                        </div>

                        {/* Divider 3-4 */}
                        <div
                          className={cn(
                            "h-[2px] w-6 sm:w-8 -mt-4 transition-colors",
                            getStepStatus('verifying') === 'completed'
                              ? "bg-emerald-500/60"
                              : "bg-zinc-700/60"
                          )}
                        />

                        {/* 4. Ready */}
                        <div className="flex flex-col items-center gap-1.5 flex-1">
                          <div
                            className={cn(
                              "w-7 h-7 rounded-full flex items-center justify-center transition-all",
                              getStepStatus('ready') === 'completed'
                                ? "bg-emerald-500/20 border border-emerald-500/60 text-emerald-400"
                                : "bg-zinc-800 border border-zinc-700/70 text-zinc-500"
                            )}
                          >
                            {getStepStatus('ready') === 'completed' ? (
                              <Check size={13} className="stroke-[2.5]" />
                            ) : (
                              <span className="text-[10px] font-bold">4</span>
                            )}
                          </div>
                          <span
                            className={cn(
                              pressStart2P.className,
                              "text-[7px] sm:text-[7.5px] tracking-tight transition-colors",
                              getStepStatus('ready') === 'completed'
                                ? "text-emerald-400"
                                : "text-zinc-500"
                            )}
                          >
                            Ready
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Step Content */}
                    <div className="mt-2 min-h-[220px] flex flex-col justify-center">
                      {onboardingStep === 'connecting' && (
                        <div className="flex flex-col items-center text-center py-2 px-4">
                          <div className="relative w-16 h-16 rounded-2xl bg-white shadow-sm flex items-center justify-center p-2.5 mb-4 overflow-hidden">
                            {onboardingWalletItem ? (
                              <WalletItemIcon item={onboardingWalletItem} connector={onboardingConnector || undefined} />
                            ) : (
                              <Wallet size={28} className="text-zinc-800" />
                            )}
                            {!onboardingError && (
                              <div className="absolute inset-0 bg-white/70 backdrop-blur-[1px] flex items-center justify-center">
                                <Loader2 size={24} className="animate-spin text-zinc-900" />
                              </div>
                            )}
                          </div>

                          <h3 className={cn(pressStart2P.className, "text-[12px] sm:text-[13px] text-white tracking-tight mb-2")}>
                            {onboardingError ? 'Connection Issue' : `Connecting to ${onboardingWalletName}...`}
                          </h3>

                          <p className="text-xs text-zinc-400 max-w-sm mb-4 leading-relaxed">
                            {onboardingError
                              ? onboardingError
                              : `Please approve the connection prompt in ${onboardingWalletName} to continue.`}
                          </p>

                          {onboardingError && (
                            <div className="flex items-center gap-3 mt-2 w-full max-w-xs">
                              <button
                                type="button"
                                onClick={() => onboardingConnector && handleStartOnboarding(onboardingConnector, onboardingWalletName, onboardingWalletItem || undefined)}
                                className="flex-1 h-9 px-4 rounded-xl bg-white text-zinc-900 font-medium text-xs hover:bg-zinc-100 transition-colors shadow-sm"
                              >
                                Try Again
                              </button>
                              <button
                                type="button"
                                onClick={resetOnboarding}
                                className="flex-1 h-9 px-4 rounded-xl bg-zinc-800 text-zinc-300 font-medium text-xs hover:bg-zinc-700 border border-zinc-700 transition-colors"
                              >
                                Other Wallets
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      {onboardingStep === 'network' && (
                        <div className="flex flex-col items-center text-center py-2 px-4">
                          <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mb-4">
                            {onboardingActionLoading ? (
                              <Loader2 size={26} className="animate-spin text-amber-400" />
                            ) : (
                              <ArrowRightLeft size={24} />
                            )}
                          </div>

                          <h3 className={cn(pressStart2P.className, "text-[12px] sm:text-[13px] text-white tracking-tight mb-2")}>
                            {onboardingActionLoading ? 'Switching Network...' : 'Sepolia Network Required'}
                          </h3>

                          <p className="text-xs text-zinc-400 max-w-sm mb-4 leading-relaxed">
                            {onboardingError ? (
                              onboardingError
                            ) : onboardingActionLoading ? (
                              'Please confirm the network switch to Ethereum Sepolia in your wallet.'
                            ) : (
                              'SYNQ contracts and escrows operate on Ethereum Sepolia testnet. Please switch your wallet to Sepolia to continue.'
                            )}
                          </p>

                          <div className="flex items-center gap-3 mt-2 w-full max-w-xs">
                            <button
                              type="button"
                              onClick={handleOnboardingRetrySwitch}
                              disabled={onboardingActionLoading}
                              className="flex-1 h-9 px-4 rounded-xl bg-white text-zinc-900 font-medium text-xs hover:bg-zinc-100 transition-colors shadow-sm flex items-center justify-center gap-2 disabled:opacity-50"
                            >
                              {onboardingActionLoading && <Loader2 size={13} className="animate-spin text-zinc-900" />}
                              <span>Switch to Sepolia</span>
                            </button>
                            <button
                              type="button"
                              onClick={handleSkipNetwork}
                              disabled={onboardingActionLoading}
                              className="flex-1 h-9 px-4 rounded-xl bg-zinc-800 text-zinc-300 font-medium text-xs hover:bg-zinc-700 border border-zinc-700 transition-colors disabled:opacity-50"
                            >
                              Skip for Now
                            </button>
                          </div>
                        </div>
                      )}

                      {onboardingStep === 'verifying' && (
                        <div className="flex flex-col items-center text-center py-2 px-4">
                          <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center mb-3">
                            {onboardingActionLoading ? (
                              <Loader2 size={26} className="animate-spin text-indigo-400" />
                            ) : (
                              <ShieldCheck size={26} />
                            )}
                          </div>

                          <h3 className={cn(pressStart2P.className, "text-[12px] sm:text-[13px] text-white tracking-tight mb-1.5")}>
                            {onboardingActionLoading ? 'Waiting for Signature...' : 'SYNQ Verification'}
                          </h3>

                          <p className="text-[11px] text-zinc-300 max-w-sm mb-3 leading-relaxed">
                            {onboardingActionLoading
                              ? `Confirm the free off-chain sign-in request in ${onboardingWalletName || 'your wallet'}.`
                              : 'Sign a one-time cryptographic message to verify ownership of your wallet.'}
                          </p>

                          <div className="w-full max-w-sm bg-zinc-800/80 border border-zinc-700/70 rounded-xl p-2.5 mb-3 text-left">
                            <div className="flex items-center gap-2 text-[10.5px] text-zinc-300 mb-1">
                              <Check size={12} className="text-emerald-400 shrink-0 stroke-[2.5]" />
                              <span>Zero gas fees · Free off-chain signature</span>
                            </div>
                            <div className="flex items-center gap-2 text-[10.5px] text-zinc-300 mb-1">
                              <Check size={12} className="text-emerald-400 shrink-0 stroke-[2.5]" />
                              <span>Cannot move funds or execute transactions</span>
                            </div>
                            <div className="flex items-center gap-2 text-[10.5px] text-zinc-300">
                              <Check size={12} className="text-emerald-400 shrink-0 stroke-[2.5]" />
                              <span>Enables messages, proposals & deals</span>
                            </div>
                          </div>

                          {onboardingError && (
                            <div className="w-full max-w-sm p-2 rounded-lg bg-red-500/10 border border-red-500/20 text-[11px] text-red-300 mb-3 text-left">
                              {onboardingError}
                            </div>
                          )}

                          <div className="flex items-center gap-3 w-full max-w-xs">
                            {onboardingActionLoading ? (
                              <div className="flex-1 h-9 px-3 rounded-xl bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-xs font-medium flex items-center justify-center gap-2 select-none">
                                <Loader2 size={13} className="animate-spin text-indigo-400 shrink-0" />
                                <span className="truncate">Confirm in wallet...</span>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={handleOnboardingVerify}
                                className="flex-1 h-9 px-4 rounded-xl bg-white text-zinc-900 font-medium text-xs hover:bg-zinc-100 transition-colors shadow-sm flex items-center justify-center gap-2"
                              >
                                Sign In & Verify
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={handleOnboardingSkip}
                              className="flex-1 h-9 px-4 rounded-xl bg-zinc-800 text-zinc-300 font-medium text-xs hover:bg-zinc-700 border border-zinc-700 transition-colors"
                            >
                              Skip for Now
                            </button>
                          </div>
                        </div>
                      )}

                      {onboardingStep === 'ready' && (
                        <div className="flex flex-col items-center text-center py-2 px-4">
                          <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center mb-3">
                            <Check size={28} className="stroke-[2.5]" />
                          </div>

                          <h3 className={cn(pressStart2P.className, "text-[12px] sm:text-[13px] text-white tracking-tight mb-1.5")}>
                            Wallet Synqd!
                          </h3>

                          <p className="text-xs text-zinc-400 max-w-sm mb-3 leading-relaxed">
                            Your wallet is connected and ready to explore SYNQ.
                          </p>

                          <div className="w-full max-w-xs bg-zinc-800/80 border border-zinc-700/70 rounded-xl p-3 mb-1 space-y-1.5 text-left">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-zinc-400 text-[11px]">Address</span>
                              <span className="font-mono text-white text-[11px]">{truncateAddress(onboardingAddress || address || '')}</span>
                            </div>
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-zinc-400 text-[11px]">Network</span>
                              <span className="text-emerald-400 font-medium text-[11px]">Sepolia</span>
                            </div>
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-zinc-400 text-[11px]">Status</span>
                              <span className={cn("font-medium text-[11px]", isAuthenticated ? "text-emerald-400" : "text-amber-400")}>
                                {isAuthenticated ? "Verified" : "Connected (Unverified)"}
                              </span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Footer */}
                <div className="px-6 py-3.5 border-t border-[#404040] shrink-0">
                  <p className={cn(pressStart2P.className, "text-[8px] text-zinc-400 text-center leading-relaxed tracking-tight select-none")}>
                    {onboardingStep === 'idle'
                      ? "Guided setup · Free off-chain signature · Terms apply"
                      : onboardingStep === 'connecting'
                      ? `Approve connection in ${onboardingWalletName || 'your wallet'}`
                      : onboardingStep === 'network'
                      ? 'Ethereum Sepolia testnet is required for SYNQ'
                      : onboardingStep === 'verifying'
                      ? 'Zero-gas cryptographic signature · Cannot move funds'
                      : 'Setup complete · Welcome to SYNQ'}
                  </p>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>,
      document.body
    );
  };

  if (mounted && isConnected && !isConnecting) {
    return (
      <div className="relative">
        <button
          ref={buttonRef}
          onClick={handleToggleOpen}
          className={cn(
            'flex items-center gap-2.5 sm:gap-3 h-10 px-4 rounded-xl border text-sm font-medium transition-all shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#242424]/20 select-none bg-[#FFFFFF] border-zinc-200/90 text-[#242424] hover:bg-zinc-50 hover:border-zinc-300 hover:shadow min-w-[210px]',
            className
          )}
        >
          {!networkReady ? (
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
              <span className="text-xs sm:text-sm text-[#242424] font-medium">
                {isWrongNetwork ? 'Wrong Network' : 'Network Not Verified'}
              </span>
            </div>
          ) : !isAuthenticated ? (
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
              <span className="text-xs sm:text-sm text-[#242424] font-medium">
                Verify Wallet
              </span>
            </div>
          ) : (
            <>
              <span className="text-sm font-mono text-[#242424] font-medium">
                {balance ? formatBalance(balance) : '...'}
              </span>
              <span className="text-[#242424]/30 font-normal select-none">|</span>
              <span className="text-sm font-mono text-[#242424] font-semibold">
                {identity.displayHandle || (address ? truncateAddress(address) : '')}
              </span>
            </>
          )}
          <ChevronDown
            size={15}
            className={cn(
              'shrink-0 transition-transform duration-200 text-[#242424]/70 ml-auto',
              open && 'rotate-180'
            )}
          />
        </button>

        {mounted && typeof document !== 'undefined' && createPortal(
          <AnimatePresence>
            {open && (
              <div key="wallet-dropdown-portal-root">
                <div
                  key="wallet-dropdown-backdrop"
                  className="fixed inset-0 z-[100]"
                  onClick={handleClose}
                  aria-hidden="true"
                />
                <motion.div
                  key="wallet-dropdown-panel"
                  initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                  animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
                  exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                  transition={{
                    duration: shouldReduceMotion ? 0.15 : 0.28,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                  style={{
                    position: 'fixed',
                    top: dropdownPos.top,
                    left: dropdownPos.left,
                    width: dropdownPos.width || (buttonRef.current?.getBoundingClientRect().width ?? 210),
                  }}
                  className={cn(
                    pressStart2P.className,
                    "p-4 rounded-2xl border border-[#444444] bg-[#303030] shadow-2xl z-[101] overflow-hidden flex flex-col gap-3.5 text-white box-border"
                  )}
                >
                  {/* Wrong network alert banner (if network is not verified / wrong network) */}
                  {!networkReady && (
                    <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25 space-y-2">
                      <div className="flex items-center gap-1.5 text-[7.5px] text-amber-300 leading-tight">
                        <AlertTriangle size={12} className="shrink-0 text-amber-400" />
                        <span className="truncate">{isWrongNetwork ? 'Wrong Network' : 'Network Unverified'}</span>
                      </div>
                      <button
                        type="button"
                        onClick={handleSwitchToSepolia}
                        disabled={isSwitching}
                        className="w-full flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg bg-amber-500/20 text-[7.5px] text-amber-200 hover:bg-amber-500/30 disabled:opacity-50 transition-colors"
                      >
                        {isSwitching ? <Loader2 size={11} className="animate-spin" /> : <ArrowRightLeft size={11} />}
                        <span>{isSwitching ? 'Switching...' : 'Switch Sepolia'}</span>
                      </button>
                      {(connectionError || networkError) && (
                        <p className="text-[7px] text-red-300 truncate">{connectionError || networkError?.message}</p>
                      )}
                    </div>
                  )}

                  {/* State 4 Recovery Banner (if network is ready but unauthenticated) */}
                  {networkReady && !isAuthenticated && (
                    <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25 space-y-2">
                      <div className="flex items-center gap-1.5 text-[7.5px] text-amber-300 leading-tight">
                        <ShieldCheck size={12} className="shrink-0 text-amber-400" />
                        <span className="truncate">Wallet Verification Needed</span>
                      </div>
                      <button
                        type="button"
                        onClick={handleVerifyWallet}
                        disabled={isVerifying}
                        className="w-full flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg bg-white text-[#242424] hover:bg-zinc-100 disabled:opacity-50 transition-colors text-[8px] font-medium select-none"
                      >
                        {isVerifying ? (
                          <Loader2 size={11} className="animate-spin text-[#242424]" />
                        ) : (
                          <ShieldCheck size={11} className="text-[#242424]" />
                        )}
                        <span>{isVerifying ? 'Verifying...' : 'Verify Wallet'}</span>
                      </button>
                      {authError && (
                        <p className="text-[7px] text-red-300 truncate">{authError}</p>
                      )}
                    </div>
                  )}

                  {/* Header: Display Name, Username, Network Status */}
                  <div className="flex items-start justify-between gap-2 pb-3 border-b border-[#404040]">
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] text-white font-normal truncate tracking-tight">
                        {displayName || identity.displayHandle || (address ? truncateAddress(address) : 'Connected')}
                      </div>
                      {displayName && identity.displayHandle && (
                        <div className="text-[8px] text-zinc-400 truncate mt-1 tracking-tight font-mono">
                          {identity.displayHandle}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 text-[7.5px] text-zinc-400 pt-0.5 select-none">
                      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', networkReady ? 'bg-green-400' : 'bg-amber-400')} />
                      <span>{networkReady ? 'Sepolia' : 'Wrong Net'}</span>
                    </div>
                  </div>

                  {/* If authenticated: Two Equally Prominent Balance Rows: USDC & ETH */}
                  {isAuthenticated && (
                    <div className="pb-3 border-b border-[#404040] flex flex-col gap-2.5">
                      <BalanceRow
                        value={!networkReady ? '--' : isUsdcLoading ? '...' : formatUsdcValue(usdcRawBalance)}
                        symbol="USDC"
                      />
                      <BalanceRow
                        value={!networkReady ? '--' : !balance ? '...' : formatEthValue(balance)}
                        symbol="ETH"
                      />
                    </div>
                  )}

                  {/* Address with Full Address Copy */}
                  <div className="pb-3 border-b border-[#404040] flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[7px] text-zinc-400 uppercase tracking-tight mb-1 select-none">
                        Address
                      </div>
                      <span className="text-[10px] sm:text-[10.5px] text-zinc-200 tracking-tight truncate block">
                        {address ? truncateAddress(address) : ''}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={copyAddress}
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50"
                      title="Copy full address"
                      aria-label="Copy full wallet address"
                    >
                      {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                    </button>
                  </div>

                  {/* Actions: Swap & Disconnect (if authenticated) or Disconnect alone (if unverified) */}
                  {isAuthenticated ? (
                    <div
                      className="grid grid-cols-[minmax(0,35fr)_minmax(0,65fr)] gap-2 w-full pt-1"
                      style={{ gridTemplateColumns: 'minmax(0, 35fr) minmax(0, 65fr)' }}
                    >
                      <Link
                        href="/swap"
                        onClick={handleClose}
                        className="w-full flex items-center justify-center gap-1 sm:gap-1.5 h-9 px-1.5 sm:px-2 rounded-xl bg-white text-[#242424] hover:bg-zinc-100 transition-colors text-[8px] sm:text-[8.5px] font-normal tracking-tight select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white whitespace-nowrap overflow-hidden"
                      >
                        <ArrowRightLeft size={11} className="shrink-0 text-[#242424]" />
                        <span>Swap</span>
                      </Link>
                      <button
                        type="button"
                        onClick={handleDisconnect}
                        className="w-full flex items-center justify-center gap-1 sm:gap-1.5 h-9 px-1.5 sm:px-2 rounded-xl bg-white text-[#242424] hover:bg-zinc-100 transition-colors text-[8px] sm:text-[8.5px] font-normal tracking-tight select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white whitespace-nowrap overflow-hidden"
                      >
                        <LogOut size={11} className="shrink-0 text-[#242424]" />
                        <span>Disconnect</span>
                      </button>
                    </div>
                  ) : (
                    <div className="w-full pt-1">
                      <button
                        type="button"
                        onClick={handleDisconnect}
                        className="w-full flex items-center justify-center gap-1 sm:gap-1.5 h-9 px-1.5 sm:px-2 rounded-xl bg-white text-[#242424] hover:bg-zinc-100 transition-colors text-[8px] sm:text-[8.5px] font-normal tracking-tight select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white whitespace-nowrap overflow-hidden"
                      >
                        <LogOut size={11} className="shrink-0 text-[#242424]" />
                        <span>Disconnect</span>
                      </button>
                    </div>
                  )}
                </motion.div>
              </div>
            )}
          </AnimatePresence>,
          document.body
        )}
        {renderWalletModal()}
      </div>
    );
  }

  return (
    <div className="relative">
      {isConnecting ? (
        <button
          ref={buttonRef}
          disabled
          className={cn(
            'flex items-center gap-2.5 h-10 px-4 rounded-xl border border-zinc-200/90 bg-[#FFFFFF] text-[#242424] opacity-90 shadow-sm text-sm font-medium transition-all select-none cursor-wait min-w-[170px]',
            className
          )}
        >
          <Loader2 size={15} className="animate-spin text-[#242424]/70 shrink-0" />
          <span className="text-[#242424]/80 font-medium">
            {onboardingStep === 'network'
              ? 'Checking Network...'
              : isVerifying || onboardingStep === 'verifying'
              ? 'Verifying Wallet...'
              : 'Connecting...'}
          </span>
        </button>
      ) : (
        <button
          ref={buttonRef}
          onClick={handleOpenModal}
          className={cn(
            'flex items-center gap-2.5 h-10 px-4 rounded-xl border border-zinc-200/90 bg-[#FFFFFF] text-[#242424] hover:bg-zinc-50 hover:border-zinc-300 hover:shadow shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#242424]/20 text-sm font-medium transition-all select-none',
            className
          )}
        >
          <Wallet size={16} className="text-[#242424]/80 shrink-0" />
          <span className="text-[#242424] font-medium">Connect Wallet</span>
        </button>
      )}
      {connectionError && (
        <p className="absolute right-0 top-full mt-2 w-72 text-xs text-red-600 bg-white border border-red-200 rounded-xl p-2.5 shadow-lg z-50">
          {connectionError}
        </p>
      )}

      {renderWalletModal()}
    </div>
  );
}
