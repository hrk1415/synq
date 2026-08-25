import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

const DEV_SECRET = 'nexotiq-dev-secret-key-change-in-production';

/**
 * Resolved per call, not at import time: in production a missing JWT_SECRET
 * must be a hard failure, not a fall-back to a secret that is published in this
 * repo. Anyone reading the source could otherwise mint valid tokens.
 */
function getSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (secret && secret !== DEV_SECRET && secret !== 'change-me-in-production') return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'JWT_SECRET is not set (or is still the example value). Refusing to issue tokens signed with a publicly-known secret. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
    );
  }
  warnDevSecretOnce();
  return DEV_SECRET;
}

let warnedDevSecret = false;
function warnDevSecretOnce() {
  if (warnedDevSecret) return;
  warnedDevSecret = true;
  console.warn('[auth] JWT_SECRET is unset — using the built-in development secret. Tokens are forgeable. Set JWT_SECRET in .env.local before deploying.');
}

export function signToken(payload: { userId: string; walletAddress?: string; email?: string }): string {
  return jwt.sign(payload, getSecret(), { expiresIn: '7d' });
}

export function verifyToken(token: string): { userId: string; walletAddress?: string; email?: string } | null {
  try {
    return jwt.verify(token, getSecret()) as any;
  } catch {
    return null;
  }
}

export function getUserFromRequest(req: NextRequest): { userId: string; walletAddress?: string; email?: string } | null {
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  return verifyToken(token);
}

export function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}
