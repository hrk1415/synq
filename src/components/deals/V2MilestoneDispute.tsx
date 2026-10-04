'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAccount, useWriteContract, useSignTypedData } from 'wagmi';
import {
  Scale,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Handshake,
  Loader2,
  Send,
  X,
  Plus,
  Trash2,
  Link2,
  GitPullRequest,
  GitCommit,
  Globe,
  FolderGit2,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  Info,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { shortenAddress, cn } from '@/lib/utils';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { synqDealV1ABI } from '@/lib/contracts/abis';
import { getSepoliaExplorerUrl, sepoliaPublicClient } from '@/lib/chain';
import { useSepoliaNetwork, isRejected } from '@/hooks/useSepoliaNetwork';
import { useAuthSession } from '@/hooks/useAuthSession';
import {
  readStandardV2DealData,
  DealState,
  MilestoneStatus,
  MILESTONE_STATUS_LABELS,
  StandardV2DealData,
  readResolutionProposal,
  StandardV2ResolutionProposal,
  verifyFinalReconsiderationRequestedReceipt,
  verifyExecuteResolutionReceipt,
} from '@/lib/deals/v2-deal';
import type { CanonicalResolutionReportV1 } from '@/lib/deals/v2-resolution-report';
import { formatUsdcAmount, parseUsdcAmount } from '@/lib/deals/v2';
import {
  verifySeriousDisputeOpenedReceipt,
  DISPUTE_LIMITS,
} from '@/lib/deals/v2-dispute';
import {
  getMutualSettlementTypedData,
  verifyMutualSettlementReceipt,
  verifyProposalCancelledReceipt,
  MutualSettlementProposalData,
} from '@/lib/deals/v2-mutual-settlement';
import type { MutualSettlementProposalView } from '@/lib/deals/mutual-settlements-db';

interface V2MilestoneDisputeProps {
  dealData: StandardV2DealData;
  currentIndex: number;
  refetchDealData: () => Promise<void>;
  onOpenDisputeModalTrigger?: () => void;
}

interface EditableDisputeLink {
  id: string;
  type: 'pr' | 'commit' | 'repository' | 'web';
  value: string;
  label: string;
}

export function V2MilestoneDispute({
  dealData,
  currentIndex,
  refetchDealData,
}: V2MilestoneDisputeProps) {
  const { address, chainId } = useAccount();
  const { ensureSepolia } = useSepoliaNetwork();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const { ensureAuthenticated, getToken } = useAuthSession();

  const currentMilestone = dealData.milestones[currentIndex];
  const isFreelancer = Boolean(address && address.toLowerCase() === dealData.freelancer.toLowerCase());
  const isClient = Boolean(address && address.toLowerCase() === dealData.client.toLowerCase());
  const isParticipant = isFreelancer || isClient;

  // Active status flags
  const isDisputed = currentMilestone.status === MilestoneStatus.Disputed;
  const isResolutionProposed = currentMilestone.status === MilestoneStatus.ResolutionProposed;
  const isFinalReview = currentMilestone.status === MilestoneStatus.FinalReview;

  // Eligibility
  const canOpenSeriousDispute =
    dealData.state === DealState.Active &&
    !dealData.isProtected &&
    isParticipant &&
    (currentMilestone.status === MilestoneStatus.InProgress ||
      currentMilestone.status === MilestoneStatus.Submitted ||
      currentMilestone.status === MilestoneStatus.RevisionRequested);

  const canUseMutualSettlement =
    dealData.state === DealState.Active &&
    !dealData.isProtected &&
    isParticipant &&
    (currentMilestone.status === MilestoneStatus.Submitted ||
      currentMilestone.status === MilestoneStatus.RevisionRequested ||
      currentMilestone.status === MilestoneStatus.Disputed ||
      currentMilestone.status === MilestoneStatus.ResolutionProposed ||
      currentMilestone.status === MilestoneStatus.FinalReview);

  // General Action State
  const [actionInProgress, setActionInProgress] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);
  const [reconcilePendingMessage, setReconcilePendingMessage] = useState<string | null>(null);

  // Serious Dispute Modal & Form State
  const [showOpenDisputeModal, setShowOpenDisputeModal] = useState<boolean>(false);
  const [disputeExplanation, setDisputeExplanation] = useState<string>('');
  const [disputeCategory, setDisputeCategory] = useState<string>('specification_breach');
  const [disputeLinks, setDisputeLinks] = useState<EditableDisputeLink[]>([]);
  const [stagingDisputeInProgress, setStagingDisputeInProgress] = useState<boolean>(false);
  const [stagingDisputeError, setStagingDisputeError] = useState<string | null>(null);

  // Confirmed Serious Dispute Record (when Disputed)
  const [disputeRecord, setDisputeRecord] = useState<{
    dispute: any;
    manifest: any;
  } | null>(null);
  const [loadingDisputeRecord, setLoadingDisputeRecord] = useState<boolean>(false);
  const [disputeRecordError, setDisputeRecordError] = useState<string | null>(null);

  // Mutual Settlement State
  const [proposals, setProposals] = useState<MutualSettlementProposalView[]>([]);
  const [loadingProposals, setLoadingProposals] = useState<boolean>(false);
  const [showProposeModal, setShowProposeModal] = useState<boolean>(false);
  const [acceptingProposal, setAcceptingProposal] = useState<MutualSettlementProposalView | null>(null);
  const [cancellingProposal, setCancellingProposal] = useState<MutualSettlementProposalView | null>(null);

  // Propose Settlement Form State
  const [freelancerAmountInput, setFreelancerAmountInput] = useState<string>('');
  const [clientAmountInput, setClientAmountInput] = useState<string>('');
  const [validUntilInput, setValidUntilInput] = useState<string>('');
  const [proposeError, setProposeError] = useState<string | null>(null);
  const [proposeInProgress, setProposeInProgress] = useState<boolean>(false);

  // Copy helper
  const [copiedHash, setCopiedHash] = useState(false);
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedHash(true);
      setTimeout(() => setCopiedHash(false), 2000);
    } catch {
      // Fallback
    }
  };

  // ---------------------------------------------------------------------------
  // Resolution & Reconsideration State (Phase 3M-F)
  // ---------------------------------------------------------------------------
  const [resolutionProposal, setResolutionProposal] = useState<StandardV2ResolutionProposal | null>(null);
  const [loadingResolutionProposal, setLoadingResolutionProposal] = useState<boolean>(false);
  const [resolutionProposalError, setResolutionProposalError] = useState<string | null>(null);

  const [chainTimeAnchor, setChainTimeAnchor] = useState<{ chainTime: bigint; localTimeMs: number } | null>(null);
  const [interpolatedTimeSec, setInterpolatedTimeSec] = useState<bigint | null>(null);

  const [initialReport, setInitialReport] = useState<CanonicalResolutionReportV1 | null>(null);
  const [loadingInitialReport, setLoadingInitialReport] = useState<boolean>(false);
  const [initialReportNotice, setInitialReportNotice] = useState<string | null>(null);
  const [showReportDrawer, setShowReportDrawer] = useState<boolean>(false);

  const [finalReport, setFinalReport] = useState<CanonicalResolutionReportV1 | null>(null);
  const [loadingFinalReport, setLoadingFinalReport] = useState<boolean>(false);
  const [showFinalReportDrawer, setShowFinalReportDrawer] = useState<boolean>(false);

  // Modals for Reconsideration & Execute Resolution
  const [showReconsiderModal, setShowReconsiderModal] = useState<boolean>(false);
  const [reconsiderInProgress, setReconsiderInProgress] = useState<boolean>(false);
  const [reconsiderError, setReconsiderError] = useState<string | null>(null);

  const [showExecuteModal, setShowExecuteModal] = useState<boolean>(false);
  const [executeInProgress, setExecuteInProgress] = useState<boolean>(false);
  const [executeError, setExecuteError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Load Confirmed Dispute Record (Participant-only)
  // ---------------------------------------------------------------------------
  const loadDisputeRecord = useCallback(async () => {
    if (!isDisputed || !isParticipant || !dealData.dealAddress) return;

    setLoadingDisputeRecord(true);
    setDisputeRecordError(null);

    try {
      const token = await getToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const res = await fetch(
        `/api/deals/${dealData.dealAddress}/milestones/${currentIndex}/disputes`,
        { headers }
      );

      if (res.status === 404) {
        // Milestone is disputed on chain, but no serious dispute record exists (e.g. revision declined / timeout)
        setDisputeRecord(null);
        return;
      }

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      setDisputeRecord({
        dispute: data.dispute,
        manifest: data.manifest,
      });
    } catch (err: any) {
      console.warn('[V2MilestoneDispute] Could not load dispute record:', err);
      setDisputeRecordError(err?.message || 'Failed to retrieve dispute record');
    } finally {
      setLoadingDisputeRecord(false);
    }
  }, [isDisputed, isParticipant, dealData.dealAddress, currentIndex, getToken]);

  useEffect(() => {
    loadDisputeRecord();
  }, [loadDisputeRecord]);

  // ---------------------------------------------------------------------------
  // Load Resolution Proposal & Chain Time Anchor (Phase 3M-F)
  // ---------------------------------------------------------------------------
  const loadResolutionProposal = useCallback(async () => {
    if ((!isResolutionProposed && !isFinalReview) || !dealData.dealAddress) {
      setResolutionProposal(null);
      return;
    }

    setLoadingResolutionProposal(true);
    setResolutionProposalError(null);

    try {
      const [proposal, block] = await Promise.all([
        readResolutionProposal(dealData.dealAddress, currentIndex, sepoliaPublicClient),
        sepoliaPublicClient.getBlock({ blockTag: 'latest' }),
      ]);

      setResolutionProposal(proposal);
      const chainTime = BigInt(block.timestamp);
      const localTimeMs = Date.now();
      setChainTimeAnchor({ chainTime, localTimeMs });
      setInterpolatedTimeSec(chainTime);
    } catch (err: any) {
      console.warn('[V2MilestoneDispute] Could not load resolution proposal:', err);
      setResolutionProposalError(err?.message || 'Failed to read resolution proposal from blockchain');
    } finally {
      setLoadingResolutionProposal(false);
    }
  }, [isResolutionProposed, isFinalReview, dealData.dealAddress, currentIndex]);

  useEffect(() => {
    loadResolutionProposal();
  }, [loadResolutionProposal]);

  // Local ticker for countdown + periodic 30s chain-anchor refresh
  useEffect(() => {
    if (!chainTimeAnchor) return;

    const tickInterval = setInterval(() => {
      const elapsedSec = BigInt(Math.floor((Date.now() - chainTimeAnchor.localTimeMs) / 1000));
      setInterpolatedTimeSec(chainTimeAnchor.chainTime + elapsedSec);
    }, 1000);

    const anchorInterval = setInterval(async () => {
      try {
        const block = await sepoliaPublicClient.getBlock({ blockTag: 'latest' });
        const chainTime = BigInt(block.timestamp);
        const localTimeMs = Date.now();
        setChainTimeAnchor({ chainTime, localTimeMs });
        setInterpolatedTimeSec(chainTime);
      } catch {
        // Non-blocking
      }
    }, 30000);

    return () => {
      clearInterval(tickInterval);
      clearInterval(anchorInterval);
    };
  }, [chainTimeAnchor]);

  // ---------------------------------------------------------------------------
  // Load Confirmed Initial Resolution Report (Phase 3M-F)
  // ---------------------------------------------------------------------------
  const loadInitialReport = useCallback(async () => {
    if ((!isResolutionProposed && !isFinalReview) || !dealData.dealAddress || !isParticipant) {
      setInitialReport(null);
      return;
    }

    setLoadingInitialReport(true);
    setInitialReportNotice(null);

    try {
      const token = await getToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const res = await fetch(
        `/api/deals/${dealData.dealAddress}/milestones/${currentIndex}/resolution-reports?phase=INITIAL_RESOLUTION`,
        { headers }
      );

      if (!res.ok) {
        setInitialReport(null);
        setInitialReportNotice(
          'Resolution explanation temporarily unavailable. The on-chain resolution proposal remains active.'
        );
        return;
      }

      const data = await res.json();
      if (data.record?.row?.status === 'confirmed' && data.record?.report) {
        setInitialReport(data.record.report);
      } else {
        setInitialReport(null);
        setInitialReportNotice(
          'Resolution explanation temporarily unavailable. The on-chain resolution proposal remains active.'
        );
      }
    } catch (err: any) {
      console.warn('[V2MilestoneDispute] Could not load initial resolution report:', err);
      setInitialReport(null);
      setInitialReportNotice(
        'Resolution explanation temporarily unavailable. The on-chain resolution proposal remains active.'
      );
    } finally {
      setLoadingInitialReport(false);
    }
  }, [isResolutionProposed, isFinalReview, dealData.dealAddress, currentIndex, isParticipant, getToken]);

  useEffect(() => {
    loadInitialReport();
  }, [loadInitialReport]);

  // ---------------------------------------------------------------------------
  // Load Confirmed Final Resolution Report (Phase 3M-G)
  // ---------------------------------------------------------------------------
  const loadFinalReport = useCallback(async () => {
    if (currentMilestone.status !== MilestoneStatus.SettledSplit || !dealData.dealAddress || !isParticipant) {
      setFinalReport(null);
      return;
    }

    setLoadingFinalReport(true);
    try {
      const token = await getToken();
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

      const res = await fetch(
        `/api/deals/${dealData.dealAddress}/milestones/${currentIndex}/resolution-reports?phase=FINAL_RESOLUTION`,
        { headers }
      );

      if (res.ok) {
        const data = await res.json();
        if (data.record?.row?.status === 'confirmed' && data.record?.report) {
          setFinalReport(data.record.report);
        } else {
          setFinalReport(null);
        }
      } else {
        setFinalReport(null);
      }
    } catch {
      setFinalReport(null);
    } finally {
      setLoadingFinalReport(false);
    }
  }, [currentMilestone.status, dealData.dealAddress, currentIndex, isParticipant, getToken]);

  useEffect(() => {
    loadFinalReport();
  }, [loadFinalReport]);

  // Derived Reconsideration / Execution Window Timers
  const remainingReconsiderationSeconds = useMemo(() => {
    if (!resolutionProposal || interpolatedTimeSec === null) return null;
    return resolutionProposal.reconsiderationDeadline - interpolatedTimeSec;
  }, [resolutionProposal, interpolatedTimeSec]);

  const isReconsiderationWindowClosed =
    remainingReconsiderationSeconds !== null && remainingReconsiderationSeconds <= 0n;
  const isReconsiderationWindowClosingSoon =
    remainingReconsiderationSeconds !== null &&
    remainingReconsiderationSeconds > 0n &&
    remainingReconsiderationSeconds <= 900n; // Under 15m

  const canRequestReconsideration =
    dealData.state === DealState.Active &&
    isParticipant &&
    isResolutionProposed &&
    remainingReconsiderationSeconds !== null &&
    remainingReconsiderationSeconds > 0n;

  const canExecuteResolution =
    dealData.state === DealState.Active &&
    isParticipant &&
    isResolutionProposed &&
    remainingReconsiderationSeconds !== null &&
    remainingReconsiderationSeconds <= 0n;

  // ---------------------------------------------------------------------------
  // Load Mutual Settlement Proposals (Participant-only)
  // ---------------------------------------------------------------------------
  const loadProposals = useCallback(async () => {
    if (!canUseMutualSettlement || !isParticipant || !dealData.dealAddress) return;

    setLoadingProposals(true);
    try {
      const token = await getToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const res = await fetch(
        `/api/deals/${dealData.dealAddress}/milestones/${currentIndex}/settlements`,
        { headers }
      );

      if (!res.ok) {
        if (res.status === 403 || res.status === 404) {
          setProposals([]);
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      setProposals(data.proposals || []);
    } catch (err: any) {
      console.warn('[V2MilestoneDispute] Could not load settlement proposals:', err);
    } finally {
      setLoadingProposals(false);
    }
  }, [canUseMutualSettlement, isParticipant, dealData.dealAddress, currentIndex, getToken]);

  useEffect(() => {
    loadProposals();
  }, [loadProposals]);

  // ---------------------------------------------------------------------------
  // Serious Dispute Form Links Helpers
  // ---------------------------------------------------------------------------
  const handleAddDisputeLink = () => {
    if (disputeLinks.length >= DISPUTE_LIMITS.MAX_LINKS_COUNT) return;
    setDisputeLinks((prev) => [
      ...prev,
      { id: crypto.randomUUID(), type: 'web', value: '', label: '' },
    ]);
  };

  const handleRemoveDisputeLink = (id: string) => {
    setDisputeLinks((prev) => prev.filter((l) => l.id !== id));
  };

  const handleUpdateDisputeLink = (id: string, field: 'type' | 'value' | 'label', val: string) => {
    setDisputeLinks((prev) =>
      prev.map((l) => (l.id === id ? { ...l, [field]: val } : l))
    );
  };

  // ---------------------------------------------------------------------------
  // ACTION: Stage & Open Serious Dispute
  // ---------------------------------------------------------------------------
  const handleStageAndOpenDispute = async () => {
    if (!address) return;

    const trimmedExplanation = disputeExplanation.trim().normalize('NFC');
    if (trimmedExplanation.length < DISPUTE_LIMITS.MIN_EXPLANATION_LENGTH) {
      setStagingDisputeError(
        `Explanation is required and must be at least ${DISPUTE_LIMITS.MIN_EXPLANATION_LENGTH} characters.`
      );
      return;
    }
    if (trimmedExplanation.length > DISPUTE_LIMITS.MAX_EXPLANATION_LENGTH) {
      setStagingDisputeError(
        `Explanation cannot exceed ${DISPUTE_LIMITS.MAX_EXPLANATION_LENGTH} characters.`
      );
      return;
    }

    setStagingDisputeInProgress(true);
    setStagingDisputeError(null);
    setActionError(null);
    setReconcilePendingMessage(null);

    let stagedReasonHash: `0x${string}` | null = null;
    let stagedManifest: any = null;

    try {
      await ensureSepolia();

      const authWallet = await ensureAuthenticated();
      if (!authWallet) {
        setStagingDisputeError('Please sign in with your connected wallet session to continue.');
        return;
      }
      // Step 1: Stage Dispute via Backend API
      const token = await getToken();
      const validLinks = disputeLinks
        .filter((l) => l.value.trim().length > 0)
        .map((l) => ({
          type: l.type,
          value: l.value.trim(),
          label: l.label.trim() || undefined,
        }));

      const stageRes = await fetch(
        `/api/deals/${dealData.dealAddress}/milestones/${currentIndex}/disputes`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            explanation: trimmedExplanation,
            category: disputeCategory,
            links: validLinks,
          }),
        }
      );

      if (!stageRes.ok) {
        const errorData = await stageRes.json().catch(() => ({}));
        throw new Error(errorData.error || `Staging failed with HTTP ${stageRes.status}`);
      }

      const stageData = await stageRes.json();
      stagedReasonHash = stageData.reasonHash as `0x${string}`;
      stagedManifest = stageData.manifest;

      // Step 2: Fresh Preflight Check against on-chain Deal clone
      const freshDeal = await readStandardV2DealData(dealData.dealAddress, sepoliaPublicClient);
      if (freshDeal.state !== DealState.Active) {
        throw new Error('Preflight check failed: Deal is no longer in Active state on-chain.');
      }
      const freshMilestone = freshDeal.milestones[currentIndex];
      if (!freshMilestone) {
        throw new Error('Preflight check failed: Milestone not found on-chain.');
      }
      if (
        freshMilestone.status !== MilestoneStatus.InProgress &&
        freshMilestone.status !== MilestoneStatus.Submitted &&
        freshMilestone.status !== MilestoneStatus.RevisionRequested
      ) {
        throw new Error(
          `Preflight check failed: Milestone status changed to ${MILESTONE_STATUS_LABELS[freshMilestone.status] || freshMilestone.status} on-chain.`
        );
      }
      if (freshMilestone.version !== stagedManifest.submissionVersion) {
        throw new Error('Preflight check failed: Milestone submission version changed on-chain.');
      }
      if (freshMilestone.specHash.toLowerCase() !== stagedManifest.specHash.toLowerCase()) {
        throw new Error('Preflight check failed: Milestone specHash changed on-chain.');
      }
      if (freshMilestone.evidenceRootHash.toLowerCase() !== stagedManifest.evidenceRootHash.toLowerCase()) {
        throw new Error('Preflight check failed: Milestone evidenceRootHash changed on-chain.');
      }

      // Step 3: Prompt Wallet Transaction (openSeriousDispute)
      const txHash = await writeContractAsync({
        address: dealData.dealAddress as `0x${string}`,
        abi: synqDealV1ABI,
        functionName: 'openSeriousDispute',
        args: [BigInt(currentIndex), stagedReasonHash],
      });

      setLastTxHash(txHash);

      // Step 4: Wait for Receipt & Verify Exact SeriousDisputeOpened Event
      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });
      const verification = verifySeriousDisputeOpenedReceipt(
        receipt,
        dealData.dealAddress,
        BigInt(currentIndex),
        address,
        stagedReasonHash
      );

      if (!verification.valid) {
        throw new Error(verification.error || 'SeriousDisputeOpened event verification failed on receipt');
      }

      // Step 5: Server Reconcile with txHash
      try {
        const reconcileRes = await fetch(
          `/api/deals/${dealData.dealAddress}/milestones/${currentIndex}/disputes/reconcile`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ txHash }),
          }
        );

        if (!reconcileRes.ok) {
          console.warn('[V2MilestoneDispute] Reconcile request returned non-200:', reconcileRes.status);
          setReconcilePendingMessage(
            'Dispute was opened on-chain. Verification is still being completed.'
          );
        }
      } catch (reconcileErr) {
        console.warn('[V2MilestoneDispute] Reconcile network error:', reconcileErr);
        setReconcilePendingMessage(
          'Dispute was opened on-chain. Verification is still being completed.'
        );
      }

      // Step 6: Refetch Canonical Deal Data
      await refetchDealData();
      setShowOpenDisputeModal(false);
      setDisputeExplanation('');
      setDisputeLinks([]);
    } catch (err: any) {
      if (isRejected(err)) {
        setStagingDisputeError('Transaction was cancelled in your wallet. The dispute was not opened.');
      } else {
        setStagingDisputeError(err?.message || 'Failed to open serious dispute');
      }
    } finally {
      setStagingDisputeInProgress(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Synchronized Mutual Settlement Amount Inputs
  // ---------------------------------------------------------------------------
  const handleFreelancerAmountChange = (val: string) => {
    setFreelancerAmountInput(val);
    setProposeError(null);
    if (!val.trim()) {
      setClientAmountInput('');
      return;
    }
    try {
      const flBase = parseUsdcAmount(val);
      const totalBase = BigInt(currentMilestone.amount);
      if (flBase <= totalBase) {
        const clBase = totalBase - flBase;
        setClientAmountInput(formatUsdcAmount(clBase));
      } else {
        setProposeError('Freelancer amount cannot exceed milestone total escrow.');
      }
    } catch {
      // User may be mid-typing decimal (e.g. "1."), do not disrupt typing
    }
  };

  const handleClientAmountChange = (val: string) => {
    setClientAmountInput(val);
    setProposeError(null);
    if (!val.trim()) {
      setFreelancerAmountInput('');
      return;
    }
    try {
      const clBase = parseUsdcAmount(val);
      const totalBase = BigInt(currentMilestone.amount);
      if (clBase <= totalBase) {
        const flBase = totalBase - clBase;
        setFreelancerAmountInput(formatUsdcAmount(flBase));
      } else {
        setProposeError('Client amount cannot exceed milestone total escrow.');
      }
    } catch {
      // User may be mid-typing decimal, do not disrupt typing
    }
  };

  // ---------------------------------------------------------------------------
  // ACTION: Propose Mutual Settlement (EIP-712 Signing)
  // ---------------------------------------------------------------------------
  const handleProposeSettlement = async () => {
    if (!address) return;

    let flBaseUnits: bigint;
    let clBaseUnits: bigint;
    try {
      flBaseUnits = parseUsdcAmount(freelancerAmountInput);
    } catch (err: any) {
      setProposeError(`Freelancer amount: ${err?.message || 'Invalid amount'}`);
      return;
    }

    try {
      clBaseUnits = parseUsdcAmount(clientAmountInput);
    } catch (err: any) {
      setProposeError(`Client amount: ${err?.message || 'Invalid amount'}`);
      return;
    }

    const milestoneAmount = BigInt(currentMilestone.amount);

    if (flBaseUnits + clBaseUnits !== milestoneAmount) {
      setProposeError(
        `Amounts must sum exactly to milestone amount (${formatUsdcAmount(milestoneAmount)} USDC). Currently: ${formatUsdcAmount(flBaseUnits + clBaseUnits)} USDC`
      );
      return;
    }

    if (!validUntilInput) {
      setProposeError('Please choose an expiration date and time for this proposal.');
      return;
    }

    const validUntilSec = BigInt(Math.floor(new Date(validUntilInput).getTime() / 1000));
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (validUntilSec <= nowSec + 300n) {
      setProposeError('Proposal expiration must be at least 5 minutes in the future.');
      return;
    }

    setProposeInProgress(true);
    setProposeError(null);

    try {
      await ensureSepolia();

      const authWallet = await ensureAuthenticated();
      if (!authWallet) {
        setProposeError('Please sign in with your connected wallet session to continue.');
        return;
      }
      // 1. Fresh read to verify Deal & Milestone eligibility
      const freshDeal = await readStandardV2DealData(dealData.dealAddress, sepoliaPublicClient);
      if (freshDeal.state !== DealState.Active) {
        throw new Error('Deal is no longer in Active state on-chain.');
      }
      const freshMilestone = freshDeal.milestones[currentIndex];
      if (
        freshMilestone.status !== MilestoneStatus.Submitted &&
        freshMilestone.status !== MilestoneStatus.RevisionRequested &&
        freshMilestone.status !== MilestoneStatus.Disputed &&
        freshMilestone.status !== MilestoneStatus.ResolutionProposed &&
        freshMilestone.status !== MilestoneStatus.FinalReview
      ) {
        throw new Error('Milestone status is no longer eligible for mutual settlement.');
      }

      // 2. Determine next proposal nonce for this proposer on this milestone
      const userProposals = proposals.filter(
        (p) => p.proposerWallet.toLowerCase() === address.toLowerCase()
      );
      let nextNonce = 1n;
      if (userProposals.length > 0) {
        const maxNonce = userProposals.reduce(
          (max, p) => (BigInt(p.proposalNonce) > max ? BigInt(p.proposalNonce) : max),
          0n
        );
        nextNonce = maxNonce + 1n;
      }

      // Check on-chain nonce state to guarantee it has not been used or cancelled
      let isNonceUsed = true;
      while (isNonceUsed) {
        try {
          isNonceUsed = (await sepoliaPublicClient.readContract({
            address: dealData.dealAddress as `0x${string}`,
            abi: synqDealV1ABI,
            functionName: 'usedProposalNonces',
            args: [BigInt(currentIndex), address as `0x${string}`, nextNonce],
          })) as boolean;

          if (isNonceUsed) {
            nextNonce += 1n;
          }
        } catch {
          // If contract read fails, stop loop
          break;
        }
      }

      // 3. Prepare EIP-712 Typed Data
      const proposalPayload: MutualSettlementProposalData = {
        dealAddress: dealData.dealAddress.toLowerCase() as `0x${string}`,
        chainId: BigInt(SEPOLIA_CHAIN_ID),
        milestoneId: BigInt(currentIndex),
        proposer: address.toLowerCase() as `0x${string}`,
        freelancerAmount: flBaseUnits,
        clientAmount: clBaseUnits,
        proposalNonce: nextNonce,
        validUntil: validUntilSec,
      };

      const typedData = getMutualSettlementTypedData(proposalPayload);

      // 4. Prompt Wallet EIP-712 Signature
      const signature = await signTypedDataAsync({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });

      // 5. Submit Proposal to Backend API
      const token = await getToken();
      const createRes = await fetch(
        `/api/deals/${dealData.dealAddress}/milestones/${currentIndex}/settlements`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            freelancerAmount: flBaseUnits.toString(),
            clientAmount: clBaseUnits.toString(),
            proposalNonce: nextNonce.toString(),
            validUntil: validUntilSec.toString(),
            signature,
          }),
        }
      );

      if (!createRes.ok) {
        const errorData = await createRes.json().catch(() => ({}));
        throw new Error(errorData.error || `Proposal submission failed with HTTP ${createRes.status}`);
      }

      setShowProposeModal(false);
      setFreelancerAmountInput('');
      setClientAmountInput('');
      setValidUntilInput('');
      await loadProposals();
    } catch (err: any) {
      if (isRejected(err)) {
        setProposeError('Signature request was rejected in your wallet. Proposal was not created.');
      } else {
        setProposeError(err?.message || 'Failed to create mutual settlement proposal');
      }
    } finally {
      setProposeInProgress(false);
    }
  };

  // ---------------------------------------------------------------------------
  // ACTION: Accept / Execute Mutual Settlement (Counterparty on-chain)
  // ---------------------------------------------------------------------------
  const handleExecuteSettlement = async (proposal: MutualSettlementProposalView) => {
    if (!address) return;

    setActionInProgress(true);
    setActionError(null);

    try {
      await ensureSepolia();

      const authWallet = await ensureAuthenticated();
      if (!authWallet) {
        setActionError('Please sign in with your connected wallet session to continue.');
        return;
      }
      // 1. Fresh preflight read on-chain
      const freshDeal = await readStandardV2DealData(dealData.dealAddress, sepoliaPublicClient);
      if (freshDeal.state !== DealState.Active) {
        throw new Error('Preflight check failed: Deal is not in Active state on-chain.');
      }
      const freshMilestone = freshDeal.milestones[currentIndex];
      if (
        freshMilestone.status !== MilestoneStatus.Submitted &&
        freshMilestone.status !== MilestoneStatus.RevisionRequested &&
        freshMilestone.status !== MilestoneStatus.Disputed &&
        freshMilestone.status !== MilestoneStatus.ResolutionProposed &&
        freshMilestone.status !== MilestoneStatus.FinalReview
      ) {
        throw new Error('Preflight check failed: Milestone is no longer eligible for mutual settlement.');
      }

      const flAmount = BigInt(proposal.freelancerAmount);
      const clAmount = BigInt(proposal.clientAmount);
      if (flAmount + clAmount !== BigInt(freshMilestone.amount)) {
        throw new Error('Preflight check failed: Split amount does not equal current milestone amount.');
      }

      const isNonceUsed = (await sepoliaPublicClient.readContract({
        address: dealData.dealAddress as `0x${string}`,
        abi: synqDealV1ABI,
        functionName: 'usedProposalNonces',
        args: [BigInt(currentIndex), proposal.proposerWallet as `0x${string}`, BigInt(proposal.proposalNonce)],
      })) as boolean;

      if (isNonceUsed) {
        throw new Error('Preflight check failed: Proposal nonce has already been executed or cancelled on-chain.');
      }

      // 2. Call executeMutualSettlement on Deal clone
      const txHash = await writeContractAsync({
        address: dealData.dealAddress as `0x${string}`,
        abi: synqDealV1ABI,
        functionName: 'executeMutualSettlement',
        args: [
          {
            dealAddress: proposal.dealAddress as `0x${string}`,
            chainId: BigInt(proposal.chainId),
            milestoneId: BigInt(proposal.milestoneId),
            proposer: proposal.proposerWallet as `0x${string}`,
            freelancerAmount: flAmount,
            clientAmount: clAmount,
            proposalNonce: BigInt(proposal.proposalNonce),
            validUntil: BigInt(proposal.validUntil),
          },
          proposal.signature as `0x${string}`,
        ],
      });

      setLastTxHash(txHash);

      // 3. Wait for Receipt & Verify MilestoneSettled Event
      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });
      const verification = verifyMutualSettlementReceipt(
        receipt,
        dealData.dealAddress,
        BigInt(currentIndex),
        flAmount,
        clAmount
      );

      if (!verification.valid) {
        throw new Error(verification.error || 'MutualSettlement event verification failed on receipt');
      }

      // 4. Server Reconciliation
      const token = await getToken();
      try {
        await fetch(
          `/api/deals/${dealData.dealAddress}/milestones/${currentIndex}/settlements/reconcile`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
              proposalId: proposal.id,
              txHash,
            }),
          }
        );
      } catch (recErr) {
        console.warn('[V2MilestoneDispute] Server settlement reconcile non-blocking error:', recErr);
      }

      // 5. Refresh State
      setAcceptingProposal(null);
      await refetchDealData();
      await loadProposals();
    } catch (err: any) {
      if (isRejected(err)) {
        setActionError('Settlement transaction was cancelled in your wallet.');
      } else {
        setActionError(err?.message || 'Failed to execute mutual settlement');
      }
    } finally {
      setActionInProgress(false);
    }
  };

  // ---------------------------------------------------------------------------
  // ACTION: Cancel Proposal (Proposer on-chain)
  // ---------------------------------------------------------------------------
  const handleCancelProposal = async (proposal: MutualSettlementProposalView) => {
    if (!address) return;

    setActionInProgress(true);
    setActionError(null);

    try {
      await ensureSepolia();

      const authWallet = await ensureAuthenticated();
      if (!authWallet) {
        setActionError('Please sign in with your connected wallet session to continue.');
        return;
      }
      // 1. Preflight check: caller must be proposer
      if (address.toLowerCase() !== proposal.proposerWallet.toLowerCase()) {
        throw new Error('Only the proposer can cancel their proposal.');
      }

      // 2. Call cancelProposal on Deal clone
      const txHash = await writeContractAsync({
        address: dealData.dealAddress as `0x${string}`,
        abi: synqDealV1ABI,
        functionName: 'cancelProposal',
        args: [BigInt(currentIndex), BigInt(proposal.proposalNonce)],
      });

      setLastTxHash(txHash);

      // 3. Wait for Receipt & Verify ProposalCancelled Event
      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });
      const verification = verifyProposalCancelledReceipt(
        receipt,
        dealData.dealAddress,
        BigInt(currentIndex),
        address,
        BigInt(proposal.proposalNonce)
      );

      if (!verification.valid) {
        throw new Error(verification.error || 'ProposalCancelled event verification failed on receipt');
      }

      // 4. Server Reconciliation
      const token = await getToken();
      try {
        await fetch(
          `/api/deals/${dealData.dealAddress}/milestones/${currentIndex}/settlements/cancel`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
              proposalId: proposal.id,
              txHash,
            }),
          }
        );
      } catch (recErr) {
        console.warn('[V2MilestoneDispute] Server cancel reconcile error:', recErr);
      }

      setCancellingProposal(null);
      await loadProposals();
      await refetchDealData();
    } catch (err: any) {
      if (isRejected(err)) {
        setActionError('Cancellation transaction was cancelled in your wallet.');
      } else {
        setActionError(err?.message || 'Failed to cancel proposal');
      }
    } finally {
      setActionInProgress(false);
    }
  };

  // Helper date formatter
  const formatTimestamp = (timestamp: bigint | number): string => {
    const s = typeof timestamp === 'bigint' ? Number(timestamp) : timestamp;
    if (s <= 0) return '—';
    return new Date(s * 1000).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  };

  const formatCountdown = (diffSeconds: bigint): string => {
    const s = Number(diffSeconds);
    if (s <= 0) return 'Window closed';
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (days > 0) {
      return `${days}d ${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m`;
    }
    return `${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`;
  };

  // ---------------------------------------------------------------------------
  // ACTION: Request Final Reconsideration (Phase 3M-F)
  // ---------------------------------------------------------------------------
  const handleRequestReconsideration = async () => {
    if (!address) return;

    setReconsiderInProgress(true);
    setReconsiderError(null);
    setActionError(null);

    try {
      await ensureSepolia();

      const authWallet = await ensureAuthenticated();
      if (!authWallet) {
        setReconsiderError('Please sign in with your connected wallet session to continue.');
        return;
      }

      // Step 1: Fresh preflight on-chain checks
      const freshDeal = await readStandardV2DealData(dealData.dealAddress, sepoliaPublicClient);
      if (freshDeal.state !== DealState.Active) {
        throw new Error('Preflight check failed: Deal is not in Active state on-chain.');
      }
      if (!isParticipant) {
        throw new Error('Preflight check failed: Only deal participants may request reconsideration.');
      }

      const freshMilestone = freshDeal.milestones[currentIndex];
      if (!freshMilestone) {
        throw new Error('Preflight check failed: Milestone not found on-chain.');
      }
      if (freshMilestone.status !== MilestoneStatus.ResolutionProposed) {
        throw new Error(
          `Preflight check failed: Milestone status changed to ${MILESTONE_STATUS_LABELS[freshMilestone.status] || freshMilestone.status} on-chain.`
        );
      }

      const [freshProposal, freshBlock] = await Promise.all([
        readResolutionProposal(dealData.dealAddress, currentIndex, sepoliaPublicClient),
        sepoliaPublicClient.getBlock({ blockTag: 'latest' }),
      ]);

      const chainTimestamp = BigInt(freshBlock.timestamp);
      if (chainTimestamp >= freshProposal.reconsiderationDeadline) {
        throw new Error(
          'The reconsideration window has closed. The resolution is now ready for execution.'
        );
      }

      // Step 2: Simulation
      await sepoliaPublicClient.simulateContract({
        address: dealData.dealAddress as `0x${string}`,
        abi: synqDealV1ABI,
        functionName: 'requestFinalReconsideration',
        args: [BigInt(currentIndex)],
        account: address as `0x${string}`,
      });

      // Step 3: Broadcast transaction
      const txHash = await writeContractAsync({
        address: dealData.dealAddress as `0x${string}`,
        abi: synqDealV1ABI,
        functionName: 'requestFinalReconsideration',
        args: [BigInt(currentIndex)],
      });

      setLastTxHash(txHash);

      // Step 4: Wait for Receipt & verify exact event
      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });
      const verification = verifyFinalReconsiderationRequestedReceipt(
        receipt,
        dealData.dealAddress,
        BigInt(currentIndex),
        address
      );

      if (!verification.valid) {
        throw new Error(verification.error || 'FinalReconsiderationRequested event verification failed on receipt');
      }

      // Step 5: Verify fresh milestone status on-chain
      const postDeal = await readStandardV2DealData(dealData.dealAddress, sepoliaPublicClient);
      if (postDeal.milestones[currentIndex].status !== MilestoneStatus.FinalReview) {
        throw new Error('Post-transaction check failed: Milestone is not in FinalReview status on-chain.');
      }

      // Step 6: Refetch Canonical Deal Data
      await refetchDealData();
      await loadResolutionProposal();
      setShowReconsiderModal(false);
    } catch (err: any) {
      if (isRejected(err)) {
        setReconsiderError('Transaction was cancelled in your wallet.');
      } else {
        setReconsiderError(err?.message || 'Failed to request final reconsideration');
      }
    } finally {
      setReconsiderInProgress(false);
    }
  };

  // ---------------------------------------------------------------------------
  // ACTION: Execute Resolution (Phase 3M-F)
  // ---------------------------------------------------------------------------
  const handleExecuteResolution = async () => {
    if (!address) return;

    setExecuteInProgress(true);
    setExecuteError(null);
    setActionError(null);

    try {
      await ensureSepolia();

      // Step 1: Fresh preflight on-chain checks
      const freshDeal = await readStandardV2DealData(dealData.dealAddress, sepoliaPublicClient);
      if (freshDeal.state !== DealState.Active) {
        throw new Error('Preflight check failed: Deal is not in Active state on-chain.');
      }

      const freshMilestone = freshDeal.milestones[currentIndex];
      if (!freshMilestone) {
        throw new Error('Preflight check failed: Milestone not found on-chain.');
      }

      if (freshMilestone.status === MilestoneStatus.SettledSplit) {
        setShowExecuteModal(false);
        await refetchDealData();
        return;
      }

      if (freshMilestone.status === MilestoneStatus.FinalReview) {
        setShowExecuteModal(false);
        await refetchDealData();
        throw new Error('A final reconsideration was requested. This proposal can no longer be executed.');
      }

      if (freshMilestone.status !== MilestoneStatus.ResolutionProposed) {
        throw new Error(
          `Preflight check failed: Milestone status changed to ${MILESTONE_STATUS_LABELS[freshMilestone.status] || freshMilestone.status} on-chain.`
        );
      }

      const [freshProposal, freshBlock] = await Promise.all([
        readResolutionProposal(dealData.dealAddress, currentIndex, sepoliaPublicClient),
        sepoliaPublicClient.getBlock({ blockTag: 'latest' }),
      ]);

      const chainTimestamp = BigInt(freshBlock.timestamp);
      if (chainTimestamp < freshProposal.reconsiderationDeadline) {
        throw new Error('Reconsideration window is still active on-chain.');
      }

      // Step 2: Simulation
      await sepoliaPublicClient.simulateContract({
        address: dealData.dealAddress as `0x${string}`,
        abi: synqDealV1ABI,
        functionName: 'executeResolution',
        args: [BigInt(currentIndex)],
        account: address as `0x${string}`,
      });

      // Step 3: Broadcast transaction
      const txHash = await writeContractAsync({
        address: dealData.dealAddress as `0x${string}`,
        abi: synqDealV1ABI,
        functionName: 'executeResolution',
        args: [BigInt(currentIndex)],
      });

      setLastTxHash(txHash);

      // Step 4: Wait for Receipt & verify exact events
      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });
      const verification = verifyExecuteResolutionReceipt(
        receipt,
        dealData.dealAddress,
        BigInt(currentIndex),
        freshProposal.resolver,
        freshProposal.freelancerAmount,
        freshProposal.clientAmount
      );

      if (!verification.valid) {
        throw new Error(verification.error || 'executeResolution event verification failed on receipt');
      }

      // Step 5: Verify fresh milestone status on-chain
      const postDeal = await readStandardV2DealData(dealData.dealAddress, sepoliaPublicClient);
      if (postDeal.milestones[currentIndex].status !== MilestoneStatus.SettledSplit) {
        throw new Error('Post-transaction check failed: Milestone is not in SettledSplit status on-chain.');
      }

      // Step 6: Refetch Canonical Deal Data
      await refetchDealData();
      setShowExecuteModal(false);
    } catch (err: any) {
      if (isRejected(err)) {
        setExecuteError('Transaction was cancelled in your wallet.');
      } else {
        setExecuteError(err?.message || 'Failed to execute resolution');
      }
    } finally {
      setExecuteInProgress(false);
    }
  };

  // Render collapsible resolution report drawer
  const renderResolutionReportDrawer = () => {
    if (loadingInitialReport) {
      return (
        <div className="rounded-lg border border-zinc-800 p-3 text-center text-xs text-zinc-400 flex items-center justify-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-purple-400" />
          Loading resolution report…
        </div>
      );
    }

    if (initialReportNotice && !initialReport) {
      return (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-400 flex items-center gap-2">
          <Info className="h-4 w-4 text-zinc-500 shrink-0" />
          <span>{initialReportNotice}</span>
        </div>
      );
    }

    if (!initialReport) return null;

    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 space-y-3">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
          <span className="text-[11px] font-semibold text-zinc-300 flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5 text-purple-400" /> Committee Resolution Report
          </span>
          <Badge variant="outline" className="border-purple-500/30 bg-purple-500/10 text-[10px] text-purple-300">
            Confirmed Explanatory Record
          </Badge>
        </div>

        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Summary</div>
          <div className="rounded-md bg-zinc-950/70 p-2.5 text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed border border-zinc-800/80">
            {initialReport.summary}
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Findings</div>
          <div className="rounded-md bg-zinc-950/70 p-2.5 text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed border border-zinc-800/80">
            {initialReport.findings}
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Justification</div>
          <div className="rounded-md bg-zinc-950/70 p-2.5 text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed border border-zinc-800/80">
            {initialReport.justification}
          </div>
        </div>

        {initialReport.evidenceReferences && initialReport.evidenceReferences.length > 0 && (
          <div className="space-y-1.5 pt-1">
            <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">
              Evidence References ({initialReport.evidenceReferences.length})
            </div>
            <div className="space-y-1">
              {initialReport.evidenceReferences.map((ref, idx) => {
                const isSafeUrl =
                  ref.url && (ref.url.startsWith('https://') || ref.url.startsWith('http://'));
                return (
                  <div
                    key={idx}
                    className="flex flex-col gap-1 rounded border border-zinc-800 bg-zinc-950/50 px-2.5 py-2 text-xs text-zinc-200"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-white">{ref.title}</span>
                      {isSafeUrl && (
                        <a
                          href={ref.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-[11px] text-purple-400 hover:text-purple-300"
                        >
                          <span>Open Evidence</span>
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </a>
                      )}
                    </div>
                    {ref.hash && <div className="text-[10px] text-zinc-500 font-mono">Hash: {ref.hash}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Pending Reconcile Notice */}
      {reconcilePendingMessage && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 p-3 text-xs text-amber-300 flex items-center justify-between">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
            <span>{reconcilePendingMessage}</span>
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={refetchDealData}
            className="h-6 text-[11px] border-amber-500/40 text-amber-300 hover:bg-amber-900/40 shrink-0"
          >
            Refresh
          </Button>
        </div>
      )}

      {/* Action Error Banner */}
      {actionError && (
        <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-xs text-red-300 flex items-start justify-between">
          <span className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
            <span>{actionError}</span>
          </span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="text-red-400 hover:text-red-200 shrink-0 ml-2"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Open Serious Dispute Trigger Button (when eligible) */}
      {canOpenSeriousDispute && (
        <div className="pt-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs border-rose-500/30 text-rose-300 hover:bg-rose-950/40 hover:border-rose-500/60 font-medium flex items-center gap-1.5"
            onClick={() => {
              setShowOpenDisputeModal(true);
              setStagingDisputeError(null);
            }}
          >
            <Scale className="h-3.5 w-3.5 text-rose-400" /> Open Serious Dispute
          </Button>
        </div>
      )}

      {/* --------------------------------------------------------------------- */}
      {/* FINAL RESOLUTION SETTLED CARD (When milestone Settled via Final Res)   */}
      {/* --------------------------------------------------------------------- */}
      {currentMilestone.status === MilestoneStatus.SettledSplit && finalReport && (
        <div className="rounded-xl border border-indigo-500/30 bg-indigo-950/20 p-4 space-y-4">
          <div className="flex items-center justify-between border-b border-indigo-500/20 pb-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-indigo-400" />
              <div>
                <span className="text-sm font-bold text-white">Final Resolution Executed by Committee</span>
                <p className="text-[11px] text-indigo-300/80">
                  The resolution committee completed final review and executed the binding split on-chain.
                </p>
              </div>
            </div>
            <Badge variant="outline" className="border-indigo-500/40 bg-indigo-500/10 text-xs text-indigo-300">
              Settled • {formatUsdcAmount(currentMilestone.amount)} USDC
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs font-mono">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5">
              <div className="text-[10px] text-zinc-400 uppercase font-sans">Freelancer Received</div>
              <div className="font-bold text-white text-sm">
                {formatUsdcAmount(finalReport.freelancerAmount)} USDC
              </div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5">
              <div className="text-[10px] text-zinc-400 uppercase font-sans">Client Received</div>
              <div className="font-bold text-white text-sm">
                {formatUsdcAmount(finalReport.clientAmount)} USDC
              </div>
            </div>
          </div>

          <div className="pt-1 flex items-center justify-between">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setShowFinalReportDrawer((prev) => !prev)}
              className="h-8 text-xs text-indigo-300 hover:text-indigo-100 hover:bg-indigo-950/40 flex items-center gap-1.5"
            >
              <FileText className="h-3.5 w-3.5" />
              <span>{showFinalReportDrawer ? 'Hide Final Resolution Report' : 'View Final Resolution Report'}</span>
              {showFinalReportDrawer ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </Button>
          </div>

          {showFinalReportDrawer && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 space-y-3">
              <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                <span className="text-[11px] font-semibold text-zinc-300 flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5 text-indigo-400" /> Final Committee Resolution Report
                </span>
                <Badge variant="outline" className="border-indigo-500/30 bg-indigo-500/10 text-[10px] text-indigo-300">
                  Confirmed Explanatory Record
                </Badge>
              </div>

              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Summary</div>
                <div className="rounded-md bg-zinc-950/70 p-2.5 text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed border border-zinc-800/80">
                  {finalReport.summary}
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Findings</div>
                <div className="rounded-md bg-zinc-950/70 p-2.5 text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed border border-zinc-800/80">
                  {finalReport.findings}
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Justification</div>
                <div className="rounded-md bg-zinc-950/70 p-2.5 text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed border border-zinc-800/80">
                  {finalReport.justification}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* --------------------------------------------------------------------- */}
      {/* DISPUTED STATE CARD (When milestone is Disputed)                     */}
      {/* --------------------------------------------------------------------- */}
      {isDisputed && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 p-4 space-y-4">
          <div className="flex items-center justify-between border-b border-rose-500/20 pb-3">
            <div className="flex items-center gap-2">
              <Scale className="h-5 w-5 text-rose-400" />
              <div>
                <span className="text-sm font-bold text-white">Dispute Open</span>
                <p className="text-[11px] text-rose-300/80">
                  Escrow remains held while resolution is pending.
                </p>
              </div>
            </div>
            <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 text-xs text-rose-300">
              Escrow Held • {formatUsdcAmount(currentMilestone.amount)} USDC
            </Badge>
          </div>

          {/* Canonical Dispute Details (Participant View) */}
          {isParticipant ? (
            disputeRecord ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 space-y-3">
                <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                  <span className="text-[11px] font-semibold text-zinc-300 flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5 text-rose-400" /> Canonical Serious Dispute Record
                  </span>
                  <Badge variant="outline" className="border-rose-500/30 bg-rose-500/10 text-[10px] text-rose-300">
                    Cryptographically Verified
                  </Badge>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-2.5 space-y-1">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Opened By</div>
                    <div className="font-mono text-zinc-200 flex items-center gap-1.5">
                      <span>{shortenAddress(disputeRecord.dispute?.openerWallet || '')}</span>
                      {address &&
                      disputeRecord.dispute?.openerWallet?.toLowerCase() === address.toLowerCase() ? (
                        <Badge variant="outline" className="border-purple-500/40 text-[9px] text-purple-300">
                          You
                        </Badge>
                      ) : null}
                    </div>
                  </div>

                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-2.5 space-y-1">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Category</div>
                    <div className="capitalize text-zinc-200">
                      {(disputeRecord.manifest?.category || disputeRecord.dispute?.canonicalManifest?.category || 'General Dispute').replace('_', ' ')}
                    </div>
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Explanation</div>
                  <div className="rounded-md bg-zinc-950/70 p-2.5 text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed border border-zinc-800/80">
                    {disputeRecord.dispute?.canonicalManifest?.explanation || disputeRecord.manifest?.explanation}
                  </div>
                </div>

                {/* Evidence Links if present */}
                {disputeRecord.manifest?.links && disputeRecord.manifest.links.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">
                      Referenced Evidence Links ({disputeRecord.manifest.links.length})
                    </div>
                    <div className="space-y-1">
                      {disputeRecord.manifest.links.map((link: any, idx: number) => (
                        <a
                          key={idx}
                          href={link.value}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-950/50 px-2.5 py-1.5 text-xs text-purple-300 hover:border-purple-500/40 transition-colors"
                        >
                          <span className="truncate">{link.label || link.value}</span>
                          <ExternalLink className="h-3 w-3 shrink-0 ml-1.5 opacity-70" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : loadingDisputeRecord ? (
              <div className="rounded-lg border border-zinc-800 p-3 text-center text-xs text-zinc-400 flex items-center justify-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-rose-400" />
                Retrieving dispute record…
              </div>
            ) : disputeRecordError ? (
              <div className="rounded-lg border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-300 flex items-center justify-between">
                <span>Dispute details could not be retrieved from the server.</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={loadDisputeRecord}
                  className="h-6 text-[11px] border-rose-500/40 text-rose-300 hover:bg-rose-900/40"
                >
                  Retry
                </Button>
              </div>
            ) : (
              // No serious dispute record found: Revision-created dispute
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-300 space-y-1">
                <div className="font-semibold text-white flex items-center gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5 text-amber-400" /> Revision Escalation
                </div>
                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  This dispute began after a revision request was declined or timed out. Escrow remains held securely while resolution is pending.
                </p>
              </div>
            )
          ) : (
            // Outsider View: Generic copy, no private explanation leaked
            <p className="text-xs text-zinc-400 leading-relaxed">
              Milestone {currentIndex + 1} is currently in dispute. Escrow funds ({formatUsdcAmount(currentMilestone.amount)} USDC) remain held securely in the Deal clone.
            </p>
          )}
        </div>
      )}

      {/* --------------------------------------------------------------------- */}
      {/* RESOLUTION PROPOSED CARD (When milestone is ResolutionProposed)       */}
      {/* --------------------------------------------------------------------- */}
      {isResolutionProposed && (
        <div className="rounded-xl border border-purple-500/30 bg-purple-950/20 p-4 space-y-4">
          <div className="flex items-center justify-between border-b border-purple-500/20 pb-3">
            <div className="flex items-center gap-2">
              <Scale className="h-5 w-5 text-purple-400" />
              <div>
                <span className="text-sm font-bold text-white">Committee Resolution Proposed</span>
                <p className="text-[11px] text-purple-300/80">
                  The resolver committee has proposed an escrow resolution split.
                </p>
              </div>
            </div>
            <Badge variant="outline" className="border-purple-500/40 bg-purple-500/10 text-xs text-purple-300">
              Proposed Split • {formatUsdcAmount(currentMilestone.amount)} USDC
            </Badge>
          </div>

          {loadingResolutionProposal ? (
            <div className="rounded-lg border border-zinc-800 p-4 text-center text-xs text-zinc-400 flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-purple-400" />
              Reading resolution proposal from blockchain…
            </div>
          ) : resolutionProposalError ? (
            <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-xs text-red-300 flex items-center justify-between">
              <span>{resolutionProposalError}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={loadResolutionProposal}
                className="h-6 text-[11px] border-red-500/40 text-red-300 hover:bg-red-900/40"
              >
                Retry
              </Button>
            </div>
          ) : resolutionProposal ? (
            <div className="space-y-4">
              {/* Proposed Split Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="rounded-lg border border-purple-500/20 bg-zinc-950/60 p-3 space-y-1">
                  <div className="text-[10px] text-zinc-400 uppercase font-semibold">Freelancer Receives</div>
                  <div className="text-lg font-bold text-white font-mono">
                    {formatUsdcAmount(resolutionProposal.freelancerAmount)} USDC
                  </div>
                  {isFreelancer && (
                    <Badge variant="outline" className="border-purple-500/40 text-[9px] text-purple-300">
                      Your Payout
                    </Badge>
                  )}
                </div>

                <div className="rounded-lg border border-purple-500/20 bg-zinc-950/60 p-3 space-y-1">
                  <div className="text-[10px] text-zinc-400 uppercase font-semibold">Client Receives</div>
                  <div className="text-lg font-bold text-white font-mono">
                    {formatUsdcAmount(resolutionProposal.clientAmount)} USDC
                  </div>
                  {isClient && (
                    <Badge variant="outline" className="border-purple-500/40 text-[9px] text-purple-300">
                      Your Refund
                    </Badge>
                  )}
                </div>
              </div>

              {/* Reconsideration Window & Deadline */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-300 flex items-center gap-1.5 font-medium">
                    <Clock className="h-3.5 w-3.5 text-purple-400" />
                    {isReconsiderationWindowClosed ? 'Reconsideration Window Closed' : '72-Hour Reconsideration Window'}
                  </span>
                  {isReconsiderationWindowClosed ? (
                    <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px]">
                      Ready to Execute
                    </Badge>
                  ) : isReconsiderationWindowClosingSoon ? (
                    <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px] animate-pulse">
                      Closing Soon
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-purple-500/40 bg-purple-500/10 text-purple-300 text-[10px]">
                      Window Active
                    </Badge>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] pt-1 border-t border-zinc-800/60">
                  <div>
                    <span className="text-zinc-400">Deadline: </span>
                    <span className="text-zinc-200 font-mono">
                      {formatTimestamp(resolutionProposal.reconsiderationDeadline)}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-400">Remaining: </span>
                    <span className={cn('font-mono font-semibold', isReconsiderationWindowClosed ? 'text-zinc-400' : isReconsiderationWindowClosingSoon ? 'text-amber-300' : 'text-purple-300')}>
                      {remainingReconsiderationSeconds !== null
                        ? formatCountdown(remainingReconsiderationSeconds)
                        : '—'}
                    </span>
                  </div>
                </div>

                <p className="text-[11px] text-zinc-400 leading-relaxed pt-1">
                  {isReconsiderationWindowClosed
                    ? "The reconsideration window has closed. The committee's proposed split can now be settled on-chain."
                    : 'If both parties agree with this resolution, no action is required. The proposed split becomes executable after the reconsideration window closes.'}
                </p>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-purple-500/20">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowReportDrawer((prev) => !prev)}
                  className="h-8 text-xs text-purple-300 hover:text-purple-100 hover:bg-purple-950/40 flex items-center gap-1.5"
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span>{showReportDrawer ? 'Hide Resolution Report' : 'View Resolution Report'}</span>
                  {showReportDrawer ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </Button>

                <div className="flex items-center gap-2">
                  {canRequestReconsideration && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs border-amber-500/40 text-amber-300 hover:bg-amber-950/40 hover:border-amber-500/70 font-medium"
                      onClick={() => {
                        setShowReconsiderModal(true);
                        setReconsiderError(null);
                      }}
                      disabled={actionInProgress}
                    >
                      Request Final Reconsideration
                    </Button>
                  )}

                  {canExecuteResolution && (
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1.5"
                      onClick={() => {
                        setShowExecuteModal(true);
                        setExecuteError(null);
                      }}
                      disabled={actionInProgress}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" /> Execute Resolution
                    </Button>
                  )}
                </div>
              </div>

              {/* Collapsible Resolution Report Drawer */}
              {showReportDrawer && renderResolutionReportDrawer()}
            </div>
          ) : null}
        </div>
      )}

      {/* --------------------------------------------------------------------- */}
      {/* FINAL REVIEW CARD (When milestone is FinalReview)                     */}
      {/* --------------------------------------------------------------------- */}
      {isFinalReview && (
        <div className="rounded-xl border border-indigo-500/30 bg-indigo-950/20 p-4 space-y-4">
          <div className="flex items-center justify-between border-b border-indigo-500/20 pb-3">
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-indigo-400" />
              <div>
                <span className="text-sm font-bold text-white">Final Review in Progress</span>
                <p className="text-[11px] text-indigo-300/80">
                  A final reconsideration was requested. The committee is reviewing the milestone again.
                </p>
              </div>
            </div>
            <Badge variant="outline" className="border-indigo-500/40 bg-indigo-500/10 text-xs text-indigo-300">
              Escrow Held • {formatUsdcAmount(currentMilestone.amount)} USDC
            </Badge>
          </div>

          <p className="text-xs text-zinc-300 leading-relaxed">
            The initial proposed resolution is no longer executable because a participant requested final reconsideration. The resolution committee will review the dispute and submit a final binding resolution.
          </p>

          {/* Historical Initial Proposal Context */}
          {resolutionProposal && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2 text-xs">
              <div className="text-[10px] text-zinc-400 uppercase font-semibold">
                Initial Proposed Split (Pending Final Review)
              </div>
              <div className="grid grid-cols-2 gap-2 font-mono">
                <div className="rounded bg-zinc-950/50 p-2">
                  <div className="text-[10px] text-zinc-400 uppercase font-sans">Freelancer</div>
                  <div className="font-bold text-zinc-300">
                    {formatUsdcAmount(resolutionProposal.freelancerAmount)} USDC
                  </div>
                </div>
                <div className="rounded bg-zinc-950/50 p-2">
                  <div className="text-[10px] text-zinc-400 uppercase font-sans">Client</div>
                  <div className="font-bold text-zinc-300">
                    {formatUsdcAmount(resolutionProposal.clientAmount)} USDC
                  </div>
                </div>
              </div>
              <p className="text-[10px] text-zinc-500 italic">
                Note: This initial proposal is for historical context and is not directly executable.
              </p>
            </div>
          )}

          <div className="pt-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setShowReportDrawer((prev) => !prev)}
              className="h-8 text-xs text-indigo-300 hover:text-indigo-100 hover:bg-indigo-950/40 flex items-center gap-1.5"
            >
              <FileText className="h-3.5 w-3.5" />
              <span>{showReportDrawer ? 'Hide Resolution Report' : 'View Initial Resolution Report'}</span>
              {showReportDrawer ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </Button>
          </div>

          {showReportDrawer && renderResolutionReportDrawer()}
        </div>
      )}

      {/* --------------------------------------------------------------------- */}
      {/* DIRECT MUTUAL SETTLEMENT SECTION                                     */}
      {/* Available in: Submitted, RevisionRequested, Disputed,               */}
      {/* ResolutionProposed, FinalReview                                      */}
      {/* --------------------------------------------------------------------- */}
      {canUseMutualSettlement && (
        <Card className="border-purple-500/20 bg-zinc-950/40">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
                  <Handshake className="h-4 w-4 text-purple-400" /> Direct Mutual Settlement
                </CardTitle>
                <CardDescription className="text-xs text-zinc-400">
                  {isDisputed
                    ? 'Both parties can still settle this milestone directly without waiting for a resolver.'
                    : 'Propose how this milestone escrow should be split between the freelancer and client.'}
                </CardDescription>
              </div>
              <Button
                size="sm"
                className="h-7 text-xs bg-purple-600 hover:bg-purple-500 text-white font-medium"
                onClick={() => {
                  setShowProposeModal(true);
                  setProposeError(null);
                  setFreelancerAmountInput('');
                  setClientAmountInput('');
                }}
              >
                Propose Settlement
              </Button>
            </div>
          </CardHeader>

          <CardContent className="space-y-3">
            {loadingProposals ? (
              <div className="rounded-lg border border-zinc-800 p-3 text-center text-xs text-zinc-400 flex items-center justify-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-purple-400" /> Loading proposals…
              </div>
            ) : proposals.length === 0 ? (
              <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/30 p-3 text-center text-xs text-zinc-400">
                No active settlement proposals. Either participant can propose an agreed escrow split.
              </div>
            ) : (
              <div className="space-y-2">
                {proposals.map((p) => {
                  const isProposer =
                    address && p.proposerWallet.toLowerCase() === address.toLowerCase();
                  const isCounterparty =
                    address && p.counterpartyWallet.toLowerCase() === address.toLowerCase();

                  return (
                    <div
                      key={p.id}
                      className={cn(
                        'rounded-lg border p-3 text-xs transition-colors space-y-2.5',
                        p.status === 'executed'
                          ? 'border-emerald-500/30 bg-emerald-950/10'
                          : p.status === 'cancelled'
                          ? 'border-zinc-800 bg-zinc-900/20 opacity-60'
                          : p.isExpired
                          ? 'border-zinc-800 bg-zinc-900/20 opacity-60'
                          : 'border-zinc-800 bg-zinc-900/50'
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-white">
                            {isProposer
                              ? 'Your Proposal'
                              : `Proposal from ${isClient ? 'Freelancer' : 'Client'}`}
                          </span>
                          <span className="font-mono text-[10px] text-zinc-400">
                            Nonce #{p.proposalNonce}
                          </span>
                        </div>

                        {p.status === 'executed' ? (
                          <Badge variant="outline" className="border-emerald-500/40 text-emerald-300 text-[10px]">
                            Executed
                          </Badge>
                        ) : p.status === 'cancelled' ? (
                          <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-[10px]">
                            Cancelled
                          </Badge>
                        ) : p.isExpired ? (
                          <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-[10px]">
                            Expired
                          </Badge>
                        ) : p.status === 'invalidated' ? (
                          <Badge variant="outline" className="border-zinc-700 text-zinc-400 text-[10px]">
                            Invalidated
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-amber-500/40 text-amber-300 text-[10px]">
                            Pending
                          </Badge>
                        )}
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        <div className="rounded bg-zinc-950/60 p-2 space-y-0.5">
                          <div className="text-[10px] text-zinc-400 uppercase">Freelancer Receives</div>
                          <div className="font-bold text-white">
                            {formatUsdcAmount(BigInt(p.freelancerAmount))} USDC
                          </div>
                        </div>

                        <div className="rounded bg-zinc-950/60 p-2 space-y-0.5">
                          <div className="text-[10px] text-zinc-400 uppercase">Client Receives</div>
                          <div className="font-bold text-white">
                            {formatUsdcAmount(BigInt(p.clientAmount))} USDC
                          </div>
                        </div>

                        <div className="rounded bg-zinc-950/60 p-2 space-y-0.5 col-span-2 sm:col-span-1">
                          <div className="text-[10px] text-zinc-400 uppercase">Expires</div>
                          <div className="text-zinc-200">
                            {formatTimestamp(Number(p.validUntil))}
                          </div>
                        </div>
                      </div>

                      {/* Action Buttons */}
                      <div className="flex items-center justify-end gap-2 pt-1 border-t border-zinc-800/60">
                        {/* Proposer: Cancel Proposal */}
                        {isProposer && p.status === 'pending' && !p.isExpired && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs border-rose-500/30 text-rose-300 hover:bg-rose-950/40"
                            disabled={actionInProgress}
                            onClick={() => setCancellingProposal(p)}
                          >
                            Cancel Proposal
                          </Button>
                        )}

                        {/* Counterparty: Accept Settlement (if executable) */}
                        {isCounterparty && p.isExecutable && (
                          <Button
                            size="sm"
                            className="h-7 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
                            disabled={actionInProgress}
                            onClick={() => setAcceptingProposal(p)}
                          >
                            Accept Settlement
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* --------------------------------------------------------------------- */}
      {/* MODAL: Open Serious Dispute                                          */}
      {/* --------------------------------------------------------------------- */}
      {showOpenDisputeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="space-y-0.5">
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Scale className="h-4 w-4 text-rose-400" /> Open Serious Dispute
                </h3>
                <p className="text-xs text-zinc-400">
                  Milestone {currentIndex + 1} • {formatUsdcAmount(currentMilestone.amount)} USDC
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowOpenDisputeModal(false);
                  setStagingDisputeError(null);
                }}
                className="text-zinc-400 hover:text-white"
                disabled={stagingDisputeInProgress}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="rounded-lg border border-rose-500/30 bg-rose-950/20 p-3 space-y-1.5 text-xs text-zinc-300">
              <div className="font-semibold text-rose-300 flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 text-rose-400 shrink-0" /> Important Warning
              </div>
              <p className="text-[11px] text-zinc-300 leading-relaxed">
                Opening a serious dispute escalates this milestone for resolution. Escrow remains held securely in the contract while the dispute is unresolved.
              </p>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Opening a dispute does <strong>not</strong> refund the client immediately or pay the freelancer immediately.
              </p>
            </div>

            {stagingDisputeError && (
              <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2.5 text-xs text-red-300 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                <span>{stagingDisputeError}</span>
              </div>
            )}

            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-zinc-300">
                  Dispute Category
                </label>
                <select
                  value={disputeCategory}
                  onChange={(e) => setDisputeCategory(e.target.value)}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-white focus:border-rose-500 focus:outline-none"
                  disabled={stagingDisputeInProgress}
                >
                  <option value="specification_breach">Specification Breach</option>
                  <option value="quality_dispute">Quality Dispute</option>
                  <option value="scope_discrepancy">Scope Discrepancy</option>
                  <option value="deadline_missed">Deadline Missed</option>
                  <option value="unresponsive_counterparty">Unresponsive Counterparty</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label className="font-semibold text-zinc-300">
                    Explain the Issue <span className="text-red-400">*</span>
                  </label>
                  <span className="text-[10px] text-zinc-500">
                    {disputeExplanation.length} / {DISPUTE_LIMITS.MAX_EXPLANATION_LENGTH}
                  </span>
                </div>
                <textarea
                  value={disputeExplanation}
                  onChange={(e) => setDisputeExplanation(e.target.value.slice(0, DISPUTE_LIMITS.MAX_EXPLANATION_LENGTH))}
                  placeholder="Detail the specific contractual or deliverables failure requiring dispute escalation…"
                  rows={4}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2.5 text-xs text-white placeholder-zinc-500 focus:border-rose-500 focus:outline-none leading-relaxed"
                  disabled={stagingDisputeInProgress}
                />
              </div>

              {/* Evidence Links */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-zinc-300">
                    Supporting Links (Optional)
                  </label>
                  {disputeLinks.length < DISPUTE_LIMITS.MAX_LINKS_COUNT && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={handleAddDisputeLink}
                      className="h-6 text-[11px] text-purple-400 hover:text-purple-300 p-0"
                      disabled={stagingDisputeInProgress}
                    >
                      <Plus className="h-3 w-3 mr-1" /> Add Link
                    </Button>
                  )}
                </div>

                {disputeLinks.map((link) => (
                  <div key={link.id} className="flex items-center gap-2">
                    <select
                      value={link.type}
                      onChange={(e) => handleUpdateDisputeLink(link.id, 'type', e.target.value as any)}
                      className="w-24 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-white focus:outline-none"
                      disabled={stagingDisputeInProgress}
                    >
                      <option value="web">Web</option>
                      <option value="pr">PR</option>
                      <option value="commit">Commit</option>
                      <option value="repository">Repo</option>
                    </select>
                    <input
                      type="url"
                      placeholder="https://…"
                      value={link.value}
                      onChange={(e) => handleUpdateDisputeLink(link.id, 'value', e.target.value)}
                      className="flex-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-white placeholder-zinc-500 focus:outline-none"
                      disabled={stagingDisputeInProgress}
                    />
                    <input
                      type="text"
                      placeholder="Label"
                      value={link.label}
                      onChange={(e) => handleUpdateDisputeLink(link.id, 'label', e.target.value)}
                      className="w-24 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-white placeholder-zinc-500 focus:outline-none"
                      disabled={stagingDisputeInProgress}
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveDisputeLink(link.id)}
                      className="text-zinc-500 hover:text-red-400"
                      disabled={stagingDisputeInProgress}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowOpenDisputeModal(false);
                  setStagingDisputeError(null);
                }}
                disabled={stagingDisputeInProgress}
                className="h-8 text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-900"
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleStageAndOpenDispute}
                disabled={stagingDisputeInProgress || disputeExplanation.trim().length < DISPUTE_LIMITS.MIN_EXPLANATION_LENGTH}
                className="h-8 text-xs bg-rose-600 hover:bg-rose-500 text-white font-medium"
              >
                {stagingDisputeInProgress ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Staging & Opening…
                  </>
                ) : (
                  <>
                    <Scale className="mr-1.5 h-3.5 w-3.5" /> Stage & Open Dispute
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* --------------------------------------------------------------------- */}
      {/* MODAL: Propose Mutual Settlement                                      */}
      {/* --------------------------------------------------------------------- */}
      {showProposeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="space-y-0.5">
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Handshake className="h-4 w-4 text-purple-400" /> Propose Mutual Settlement
                </h3>
                <p className="text-xs text-zinc-400">
                  Total Milestone Escrow: {formatUsdcAmount(currentMilestone.amount)} USDC
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowProposeModal(false);
                  setProposeError(null);
                }}
                className="text-zinc-400 hover:text-white"
                disabled={proposeInProgress}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-xs text-zinc-400 leading-relaxed">
              Propose how this milestone escrow should be split between the freelancer and client.
              The other party must accept the signed proposal on-chain.
            </p>

            {proposeError && (
              <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2.5 text-xs text-red-300 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                <span>{proposeError}</span>
              </div>
            )}

            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-zinc-300">
                  Freelancer Receives (USDC)
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={freelancerAmountInput}
                  onChange={(e) => handleFreelancerAmountChange(e.target.value)}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-white focus:border-purple-500 focus:outline-none font-mono"
                  disabled={proposeInProgress}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-zinc-300">
                  Client Receives (USDC)
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={clientAmountInput}
                  onChange={(e) => handleClientAmountChange(e.target.value)}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-white focus:border-purple-500 focus:outline-none font-mono"
                  disabled={proposeInProgress}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-zinc-300">
                  Proposal Expiration (validUntil)
                </label>
                <input
                  type="datetime-local"
                  value={validUntilInput}
                  onChange={(e) => {
                    setValidUntilInput(e.target.value);
                    setProposeError(null);
                  }}
                  min={new Date(Date.now() + 300 * 1000).toISOString().slice(0, 16)}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-white focus:border-purple-500 focus:outline-none"
                  disabled={proposeInProgress}
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowProposeModal(false);
                  setProposeError(null);
                }}
                disabled={proposeInProgress}
                className="h-8 text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-900"
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleProposeSettlement}
                disabled={proposeInProgress || !freelancerAmountInput || !clientAmountInput || !validUntilInput}
                className="h-8 text-xs bg-purple-600 hover:bg-purple-500 text-white font-medium"
              >
                {proposeInProgress ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Signing…
                  </>
                ) : (
                  <>
                    <Send className="mr-1.5 h-3.5 w-3.5" /> Sign & Propose
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* --------------------------------------------------------------------- */}
      {/* MODAL: Accept Settlement Confirmation (Counterparty)                  */}
      {/* --------------------------------------------------------------------- */}
      {acceptingProposal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" /> Accept Mutual Settlement
              </h3>
              <button
                type="button"
                onClick={() => setAcceptingProposal(null)}
                className="text-zinc-400 hover:text-white"
                disabled={actionInProgress}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-3 space-y-2 text-xs">
              <div className="font-semibold text-emerald-300">Confirm Agreed Escrow Distribution</div>
              <p className="text-[11px] text-zinc-300 leading-relaxed">
                Accepting this proposal settles this milestone immediately according to this split. This is financially final.
              </p>
              <div className="grid grid-cols-2 gap-2 pt-1 font-mono">
                <div className="rounded bg-zinc-900/60 p-2">
                  <div className="text-[10px] text-zinc-400 uppercase font-sans">Freelancer Receives</div>
                  <div className="font-bold text-white">
                    {formatUsdcAmount(BigInt(acceptingProposal.freelancerAmount))} USDC
                  </div>
                </div>
                <div className="rounded bg-zinc-900/60 p-2">
                  <div className="text-[10px] text-zinc-400 uppercase font-sans">Client Receives</div>
                  <div className="font-bold text-white">
                    {formatUsdcAmount(BigInt(acceptingProposal.clientAmount))} USDC
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAcceptingProposal(null)}
                disabled={actionInProgress}
                className="h-8 text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-900"
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => handleExecuteSettlement(acceptingProposal)}
                disabled={actionInProgress}
                className="h-8 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
              >
                {actionInProgress ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Settling…
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Confirm Settlement
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* --------------------------------------------------------------------- */}
      {/* MODAL: Cancel Proposal Confirmation (Proposer)                        */}
      {/* --------------------------------------------------------------------- */}
      {cancellingProposal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-rose-400" /> Cancel Proposal
              </h3>
              <button
                type="button"
                onClick={() => setCancellingProposal(null)}
                className="text-zinc-400 hover:text-white"
                disabled={actionInProgress}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-xs text-zinc-300 leading-relaxed">
              Are you sure you want to cancel this settlement proposal (Nonce #{cancellingProposal.proposalNonce}) on-chain? The counterparty will no longer be able to execute it.
            </p>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setCancellingProposal(null)}
                disabled={actionInProgress}
                className="h-8 text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-900"
              >
                Keep Proposal
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => handleCancelProposal(cancellingProposal)}
                disabled={actionInProgress}
                className="h-8 text-xs bg-rose-600 hover:bg-rose-500 text-white font-medium"
              >
                {actionInProgress ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Cancelling…
                  </>
                ) : (
                  'Yes, Cancel Proposal'
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* --------------------------------------------------------------------- */}
      {/* MODAL: Request Final Reconsideration Confirmation (Phase 3M-F)        */}
      {/* --------------------------------------------------------------------- */}
      {showReconsiderModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-400" /> Request Final Reconsideration
              </h3>
              <button
                type="button"
                onClick={() => {
                  setShowReconsiderModal(false);
                  setReconsiderError(null);
                }}
                className="text-zinc-400 hover:text-white"
                disabled={reconsiderInProgress}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 space-y-2 text-xs">
              <div className="font-semibold text-amber-300">Important Consequences</div>
              <ul className="list-disc pl-4 space-y-1 text-[11px] text-zinc-300 leading-relaxed">
                <li>This milestone will transition into <strong>Final Review</strong>.</li>
                <li>The current proposed resolution will <strong>not</strong> execute.</li>
                <li>The resolution committee must review and submit a final resolution.</li>
                <li>Direct mutual settlement remains available while in Final Review.</li>
              </ul>
            </div>

            {reconsiderError && (
              <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2.5 text-xs text-red-300 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                <span>{reconsiderError}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowReconsiderModal(false);
                  setReconsiderError(null);
                }}
                disabled={reconsiderInProgress}
                className="h-8 text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-900"
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleRequestReconsideration}
                disabled={reconsiderInProgress}
                className="h-8 text-xs bg-amber-600 hover:bg-amber-500 text-white font-medium"
              >
                {reconsiderInProgress ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Submitting Request…
                  </>
                ) : (
                  'Confirm Reconsideration Request'
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* --------------------------------------------------------------------- */}
      {/* MODAL: Execute Resolution Confirmation (Phase 3M-F)                   */}
      {/* --------------------------------------------------------------------- */}
      {showExecuteModal && resolutionProposal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" /> Execute Resolution Split
              </h3>
              <button
                type="button"
                onClick={() => {
                  setShowExecuteModal(false);
                  setExecuteError(null);
                }}
                className="text-zinc-400 hover:text-white"
                disabled={executeInProgress}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-3 space-y-2 text-xs">
              <div className="font-semibold text-emerald-300">Confirm On-Chain Escrow Disbursement</div>
              <p className="text-[11px] text-zinc-300 leading-relaxed">
                The 72-hour reconsideration window has closed without reconsideration. Executing this transaction settles the milestone and disburses escrow funds immediately.
              </p>
              <div className="grid grid-cols-2 gap-2 pt-1 font-mono">
                <div className="rounded bg-zinc-900/60 p-2">
                  <div className="text-[10px] text-zinc-400 uppercase font-sans">Freelancer Receives</div>
                  <div className="font-bold text-white">
                    {formatUsdcAmount(resolutionProposal.freelancerAmount)} USDC
                  </div>
                </div>
                <div className="rounded bg-zinc-900/60 p-2">
                  <div className="text-[10px] text-zinc-400 uppercase font-sans">Client Receives</div>
                  <div className="font-bold text-white">
                    {formatUsdcAmount(resolutionProposal.clientAmount)} USDC
                  </div>
                </div>
              </div>
            </div>

            {executeError && (
              <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2.5 text-xs text-red-300 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                <span>{executeError}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowExecuteModal(false);
                  setExecuteError(null);
                }}
                disabled={executeInProgress}
                className="h-8 text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-900"
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleExecuteResolution}
                disabled={executeInProgress}
                className="h-8 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
              >
                {executeInProgress ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Executing…
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Confirm Execution
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
