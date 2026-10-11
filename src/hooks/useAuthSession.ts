'use client';

import { useCallback } from 'react';
import { useAccount, useSignMessage } from 'wagmi';

const SESSION_KEY = 'synq_auth_session';
const SESSION_KEY_PREFIX = 'synq_auth_session_';

interface StoredSession {
  token: string;
  wallet: string;
}

/**
 * Validates whether a JWT token is expired based on its client-decodable payload.
 * Applies a 30-second clock skew buffer.
 */
export function isJwtExpired(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('utf-8');
    const payload = JSON.parse(jsonStr);
    if (typeof payload.exp !== 'number') return true;
    return payload.exp * 1000 <= Date.now() + 30_000;
  } catch {
    return true;
  }
}

/**
 * Retrieves the cached authenticated session token for the specified wallet address.
 * Prioritizes wallet-scoped localStorage, with backward-compatible fallback/migration
 * from sessionStorage. Discards expired or wallet-mismatched tokens automatically.
 */
export function getStoredSession(currentAddress?: string): string | null {
  if (typeof window === 'undefined' || !currentAddress) return null;
  const normalized = currentAddress.toLowerCase();
  const walletKey = `${SESSION_KEY_PREFIX}${normalized}`;

  const checkStorage = (storage: Storage, key: string): string | null => {
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const session: StoredSession = JSON.parse(raw);
      if (
        session &&
        typeof session.token === 'string' &&
        typeof session.wallet === 'string' &&
        session.wallet.toLowerCase() === normalized
      ) {
        if (isJwtExpired(session.token)) {
          clearAuthSession(normalized);
          return null;
        }
        return session.token;
      }
    } catch {
      try { storage.removeItem(key); } catch {}
    }
    return null;
  };

  // 1. Check wallet-scoped key in localStorage
  let token = checkStorage(window.localStorage, walletKey);
  if (token) {
    try {
      if (!window.sessionStorage.getItem(walletKey)) {
        const serialized = JSON.stringify({ token, wallet: normalized });
        window.sessionStorage.setItem(walletKey, serialized);
        window.sessionStorage.setItem(SESSION_KEY, serialized);
      }
    } catch {}
    return token;
  }

  // 2. Check general key in localStorage (backward compat / migration)
  token = checkStorage(window.localStorage, SESSION_KEY);
  if (token) {
    try {
      window.localStorage.setItem(walletKey, JSON.stringify({ token, wallet: normalized }));
    } catch {}
    return token;
  }

  // 3. Fallback to sessionStorage (backward compat / same-tab legacy session)
  token = checkStorage(window.sessionStorage, walletKey) || checkStorage(window.sessionStorage, SESSION_KEY);
  if (token) {
    try {
      window.localStorage.setItem(walletKey, JSON.stringify({ token, wallet: normalized }));
      window.localStorage.setItem(SESSION_KEY, JSON.stringify({ token, wallet: normalized }));
    } catch {}
    return token;
  }

  return null;
}

/**
 * Stores an authenticated session bound to the specific wallet address.
 * Persists to localStorage for cross-tab / refresh persistence and syncs to sessionStorage.
 */
export function setStoredSession(token: string, wallet: string) {
  if (typeof window === 'undefined' || !wallet || !token) return;
  const normalized = wallet.toLowerCase();
  const session: StoredSession = { token, wallet: normalized };
  const serialized = JSON.stringify(session);
  const walletKey = `${SESSION_KEY_PREFIX}${normalized}`;

  try {
    window.localStorage.setItem(walletKey, serialized);
    window.localStorage.setItem(SESSION_KEY, serialized);
  } catch {}

  try {
    window.sessionStorage.setItem(walletKey, serialized);
    window.sessionStorage.setItem(SESSION_KEY, serialized);
  } catch {}
}

/**
 * Invalidates authenticated session state. If a specific wallet address is supplied,
 * only that wallet's stored sessions are purged. Otherwise, all sessions are cleared.
 */
