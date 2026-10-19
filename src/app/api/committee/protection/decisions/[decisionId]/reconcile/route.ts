import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { checkCommitteeSignerStatus } from '@/lib/deals/v2-committee-signer';
import {
  reconcileProtectionDecision,
  ProtectionCommitteeAuthError,
  ProtectionCommitteeValidationError,
  ProtectionCommitteeIntegrityError,
  ProtectionCommitteeExecutionError,
} from '@/lib/deals/protection-committee-db';

interface RouteContext {
  params: Promise<{
    decisionId: string;
  }>;
}

export async function POST(req: NextRequest, context: RouteContext) {
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

    const { decisionId } = await context.params;
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      // Body is optional for crash recovery mode
    }

    const { txHash } = body || {};

    const decision = await reconcileProtectionDecision({
      decisionId,
      txHash: txHash || null,
      callerWallet: authWallet,
    });

    return NextResponse.json(
      {
        success: true,
        decision,
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
    if (err instanceof ProtectionCommitteeIntegrityError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof ProtectionCommitteeExecutionError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error('[POST /api/committee/protection/decisions/[decisionId]/reconcile] Error:', err);
    return NextResponse.json(
      { error: err?.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
