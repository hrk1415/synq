'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAccount, useWriteContract } from 'wagmi';
import {
  ShieldCheck,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Loader2,
  Send,
  X,
  Plus,
  Trash2,
  Link2,
  Copy,
  Check,
  Info,
  Coins,
  Sparkles,
  RefreshCw,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { shortenAddress, cn } from '@/lib/utils';
import { SEPOLIA_CHAIN_ID, SYNQ_V2_SEPOLIA_CONFIG, getSynqPremiumConfig } from '@/lib/contracts/addresses';
import {
  CANONICAL_PROTECTION_MANAGER_V1_1_SEPOLIA,
  CANONICAL_PROTECTION_POOL_SEPOLIA,
} from '@/lib/deals/v2-protection-committee';
import { synqProtectionPoolABI } from '@/lib/contracts/abis';
import { getSepoliaExplorerUrl, sepoliaPublicClient } from '@/lib/chain';
import { useSepoliaNetwork, isRejected } from '@/hooks/useSepoliaNetwork';
import { useAuthSession } from '@/hooks/useAuthSession';
import {
  MilestoneStatus,
  StandardV2DealData,
} from '@/lib/deals/v2-deal';
import { formatUsdcAmount } from '@/lib/deals/v2';
import {
  PremiumPolicyState,
  DEFAULT_COVERAGE_RATE_BPS,
  BPS_DENOMINATOR,
} from '@/lib/deals/v2-protection';
import {
  determineProtectionClaimEligibility,
  synqProtectionClaimManagerABI,
  verifyClaimPaidReceipt,
  type VerifiedClaimPaidReceipt,
  type ClaimFailureReason,
  CLAIM_FAILURE_REASONS,
  CLAIM_LIMITS,
} from '@/lib/deals/v2-protection-claim';
import { getAddress, isAddress } from 'viem';

interface V2MilestoneClaimProps {
  dealData: StandardV2DealData;
  milestoneIndex: number;
  policy: PremiumPolicyState | null;
  loadingPolicy?: boolean;
  refetchDealData: () => Promise<void>;
}

interface EditableClaimLink {
  id: string;
  type: 'web' | 'pr' | 'commit' | 'repository';
  value: string;
  label: string;
}

export interface OnChainClaimState {
  status: number; // 0 = None, 1 = Submitted, 2 = Approved, 3 = Rejected, 4 = Paid
  milestoneId: number;
  milestoneAmount: bigint;
  evidenceHash: `0x${string}`;
  decisionReportHash: `0x${string}`;
  submittedAt: bigint;
  resolvedAt: bigint;
  payout: bigint;
}

export function V2MilestoneClaim({
  dealData,
  milestoneIndex,
  policy,
  loadingPolicy,
  refetchDealData,
}: V2MilestoneClaimProps) {
  const { address } = useAccount();
  const { ensureSepolia } = useSepoliaNetwork();
  const { writeContractAsync } = useWriteContract();
  const { ensureAuthenticated, getToken } = useAuthSession();

  const currentMilestone = dealData.milestones[milestoneIndex];
  const isClient = Boolean(address && address.toLowerCase() === dealData.client.toLowerCase());

  // Local state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [onChainClaim, setOnChainClaim] = useState<OnChainClaimState | null>(null);
  const [storedClaimRow, setStoredClaimRow] = useState<any | null>(null);
  const [isLoadingClaim, setIsLoadingClaim] = useState(true);

  // Form state
  const [failureReason, setFailureReason] = useState<ClaimFailureReason>('missed_deadline');
  const [explanation, setExplanation] = useState('');
  const [links, setLinks] = useState<EditableClaimLink[]>([]);
  const [copiedHash, setCopiedHash] = useState(false);

  // Submission state
  const [submitStage, setSubmitStage] = useState<'idle' | 'staging' | 'wallet' | 'confirming' | 'reconciling' | 'success'>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);
  const [recoveryTxHash, setRecoveryTxHash] = useState('');

  const managerAddress =
    getSynqPremiumConfig().manager ||
    SYNQ_V2_SEPOLIA_CONFIG.premiumProtectionManagerV1_1 ||
    CANONICAL_PROTECTION_MANAGER_V1_1_SEPOLIA;

  const poolAddress =
    getSynqPremiumConfig().pool ||
    CANONICAL_PROTECTION_POOL_SEPOLIA;

  // Payout & Pool State (Phase 3E)
  const [poolAvailableBalance, setPoolAvailableBalance] = useState<bigint | null>(null);
  const [isLoadingPool, setIsLoadingPool] = useState(false);
  const [poolError, setPoolError] = useState<string | null>(null);

  const [payoutStage, setPayoutStage] = useState<
    'idle' | 'checking' | 'wallet' | 'confirming' | 'verifying' | 'success' | 'uncertain'
  >('idle');
  const [payoutError, setPayoutError] = useState<string | null>(null);
  const [payoutTxHash, setPayoutTxHash] = useState<string | null>(null);
  const [verifiedPayout, setVerifiedPayout] = useState<VerifiedClaimPaidReceipt | null>(null);
  const [isCheckingOnChain, setIsCheckingOnChain] = useState<boolean>(false);
  const [checkOnChainMessage, setCheckOnChainMessage] = useState<string | null>(null);
  const [isTroubleshootingOpen, setIsTroubleshootingOpen] = useState(false);
  const [manualRecoveryHash, setManualRecoveryHash] = useState('');

  // Fetch pool available balance dynamically from deployed contract
  const fetchPoolBalance = useCallback(async () => {
    if (!poolAddress || !isAddress(poolAddress)) return;
    setIsLoadingPool(true);
    setPoolError(null);
    try {
      const balance = (await sepoliaPublicClient.readContract({
        address: getAddress(poolAddress),
        abi: synqProtectionPoolABI,
        functionName: 'availableBalance',
      })) as bigint;
      setPoolAvailableBalance(BigInt(balance));
    } catch (err: any) {
      console.warn('[V2MilestoneClaim] Error loading pool available balance:', err);
      setPoolError('Failed to read pool balance from on-chain contract');
      setPoolAvailableBalance(null);
    } finally {
      setIsLoadingPool(false);
    }
  }, [poolAddress]);

  // Bounded chunked lookup for ClaimPaid event log to retrieve disbursement transaction hash
  const lookupClaimPaidLog = useCallback(async () => {
    if (!managerAddress || !isAddress(managerAddress) || !dealData.dealAddress) return;
    try {
      const currentBlock = await sepoliaPublicClient.getBlockNumber();
      const CHUNK_SIZE = 8000n;
      const MAX_LOOKBACK = 48000n;
      const minBlock = currentBlock > MAX_LOOKBACK ? currentBlock - MAX_LOOKBACK : 0n;
      let currentTo = currentBlock;
      let foundHash: `0x${string}` | null = null;

      while (currentTo >= minBlock) {
        const currentFrom =
          currentTo >= CHUNK_SIZE && currentTo - CHUNK_SIZE + 1n >= minBlock
            ? currentTo - CHUNK_SIZE + 1n
            : minBlock;

        try {
          const logs = await sepoliaPublicClient.getLogs({
            address: getAddress(managerAddress),
            event: {
              anonymous: false,
              inputs: [
                { indexed: true, name: 'deal', type: 'address' },
                { indexed: true, name: 'milestoneId', type: 'uint256' },
                { indexed: true, name: 'recipient', type: 'address' },
                { indexed: false, name: 'payoutAmount', type: 'uint256' },
              ],
              name: 'ClaimPaid',
              type: 'event',
            },
            args: {
              deal: getAddress(dealData.dealAddress),
              milestoneId: BigInt(milestoneIndex),
            },
            fromBlock: currentFrom,
            toBlock: currentTo,
          });

          if (logs && logs.length > 0) {
            foundHash = logs[logs.length - 1].transactionHash;
            break;
          }
        } catch (chunkErr) {
          console.warn('[V2MilestoneClaim] Chunk lookup error for ClaimPaid log:', chunkErr);
        }

        if (currentFrom <= minBlock) break;
        currentTo = currentFrom - 1n;
      }

      if (foundHash) {
        setPayoutTxHash(foundHash);
      }
    } catch (err) {
      console.warn('[V2MilestoneClaim] Bounded lookup of ClaimPaid log:', err);
    }
  }, [managerAddress, dealData.dealAddress, milestoneIndex]);

  // 1. Fetch on-chain claim state & off-chain stored manifest
  const fetchClaimData = useCallback(async () => {
    if (!managerAddress || !isAddress(managerAddress) || !dealData.dealAddress) {
      setIsLoadingClaim(false);
      return;
    }

    setIsLoadingClaim(true);
    try {
      // On-chain check
      const rawClaim = (await sepoliaPublicClient.readContract({
        address: getAddress(managerAddress),
        abi: synqProtectionClaimManagerABI,
        functionName: 'getClaim',
        args: [getAddress(dealData.dealAddress), BigInt(milestoneIndex)],
      })) as {
        status: number;
        milestoneId: bigint | number;
        milestoneAmount: bigint;
        evidenceHash: `0x${string}`;
        decisionReportHash: `0x${string}`;
        submittedAt: bigint | number;
        resolvedAt: bigint | number;
        payout: bigint;
      };

      if (rawClaim && Number(rawClaim.status) > 0) {
        const claimStatus = Number(rawClaim.status);
        setOnChainClaim({
          status: claimStatus,
          milestoneId: Number(rawClaim.milestoneId),
          milestoneAmount: BigInt(rawClaim.milestoneAmount),
          evidenceHash: rawClaim.evidenceHash,
          decisionReportHash: rawClaim.decisionReportHash,
          submittedAt: BigInt(rawClaim.submittedAt),
          resolvedAt: BigInt(rawClaim.resolvedAt),
          payout: BigInt(rawClaim.payout),
        });

        // Trigger pool balance fetch if Approved
        if (claimStatus === 2) {
          fetchPoolBalance();
        } else if (claimStatus === 4) {
          lookupClaimPaidLog();
        }
      } else {
        setOnChainClaim(null);
      }

      // Off-chain check if authenticated
      const token = getToken();
      if (token) {
        try {
          const res = await fetch(
            `/api/deals/${dealData.dealAddress}/milestones/${milestoneIndex}/claims`,
            {
              headers: { Authorization: `Bearer ${token}` },
            }
          );
          if (res.ok) {
            const data = await res.json();
            if (data?.claim) {
              setStoredClaimRow(data.claim);
            }
          }
        } catch {
          // Off-chain read is non-blocking
        }
      }
    } catch (err) {
      console.warn('[V2MilestoneClaim] Error loading claim data:', err);
    } finally {
      setIsLoadingClaim(false);
    }
  }, [managerAddress, dealData.dealAddress, milestoneIndex, getToken, fetchPoolBalance, lookupClaimPaidLog]);

  useEffect(() => {
    fetchClaimData();
  }, [fetchClaimData]);

  // Eligibility evaluation
  const eligibility = useMemo(() => {
    if (!currentMilestone) return { eligible: false, reason: 'Milestone not found' };
    return determineProtectionClaimEligibility({
      dealState: dealData.state,
      milestoneStatus: currentMilestone.status,
      milestoneAmount: currentMilestone.amount,
      isClient,
      policy,
      milestoneIndex,
      existingClaimStatus: onChainClaim ? onChainClaim.status : 0,
    });
  }, [dealData.state, currentMilestone, isClient, policy, milestoneIndex, onChainClaim]);

  // Link helpers
  const handleAddLink = () => {
    if (links.length >= CLAIM_LIMITS.MAX_LINKS_COUNT) return;
    setLinks([
      ...links,
      {
        id: crypto.randomUUID(),
        type: 'web',
        value: '',
        label: '',
      },
    ]);
  };

  const handleRemoveLink = (id: string) => {
    setLinks(links.filter((l) => l.id !== id));
  };

  const handleUpdateLink = (id: string, field: keyof EditableClaimLink, val: string) => {
    setLinks(
      links.map((l) => (l.id === id ? { ...l, [field]: val } : l))
    );
  };

  // Submit Claim workflow
  const handleSubmitClaim = async () => {
    if (!address) {
      setSubmitError('Wallet not connected. Please connect your client wallet.');
      return;
    }

    const trimmedExplanation = explanation.trim();
    if (!trimmedExplanation) {
      setSubmitError('Please enter an explanation of the failure (minimum 1 character).');
      return;
    }

    if (trimmedExplanation.length > CLAIM_LIMITS.MAX_EXPLANATION_LENGTH) {
      setSubmitError(
        `Explanation exceeds maximum limit of ${CLAIM_LIMITS.MAX_EXPLANATION_LENGTH} characters.`
      );
      return;
    }

    if (!managerAddress || !isAddress(managerAddress)) {
      setSubmitError('Premium Protection Manager contract address is not configured.');
      return;
    }

    if (!dealData?.dealAddress || !isAddress(dealData.dealAddress)) {
      setSubmitError('Deal contract address is missing or invalid.');
      return;
    }

    setSubmitError(null);
    setSubmitStage('staging');

    try {
      // 1. Ensure authenticated session
      const token = await ensureAuthenticated();
      await ensureSepolia();

      // Format links payload
      const formattedLinks = links
        .filter((l) => l.value.trim().length > 0)
        .map((l) => ({
          url: l.value.trim(),
          label: l.label.trim() || undefined,
          type: l.type,
        }));

      // 2. Stage manifest on server
      const stageRes = await fetch(
        `/api/deals/${dealData.dealAddress}/milestones/${milestoneIndex}/claims`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            explanation: explanation.trim(),
            failureReason,
            links: formattedLinks,
          }),
        }
      );

      const stageData = await stageRes.json();
      if (!stageRes.ok || !stageData?.evidenceHash) {
        throw new Error(stageData?.error || 'Failed to stage claim evidence on server');
      }

      const evidenceHash = stageData.evidenceHash as `0x${string}`;

      // 3. Prompt wallet for on-chain submission
      setSubmitStage('wallet');
      const txHash = await writeContractAsync({
        address: getAddress(managerAddress),
        abi: synqProtectionClaimManagerABI,
        functionName: 'submitClaim',
        args: [getAddress(dealData.dealAddress), BigInt(milestoneIndex), evidenceHash],
        chainId: SEPOLIA_CHAIN_ID,
      });

      setLastTxHash(txHash);
      setSubmitStage('confirming');

      // 4. Wait for transaction receipt
      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        throw new Error('On-chain transaction reverted');
      }

      // 5. Reconcile with server
      setSubmitStage('reconciling');
      const reconcileRes = await fetch(
        `/api/deals/${dealData.dealAddress}/milestones/${milestoneIndex}/claims/reconcile`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ txHash }),
        }
      );

      if (!reconcileRes.ok) {
        const recData = await reconcileRes.json();
        console.warn('[V2MilestoneClaim] Reconciliation warning:', recData?.error);
      }

      setSubmitStage('success');
      await fetchClaimData();
      await refetchDealData();
    } catch (err: any) {
      console.error('[V2MilestoneClaim] Error submitting claim:', err);
      if (isRejected(err)) {
        setSubmitError('Transaction rejected by user in wallet');
      } else {
        setSubmitError(err?.message || 'Failed to submit protection claim');
      }
      setSubmitStage('idle');
    }
  };

  // Manual or automatic reconciliation recovery
  const handleManualReconcile = async () => {
    try {
      setSubmitStage('reconciling');
      setSubmitError(null);
      const token = await ensureAuthenticated();

      const payload = recoveryTxHash.trim() ? { txHash: recoveryTxHash.trim() } : {};

      const res = await fetch(
        `/api/deals/${dealData.dealAddress}/milestones/${milestoneIndex}/claims/reconcile`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        }
      );

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Reconciliation failed');
      }

      setSubmitStage('success');
      setRecoveryTxHash('');
      await fetchClaimData();
      await refetchDealData();
    } catch (err: any) {
      setSubmitError(err?.message || 'Reconciliation failed');
      setSubmitStage('idle');
    }
  };

  // Ambiguous submission error classifier for provider disconnects & timeouts
  const isAmbiguousSubmissionError = (err: any): boolean => {
    if (!err) return false;
    const msg = (err.message || '').toLowerCase();
    const code = err.code ?? err.cause?.code;
    if (code === 4900 || code === '4900') return true;
    if (
      msg.includes('disconnected from all chains') ||
      msg.includes('provider is disconnected') ||
      msg.includes('wallet disconnected') ||
      msg.includes('timeout') ||
      msg.includes('network error') ||
      msg.includes('failed to fetch') ||
      msg.includes('connection reset') ||
      msg.includes('could not coalesce error')
    ) {
      return true;
    }
    return false;
  };

  // Safe payout disbursement execution (Phase 3E)
  const handleDisbursePayout = async () => {
    if (!address) {
      setPayoutError('Wallet not connected. Please connect your client wallet.');
      return;
    }

    if (!isClient) {
      setPayoutError(`Only the protected deal client (${shortenAddress(dealData.client)}) is authorized to receive this payout.`);
      return;
    }

    if (!managerAddress || !isAddress(managerAddress)) {
      setPayoutError('Protection Manager contract address is not configured.');
      return;
    }

    if (!dealData?.dealAddress || !isAddress(dealData.dealAddress)) {
      setPayoutError('Invalid deal address.');
      return;
    }

    setPayoutStage('checking');
    setPayoutError(null);
    setCheckOnChainMessage(null);

    try {
      // 1. Verify Sepolia network
      await ensureSepolia();

      // 2. Preflight verification: verify claim is still Approved on-chain
      const freshClaim = (await sepoliaPublicClient.readContract({
        address: getAddress(managerAddress),
        abi: synqProtectionClaimManagerABI,
        functionName: 'getClaim',
        args: [getAddress(dealData.dealAddress), BigInt(milestoneIndex)],
      })) as { status: number; payout: bigint };

      if (Number(freshClaim.status) === 4) {
        // Already paid!
        setOnChainClaim((prev) => (prev ? { ...prev, status: 4 } : null));
        setPayoutStage('success');
        await lookupClaimPaidLog();
        await refetchDealData();
        return;
      }

      if (Number(freshClaim.status) !== 2) {
        throw new Error(`Claim is not in Approved status (current status: ${freshClaim.status}). Payout cannot be disbursed.`);
      }

      const payoutAmount = BigInt(freshClaim.payout);
      if (payoutAmount <= 0n) {
        throw new Error('Approved payout amount is zero. Cannot disburse claim.');
      }

      // 3. Preflight verification: verify pool liquidity
      const poolBal = (await sepoliaPublicClient.readContract({
        address: getAddress(poolAddress),
        abi: synqProtectionPoolABI,
        functionName: 'availableBalance',
      })) as bigint;

      setPoolAvailableBalance(poolBal);
      if (poolBal < payoutAmount) {
        throw new Error(
          `Insufficient pool liquidity: available ${formatUsdcAmount(poolBal)} USDC, required ${formatUsdcAmount(payoutAmount)} USDC.`
        );
      }

      // 4. Request wallet signature & broadcast
      setPayoutStage('wallet');
      const txHash = await writeContractAsync({
        address: getAddress(managerAddress),
        abi: synqProtectionClaimManagerABI,
        functionName: 'disburseClaim',
        args: [getAddress(dealData.dealAddress), BigInt(milestoneIndex)],
      });

      setPayoutTxHash(txHash);
      setPayoutStage('confirming');

      // 5. Wait for transaction receipt via stable public client
      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      });

      if (!receipt || receipt.status !== 'success') {
        throw new Error('Disbursement transaction failed or reverted on-chain.');
      }

      // 6. Verify payout state and events
      setPayoutStage('verifying');
      const postClaim = (await sepoliaPublicClient.readContract({
        address: getAddress(managerAddress),
        abi: synqProtectionClaimManagerABI,
        functionName: 'getClaim',
        args: [getAddress(dealData.dealAddress), BigInt(milestoneIndex)],
      })) as { status: number; payout: bigint };

      if (Number(postClaim.status) !== 4) {
        throw new Error('Transaction mined, but on-chain claim status was not updated to Paid.');
      }

      // Event verification
      try {
        const verified = verifyClaimPaidReceipt({
          receipt,
          expectedManagerAddress: managerAddress,
          expectedDealAddress: dealData.dealAddress,
          expectedMilestoneId: milestoneIndex,
          expectedRecipient: dealData.client,
          expectedPayoutAmount: payoutAmount,
          expectedPoolAddress: poolAddress,
          expectedUsdcAddress: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
        });
        setVerifiedPayout(verified);
      } catch (evErr: any) {
        console.warn('[V2MilestoneClaim] Non-fatal transfer verification warning:', evErr?.message);
      }

      // 7. Transition to Paid (status 4)
      setOnChainClaim((prev) => (prev ? { ...prev, status: 4, payout: payoutAmount } : null));
      setPayoutStage('success');
      await refetchDealData();
    } catch (err: any) {
      console.error('[V2MilestoneClaim] Payout execution error:', err);

      if (isRejected(err)) {
        setPayoutStage('idle');
        setPayoutError('Transaction was rejected in your wallet.');
        return;
      }

      if (isAmbiguousSubmissionError(err)) {
        setPayoutStage('uncertain');
        setPayoutError(
          'Wallet provider disconnected or response timed out. The transaction may have reached the network. Please check on-chain status before attempting to retry.'
        );
        return;
      }

      setPayoutStage('idle');
      setPayoutError(err?.message || 'Failed to disburse protection payout.');
    }
  };

  // Check on-chain payout status without resubmitting
  const handleCheckPayoutOnChainStatus = async () => {
    if (!managerAddress || !isAddress(managerAddress) || !dealData.dealAddress) return;
    setIsCheckingOnChain(true);
    setCheckOnChainMessage(null);
    try {
      const claim = (await sepoliaPublicClient.readContract({
        address: getAddress(managerAddress),
        abi: synqProtectionClaimManagerABI,
        functionName: 'getClaim',
        args: [getAddress(dealData.dealAddress), BigInt(milestoneIndex)],
      })) as { status: number; payout: bigint };

      if (Number(claim.status) === 4) {
        setOnChainClaim((prev) => (prev ? { ...prev, status: 4, payout: BigInt(claim.payout) } : null));
        setPayoutStage('success');
        setPayoutError(null);
        setCheckOnChainMessage('Confirmed on-chain: Protection payout has already been paid!');
        await lookupClaimPaidLog();
        await refetchDealData();
      } else if (Number(claim.status) === 2) {
        setCheckOnChainMessage(
          'On-chain claim is still in Approved status (not Paid). The broadcast was not mined or may still be pending in the mempool.'
        );
      } else {
        setCheckOnChainMessage(`On-chain claim is currently in status ${claim.status}.`);
      }
    } catch (err: any) {
      setCheckOnChainMessage(`Failed to read on-chain status: ${err?.message || 'RPC error'}`);
    } finally {
      setIsCheckingOnChain(false);
    }
  };

  // Verify manual transaction hash recovery
  const handleVerifyManualTxHash = async () => {
    const cleanHash = manualRecoveryHash.trim();
    if (!cleanHash || !/^0x[0-9a-fA-F]{64}$/.test(cleanHash)) {
      setPayoutError('Please enter a valid 32-byte transaction hash (0x...).');
      return;
    }
    setIsCheckingOnChain(true);
    setPayoutError(null);
    try {
      const receipt = await sepoliaPublicClient.getTransactionReceipt({
        hash: cleanHash as `0x${string}`,
      });
      if (!receipt || receipt.status !== 'success') {
        throw new Error('Transaction receipt not found or status was not success.');
      }
      const verified = verifyClaimPaidReceipt({
        receipt,
        expectedManagerAddress: managerAddress,
        expectedDealAddress: dealData.dealAddress,
        expectedMilestoneId: milestoneIndex,
        expectedRecipient: dealData.client,
        expectedPayoutAmount: onChainClaim ? onChainClaim.payout : 0n,
        expectedPoolAddress: poolAddress,
        expectedUsdcAddress: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      });
      setVerifiedPayout(verified);
      setPayoutTxHash(cleanHash);
      setOnChainClaim((prev) => (prev ? { ...prev, status: 4 } : null));
      setPayoutStage('success');
      setCheckOnChainMessage('Disbursement successfully verified on-chain!');
      await refetchDealData();
    } catch (err: any) {
      setPayoutError(err?.message || 'Manual transaction verification failed.');
    } finally {
      setIsCheckingOnChain(false);
    }
  };

  // Reset ambiguous payout state for retry
  const handleResetPayoutForRetry = () => {
    setPayoutStage('idle');
    setPayoutError(null);
    setCheckOnChainMessage(null);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedHash(true);
    setTimeout(() => setCopiedHash(false), 2000);
  };

  if (isLoadingClaim || loadingPolicy) {
    return (
      <div className="flex items-center gap-2 p-3 text-xs text-zinc-400 bg-zinc-900/40 rounded-lg border border-zinc-800">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-400" />
        Checking protection claim status...
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // A. Existing Claim Display (Status 1..4)
  // ---------------------------------------------------------------------------
  if (onChainClaim && onChainClaim.status > 0) {
    const statusMap: Record<number, { label: string; badgeClass: string }> = {
      1: {
        label: 'Awaiting Protection Committee Review',
        badgeClass: 'bg-purple-500/10 text-purple-300 border-purple-500/30',
      },
      2: {
        label: 'Claim Approved — Pool Payout Pending',
        badgeClass: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
      },
      3: {
        label: 'Claim Rejected by Committee',
        badgeClass: 'bg-red-500/10 text-red-300 border-red-500/30',
      },
      4: {
        label: 'Claim Paid from Protection Pool',
        badgeClass: 'bg-green-500/10 text-green-300 border-green-500/30',
      },
    };

    const currentStatus = statusMap[onChainClaim.status] || {
      label: 'Claim Submitted',
      badgeClass: 'bg-purple-500/10 text-purple-300 border-purple-500/30',
    };

    return (
      <Card className="bg-[#18181b]/80 border-purple-900/30 shadow-md">
        <CardHeader className="pb-3 pt-4 px-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-purple-400" />
              <CardTitle className="text-sm font-semibold text-white">
                Premium Protection Claim (Milestone #{milestoneIndex + 1})
              </CardTitle>
            </div>
            <Badge variant="outline" className={cn('text-xs font-medium', currentStatus.badgeClass)}>
              {currentStatus.label}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-3 text-xs">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3 bg-zinc-950/60 rounded-md border border-zinc-800/80">
            <div>
              <span className="text-zinc-500 block">Milestone Principal</span>
              <span className="text-zinc-200 font-mono font-medium">
                ${formatUsdcAmount(onChainClaim.milestoneAmount)} USDC
              </span>
            </div>
            <div>
              <span className="text-zinc-500 block">
                {onChainClaim.status >= 2 ? 'Determined Payout' : 'Max Pool Recovery (20%)'}
              </span>
              <span className="text-purple-300 font-mono font-medium">
                ${formatUsdcAmount(
                  onChainClaim.payout > 0n
                    ? onChainClaim.payout
                    : (onChainClaim.milestoneAmount * DEFAULT_COVERAGE_RATE_BPS) / BPS_DENOMINATOR
                )} USDC
              </span>
            </div>
            <div>
              <span className="text-zinc-500 block">Submitted At</span>
              <span className="text-zinc-300">
                {onChainClaim.submittedAt > 0n
                  ? new Date(Number(onChainClaim.submittedAt) * 1000).toLocaleDateString()
                  : 'Confirmed'}
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between p-2.5 bg-zinc-900/60 rounded border border-zinc-800 text-[11px]">
            <span className="text-zinc-400">On-Chain Evidence Hash:</span>
            <div className="flex items-center gap-1.5 font-mono text-zinc-300">
              <span>{shortenAddress(onChainClaim.evidenceHash)}</span>
              <button
                type="button"
                onClick={() => copyToClipboard(onChainClaim.evidenceHash)}
                className="text-zinc-400 hover:text-white p-0.5"
                title="Copy Evidence Hash"
              >
                {copiedHash ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {storedClaimRow?.canonicalManifest?.explanation && (
            <div className="p-3 bg-zinc-900/40 rounded border border-zinc-800/60">
              <span className="text-zinc-400 font-medium block mb-1">Claim Explanation:</span>
              <p className="text-zinc-300 text-xs whitespace-pre-wrap leading-relaxed">
                {storedClaimRow.canonicalManifest.explanation}
              </p>
            </div>
          )}

          {storedClaimRow && storedClaimRow.status === 'staged' && (
            <div className="p-3 bg-amber-950/20 border border-amber-800/30 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="space-y-0.5">
                <span className="text-amber-300 font-medium block text-xs">
                  Evidence Synchronization Pending
                </span>
                <span className="text-zinc-400 text-[11px] block leading-relaxed">
                  Your claim is confirmed on-chain, but the local audit record is staged. Click to synchronize without resubmitting.
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={handleManualReconcile}
                disabled={submitStage === 'reconciling'}
                className="text-xs border-amber-500/40 text-amber-300 hover:bg-amber-900/30 h-7 shrink-0"
              >
                {submitStage === 'reconciling' ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin mr-1" />
                    Syncing…
                  </>
                ) : (
                  'Sync Record'
                )}
              </Button>
            </div>
          )}

          {/* ----------------------------------------------------------------- */}
          {/* Approved Payout Disbursement Action (Phase 3E)                    */}
          {/* ----------------------------------------------------------------- */}
          {onChainClaim.status === 2 && (
            <div className="mt-3 p-3.5 bg-gradient-to-r from-emerald-950/30 via-zinc-900/50 to-zinc-900/80 rounded-lg border border-emerald-500/30 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-emerald-900/30">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="text-xs font-semibold text-white">
                    Approved Recovery Payout Ready
                  </span>
                </div>
                <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/40 text-[10px] self-start sm:self-auto font-mono">
                  ${formatUsdcAmount(onChainClaim.payout)} USDC Approved
                </Badge>
              </div>

              {/* Accounting & Destination Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                <div className="p-2.5 bg-zinc-950/60 rounded border border-zinc-800/80">
                  <span className="text-zinc-500 block">Protected Destination Wallet:</span>
                  <span className="text-zinc-200 font-mono font-medium block truncate" title={dealData.client}>
                    {dealData.client}
                  </span>
                  <span className="text-zinc-500 text-[10px] block mt-0.5">
                    * Payout recipient is immutably enforced by the smart contract
                  </span>
                </div>

                <div className="p-2.5 bg-zinc-950/60 rounded border border-zinc-800/80">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">Protection Pool Liquidity:</span>
                    {isLoadingPool ? (
                      <span className="flex items-center gap-1 text-zinc-400 text-[10px]">
                        <Loader2 className="w-2.5 h-2.5 animate-spin text-emerald-400" />
                        Verifying…
                      </span>
                    ) : poolAvailableBalance !== null ? (
                      <span
                        className={cn(
                          'text-[10px] font-medium px-1.5 py-0.5 rounded',
                          poolAvailableBalance >= onChainClaim.payout
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            : 'bg-red-500/10 text-red-400 border border-red-500/20'
                        )}
                      >
                        {poolAvailableBalance >= onChainClaim.payout ? 'Sufficient Liquidity' : 'Insufficient Liquidity'}
                      </span>
                    ) : (
                      <span className="text-red-400 text-[10px]">Read Error</span>
                    )}
                  </div>
                  <span className="text-zinc-200 font-mono font-medium block mt-0.5">
                    {isLoadingPool
                      ? 'Checking on-chain reserve…'
                      : poolAvailableBalance !== null
                      ? `$${formatUsdcAmount(poolAvailableBalance)} USDC Available`
                      : poolError || 'Unavailable'}
                  </span>
                </div>
              </div>

              {/* Action Section */}
              <div className="pt-1 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
                {isClient ? (
                  <>
                    <p className="text-[11px] text-zinc-400 leading-relaxed">
                      As the protected deal client, you can execute disbursement to receive the 20% pool recovery payout.
                    </p>
                    <Button
                      size="sm"
                      onClick={handleDisbursePayout}
                      disabled={
                        payoutStage === 'checking' ||
                        payoutStage === 'wallet' ||
                        payoutStage === 'confirming' ||
                        payoutStage === 'verifying' ||
                        isLoadingPool ||
                        poolAvailableBalance === null ||
                        poolAvailableBalance < onChainClaim.payout
                      }
                      className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium shrink-0 shadow-sm gap-1.5 h-8 px-4"
                    >
                      {payoutStage === 'checking' && (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Verifying On-Chain…
                        </>
                      )}
                      {payoutStage === 'wallet' && (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Confirm in Wallet…
                        </>
                      )}
                      {payoutStage === 'confirming' && (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Confirming Payout…
                        </>
                      )}
                      {payoutStage === 'verifying' && (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Verifying Transfer…
                        </>
                      )}
                      {payoutStage !== 'checking' &&
                        payoutStage !== 'wallet' &&
                        payoutStage !== 'confirming' &&
                        payoutStage !== 'verifying' && (
                          <>
                            <Coins className="w-3.5 h-3.5" />
                            Receive Protection Payout
                          </>
                        )}
                    </Button>
                  </>
                ) : (
                  <div className="p-2 bg-zinc-900/60 rounded border border-zinc-800 text-[11px] text-zinc-400 w-full flex items-center gap-2">
                    <Info className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                    <span>
                      Protected client wallet (<span className="font-mono text-zinc-300">{shortenAddress(dealData.client)}</span>) is authorized to trigger and receive this payout.
                    </span>
                  </div>
                )}
              </div>

              {/* Ambiguous Error & Provider Disconnect Recovery Panel */}
              {(payoutStage === 'uncertain' || payoutError) && (
                <div className="p-3 bg-amber-950/20 border border-amber-800/40 rounded-lg space-y-2 mt-2">
                  <div className="flex items-start gap-2 text-amber-300 text-xs font-medium">
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <div className="space-y-0.5">
                      <span>Transaction Status Uncertainty</span>
                      <p className="text-zinc-300 text-[11px] font-normal leading-relaxed">
                        {payoutError || 'The wallet provider reported a disconnection or timeout. The transaction may have already executed on-chain.'}
                      </p>
                    </div>
                  </div>

                  {checkOnChainMessage && (
                    <div className="p-2 bg-zinc-900/80 rounded border border-zinc-800 text-[11px] text-zinc-300 font-mono">
                      {checkOnChainMessage}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleCheckPayoutOnChainStatus}
                      disabled={isCheckingOnChain}
                      className="border-amber-500/40 text-amber-300 hover:bg-amber-900/30 text-xs h-7"
                    >
                      {isCheckingOnChain ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin mr-1" />
                          Checking On-Chain…
                        </>
                      ) : (
                        <>
                          <RefreshCw className="w-3 h-3 mr-1" />
                          Check On-Chain Status
                        </>
                      )}
                    </Button>

                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={handleResetPayoutForRetry}
                      className="text-zinc-400 hover:text-white text-xs h-7"
                    >
                      Reset to Retry Payout
                    </Button>

                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setIsTroubleshootingOpen(!isTroubleshootingOpen)}
                      className="text-zinc-500 hover:text-zinc-300 text-[10px] h-7 ml-auto"
                    >
                      Troubleshooting {isTroubleshootingOpen ? <ChevronUp className="w-3 h-3 ml-0.5" /> : <ChevronDown className="w-3 h-3 ml-0.5" />}
                    </Button>
                  </div>

                  {isTroubleshootingOpen && (
                    <div className="pt-2 border-t border-amber-900/30 space-y-2 text-[11px]">
                      <p className="text-zinc-400">
                        If your wallet broadcasted a transaction hash before disconnecting, paste it below to verify on-chain:
                      </p>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={manualRecoveryHash}
                          onChange={(e) => setManualRecoveryHash(e.target.value)}
                          placeholder="0x..."
                          className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:ring-1 focus:ring-amber-500"
                        />
                        <Button
                          size="sm"
                          onClick={handleVerifyManualTxHash}
                          disabled={isCheckingOnChain || !manualRecoveryHash.trim()}
                          className="bg-zinc-800 hover:bg-zinc-700 text-xs h-7 shrink-0"
                        >
                          Verify Hash
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ----------------------------------------------------------------- */}
          {/* Claim Paid State Display (Phase 3E)                                */}
          {/* ----------------------------------------------------------------- */}
          {onChainClaim.status === 4 && (
            <div className="mt-3 p-3.5 bg-gradient-to-r from-emerald-950/40 via-zinc-900/60 to-zinc-900/90 rounded-lg border border-emerald-500/40 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="text-xs font-semibold text-white">
                    Protection Payout Completed
                  </span>
                </div>
                <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/40 text-[10px] font-mono">
                  ${formatUsdcAmount(onChainClaim.payout)} USDC Paid
                </Badge>
              </div>

              <p className="text-xs text-zinc-300 leading-relaxed">
                A recovery payout of <span className="font-semibold text-emerald-300">${formatUsdcAmount(onChainClaim.payout)} USDC</span> has been disbursed directly from the Protection Pool to the client wallet (<span className="font-mono text-zinc-200">{shortenAddress(dealData.client)}</span>).
              </p>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-emerald-900/30 text-[11px]">
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400 bg-emerald-500/5">
                    {verifiedPayout?.usdcTransferVerified
                      ? 'USDC Transfer Verified on Sepolia'
                      : 'Paid On-Chain'}
                  </Badge>
                </div>

                {payoutTxHash && (
                  <a
                    href={getSepoliaExplorerUrl(payoutTxHash, 'tx')}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1 font-mono text-[11px] underline underline-offset-2"
                  >
                    <span>View on Sepolia Etherscan</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // ---------------------------------------------------------------------------
  // B. Ineligible State Display
  // ---------------------------------------------------------------------------
  if (!eligibility.eligible) {
    // Only show if the deal actually selected protection or milestone is refunded
    const isRefunded = currentMilestone?.status === MilestoneStatus.SettledRefunded;
    const isSplit = currentMilestone?.status === MilestoneStatus.SettledSplit;
    const hasProtection = policy && (policy.active || policy.purchasedAt > 0n);

    if (!hasProtection && !isRefunded && !isSplit) {
      return null;
    }

    return (
      <div className="p-3 bg-zinc-900/30 rounded-lg border border-zinc-800/60 text-xs flex items-start gap-2.5">
        <Info className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
        <div>
          <span className="text-zinc-300 font-medium block">
            Premium Protection Status (Milestone #{milestoneIndex + 1}):
          </span>
          <span className="text-zinc-400 leading-relaxed">
            {eligibility.reason || 'This milestone is not eligible for protection claim submission.'}
          </span>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // C. Eligible State & Claim Submission Action
  // ---------------------------------------------------------------------------
  return (
    <>
      <Card className="bg-gradient-to-r from-purple-950/20 via-zinc-900/50 to-zinc-900/80 border-purple-500/30 shadow-md">
        <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-purple-400" />
              <span className="text-sm font-semibold text-white">
                Eligible for Premium Protection Recovery (Milestone #{milestoneIndex + 1})
              </span>
              <Badge className="bg-purple-600/20 text-purple-300 border-purple-500/40 text-[10px]">
                Up to ${formatUsdcAmount(eligibility.potentialPayout ?? 0n)} USDC
              </Badge>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              This milestone finalized as an expired refund. As a protected deal client, you can submit a failure claim to the Protection Committee for up to 20% recovery from the pool, subject to committee determination and available pool liquidity.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => setIsModalOpen(true)}
            className="bg-purple-600 hover:bg-purple-500 text-white font-medium shrink-0 shadow-sm gap-1.5"
          >
            <Send className="w-3.5 h-3.5" />
            File Protection Claim
          </Button>
        </CardContent>
      </Card>

      {/* Claim Submission Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-[#18181b] border border-zinc-700/80 rounded-xl shadow-2xl max-w-xl w-full max-h-[90vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-purple-400" />
                <h3 className="text-base font-semibold text-white">
                  Submit Protection Claim (Milestone #{milestoneIndex + 1})
                </h3>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (submitStage === 'idle' || submitStage === 'success') {
                    setIsModalOpen(false);
                  }
                }}
                disabled={submitStage !== 'idle' && submitStage !== 'success'}
                className="text-zinc-400 hover:text-white p-1 rounded-md"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-4 space-y-4 text-xs">
              {/* Coverage summary banner */}
              <div className="p-3 bg-purple-950/30 border border-purple-800/40 rounded-lg flex items-center justify-between">
                <div>
                  <span className="text-purple-300 font-semibold block text-xs">Eligible Milestone Principal:</span>
                  <span className="text-zinc-300 font-mono text-sm">${formatUsdcAmount(currentMilestone.amount)} USDC</span>
                </div>
                <div className="text-right">
                  <span className="text-purple-300 font-semibold block text-xs">Max Potential Recovery (20%):</span>
                  <span className="text-purple-400 font-mono text-sm font-bold">
                    ${formatUsdcAmount(eligibility.potentialPayout ?? 0n)} USDC
                  </span>
                </div>
              </div>

              {/* Failure reason selector */}
              <div className="space-y-1.5">
                <label className="text-zinc-300 font-medium block">
                  Failure Reason:
                </label>
                <select
                  value={failureReason}
                  onChange={(e) => setFailureReason(e.target.value as ClaimFailureReason)}
                  disabled={submitStage !== 'idle'}
                  className="w-full p-2 bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-200 text-xs focus:ring-1 focus:ring-purple-500 focus:outline-none"
                >
                  <option value="missed_deadline">Missed Deadline / Expired Delivery</option>
                  <option value="abandonment">Freelancer Abandonment</option>
                  <option value="unresponsive_freelancer">Unresponsive Freelancer</option>
                  <option value="other">Other Valid Contractual Failure</option>
                </select>
              </div>

              {/* Explanation textarea */}
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <label className="text-zinc-300 font-medium">
                    Failure Explanation <span className="text-red-400">*</span>:
                  </label>
                  <span className="text-zinc-500 text-[11px]">
                    {explanation.length} / {CLAIM_LIMITS.MAX_EXPLANATION_LENGTH}
                  </span>
                </div>
                <textarea
                  value={explanation}
                  onChange={(e) => setExplanation(e.target.value)}
                  placeholder="Provide a clear, factual explanation of the delivery failure or abandonment for the Protection Committee..."
                  rows={4}
                  maxLength={CLAIM_LIMITS.MAX_EXPLANATION_LENGTH}
                  disabled={submitStage !== 'idle'}
                  className="w-full p-2.5 bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-200 text-xs focus:ring-1 focus:ring-purple-500 focus:outline-none placeholder:text-zinc-600 leading-relaxed"
                />
              </div>

              {/* Evidence Links */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-zinc-300 font-medium">
                    Evidence Links (Optional, max 20):
                  </label>
                  {links.length < CLAIM_LIMITS.MAX_LINKS_COUNT && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleAddLink}
                      disabled={submitStage !== 'idle'}
                      className="text-xs text-purple-400 hover:text-purple-300 h-7 px-2 gap-1"
                    >
                      <Plus className="w-3.5 h-3.5" /> Add Link
                    </Button>
                  )}
                </div>

                {links.length === 0 ? (
                  <p className="text-[11px] text-zinc-500 italic">No links added. You can attach GitHub repositories, pull requests, commits, or chat logs.</p>
                ) : (
                  <div className="space-y-2">
                    {links.map((link) => (
                      <div key={link.id} className="flex items-center gap-2 bg-zinc-900/60 p-2 rounded-lg border border-zinc-800">
                        <select
                          value={link.type}
                          onChange={(e) => handleUpdateLink(link.id, 'type', e.target.value)}
                          disabled={submitStage !== 'idle'}
                          className="bg-zinc-800 text-zinc-200 text-[11px] p-1.5 rounded border border-zinc-700 shrink-0"
                        >
                          <option value="web">Web Link</option>
                          <option value="pr">Pull Request</option>
                          <option value="commit">Commit</option>
                          <option value="repository">Repository</option>
                        </select>
                        <input
                          type="text"
                          value={link.value}
                          onChange={(e) => handleUpdateLink(link.id, 'value', e.target.value)}
                          placeholder="https://..."
                          disabled={submitStage !== 'idle'}
                          className="flex-1 bg-zinc-800 text-zinc-200 text-[11px] p-1.5 rounded border border-zinc-700 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => handleRemoveLink(link.id)}
                          disabled={submitStage !== 'idle'}
                          className="text-zinc-500 hover:text-red-400 p-1"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Status & Error indicators */}
              {submitError && (
                <div className="p-3 bg-red-950/40 border border-red-800/60 rounded-lg flex items-start gap-2 text-red-300 text-xs">
                  <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                  <span className="leading-relaxed">{submitError}</span>
                </div>
              )}

              {submitStage === 'staging' && (
                <div className="p-3 bg-purple-950/30 border border-purple-800/40 rounded-lg flex items-center gap-2 text-purple-300 text-xs">
                  <Loader2 className="w-4 h-4 animate-spin text-purple-400 shrink-0" />
                  <span>Staging canonical manifest and generating cryptographic evidence hash...</span>
                </div>
              )}

              {submitStage === 'wallet' && (
                <div className="p-3 bg-amber-950/30 border border-amber-800/40 rounded-lg flex items-center gap-2 text-amber-300 text-xs">
                  <Loader2 className="w-4 h-4 animate-spin text-amber-400 shrink-0" />
                  <span>Please confirm the claim transaction in your wallet...</span>
                </div>
              )}

              {submitStage === 'confirming' && (
                <div className="p-3 bg-blue-950/30 border border-blue-800/40 rounded-lg flex items-center gap-2 text-blue-300 text-xs">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-400 shrink-0" />
                  <span>Waiting for Sepolia block confirmation...</span>
                </div>
              )}

              {submitStage === 'reconciling' && (
                <div className="p-3 bg-purple-950/30 border border-purple-800/40 rounded-lg flex items-center gap-2 text-purple-300 text-xs">
                  <Loader2 className="w-4 h-4 animate-spin text-purple-400 shrink-0" />
                  <span>Reconciling verified on-chain ClaimSubmitted event...</span>
                </div>
              )}

              {submitStage === 'success' && (
                <div className="p-3 bg-green-950/40 border border-green-800/60 rounded-lg flex items-center gap-2 text-green-300 text-xs">
                  <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                  <span>Claim successfully submitted and recorded on-chain! Awaiting committee review.</span>
                </div>
              )}

              {/* Recovery path for ambiguous tx */}
              {submitError && lastTxHash && (
                <div className="p-3 bg-zinc-900 border border-zinc-700 rounded-lg space-y-2">
                  <span className="text-zinc-300 font-medium block">Transaction Recovery:</span>
                  <p className="text-zinc-400 text-[11px]">
                    If your transaction confirmed on-chain but reconciliation was interrupted, submit the transaction hash below:
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={recoveryTxHash || lastTxHash}
                      onChange={(e) => setRecoveryTxHash(e.target.value)}
                      placeholder="0x..."
                      className="flex-1 bg-zinc-800 text-zinc-200 text-xs p-1.5 rounded border border-zinc-700 font-mono"
                    />
                    <Button
                      size="sm"
                      onClick={handleManualReconcile}
                      className="bg-purple-600 hover:bg-purple-500 text-white text-xs"
                    >
                      Reconcile
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-2 p-4 border-t border-zinc-800 bg-zinc-950/40">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsModalOpen(false)}
                disabled={submitStage !== 'idle' && submitStage !== 'success'}
                className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
              >
                {submitStage === 'success' ? 'Close' : 'Cancel'}
              </Button>
              {submitStage !== 'success' && (
                <Button
                  size="sm"
                  onClick={handleSubmitClaim}
                  disabled={!explanation.trim() || submitStage !== 'idle'}
                  className="bg-purple-600 hover:bg-purple-500 text-white font-medium gap-1.5"
                >
                  {submitStage !== 'idle' ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <Send className="w-3.5 h-3.5" />
                      Confirm & Submit Claim
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
