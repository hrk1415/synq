'use client';

import React, { useState, useEffect } from 'react';
import { useAccount, useConnect, useDisconnect, useBalance, useConnectors, useReadContract, useChainId } from 'wagmi';
import { motion, AnimatePresence } from 'framer-motion';
import { Wallet, ChevronDown, ChevronRight, LogOut, Copy, Check, ExternalLink, X, Loader2, User, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRegistry } from '@/hooks/useRegistryContract';
import { Avatar } from '@/components/shared/Avatar';

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

export default function WalletStatus() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: balance } = useBalance({ address });
  const connectors = useConnectors();
  const registry = useRegistry(address);

  const [open, setOpen] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [usernameInput, setUsernameInput] = useState('');
  const [usernameError, setUsernameError] = useState('');
  const [txError, setTxError] = useState('');

  const [displayName, setDisplayName] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    try {
      const raw = window.localStorage.getItem('settings:username');
      return raw !== null && raw !== undefined ? (JSON.parse(raw) as string) : '';
    } catch { return ''; }
  });

  const refreshDisplayName = () => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem('settings:username');
      const v = raw !== null && raw !== undefined ? JSON.parse(raw) : '';
      setDisplayName(typeof v === 'string' ? v : '');
    } catch { /* ignore */ }
  };

  useEffect(() => {
    const onName = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail !== undefined && detail !== null) setDisplayName(detail);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'settings:username') refreshDisplayName();
    };
    window.addEventListener('synq:displayname', onName);
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', refreshDisplayName);
    return () => {
      window.removeEventListener('synq:displayname', onName);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', refreshDisplayName);
    };
  }, []);

  // Profile photo for the top bar. Refetched on focus and whenever the display
  // name is saved (Profile page dispatches synq:displayname on save).
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!address) { setAvatarSrc(null); return; }
    let cancelled = false;
    const load = () =>
      fetch(`/api/profile?wallet=${address}`)
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setAvatarSrc(d?.avatar || null); })
        .catch(() => { /* keep initials */ });
    load();
    window.addEventListener('focus', load);
    window.addEventListener('synq:displayname', load);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', load);
      window.removeEventListener('synq:displayname', load);
    };
  }, [address]);

  // Live uniqueness check — the username becomes the user's on-chain digital identity
  const trimmedName = usernameInput.trim();
  const { data: isTaken } = useReadContract({
    ...registry.config,
    functionName: 'isUsernameTaken',
    args: trimmedName.length >= 3 ? [trimmedName] : undefined,
    query: { enabled: trimmedName.length >= 3 },
  });

  // Connected but no username → show registration modal (computed inline, no effect timing issues)
  const needsRegistration = isConnected && !!address && !registry.isLoading &&
    (registry.username === undefined || registry.username.length === 0);

  // After successful registration → refetch
  useEffect(() => {
    if (registry.txReceipt.isSuccess) {
      registry.refetchUsername();
    }
  }, [registry.txReceipt.isSuccess]);

  // Surface on-chain failure (e.g. username already taken)
  useEffect(() => {
    if (registry.error) {
      const msg = registry.error.message || '';
      if (msg.toLowerCase().includes('taken') || msg.toLowerCase().includes('exists')) {
        setTxError('This username is already taken on-chain — pick another one');
      } else {
        setTxError('Transaction failed. ' + (msg.includes('rejected') || msg.includes('denied') ? 'Signature was rejected.' : 'You can try again.'));
      }
      registry.refetchUsername();
    }
  }, [registry.error]);

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
    const idMap: Record<string, string> = {
      metaMask: 'injected', rabby: 'injected', phantom: 'injected',
      coinbaseWallet: 'coinbaseWalletSDK', walletConnect: 'walletConnect',
    };
    const targetId = idMap[option.id] || option.id;
    const connector = connectors.find((c) => c.id === targetId);
    if (!connector) {
      alert(`Wallet connector not found. Make sure ${option.name} is installed.`);
      setConnecting(null); setShowModal(false); return;
    }
    try { await connect({ connector }); }
    catch (e: any) {
      if (!(e?.message?.includes('rejected') || e?.code === 4001)) alert(`Connection failed: ${e?.message || 'Unknown error'}`);
    }
    setConnecting(null); setShowModal(false);
  };

  const handleRegisterUsername = () => {
    const name = usernameInput.trim();
    if (name.length < 3 || name.length > 32) { setUsernameError('3-32 characters required'); return; }
    if (!/^[a-zA-Z0-9_]+$/.test(name)) { setUsernameError('Only letters, numbers, and underscores'); return; }
    if (isTaken) { setUsernameError('This username is already taken — pick another one'); return; }
    setUsernameError('');
    setTxError('');
    registry.register(name);
  };

  if (isConnected) {
    return (
      <div className="relative">
        <button onClick={() => { refreshDisplayName(); setOpen(!open); }} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-700 bg-zinc-800/50 text-sm text-zinc-300 hover:bg-zinc-700 hover:text-white transition-all">
          <Avatar name={displayName || registry.username || ''} src={avatarSrc} size={22} className="rounded-md" />
          <div className="w-2 h-2 rounded-full bg-green-400" />
          <span className="hidden sm:inline">
            {/* Top-bar shows the display name only — the @username is redundant
                clutter here (still available in the dropdown's Username card). */}
            {displayName ? (
              <span className="text-blue-400">{displayName}</span>
            ) : (
              registry.username || truncateAddress(address!)
            )}
          </span>
          <span className="text-zinc-500 hidden sm:inline">|</span>
          <span className="text-xs text-zinc-400 hidden sm:inline">{balance ? formatBalance(balance) : '...'}</span>
          <ChevronDown size={14} className="text-zinc-500" />
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
                        {registry.username && <span className="text-zinc-500"> @{registry.username}</span>}
                      </>
                    ) : (
                      registry.username ? `@${registry.username}` : 'Wallet'
                    )}
                  </span>
                  <div className="flex items-center gap-1 text-xs text-zinc-500"><div className="w-1.5 h-1.5 rounded-full bg-green-400" /> Connected</div>
                </div>
                <div className="p-3 rounded-lg bg-zinc-800/50 mb-3">
                  <div className="text-xs text-zinc-500 mb-1">Address</div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-white font-mono">{truncateAddress(address!)}</span>
                    <button onClick={copyAddress} className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors">
                      {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>
                {registry.username && (
                  <div className="p-3 rounded-lg bg-zinc-800/50 mb-3">
                    <div className="text-xs text-zinc-500 mb-1">Username</div>
                    <div className="text-sm text-blue-400">@{registry.username}</div>
                  </div>
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

        <AnimatePresence>
          {needsRegistration && (
            <>
              <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50" onClick={() => {}} />
              <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }}
                className="fixed inset-0 z-50 flex items-center justify-center p-4">
                <div className="w-full max-w-md rounded-2xl border border-zinc-700/50 bg-zinc-900 shadow-2xl overflow-hidden">
                  <div className="flex items-center justify-between p-5 border-b border-zinc-800">
                    <div>
                      <h2 className="text-lg font-semibold text-white">Create Your Unique ID</h2>
                      <p className="text-sm text-zinc-400 mt-0.5">You must register a username before using Synq.</p>
                    </div>
                  </div>
                  <div className="p-5 space-y-4">
                    {registry.isLoading ? (
                      <div className="flex items-center justify-center gap-2 py-8 text-zinc-400">
                        <Loader2 size={18} className="animate-spin text-blue-400" />
                        <span className="text-sm">Checking registry...</span>
                      </div>
                    ) : registry.username === undefined ? (
                      <>
                        <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-600/10 border border-amber-500/20">
                          <span className="text-xs text-amber-400">
                            {String(registry.config.address ?? '').length < 2
                              ? <>Synq contracts are <strong>not deployed on {chainId === 11155111 ? 'Ethereum Sepolia' : 'this network'}</strong> yet. Deploy them first, then reconnect.</>
                              : <>Cannot reach the registry contract. Your wallet is on <strong>{chainId === 11155111 ? 'Ethereum Sepolia' : chainId === 31337 ? 'Hardhat localhost:8545' : `chain ${chainId}`}</strong> — {chainId === 11155111 ? 'the registry address seems wrong or RPC is down.' : 'switch to <strong>Ethereum Sepolia</strong> in your wallet for testnet mode, or start the local node for Hardhat mode.'}</>}
                          </span>
                        </div>
                        <button
                          onClick={() => registry.refetchUsername()}
                          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-zinc-700 text-sm text-zinc-300 hover:bg-zinc-800 transition-all"
                        >
                          <Loader2 size={16} /> Retry Connection
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center gap-3 p-3 rounded-lg bg-zinc-800/50">
                          <User size={20} className="text-blue-400" />
                          <span className="text-sm text-zinc-300 font-mono">{truncateAddress(address!)}</span>
                        </div>
                        <div>
                          <label className="text-xs text-zinc-500 mb-1 block">Username</label>
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 text-sm">@</span>
                            <input
                              value={usernameInput}
                              onChange={(e) => { setUsernameInput(e.target.value.replace(/[^a-zA-Z0-9_]/g, '')); setUsernameError(''); }}
                              onKeyDown={(e) => e.key === 'Enter' && handleRegisterUsername()}
                              placeholder="your_unique_id"
                              className="w-full h-11 rounded-xl border border-zinc-700 bg-zinc-800/50 pl-8 pr-4 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 font-mono"
                              autoFocus
                              maxLength={32}
                            />
                          </div>
                          <p className="text-xs text-zinc-500 mt-1">3-32 characters, letters, numbers, underscores. This is your permanent digital identity on Synq.</p>
                        </div>
                        {isTaken && <p className="text-xs text-red-400">This username is already taken — pick another one</p>}
                        {usernameError && <p className="text-xs text-red-400">{usernameError}</p>}
                        {txError && <p className="text-xs text-red-400">{txError}</p>}
                        <button
                          onClick={handleRegisterUsername}
                          disabled={usernameInput.length < 3 || registry.isPending || isTaken}
                          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 text-sm text-white font-medium hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                        >
                          {registry.isPending ? <><Loader2 size={16} className="animate-spin" /> Signing...</> : <><Sparkles size={16} /> Register Unique ID</>}
                        </button>
                        <p className="text-xs text-zinc-500 text-center">This creates an on-chain record linking your wallet to this unique username.</p>
                      </>
                    )}
                  </div>
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
