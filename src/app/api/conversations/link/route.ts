import { NextRequest } from 'next/server';
import { getById, update, create, query } from '@/lib/db';

/**
 * Links a chat conversation to the on-chain deal that backs it.
 *
 *   POST { dealAddress, buyerWallet?, sellerWallet?, conversationId? }
 *     → finds the conversation (by id, else by buyer/seller pair)
 *     → stamps dealAddress
 *     → corrects buyer/seller roles to match the on-chain deal (source of truth)
 *
 * In the canonical flow the buyer creates the deal first, then messages the
 * seller, so the conversation's roles are usually already right. But a seller
 * who messages a buyer first would otherwise be recorded as the "buyer", which
 * flips the "Confirm Order" button and 403s the confirm API. This endpoint
 * makes the on-chain deal authoritative so the chat can never disagree with it.
 */

const isWallet = (w: unknown): w is string => typeof w === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w);
const lc = (w: string) => w.toLowerCase();

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const dealAddress = String(body.dealAddress || '').trim();
    if (!dealAddress) {
      return Response.json({ error: 'dealAddress is required' }, { status: 400 });
    }

    const buyerWallet = body.buyerWallet && isWallet(body.buyerWallet) ? lc(body.buyerWallet) : undefined;
    const sellerWallet = body.sellerWallet && isWallet(body.sellerWallet) ? lc(body.sellerWallet) : undefined;
    const conversationId = String(body.conversationId || '').trim() || undefined;

    let conversation = conversationId ? await getById('conversations', conversationId) : null;

    if (!conversation && buyerWallet && sellerWallet) {
      const pair = await query('conversations', (c: any) =>
        (lc(String(c.buyerWallet || '')) === buyerWallet && lc(String(c.sellerWallet || '')) === sellerWallet) ||
        (lc(String(c.buyerWallet || '')) === sellerWallet && lc(String(c.sellerWallet || '')) === buyerWallet),
      );
      conversation = pair[0] || null;
    }

    // No existing conversation: only create one when we have authoritative
    // buyer/seller (i.e. an on-chain deal exists) so we never invent a thread.
    if (!conversation) {
      if (!buyerWallet || !sellerWallet) {
        return Response.json(
          { error: 'Could not find a conversation to link — pass conversationId or buyer/seller wallets.' },
          { status: 404 },
        );
      }
      const created = await create('conversations', {
        buyerWallet,
        sellerWallet,
        dealAddress,
        createdAt: new Date().toISOString(),
      });
      return Response.json({ conversation: created, created: true });
    }

    const patch: Record<string, unknown> = { dealAddress };

    // Reconcile roles with the on-chain deal. The factory records buyer =
    // msg.sender and seller = the counterparty, so if the chat pair is simply
    // swapped (seller messaged first), swap them back. Leave unrelated pairs
    // alone to avoid clobbering an unrelated thread.
    if (buyerWallet && sellerWallet) {
      const curBuyer = lc(String(conversation.buyerWallet || ''));
      const curSeller = lc(String(conversation.sellerWallet || ''));
      const swapped = curBuyer === sellerWallet && curSeller === buyerWallet;
      if (swapped) {
        patch.buyerWallet = buyerWallet;
        patch.sellerWallet = sellerWallet;
      }
    }

    const updated = await update('conversations', conversation.id, patch);
    return Response.json({ conversation: updated, created: false });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Failed to link conversation' }, { status: 500 });
  }
}
