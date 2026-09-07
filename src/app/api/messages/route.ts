import { NextRequest } from 'next/server';
import { getAll, getById, create, update, query } from '@/lib/db';
import { notifySellerOrderInquiry, notifyNewChatMessage } from '@/lib/notify';

/**
 * Buyer↔seller chat backend for the Messages page (/messages).
 *
 * Unauthenticated, wallet passed in the query/body (same model as /api/notify).
 * There is no WebSocket on this serverless host, so the client polls GET.
 *
 *   GET  ?conversationId=&wallet=[&since=ISO]  → messages asc; marks incoming read
 *   POST { fromWallet, toWallet, body, kind?, orderMeta?, fromName? }
 *        → upserts the thread, stores the message, emails the recipient (always)
 */

const isWallet = (w: unknown): w is string => typeof w === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w);
const lc = (w: string) => w.toLowerCase();

const previewOf = (s: string) => {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 137)}...` : flat;
};

async function nameForWallet(users: any[], wallet: string, fallback?: string): Promise<string> {
  const u = users.find((x: any) => x.walletAddress && lc(String(x.walletAddress)) === lc(wallet));
  return (u?.name && String(u.name)) || fallback || `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const conversationId = url.searchParams.get('conversationId');
  const wallet = url.searchParams.get('wallet');
  const since = url.searchParams.get('since');
  if (!conversationId || !isWallet(wallet)) {
    return Response.json({ error: 'conversationId and a valid wallet are required' }, { status: 400 });
  }

  const conversation = await getById('conversations', conversationId);
  if (!conversation) {
    return Response.json({ error: 'Conversation not found' }, { status: 404 });
  }
  const me = lc(wallet);
  const isParticipant =
    lc(String(conversation.buyerWallet || '')) === me || lc(String(conversation.sellerWallet || '')) === me;
  if (!isParticipant) {
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
    const body = await req.json();
    const { fromWallet, toWallet, kind } = body;
    const text = String(body.body ?? '').trim();
    if (!isWallet(fromWallet) || !isWallet(toWallet)) {
      return Response.json({ error: 'Valid fromWallet and toWallet are required' }, { status: 400 });
    }
    if (lc(fromWallet) === lc(toWallet)) {
      return Response.json({ error: 'You cannot message yourself' }, { status: 400 });
    }
    if (!text) {
      return Response.json({ error: 'Message body is required' }, { status: 400 });
    }
    if (text.length > 4000) {
      return Response.json({ error: 'Message is too long (max 4000 characters)' }, { status: 400 });
    }
    const messageKind = kind === 'order' ? 'order' : 'text';
    const orderMeta = body.orderMeta && typeof body.orderMeta === 'object' ? body.orderMeta : undefined;

    const users = await getAll('users');
    const fromName = await nameForWallet(users, fromWallet, body.fromName);
    const toName = await nameForWallet(users, toWallet);

    // One thread per buyer↔seller pair, regardless of who is sending now.
    const pair = await query(
      'conversations',
      (c: any) => {
        const a = lc(String(c.buyerWallet || ''));
        const b = lc(String(c.sellerWallet || ''));
        return (a === lc(fromWallet) && b === lc(toWallet)) || (a === lc(toWallet) && b === lc(fromWallet));
      },
    );
    let conversation = pair[0] || null;
    const now = new Date().toISOString();
    const preview = previewOf(text);

    const dealAddress = body.dealAddress && typeof body.dealAddress === 'string' ? body.dealAddress.trim() : '';

    if (!conversation) {
      // First message opens the thread. The initiator is the buyer, the
      // recipient the seller — matches the "buyer orders a freelancer" flow.
      // If an on-chain deal already exists for this pair (the buyer created it
      // before chatting), stamp its address so the thread can link to it.
      conversation = await create('conversations', {
        buyerWallet: lc(fromWallet),
        sellerWallet: lc(toWallet),
        buyerName: fromName,
        sellerName: toName,
        subject: orderMeta?.type || body.subject || undefined,
        orderMeta: orderMeta || undefined,
        dealAddress: dealAddress || undefined,
        lastMessageAt: now,
        lastMessagePreview: preview,
        lastMessageFrom: lc(fromWallet),
        createdAt: now,
      });
    } else {
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
      // Link the on-chain deal if the client passes it and we don't have one yet.
      if (dealAddress && !conversation.dealAddress) patch.dealAddress = dealAddress;
      conversation = (await update('conversations', conversation.id, patch)) || conversation;
    }

    const message = await create('messages', {
      conversationId: conversation.id,
      fromWallet: lc(fromWallet),
      toWallet: lc(toWallet),
      fromName,
      body: text,
      kind: messageKind,
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
