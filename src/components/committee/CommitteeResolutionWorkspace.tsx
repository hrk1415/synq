'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAccount, useSignTypedData, useWriteContract } from 'wagmi';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { shortenAddress } from '@/lib/utils';
import { parseUsdcAmount, formatUsdcAmount } from '@/lib/deals/v2';
import { synqResolutionCommitteeABI, synqDealV1ABI } from '@/lib/contracts/abis';
import { MilestoneStatus } from '@/lib/deals/v2-deal';
import { sepoliaPublicClient } from '@/lib/chain';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';
import type { CommitteeQueueItem } from '@/lib/deals/committee-queue';
import { getCommitteeTimingInfo, CommitteeTimingBadge } from '@/components/committee/CommitteeQueue';
import type { CanonicalResolutionReportV1 } from '@/lib/deals/v2-resolution-report';
import type { MilestoneDisputeRow, MilestoneResolutionReportRow } from '@/db/schema';
import {
  Scale,
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  Send,
  ArrowLeft,
  Check,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ShieldAlert,
  Info,
  History,
  GitCompare,
  Clock,
  ArrowRight,
  Search,
} from 'lucide-react';

/**
 * Validates that an evidence reference is a safe HTTP/HTTPS URL.
 * Strictly prevents dangerous schemes (javascript:, data:, vbscript:) and malformed input.
 */
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

interface CommitteeResolutionWorkspaceProps {
  item: CommitteeQueueItem;
  onBack: () => void;
  onSettled: () => void;
  onViewInHistory?: (caseInfo: {
    dealAddress: string;
    milestoneId: number;
    phase: ResolutionReportPhase;
  }) => void;
}

