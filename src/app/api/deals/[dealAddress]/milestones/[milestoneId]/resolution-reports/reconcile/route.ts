import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { isAddress } from 'viem';
import {
  reconcileResolutionReport,
  ResolutionReportAuthError,
  ResolutionReportValidationError,
  ResolutionReportConflictError,
  ResolutionReportIntegrityError,
} from '@/lib/deals/resolution-reports-db';
import type { ResolutionReportPhase } from '@/db/schema';

interface RouteContext {
  params: Promise<{ dealAddress: string; milestoneId: string }> | { dealAddress: string; milestoneId: string };
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const authWallet = getAuthenticatedWallet(req);
    if (!authWallet) {
      return NextResponse.json({ error: 'Unauthorized: valid wallet session required' }, { status: 401 });
    }

    const resolvedParams = await Promise.resolve(context.params);
    const rawDealAddress = resolvedParams?.dealAddress;
    const rawMilestoneId = resolvedParams?.milestoneId;

    if (!rawDealAddress || !isAddress(rawDealAddress)) {
      return NextResponse.json({ error: 'Invalid dealAddress in route parameter' }, { status: 400 });
    }

    const milestoneId = Number(rawMilestoneId);
    if (!Number.isInteger(milestoneId) || milestoneId < 0) {
      return NextResponse.json({ error: 'Invalid milestoneId in route parameter' }, { status: 400 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      // Body may be empty for crash recovery
    }

    const phase = body?.phase as ResolutionReportPhase;
    if (!phase || (phase !== 'INITIAL_RESOLUTION' && phase !== 'FINAL_RESOLUTION')) {
      return NextResponse.json({ error: 'Missing or invalid phase: expected INITIAL_RESOLUTION or FINAL_RESOLUTION' }, { status: 400 });
    }

    const txHash = body?.txHash;

    const result = await reconcileResolutionReport({
      dealAddress: rawDealAddress,
      milestoneId,
      callerWallet: authWallet,
      phase,
      txHash,
    });

    return NextResponse.json(
      {
        success: true,
        report: result.report,
        justificationHash: result.justificationHash,
        row: result.row,
      },
      { status: 200 }
    );
  } catch (err: any) {
    if (err instanceof ResolutionReportAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof ResolutionReportConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof ResolutionReportValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof ResolutionReportIntegrityError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error('[POST /api/deals/.../resolution-reports/reconcile] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
