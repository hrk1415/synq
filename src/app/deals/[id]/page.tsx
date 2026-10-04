'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ArrowLeft, Shield, CheckCircle, AlertTriangle, Bot, Loader2, Wallet as WalletIcon, KeyRound, Ban, X, Play, Send, ThumbsUp, RotateCcw, Plus, FileText, Sparkles, ArrowRight, Gavel, Scale, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { useDealContract } from '@/hooks/useDealContract';
import { useFactoryContract } from '@/hooks/useFactoryContract';
import { useAccount, useSimulateContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatTokenAmount, shortenAddress, cn, evidenceUrl } from '@/lib/utils';
import { getTokenInfo, SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { nexotiqFactoryABI } from '@/lib/contracts/abis';
import ChainGuard from '@/components/shared/ChainGuard';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';
import { formatUnits, isAddress, parseUnits } from 'viem';
import { deriveDealUX } from '@/lib/deals/deriveDealUX';
import { useSynqIdentities } from '@/hooks/useSynqIdentity';
import { DealLifecycleVisualizer } from '@/components/deals/DealLifecycleVisualizer';
import { DealNextAction } from '@/components/deals/DealNextAction';
import { MilestoneHeaderSummary } from '@/components/deals/MilestoneHeaderSummary';
import { TransactionOverlay } from '@/components/shared/TransactionOverlay';
import { MilestoneCard } from '@/components/deals/MilestoneCard';
import { DealEscrowPanel } from '@/components/deals/DealEscrowPanel';
import { DealCommandCenter } from '@/components/deals/DealCommandCenter';
import { DealOverview } from '@/components/deals/DealOverview';
import { DealDisputePanel } from '@/components/deals/DealDisputePanel';
import { useAuthSession } from '@/hooks/useAuthSession';
import { V2DealDetailView } from '@/components/deals/V2DealDetailView';
import { isSynqV2Deal } from '@/lib/deals/v2-deal';
import { sepoliaPublicClient } from '@/lib/chain';

const dealStatusLabels = ['Draft', 'Active', 'Completed', 'Disputed', 'Cancelled'];
const msStatusLabels = ['Pending', 'In Progress', 'Completed', 'Approved', 'Rejected'];

const ZERO = '0x0000000000000000000000000000000000000000';

type WorkspaceSection = 'overview' | 'escrow' | 'milestones' | 'dispute';

const workspaceSections: { id: WorkspaceSection; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'milestones', label: 'Milestones' },
  { id: 'escrow', label: 'Escrow' },
  { id: 'dispute', label: 'Dispute' },
];

