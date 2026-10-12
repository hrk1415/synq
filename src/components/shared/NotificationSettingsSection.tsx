'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  Mail,
  ShieldCheck,
  Loader2,
  Trash2,
  Pencil,
  Bell,
  CheckCircle2,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
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

  // Load email and preferences on wallet change
  const loadData = useCallback(() => {
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
      }
    };
    window.addEventListener('synq:email-bound', handleBound);
    return () => window.removeEventListener('synq:email-bound', handleBound);
  }, [address, onEmailChange]);

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
        <h2 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
          <Bell size={14} className="text-white" /> Notifications &amp; Email Management
        </h2>
        <p className="text-xs text-[#A3A3A3] mt-0.5">
          Manage your verified deal notification address and fine-tune which events send you emails.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ==================================================
            CARD 1: EMAIL ADDRESS MANAGEMENT (DISPLAY ONLY)
            All add/change/unlink actions route to Profile -> Edit modal
        ================================================== */}
        <div className="p-5 rounded-xl bg-[#1B1B1B] border border-white/75 space-y-4 flex flex-col justify-between shadow-xl">
          <div className="space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Mail size={16} className={email ? 'text-emerald-400' : 'text-white'} />
                <span className="text-sm font-semibold text-white">Deal Notification Email</span>
              </div>
              {loadingEmail ? (
                <span className="text-xs text-[#A3A3A3] flex items-center gap-1.5 font-mono">
                  <Loader2 size={12} className="animate-spin" /> Checking...
                </span>
              ) : email ? (
                <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[11px] px-2 py-0.5 flex items-center gap-1 font-medium">
                  <ShieldCheck size={12} /> Verified
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[#A3A3A3] border-white/20 text-[11px] px-2 py-0.5">
                  Not Linked
                </Badge>
              )}
            </div>

            <p className="text-xs text-[#A3A3A3] leading-relaxed">
              Deal confirmations, work submissions, milestone approvals, and payments are sent to this address.
              Your email is private and never published on-chain.
            </p>

            {/* Email Display */}
            {!address ? (
              <p className="text-xs text-[#A3A3A3] italic py-2">Connect your wallet to manage your notification email.</p>
            ) : (
              <div className="pt-2">
                {email ? (
                  <div className="p-3 rounded-lg bg-[#252525] border border-white/20 flex items-center justify-between flex-wrap gap-3">
                    <div className="min-w-0 flex items-center gap-2">
                      <ShieldCheck size={16} className="text-emerald-400 shrink-0" />
                      <span className="text-sm font-mono text-white truncate">{email}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        asChild
                        size="sm"
                        variant="ghost"
                        className="h-8 px-2.5 text-xs text-white hover:text-white hover:bg-white/10 gap-1.5"
                      >
                        <Link href="/profile?edit=true">
                          <Pencil size={12} /> Change
                        </Link>
                      </Button>
                      <Button
                        asChild
                        size="sm"
                        variant="ghost"
                        className="h-8 px-2.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-950/20 gap-1.5"
                      >
                        <Link href="/profile?edit=true">
                          <Trash2 size={12} /> Unlink
                        </Link>
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 rounded-lg bg-[#252525] border border-dashed border-white/30 flex items-center justify-between flex-wrap gap-3">
                    <div className="text-xs text-[#A3A3A3]">
                      No email address is linked to this wallet.
                    </div>
                    <Button
                      asChild
                      size="sm"
                      className="bg-white hover:bg-neutral-200 text-[#101010] text-xs h-8 px-3 gap-1.5 font-semibold shrink-0"
                    >
                      <Link href="/profile?edit=true">
                        <Mail size={13} /> Link Email
                      </Link>
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="pt-3 border-t border-white/10 text-[11px] text-[#A3A3A3] flex items-center justify-between">
            <span>Identity: Wallet authenticated</span>
            {email && <span className="text-emerald-500 font-mono">Active Delivery ✓</span>}
          </div>
        </div>

        {/* ==================================================
            CARD 2: NOTIFICATION PREFERENCES
        ================================================== */}
        <div className="p-5 rounded-xl bg-[#1B1B1B] border border-white/75 space-y-4 flex flex-col justify-between shadow-xl">
          <div className="space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Bell size={16} className="text-white" />
                <span className="text-sm font-semibold text-white">Event Notification Categories</span>
              </div>
              <span className="text-[10px] font-mono text-white/80 bg-white/10 border border-white/20 rounded px-1.5 py-0.5">
                Wallet-scoped
              </span>
            </div>

            <p className="text-xs text-[#A3A3A3] leading-relaxed">
              Fine-tune which transactional deal events trigger an email dispatch. Security OTP verification codes are always delivered.
            </p>

            {loadingPrefs ? (
              <div className="py-6 flex items-center justify-center gap-2 text-xs text-[#A3A3A3] font-mono">
                <Loader2 size={14} className="animate-spin text-white" /> Loading preferences...
              </div>
            ) : (
              <div className="space-y-3 pt-1">
                {/* CATEGORY 1: PROPOSALS & CONFIRMATIONS */}
                <div
                  onClick={() => togglePreference('dealProposalsAndConfirmations')}
                  className="p-3 rounded-lg bg-[#252525] border border-white/20 hover:border-white/50 transition-colors cursor-pointer flex items-center justify-between gap-3 group"
                >
                  <div className="min-w-0 pr-2">
                    <div className="text-xs font-semibold text-white group-hover:text-neutral-200 transition-colors">
                      Deal Proposals &amp; Confirmations
                    </div>
                    <div className="text-[11px] text-[#A3A3A3] mt-0.5 leading-snug">
                      Proposals received, buyer confirmations, orders, and deal cancellations.
                    </div>
                  </div>
                  <div
                    className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${
                      preferences.dealProposalsAndConfirmations ? 'bg-white' : 'bg-neutral-700'
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded-full transition-transform absolute top-0.5 ${
                        preferences.dealProposalsAndConfirmations ? 'bg-[#101010] translate-x-5' : 'bg-white translate-x-0.5'
                      }`}
                    />
                  </div>
                </div>

                {/* CATEGORY 2: MILESTONE SUBMISSIONS & REVISIONS */}
                <div
                  onClick={() => togglePreference('milestoneSubmissionsAndRevisions')}
                  className="p-3 rounded-lg bg-[#252525] border border-white/20 hover:border-white/50 transition-colors cursor-pointer flex items-center justify-between gap-3 group"
                >
                  <div className="min-w-0 pr-2">
                    <div className="text-xs font-semibold text-white group-hover:text-neutral-200 transition-colors">
                      Milestone Submissions &amp; Revisions
                    </div>
                    <div className="text-[11px] text-[#A3A3A3] mt-0.5 leading-snug">
                      Deliverables submitted for review and client revision requests with feedback.
                    </div>
                  </div>
                  <div
                    className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${
                      preferences.milestoneSubmissionsAndRevisions ? 'bg-white' : 'bg-neutral-700'
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded-full transition-transform absolute top-0.5 ${
                        preferences.milestoneSubmissionsAndRevisions ? 'bg-[#101010] translate-x-5' : 'bg-white translate-x-0.5'
                      }`}
                    />
                  </div>
                </div>

                {/* CATEGORY 3: PAYMENTS & COMPLETIONS */}
                <div
                  onClick={() => togglePreference('paymentsAndCompletions')}
                  className="p-3 rounded-lg bg-[#252525] border border-white/20 hover:border-white/50 transition-colors cursor-pointer flex items-center justify-between gap-3 group"
                >
                  <div className="min-w-0 pr-2">
                    <div className="text-xs font-semibold text-white group-hover:text-neutral-200 transition-colors">
                      Payments &amp; Deal Completion
                    </div>
                    <div className="text-[11px] text-[#A3A3A3] mt-0.5 leading-snug">
                      Escrow milestone payments released, refunds issued, and final deal completions.
                    </div>
                  </div>
                  <div
                    className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${
                      preferences.paymentsAndCompletions ? 'bg-white' : 'bg-neutral-700'
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded-full transition-transform absolute top-0.5 ${
                        preferences.paymentsAndCompletions ? 'bg-[#101010] translate-x-5' : 'bg-white translate-x-0.5'
                      }`}
                    />
                  </div>
                </div>

                {/* CATEGORY 4: DISPUTES & RESOLUTIONS */}
                <div
                  onClick={() => togglePreference('disputesAndResolutions')}
                  className="p-3 rounded-lg bg-[#252525] border border-white/20 hover:border-white/50 transition-colors cursor-pointer flex items-center justify-between gap-3 group"
                >
                  <div className="min-w-0 pr-2">
                    <div className="text-xs font-semibold text-white group-hover:text-neutral-200 transition-colors">
                      Disputes &amp; Resolution Activity
                    </div>
                    <div className="text-[11px] text-[#A3A3A3] mt-0.5 leading-snug">
                      Formal dispute filings, settlement proposals, and committee resolutions.
                    </div>
                  </div>
                  <div
                    className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ${
                      preferences.disputesAndResolutions ? 'bg-white' : 'bg-neutral-700'
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded-full transition-transform absolute top-0.5 ${
                        preferences.disputesAndResolutions ? 'bg-[#101010] translate-x-5' : 'bg-white translate-x-0.5'
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

          <div className="pt-3 border-t border-white/10 flex items-center justify-between flex-wrap gap-2">
            <span className="text-[11px] text-[#A3A3A3]">
              {hasPrefsChanges ? 'Unsaved changes' : 'All preferences saved'}
            </span>
            <Button
              type="button"
              size="sm"
              onClick={handleSavePreferences}
              disabled={!hasPrefsChanges || savingPrefs || !address}
              className="bg-white hover:bg-neutral-200 text-[#101010] text-xs h-8 px-4 font-semibold shrink-0 gap-1.5 disabled:opacity-50"
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
