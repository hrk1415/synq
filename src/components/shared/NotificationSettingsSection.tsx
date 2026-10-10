'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Mail,
  ShieldCheck,
  Check,
  Loader2,
  Trash2,
  Pencil,
  RotateCcw,
  Bell,
  CheckCircle2,
  AlertCircle,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useAuthSession } from '@/hooks/useAuthSession';
import {
  type NotificationPreferences,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from '@/lib/deals/notification-preferences-types';

interface NotificationSettingsSectionProps {
  address?: string;
  onEmailChange?: (email: string | null) => void;
}

export default function NotificationSettingsSection({
  address,
  onEmailChange,
}: NotificationSettingsSectionProps) {
  const { ensureAuthenticated } = useAuthSession();

  // Email State
  const [email, setEmail] = useState<string | null>(null);
  const [loadingEmail, setLoadingEmail] = useState(false);
  const [emailMode, setEmailMode] = useState<'view' | 'email' | 'code' | 'unlink'>('view');
  const [emailDraft, setEmailDraft] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailInfo, setEmailInfo] = useState('');
  const [emailError, setEmailError] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);

  // Preferences State
  const [preferences, setPreferences] = useState<NotificationPreferences>({
    ...DEFAULT_NOTIFICATION_PREFERENCES,
  });
  const [loadingPrefs, setLoadingPrefs] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [prefsSuccess, setPrefsSuccess] = useState(false);
  const [prefsError, setPrefsError] = useState('');
  const [hasPrefsChanges, setHasPrefsChanges] = useState(false);
  const baselinePrefsRef = useRef<NotificationPreferences>({ ...DEFAULT_NOTIFICATION_PREFERENCES });

  // Cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const interval = setInterval(() => {
      setResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [resendCooldown]);

  // Load email and preferences on wallet change
  const loadData = useCallback(() => {
    // Reset all transient state on wallet change or disconnect
    setEmailMode('view');
    setEmailDraft('');
    setOtpCode('');
    setEmailInfo('');
    setEmailError('');
    setResendCooldown(0);
    setPrefsError('');
    setPrefsSuccess(false);
    setHasPrefsChanges(false);

    if (!address) {
      setEmail(null);
      setPreferences({ ...DEFAULT_NOTIFICATION_PREFERENCES });
      baselinePrefsRef.current = { ...DEFAULT_NOTIFICATION_PREFERENCES };
      onEmailChange?.(null);
      return;
    }

    const currentWallet = address.toLowerCase();
    let cancelled = false;

    // 1. Fetch Email
    setLoadingEmail(true);
    void (async () => {
      try {
        const token = await ensureAuthenticated();
        if (cancelled) return;
        const res = await fetch(`/api/profile?wallet=${currentWallet}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            const bound = data?.email || null;
            setEmail(bound);
            onEmailChange?.(bound);
          }
        }
      } catch {
        // Leave null if unauthenticated or failed
      } finally {
        if (!cancelled) setLoadingEmail(false);
      }
    })();

    // 2. Fetch Preferences
    setLoadingPrefs(true);
    void (async () => {
      try {
        const token = await ensureAuthenticated();
        if (cancelled) return;
        const res = await fetch(`/api/notifications/preferences?wallet=${currentWallet}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          if (!cancelled && data.preferences) {
            const loaded = {
              dealProposalsAndConfirmations: Boolean(data.preferences.dealProposalsAndConfirmations),
              milestoneSubmissionsAndRevisions: Boolean(data.preferences.milestoneSubmissionsAndRevisions),
              paymentsAndCompletions: Boolean(data.preferences.paymentsAndCompletions),
              disputesAndResolutions: Boolean(data.preferences.disputesAndResolutions),
            };
            setPreferences(loaded);
            baselinePrefsRef.current = { ...loaded };
          }
        }
      } catch {
        // Defaults apply
      } finally {
        if (!cancelled) setLoadingPrefs(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [address, ensureAuthenticated, onEmailChange]);

  useEffect(() => {
    return loadData();
  }, [loadData]);

  // Listen to external email bound events
  useEffect(() => {
    const handleBound = (e: any) => {
      const boundWallet = e?.detail?.wallet;
      const boundEmail = e?.detail?.email;
      if (address && boundWallet && boundWallet.toLowerCase() === address.toLowerCase()) {
        setEmail(boundEmail);
        onEmailChange?.(boundEmail);
        setEmailMode('view');
      }
    };
    window.addEventListener('synq:email-bound', handleBound);
    return () => window.removeEventListener('synq:email-bound', handleBound);
  }, [address, onEmailChange]);

  // Request OTP code
  const handleRequestCode = async () => {
    setEmailError('');
    setEmailInfo('');
    const cleanEmail = emailDraft.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setEmailError('Enter a valid email address.');
      return;
    }
    setEmailBusy(true);
    try {
      const token = await ensureAuthenticated();
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ type: 'bind_email', walletAddress: address, email: cleanEmail }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEmailError(data.error || 'Could not send the verification code.');
      } else {
        setEmailInfo(data.message || `Verification code sent to ${cleanEmail}.`);
        setEmailMode('code');
        setResendCooldown(60);
      }
    } catch {
      setEmailError('Network error. Try again.');
    } finally {
      setEmailBusy(false);
    }
  };

  // Verify OTP code
  const handleVerifyCode = async () => {
    setEmailError('');
    setEmailBusy(true);
    const cleanEmail = emailDraft.trim().toLowerCase();
    try {
      const token = await ensureAuthenticated();
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          type: 'bind_email_verify',
          walletAddress: address,
          email: cleanEmail,
          code: otpCode.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEmailError(data.error || 'Verification failed. Please check the code.');
      } else {
        setEmail(cleanEmail);
        onEmailChange?.(cleanEmail);
        setEmailMode('view');
        setOtpCode('');
        setEmailDraft('');
        setEmailInfo('');
        setResendCooldown(0);
        try {
          if (address) {
            window.dispatchEvent(
              new CustomEvent('synq:email-bound', {
                detail: { wallet: address.toLowerCase(), email: cleanEmail },
              }),
            );
          }
        } catch {}
      }
    } catch {
      setEmailError('Network error. Try again.');
    } finally {
      setEmailBusy(false);
    }
  };

  // Unbind email
  const handleUnbind = async () => {
    setEmailError('');
    setEmailInfo('');
    setEmailBusy(true);
    try {
      const token = await ensureAuthenticated();
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ type: 'unbind_email', walletAddress: address }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEmailError(data.error || 'Could not unlink email.');
      } else {
        setEmail(null);
        onEmailChange?.(null);
        setEmailMode('view');
        setEmailDraft('');
        setOtpCode('');
      }
    } catch {
      setEmailError('Network error. Try again.');
    } finally {
      setEmailBusy(false);
    }
  };

  // Cancel edit/change flow
  const handleCancelEmailChange = () => {
    setEmailMode('view');
    setEmailDraft('');
    setOtpCode('');
    setEmailError('');
    setEmailInfo('');
    setResendCooldown(0);
  };

  // Toggle single preference
  const togglePreference = (key: keyof NotificationPreferences) => {
    setPreferences((prev) => {
      const updated = { ...prev, [key]: !prev[key] };
      const changed =
        updated.dealProposalsAndConfirmations !== baselinePrefsRef.current.dealProposalsAndConfirmations ||
        updated.milestoneSubmissionsAndRevisions !== baselinePrefsRef.current.milestoneSubmissionsAndRevisions ||
        updated.paymentsAndCompletions !== baselinePrefsRef.current.paymentsAndCompletions ||
        updated.disputesAndResolutions !== baselinePrefsRef.current.disputesAndResolutions;
      setHasPrefsChanges(changed);
      return updated;
    });
    setPrefsSuccess(false);
    setPrefsError('');
  };

  // Save Preferences
  const handleSavePreferences = async () => {
    if (!address) {
      setPrefsError('Connect your wallet first');
      return;
    }
    setSavingPrefs(true);
    setPrefsError('');
    setPrefsSuccess(false);

    try {
      const token = await ensureAuthenticated();
      const res = await fetch('/api/notifications/preferences', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          walletAddress: address,
          preferences,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setPrefsError(data.error || 'Failed to save preferences');
      } else {
        baselinePrefsRef.current = { ...preferences };
        setHasPrefsChanges(false);
        setPrefsSuccess(true);
        setTimeout(() => setPrefsSuccess(false), 3000);
      }
    } catch {
      setPrefsError('Network error while saving preferences');
    } finally {
      setSavingPrefs(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* SECTION HEADER */}
      <div>
        <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-2">
          <Bell size={14} className="text-blue-400" /> Notifications &amp; Email Management
        </h2>
        <p className="text-xs text-zinc-500 mt-0.5">
          Manage your verified deal notification address and fine-tune which events send you emails.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ==================================================
            CARD 1: EMAIL ADDRESS MANAGEMENT
        ================================================== */}
        <div className="p-5 rounded-xl bg-zinc-950/60 border border-zinc-800 space-y-4 flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Mail size={16} className={email ? 'text-emerald-400' : 'text-blue-400'} />
                <span className="text-sm font-semibold text-white">Deal Notification Email</span>
              </div>
              {loadingEmail ? (
                <span className="text-xs text-zinc-500 flex items-center gap-1.5 font-mono">
                  <Loader2 size={12} className="animate-spin" /> Checking...
                </span>
              ) : email ? (
                <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[11px] px-2 py-0.5 flex items-center gap-1 font-medium">
                  <ShieldCheck size={12} /> Verified
                </Badge>
              ) : (
                <Badge variant="outline" className="text-zinc-500 border-zinc-700 text-[11px] px-2 py-0.5">
                  Not Linked
                </Badge>
              )}
            </div>

            <p className="text-xs text-zinc-400 leading-relaxed">
              Deal confirmations, work submissions, milestone approvals, and payments are sent to this address.
              Your email is private and never published on-chain.
            </p>

            {/* Email UI State Machine */}
            {!address ? (
              <p className="text-xs text-zinc-500 italic py-2">Connect your wallet to manage your notification email.</p>
            ) : emailMode === 'view' ? (
              <div className="pt-2">
                {email ? (
                  <div className="p-3 rounded-lg bg-zinc-900/80 border border-zinc-800 flex items-center justify-between flex-wrap gap-3">
                    <div className="min-w-0 flex items-center gap-2">
                      <ShieldCheck size={16} className="text-emerald-400 shrink-0" />
                      <span className="text-sm font-mono text-zinc-200 truncate">{email}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEmailDraft(email);
                          setEmailMode('email');
                          setEmailError('');
                          setEmailInfo('');
                        }}
                        className="h-8 px-2.5 text-xs text-zinc-300 hover:text-white hover:bg-zinc-800 gap-1.5"
                      >
                        <Pencil size={12} /> Change
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEmailMode('unlink');
                          setEmailError('');
                          setEmailInfo('');
                        }}
                        className="h-8 px-2.5 text-xs text-zinc-400 hover:text-red-400 hover:bg-red-950/20 gap-1.5"
                      >
                        <Trash2 size={12} /> Unlink
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 rounded-lg bg-zinc-900/40 border border-dashed border-zinc-800 flex items-center justify-between flex-wrap gap-3">
                    <div className="text-xs text-zinc-400">
                      No email address is linked to this wallet.
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        setEmailDraft('');
                        setEmailMode('email');
                        setEmailError('');
                        setEmailInfo('');
                      }}
                      className="bg-blue-600 hover:bg-blue-500 text-white text-xs h-8 px-3 gap-1.5 font-medium shrink-0"
                    >
                      <Mail size={13} /> Link Email
                    </Button>
                  </div>
                )}
              </div>
            ) : emailMode === 'email' ? (
              /* DRAFT EMAIL INPUT */
              <div className="space-y-3 pt-2">
                <label className="text-xs text-zinc-300 block font-medium">
                  {email ? 'Enter new email address' : 'Enter your email address'}
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    type="email"
                    value={emailDraft}
                    onChange={(e) => setEmailDraft(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleRequestCode()}
                    placeholder="you@example.com"
                    disabled={emailBusy}
                    className="text-sm bg-zinc-900 border-zinc-700"
                    autoFocus
                  />
                  <Button
                    type="button"
                    onClick={handleRequestCode}
                    disabled={emailBusy || !emailDraft.trim()}
                    className="bg-blue-600 hover:bg-blue-500 text-white text-xs h-10 px-4 font-semibold shrink-0 gap-1.5"
                  >
                    {emailBusy ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
                    Send Code
                  </Button>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-zinc-500">
                    A 6-digit OTP code will be sent to confirm ownership.
                  </span>
                  <button
                    type="button"
                    onClick={handleCancelEmailChange}
                    disabled={emailBusy}
                    className="text-xs text-zinc-400 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : emailMode === 'code' ? (
              /* OTP CODE VERIFICATION */
              <div className="space-y-3 pt-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-zinc-300 block font-medium">
                    Enter code sent to <span className="text-white font-mono">{emailDraft}</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setEmailMode('email');
                      setOtpCode('');
                      setResendCooldown(0);
                    }}
                    className="text-xs text-zinc-400 hover:text-blue-400 transition-colors"
                  >
                    Change email
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    onKeyDown={(e) => e.key === 'Enter' && otpCode.length === 6 && handleVerifyCode()}
                    placeholder="000000"
                    disabled={emailBusy}
                    className="text-center text-lg tracking-[0.3em] font-mono bg-zinc-900 border-zinc-700 h-10"
                    autoFocus
                  />
                  <Button
                    type="button"
                    onClick={handleVerifyCode}
                    disabled={emailBusy || otpCode.length !== 6}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs h-10 px-4 font-semibold shrink-0 gap-1.5"
                  >
                    {emailBusy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                    Verify &amp; Link
                  </Button>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <button
                    type="button"
                    onClick={handleRequestCode}
                    disabled={emailBusy || resendCooldown > 0}
                    className="text-xs text-blue-400 hover:text-blue-300 disabled:text-zinc-600 disabled:cursor-not-allowed transition-colors"
                  >
                    {resendCooldown > 0 ? `Resend code (${resendCooldown}s)` : 'Resend code'}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelEmailChange}
                    disabled={emailBusy}
                    className="text-xs text-zinc-400 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              /* UNLINK CONFIRMATION */
              <div className="p-4 rounded-xl bg-red-950/20 border border-red-900/40 space-y-3 pt-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-red-400">
                  <AlertCircle size={15} /> Confirm Unlinking Email
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Are you sure you want to unlink <span className="text-zinc-200 font-mono">{email}</span>?
                  You will no longer receive deal updates or order notifications for this wallet.
                </p>
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={handleUnbind}
                    disabled={emailBusy}
                    className="h-8 text-xs gap-1.5"
                  >
                    {emailBusy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    Confirm Unlink
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={handleCancelEmailChange}
                    disabled={emailBusy}
                    className="h-8 text-xs text-zinc-400 hover:text-white"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {emailInfo && <p className="text-xs text-amber-400/90 pt-1">{emailInfo}</p>}
            {emailError && <p className="text-xs text-red-400 pt-1">{emailError}</p>}
          </div>

          <div className="pt-3 border-t border-zinc-800/60 text-[11px] text-zinc-500 flex items-center justify-between">
            <span>Identity: Wallet authenticated</span>
            {email && <span className="text-emerald-500 font-mono">Active Delivery ✓</span>}
          </div>
        </div>

        {/* ==================================================
            CARD 2: NOTIFICATION PREFERENCES
        ================================================== */}
        <div className="p-5 rounded-xl bg-zinc-950/60 border border-zinc-800 space-y-4 flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Bell size={16} className="text-blue-400" />
                <span className="text-sm font-semibold text-white">Event Notification Categories</span>
              </div>
              <span className="text-[10px] font-mono text-zinc-500 bg-zinc-800/60 rounded px-1.5 py-0.5">
                Wallet-scoped
              </span>
            </div>

            <p className="text-xs text-zinc-400 leading-relaxed">
              Fine-tune which transactional deal events trigger an email dispatch. Security OTP verification codes are always delivered.
            </p>

            {loadingPrefs ? (
              <div className="py-6 flex items-center justify-center gap-2 text-xs text-zinc-500 font-mono">
                <Loader2 size={14} className="animate-spin text-blue-400" /> Loading preferences...
              </div>
            ) : (
              <div className="space-y-3 pt-1">
                {/* CATEGORY 1: PROPOSALS & CONFIRMATIONS */}
                <div
                  onClick={() => togglePreference('dealProposalsAndConfirmations')}
                  className="p-3 rounded-lg bg-zinc-900/60 border border-zinc-800/80 hover:border-zinc-700 transition-colors cursor-pointer flex items-center justify-between gap-3 group"
                >
                  <div className="min-w-0 pr-2">
                    <div className="text-xs font-semibold text-white group-hover:text-blue-300 transition-colors">
                      Deal Proposals &amp; Confirmations
                    </div>
                    <div className="text-[11px] text-zinc-400 mt-0.5 leading-snug">
                      Proposals received, buyer confirmations, orders, and deal cancellations.
                    </div>
                  </div>
                  <div
                    className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${
                      preferences.dealProposalsAndConfirmations ? 'bg-blue-600' : 'bg-zinc-700'
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-0.5 ${
                        preferences.dealProposalsAndConfirmations ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </div>
                </div>

                {/* CATEGORY 2: MILESTONE SUBMISSIONS & REVISIONS */}
                <div
                  onClick={() => togglePreference('milestoneSubmissionsAndRevisions')}
                  className="p-3 rounded-lg bg-zinc-900/60 border border-zinc-800/80 hover:border-zinc-700 transition-colors cursor-pointer flex items-center justify-between gap-3 group"
                >
                  <div className="min-w-0 pr-2">
                    <div className="text-xs font-semibold text-white group-hover:text-blue-300 transition-colors">
                      Milestone Submissions &amp; Revisions
                    </div>
                    <div className="text-[11px] text-zinc-400 mt-0.5 leading-snug">
                      Deliverables submitted for review and client revision requests with feedback.
                    </div>
                  </div>
                  <div
                    className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${
                      preferences.milestoneSubmissionsAndRevisions ? 'bg-blue-600' : 'bg-zinc-700'
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-0.5 ${
                        preferences.milestoneSubmissionsAndRevisions ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </div>
                </div>

                {/* CATEGORY 3: PAYMENTS & COMPLETIONS */}
                <div
                  onClick={() => togglePreference('paymentsAndCompletions')}
                  className="p-3 rounded-lg bg-zinc-900/60 border border-zinc-800/80 hover:border-zinc-700 transition-colors cursor-pointer flex items-center justify-between gap-3 group"
                >
                  <div className="min-w-0 pr-2">
                    <div className="text-xs font-semibold text-white group-hover:text-blue-300 transition-colors">
                      Payments &amp; Deal Completion
                    </div>
                    <div className="text-[11px] text-zinc-400 mt-0.5 leading-snug">
                      Escrow milestone payments released, refunds issued, and final deal completions.
                    </div>
                  </div>
                  <div
                    className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${
                      preferences.paymentsAndCompletions ? 'bg-blue-600' : 'bg-zinc-700'
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-0.5 ${
                        preferences.paymentsAndCompletions ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </div>
                </div>

                {/* CATEGORY 4: DISPUTES & RESOLUTIONS */}
                <div
                  onClick={() => togglePreference('disputesAndResolutions')}
                  className="p-3 rounded-lg bg-zinc-900/60 border border-zinc-800/80 hover:border-zinc-700 transition-colors cursor-pointer flex items-center justify-between gap-3 group"
                >
                  <div className="min-w-0 pr-2">
                    <div className="text-xs font-semibold text-white group-hover:text-blue-300 transition-colors">
                      Disputes &amp; Resolution Activity
                    </div>
                    <div className="text-[11px] text-zinc-400 mt-0.5 leading-snug">
                      Formal dispute filings, settlement proposals, and committee resolutions.
                    </div>
                  </div>
                  <div
                    className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${
                      preferences.disputesAndResolutions ? 'bg-blue-600' : 'bg-zinc-700'
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-0.5 ${
                        preferences.disputesAndResolutions ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </div>
                </div>
              </div>
            )}

            {prefsError && <p className="text-xs text-red-400 font-medium">{prefsError}</p>}
            {prefsSuccess && (
              <p className="text-xs text-emerald-400 flex items-center gap-1.5 font-medium">
                <CheckCircle2 size={13} /> Preferences updated successfully!
              </p>
            )}
          </div>

          <div className="pt-3 border-t border-zinc-800/60 flex items-center justify-between flex-wrap gap-2">
            <span className="text-[11px] text-zinc-500">
              {hasPrefsChanges ? 'Unsaved changes' : 'All preferences saved'}
            </span>
            <Button
              type="button"
              size="sm"
              onClick={handleSavePreferences}
              disabled={!hasPrefsChanges || savingPrefs || !address}
              className="bg-blue-600 hover:bg-blue-500 text-white text-xs h-8 px-4 font-semibold shrink-0 gap-1.5 disabled:opacity-50"
            >
              {savingPrefs ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {savingPrefs ? 'Saving...' : 'Save Preferences'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
