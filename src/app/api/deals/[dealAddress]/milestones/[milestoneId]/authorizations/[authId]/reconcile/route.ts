import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import {
  reconcileCommitteeAuthorization,
  CommitteeAuthAuthError,
  CommitteeAuthValidationError,
  CommitteeAuthConflictError,
  CommitteeAuthIntegrityError,
  CommitteeAuthExpiredError,
  CommitteeAuthInvalidatedError,
  CommitteeExecutionReceiptError,
  CommitteeExecutionRecoveryError,
} from '@/lib/deals/committee-authorizations-db';

interface RouteContext {
  params:
    | Promise<{ dealAddress: string; milestoneId: string; authId: string }>
    | { dealAddress: string; milestoneId: string; authId: string };
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const authWallet = getAuthenticatedWallet(req);
    if (!authWallet) {
      return NextResponse.json({ error: 'Unauthorized: valid wallet session required' }, { status: 401 });
    }

    const resolvedParams = await Promise.resolve(context.params);
    const authId = resolvedParams?.authId;

    if (!authId || typeof authId !== 'string') {
      return NextResponse.json({ error: 'Invalid authId route parameter' }, { status: 400 });
    }

    let txHash: string | undefined;
    try {
      const body = await req.json();
      if (body && typeof body.txHash === 'string') {
        txHash = body.txHash;
      }
    } catch {
      // Body is optional (crash recovery can run without txHash)
      txHash = undefined;
    }

    const result = await reconcileCommitteeAuthorization({
      authorizationId: authId,
      callerWallet: authWallet,
      txHash,
    });

    return NextResponse.json(
      {
        success: true,
        authorization: result.authorization,
        report: result.report,
        executionTxHash: result.executionTxHash,
        executedByWallet: result.executedByWallet,
        executedAt: result.executedAt,
        alreadyExecuted: result.alreadyExecuted,
      },
      { status: 200 }
    );
  } catch (err: any) {
    if (err instanceof CommitteeAuthAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof CommitteeAuthConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof CommitteeAuthValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof CommitteeExecutionRecoveryError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof CommitteeExecutionReceiptError || err instanceof CommitteeAuthIntegrityError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof CommitteeAuthExpiredError || err instanceof CommitteeAuthInvalidatedError) {
      return NextResponse.json({ error: err.message }, { status: 410 });
    }
    console.error('[POST /api/deals/.../authorizations/.../reconcile] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
