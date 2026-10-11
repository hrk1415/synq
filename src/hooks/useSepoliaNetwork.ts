'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection, useSwitchChain, type Connector } from 'wagmi';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';

export type SepoliaNetworkErrorCode =
  | 'NOT_CONNECTED'
  | 'WRONG_NETWORK'
  | 'SWITCH_REJECTED'
  | 'ADD_CHAIN_REJECTED'
  | 'SWITCH_UNSUPPORTED'
  | 'ADD_CHAIN_UNSUPPORTED'
  | 'NETWORK_ERROR';

export class SepoliaNetworkError extends Error {
  readonly code: SepoliaNetworkErrorCode;
  readonly cause?: unknown;

  constructor(code: SepoliaNetworkErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'SepoliaNetworkError';
    this.code = code;
    this.cause = cause;
  }
}

function errorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as {
    code?: unknown;
    cause?: unknown;
    data?: { originalError?: unknown };
  };
  if (typeof value.code === 'number') return value.code;
  return errorCode(value.cause) ?? errorCode(value.data?.originalError);
}

function errorName(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const value = error as { name?: unknown; cause?: unknown };
  if (typeof value.name === 'string' && value.name) return value.name;
  return errorName(value.cause);
}

export function isRejected(error: unknown): boolean {
  if (!error) return false;
  if (errorCode(error) === 4001 || errorName(error) === 'UserRejectedRequestError') return true;
  const msg = typeof error === 'object' && error !== null && 'message' in error ? String((error as any).message).toLowerCase() : '';
  return msg.includes('user rejected') || msg.includes('user denied') || msg.includes('rejected transaction');
}

function normalizeSwitchError(error: unknown): SepoliaNetworkError {
  if (error instanceof SepoliaNetworkError) return error;
  if (isRejected(error)) {
    return new SepoliaNetworkError('SWITCH_REJECTED', 'The Sepolia network switch was rejected.', error);
  }
  if (errorName(error) === 'SwitchChainNotSupportedError') {
    return new SepoliaNetworkError('SWITCH_UNSUPPORTED', 'This wallet connector cannot switch networks.', error);
  }
  return new SepoliaNetworkError('NETWORK_ERROR', 'Unable to switch to Ethereum Sepolia.', error);
}

type VerifiedWalletChain = {
  connectorUid: string;
  chainId: number;
};

/** Module-scoped in-flight switch promises keyed by connector UID or ID to deduplicate concurrent requests across all components. */
const globalInFlightSwitchPromises = new Map<string, Promise<void>>();

/** Module-scoped set of rejected switch session keys (connectorUid:chainId) to prevent automatic retry loops. */
const rejectedSwitchSessions = new Set<string>();

export function hasRejectedSwitchSession(connectorUid?: string): boolean {
  if (!connectorUid) return false;
  return rejectedSwitchSessions.has(`${connectorUid}:${SEPOLIA_CHAIN_ID}`);
}

export function clearRejectedSwitchSession(connectorUid?: string) {
  if (connectorUid) {
    for (const key of Array.from(rejectedSwitchSessions)) {
      if (key.startsWith(`${connectorUid}:`)) {
        rejectedSwitchSessions.delete(key);
      }
    }
  } else {
    rejectedSwitchSessions.clear();
  }
}

/**
 * Normalizes an unknown chain ID value (hex string, decimal string, number, or bigint)
 * into a safe, positive decimal integer. Returns undefined for invalid, non-positive, or NaN values.
 */
export function parseChainId(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;

  if (typeof value === 'number') {
    return Number.isFinite(value) && !Number.isNaN(value) && value > 0 ? Math.floor(value) : undefined;
  }

  if (typeof value === 'bigint') {
    const num = Number(value);
    return Number.isSafeInteger(num) && num > 0 ? num : undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    // Hexadecimal representation with 0x prefix (e.g. '0xaa36a7', '0X1')
    if (/^0x[0-9a-fA-F]+$/i.test(trimmed)) {
      const parsedHex = parseInt(trimmed, 16);
      return Number.isFinite(parsedHex) && !Number.isNaN(parsedHex) && parsedHex > 0 ? parsedHex : undefined;
    }

    // Decimal representation without 0x prefix (e.g. '11155111', '1')
    if (/^\d+$/.test(trimmed)) {
      const parsedDec = parseInt(trimmed, 10);
      return Number.isFinite(parsedDec) && !Number.isNaN(parsedDec) && parsedDec > 0 ? parsedDec : undefined;
    }
  }

  return undefined;
}

/**
 * Safely resolves the active chain ID from a connector across Wagmi connector types,
 * serialized/rehydrating connectors, and custom EIP-1193 providers without throwing TypeError.
 *
 * Safety Invariant:
 * If the connector exposes live provider methods (`getChainId` or `getProvider`), those methods are
 * the authoritative source. If they fail or reject, the active provider chain is UNKNOWN and
 * returns `undefined`. We strictly DO NOT fall back to static properties or cached IDs to ensure
 * no unsafe assumptions about Sepolia can occur when a provider is failing or unreachable.
 */
