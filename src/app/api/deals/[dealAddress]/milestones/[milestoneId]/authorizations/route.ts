import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { isAddress } from 'viem';
import {
  createCommitteeAuthorization,
  getCommitteeAuthorization,
  CommitteeAuthAuthError,
  CommitteeAuthValidationError,
  CommitteeAuthConflictError,
  CommitteeAuthIntegrityError,
  CommitteeAuthExpiredError,
  CommitteeAuthInvalidatedError,
  DrizzleCommitteeAuthorizationRepository,
} from '@/lib/deals/committee-authorizations-db';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';

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

    const reportId = body?.reportId;
    if (!reportId || typeof reportId !== 'string') {
      return NextResponse.json({ error: 'reportId is required in request body' }, { status: 400 });
    }

    const result = await createCommitteeAuthorization({
      reportId,
      callerWallet: authWallet,
      resolutionNonce: body?.resolutionNonce,
      validUntilSeconds: body?.validUntilSeconds,
    });

    return NextResponse.json(
      {
        success: true,
        authorization: result.authorization,
        typedData: result.typedData,
        typedDataHash: result.typedDataHash,
      },
      { status: 200 }
    );
  } catch (err: any) {
    if (err instanceof CommitteeAuthAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof CommitteeAuthConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof CommitteeAuthValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof CommitteeAuthIntegrityError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof CommitteeAuthExpiredError || err instanceof CommitteeAuthInvalidatedError) {
      return NextResponse.json({ error: err.message }, { status: 410 });
    }
    console.error('[POST /api/deals/.../authorizations] Unhandled error:', err);
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

    const searchParams = req.nextUrl.searchParams;
    const authId = searchParams.get('id');

    if (authId) {
      const single = await getCommitteeAuthorization({
        authorizationId: authId,
        callerWallet: authWallet,
      });
      return NextResponse.json(single, { status: 200 });
    }

    const repo = new DrizzleCommitteeAuthorizationRepository();
    const rows = await repo.listAuthsByMilestone(SEPOLIA_CHAIN_ID, rawDealAddress, milestoneId);

    // Filter to authorizations caller can access
    const accessible: any[] = [];
    for (const row of rows) {
      try {
        const item = await getCommitteeAuthorization({
          authorizationId: row.id,
          callerWallet: authWallet,
          authRepo: repo,
        });
        accessible.push(item);
      } catch {
        // Exclude unpermitted
      }
    }

    return NextResponse.json({ authorizations: accessible }, { status: 200 });
  } catch (err: any) {
    if (err instanceof CommitteeAuthAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof CommitteeAuthValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[GET /api/deals/.../authorizations] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
