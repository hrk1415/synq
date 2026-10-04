import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import {
  prepareCommitteeExecutionTransaction,
  CommitteeAuthAuthError,
  CommitteeAuthValidationError,
  CommitteeAuthConflictError,
  CommitteeAuthIntegrityError,
  CommitteeAuthExpiredError,
  CommitteeAuthInvalidatedError,
} from '@/lib/deals/committee-authorizations-db';

interface RouteContext {
  params:
    | Promise<{ dealAddress: string; milestoneId: string; authId: string }>
    | { dealAddress: string; milestoneId: string; authId: string };
}

export async function GET(req: NextRequest, context: RouteContext) {
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

    const transactionRequest = await prepareCommitteeExecutionTransaction({
      authorizationId: authId,
      callerWallet: authWallet,
    });

    return NextResponse.json(
      {
        success: true,
        transactionRequest,
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
    if (err instanceof CommitteeAuthIntegrityError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof CommitteeAuthExpiredError || err instanceof CommitteeAuthInvalidatedError) {
      return NextResponse.json({ error: err.message }, { status: 410 });
    }
    console.error('[GET /api/deals/.../authorizations/.../prepare] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
