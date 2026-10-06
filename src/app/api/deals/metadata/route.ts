import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedWallet, unauthorized } from '@/lib/auth';
import { isAddress } from 'viem';
import { getDealProposalsByDealAddresses } from '@/lib/deals/proposals-db';

export async function POST(req: NextRequest) {
  try {
    const authWallet = getAuthenticatedWallet(req);
    if (!authWallet) {
      return unauthorized();
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
    }

    const { dealAddresses } = body || {};
    if (!Array.isArray(dealAddresses)) {
      return NextResponse.json({ error: 'dealAddresses must be an array' }, { status: 400 });
    }

    if (dealAddresses.length === 0) {
      return NextResponse.json({ metadata: {} }, { status: 200 });
    }

    if (dealAddresses.length > 100) {
      return NextResponse.json({ error: 'Too many deal addresses requested (max 100)' }, { status: 400 });
    }

    const validAddresses: string[] = [];
    for (const addr of dealAddresses) {
      if (typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr.trim())) {
        validAddresses.push(addr.trim());
      }
    }

    if (validAddresses.length === 0) {
      return NextResponse.json({ metadata: {} }, { status: 200 });
    }

    const rows = await getDealProposalsByDealAddresses(validAddresses, authWallet);
    const metadata: Record<string, { title: string; proposalId: string; createdAt: string; protectionSelection: string }> = {};

    for (const r of rows) {
      if (r.dealAddress) {
        metadata[r.dealAddress.toLowerCase()] = {
          title: r.title,
          proposalId: r.proposalId,
          createdAt: r.createdAt.toISOString(),
          protectionSelection: r.protectionSelection,
        };
      }
    }

    return NextResponse.json({ metadata }, { status: 200 });
  } catch (err: unknown) {
    console.error('[POST /api/deals/metadata] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
