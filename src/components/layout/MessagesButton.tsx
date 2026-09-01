'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccount } from 'wagmi';
import { MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Top-right Messages entry point. Lives next to WalletStatus in the root layout
 * so the inbox is reachable from every page, with a badge for unread messages
 * addressed to the connected wallet (counts come from /api/conversations, which
 * already annotates each thread with `unread`).
 */
export default function MessagesButton() {
  const { address } = useAccount();
  const pathname = usePathname();
  const [unread, setUnread] = useState(0);
  const isActive = pathname === '/messages';

  const load = useCallback(async () => {
    if (!address) { setUnread(0); return; }
    try {
      const res = await fetch(`/api/conversations?wallet=${address}`);
      const data = await res.json();
      const total = Array.isArray(data?.conversations)
        ? data.conversations.reduce((n: number, c: any) => n + (Number(c.unread) || 0), 0)
        : 0;
      setUnread(total);
    } catch { /* keep the last known count */ }
  }, [address]);

  // Poll (no WebSocket on Vercel), and refresh on focus + on navigation — opening
  // a thread marks its messages read, which should clear the badge.
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    window.addEventListener('focus', load);
    return () => { clearInterval(t); window.removeEventListener('focus', load); };
  }, [load, pathname]);

  return (
    <Link
      href="/messages"
      aria-label={unread > 0 ? `Messages (${unread} unread)` : 'Messages'}
      title="Messages"
      className={cn(
        'relative flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all',
        isActive
          ? 'border-blue-500/30 bg-blue-600/15 text-blue-400'
          : 'border-zinc-700 bg-zinc-800/50 text-zinc-300 hover:bg-zinc-700 hover:text-white',
      )}
    >
      <MessageSquare size={16} />
      <span className="hidden sm:inline">Messages</span>
      {unread > 0 && (
        <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-blue-600 text-white text-[10px] font-semibold flex items-center justify-center shadow-lg shadow-blue-600/30">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}
