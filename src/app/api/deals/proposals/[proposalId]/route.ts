import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { getDealProposalById, serializeDealProposal } from '@/lib/deals/proposals-db';

interface RouteContext {
  params: Promise<{ proposalId: string }> | { proposalId: string };
}

export async function GET(req: NextRequest, context: RouteContext) {
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

    // 3. Query proposal record
    const proposal = await getDealProposalById(proposalId);
    if (!proposal) {
      return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
    }

    // 4. Authorization check: caller must be client or freelancer
    const caller = authWallet.toLowerCase();
    const client = proposal.clientWallet.toLowerCase();
    const freelancer = proposal.freelancerWallet.toLowerCase();

    if (caller !== client && caller !== freelancer) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // 5. Return sanitized serialized proposal
    return NextResponse.json({ proposal: serializeDealProposal(proposal) }, { status: 200 });
  } catch (err: unknown) {
    console.error('[GET /api/deals/proposals/[proposalId]] Unhandled error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
