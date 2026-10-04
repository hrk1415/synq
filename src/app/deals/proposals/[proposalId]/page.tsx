'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAccount, useWriteContract } from 'wagmi';
import { formatUnits, getAddress, isAddress } from 'viem';
import {
  FileSignature,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Ban,
  Clock,
  Coins,
  Layers,
  Copy,
  Check,
  ExternalLink,
  ShieldCheck,
  Info,
  Loader2,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';
import { shortenAddress, normalizeWallet, cn } from '@/lib/utils';
import { synqFactoryV2ABI } from '@/lib/contracts/abis';
import { SYNQ_V2_SEPOLIA_CONFIG, SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { getSepoliaExplorerUrl, sepoliaPublicClient } from '@/lib/chain';
import type { SerializedDealProposal } from '@/lib/deals/proposals-db';
import {
  validateAcceptPreflight,
  validateDeclinePreflight,
  validateCancelPreflight,
  verifyProposalPendingOnChain,
  getAcceptContractArgs,
  getDeclineContractArgs,
  getCancelContractArgs,
} from '@/lib/deals/v2-actions';

export default function DealProposalPage() {
  const params = useParams();
  const router = useRouter();
  const rawProposalId = params?.proposalId as string | undefined;
  const proposalId = rawProposalId?.toLowerCase();

  const { address, isConnected } = useAccount();
  const { ensureAuthenticated } = useAuthSession();
  const { ensureSepolia, networkReady, isSwitching } = useSepoliaNetwork();
  const { writeContractAsync } = useWriteContract();

  const [proposal, setProposal] = useState<SerializedDealProposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Action states
  const [actionInProgress, setActionInProgress] = useState<'accept' | 'decline' | 'cancel' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [unreconciledTxHash, setUnreconciledTxHash] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);

  // Fetch proposal data
  const loadProposal = useCallback(async () => {
    if (!proposalId || !/^0x[0-9a-fA-F]{64}$/.test(proposalId)) {
      setError('Invalid proposal ID format');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      let token: string | undefined;
      try {
        token = await ensureAuthenticated();
      } catch (authErr: any) {
        // Not authenticated yet
      }

      const headers: Record<string, string> = {};
      if (token) {
        headers.authorization = `Bearer ${token}`;
      }

      const res = await fetch(`/api/deals/proposals/${proposalId}`, { headers });
      if (res.status === 401) {
        setError('Please connect your wallet and sign in to view this proposal.');
        return;
      }
      if (res.status === 403) {
        setError('Access restricted: You are not a designated participant (client or freelancer) in this proposal.');
        return;
      }
      if (res.status === 404) {
        setError('Deal proposal not found.');
        return;
      }
      if (!res.ok) {
        throw new Error(`Failed to load proposal (${res.status})`);
      }

      const data = await res.json();
      setProposal(data.proposal);
    } catch (err: any) {
      setError(err?.message || 'Failed to load deal proposal');
    } finally {
      setLoading(false);
    }
  }, [proposalId, ensureAuthenticated]);

  useEffect(() => {
    loadProposal();
  }, [loadProposal]);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  // Role detection
  const normalizedConnected = address ? normalizeWallet(address) : '';
  const isClient = Boolean(proposal && normalizedConnected && normalizedConnected === normalizeWallet(proposal.clientWallet));
  const isFreelancer = Boolean(proposal && normalizedConnected && normalizedConnected === normalizeWallet(proposal.freelancerWallet));
  const isParticipant = isClient || isFreelancer;

  // Stale Deal implementation detection
  const isStaleImplementation = useMemo(() => {
    if (!proposal?.dealImplementation) return false;
    return normalizeWallet(proposal.dealImplementation) !== normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.dealImplementation);
  }, [proposal]);

  // Expiry calculation
  const isExpired = useMemo(() => {
    if (!proposal) return false;
    const now = Math.floor(Date.now() / 1000);
    return now > Number(proposal.expiry);
  }, [proposal]);

  // USDC Amount Formatter
  const formattedUsdc = useMemo(() => {
    if (!proposal) return '0';
    try {
      return formatUnits(BigInt(proposal.totalAmount), 6);
    } catch {
      return proposal.totalAmount;
    }
  }, [proposal]);

  // Expiry Date Formatter
  const formattedExpiry = useMemo(() => {
    if (!proposal) return '—';
    try {
      const expSec = Number(proposal.expiry);
      return new Date(expSec * 1000).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return proposal.expiry;
    }
  }, [proposal]);

  // Reconciliation helper
  const handleReconcile = async (txHash: string) => {
    try {
      setReconciling(true);
      setActionError(null);
      const token = await ensureAuthenticated();

      const res = await fetch(`/api/deals/proposals/${proposalId}/reconcile`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ txHash }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to reconcile status on server');
      }

      setProposal(data.proposal);
      setUnreconciledTxHash(null);
    } catch (err: any) {
      setActionError(err?.message || 'Status reconciliation failed. You can retry syncing without resending the transaction.');
      setUnreconciledTxHash(txHash);
    } finally {
      setReconciling(false);
    }
  };

  // Freelancer Accept Action
  const handleAccept = async () => {
    if (!proposal || !address) return;
    try {
      setActionInProgress('accept');
      setActionError(null);
      await ensureSepolia();

      // 1. Local preflight check
      const preflight = await validateAcceptPreflight(proposal, address);
      if (!preflight.ok) {
        throw new Error(preflight.error);
      }

      // 2. Chain-authoritative preflight check against Factory V2
      const chainPreflight = await verifyProposalPendingOnChain(proposal, sepoliaPublicClient);
      if (!chainPreflight.ok) {
        loadProposal().catch(() => {});
        throw new Error(chainPreflight.error);
      }

      const args = getAcceptContractArgs(proposal);

      // Execute on-chain accept
      const txHash = await writeContractAsync({
        address: SYNQ_V2_SEPOLIA_CONFIG.factory,
        abi: synqFactoryV2ABI,
        functionName: 'acceptDealProposal',
        args,
        chainId: SEPOLIA_CHAIN_ID,
      });

      // Wait for receipt
      await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });

      // Reconcile status with backend
      await handleReconcile(txHash);
    } catch (err: any) {
      setActionError(err?.message || 'Failed to accept proposal');
    } finally {
      setActionInProgress(null);
    }
  };

  // Freelancer Decline Action
  const handleDecline = async () => {
    if (!proposal || !address) return;
    try {
      setActionInProgress('decline');
      setActionError(null);
      await ensureSepolia();

      // 1. Local preflight check
      const preflight = await validateDeclinePreflight(proposal, address);
      if (!preflight.ok) {
        throw new Error(preflight.error);
      }

      // 2. Chain-authoritative preflight check against Factory V2
      const chainPreflight = await verifyProposalPendingOnChain(proposal, sepoliaPublicClient);
      if (!chainPreflight.ok) {
        loadProposal().catch(() => {});
        throw new Error(chainPreflight.error);
      }

      const args = getDeclineContractArgs(proposal);

      // Execute on-chain decline
      const txHash = await writeContractAsync({
        address: SYNQ_V2_SEPOLIA_CONFIG.factory,
        abi: synqFactoryV2ABI,
        functionName: 'declineDealProposal',
        args,
        chainId: SEPOLIA_CHAIN_ID,
      });

      await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });
      await handleReconcile(txHash);
    } catch (err: any) {
      setActionError(err?.message || 'Failed to decline proposal');
    } finally {
      setActionInProgress(null);
    }
  };

  // Client Cancel Action
  const handleCancel = async () => {
    if (!proposal || !address) return;
    try {
      setActionInProgress('cancel');
      setActionError(null);
      await ensureSepolia();

      // 1. Local preflight check
      const preflight = validateCancelPreflight(proposal, address);
      if (!preflight.ok) {
        throw new Error(preflight.error);
      }

      // 2. Chain-authoritative preflight check against Factory V2
      const chainPreflight = await verifyProposalPendingOnChain(proposal, sepoliaPublicClient);
      if (!chainPreflight.ok) {
        loadProposal().catch(() => {});
        throw new Error(chainPreflight.error);
      }

      const args = getCancelContractArgs(proposal);

      // Execute on-chain cancel
      const txHash = await writeContractAsync({
        address: SYNQ_V2_SEPOLIA_CONFIG.factory,
        abi: synqFactoryV2ABI,
        functionName: 'cancelDealProposal',
        args,
        chainId: SEPOLIA_CHAIN_ID,
      });

      await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });
      await handleReconcile(txHash);
    } catch (err: any) {
      setActionError(err?.message || 'Failed to cancel proposal');
    } finally {
      setActionInProgress(null);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center space-y-4">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        <p className="text-sm text-zinc-400">Loading proposal terms…</p>
      </div>
    );
  }

  if (error || !proposal) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <Card className="border-red-500/30 bg-red-950/20 backdrop-blur-md">
          <CardContent className="pt-6 text-center space-y-4">
            <AlertTriangle className="mx-auto h-12 w-12 text-red-400" />
            <h3 className="text-lg font-semibold text-white">Proposal Unavailable</h3>
            <p className="text-sm text-red-200/80">{error || 'Could not load proposal data'}</p>
            <div className="pt-2">
              <Button variant="outline" onClick={() => router.push('/messages')}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Return to Messages
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const status = proposal.cachedStatus || 'PENDING';

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      {/* Top Navigation */}
      <div className="flex items-center justify-between">
        <Link
          href="/messages"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Messages
        </Link>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="border-blue-500/30 bg-blue-500/10 text-xs text-blue-400">
            Standard V2
          </Badge>
          {status === 'PENDING' && (
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-xs text-amber-400">
              Pending Review
            </Badge>
          )}
          {status === 'ACCEPTED' && (
            <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-xs text-emerald-400">
              Accepted — Deal Created
            </Badge>
          )}
          {status === 'DECLINED' && (
            <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 text-xs text-rose-400">
              Declined
            </Badge>
          )}
          {status === 'CANCELLED' && (
            <Badge variant="outline" className="border-zinc-500/40 bg-zinc-500/10 text-xs text-zinc-400">
              Cancelled
            </Badge>
          )}
          {status === 'EXPIRED' && (
            <Badge variant="outline" className="border-zinc-500/40 bg-zinc-500/10 text-xs text-zinc-400">
              Expired
            </Badge>
          )}
        </div>
      </div>

      {/* Hero Header Card */}
      <Card className="border-zinc-800 bg-gradient-to-b from-zinc-900/90 to-zinc-950/90 backdrop-blur-md">
        <CardContent className="pt-6 space-y-4">
          <div className="space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-blue-400">
              Deal Proposal
            </span>
            <h1 className="text-2xl font-bold tracking-tight text-white">
              {proposal.title}
            </h1>
            <p className="text-xs text-zinc-400">
              Created for counterparty review. Before acceptance, no contract exists and no funds move.
            </p>
          </div>

          {/* Quick Metrics Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-3">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-zinc-400">
                <Coins className="h-3.5 w-3.5 text-blue-400" /> Proposed Escrow
              </div>
              <div className="mt-1 text-lg font-bold text-white">
                {formattedUsdc} <span className="text-xs font-normal text-zinc-400">USDC</span>
              </div>
            </div>

            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-3">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-zinc-400">
                <Layers className="h-3.5 w-3.5 text-blue-400" /> Milestones
              </div>
              <div className="mt-1 text-lg font-bold text-white">
                {proposal.milestones.length}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-3">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-zinc-400">
                <Clock className="h-3.5 w-3.5 text-blue-400" /> Proposal Expiry
              </div>
              <div className="mt-1 text-sm font-semibold text-white truncate" title={formattedExpiry}>
                {formattedExpiry}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-3">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-zinc-400">
                <FileSignature className="h-3.5 w-3.5 text-blue-400" /> Your Role
              </div>
              <div className="mt-1 text-sm font-semibold text-white">
                {isClient ? 'Client (Creator)' : isFreelancer ? 'Freelancer' : 'Viewer (Read-Only)'}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Terminal State Banners */}
      {status === 'ACCEPTED' && (
        <Card className="border-emerald-500/30 bg-emerald-950/20 backdrop-blur-md">
          <CardContent className="pt-6 space-y-3">
            <div className="flex items-center gap-2 text-emerald-400 font-semibold text-base">
              <CheckCircle2 className="h-5 w-5" /> Proposal Accepted — Deal Deployed On-Chain
            </div>
            <p className="text-xs text-zinc-300">
              The freelancer accepted the proposal terms and the SynqDealV1 instance was deployed via SynqFactoryV2.
            </p>
            {proposal.dealAddress && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-emerald-500/20 bg-emerald-900/20 p-3">
                <div className="space-y-0.5">
                  <span className="text-[10px] uppercase tracking-wider text-emerald-300">Deployed Deal Contract</span>
                  <div className="font-mono text-xs text-white">{proposal.dealAddress}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-emerald-500/30 hover:bg-emerald-500/20"
                    onClick={() => copyToClipboard(proposal.dealAddress!, 'dealAddress')}
                  >
                    {copiedKey === 'dealAddress' ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
                    Copy
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 text-xs bg-emerald-600 hover:bg-emerald-500 text-white"
                    onClick={() => {
                      if (proposal.dealAddress && isAddress(proposal.dealAddress)) {
                        router.push(`/deals/${proposal.dealAddress}`);
                      }
                    }}
                  >
                    Open Deal <ArrowLeft className="ml-1 h-3 w-3 rotate-180" />
                  </Button>
                </div>
              </div>
            )}
            <p className="text-[11px] text-emerald-300/80">
              Standard V2 Deal deployed. Open Deal to inspect milestone terms and fund escrow with exact canonical Sepolia USDC.
            </p>
          </CardContent>
        </Card>
      )}

      {status === 'DECLINED' && (
        <Card className="border-rose-500/30 bg-rose-950/20 backdrop-blur-md">
          <CardContent className="pt-6 space-y-2">
            <div className="flex items-center gap-2 text-rose-400 font-semibold text-base">
              <XCircle className="h-5 w-5" /> Proposal Declined
            </div>
            <p className="text-xs text-zinc-300">
              This proposal was permanently declined by the freelancer. No Deal contract clone was deployed, no escrow was funded, and no USDC was transferred.
            </p>
          </CardContent>
        </Card>
      )}

      {status === 'CANCELLED' && (
        <Card className="border-zinc-700 bg-zinc-900/40 backdrop-blur-md">
          <CardContent className="pt-6 space-y-2">
            <div className="flex items-center gap-2 text-zinc-300 font-semibold text-base">
              <Ban className="h-5 w-5 text-zinc-400" /> Proposal Cancelled
            </div>
            <p className="text-xs text-zinc-400">
              This proposal was cancelled by the client. The proposal nonce has been invalidated on-chain. No Deal contract was deployed.
            </p>
          </CardContent>
        </Card>
      )}

      {status === 'PENDING' && isExpired && (
        <Card className="border-amber-500/30 bg-amber-950/20 backdrop-blur-md">
          <CardContent className="pt-6 space-y-2">
            <div className="flex items-center gap-2 text-amber-400 font-semibold text-base">
              <Clock className="h-5 w-5" /> Proposal Expired
            </div>
            <p className="text-xs text-zinc-300">
              The expiry timestamp ({formattedExpiry}) has passed. According to Factory V2 contract rules, expired proposals cannot be accepted.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Reconciliation Warning & Recovery */}
      {unreconciledTxHash && (
        <Card className="border-blue-500/40 bg-blue-950/20 backdrop-blur-md">
          <CardContent className="pt-6 space-y-3">
            <div className="flex items-center gap-2 text-blue-400 font-semibold text-sm">
              <Info className="h-4 w-4" /> Transaction Confirmed on Chain
            </div>
            <p className="text-xs text-blue-100/90">
              Your transaction confirmed on Ethereum Sepolia, but Synq is still reconciling the server-side lifecycle state.
            </p>
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                className="h-8 bg-blue-600 hover:bg-blue-500 text-xs"
                onClick={() => handleReconcile(unreconciledTxHash)}
                disabled={reconciling}
              >
                {reconciling ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                Sync Status Now
              </Button>
              <a
                href={getSepoliaExplorerUrl('tx', unreconciledTxHash)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue-300 hover:underline"
              >
                View Transaction <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Action Errors */}
      {actionError && (
        <div className="rounded-xl border border-red-500/30 bg-red-950/30 p-3 text-xs text-red-200">
          {actionError}
        </div>
      )}

      {/* Section 1: Signed On-Chain Terms */}
      <Card className="border-zinc-800 bg-zinc-900/60 backdrop-blur-md">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base text-white flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-400" /> Signed On-Chain Terms
              </CardTitle>
              <p className="text-xs text-zinc-400">
                These terms are cryptographically committed through EIP-712 and cannot be modified.
              </p>
            </div>
            <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-400">
              EIP-712 Bound
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Parties */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Client (Signer)</div>
              <div className="flex items-center justify-between font-mono text-xs text-white">
                <span>{proposal.clientWallet}</span>
                <button
                  type="button"
                  onClick={() => copyToClipboard(proposal.clientWallet, 'client')}
                  className="text-zinc-500 hover:text-zinc-300"
                >
                  {copiedKey === 'client' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Freelancer (Recipient)</div>
              <div className="flex items-center justify-between font-mono text-xs text-white">
                <span>{proposal.freelancerWallet}</span>
                <button
                  type="button"
                  onClick={() => copyToClipboard(proposal.freelancerWallet, 'freelancer')}
                  className="text-zinc-500 hover:text-zinc-300"
                >
                  {copiedKey === 'freelancer' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          </div>

          {/* Milestones List */}
          <div className="space-y-2">
            <div className="text-xs font-semibold text-zinc-300">Milestone Definitions ({proposal.milestones.length})</div>
            <div className="divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-950/40 overflow-hidden">
              {proposal.milestones.map((m, idx) => {
                const amountUsdc = formatUnits(BigInt(m.amount), 6);
                const deadlineDate = new Date(Number(m.workDeadline) * 1000).toLocaleDateString();
                const reviewDays = Number(m.reviewWindow) / 86400;
                const graceDays = Number(m.gracePeriod) / 86400;

                return (
                  <div key={idx} className="p-3.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-500/20 text-[10px] font-bold text-blue-400">
                          {idx + 1}
                        </span>
                        <span className="text-sm font-semibold text-white">
                          {m.title || `Milestone ${idx + 1}`}
                        </span>
                      </div>
                      <span className="font-mono text-sm font-bold text-white">
                        {amountUsdc} <span className="text-xs font-normal text-zinc-400">USDC</span>
                      </span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] text-zinc-400 pt-1">
                      <div>
                        <span className="text-[10px] uppercase text-zinc-500 block">Work Deadline</span>
                        <span className="text-zinc-200">{deadlineDate}</span>
                      </div>
                      <div>
                        <span className="text-[10px] uppercase text-zinc-500 block">Review Window</span>
                        <span className="text-zinc-200">{reviewDays} days</span>
                      </div>
                      <div>
                        <span className="text-[10px] uppercase text-zinc-500 block">Grace Period</span>
                        <span className="text-zinc-200">{graceDays} days</span>
                      </div>
                      <div>
                        <span className="text-[10px] uppercase text-zinc-500 block">Spec Hash</span>
                        <span className="font-mono text-zinc-300 truncate block" title={m.specHash}>
                          {shortenAddress(m.specHash)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Section 2: Proposal Details (Unsigned Application Metadata) */}
      <Card className="border-zinc-800 bg-zinc-900/60 backdrop-blur-md">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base text-white flex items-center gap-2">
                <Info className="h-4 w-4 text-blue-400" /> Proposal Details
              </CardTitle>
              <p className="text-xs text-zinc-400">
                Human-readable project scope and descriptions (Stored durably off-chain).
              </p>
            </div>
            <Badge variant="outline" className="border-zinc-700 bg-zinc-800/40 text-[10px] text-zinc-400">
              Unsigned Metadata
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Scope of Work</span>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap">
              {proposal.scope || 'No written scope of work provided with this proposal.'}
            </div>
          </div>

          {proposal.milestones.some((m) => m.description) && (
            <div className="space-y-2">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Milestone Deliverable Descriptions</span>
              <div className="space-y-2">
                {proposal.milestones.map((m, idx) => m.description ? (
                  <div key={idx} className="rounded-lg border border-zinc-800/60 bg-zinc-950/20 p-2.5 text-xs">
                    <span className="font-medium text-zinc-300 block mb-0.5">{m.title || `Milestone ${idx + 1}`}</span>
                    <p className="text-zinc-400">{m.description}</p>
                  </div>
                ) : null)}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 3: Advanced Cryptographic Details */}
      <Card className="border-zinc-800/70 bg-zinc-950/40">
        <CardHeader className="py-3">
          <CardTitle className="text-xs text-zinc-400 font-semibold uppercase tracking-wider">
            Technical & Cryptographic Proofs
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs font-mono">
          <div className="flex items-center justify-between py-1 border-b border-zinc-900">
            <span className="text-zinc-500">Proposal ID</span>
            <div className="flex items-center gap-1.5 text-zinc-300">
              <span>{proposal.proposalId}</span>
              <button type="button" onClick={() => copyToClipboard(proposal.proposalId, 'propId')} className="text-zinc-500 hover:text-zinc-300">
                {copiedKey === 'propId' ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between py-1 border-b border-zinc-900">
            <span className="text-zinc-500">Milestones Hash</span>
            <div className="flex items-center gap-1.5 text-zinc-300">
              <span>{proposal.milestonesHash}</span>
              <button type="button" onClick={() => copyToClipboard(proposal.milestonesHash, 'mHash')} className="text-zinc-500 hover:text-zinc-300">
                {copiedKey === 'mHash' ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between py-1 border-b border-zinc-900">
            <span className="text-zinc-500">Proposal Nonce</span>
            <span className="text-zinc-300">{proposal.proposalNonce}</span>
          </div>

          <div className="flex items-center justify-between py-1 border-b border-zinc-900">
            <span className="text-zinc-500">Factory V2 Contract</span>
            <a
              href={getSepoliaExplorerUrl('address', proposal.factoryAddress)}
              target="_blank"
              rel="noreferrer"
              className="text-blue-400 hover:underline flex items-center gap-1"
            >
              {proposal.factoryAddress} <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          <div className="flex items-center justify-between py-1">
            <span className="text-zinc-500">Client Signature</span>
            <div className="flex items-center gap-1.5 text-zinc-300">
              <span>{shortenAddress(proposal.clientSignature)}</span>
              <button type="button" onClick={() => copyToClipboard(proposal.clientSignature, 'sig')} className="text-zinc-500 hover:text-zinc-300">
                {copiedKey === 'sig' ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Role-Aware Terminal Actions */}
      {status === 'PENDING' && !isExpired && (
        <Card className="border-zinc-800 bg-zinc-900/90 backdrop-blur-md sticky bottom-4 shadow-2xl">
          <CardContent className="pt-4 pb-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-0.5">
                <span className="text-sm font-semibold text-white">Respond to Proposal</span>
                <p className="text-xs text-zinc-400">
                  {isFreelancer
                    ? 'Accepting will deploy the SynqDealV1 clone on-chain.'
                    : isClient
                    ? 'Cancelling will invalidate this proposal nonce on-chain.'
                    : 'Connect the designated client or freelancer wallet to respond.'}
                </p>
              </div>

              <div className="flex items-center gap-3">
                {!isConnected ? (
                  <Button variant="outline" className="text-xs border-zinc-700" onClick={() => router.push('/settings')}>
                    Connect Wallet to Respond
                  </Button>
                ) : isFreelancer ? (
                  isStaleImplementation ? (
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
                      <span className="text-xs text-amber-400 font-medium">
                        This proposal uses an earlier Deal contract version. Ask the client to create a refreshed proposal.
                      </span>
                      <Button
                        variant="outline"
                        className="border-rose-500/40 text-rose-300 hover:bg-rose-950/40 text-xs h-9 shrink-0"
                        onClick={handleDecline}
                        disabled={actionInProgress !== null}
                      >
                        {actionInProgress === 'decline' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <XCircle className="mr-1.5 h-3.5 w-3.5" />}
                        Decline Proposal
                      </Button>
                    </div>
                  ) : (
                    <>
                      <Button
                        variant="outline"
                        className="border-rose-500/40 text-rose-300 hover:bg-rose-950/40 text-xs h-9"
                        onClick={handleDecline}
                        disabled={actionInProgress !== null}
                      >
                        {actionInProgress === 'decline' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <XCircle className="mr-1.5 h-3.5 w-3.5" />}
                        Decline Proposal
                      </Button>

                      <Button
                        className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs h-9 shadow-lg shadow-emerald-900/30"
                        onClick={handleAccept}
                        disabled={actionInProgress !== null}
                      >
                        {actionInProgress === 'accept' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />}
                        Accept Proposal
                      </Button>
                    </>
                  )
                ) : isClient ? (
                  <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
                    {isStaleImplementation && (
                      <span className="text-xs text-amber-400 font-medium">
                        This proposal uses an earlier Deal contract version. Ask the client to create a refreshed proposal.
                      </span>
                    )}
                    <Button
                      variant="outline"
                      className="border-rose-500/40 text-rose-300 hover:bg-rose-950/40 text-xs h-9 shrink-0"
                      onClick={handleCancel}
                      disabled={actionInProgress !== null}
                    >
                      {actionInProgress === 'cancel' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Ban className="mr-1.5 h-3.5 w-3.5" />}
                      Cancel Proposal
                    </Button>
                  </div>
                ) : (
                  <span className="text-xs text-zinc-500 italic">
                    Connected as third-party viewer ({shortenAddress(address || '')})
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
