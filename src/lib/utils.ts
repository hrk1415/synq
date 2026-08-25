import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatUnits } from 'viem';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Formats a wei amount as a token amount.
 *
 * Not `formatCurrency`: that renders USD with zero decimal places, so a premium
 * of 0.004 ETH came out as the string "$0 ETH" — a real amount displayed as
 * zero, in the currency it isn't denominated in. Trailing zeros are trimmed so
 * small amounts stay readable without padding large ones.
 */
export function formatTokenAmount(value: bigint | undefined, decimals = 18, maxFractionDigits = 6): string {
  if (value === undefined || value === null) return '—';
  const full = formatUnits(value, decimals);
  const [whole, fraction = ''] = full.split('.');
  if (!fraction) return whole;
  const trimmed = fraction.slice(0, maxFractionDigits).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export function formatTimeAgo(timestamp: string): string {
  const now = new Date();
  const date = new Date(timestamp);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function getRiskColor(score: number): string {
  if (score < 25) return 'text-green-400';
  if (score < 50) return 'text-amber-400';
  return 'text-red-400';
}

export function getRiskBgColor(score: number): string {
  if (score < 25) return 'bg-green-400/10';
  if (score < 50) return 'bg-amber-400/10';
  return 'bg-red-400/10';
}

export function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    active: 'text-green-400 bg-green-400/10',
    idle: 'text-zinc-400 bg-zinc-400/10',
    busy: 'text-amber-400 bg-amber-400/10',
    completed: 'text-green-400 bg-green-400/10',
    in_progress: 'text-blue-400 bg-blue-400/10',
    negotiating: 'text-violet-400 bg-violet-400/10',
    pending: 'text-zinc-400 bg-zinc-400/10',
    locked: 'text-blue-400 bg-blue-400/10',
    released: 'text-green-400 bg-green-400/10',
    disputed: 'text-red-400 bg-red-400/10',
    cancelled: 'text-zinc-500 bg-zinc-500/10',
    confirmed: 'text-green-400 bg-green-400/10',
    failed: 'text-red-400 bg-red-400/10',
    funding: 'text-amber-400 bg-amber-400/10',
    draft: 'text-zinc-400 bg-zinc-400/10',
  };
  return colors[status] || 'text-zinc-400 bg-zinc-400/10';
}

export function getMilestoneProgress(milestones: { status: string }[]): number {
  const completed = milestones.filter(m => m.status === 'approved' || m.status === 'completed').length;
  return Math.round((completed / milestones.length) * 100);
}

export function shortenAddress(addr: string, chars = 4): string {
  if (!addr || addr.length < 10) return addr || '';
  return `${addr.slice(0, chars + 2)}...${addr.slice(-chars)}`;
}

/**
 * Converts an on-chain evidence string into a browsable URL, or null when it
 * isn't a link (plain hash / free text).
 */
export function evidenceUrl(evidence: string): string | null {
  const e = String(evidence || '').trim();
  if (!e) return null;
  if (/^https?:\/\//i.test(e)) return e;
  const ipfsMatch = e.match(/^ipfs:\/\/(?:ipfs\/)?(.+)$/i);
  if (ipfsMatch) return `https://ipfs.io/ipfs/${ipfsMatch[1]}`;
  return null;
}
