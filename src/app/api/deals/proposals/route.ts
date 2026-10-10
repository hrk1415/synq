import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { isAddress, getAddress } from 'viem';
import {
  verifyServerProposalSubmission,
  evaluateProposalPersistence,
  createDealProposal,
  createCanonicalDealProposalReceiptMessage,
  getDealProposalById,
  getDealProposalByClientNonce,
  getNextClientProposalNonce,
  serializeDealProposal,
  ProposalAuthError,
  ProposalValidationError,
  ProposalConflictError,
} from '@/lib/deals/proposals-db';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const client = searchParams.get('client');
    if (!client || !isAddress(client)) {
      return NextResponse.json({ error: 'Valid client address required' }, { status: 400 });
    }
    const nextNonce = await getNextClientProposalNonce(client);
    return NextResponse.json({ client: getAddress(client), nextNonce: nextNonce.toString() }, { status: 200 });
  } catch (err: unknown) {
    console.error('[GET /api/deals/proposals] Error fetching next nonce:', err);
    return NextResponse.json({ error: 'Failed to retrieve proposal nonce' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    // 1. Authenticate caller using bearer session
    const authWallet = getAuthenticatedWallet(req);
    if (!authWallet) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Read request JSON body safely
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
    }

    // 3. Execute strict verification pipeline (EIP-712 recovery, milestone hashing, etc.)
    const verified = await verifyServerProposalSubmission(rawBody, authWallet);

    // 4. Query DB for existing proposal by proposalId and by client nonce
    const [existingById, existingByNonce] = await Promise.all([
      getDealProposalById(verified.proposalId),
      getDealProposalByClientNonce(
        verified.rowToInsert.chainId,
        verified.rowToInsert.factoryAddress,
        verified.rowToInsert.clientWallet,
        verified.rowToInsert.proposalNonce,
      ),
    ]);

    // 5. Evaluate idempotency & nonce conflict
    const decision = evaluateProposalPersistence(verified.rowToInsert, existingById, existingByNonce);

    if (decision.action === 'IDEMPOTENT_REPLAY') {
      let receiptDelivered = true;
      let receiptWarning: string | undefined;
      try {
        await createCanonicalDealProposalReceiptMessage(decision.existingRow);
      } catch (deliveryErr: any) {
        receiptDelivered = false;
        receiptWarning = deliveryErr?.message || 'Receipt delivery failed';
        console.error('[POST /api/deals/proposals] SynqChat receipt replay delivery error:', deliveryErr);
      }

      return NextResponse.json(
        {
          proposal: serializeDealProposal(decision.existingRow),
          idempotent: true,
          receiptDelivered,
          ...(receiptWarning ? { receiptWarning } : {}),
        },
        { status: 200 },
      );
    }

    if (decision.action === 'CONFLICT_DATA') {
      return NextResponse.json({ error: decision.reason, code: 'CONFLICT_DATA' }, { status: 409 });
    }

    if (decision.action === 'CONFLICT_NONCE') {
      return NextResponse.json({ error: decision.reason, code: 'CONFLICT_NONCE' }, { status: 409 });
    }

    // 6. Persist immutable proposal record
    const created = await createDealProposal(decision.row);

    // 7. Deliver trusted SynqChat proposal receipt
    let receiptDelivered = true;
    let receiptWarning: string | undefined;
    try {
      await createCanonicalDealProposalReceiptMessage(created);
    } catch (deliveryErr: any) {
      receiptDelivered = false;
      receiptWarning = deliveryErr?.message || 'Receipt delivery failed';
      console.error('[POST /api/deals/proposals] SynqChat receipt delivery error:', deliveryErr);
    }

    // 7b. Deliver automatic email notification to freelancer (proposal_received)
    try {
      const { dispatchProposalCreatedNotification } = await import('@/lib/deals/deal-lifecycle-notifications');
      await dispatchProposalCreatedNotification(created);
    } catch (notifErr: any) {
      console.warn('[POST /api/deals/proposals] Notification dispatch warning:', notifErr?.message || notifErr);
    }

    // 8. Return 201 Created with sanitized decimal-string proposal
    return NextResponse.json(
      {
        proposal: serializeDealProposal(created),
        idempotent: false,
        receiptDelivered,
        ...(receiptWarning ? { receiptWarning } : {}),
      },
      { status: 201 },
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

    console.error('[POST /api/deals/proposals] Unhandled internal error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
