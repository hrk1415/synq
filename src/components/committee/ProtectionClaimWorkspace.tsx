'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAccount, useSignTypedData, useWriteContract } from 'wagmi';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { shortenAddress } from '@/lib/utils';
import { formatUsdcAmount } from '@/lib/deals/v2';
import { useAuthSession } from '@/hooks/useAuthSession';
import { sepoliaPublicClient } from '@/lib/chain';
import {
  CANONICAL_PROTECTION_COMMITTEE_SEPOLIA,
  synqProtectionCommitteeFullABI,
  formatSubmitClaimDecisionTx,
  computeDecisionNonceKey,
  type ProtectionClaimDecisionAuthData,
} from '@/lib/deals/v2-protection-committee';
import { formatClaimStatus } from './ProtectionClaimQueue';
import {
  ArrowLeft,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  FileText,
  Clock,
  ExternalLink,
  Loader2,
  Check,
  Send,
  RefreshCw,
  Info,
  Hash,
  ChevronDown,
  ChevronUp,
  Search,
} from 'lucide-react';
import { getAddress } from 'viem';

interface ProtectionClaimWorkspaceProps {
  dealAddress: string;
  milestoneId: number;
  onBack: () => void;
  onDecisionExecuted: () => void;
}

function isSafeHttpUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Detects whether an error from wallet submission indicates an ambiguous outcome
 * (e.g. provider disconnection, timeout, network error) where the transaction may
 * have been signed and broadcast by the wallet before connection was dropped.
 */
function isAmbiguousSubmissionError(err: any): boolean {
  if (!err) return false;
  const code = err.code ?? err.cause?.code;
  if (code === 4001 || code === 'ACTION_REJECTED') {
    return false; // Explicit user rejection
  }
  const msg = (err.message || String(err)).toLowerCase();
  if (
    msg.includes('user rejected') ||
    msg.includes('user denied') ||
    msg.includes('rejected the request') ||
    msg.includes('cancelled') ||
    msg.includes('canceled')
  ) {
    return false; // Explicit user rejection
  }
  if (
    code === 4900 ||
    msg.includes('disconnected') ||
    msg.includes('disconnected from all chains') ||
    msg.includes('provider disconnected') ||
    msg.includes('providerdisconnectederror') ||
    msg.includes('lost connection') ||
    msg.includes('network connection lost') ||
    msg.includes('failed to fetch') ||
    msg.includes('network error') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('connection reset') ||
    msg.includes('socket hang up')
  ) {
    return true;
  }
  return false;
}

