'use client';

import { useState, useEffect, useCallback } from 'react';
import { Mail, Loader2, Check, ShieldCheck, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthSession } from '@/hooks/useAuthSession';

/**
 * Inline email management for the Profile page. Shows the email currently bound
 * to the connected wallet and lets the user link, change, or unbind it using
 * authenticated /api/auth endpoints.
 */
export default function ProfileEmail({
  address,
  onEmailChange,
}: {
  address?: string;
  onEmailChange?: (email: string | null) => void;
}) {
  const { ensureAuthenticated } = useAuthSession();
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'view' | 'email' | 'code' | 'unlink'>('view');
  const [draft, setDraft] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    if (!address) { setEmail(null); onEmailChange?.(null); return; }
    setLoading(true);
    let cancelled = false;
    void (async () => {
      try {
        const token = await ensureAuthenticated();
        const response = await fetch(`/api/profile?wallet=${address}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json();
        if (!cancelled && response.ok) {
          const val = data?.email || null;
          setEmail(val);
          onEmailChange?.(val);
        }
      } catch {
        // Keep the last owner-only value when authentication or loading fails.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [address, ensureAuthenticated, onEmailChange]);

  useEffect(() => {
    const cleanup = refresh();
    setMode('view'); setCode(''); setInfo(''); setError('');
    return cleanup;
  }, [refresh]);

  const requestCode = async () => {
    setError(''); setInfo('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.trim())) { setError('Enter a valid email address.'); return; }
    setBusy(true);
    try {
      const token = await ensureAuthenticated();
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ type: 'bind_email', walletAddress: address, email: draft.trim() }),
      });
      const d = await res.json();
      if (!res.ok) setError(d.error || 'Could not send the code.');
      else { setInfo(d.message || 'Code sent.'); setMode('code'); }
    } catch (err: any) {
      setError(err?.message || 'Network error. Try again.');
    }
    setBusy(false);
  };

  const verify = async () => {
    setError(''); setBusy(true);
    try {
      const token = await ensureAuthenticated();
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ type: 'bind_email_verify', walletAddress: address, email: draft.trim(), code: code.trim() }),
      });
      const d = await res.json();
      if (!res.ok) setError(d.error || 'Verification failed.');
      else {
        const newEmail = draft.trim().toLowerCase();
        setEmail(newEmail);
        onEmailChange?.(newEmail);
        setMode('view');
        setCode('');
        setInfo('');
        setDraft('');
      }
    } catch (err: any) {
      setError(err?.message || 'Network error. Try again.');
    }
    setBusy(false);
  };

  const unbind = async () => {
    setError(''); setInfo(''); setBusy(true);
    try {
      const token = await ensureAuthenticated();
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ type: 'unbind_email', walletAddress: address }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d.error || 'Could not unlink email.');
      } else {
        setEmail(null);
        onEmailChange?.(null);
        setMode('view');
        setCode('');
        setDraft('');
        setInfo('');
      }
    } catch (err: any) {
      setError(err?.message || 'Network error. Try again.');
    }
    setBusy(false);
  };

  return (
    <div>
      <label className="text-xs text-zinc-500 block mb-1">Email</label>

      {!address ? (
        <p className="text-[11px] text-zinc-600">Connect your wallet to link an email for notifications.</p>
      ) : mode === 'view' ? (
        <div className="flex items-center gap-2 flex-wrap">
          {loading ? (
            <span className="text-xs text-zinc-500 flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Checking…</span>
          ) : email ? (
            <>
              <span className="text-sm text-white bg-zinc-800/50 rounded-lg px-3 py-1.5 flex items-center gap-1.5">
                <ShieldCheck size={13} className="text-emerald-400" /> {email}
              </span>
              <Button type="button" size="sm" variant="ghost" className="gap-1.5" onClick={() => { setDraft(email); setMode('email'); setError(''); setInfo(''); }}>
                <Pencil size={13} /> Change
              </Button>
              <Button type="button" size="sm" variant="ghost" className="gap-1.5 text-zinc-400 hover:text-red-400" onClick={() => { setMode('unlink'); setError(''); setInfo(''); }}>
                <Trash2 size={13} /> Unlink
              </Button>
            </>
          ) : (
            <>
              <span className="text-sm text-zinc-500">No email linked</span>
              <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => { setDraft(''); setMode('email'); setError(''); setInfo(''); }}>
                <Mail size={13} /> Link email
              </Button>
            </>
          )}
        </div>
      ) : mode === 'unlink' ? (
        <div className="space-y-2 max-w-xs bg-zinc-900/60 border border-zinc-800/80 rounded-lg p-3">
          <p className="text-xs font-medium text-white">Unlink email?</p>
          <p className="text-xs font-mono text-zinc-300">{email}</p>
          <p className="text-[11px] text-zinc-400 leading-snug">
            You will no longer receive order and message email notifications.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={unbind}
              disabled={busy}
              className="gap-1.5 text-xs h-8"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
              {busy ? 'Unlinking...' : 'Unlink Email'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => { setMode('view'); setError(''); setInfo(''); }}
              disabled={busy}
              className="text-xs h-8"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : mode === 'email' ? (
        <div className="space-y-2 max-w-xs">
          <Input
            type="email"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') requestCode(); }}
            placeholder="you@example.com"
            autoFocus
          />
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={requestCode} disabled={busy || !draft.trim()} className="gap-1.5">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />} Send code
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setMode('view'); setError(''); setInfo(''); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 max-w-xs">
          <p className="text-xs text-zinc-400">Enter the 6-digit code sent to <span className="text-white">{draft}</span></p>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6) verify(); }}
            placeholder="000000"
            className="text-center text-lg tracking-[0.3em] font-mono"
            autoFocus
          />
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={verify} disabled={busy || code.length !== 6} className="gap-1.5">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Verify &amp; link
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setMode('email'); setCode(''); }}>Back</Button>
          </div>
        </div>
      )}

      {info && mode !== 'view' && <p className="text-[11px] text-amber-400/90 mt-1">{info}</p>}
      {error && <p className="text-[11px] text-red-400 mt-1">{error}</p>}
      {mode === 'view' && !!email && !loading && (
        <p className="text-[11px] text-zinc-600 mt-1">Order &amp; message notifications are sent here.</p>
      )}
    </div>
  );
}
