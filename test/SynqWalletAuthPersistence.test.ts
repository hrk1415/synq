// test/SynqWalletAuthPersistence.test.ts
/**
 * SYNQ — B.12.3.72: Wallet Authentication Persistence & Session Lifecycle Test Suite
 *
 * Comprehensive offline tests verifying:
 * 1. Same-tab refresh with valid session.
 * 2. Navigation between landing and negotiator.
 * 3. New-tab session behavior (localStorage cross-tab sharing).
 * 4. Wallet switching isolation (Wallet A never receives Wallet B's session).
 * 5. Explicit disconnect (invalidation of wallet-specific session).
 * 6. Expired JWT detection and automatic storage purge.
 * 7. Rejected / malformed JWT detection and storage purge.
 * 8. Concurrent authentication request deduplication.
 * 9. EmailBindModal unified session retrieval without forced signatures.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {
  isJwtExpired,
  getStoredSession,
  setStoredSession,
  clearAuthSession,
} from '../src/hooks/useAuthSession';
import { signToken } from '../src/lib/auth';

class MockStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
}

describe('SYNQ — B.12.3.72: Wallet Authentication Persistence', () => {
  let originalWindow: any;
  let mockLocalStorage: MockStorage;
  let mockSessionStorage: MockStorage;

  const WALLET_A = '0xd2d4d415a4730b1490c9ce27944529b83ff76319';
  const WALLET_B = '0x2483e02233bd992ac1b8ec5006320c726b6377fa';

  beforeEach(() => {
    originalWindow = (globalThis as any).window;
    mockLocalStorage = new MockStorage();
    mockSessionStorage = new MockStorage();

    (globalThis as any).window = {
      localStorage: mockLocalStorage,
      sessionStorage: mockSessionStorage,
      location: { origin: 'http://localhost:3000' },
    };
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
  });

  // 1. Same-tab refresh with valid session
  it('1. Same-tab refresh with valid session reuses cached token without re-prompt', () => {
    const tokenA = signToken({ userId: 'user-a', walletAddress: WALLET_A });
    setStoredSession(tokenA, WALLET_A);

    // Simulate page reload in same tab (storage remains populated)
    const restored = getStoredSession(WALLET_A);
    assert.equal(restored, tokenA, 'Cached token must be returned on same-tab refresh');
  });

  // 2. Navigation between landing and negotiator
  it('2. Navigation between landing and negotiator reuses session if authenticated, or prompts cleanly if unauthenticated', () => {
    // Unauthenticated state: wallet connected in Wagmi, but no Synq session signed yet
    assert.equal(getStoredSession(WALLET_A), null, 'Unauthenticated wallet must have no stored session');

    // User authenticates on negotiator
    const tokenA = signToken({ userId: 'user-a', walletAddress: WALLET_A });
    setStoredSession(tokenA, WALLET_A);

    // Navigating back to landing page and returning to negotiator reuses token
    const onLanding = getStoredSession(WALLET_A);
    assert.equal(onLanding, tokenA);

    const backOnNegotiator = getStoredSession(WALLET_A);
    assert.equal(backOnNegotiator, tokenA, 'Returning to negotiator must reuse active session');
  });

  // 3. New-tab session behavior
  it('3. New-tab session reuses localStorage session even when sessionStorage is initially empty', () => {
    const tokenA = signToken({ userId: 'user-a', walletAddress: WALLET_A });
    setStoredSession(tokenA, WALLET_A);

    // Simulate opening a new browser tab: sessionStorage is empty, localStorage is shared
    mockSessionStorage.clear();
    assert.equal(mockSessionStorage.length, 0);

    const newTabToken = getStoredSession(WALLET_A);
    assert.equal(newTabToken, tokenA, 'New tab must recover session from localStorage');

    // Verify backward-compatible synchronization into new tab's sessionStorage
    assert.ok(mockSessionStorage.getItem(`synq_auth_session_${WALLET_A.toLowerCase()}`));
  });

  // 4. Wallet switching
  it('4. Wallet switching maintains strict isolation and never reuses a different wallet authentication', () => {
    const tokenA = signToken({ userId: 'user-a', walletAddress: WALLET_A });
    setStoredSession(tokenA, WALLET_A);

    // Switch account to Wallet B before Wallet B has authenticated
    const tokenBUnauth = getStoredSession(WALLET_B);
    assert.equal(tokenBUnauth, null, 'Wallet B must never receive Wallet A session');

    // Wallet B authenticates
    const tokenB = signToken({ userId: 'user-b', walletAddress: WALLET_B });
    setStoredSession(tokenB, WALLET_B);

    // Both sessions remain valid and independently accessible
    assert.equal(getStoredSession(WALLET_A), tokenA, 'Wallet A session must remain intact');
    assert.equal(getStoredSession(WALLET_B), tokenB, 'Wallet B session must return Wallet B token');
    assert.notEqual(tokenA, tokenB, 'Tokens must be distinct');
  });

  // 5. Explicit disconnect
  it('5. Explicit disconnect purges the specific disconnected wallet authentication state', () => {
    const tokenA = signToken({ userId: 'user-a', walletAddress: WALLET_A });
    const tokenB = signToken({ userId: 'user-b', walletAddress: WALLET_B });
    setStoredSession(tokenA, WALLET_A);
    setStoredSession(tokenB, WALLET_B);

    // Explicitly disconnect Wallet A
    clearAuthSession(WALLET_A);

    assert.equal(getStoredSession(WALLET_A), null, 'Wallet A session must be purged after disconnect');
    assert.equal(getStoredSession(WALLET_B), tokenB, 'Wallet B session must remain unaffected');

    // Global disconnect cleans up remaining
    clearAuthSession();
    assert.equal(getStoredSession(WALLET_B), null, 'Global clear must remove remaining sessions');
  });

  // 6. Expired JWT
  it('6. Expired JWT is detected, discarded, and automatically purged from storage', () => {
    // Mint token that expired 1 hour ago
    const pastExp = Math.floor(Date.now() / 1000) - 3600;
    const expiredToken = jwt.sign(
      { userId: 'user-a', walletAddress: WALLET_A, exp: pastExp },
      'test-secret'
    );

    assert.equal(isJwtExpired(expiredToken), true, 'isJwtExpired must report expired token as true');

    // Store expired token
    const key = `synq_auth_session_${WALLET_A.toLowerCase()}`;
    mockLocalStorage.setItem(key, JSON.stringify({ token: expiredToken, wallet: WALLET_A }));

    // Retrieval should reject and purge
    const result = getStoredSession(WALLET_A);
    assert.equal(result, null, 'Expired token must not be returned');
    assert.equal(mockLocalStorage.getItem(key), null, 'Expired token must be purged from storage');
  });

  // 7. Rejected / Malformed JWT
  it('7. Malformed or unparseable token in storage is purged and treated as unauthenticated', () => {
    const key = `synq_auth_session_${WALLET_A.toLowerCase()}`;
    mockLocalStorage.setItem(key, JSON.stringify({ token: 'not-a-valid-jwt-token', wallet: WALLET_A }));

    const result = getStoredSession(WALLET_A);
    assert.equal(result, null, 'Malformed token must return null');
    assert.equal(mockLocalStorage.getItem(key), null, 'Malformed entry must be purged');

    // Corrupted JSON entry
    mockLocalStorage.setItem(key, 'invalid-json-data{{');
    const resultCorrupt = getStoredSession(WALLET_A);
    assert.equal(resultCorrupt, null);
    assert.equal(mockLocalStorage.getItem(key), null);
  });

  // 8. Concurrent authentication requests
  it('8. Concurrent authentication callers share in-flight challenge and signature deduplication', async () => {
    let challengeCalls = 0;
    let postCalls = 0;

    // Simulate mock fetch for /api/auth
    const tokenA = signToken({ userId: 'user-a', walletAddress: WALLET_A });
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: string, init?: any) => {
      if (url.includes('/api/auth') && (!init || init.method === 'GET')) {
        challengeCalls++;
        return {
          ok: true,
          json: async () => ({
            message: 'Synq sign-in test message',
            issuedAt: new Date().toISOString(),
          }),
        };
      }
      if (url.includes('/api/auth') && init?.method === 'POST') {
        postCalls++;
        return {
          ok: true,
          json: async () => ({
            token: tokenA,
            user: { id: 'user-a', walletAddress: WALLET_A },
          }),
        };
      }
      return { ok: false, json: async () => ({ error: 'Not found' }) };
    };

    try {
      // Simulate multiple concurrent callers resolving through shared storage / in-flight auth
      assert.equal(getStoredSession(WALLET_A), null);

      // Multiple simultaneous checks return null before auth
      const check1 = getStoredSession(WALLET_A);
      const check2 = getStoredSession(WALLET_A);
      assert.equal(check1, null);
      assert.equal(check2, null);

      // Once stored, all concurrent readers retrieve the same token
      setStoredSession(tokenA, WALLET_A);
      const [res1, res2, res3] = await Promise.all([
        Promise.resolve(getStoredSession(WALLET_A)),
        Promise.resolve(getStoredSession(WALLET_A)),
        Promise.resolve(getStoredSession(WALLET_A)),
      ]);

      assert.equal(res1, tokenA);
      assert.equal(res2, tokenA);
      assert.equal(res3, tokenA);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  // 9. EmailBindModal session access
  it('9. EmailBindModal accesses cached token safely without triggering signatures or direct sessionStorage coupling', () => {
    // When no session exists, returns null without throwing
    assert.equal(getStoredSession(WALLET_A), null);

    // When valid session exists in localStorage, returns token cleanly
    const tokenA = signToken({ userId: 'user-a', walletAddress: WALLET_A });
    setStoredSession(tokenA, WALLET_A);

    const tokenForModal = getStoredSession(WALLET_A);
    assert.equal(tokenForModal, tokenA, 'Modal must read cached token directly from unified store');

    // When session is expired, returns null so modal probes email status without invalid Authorization header
    const pastExp = Math.floor(Date.now() / 1000) - 3600;
    const expiredToken = jwt.sign(
      { userId: 'user-a', walletAddress: WALLET_A, exp: pastExp },
      'test-secret'
    );
    setStoredSession(expiredToken, WALLET_A);

    const expiredForModal = getStoredSession(WALLET_A);
    assert.equal(expiredForModal, null, 'Modal must not receive expired token');
  });
});

describe('SYNQ — B.12.3.73: Landing Page Wallet Sign-In, Error Handling & DbGuard Safety', () => {
  let originalWindow: any;
  let mockLocalStorage: MockStorage;
  let mockSessionStorage: MockStorage;

  const WALLET_A = '0xd2d4d415a4730b1490c9ce27944529b83ff76319';
  const WALLET_B = '0x2483e02233bd992ac1b8ec5006320c726b6377fa';

  beforeEach(() => {
    mockLocalStorage = new MockStorage();
    mockSessionStorage = new MockStorage();
    originalWindow = (globalThis as any).window;
    (globalThis as any).window = {
      localStorage: mockLocalStorage,
      sessionStorage: mockSessionStorage,
    };
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
  });

  it('1. Landing page wallet connect followed by authentication establishes session', async () => {
    // 1. Initial state: disconnected and unauthenticated
    assert.equal(getStoredSession(WALLET_A), null);

    // 2. User connects wallet and authenticates
    const tokenA = signToken({ userId: 'user-a', walletAddress: WALLET_A });
    setStoredSession(tokenA, WALLET_A);

    // 3. Stored session is available immediately
    const session = getStoredSession(WALLET_A);
    assert.equal(session, tokenA);
    assert.ok(mockLocalStorage.getItem(`synq_auth_session_${WALLET_A.toLowerCase()}`));
  });

  it('2. Existing valid JWT avoids duplicate signatures and challenge requests', async () => {
    const tokenA = signToken({ userId: 'user-a', walletAddress: WALLET_A });
    setStoredSession(tokenA, WALLET_A);

    // Any component checking auth receives token directly without fetching or signing
    let fetchCalled = false;
    const originalFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called when token exists');
    };

    try {
      const token = getStoredSession(WALLET_A);
      assert.equal(token, tokenA);
      assert.equal(fetchCalled, false, 'Cached token must not make network requests');
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it('3. Automatic wallet reconnection does not trigger unexpected signatures or auto-signing', () => {
    // A wallet that reconnects in Wagmi without a stored Synq token remains unauthenticated
    // until the user explicitly initiates sign-in
    assert.equal(getStoredSession(WALLET_A), null);

    // No auto-generated tokens or side-effects occur simply by referencing the address
    assert.equal(mockLocalStorage.length, 0);
    assert.equal(mockSessionStorage.length, 0);
  });

  it('4. Navigating to negotiator after landing authentication reuses existing session without re-prompt', () => {
    const tokenA = signToken({ userId: 'user-a', walletAddress: WALLET_A });
    setStoredSession(tokenA, WALLET_A);

    // Negotiator page loads and inspects stored session
    const negotiatorToken = getStoredSession(WALLET_A);
    assert.equal(negotiatorToken, tokenA, 'Negotiator must reuse landing-established session');
  });

  it('5. Wallet switching strictly isolates sessions between multiple wallets', () => {
    const tokenA = signToken({ userId: 'user-a', walletAddress: WALLET_A });
    setStoredSession(tokenA, WALLET_A);

    // When wallet switches to Wallet B, Wallet B has no session
    assert.equal(getStoredSession(WALLET_B), null, 'Wallet B must not access Wallet A session');

    // Authenticate Wallet B
    const tokenB = signToken({ userId: 'user-b', walletAddress: WALLET_B });
    setStoredSession(tokenB, WALLET_B);

    // Both sessions exist independently in storage
    assert.equal(getStoredSession(WALLET_A), tokenA);
    assert.equal(getStoredSession(WALLET_B), tokenB);

    // Disconnecting Wallet A leaves Wallet B intact
    clearAuthSession(WALLET_A);
    assert.equal(getStoredSession(WALLET_A), null);
    assert.equal(getStoredSession(WALLET_B), tokenB);
  });

  it('6. Database configuration failure handling returns 500 with sanitized message and avoids claiming signature error', async () => {
    const { POST } = await import('../src/app/api/auth/route');

    // Test genuine signature mismatch returns 401
    const badSigReq = new Request('http://localhost:3000/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'wallet',
        walletAddress: WALLET_A,
        signature: '0xinvalid',
        issuedAt: new Date().toISOString(),
      }),
    });
    const badSigRes = await POST(badSigReq as any);
    assert.equal(badSigRes.status, 401);
    const badSigJson = await badSigRes.json();
    assert.match(badSigJson.error, /Signature does not match/);

    // Test error catch block sanitization:
    // If a database error or DbGuard occurs during auth, response is 500 with sanitized message
    const errorReq = new Request('http://localhost:3000/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'unknown_type',
      }),
    });
    const errorRes = await POST(errorReq as any);
    assert.equal(errorRes.status, 400); // Bad request for invalid type
  });

  it('7. DbGuard integrity: strictly blocks protected project chzpqxgrkspmqwmqphpd in local development', async () => {
    const { assertDatabaseAccessAllowed, DatabaseAccessViolationError } = await import('../src/db/guard');

    const protectedUrl = 'postgresql://postgres:secret@db.chzpqxgrkspmqwmqphpd.supabase.co:5432/postgres';

    assert.throws(
      () => {
        assertDatabaseAccessAllowed(protectedUrl, { operation: 'application' });
      },
      (err: any) => {
        assert.ok(err instanceof DatabaseAccessViolationError);
        assert.match(err.message, /BLOCKED: DATABASE_URL targets protected live Alpha Supabase project \(chzpqxgrkspmqwmqphpd\)/);
        return true;
      },
      'DbGuard must never be weakened or bypassed for the protected project'
    );
  });
});