export function ProtectionClaimWorkspace({
  dealAddress,
  milestoneId,
  onBack,
  onDecisionExecuted,
}: ProtectionClaimWorkspaceProps) {
  const { address } = useAccount();
  const { getToken } = useAuthSession();

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [claimData, setClaimData] = useState<any | null>(null);
  const [activeDecision, setActiveDecision] = useState<any | null>(null);
  const [historyDecisions, setHistoryDecisions] = useState<any[]>([]);

  // Draft Authoring Form
  const [decisionChoice, setDecisionChoice] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [rationale, setRationale] = useState<string>('');
  const [isSubmittingDraft, setIsSubmittingDraft] = useState<boolean>(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [confirmDraft, setConfirmDraft] = useState<boolean>(false);

  // Signatures
  const { signTypedDataAsync } = useSignTypedData();
  const [isSigning, setIsSigning] = useState<boolean>(false);
  const [signingError, setSigningError] = useState<string | null>(null);

  // Execution
  const { writeContractAsync } = useWriteContract();
  const [isExecuting, setIsExecuting] = useState<boolean>(false);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [executionTxHash, setExecutionTxHash] = useState<string | null>(null);

  // Recovery & Disconnect Handling
  const [recoveryTxHash, setRecoveryTxHash] = useState<string>('');
  const [isReconciling, setIsReconciling] = useState<boolean>(false);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [isAmbiguousFailure, setIsAmbiguousFailure] = useState<boolean>(false);
  const [showTroubleshooting, setShowTroubleshooting] = useState<boolean>(false);
  const [checkingOnChain, setCheckingOnChain] = useState<boolean>(false);
  const [onChainCheckMessage, setOnChainCheckMessage] = useState<string | null>(null);
  const [onChainCheckSuccess, setOnChainCheckSuccess] = useState<boolean>(false);

  const [showTypedData, setShowTypedData] = useState<boolean>(false);

  // Ref to prevent repeat automatic reconciliation attempts during same session
  const autoReconcileAttemptedRef = useRef<Set<string>>(new Set());

  // 1. Fetch Claim Detail & Decisions
  const fetchClaimDetails = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

      const [detailRes, decisionsRes] = await Promise.all([
        fetch(`/api/committee/protection/claims/${dealAddress}/${milestoneId}`, { headers }),
        fetch(`/api/committee/protection/decisions?dealAddress=${dealAddress}&milestoneId=${milestoneId}`, { headers }),
      ]);

      if (!detailRes.ok) {
        const errJson = await detailRes.json().catch(() => ({}));
        throw new Error(errJson.error || `Failed to fetch claim detail (HTTP ${detailRes.status})`);
      }

      const detailData = await detailRes.json();
      setClaimData(detailData.detail);
      setActiveDecision(detailData.detail.activeDecision);

      // Safe automatic reconciliation: check if this exact decision draft has already executed on-chain
      const onChainStatus = Number(detailData.detail?.onChainClaim?.status);
      const activeDec = detailData.detail?.activeDecision;
      const onChainRepHash = detailData.detail?.onChainClaim?.decisionReportHash?.toLowerCase();
      const decRepHash = activeDec?.decisionReportHash?.toLowerCase();

      if (
        activeDec?.status === 'threshold_ready' &&
        (onChainStatus === 2 || onChainStatus === 3 || onChainStatus === 4) &&
        onChainRepHash &&
        decRepHash &&
        onChainRepHash === decRepHash
      ) {
        if (!autoReconcileAttemptedRef.current.has(activeDec.id)) {
          autoReconcileAttemptedRef.current.add(activeDec.id);
          try {
            const recRes = await fetch(`/api/committee/protection/decisions/${activeDec.id}/reconcile`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({}),
            });
            if (recRes.ok) {
              const recData = await recRes.json();
              setActiveDecision(null);
              setExecutionTxHash(recData.decision?.executionTxHash || null);
              setOnChainCheckSuccess(true);
              setOnChainCheckMessage('Decision execution successfully synchronized with on-chain records.');
              onDecisionExecuted();
              return;
            } else {
              const errData = await recRes.json().catch(() => ({}));
              console.warn('[ProtectionClaimWorkspace] Auto-reconcile non-ok response:', errData);
              setIsAmbiguousFailure(true);
              setShowTroubleshooting(true);
              const statusLabel =
                onChainStatus === 2 ? 'Approved (2)' : onChainStatus === 4 ? 'Paid (4)' : 'Rejected (3)';
              setOnChainCheckMessage(
                `On-chain claim status is ${statusLabel}. The decision has executed on-chain. Click 'Reconcile On-Chain' below to synchronize.`
              );
            }
          } catch (autoErr) {
            console.warn('[ProtectionClaimWorkspace] Auto-reconcile error:', autoErr);
            setIsAmbiguousFailure(true);
            setShowTroubleshooting(true);
          }
        }
      }

      if (decisionsRes.ok) {
        const decData = await decisionsRes.json();
        setHistoryDecisions(decData.decisions || []);
      }
    } catch (err: any) {
      setError(err?.message || 'Error loading claim details');
    } finally {
      setLoading(false);
    }
  }, [dealAddress, milestoneId, getToken]);

  useEffect(() => {
    fetchClaimDetails();
  }, [fetchClaimDetails]);

  // Check if current user has already signed active decision
  const hasUserSigned = useMemo(() => {
    if (!activeDecision || !address || !Array.isArray(activeDecision.signatures)) {
      return false;
    }
    const currentAddr = address.toLowerCase();
    return activeDecision.signatures.some(
      (s: any) => s.signerWallet?.toLowerCase() === currentAddr
    );
  }, [activeDecision, address]);

  // Handle Stage Decision Draft
  const handleStageDraft = async () => {
    if (!rationale.trim()) {
      setDraftError('Rationale cannot be empty.');
      return;
    }
    if (rationale.trim().length > 4000) {
      setDraftError('Rationale exceeds maximum length of 4000 characters.');
      return;
    }

    setIsSubmittingDraft(true);
    setDraftError(null);
    try {
      const token = await getToken();
      const res = await fetch('/api/committee/protection/decisions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          dealAddress,
          milestoneId,
          decision: decisionChoice,
          rationale: rationale.trim(),
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      setConfirmDraft(false);
      setRationale('');
      await fetchClaimDetails();
    } catch (err: any) {
      setDraftError(err?.message || 'Failed to stage decision draft');
    } finally {
      setIsSubmittingDraft(false);
    }
  };

  // Handle Signing with Wallet
  const handleSignDecision = async () => {
    if (!activeDecision || !activeDecision.typedData) {
      setSigningError('Typed data is missing for active decision.');
      return;
    }

    setIsSigning(true);
    setSigningError(null);
    try {
      const td = activeDecision.typedData;
      const signature = await signTypedDataAsync({
        domain: {
          name: td.domain.name,
          version: td.domain.version,
          chainId: Number(td.domain.chainId),
          verifyingContract: td.domain.verifyingContract as `0x${string}`,
        },
        types: td.types,
        primaryType: td.primaryType,
        message: {
          committee: td.message.committee as `0x${string}`,
          chainId: BigInt(td.message.chainId),
          manager: td.message.manager as `0x${string}`,
          deal: td.message.deal as `0x${string}`,
          milestoneId: BigInt(td.message.milestoneId),
          decision: Number(td.message.decision),
          decisionReportHash: td.message.decisionReportHash as `0x${string}`,
          decisionNonce: BigInt(td.message.decisionNonce),
          validUntil: BigInt(td.message.validUntil),
        },
      });

      const token = await getToken();
      const res = await fetch(
        `/api/committee/protection/decisions/${activeDecision.id}/signatures`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ signature }),
        }
      );

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      await fetchClaimDetails();
    } catch (err: any) {
      setSigningError(err?.message || 'Error signing decision');
    } finally {
      setIsSigning(false);
    }
  };

  // Handle On-Chain Execution
  // Handle On-Chain Execution
  const handleExecuteDecision = async () => {
    if (!activeDecision || activeDecision.status !== 'threshold_ready') {
      setExecutionError('Threshold is not met or decision is not ready for execution.');
      return;
    }

    const sigs = activeDecision.signatures;
    if (!Array.isArray(sigs) || sigs.length < 2) {
      setExecutionError('Two signatures are required for execution.');
      return;
    }

    setIsExecuting(true);
    setExecutionError(null);
    try {
      const [s1, s2] = sigs;
      const authData: ProtectionClaimDecisionAuthData = {
        committee: getAddress(activeDecision.committeeAddress),
        chainId: BigInt(activeDecision.chainId),
        manager: getAddress(activeDecision.managerAddress),
        deal: getAddress(activeDecision.dealAddress),
        milestoneId: BigInt(activeDecision.milestoneId),
        decision: activeDecision.decision,
        decisionReportHash: activeDecision.decisionReportHash as `0x${string}`,
        decisionNonce: BigInt(activeDecision.decisionNonce),
        validUntil: BigInt(activeDecision.validUntil),
      };

      const txPayload = formatSubmitClaimDecisionTx({
        committeeAddress: getAddress(activeDecision.committeeAddress),
        auth: authData,
        sig1: s1.signature as `0x${string}`,
        sig2: s2.signature as `0x${string}`,
      });

      const txHash = await writeContractAsync({
        address: txPayload.address,
        abi: txPayload.abi,
        functionName: txPayload.functionName,
        args: txPayload.args,
      });

      setExecutionTxHash(txHash);

      // Wait for receipt using resilient public client
      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        throw new Error('Transaction reverted on-chain');
      }

      // Reconcile on backend
      const token = await getToken();
      const recRes = await fetch(
        `/api/committee/protection/decisions/${activeDecision.id}/reconcile`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ txHash }),
        }
      );

      if (!recRes.ok) {
        const errData = await recRes.json().catch(() => ({}));
        throw new Error(errData.error || `Reconciliation failed (HTTP ${recRes.status})`);
      }

      setIsAmbiguousFailure(false);
      setExecutionError(null);
      await fetchClaimDetails();
      onDecisionExecuted();
    } catch (err: any) {
      if (isAmbiguousSubmissionError(err)) {
        setIsAmbiguousFailure(true);
        setExecutionError(
          'Your wallet provider disconnected while submitting or awaiting the transaction. It may have already succeeded on Sepolia. Check on-chain status below before attempting any rebroadcast.'
        );
      } else {
        setIsAmbiguousFailure(false);
        setExecutionError(
          err?.message ||
            'Transaction execution failed or encountered a provider error. If mined, use Manual Reconciliation below.'
        );
      }
    } finally {
      setIsExecuting(false);
    }
  };

  // On-Chain State Verification Action
  const handleCheckOnChainStatus = async () => {
    if (!claimData) return;
    try {
      setCheckingOnChain(true);
      setOnChainCheckMessage(null);

      // 1. Read on-chain claim status from manager contract
      const rawClaim = (await sepoliaPublicClient.readContract({
        address: getAddress(claimData.claim.managerAddress),
        abi: [
          {
            inputs: [
              { name: 'deal', type: 'address' },
              { name: 'milestoneId', type: 'uint256' },
            ],
            name: 'getClaim',
            outputs: [
              {
                components: [
                  { name: 'status', type: 'uint8' },
                  { name: 'milestoneId', type: 'uint256' },
                  { name: 'milestoneAmount', type: 'uint256' },
                  { name: 'evidenceHash', type: 'bytes32' },
                  { name: 'decisionReportHash', type: 'bytes32' },
                  { name: 'submittedAt', type: 'uint256' },
                  { name: 'resolvedAt', type: 'uint256' },
                  { name: 'payout', type: 'uint256' },
                ],
                type: 'tuple',
              },
            ],
            stateMutability: 'view',
            type: 'function',
          },
        ],
        functionName: 'getClaim',
        args: [getAddress(dealAddress), BigInt(milestoneId)],
      })) as any;

      const onChainStatus = Number(rawClaim.status);
      if (onChainStatus === 2 || onChainStatus === 3 || onChainStatus === 4) {
        setOnChainCheckSuccess(true);
        const statusLabel =
          onChainStatus === 2 ? 'Approved (2)' : onChainStatus === 4 ? 'Paid (4)' : 'Rejected (3)';
        setOnChainCheckMessage(
          `On-chain claim status is ${statusLabel}. The decision transaction succeeded on Sepolia! Click 'Reconcile On-Chain' below to synchronize the database record.`
        );
        return;
      }

      // 2. Check if decision nonce was used on committee contract
      if (activeDecision) {
        const nonceKey = computeDecisionNonceKey({
          manager: activeDecision.managerAddress,
          deal: activeDecision.dealAddress,
          milestoneId: activeDecision.milestoneId,
          decisionNonce: BigInt(activeDecision.decisionNonce),
        });

        const isNonceUsed = (await sepoliaPublicClient.readContract({
          address: getAddress(activeDecision.committeeAddress),
          abi: synqProtectionCommitteeFullABI,
          functionName: 'usedDecisionNonces',
          args: [nonceKey],
        })) as boolean;

        if (isNonceUsed) {
          setOnChainCheckSuccess(true);
          setOnChainCheckMessage(
            `Decision nonce #${activeDecision.decisionNonce} has been marked as used on-chain. Click 'Reconcile On-Chain' below to recover and finalize the execution record.`
          );
          return;
        }
      }

      setOnChainCheckSuccess(false);
      setOnChainCheckMessage(
        `On-chain claim status is Submitted (1) and decision nonce #${activeDecision?.decisionNonce || '1'} is unused. The transaction did not execute on-chain. It is safe to reconnect your wallet and broadcast again.`
      );
    } catch (err: any) {
      setOnChainCheckSuccess(false);
      setOnChainCheckMessage(`Failed to read on-chain contract: ${err?.message || String(err)}`);
    } finally {
      setCheckingOnChain(false);
    }
  };

  // Reset Ambiguous State for Safe Resubmission Retry
  const handleResetForRetry = () => {
    setIsAmbiguousFailure(false);
    setExecutionError(null);
    setReconcileError(null);
    setOnChainCheckMessage(null);
  };

  // Handle Manual Reconciliation / Crash Recovery
  const handleReconcile = async (txHashToUse?: string) => {
    if (!activeDecision) return;
    setIsReconciling(true);
    setReconcileError(null);
    try {
      const token = await getToken();
      const targetHash = txHashToUse || recoveryTxHash.trim() || executionTxHash || undefined;
      const res = await fetch(
        `/api/committee/protection/decisions/${activeDecision.id}/reconcile`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(targetHash ? { txHash: targetHash } : {}),
        }
      );

      const resData = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(resData.error || `Reconciliation failed (HTTP ${res.status})`);
      }

      setIsAmbiguousFailure(false);
      setExecutionError(null);
      await fetchClaimDetails();
      onDecisionExecuted();
    } catch (err: any) {
      setReconcileError(err?.message || 'Reconciliation failed');
    } finally {
      setIsReconciling(false);
    }
  };

  if (loading) {
    return (
      <div className="py-16 text-center text-xs text-zinc-400 space-y-3">
        <Loader2 className="h-8 w-8 animate-spin mx-auto text-zinc-500" />
        <p>Loading Protection Committee workspace…</p>
      </div>
    );
  }

  if (error || !claimData) {
    return (
      <div className="space-y-4">
        <Button size="sm" variant="outline" onClick={onBack} className="text-xs">
          <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back to Queue
        </Button>
        <Card className="border-red-500/40 bg-red-950/20 p-6 text-center space-y-2">
          <AlertTriangle className="h-8 w-8 text-red-400 mx-auto" />
          <h2 className="text-sm font-bold text-white">Error Loading Claim</h2>
          <p className="text-xs text-red-300">{error || 'Claim record could not be loaded.'}</p>
        </Card>
      </div>
    );
  }

  const { claim, onChainClaim } = claimData;
  const statusCfg = formatClaimStatus(onChainClaim.status);
  const manifest = claim.canonicalManifest || {};

  const isExecutedCase = Boolean(
    claimData.executedDecision ||
      (onChainClaim && onChainClaim.status >= 2) ||
      (activeDecision && activeDecision.status === 'executed')
  );

  const executedDec =
    claimData.executedDecision ||
    (activeDecision?.status === 'executed' ? activeDecision : null) ||
    (historyDecisions.length > 0 ? historyDecisions.find((d: any) => d.status === 'executed') : null);

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex items-center justify-between border-b border-white/10 pb-4">
        <Button
          size="sm"
          variant="outline"
          onClick={onBack}
          className="h-8 text-xs border-white/20 bg-[#252525] text-white hover:bg-neutral-800"
        >
          <ArrowLeft className="h-3.5 w-3.5 mr-1.5" /> Back to Queue
        </Button>

        <div className="flex items-center gap-2">
          <Badge variant={statusCfg.variant} className={`text-xs ${statusCfg.className}`}>
            {statusCfg.label}
          </Badge>
        </div>
      </div>

      {/* 1. Claim Facts & Private Evidence */}
      <Card className="border border-white/10 bg-[#1E1E1E] shadow-lg">
        <CardHeader className="pb-3 border-b border-white/5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
                <FileText className="h-4 w-4 text-emerald-400" />
                Claim Review: Deal {shortenAddress(claim.dealAddress)} · Milestone #{claim.milestoneId + 1}
              </CardTitle>
              <CardDescription className="text-xs text-zinc-400">
                Verified on-chain policy record and client-submitted claim manifest.
              </CardDescription>
            </div>
            <div className="text-right text-xs">
              <span className="text-zinc-400">Milestone Principal: </span>
              <span className="font-mono font-bold text-white">
                {formatUsdcAmount(BigInt(onChainClaim.milestoneAmount || '0'))} USDC
              </span>
            </div>
          </div>
        </CardHeader>

        <CardContent className="pt-4 space-y-4">
          {/* Verified On-Chain Metadata Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 rounded-lg bg-black/30 border border-white/5 text-xs">
            <div>
              <span className="text-zinc-500 block text-[10px] uppercase font-bold">Client Wallet</span>
              <span className="font-mono text-zinc-300">{shortenAddress(claim.clientWallet)}</span>
            </div>
            <div>
              <span className="text-zinc-500 block text-[10px] uppercase font-bold">Manager Contract</span>
              <span className="font-mono text-zinc-300">{shortenAddress(claim.managerAddress)}</span>
            </div>
            <div>
              <span className="text-zinc-500 block text-[10px] uppercase font-bold">Evidence Hash</span>
              <span className="font-mono text-zinc-300 truncate block" title={claim.evidenceHash}>
                {claim.evidenceHash.slice(0, 16)}…
              </span>
            </div>
          </div>

          {/* Client Submitted Explanation & Evidence */}
          <div className="space-y-3 pt-2">
            <div>
              <h4 className="text-xs font-bold text-zinc-300 mb-1">Client Explanation:</h4>
              <div className="p-3 rounded-lg bg-[#252525] border border-white/5 text-xs text-zinc-200 whitespace-pre-wrap">
                {manifest.explanation || 'No explanation text provided.'}
              </div>
            </div>

            {manifest.failureReason && (
              <div>
                <h4 className="text-xs font-bold text-zinc-300 mb-1">Declared Failure Reason:</h4>
                <Badge variant="outline" className="text-xs border-amber-500/30 bg-amber-500/10 text-amber-300">
                  {manifest.failureReason}
                </Badge>
              </div>
            )}

            {Array.isArray(manifest.links) && manifest.links.length > 0 && (
              <div>
                <h4 className="text-xs font-bold text-zinc-300 mb-1">Evidence Links:</h4>
                <div className="space-y-1.5">
                  {manifest.links.map((link: any, idx: number) => {
                    const safe = isSafeHttpUrl(link.url);
                    return (
                      <div
                        key={idx}
                        className="flex items-center justify-between p-2 rounded bg-[#252525] border border-white/5 text-xs"
                      >
                        <span className="text-zinc-300 truncate mr-2">{link.title || `Evidence Link #${idx + 1}`}</span>
                        {safe ? (
                          <a
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-emerald-400 hover:text-emerald-300 flex items-center gap-1 font-mono text-[11px] shrink-0"
                          >
                            <span>Open URL</span>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span className="text-zinc-500 text-[11px] italic">Non-HTTP Link</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="p-2.5 rounded bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-300 flex items-start gap-2">
            <Info className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              <strong>Adjudication Notice:</strong> Client explanations and links above represent submitted claims.
              Review against verifiable milestones and on-chain deliverables before approving or rejecting.
            </span>
          </div>
        </CardContent>
      </Card>

      {/* 2. Active Decision & Signature Collection */}
      {activeDecision ? (
        <Card className="border border-white/10 bg-[#1E1E1E] shadow-lg">
          <CardHeader className="pb-3 border-b border-white/5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                Active Decision Draft #{activeDecision.decisionNonce}
              </CardTitle>
              <div className="flex items-center gap-2">
                <Badge
                  className={`text-xs font-bold ${
                    activeDecision.decision === 1
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'bg-red-500/20 text-red-300 border border-red-500/40'
                  }`}
                >
                  {activeDecision.decision === 1 ? 'APPROVE' : 'REJECT'}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  Status: {activeDecision.status}
                </Badge>
              </div>
            </div>
          </CardHeader>

          <CardContent className="pt-4 space-y-4">
            {/* Confirmed Execution Notice */}
            {activeDecision.status === 'executed' && (
              <div className="p-3.5 rounded-lg bg-emerald-950/30 border border-emerald-500/40 text-xs text-emerald-200 space-y-1.5">
                <div className="flex items-center gap-2 font-semibold text-emerald-300">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                  <span>Decision Confirmed & Executed On-Chain</span>
                </div>
                <p className="text-[11px] text-zinc-300">
                  This protection decision has been confirmed and executed on Sepolia. The on-chain claim status has been finalized.
                </p>
                {activeDecision.executionTxHash && (
                  <div className="pt-1 flex items-center justify-between flex-wrap gap-2 border-t border-emerald-500/20">
                    <span className="text-[11px] text-zinc-400 font-mono">
                      Tx: {shortenAddress(activeDecision.executionTxHash)}
                    </span>
                    <a
                      href={`https://sepolia.etherscan.io/tx/${activeDecision.executionTxHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-emerald-400 hover:text-emerald-300 font-mono text-xs flex items-center gap-1"
                    >
                      <span>View on Sepolia Etherscan</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )}
              </div>
            )}

            {/* Written Rationale */}
            <div>
              <span className="text-[10px] text-zinc-500 uppercase font-bold block mb-1">
                Committee Written Rationale:
              </span>
              <div className="p-3 rounded-lg bg-[#252525] border border-white/5 text-xs text-zinc-200 whitespace-pre-wrap">
                {activeDecision.canonicalReport?.rationale || 'No rationale available.'}
              </div>
            </div>

            {/* Cryptographic Commitment Hashes */}
            <div className="p-3 rounded bg-black/40 border border-white/5 space-y-1 text-[11px] font-mono">
              <div className="flex justify-between items-center text-zinc-400">
                <span>Decision Report Hash:</span>
                <span className="text-zinc-200">{activeDecision.decisionReportHash}</span>
              </div>
              <div className="flex justify-between items-center text-zinc-400">
                <span>Typed Data Hash:</span>
                <span className="text-zinc-200">{activeDecision.typedDataHash}</span>
              </div>
              <div className="flex justify-between items-center text-zinc-400">
                <span>Valid Until:</span>
                <span className="text-zinc-200">
                  {new Date(Number(activeDecision.validUntil) * 1000).toLocaleString()}
                </span>
              </div>
            </div>

            {/* Signatures Progress */}
            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                  <span>Signatures Collected</span>
                  <Badge variant="secondary" className="text-[10px] bg-white/10 text-white font-mono">
                    {activeDecision.signatures?.length || 0} / 2
                  </Badge>
                </h4>

                {hasUserSigned && (
                  <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/40 text-[10px] flex items-center gap-1">
                    <Check className="h-3 w-3" /> You have signed this draft
                  </Badge>
                )}
              </div>

              {/* Signers list */}
              <div className="space-y-2">
                {Array.isArray(activeDecision.signatures) && activeDecision.signatures.length > 0 ? (
                  activeDecision.signatures.map((sig: any, idx: number) => (
                    <div
                      key={sig.id || idx}
                      className="p-3 rounded-lg bg-[#252525] border border-white/5 flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                        <div>
                          <span className="font-mono text-zinc-200">{shortenAddress(sig.signerWallet)}</span>
                          <span className="text-[10px] text-zinc-500 block">
                            {new Date(sig.createdAt).toLocaleTimeString()}
                          </span>
                        </div>
                      </div>
                      <span className="font-mono text-[10px] text-zinc-500">
                        Sig: {sig.signature.slice(0, 10)}…{sig.signature.slice(-8)}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="p-3 rounded bg-zinc-900 border border-white/5 text-xs text-zinc-500 text-center">
                    No signatures collected yet.
                  </div>
                )}
              </div>

              {/* Sign Button */}
              {!hasUserSigned && activeDecision.status === 'collecting' && (
                <div className="pt-2">
                  <Button
                    onClick={handleSignDecision}
                    disabled={isSigning}
                    className="w-full h-9 text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-black flex items-center justify-center gap-1.5"
                  >
                    {isSigning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    <span>Sign Decision Draft (EIP-712)</span>
                  </Button>
                </div>
              )}

              {signingError && (
                <div className="p-2.5 rounded bg-red-950/30 border border-red-500/30 text-xs text-red-300">
                  {signingError}
                </div>
              )}
            </div>

            {/* 3. Execution Section (when 2 signatures available and not yet executed) */}
            {activeDecision.status === 'threshold_ready' && (
              <div className="pt-4 border-t border-white/10 space-y-3">
                <div className="p-3 rounded-lg bg-emerald-950/20 border border-emerald-500/30 text-xs text-emerald-300 flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-emerald-400" />
                  <div>
                    <strong>Threshold Reached (2 of 3 Signatures):</strong> This decision is cryptographically ready
                    for on-chain submission to <code>SynqProtectionCommittee</code>.
                  </div>
                </div>

                <div className="p-2.5 rounded bg-black/30 border border-white/5 text-[11px] text-zinc-400 space-y-1">
                  <p>
                    <strong>Execution Notice:</strong> Submitting this decision executes{' '}
                    <code>submitClaimDecision</code> on-chain. Payout calculation is computed deterministically by the
                    deployed Protection Manager.
                  </p>
                  <p className="text-zinc-500">
                    Approved-claim disbursement from the pool occurs in Phase 3E and is subject to available pool liquidity.
                  </p>
                </div>

                {/* Ambiguous Interruption Warning */}
                {isAmbiguousFailure && (
                  <div className="p-3 rounded-lg border border-amber-500/50 bg-amber-950/40 text-xs text-amber-200 space-y-2">
                    <div className="flex items-center gap-2 font-semibold text-amber-300">
                      <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                      <span>Wallet Provider Disconnected / Unconfirmed Broadcast</span>
                    </div>
                    <p className="text-[11px] text-zinc-300 leading-normal">
                      Your wallet provider disconnected while submitting or awaiting the transaction. It may have already succeeded on Sepolia. Check on-chain status below before attempting any rebroadcast.
                    </p>
                  </div>
                )}

                {/* Primary Action Buttons */}
                {!onChainCheckSuccess && !executionTxHash ? (
                  <div className="space-y-2">
                    <Button
                      onClick={handleExecuteDecision}
                      disabled={isExecuting || isAmbiguousFailure}
                      className="w-full h-10 text-xs font-bold bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/10"
                    >
                      {isExecuting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                      <span>
                        {isExecuting
                          ? 'Submitting to Blockchain…'
                          : isAmbiguousFailure
                            ? 'Verify Status Below Before Rebroadcasting'
                            : 'Broadcast & Execute Decision On-Chain'}
                      </span>
                    </Button>
                  </div>
                ) : (
                  <div className="p-3.5 rounded-lg border border-emerald-500/40 bg-emerald-950/20 text-xs text-emerald-200 space-y-2">
                    <div className="flex items-center gap-2 font-semibold text-emerald-300">
                      <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                      <span>Decision Confirmed & Executed On-Chain</span>
                    </div>
                    <p className="text-[11px] text-zinc-300">
                      This protection decision has been verified and executed on Sepolia.
                    </p>
                    {executionTxHash && (
                      <div className="pt-1 flex items-center justify-between flex-wrap gap-2 border-t border-emerald-500/20">
                        <span className="font-mono text-[11px] text-zinc-400">
                          Tx: {shortenAddress(executionTxHash)}
                        </span>
                        <a
                          href={`https://sepolia.etherscan.io/tx/${executionTxHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-emerald-400 hover:text-emerald-300 font-mono text-xs flex items-center gap-1"
                        >
                          <span>View on Sepolia Etherscan</span>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    )}
                    <div className="pt-2">
                      <Button
                        size="sm"
                        onClick={onDecisionExecuted}
                        className="h-8 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
                      >
                        Complete & Return to Committee Portal
                      </Button>
                    </div>
                  </div>
                )}

                {executionError && !isAmbiguousFailure && (
                  <div className="p-3 rounded bg-red-950/30 border border-red-500/30 text-xs text-red-300 space-y-1">
                    <p>{executionError}</p>
                  </div>
                )}

                {/* Advanced / Troubleshooting Collapsible Section */}
                {!onChainCheckSuccess && !executionTxHash && (
                  <div className="pt-2 border-t border-white/5">
                    <div className="flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => setShowTroubleshooting(!showTroubleshooting)}
                        className="text-[11px] text-zinc-400 hover:text-white flex items-center gap-1 font-mono transition-colors"
                      >
                        {showTroubleshooting ? (
                          <ChevronUp className="h-3 w-3" />
                        ) : (
                          <ChevronDown className="h-3 w-3" />
                        )}
                        <span>
                          {showTroubleshooting
                            ? 'Hide Advanced / Troubleshooting'
                            : 'Advanced / Troubleshooting'}
                        </span>
                      </button>

                      {isAmbiguousFailure && !showTroubleshooting && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px]"
                        >
                          Action Recommended
                        </Badge>
                      )}
                    </div>

                    {(showTroubleshooting || isAmbiguousFailure) && (
                      <div className="p-3.5 rounded-lg border border-amber-500/40 bg-amber-950/20 text-xs text-amber-200 space-y-3 mt-2.5">
                        <div className="flex items-center gap-2 font-semibold text-amber-300">
                          <ShieldCheck className="h-4 w-4 text-amber-400 shrink-0" />
                          <span>Transaction Recovery & Synchronization</span>
                        </div>
                        <p className="text-[11px] text-zinc-300 leading-normal">
                          If your wallet submitted the transaction on Sepolia but connection was interrupted, or if database reconciliation was skipped, verify on-chain status or recover the transaction below.
                        </p>

                        {/* Step A: Check On-Chain Status */}
                        <div className="space-y-1.5 pt-1">
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <span className="text-[11px] text-zinc-400 font-medium">1. Verify Blockchain State:</span>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={handleCheckOnChainStatus}
                              disabled={checkingOnChain}
                              className="h-7 text-xs border-amber-600/50 bg-amber-950/40 text-amber-200 hover:bg-amber-900"
                            >
                              {checkingOnChain ? (
                                <>
                                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> Checking On-Chain…
                                </>
                              ) : (
                                <>
                                  <Search className="mr-1.5 h-3 w-3" /> Check On-Chain Status
                                </>
                              )}
                            </Button>
                          </div>
                          {onChainCheckMessage && (
                            <div
                              className={`rounded p-2 text-[11px] leading-relaxed border ${
                                onChainCheckSuccess
                                  ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300'
                                  : 'border-zinc-700 bg-zinc-900/60 text-zinc-300'
                              }`}
                            >
                              {onChainCheckMessage}
                            </div>
                          )}
                        </div>

                        {/* Step B: Reconcile On-Chain */}
                        <div className="space-y-2 pt-2 border-t border-amber-500/20">
                          <div className="space-y-1">
                            <label className="text-[11px] text-zinc-300 font-medium">
                              2. Transaction Hash (Optional for Event Scan)
                            </label>
                            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                              <Input
                                value={recoveryTxHash}
                                onChange={(e) => setRecoveryTxHash(e.target.value)}
                                placeholder="0x… (leave blank to scan recent events automatically)"
                                className="h-8 text-xs bg-[#202020] border-white/20 text-white placeholder:text-zinc-500 flex-1 font-mono"
                              />
                              <Button
                                size="sm"
                                onClick={() => handleReconcile()}
                                disabled={isReconciling}
                                className="h-8 text-xs bg-amber-600 hover:bg-amber-500 text-white font-medium shrink-0"
                              >
                                {isReconciling ? (
                                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                ) : (
                                  <RefreshCw className="h-3 w-3 mr-1" />
                                )}
                                Reconcile On-Chain
                              </Button>
                            </div>
                            <p className="text-[10px] text-zinc-400">
                              Leave blank to scan verified <code>ClaimDecisionSubmitted</code> events automatically, or paste the mined tx hash.
                            </p>
                          </div>
                          {reconcileError && (
                            <div className="rounded border border-red-500/40 bg-red-950/40 p-2 text-[11px] text-red-300 flex items-center gap-2">
                              <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0" />
                              <span>{reconcileError}</span>
                            </div>
                          )}
                        </div>

                        {isAmbiguousFailure && (
                          <div className="pt-2 border-t border-amber-500/20 flex justify-end">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={handleResetForRetry}
                              className="h-7 text-xs text-zinc-400 hover:text-white"
                            >
                              Reset & Allow Rebroadcast Retry
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Collapsible Typed Data Preview */}
            <div className="pt-2">
              <button
                type="button"
                onClick={() => setShowTypedData(!showTypedData)}
                className="text-[11px] text-zinc-400 hover:text-white flex items-center gap-1 font-mono"
              >
                {showTypedData ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                <span>{showTypedData ? 'Hide EIP-712 Typed Data JSON' : 'View EIP-712 Typed Data JSON'}</span>
              </button>
              {showTypedData && (
                <pre className="mt-2 p-3 rounded bg-black/60 border border-white/5 text-[10px] font-mono text-zinc-300 overflow-x-auto max-h-60">
                  {JSON.stringify(activeDecision.typedData, null, 2)}
                </pre>
              )}
            </div>
          </CardContent>
        </Card>
      ) : isExecutedCase && executedDec ? (
        /* 3. Executed Decision Read-Only View */
        <Card className="border border-white/10 bg-[#1E1E1E] shadow-lg">
          <CardHeader className="pb-3 border-b border-white/5">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-emerald-400" />
                <CardTitle className="text-sm font-bold text-white">
                  Executed Decision Record #{executedDec.decisionNonce}
                </CardTitle>
              </div>
              <Badge
                className={`text-[10px] font-bold ${
                  executedDec.decision === 1
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                    : 'bg-red-500/20 text-red-300 border-red-500/40'
                }`}
              >
                {executedDec.decision === 1 ? 'Approved' : 'Rejected'}
              </Badge>
            </div>
            <CardDescription className="text-xs text-zinc-400">
              Immutable committee adjudication executed and verified on Sepolia.
            </CardDescription>
          </CardHeader>

          <CardContent className="pt-4 space-y-4">
            {/* Written Rationale */}
            <div>
              <span className="text-[10px] text-zinc-500 uppercase font-bold block mb-1">
                Committee Written Rationale:
              </span>
              <div className="p-3.5 rounded-lg bg-[#252525] border border-white/5 text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed">
                {executedDec.canonicalReport?.rationale || 'No rationale recorded.'}
              </div>
            </div>

            {/* Signers Attribution */}
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-500 uppercase font-bold">
                  Verified Committee Signatures (Threshold Met):
                </span>
                <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px] flex items-center gap-1 font-mono">
                  <CheckCircle2 className="h-3 w-3" />
                  <span>2/2 Signatures Verified</span>
                </Badge>
              </div>

              <div className="space-y-1.5">
                {(executedDec.signatures || []).map((sig: any, idx: number) => {
                  const isCurrent = Boolean(address && sig.signerWallet?.toLowerCase() === address.toLowerCase());
                  return (
                    <div
                      key={sig.id || `${sig.signerWallet}-${idx}`}
                      className="flex items-center justify-between rounded-md border border-white/5 bg-[#252525] px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-zinc-200" title={sig.signerWallet}>
                          {sig.signerWallet}
                        </span>
                        {isCurrent && (
                          <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[9px] px-1.5 py-0 font-mono">
                            You
                          </Badge>
                        )}
                      </div>
                      {sig.createdAt && (
                        <div className="flex items-center gap-1 text-[11px] text-zinc-400">
                          <Clock className="h-3 w-3 text-zinc-500" />
                          <span>{new Date(sig.createdAt).toLocaleDateString()}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Execution Details Grid */}
            <div className="p-3.5 rounded-lg border border-white/10 bg-[#252525] text-xs space-y-2">
              <span className="text-[10px] text-zinc-500 uppercase font-bold block">
                On-Chain Execution Verification:
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                <div>
                  <span className="text-zinc-500">Executed At: </span>
                  <span className="text-zinc-300">
                    {executedDec.executedAt ? new Date(executedDec.executedAt).toLocaleString() : 'Executed On-Chain'}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500">Decision Nonce: </span>
                  <span className="font-mono text-zinc-300">#{executedDec.decisionNonce}</span>
                </div>
                {executedDec.executedByWallet && (
                  <div className="sm:col-span-2">
                    <span className="text-zinc-500">Broadcast By: </span>
                    <span className="font-mono text-zinc-300">{executedDec.executedByWallet}</span>
                  </div>
                )}
                {executedDec.executionTxHash && (
                  <div className="sm:col-span-2 flex items-center justify-between flex-wrap gap-2 pt-2 border-t border-white/5">
                    <span className="font-mono text-zinc-400">
                      Tx: {shortenAddress(executedDec.executionTxHash)}
                    </span>
                    <a
                      href={`https://sepolia.etherscan.io/tx/${executedDec.executionTxHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-emerald-400 hover:text-emerald-300 font-mono text-xs flex items-center gap-1"
                    >
                      <span>View on Sepolia Etherscan</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : onChainClaim.status === 1 ? (
        /* 3. Decision Authoring (when no active decision draft exists) */
        <Card className="border border-white/10 bg-[#1E1E1E] shadow-lg">
          <CardHeader className="pb-3 border-b border-white/5">
            <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              Draft Protection Committee Decision
            </CardTitle>
            <CardDescription className="text-xs text-zinc-400">
              Author a binary determination (Approve or Reject) with a mandatory written rationale.
            </CardDescription>
          </CardHeader>

          <CardContent className="pt-4 space-y-4">
            {/* Decision Toggle */}
            <div>
              <span className="text-[10px] text-zinc-500 uppercase font-bold block mb-2">
                Determination Decision:
              </span>
              <div className="grid grid-cols-2 gap-3">
                <Button
                  type="button"
                  variant={decisionChoice === 'APPROVE' ? 'default' : 'outline'}
                  onClick={() => setDecisionChoice('APPROVE')}
                  className={`h-10 text-xs font-bold border ${
                    decisionChoice === 'APPROVE'
                      ? 'bg-emerald-500 hover:bg-emerald-400 text-black border-emerald-500'
                      : 'border-white/10 bg-[#252525] text-zinc-300 hover:bg-neutral-800'
                  }`}
                >
                  <ShieldCheck className="h-4 w-4 mr-1.5" />
                  APPROVE CLAIM
                </Button>

                <Button
                  type="button"
                  variant={decisionChoice === 'REJECT' ? 'default' : 'outline'}
                  onClick={() => setDecisionChoice('REJECT')}
                  className={`h-10 text-xs font-bold border ${
                    decisionChoice === 'REJECT'
                      ? 'bg-red-500 hover:bg-red-400 text-white border-red-500'
                      : 'border-white/10 bg-[#252525] text-zinc-300 hover:bg-neutral-800'
                  }`}
                >
                  <ShieldAlert className="h-4 w-4 mr-1.5" />
                  REJECT CLAIM
                </Button>
              </div>
            </div>

            {/* Written Rationale Textarea */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-zinc-500 uppercase font-bold">
                  Written Determination Rationale (Required):
                </span>
                <span className="text-[10px] text-zinc-500 font-mono">
                  {rationale.length} / 4000
                </span>
              </div>
              <textarea
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                placeholder="State the objective findings, evidence reviews, and reasoning justifying this determination…"
                rows={4}
                maxLength={4000}
                disabled={isSubmittingDraft || confirmDraft}
                className="w-full rounded-xl border border-white/10 bg-[#252525] p-3 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 disabled:cursor-not-allowed disabled:opacity-50 transition-colors resize-y leading-relaxed"
              />
            </div>

            {draftError && (
              <div className="p-2.5 rounded bg-red-950/30 border border-red-500/30 text-xs text-red-300">
                {draftError}
              </div>
            )}

            {/* Stage Confirmation */}
            {confirmDraft ? (
              <div className="p-3 rounded-lg bg-zinc-900 border border-white/10 space-y-3">
                <p className="text-xs text-zinc-200">
                  Are you sure you want to stage this <strong>{decisionChoice}</strong> decision? Once staged, an
                  immutable EIP-712 typed-data commitment will be created for committee signatures.
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={handleStageDraft}
                    disabled={isSubmittingDraft}
                    className="h-8 text-xs font-semibold bg-white text-black hover:bg-zinc-200"
                  >
                    {isSubmittingDraft ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                    Confirm & Create Draft
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmDraft(false)}
                    className="h-8 text-xs text-zinc-400 hover:text-white"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                onClick={() => setConfirmDraft(true)}
                disabled={!rationale.trim()}
                className="w-full h-9 text-xs font-semibold bg-white hover:bg-zinc-200 text-black"
              >
                Stage Decision Draft
              </Button>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* 4. Decision History for this Claim */}
      {historyDecisions.length > 0 && (
        <Card className="border border-white/10 bg-[#1E1E1E]">
          <CardHeader className="pb-3 border-b border-white/5">
            <CardTitle className="text-xs font-bold text-zinc-300 flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 text-zinc-400" /> Decision History for this Claim
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3 space-y-2">
            {historyDecisions.map((dec) => (
              <div
                key={dec.id}
                className="p-3 rounded bg-[#252525] border border-white/5 text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <Badge
                      className={`text-[10px] font-bold ${
                        dec.decision === 1
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-red-500/20 text-red-300'
                      }`}
                    >
                      {dec.decision === 1 ? 'APPROVED' : 'REJECTED'}
                    </Badge>
                    <span className="text-zinc-400 font-mono text-[11px]">Nonce #{dec.decisionNonce}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {dec.status}
                    </Badge>
                  </div>
                  <p className="text-zinc-400 text-[11px] mt-1 line-clamp-1">
                    {dec.canonicalReport?.rationale}
                  </p>
                </div>

                {dec.executionTxHash && (
                  <a
                    href={`https://sepolia.etherscan.io/tx/${dec.executionTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-400 hover:text-emerald-300 flex items-center gap-1 font-mono text-[11px] shrink-0"
                  >
                    <span>Tx: {dec.executionTxHash.slice(0, 10)}…</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
