'use client';

import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import Messages from '@/components/messages/Messages';

export default function MessagesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Messages</h1>
        <p className="text-zinc-400 text-sm mt-1">
          Chat with buyers and sellers, send your order conditions, and open an escrow deal straight from a conversation.
        </p>
      </div>

      {/* Messages reads ?to / ?intent from the URL, so it needs a Suspense boundary. */}
      <Suspense fallback={<div className="flex items-center justify-center py-20"><Loader2 size={24} className="animate-spin text-blue-400" /></div>}>
        <Messages />
      </Suspense>
    </div>
  );
}
