import { NextRequest } from 'next/server';
import { getUserFromRequest, unauthorized } from '@/lib/auth';
import { getAll, create } from '@/lib/db';

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  // Anonymous callers used to receive every user's payment history. Require auth.
  if (!user) return unauthorized();
  const payments = getAll('payments').filter((p: any) => p.userId === user.userId);
  return Response.json({ payments });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  try {
    const body = await req.json();
    const payment = create('payments', {
      ...body,
      userId: user.userId,
      status: 'pending',
      timestamp: new Date().toISOString(),
    });

    create('activities', {
      type: 'payment_sent',
      title: 'Payment Sent',
      description: `Payment of $${body.amount} sent to ${body.recipient}`,
      amount: body.amount,
      dealId: body.dealId || null,
      userId: user.userId,
      timestamp: new Date().toISOString(),
    });

    return Response.json({ payment }, { status: 201 });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}
