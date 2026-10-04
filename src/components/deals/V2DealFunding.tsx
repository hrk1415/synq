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
import { SYNQ_V2_SEPOLIA_CONFIG, SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { synqDealV1ABI, erc20ABI } from '@/lib/contracts/abis';
import { getSepoliaExplorerUrl, sepoliaPublicClient } from '@/lib/chain';
import { useSepoliaNetwork, isRejected } from '@/hooks/useSepoliaNetwork';
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

interface V2DealFundingProps {
  dealData: StandardV2DealData;
  refetchDealData: () => Promise<void>;
}

export function V2DealFunding({ dealData, refetchDealData }: V2DealFundingProps) {
  const { address, isConnected, chainId } = useAccount();
  const { ensureSepolia, networkReady, isSwitching } = useSepoliaNetwork();
  const { writeContractAsync } = useWriteContract();

  const [balance, setBalance] = useState<bigint | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [actionInProgress, setActionInProgress] = useState<'approve' | 'fund' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [txConfirmedPendingRefresh, setTxConfirmedPendingRefresh] = useState(false);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);

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

  // State: Deal Already Active / Funded
  if (dealData.state === DealState.Active) {
    return (
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
