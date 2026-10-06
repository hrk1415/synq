import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet } from '@/lib/auth';
import { isAddress, getAddress } from 'viem';
import { normalizeWallet } from '@/lib/utils';
import { getDealProposalByDealAddress } from '@/lib/deals/proposals-db';

interface RouteContext {
  params: Promise<{ dealAddress: string }> | { dealAddress: string };
}

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    // 1. Authenticate caller using session bearer token
    const authWallet = getAuthenticatedWallet(req);
    if (!authWallet) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Extract and validate dealAddress
    const resolvedParams = await Promise.resolve(context.params);
    const rawDealAddress = resolvedParams?.dealAddress;
    if (!rawDealAddress || !isAddress(rawDealAddress.trim())) {
      return NextResponse.json({ error: 'Invalid deal address format' }, { status: 400 });
    }

    const cleanDealAddress = getAddress(rawDealAddress.trim());
    const normalizedAddress = normalizeWallet(cleanDealAddress);

    // 3. Query proposal record linked to this deal address
    const proposal = await getDealProposalByDealAddress(normalizedAddress);

    if (!proposal) {
      // Legacy deal or direct clone without a proposal record safely defaults to STANDARD
      return NextResponse.json(
        {
          dealAddress: cleanDealAddress,
          proposalId: null,
          protectionSelection: 'STANDARD',
        },
        { status: 200 }
      );
    }

    // 4. Authorization: caller must be client or freelancer associated with the proposal
    const caller = normalizeWallet(authWallet);
    const client = normalizeWallet(proposal.clientWallet);
    const freelancer = normalizeWallet(proposal.freelancerWallet);

    if (caller !== client && caller !== freelancer) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const protectionSelection =
      (proposal.protectionSelection as 'STANDARD' | 'PREMIUM') || 'STANDARD';

    return NextResponse.json(
      {
        dealAddress: cleanDealAddress,
        proposalId: proposal.proposalId,
        protectionSelection,
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    console.error('[GET /api/deals/[dealAddress]/protection] Unhandled error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
