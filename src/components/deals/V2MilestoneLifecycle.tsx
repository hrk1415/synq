'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useAccount, useWriteContract } from 'wagmi';
import {
  Play,
  Clock,
  Calendar,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  Layers,
  FileCheck2,
  Send,
  Copy,
  Check,
  Plus,
  Trash2,
  Link2,
  GitPullRequest,
  GitCommit,
  Globe,
  FolderGit2,
  ShieldCheck,
  FileText,
  AlertCircle,
  X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { shortenAddress, cn } from '@/lib/utils';
import { SYNQ_V2_SEPOLIA_CONFIG, SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { synqDealV1ABI } from '@/lib/contracts/abis';
import { getSepoliaExplorerUrl, sepoliaPublicClient } from '@/lib/chain';
import { useSepoliaNetwork, isRejected } from '@/hooks/useSepoliaNetwork';
import { useAuthSession } from '@/hooks/useAuthSession';
import {
  DealState,
  MilestoneStatus,
  MILESTONE_STATUS_LABELS,
  StandardV2DealData,
  determineMilestoneStartEligibility,
  validateStartMilestonePreflight,
  verifyStartMilestoneReceipt,
  determineMilestoneSubmissionEligibility,
  validateSubmitWorkPreflight,
  verifySubmitWorkReceipt,
  calculateReviewWindowExpiration,
  calculateEffectiveSubmissionDeadline,
  readStandardV2DealData,
  isSynqV2Deal,
  hashEvidenceManifest,
  normalizeEvidenceManifest,
  type CanonicalEvidenceManifestV1,
  type CanonicalEvidenceLink,
  type EvidenceLinkType,
  EVIDENCE_LIMITS,
  VALID_LINK_TYPES,
  SettlementType,
  determineMilestoneApprovalEligibility,
  validateClientApprovePreflight,
  verifyClientApproveReceipt,
  determineReviewTimeoutEligibility,
  validateSettleReviewTimeoutPreflight,
  verifySettleReviewTimeoutReceipt,
  getCurrentMilestoneIndex,
  REVISION_RESPONSE_WINDOW,
  determineRequestChangesEligibility,
  validateRequestChangesPreflight,
  verifyRevisionRequestedReceipt,
  determineFreelancerRevisionResponseEligibility,
  validateAcceptRevisionPreflight,
  verifyAcceptRevisionReceipt,
  validateDeclineRevisionPreflight,
  verifyDeclineRevisionReceipt,
  determineTimeoutRevisionResponseEligibility,
  validateTimeoutRevisionResponsePreflight,
  verifyTimeoutRevisionResponseReceipt,
} from '@/lib/deals/v2-deal';
import { formatUsdcAmount, ZERO_BYTES32 } from '@/lib/deals/v2';
import { V2MilestoneDispute } from '@/components/deals/V2MilestoneDispute';

interface V2MilestoneLifecycleProps {
  dealData: StandardV2DealData;
  refetchDealData: () => Promise<void>;
}

interface EditableLink {
  id: string;
  type: EvidenceLinkType;
  value: string;
  label: string;
}

export function V2MilestoneLifecycle({ dealData, refetchDealData }: V2MilestoneLifecycleProps) {
  const { address, chainId } = useAccount();
  const { ensureSepolia } = useSepoliaNetwork();
  const { writeContractAsync } = useWriteContract();
  const { ensureAuthenticated, getToken } = useAuthSession();

  const [actionInProgress, setActionInProgress] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [txConfirmedPendingRefresh, setTxConfirmedPendingRefresh] = useState(false);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);

  // Structured Evidence Form State (Phase 3I-B)
  const [summaryInput, setSummaryInput] = useState<string>('');
  const [linksList, setLinksList] = useState<EditableLink[]>([]);
  const [copiedEvidence, setCopiedEvidence] = useState(false);

  // Submitted record retrieved from server
  const [submittedRecord, setSubmittedRecord] = useState<{
    submission: any;
    manifest: CanonicalEvidenceManifestV1;
  } | null>(null);
  const [loadingSubmittedRecord, setLoadingSubmittedRecord] = useState<boolean>(false);
  const [submittedRecordError, setSubmittedRecordError] = useState<string | null>(null);

  // Request Changes Modal & Staging State (Phase 3K-C)
  const [showRequestChangesModal, setShowRequestChangesModal] = useState<boolean>(false);
  const [revisionFeedback, setRevisionFeedback] = useState<string>('');
  const [revisionProposedDeadlineInput, setRevisionProposedDeadlineInput] = useState<string>('');
  const [stagingRevisionInProgress, setStagingRevisionInProgress] = useState<boolean>(false);
  const [stagingRevisionError, setStagingRevisionError] = useState<string | null>(null);

  // Confirmed Revision Record (for RevisionRequested state)
  const [revisionRecord, setRevisionRecord] = useState<{
    revision: any;
    manifest: any;
  } | null>(null);
  const [loadingRevisionRecord, setLoadingRevisionRecord] = useState<boolean>(false);
  const [revisionRecordError, setRevisionRecordError] = useState<string | null>(null);

  if (dealData.state === DealState.Completed) {
    return (
      <Card className="border-emerald-500/30 bg-emerald-950/20 backdrop-blur-md">
        <CardContent className="pt-6 space-y-2 text-center">
          <CheckCircle2 className="h-6 w-6 text-emerald-400 mx-auto" />
          <h3 className="text-sm font-semibold text-white">Deal Completed</h3>
          <p className="text-xs text-zinc-300">
            All milestones have completed lifecycle settlement. Total settled: {formatUsdcAmount(dealData.totalSettled)} USDC.
          </p>
        </CardContent>
      </Card>
    );
  }

  // If deal is not Active, milestone execution is not active
  if (dealData.state !== DealState.Active) {
    return null;
  }

  const startEligibility = determineMilestoneStartEligibility({
    connectedWallet: address,
    freelancerAddress: dealData.freelancer,
    clientAddress: dealData.client,
    chainId,
    dealState: dealData.state,
    milestones: dealData.milestones,
  });

  const submissionEligibility = determineMilestoneSubmissionEligibility({
    connectedWallet: address,
    freelancerAddress: dealData.freelancer,
    clientAddress: dealData.client,
    chainId,
    dealState: dealData.state,
    milestones: dealData.milestones,
  });

  const approvalEligibility = determineMilestoneApprovalEligibility({
    connectedWallet: address,
    clientAddress: dealData.client,
    freelancerAddress: dealData.freelancer,
    chainId,
    dealState: dealData.state,
    milestones: dealData.milestones,
  });

  const timeoutEligibility = determineReviewTimeoutEligibility({
    connectedWallet: address,
    clientAddress: dealData.client,
    freelancerAddress: dealData.freelancer,
    chainId,
    dealState: dealData.state,
    milestones: dealData.milestones,
    isProtected: dealData.isProtected,
  });

  const currentIndex = getCurrentMilestoneIndex(dealData.milestones);
  if (currentIndex === null) {
    return (
      <Card className="border-emerald-500/30 bg-emerald-950/20 backdrop-blur-md">
        <CardContent className="pt-6 space-y-2 text-center">
          <CheckCircle2 className="h-6 w-6 text-emerald-400 mx-auto" />
          <h3 className="text-sm font-semibold text-white">All Milestones Settled</h3>
          <p className="text-xs text-zinc-400">All milestone deliverables for this deal have completed lifecycle settlement.</p>
        </CardContent>
      </Card>
    );
  }

  const isFinalMilestone = currentIndex === dealData.milestones.length - 1;

  const currentMilestone = dealData.milestones[currentIndex];
  const isFreelancer = Boolean(address && address.toLowerCase() === dealData.freelancer.toLowerCase());
  const isClient = Boolean(address && address.toLowerCase() === dealData.client.toLowerCase());
  const isParticipant = isFreelancer || isClient;

  const isPending = currentMilestone.status === MilestoneStatus.Pending;
  const isInProgress = currentMilestone.status === MilestoneStatus.InProgress;
  const isSubmitted = currentMilestone.status === MilestoneStatus.Submitted;
  const isRevisionRequested = currentMilestone.status === MilestoneStatus.RevisionRequested;
  const isDisputed = currentMilestone.status === MilestoneStatus.Disputed;

  const requestChangesEligibility = determineRequestChangesEligibility({
    connectedWallet: address,
    clientAddress: dealData.client,
    freelancerAddress: dealData.freelancer,
    chainId,
    dealState: dealData.state,
    milestones: dealData.milestones,
    isProtected: dealData.isProtected,
    targetMilestoneIndex: currentIndex,
    hasVerifiedEvidence: Boolean(submittedRecord),
  });

  const freelancerResponseEligibility = determineFreelancerRevisionResponseEligibility({
    connectedWallet: address,
    clientAddress: dealData.client,
    freelancerAddress: dealData.freelancer,
    chainId,
    dealState: dealData.state,
    milestones: dealData.milestones,
    targetMilestoneIndex: currentIndex,
  });

  const revisionTimeoutEligibility = determineTimeoutRevisionResponseEligibility({
    dealState: dealData.state,
    milestones: dealData.milestones,
    currentTimeSeconds: BigInt(Math.floor(Date.now() / 1000)),
    targetMilestoneIndex: currentIndex,
  });

  const effectiveDeadline = calculateEffectiveSubmissionDeadline(
    currentMilestone.workDeadline,
    currentMilestone.gracePeriod
  );

  const reviewDeadline = calculateReviewWindowExpiration(
    currentMilestone.submittedAt,
    currentMilestone.reviewWindow
  );

  const [currentTimestampSeconds, setCurrentTimestampSeconds] = useState<bigint>(() =>
    BigInt(Math.floor(Date.now() / 1000))
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTimestampSeconds(BigInt(Math.floor(Date.now() / 1000)));
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  const isMilestoneWorkExpired = useMemo(() => {
    if (!currentMilestone) return false;
    const isRefundableStatus =
      currentMilestone.status === MilestoneStatus.Pending ||
      currentMilestone.status === MilestoneStatus.InProgress;
    return isRefundableStatus && currentTimestampSeconds > effectiveDeadline;
  }, [currentMilestone, currentTimestampSeconds, effectiveDeadline]);

  const isSubmissionExpired = useMemo(() => {
    return currentTimestampSeconds > effectiveDeadline;
  }, [effectiveDeadline, currentTimestampSeconds]);

  // Expected next submission version (m.version increments in submitWork)
  const nextSubmissionVersion = currentMilestone.version + 1;

  // Build and compute live canonical manifest & hash
  const { previewManifest, previewHash, manifestValidationError } = useMemo(() => {
    const trimmedSummary = summaryInput.trim().normalize('NFC');
    if (!trimmedSummary) {
      return { previewManifest: null, previewHash: null, manifestValidationError: null };
    }

    try {
      const canonicalLinks: CanonicalEvidenceLink[] = linksList
        .filter((l) => l.value.trim().length > 0)
        .map((l) => {
          const item: CanonicalEvidenceLink = {
            type: l.type,
            value: l.value.trim().normalize('NFC'),
          };
          const trimmedLabel = l.label.trim().normalize('NFC');
          if (trimmedLabel) {
            item.label = trimmedLabel;
          }
          return item;
        });

      const unverifiedManifest = {
        schemaVersion: 1,
        chainId: SEPOLIA_CHAIN_ID,
        dealAddress: dealData.dealAddress.toLowerCase() as `0x${string}`,
        milestoneId: currentIndex,
        version: nextSubmissionVersion,
        specHash: currentMilestone.specHash.toLowerCase() as `0x${string}`,
        summary: trimmedSummary,
        links: canonicalLinks,
        attachments: [],
      };

      const normalized = normalizeEvidenceManifest(unverifiedManifest);
      const hash = hashEvidenceManifest(normalized);

      return { previewManifest: normalized, previewHash: hash, manifestValidationError: null };
    } catch (err: any) {
      return { previewManifest: null, previewHash: null, manifestValidationError: err?.message || 'Invalid manifest' };
    }
  }, [summaryInput, linksList, dealData.dealAddress, currentIndex, nextSubmissionVersion, currentMilestone.specHash]);

  // Add / remove link helpers
  const handleAddLink = () => {
    if (linksList.length >= EVIDENCE_LIMITS.MAX_LINKS_COUNT) return;
    setLinksList((prev) => [
      ...prev,
      { id: crypto.randomUUID(), type: 'pr', value: '', label: '' },
    ]);
  };

  const handleRemoveLink = (id: string) => {
    setLinksList((prev) => prev.filter((l) => l.id !== id));
  };

  const handleUpdateLink = (id: string, field: 'type' | 'value' | 'label', val: string) => {
    setLinksList((prev) =>
      prev.map((l) => (l.id === id ? { ...l, [field]: val } : l))
    );
  };

  const copyEvidenceHash = async (hash: string) => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopiedEvidence(true);
      setTimeout(() => setCopiedEvidence(false), 2000);
    } catch {
      // Fallback
    }
  };

  const formatWindowDuration = (seconds: bigint): string => {
    const s = Number(seconds);
    if (s >= 86400) {
      const days = Math.floor(s / 86400);
      const remainingHours = Math.floor((s % 86400) / 3600);
      return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days} day${days > 1 ? 's' : ''}`;
    }
    const hours = Math.floor(s / 3600);
    return `${hours} hour${hours > 1 ? 's' : ''}`;
  };

  const formatTimestamp = (timestamp: bigint): string => {
    if (timestamp === 0n) return '—';
    const date = new Date(Number(timestamp) * 1000);
    return date.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  };

  // Fetch submitted evidence for participant review
  const loadSubmittedRecord = useCallback(async () => {
    if (!isSubmitted || !isParticipant) return;
    setLoadingSubmittedRecord(true);
    setSubmittedRecordError(null);

    try {
      let token = getToken();
      if (!token) {
        token = await ensureAuthenticated();
      }

      const res = await fetch(
        `/api/deals/${dealData.dealAddress}/milestones/${currentIndex}/submissions?version=${currentMilestone.version}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to fetch evidence (HTTP ${res.status})`);
      }

      const data = await res.json();

      // Dual-verify evidence integrity before displaying as verified
      const normalized = normalizeEvidenceManifest(data.manifest);
      const recomputedHash = hashEvidenceManifest(normalized);

      if (recomputedHash.toLowerCase() !== currentMilestone.evidenceRootHash.toLowerCase()) {
        throw new Error(
          `Evidence integrity mismatch: computed hash (${recomputedHash}) does not match on-chain commitment (${currentMilestone.evidenceRootHash})`
        );
      }
      if (normalized.version !== currentMilestone.version) {
        throw new Error(
          `Evidence version mismatch: manifest version v${normalized.version} does not match on-chain v${currentMilestone.version}`
        );
      }
      if (normalized.specHash.toLowerCase() !== currentMilestone.specHash.toLowerCase()) {
        throw new Error('Evidence specHash mismatch: manifest specHash does not match on-chain milestone specHash');
      }

      setSubmittedRecord({
        ...data,
        manifest: normalized,
      });
    } catch (err: any) {
      console.warn('[V2MilestoneLifecycle] Could not load evidence submission:', err);
      setSubmittedRecord(null);
      setSubmittedRecordError(err?.message || 'Could not load evidence submission details');
    } finally {
      setLoadingSubmittedRecord(false);
    }
  }, [isSubmitted, isParticipant, dealData.dealAddress, currentIndex, currentMilestone.version, currentMilestone.evidenceRootHash, currentMilestone.specHash, getToken, ensureAuthenticated]);

  useEffect(() => {
    if (isSubmitted && isParticipant) {
      loadSubmittedRecord();
    }
  }, [isSubmitted, isParticipant, loadSubmittedRecord]);

  // Fetch revision record for participant review (Phase 3K-C)
  const loadRevisionRecord = useCallback(async () => {
    if (!isRevisionRequested || !isParticipant) return;
    setLoadingRevisionRecord(true);
    setRevisionRecordError(null);

    try {
      let token = getToken();
      if (!token) {
        token = await ensureAuthenticated();
      }

      const res = await fetch(
        `/api/deals/${dealData.dealAddress}/milestones/${currentIndex}/revisions?version=${currentMilestone.version}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to fetch revision details (HTTP ${res.status})`);
      }

      const data = await res.json();

      const manifest = data.manifest;
      if (!manifest) {
        throw new Error('Revision record is missing manifest data');
      }

      if (data.revision?.submissionVersion !== currentMilestone.version) {
        throw new Error(`Revision version mismatch: record is v${data.revision?.submissionVersion}, on-chain is v${currentMilestone.version}`);
      }
      if (manifest.specHash?.toLowerCase() !== currentMilestone.specHash.toLowerCase()) {
        throw new Error('Revision specHash mismatch with on-chain milestone specHash');
      }
      if (manifest.evidenceRootHash?.toLowerCase() !== currentMilestone.evidenceRootHash.toLowerCase()) {
        throw new Error('Revision evidenceRootHash mismatch with on-chain milestone deliverable');
      }

      setRevisionRecord(data);
    } catch (err: any) {
      console.warn('[V2MilestoneLifecycle] Could not load revision record:', err);
      setRevisionRecord(null);
      setRevisionRecordError(err?.message || 'Could not load revision details');
    } finally {
      setLoadingRevisionRecord(false);
    }
  }, [
    isRevisionRequested,
    isParticipant,
    dealData.dealAddress,
    currentIndex,
    currentMilestone.version,
    currentMilestone.specHash,
    currentMilestone.evidenceRootHash,
    getToken,
    ensureAuthenticated,
  ]);

  useEffect(() => {
    if (isRevisionRequested && isParticipant) {
      loadRevisionRecord();
    }
  }, [isRevisionRequested, isParticipant, loadRevisionRecord]);

  const handleStartMilestone = async () => {
    if (!address || !isFreelancer || !isPending) return;

    try {
      setActionInProgress(true);
      setActionError(null);
      await ensureSepolia();

      // Fresh authoritative preflight reads from contract
      const isCanonical = await isSynqV2Deal(dealData.dealAddress, sepoliaPublicClient);
      const latestDealData = await readStandardV2DealData(dealData.dealAddress, sepoliaPublicClient);

      const preflight = validateStartMilestonePreflight({
        connectedWallet: address,
        freelancerAddress: latestDealData.freelancer,
        chainId,
        isCanonicalV2Deal: isCanonical,
        dealUsdc: latestDealData.usdc,
        dealState: latestDealData.state,
        targetMilestoneIndex: currentIndex,
        milestones: latestDealData.milestones,
      });

      if (!preflight.valid) {
        throw new Error(preflight.error);
      }

      // Execute on-chain startMilestone(uint256)
      const txHash = await writeContractAsync({
        address: dealData.dealAddress,
        abi: synqDealV1ABI,
        functionName: 'startMilestone',
        args: [BigInt(currentIndex)],
        chainId: SEPOLIA_CHAIN_ID,
      });

      setLastTxHash(txHash);

      // Wait for confirmed receipt
      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });

      // Event verification: confirm MilestoneStarted emitted for exact milestone
      const eventVerification = verifyStartMilestoneReceipt(receipt, dealData.dealAddress, BigInt(currentIndex));
      if (!eventVerification.valid) {
        throw new Error(eventVerification.error || 'Milestone start event verification failed');
      }

      // Refresh on-chain Deal data
      try {
        await refetchDealData();
      } catch (refreshErr) {
        console.warn('[V2MilestoneLifecycle] Confirmed start tx, but refresh failed:', refreshErr);
        setTxConfirmedPendingRefresh(true);
      }
    } catch (err: any) {
      if (isRejected(err)) {
        setActionError('Milestone start transaction was cancelled in your wallet.');
      } else {
        setActionError(err?.message || 'Failed to start milestone');
      }
    } finally {
      setActionInProgress(false);
    }
  };

  // Claim Expired Refund for Client (Standard V2 Lifecycle)
  const handleClaimExpiredRefund = async () => {
    if (!address || !isClient) return;

    try {
      setActionInProgress(true);
      setActionError(null);
      await ensureSepolia();

      const txHash = await writeContractAsync({
        address: dealData.dealAddress as `0x${string}`,
        abi: synqDealV1ABI,
        functionName: 'claimExpiredRefund',
        args: [BigInt(currentIndex)],
        chainId: SEPOLIA_CHAIN_ID,
      });

      setLastTxHash(txHash);
      await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });

      try {
        await refetchDealData();
      } catch (refreshErr) {
        console.warn('[V2MilestoneLifecycle] Confirmed expired refund tx, but refresh failed:', refreshErr);
        setTxConfirmedPendingRefresh(true);
      }
    } catch (err: any) {
      if (isRejected(err)) {
        setActionError('Claim expired refund transaction was cancelled in your wallet.');
      } else {
        setActionError(err?.message || 'Failed to claim expired refund');
      }
    } finally {
      setActionInProgress(false);
    }
  };

  /**
   * CANONICAL WORK SUBMISSION WORKFLOW (Phase 3I-B)
   * 1. Local manifest assembly & canonical hashing
   * 2. Authenticate session & stage manifest off-chain with server
   * 3. Server dual-verifies hash and confirms deal/milestone eligibility
   * 4. Verify returned hash matches local hash
   * 5. Fresh authoritative on-chain preflight
   * 6. Prompt wallet for submitWork(milestoneId, evidenceRootHash)
   * 7. Await receipt & verify on-chain MilestoneSubmitted event
   * 8. Server reconciliation: transitions staged -> confirmed with txHash
   * 9. Refresh view and display confirmed manifest
   */
  const handleSubmitWork = async () => {
    if (!address || !isFreelancer || !isInProgress) return;

    if (!summaryInput.trim()) {
      setActionError('Please enter a submission summary describing the completed work');
      return;
    }

    if (manifestValidationError) {
      setActionError(manifestValidationError);
      return;
    }

    if (!previewManifest || !previewHash) {
      setActionError('Unable to construct canonical evidence manifest');
      return;
    }

    try {
      setActionInProgress(true);
      setActionError(null);
      await ensureSepolia();

      // Step 1: Ensure wallet session is authenticated (SIWE / Bearer JWT)
      const token = await ensureAuthenticated();

      // Step 2: Fresh authoritative reads from contract
      const isCanonical = await isSynqV2Deal(dealData.dealAddress, sepoliaPublicClient);
      const latestDealData = await readStandardV2DealData(dealData.dealAddress, sepoliaPublicClient);
      const targetMilestone = latestDealData.milestones[currentIndex];

      if (targetMilestone.status !== MilestoneStatus.InProgress) {
        throw new Error(`Milestone is not InProgress (current: ${MILESTONE_STATUS_LABELS[targetMilestone.status]})`);
      }

      const expectedVersion = targetMilestone.version + 1;

      // Construct manifest bound to current authoritative on-chain state
      const canonicalLinks: CanonicalEvidenceLink[] = linksList
        .filter((l) => l.value.trim().length > 0)
        .map((l) => {
          const item: CanonicalEvidenceLink = {
            type: l.type,
            value: l.value.trim().normalize('NFC'),
          };
          const trimmedLabel = l.label.trim().normalize('NFC');
          if (trimmedLabel) {
            item.label = trimmedLabel;
          }
          return item;
        });

      const manifestToStage = normalizeEvidenceManifest({
        schemaVersion: 1,
        chainId: SEPOLIA_CHAIN_ID,
        dealAddress: dealData.dealAddress.toLowerCase() as `0x${string}`,
        milestoneId: currentIndex,
        version: expectedVersion,
        specHash: targetMilestone.specHash.toLowerCase() as `0x${string}`,
        summary: summaryInput.trim().normalize('NFC'),
        links: canonicalLinks,
        attachments: [],
      });

      const localEvidenceRootHash = hashEvidenceManifest(manifestToStage);

      // Step 3: Stage manifest with server before prompting wallet
      const stageRes = await fetch(
        `/api/deals/${dealData.dealAddress}/milestones/${currentIndex}/submissions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            manifest: manifestToStage,
            claimedEvidenceRootHash: localEvidenceRootHash,
          }),
        }
      );

      if (!stageRes.ok) {
        const errorData = await stageRes.json().catch(() => ({}));
        throw new Error(errorData.error || `Server evidence staging failed (HTTP ${stageRes.status})`);
      }

      const stageResult = await stageRes.json();
      const serverEvidenceRootHash = stageResult.evidenceRootHash as `0x${string}`;

      // Dual-verification check: server computed hash must match local hash
      if (serverEvidenceRootHash.toLowerCase() !== localEvidenceRootHash.toLowerCase()) {
        throw new Error(
          `Evidence hash mismatch: Server computed ${serverEvidenceRootHash}, local computed ${localEvidenceRootHash}. Aborting submission.`
        );
      }

      // Step 4: Fresh preflight check immediately before wallet transaction
      const preflight = validateSubmitWorkPreflight({
        connectedWallet: address,
        freelancerAddress: latestDealData.freelancer,
        chainId,
        isCanonicalV2Deal: isCanonical,
        dealUsdc: latestDealData.usdc,
        dealState: latestDealData.state,
        targetMilestoneIndex: currentIndex,
        milestones: latestDealData.milestones,
        evidenceRootHash: serverEvidenceRootHash,
      });

      if (!preflight.valid) {
        throw new Error(preflight.error);
      }

      // Step 5: Execute on-chain submitWork(uint256,bytes32)
      const txHash = await writeContractAsync({
        address: dealData.dealAddress,
        abi: synqDealV1ABI,
        functionName: 'submitWork',
        args: [BigInt(currentIndex), serverEvidenceRootHash],
        chainId: SEPOLIA_CHAIN_ID,
      });

      setLastTxHash(txHash);

      // Step 6: Wait for confirmed receipt
      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });

      // Step 7: Event verification: confirm MilestoneSubmitted emitted for exact milestone and hash
      const eventVerification = verifySubmitWorkReceipt(
        receipt,
        dealData.dealAddress,
        BigInt(currentIndex),
        serverEvidenceRootHash
      );
      if (!eventVerification.valid) {
        throw new Error(eventVerification.error || 'Milestone submission event verification failed');
      }

      // Step 8: Reconcile submission state with server
      try {
        const reconcileRes = await fetch(
          `/api/deals/${dealData.dealAddress}/milestones/${currentIndex}/submissions/reconcile`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              version: expectedVersion,
              txHash,
            }),
          }
        );

        if (!reconcileRes.ok) {
          console.warn('[V2MilestoneLifecycle] Reconcile request non-200:', reconcileRes.status);
        }
      } catch (reconcileErr) {
        console.warn('[V2MilestoneLifecycle] Server reconcile network error:', reconcileErr);
      }

      // Reset local inputs
      setSummaryInput('');
      setLinksList([]);

      // Refresh on-chain Deal data
      try {
        await refetchDealData();
      } catch (refreshErr) {
        console.warn('[V2MilestoneLifecycle] Confirmed submit tx, but refresh failed:', refreshErr);
        setTxConfirmedPendingRefresh(true);
      }
    } catch (err: any) {
      if (isRejected(err)) {
        setActionError('Work submission transaction was cancelled in your wallet. Staged evidence has been preserved.');
      } else {
        setActionError(err?.message || 'Failed to submit milestone deliverables');
      }
    } finally {
      setActionInProgress(false);
    }
  };

  /**
   * CANONICAL CLIENT APPROVAL WORKFLOW (Phase 3J)
   * 1. Fresh authoritative reads of deal state and target milestone
   * 2. Validate canonical evidence record matches on-chain commitment
   * 3. Validate clientApprove preflight
   * 4. Prompt wallet for clientApprove(milestoneId) on Deal clone
   * 5. Await receipt & verify on-chain MilestoneSettled event (ClientApproval)
   * 6. Refresh on-chain Deal data
   */
  const handleClientApprove = async () => {
    if (!address || !isClient || !isSubmitted) return;

    if (!submittedRecord) {
      setActionError('Cannot approve milestone: Verified canonical evidence manifest is required before approval.');
      return;
    }

    try {
      setActionInProgress(true);
      setActionError(null);
      await ensureSepolia();

      // Fresh authoritative reads from contract
      const isCanonical = await isSynqV2Deal(dealData.dealAddress, sepoliaPublicClient);
      const latestDealData = await readStandardV2DealData(dealData.dealAddress, sepoliaPublicClient);
      const targetMilestone = latestDealData.milestones[currentIndex];

      const preflight = validateClientApprovePreflight({
        connectedWallet: address,
        clientAddress: latestDealData.client,
        chainId,
        isCanonicalV2Deal: isCanonical,
        dealUsdc: latestDealData.usdc,
        dealState: latestDealData.state,
        targetMilestoneIndex: currentIndex,
        milestones: latestDealData.milestones,
        canonicalEvidence: {
          evidenceRootHash: submittedRecord.submission?.evidenceRootHash || targetMilestone.evidenceRootHash,
          version: submittedRecord.manifest.version,
          specHash: submittedRecord.manifest.specHash,
        },
      });

      if (!preflight.valid) {
        throw new Error(preflight.error);
      }

      // Execute on-chain clientApprove(milestoneId)
      const txHash = await writeContractAsync({
        address: dealData.dealAddress,
        abi: synqDealV1ABI,
        functionName: 'clientApprove',
        args: [BigInt(currentIndex)],
        chainId: SEPOLIA_CHAIN_ID,
      });

      setLastTxHash(txHash);

      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });

      const eventVerification = verifyClientApproveReceipt(
        receipt,
        dealData.dealAddress,
        BigInt(currentIndex),
        targetMilestone.amount
      );
      if (!eventVerification.valid) {
        throw new Error(eventVerification.error || 'Milestone approval event verification failed');
      }

      // Dispatch automatic notifications for payment release and deal completion
      try {
        const token = await ensureAuthenticated();
        const notifyBase = {
          dealId: dealData.dealAddress,
          milestone: currentIndex,
          txHash,
        };
        await fetch('/api/notify', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            ...notifyBase,
            event: 'payment_released',
          }),
        }).catch((e) => console.warn('[V2MilestoneLifecycle] payment_released notify warning:', e));

        const isFinal = currentIndex === dealData.milestones.length - 1;
        if (isFinal) {
          await fetch('/api/notify', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              ...notifyBase,
              event: 'deal_completed',
            }),
          }).catch((e) => console.warn('[V2MilestoneLifecycle] deal_completed notify warning:', e));

          await fetch('/api/notify', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              ...notifyBase,
              event: 'deal_completed_seller',
            }),
          }).catch((e) => console.warn('[V2MilestoneLifecycle] deal_completed_seller notify warning:', e));
        }
      } catch (notifyErr) {
        console.warn('[V2MilestoneLifecycle] Post-approval notify dispatch warning:', notifyErr);
      }

      try {
        await refetchDealData();
      } catch (refreshErr) {
        console.warn('[V2MilestoneLifecycle] Confirmed approve tx, but refresh failed:', refreshErr);
        setTxConfirmedPendingRefresh(true);
      }
    } catch (err: any) {
      if (isRejected(err)) {
        setActionError('Milestone approval transaction was cancelled in your wallet. Milestone remains in review.');
      } else {
        setActionError(err?.message || 'Failed to approve milestone');
      }
    } finally {
      setActionInProgress(false);
    }
  };

  /**
   * CANONICAL REVIEW TIMEOUT SETTLEMENT WORKFLOW (Phase 3J)
   * 1. Fresh authoritative reads of deal state, milestone, and latest block timestamp
   * 2. Validate settleReviewTimeout preflight (strictly block.timestamp > submittedAt + reviewWindow)
   * 3. Prompt wallet for settleReviewTimeout(milestoneId) on Deal clone
   * 4. Await receipt & verify on-chain MilestoneSettled event (StandardReviewTimeout)
   * 5. Refresh on-chain Deal data
   */
  const handleSettleReviewTimeout = async () => {
    if (!address || !isSubmitted) return;

    try {
      setActionInProgress(true);
      setActionError(null);
      await ensureSepolia();

      const isCanonical = await isSynqV2Deal(dealData.dealAddress, sepoliaPublicClient);
      const latestDealData = await readStandardV2DealData(dealData.dealAddress, sepoliaPublicClient);
      const targetMilestone = latestDealData.milestones[currentIndex];

      const latestBlock = await sepoliaPublicClient.getBlock({ blockTag: 'latest' });
      const currentBlockTimestamp = BigInt(latestBlock.timestamp);

      const preflight = validateSettleReviewTimeoutPreflight({
        connectedWallet: address,
        chainId,
        isCanonicalV2Deal: isCanonical,
        isProtected: latestDealData.isProtected,
        dealUsdc: latestDealData.usdc,
        dealState: latestDealData.state,
        targetMilestoneIndex: currentIndex,
        milestones: latestDealData.milestones,
        currentTimeSeconds: currentBlockTimestamp,
      });

      if (!preflight.valid) {
        throw new Error(preflight.error);
      }

      const txHash = await writeContractAsync({
        address: dealData.dealAddress,
        abi: synqDealV1ABI,
        functionName: 'settleReviewTimeout',
        args: [BigInt(currentIndex)],
        chainId: SEPOLIA_CHAIN_ID,
      });

      setLastTxHash(txHash);

      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });

      const eventVerification = verifySettleReviewTimeoutReceipt(
        receipt,
        dealData.dealAddress,
        BigInt(currentIndex),
        targetMilestone.amount
      );
      if (!eventVerification.valid) {
        throw new Error(eventVerification.error || 'Review timeout settlement event verification failed');
      }

      try {
        await refetchDealData();
      } catch (refreshErr) {
        console.warn('[V2MilestoneLifecycle] Confirmed timeout tx, but refresh failed:', refreshErr);
        setTxConfirmedPendingRefresh(true);
      }
    } catch (err: any) {
      if (isRejected(err)) {
        setActionError('Timeout settlement transaction was cancelled in your wallet. Milestone remains in review.');
      } else {
        setActionError(err?.message || 'Failed to execute review timeout settlement');
      }
    } finally {
      setActionInProgress(false);
    }
  };

  const handleStageAndRequestChanges = async () => {
    const trimmedFeedback = revisionFeedback.trim().normalize('NFC');
    if (!trimmedFeedback) {
      setStagingRevisionError('Feedback is required to request changes.');
      return;
    }
    if (trimmedFeedback.length > 4000) {
      setStagingRevisionError('Feedback cannot exceed 4000 characters.');
      return;
    }

    const deadlineMs = new Date(revisionProposedDeadlineInput).getTime();
    if (isNaN(deadlineMs)) {
      setStagingRevisionError('Please specify a valid proposed revision deadline.');
      return;
    }
    const proposedDeadlineSeconds = Math.floor(deadlineMs / 1000);
    if (proposedDeadlineSeconds <= Math.floor(Date.now() / 1000)) {
      setStagingRevisionError('Proposed revision deadline must be strictly in the future.');
      return;
    }

    try {
      setStagingRevisionInProgress(true);
      setStagingRevisionError(null);
      setActionError(null);

      await ensureSepolia();

      let token = getToken();
      if (!token) {
        token = await ensureAuthenticated();
      }

      // Step 1: Stage canonical revision on server
      const stageRes = await fetch(
        `/api/deals/${dealData.dealAddress}/milestones/${currentIndex}/revisions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            feedback: trimmedFeedback,
            proposedRevisionDeadline: proposedDeadlineSeconds,
          }),
        }
      );

      if (!stageRes.ok) {
        const errorData = await stageRes.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to stage revision request (HTTP ${stageRes.status})`);
      }

      const stageData = await stageRes.json();
      const serverReasonHash = stageData.reasonHash;
      const serverProposedDeadline = BigInt(stageData.proposedRevisionDeadline);

      // Step 2: Fresh authoritative preflight read on-chain
      const isCanonical = await isSynqV2Deal(dealData.dealAddress, sepoliaPublicClient);
      const latestDealData = await readStandardV2DealData(dealData.dealAddress, sepoliaPublicClient);
      const latestBlock = await sepoliaPublicClient.getBlock({ blockTag: 'latest' });
      const currentBlockTimestamp = BigInt(latestBlock.timestamp);

      const preflight = validateRequestChangesPreflight({
        connectedWallet: address!,
        clientAddress: latestDealData.client,
        chainId,
        isCanonicalV2Deal: isCanonical,
        dealState: latestDealData.state,
        isProtected: latestDealData.isProtected,
        targetMilestoneIndex: currentIndex,
        milestones: latestDealData.milestones,
        currentTimeSeconds: currentBlockTimestamp,
        stagedRevision: {
          submissionVersion: stageData.submissionVersion,
          specHash: currentMilestone.specHash,
          evidenceRootHash: currentMilestone.evidenceRootHash,
          proposedRevisionDeadline: serverProposedDeadline,
        },
      });

      if (!preflight.valid) {
        throw new Error(preflight.error);
      }

      // Step 3: Broadcast on-chain requestRevision(milestoneId, reasonHash, proposedRevisionDeadline)
      const txHash = await writeContractAsync({
        address: dealData.dealAddress,
        abi: synqDealV1ABI,
        functionName: 'requestRevision',
        args: [BigInt(currentIndex), serverReasonHash, serverProposedDeadline],
        chainId: SEPOLIA_CHAIN_ID,
      });

      setLastTxHash(txHash);

      // Step 4: Wait for transaction receipt
      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });

      // Step 5: Verify RevisionRequested event
      const eventVerification = verifyRevisionRequestedReceipt(
        receipt,
        dealData.dealAddress,
        BigInt(currentIndex),
        serverReasonHash,
        serverProposedDeadline
      );

      if (!eventVerification.valid) {
        throw new Error(eventVerification.error || 'RevisionRequested event verification failed');
      }

      // Step 6: Reconcile staged revision with server
      try {
        const reconcileRes = await fetch(
          `/api/deals/${dealData.dealAddress}/milestones/${currentIndex}/revisions/reconcile`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              version: stageData.submissionVersion,
              txHash,
            }),
          }
        );

        if (!reconcileRes.ok) {
          console.warn('[V2MilestoneLifecycle] Reconcile request non-200:', reconcileRes.status);
        }
      } catch (reconcileErr) {
        console.warn('[V2MilestoneLifecycle] Server reconcile network error:', reconcileErr);
        setActionError('Revision request was submitted on-chain. Verification is still being completed.');
      }

      // Reset local inputs and close modal
      setRevisionFeedback('');
      setRevisionProposedDeadlineInput('');
      setShowRequestChangesModal(false);

      // Step 7: Refresh deal data
      try {
        await refetchDealData();
      } catch (refreshErr) {
        console.warn('[V2MilestoneLifecycle] Confirmed requestRevision tx, but refresh failed:', refreshErr);
        setTxConfirmedPendingRefresh(true);
      }
    } catch (err: any) {
      if (isRejected(err)) {
        setStagingRevisionError('Request Changes transaction was cancelled in your wallet. Staged revision has been preserved.');
      } else {
        setStagingRevisionError(err?.message || 'Failed to request changes');
      }
    } finally {
      setStagingRevisionInProgress(false);
    }
  };

  const handleAcceptRevision = async () => {
    if (!address || !isFreelancer || !isRevisionRequested) return;

    try {
      setActionInProgress(true);
      setActionError(null);
      await ensureSepolia();

      const isCanonical = await isSynqV2Deal(dealData.dealAddress, sepoliaPublicClient);
      const latestDealData = await readStandardV2DealData(dealData.dealAddress, sepoliaPublicClient);
      const latestBlock = await sepoliaPublicClient.getBlock({ blockTag: 'latest' });
      const currentBlockTimestamp = BigInt(latestBlock.timestamp);
      const targetMilestone = latestDealData.milestones[currentIndex];
      const proposedDeadline = targetMilestone.proposedRevisionDeadline ?? 0n;

      const preflight = validateAcceptRevisionPreflight({
        connectedWallet: address,
        freelancerAddress: latestDealData.freelancer,
        chainId,
        isCanonicalV2Deal: isCanonical,
        dealState: latestDealData.state,
        targetMilestoneIndex: currentIndex,
        milestones: latestDealData.milestones,
        proposedRevisionDeadline: proposedDeadline,
        currentTimeSeconds: currentBlockTimestamp,
      });

      if (!preflight.valid) {
        throw new Error(preflight.error);
      }

      const txHash = await writeContractAsync({
        address: dealData.dealAddress,
        abi: synqDealV1ABI,
        functionName: 'acceptRevision',
        args: [BigInt(currentIndex)],
        chainId: SEPOLIA_CHAIN_ID,
      });

      setLastTxHash(txHash);

      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });

      const eventVerification = verifyAcceptRevisionReceipt(
        receipt,
        dealData.dealAddress,
        BigInt(currentIndex),
        proposedDeadline
      );

      if (!eventVerification.valid) {
        throw new Error(eventVerification.error || 'RevisionAccepted event verification failed');
      }

      try {
        await refetchDealData();
      } catch (refreshErr) {
        console.warn('[V2MilestoneLifecycle] Confirmed acceptRevision tx, but refresh failed:', refreshErr);
        setTxConfirmedPendingRefresh(true);
      }
    } catch (err: any) {
      if (isRejected(err)) {
        setActionError('Accept revision transaction was cancelled in your wallet.');
      } else {
        setActionError(err?.message || 'Failed to accept revision request');
      }
    } finally {
      setActionInProgress(false);
    }
  };

  const handleDeclineRevision = async () => {
    if (!address || !isFreelancer || !isRevisionRequested) return;

    try {
      setActionInProgress(true);
      setActionError(null);
      await ensureSepolia();

      const isCanonical = await isSynqV2Deal(dealData.dealAddress, sepoliaPublicClient);
      const latestDealData = await readStandardV2DealData(dealData.dealAddress, sepoliaPublicClient);

      const preflight = validateDeclineRevisionPreflight({
        connectedWallet: address,
        freelancerAddress: latestDealData.freelancer,
        chainId,
        isCanonicalV2Deal: isCanonical,
        dealState: latestDealData.state,
        targetMilestoneIndex: currentIndex,
        milestones: latestDealData.milestones,
      });

      if (!preflight.valid) {
        throw new Error(preflight.error);
      }

      const txHash = await writeContractAsync({
        address: dealData.dealAddress,
        abi: synqDealV1ABI,
        functionName: 'declineRevision',
        args: [BigInt(currentIndex)],
        chainId: SEPOLIA_CHAIN_ID,
      });

      setLastTxHash(txHash);

      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });

      const eventVerification = verifyDeclineRevisionReceipt(
        receipt,
        dealData.dealAddress,
        BigInt(currentIndex)
      );

      if (!eventVerification.valid) {
        throw new Error(eventVerification.error || 'RevisionDeclined event verification failed');
      }

      try {
        await refetchDealData();
      } catch (refreshErr) {
        console.warn('[V2MilestoneLifecycle] Confirmed declineRevision tx, but refresh failed:', refreshErr);
        setTxConfirmedPendingRefresh(true);
      }
    } catch (err: any) {
      if (isRejected(err)) {
        setActionError('Decline revision transaction was cancelled in your wallet.');
      } else {
        setActionError(err?.message || 'Failed to decline revision request');
      }
    } finally {
      setActionInProgress(false);
    }
  };

  const handleTimeoutRevisionResponse = async () => {
    if (!address || !isRevisionRequested) return;

    try {
      setActionInProgress(true);
      setActionError(null);
      await ensureSepolia();

      const isCanonical = await isSynqV2Deal(dealData.dealAddress, sepoliaPublicClient);
      const latestDealData = await readStandardV2DealData(dealData.dealAddress, sepoliaPublicClient);
      const latestBlock = await sepoliaPublicClient.getBlock({ blockTag: 'latest' });
      const currentBlockTimestamp = BigInt(latestBlock.timestamp);
      const targetMilestone = latestDealData.milestones[currentIndex];
      const requestedAt = targetMilestone.revisionRequestedAt ?? 0n;

      const preflight = validateTimeoutRevisionResponsePreflight({
        chainId,
        isCanonicalV2Deal: isCanonical,
        dealState: latestDealData.state,
        targetMilestoneIndex: currentIndex,
        milestones: latestDealData.milestones,
        revisionRequestedAt: requestedAt,
        currentTimeSeconds: currentBlockTimestamp,
      });

      if (!preflight.valid) {
        throw new Error(preflight.error);
      }

      const txHash = await writeContractAsync({
        address: dealData.dealAddress,
        abi: synqDealV1ABI,
        functionName: 'timeoutRevisionResponse',
        args: [BigInt(currentIndex)],
        chainId: SEPOLIA_CHAIN_ID,
      });

      setLastTxHash(txHash);

      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });

      const eventVerification = verifyTimeoutRevisionResponseReceipt(
        receipt,
        dealData.dealAddress,
        BigInt(currentIndex)
      );

      if (!eventVerification.valid) {
        throw new Error(eventVerification.error || 'MilestoneDisputed timeout event verification failed');
      }

      try {
        await refetchDealData();
      } catch (refreshErr) {
        console.warn('[V2MilestoneLifecycle] Confirmed timeoutRevisionResponse tx, but refresh failed:', refreshErr);
        setTxConfirmedPendingRefresh(true);
      }
    } catch (err: any) {
      if (isRejected(err)) {
        setActionError('Timeout revision response transaction was cancelled in your wallet.');
      } else {
        setActionError(err?.message || 'Failed to execute revision timeout settlement');
      }
    } finally {
      setActionInProgress(false);
    }
  };

  const getLinkIcon = (type: EvidenceLinkType) => {
    switch (type) {
      case 'pr':
        return <GitPullRequest className="h-3.5 w-3.5 text-purple-400" />;
      case 'commit':
        return <GitCommit className="h-3.5 w-3.5 text-blue-400" />;
      case 'repository':
        return <FolderGit2 className="h-3.5 w-3.5 text-emerald-400" />;
      case 'web':
        return <Globe className="h-3.5 w-3.5 text-amber-400" />;
      default:
        return <Link2 className="h-3.5 w-3.5 text-zinc-400" />;
    }
  };

  return (
    <Card className="border-purple-500/30 bg-zinc-950/60 backdrop-blur-md">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base text-white flex items-center gap-2">
              <Layers className="h-4 w-4 text-purple-400" /> Current Milestone Lifecycle
            </CardTitle>
            <CardDescription className="text-xs text-zinc-400">
              Milestone {currentIndex + 1} of {dealData.milestones.length} • {formatUsdcAmount(currentMilestone.amount)} USDC
            </CardDescription>
          </div>
          {isMilestoneWorkExpired ? (
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-xs text-amber-400 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" /> Expired — Refund Available
            </Badge>
          ) : isPending ? (
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-xs text-amber-400">
              Pending Start
            </Badge>
          ) : isInProgress ? (
            <Badge variant="outline" className="border-purple-500/40 bg-purple-500/10 text-xs text-purple-400">
              Work In Progress
            </Badge>
          ) : isSubmitted ? (
            <Badge variant="outline" className="border-blue-500/40 bg-blue-500/10 text-xs text-blue-400">
              Submitted — In Client Review
            </Badge>
          ) : isRevisionRequested ? (
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-xs text-amber-400">
              Changes Requested
            </Badge>
          ) : isDisputed ? (
            <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 text-xs text-rose-400">
              Dispute Open
            </Badge>
          ) : (
            <Badge variant="outline" className="border-zinc-700 text-xs text-zinc-300">
              {MILESTONE_STATUS_LABELS[currentMilestone.status]}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Milestone Specs & Parameters */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5 text-zinc-500" /> Work Deadline
            </div>
            <div className="font-semibold text-white">{formatTimestamp(currentMilestone.workDeadline)}</div>
            <div className="text-[10px] text-zinc-500">
              Grace buffer: {formatWindowDuration(currentMilestone.gracePeriod)}
            </div>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-zinc-500" /> Review Window
            </div>
            <div className="font-semibold text-white">{formatWindowDuration(currentMilestone.reviewWindow)}</div>
            <div className="text-[10px] text-zinc-500">
              Client inspection period
            </div>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold flex items-center gap-1.5">
              <FileCheck2 className="h-3.5 w-3.5 text-zinc-500" /> Spec Hash
            </div>
            <div className="font-mono text-xs text-zinc-300 truncate select-all" title={currentMilestone.specHash}>
              {currentMilestone.specHash}
            </div>
            <div className="text-[10px] text-zinc-500">Cryptographically bound acceptance criteria</div>
          </div>
        </div>

        {/* Action Error Banner */}
        {actionError && (
          <div className="rounded-lg border border-red-500/40 bg-red-950/40 p-3 text-xs text-red-300 flex items-start gap-2.5">
            <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 space-y-1">
              <div className="font-semibold text-red-200">Action Failed</div>
              <div className="text-[11px] leading-relaxed break-words">{actionError}</div>
            </div>
          </div>
        )}

        {/* Refresh Pending Confirmation Banner */}
        {txConfirmedPendingRefresh && (
          <div className="rounded-lg border border-blue-500/40 bg-blue-950/30 p-3 text-xs text-blue-300 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-blue-400 shrink-0" />
              Transaction confirmed on-chain. Syncing latest state…
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs border-blue-500/40 text-blue-300 hover:bg-blue-900/40"
              onClick={() => {
                refetchDealData();
                setTxConfirmedPendingRefresh(false);
              }}
            >
              <RefreshCw className="mr-1 h-3 w-3" /> Refresh
            </Button>
          </div>
        )}

        {/* LIFECYCLE STAGE 1: EXPIRED WORK OR PENDING START */}
        {isMilestoneWorkExpired ? (
          <div className="rounded-xl border border-amber-500/40 bg-amber-950/20 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-amber-300 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-400" /> Expired — Refund Available
              </span>
              <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-300">
                claimExpiredRefund({currentIndex})
              </Badge>
            </div>
            {isClient ? (
              <div className="space-y-3">
                <p className="text-xs text-zinc-300">
                  Milestone work deadline elapsed without deliverables. As the client, you can claim a full refund of the {formatUsdcAmount(currentMilestone.amount)} USDC escrow.
                </p>
                <Button
                  size="sm"
                  className="w-full sm:w-auto h-8 text-xs bg-amber-600 hover:bg-amber-500 text-white font-medium"
                  disabled={actionInProgress || chainId !== SEPOLIA_CHAIN_ID || txConfirmedPendingRefresh}
                  onClick={handleClaimExpiredRefund}
                >
                  {actionInProgress ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Claiming Refund…
                    </>
                  ) : (
                    <>Claim Expired Refund ({formatUsdcAmount(currentMilestone.amount)} USDC)</>
                  )}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-zinc-400">
                Milestone work deadline elapsed without deliverables. Milestone escrow of {formatUsdcAmount(currentMilestone.amount)} USDC is eligible for client refund.
              </p>
            )}
          </div>
        ) : isPending ? (
          isFreelancer ? (
            <div className="rounded-xl border border-purple-500/30 bg-purple-950/20 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white flex items-center gap-2">
                  <Play className="h-4 w-4 text-purple-400 fill-current" /> Ready to Start Milestone
                </span>
                <Badge variant="outline" className="border-purple-500/40 text-[10px] text-purple-300">
                  startMilestone({currentIndex})
                </Badge>
              </div>
              <p className="text-xs text-zinc-300">
                You are the designated freelancer for this deal. Calling start milestone activates the sequential execution clock on-chain.
              </p>
              <Button
                size="sm"
                className="w-full sm:w-auto h-8 text-xs bg-purple-600 hover:bg-purple-500 text-white font-medium"
                disabled={actionInProgress || chainId !== SEPOLIA_CHAIN_ID || txConfirmedPendingRefresh}
                onClick={handleStartMilestone}
              >
                {actionInProgress ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Starting Milestone…
                  </>
                ) : (
                  <>
                    <Play className="mr-1.5 h-3.5 w-3.5 fill-current" /> Start Milestone {currentIndex + 1}
                  </>
                )}
              </Button>
            </div>
          ) : isClient ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-200 flex items-center gap-2">
                  <Clock className="h-4 w-4 text-amber-400" /> Awaiting Freelancer Start
                </span>
                <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400">
                  Sequential Order
                </Badge>
              </div>
              <p className="text-xs text-zinc-400">
                The escrow is funded and ready. Designated freelancer ({shortenAddress(dealData.freelancer)}) must call start milestone to begin work.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-2">
              <div className="text-xs font-semibold text-zinc-200 flex items-center gap-2">
                <Clock className="h-4 w-4 text-amber-400" /> Milestone Pending Start
              </div>
              <p className="text-xs text-zinc-400">
                Milestone {currentIndex + 1} is awaiting start by designated freelancer ({shortenAddress(dealData.freelancer)}).
              </p>
            </div>
          )
        ) : null}

        {/* LIFECYCLE STAGE 2: IN PROGRESS (FREELANCER SUBMISSION FORM) */}
        {isInProgress && !isMilestoneWorkExpired ? (
          isFreelancer ? (
            <div className="rounded-xl border border-purple-500/30 bg-purple-950/10 p-4 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white flex items-center gap-2">
                  <Play className="h-4 w-4 text-purple-400 fill-current" /> Submit Milestone Deliverables
                </span>
                <Badge variant="outline" className="border-purple-500/30 text-[10px] text-purple-300">
                  v{nextSubmissionVersion} • submitWork({currentIndex})
                </Badge>
              </div>

              <p className="text-xs text-zinc-300">
                Provide structured submission details. Synq constructs a canonical deterministic evidence manifest, stages it off-chain, and cryptographically commits its 32-byte hash on-chain.
              </p>

              {/* 1. Submission Summary Textarea */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                    Submission Summary <span className="text-red-400">*</span>
                  </label>
                  <span className="text-[10px] font-mono text-zinc-500">
                    {summaryInput.length} / {EVIDENCE_LIMITS.MAX_SUMMARY_LENGTH}
                  </span>
                </div>
                <textarea
                  value={summaryInput}
                  onChange={(e) => setSummaryInput(e.target.value.slice(0, EVIDENCE_LIMITS.MAX_SUMMARY_LENGTH))}
                  placeholder="Describe the completed work, deliverables, and how acceptance criteria were met…"
                  rows={3}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs text-white placeholder-zinc-500 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                  disabled={actionInProgress || txConfirmedPendingRefresh}
                />
              </div>

              {/* 2. Structured Evidence Links */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                    Evidence References & Links ({linksList.length}/{EVIDENCE_LIMITS.MAX_LINKS_COUNT})
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleAddLink}
                    disabled={linksList.length >= EVIDENCE_LIMITS.MAX_LINKS_COUNT || actionInProgress}
                    className="h-6 text-[10px] px-2 border-purple-500/30 text-purple-300 hover:bg-purple-900/30"
                  >
                    <Plus className="h-3 w-3 mr-1" /> Add Reference
                  </Button>
                </div>

                {linksList.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-zinc-800 p-3 text-center text-xs text-zinc-500">
                    No reference links added yet. Click &quot;Add Reference&quot; to include PRs, Git commits, repository links, or URLs.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {linksList.map((link, idx) => (
                      <div
                        key={link.id}
                        className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2.5 space-y-2 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 font-semibold text-zinc-300">
                            {getLinkIcon(link.type)}
                            <span>Reference {idx + 1}</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleRemoveLink(link.id)}
                            className="text-zinc-500 hover:text-red-400 p-0.5"
                            title="Remove reference"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                          <div className="sm:col-span-1">
                            <select
                              value={link.type}
                              onChange={(e) => handleUpdateLink(link.id, 'type', e.target.value)}
                              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-white focus:border-purple-500 focus:outline-none"
                              disabled={actionInProgress}
                            >
                              <option value="pr">PR</option>
                              <option value="commit">Commit</option>
                              <option value="web">Web URL</option>
                              <option value="repository">Repository</option>
                              <option value="other">Other</option>
                            </select>
                          </div>
                          <div className="sm:col-span-3">
                            <input
                              type="text"
                              value={link.value}
                              onChange={(e) => handleUpdateLink(link.id, 'value', e.target.value.slice(0, EVIDENCE_LIMITS.MAX_LINK_VALUE_LENGTH))}
                              placeholder={
                                link.type === 'commit'
                                  ? 'Git commit SHA (e.g. 7-40 hex chars)'
                                  : link.type === 'pr'
                                  ? 'https://github.com/org/repo/pull/123'
                                  : 'URL or reference string'
                              }
                              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-white placeholder-zinc-500 focus:border-purple-500 focus:outline-none"
                              disabled={actionInProgress}
                            />
                          </div>
                        </div>

                        <div>
                          <input
                            type="text"
                            value={link.label}
                            onChange={(e) => handleUpdateLink(link.id, 'label', e.target.value.slice(0, EVIDENCE_LIMITS.MAX_LINK_LABEL_LENGTH))}
                            placeholder="Optional label (e.g. 'Core Implementation PR' or 'Benchmark Results')"
                            className="w-full rounded-md border border-zinc-800/80 bg-zinc-950/70 px-2.5 py-1 text-[11px] text-zinc-300 placeholder-zinc-600 focus:border-purple-500 focus:outline-none"
                            disabled={actionInProgress}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 3. Pre-Commit Review & Canonical Hash Preview */}
              {previewHash && (
                <div className="rounded-xl border border-purple-500/30 bg-purple-950/20 p-3 space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] uppercase font-semibold text-purple-300 flex items-center gap-1.5">
                      <ShieldCheck className="h-3.5 w-3.5 text-purple-400" />
                      Canonical Evidence Commitment Preview
                    </span>
                    <button
                      type="button"
                      onClick={() => copyEvidenceHash(previewHash)}
                      className="text-zinc-400 hover:text-white"
                      title="Copy canonical evidence hash"
                    >
                      {copiedEvidence ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                    </button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] text-zinc-400 font-mono">
                    <div>
                      <span className="text-[10px] uppercase font-sans text-zinc-500 block">Version:</span>
                      <span className="text-zinc-200">v{nextSubmissionVersion}</span>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase font-sans text-zinc-500 block">Milestone:</span>
                      <span className="text-zinc-200">#{currentIndex + 1}</span>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase font-sans text-zinc-500 block">References:</span>
                      <span className="text-zinc-200">{linksList.length}</span>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase font-sans text-zinc-500 block">Schema:</span>
                      <span className="text-zinc-200">v1 (JCS/NFC)</span>
                    </div>
                  </div>

                  <div className="space-y-1 pt-1 font-mono">
                    <span className="text-[10px] uppercase font-sans font-semibold text-zinc-400 block">
                      evidenceRootHash:
                    </span>
                    <div className="text-purple-200 break-all select-all text-[11px] bg-zinc-950/80 p-2 rounded border border-purple-500/20">
                      {previewHash}
                    </div>
                  </div>

                  <p className="text-[11px] text-zinc-400 pt-1">
                    This evidence will be committed to the Deal. After submission, this version cannot be changed.
                  </p>
                </div>
              )}

              {manifestValidationError && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-950/30 p-2.5 text-xs text-amber-300 flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                  <span>{manifestValidationError}</span>
                </div>
              )}

              {/* Effective Deadline Information */}
              <div className="flex items-center justify-between text-xs text-zinc-400 pt-1">
                <span>Effective submission deadline:</span>
                <span className="font-semibold text-zinc-200">
                  {formatTimestamp(effectiveDeadline)}
                </span>
              </div>

              {isSubmissionExpired && (
                <div className="rounded-lg border border-red-500/30 bg-red-950/30 p-2.5 text-xs text-red-300 flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                  <span>Work deadline and grace period have expired for this milestone.</span>
                </div>
              )}

              <Button
                size="sm"
                className="w-full sm:w-auto h-8 text-xs bg-purple-600 hover:bg-purple-500 text-white font-medium"
                disabled={
                  actionInProgress ||
                  chainId !== SEPOLIA_CHAIN_ID ||
                  txConfirmedPendingRefresh ||
                  !summaryInput.trim() ||
                  Boolean(manifestValidationError) ||
                  isSubmissionExpired
                }
                onClick={handleSubmitWork}
              >
                {actionInProgress ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Submitting Deliverables…
                  </>
                ) : (
                  <>
                    <Send className="mr-1.5 h-3.5 w-3.5" /> Submit Work for Review
                  </>
                )}
              </Button>
            </div>
          ) : isClient ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-200 flex items-center gap-2">
                  <Clock className="h-4 w-4 text-purple-400" /> Work In Progress
                </span>
                <span className="text-[11px] font-mono text-zinc-400">
                  Deadline: {formatTimestamp(currentMilestone.workDeadline)}
                </span>
              </div>
              <p className="text-xs text-zinc-400">
                Freelancer ({shortenAddress(dealData.freelancer)}) is actively completing deliverables for Milestone {currentIndex + 1}. Awaiting submission.
              </p>
              <div className="text-[11px] text-zinc-500">
                Grace period buffer: {formatWindowDuration(currentMilestone.gracePeriod)} (Effective deadline: {formatTimestamp(effectiveDeadline)})
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-2">
              <div className="text-xs font-semibold text-zinc-200 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-purple-400" /> Work In Progress
              </div>
              <p className="text-xs text-zinc-400">
                Milestone {currentIndex + 1} is in progress by designated freelancer ({shortenAddress(dealData.freelancer)}).
              </p>
            </div>
          )
        ) : null}

        {/* LIFECYCLE STAGE 3: SUBMITTED (REVIEW & RETRIEVAL DISPLAY) */}
        {isSubmitted ? (
          <div className="rounded-xl border border-blue-500/30 bg-blue-950/20 p-4 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-blue-300 flex items-center gap-2">
                <FileCheck2 className="h-4 w-4 text-blue-400" /> Milestone Deliverables Submitted
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-white font-mono">
                  {formatUsdcAmount(currentMilestone.amount)} USDC
                </span>
                <Badge variant="outline" className="border-blue-500/40 text-[10px] text-blue-300">
                  v{currentMilestone.version}
                </Badge>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs pt-1">
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Submitted At</div>
                <div className="font-semibold text-white">{formatTimestamp(currentMilestone.submittedAt)}</div>
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Review Window Expiration</div>
                <div className="font-semibold text-white">{formatTimestamp(reviewDeadline)}</div>
              </div>
            </div>

            {/* Canonical Evidence Manifest Details (Participant Review) */}
            {isParticipant ? (
              submittedRecord ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 space-y-3">
                  <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                    <span className="text-[11px] font-semibold text-zinc-300 flex items-center gap-1.5">
                      <FileText className="h-3.5 w-3.5 text-blue-400" /> Canonical Submission Manifest
                    </span>
                    <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-300">
                      Cryptographically Verified
                    </Badge>
                  </div>

                  {/* Summary */}
                  <div className="space-y-1">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Submission Summary</div>
                    <div className="rounded-md bg-zinc-950/70 p-2.5 text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed border border-zinc-800/80">
                      {submittedRecord.manifest.summary}
                    </div>
                  </div>

                  {/* Links */}
                  {submittedRecord.manifest.links && submittedRecord.manifest.links.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">
                        Evidence References ({submittedRecord.manifest.links.length})
                      </div>
                      <div className="space-y-1.5">
                        {submittedRecord.manifest.links.map((link, idx) => (
                          <div
                            key={idx}
                            className="rounded-md border border-zinc-800/80 bg-zinc-950/50 p-2 flex items-center justify-between text-xs"
                          >
                            <div className="flex items-center gap-2 overflow-hidden">
                              {getLinkIcon(link.type)}
                              {link.label && (
                                <span className="font-medium text-zinc-300 shrink-0">{link.label}:</span>
                              )}
                              <span className="text-zinc-400 truncate font-mono text-[11px]">
                                {link.value}
                              </span>
                            </div>
                            {link.type === 'web' || link.type === 'pr' || link.type === 'repository' ? (
                              <a
                                href={link.value}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 hover:underline shrink-0 ml-2"
                              >
                                Open <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : loadingSubmittedRecord ? (
                <div className="rounded-lg border border-zinc-800 p-3 text-center text-xs text-zinc-400 flex items-center justify-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
                  Retrieving evidence manifest…
                </div>
              ) : submittedRecordError ? (
                <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-xs text-red-300 flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
                    <span>Evidence integrity / retrieval error: {submittedRecordError}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={loadSubmittedRecord}
                    className="h-6 text-[11px] border-red-500/40 text-red-300 hover:bg-red-900/40 shrink-0 ml-2"
                  >
                    Retry
                  </Button>
                </div>
              ) : null
            ) : null}

            {/* Evidence Root Hash Commitment */}
            <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-2.5 flex items-center justify-between text-xs font-mono">
              <div className="flex items-center gap-2 overflow-hidden">
                <span className="text-[10px] uppercase text-zinc-400 font-sans font-semibold shrink-0">Evidence Root Hash:</span>
                <span className="text-zinc-200 truncate">{currentMilestone.evidenceRootHash}</span>
              </div>
              <button
                type="button"
                onClick={() => copyEvidenceHash(currentMilestone.evidenceRootHash)}
                className="text-zinc-400 hover:text-white shrink-0 ml-2"
                title="Copy Evidence Root Hash"
              >
                {copiedEvidence ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>

            {/* Review Status & Actions */}
            {isClient ? (
              <div className="space-y-3 pt-2">
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-300 space-y-1">
                  <div className="font-semibold text-white flex items-center gap-1.5">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" /> Client Review & Final Approval
                  </div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    Approval is final for Milestone {currentIndex + 1}. Once approved, {formatUsdcAmount(currentMilestone.amount)} USDC will be released immediately to the freelancer ({shortenAddress(dealData.freelancer)}). {isFinalMilestone ? 'This is the final milestone: approval will mark the entire deal as Completed.' : 'The next milestone will become available for the freelancer to start.'}
                  </p>
                </div>

                {timeoutEligibility.isExpired && (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 p-2.5 text-xs text-amber-300 flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold">Review Period Expired</div>
                      <div className="text-[11px] text-amber-200/80">
                        The review window for this milestone has passed. Settlement is available via standard review timeout or direct approval.
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    size="sm"
                    className="h-8 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
                    disabled={
                      actionInProgress ||
                      chainId !== SEPOLIA_CHAIN_ID ||
                      txConfirmedPendingRefresh ||
                      !submittedRecord ||
                      !approvalEligibility.canApprove
                    }
                    onClick={handleClientApprove}
                  >
                    {actionInProgress ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Processing Approval…
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Approve & Release {formatUsdcAmount(currentMilestone.amount)} USDC
                      </>
                    )}
                  </Button>

                  {requestChangesEligibility.canRequestChanges && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs border-amber-500/40 text-amber-300 hover:bg-amber-950/40 font-medium"
                      disabled={
                        actionInProgress ||
                        chainId !== SEPOLIA_CHAIN_ID ||
                        txConfirmedPendingRefresh ||
                        !submittedRecord
                      }
                      onClick={() => {
                        setActionError(null);
                        setStagingRevisionError(null);
                        setShowRequestChangesModal(true);
                      }}
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Request Changes
                    </Button>
                  )}

                  {timeoutEligibility.isExpired && timeoutEligibility.canSettleTimeout && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs border-amber-500/40 text-amber-300 hover:bg-amber-950/40"
                      disabled={actionInProgress || chainId !== SEPOLIA_CHAIN_ID || txConfirmedPendingRefresh}
                      onClick={handleSettleReviewTimeout}
                    >
                      {actionInProgress ? (
                        <>
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Settling…
                        </>
                      ) : (
                        <>
                          <Clock className="mr-1.5 h-3.5 w-3.5" /> Settle via Review Timeout
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            ) : isFreelancer ? (
              <div className="space-y-3 pt-2">
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-300 space-y-1">
                  <div className="font-semibold text-white flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-blue-400" /> Awaiting Client Review
                  </div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    Your deliverables for Milestone {currentIndex + 1} are currently in client review. The client has until {formatTimestamp(reviewDeadline)} to approve. Escrow funds remain held securely in the Deal clone.
                  </p>
                </div>

                {timeoutEligibility.isExpired && (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 p-3 text-xs text-amber-300 space-y-2">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-semibold">Client Review Window Expired</div>
                        <div className="text-[11px] text-amber-200/80">
                          The client review window expired at {formatTimestamp(reviewDeadline)}. According to protocol rules, you may execute permissionless review timeout settlement to release {formatUsdcAmount(currentMilestone.amount)} USDC to your wallet.
                        </div>
                      </div>
                    </div>
                    {timeoutEligibility.canSettleTimeout && (
                      <Button
                        size="sm"
                        className="h-8 text-xs bg-amber-600 hover:bg-amber-500 text-white font-medium"
                        disabled={actionInProgress || chainId !== SEPOLIA_CHAIN_ID || txConfirmedPendingRefresh}
                        onClick={handleSettleReviewTimeout}
                      >
                        {actionInProgress ? (
                          <>
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Settling Timeout…
                          </>
                        ) : (
                          <>
                            <Clock className="mr-1.5 h-3.5 w-3.5" /> Settle via Review Timeout ({formatUsdcAmount(currentMilestone.amount)} USDC)
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3 pt-2">
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-400 space-y-1">
                  <div className="font-semibold text-zinc-200 flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-blue-400" /> Milestone Under Review
                  </div>
                  <p className="text-[11px] leading-relaxed">
                    Milestone {currentIndex + 1} is currently submitted and awaiting client approval.
                  </p>
                </div>

                {timeoutEligibility.isExpired && timeoutEligibility.canSettleTimeout && (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 p-3 text-xs text-amber-300 space-y-2">
                    <div className="font-semibold">Review Period Expired</div>
                    <p className="text-[11px] text-amber-200/80">
                      Client review period has expired. Permissionless timeout settlement is available.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs border-amber-500/40 text-amber-300 hover:bg-amber-950/40"
                      disabled={actionInProgress || chainId !== SEPOLIA_CHAIN_ID || txConfirmedPendingRefresh}
                      onClick={handleSettleReviewTimeout}
                    >
                      {actionInProgress ? (
                        <>
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Settling…
                        </>
                      ) : (
                        <>
                          <Clock className="mr-1.5 h-3.5 w-3.5" /> Settle via Review Timeout
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : null}

        {/* LIFECYCLE STAGE 4: REVISION REQUESTED */}
        {isRevisionRequested ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-amber-300 flex items-center gap-2">
                <RefreshCw className="h-4 w-4 text-amber-400" /> Changes Requested
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-white font-mono">
                  {formatUsdcAmount(currentMilestone.amount)} USDC
                </span>
                <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-300">
                  v{currentMilestone.version}
                </Badge>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs pt-1">
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Requested At</div>
                <div className="font-semibold text-white">{formatTimestamp(currentMilestone.revisionRequestedAt ?? 0n)}</div>
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Proposed Deadline</div>
                <div className="font-semibold text-amber-300">{formatTimestamp(currentMilestone.proposedRevisionDeadline ?? 0n)}</div>
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Response Window Ends</div>
                <div className="font-semibold text-white">
                  {formatTimestamp((currentMilestone.revisionRequestedAt ?? 0n) + REVISION_RESPONSE_WINDOW)}
                </div>
              </div>
            </div>

            {/* Canonical Revision Feedback Details (Participant Review) */}
            {isParticipant ? (
              revisionRecord ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 space-y-3">
                  <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                    <span className="text-[11px] font-semibold text-zinc-300 flex items-center gap-1.5">
                      <FileText className="h-3.5 w-3.5 text-amber-400" /> Canonical Revision Request
                    </span>
                    <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300">
                      Cryptographically Verified
                    </Badge>
                  </div>

                  <div className="space-y-1">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Requested Changes</div>
                    <div className="rounded-md bg-zinc-950/70 p-2.5 text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed border border-zinc-800/80">
                      {revisionRecord.revision?.feedback || revisionRecord.manifest?.feedback}
                    </div>
                  </div>
                </div>
              ) : loadingRevisionRecord ? (
                <div className="rounded-lg border border-zinc-800 p-3 text-center text-xs text-zinc-400 flex items-center justify-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
                  Retrieving revision feedback…
                </div>
              ) : revisionRecordError ? (
                <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 p-3 text-xs text-amber-300 flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                    <span>Revision details are temporarily unavailable or could not be verified.</span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={loadRevisionRecord}
                    className="h-6 text-[11px] border-amber-500/40 text-amber-300 hover:bg-amber-900/40 shrink-0 ml-2"
                  >
                    Retry
                  </Button>
                </div>
              ) : null
            ) : null}

            {/* Original Evidence Root Hash Commitment */}
            <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-2.5 flex items-center justify-between text-xs font-mono">
              <div className="flex items-center gap-2 overflow-hidden">
                <span className="text-[10px] uppercase text-zinc-400 font-sans font-semibold shrink-0">Original Evidence Hash:</span>
                <span className="text-zinc-200 truncate">{currentMilestone.evidenceRootHash}</span>
              </div>
              <button
                type="button"
                onClick={() => copyEvidenceHash(currentMilestone.evidenceRootHash)}
                className="text-zinc-400 hover:text-white shrink-0 ml-2"
                title="Copy Original Evidence Hash"
              >
                {copiedEvidence ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>

            {/* Participant Status & Response Actions */}
            {isFreelancer ? (
              <div className="space-y-3 pt-2">
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-300 space-y-1">
                  <div className="font-semibold text-white flex items-center gap-1.5">
                    <RefreshCw className="h-3.5 w-3.5 text-amber-400" /> Action Required: Respond to Revision Request
                  </div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    The client has proposed a revised work deadline of {formatTimestamp(currentMilestone.proposedRevisionDeadline ?? 0n)}. Accepting confirms this new deadline and returns the milestone to active work so you can submit your updated deliverable. Declining will escalate this milestone directly to Dispute.
                  </p>
                </div>

                {freelancerResponseEligibility.isDeadlineExpired && (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 p-2.5 text-xs text-amber-300 flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold">Proposed Revision Deadline Expired</div>
                      <div className="text-[11px] text-amber-200/80">
                        The proposed deadline has already passed on-chain. This request can no longer be accepted, but you may decline to open dispute.
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {freelancerResponseEligibility.canAccept && (
                    <Button
                      size="sm"
                      className="h-8 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
                      disabled={actionInProgress || chainId !== SEPOLIA_CHAIN_ID || txConfirmedPendingRefresh}
                      onClick={handleAcceptRevision}
                    >
                      {actionInProgress ? (
                        <>
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Accepting…
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Accept Changes
                        </>
                      )}
                    </Button>
                  )}

                  {freelancerResponseEligibility.canDecline && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs border-rose-500/40 text-rose-300 hover:bg-rose-950/40 font-medium"
                      disabled={actionInProgress || chainId !== SEPOLIA_CHAIN_ID || txConfirmedPendingRefresh}
                      onClick={handleDeclineRevision}
                    >
                      {actionInProgress ? (
                        <>
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Declining…
                        </>
                      ) : (
                        <>
                          <AlertCircle className="mr-1.5 h-3.5 w-3.5" /> Decline & Dispute
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            ) : isClient ? (
              <div className="space-y-3 pt-2">
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-300 space-y-1">
                  <div className="font-semibold text-white flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-amber-400" /> Waiting for Freelancer Response
                  </div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    You have requested changes for Milestone {currentIndex + 1}. The freelancer has 48 hours to accept or decline before timeout eligibility. Escrow funds remain safely locked in the Deal clone.
                  </p>
                </div>
              </div>
            ) : null}

            {/* Permissionless Revision Timeout */}
            {revisionTimeoutEligibility.isExpired && revisionTimeoutEligibility.canTimeout && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 p-3 text-xs text-amber-300 space-y-2 mt-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">Revision Response Period Expired</div>
                    <div className="text-[11px] text-amber-200/80">
                      The freelancer did not respond within the 48-hour revision response window. Any participant may execute timeout settlement to move this milestone into dispute. It does not release escrow.
                    </div>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs border-amber-500/40 text-amber-300 hover:bg-amber-950/40 font-medium"
                  disabled={actionInProgress || chainId !== SEPOLIA_CHAIN_ID || txConfirmedPendingRefresh}
                  onClick={handleTimeoutRevisionResponse}
                >
                  {actionInProgress ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Moving to Dispute…
                    </>
                  ) : (
                    <>
                      <Clock className="mr-1.5 h-3.5 w-3.5" /> Move to Dispute
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        ) : null}

        {/* DISPUTE & MUTUAL SETTLEMENT (Phase 3L-C) */}
        <V2MilestoneDispute
          dealData={dealData}
          currentIndex={currentIndex}
          refetchDealData={refetchDealData}
        />

        {/* Transaction Explorer Link */}
        {lastTxHash && (
          <div className="text-right">
            <a
              href={getSepoliaExplorerUrl('tx', lastTxHash)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-purple-400 hover:underline"
            >
              View Recent Transaction <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}
      </CardContent>

      {/* Request Changes Modal */}
      {showRequestChangesModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="space-y-0.5">
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <RefreshCw className="h-4 w-4 text-amber-400" /> Request Changes
                </h3>
                <p className="text-xs text-zinc-400">
                  Milestone {currentIndex + 1} • {formatUsdcAmount(currentMilestone.amount)} USDC • v{currentMilestone.version}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowRequestChangesModal(false);
                  setStagingRevisionError(null);
                }}
                className="text-zinc-400 hover:text-white"
                disabled={stagingRevisionInProgress}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-1.5 text-xs text-zinc-300">
              <div className="font-semibold text-white">How Revision Works</div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                The freelancer must accept this revision request before revision work begins. If they decline or do not respond within the protocol response window (48 hours), the milestone can enter dispute.
              </p>
              <div className="font-mono text-[11px] text-zinc-500 truncate pt-1">
                Current Deliverable Hash: {currentMilestone.evidenceRootHash}
              </div>
            </div>

            {stagingRevisionError && (
              <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-2.5 text-xs text-red-300 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                <span>{stagingRevisionError}</span>
              </div>
            )}

            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label className="font-semibold text-zinc-300">
                    Feedback / Required Changes <span className="text-red-400">*</span>
                  </label>
                  <span className="text-[10px] text-zinc-500">
                    {revisionFeedback.length} / 4000
                  </span>
                </div>
                <textarea
                  value={revisionFeedback}
                  onChange={(e) => setRevisionFeedback(e.target.value.slice(0, 4000))}
                  placeholder="Detail the specific corrections, additions, or adjustments required before deliverable approval…"
                  rows={4}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-2.5 text-xs text-white placeholder-zinc-500 focus:border-amber-500 focus:outline-none leading-relaxed"
                  disabled={stagingRevisionInProgress}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-zinc-300">
                  New Proposed Revision Deadline <span className="text-red-400">*</span>
                </label>
                <input
                  type="datetime-local"
                  value={revisionProposedDeadlineInput}
                  onChange={(e) => setRevisionProposedDeadlineInput(e.target.value)}
                  min={new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 16)}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-white focus:border-amber-500 focus:outline-none"
                  disabled={stagingRevisionInProgress}
                />
                <p className="text-[10px] text-zinc-500">
                  Must be strictly in the future (up to 365 days). Activates once the freelancer accepts.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowRequestChangesModal(false);
                  setStagingRevisionError(null);
                }}
                disabled={stagingRevisionInProgress}
                className="h-8 text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-900"
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleStageAndRequestChanges}
                disabled={
                  stagingRevisionInProgress ||
                  !revisionFeedback.trim() ||
                  !revisionProposedDeadlineInput
                }
                className="h-8 text-xs bg-amber-600 hover:bg-amber-500 text-white font-medium"
              >
                {stagingRevisionInProgress ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Staging & Requesting…
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Stage & Request Changes
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
