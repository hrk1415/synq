import { NextRequest } from 'next/server';
import { getUserFromRequest, unauthorized } from '@/lib/auth';
import { getAll } from '@/lib/db';

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  const activities = getAll('activities')
    .filter((a: any) => a.userId === user.userId)
    .sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return Response.json({ activities });
}
