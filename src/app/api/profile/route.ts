import { NextRequest } from 'next/server';
import { getAll, create, update } from '@/lib/db';
import { getUserFromRequest } from '@/lib/auth';

/** Wallet-keyed private profile access for the authenticated wallet owner. */

const isWallet = (w: unknown): w is string => typeof w === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w);

// Same starting fields wallet sign-in gives a fresh user (auth/route.ts), so a
// profile created here looks identical to one created by signing in.
const newUserFields = () => ({
  trustScore: 85,
  totalProtected: 0,
  activeEscrow: 0,
  pendingPayments: 0,
  createdAt: new Date().toISOString(),
});

async function findByWallet(wallet: string) {
  const users = await getAll('users');
  const lower = wallet.toLowerCase();
  return users.find((u: any) => u.walletAddress && String(u.walletAddress).toLowerCase() === lower) || null;
}

export async function GET(req: NextRequest) {
  const wallet = new URL(req.url).searchParams.get('wallet');
  if (!isWallet(wallet)) {
    return Response.json({ error: 'Valid wallet address required' }, { status: 400 });
  }
  const authUser = getUserFromRequest(req);
  if (!authUser?.walletAddress) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }
  if (!isWallet(authUser.walletAddress) || authUser.walletAddress.toLowerCase() !== wallet.toLowerCase()) {
    return Response.json({ error: 'Not authorized' }, { status: 403 });
  }

  try {
    const user = await findByWallet(wallet);
    return Response.json({
      name: user?.name || null,
      avatar: user?.avatar || null,
      email: user?.email || null,
    });
  } catch {
    return Response.json({ error: 'Failed to load profile' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const authUser = getUserFromRequest(req);
    if (!authUser) {
      return Response.json({ error: 'Authentication required to update profile' }, { status: 401 });
    }

    const body = await req.json();
    const { walletAddress, name, avatar } = body;
    if (!isWallet(walletAddress)) {
      return Response.json({ error: 'Valid wallet address required' }, { status: 400 });
    }

    if (!authUser.walletAddress || authUser.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      return Response.json({ error: 'Unauthorized: Bearer token wallet does not match request wallet' }, { status: 403 });
    }

    if (typeof name === 'string' && name.length > 60) {
      return Response.json({ error: 'Name is too long (max 60 characters)' }, { status: 400 });
    }
    // A 256px JPEG data URL is well under this; the cap just stops someone
    // wedging a multi-MB image into the record.
    if (typeof avatar === 'string' && avatar.length > 400_000) {
      return Response.json({ error: 'Image is too large — pick a smaller photo' }, { status: 413 });
    }

    const patch: Record<string, unknown> = {};
    if (typeof name === 'string') patch.name = name.trim();
    if (typeof avatar === 'string') patch.avatar = avatar;

    const existing = await findByWallet(walletAddress);
    const user = existing
      ? await update('users', existing.id, patch)
      : await create('users', { walletAddress, ...newUserFields(), ...patch });

    return Response.json({
      ok: true,
      profile: { name: user?.name || null, avatar: user?.avatar || null, email: user?.email || null },
    });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Failed to save profile' }, { status: 500 });
  }
}
