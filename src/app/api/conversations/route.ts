import { NextRequest } from 'next/server';
import { getAll, query } from '@/lib/db';
import { getAuthenticatedWallet, unauthorized } from '@/lib/auth';
import { formatUnits } from 'viem';
import { validatePaymentReceiptPayload } from '@/lib/synq-message';

/**
 * Conversation list for the Messages page (/messages). The verified bearer
 * wallet is the sole authorization identity.
 *
 * Returns every canonical thread the wallet participates in, newest
 * first, each annotated with `unread` = messages addressed to this wallet that
 * have not been read yet.
 */

export async function GET(req: NextRequest) {
  const authenticatedWallet = getAuthenticatedWallet(req);
  if (!authenticatedWallet) return unauthorized();
  const requestedWallet = new URL(req.url).searchParams.get('wallet');
  if (requestedWallet && requestedWallet.toLowerCase() !== authenticatedWallet) {
    return Response.json({ error: 'Requested wallet does not match authenticated wallet' }, { status: 403 });
  }
  const lower = authenticatedWallet;

  const threads = await query(
    'conversations',
    (c: any) =>
      String(c.participantA || '').toLowerCase() === lower ||
      String(c.participantB || '').toLowerCase() === lower,
  );

  const allMessages = await getAll('messages');
  const unreadByConversation = new Map<string, number>();
  for (const m of allMessages) {
    if (String(m.toWallet || '').toLowerCase() === lower && !m.readAt) {
      unreadByConversation.set(m.conversationId, (unreadByConversation.get(m.conversationId) || 0) + 1);
    }
  }

  const conversations = threads
    .map((c: any) => {
      let lastMessagePreview = c.lastMessagePreview;
      const latest = allMessages
        .filter((message: any) => message.conversationId === c.id)
        .sort((a: any, b: any) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
      if (latest?.kind === 'payment_receipt') {
        try {
          const payload = validatePaymentReceiptPayload(latest.payload);
          const amount = formatUnits(BigInt(payload.amount), payload.decimals);
          lastMessagePreview = `${String(latest.fromWallet || '').toLowerCase() === lower ? 'You sent' : 'You received'} ${amount} ${payload.symbol}`;
        } catch {
          lastMessagePreview = 'Payment recorded';
        }
      }
      return { ...c, lastMessagePreview, unread: unreadByConversation.get(c.id) || 0 };
    })
    .sort((a: any, b: any) =>
      String(b.lastMessageAt || b.createdAt || '').localeCompare(String(a.lastMessageAt || a.createdAt || '')),
    );

  return Response.json({ conversations });
}
