'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAccount, useConnect, useDisconnect, useBalance, useConnectors } from 'wagmi';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { Wallet, ChevronDown, ChevronRight, LogOut, Copy, Check, ExternalLink, X, Loader2, AlertTriangle, ArrowRightLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSynqIdentity } from '@/hooks/useSynqIdentity';
import { Avatar } from '@/components/shared/Avatar';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';

declare global {
  interface Window {
    phantom?: { ethereum?: { isPhantom?: boolean } };
  }
}

const walletOptions = [
  { id: 'metaMask', name: 'MetaMask', src: '/wallets/metamask.png', color: '#f6851b', bg: 'bg-orange-500/10 border-orange-500/20', textColor: 'text-orange-400', description: 'Popular browser extension wallet' },
  { id: 'rabby', name: 'Rabby', src: '/wallets/rabby.jpg', color: '#7c3aed', bg: 'bg-violet-500/10 border-violet-500/20', textColor: 'text-violet-400', description: 'Smart contract wallet for power users' },
  { id: 'phantom', name: 'Phantom', src: '/wallets/phantom.png', color: '#ab9ff2', bg: 'bg-purple-500/10 border-purple-500/20', textColor: 'text-purple-400', description: 'Multi-chain wallet (EVM + Solana)' },
  { id: 'coinbaseWallet', name: 'Coinbase', src: '/wallets/coinbase.png', color: '#0052ff', bg: 'bg-blue-500/10 border-blue-500/20', textColor: 'text-blue-400', description: 'Coinbase self-custody wallet' },
  { id: 'walletConnect', name: 'WalletConnect', src: '/wallets/walletconnect.png', color: '#3b99fc', bg: 'bg-blue-400/10 border-blue-400/20', textColor: 'text-blue-400', description: 'Connect via mobile wallet' },
];

function WalletIcon({ src, name }: { src: string; name: string }) {
  return (
    <div className="w-10 h-10 rounded-xl bg-zinc-800 overflow-hidden flex items-center justify-center">
      <img src={src} alt={name} className="w-full h-full object-cover" />
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

export default function WalletStatus() {
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

  const handleConnect = async (option: typeof walletOptions[0]) => {
    setConnecting(option.id);
    setConnectionError('');
    const idMap: Record<string, string> = {
      metaMask: 'injected', rabby: 'injected', phantom: 'injected',
      coinbaseWallet: 'coinbaseWalletSDK', walletConnect: 'walletConnect',
    };
    const targetId = idMap[option.id] || option.id;
    const connector = connectors.find((c) => c.id === targetId);
    if (!connector) {
      setConnectionError(`Wallet connector not found. Make sure ${option.name} is installed.`);
      setConnecting(null); setShowModal(false); return;
    }
    try { await connectAsync({ connector }); }
    catch (e: any) {
      if (!(e?.message?.includes('rejected') || e?.code === 4001)) setConnectionError(`Connection failed: ${e?.message || 'Unknown error'}`);
    }
    setConnecting(null); setShowModal(false);
  };

  const handleSwitchToSepolia = async () => {
    setConnectionError('');
    try {
      await requestSepolia();
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Unable to switch to Ethereum Sepolia.');
    }
  };

  if (mounted && isConnected) {
    return (
      <div className="relative">
        <button
          onClick={() => { refreshDisplayName(); setOpen(!open); }}
          className={cn(
            'flex items-center gap-2.5 sm:gap-3 h-10 px-4 rounded-xl border text-sm font-medium transition-all shadow-sm',
            networkReady
              ? 'border-zinc-700/80 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-800 hover:border-zinc-600 hover:text-white'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/15'
          )}
        >
          {!networkReady ? (
            <span className="text-xs sm:text-sm text-amber-300 font-medium">
              {isWrongNetwork ? 'Wrong Network' : 'Network Not Verified'}
            </span>
          ) : (
            <>
              <span className="text-sm font-mono text-zinc-200">
                {balance ? formatBalance(balance) : '...'}
              </span>
              <span className="text-zinc-600 font-normal">|</span>
              <span className="text-sm font-mono text-blue-400 font-semibold">
                {identity.displayHandle || (address ? truncateAddress(address) : '')}
              </span>
            </>
          )}
          <ChevronDown size={16} className="text-zinc-400 shrink-0" />
        </button>

        <AnimatePresence>
          {open && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
              <motion.div initial={{ opacity: 0, y: -8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.96 }}
                className="absolute right-0 top-full mt-2 w-72 p-4 rounded-xl border border-zinc-700/50 bg-zinc-900 shadow-xl z-50">
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
                          onClick={() => setOpen(false)}
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
                  <button onClick={() => { disconnect(); setOpen(false); }} className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-red-600/10 text-xs text-red-400 hover:bg-red-600/20 transition-colors">
                    <LogOut size={14} /> Disconnect
                  </button>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <>
      <button onClick={() => setShowModal(true)} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 transition-all shadow-lg shadow-blue-600/20">
        <Wallet size={16} /> Connect Wallet
      </button>
      {connectionError && <p className="absolute right-0 top-full mt-2 w-72 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-2">{connectionError}</p>}

      <AnimatePresence>
        {showModal && (
          <>
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50" onClick={() => setShowModal(false)} />
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="w-full max-w-md rounded-2xl border border-zinc-700/50 bg-zinc-900 shadow-2xl overflow-hidden">
                <div className="flex items-center justify-between p-5 border-b border-zinc-800">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Connect Wallet</h2>
                    <p className="text-sm text-zinc-400 mt-0.5">Choose a connection method</p>
                  </div>
                  <button onClick={() => setShowModal(false)} className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors">
                    <X size={18} />
                  </button>
                </div>
                <div className="p-5">
                  <div className="grid gap-2">
                      {walletOptions.map((option) => (
                        <button key={option.id} onClick={() => handleConnect(option)} disabled={connecting !== null}
                          className={cn('flex items-center gap-3 w-full p-3 rounded-xl border text-left transition-all group', option.bg, connecting === option.id ? 'opacity-70' : 'hover:bg-zinc-800/50')}>
                          <WalletIcon src={option.src} name={option.name} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-white group-hover:text-blue-400 transition-colors">{option.name}</span>
                              {connecting === option.id && <Loader2 size={12} className="animate-spin text-blue-400" />}
                            </div>
                            <p className="text-xs text-zinc-500 truncate">{option.description}</p>
                          </div>
                          <ChevronRight size={16} className="text-zinc-600 group-hover:text-zinc-400 transition-colors" />
                        </button>
                      ))}
                    </div>
                </div>
                <div className="px-5 py-3 bg-zinc-800/30 border-t border-zinc-800">
                  <p className="text-xs text-zinc-500 text-center">By connecting, you agree to Synq's Terms of Service</p>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
