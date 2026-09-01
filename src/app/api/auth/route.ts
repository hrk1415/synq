import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { verifyMessage } from 'viem';
import { signToken, verifyToken } from '@/lib/auth';
import { getAll, create, update, remove, query } from '@/lib/db';
import { sendEmailVerificationCode, getMailStatus } from '@/lib/notify';

const SIG_MAX_AGE_MS = 5 * 60 * 1000;
const CODE_TTL_MIN = 10;
const CODE_MAX_ATTEMPTS = 5;

/** Signatures already redeemed, so a captured one can't be replayed. */
const usedSignatures = new Set<string>();

const newUserFields = () => ({
  trustScore: 85,
  totalProtected: 0,
  activeEscrow: 0,
  pendingPayments: 0,
  createdAt: new Date().toISOString(),
});

/**
 * The message the wallet must sign. Contains the address (so a signature for
 * one wallet can't be presented as another) and an ISO timestamp (so an old
 * signature stops working after SIG_MAX_AGE_MS).
 */
function buildSignInMessage(address: string, issuedAt: string) {
  return [
    'Synq sign-in',
    '',
    `Address: ${address}`,
    `Issued At: ${issuedAt}`,
    '',
    'Signing this message proves you control this wallet. It costs no gas and authorises no transaction.',
  ].join('\n');
}