export function clearAuthSession(walletAddress?: string) {
  if (typeof window === 'undefined') return;
  const clearKeys = (storage: Storage) => {
    try {
      if (walletAddress) {
        const normalized = walletAddress.toLowerCase();
        storage.removeItem(`${SESSION_KEY_PREFIX}${normalized}`);
        const raw = storage.getItem(SESSION_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.wallet?.toLowerCase() === normalized) {
            storage.removeItem(SESSION_KEY);
          }
        }
      } else {
        storage.removeItem(SESSION_KEY);
        for (let i = storage.length - 1; i >= 0; i--) {
          const key = storage.key(i);
          if (key && key.startsWith(SESSION_KEY_PREFIX)) {
            storage.removeItem(key);
          }
        }
      }
    } catch {}
  };

  clearKeys(window.localStorage);
  clearKeys(window.sessionStorage);
}

/** Module-scoped in-flight authentication promises keyed by normalized lowercase wallet address. */
const inFlightAuth = new Map<string, Promise<string>>();

export function useAuthSession() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const ensureAuthenticated = useCallback(async (explicitAddress?: string): Promise<string> => {
    const targetAddress = explicitAddress || address;
    if (!isConnected && !explicitAddress) {
      throw new Error('Wallet not connected. Connect your wallet to proceed.');
    }
    if (!targetAddress) {
      throw new Error('Wallet not connected. Connect your wallet to proceed.');
    }

    const currentWallet = targetAddress.toLowerCase();

    // 1. Return cached session token for current wallet if valid
    const existingToken = getStoredSession(currentWallet);
    if (existingToken) {
      return existingToken;
    }

    // 2. Return existing in-flight authentication Promise for this wallet if one is already pending
    const pending = inFlightAuth.get(currentWallet);
    if (pending) {
      return pending;
    }

    // 3. Create ONE Promise for the authentication sequence
    const authPromise = (async (): Promise<string> => {
      // 3a. Obtain sign-in challenge message from server
      const challengeRes = await fetch(`/api/auth?address=${targetAddress}`);
      const challengeData = await challengeRes.json();
      if (!challengeRes.ok || !challengeData.message || !challengeData.issuedAt) {
        throw new Error(challengeData.error || 'Failed to obtain auth challenge from server');
      }

      const { message, issuedAt } = challengeData;

      // 3b. Request wallet signature from connected account (off-chain proof, zero gas)
      let signature: string;
      try {
        signature = await signMessageAsync({
          message,
          account: targetAddress as `0x${string}`,
        });
      } catch (err: any) {
        const msg = err?.shortMessage || err?.message || 'Signature request rejected';
        if (msg.includes('user rejected') || msg.includes('User rejected') || msg.includes('User denied')) {
          throw new Error('Signature request cancelled by user');
        }
        throw new Error(msg);
      }

      // Guard against wallet address change during in-flight signature
      if (address && address.toLowerCase() !== currentWallet) {
        throw new Error('Wallet address changed during authentication. Please try again.');
      }

      // 3c. Send signature proof to /api/auth
      const authRes = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'wallet',
          walletAddress: targetAddress,
          issuedAt,
          signature,
        }),
      });

      const authData = await authRes.json();
      if (!authRes.ok || !authData.token) {
        if (authRes.status >= 500) {
          throw new Error(authData.error || 'Authentication server error. Please check server configuration.');
        }
        if (authRes.status === 401) {
          throw new Error(authData.error || 'Wallet signature verification failed.');
        }
        throw new Error(authData.error || 'Authentication failed');
      }

      const token = authData.token as string;

      // 3d. Store session in localStorage and sessionStorage bound to current wallet address
      setStoredSession(token, currentWallet);

      return token;
    })();

    // 4. Register the in-flight promise before awaiting
    inFlightAuth.set(currentWallet, authPromise);

    // 5. Await the promise and ensure identity-safe cleanup in finally
    try {
      return await authPromise;
    } finally {
      if (inFlightAuth.get(currentWallet) === authPromise) {
        inFlightAuth.delete(currentWallet);
      }
    }
  }, [address, isConnected, signMessageAsync]);

  const clearSession = useCallback(() => {
    clearAuthSession(address);
  }, [address]);

  return {
    ensureAuthenticated,
    clearSession,
    getToken: () => getStoredSession(address),
  };
}
