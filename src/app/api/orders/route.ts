import { NextRequest } from 'next/server';
import { getById, update, create } from '@/lib/db';
import { notifyBuyerOrderConfirmed } from '@/lib/notify';

/**
 * Seller confirms an order received in the Messages thread.
 *
 *   POST { conversationId, sellerWallet }
 *     → marks conversation.orderMeta.confirmed = true
 *     → emails the buyer a confirmation
 *
 * Wallet passed in the body (same unauthenticated model as /api/messages).
 */

const isWallet = (w: unknown): w is string => typeof w === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w);
const lc = (w: string) => w.toLowerCase();

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const conversationId = String(body.conversationId ?? '');
    const sellerWallet = String(body.sellerWallet ?? '');

    if (!conversationId || !isWallet(sellerWallet)) {
      return Response.json({ error: 'conversationId and a valid sellerWallet are required' }, { status: 400 });
    }

    const conversation = await getById('conversations', conversationId);
    if (!conversation) {
      return Response.json({ error: 'Conversation not found' }, { status: 404 });
    }

    // Only the seller may confirm the order.
    if (lc(String(conversation.sellerWallet || '')) !== lc(sellerWallet)) {
      return Response.json({ error: 'Only the seller can confirm this order' }, { status: 403 });
    }

    const orderMeta = conversation.orderMeta && typeof conversation.orderMeta === 'object'
      ? { ...conversation.orderMeta }
      : {};
    const alreadyConfirmed = !!orderMeta.confirmed;

    const updated = await update('conversations', conversation.id, {
      orderMeta: {
        ...orderMeta,
        confirmed: true,
        confirmedAt: new Date().toISOString(),
        confirmedBy: lc(sellerWallet),
      },
    });

    // Append a confirm message so both sides see it in the chat thread.
    await create('messages', {
      conversationId: conversation.id,
      fromWallet: lc(sellerWallet),
      toWallet: lc(String(conversation.buyerWallet || '')),
      fromName: conversation.sellerName || undefined,
      body: 'I confirm this order. Let\'s proceed.',
      kind: 'confirm',
      createdAt: new Date().toISOString(),
    });

    // Email the buyer once, not on every repeated confirm click.
    if (!alreadyConfirmed) {
      try {
        await notifyBuyerOrderConfirmed({
          event: 'order_confirmed',
          recipientWallet: conversation.buyerWallet,
          recipientName: conversation.buyerName,
          fromName: conversation.sellerName || undefined,
          dealTitle: conversation.subject || orderMeta.type,
          dealAmount: orderMeta.budget ? String(orderMeta.budget) : undefined,
          note: orderMeta.paymentSplit === '50/50' ? '50/50 (half upfront, half on approval)' : orderMeta.paymentSplit === 'full' ? 'Full payment in escrow' : undefined,
          dealId: conversation.id,
          link: '/messages',
        });
      } catch (e) {
        console.error('[orders] confirm email failed:', e);
      }
    }

    return Response.json({ conversation: updated, confirmed: true, alreadyConfirmed });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Failed to confirm order' }, { status: 500 });
  }
}
