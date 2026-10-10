'use client';

import { useCallback } from 'react';
import { useAccount, useSignMessage } from 'wagmi';

const SESSION_KEY = 'synq_auth_session';

interface StoredSession {
  token: string;
  wallet: string;
}

function getStoredSession(currentAddress?: string): string | null {
  if (typeof window === 'undefined' || !currentAddress) return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session: StoredSession = JSON.parse(raw);
    if (
      session &&
      typeof session.token === 'string' &&
      typeof session.wallet === 'string' &&
      session.wallet.toLowerCase() === currentAddress.toLowerCase()
    ) {
      return session.token;
    }
  } catch {
    // Malformed session data
  }
  return null;
}

function setStoredSession(token: string, wallet: string) {
  if (typeof window === 'undefined') return;
  try {
    const session: StoredSession = { token, wallet: wallet.toLowerCase() };
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Session storage unavailable
  }
}

export function clearAuthSession() {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Ignore
  }
}

/** Module-scoped in-flight authentication promises keyed by normalized lowercase wallet address. */
const inFlightAuth = new Map<string, Promise<string>>();

export function useAuthSession() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const ensureAuthenticated = useCallback(async (): Promise<string> => {
    if (!isConnected || !address) {
      throw new Error('Wallet not connected. Connect your wallet to proceed.');
    }

    const currentWallet = address.toLowerCase();

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
      const challengeRes = await fetch(`/api/auth?address=${address}`);
      const challengeData = await challengeRes.json();
      if (!challengeRes.ok || !challengeData.message || !challengeData.issuedAt) {
        throw new Error(challengeData.error || 'Failed to obtain auth challenge from server');
      }

      const { message, issuedAt } = challengeData;

      // 3b. Request wallet signature from connected account (off-chain proof, zero gas)
      let signature: string;
      try {
        signature = await signMessageAsync({ message });
      } catch (err: any) {
        const msg = err?.shortMessage || err?.message || 'Signature request rejected';
        if (msg.includes('user rejected') || msg.includes('User rejected') || msg.includes('User denied')) {
          throw new Error('Signature request cancelled by user');
        }
        throw new Error(msg);
      }

      // Guard against wallet address change during in-flight signature
      if (!address || address.toLowerCase() !== currentWallet) {
        throw new Error('Wallet address changed during authentication. Please try again.');
      }

      // 3c. Send signature proof to /api/auth
      const authRes = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'wallet',
          walletAddress: address,
          issuedAt,
          signature,
        }),
      });

      const authData = await authRes.json();
      if (!authRes.ok || !authData.token) {
        throw new Error(authData.error || 'Signature verification failed on server');
      }

      const token = authData.token as string;

      // 3d. Store session in sessionStorage bound to current wallet address
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
    clearAuthSession();
  }, []);

  return {
    ensureAuthenticated,
    clearSession,
    getToken: () => getStoredSession(address),
  };
}
