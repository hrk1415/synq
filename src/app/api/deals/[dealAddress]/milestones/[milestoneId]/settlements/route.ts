import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { isAddress } from 'viem';
import {
  createMutualSettlementProposal,
  getMutualSettlementProposals,
  MutualSettlementAuthError,
  MutualSettlementValidationError,
  MutualSettlementConflictError,
  MutualSettlementIntegrityError,
} from '@/lib/deals/mutual-settlements-db';

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

    const freelancerAmount = body?.freelancerAmount;
    const clientAmount = body?.clientAmount;
    const proposalNonce = body?.proposalNonce;
    const validUntil = body?.validUntil;
    const signature = body?.signature;

    if (!signature || typeof signature !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid signature' }, { status: 400 });
    }

    const proposal = await createMutualSettlementProposal({
      dealAddress: rawDealAddress,
      milestoneId,
      proposerWallet: authWallet,
      freelancerAmount,
      clientAmount,
      proposalNonce,
      validUntil,
      signature: signature as `0x${string}`,
    });

    return NextResponse.json(
      {
        success: true,
        proposal,
      },
      { status: 201 }
    );
  } catch (err: any) {
    if (err instanceof MutualSettlementAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof MutualSettlementConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof MutualSettlementValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof MutualSettlementIntegrityError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    console.error('[POST /api/deals/.../settlements] Unhandled error:', err);
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

    const proposals = await getMutualSettlementProposals({
      dealAddress: rawDealAddress,
      milestoneId,
      callerWallet: authWallet,
    });

    return NextResponse.json({ success: true, proposals }, { status: 200 });
  } catch (err: any) {
    if (err instanceof MutualSettlementAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof MutualSettlementValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[GET /api/deals/.../settlements] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
