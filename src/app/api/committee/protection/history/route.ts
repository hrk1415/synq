import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { checkCommitteeSignerStatus } from '@/lib/deals/v2-committee-signer';
import {
  listProtectionClaimHistory,
  ProtectionCommitteeAuthError,
  ProtectionCommitteeValidationError,
} from '@/lib/deals/protection-committee-db';

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

    const { searchParams } = new URL(req.url);
    const page = parseInt(searchParams.get('page') || '1', 10);
    const limit = parseInt(searchParams.get('limit') || '20', 10);

    const historyResult = await listProtectionClaimHistory({
      callerWallet: authWallet,
      page: isNaN(page) ? 1 : page,
      limit: isNaN(limit) ? 20 : limit,
    });

    return NextResponse.json(
      {
        success: true,
        callerWallet: authWallet,
        items: historyResult.items,
        pagination: historyResult.pagination,
      },
      { status: 200 }
    );
  } catch (err: any) {
    if (err instanceof ProtectionCommitteeAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof ProtectionCommitteeValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[GET /api/committee/protection/history] Error:', err);
    return NextResponse.json(
      { error: err?.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