export async function getConnectorChainId(
  connector?: Connector | null,
  fallbackChainId?: number,
): Promise<number | undefined> {
  const safeFallback = parseChainId(fallbackChainId);
  if (!connector) return safeFallback;

  const hasGetChainId = typeof (connector as any).getChainId === 'function';
  const hasGetProvider = typeof (connector as any).getProvider === 'function';
  const hasProviderMethods = hasGetChainId || hasGetProvider;

  // 1. Native getChainId method if available
  if (hasGetChainId) {
    try {
      const id = await (connector as any).getChainId();
      const parsed = parseChainId(id);
      if (parsed !== undefined) return parsed;
    } catch {
      // Fall through to getProvider if available
    }
  }

  // 2. Direct EIP-1193 provider request if available
  if (hasGetProvider) {
    try {
      const provider = await (connector as any).getProvider();
      if (provider && typeof (provider as any).request === 'function') {
        const raw = await (provider as any).request({ method: 'eth_chainId' });
        const parsed = parseChainId(raw);
        if (parsed !== undefined) return parsed;
      }
    } catch {
      // Provider request failed
    }
  }

  // If live provider methods exist on the connector but failed to resolve a valid chain ID,
  // the provider chain state is strictly unknown. Return undefined to prevent unsafe assumptions.
  if (hasProviderMethods) {
    return undefined;
  }

  // 3. For connectors with NO provider methods (e.g. bare unit test mocks or disconnected stubs):
  const propChainId = parseChainId((connector as any).chainId);
  if (propChainId !== undefined) {
    return propChainId;
  }

  return safeFallback;
}

