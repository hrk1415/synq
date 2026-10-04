import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { isAddress } from 'viem';
import {
  reconcileMilestoneDispute,
  DisputeAuthError,
  DisputeValidationError,
  DisputeConflictError,
  DisputeIntegrityError,
} from '@/lib/deals/disputes-db';

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
      // Body can be empty for crash recovery
    }

    const txHash = body?.txHash;

    const dispute = await reconcileMilestoneDispute({
      dealAddress: rawDealAddress,
      milestoneId,
      callerWallet: authWallet,
      txHash,
    });

    return NextResponse.json(
      {
        success: true,
        dispute,
      },
      { status: 200 }
    );
  } catch (err: any) {
    if (err instanceof DisputeAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof DisputeConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof DisputeValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof DisputeIntegrityError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error('[POST /api/deals/.../disputes/reconcile] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
