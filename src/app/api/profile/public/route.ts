import { NextRequest } from 'next/server';
import { getAll } from '@/lib/db';

const isWallet = (w: unknown): w is string => typeof w === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w);
const MAX_BATCH_SIZE = 100;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { wallets } = body || {};

    if (!Array.isArray(wallets)) {
      return Response.json({ error: 'wallets must be an array of addresses' }, { status: 400 });
    }

    const validWallets = wallets.filter(isWallet);
    if (validWallets.length === 0) {
      return Response.json({ profiles: [] });
    }

    if (validWallets.length > MAX_BATCH_SIZE) {
      return Response.json({ error: `Maximum batch size exceeded (max ${MAX_BATCH_SIZE})` }, { status: 400 });
    }

    // Deduplicate case-insensitively
    const uniqueWalletsSet = new Set(validWallets.map((w) => w.toLowerCase()));
    const users = await getAll('users');
    const marketProfiles = await getAll('marketProfiles');

    const profiles = Array.from(uniqueWalletsSet).map((walletLower) => {
      const matchedUser = users.find((u: any) => u.walletAddress && String(u.walletAddress).toLowerCase() === walletLower);
      const matchedMarket = marketProfiles.find((m: any) => m.walletAddress && String(m.walletAddress).toLowerCase() === walletLower);

      return {
        wallet: walletLower,
        avatar: (matchedUser?.avatar as string) || null,
        name: (matchedUser?.name as string) || null,
        headline: (matchedMarket?.headline as string) || '',
        secondaryCategories: Array.isArray(matchedMarket?.secondaryCategories) ? matchedMarket.secondaryCategories : [],
      };
    });

    return Response.json({ profiles });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Failed to fetch public profiles' }, { status: 500 });
  }
}
