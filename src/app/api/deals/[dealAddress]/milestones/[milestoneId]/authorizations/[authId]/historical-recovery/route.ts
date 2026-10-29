import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { isAddress } from 'viem';
import {
  executeHistoricalAuthorizationRecovery,
  HistoricalRecoveryTargetError,
  HistoricalRecoveryAdminError,
  HistoricalRecoveryIntegrityError,
  HistoricalRecoveryOnChainError,
  HistoricalRecoveryInconsistentStateError,
  HISTORICAL_RECOVERY_TARGET,
} from '@/lib/deals/historical-recovery';

interface RouteContext {
  params:
    | Promise<{ dealAddress: string; milestoneId: string; authId: string }>
    | { dealAddress: string; milestoneId: string; authId: string };
}

/**
 * Exceptional administrative endpoint strictly restricted to historical recovery of
 * authorization 779f4088-aeee-4223-a277-38b6b3dbfd0e.
 * Ordinary committee signers are rejected; requires verified administrative identity.
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const authWallet = getAuthenticatedWallet(req);
    if (!authWallet) {
      return NextResponse.json(
        { error: 'Unauthorized: valid wallet session required' },
        { status: 401 }
      );
    }

    const resolvedParams = await Promise.resolve(context.params);
    const rawDealAddress = resolvedParams?.dealAddress;
    const rawMilestoneId = resolvedParams?.milestoneId;
    const authId = resolvedParams?.authId;

    if (!rawDealAddress || !isAddress(rawDealAddress)) {
      return NextResponse.json({ error: 'Invalid dealAddress in route parameter' }, { status: 400 });
    }

    const milestoneId = Number(rawMilestoneId);
    if (!Number.isInteger(milestoneId) || milestoneId < 0) {
      return NextResponse.json({ error: 'Invalid milestoneId in route parameter' }, { status: 400 });
    }

    if (!authId || typeof authId !== 'string') {
      return NextResponse.json({ error: 'Invalid authId in route parameter' }, { status: 400 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      // Body is optional; default executionTxHash will be taken from target definition if omitted
    }

    const executionTxHash = body?.executionTxHash || HISTORICAL_RECOVERY_TARGET.executionTxHash;

    const result = await executeHistoricalAuthorizationRecovery({
      dealAddress: rawDealAddress,
      milestoneId,
      authorizationId: authId,
      executionTxHash,
      callerWallet: authWallet,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (err: any) {
    if (err instanceof HistoricalRecoveryTargetError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof HistoricalRecoveryAdminError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof HistoricalRecoveryIntegrityError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof HistoricalRecoveryOnChainError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof HistoricalRecoveryInconsistentStateError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error('[POST historical-recovery] Unexpected error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
