import { NextRequest } from 'next/server';
import { getUserFromRequest, unauthorized } from '@/lib/auth';
import { getById, update } from '@/lib/db';
import { notifyDealConfirmedToSeller, notifyBuyerDealCompleted } from '@/lib/notify';

const CONFIRMED = ['confirmed', 'active', 'activated', '1', 'locked'];
const COMPLETED = ['completed', 'complete', 'done', '2', 'finalized'];
const norm = (s: unknown) => String(s || '').toLowerCase().trim();

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deal = getById('deals', id);
  if (!deal) return Response.json({ error: 'Deal not found' }, { status: 404 });
  return Response.json({ deal });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  try {
    const body = await req.json();
    const prev = getById('deals', id);
    const deal = update('deals', id, { ...body, updatedAt: new Date().toISOString() });
    if (!deal) return Response.json({ error: 'Deal not found' }, { status: 404 });

    const prevStatus = norm(prev?.status);
    const newStatus = norm(deal.status);

    if (!CONFIRMED.includes(prevStatus) && CONFIRMED.includes(newStatus)) {
      void notifyDealConfirmedToSeller({
        event: 'deal_confirmed',
        recipientEmail: body.sellerEmail || body.recipientEmail || prev?.sellerEmail,
        recipientName: deal.seller || body.seller,
        recipientWallet: deal.sellerWallet || body.sellerWallet || body.counterparty,
        dealTitle: deal.title,
        dealAmount: body.amount ? String(body.amount) : String(deal.value ?? ''),
        dealId: deal.id,
        note: body.note,
      }).catch(() => {});
    }

    if (!COMPLETED.includes(prevStatus) && COMPLETED.includes(newStatus)) {
      void notifyBuyerDealCompleted({
        event: 'deal_completed',
        recipientEmail: body.buyerEmail || body.recipientEmail || prev?.buyerEmail,
        recipientName: deal.buyer || body.buyer,
        recipientWallet: deal.buyerWallet || body.buyerWallet,
        dealTitle: deal.title,
        dealAmount: body.amount ? String(body.amount) : String(deal.value ?? ''),
        dealId: deal.id,
        note: body.note,
      }).catch(() => {});
    }

    return Response.json({ deal });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}
