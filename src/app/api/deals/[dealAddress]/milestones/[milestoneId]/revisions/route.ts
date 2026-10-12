import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { isAddress } from 'viem';
import {
  stageMilestoneRevision,
  getMilestoneRevision,
  RevisionAuthError,
  RevisionValidationError,
  RevisionConflictError,
  RevisionIntegrityError,
} from '@/lib/deals/revisions-db';

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

    const rawManifest = body?.manifest ?? body;
    const claimedReasonHash = body?.claimedReasonHash;
    const feedback = body?.feedback;
    const proposedRevisionDeadline = body?.proposedRevisionDeadline;

    // Verify route parameters match manifest (if supplied in manifest)
    if (
      rawManifest &&
      typeof rawManifest === 'object' &&
      typeof rawManifest.dealAddress === 'string' &&
      isAddress(rawManifest.dealAddress)
    ) {
      if (rawManifest.dealAddress.toLowerCase() !== rawDealAddress.toLowerCase()) {
        return NextResponse.json(
          { error: `Manifest dealAddress (${rawManifest.dealAddress}) does not match route dealAddress (${rawDealAddress})` },
          { status: 400 }
        );
      }
    }

    if (
      rawManifest &&
      typeof rawManifest === 'object' &&
      typeof rawManifest.milestoneId === 'number'
    ) {
      if (rawManifest.milestoneId !== milestoneId) {
        return NextResponse.json(
          { error: `Manifest milestoneId (${rawManifest.milestoneId}) does not match route milestoneId (${milestoneId})` },
          { status: 400 }
        );
      }
    }

    const result = await stageMilestoneRevision({
      rawManifest,
      dealAddress: rawDealAddress,
      milestoneId,
      feedback,
      proposedRevisionDeadline,
      authWallet,
      claimedReasonHash,
    });

    return NextResponse.json(
      {
        success: true,
        revision: result.revision,
        reasonHash: result.reasonHash,
        proposedRevisionDeadline: result.proposedRevisionDeadline,
        submissionVersion: result.submissionVersion,
      },
      { status: 200 }
    );
  } catch (err: any) {
    if (err instanceof RevisionAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof RevisionConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof RevisionValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof RevisionIntegrityError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    console.error('[POST /api/deals/.../revisions] Unhandled error:', err);
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
    const rawVersion = searchParams.get('version');
    if (!rawVersion || !/^\d+$/.test(rawVersion)) {
      return NextResponse.json({ error: 'Query parameter version must be a positive integer' }, { status: 400 });
    }
    const version = Number(rawVersion);
    if (version < 1) {
      return NextResponse.json({ error: 'Query parameter version must be >= 1' }, { status: 400 });
    }

    const result = await getMilestoneRevision({
      dealAddress: rawDealAddress,
      milestoneId,
      version,
      authWallet,
    });

    if (!result) {
      return NextResponse.json({ error: 'Milestone revision request not found' }, { status: 404 });
    }

    return NextResponse.json(
      {
        revision: result.revision,
        manifest: result.manifest,
        reasonHash: result.revision.reasonHash,
        status: result.revision.status,
        txHash: result.revision.txHash,
        requestedAt: result.revision.requestedAt,
        submissionVersion: result.revision.submissionVersion,
        proposedRevisionDeadline: result.revision.proposedRevisionDeadline,
      },
      { status: 200 }
    );
  } catch (err: any) {
    if (err instanceof RevisionAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof RevisionConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof RevisionValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof RevisionIntegrityError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    console.error('[GET /api/deals/.../revisions] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
