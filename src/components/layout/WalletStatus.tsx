'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAccount, useConnect, useDisconnect, useBalance, useReadContract, useConnectors, type Connector } from 'wagmi';
import Link from 'next/link';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Wallet, ChevronDown, ChevronRight, LogOut, Copy, Check, X, Loader2, AlertTriangle, ArrowRightLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSynqIdentity } from '@/hooks/useSynqIdentity';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';
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
  const { address, isConnected, connector } = useAccount();
  const { connectAsync } = useConnect();
  const { disconnect } = useDisconnect();
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
    setShowModal(true);
    onOpenChange?.(true);
  }, [onOpenChange]);

  const handleCloseModal = useCallback(() => {
    setShowModal(false);
    onOpenChange?.(false);
  }, [onOpenChange]);

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

  // One automatic Sepolia request per established account/connector session.
  // Mark ready sessions too, so a later manual chain change never opens a prompt.
  useEffect(() => {
    if (!isConnected || !address || !connector) {
      autoSwitchSessionRef.current = null;
      return;
    }
    const sessionKey = `${connector.uid}:${address.toLowerCase()}`;
    if (autoSwitchSessionRef.current === sessionKey) return;
    autoSwitchSessionRef.current = sessionKey;
    if (!networkReady) void requestSepolia().catch(() => {});
  }, [address, connector, isConnected, networkReady, requestSepolia]);

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


  const handleConnect = async (targetConnector: Connector) => {
    setConnecting(targetConnector.uid || targetConnector.id);
    setConnectionError('');
    try {
      await connectAsync({ connector: targetConnector });
      handleCloseModal();
    } catch (e: any) {
      if (!(e?.message?.includes('rejected') || e?.code === 4001)) {
        setConnectionError(`Connection failed: ${e?.message || 'Unknown error'}`);
      }
    } finally {
      setConnecting(null);
    }
  };

  const handleSwitchToSepolia = async () => {
    setConnectionError('');
    try {
      await requestSepolia();
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

  if (mounted && isConnected) {
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

                  {/* Two Equally Prominent Balance Rows: USDC & ETH */}
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

                  {/* Actions: Swap & Disconnect in 35:65 Ratio Grid */}
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
                      onClick={() => {
                        disconnect();
                        handleClose();
                      }}
                      className="w-full flex items-center justify-center gap-1 sm:gap-1.5 h-9 px-1.5 sm:px-2 rounded-xl bg-white text-[#242424] hover:bg-zinc-100 transition-colors text-[8px] sm:text-[8.5px] font-normal tracking-tight select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white whitespace-nowrap overflow-hidden"
                    >
                      <LogOut size={11} className="shrink-0 text-[#242424]" />
                      <span>Disconnect</span>
                    </button>
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>,
          document.body
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      {connecting !== null ? (
        <button
          ref={buttonRef}
          disabled
          className={cn(
            'flex items-center gap-2.5 h-10 px-4 rounded-xl border border-zinc-200/90 bg-[#FFFFFF] text-[#242424] opacity-90 shadow-sm text-sm font-medium transition-all select-none cursor-wait',
            className
          )}
        >
          <Loader2 size={15} className="animate-spin text-[#242424]/70 shrink-0" />
          <span className="text-[#242424]/80 font-medium">Connecting...</span>
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

      {mounted && typeof document !== 'undefined' && createPortal(
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
                      className={cn(pressStart2P.className, "text-[14px] sm:text-[15px] text-white tracking-normal leading-relaxed")}
                      style={{ wordSpacing: '-0.35em' }}
                    >
                      Synq your wallet...
                    </h2>
                    <p className={cn(pressStart2P.className, "text-[9px] sm:text-[10px] text-zinc-400 mt-2.5 leading-relaxed tracking-tight")}>
                      Choose a wallet to connect and continue.
                    </p>
                  </div>

                  {/* Connection error display */}
                  {connectionError && (
                    <div className="mx-6 mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-300 flex items-center justify-between shrink-0">
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

                  {/* Wallet Grid - Bounded scrollable area */}
                  <div className="p-6 py-5 overflow-y-auto flex-1 max-h-[380px]">
                    {gridItems.length > 0 ? (
                      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-y-5 gap-x-3 sm:gap-x-4 place-items-center">
                        {gridItems.map((item) => {
                          const isConnectingThis = connecting === item.key;
                          return (
                            <button
                              key={item.key}
                              type="button"
                              onClick={() => handleConnect(item.connector)}
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

                  {/* Footer */}
                  <div className="px-6 py-3.5 border-t border-[#404040] shrink-0">
                    <p className={cn(pressStart2P.className, "text-[8px] text-zinc-400 text-center leading-relaxed tracking-tight select-none")}>
                      By connecting, you agree to Synq&apos;s Terms of Service
                    </p>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
}