export function CommitteeResolutionWorkspace({
  item,
  onBack,
  onSettled,
  onViewInHistory,
}: CommitteeResolutionWorkspaceProps) {
  const { address } = useAccount();
  const { ensureSepolia } = useSepoliaNetwork();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();
  const { getToken } = useAuthSession();

  const isFinal = item.phase === 'FINAL_RESOLUTION';
  const milestoneAmountBigInt = useMemo(() => BigInt(item.milestoneAmount), [item.milestoneAmount]);

  // Shared live clock for timing indicators (30s interval)
  const [nowSec, setNowSec] = useState<number>(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    setNowSec(Math.floor(Date.now() / 1000));
    const interval = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const timingInfo = useMemo(() => getCommitteeTimingInfo(item, nowSec), [item, nowSec]);

  // Stage Report State
  const [freelancerAmountInput, setFreelancerAmountInput] = useState<string>('');
  const [clientAmountInput, setClientAmountInput] = useState<string>('');
  const [summaryInput, setSummaryInput] = useState<string>('');
  const [findingsInput, setFindingsInput] = useState<string>('');
  const [justificationInput, setJustificationInput] = useState<string>('');

  const [stagedReport, setStagedReport] = useState<CanonicalResolutionReportV1 | null>(null);
  const [stagedReportId, setStagedReportId] = useState<string | null>(null);
  const [stagingInProgress, setStagingInProgress] = useState<boolean>(false);
  const [stageError, setStageError] = useState<string | null>(null);

  // Authorization State
  const [currentAuth, setCurrentAuth] = useState<any | null>(null);
  const [creatingAuth, setCreatingAuth] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Signing State
  const [signingInProgress, setSigningInProgress] = useState<boolean>(false);
  const [signError, setSignError] = useState<string | null>(null);

  // Submission & Recovery State
  const [preparingExecution, setPreparingExecution] = useState<boolean>(false);
  const [submittingInProgress, setSubmittingInProgress] = useState<boolean>(false);
  const [reconcilingInProgress, setReconcilingInProgress] = useState<boolean>(false);
  const [executionTxHash, setExecutionTxHash] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isAmbiguousFailure, setIsAmbiguousFailure] = useState<boolean>(false);
  const [reconciliationFailed, setReconciliationFailed] = useState<boolean>(false);
  const [reconciliationSuccess, setReconciliationSuccess] = useState<boolean>(false);

  // Transaction Recovery Actions State
  const [checkingOnChain, setCheckingOnChain] = useState<boolean>(false);
  const [onChainMilestoneStatus, setOnChainMilestoneStatus] = useState<number | null>(null);
  const [onChainCheckMessage, setOnChainCheckMessage] = useState<string | null>(null);
  const [onChainCheckSuccess, setOnChainCheckSuccess] = useState<boolean>(false);
  const [recoveryTxHashInput, setRecoveryTxHashInput] = useState<string>('');
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoverySuccessMessage, setRecoverySuccessMessage] = useState<string | null>(null);
  const [showManualRecovery, setShowManualRecovery] = useState<boolean>(false);

  // Reset case-specific interaction state when switching deals/milestones/phases
  useEffect(() => {
    setExecutionTxHash(null);
    setSubmitError(null);
    setIsAmbiguousFailure(false);
    setReconciliationFailed(false);
    setReconciliationSuccess(false);
    setRecoveryTxHashInput('');
    setRecoveryError(null);
    setRecoverySuccessMessage(null);
    setOnChainMilestoneStatus(null);
    setOnChainCheckMessage(null);
    setOnChainCheckSuccess(false);
    setShowManualRecovery(false);
  }, [item.dealAddress, item.milestoneId, item.phase]);

  // Dispute Evidence & Claims State (Phase 2B)
  const [disputeRecord, setDisputeRecord] = useState<MilestoneDisputeRow | null>(null);
  const [disputeFetchStatus, setDisputeFetchStatus] = useState<
    'idle' | 'loading' | 'success' | 'not_found' | 'restricted' | 'error'
  >('idle');
  const [disputeErrorMessage, setDisputeErrorMessage] = useState<string | null>(null);
  const [isDisputeExpanded, setIsDisputeExpanded] = useState<boolean>(true);

  // Securely load dispute claims and evidence for the authorized committee case
  const fetchDisputeEvidence = useCallback(
    async (isCancelledCheck: () => boolean) => {
      if (!address) {
        setDisputeRecord(null);
        setDisputeFetchStatus('restricted');
        setDisputeErrorMessage('Wallet not connected');
        return;
      }

      setDisputeRecord(null);
      setDisputeFetchStatus('loading');
      setDisputeErrorMessage(null);

      try {
        const token = await getToken();
        if (isCancelledCheck()) return;

        if (!token) {
          setDisputeRecord(null);
          setDisputeFetchStatus('restricted');
          setDisputeErrorMessage('Authentication session required to access dispute claims');
          return;
        }

        const res = await fetch(
          `/api/deals/${item.dealAddress}/milestones/${item.milestoneId}/disputes`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        if (isCancelledCheck()) return;

        if (res.status === 404) {
          setDisputeRecord(null);
          setDisputeFetchStatus('not_found');
          return;
        }

        if (res.status === 401 || res.status === 403) {
          setDisputeRecord(null);
          setDisputeFetchStatus('restricted');
          setDisputeErrorMessage(
            'Dispute claims & evidence access restricted to authorized signers on this case.'
          );
          return;
        }

        if (!res.ok) {
          setDisputeRecord(null);
          setDisputeFetchStatus('error');
          setDisputeErrorMessage('Failed to load dispute evidence from server.');
          return;
        }

        const json = await res.json();
        if (isCancelledCheck()) return;

        if (json.dispute) {
          setDisputeRecord(json.dispute);
          setDisputeFetchStatus('success');
        } else {
          setDisputeRecord(null);
          setDisputeFetchStatus('not_found');
        }
      } catch (err: any) {
        if (isCancelledCheck()) return;
        setDisputeRecord(null);
        setDisputeFetchStatus('error');
        setDisputeErrorMessage(err?.message || 'Network error fetching dispute evidence');
      }
    },
    [item.dealAddress, item.milestoneId, address, getToken]
  );

  useEffect(() => {
    let cancelled = false;
    fetchDisputeEvidence(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [fetchDisputeEvidence]);

  // Original Initial Resolution State for Final Review (Phase 2C)
  const [originalReport, setOriginalReport] = useState<CanonicalResolutionReportV1 | null>(null);
  const [originalReportRow, setOriginalReportRow] = useState<MilestoneResolutionReportRow | null>(null);
  const [originalReportStatus, setOriginalReportStatus] = useState<
    'idle' | 'loading' | 'success' | 'not_found' | 'restricted' | 'error'
  >('idle');
  const [originalReportError, setOriginalReportError] = useState<string | null>(null);
  const [isOriginalReportExpanded, setIsOriginalReportExpanded] = useState<boolean>(true);

  // Securely load confirmed original INITIAL_RESOLUTION report for final review cases
  const fetchOriginalReport = useCallback(
    async (isCancelledCheck: () => boolean) => {
      if (item.phase !== 'FINAL_RESOLUTION') {
        setOriginalReport(null);
        setOriginalReportRow(null);
        setOriginalReportStatus('idle');
        return;
      }

      if (!address) {
        setOriginalReport(null);
        setOriginalReportRow(null);
        setOriginalReportStatus('restricted');
        setOriginalReportError('Wallet not connected');
        return;
      }

      setOriginalReport(null);
      setOriginalReportRow(null);
      setOriginalReportStatus('loading');
      setOriginalReportError(null);

      try {
        const token = await getToken();
        if (isCancelledCheck()) return;

        if (!token) {
          setOriginalReport(null);
          setOriginalReportRow(null);
          setOriginalReportStatus('restricted');
          setOriginalReportError('Authentication required to view original committee decision');
          return;
        }

        const res = await fetch(
          `/api/deals/${item.dealAddress}/milestones/${item.milestoneId}/resolution-reports?phase=INITIAL_RESOLUTION`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        if (isCancelledCheck()) return;

        if (res.status === 404) {
          setOriginalReport(null);
          setOriginalReportRow(null);
          setOriginalReportStatus('not_found');
          return;
        }

        if (res.status === 401 || res.status === 403) {
          setOriginalReport(null);
          setOriginalReportRow(null);
          setOriginalReportStatus('restricted');
          setOriginalReportError('Original decision access restricted to authorized signers.');
          return;
        }

        if (!res.ok) {
          setOriginalReport(null);
          setOriginalReportRow(null);
          setOriginalReportStatus('error');
          setOriginalReportError('Failed to load original resolution report.');
          return;
        }

        const json = await res.json();
        if (isCancelledCheck()) return;

        const record = json.record;
        if (!record || !record.report || !record.row) {
          setOriginalReport(null);
          setOriginalReportRow(null);
          setOriginalReportStatus('not_found');
          return;
        }

        const row = record.row;
        const report = record.report;

        // Strict verification: Require confirmed initial resolution
        if (row.status !== 'confirmed') {
          setOriginalReport(null);
          setOriginalReportRow(null);
          setOriginalReportStatus('not_found');
          return;
        }

        if (
          row.dealAddress.toLowerCase() !== item.dealAddress.toLowerCase() ||
          row.milestoneId !== item.milestoneId ||
          row.phase !== 'INITIAL_RESOLUTION'
        ) {
          setOriginalReport(null);
          setOriginalReportRow(null);
          setOriginalReportStatus('error');
          setOriginalReportError('Original resolution record does not match active milestone case.');
          return;
        }

        setOriginalReport(report);
        setOriginalReportRow(row);
        setOriginalReportStatus('success');
      } catch (err: any) {
        if (isCancelledCheck()) return;
        setOriginalReport(null);
        setOriginalReportRow(null);
        setOriginalReportStatus('error');
        setOriginalReportError(err?.message || 'Network error fetching original decision');
      }
    },
    [item.dealAddress, item.milestoneId, item.phase, address, getToken]
  );

  useEffect(() => {
    let cancelled = false;
    fetchOriginalReport(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [fetchOriginalReport]);

  // Memoized Payouts and Percentages for Original and Final Splits (Phase 2C)
  const originalFreelancerBn = useMemo(() => {
    if (!originalReport?.freelancerAmount) return null;
    try {
      return BigInt(originalReport.freelancerAmount);
    } catch {
      return null;
    }
  }, [originalReport?.freelancerAmount]);

  const originalClientBn = useMemo(() => {
    if (!originalReport?.clientAmount) return null;
    try {
      return BigInt(originalReport.clientAmount);
    } catch {
      return null;
    }
  }, [originalReport?.clientAmount]);

  const originalFreelancerPct = useMemo(() => {
    if (originalFreelancerBn === null || milestoneAmountBigInt <= 0n) return null;
    return (Number((originalFreelancerBn * 1000n) / milestoneAmountBigInt) / 10).toFixed(1);
  }, [originalFreelancerBn, milestoneAmountBigInt]);

  const originalClientPct = useMemo(() => {
    if (originalClientBn === null || milestoneAmountBigInt <= 0n) return null;
    return (Number((originalClientBn * 1000n) / milestoneAmountBigInt) / 10).toFixed(1);
  }, [originalClientBn, milestoneAmountBigInt]);

  // Memoized Payouts and Percentages for Current Draft Allocation (Initial or Final Review)
  const currentDraftFreelancerBn = useMemo(() => {
    if (!freelancerAmountInput.trim()) return null;
    try {
      return parseUsdcAmount(freelancerAmountInput);
    } catch {
      return null;
    }
  }, [freelancerAmountInput]);

  const currentDraftClientBn = useMemo(() => {
    if (!clientAmountInput.trim()) return null;
    try {
      return parseUsdcAmount(clientAmountInput);
    } catch {
      return null;
    }
  }, [clientAmountInput]);

  const currentDraftFreelancerPct = useMemo(() => {
    if (currentDraftFreelancerBn === null || milestoneAmountBigInt <= 0n) return null;
    return (Number((currentDraftFreelancerBn * 1000n) / milestoneAmountBigInt) / 10).toFixed(1);
  }, [currentDraftFreelancerBn, milestoneAmountBigInt]);

  const currentDraftClientPct = useMemo(() => {
    if (currentDraftClientBn === null || milestoneAmountBigInt <= 0n) return null;
    return (Number((currentDraftClientBn * 1000n) / milestoneAmountBigInt) / 10).toFixed(1);
  }, [currentDraftClientBn, milestoneAmountBigInt]);

  // Backward-compatibility aliases for Reconsideration Split Comparison
  const currentFinalFreelancerPct = currentDraftFreelancerPct;
  const currentFinalClientPct = currentDraftClientPct;

  // Phase 2G.2: Advisory-only check for obvious split-description contradictions in executive summary
  const equalSplitContradiction = useMemo(() => {
    // 1. Both inputs must be valid BigInts and sum must exactly equal milestone amount
    if (
      currentDraftFreelancerBn === null ||
      currentDraftClientBn === null ||
      milestoneAmountBigInt <= 0n ||
      currentDraftFreelancerBn + currentDraftClientBn !== milestoneAmountBigInt
    ) {
      return false; // Incomplete or invalid allocation inputs -> do not warn
    }

    // 2. If amounts are actually equal (e.g. 0.5 vs 0.5), there is no contradiction!
    if (currentDraftFreelancerBn === currentDraftClientBn) {
      return false;
    }

    // 3. Amounts are unequal. Check if summary explicitly asserts an equal split.
    const text = summaryInput.toLowerCase();
    if (!text.trim()) return false;

    const equalPatterns = [
      /\bequal\s+split\b/,
      /\bsplit\s+equally\b/,
      /\bequally\s+split\b/,
      /\b50\s*[\/-]\s*50\b/,
      /\bfifty[\s\/-]fifty\b/,
      /\bhalf\s+each\b/,
      /\beach\s+half\b/,
    ];

    return equalPatterns.some((pattern) => pattern.test(text));
  }, [
    currentDraftFreelancerBn,
    currentDraftClientBn,
    milestoneAmountBigInt,
    summaryInput,
  ]);

  // 1. Fetch Existing Staged Report and Auths on load
  const loadExistingState = useCallback(async (isCancelledCheck?: () => boolean) => {
    try {
      const token = await getToken();
      if (isCancelledCheck && isCancelledCheck()) return;
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

      // Load report
      const repRes = await fetch(
        `/api/deals/${item.dealAddress}/milestones/${item.milestoneId}/resolution-reports?phase=${item.phase}`,
        { headers }
      );
      if (isCancelledCheck && isCancelledCheck()) return;

      if (repRes.ok) {
        const repData = await repRes.json();
        if (isCancelledCheck && isCancelledCheck()) return;
        if (repData.record?.report) {
          setStagedReport(repData.record.report);
          setStagedReportId(repData.record.row?.id || null);
          setFreelancerAmountInput(formatUsdcAmount(repData.record.report.freelancerAmount));
          setClientAmountInput(formatUsdcAmount(repData.record.report.clientAmount));
          setSummaryInput(repData.record.report.summary);
          setFindingsInput(repData.record.report.findings);
          setJustificationInput(repData.record.report.justification);
        }
      }

      // Load authorisations
      const authRes = await fetch(
        `/api/deals/${item.dealAddress}/milestones/${item.milestoneId}/authorizations`,
        { headers }
      );
      if (isCancelledCheck && isCancelledCheck()) return;

      if (authRes.ok) {
        const authData = await authRes.json();
        if (isCancelledCheck && isCancelledCheck()) return;
        // Filter for authorizations matching the active milestone phase
        const phaseAuths = (authData.authorizations || []).filter(
          (a: any) => a.authorization?.phase === item.phase
        );

        // Sort deterministically: createdAt DESC, resolutionNonce DESC, id DESC
        phaseAuths.sort((a: any, b: any) => {
          const timeA = a.authorization?.createdAt ? new Date(a.authorization.createdAt).getTime() : 0;
          const timeB = b.authorization?.createdAt ? new Date(b.authorization.createdAt).getTime() : 0;
          if (timeB !== timeA) return timeB - timeA;

          const nonceA = BigInt(a.authorization?.resolutionNonce || '0');
          const nonceB = BigInt(b.authorization?.resolutionNonce || '0');
          if (nonceB > nonceA) return 1;
          if (nonceB < nonceA) return -1;

          const idA = String(a.authorization?.id || '');
          const idB = String(b.authorization?.id || '');
          return idB.localeCompare(idA);
        });

        const latestRaw = phaseAuths[0] || null;
        if (!latestRaw) {
          setCurrentAuth(null);
        } else {
          setCurrentAuth({
            ...latestRaw,
            typedData: latestRaw.typedData ?? latestRaw.authorization?.typedData ?? null,
          });
        }
      }
    } catch (err) {
      console.warn('[CommitteeResolutionWorkspace] Failed to load initial state:', err);
    }
  }, [item.dealAddress, item.milestoneId, item.phase, getToken]);

  useEffect(() => {
    let cancelled = false;
    const isCancelledCheck = () => cancelled;
    loadExistingState(isCancelledCheck);
    return () => {
      cancelled = true;
    };
  }, [loadExistingState]);

  // Handle Exact Split Input Sync
  const handleFreelancerAmountChange = (val: string) => {
    setFreelancerAmountInput(val);
    setStageError(null);
    try {
      if (!val.trim()) {
        setClientAmountInput('');
        return;
      }
      const parsedFreelancer = parseUsdcAmount(val);
      if (parsedFreelancer > milestoneAmountBigInt) {
        setStageError('Freelancer amount cannot exceed total milestone amount');
        setClientAmountInput('');
        return;
      }
      const remainingClient = milestoneAmountBigInt - parsedFreelancer;
      setClientAmountInput(formatUsdcAmount(remainingClient));
    } catch {
      setClientAmountInput('');
    }
  };

  const handleClientAmountChange = (val: string) => {
    setClientAmountInput(val);
    setStageError(null);
    try {
      if (!val.trim()) {
        setFreelancerAmountInput('');
        return;
      }
      const parsedClient = parseUsdcAmount(val);
      if (parsedClient > milestoneAmountBigInt) {
        setStageError('Client amount cannot exceed total milestone amount');
        setFreelancerAmountInput('');
        return;
      }
      const remainingFreelancer = milestoneAmountBigInt - parsedClient;
      setFreelancerAmountInput(formatUsdcAmount(remainingFreelancer));
    } catch {
      setFreelancerAmountInput('');
    }
  };

  // 2. Stage Report Action
  const handleStageReport = async () => {
    try {
      setStagingInProgress(true);
      setStageError(null);

      const fAmountBn = parseUsdcAmount(freelancerAmountInput);
      const cAmountBn = parseUsdcAmount(clientAmountInput);

      if (fAmountBn + cAmountBn !== milestoneAmountBigInt) {
        throw new Error('Split sum does not exactly equal total milestone amount');
      }

      const token = await getToken();
      const res = await fetch(
        `/api/deals/${item.dealAddress}/milestones/${item.milestoneId}/resolution-reports`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            phase: item.phase,
            freelancerAmount: fAmountBn.toString(),
            clientAmount: cAmountBn.toString(),
            summary: summaryInput,
            findings: findingsInput,
            justification: justificationInput,
          }),
        }
      );

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Staging failed with HTTP ${res.status}`);
      }

      const data = await res.json();
      setStagedReport(data.report);
      setStagedReportId(data.reportId);
    } catch (err: any) {
      setStageError(err?.message || 'Failed to stage resolution report');
    } finally {
      setStagingInProgress(false);
    }
  };

  // 3. Create Authorization Action
  const handleCreateAuthorization = async () => {
    const targetReportId = stagedReportId || currentAuth?.authorization?.reportId;
    if (!targetReportId) {
      setAuthError('No staged resolution report found to authorize.');
      return;
    }
    try {
      setCreatingAuth(true);
      setAuthError(null);

      const token = await getToken();
      const res = await fetch(
        `/api/deals/${item.dealAddress}/milestones/${item.milestoneId}/authorizations`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            reportId: targetReportId,
          }),
        }
      );

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Authorization creation failed with HTTP ${res.status}`);
      }

      const data = await res.json();
      setCurrentAuth({
        authorization: data.authorization,
        typedData: data.typedData ?? data.authorization?.typedData ?? null,
        signatures: [],
        signers: [],
        thresholdReady: false,
      });
      await loadExistingState();
    } catch (err: any) {
      setAuthError(err?.message || 'Failed to generate authorization');
    } finally {
      setCreatingAuth(false);
    }
  };

  // 4. Sign Authorization Action
  const handleSignAuthorization = async () => {
    if (!currentAuth?.authorization?.id) return;
    try {
      setSigningInProgress(true);
      setSignError(null);

      await ensureSepolia();

      const typedData =
        currentAuth?.typedData ??
        currentAuth?.authorization?.typedData;
      if (!typedData) {
        throw new Error('EIP-712 typed data not available on authorization');
      }

      const signature = await signTypedDataAsync({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });

      const token = await getToken();
      const res = await fetch(
        `/api/deals/${item.dealAddress}/milestones/${item.milestoneId}/authorizations/${currentAuth.authorization.id}/signatures`,
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
        throw new Error(errData.error || `Signature submission failed with HTTP ${res.status}`);
      }

      await loadExistingState();
    } catch (err: any) {
      setSignError(err?.message || 'Failed to submit committee signature');
    } finally {
      setSigningInProgress(false);
    }
  };

  // 5. Submit On-Chain Execution
  const handleSubmitExecution = async () => {
    if (!currentAuth?.authorization?.id) return;
    try {
      setSubmittingInProgress(true);
      setSubmitError(null);
      setIsAmbiguousFailure(false);
      setReconciliationFailed(false);
      setRecoveryError(null);
      setRecoverySuccessMessage(null);

      await ensureSepolia();

      // Step 1: Prepare transaction from verified bundle
      const token = await getToken();
      const prepRes = await fetch(
        `/api/deals/${item.dealAddress}/milestones/${item.milestoneId}/authorizations/${currentAuth.authorization.id}/prepare`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }
      );

      if (!prepRes.ok) {
        const errData = await prepRes.json().catch(() => ({}));
        throw new Error(errData.error || `Execution preparation failed with HTTP ${prepRes.status}`);
      }

      const prepData = await prepRes.json();
      const txReq = prepData.transactionRequest;

      // Step 2: Prompt wallet transaction
      const txHash = await writeContractAsync({
        address: txReq.address as `0x${string}`,
        abi: synqResolutionCommitteeABI,
        functionName: txReq.functionName as any,
        args: txReq.args,
      });

      setExecutionTxHash(txHash);

      // Step 3: Wait for receipt
      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status !== 'success') {
        throw new Error('Transaction reverted on-chain');
      }

      // Step 4: Server Reconcile
      await triggerReconcile(txHash);
    } catch (err: any) {
      if (isAmbiguousSubmissionError(err)) {
        setIsAmbiguousFailure(true);
        setSubmitError(
          'Your wallet lost connection while submitting the transaction. It may still have succeeded on-chain. Check the transaction status before trying again.'
        );
      } else {
        setIsAmbiguousFailure(false);
        setSubmitError(err?.message || 'Failed to submit resolution on-chain');
      }
    } finally {
      setSubmittingInProgress(false);
    }
  };

  // Reconcile Helper with Retry & Event-Scan Recovery Support
  const triggerReconcile = async (txHash?: string) => {
    if (!currentAuth?.authorization?.id) return;
    try {
      setReconcilingInProgress(true);
      setRecoveryError(null);
      setRecoverySuccessMessage(null);
      const token = await getToken();
      const targetTxHash = txHash || executionTxHash || undefined;
      const res = await fetch(
        `/api/deals/${item.dealAddress}/milestones/${item.milestoneId}/authorizations/${currentAuth.authorization.id}/reconcile`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(targetTxHash ? { txHash: targetTxHash } : {}),
        }
      );

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setReconciliationFailed(true);
        setReconciliationSuccess(false);
        setRecoveryError(data.error || `Reconciliation failed with HTTP ${res.status}`);
      } else {
        setReconciliationSuccess(true);
        setReconciliationFailed(false);
        setSubmitError(null);
        setIsAmbiguousFailure(false);
        if (data.executionTxHash) {
          setExecutionTxHash(data.executionTxHash);
        }
        setRecoverySuccessMessage(
          isFinal
            ? 'Final resolution successfully reconciled and confirmed! Milestone is settled.'
            : 'Initial resolution proposal successfully reconciled and confirmed!'
        );
        // Refresh authorization state and report state
        await loadExistingState();
      }
    } catch (err: any) {
      setReconciliationFailed(true);
      setReconciliationSuccess(false);
      setRecoveryError(err?.message || 'Network error during reconciliation');
    } finally {
      setReconcilingInProgress(false);
    }
  };

  // On-Chain State Verification Action
  const handleCheckOnChainStatus = async () => {
    try {
      setCheckingOnChain(true);
      setOnChainCheckMessage(null);
      const ms = (await sepoliaPublicClient.readContract({
        address: item.dealAddress as `0x${string}`,
        abi: synqDealV1ABI,
        functionName: 'getMilestone',
        args: [BigInt(item.milestoneId)],
      })) as any;

      const statusNum = Number(ms.status);
      setOnChainMilestoneStatus(statusNum);

      const expectedStatus = isFinal ? MilestoneStatus.SettledSplit : MilestoneStatus.ResolutionProposed;
      if (statusNum === expectedStatus) {
        setOnChainCheckSuccess(true);
        setOnChainCheckMessage(
          isFinal
            ? `On-chain milestone status is SettledSplit (${statusNum}). The final resolution transaction succeeded! Click 'Recover Transaction' below to synchronize.`
            : `On-chain milestone status is ResolutionProposed (${statusNum}). The proposal transaction succeeded! Click 'Recover Transaction' below to synchronize.`
        );
      } else {
        setOnChainCheckSuccess(false);
        const statusLabel =
          statusNum === MilestoneStatus.Disputed
            ? 'Disputed (4)'
            : statusNum === MilestoneStatus.FinalReview
            ? 'FinalReview (6)'
            : `Status code ${statusNum}`;
        setOnChainCheckMessage(
          `On-chain milestone status is ${statusLabel}. It has not yet transitioned to ${
            isFinal ? 'SettledSplit (9)' : 'ResolutionProposed (5)'
          }. The transaction may not have reached the blockchain.`
        );
      }
    } catch (err: any) {
      setOnChainCheckSuccess(false);
      setOnChainCheckMessage(`Failed to read on-chain contract: ${err?.message || String(err)}`);
    } finally {
      setCheckingOnChain(false);
    }
  };

  // Manual or Event-Scan Recovery Action
  const handleRecover = async () => {
    if (!currentAuth?.authorization?.id) return;
    setRecoveryError(null);
    setRecoverySuccessMessage(null);

    const trimmedHash = recoveryTxHashInput.trim();
    if (trimmedHash && !/^0x[0-9a-fA-F]{64}$/.test(trimmedHash)) {
      setRecoveryError('Transaction hash must be a 32-byte hex string (0x followed by 64 hex characters).');
      return;
    }

    await triggerReconcile(trimmedHash || undefined);
  };

  // Reset Ambiguous State for Safe Resubmission Retry
  const handleResetForRetry = () => {
    setIsAmbiguousFailure(false);
    setSubmitError(null);
    setRecoveryError(null);
    setOnChainCheckMessage(null);
  };

  const signatures: Array<{
    id?: string;
    signerWallet: string;
    createdAt?: string | Date;
  }> = useMemo(() => {
    if (!currentAuth) return [];
    if (Array.isArray(currentAuth.signatures)) {
      return currentAuth.signatures.map((s: any) => ({
        id: s.id,
        signerWallet: (s.signerWallet || s).toLowerCase(),
        createdAt: s.createdAt,
      }));
    }
    if (Array.isArray(currentAuth.signers)) {
      return currentAuth.signers.map((s: any) => ({
        signerWallet: (typeof s === 'string' ? s : s.signerWallet || '').toLowerCase(),
        createdAt: typeof s === 'object' ? s.createdAt : undefined,
      }));
    }
    return [];
  }, [currentAuth]);

  const signatureCount = signatures.length;
  const hasUserSigned = useMemo(() => {
    if (!address) return false;
    return signatures.some((s) => s.signerWallet === address.toLowerCase());
  }, [address, signatures]);

  const authStatus = currentAuth?.authorization?.status;
  const validUntilSec = currentAuth?.authorization?.validUntil ? Number(currentAuth.authorization.validUntil) : null;
  const isExpired = authStatus === 'expired' || (validUntilSec ? (validUntilSec * 1000 <= Date.now()) : false);
  const isInvalidated = authStatus === 'invalidated';
  const isExecuted = authStatus === 'executed';
  const isThresholdReady = !isExpired && !isInvalidated && !isExecuted && (authStatus === 'threshold_ready' || signatureCount >= 2);
  const displayTxHash = executionTxHash || currentAuth?.authorization?.executionTxHash || null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={onBack}
          className="h-8 text-xs border-white/20 text-[#A3A3A3] hover:text-white hover:bg-white/5 flex items-center gap-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Queue
        </Button>
        <Badge
          variant="outline"
          className={
            isFinal
              ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
          }
        >
          {isFinal ? 'FINAL RESOLUTION WORKSPACE' : 'INITIAL RESOLUTION WORKSPACE'}
        </Badge>
      </div>

      {/* PHASE 2E.4: Reconciled On-Chain Success Confirmation */}
      {(reconciliationSuccess || isExecuted) && (
        <Card className="border-emerald-500/40 bg-emerald-950/20 shadow-xl space-y-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-bold text-white flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              {isFinal ? 'Final Resolution Executed On-Chain' : 'Initial Resolution Proposed On-Chain'}
            </CardTitle>
            <CardDescription className="text-xs text-zinc-300">
              {isFinal
                ? 'The final committee decision has been executed. The contract has distributed the milestone funds.'
                : 'The initial committee decision has been submitted. The participant reconsideration window now applies. The milestone has not necessarily settled.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-xs">
            <div className="rounded-lg bg-[#141d18] border border-emerald-500/20 p-3 space-y-2 text-zinc-300">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="text-[11px] text-zinc-400 font-mono">
                  Tx: {displayTxHash ? shortenAddress(displayTxHash) : 'Confirmed On-Chain'}
                </span>
                {displayTxHash && (
                  <a
                    href={`https://sepolia.etherscan.io/tx/${displayTxHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-emerald-400 hover:text-emerald-300 font-mono text-xs flex items-center gap-1"
                  >
                    <span>View on Sepolia Etherscan</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
              <p className="text-[11px] text-zinc-400">
                The confirmed {isFinal ? 'final decision' : 'proposal'} record has been synchronized and can be inspected in Resolution History.
              </p>
            </div>

            <div className="flex items-center gap-3 pt-1 flex-wrap">
              {onViewInHistory && (
                <Button
                  size="sm"
                  onClick={() =>
                    onViewInHistory({
                      dealAddress: item.dealAddress,
                      milestoneId: item.milestoneId,
                      phase: item.phase,
                    })
                  }
                  className="h-8 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1.5"
                >
                  <span>View in Resolution History</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={onSettled}
                className="h-8 text-xs border-white/20 text-zinc-300 hover:text-white hover:bg-white/5"
              >
                Back to Queue
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Snapshot Context Card */}
      <Card className="border-white/75 bg-[#1B1B1B] shadow-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
            <Scale className="h-4 w-4 text-white" /> Milestone Case Context
          </CardTitle>
          <CardDescription className="text-xs text-[#A3A3A3]">
            Escrow amount: {formatUsdcAmount(item.milestoneAmount)} USDC • Deal {shortenAddress(item.dealAddress)} • Milestone #{item.milestoneId + 1}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono">
            <div className="rounded-lg bg-[#252525] border border-white/10 p-2.5">
              <div className="text-[10px] text-[#A3A3A3] uppercase font-sans">Client</div>
              <div className="text-white">{shortenAddress(item.client)}</div>
            </div>
            <div className="rounded-lg bg-[#252525] border border-white/10 p-2.5">
              <div className="text-[10px] text-[#A3A3A3] uppercase font-sans">Freelancer</div>
              <div className="text-white">{shortenAddress(item.freelancer)}</div>
            </div>
            <div className="rounded-lg bg-[#252525] border border-white/10 p-2.5">
              <div className="text-[10px] text-[#A3A3A3] uppercase font-sans">Spec Hash</div>
              <div className="text-white">{item.specHash.slice(0, 10)}…</div>
            </div>
            <div className="rounded-lg bg-[#252525] border border-white/10 p-2.5">
              <div className="text-[10px] text-[#A3A3A3] uppercase font-sans">Evidence Hash</div>
              <div className="text-white">{item.evidenceRootHash.slice(0, 10)}…</div>
            </div>
          </div>

          {/* Review Timing & SLA Section (Phase 2E.2) */}
          <div className="pt-1">
            <CommitteeTimingBadge timing={timingInfo} />
          </div>

          {/* Dispute Claims & Evidence Collapsible Section (Phase 2B) */}
          <div className="mt-3 border-t border-white/10 pt-3">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setIsDisputeExpanded((prev) => !prev)}
                className="flex items-center gap-1.5 text-xs font-semibold text-white hover:text-white/80 transition-colors focus:outline-none"
              >
                <FileText className="h-3.5 w-3.5 text-white/70" />
                <span>Dispute Claims & Evidence</span>
                {isDisputeExpanded ? (
                  <ChevronUp className="h-3.5 w-3.5 text-white/50" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-white/50" />
                )}
              </button>
              {disputeFetchStatus === 'success' && disputeRecord && (
                <Badge variant="outline" className="text-[10px] border-amber-500/30 bg-amber-500/10 text-amber-300">
                  Evidence Available
                </Badge>
              )}
            </div>

            {isDisputeExpanded && (
              <div className="mt-2.5 rounded-lg bg-[#202020] border border-white/10 p-3 text-xs space-y-3">
                {/* 1. Loading State */}
                {disputeFetchStatus === 'loading' && (
                  <div className="flex items-center gap-2 text-white/60 py-2 font-sans">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-white/60" />
                    <span>Loading dispute claims & evidence…</span>
                  </div>
                )}

                {/* 2. Record Found (Success State) */}
                {disputeFetchStatus === 'success' && disputeRecord && (
                  <div className="space-y-3 font-sans">
                    {/* Metadata: Initiator, Category, Submission Version */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <div className="rounded bg-[#282828] p-2 border border-white/5">
                        <div className="text-[10px] text-[#A3A3A3] uppercase">Dispute Initiator</div>
                        <div className="text-white font-mono flex items-center gap-1.5 mt-0.5">
                          <span>{shortenAddress(disputeRecord.openerWallet)}</span>
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-white/10 text-white/80 font-sans">
                            {disputeRecord.openerWallet.toLowerCase() === item.client.toLowerCase()
                              ? 'Client'
                              : disputeRecord.openerWallet.toLowerCase() === item.freelancer.toLowerCase()
                              ? 'Freelancer'
                              : 'Party'}
                          </span>
                        </div>
                      </div>

                      <div className="rounded bg-[#282828] p-2 border border-white/5">
                        <div className="text-[10px] text-[#A3A3A3] uppercase">Category</div>
                        <div className="text-white font-medium capitalize mt-0.5">
                          {(() => {
                            const cat = (disputeRecord.canonicalManifest as any)?.category;
                            if (!cat) return 'Unspecified';
                            return String(cat).replace(/_/g, ' ');
                          })()}
                        </div>
                      </div>

                      <div className="rounded bg-[#282828] p-2 border border-white/5">
                        <div className="text-[10px] text-[#A3A3A3] uppercase">Submission Version</div>
                        <div className="text-white font-mono mt-0.5">
                          v{disputeRecord.submissionVersion ?? item.submissionVersion ?? 0}
                        </div>
                      </div>
                    </div>

                    {/* Explanation */}
                    <div>
                      <div className="text-[10px] text-[#A3A3A3] uppercase mb-1">Dispute Explanation</div>
                      <div className="rounded bg-[#181818] border border-white/10 p-2.5 text-white/90 whitespace-pre-wrap break-words text-xs leading-relaxed max-h-48 overflow-y-auto">
                        {((disputeRecord.canonicalManifest as any)?.explanation as string) || 'No narrative explanation provided.'}
                      </div>
                    </div>

                    {/* Evidence Links */}
                    {(() => {
                      const links = ((disputeRecord.canonicalManifest as any)?.links as any[]) || [];
                      if (links.length === 0) {
                        return (
                          <div className="text-white/50 text-[11px] italic">
                            No external evidence references submitted.
                          </div>
                        );
                      }
                      return (
                        <div>
                          <div className="text-[10px] text-[#A3A3A3] uppercase mb-1">
                            Evidence References ({links.length})
                          </div>
                          <ul className="space-y-1.5">
                            {links.map((link, idx) => {
                              const safe = isSafeHttpUrl(link.value);
                              return (
                                <li
                                  key={idx}
                                  className="flex items-center gap-2 rounded bg-[#282828] px-2.5 py-1.5 border border-white/5 text-[11px]"
                                >
                                  {link.type && (
                                    <Badge
                                      variant="outline"
                                      className="text-[9px] uppercase px-1 py-0 border-white/20 text-white/60"
                                    >
                                      {link.type}
                                    </Badge>
                                  )}
                                  {safe ? (
                                    <a
                                      href={link.value}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-sky-400 hover:text-sky-300 underline inline-flex items-center gap-1 break-all transition-colors"
                                    >
                                      <span>{link.label || link.value}</span>
                                      <ExternalLink className="h-3 w-3 shrink-0" />
                                    </a>
                                  ) : (
                                    <span className="text-white/80 font-mono break-all">
                                      {link.label ? `${link.label}: ` : ''}
                                      {link.value}
                                    </span>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* 3. Confirmed 404 (No Record Found) */}
                {disputeFetchStatus === 'not_found' && (
                  <div className="flex items-start gap-2 text-white/70 py-1 font-sans">
                    <Info className="h-4 w-4 text-white/40 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-white/80">No dispute manifest recorded</p>
                      <p className="text-[11px] text-white/50 mt-0.5 leading-normal">
                        No off-chain dispute claims or evidence manifest was submitted for this milestone.
                        This milestone may have entered dispute through automatic escalation (such as revision deadline expiry) or directly on-chain.
                      </p>
                    </div>
                  </div>
                )}

                {/* 4. 401/403 (Restricted Access) */}
                {disputeFetchStatus === 'restricted' && (
                  <div className="flex items-start gap-2 text-amber-300/80 py-1 font-sans">
                    <ShieldAlert className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-amber-200">Access Restricted</p>
                      <p className="text-[11px] text-white/60 mt-0.5 leading-normal">
                        {disputeErrorMessage || 'Dispute evidence is restricted to authorized resolution committee signers assigned to this milestone case.'}
                      </p>
                    </div>
                  </div>
                )}

                {/* 5. Network / Server Error */}
                {disputeFetchStatus === 'error' && (
                  <div className="flex items-start justify-between gap-2 py-1 font-sans">
                    <div className="flex items-start gap-2 text-rose-300/90">
                      <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-medium text-rose-200">Dispute Evidence Unavailable</p>
                        <p className="text-[11px] text-white/50 mt-0.5 leading-normal">
                          {disputeErrorMessage || 'Unable to retrieve dispute manifest from server.'}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => fetchDisputeEvidence(() => false)}
                      className="h-7 text-[11px] px-2 border-white/20 hover:bg-white/10 shrink-0"
                    >
                      <RotateCcw className="h-3 w-3 mr-1" /> Retry
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* PHASE 2C: Original Committee Decision (Final Review Reconsideration Context) */}
      {isFinal && (
        <Card className="border-indigo-500/30 bg-[#1A1A24] shadow-xl">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
                <History className="h-4 w-4 text-indigo-400" /> Original Committee Decision
              </CardTitle>
              <button
                type="button"
                onClick={() => setIsOriginalReportExpanded((prev) => !prev)}
                className="text-xs text-[#A3A3A3] hover:text-white flex items-center gap-1 transition-colors focus:outline-none"
              >
                <span>{isOriginalReportExpanded ? 'Collapse' : 'Expand'}</span>
                {isOriginalReportExpanded ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
            <CardDescription className="text-xs text-[#A3A3A3]">
              Initial resolution determination currently under final reconsideration.
            </CardDescription>
          </CardHeader>

          {isOriginalReportExpanded && (
            <CardContent className="space-y-3 text-xs">
              {/* 1. Loading State */}
              {originalReportStatus === 'loading' && (
                <div className="flex items-center gap-2 text-white/60 py-3 font-sans">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400" />
                  <span>Loading original committee decision…</span>
                </div>
              )}

              {/* 2. Confirmed Original Report Found */}
              {originalReportStatus === 'success' && originalReport && (
                <div className="space-y-3 font-sans">
                  {/* Summary Metric Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="rounded-lg bg-[#222230] border border-indigo-500/20 p-2.5">
                      <div className="text-[10px] text-[#A3A3A3] uppercase">Original Escrow</div>
                      <div className="text-white font-mono font-medium mt-0.5">
                        {formatUsdcAmount(item.milestoneAmount)} USDC
                      </div>
                    </div>

                    <div className="rounded-lg bg-[#222230] border border-indigo-500/20 p-2.5">
                      <div className="text-[10px] text-[#A3A3A3] uppercase">Original Freelancer Payout</div>
                      <div className="text-emerald-400 font-mono font-semibold mt-0.5">
                        {formatUsdcAmount(originalReport.freelancerAmount)} USDC
                        {originalFreelancerPct !== null && (
                          <span className="text-[10px] text-emerald-400/70 font-sans ml-1">
                            ({originalFreelancerPct}%)
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="rounded-lg bg-[#222230] border border-indigo-500/20 p-2.5">
                      <div className="text-[10px] text-[#A3A3A3] uppercase">Original Client Refund</div>
                      <div className="text-sky-400 font-mono font-semibold mt-0.5">
                        {formatUsdcAmount(originalReport.clientAmount)} USDC
                        {originalClientPct !== null && (
                          <span className="text-[10px] text-sky-400/70 font-sans ml-1">
                            ({originalClientPct}%)
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="rounded-lg bg-[#222230] border border-indigo-500/20 p-2.5">
                      <div className="text-[10px] text-[#A3A3A3] uppercase">Original Resolver</div>
                      <div className="text-white font-mono mt-0.5 flex items-center justify-between">
                        <span>{originalReportRow?.committeeAddress ? shortenAddress(originalReportRow.committeeAddress) : 'On-Chain'}</span>
                        {originalReportRow?.txHash && (
                          <a
                            href={`https://sepolia.etherscan.io/tx/${originalReportRow.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-0.5"
                            title="View Proposal Transaction"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Summary */}
                  <div>
                    <div className="text-[10px] text-[#A3A3A3] uppercase mb-1">Original Executive Summary</div>
                    <div className="rounded bg-[#20202C] border border-white/10 p-2.5 text-white/90 text-xs leading-relaxed">
                      {originalReport.summary || 'No summary provided.'}
                    </div>
                  </div>

                  {/* Findings */}
                  <div>
                    <div className="text-[10px] text-[#A3A3A3] uppercase mb-1">Original Findings</div>
                    <div className="rounded bg-[#20202C] border border-white/10 p-2.5 text-white/90 whitespace-pre-wrap break-words text-xs leading-relaxed max-h-36 overflow-y-auto">
                      {originalReport.findings || 'No findings recorded.'}
                    </div>
                  </div>

                  {/* Justification */}
                  <div>
                    <div className="text-[10px] text-[#A3A3A3] uppercase mb-1">Original Justification</div>
                    <div className="rounded bg-[#20202C] border border-white/10 p-2.5 text-white/90 whitespace-pre-wrap break-words text-xs leading-relaxed max-h-36 overflow-y-auto">
                      {originalReport.justification || 'No justification recorded.'}
                    </div>
                  </div>
                </div>
              )}

              {/* 3. Confirmed Report Not Found */}
              {originalReportStatus === 'not_found' && (
                <div className="flex items-start gap-2 text-white/70 py-1 font-sans">
                  <Info className="h-4 w-4 text-white/40 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-white/80">No confirmed original resolution report available</p>
                    <p className="text-[11px] text-white/50 mt-0.5 leading-normal">
                      The initial resolution proposal was recorded on-chain, but no confirmed off-chain resolution report was found in the database.
                      The final determination may proceed based on on-chain milestone records and submitted dispute claims.
                    </p>
                  </div>
                </div>
              )}

              {/* 4. Restricted Access */}
              {originalReportStatus === 'restricted' && (
                <div className="flex items-start gap-2 text-amber-300/80 py-1 font-sans">
                  <ShieldAlert className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-amber-200">Access Restricted</p>
                    <p className="text-[11px] text-white/60 mt-0.5 leading-normal">
                      {originalReportError || 'Original committee determination details are restricted to authorized resolution committee signers.'}
                    </p>
                  </div>
                </div>
              )}

              {/* 5. Error State */}
              {originalReportStatus === 'error' && (
                <div className="flex items-start justify-between gap-2 py-1 font-sans">
                  <div className="flex items-start gap-2 text-rose-300/90">
                    <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium text-rose-200">Original Decision Unavailable</p>
                      <p className="text-[11px] text-white/50 mt-0.5 leading-normal">
                        {originalReportError || 'Unable to retrieve original committee decision.'}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchOriginalReport(() => false)}
                    className="h-7 text-[11px] px-2 border-white/20 hover:bg-white/10 shrink-0"
                  >
                    <RotateCcw className="h-3 w-3 mr-1" /> Retry
                  </Button>
                </div>
              )}
            </CardContent>
          )}
        </Card>
      )}

      {/* STEP 1 & 2: Author, Sign & Submit Resolution (Hidden once confirmed & reconciled) */}
      {!reconciliationSuccess && !isExecuted && (
        <>
          {/* STEP 1: Stage Canonical Report */}
          <Card className="border-white/75 bg-[#1B1B1B] shadow-xl space-y-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
            <FileText className="h-4 w-4 text-white" /> 1. Author Resolution Report & Split
          </CardTitle>
          <CardDescription className="text-xs text-[#A3A3A3]">
            Determine the exact escrow split and state findings. Sum must equal exactly {formatUsdcAmount(item.milestoneAmount)} USDC.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[11px] text-[#A3A3A3]">Freelancer Amount (USDC)</label>
              <Input
                type="text"
                placeholder="0.00"
                value={freelancerAmountInput}
                onChange={(e) => handleFreelancerAmountChange(e.target.value)}
                disabled={Boolean(currentAuth)}
                className="h-8 text-xs bg-[#252525] border-white/20 text-white placeholder:text-[#A3A3A3]"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-[#A3A3A3]">Client Refund Amount (USDC)</label>
              <Input
                type="text"
                placeholder="0.00"
                value={clientAmountInput}
                onChange={(e) => handleClientAmountChange(e.target.value)}
                disabled={Boolean(currentAuth)}
                className="h-8 text-xs bg-[#252525] border-white/20 text-white placeholder:text-[#A3A3A3]"
              />
            </div>
          </div>

          {/* PHASE 2G.2: Compact Proposed Settlement Breakdown */}
          <div className="rounded-lg bg-[#202020] border border-white/10 p-2.5 text-xs space-y-2">
            <div className="flex items-center justify-between text-[11px] font-semibold text-zinc-300">
              <span className="flex items-center gap-1.5">
                <Scale className="h-3.5 w-3.5 text-zinc-400" />
                <span>Proposed Settlement Breakdown</span>
              </span>
              <span className="font-mono text-zinc-400 text-[10px]">
                Total Escrow: {formatUsdcAmount(item.milestoneAmount)} USDC
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs font-mono">
              <div className="rounded bg-[#171717] border border-white/5 p-2 space-y-0.5">
                <div className="text-[10px] text-[#A3A3A3] uppercase font-sans font-medium">Freelancer Payout</div>
                <div className="text-emerald-400 font-semibold text-xs flex items-center justify-between flex-wrap gap-1">
                  <span>{currentDraftFreelancerBn !== null ? `${formatUsdcAmount(currentDraftFreelancerBn)} USDC` : '—'}</span>
                  {currentDraftFreelancerPct !== null && (
                    <span className="text-[10px] font-sans text-emerald-400/80 bg-emerald-500/10 px-1 py-0.2 rounded border border-emerald-500/20">
                      {currentDraftFreelancerPct}%
                    </span>
                  )}
                </div>
              </div>
              <div className="rounded bg-[#171717] border border-white/5 p-2 space-y-0.5">
                <div className="text-[10px] text-[#A3A3A3] uppercase font-sans font-medium">Client Refund</div>
                <div className="text-sky-400 font-semibold text-xs flex items-center justify-between flex-wrap gap-1">
                  <span>{currentDraftClientBn !== null ? `${formatUsdcAmount(currentDraftClientBn)} USDC` : '—'}</span>
                  {currentDraftClientPct !== null && (
                    <span className="text-[10px] font-sans text-sky-400/80 bg-sky-500/10 px-1 py-0.2 rounded border border-sky-500/20">
                      {currentDraftClientPct}%
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* PHASE 2C: Reconsideration Split Comparison */}
          {isFinal && originalReport && (
            <div className="rounded-lg bg-[#202028] border border-indigo-500/20 p-3 space-y-2">
              <div className="text-[11px] font-semibold text-indigo-300 flex items-center gap-1.5">
                <GitCompare className="h-3.5 w-3.5 text-indigo-400" />
                <span>Split Comparison (Original vs Final Draft)</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                {/* Original Split Column */}
                <div className="rounded bg-[#181820] border border-white/5 p-2 space-y-1">
                  <div className="text-[10px] text-[#A3A3A3] uppercase font-medium">Original Proposed Split</div>
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="text-white/70">Freelancer:</span>
                    <span className="font-mono text-emerald-400 font-medium">
                      {formatUsdcAmount(originalReport.freelancerAmount)} USDC
                      {originalFreelancerPct !== null && ` (${originalFreelancerPct}%)`}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="text-white/70">Client:</span>
                    <span className="font-mono text-sky-400 font-medium">
                      {formatUsdcAmount(originalReport.clientAmount)} USDC
                      {originalClientPct !== null && ` (${originalClientPct}%)`}
                    </span>
                  </div>
                </div>

                {/* Final Draft Split Column */}
                <div className="rounded bg-[#181820] border border-white/5 p-2 space-y-1">
                  <div className="text-[10px] text-indigo-300 uppercase font-medium">Final Draft Split</div>
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="text-white/70">Freelancer:</span>
                    <span className="font-mono text-emerald-300 font-medium">
                      {freelancerAmountInput.trim() ? `${freelancerAmountInput.trim()} USDC` : '—'}
                      {currentFinalFreelancerPct !== null && ` (${currentFinalFreelancerPct}%)`}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="text-white/70">Client:</span>
                    <span className="font-mono text-sky-300 font-medium">
                      {clientAmountInput.trim() ? `${clientAmountInput.trim()} USDC` : '—'}
                      {currentFinalClientPct !== null && ` (${currentFinalClientPct}%)`}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Executive Summary with Consistency Reminder & Contradiction Detection */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between flex-wrap gap-1">
              <label className="text-[11px] text-[#A3A3A3]">Executive Summary</label>
              <span className="text-[10px] text-zinc-400">
                Make sure your written decision matches the proposed payout and refund amounts.
              </span>
            </div>
            <Input
              type="text"
              placeholder="High-level summary of determination…"
              value={summaryInput}
              onChange={(e) => setSummaryInput(e.target.value)}
              disabled={Boolean(currentAuth)}
              className="h-8 text-xs bg-[#252525] border-white/20 text-white placeholder:text-[#A3A3A3]"
            />
            {equalSplitContradiction && (
              <div className="rounded border border-amber-500/40 bg-amber-950/30 p-2 text-[11px] text-amber-200 flex items-start gap-2 shadow-sm">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <span className="font-semibold text-amber-300">Advisory: Split Description Discrepancy</span>
                  <p className="text-amber-200/90 leading-normal">
                    Your summary describes an equal split, but the proposed settlement amounts are different. Please review the wording before continuing.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-[#A3A3A3]">Detailed Findings</label>
            <textarea
              placeholder="Evaluation of evidence, milestones deliverables, and dispute claims…"
              value={findingsInput}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setFindingsInput(e.target.value)}
              disabled={Boolean(currentAuth)}
              rows={3}
              className="w-full rounded-md border border-white/20 bg-[#252525] p-2.5 text-xs text-white focus:outline-none focus:border-white/50 placeholder:text-[#A3A3A3]"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-[#A3A3A3]">Legal & Equitable Justification</label>
            <textarea
              placeholder="Justification for split decision and contract adherence…"
              value={justificationInput}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setJustificationInput(e.target.value)}
              disabled={Boolean(currentAuth)}
              rows={3}
              className="w-full rounded-md border border-white/20 bg-[#252525] p-2.5 text-xs text-white focus:outline-none focus:border-white/50 placeholder:text-[#A3A3A3]"
            />
          </div>

          {stageError && (
            <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2 text-xs text-red-300 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
              <span>{stageError}</span>
            </div>
          )}

          {!currentAuth && (
            <div className="flex justify-end pt-2">
              <Button
                size="sm"
                onClick={handleStageReport}
                disabled={stagingInProgress || !freelancerAmountInput || !clientAmountInput}
                className="h-8 text-xs bg-white hover:bg-neutral-200 text-[#101010] font-semibold shadow-sm"
              >
                {stagingInProgress ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin text-[#101010]" /> Staging Report…
                  </>
                ) : stagedReport ? (
                  'Update Staged Report'
                ) : (
                  'Stage Resolution Report'
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* STEP 2: Generate Authorization & Signatures */}
      {stagedReport && (
        <Card className="border-white/75 bg-[#1B1B1B] shadow-xl space-y-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
              <Scale className="h-4 w-4 text-white" /> 2. Committee Multi-Sig Authorization (2 of 3)
            </CardTitle>
            <CardDescription className="text-xs text-[#A3A3A3]">
              Collect 2 distinct committee member signatures over the exact hash-bound resolution payload.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!currentAuth ? (
              <div className="space-y-3">
                <p className="text-xs text-[#A3A3A3]">
                  Report staged with cryptographic hash. Generate the formal EIP-712 authorization to begin signature collection.
                </p>
                {authError && (
                  <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2 text-xs text-red-300 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
                    <span>{authError}</span>
                  </div>
                )}
                <Button
                  size="sm"
                  onClick={handleCreateAuthorization}
                  disabled={creatingAuth}
                  className="h-8 text-xs bg-white hover:bg-neutral-200 text-[#101010] font-semibold shadow-sm"
                >
                  {creatingAuth ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin text-[#101010]" /> Generating…
                    </>
                  ) : (
                    'Generate Resolution Authorization'
                  )}
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Authorization Status & Count */}
                <div className="flex items-center justify-between rounded-lg border border-white/20 bg-[#252525] p-3">
                  <div className="space-y-0.5">
                    <div className="text-xs font-semibold text-white">Signatures Collected</div>
                    <div className="text-[11px] text-[#A3A3A3]">
                      {signatureCount} of 2 required signatures collected from active signers.
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isExpired ? (
                      <Badge variant="outline" className="border-red-500/40 bg-red-500/10 text-red-300 text-xs font-mono">
                        Authorization Expired
                      </Badge>
                    ) : isInvalidated ? (
                      <Badge variant="outline" className="border-zinc-600 bg-zinc-800 text-zinc-400 text-xs font-mono">
                        Invalidated
                      </Badge>
                    ) : isExecuted ? (
                      <Badge variant="outline" className="border-purple-500/40 bg-purple-500/10 text-purple-300 text-xs font-mono">
                        Executed On-Chain
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className={
                          isThresholdReady
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 font-mono text-xs'
                            : 'border-amber-500/40 bg-amber-500/10 text-amber-300 font-mono text-xs'
                        }
                      >
                        {isThresholdReady ? '2 / 2 Ready' : `${signatureCount} / 2 Signed`}
                      </Badge>
                    )}
                  </div>
                </div>

                {/* Expired Authorization Recovery Section */}
                {isExpired && !isExecuted && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 space-y-2.5">
                    <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                      <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                      <span>Authorization Expired On-Chain</span>
                    </div>
                    <p className="text-[11px] text-zinc-300 leading-normal">
                      The cryptographic signing window for this authorization has lapsed on-chain.
                      Previously gathered signatures cannot be submitted.
                      An authorized committee member can generate a fresh authorization using the existing staged determination.
                    </p>
                    {authError && (
                      <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2 text-xs text-red-300 flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
                        <span>{authError}</span>
                      </div>
                    )}
                    <div className="pt-0.5">
                      <Button
                        size="sm"
                        onClick={handleCreateAuthorization}
                        disabled={creatingAuth}
                        className="h-8 text-xs bg-white hover:bg-neutral-200 text-[#101010] font-semibold shadow-sm"
                      >
                        {creatingAuth ? (
                          <>
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin text-[#101010]" /> Generating Fresh Authorization…
                          </>
                        ) : (
                          'Generate Fresh Authorization'
                        )}
                      </Button>
                    </div>
                  </div>
                )}

                {/* Signers Attribution List */}
                <div className="space-y-1.5 pt-1">
                  <div className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
                    Signer Attribution
                  </div>
                  {signatures.length === 0 ? (
                    <div className="text-xs text-zinc-500 italic bg-[#1E1E1E] rounded-md p-2.5 border border-white/5">
                      No signatures collected yet. Connected committee members must sign with their authorized wallet.
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {signatures.map((sig, idx) => {
                        const isCurrentSigner = Boolean(address && sig.signerWallet === address.toLowerCase());
                        return (
                          <div
                            key={sig.id || `${sig.signerWallet}-${idx}`}
                            className="flex items-center justify-between rounded-md border border-white/10 bg-[#1E1E1E] px-3 py-2 text-xs"
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-zinc-200" title={sig.signerWallet}>
                                {shortenAddress(sig.signerWallet)}
                              </span>
                              {isCurrentSigner && (
                                <Badge
                                  variant="outline"
                                  className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px] px-1.5 py-0 font-mono"
                                >
                                  You
                                </Badge>
                              )}
                            </div>
                            {sig.createdAt && (
                              <div className="flex items-center gap-1 text-[11px] text-zinc-400">
                                <Clock className="h-3 w-3 text-zinc-500" />
                                <span>
                                  {new Date(sig.createdAt).toLocaleString(undefined, {
                                    month: 'short',
                                    day: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Expiration Timestamp */}
                {validUntilSec && (
                  <div className="flex items-center justify-between text-[11px] text-zinc-400 border-t border-white/5 pt-2">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3 text-zinc-500" />
                      <span>Authorization Expiration:</span>
                    </span>
                    <span className={isExpired ? 'text-red-400 font-medium font-mono' : 'text-zinc-300 font-mono'}>
                      {new Date(validUntilSec * 1000).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                      {isExpired && ' (Expired)'}
                    </span>
                  </div>
                )}

                {signError && (
                  <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2 text-xs text-red-300 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
                    <span>{signError}</span>
                  </div>
                )}

                <div className="flex items-center gap-2 pt-1">
                  {!hasUserSigned && !isExpired && !isInvalidated && !isExecuted && (
                    <Button
                      size="sm"
                      onClick={handleSignAuthorization}
                      disabled={signingInProgress}
                      className="h-8 text-xs bg-white hover:bg-neutral-200 text-[#101010] font-semibold shadow-sm"
                    >
                      {signingInProgress ? (
                        <>
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin text-[#101010]" /> Signing Typed Data…
                        </>
                      ) : (
                        'Sign Resolution (Wallet)'
                      )}
                    </Button>
                  )}
                  {hasUserSigned && (
                    <div className="text-xs text-emerald-400 flex items-center gap-1.5 font-medium">
                      <Check className="h-4 w-4" /> You have signed this resolution.
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* STEP 3: On-Chain Submission & Resolution Confirmation (Phase 2E.4) */}
      {reconciliationSuccess && (
        <Card className="border-emerald-500/40 bg-emerald-950/20 shadow-xl space-y-3">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              <CardTitle className="text-sm font-bold text-white">
                {isFinal ? 'Final Resolution Executed On-Chain' : 'Initial Resolution Proposed On-Chain'}
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            {isFinal ? (
              <div className="space-y-1.5 text-zinc-300">
                <p>• The final committee decision has been executed and confirmed on Sepolia.</p>
                <p>• The contract has distributed the milestone escrow funds to the parties.</p>
                <p>• The confirmed resolution report has been synchronized into the permanent Resolution History.</p>
              </div>
            ) : (
              <div className="space-y-1.5 text-zinc-300">
                <p>• The initial committee resolution proposal has been confirmed on Sepolia.</p>
                <p>• The 72-hour participant reconsideration window now applies.</p>
                <p>• Milestone escrow funds have not yet been distributed.</p>
                <p>• The confirmed proposal report has been synchronized into the permanent Resolution History.</p>
              </div>
            )}

            {executionTxHash && (
              <div className="pt-2 border-t border-emerald-500/20 flex items-center justify-between flex-wrap gap-2">
                <span className="text-[11px] text-zinc-400 font-mono">
                  Tx: {shortenAddress(executionTxHash)}
                </span>
                <a
                  href={`https://sepolia.etherscan.io/tx/${executionTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-300 hover:text-emerald-200 font-mono text-xs flex items-center gap-1"
                >
                  <span>View on Sepolia Etherscan</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}

            <div className="flex items-center gap-2.5 pt-2 border-t border-emerald-500/20">
              <Button
                size="sm"
                onClick={() => {
                  if (onViewInHistory) {
                    onViewInHistory({
                      dealAddress: item.dealAddress,
                      milestoneId: item.milestoneId,
                      phase: item.phase,
                    });
                  } else {
                    onSettled();
                  }
                }}
                className="h-8 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1.5 shadow-sm"
              >
                <span>View in Resolution History</span>
                <ArrowRight className="h-3 w-3" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onSettled}
                className="h-8 text-xs border-white/20 text-zinc-300 hover:text-white"
              >
                Back to Queue
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  )}

      {!reconciliationSuccess && isThresholdReady && (
        <Card className="border-emerald-500/30 bg-emerald-950/10 space-y-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" /> 3. Submit Resolution On-Chain
            </CardTitle>
            <CardDescription className="text-xs text-[#A3A3A3]">
              Threshold met. Active committee member submits gateway transaction to execute resolution.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-[#A3A3A3]">
              The gateway will forward execution to the Deal clone, disburse funds, and record the resolution justification hash on-chain.
            </p>

            {isAmbiguousFailure && (
              <div className="rounded-lg border border-amber-500/50 bg-amber-950/40 p-3 text-xs text-amber-200 space-y-2">
                <div className="flex items-center gap-2 font-semibold text-amber-300">
                  <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                  <span>Wallet Connection Interrupted</span>
                </div>
                <p className="text-[11px] text-zinc-300 leading-normal">
                  Your wallet lost connection while submitting the transaction. It may still have succeeded on-chain. Check the transaction status before trying again.
                </p>
              </div>
            )}

            {submitError && !isAmbiguousFailure && (
              <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2.5 text-xs text-red-300 flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
                  <span>{submitError}</span>
                </div>
                {executionTxHash && (
                  <a
                    href={`https://sepolia.etherscan.io/tx/${executionTxHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-red-300 hover:text-red-200 font-mono text-xs flex items-center gap-1 ml-auto"
                  >
                    <span>View on Sepolia Etherscan</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            )}

            {/* Transaction Recovery & Synchronization Panel */}
            {(isAmbiguousFailure || reconciliationFailed || onChainCheckSuccess || showManualRecovery || executionTxHash) && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-950/20 p-3.5 text-xs text-amber-200 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2 font-semibold text-amber-300">
                    <Scale className="h-4 w-4 text-amber-400 shrink-0" />
                    <span>Advanced / Troubleshooting: Transaction Recovery</span>
                  </div>
                  {showManualRecovery && !isAmbiguousFailure && !reconciliationFailed && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setShowManualRecovery(false)}
                      className="h-6 text-[11px] text-zinc-400 hover:text-white p-1"
                    >
                      Hide
                    </Button>
                  )}
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

                {/* Step B: Recover Transaction */}
                <div className="space-y-2 pt-2 border-t border-amber-500/20">
                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-300 font-medium">
                      2. Transaction Hash (Optional for Event Scan)
                    </label>
                    <Input
                      type="text"
                      placeholder="0x... (leave empty to scan recent events automatically)"
                      value={recoveryTxHashInput}
                      onChange={(e) => {
                        setRecoveryTxHashInput(e.target.value);
                        setRecoveryError(null);
                      }}
                      disabled={reconcilingInProgress}
                      className="h-8 text-xs bg-[#202020] border-white/20 text-white placeholder:text-zinc-500 font-mono"
                    />
                    <p className="text-[10px] text-zinc-400">
                      If you recovered the transaction hash from Rabby or Etherscan, paste it above. Leave blank for server-side event scan.
                    </p>
                  </div>

                  {recoveryError && (
                    <div className="rounded border border-red-500/40 bg-red-950/40 p-2 text-[11px] text-red-300 flex items-center gap-2">
                      <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0" />
                      <span>{recoveryError}</span>
                    </div>
                  )}

                  {recoverySuccessMessage && (
                    <div className="rounded border border-emerald-500/40 bg-emerald-950/40 p-2 text-[11px] text-emerald-300 flex items-center gap-2">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                      <span>{recoverySuccessMessage}</span>
                    </div>
                  )}

                  <div className="flex items-center gap-2 pt-1 flex-wrap">
                    <Button
                      size="sm"
                      onClick={handleRecover}
                      disabled={reconcilingInProgress}
                      className="h-7 text-xs bg-amber-600 hover:bg-amber-500 text-white font-medium"
                    >
                      {reconcilingInProgress ? (
                        <>
                          <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> Recovering Transaction…
                        </>
                      ) : (
                        <>
                          <RotateCcw className="mr-1.5 h-3 w-3" /> Recover Transaction
                        </>
                      )}
                    </Button>

                    {isAmbiguousFailure && !onChainCheckSuccess && onChainMilestoneStatus !== null && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleResetForRetry}
                        className="h-7 text-xs border-zinc-600 text-zinc-300 hover:bg-zinc-800"
                      >
                        Milestone Unsettled: Try Submitting Again
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Quick toggle to reveal recovery when not automatically shown */}
            {!showManualRecovery && !isAmbiguousFailure && !reconciliationFailed && !onChainCheckSuccess && !executionTxHash && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowManualRecovery(true)}
                  className="text-[11px] text-zinc-400 hover:text-zinc-200 underline flex items-center gap-1 cursor-pointer"
                >
                  <RotateCcw className="h-3 w-3" /> Advanced / Troubleshooting: Check on-chain status & recover
                </button>
              </div>
            )}

            {!reconciliationFailed && !isAmbiguousFailure && !onChainCheckSuccess && (
              <Button
                size="sm"
                onClick={handleSubmitExecution}
                disabled={submittingInProgress}
                className="h-8 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
              >
                {submittingInProgress ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Submitting to Blockchain…
                  </>
                ) : isFinal ? (
                  'Submit Final Resolution'
                ) : (
                  'Submit Initial Resolution Proposal'
                )}
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
