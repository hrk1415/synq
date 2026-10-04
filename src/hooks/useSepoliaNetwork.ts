'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection, useSwitchChain } from 'wagmi';
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

  const verifyCurrentChain = useCallback(async (): Promise<number> => {
    const connector = connection.connector;
    if (!connection.isConnected || !connector) {
      verificationSequenceRef.current += 1;
      if (mountedRef.current) setVerifiedWalletChain(null);
      throw new SepoliaNetworkError('NOT_CONNECTED', 'Connect a wallet before selecting Ethereum Sepolia.');
    }

    const sequence = ++verificationSequenceRef.current;
    const isCurrent = () => mountedRef.current &&
      connectedRef.current &&
      activeConnectorRef.current?.uid === connector.uid &&
      verificationSequenceRef.current === sequence;

    try {
      const actualChainId = await connector.getChainId();
      if (isCurrent()) setVerifiedWalletChain({ connectorUid: connector.uid, chainId: actualChainId });
      return actualChainId;
    } catch (verificationError) {
      if (isCurrent()) setVerifiedWalletChain(null);
      throw new SepoliaNetworkError(
        'NETWORK_ERROR',
        'Unable to verify the wallet network.',
        verificationError,
      );
    }
  }, [connection.connector, connection.isConnected]);

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

  const requestSepolia = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;

    const request = (async () => {
      const connector = connection.connector;
      if (!connection.isConnected || !connector) {
        throw new SepoliaNetworkError('NOT_CONNECTED', 'Connect a wallet before selecting Ethereum Sepolia.');
      }

      if (mountedRef.current) {
        setError(null);
        setIsRequesting(true);
        setVerifiedWalletChain(null);
      }

      try {
        if (await verifyCurrentChain() === SEPOLIA_CHAIN_ID) return;

        if (mountedRef.current) setVerifiedWalletChain(null);
        await switchChainAsync({
          chainId: SEPOLIA_CHAIN_ID,
          connector,
        });

        const actualChainId = await verifyCurrentChain();
        if (actualChainId !== SEPOLIA_CHAIN_ID) {
          throw new SepoliaNetworkError(
            'WRONG_NETWORK',
            'The wallet did not finish switching to Ethereum Sepolia.',
          );
        }
      } catch (requestError) {
        const normalized = requestError instanceof SepoliaNetworkError
          ? requestError
          : normalizeSwitchError(requestError);

        let reconciledChainId: number | undefined;
        try {
          reconciledChainId = await verifyCurrentChain();
        } catch {
          reconciledChainId = undefined;
        }

        if (reconciledChainId === SEPOLIA_CHAIN_ID) {
          if (mountedRef.current) setError(null);
          return;
        }

        if (
          mountedRef.current &&
          connectedRef.current &&
          activeConnectorRef.current?.uid === connector.uid
        ) setError(normalized);
        throw normalized;
      } finally {
        if (mountedRef.current) setIsRequesting(false);
      }
    })();

    inFlightRef.current = request;
    try {
      await request;
    } finally {
      if (inFlightRef.current === request) inFlightRef.current = null;
    }
  }, [connection.connector, connection.isConnected, switchChainAsync, verifyCurrentChain]);

  const ensureSepolia = useCallback(async (): Promise<void> => {
    if (!connection.isConnected || !connection.connector) {
      const notConnected = new SepoliaNetworkError('NOT_CONNECTED', 'Connect a wallet before continuing.');
      if (mountedRef.current) setError(notConnected);
      throw notConnected;
    }

    if (await verifyCurrentChain() !== SEPOLIA_CHAIN_ID) await requestSepolia();

    const finalChainId = await verifyCurrentChain();
    if (finalChainId !== SEPOLIA_CHAIN_ID) {
      const wrongNetwork = new SepoliaNetworkError(
        'WRONG_NETWORK',
        'Ethereum Sepolia is required before continuing.',
      );
      if (mountedRef.current) setError(wrongNetwork);
      throw wrongNetwork;
    }
  }, [connection.connector, connection.isConnected, requestSepolia, verifyCurrentChain]);

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
