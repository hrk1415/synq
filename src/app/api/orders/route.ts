import { NextRequest } from 'next/server';
import { getById, update, createSynqMessage } from '@/lib/db';
import { notifyBuyerOrderConfirmed } from '@/lib/notify';
import { getAuthenticatedWallet, unauthorized } from '@/lib/auth';
import { isConversationParticipant } from '@/lib/conversation-pair';

/**
 * Seller confirms an order received in the Messages thread.
 *
 *   POST { conversationId, sellerWallet? }
 *     → marks conversation.orderMeta.confirmed = true
 *     → emails the buyer a confirmation
 *
 * The verified bearer wallet must be the conversation's current seller.
 */

const isWallet = (w: unknown): w is string => typeof w === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w);
const lc = (w: string) => w.toLowerCase();

export async function POST(req: NextRequest) {
  try {
    const authenticatedWallet = getAuthenticatedWallet(req);
    if (!authenticatedWallet) return unauthorized();
    const body = await req.json();
    const conversationId = String(body.conversationId ?? '');
    const suppliedSellerWallet = body.sellerWallet ? String(body.sellerWallet) : '';

    if (!conversationId) {
      return Response.json({ error: 'conversationId is required' }, { status: 400 });
    }
    if (suppliedSellerWallet && (!isWallet(suppliedSellerWallet) || lc(suppliedSellerWallet) !== authenticatedWallet)) {
      return Response.json({ error: 'Seller does not match authenticated wallet' }, { status: 403 });
    }

    const conversation = await getById('conversations', conversationId);
    if (!conversation) {
      return Response.json({ error: 'Conversation not found' }, { status: 404 });
    }

    if (!isConversationParticipant(conversation, authenticatedWallet)) {
      return Response.json({ error: 'Not a participant in this conversation' }, { status: 403 });
    }

    // Only the seller may confirm the order.
    if (lc(String(conversation.sellerWallet || '')) !== authenticatedWallet) {
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
        confirmedBy: authenticatedWallet,
      },
    });

    // Append a confirm message so both sides see it in the chat thread.
    await createSynqMessage({
      conversationId: conversation.id,
      fromWallet: authenticatedWallet,
      toWallet: lc(String(conversation.buyerWallet || '')),
      fromName: conversation.sellerName || undefined,
      body: 'I confirm this order. Let\'s proceed.',
      kind: 'confirm',
      payload: null,
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