export function useSepoliaNetwork() {
  const connection = useConnection();
  const { switchChainAsync, isPending: wagmiIsSwitching } = useSwitchChain();
  const [error, setError] = useState<SepoliaNetworkError | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);
  const [verifiedWalletChain, setVerifiedWalletChain] = useState<VerifiedWalletChain | null>(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const verificationSequenceRef = useRef(0);
  const activeConnectorRef = useRef(connection.connector);
  const connectedRef = useRef(connection.isConnected);

  activeConnectorRef.current = connection.connector;
  connectedRef.current = connection.isConnected;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      inFlightRef.current = null;
      verificationSequenceRef.current += 1;
    };
  }, []);

  const isConnected = connection.isConnected;
  const verifiedChainId = isConnected && connection.connector && verifiedWalletChain?.connectorUid === connection.connector.uid
    ? verifiedWalletChain.chainId
    : undefined;
  const isNetworkVerified = verifiedChainId !== undefined;
  const isSepolia = isConnected && isNetworkVerified && verifiedChainId === SEPOLIA_CHAIN_ID;
  const isWrongNetwork = isConnected && isNetworkVerified && verifiedChainId !== SEPOLIA_CHAIN_ID;
  const isNetworkUnverified = isConnected && !isNetworkVerified;
  const networkReady = isConnected && isNetworkVerified && verifiedChainId === SEPOLIA_CHAIN_ID;

  useEffect(() => {
    if (networkReady) setError(null);
  }, [networkReady]);

  const verifyCurrentChain = useCallback(async (explicitConnector?: Connector): Promise<number> => {
    const connector = explicitConnector || connection.connector;
    if (!connector) {
      verificationSequenceRef.current += 1;
      if (mountedRef.current) setVerifiedWalletChain(null);
      throw new SepoliaNetworkError('NOT_CONNECTED', 'Connect a wallet before selecting Ethereum Sepolia.');
    }

    const sequence = ++verificationSequenceRef.current;
    const isCurrent = () => mountedRef.current &&
      (explicitConnector || (connectedRef.current && activeConnectorRef.current?.uid === connector.uid)) &&
      verificationSequenceRef.current === sequence;

    try {
      const actualChainId = await getConnectorChainId(connector, connection.chainId);
      if (actualChainId !== undefined) {
        if (isCurrent()) setVerifiedWalletChain({ connectorUid: connector.uid, chainId: actualChainId });
        return actualChainId;
      }
      throw new Error('Unable to resolve chain ID from connector');
    } catch (verificationError) {
      if (isCurrent()) setVerifiedWalletChain(null);
      throw new SepoliaNetworkError(
        'NETWORK_ERROR',
        'Unable to verify the wallet network.',
        verificationError,
      );
    }
  }, [connection.connector, connection.chainId]);

  useEffect(() => {
    if (!connection.isConnected || !connection.connector) {
      verificationSequenceRef.current += 1;
      setVerifiedWalletChain(null);
      setError(null);
      setIsRequesting(false);
      return;
    }

    setVerifiedWalletChain((current) => current?.connectorUid === connection.connector?.uid ? current : null);
    void verifyCurrentChain()
      .then((actualChainId) => {
        if (actualChainId === SEPOLIA_CHAIN_ID && mountedRef.current) setError(null);
      })
      .catch((verificationError) => {
        if (
          mountedRef.current &&
          connectedRef.current &&
          activeConnectorRef.current?.uid === connection.connector?.uid
        ) {
          setError(verificationError instanceof SepoliaNetworkError
            ? verificationError
            : new SepoliaNetworkError('NETWORK_ERROR', 'Unable to verify the wallet network.', verificationError));
        }
      });
  }, [connection.chainId, connection.connector, connection.isConnected, verifyCurrentChain]);

  const requestSepolia = useCallback(async (explicitConnector?: Connector): Promise<void> => {
    const connector = explicitConnector || connection.connector;
    if (!connector) {
      throw new SepoliaNetworkError('NOT_CONNECTED', 'Connect a wallet before selecting Ethereum Sepolia.');
    }

    const connKey = connector.uid || connector.id || 'default_connector';
    const existing = globalInFlightSwitchPromises.get(connKey);
    if (existing) return existing;

    const request = (async () => {
      if (mountedRef.current) {
        setError(null);
        setIsRequesting(true);
      }

      try {
        // Direct provider verification before requesting network switch
        let actualBefore: number | undefined;
        try {
          actualBefore = await getConnectorChainId(connector, connection.chainId);
        } catch {
          actualBefore = undefined;
        }

        if (actualBefore === SEPOLIA_CHAIN_ID) {
          if (mountedRef.current) {
            setVerifiedWalletChain({ connectorUid: connector.uid, chainId: SEPOLIA_CHAIN_ID });
            setError(null);
          }
          return;
        }

        if (mountedRef.current) setVerifiedWalletChain(null);
        await switchChainAsync({
          chainId: SEPOLIA_CHAIN_ID,
          connector,
        });

        let actualChainId: number | undefined;
        try {
          actualChainId = await getConnectorChainId(connector);
        } catch {
          actualChainId = await verifyCurrentChain(connector);
        }

        if (actualChainId !== SEPOLIA_CHAIN_ID) {
          throw new SepoliaNetworkError(
            'WRONG_NETWORK',
            'The wallet did not finish switching to Ethereum Sepolia.',
          );
        }

        if (mountedRef.current) {
          setVerifiedWalletChain({ connectorUid: connector.uid, chainId: SEPOLIA_CHAIN_ID });
          setError(null);
        }
      } catch (requestError) {
        const normalized = requestError instanceof SepoliaNetworkError
          ? requestError
          : normalizeSwitchError(requestError);

        if (isRejected(requestError)) {
          rejectedSwitchSessions.add(`${connKey}:${SEPOLIA_CHAIN_ID}`);
        }

        let reconciledChainId: number | undefined;
        try {
          reconciledChainId = await getConnectorChainId(connector);
        } catch {
          reconciledChainId = undefined;
        }

        if (reconciledChainId === SEPOLIA_CHAIN_ID) {
          if (mountedRef.current) {
            setVerifiedWalletChain({ connectorUid: connector.uid, chainId: SEPOLIA_CHAIN_ID });
            setError(null);
          }
          return;
        }

        if (
          mountedRef.current &&
          (explicitConnector || (connectedRef.current && activeConnectorRef.current?.uid === connector.uid))
        ) {
          setError(normalized);
        }
        throw normalized;
      } finally {
        globalInFlightSwitchPromises.delete(connKey);
        if (mountedRef.current) setIsRequesting(false);
      }
    })();

    globalInFlightSwitchPromises.set(connKey, request);
    inFlightRef.current = request;
    try {
      await request;
    } finally {
      if (inFlightRef.current === request) inFlightRef.current = null;
    }
  }, [connection.connector, connection.chainId, switchChainAsync, verifyCurrentChain]);

  const ensureSepolia = useCallback(async (explicitConnector?: Connector): Promise<void> => {
    const connector = explicitConnector || connection.connector;
    if (!connector) {
      const notConnected = new SepoliaNetworkError('NOT_CONNECTED', 'Connect a wallet before continuing.');
      if (mountedRef.current) setError(notConnected);
      throw notConnected;
    }

    const currentChainId = await getConnectorChainId(connector, connection.chainId);
    if (currentChainId !== SEPOLIA_CHAIN_ID) {
      await requestSepolia(connector);
    }

    const finalChainId = (await getConnectorChainId(connector)) ?? (await verifyCurrentChain(connector));
    if (finalChainId !== SEPOLIA_CHAIN_ID) {
      const wrongNetwork = new SepoliaNetworkError(
        'WRONG_NETWORK',
        'Ethereum Sepolia is required before continuing.',
      );
      if (mountedRef.current) setError(wrongNetwork);
      throw wrongNetwork;
    }
  }, [connection.connector, connection.chainId, requestSepolia, verifyCurrentChain]);

  return {
    isConnected,
    chainId: verifiedChainId,
    cachedChainId: connection.chainId,
    verifiedChainId,
    isNetworkVerified,
    isSepolia,
    isWrongNetwork,
    isNetworkUnverified,
    networkReady,
    isSwitching: isRequesting || wagmiIsSwitching,
    error,
    requestSepolia,
    ensureSepolia,
  };
}

export default useSepoliaNetwork;
