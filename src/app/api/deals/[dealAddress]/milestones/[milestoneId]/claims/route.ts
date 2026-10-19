import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { isAddress } from 'viem';
import {
  stageProtectionClaim,
  getProtectionClaim,
  ProtectionClaimAuthError,
  ProtectionClaimValidationError,
  ProtectionClaimConflictError,
  ProtectionClaimIntegrityError,
} from '@/lib/deals/protection-claims-db';

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
    if (!Number.isInteger(milestoneId) || milestoneId < 0 || milestoneId >= 16) {
      return NextResponse.json({ error: 'Invalid milestoneId in route parameter (must be 0-15)' }, { status: 400 });
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
    }

    const explanation = body?.explanation;
    const failureReason = body?.failureReason;
    const links = body?.links;

    const result = await stageProtectionClaim({
      dealAddress: rawDealAddress,
      milestoneId,
      callerWallet: authWallet,
      explanation,
      failureReason,
      links,
    });

    return NextResponse.json(
      {
        success: true,
        manifest: result.manifest,
        evidenceHash: result.evidenceHash,
        claim: result.row,
      },
      { status: 200 }
    );
  } catch (err: any) {
    if (err instanceof ProtectionClaimAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof ProtectionClaimConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof ProtectionClaimValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof ProtectionClaimIntegrityError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    console.error('[POST /api/deals/.../claims] Unhandled error:', err);
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
    if (!Number.isInteger(milestoneId) || milestoneId < 0 || milestoneId >= 16) {
      return NextResponse.json({ error: 'Invalid milestoneId in route parameter (must be 0-15)' }, { status: 400 });
    }

    const claim = await getProtectionClaim({
      dealAddress: rawDealAddress,
      milestoneId,
      callerWallet: authWallet,
    });

    if (!claim) {
      return NextResponse.json({ error: 'Claim record not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, claim }, { status: 200 });
  } catch (err: any) {
    if (err instanceof ProtectionClaimAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof ProtectionClaimValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[GET /api/deals/.../claims] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
