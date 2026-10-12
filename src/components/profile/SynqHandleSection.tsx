'use client';

import React, { useState, useEffect } from 'react';
import { useReadContract } from 'wagmi';
import { AtSign, Check, Copy, Loader2, Sparkles, RefreshCw, AlertCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { shortenAddress } from '@/lib/utils';
import { useRegistry } from '@/hooks/useRegistryContract';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';

interface SynqHandleSectionProps {
  address: `0x${string}` | undefined;
}

export function SynqHandleSection({ address }: SynqHandleSectionProps) {
  const {
    username: currentUsername,
    isLoading: registryLoading,
    isPending: txPending,
    error: registryError,
    config,
    refetchUsername,
    register,
    updateUsername,
    txReceipt,
  } = useRegistry(address);

  const { networkReady } = useSepoliaNetwork();

  const [handleInput, setHandleInput] = useState('');
  const [copied, setCopied] = useState(false);
  const [lastSubmittedHandle, setLastSubmittedHandle] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const candidate = handleInput.trim();
  const isCandidateValid = candidate.length >= 3 && candidate.length <= 32 && /^[a-zA-Z0-9_]+$/.test(candidate);
  const isSameAsCurrent = !!currentUsername && candidate === currentUsername;

  // Read availability from contract (case-sensitive check)
  const { data: isTaken, isLoading: isCheckingTaken } = useReadContract({
    ...config,
    functionName: 'isUsernameTaken',
    args: isCandidateValid && !isSameAsCurrent ? [candidate] : undefined,
    query: {
      enabled: !!address && networkReady && isCandidateValid && !isSameAsCurrent,
    },
  });

  // Handle successful transaction completion
  useEffect(() => {
    if (lastSubmittedHandle && txReceipt.isSuccess) {
      refetchUsername();
      setSuccessMsg(`Handle successfully saved as @${lastSubmittedHandle}!`);
      setHandleInput('');
      setLastSubmittedHandle(null);
    }
  }, [txReceipt.isSuccess, lastSubmittedHandle, refetchUsername]);

  // Handle transaction errors
  useEffect(() => {
    if (registryError && lastSubmittedHandle) {
      const msg = registryError.message || '';
      if (msg.toLowerCase().includes('taken') || msg.toLowerCase().includes('exists')) {
        setErrorMsg('This username is already taken on-chain — pick another one');
      } else if (msg.includes('rejected') || msg.includes('denied')) {
        setErrorMsg('Signature was rejected in wallet.');
      } else {
        setErrorMsg('Transaction failed. Please try again.');
      }
      setLastSubmittedHandle(null);
    }
  }, [registryError, lastSubmittedHandle]);

  const copyHandle = async () => {
    if (!currentUsername) return;
    try {
      await navigator.clipboard.writeText(`@${currentUsername}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore clipboard error */
    }
  };

  const handleRegister = async () => {
    if (!isCandidateValid || isTaken || isCheckingTaken || !networkReady) return;
    setErrorMsg('');
    setSuccessMsg('');
    setLastSubmittedHandle(candidate);
    await register(candidate);
  };

  const handleUpdate = async () => {
    if (!isCandidateValid || isTaken || isCheckingTaken || isSameAsCurrent || !networkReady) return;
    setErrorMsg('');
    setSuccessMsg('');
    setLastSubmittedHandle(candidate);
    await updateUsername(candidate);
  };

  // 1. Disconnected state
  if (!address) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-zinc-400">
          Connect your wallet to manage your on-chain Synq handle.
        </p>
      </div>
    );
  }

  // 2. Network wrong / unverified
  if (!networkReady) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-amber-400 flex items-center gap-1.5">
          <AlertCircle size={14} />
          Switch your wallet to Ethereum Sepolia to view or update your handle.
        </p>
      </div>
    );
  }

  // 3. Registry read loading
  if (registryLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-400 py-2">
        <Loader2 size={14} className="animate-spin text-blue-400" />
        Checking Registry contract...
      </div>
    );
  }

  const hasHandle = !!currentUsername && currentUsername.length > 0;

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-400">
        Your NexotiqRegistry @username is your permanent on-chain digital identity for ChatPay addressing and counterparty verification.
      </p>

      {/* Current Handle Card */}
      {hasHandle ? (
        <div className="p-3 rounded-xl bg-zinc-800/50 border border-zinc-700/50 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-500 font-medium">Current Handle</span>
            <span className="text-[11px] font-mono text-zinc-500">{shortenAddress(address)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-base font-bold text-blue-400 flex items-center gap-1">
              @{currentUsername}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={copyHandle}
              className="h-8 text-xs gap-1.5 border-zinc-700 text-zinc-300 hover:text-white"
            >
              {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="p-3 rounded-xl bg-zinc-800/30 border border-zinc-800 text-xs text-zinc-400">
          No handle registered yet for wallet <span className="font-mono text-zinc-300">{shortenAddress(address)}</span>. Claiming a handle is optional.
        </div>
      )}

      {/* Handle Input & Action */}
      <div className="space-y-2 pt-1">
        <label className="text-xs text-zinc-400 block font-medium">
          {hasHandle ? 'Change Handle' : 'Claim Handle'}
        </label>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 text-sm">@</span>
            <Input
              value={handleInput}
              onChange={(e) => {
                setHandleInput(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''));
                setErrorMsg('');
                setSuccessMsg('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (hasHandle) handleUpdate();
                  else handleRegister();
                }
              }}
              placeholder={hasHandle ? 'new_handle' : 'your_handle'}
              className="pl-8 font-mono text-sm"
              maxLength={32}
            />
          </div>
          <Button
            type="button"
            size="sm"
            onClick={hasHandle ? handleUpdate : handleRegister}
            disabled={
              !isCandidateValid ||
              isTaken === true ||
              isCheckingTaken ||
              isSameAsCurrent ||
              txPending ||
              !networkReady
            }
            className="shrink-0 gap-1.5"
          >
            {txPending ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                {hasHandle ? 'Updating...' : 'Signing...'}
              </>
            ) : hasHandle ? (
              <>
                <RefreshCw size={14} />
                Update Handle
              </>
            ) : (
              <>
                <Sparkles size={14} />
                Register Handle
              </>
            )}
          </Button>
        </div>

        {/* Validation & Availability Messages */}
        {candidate.length > 0 && (
          <div className="text-xs space-y-1">
            {candidate.length < 3 && (
              <p className="text-zinc-500">Must be 3–32 characters (letters, numbers, underscore).</p>
            )}
            {isSameAsCurrent && (
              <p className="text-amber-400">This is already your current handle.</p>
            )}
            {isCandidateValid && !isSameAsCurrent && (
              <>
                {isCheckingTaken && (
                  <p className="text-zinc-400 flex items-center gap-1">
                    <Loader2 size={12} className="animate-spin text-blue-400" />
                    Checking availability on-chain...
                  </p>
                )}
                {!isCheckingTaken && isTaken === true && (
                  <p className="text-red-400">@{candidate} is already taken on-chain — pick another one</p>
                )}
                {!isCheckingTaken && isTaken === false && (
                  <p className="text-emerald-400 flex items-center gap-1">
                    <Check size={12} />
                    @{candidate} is available
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {errorMsg && <p className="text-xs text-red-400">{errorMsg}</p>}
        {successMsg && (
          <p className="text-xs text-emerald-400 flex items-center gap-1">
            <Check size={12} /> {successMsg}
          </p>
        )}

        <p className="text-[11px] text-zinc-600">
          NexotiqRegistry is case-sensitive. 3–32 characters, alphanumeric and underscores only.
        </p>
      </div>
    </div>
  );
}
