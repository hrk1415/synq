import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { checkCommitteeSignerStatus } from '@/lib/deals/v2-committee-signer';
import { listPendingProtectionClaims } from '@/lib/deals/protection-committee-db';

export async function GET(req: NextRequest) {
  try {
    const authWallet = getAuthenticatedWallet(req);
    if (!authWallet) {
      return NextResponse.json(
        { error: 'Unauthorized: valid wallet session required' },
        { status: 401 }
      );
    }

    const signerStatus = await checkCommitteeSignerStatus(authWallet);
    if (!signerStatus.isProtectionSigner) {
      return NextResponse.json(
        { error: 'Forbidden: wallet is not an active Protection Committee signer' },
        { status: 403 }
      );
    }

    const items = await listPendingProtectionClaims({
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
    console.error('[GET /api/committee/protection/queue] Error:', err);
    return NextResponse.json(
      { error: err?.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
