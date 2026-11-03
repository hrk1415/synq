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
  const tRouteStart = Date.now();
  console.log('[synq-recovery-diag] [route:entry]', {
    timestamp: new Date().toISOString(),
    method: req.method,
  });

  try {
    const tAuth0 = Date.now();
    const authWallet = getAuthenticatedWallet(req);
    const authDurationMs = Date.now() - tAuth0;
    console.log('[synq-recovery-diag] [route:auth_check]', {
      authenticated: !!authWallet,
      wallet: authWallet ? `${authWallet.slice(0, 6)}...${authWallet.slice(-4)}` : 'none',
      durationMs: authDurationMs,
    });

    if (!authWallet) {
      console.log('[synq-recovery-diag] [route:unauthorized]', {
        totalRouteDurationMs: Date.now() - tRouteStart,
      });
      return NextResponse.json(
        { error: 'Unauthorized: valid wallet session required' },
        { status: 401 }
      );
    }

    const tParam0 = Date.now();
    const resolvedParams = await Promise.resolve(context.params);
    const rawDealAddress = resolvedParams?.dealAddress;
    const rawMilestoneId = resolvedParams?.milestoneId;
    const authId = resolvedParams?.authId;

    if (!rawDealAddress || !isAddress(rawDealAddress)) {
      console.log('[synq-recovery-diag] [route:param_error:dealAddress]', {
        errorLabel: 'INVALID_DEAL_ADDRESS',
      });
      return NextResponse.json({ error: 'Invalid dealAddress in route parameter' }, { status: 400 });
    }

    const milestoneId = Number(rawMilestoneId);
    if (!Number.isInteger(milestoneId) || milestoneId < 0) {
      console.log('[synq-recovery-diag] [route:param_error:milestoneId]', {
        errorLabel: 'INVALID_MILESTONE_ID',
      });
      return NextResponse.json({ error: 'Invalid milestoneId in route parameter' }, { status: 400 });
    }

    if (!authId || typeof authId !== 'string') {
      console.log('[synq-recovery-diag] [route:param_error:authId]', {
        errorLabel: 'INVALID_AUTH_ID',
      });
      return NextResponse.json({ error: 'Invalid authId in route parameter' }, { status: 400 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      // Body is optional; default executionTxHash will be taken from target definition if omitted
    }

    const executionTxHash = body?.executionTxHash || HISTORICAL_RECOVERY_TARGET.executionTxHash;

    console.log('[synq-recovery-diag] [route:params_resolved]', {
      dealAddress: `${rawDealAddress.slice(0, 6)}...${rawDealAddress.slice(-4)}`,
      milestoneId,
      authId,
      executionTxHash: `${executionTxHash.slice(0, 10)}...${executionTxHash.slice(-8)}`,
      paramDurationMs: Date.now() - tParam0,
    });

    console.log('[synq-recovery-diag] [route:service_dispatch:start]', {
      authId,
      callerWallet: `${authWallet.slice(0, 6)}...${authWallet.slice(-4)}`,
    });
    const tService0 = Date.now();

    const result = await executeHistoricalAuthorizationRecovery({
      dealAddress: rawDealAddress,
      milestoneId,
      authorizationId: authId,
      executionTxHash,
      callerWallet: authWallet,
    });

    const serviceDurationMs = Date.now() - tService0;
    const totalRouteDurationMs = Date.now() - tRouteStart;

    console.log('[synq-recovery-diag] [route:service_dispatch:done]', {
      isIdempotentNoop: result.isIdempotentNoop,
      onChainMilestoneStatus: result.onChainMilestoneStatus,
      serviceDurationMs,
      totalRouteDurationMs,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (err: any) {
    const totalRouteDurationMs = Date.now() - tRouteStart;
    const errorLabel =
      err instanceof HistoricalRecoveryTargetError
        ? 'TARGET_ERROR'
        : err instanceof HistoricalRecoveryAdminError
        ? 'ADMIN_ERROR'
        : err instanceof HistoricalRecoveryIntegrityError
        ? 'INTEGRITY_ERROR'
        : err instanceof HistoricalRecoveryOnChainError
        ? 'ONCHAIN_ERROR'
        : err instanceof HistoricalRecoveryInconsistentStateError
        ? 'INCONSISTENT_STATE_ERROR'
        : 'INTERNAL_ERROR';

    console.error('[synq-recovery-diag] [route:error]', {
      errorName: err?.name || 'UnknownError',
      errorLabel,
      totalRouteDurationMs,
    });

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
    console.error('[POST historical-recovery] Unexpected error:', err?.name || 'Error');
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
