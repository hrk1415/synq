import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import {
  reconcileProposalWithReceipt,
} from '@/lib/deals/proposals-reconcile';
import {
  serializeDealProposal,
  ProposalAuthError,
  ProposalValidationError,
  ProposalConflictError,
} from '@/lib/deals/proposals-db';

interface RouteContext {
  params: Promise<{ proposalId: string }> | { proposalId: string };
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    // 1. Authenticate caller
    const authWallet = getAuthenticatedWallet(req);
    if (!authWallet) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Extract and validate proposalId
    const resolvedParams = await Promise.resolve(context.params);
    const rawProposalId = resolvedParams?.proposalId;
    if (!rawProposalId || !/^0x[0-9a-fA-F]{64}$/.test(rawProposalId)) {
      return NextResponse.json({ error: 'Invalid proposalId format' }, { status: 400 });
    }
    const proposalId = rawProposalId.toLowerCase();

    // 3. Parse JSON body
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
    }

    if (!rawBody || typeof rawBody !== 'object') {
      return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 });
    }

    const { txHash } = rawBody as { txHash?: unknown };
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash.trim())) {
      return NextResponse.json({ error: 'Valid 32-byte hex txHash is required' }, { status: 400 });
    }

    // 4. Reconcile proposal lifecycle state against verified on-chain receipt
    const result = await reconcileProposalWithReceipt(proposalId, txHash.trim(), authWallet);

    return NextResponse.json(
      {
        proposal: serializeDealProposal(result.proposal),
        reconciled: result.reconciled,
        alreadyReconciled: result.alreadyReconciled,
        status: result.status,
        dealAddress: result.dealAddress,
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    if (err instanceof ProposalAuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof ProposalValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof ProposalConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error('[POST /api/deals/proposals/[proposalId]/reconcile] Unhandled error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
