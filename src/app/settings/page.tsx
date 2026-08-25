'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Settings, User, Bell, Wallet, Globe, ChevronRight, Check, Copy, ExternalLink, Power, Loader2, Mail, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { useAccount, useChainId, useBalance, useDisconnect, useSwitchChain } from 'wagmi';
import { shortenAddress } from '@/lib/utils';
import { getExplorerUrl } from '@/lib/chain';

type ToggleKey = 'dealUpdates' | 'payments' | 'agentActivity';

function useLocal<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial;
    try {
      const raw = window.localStorage.getItem(key);
      return raw !== null ? (JSON.parse(raw) as T) : initial;
    } catch { return initial; }
  });
  const setPersist = useCallback(
    (v: T) => {
      setValue(v);
      try { window.localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
    },
    [key]
  );
  return [value, setPersist];
}

function Toggle({ checked, onChange, label, desc }: { checked: boolean; onChange: (v: boolean) => void; label: string; desc?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div>
        <p className="text-sm text-white">{label}</p>
        {desc && <p className="text-xs text-zinc-500">{desc}</p>}
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${checked ? 'bg-blue-600' : 'bg-zinc-700'}`}
        aria-label={label}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const [openSection, setOpenSection] = useState<string | null>('Profile');
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { data: balance } = useBalance({ address });
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: chainSwitching } = useSwitchChain();

  const [username, setUsername] = useLocal<string>('settings:username', '');
  const [nameDraft, setNameDraft] = useState(username);
  const [nameStatus, setNameStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  const saveDisplayName = () => {
    try {
      window.localStorage.setItem('settings:username', JSON.stringify(nameDraft));
      setUsername(nameDraft);
      window.dispatchEvent(new CustomEvent('synq:displayname', { detail: nameDraft }));
      setNameStatus('saved');
      window.setTimeout(() => setNameStatus('idle'), 2000);
    } catch {
      setNameStatus('error');
    }
  };
  const [toggles, setToggles] = useLocal<Record<ToggleKey, boolean>>('settings:toggles', {
    dealUpdates: true, payments: true, agentActivity: false,
  });
  const [preferredChain, setPreferredChain] = useLocal<number>('settings:preferredChain', 11155111);

  const [copied, setCopied] = useState(false);
  const copyAddress = async () => {
    if (!address) return;
    try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };

  const open = (label: string) => setOpenSection(openSection === label ? null : label);

  // Real delivery status from /api/notify — so "Notifications: on" can never
  // imply email is being sent when it is only being written to a log file.
  interface MailStatusView {
    live?: boolean;
    host?: string;
    port?: number;
    user?: string;
    hostSource?: string;
    missing?: string[];
    logFile?: string;
    hint?: string;
    failed?: boolean;
  }
  const [mailStatus, setMailStatus] = useState<MailStatusView | null>(null);
  const mailRequested = useRef(false);
  useEffect(() => {
    if (openSection !== 'Notifications' || mailRequested.current) return;
    mailRequested.current = true;
    fetch('/api/notify')
      .then((r) => r.json())
      .then((d) => setMailStatus(d))
      .catch(() => setMailStatus({ failed: true }));
  }, [openSection]);
  const mailLoading = openSection === 'Notifications' && !mailStatus;

  const sections = [
    { icon: User, label: 'Profile', desc: 'Manage your personal information' },
    { icon: Bell, label: 'Notifications', desc: 'Configure alert preferences' },
    { icon: Wallet, label: 'Wallet', desc: 'Connected wallets and addresses' },
    { icon: Globe, label: 'Network', desc: 'Preferred blockchain networks' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-zinc-400 text-sm mt-1">Manage your account and preferences.</p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {sections.map((section) => (
          <Card
            key={section.label}
            className={`transition-all ${openSection === section.label ? 'border-blue-500/40' : ''}`}
          >
            <CardContent
              className="p-4 flex items-center gap-4 cursor-pointer"
              onClick={() => open(section.label)}
            >
              <div className={`p-2.5 rounded-xl ${openSection === section.label ? 'bg-blue-600/10' : 'bg-zinc-800/50'}`}>
                <section.icon size={20} className={openSection === section.label ? 'text-blue-400' : 'text-zinc-400'} />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-white">{section.label}</p>
                <p className="text-xs text-zinc-500">{section.desc}</p>
              </div>
              <ChevronRight size={16} className={`text-zinc-600 transition-transform ${openSection === section.label ? 'rotate-90' : ''}`} />
            </CardContent>
            {openSection === section.label && (
              <CardContent className="pt-0 px-4 pb-4 border-t border-zinc-800/60">
                <div className="pt-3 space-y-3">
                  {section.label === 'Profile' && (
                    <>
                      <div>
                        <label className="text-xs text-zinc-500 block mb-1">Display Name</label>
                        <div className="flex items-center gap-2">
                          <Input
                            value={nameDraft}
                            onChange={(e) => setNameDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') saveDisplayName(); }}
                            placeholder="Enter your display name"
                            className="max-w-xs"
                          />
                          <Button type="button" size="sm" onClick={saveDisplayName} className="shrink-0">Save</Button>
                        </div>
                        {nameStatus === 'saved' && (
                          <p className="text-xs text-emerald-400 mt-1 flex items-center gap-1">
                            <Check size={12} />
                            {nameDraft ? `Display name saved as @${nameDraft}` : 'Display name cleared'}
                          </p>
                        )}
                        {nameStatus === 'error' && (
                          <p className="text-xs text-red-400 mt-1">Could not save — browser storage is blocked.</p>
                        )}
                      </div>
                      <div>
                        <p className="text-xs text-zinc-500 mb-1">Wallet Address</p>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-zinc-300 bg-zinc-800/50 rounded-lg px-3 py-1.5">
                            {address ? shortenAddress(address) : 'Not connected'}
                          </span>
                          {address && (
                            <button onClick={copyAddress} className="p-1.5 rounded-lg bg-zinc-800/50 text-zinc-400 hover:text-white">
                              {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                            </button>
                          )}
                        </div>
                      </div>
                      {nameStatus === 'idle' && username && (
                        <p className="text-xs text-zinc-500">Currently saved as @{username}</p>
                      )}
                      <p className="text-xs text-zinc-600">Shown in the top bar next to your on-chain @username.</p>
                    </>
                  )}

                  {section.label === 'Notifications' && (
                    <>
                      <div className="mb-1">
                        <p className="text-xs text-zinc-500 mb-2 flex items-center gap-1.5"><Mail size={12} /> Email delivery</p>
                        {mailLoading && !mailStatus ? (
                          <div className="flex items-center gap-2 text-xs text-zinc-500">
                            <Loader2 size={12} className="animate-spin" /> Checking SMTP configuration...
                          </div>
                        ) : mailStatus?.failed ? (
                          <p className="text-xs text-red-400">Could not reach /api/notify to check delivery status.</p>
                        ) : mailStatus?.live ? (
                          <div className="p-3 rounded-lg bg-emerald-600/10 border border-emerald-500/20 space-y-1">
                            <p className="text-xs text-emerald-400 flex items-center gap-1.5">
                              <Check size={12} /> Live — email is delivered to real inboxes
                            </p>
                            <p className="text-[11px] text-zinc-500 font-mono">
                              {mailStatus.host}:{mailStatus.port} as {mailStatus.user}
                              {mailStatus.hostSource === 'inferred' && ' (host inferred from SMTP_USER)'}
                            </p>
                          </div>
                        ) : mailStatus ? (
                          <div className="p-3 rounded-lg bg-amber-600/10 border border-amber-500/20 space-y-1">
                            <p className="text-xs text-amber-400 flex items-center gap-1.5">
                              <AlertTriangle size={12} /> Log-only — nobody receives these emails
                            </p>
                            <p className="text-[11px] text-zinc-400">
                              Notifications are appended to <span className="font-mono">{mailStatus.logFile || 'data/emails.log'}</span> instead of being sent.
                            </p>
                            {!!mailStatus.missing?.length && (
                              <p className="text-[11px] text-zinc-500">
                                Set <span className="font-mono text-amber-400">{mailStatus.missing.join(' + ')}</span> in <span className="font-mono">.env.local</span> and restart the dev server.
                              </p>
                            )}
                          </div>
                        ) : null}
                      </div>
                      <Separator className="bg-zinc-800/60" />
                      <Toggle checked={toggles.dealUpdates} onChange={(v) => setToggles({ ...toggles, dealUpdates: v })} label="Deal updates" desc="New offers, milestones, and status changes" />
                      <Separator className="bg-zinc-800/60" />
                      <Toggle checked={toggles.payments} onChange={(v) => setToggles({ ...toggles, payments: v })} label="Payments" desc="Escrow deposits, releases, and refunds" />
                      <Separator className="bg-zinc-800/60" />
                      <Toggle checked={toggles.agentActivity} onChange={(v) => setToggles({ ...toggles, agentActivity: v })} label="AI agent activity" desc="Notifications when agents take actions" />
                      <p className="text-[11px] text-zinc-600">These three switches are stored in this browser only — they do not yet filter what the server sends.</p>
                    </>
                  )}

                  {section.label === 'Wallet' && (
                    <>
                      <div className="text-sm">
                        <p className="text-zinc-500 text-xs mb-1">Status</p>
                        {isConnected ? (
                          <Badge variant="success" className="gap-1"><Check size={12} /> Connected</Badge>
                        ) : (
                          <Badge variant="secondary">Not connected</Badge>
                        )}
                      </div>
                      {address && (
                        <>
                          <div className="flex flex-wrap items-center gap-3 text-sm">
                            <span className="text-xs font-mono text-zinc-300 bg-zinc-800/50 rounded-lg px-3 py-1.5">{shortenAddress(address)}</span>
                            <button onClick={copyAddress} className="p-1.5 rounded-lg bg-zinc-800/50 text-zinc-400 hover:text-white">
                              {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                            </button>
                            <span className="text-sm font-semibold text-white">{balance ? `${(Number(balance.value) / 1e18).toFixed(4)} ${balance.symbol}` : '-'}</span>
                          </div>
                          <Button variant="outline" size="sm" className="text-red-400 border-red-500/30 hover:bg-red-500/10 gap-2" onClick={() => disconnect()}>
                            <Power size={14} /> Disconnect Wallet
                          </Button>
                        </>
                      )}
                      {!address && (
                        <p className="text-xs text-zinc-500">Connect your wallet using the button at the top right to manage it here.</p>
                      )}
                    </>
                  )}

                  {section.label === 'Network' && (
                    <>
                      <p className="text-xs text-zinc-500 mb-2">Switch your wallet to a supported chain. Synq works best on Sepolia testnet.</p>
                      <div className="flex flex-wrap gap-2">
                        {[
                          { id: 11155111, name: 'Sepolia (Recommended)', note: 'Deals + marketplace live' },
                          { id: 1, name: 'Ethereum Mainnet', note: 'Deploy at your own risk' },
                          { id: 8453, name: 'Base', note: 'Low fees, L2' },
                        ].map((net) => (
                          <button
                            key={net.id}
                            onClick={() => { setPreferredChain(net.id); if (isConnected) switchChain({ chainId: net.id }); }}
                            className={`px-4 py-2 rounded-lg border text-left transition-all ${
                              chainId === net.id ? 'border-emerald-500/50 bg-emerald-600/10' : preferredChain === net.id ? 'border-blue-500/50 bg-blue-600/10' : 'border-zinc-700/50 bg-zinc-800/30 hover:border-zinc-600'
                            }`}
                          >
                            <p className={`text-sm font-medium ${chainId === net.id ? 'text-emerald-400' : 'text-zinc-200'}`}>{net.name}</p>
                            <p className="text-[10px] text-zinc-500">{net.note}</p>
                          </button>
                        ))}
                      </div>
                      {chainSwitching && (
                        <p className="text-xs text-amber-400 flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Switching chain in your wallet...</p>
                      )}
                    </>
                  )}
                </div>
              </CardContent>
            )}
          </Card>
        ))}
      </div>

          </div>
  );
}
