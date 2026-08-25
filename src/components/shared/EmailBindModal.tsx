'use client';

import { useState, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { motion } from 'framer-motion';
import { X, Mail, Loader2, CheckCircle, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Asks the connected wallet to bind an email so deal notifications
 * (confirmed / work submitted / completed / cancelled) can reach them.
 * Reappears on every fresh page load until an email is bound; "Not now"
 * only dismisses it for the current session.
 */
export default function EmailBindModal() {
  const { address, isConnected } = useAccount();
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [step, setStep] = useState<'email' | 'code' | 'done'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isConnected || !address) {
      setOpen(false);
      return;
    }
    if (typeof window !== 'undefined' && sessionStorage.getItem('emailBindDismissed') === address.toLowerCase()) return;
    let cancelled = false;
    fetch(`/api/auth?address=${address}&mode=email_status`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && d.bound === false) setOpen(true); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [address, isConnected]);

  const dismiss = () => {
    if (address) sessionStorage.setItem('emailBindDismissed', address.toLowerCase());
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
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'bind_email', walletAddress: address, email: email.trim() }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d.error || 'Could not send the code.');
      } else {
        setInfo(d.message || 'Code sent.');
        setStep('code');
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
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'bind_email_verify', walletAddress: address, email: email.trim(), code: code.trim() }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d.error || 'Verification failed.');
      } else {
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
        {step !== 'done' && (
          <button onClick={dismiss} className="absolute top-4 right-4 p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors" aria-label="Not now">
            <X size={16} />
          </button>
        )}

        {step === 'done' ? (
          <div className="text-center py-4">
            <div className="w-14 h-14 rounded-full bg-green-500/15 flex items-center justify-center mx-auto mb-4">
              <CheckCircle size={28} className="text-green-400" />
            </div>
            <h3 className="text-lg font-bold text-white mb-1">Email connected</h3>
            <p className="text-sm text-zinc-400">{email} will now receive deal notifications.</p>
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
                <button onClick={() => { setStep('email'); setCode(''); setInfo(''); }} className="text-xs text-zinc-500 hover:text-white w-full text-center">
                  Use a different email
                </button>
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