export default function DealDetailPage() {
  const params = useParams();
  const router = useRouter();
  const rawDealAddress = typeof params?.id === 'string' ? params.id : '';
  const dealAddress = isAddress(rawDealAddress) ? (rawDealAddress as `0x${string}`) : undefined;

  const [isV2, setIsV2] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    if (!dealAddress) {
      setIsV2(false);
      return;
    }

    isSynqV2Deal(dealAddress, sepoliaPublicClient)
      .then((v2Result) => {
        if (mounted) {
          setIsV2(v2Result);
        }
      })
      .catch(() => {
        if (mounted) {
          setIsV2(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [dealAddress]);

  if (!dealAddress) {
    return (
      <div className="text-center py-20">
        <AlertTriangle size={40} className="mx-auto text-amber-400 mb-4" />
        <h2 className="text-xl font-bold text-white mb-2">Invalid Deal Address</h2>
        <p className="text-zinc-400 text-sm mb-4">This deal link does not contain a valid EVM address.</p>
        <Button onClick={() => router.push('/deals')}>Back to Deals</Button>
      </div>
    );
  }

  if (isV2 === null) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center space-y-4">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        <p className="text-sm text-zinc-400">Verifying deal protocol version…</p>
      </div>
    );
  }

  if (isV2) {
    return <V2DealDetailView dealAddress={dealAddress} />;
  }

  return <LegacyDealDetailView dealAddress={dealAddress} />;
}

function LegacyDealDetailView({ dealAddress }: { dealAddress: `0x${string}` }) {
  const params = useParams();
  const router = useRouter();
  const { address } = useAccount();
  const rawDealAddress = typeof params.id === 'string' ? params.id : '';
  const deal = useDealContract(dealAddress);
  const factory = useFactoryContract();
  const { ensureAuthenticated } = useAuthSession();
  const { networkReady, isSwitching, ensureSepolia } = useSepoliaNetwork();
  const [activeSection, setActiveSection] = useState<WorkspaceSection>('overview');
  const [actionError, setActionError] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelNotifyTo, setCancelNotifyTo] = useState<string | null>(null);
  const [cancelNotifyRole, setCancelNotifyRole] = useState<string>('seller');
  const cancelHashRef = useRef<string | null>(null);
  const [evidence, setEvidence] = useState('');
  const [msTitle, setMsTitle] = useState('');
  const [msDesc, setMsDesc] = useState('');
  const [msAmount, setMsAmount] = useState('');
  const [msError, setMsError] = useState('');
  const [activeForm, setActiveForm] = useState<'ms' | null>(null);
  const [verifications, setVerifications] = useState<Record<string, any>>({});
  const [verifying, setVerifying] = useState<string | null>(null);
  const [submitPending, setSubmitPending] = useState(false);
  const [submitAfterHash, setSubmitAfterHash] = useState<string | null>(null);
  const [submitMeta, setSubmitMeta] = useState({ title: '', amount: '', buyer: '', evidence: '', milestone: 0 });
  const [approvePending, setApprovePending] = useState(false);
  const [approveAfterHash, setApproveAfterHash] = useState<string | null>(null);
  const [approveMeta, setApproveMeta] = useState({
    milestone: 0,
    seller: '',
    buyer: '',
    amount: '',
    dealTitle: '',
    dealAmount: '',
    completesDeal: false,
  });
  const [autoSubmit, setAutoSubmit] = useState<{ i: number; afterHash: string | null; evidence: string } | null>(null);
  const [disputeFormOpen, setDisputeFormOpen] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');
  const [disputeActionPending, setDisputeActionPending] = useState(false);
  const [disputeActionAfterHash, setDisputeActionAfterHash] = useState<string | null>(null);
  const [disputeActionConfirmed, setDisputeActionConfirmed] = useState(false);
  const [forceResolvePending, setForceResolvePending] = useState(false);
  const [forceResolveAfterHash, setForceResolveAfterHash] = useState<string | null>(null);
  const [forceResolveConfirmed, setForceResolveConfirmed] = useState(false);
  const [pendingActionTitle, setPendingActionTitle] = useState<string>('Transaction Pending...');

  const sendNotification = useCallback(async (payload: Record<string, unknown>) => {
    try {
      const token = await ensureAuthenticated();
      await fetch('/api/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      // Notifications remain secondary to the confirmed on-chain Deal action.
    }
  }, [ensureAuthenticated]);

  // The receipt hook stays isSuccess for older txs, so wait for a NEW hash
  // before emailing — otherwise a previous transaction would trigger it.
  useEffect(() => {
    if (!cancelNotifyTo || !deal.txReceipt.isSuccess) return;
    const hash = deal.txReceipt.data?.transactionHash ? String(deal.txReceipt.data.transactionHash) : null;
    if (hash && hash !== cancelHashRef.current) {
      const recipient = cancelNotifyTo;
      const role = cancelNotifyRole;
      setCancelNotifyTo(null);
      cancelHashRef.current = null;
      void sendNotification({
        event: 'deal_cancelled',
        recipientWallet: recipient,
        recipientName: role,
        dealTitle: String(deal.title || ''),
        dealAmount: deal.totalValue ? fmt(deal.totalValue) : '',
      });
    }
  }, [cancelNotifyTo, cancelNotifyRole, deal.txReceipt.isSuccess, deal.txReceipt.data, deal.title, deal.totalValue, sendNotification]);

  const tokenApprove = useWriteContract();
  const approveReceipt = useWaitForTransactionReceipt({ hash: tokenApprove.data, chainId: SEPOLIA_CHAIN_ID });

  const isAnyTxPending = deal.isPending || factory.isPending || tokenApprove.isPending || submitPending || approvePending || disputeActionPending || forceResolvePending;

  const assetAddress = String(deal.asset || ZERO);
  const token = getTokenInfo('sepolia', assetAddress);
  const isToken = assetAddress !== ZERO;
  const isBuyer = !!address && !!deal.buyer && address.toLowerCase() === String(deal.buyer).toLowerCase();
  const isSeller = !!address && !!deal.seller && address.toLowerCase() === String(deal.seller).toLowerCase();
  const isParty = isBuyer || isSeller;

  const participantWallets = useMemo(() => {
    const list: string[] = [];
    if (deal.buyer) list.push(String(deal.buyer));
    if (deal.seller) list.push(String(deal.seller));
    return list;
  }, [deal.buyer, deal.seller]);

  const { identitiesMap: participantIdentities } = useSynqIdentities(participantWallets);
  const buyerIdentity = deal.buyer ? participantIdentities[String(deal.buyer).toLowerCase()] : undefined;
  const sellerIdentity = deal.seller ? participantIdentities[String(deal.seller).toLowerCase()] : undefined;
  const buyerHandle = buyerIdentity?.displayHandle || null;
  const sellerHandle = sellerIdentity?.displayHandle || null;
  const statusNum = Number(deal.status);
  const statusLabel = dealStatusLabels[statusNum] || 'Unknown';
  const isActive = statusNum === 1;
  const isDisputed = statusNum === 3;
  const isAdmin = !!address
    && !!factory.feeCollector
    && address.toLowerCase() === String(factory.feeCollector).toLowerCase();
  const { data: forceResolveSimulation, error: forceResolveSimError, isPending: forceResolveSimPending } = useSimulateContract({
    address: factory.factoryAddress,
    abi: nexotiqFactoryABI,
    functionName: 'forceResolve',
    args: dealAddress && isDisputed ? [dealAddress, 'release_to_seller'] : undefined,
    chainId: SEPOLIA_CHAIN_ID,
    query: { enabled: !!dealAddress && isDisputed && isAdmin },
  });
  const supportsForceResolve = !!forceResolveSimulation?.request && !forceResolveSimError;
  const roleLabel = !address
    ? 'Disconnected'
    : isBuyer && isSeller
      ? 'Buyer & Seller'
      : isBuyer
        ? 'Buyer'
        : isSeller
          ? 'Seller'
          : 'Viewer';
  const funded = !!deal.escrowBalance && !!deal.totalValue && BigInt(String(deal.escrowBalance)) >= BigInt(String(deal.totalValue));
  const fmt = (raw: unknown) => {
    if (!token) return '-';
    if (raw === undefined || raw === null || raw === '') return '0 ' + token.symbol;
    let b: bigint;
    try {
      b = BigInt(String(raw));
    } catch {
      b = 0n;
    }
    return `${formatTokenAmount(b, token.decimals)} ${token.symbol}`;
  };
  const msList = (deal.milestones || []) as any[];
  const dispute = (deal.dispute || {}) as {
    openedBy?: string;
    reason?: string;
    aiSummary?: string;
    aiRecommendation?: string;
    buyerApproved?: boolean;
    sellerApproved?: boolean;
  };
  const buyerApproved = dispute.buyerApproved === true;
  const sellerApproved = dispute.sellerApproved === true;
  const bothApproved = buyerApproved && sellerApproved;
  const partyAlreadyApproved = isBuyer && isSeller
    ? buyerApproved && sellerApproved
    : isBuyer
      ? buyerApproved
      : isSeller
        ? sellerApproved
        : false;
  const hasDisputeRecord = (!!dispute.openedBy && dispute.openedBy !== ZERO) || !!dispute.reason;
  const progress = msList.length > 0
    ? Math.round(msList.filter((m: any) => m.msStatus === 3).length / msList.length * 100)
    : 0;
  const txHashNow = () => deal.txReceipt.data?.transactionHash ? String(deal.txReceipt.data.transactionHash) : null;
  const factoryTxHashNow = () => factory.txReceipt.data?.transactionHash ? String(factory.txReceipt.data.transactionHash) : null;
  const verificationKey = (index: number) => `${dealAddress?.toLowerCase() ?? ''}:${index}`;

  const uxState = deriveDealUX(address, {
    status: statusNum,
    buyer: String(deal.buyer || ''),
    seller: String(deal.seller || ''),
    totalValue: deal.totalValue ? BigInt(String(deal.totalValue)) : 0n,
    escrowBalance: deal.escrowBalance ? BigInt(String(deal.escrowBalance)) : 0n,
    milestones: msList,
    dispute,
  });

  const totalDealValueWei = deal.totalValue ? BigInt(String(deal.totalValue)) : 0n;
  const totalAllocatedWei = msList.reduce((sum: bigint, m: any) => sum + BigInt(String(m.amount || 0)), 0n);
  const remainingAllocationWei = totalDealValueWei > totalAllocatedWei ? totalDealValueWei - totalAllocatedWei : 0n;
  const isFullyAllocated = totalDealValueWei > 0n && totalAllocatedWei >= totalDealValueWei;

  let parsedMsAmountWei: bigint | null = null;
  let msAmountValidationReason: string | null = null;

  if (msAmount.trim()) {
    if (!token) {
      msAmountValidationReason = 'Unsupported asset.';
    } else {
      try {
        const parsed = parseUnits(msAmount.trim(), token.decimals);
        if (parsed <= 0n) {
          msAmountValidationReason = 'Amount must be greater than zero.';
        } else if (parsed > remainingAllocationWei) {
          msAmountValidationReason = `Milestone allocation exceeds the deal total. Remaining: ${formatTokenAmount(remainingAllocationWei, token.decimals)} ${token.symbol}.`;
        } else {
          parsedMsAmountWei = parsed;
        }
      } catch {
        msAmountValidationReason = 'Enter a valid milestone amount.';
      }
    }
  }

  const isAddMilestoneValid =
    !isFullyAllocated &&
    !!msTitle.trim() &&
    !!msDesc.trim() &&
    !!msAmount.trim() &&
    parsedMsAmountWei !== null &&
    parsedMsAmountWei > 0n &&
    parsedMsAmountWei <= remainingAllocationWei &&
    !msAmountValidationReason &&
    !deal.isPending;

  const scrollToTarget = (primaryId: string, fallbackId?: string) => {
    const doScroll = () => {
      const el = document.getElementById(primaryId) || (fallbackId ? document.getElementById(fallbackId) : null);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    const immediateEl = document.getElementById(primaryId) || (fallbackId ? document.getElementById(fallbackId) : null);
    if (immediateEl) {
      immediateEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      setTimeout(doScroll, 60);
    }
  };

  const handleTriggerPrimaryAction = (action: string, milestoneIndex: number | null) => {
    switch (action) {
      case 'ADD_MILESTONE':
        setActiveSection('milestones');
        setMsError('');
        setActiveForm('ms');
        scrollToTarget('add-milestone-form', 'milestones-section');
        break;
      case 'FUND_ESCROW':
        setActiveSection('escrow');
        scrollToTarget('escrow-section');
        break;
      case 'START_MILESTONE':
      case 'SUBMIT_MILESTONE':
      case 'APPROVE_MILESTONE':
        setActiveSection('milestones');
        {
          const targetId = milestoneIndex !== null ? `milestone-card-${milestoneIndex}` : 'milestones-section';
          scrollToTarget(targetId, 'milestones-section');
        }
        break;
      case 'DISPUTE_ACTION':
        setActiveSection('dispute');
        scrollToTarget('dispute-section');
        break;
      case 'CONNECT_WALLET':
        break;
    }
  };

  const runDisputeAction = (action: () => void) => {
    setDisputeActionAfterHash(txHashNow());
    setDisputeActionConfirmed(false);
    setDisputeActionPending(true);
    action();
  };

  const runForceResolve = (resolution: 'release_to_seller' | 'refund_buyer') => {
    if (!dealAddress) return;
    setForceResolveAfterHash(factoryTxHashNow());
    setForceResolveConfirmed(false);
    setForceResolvePending(true);
    factory.forceResolve(dealAddress, resolution);
  };

  const submitWork = (index: number, evidenceHash: string, isRevision = false) => {
    setPendingActionTitle(isRevision ? 'Submitting revision...' : 'Submitting work...');
    setSubmitAfterHash(txHashNow());
    setSubmitPending(true);
    setSubmitMeta({
      title: String(deal.title || ''),
      amount: fmt(deal.totalValue),
      buyer: String(deal.buyer || ''),
      evidence: evidenceHash,
      milestone: index,
    });
    deal.submitMilestone(BigInt(index), evidenceHash);
  };

  const startAndSubmit = (index: number, evidenceHash: string) => {
    setPendingActionTitle('Submitting work...');
    setAutoSubmit({ i: index, afterHash: txHashNow(), evidence: evidenceHash });
    deal.startMilestone(BigInt(index));
  };

  const approveAndRelease = (index: number, amount: unknown) => {
    setPendingActionTitle('Releasing milestone payment...');
    setApproveAfterHash(txHashNow());
    setApprovePending(true);
    setApproveMeta({
      milestone: index,
      seller: String(deal.seller || ''),
      buyer: String(deal.buyer || ''),
      amount: fmt(amount),
      dealTitle: String(deal.title || ''),
      dealAmount: fmt(deal.totalValue),
      completesDeal: index === msList.length - 1,
    });
    deal.approveMilestone(BigInt(index));
  };

  const addMilestone = () => {
    setMsError('');
    if (!msTitle.trim() || !msDesc.trim() || !msAmount.trim()) {
      setMsError('Title, description, and amount are required.');
      return;
    }
    if (!token) {
      setMsError('This Deal uses an unsupported asset.');
      return;
    }
    try {
      const amount = parseUnits(msAmount.trim(), token.decimals);
      if (amount <= 0n) throw new Error('Amount must be greater than zero.');
      const allocated = msList.reduce((sum: bigint, milestone: any) => sum + BigInt(String(milestone.amount || 0)), 0n);
      const total = BigInt(String(deal.totalValue || 0));
      if (allocated + amount > total) {
        const remaining = total > allocated ? total - allocated : 0n;
        setMsError(`Milestone allocation exceeds the deal total. Remaining: ${formatTokenAmount(remaining, token.decimals)} ${token.symbol}.`);
        return;
      }
      setPendingActionTitle('Adding milestone...');
      deal.addMilestone(
        msTitle.trim(),
        msDesc.trim(),
        amount,
        BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
      );
      setMsTitle('');
      setMsDesc('');
      setMsAmount('');
      setActiveForm(null);
    } catch (error) {
      setMsError(error instanceof Error ? error.message : 'Invalid milestone amount.');
    }
  };

  const loadVerification = async (index: number, milestone: any) => {
    const key = verificationKey(index);
    if (!dealAddress || !milestone?.evidenceHash || verifications[key] || verifying === key) return;
    try {
      setVerifying(key);
      const response = await fetch(`/api/escrow-verify?dealAddress=${encodeURIComponent(dealAddress)}&milestoneId=${index}`);
      const result = await response.json();
      if (result?.verification) setVerifications((current) => ({ ...current, [key]: result.verification }));
    } catch {
      // A missing stored verification is non-fatal; the buyer can run one manually.
    } finally {
      setVerifying((current) => current === key ? null : current);
    }
  };

  const runAiVerify = async (index: number, milestone: any) => {
    const key = verificationKey(index);
    if (!dealAddress || verifying === key) return;
    try {
      setVerifying(key);
      const token = await ensureAuthenticated();
      const response = await fetch('/api/escrow-verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          dealAddress,
          milestoneId: index,
          title: String(milestone.title || ''),
          description: String(milestone.description || ''),
          evidenceHash: String(milestone.evidenceHash || ''),
        }),
      });
      const result = await response.json();
      if (result?.verification) setVerifications((current) => ({ ...current, [key]: result.verification }));
    } catch {
      setMsError('AI evidence verification failed.');
    } finally {
      setVerifying((current) => current === key ? null : current);
    }
  };

  useEffect(() => {
    if (!autoSubmit || !deal.txReceipt.isSuccess) return;
    const hash = txHashNow();
    if (hash && hash !== autoSubmit.afterHash) {
      const pending = autoSubmit;
      setAutoSubmit(null);
      submitWork(pending.i, pending.evidence || `ipfs://${Math.random().toString(36).slice(2, 10)}`);
    }
  }, [autoSubmit, deal.txReceipt.isSuccess, deal.txReceipt.data]);

  useEffect(() => {
    if (!submitPending || !deal.txReceipt.isSuccess) return;
    const hash = txHashNow();
    if (hash && hash !== submitAfterHash) {
      setSubmitPending(false);
      void sendNotification({
        event: 'work_submitted',
        recipientWallet: submitMeta.buyer,
        recipientName: 'buyer',
        dealTitle: submitMeta.title,
        dealAmount: submitMeta.amount,
        evidence: submitMeta.evidence || undefined,
        note: `Milestone ${submitMeta.milestone + 1}`,
      });
    }
  }, [submitPending, submitAfterHash, submitMeta, deal.txReceipt.isSuccess, deal.txReceipt.data, sendNotification]);

  useEffect(() => {
    if (!approvePending || !deal.txReceipt.isSuccess) return;
    const hash = txHashNow();
    if (!hash || hash === approveAfterHash) return;
    setApprovePending(false);

    void sendNotification({
      event: 'payment_released',
      recipientWallet: approveMeta.seller,
      recipientName: 'seller',
      dealTitle: approveMeta.dealTitle,
      dealAmount: approveMeta.amount,
      note: `Milestone ${approveMeta.milestone + 1}`,
    });

    if (approveMeta.completesDeal) {
      void sendNotification({
        event: 'deal_completed',
        recipientWallet: approveMeta.buyer,
        recipientName: 'buyer',
        dealTitle: approveMeta.dealTitle,
        dealAmount: approveMeta.dealAmount,
      });
      void sendNotification({
        event: 'deal_completed_seller',
        recipientWallet: approveMeta.seller,
        recipientName: 'seller',
        dealTitle: approveMeta.dealTitle,
        dealAmount: approveMeta.dealAmount,
      });
    }
  }, [approvePending, approveAfterHash, approveMeta, deal.txReceipt.isSuccess, deal.txReceipt.data, sendNotification]);

  useEffect(() => {
    msList.forEach((milestone: any, index: number) => {
      if (Number(milestone.msStatus) === 2 && milestone.evidenceHash) void loadVerification(index, milestone);
    });
  }, [dealAddress, deal.milestones]);

  useEffect(() => {
    if (!disputeActionPending || !deal.txReceipt.isSuccess) return;
    const hash = txHashNow();
    if (hash && hash !== disputeActionAfterHash) {
      setDisputeActionPending(false);
      setDisputeActionConfirmed(true);
    }
  }, [disputeActionPending, disputeActionAfterHash, deal.txReceipt.isSuccess, deal.txReceipt.data]);

  useEffect(() => {
    if (!forceResolvePending || !factory.txReceipt.isSuccess) return;
    const hash = factoryTxHashNow();
    if (hash && hash !== forceResolveAfterHash) {
      setForceResolvePending(false);
      setForceResolveConfirmed(true);
      deal.refetchAll();
    }
  }, [forceResolvePending, forceResolveAfterHash, factory.txReceipt.isSuccess, factory.txReceipt.data, deal.refetchAll]);

  useEffect(() => {
    setDisputeFormOpen(false);
    setDisputeReason('');
    setDisputeActionPending(false);
    setDisputeActionConfirmed(false);
    setForceResolvePending(false);
    setForceResolveConfirmed(false);
  }, [dealAddress]);

  if (!dealAddress) {
    return (
      <div className="text-center py-20">
        <AlertTriangle size={40} className="mx-auto text-amber-400 mb-4" />
        <h2 className="text-xl font-bold text-white mb-2">Invalid Deal Address</h2>
        <p className="text-zinc-400 text-sm mb-4">This deal link does not contain a valid EVM address.</p>
        <Button onClick={() => router.push('/deals')}>Back to Deals</Button>
      </div>
    );
  }

  if (deal.title === undefined) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-blue-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <TransactionOverlay open={isAnyTxPending} title={pendingActionTitle} />
      <ChainGuard what="Deal transactions are" />
      <button onClick={() => router.back()} className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors">
        <ArrowLeft size={16} /> Back to Deals
      </button>

      <DealCommandCenter
        dealAddress={dealAddress as `0x${string}`}
        title={String(deal.title || '')}
        description={String(deal.description || '')}
        statusNum={statusNum}
        statusLabel={statusLabel}
        uxState={uxState}
        msList={msList}
        formattedTotalValue={fmt(deal.totalValue)}
        deadlineTimestamp={Number(deal.deadline || 0)}
        buyerAddress={String(deal.buyer || '')}
        sellerAddress={String(deal.seller || '')}
        isPendingTx={deal.isPending}
        onTriggerPrimaryAction={handleTriggerPrimaryAction}
      />

      <div className="flex gap-1 overflow-x-auto rounded-xl border border-zinc-800/70 bg-zinc-900/30 p-1">
        {workspaceSections.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => setActiveSection(section.id)}
            className={cn(
              'min-w-fit rounded-lg px-4 py-2 text-sm font-medium transition-colors',
              activeSection === section.id
                ? 'bg-blue-600/15 text-blue-300 border border-blue-500/30 font-semibold'
                : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200',
            )}
          >
            {section.label}
          </button>
        ))}
      </div>

      {activeSection === 'overview' ? (
        <DealOverview
          uxState={uxState}
          dealAddress={dealAddress as `0x${string}`}
          title={String(deal.title || '')}
          description={String(deal.description || '')}
          statusNum={statusNum}
          statusLabel={statusLabel}
          buyerAddress={String(deal.buyer || '')}
          sellerAddress={String(deal.seller || '')}
          buyerHandle={buyerHandle}
          sellerHandle={sellerHandle}
          formattedTotalValue={fmt(deal.totalValue)}
          formattedEscrowBalance={fmt(deal.escrowBalance)}
          formattedReleasedAmount={fmt(uxState.financial.releasedAmount)}
          deadlineTimestamp={Number(deal.deadline || 0)}
          riskScore={(deal.riskScore as number | bigint) || 0}
          protectionEnabled={Boolean(deal.protectionEnabled)}
          tokenInfo={token ?? null}
          isToken={isToken}
          msList={msList}
          isBuyer={isBuyer}
          isSeller={isSeller}
          isActive={statusNum === 1}
          isParty={isBuyer || isSeller}
          onNavigateSection={(sec) => setActiveSection(sec)}
          onCancelClick={() => {
            setActionError('');
            setConfirmCancel(true);
          }}
        />
      ) : activeSection === 'escrow' ? (
        <div id="escrow-section" className="space-y-6">
          <DealEscrowPanel
            uxState={uxState}
            dealAddress={dealAddress}
            statusNum={statusNum}
            statusLabel={statusLabel}
            isBuyer={isBuyer}
            isSeller={isSeller}
            isActive={isActive}
            tokenInfo={token ?? null}
            isToken={isToken}
            assetAddress={assetAddress}
            formattedTotalValue={fmt(deal.totalValue)}
            formattedEscrowBalance={fmt(deal.escrowBalance)}
            formattedReleasedAmount={fmt(uxState.financial.releasedAmount)}
            milestones={msList}
            networkReady={networkReady}
            isSwitching={isSwitching}
            isPendingTx={deal.isPending}
            isTokenApprovePending={tokenApprove.isPending || approveReceipt.isLoading}
            isApproveSuccess={approveReceipt.isSuccess}
            actionError={actionError}
            onApproveToken={async () => {
              setActionError('');
              setPendingActionTitle('Approving token allowance...');
              try {
                await ensureSepolia();
                await tokenApprove.writeContractAsync({
                  address: assetAddress as `0x${string}`,
                  abi: [{ inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], name: 'approve', outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable', type: 'function' } as const],
                  functionName: 'approve',
                  args: [dealAddress, BigInt(String(deal.totalValue))],
                });
              } catch (error) {
                setActionError(error instanceof Error ? error.message : 'Approval failed');
              }
            }}
            onFundEscrow={() => {
              setActionError('');
              setPendingActionTitle('Funding escrow...');
              if (isToken) {
                deal.fundEscrow(BigInt(0));
              } else {
                deal.fundEscrow(BigInt(String(deal.totalValue)));
              }
            }}
            onCancelClick={() => { setActionError(''); setConfirmCancel(true); }}
            onNavigateSection={(sec) => setActiveSection(sec)}
          />

          {confirmCancel && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
              onClick={() => setConfirmCancel(false)}
            >
              <div className="w-full max-w-sm rounded-2xl border border-zinc-700/50 bg-zinc-900 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <div className="mb-3 flex items-center gap-2">
                  <AlertTriangle size={18} className="text-red-400" />
                  <h3 className="font-semibold text-white">Cancel this deal?</h3>
                </div>
                <p className="mb-1 text-sm text-zinc-400">
                  {BigInt(String(deal.escrowBalance || 0)) > 0n
                    ? `Any escrow balance (~${fmt(deal.escrowBalance)}) will be refunded back to the buyer's wallet.`
                    : 'The deal will be marked as Cancelled on-chain.'}
                </p>
                <p className="mb-4 text-xs text-zinc-500">This action cannot be undone. The {isBuyer ? 'seller' : 'buyer'} will see the deal as cancelled.</p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1 gap-1" onClick={() => setConfirmCancel(false)} disabled={deal.isPending}>
                    <X size={14} /> Keep Deal
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="flex-1 gap-1"
                    disabled={!networkReady || isSwitching || deal.isPending}
                    onClick={() => {
                      setActionError('');
                      setConfirmCancel(false);
                      setPendingActionTitle('Cancelling deal...');
                      cancelHashRef.current = deal.txReceipt.data?.transactionHash ? String(deal.txReceipt.data.transactionHash) : null;
                      const counterparty = isBuyer ? String(deal.seller || '') : String(deal.buyer || '');
                      const role = isBuyer ? 'seller' : 'buyer';
                      setCancelNotifyTo(counterparty);
                      setCancelNotifyRole(role);
                      deal.cancelDeal();
                    }}
                  >
                    {deal.isPending ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />}
                    {deal.isPending ? 'Cancelling...' : 'Yes, Cancel Deal'}
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </div>
      ) : activeSection === 'milestones' ? (
        <div id="milestones-section" className="space-y-6">
          {/* Milestone Header Summary Bar */}
          <MilestoneHeaderSummary
            totalCount={msList.length}
            approvedCount={msList.filter((m: any) => Number(m.msStatus) === 3).length}
            submittedCount={msList.filter((m: any) => Number(m.msStatus) === 2).length}
            inProgressCount={msList.filter((m: any) => Number(m.msStatus) === 1).length}
            pendingCount={msList.filter((m: any) => Number(m.msStatus) === 0).length}
            totalAllocatedText={fmt(msList.reduce((sum: bigint, m: any) => sum + BigInt(String(m.amount || 0)), 0n))}
            totalReleasedText={fmt(uxState.financial.releasedAmount)}
            totalValueText={fmt(deal.totalValue)}
          />

          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0 pb-4">
              <div>
                <CardTitle className="text-lg font-bold text-white">Project Work Milestones</CardTitle>
                <CardDescription className="text-xs text-zinc-400 mt-0.5">
                  Track agreed deliverables, work execution, evidence review, and payment releases.
                </CardDescription>
              </div>
              {isBuyer && isActive && activeForm !== 'ms' && (
                <Button size="sm" className="shrink-0 gap-1.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs" onClick={() => { setMsError(''); setActiveForm('ms'); }}>
                  <Plus size={14} /> Add Milestone
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Progress bar */}
              <div className="space-y-2">
                <Progress value={progress} />
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
                  <span>{progress}% of agreement value released</span>
                  <span>{msList.filter((m: any) => Number(m.msStatus) === 3).length} of {msList.length} milestones approved</span>
                </div>
              </div>

              {/* Add Milestone Form */}
              {activeForm === 'ms' && isBuyer && isActive && (
                <div id="add-milestone-form" className="space-y-3.5 rounded-xl border border-blue-500/30 bg-blue-950/20 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-bold text-white uppercase tracking-wider">Add Project Milestone</p>
                    <Button size="icon" variant="ghost" className="h-6 w-6 text-zinc-400 hover:text-white" onClick={() => { setActiveForm(null); setMsError(''); }} aria-label="Close milestone form">
                      <X size={14} />
                    </Button>
                  </div>

                  {isFullyAllocated ? (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-950/30 p-3 space-y-1">
                      <p className="text-xs font-semibold text-amber-400">Deal value fully allocated</p>
                      <p className="text-xs text-amber-200/80">
                        All {fmt(deal.totalValue)} has already been assigned to milestones.
                      </p>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between text-xs text-zinc-400 bg-zinc-950/60 p-2.5 rounded-lg border border-zinc-800 font-mono">
                      <span>Allocation Context:</span>
                      <span className="text-zinc-200">
                        Allocated: {fmt(totalAllocatedWei)} / Total: {fmt(totalDealValueWei)} (Remaining: {fmt(remainingAllocationWei)})
                      </span>
                    </div>
                  )}

                  <Input value={msTitle} onChange={(event) => setMsTitle(event.target.value)} placeholder="Milestone title (e.g. Frontend Implementation)" className="bg-zinc-950/80 border-zinc-800 text-xs" disabled={isFullyAllocated} />
                  <Input value={msDesc} onChange={(event) => setMsDesc(event.target.value)} placeholder="Detailed deliverables description" className="bg-zinc-950/80 border-zinc-800 text-xs" disabled={isFullyAllocated} />
                  <Input value={msAmount} onChange={(event) => setMsAmount(event.target.value)} placeholder={`Amount in ${token?.symbol ?? 'asset'}`} inputMode="decimal" className="bg-zinc-950/80 border-zinc-800 text-xs font-mono" disabled={isFullyAllocated} />

                  {msAmount.trim() !== '' && msAmountValidationReason && !isFullyAllocated && (
                    <div className="rounded-lg border border-red-500/20 bg-red-600/10 p-2.5 text-xs text-red-400">
                      {msAmountValidationReason}
                    </div>
                  )}

                  <p className="text-[11px] text-zinc-500">Default due date set to 30 days from creation.</p>
                  <div className="flex justify-end gap-2 pt-1">
                    <Button size="sm" variant="outline" className="text-xs" onClick={() => { setActiveForm(null); setMsError(''); }}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className="gap-1.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs"
                      disabled={!isAddMilestoneValid}
                      onClick={addMilestone}
                    >
                      {deal.isPending ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                      Create Milestone
                    </Button>
                  </div>
                </div>
              )}

              {msError && (
                <div className="rounded-lg border border-red-500/20 bg-red-600/10 p-3 text-xs text-red-400">{msError}</div>
              )}

              {/* Zero Milestones Empty State */}
              {msList.length === 0 ? (
                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-8 text-center space-y-3">
                  <FileText size={32} className="mx-auto text-zinc-500" />
                  <h3 className="text-base font-semibold text-white">No milestones defined yet</h3>
                  <p className="text-xs text-zinc-400 max-w-md mx-auto">
                    {isActive && isBuyer
                      ? 'Break this deal into clear pieces of work, each with its own deliverable description, allocation amount, and due date.'
                      : isActive && isSeller
                        ? 'The client hasn\'t defined the work milestones yet. Once added, you will be able to start and submit work here.'
                        : `Milestone operations are unavailable while this Deal is ${statusLabel}.`}
                  </p>
                  {isActive && isBuyer && (
                    <Button size="sm" className="gap-1.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs mt-2" onClick={() => { setMsError(''); setActiveForm('ms'); }}>
                      <Plus size={14} /> Add First Milestone
                    </Button>
                  )}
                </div>
              ) : (
                /* Multi-Milestone List */
                <div className="space-y-4">
                  {(() => {
                    const totalAllocatedWei = msList.reduce((sum: bigint, m: any) => sum + BigInt(String(m.amount || 0)), 0n);
                    const totalDealValueWei = BigInt(String(deal.totalValue || 0));
                    const isUnderAllocated = totalAllocatedWei < totalDealValueWei;
                    const hasUnapprovedEarlierMilestones = msList.some((m: any, i: number) => i < msList.length - 1 && Number(m.msStatus) !== 3);

                    return msList.map((milestone: any, index: number) => {
                      const key = verificationKey(index);
                      const isCurrent = uxState.currentMilestoneIndex === index;
                      return (
                        <MilestoneCard
                          key={index}
                          index={index}
                          milestone={milestone}
                          isCurrentMilestone={isCurrent}
                          role={uxState.role}
                          isActiveDeal={isActive}
                          tokenSymbol={token?.symbol ?? 'asset'}
                          formattedAmount={fmt(milestone.amount)}
                          verification={verifications[key]}
                          isVerifying={verifying === key}
                          onRunAiVerify={() => void runAiVerify(index, milestone)}
                          onStartWork={(idx) => {
                            setPendingActionTitle('Starting milestone...');
                            deal.startMilestone(BigInt(idx));
                          }}
                          onSubmitWork={(idx, ev, isRev) => submitWork(idx, ev || `ipfs://${Math.random().toString(36).slice(2, 10)}`, isRev)}
                          onApproveRelease={(idx, amt) => approveAndRelease(idx, amt)}
                          onRequestRevision={(idx) => {
                            setPendingActionTitle('Requesting revision...');
                            deal.requestRevision(BigInt(idx));
                          }}
                          isPendingTx={deal.isPending || submitPending || approvePending}
                          autoSubmitPending={autoSubmit?.i === index}
                          totalMilestones={msList.length}
                          hasUnapprovedEarlierMilestones={hasUnapprovedEarlierMilestones}
                          isUnderAllocated={isUnderAllocated}
                          totalValueText={fmt(deal.totalValue)}
                          totalAllocatedText={fmt(totalAllocatedWei)}
                        />
                      );
                    });
                  })()}
                </div>
              )}

              {deal.txReceipt.isSuccess && (
                <div className="flex items-center gap-1.5 rounded-lg border border-green-500/20 bg-green-600/10 p-3 text-xs text-green-400">
                  <CheckCircle size={12} /> Transaction confirmed on-chain
                </div>
              )}
              {deal.txReceipt.isError && (
                <div className="rounded-lg border border-red-500/20 bg-red-600/10 p-3 text-xs text-red-400">Transaction failed. Please check wallet connection and network state.</div>
              )}
            </CardContent>
          </Card>
        </div>
      ) : (
        <div id="dispute-section">
          <DealDisputePanel
            uxState={uxState}
            dealAddress={dealAddress as `0x${string}`}
            statusNum={statusNum}
            statusLabel={statusLabel}
            isBuyer={isBuyer}
            isSeller={isSeller}
            isActive={isActive}
            isDisputed={isDisputed}
            isParty={isParty}
            isAdmin={isAdmin}
            buyerAddress={String(deal.buyer || '')}
            sellerAddress={String(deal.seller || '')}
            buyerHandle={buyerHandle}
            sellerHandle={sellerHandle}
            formattedTotalValue={fmt(deal.totalValue)}
            formattedEscrowBalance={fmt(deal.escrowBalance)}
            formattedReleasedAmount={fmt(uxState.financial.releasedAmount)}
            dispute={dispute}
            tokenInfo={token ?? null}
            supportsForceResolve={supportsForceResolve}
            forceResolveSimPending={forceResolveSimPending}
            isPendingTx={deal.isPending || disputeActionPending}
            isFactoryPendingTx={factory.isPending || forceResolvePending}
            actionError={actionError}
            disputeActionConfirmed={disputeActionConfirmed}
            forceResolveConfirmed={forceResolveConfirmed}
            onOpenDispute={(reason) => {
              setPendingActionTitle('Opening dispute...');
              runDisputeAction(() => deal.openDispute(reason));
            }}
            onApproveConsent={() => {
              setPendingActionTitle('Approving resolution consent...');
              runDisputeAction(() => deal.approveDisputeResolution());
            }}
            onExecuteResolution={(resolution) => {
              setPendingActionTitle(resolution === 'release_to_seller' ? 'Releasing escrow to freelancer...' : 'Refunding escrow to client...');
              runDisputeAction(() => deal.executeDisputeResolution(resolution));
            }}
            onForceResolve={(resolution) => {
              setPendingActionTitle('Resolving dispute...');
              runForceResolve(resolution);
            }}
          />
        </div>
      )}
    </div>
  );
}
