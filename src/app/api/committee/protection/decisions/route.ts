import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { checkCommitteeSignerStatus } from '@/lib/deals/v2-committee-signer';
import {
  createProtectionDecisionDraft,
  DrizzleProtectionClaimDecisionRepository,
  ProtectionCommitteeAuthError,
  ProtectionCommitteeValidationError,
  ProtectionCommitteeConflictError,
  ProtectionCommitteeIntegrityError,
  ProtectionCommitteeExpiredError,
} from '@/lib/deals/protection-committee-db';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';

export async function GET(req: NextRequest) {
  try {
    const authWallet = getAuthenticatedWallet(req);
    if (!authWallet) {
      return NextResponse.json(
        { error: 'Unauthorized: valid wallet session required' },
        { status: 401 }
      );
    }

    const signerStatus = await checkCommitteeSignerStatus(authWallet);
    if (!signerStatus.isProtectionSigner) {
      return NextResponse.json(
        { error: 'Forbidden: wallet is not an active Protection Committee signer' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(req.url);
    const dealAddress = searchParams.get('dealAddress');
    const milestoneIdStr = searchParams.get('milestoneId');

    const repo = new DrizzleProtectionClaimDecisionRepository();

    if (dealAddress && milestoneIdStr !== null) {
      const milestoneId = parseInt(milestoneIdStr, 10);
      if (isNaN(milestoneId) || milestoneId < 0 || milestoneId >= 16) {
        return NextResponse.json({ error: 'Invalid milestoneId (0-15)' }, { status: 400 });
      }

      const decisions = await repo.listDecisionsByMilestone(
        SEPOLIA_CHAIN_ID,
        dealAddress,
        milestoneId
      );

      return NextResponse.json(
        {
          success: true,
          decisions,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      { error: 'Missing dealAddress and milestoneId search parameters' },
      { status: 400 }
    );
  } catch (err: any) {
    console.error('[GET /api/committee/protection/decisions] Error:', err);
    return NextResponse.json(
      { error: err?.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const authWallet = getAuthenticatedWallet(req);
    if (!authWallet) {
      return NextResponse.json(
        { error: 'Unauthorized: valid wallet session required' },
        { status: 401 }
      );
    }

    const signerStatus = await checkCommitteeSignerStatus(authWallet);
    if (!signerStatus.isProtectionSigner) {
      return NextResponse.json(
        { error: 'Forbidden: wallet is not an active Protection Committee signer' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const { dealAddress, milestoneId, decision, rationale, customNonce, validUntilSeconds } =
      body || {};

    if (!dealAddress || milestoneId === undefined || decision === undefined || !rationale) {
      return NextResponse.json(
        { error: 'Missing required fields: dealAddress, milestoneId, decision, rationale' },
        { status: 400 }
      );
    }

    const parsedMilestoneId = parseInt(String(milestoneId), 10);
    if (isNaN(parsedMilestoneId) || parsedMilestoneId < 0 || parsedMilestoneId >= 16) {
      return NextResponse.json({ error: 'Invalid milestoneId (0-15)' }, { status: 400 });
    }

    const result = await createProtectionDecisionDraft({
      dealAddress: String(dealAddress),
      milestoneId: parsedMilestoneId,
      decision,
      rationale: String(rationale),
      callerWallet: authWallet,
      customNonce: customNonce !== undefined ? BigInt(customNonce) : undefined,
      validUntilSeconds:
        validUntilSeconds !== undefined ? BigInt(validUntilSeconds) : undefined,
    });

    return NextResponse.json(
      {
        success: true,
        decision: result.decision,
        typedData: result.typedData,
        typedDataHash: result.typedDataHash,
      },
      { status: 201 }
    );
  } catch (err: any) {
    if (err instanceof ProtectionCommitteeAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof ProtectionCommitteeConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof ProtectionCommitteeValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof ProtectionCommitteeIntegrityError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof ProtectionCommitteeExpiredError) {
      return NextResponse.json({ error: err.message }, { status: 410 });
    }

    console.error('[POST /api/committee/protection/decisions] Error:', err);
    return NextResponse.json(
      { error: err?.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
