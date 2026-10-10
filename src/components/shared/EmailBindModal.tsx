'use client';

import { useState, useEffect, useRef } from 'react';
import { useAccount } from 'wagmi';
import { motion } from 'framer-motion';
import { X, Mail, Loader2, CheckCircle, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthSession } from '@/hooks/useAuthSession';

const DISMISS_KEY_PREFIX = 'synq_email_bind_dismissed_';

/** In-memory cache of verified wallets for the active application lifecycle. */
const verifiedWalletsCache = new Set<string>();

function isWalletDismissed(wallet: string): boolean {
  if (typeof window === 'undefined' || !wallet) return false;
  try {
    const key = `${DISMISS_KEY_PREFIX}${wallet.toLowerCase()}`;
    return Boolean(window.localStorage.getItem(key) || window.sessionStorage.getItem(key));
  } catch {
    return false;
  }
}

function setWalletDismissed(wallet: string) {
  if (typeof window === 'undefined' || !wallet) return;
  try {
    const key = `${DISMISS_KEY_PREFIX}${wallet.toLowerCase()}`;
    const now = Date.now().toString();
    window.localStorage.setItem(key, now);
    window.sessionStorage.setItem(key, now);
  } catch {}
}

function clearWalletDismissed(wallet: string) {
  if (typeof window === 'undefined' || !wallet) return;
  try {
    const key = `${DISMISS_KEY_PREFIX}${wallet.toLowerCase()}`;
    window.localStorage.removeItem(key);
    window.sessionStorage.removeItem(key);
  } catch {}
}

/**
 * Prompts the connected wallet to bind an email for deal notifications.
 * Persistent: does not prompt wallets that have already verified an email.
 * Wallet-scoped: tracks dismissals per wallet without global browser-wide suppression.
 * Resilient: handles reloads, strict mode, account switching, and network failures.
 */
