import { NextRequest } from 'next/server';
import { getAll, query } from '@/lib/db';

/**
 * Conversation list for the Messages page (/messages). Unauthenticated, wallet in
 * the query (same model as /api/notify and /api/profile).
 *
 * Returns every thread the wallet is part of (as buyer or seller), newest
 * first, each annotated with `unread` = messages addressed to this wallet that
 * have not been read yet.
 */

const isWallet = (w: unknown): w is string => typeof w === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w);

export async function GET(req: NextRequest) {
  const wallet = new URL(req.url).searchParams.get('wallet');
  if (!isWallet(wallet)) {
    return Response.json({ error: 'Valid wallet address required' }, { status: 400 });
  }
  const lower = wallet.toLowerCase();

  const threads = await query(
    'conversations',
    (c: any) =>
      String(c.buyerWallet || '').toLowerCase() === lower ||
      String(c.sellerWallet || '').toLowerCase() === lower,
  );

  const allMessages = await getAll('messages');
  const unreadByConversation = new Map<string, number>();
  for (const m of allMessages) {
    if (String(m.toWallet || '').toLowerCase() === lower && !m.readAt) {
      unreadByConversation.set(m.conversationId, (unreadByConversation.get(m.conversationId) || 0) + 1);
    }
  }

  const conversations = threads
    .map((c: any) => ({ ...c, unread: unreadByConversation.get(c.id) || 0 }))
    .sort((a: any, b: any) =>
      String(b.lastMessageAt || b.createdAt || '').localeCompare(String(a.lastMessageAt || a.createdAt || '')),
    );

  return Response.json({ conversations });
}
