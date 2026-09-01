import { NextRequest } from 'next/server';
import { getUserFromRequest, unauthorized } from '@/lib/auth';
import { getAll, create } from '@/lib/db';

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  // Anonymous callers used to receive every user's escrows. Require auth.
  if (!user) return unauthorized();
  const escrows = (await getAll('escrows')).filter((e: any) => e.userId === user.userId);
  return Response.json({ escrows });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  try {
    const body = await req.json();
    const escrow = await create('escrows', {
      ...body,
      userId: user.userId,
      createdAt: new Date().toISOString(),
    });
    return Response.json({ escrow }, { status: 201 });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}
