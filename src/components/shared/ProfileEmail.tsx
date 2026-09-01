'use client';

import { useState, useEffect, useCallback } from 'react';
import { Mail, Loader2, Check, ShieldCheck, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Inline email management for the Profile page. Shows the email currently bound
 * to the connected wallet and lets the user link or change it using the same
 * code-verify flow as the global EmailBindModal (/api/auth bind_email →
 * bind_email_verify). The bound email is what order/chat notifications are sent
 * to, so surfacing it here tells the user exactly where their alerts go.
 */
export default function ProfileEmail({ address }: { address?: string }) {
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'view' | 'email' | 'code'>('view');
  const [draft, setDraft] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    if (!address) { setEmail(null); return; }
    setLoading(true);
    let cancelled = false;
    fetch(`/api/profile?wallet=${address}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setEmail(d?.email || null); })
      .catch(() => { /* keep last */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [address]);

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
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'bind_email', walletAddress: address, email: draft.trim() }),
      });
      const d = await res.json();
      if (!res.ok) setError(d.error || 'Could not send the code.');
      else { setInfo(d.message || 'Code sent.'); setMode('code'); }
    } catch { setError('Network error. Try again.'); }
    setBusy(false);
  };

  const verify = async () => {
    setError(''); setBusy(true);
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'bind_email_verify', walletAddress: address, email: draft.trim(), code: code.trim() }),
      });
      const d = await res.json();
      if (!res.ok) setError(d.error || 'Verification failed.');
      else { setEmail(draft.trim().toLowerCase()); setMode('view'); setCode(''); setInfo(''); }
    } catch { setError('Network error. Try again.'); }
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
              <Button type="button" size="sm" variant="ghost" className="gap-1.5" onClick={() => { setDraft(email); setMode('email'); }}>
                <Pencil size={13} /> Change
              </Button>
            </>
          ) : (
            <>
              <span className="text-sm text-zinc-500">No email linked</span>
              <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => { setDraft(''); setMode('email'); }}>
                <Mail size={13} /> Link email
              </Button>
            </>
          )}
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
