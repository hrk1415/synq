'use client';

import { useState, useEffect } from 'react';
import { Press_Start_2P } from 'next/font/google';
import { Shield, Wallet } from 'lucide-react';
import { useAccount } from 'wagmi';
import { shortenAddress } from '@/lib/utils';
import NotificationSettingsSection from '@/components/shared/NotificationSettingsSection';

const pressStart2P = Press_Start_2P({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

export default function SettingsPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const { address, isConnected, status } = useAccount();
  const isAccountRestoring = status === 'connecting' || status === 'reconnecting';

  // Deterministic address during SSR and initial client render to prevent hydration mismatches
  const effectiveAddress =
    mounted && isConnected && !!address && !isAccountRestoring
      ? address
      : undefined;

  return (
    <div className="space-y-6 pt-0 animate-in fade-in duration-300">
      {/* COMPACT TITLE ROW WITH HOVER/FOCUS TOOLTIP */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <h1 className={`${pressStart2P.className} text-xl md:text-2xl font-normal text-white tracking-tight`}>
            Settings
          </h1>
          <div className="relative group inline-block">
            <button
              type="button"
              tabIndex={0}
              aria-label="About Settings"
              className="w-5 h-5 rounded-full bg-[#252525] hover:bg-neutral-800 border border-white/20 text-[#A3A3A3] hover:text-white text-[11px] font-bold font-mono inline-flex items-center justify-center shrink-0 transition-colors focus:outline-none focus:ring-1 focus:ring-white/50"
            >
              ?
            </button>
            <div className="absolute left-0 top-full mt-2 w-72 sm:w-80 p-3 rounded-xl bg-[#1B1B1B] border border-white/75 text-[#A3A3A3] text-xs leading-relaxed shadow-2xl opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-all duration-150 z-30">
              Manage your notification preferences, email delivery, and account settings.
            </div>
          </div>
        </div>
      </div>

      {/* WALLET IDENTITY STATUS BANNER */}
      <div className="p-4 rounded-xl bg-[#1B1B1B] border border-white/75 flex items-center justify-between flex-wrap gap-3 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-[#252525] border border-white/20 text-white">
            <Wallet size={16} />
          </div>
          <div>
            <div className="text-xs font-semibold text-white">
              Active Wallet Context
            </div>
            <div className="text-xs font-mono text-[#A3A3A3]">
              {effectiveAddress ? shortenAddress(effectiveAddress) : 'No wallet connected'}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {effectiveAddress ? (
            <span className="text-[11px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full flex items-center gap-1">
              <Shield size={11} /> Connected &amp; Scoped
            </span>
          ) : (
            <span className="text-[11px] text-[#A3A3A3]">
              Settings are saved per connected wallet
            </span>
          )}
        </div>
      </div>

      {/* NOTIFICATIONS & EMAIL MANAGEMENT SECTION */}
      <NotificationSettingsSection address={effectiveAddress} />
    </div>
  );
}
