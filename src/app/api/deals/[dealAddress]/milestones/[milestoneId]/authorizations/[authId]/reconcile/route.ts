import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import {
  reconcileCommitteeAuthorization,
  CommitteeAuthAuthError,
  CommitteeAuthValidationError,
  CommitteeAuthConflictError,
  CommitteeAuthIntegrityError,
  CommitteeAuthExpiredError,
  CommitteeAuthInvalidatedError,
  CommitteeExecutionReceiptError,
  CommitteeExecutionRecoveryError,
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

    let txHash: string | undefined;
    try {
      const body = await req.json();
      if (body && typeof body.txHash === 'string') {
        txHash = body.txHash;
      }
    } catch {
      // Body is optional (crash recovery can run without txHash)
      txHash = undefined;
    }

    const result = await reconcileCommitteeAuthorization({
      authorizationId: authId,
      callerWallet: authWallet,
      txHash,
    });

    try {
      const { getDealOutboxRepository } = await import('@/lib/deals/outbox-db');
      const { SEPOLIA_CHAIN_ID } = await import('@/lib/contracts/addresses');
      const { readStandardV2DealData } = await import('@/lib/deals/v2-deal');
      const { sepoliaPublicClient } = await import('@/lib/chain');
      const dealAddress = result.authorization.dealAddress;
      const milestoneIndex = result.authorization.milestoneId;
      const dealData = await readStandardV2DealData(dealAddress as `0x${string}`, sepoliaPublicClient).catch(() => null);
      if (dealData) {
        const outboxRepo = getDealOutboxRepository();
        for (const recipient of [dealData.client, dealData.freelancer]) {
          const eventId = `outbox:${SEPOLIA_CHAIN_ID}:${dealAddress.toLowerCase()}:resolution_finalized:${recipient.toLowerCase()}:${authId}`;
          await outboxRepo.enqueue({
            id: eventId,
            chainId: SEPOLIA_CHAIN_ID,
            dealId: dealAddress,
            event: 'resolution_finalized',
            recipientWallet: recipient,
            payload: {
              dealId: dealAddress,
              milestoneIndex,
              authorizationId: authId,
              txHash: result.executionTxHash,
            },
          });
        }
      }
    } catch (e) {
      console.warn('[authorizations/reconcile] Outbox enqueue warning:', e);
    }

    return NextResponse.json(
      {
        success: true,
        authorization: result.authorization,
        report: result.report,
        executionTxHash: result.executionTxHash,
        executedByWallet: result.executedByWallet,
        executedAt: result.executedAt,
        alreadyExecuted: result.alreadyExecuted,
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
    if (err instanceof CommitteeExecutionRecoveryError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof CommitteeExecutionReceiptError || err instanceof CommitteeAuthIntegrityError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof CommitteeAuthExpiredError || err instanceof CommitteeAuthInvalidatedError) {
      return NextResponse.json({ error: err.message }, { status: 410 });
    }
    console.error('[POST /api/deals/.../authorizations/.../reconcile] Unhandled error:', err);
    return NextResponse.json({ error: err?.message || 'Internal server error' }, { status: 500 });
  }
}
