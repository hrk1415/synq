import { NextRequest } from 'next/server';
import { getAll, create, update } from '@/lib/db';

/**
 * Wallet-keyed profile (display name + base64 avatar), stored on the `users`
 * record. Unauthenticated by design — identity in this app is the connected
 * wallet and there is no client session, so the wallet is passed in the
 * query/body, exactly like /api/notify. See the plan's "Notes / limitations"
 * for the follow-up signature-gating.
 */

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
  const user = await findByWallet(wallet);
  return Response.json({
    name: user?.name || null,
    avatar: user?.avatar || null,
    email: user?.email || null,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { walletAddress, name, avatar } = body;
    if (!isWallet(walletAddress)) {
      return Response.json({ error: 'Valid wallet address required' }, { status: 400 });
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
