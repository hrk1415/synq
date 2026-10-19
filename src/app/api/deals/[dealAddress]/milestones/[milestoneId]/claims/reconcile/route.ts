import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { isAddress } from 'viem';
import {
  reconcileProtectionClaim,
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

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      // Empty body allowed for hash-free crash recovery
    }

    const txHash = body?.txHash;
    if (txHash && !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return NextResponse.json({ error: 'Invalid txHash format (must be a 0x-prefixed 32-byte hex string)' }, { status: 400 });
    }

    const claim = await reconcileProtectionClaim({
      dealAddress: rawDealAddress,
      milestoneId,
      callerWallet: authWallet,
      txHash: txHash || undefined,
    });

    return NextResponse.json(
      {
        success: true,
        claim,
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
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error('[POST /api/deals/.../claims/reconcile] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
