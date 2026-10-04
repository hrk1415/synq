'use client';

import { Suspense } from 'react';
import { Press_Start_2P } from 'next/font/google';
import { Loader2 } from 'lucide-react';
import Messages from '@/components/messages/Messages';

const pressStart2P = Press_Start_2P({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

export default function MessagesPage() {
  return (
    <div className="flex h-[calc(100dvh-6rem)] min-h-0 flex-col gap-4 overflow-hidden pt-0 lg:h-[calc(100dvh-4rem)]">
      <div className="flex shrink-0 items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <h1 className={`${pressStart2P.className} text-xl md:text-2xl font-normal text-white tracking-tight`}>
            SynqChat
          </h1>
          <div className="relative group inline-block">
            <button
              type="button"
              tabIndex={0}
              aria-label="About SynqChat"
              className="w-5 h-5 rounded-full bg-zinc-800/80 hover:bg-zinc-800 border border-zinc-700/60 text-zinc-400 hover:text-white text-[11px] font-bold font-mono inline-flex items-center justify-center shrink-0 transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            >
              ?
            </button>
            <div className="absolute left-0 top-full mt-2 w-72 sm:w-80 p-3 rounded-xl bg-zinc-900 border border-zinc-700/80 text-zinc-200 text-xs leading-relaxed shadow-2xl opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-all duration-150 z-30">
              Message anyone on Synq, share what matters, and stay connected wallet to wallet.
            </div>
          </div>
        </div>
      </div>

      {/* Messages reads ?to / ?intent from the URL, so it needs a Suspense boundary. */}
      <div className="min-h-0 flex-1">
        <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader2 size={24} className="animate-spin text-blue-400" /></div>}>
          <Messages />
        </Suspense>
      </div>
    </div>
  );
}
