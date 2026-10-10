import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { isAddress } from 'viem';
import {
  submitCommitteeSignature,
  CommitteeAuthAuthError,
  CommitteeAuthValidationError,
  CommitteeAuthConflictError,
  CommitteeAuthIntegrityError,
  CommitteeAuthExpiredError,
  CommitteeAuthInvalidatedError,
} from '@/lib/deals/committee-authorizations-db';

interface RouteContext {
  params:
    | Promise<{ dealAddress: string; milestoneId: string; authId: string }>
    | { dealAddress: string; milestoneId: string; authId: string };
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const authWallet = getAuthenticatedWallet(req);
    if (!authWallet) {
      return NextResponse.json({ error: 'Unauthorized: valid wallet session required' }, { status: 401 });
    }

    const resolvedParams = await Promise.resolve(context.params);
    const authId = resolvedParams?.authId;

    if (!authId || typeof authId !== 'string') {
      return NextResponse.json({ error: 'Invalid authId route parameter' }, { status: 400 });
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
    }

    const signature = body?.signature;
    if (!signature || typeof signature !== 'string') {
      return NextResponse.json({ error: 'signature is required in request body' }, { status: 400 });
    }

    // Never trust signerWallet from body as authority; compare if supplied
    if (body?.signerWallet && typeof body.signerWallet === 'string') {
      if (body.signerWallet.toLowerCase() !== authWallet.toLowerCase()) {
        return NextResponse.json(
          { error: 'Forbidden: signerWallet in body does not match authenticated wallet identity' },
          { status: 403 }
        );
      }
    }

    const result = await submitCommitteeSignature({
      authorizationId: authId,
      signature,
      callerWallet: authWallet,
    });

    return NextResponse.json(
      {
        success: true,
        signature: result.signatureRow,
        authorization: result.authorization,
        thresholdReady: result.thresholdReady,
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
    console.error('[POST /api/deals/.../signatures] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
