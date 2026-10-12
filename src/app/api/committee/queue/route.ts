import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import {
  getCommitteeQueueItems,
  checkCommitteeSignerStatus,
} from '@/lib/deals/committee-queue';

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

    const items = await getCommitteeQueueItems({
      callerWallet: authWallet,
    });

    return NextResponse.json(
      {
        success: true,
        callerWallet: authWallet,
        signerStatus,
        items,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error('[GET /api/committee/queue] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
