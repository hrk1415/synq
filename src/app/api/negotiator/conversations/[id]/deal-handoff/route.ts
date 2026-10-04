import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet, getNegotiatorDealHandoff } from '@/lib/ai-negotiator-db';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const wallet = getAuthenticatedWallet(req);
  if (!wallet) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401 }
    );
  }

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json(
      { error: 'Conversation ID required' },
      { status: 400 }
    );
  }

  const mode = req.nextUrl.searchParams.get('mode') || undefined;

  const result = await getNegotiatorDealHandoff(wallet, id, mode);
  if (!result.success) {
    return NextResponse.json(
      { code: result.code, error: result.error },
      { status: result.status }
    );
  }

  return NextResponse.json({ handoff: result.handoff }, { status: 200 });
}
