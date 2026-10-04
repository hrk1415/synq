import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { isAddress } from 'viem';
import {
  stageResolutionReport,
  getResolutionReport,
  listResolutionReports,
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

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
    }

    const phase = body?.phase as ResolutionReportPhase;
    const freelancerAmount = body?.freelancerAmount;
    const clientAmount = body?.clientAmount;
    const summary = body?.summary;
    const findings = body?.findings;
    const justification = body?.justification;
    const evidenceReferences = body?.evidenceReferences;

    const result = await stageResolutionReport({
      dealAddress: rawDealAddress,
      milestoneId,
      callerWallet: authWallet,
      phase,
      freelancerAmount,
      clientAmount,
      summary,
      findings,
      justification,
      evidenceReferences,
    });

    return NextResponse.json(
      {
        success: true,
        report: result.report,
        justificationHash: result.justificationHash,
        reportId: result.reportId,
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
    console.error('[POST /api/deals/.../resolution-reports] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}

export async function GET(req: NextRequest, context: RouteContext) {
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

    const { searchParams } = new URL(req.url);
    const phaseParam = searchParams.get('phase') as ResolutionReportPhase | null;

    if (phaseParam) {
      const record = await getResolutionReport({
        dealAddress: rawDealAddress,
        milestoneId,
        phase: phaseParam,
        callerWallet: authWallet,
      });

      if (!record) {
        return NextResponse.json({ error: 'Resolution report not found' }, { status: 404 });
      }

      return NextResponse.json({ success: true, record }, { status: 200 });
    }

    const reports = await listResolutionReports({
      dealAddress: rawDealAddress,
      milestoneId,
      callerWallet: authWallet,
    });

    return NextResponse.json({ success: true, reports }, { status: 200 });
  } catch (err: any) {
    if (err instanceof ResolutionReportAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof ResolutionReportValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[GET /api/deals/.../resolution-reports] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
