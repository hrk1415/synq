'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAccount, useConnect, useDisconnect, useBalance, useConnectors, type Connector } from 'wagmi';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { Wallet, ChevronDown, ChevronRight, LogOut, Copy, Check, ExternalLink, X, Loader2, AlertTriangle, ArrowRightLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSynqIdentity } from '@/hooks/useSynqIdentity';
import { Avatar } from '@/components/shared/Avatar';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import {
  classifyConnectors,
  KNOWN_WALLETS_BY_RDNS,
  isSafeIconUri,
  getWalletDisplayName,
} from '@/lib/wallet/discovery';

declare global {
  interface Window {
    phantom?: { ethereum?: { isPhantom?: boolean } };
  }
}

function WalletItemIcon({ connector, fallbackSrc }: { connector?: Connector; fallbackSrc?: string }) {
  const [imgError, setImgError] = useState(false);

  if (fallbackSrc) {
    return (
      <div className="w-10 h-10 rounded-xl bg-zinc-800 overflow-hidden flex items-center justify-center shrink-0">
        <img src={fallbackSrc} alt="" className="w-full h-full object-cover" />
      </div>
    );
  }

  if (!connector) {
    return (
      <div className="w-10 h-10 rounded-xl bg-zinc-800 overflow-hidden flex items-center justify-center shrink-0 text-zinc-400">
        <Wallet size={20} />
      </div>
    );
  }

  const rdns = typeof connector.rdns === 'string'
    ? connector.rdns.toLowerCase()
    : (Array.isArray(connector.rdns) ? connector.rdns[0]?.toLowerCase() : '') || connector.id.toLowerCase();

  const curated = KNOWN_WALLETS_BY_RDNS[rdns];
  if (curated) {
    return (
      <div className="w-10 h-10 rounded-xl bg-zinc-800 overflow-hidden flex items-center justify-center shrink-0">
        <img src={curated.src} alt="" className="w-full h-full object-cover" />
      </div>
    );
  }

  const rawIcon = connector.icon;
  if (!imgError && isSafeIconUri(rawIcon)) {
    return (
      <div className="w-10 h-10 rounded-xl bg-zinc-800 overflow-hidden flex items-center justify-center shrink-0 p-1">
        <img
          src={rawIcon}
          alt=""
          className="w-full h-full object-contain"
          onError={() => setImgError(true)}
        />
      </div>
    );
  }

  return (
    <div className="w-10 h-10 rounded-xl bg-zinc-800 overflow-hidden flex items-center justify-center shrink-0 text-zinc-400">
      <Wallet size={20} />
    </div>
  );
}

