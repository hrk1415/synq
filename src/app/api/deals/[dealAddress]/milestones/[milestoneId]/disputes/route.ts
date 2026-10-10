import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { isAddress } from 'viem';
import {
  stageMilestoneDispute,
  getMilestoneDispute,
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

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
    }

    const explanation = body?.explanation;
    const category = body?.category;
    const links = body?.links;

    const result = await stageMilestoneDispute({
      dealAddress: rawDealAddress,
      milestoneId,
      callerWallet: authWallet,
      explanation,
      category,
      links,
    });

    return NextResponse.json(
      {
        success: true,
        manifest: result.manifest,
        reasonHash: result.reasonHash,
        dispute: result.row,
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
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    console.error('[POST /api/deals/.../disputes] Unhandled error:', err);
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

    const dispute = await getMilestoneDispute({
      dealAddress: rawDealAddress,
      milestoneId,
      callerWallet: authWallet,
    });

    if (!dispute) {
      return NextResponse.json({ error: 'Dispute record not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, dispute }, { status: 200 });
  } catch (err: any) {
    if (err instanceof DisputeAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof DisputeValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[GET /api/deals/.../disputes] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
