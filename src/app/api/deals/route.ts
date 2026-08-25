import { NextRequest } from 'next/server';
import { getUserFromRequest, unauthorized } from '@/lib/auth';
import { getAll, getById, create, update, remove } from '@/lib/db';
import { notifyDealConfirmedToSeller } from '@/lib/notify';

const CONFIRMED = ['confirmed', 'active', 'activated', '1', 'locked'];
const norm = (s: unknown) => String(s || '').toLowerCase().trim();

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  // Was: unauthenticated callers got getAll('deals') — every user's deals — while
  // authenticated ones got only their own. Anonymous must never see more.
  if (!user) return unauthorized();
  const deals = getAll('deals').filter((d: any) => d.userId === user.userId);
  return Response.json({ deals });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  try {
    const body = await req.json();
    const deal = create('deals', {
      ...body,
      userId: user.userId,
      status: body.status || 'draft',
      milestones: body.milestones || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (CONFIRMED.includes(norm(deal.status))) {
      void notifyDealConfirmedToSeller({
        event: 'deal_confirmed',
        recipientEmail: body.sellerEmail || body.recipientEmail,
        recipientName: body.seller,
        recipientWallet: body.sellerWallet || body.counterparty,
        dealTitle: deal.title,
        dealAmount: body.amount ? String(body.amount) : String(deal.value ?? ''),
        dealId: deal.id,
        note: body.note,
      }).catch(() => {});
    }

    create('activities', {
      type: 'deal_created',
      title: 'Deal Created',
      description: `${deal.title} deal was created`,
      dealId: deal.id,
      amount: deal.value,
      userId: user.userId,
      timestamp: new Date().toISOString(),
    });

    return Response.json({ deal }, { status: 201 });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}
