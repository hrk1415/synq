'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useAccount, useWriteContract } from 'wagmi';
import {
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  ExternalLink,
  Coins,
  ArrowRight,
  RefreshCw,
  Lock,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { shortenAddress, cn } from '@/lib/utils';
import { SYNQ_V2_SEPOLIA_CONFIG, SEPOLIA_CHAIN_ID, getSynqPremiumConfig, isPremiumProtectionConfigured } from '@/lib/contracts/addresses';
import { synqDealV1ABI, erc20ABI, synqPremiumProtectionManagerABI, synqPremiumProtectionManagerV1_1ABI } from '@/lib/contracts/abis';
import { getSepoliaExplorerUrl, sepoliaPublicClient } from '@/lib/chain';
import { useSepoliaNetwork, isRejected } from '@/hooks/useSepoliaNetwork';
import { useAuthSession } from '@/hooks/useAuthSession';
import {
  DealState,
  DEAL_STATE_LABELS,
  StandardV2DealData,
  determineFundingEligibility,
  validateApprovalPreflight,
  validateFundingPreflight,
  verifyFundingReceipt,
  readClientUsdcFundingState,
  isSynqV2Deal,
} from '@/lib/deals/v2-deal';
import { formatUsdcAmount } from '@/lib/deals/v2';
import {
  PremiumPolicyState,
  PremiumManagerParameters,
  PremiumManagerVersion,
  MAX_PROTECTED_MILESTONES,
  calculatePremiumFee,
  calculateMaximumCoverage,
  calculateEligibleMilestones,
  detectPremiumManagerVersion,
  readPremiumManagerParameters,
  readDealPremiumPolicy,
  readClientPremiumAllowance,
  validatePremiumApprovalPreflight,
  validatePremiumActivationPreflight,
} from '@/lib/deals/v2-protection';

interface V2DealFundingProps {
  dealData: StandardV2DealData;
  refetchDealData: () => Promise<void>;
}

export function V2DealFunding({ dealData, refetchDealData }: V2DealFundingProps) {
  const { address, isConnected, chainId } = useAccount();
  const { ensureSepolia, networkReady, isSwitching } = useSepoliaNetwork();
  const { ensureAuthenticated, getToken } = useAuthSession();
  const { writeContractAsync } = useWriteContract();

  const [balance, setBalance] = useState<bigint | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [actionInProgress, setActionInProgress] = useState<'approve' | 'fund' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [txConfirmedPendingRefresh, setTxConfirmedPendingRefresh] = useState(false);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);

  // Protection Intent & Premium State (Phase 4B / Phase 7D)
  const [protectionSelection, setProtectionSelection] = useState<'STANDARD' | 'PREMIUM' | null>(null);
  const [loadingProtectionIntent, setLoadingProtectionIntent] = useState(false);
  const [protectionIntentError, setProtectionIntentError] = useState<string | null>(null);
  const [premiumPolicy, setPremiumPolicy] = useState<PremiumPolicyState | null>(null);
  const [premiumParams, setPremiumParams] = useState<PremiumManagerParameters | null>(null);
  const [managerVersion, setManagerVersion] = useState<PremiumManagerVersion | null>(null);
  const [premiumAllowance, setPremiumAllowance] = useState<bigint | null>(null);
  const [loadingPremiumState, setLoadingPremiumState] = useState(false);
  const [premiumActionInProgress, setPremiumActionInProgress] = useState<'approvePremium' | 'activatePremium' | null>(null);
  const [premiumActionError, setPremiumActionError] = useState<string | null>(null);
  const [premiumTxHash, setPremiumTxHash] = useState<string | null>(null);

  const premiumConfig = getSynqPremiumConfig();
  const isPremiumConfigured = isPremiumProtectionConfigured(premiumConfig);

  // Fetch client balances & allowance from canonical Sepolia USDC
  const fetchFundingBalances = useCallback(async () => {
    if (!dealData.client || !dealData.dealAddress) return;
    try {
      setLoadingBalances(true);
      const state = await readClientUsdcFundingState(
        dealData.client,
        dealData.dealAddress,
        sepoliaPublicClient
      );
      setBalance(state.balance);
      setAllowance(state.allowance);
    } catch (err: any) {
      console.error('[V2DealFunding] Error reading USDC balance/allowance:', err);
    } finally {
      setLoadingBalances(false);
    }
  }, [dealData.client, dealData.dealAddress]);

  useEffect(() => {
    fetchFundingBalances();
  }, [fetchFundingBalances]);

  // Fetch persisted protection intent for this deal (Phase 4B / Phase 7D)
  const fetchProtectionIntent = useCallback(async () => {
    if (!dealData.dealAddress) return;
    try {
      setLoadingProtectionIntent(true);
      setProtectionIntentError(null);

      // Attempt to retrieve active session token or prompt authenticated session
      let token = getToken();
      if (!token && isConnected && address) {
        try {
          token = await ensureAuthenticated();
        } catch (authErr: any) {
          const msg = authErr?.shortMessage || authErr?.message || 'Authentication required';
          setProtectionSelection(null);
          setProtectionIntentError(
            msg.includes('cancelled') || msg.includes('rejected') || msg.includes('denied')
              ? 'Authentication cancelled. Please sign in with your connected wallet to verify deal protection intent.'
              : `Authentication required to verify deal protection: ${msg}`
          );
          return;
        }
      }

      if (!token) {
        setProtectionSelection(null);
        setProtectionIntentError('Wallet not authenticated. Connect and sign in to verify deal protection.');
        return;
      }

      const res = await fetch(`/api/deals/${dealData.dealAddress}/protection`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (res.status === 401) {
        setProtectionSelection(null);
        setProtectionIntentError('Authentication session expired or invalid (401). Please re-authenticate.');
        return;
      }

      if (res.status === 403) {
        setProtectionSelection(null);
        setProtectionIntentError('Access restricted: You are not an authorized participant (client or freelancer) in this deal (403).');
        return;
      }

      if (!res.ok) {
        setProtectionSelection(null);
        const errJson = await res.json().catch(() => ({}));
        setProtectionIntentError(errJson.error || `Server error verifying protection intent (HTTP ${res.status}).`);
        return;
      }

      const json = await res.json().catch(() => null);
      if (json && (json.protectionSelection === 'PREMIUM' || json.protectionSelection === 'STANDARD')) {
        setProtectionSelection(json.protectionSelection);
        setProtectionIntentError(null);
      } else {
        setProtectionSelection(null);
        setProtectionIntentError('Malformed protection response received from server.');
      }
    } catch (err: any) {
      console.warn('[V2DealFunding] Error fetching protection intent:', err);
      setProtectionSelection(null);
      setProtectionIntentError(err?.message || 'Network error verifying deal protection intent.');
    } finally {
      setLoadingProtectionIntent(false);
    }
  }, [dealData.dealAddress, isConnected, address, getToken, ensureAuthenticated]);

  useEffect(() => {
    fetchProtectionIntent();
  }, [fetchProtectionIntent]);

  // Helper to count set bits in a 16-bit bitmap
  const countSetBits = useCallback((bitmap: number) => {
    let count = 0;
    let n = bitmap;
    while (n > 0) {
      if ((n & 1) === 1) count++;
      n >>= 1;
    }
    return count;
  }, []);

  // Fetch Premium Manager params, policy, and allowance only when configured and deal is Active with PREMIUM intent
  const fetchPremiumState = useCallback(async () => {
    if (!isPremiumConfigured || !premiumConfig.manager || !dealData.dealAddress || dealData.state !== DealState.Active) {
      return;
    }
    try {
      setLoadingPremiumState(true);
      const version = await detectPremiumManagerVersion(sepoliaPublicClient, premiumConfig.manager);
      setManagerVersion(version);
      if (!version) return;

      const [policy, params, pAllowance] = await Promise.all([
        readDealPremiumPolicy(sepoliaPublicClient, premiumConfig.manager, dealData.dealAddress, version),
        readPremiumManagerParameters(sepoliaPublicClient, premiumConfig.manager, version),
        dealData.client
          ? readClientPremiumAllowance(sepoliaPublicClient, dealData.usdc, dealData.client, premiumConfig.manager)
          : Promise.resolve(0n),
      ]);
      setPremiumPolicy(policy);
      setPremiumParams(params);
      setPremiumAllowance(pAllowance);
    } catch (err) {
      console.warn('[V2DealFunding] Error reading Premium state:', err);
    } finally {
      setLoadingPremiumState(false);
    }
  }, [isPremiumConfigured, premiumConfig.manager, dealData.dealAddress, dealData.state, dealData.client, dealData.usdc]);

  useEffect(() => {
    if (dealData.state === DealState.Active && protectionSelection === 'PREMIUM' && isPremiumConfigured) {
      fetchPremiumState();
    }
  }, [dealData.state, protectionSelection, isPremiumConfigured, fetchPremiumState]);

  // Determine current role and eligibility
  const eligibility = determineFundingEligibility({
    connectedWallet: address,
    clientAddress: dealData.client,
    freelancerAddress: dealData.freelancer,
    chainId,
    dealState: dealData.state,
    totalEscrow: dealData.totalEscrow,
    usdcBalance: balance ?? 0n,
    usdcAllowance: allowance ?? 0n,
  });

  const formattedRequiredEscrow = formatUsdcAmount(dealData.totalEscrow);
  const formattedBalance = balance !== null ? formatUsdcAmount(balance) : '—';
  const formattedAllowance = allowance !== null ? formatUsdcAmount(allowance) : '—';
  const hasSufficientAllowance = allowance !== null && allowance >= dealData.totalEscrow;
  const isClient = eligibility.role === 'client';
  const isFreelancer = eligibility.role === 'freelancer';

  // Canonical Premium calculation helpers (sourced from Manager contract & V1.1 eligible principal)
  const premiumFeeBps = premiumParams?.premiumFeeBps ?? 0;
  const coverageRateBps = premiumParams?.coverageRateBps ?? 2000;
  const milestoneCount = dealData.milestones?.length || 0;
  const isV1 = managerVersion === 'V1';
  const exceedsMaxMilestones = !isV1 && milestoneCount > MAX_PROTECTED_MILESTONES;

  const eligibleMilestonesData = React.useMemo(() => {
    if (exceedsMaxMilestones) return null;
    return calculateEligibleMilestones(dealData.milestones || []);
  }, [dealData.milestones, exceedsMaxMilestones]);

  const eligiblePrincipal = isV1
    ? dealData.totalEscrow
    : (eligibleMilestonesData?.eligiblePrincipal ?? 0n);

  const calculatedPremiumFee = calculatePremiumFee(eligiblePrincipal, premiumFeeBps);
  const calculatedMaxCoverage = calculateMaximumCoverage(eligiblePrincipal, coverageRateBps);
  const formattedPremiumFee = formatUsdcAmount(calculatedPremiumFee);
  const formattedMaxCoverage = formatUsdcAmount(calculatedMaxCoverage);
  const hasSufficientPremiumAllowance = premiumAllowance !== null && premiumAllowance >= calculatedPremiumFee;

  // Step 1: Approve Exact USDC
  const handleApproveUsdc = async () => {
    if (!address || !isClient) return;

    try {
      setActionInProgress('approve');
      setActionError(null);
      await ensureSepolia();

      // Fresh authoritative preflight
      const isCanonical = await isSynqV2Deal(dealData.dealAddress, sepoliaPublicClient);
      const latestBalanceState = await readClientUsdcFundingState(
        dealData.client,
        dealData.dealAddress,
        sepoliaPublicClient
      );
      setBalance(latestBalanceState.balance);
      setAllowance(latestBalanceState.allowance);

      const preflight = validateApprovalPreflight({
        connectedWallet: address,
        clientAddress: dealData.client,
        chainId,
        isCanonicalV2Deal: isCanonical,
        dealUsdc: dealData.usdc,
        dealState: dealData.state,
        totalEscrow: dealData.totalEscrow,
        balance: latestBalanceState.balance,
        currentAllowance: latestBalanceState.allowance,
      });

      if (!preflight.valid) {
        throw new Error(preflight.error);
      }

      // Execute approval for EXACT required escrow amount (never MaxUint256)
      const txHash = await writeContractAsync({
        address: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
        abi: erc20ABI,
        functionName: 'approve',
        args: [dealData.dealAddress, dealData.totalEscrow],
        chainId: SEPOLIA_CHAIN_ID,
      });

      setLastTxHash(txHash);
      await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });

      // Refresh allowance immediately after confirmation
      await fetchFundingBalances();
    } catch (err: any) {
      if (isRejected(err)) {
        setActionError('Approval was cancelled in your wallet.');
      } else {
        setActionError(err?.message || 'Failed to approve USDC');
      }
    } finally {
      setActionInProgress(null);
    }
  };

  // Step 2: Fund Deal with Exact USDC
  const handleFundDeal = async () => {
    if (!address || !isClient) return;

    try {
      setActionInProgress('fund');
      setActionError(null);
      await ensureSepolia();

      // Fresh authoritative preflight reads directly from contracts
      const isCanonical = await isSynqV2Deal(dealData.dealAddress, sepoliaPublicClient);
      const [onChainState, onChainTotalEscrow, latestBalanceState] = await Promise.all([
        sepoliaPublicClient.readContract({
          address: dealData.dealAddress,
          abi: synqDealV1ABI,
          functionName: 'state',
        }) as Promise<number>,
        sepoliaPublicClient.readContract({
          address: dealData.dealAddress,
          abi: synqDealV1ABI,
          functionName: 'totalEscrow',
        }) as Promise<bigint>,
        readClientUsdcFundingState(dealData.client, dealData.dealAddress, sepoliaPublicClient),
      ]);

      setBalance(latestBalanceState.balance);
      setAllowance(latestBalanceState.allowance);

      const preflight = validateFundingPreflight({
        connectedWallet: address,
        clientAddress: dealData.client,
        chainId,
        isCanonicalV2Deal: isCanonical,
        dealUsdc: dealData.usdc,
        dealState: Number(onChainState) as DealState,
        contractTotalEscrow: BigInt(onChainTotalEscrow),
        expectedTotalEscrow: dealData.totalEscrow,
        balance: latestBalanceState.balance,
        allowance: latestBalanceState.allowance,
      });

      if (!preflight.valid) {
        throw new Error(preflight.error);
      }

      // Execute fundDeal() on SynqDealV1: nonpayable, zero arguments, exact totalEscrow pulled via safeTransferFrom
      const txHash = await writeContractAsync({
        address: dealData.dealAddress,
        abi: synqDealV1ABI,
        functionName: 'fundDeal',
        args: [],
        chainId: SEPOLIA_CHAIN_ID,
      });

      setLastTxHash(txHash);

      // Wait for confirmed receipt
      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });

      // Authoritative receipt & event verification
      const eventVerification = verifyFundingReceipt(receipt, dealData.dealAddress, dealData.totalEscrow);
      if (!eventVerification.valid) {
        throw new Error(eventVerification.error || 'Deal funding receipt validation failed');
      }

      // Refresh on-chain Deal data
      try {
        await refetchDealData();
        await fetchFundingBalances();
      } catch (refreshErr) {
        console.warn('[V2DealFunding] Confirmed funding tx, but refresh failed:', refreshErr);
        setTxConfirmedPendingRefresh(true);
      }
    } catch (err: any) {
      if (isRejected(err)) {
        setActionError('Funding transaction was cancelled in your wallet.');
      } else {
        setActionError(err?.message || 'Failed to fund deal');
      }
    } finally {
      setActionInProgress(null);
    }
  };

  // Step 1 (Premium): Approve Exact Premium Fee for Premium Manager
  const handleApprovePremium = async () => {
    if (!address || !isClient || !premiumConfig.manager) return;

    try {
      setPremiumActionInProgress('approvePremium');
      setPremiumActionError(null);
      await ensureSepolia();

      const latestBalanceState = await readClientUsdcFundingState(
        dealData.client,
        dealData.dealAddress,
        sepoliaPublicClient
      );
      setBalance(latestBalanceState.balance);

      const preflight = validatePremiumApprovalPreflight({
        connectedWallet: address,
        clientAddress: dealData.client,
        chainId,
        managerAddress: premiumConfig.manager,
        dealState: dealData.state,
        premiumFee: calculatedPremiumFee,
        balance: latestBalanceState.balance,
      });

      if (!preflight.valid) {
        throw new Error(preflight.error);
      }

      const txHash = await writeContractAsync({
        address: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
        abi: erc20ABI,
        functionName: 'approve',
        args: [premiumConfig.manager, calculatedPremiumFee],
        chainId: SEPOLIA_CHAIN_ID,
      });

      setPremiumTxHash(txHash);
      await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });

      await fetchPremiumState();
    } catch (err: any) {
      if (isRejected(err)) {
        setPremiumActionError('Premium fee approval was cancelled in your wallet.');
      } else {
        setPremiumActionError(err?.message || 'Failed to approve Premium fee');
      }
    } finally {
      setPremiumActionInProgress(null);
    }
  };

  // Step 2 (Premium): Purchase Policy on Premium Manager
  const handleActivatePremium = async () => {
    if (!address || !isClient || !premiumConfig.manager) return;

    try {
      setPremiumActionInProgress('activatePremium');
      setPremiumActionError(null);
      await ensureSepolia();

      const [latestBalanceState, currentVersion, latestAllowance] = await Promise.all([
        readClientUsdcFundingState(dealData.client, dealData.dealAddress, sepoliaPublicClient),
        managerVersion ? Promise.resolve(managerVersion) : detectPremiumManagerVersion(sepoliaPublicClient, premiumConfig.manager),
        readClientPremiumAllowance(sepoliaPublicClient, dealData.usdc, dealData.client, premiumConfig.manager),
      ]);
      if (currentVersion) setManagerVersion(currentVersion);

      const latestPolicy = await readDealPremiumPolicy(
        sepoliaPublicClient,
        premiumConfig.manager,
        dealData.dealAddress,
        currentVersion
      );

      setBalance(latestBalanceState.balance);
      setPremiumPolicy(latestPolicy);
      setPremiumAllowance(latestAllowance);

      const preflight = validatePremiumActivationPreflight({
        connectedWallet: address,
        clientAddress: dealData.client,
        chainId,
        managerAddress: premiumConfig.manager,
        dealState: dealData.state,
        premiumFee: calculatedPremiumFee,
        balance: latestBalanceState.balance,
        allowance: latestAllowance,
        existingPolicy: latestPolicy,
      });

      if (!preflight.valid) {
        throw new Error(preflight.error);
      }

      const writeAbi = currentVersion === 'V1_1' ? synqPremiumProtectionManagerV1_1ABI : synqPremiumProtectionManagerABI;

      const txHash = await writeContractAsync({
        address: premiumConfig.manager,
        abi: writeAbi,
        functionName: 'purchasePolicy',
        args: [dealData.dealAddress],
        chainId: SEPOLIA_CHAIN_ID,
      });

      setPremiumTxHash(txHash);
      const receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status !== 'success') {
        throw new Error('Premium policy activation transaction reverted');
      }

      await fetchPremiumState();
    } catch (err: any) {
      if (isRejected(err)) {
        setPremiumActionError('Policy activation was cancelled in your wallet.');
      } else {
        setPremiumActionError(err?.message || 'Failed to activate Premium Protection');
      }
    } finally {
      setPremiumActionInProgress(null);
    }
  };

  // State: Deal Already Active / Funded
  if (dealData.state === DealState.Active) {
    return (
      <div className="space-y-4">
        {/* Canonical Standard V2 Deal Funded & Active Card */}
        <Card className="border-emerald-500/30 bg-emerald-950/20 backdrop-blur-md">
          <CardContent className="pt-6 space-y-3">
            <div className="flex items-center gap-2 text-emerald-400 font-semibold text-base">
              <CheckCircle2 className="h-5 w-5" /> Deal Funded & Active
            </div>
            <p className="text-xs text-zinc-300">
              The client has successfully deposited {formattedRequiredEscrow} USDC into escrow. Work may now commence on milestone deliverables.
            </p>
            <div className="flex items-center gap-4 text-xs text-zinc-400 font-mono pt-1">
              <span>Escrow Locked: {formattedRequiredEscrow} USDC</span>
              <span>•</span>
              <span>Asset: Canonical Sepolia USDC</span>
            </div>
          </CardContent>
        </Card>

        {/* Protection Verification Loading / Error Treatment (Phase 7D) */}
        {loadingProtectionIntent && !protectionSelection && (
          <div className="flex items-center gap-2.5 p-3.5 rounded-xl border border-zinc-800 bg-zinc-950/40 text-xs text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin text-purple-400" />
            <span>Verifying deal protection intent…</span>
          </div>
        )}

        {protectionIntentError && !protectionSelection && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl border border-amber-500/30 bg-amber-950/20 text-xs text-amber-200">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
              <span>{protectionIntentError}</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs border-amber-500/40 text-amber-300 hover:bg-amber-500/10 shrink-0"
              onClick={() => fetchProtectionIntent()}
            >
              <RefreshCw className="h-3 w-3 mr-1" /> Retry
            </Button>
          </div>
        )}

        {/* Phase 4B: Post-Funding Premium Protection Module */}
        {protectionSelection === 'PREMIUM' && (
          <>
            {!isPremiumConfigured ? (
              /* Pre-Deployment Unconfigured State (Section J) */
              <Card className="border-zinc-800 bg-zinc-900/40 backdrop-blur-md">
                <CardContent className="pt-5 pb-5 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-zinc-300 font-semibold text-sm">
                      <ShieldCheck className="h-4 w-4 text-purple-400" />
                      <span>Premium Protection</span>
                    </div>
                    <Badge variant="outline" className="border-zinc-700 bg-zinc-900/50 text-[10px] text-zinc-400">
                      Pending Environment Deployment
                    </Badge>
                  </div>
                  <p className="text-xs text-zinc-400">
                    Premium Protection selected. Activation configuration is not available in this environment yet.
                  </p>
                </CardContent>
              </Card>
            ) : premiumPolicy?.active ? (
              /* Active Policy State (Section I) */
              <Card className="border-purple-500/40 bg-purple-950/20 backdrop-blur-md">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-purple-300 font-semibold text-base">
                      <ShieldCheck className="h-5 w-5 text-purple-400" />
                      <span>Premium Protected</span>
                    </div>
                    <Badge className="bg-purple-500/20 text-purple-300 border-purple-500/40 text-xs">
                      Active Policy
                    </Badge>
                  </div>
                  <CardDescription className="text-xs text-zinc-400">
                    This deal is protected under Synq Premium Protection V1.1 with on-chain pooled coverage.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Premium Paid</div>
                      <div className="text-base font-bold text-white">{formatUsdcAmount(premiumPolicy.premiumPaid)} USDC</div>
                      <div className="text-[10px] text-zinc-500 font-mono">
                        {dealData.totalEscrow > 0n
                          ? `${(Number((premiumPolicy.premiumPaid * 10000n) / dealData.totalEscrow) / 100).toFixed(1)}% of total escrow`
                          : 'On-chain policy fee'}
                      </div>
                    </div>
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Coverage Rate</div>
                      <div className="text-base font-bold text-white">
                        {premiumParams ? `${premiumParams.coverageRateBps / 100}%` : '20%'}
                      </div>
                      <div className="text-[10px] text-zinc-500 font-mono">
                        {premiumPolicy.version === 'V1_1' ? 'Fixed V1.1 protection rate' : 'Fixed V1 protection rate'}
                      </div>
                    </div>
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Maximum Coverage</div>
                      <div className="text-base font-bold text-emerald-400">{formatUsdcAmount(premiumPolicy.maxCoverage)} USDC</div>
                      <div className="text-[10px] text-zinc-500 font-mono">Pool-backed milestone cap</div>
                    </div>
                    {premiumPolicy.eligiblePrincipal !== undefined && (
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
                        <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Covered Escrow</div>
                        <div className="text-base font-bold text-white">{formatUsdcAmount(premiumPolicy.eligiblePrincipal)} USDC</div>
                        <div className="text-[10px] text-zinc-500 font-mono">V1.1 eligible snapshot</div>
                      </div>
                    )}
                    {premiumPolicy.coveredBitmap !== undefined && (
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
                        <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Protected Milestones</div>
                        <div className="text-base font-bold text-purple-300">{countSetBits(premiumPolicy.coveredBitmap)} covered</div>
                        <div className="text-[10px] text-zinc-500 font-mono">Bitmap: 0x{premiumPolicy.coveredBitmap.toString(16).toUpperCase()}</div>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between text-xs text-zinc-400 pt-1 border-t border-zinc-800/60">
                    <span>Activated: {new Date(Number(premiumPolicy.purchasedAt) * 1000).toLocaleString()}</span>
                    {premiumPolicy.totalPaid > 0n && (
                      <span className="text-amber-400">Claims Paid: {formatUsdcAmount(premiumPolicy.totalPaid)} USDC</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            ) : (
              /* Activation State (Sections F, G, H) */
              <Card className="border-purple-500/30 bg-zinc-950/60 backdrop-blur-md">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <CardTitle className="text-base text-white flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-purple-400" /> Premium Protection
                      </CardTitle>
                      <CardDescription className="text-xs text-zinc-400">
                        Activate decentralized milestone protection backed by the Synq Protection Pool.
                      </CardDescription>
                    </div>
                    <Badge variant="outline" className="border-purple-500/40 bg-purple-500/10 text-xs text-purple-400">
                      Awaiting Activation
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {exceedsMaxMilestones ? (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 space-y-2">
                      <div className="flex items-center gap-2 text-sm font-semibold text-amber-300">
                        <AlertTriangle className="h-4 w-4 text-amber-400" /> Milestone Limit Exceeded
                      </div>
                      <p className="text-xs text-zinc-400">
                        This deal contains {milestoneCount} milestones. Premium Protection supports a maximum of 16 milestones. Policy activation is disabled for this deal.
                      </p>
                    </div>
                  ) : eligiblePrincipal === 0n ? (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 space-y-2">
                      <div className="flex items-center gap-2 text-sm font-semibold text-amber-300">
                        <AlertTriangle className="h-4 w-4 text-amber-400" /> No Remaining Milestones Eligible
                      </div>
                      <p className="text-xs text-zinc-400">
                        No remaining milestones are eligible for new Premium Protection. Premium Protection can only be purchased for unstarted (Pending) milestones whose deadlines have not passed.
                      </p>
                    </div>
                  ) : isV1 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
                        <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Total Escrow</div>
                        <div className="text-base font-bold text-white">{formatUsdcAmount(dealData.totalEscrow)} USDC</div>
                        <div className="text-[10px] text-zinc-500 font-mono">Deal principal</div>
                      </div>
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
                        <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Premium Fee</div>
                        <div className="text-base font-bold text-white">{formattedPremiumFee} USDC</div>
                        <div className="text-[10px] text-zinc-500 font-mono">{premiumFeeBps / 100}% of escrow</div>
                      </div>
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
                        <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Coverage Rate</div>
                        <div className="text-base font-bold text-white">{coverageRateBps / 100}%</div>
                        <div className="text-[10px] text-zinc-500 font-mono">Fixed protection rate</div>
                      </div>
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
                        <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Maximum Coverage</div>
                        <div className="text-base font-bold text-purple-300">{formattedMaxCoverage} USDC</div>
                        <div className="text-[10px] text-zinc-500 font-mono">Milestone cap</div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
                          <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Protected Milestones</div>
                          <div className="text-base font-bold text-white">
                            {eligibleMilestonesData?.eligibleCount} of {eligibleMilestonesData?.totalCount} eligible
                          </div>
                          <div className="text-[10px] text-zinc-500 font-mono">Pending & unexpired</div>
                        </div>
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
                          <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Covered Escrow</div>
                          <div className="text-base font-bold text-white">{formatUsdcAmount(eligiblePrincipal)} USDC</div>
                          <div className="text-[10px] text-zinc-500 font-mono">Eligible principal</div>
                        </div>
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
                          <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Premium Fee</div>
                          <div className="text-base font-bold text-white">{formattedPremiumFee} USDC</div>
                          <div className="text-[10px] text-zinc-500 font-mono">{premiumFeeBps / 100}% of covered escrow</div>
                        </div>
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
                          <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Coverage Rate</div>
                          <div className="text-base font-bold text-white">{coverageRateBps / 100}%</div>
                          <div className="text-[10px] text-zinc-500 font-mono">CANONICAL COVERAGE_RATE_BPS</div>
                        </div>
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
                          <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Maximum Protection</div>
                          <div className="text-base font-bold text-purple-300">{formattedMaxCoverage} USDC</div>
                          <div className="text-[10px] text-zinc-500 font-mono">Max payout on covered failure</div>
                        </div>
                      </div>

                      {/* Excluded milestones summary if any */}
                      {eligibleMilestonesData && eligibleMilestonesData.eligibleCount < eligibleMilestonesData.totalCount && (
                        <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3 space-y-2 text-xs">
                          <div className="font-semibold text-zinc-300">Milestone Coverage Breakdown</div>
                          <div className="space-y-1">
                            {eligibleMilestonesData.milestones.map((m) => (
                              <div key={m.index} className="flex items-center justify-between text-zinc-400">
                                <span>Milestone {m.index + 1} ({formatUsdcAmount(m.amount)} USDC):</span>
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    'text-[10px]',
                                    m.isEligible
                                      ? 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10'
                                      : 'border-zinc-700 text-zinc-400 bg-zinc-800/40'
                                  )}
                                >
                                  {m.reason}
                                </Badge>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {premiumActionError && (
                    <div className="rounded-xl border border-red-500/30 bg-red-950/30 p-3 text-xs text-red-200 flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                      <span>{premiumActionError}</span>
                    </div>
                  )}

                  {isClient && eligiblePrincipal > 0n && !exceedsMaxMilestones ? (
                    <div className="space-y-3 pt-1">
                      {!hasSufficientPremiumAllowance ? (
                        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 rounded-lg border border-purple-500/20 bg-purple-950/10">
                          <div className="text-xs text-zinc-300">
                            Authorize Premium Manager to transfer exactly {formattedPremiumFee} USDC.
                          </div>
                          <Button
                            size="sm"
                            className="w-full sm:w-auto h-8 text-xs bg-purple-600 hover:bg-purple-500 text-white"
                            disabled={
                              premiumActionInProgress !== null ||
                              (balance !== null && balance < calculatedPremiumFee) ||
                              chainId !== SEPOLIA_CHAIN_ID
                            }
                            onClick={handleApprovePremium}
                          >
                            {premiumActionInProgress === 'approvePremium' ? (
                              <>
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Approving {formattedPremiumFee} USDC…
                              </>
                            ) : (
                              <>Approve {formattedPremiumFee} USDC</>
                            )}
                          </Button>
                        </div>
                      ) : (
                        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 rounded-lg border border-emerald-500/20 bg-emerald-950/10">
                          <div className="text-xs text-zinc-300">
                            USDC fee approved. Click below to activate your policy.
                          </div>
                          <Button
                            size="sm"
                            className="w-full sm:w-auto h-8 text-xs bg-emerald-600 hover:bg-emerald-500 text-white"
                            disabled={
                              premiumActionInProgress !== null ||
                              chainId !== SEPOLIA_CHAIN_ID
                            }
                            onClick={handleActivatePremium}
                          >
                            {premiumActionInProgress === 'activatePremium' ? (
                              <>
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Activating Premium Protection…
                              </>
                            ) : (
                              <>Activate Premium Protection</>
                            )}
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : !isClient ? (
                    <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/30 text-xs text-zinc-400">
                      Premium Protection activation is restricted to the deal client ({shortenAddress(dealData.client)}).
                    </div>
                  ) : null}

                  {premiumTxHash && (
                    <div className="text-right">
                      <a
                        href={getSepoliaExplorerUrl('tx', premiumTxHash)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-purple-400 hover:underline"
                      >
                        View Premium Transaction <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    );
  }

  // State: Deal Terminal (Completed, Cancelled, Terminated)
  if (dealData.state !== DealState.Draft) {
    const label = DEAL_STATE_LABELS[dealData.state] ?? 'Terminal';
    return (
      <Card className="border-zinc-800 bg-zinc-900/40 backdrop-blur-md">
        <CardContent className="pt-6 space-y-2">
          <div className="flex items-center gap-2 text-zinc-300 font-semibold text-base">
            <Lock className="h-5 w-5 text-zinc-500" /> Deal State: {label}
          </div>
          <p className="text-xs text-zinc-400">
            This deal is in state {label} and does not require funding.
          </p>
        </CardContent>
      </Card>
    );
  }

  // State: Draft — Awaiting Client Funding
  return (
    <Card className="border-blue-500/30 bg-zinc-950/60 backdrop-blur-md">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base text-white flex items-center gap-2">
              <Coins className="h-4 w-4 text-blue-400" /> Escrow Collateralization
            </CardTitle>
            <CardDescription className="text-xs text-zinc-400">
              Standard V2 deals require full collateralization in canonical Sepolia USDC before work begins.
            </CardDescription>
          </div>
          <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-xs text-amber-400">
            Awaiting Client Funding
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Protection Verification Error in Draft State (Phase 7D) */}
        {protectionIntentError && !protectionSelection && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-xl border border-amber-500/30 bg-amber-950/20 text-xs text-amber-200">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
              <span>{protectionIntentError}</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs border-amber-500/40 text-amber-300 hover:bg-amber-500/10 shrink-0"
              onClick={() => fetchProtectionIntent()}
            >
              <RefreshCw className="h-3 w-3 mr-1" /> Retry
            </Button>
          </div>
        )}

        {/* Premium Intent Informational Treatment (Section E) */}
        {protectionSelection === 'PREMIUM' && (
          <div className="rounded-xl border border-purple-500/30 bg-purple-950/20 p-3.5 text-xs text-purple-200 flex items-start gap-2.5">
            <ShieldCheck className="h-4 w-4 text-purple-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-purple-300">Premium Protection selected:</span>{' '}
              Premium Protection becomes available after the Standard V2 escrow is funded. Please complete the escrow deposit below to activate the deal.
            </div>
          </div>
        )}

        {/* Funding Summary Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Total Escrow Required</div>
            <div className="text-base font-bold text-white">{formattedRequiredEscrow} USDC</div>
            <div className="text-[10px] text-zinc-500 font-mono">6 decimals • exact base units</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Your USDC Balance</div>
            <div className="text-base font-bold text-white flex items-center gap-2">
              {loadingBalances ? <Loader2 className="h-4 w-4 animate-spin text-zinc-400" /> : `${formattedBalance} USDC`}
            </div>
            <div className="text-[10px] text-zinc-500 font-mono">
              {eligibility.hasInsufficientBalance ? (
                <span className="text-red-400 font-semibold">Insufficient balance</span>
              ) : (
                'Canonical Sepolia USDC'
              )}
            </div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">USDC Allowance</div>
            <div className="text-base font-bold text-white flex items-center gap-2">
              {loadingBalances ? <Loader2 className="h-4 w-4 animate-spin text-zinc-400" /> : `${formattedAllowance} USDC`}
            </div>
            <div className="text-[10px] text-zinc-500 font-mono">
              {hasSufficientAllowance ? (
                <span className="text-emerald-400 font-semibold">Ready for funding</span>
              ) : (
                'Approval needed'
              )}
            </div>
          </div>
        </div>

        {/* Action Error Notice */}
        {actionError && (
          <div className="rounded-xl border border-red-500/30 bg-red-950/30 p-3 text-xs text-red-200 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
            <span>{actionError}</span>
          </div>
        )}

        {/* Confirmed Pending Refresh Notice */}
        {txConfirmedPendingRefresh && (
          <div className="rounded-xl border border-blue-500/30 bg-blue-950/30 p-3 text-xs text-blue-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-blue-400 animate-spin" />
              <span>Funding transaction confirmed. Synq is refreshing the Deal state.</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs border-blue-500/40 text-blue-300"
              onClick={() => refetchDealData().catch(() => {})}
            >
              Refresh Now
            </Button>
          </div>
        )}

        {/* Client Two-Step Funding Sequence */}
        {isClient ? (
          <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="text-xs font-semibold text-zinc-200">Client Funding Sequence</div>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Step 1: Approve */}
              <div
                className={cn(
                  'rounded-lg border p-3 space-y-2 transition-colors',
                  hasSufficientAllowance
                    ? 'border-emerald-500/30 bg-emerald-950/10'
                    : 'border-blue-500/30 bg-blue-950/10'
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-zinc-300">Step 1: Approve USDC</span>
                  {hasSufficientAllowance ? (
                    <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-400">
                      <CheckCircle2 className="mr-1 h-3 w-3" /> Approved
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-blue-500/40 bg-blue-500/10 text-[10px] text-blue-400">
                      Required
                    </Badge>
                  )}
                </div>
                <p className="text-[11px] text-zinc-400">
                  Authorize the Deal escrow contract to transfer exactly {formattedRequiredEscrow} USDC from your wallet.
                </p>
                {!hasSufficientAllowance && (
                  <Button
                    size="sm"
                    className="w-full h-8 text-xs bg-blue-600 hover:bg-blue-500 text-white"
                    disabled={
                      actionInProgress !== null ||
                      eligibility.hasInsufficientBalance ||
                      chainId !== SEPOLIA_CHAIN_ID ||
                      txConfirmedPendingRefresh
                    }
                    onClick={handleApproveUsdc}
                  >
                    {actionInProgress === 'approve' ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Approving {formattedRequiredEscrow} USDC…
                      </>
                    ) : (
                      <>Approve {formattedRequiredEscrow} USDC</>
                    )}
                  </Button>
                )}
              </div>

              {/* Step 2: Fund Deal */}
              <div
                className={cn(
                  'rounded-lg border p-3 space-y-2 transition-colors',
                  hasSufficientAllowance
                    ? 'border-blue-500/30 bg-blue-950/10'
                    : 'border-zinc-800 bg-zinc-950/20 opacity-60'
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-zinc-300">Step 2: Fund Deal</span>
                  <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400">
                    fundDeal()
                  </Badge>
                </div>
                <p className="text-[11px] text-zinc-400">
                  Transfer {formattedRequiredEscrow} USDC into the SynqDealV1 contract to activate the deal lifecycle.
                </p>
                <Button
                  size="sm"
                  className="w-full h-8 text-xs bg-emerald-600 hover:bg-emerald-500 text-white"
                  disabled={
                    !hasSufficientAllowance ||
                    actionInProgress !== null ||
                    eligibility.hasInsufficientBalance ||
                    chainId !== SEPOLIA_CHAIN_ID ||
                    txConfirmedPendingRefresh
                  }
                  onClick={handleFundDeal}
                >
                  {actionInProgress === 'fund' ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Funding Deal…
                    </>
                  ) : (
                    <>Fund Deal ({formattedRequiredEscrow} USDC)</>
                  )}
                </Button>
              </div>
            </div>

            {/* Insufficient balance explanation */}
            {eligibility.hasInsufficientBalance && (
              <p className="text-xs text-red-400">
                You have {formattedBalance} USDC but {formattedRequiredEscrow} USDC is required. Please acquire additional Sepolia USDC to continue.
              </p>
            )}

            {/* Wrong network prompt */}
            {chainId !== SEPOLIA_CHAIN_ID && (
              <div className="flex items-center justify-between p-2 rounded-lg bg-amber-950/30 border border-amber-500/30 text-xs text-amber-200">
                <span>Wrong network. Switch to Sepolia to approve and fund.</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs border-amber-500/40 text-amber-300"
                  onClick={() => ensureSepolia()}
                  disabled={isSwitching}
                >
                  {isSwitching ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null} Switch to Sepolia
                </Button>
              </div>
            )}
          </div>
        ) : isFreelancer ? (
          /* Freelancer View */
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
              <ShieldCheck className="h-4 w-4 text-zinc-400" /> Freelancer Read-Only View
            </div>
            <p className="text-xs text-zinc-400">
              You are the designated freelancer for this deal. The client ({shortenAddress(dealData.client)}) must complete the {formattedRequiredEscrow} USDC escrow deposit before work begins.
            </p>
          </div>
        ) : isConnected ? (
          /* Third Party Connected */
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
              <Lock className="h-4 w-4 text-zinc-400" /> Third-Party Observer
            </div>
            <p className="text-xs text-zinc-400">
              You are viewing this deal from an observer wallet ({address ? shortenAddress(address) : ''}). Funding is restricted exclusively to the deal client ({shortenAddress(dealData.client)}).
            </p>
          </div>
        ) : (
          /* Disconnected */
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 space-y-2 text-center">
            <p className="text-xs text-zinc-400">Connect your wallet to interact with this deal.</p>
          </div>
        )}

        {/* Transaction Link */}
        {lastTxHash && (
          <div className="text-right">
            <a
              href={getSepoliaExplorerUrl('tx', lastTxHash)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:underline"
            >
              View Recent Transaction <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