/** GET the exact message to sign, then POST it back with the signature. */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const wallet = url.searchParams.get('address');
  if (wallet) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return Response.json({ error: 'Invalid wallet address' }, { status: 400 });
    }
    if (url.searchParams.get('mode') === 'email_status') {
      const users = await getAll('users');
      const user = users.find((u: any) => u.walletAddress?.toLowerCase() === wallet.toLowerCase());
      const email = user?.email ? String(user.email) : null;
      return Response.json({
        bound: !!email,
        email: email ? email.replace(/^(.{2}).*(@.+)$/, '$1***$2') : null,
      });
    }
    const issuedAt = new Date().toISOString();
    return Response.json({ message: buildSignInMessage(wallet, issuedAt), issuedAt, expiresInSeconds: SIG_MAX_AGE_MS / 1000 });
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const payload = verifyToken(authHeader.slice(7));
  if (!payload) {
    return Response.json({ error: 'Invalid token' }, { status: 401 });
  }
  const users = await getAll('users');
  const user = users.find((u: any) => u.id === payload.userId);
  if (!user) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }
  return Response.json({ user });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { type, walletAddress, email, name, signature, issuedAt, code } = body;

    // ---------------------------------------------------------------- wallet
    if (type === 'wallet') {
      if (!walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
        return Response.json({ error: 'Valid wallet address required' }, { status: 400 });
      }
      // A wallet address is public information. Without a signature anyone could
      // mint a token for any address, so proof of control is mandatory.
      if (!signature || !issuedAt) {
        return Response.json(
          { error: 'Signature required. GET /api/auth?address=0x... to obtain the message to sign, then POST { type: "wallet", walletAddress, issuedAt, signature }.' },
          { status: 400 },
        );
      }
      const issuedMs = Date.parse(String(issuedAt));
      if (Number.isNaN(issuedMs)) {
        return Response.json({ error: 'Invalid issuedAt' }, { status: 400 });
      }
      const age = Date.now() - issuedMs;
      if (age > SIG_MAX_AGE_MS || age < -60_000) {
        return Response.json({ error: 'Signature expired. Request a fresh message and sign again.' }, { status: 401 });
      }
      const sigKey = `${String(walletAddress).toLowerCase()}:${signature}`;
      if (usedSignatures.has(sigKey)) {
        return Response.json({ error: 'Signature already used. Request a fresh message.' }, { status: 401 });
      }

      let valid = false;
      try {
        valid = await verifyMessage({
          address: walletAddress as `0x${string}`,
          message: buildSignInMessage(walletAddress, String(issuedAt)),
          signature: signature as `0x${string}`,
        });
      } catch {
        valid = false;
      }
      if (!valid) {
        return Response.json({ error: 'Signature does not match this wallet address' }, { status: 401 });
      }
      usedSignatures.add(sigKey);

      const users = await getAll('users');
      let user = users.find((u: any) => u.walletAddress?.toLowerCase() === walletAddress.toLowerCase());
      if (!user) {
        user = await create('users', {
          name: name || `User ${walletAddress.slice(0, 6)}`,
          walletAddress,
          ...newUserFields(),
        });
      }
      const token = signToken({ userId: user.id, walletAddress: user.walletAddress });
      return Response.json({ token, user });
    }

    // ----------------------------------------------------------------- email
    // Step 1: request a code. No token is issued here — proving you can read
    // the inbox is the whole point of email sign-in.
    if (type === 'email') {
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
        return Response.json({ error: 'Valid email required' }, { status: 400 });
      }
      const normalized = String(email).toLowerCase().trim();
      const plainCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString();

      // Invalidate any outstanding codes for this address.
      for (const v of await query('verifications', (v: any) => String(v.email).toLowerCase() === normalized)) {
        await remove('verifications', v.id);
      }
      await create('verifications', {
        email: normalized,
        name: name || undefined,
        // Hashed, so reading data/db.json does not hand over a live sign-in code.
        codeHash: crypto.createHash('sha256').update(plainCode).digest('hex'),
        attempts: 0,
        expiresAt,
        createdAt: new Date().toISOString(),
      });

      const mail = await sendEmailVerificationCode(normalized, plainCode, CODE_TTL_MIN);
      const status = getMailStatus();
      return Response.json({
        requiresVerification: true,
        email: normalized,
        expiresAt,
        delivery: mail.mode,
        message: status.live
          ? `A 6-digit code was sent to ${normalized}. POST { type: "email_verify", email, code } to sign in.`
          : `SMTP is not configured, so the code was written to ${status.logFile} instead of being emailed. POST { type: "email_verify", email, code } to sign in.`,
        ...(mail.error ? { deliveryError: mail.error } : {}),
      });
    }

    // Step 2: redeem the code.
    if (type === 'email_verify') {
      if (!email || !code) {
        return Response.json({ error: 'email and code are required' }, { status: 400 });
      }
      const normalized = String(email).toLowerCase().trim();
      const record = (await query('verifications', (v: any) => String(v.email).toLowerCase() === normalized))
        .sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];

      if (!record) {
        return Response.json({ error: 'No sign-in code was requested for this address' }, { status: 401 });
      }
      if (Date.parse(record.expiresAt) < Date.now()) {
        await remove('verifications', record.id);
        return Response.json({ error: 'Code expired. Request a new one.' }, { status: 401 });
      }
      if (Number(record.attempts || 0) >= CODE_MAX_ATTEMPTS) {
        await remove('verifications', record.id);
        return Response.json({ error: 'Too many incorrect attempts. Request a new code.' }, { status: 429 });
      }

      const given = crypto.createHash('sha256').update(String(code).trim()).digest('hex');
      const expected = String(record.codeHash || '');
      const match = expected.length === given.length
        && crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
      if (!match) {
        await update('verifications', record.id, { attempts: Number(record.attempts || 0) + 1 });
        return Response.json({ error: 'Incorrect code' }, { status: 401 });
      }

      await remove('verifications', record.id);
      const users = await getAll('users');
      let user = users.find((u: any) => String(u.email).toLowerCase() === normalized);
      if (!user) {
        user = await create('users', {
          name: record.name || normalized.split('@')[0],
          email: normalized,
          ...newUserFields(),
        });
      }
      const token = signToken({ userId: user.id, email: user.email });
      return Response.json({ token, user });
    }

    // ------------------------------------------------- bind email to a wallet
    // Wallet sign-in creates the account, but notifications need an inbox.
    // Step 1: request a code for the email being bound.
    if (type === 'bind_email') {
      if (!walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(String(walletAddress))) {
        return Response.json({ error: 'Valid wallet address required' }, { status: 400 });
      }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
        return Response.json({ error: 'Valid email required' }, { status: 400 });
      }
      const normalized = String(email).toLowerCase().trim();
      const users = await getAll('users');
      const clash = users.find(
        (u: any) => String(u.email || '').toLowerCase() === normalized
          && u.walletAddress?.toLowerCase() !== String(walletAddress).toLowerCase()
      );
      if (clash) {
        return Response.json({ error: 'This email is already linked to another wallet' }, { status: 409 });
      }
      const plainCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString();
      for (const v of await query('verifications', (v: any) => String(v.email).toLowerCase() === normalized)) {
        await remove('verifications', v.id);
      }
      await create('verifications', {
        email: normalized,
        walletAddress: String(walletAddress).toLowerCase(),
        codeHash: crypto.createHash('sha256').update(plainCode).digest('hex'),
        attempts: 0,
        expiresAt,
        createdAt: new Date().toISOString(),
      });
      const mail = await sendEmailVerificationCode(normalized, plainCode, CODE_TTL_MIN);
      return Response.json({
        codeSent: true,
        email: normalized,
        delivery: mail.mode,
        message: mail.mode === 'log'
          ? 'SMTP is not configured, so the code was written to data/emails.log instead of being emailed.'
          : `A 6-digit code was sent to ${normalized}.`,
        ...(mail.error ? { deliveryError: mail.error } : {}),
      });
    }

    // Step 2: redeem the code and store the email on the wallet's account.
    if (type === 'bind_email_verify') {
      if (!walletAddress || !email || !code) {
        return Response.json({ error: 'walletAddress, email and code are required' }, { status: 400 });
      }
      const normalized = String(email).toLowerCase().trim();
      const walletLower = String(walletAddress).toLowerCase();
      const record = (await query('verifications', (v: any) => String(v.email).toLowerCase() === normalized))
        .filter((v: any) => !v.walletAddress || String(v.walletAddress).toLowerCase() === walletLower)
        .sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      if (!record) {
        return Response.json({ error: 'No binding code was requested for this address' }, { status: 401 });
      }
      if (Date.parse(record.expiresAt) < Date.now()) {
        await remove('verifications', record.id);
        return Response.json({ error: 'Code expired. Request a new one.' }, { status: 401 });
      }
      if (Number(record.attempts || 0) >= CODE_MAX_ATTEMPTS) {
        await remove('verifications', record.id);
        return Response.json({ error: 'Too many incorrect attempts. Request a new code.' }, { status: 429 });
      }
      const given = crypto.createHash('sha256').update(String(code).trim()).digest('hex');
      const expected = String(record.codeHash || '');
      const match = expected.length === given.length
        && crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
      if (!match) {
        await update('verifications', record.id, { attempts: Number(record.attempts || 0) + 1 });
        return Response.json({ error: 'Incorrect code' }, { status: 401 });
      }
      await remove('verifications', record.id);
      const users = await getAll('users');
      let user = users.find((u: any) => u.walletAddress?.toLowerCase() === walletLower);
      if (!user) {
        user = await create('users', {
          name: `User ${String(walletAddress).slice(0, 6)}`,
          walletAddress: String(walletAddress),
          email: normalized,
          ...newUserFields(),
        });
      } else {
        user = await update('users', user.id, { email: normalized });
      }
      return Response.json({ ok: true, bound: true, email: normalized, user });
    }

    return Response.json({ error: 'Invalid auth type. Use wallet, email, email_verify, bind_email or bind_email_verify.' }, { status: 400 });
  } catch (e: any) {
    return Response.json({ error: e.message || 'Auth failed' }, { status: 500 });
  }
}
