import { NextRequest } from 'next/server';
import { getAll, getById, update, query, getOrCreateCanonicalConversation, createSynqMessage } from '@/lib/db';
import { notifySellerOrderInquiry, notifyNewChatMessage } from '@/lib/notify';
import { getAuthenticatedWallet, unauthorized } from '@/lib/auth';
import { canonicalizeConversationPair, isConversationParticipant } from '@/lib/conversation-pair';
import { deriveConversationPreview, validatePublicMessageInput } from '@/lib/synq-message';

/**
 * Neutral wallet↔wallet chat backend for the Messages page (/messages).
 *
 * The verified bearer wallet is the sole sender/membership authority. There is
 * no WebSocket on this serverless host, so the client polls GET.
 *
 *   GET  ?conversationId=&wallet=[&since=ISO]  → messages asc; marks incoming read
 *   POST { fromWallet, toWallet, body, kind?, orderMeta?, fromName? }
 *        → upserts the thread, stores the message, emails the recipient (always)
 */

const isWallet = (w: unknown): w is string => typeof w === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w);
const lc = (w: string) => w.toLowerCase();

async function nameForWallet(users: any[], wallet: string, fallback?: string): Promise<string> {
  const u = users.find((x: any) => x.walletAddress && lc(String(x.walletAddress)) === lc(wallet));
  return (u?.name && String(u.name)) || fallback || `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

export async function GET(req: NextRequest) {
  const authenticatedWallet = getAuthenticatedWallet(req);
  if (!authenticatedWallet) return unauthorized();
  const url = new URL(req.url);
  const conversationId = url.searchParams.get('conversationId');
  const wallet = url.searchParams.get('wallet');
  const since = url.searchParams.get('since');
  if (!conversationId) {
    return Response.json({ error: 'conversationId is required' }, { status: 400 });
  }
  if (wallet && (!isWallet(wallet) || lc(wallet) !== authenticatedWallet)) {
    return Response.json({ error: 'Requested wallet does not match authenticated wallet' }, { status: 403 });
  }

  const conversation = await getById('conversations', conversationId);
  if (!conversation) {
    return Response.json({ error: 'Conversation not found' }, { status: 404 });
  }
  const me = authenticatedWallet;
  if (!isConversationParticipant(conversation, me)) {
    return Response.json({ error: 'Not a participant in this conversation' }, { status: 403 });
  }

  const all = await query('messages', (m: any) => m.conversationId === conversationId);
  all.sort((a: any, b: any) => String(a.createdAt).localeCompare(String(b.createdAt)));

  // Opening/polling the thread means the recipient has seen it → clear unread.
  for (const m of all) {
    if (lc(String(m.toWallet || '')) === me && !m.readAt) {
      await update('messages', m.id, { readAt: new Date().toISOString() });
      m.readAt = m.readAt || new Date().toISOString();
    }
  }

  const messages = since ? all.filter((m: any) => String(m.createdAt) > since) : all;
  return Response.json({ messages, conversation });
}

export async function POST(req: NextRequest) {
  try {
    const authenticatedWallet = getAuthenticatedWallet(req);
    if (!authenticatedWallet) return unauthorized();
    const body = await req.json();
    if (Object.prototype.hasOwnProperty.call(body, 'dealAddress')) {
      return Response.json(
        { error: 'Legacy dealAddress is not accepted by this endpoint' },
        { status: 400 },
      );
    }
    const { toWallet } = body;
    const fromWallet = authenticatedWallet;
    if (body.fromWallet && (!isWallet(body.fromWallet) || lc(body.fromWallet) !== authenticatedWallet)) {
      return Response.json({ error: 'Sender does not match authenticated wallet' }, { status: 403 });
    }
    if (!isWallet(toWallet)) {
      return Response.json({ error: 'Valid toWallet is required' }, { status: 400 });
    }
    if (lc(fromWallet) === lc(toWallet)) {
      return Response.json({ error: 'You cannot message yourself' }, { status: 400 });
    }
    const validated = validatePublicMessageInput(body);
    if (!validated.ok) return Response.json({ error: validated.error }, { status: 400 });
    const text = validated.body;
    const messageKind = validated.kind;
    const orderMeta = validated.orderMeta;

    const users = await getAll('users');
    const fromName = await nameForWallet(users, fromWallet);
    const toName = await nameForWallet(users, toWallet);

    const canonicalPair = canonicalizeConversationPair(fromWallet, toWallet);
    const now = new Date().toISOString();
    const preview = deriveConversationPreview(messageKind, text);

    // Legacy roles remain compatibility metadata: for a brand-new row only,
    // the initiator is stored as buyer and recipient as seller. Canonical
    // participant ordering is the generic chat identity and never implies role.
    const result = await getOrCreateCanonicalConversation({
      ...canonicalPair,
      buyerWallet: fromWallet,
      sellerWallet: toWallet,
      buyerName: fromName,
      sellerName: toName,
      subject: orderMeta?.type || body.subject || undefined,
      orderMeta: orderMeta || undefined,
      lastMessageAt: now,
      lastMessagePreview: preview,
      lastMessageFrom: fromWallet,
      createdAt: now,
    });
    let conversation = result.conversation;

    if (!result.created) {
      const patch: Record<string, unknown> = {
        lastMessageAt: now,
        lastMessagePreview: preview,
        lastMessageFrom: lc(fromWallet),
      };
      // Backfill names/subject as we learn them; never flip buyer/seller roles.
      if (!conversation.buyerName && lc(String(conversation.buyerWallet)) === lc(fromWallet)) patch.buyerName = fromName;
      if (!conversation.sellerName && lc(String(conversation.sellerWallet)) === lc(fromWallet)) patch.sellerName = fromName;
      if (!conversation.buyerName && lc(String(conversation.buyerWallet)) === lc(toWallet)) patch.buyerName = toName;
      if (!conversation.sellerName && lc(String(conversation.sellerWallet)) === lc(toWallet)) patch.sellerName = toName;
      if (orderMeta && !conversation.orderMeta) { patch.orderMeta = orderMeta; patch.subject = conversation.subject || orderMeta.type; }
      conversation = (await update('conversations', conversation.id, patch)) || conversation;
    }

    const message = await createSynqMessage({
      conversationId: conversation.id,
      fromWallet: lc(fromWallet),
      toWallet: lc(toWallet),
      fromName,
      body: text,
      kind: messageKind,
      payload: null,
      orderMeta: orderMeta || undefined,
      createdAt: now,
    });

    // Always email the recipient (the user's chosen policy). Never let a mail
    // problem fail the send — the senders already fall back to a log file.
    try {
      const link = '/messages';
      if (messageKind === 'order') {
        await notifySellerOrderInquiry({
          event: 'order_inquiry',
          recipientWallet: toWallet,
          recipientName: toName,
          fromName,
          dealTitle: conversation.subject || orderMeta?.type,
          messagePreview: preview,
          link,
        });
      } else {
        await notifyNewChatMessage({
          event: 'chat_message',
          recipientWallet: toWallet,
          recipientName: toName,
          fromName,
          messagePreview: preview,
          link,
        });
      }
    } catch (e) {
      console.error('[messages] notify failed (message was still saved):', e);
    }

    return Response.json({ message, conversation });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Failed to send message' }, { status: 500 });
  }
}
