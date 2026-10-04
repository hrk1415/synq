import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { isAddress } from 'viem';
import {
  reconcileMilestoneSubmission,
  SubmissionAuthError,
  SubmissionValidationError,
  SubmissionConflictError,
  SubmissionIntegrityError,
} from '@/lib/deals/submissions-db';

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

    const version = Number(body?.version);
    if (!Number.isInteger(version) || version < 1) {
      return NextResponse.json({ error: 'Field version must be a positive integer' }, { status: 400 });
    }

    const txHash = typeof body?.txHash === 'string' && body.txHash.trim()
      ? body.txHash.trim()
      : undefined;

    const result = await reconcileMilestoneSubmission({
      dealAddress: rawDealAddress,
      milestoneId,
      version,
      authWallet,
      txHash,
    });

    return NextResponse.json(
      {
        success: true,
        submission: result.submission,
      },
      { status: 200 }
    );
  } catch (err: any) {
    if (err instanceof SubmissionAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof SubmissionConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof SubmissionValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof SubmissionIntegrityError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    console.error('[POST /api/deals/.../submissions/reconcile] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
