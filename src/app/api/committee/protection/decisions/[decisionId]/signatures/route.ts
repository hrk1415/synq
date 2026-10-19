import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { checkCommitteeSignerStatus } from '@/lib/deals/v2-committee-signer';
import {
  submitProtectionDecisionSignature,
  ProtectionCommitteeAuthError,
  ProtectionCommitteeValidationError,
  ProtectionCommitteeConflictError,
  ProtectionCommitteeIntegrityError,
  ProtectionCommitteeExpiredError,
  ProtectionCommitteeInvalidatedError,
} from '@/lib/deals/protection-committee-db';

interface RouteContext {
  params: Promise<{
    decisionId: string;
  }>;
}

export async function POST(req: NextRequest, context: RouteContext) {
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

    const { decisionId } = await context.params;
    const body = await req.json();
    const { signature } = body || {};

    if (!signature || typeof signature !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid signature (must be 65-byte hex string)' },
        { status: 400 }
      );
    }

    const result = await submitProtectionDecisionSignature({
      decisionId,
      signature: signature as `0x${string}`,
      signerWallet: authWallet,
    });

    return NextResponse.json(
      {
        success: true,
        signature: result.signature,
        decisionStatus: result.decisionStatus,
        thresholdMet: result.thresholdMet,
        thresholdBundle: result.thresholdBundle,
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
    if (err instanceof ProtectionCommitteeInvalidatedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error('[POST /api/committee/protection/decisions/[decisionId]/signatures] Error:', err);
    return NextResponse.json(
      { error: err?.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
