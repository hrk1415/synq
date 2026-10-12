import { NextRequest } from 'next/server';
import { verifyMilestone } from '@/lib/ai';
import { query, create } from '@/lib/db';
import { getAuthenticatedWallet, unauthorized } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const dealAddress = String(req.nextUrl.searchParams.get('dealAddress') || '').toLowerCase();
  const milestoneId = req.nextUrl.searchParams.get('milestoneId');
  if (!dealAddress || milestoneId === null) {
    return Response.json({ verification: null });
  }
  const rows = await query('verifications', (v: any) =>
    String(v.dealAddress || '').toLowerCase() === dealAddress && String(v.milestoneId) === String(milestoneId)
  );
  return Response.json({ verification: rows[rows.length - 1] || null });
}

export async function POST(req: NextRequest) {
  const authenticatedWallet = getAuthenticatedWallet(req);
  if (!authenticatedWallet) return unauthorized();

  try {
    const body = await req.json();
    const { dealAddress, milestoneId, title, description, evidenceHash } = body;
    if (!dealAddress || milestoneId === undefined || !evidenceHash) {
      return Response.json({ error: 'dealAddress, milestoneId and evidenceHash are required' }, { status: 400 });
    }

    const result = await verifyMilestone({
      title: String(title || ''),
      description: String(description || ''),
      evidenceHash: String(evidenceHash),
    });

    const record = await create('verifications', {
      dealAddress,
      milestoneId: Number(milestoneId),
      completionPct: result.completionPct,
      summary: result.summary,
      verified: result.verified,
      notes: result.notes,
      recommendation: result.recommendation,
      createdAt: new Date().toISOString(),
    });

    return Response.json({ verification: record });
  } catch {
    return Response.json({ error: 'Milestone verification failed' }, { status: 500 });
  }
}