export default function EmailBindModal() {
  const { address, isConnected } = useAccount();
  const { ensureAuthenticated } = useAuthSession();
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [step, setStep] = useState<'email' | 'code' | 'done'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const [boundEmail, setBoundEmail] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);
  const activeWalletRef = useRef<string | null>(null);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const interval = setInterval(() => {
      setResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [resendCooldown]);

  // External trigger support (e.g. from Profile or Settings button)
  useEffect(() => {
    const handleOpen = () => {
      if (!address) return;
      const currentWallet = address.toLowerCase();
      setError('');
      setInfo('');
      setResendCooldown(0);
      if (verifiedWalletsCache.has(currentWallet) || boundEmail) {
        setStep('done');
      } else {
        setStep('email');
      }
      setOpen(true);
    };
    window.addEventListener('synq:open-email-bind', handleOpen);
    return () => window.removeEventListener('synq:open-email-bind', handleOpen);
  }, [address, boundEmail]);

  useEffect(() => {
    // Clear stale UI state on wallet change or disconnection
    setStep('email');
    setEmail('');
    setCode('');
    setInfo('');
    setError('');
    setBoundEmail(null);
    setResendCooldown(0);
    setOpen(false);

    if (!isConnected || !address) {
      activeWalletRef.current = null;
      setChecking(false);
      return;
    }

    const currentWallet = address.toLowerCase();
    activeWalletRef.current = currentWallet;

    // Fast-path: wallet already verified in this session
    if (verifiedWalletsCache.has(currentWallet)) {
      setChecking(false);
      return;
    }

    // Fast-path: wallet dismissed by user
    if (isWalletDismissed(currentWallet)) {
      setChecking(false);
      return;
    }

    let cancelled = false;
    setChecking(true);

    // Retrieve cached auth token if already exists, without forcing sign-in prompt on mount
    let authHeader: HeadersInit = {};
    try {
      const raw = window.sessionStorage.getItem('synq_auth_session');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.wallet?.toLowerCase() === currentWallet && parsed?.token) {
          authHeader = { Authorization: `Bearer ${parsed.token}` };
        }
      }
    } catch {}

    fetch(`/api/auth?address=${address}&mode=email_status`, { headers: authHeader })
      .then((r) => {
        if (!r.ok) throw new Error('Status query failed');
        return r.json();
      })
      .then((d) => {
        if (cancelled || activeWalletRef.current !== currentWallet) return;
        if (d?.bound === true) {
          verifiedWalletsCache.add(currentWallet);
          if (d.email) setBoundEmail(d.email);
          setOpen(false);
        } else if (d?.bound === false) {
          // Only open if not dismissed in the meantime
          setOpen(!isWalletDismissed(currentWallet));
        } else {
          // Non-definitive payload: avoid treating as proof of no email
          setOpen(false);
        }
      })
      .catch(() => {
        // Network/API failure: avoid treating error as proof that wallet has no email
        if (!cancelled && activeWalletRef.current === currentWallet) {
          setOpen(false);
        }
      })
      .finally(() => {
        if (!cancelled && activeWalletRef.current === currentWallet) {
          setChecking(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [address, isConnected]);

  const dismiss = () => {
    if (address) {
      setWalletDismissed(address);
    }
    setOpen(false);
  };

  const requestCode = async () => {
    setError('');
    setInfo('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    try {
      const token = await ensureAuthenticated();
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ type: 'bind_email', walletAddress: address, email: email.trim() }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d.error || 'Could not send the code.');
      } else {
        setInfo(d.message || 'Code sent.');
        setStep('code');
        setResendCooldown(60);
      }
    } catch {
      setError('Network error. Try again.');
    }
    setBusy(false);
  };

  const verifyCode = async () => {
    setError('');
    setBusy(true);
    try {
      const token = await ensureAuthenticated();
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ type: 'bind_email_verify', walletAddress: address, email: email.trim(), code: code.trim() }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d.error || 'Verification failed.');
      } else {
        if (address) {
          const normalized = address.toLowerCase();
          verifiedWalletsCache.add(normalized);
          clearWalletDismissed(normalized);
          try {
            window.dispatchEvent(new CustomEvent('synq:email-bound', { detail: { wallet: normalized, email: email.trim() } }));
          } catch {}
        }
        setStep('done');
        setTimeout(() => setOpen(false), 1800);
      }
    } catch {
      setError('Network error. Try again.');
    }
    setBusy(false);
  };

  if (!open || checking) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-md rounded-2xl border border-zinc-700/50 bg-zinc-900 shadow-2xl p-6 relative"
      >
        {step === 'done' ? (
          <div className="text-center py-4">
            <button
              onClick={() => setOpen(false)}
              className="absolute top-4 right-4 p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>
            <div className="w-14 h-14 rounded-full bg-emerald-500/15 flex items-center justify-center mx-auto mb-4">
              <CheckCircle size={28} className="text-emerald-400" />
            </div>
            <h3 className="text-lg font-bold text-white mb-1">Email Connected</h3>
            <p className="text-sm text-zinc-300 font-mono mb-2">{boundEmail || email || 'Verified account'}</p>
            <p className="text-xs text-zinc-400 max-w-xs mx-auto mb-6">
              Deal notifications are automatically active for this connected wallet across browser sessions.
            </p>
            <div className="flex gap-2 justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setStep('email');
                  setEmail('');
                  setCode('');
                  setError('');
                  setInfo('');
                  setResendCooldown(0);
                }}
                className="text-xs border-zinc-700 hover:bg-zinc-800 text-zinc-300"
              >
                Change email
              </Button>
              <Button
                size="sm"
                onClick={() => setOpen(false)}
                className="text-xs bg-zinc-800 hover:bg-zinc-700 text-white"
              >
                Done
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-1">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center">
                <Mail size={18} className="text-white" />
              </div>
              <div>
                <h3 className="font-bold text-white">Link your email</h3>
                <p className="text-xs text-zinc-500">Required to receive deal notifications</p>
              </div>
            </div>

            <div className="mt-4 p-3 rounded-xl bg-blue-600/5 border border-blue-500/20 flex items-start gap-2">
              <ShieldCheck size={14} className="text-blue-400 shrink-0 mt-0.5" />
              <p className="text-xs text-zinc-400">
                Get emailed when your deals are confirmed, work is submitted, completed, or cancelled. Your wallet
                <span className="text-zinc-300 font-mono"> {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : ''} </span>
                will be linked to this email.
              </p>
            </div>

            {step === 'email' && (
              <div className="mt-4 space-y-3">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && requestCode()}
                  placeholder="you@example.com"
                  autoFocus
                />
                <Button onClick={requestCode} disabled={busy || !email.trim()} className="w-full gap-2">
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <Mail size={15} />}
                  Send verification code
                </Button>
                <button
                  type="button"
                  onClick={dismiss}
                  className="text-xs text-zinc-500 hover:text-zinc-300 w-full text-center transition-colors pt-1"
                >
                  Skip for now
                </button>
              </div>
            )}

            {step === 'code' && (
              <div className="mt-4 space-y-3">
                <p className="text-xs text-zinc-400">Enter the 6-digit code sent to <span className="text-white">{email}</span></p>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && verifyCode()}
                  placeholder="000000"
                  className="text-center text-xl tracking-[0.4em] font-mono"
                  autoFocus
                />
                <Button onClick={verifyCode} disabled={busy || code.length !== 6} className="w-full gap-2">
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle size={15} />}
                  Verify & link email
                </Button>
                <div className="flex items-center justify-between pt-1">
                  <button
                    type="button"
                    onClick={requestCode}
                    disabled={busy || resendCooldown > 0}
                    className="text-xs text-blue-400 hover:text-blue-300 disabled:text-zinc-600 disabled:cursor-not-allowed transition-colors"
                  >
                    {resendCooldown > 0 ? `Resend code (${resendCooldown}s)` : 'Resend code'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setStep('email'); setCode(''); setInfo(''); setError(''); setResendCooldown(0); }}
                    className="text-xs text-zinc-500 hover:text-white"
                  >
                    Use different email
                  </button>
                </div>
              </div>
            )}

            {info && <p className="text-xs text-amber-400/90 mt-3">{info}</p>}
            {error && <p className="text-xs text-red-400 mt-3">{error}</p>}
          </>
        )}
      </motion.div>
    </div>
  );
}