function getScopedDisplayName(walletAddress?: string): string {
  if (typeof window === 'undefined' || !walletAddress) return '';
  try {
    const raw = window.localStorage.getItem(`settings:username:${walletAddress.toLowerCase()}`);
    return raw !== null && raw !== undefined ? (JSON.parse(raw) as string) : '';
  } catch { return ''; }
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
  const { data: balance } = useBalance({ address, chainId: SEPOLIA_CHAIN_ID });
  const connectors = useConnectors();
  const identity = useSynqIdentity(address);
  const {
    networkReady,
    isWrongNetwork,
    isNetworkUnverified,
    isSwitching,
    error: networkError,
    requestSepolia,
  } = useSepoliaNetwork();
  const autoSwitchSessionRef = useRef<string | null>(null);

  const [open, setOpen] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [connectionError, setConnectionError] = useState('');
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });

  const updateDropdownPos = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setDropdownPos({
      top: rect.bottom + 8,
      right: Math.max(16, window.innerWidth - rect.right),
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
    return () => {
      window.removeEventListener('resize', updateDropdownPos);
      window.removeEventListener('scroll', updateDropdownPos, true);
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
      setDropdownPos({
        top: rect.bottom + 8,
        right: Math.max(16, window.innerWidth - rect.right),
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
            'flex items-center gap-2.5 sm:gap-3 h-10 px-4 rounded-xl border text-sm font-medium transition-all shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#242424]/20 select-none bg-[#FFFFFF] border-zinc-200/90 text-[#242424] hover:bg-zinc-50 hover:border-zinc-300 hover:shadow',
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
              'shrink-0 transition-transform duration-200 text-[#242424]/70',
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
                initial={{ opacity: 0, y: -8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.96 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                style={{
                  position: 'fixed',
                  top: dropdownPos.top,
                  right: dropdownPos.right,
                }}
                className="w-72 p-4 rounded-xl border border-zinc-700/50 bg-zinc-900 shadow-2xl z-[101]"
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-white">
                    {displayName ? (
                      <>
                        {displayName}
                        {identity.displayHandle && <span className="text-zinc-500"> {identity.displayHandle}</span>}
                      </>
                    ) : (
                      identity.displayHandle || 'Wallet'
                    )}
                  </span>
                  <div className={cn('flex items-center gap-1 text-xs', networkReady ? 'text-zinc-500' : 'text-amber-400')}><div className={cn('w-1.5 h-1.5 rounded-full', networkReady ? 'bg-green-400' : 'bg-amber-400')} /> {networkReady ? 'Sepolia Ready' : isNetworkUnverified ? 'Network Not Verified' : 'Wrong Network'}</div>
                </div>
                {!networkReady && (
                  <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/25 mb-3 space-y-2">
                    <div className="flex items-start gap-2 text-xs text-amber-300">
                      <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                      <span>{isWrongNetwork ? 'Wrong Network.' : 'The wallet network could not be verified.'} Required: Ethereum Sepolia.</span>
                    </div>
                    <button onClick={handleSwitchToSepolia} disabled={isSwitching} className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-amber-500/15 text-xs text-amber-200 hover:bg-amber-500/25 disabled:opacity-50 transition-colors">
                      {isSwitching ? <Loader2 size={14} className="animate-spin" /> : <ArrowRightLeft size={14} />}
                      {isSwitching ? 'Switching...' : 'Switch to Sepolia'}
                    </button>
                    {(connectionError || networkError) && <p className="text-[11px] text-red-300">{connectionError || networkError?.message}</p>}
                  </div>
                )}
                <div className="p-3 rounded-lg bg-zinc-800/50 mb-3">
                  <div className="text-xs text-zinc-500 mb-1">Address</div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-white font-mono">{truncateAddress(address!)}</span>
                    <button onClick={copyAddress} className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors">
                      {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>
                {identity.hasHandle ? (
                  <div className="p-3 rounded-lg bg-zinc-800/50 mb-3">
                    <div className="text-xs text-zinc-500 mb-1">Username</div>
                    <div className="text-sm text-blue-400">{identity.displayHandle}</div>
                  </div>
                ) : (
                  networkReady && !identity.isLoading && (
                    <div className="p-3 rounded-lg bg-zinc-800/50 border border-zinc-700/50 mb-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-amber-400/90">No Synq handle</span>
                        <Link
                          href="/settings"
                          onClick={handleClose}
                          className="text-xs text-blue-400 hover:text-blue-300 transition-colors font-medium flex items-center gap-0.5"
                        >
                          Profile &rarr;
                        </Link>
                      </div>
                      <p className="text-xs text-zinc-400">Set up your @username in Profile</p>
                    </div>
                  )
                )}
                {displayName && (
                  <div className="p-3 rounded-lg bg-zinc-800/50 mb-3">
                    <div className="text-xs text-zinc-500 mb-1">Display Name</div>
                    <div className="text-sm text-white">{displayName}</div>
                  </div>
                )}
                <div className="p-3 rounded-lg bg-zinc-800/50 mb-3">
                  <div className="text-xs text-zinc-500 mb-1">Balance</div>
                  <div className="text-sm text-white">{balance ? formatBalance(balance) : '...'}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => { navigator.clipboard.writeText(address!); }} className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors">
                    <ExternalLink size={14} /> Explorer
                  </button>
                  <button onClick={() => { disconnect(); handleClose(); }} className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-red-600/10 text-xs text-red-400 hover:bg-red-600/20 transition-colors">
                    <LogOut size={14} /> Disconnect
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
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                className="fixed inset-0 z-[101] flex items-center justify-center p-4 pointer-events-none"
              >
                <div className="w-full max-w-md rounded-2xl border border-zinc-700/50 bg-zinc-900 shadow-2xl overflow-hidden pointer-events-auto">
                  <div className="flex items-center justify-between p-5 border-b border-zinc-800">
                    <div>
                      <h2 className="text-lg font-semibold text-white">Connect Wallet</h2>
                      <p className="text-sm text-zinc-400 mt-0.5">Choose a connection method</p>
                    </div>
                    <button
                      onClick={handleCloseModal}
                      className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
                      aria-label="Close modal"
                    >
                      <X size={18} />
                    </button>
                  </div>
                  <div className="p-5 max-h-[70vh] sm:max-h-[460px] overflow-y-auto space-y-4">
                    {/* Section 1: Detected Wallets */}
                    <div>
                      <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider px-0.5 mb-2 flex items-center justify-between">
                        <span>Detected Wallets</span>
                        {detectedWallets.length > 0 && (
                          <span className="text-[10px] text-zinc-500 font-normal">
                            {detectedWallets.length} available
                          </span>
                        )}
                      </div>

                      {detectedWallets.length > 0 ? (
                        <div className="grid gap-2">
                          {detectedWallets.map((wallet) => {
                            const key = wallet.uid || wallet.id;
                            const rdns = typeof wallet.rdns === 'string'
                              ? wallet.rdns.toLowerCase()
                              : (Array.isArray(wallet.rdns) ? wallet.rdns[0]?.toLowerCase() : '') || wallet.id.toLowerCase();
                            const curated = KNOWN_WALLETS_BY_RDNS[rdns];
                            const isConnectingThis = connecting === key;

                            return (
                              <button
                                key={key}
                                onClick={() => handleConnect(wallet)}
                                disabled={connecting !== null}
                                className={cn(
                                  'flex items-center gap-3 w-full p-3 rounded-xl border text-left transition-all group border-zinc-700/40 bg-zinc-800/30',
                                  curated?.bg,
                                  isConnectingThis
                                    ? 'opacity-70 cursor-wait'
                                    : 'hover:bg-zinc-800/70 hover:border-zinc-600/60'
                                )}
                              >
                                <WalletItemIcon connector={wallet} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium text-white group-hover:text-blue-400 transition-colors truncate">
                                      {getWalletDisplayName(wallet.name)}
                                    </span>
                                    {isConnectingThis ? (
                                      <Loader2 size={12} className="animate-spin text-blue-400 shrink-0" />
                                    ) : (
                                      <span className="text-[10px] font-medium tracking-wide uppercase px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                                        Installed
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs text-zinc-500 truncate">
                                    {curated?.description || 'Browser extension'}
                                  </p>
                                </div>
                                <ChevronRight size={16} className="text-zinc-600 group-hover:text-zinc-400 transition-colors shrink-0" />
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="p-3.5 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 text-center">
                          <p className="text-xs font-medium text-zinc-400">No browser wallet detected</p>
                          <p className="text-[11px] text-zinc-500 mt-1">
                            Install an extension or connect via mobile wallet below:
                          </p>
                          <div className="flex items-center justify-center gap-2.5 mt-2">
                            <a
                              href="https://metamask.io/download/"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-orange-400 hover:text-orange-300 transition-colors font-medium flex items-center gap-0.5"
                            >
                              MetaMask <ExternalLink size={10} />
                            </a>
                            <span className="text-zinc-700">&bull;</span>
                            <a
                              href="https://rabby.io/"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-violet-400 hover:text-violet-300 transition-colors font-medium flex items-center gap-0.5"
                            >
                              Rabby <ExternalLink size={10} />
                            </a>
                            <span className="text-zinc-700">&bull;</span>
                            <a
                              href="https://phantom.app/download"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-purple-400 hover:text-purple-300 transition-colors font-medium flex items-center gap-0.5"
                            >
                              Phantom <ExternalLink size={10} />
                            </a>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Section 2: Other Connection Methods */}
                    {(walletConnect || coinbaseSdk || (genericInjected && detectedWallets.length === 0)) && (
                      <div>
                        <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider px-0.5 mb-2">
                          Other Connection Methods
                        </div>
                        <div className="grid gap-2">
                          {walletConnect && (
                            <button
                              key={walletConnect.uid || walletConnect.id}
                              onClick={() => handleConnect(walletConnect)}
                              disabled={connecting !== null}
                              className={cn(
                                'flex items-center gap-3 w-full p-3 rounded-xl border text-left transition-all group border-blue-500/20 bg-blue-500/10',
                                connecting === (walletConnect.uid || walletConnect.id) ? 'opacity-70 cursor-wait' : 'hover:bg-blue-500/15'
                              )}
                            >
                              <WalletItemIcon fallbackSrc="/wallets/walletconnect.png" />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium text-white group-hover:text-blue-400 transition-colors">
                                    WalletConnect
                                  </span>
                                  {connecting === (walletConnect.uid || walletConnect.id) && (
                                    <Loader2 size={12} className="animate-spin text-blue-400 shrink-0" />
                                  )}
                                </div>
                                <p className="text-xs text-zinc-500 truncate">Connect via mobile wallet or QR code</p>
                              </div>
                              <ChevronRight size={16} className="text-zinc-600 group-hover:text-zinc-400 transition-colors shrink-0" />
                            </button>
                          )}

                          {coinbaseSdk && (
                            <button
                              key={coinbaseSdk.uid || coinbaseSdk.id}
                              onClick={() => handleConnect(coinbaseSdk)}
                              disabled={connecting !== null}
                              className={cn(
                                'flex items-center gap-3 w-full p-3 rounded-xl border text-left transition-all group border-blue-500/20 bg-blue-500/10',
                                connecting === (coinbaseSdk.uid || coinbaseSdk.id) ? 'opacity-70 cursor-wait' : 'hover:bg-blue-500/15'
                              )}
                            >
                              <WalletItemIcon fallbackSrc="/wallets/coinbase.png" />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium text-white group-hover:text-blue-400 transition-colors">
                                    Coinbase Wallet
                                  </span>
                                  {connecting === (coinbaseSdk.uid || coinbaseSdk.id) && (
                                    <Loader2 size={12} className="animate-spin text-blue-400 shrink-0" />
                                  )}
                                </div>
                                <p className="text-xs text-zinc-500 truncate">Smart Wallet or mobile app</p>
                              </div>
                              <ChevronRight size={16} className="text-zinc-600 group-hover:text-zinc-400 transition-colors shrink-0" />
                            </button>
                          )}

                          {genericInjected && detectedWallets.length === 0 && (
                            <button
                              key={genericInjected.uid || genericInjected.id}
                              onClick={() => handleConnect(genericInjected)}
                              disabled={connecting !== null}
                              className={cn(
                                'flex items-center gap-3 w-full p-3 rounded-xl border text-left transition-all group border-zinc-700/40 bg-zinc-800/30',
                                connecting === (genericInjected.uid || genericInjected.id) ? 'opacity-70 cursor-wait' : 'hover:bg-zinc-800/70'
                              )}
                            >
                              <WalletItemIcon />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium text-white group-hover:text-blue-400 transition-colors">
                                    Browser Wallet
                                  </span>
                                  {connecting === (genericInjected.uid || genericInjected.id) && (
                                    <Loader2 size={12} className="animate-spin text-blue-400 shrink-0" />
                                  )}
                                </div>
                                <p className="text-xs text-zinc-500 truncate">Default window.ethereum provider</p>
                              </div>
                              <ChevronRight size={16} className="text-zinc-600 group-hover:text-zinc-400 transition-colors shrink-0" />
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="px-5 py-3 bg-zinc-800/30 border-t border-zinc-800">
                    <p className="text-xs text-zinc-500 text-center">By connecting, you agree to Synq&apos;s Terms of Service</p>
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
