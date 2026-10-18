import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { checkCommitteeSignerStatus } from '@/lib/deals/committee-queue';
import { getPendingSyncAuthorizations } from '@/lib/deals/committee-pending-sync';

export async function GET(req: NextRequest) {
  try {
    const authWallet = getAuthenticatedWallet(req);
    if (!authWallet) {
      return NextResponse.json({ error: 'Unauthorized: valid wallet session required' }, { status: 401 });
    }

    const signerStatus = await checkCommitteeSignerStatus(authWallet);
    if (!signerStatus.isAnySigner) {
      return NextResponse.json(
        { error: 'Forbidden: wallet is not an active signer on any resolution committee' },
        { status: 403 }
      );
    }

    const items = await getPendingSyncAuthorizations({
      callerWallet: authWallet,
    });

    return NextResponse.json(
      {
        success: true,
        callerWallet: authWallet,
        items,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error('[GET /api/committee/pending-sync] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
