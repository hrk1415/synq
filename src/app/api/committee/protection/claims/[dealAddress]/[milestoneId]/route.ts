import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import {
  getProtectionClaimDetail,
  ProtectionCommitteeAuthError,
  ProtectionCommitteeValidationError,
} from '@/lib/deals/protection-committee-db';

interface RouteContext {
  params: Promise<{
    dealAddress: string;
    milestoneId: string;
  }>;
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const authWallet = getAuthenticatedWallet(req);
    if (!authWallet) {
      return NextResponse.json(
        { error: 'Unauthorized: valid wallet session required' },
        { status: 401 }
      );
    }

    const { dealAddress, milestoneId } = await context.params;
    const parsedMilestoneId = parseInt(milestoneId, 10);
    if (isNaN(parsedMilestoneId) || parsedMilestoneId < 0 || parsedMilestoneId >= 16) {
      return NextResponse.json({ error: 'Invalid milestoneId (0-15)' }, { status: 400 });
    }

    const detail = await getProtectionClaimDetail({
      dealAddress,
      milestoneId: parsedMilestoneId,
      callerWallet: authWallet,
    });

    return NextResponse.json(
      {
        success: true,
        callerWallet: authWallet,
        detail,
      },
      { status: 200 }
    );
  } catch (err: any) {
    if (err instanceof ProtectionCommitteeAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof ProtectionCommitteeValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[GET /api/committee/protection/claims/[dealAddress]/[milestoneId]] Error:', err);
    return NextResponse.json(
      { error: err?.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
