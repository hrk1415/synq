'use client';

import { useMemo, useState, useEffect } from 'react';
import { ShieldCheck, Loader2, CheckCircle, AlertTriangle, Scale, ThumbsUp, ThumbsDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useAccount, useChainId, useReadContract } from 'wagmi';
import { useProtectionContract, useProtectionCoverage } from '@/hooks/useProtectionContract';
import { useDealStatuses, dealStatusLabel, isTerminalStatus } from '@/hooks/useDealStatuses';
import { getFactoryAddress, useFactoryContract } from '@/hooks/useFactoryContract';
import { nexotiqFactoryABI, nexotiqDealABI } from '@/lib/contracts/abis';
import { formatTokenAmount, shortenAddress, cn } from '@/lib/utils';
import { isSupportedChain } from '@/lib/contracts/addresses';
import { ChainGuard } from '@/components/shared/ChainGuard';

export default function ProtectionPage() {
  const { address } = useAccount();
  const chainId = useChainId();
  const protection = useProtectionContract();
  const factoryAddress = getFactoryAddress(chainId);
  const onSupportedChain = isSupportedChain(chainId) && !!factoryAddress;

  const { data: rawDeals, isLoading: dealsLoading } = useReadContract({
    address: factoryAddress,
    abi: nexotiqFactoryABI,
    functionName: 'getUserDeals',
    args: address ? [address] : undefined,
    query: { enabled: !!address && onSupportedChain },
  });

  // Every deal, not just the ones the factory calls active — that flag is never
  // cleared on the deployed factory, so filtering on it hid nothing and labelled
  // settled deals as live. Real status comes from each deal contract below.
  const deals = useMemo(() => {
    if (!rawDeals) return [];
    return (rawDeals as any[]).filter(Boolean);
  }, [rawDeals]);

  const dealAddressList = useMemo(() => deals.map((d) => String(d.dealAddress)), [deals]);
  const { statuses: dealStatuses } = useDealStatuses(dealAddressList);

  const [selectedAddr, setSelectedAddr] = useState<string | null>(null);
  useEffect(() => {
    if (deals.length > 0 && !deals.some((d) => d.dealAddress === selectedAddr)) {
      setSelectedAddr(deals[0].dealAddress);
    }
  }, [deals, selectedAddr]);

  const dealAddress = (deals.find((d) => d.dealAddress === selectedAddr)?.dealAddress || null) as `0x${string}` | null;

  const { data: protEnabled } = useReadContract({
    address: dealAddress ?? undefined,
    abi: nexotiqDealABI,
    functionName: 'protectionEnabled',
    query: { enabled: !!dealAddress },
  });
  const { data: dealTotalValue } = useReadContract({
    address: dealAddress ?? undefined,
    abi: nexotiqDealABI,
    functionName: 'totalValue',
    query: { enabled: !!dealAddress },
  });
  const { data: dealRiskScore } = useReadContract({
    address: dealAddress ?? undefined,
    abi: nexotiqDealABI,
    functionName: 'riskScore',
    query: { enabled: !!dealAddress },
  });
  const { coverage: cov, tracksPremiumPaid } = useProtectionCoverage(dealAddress ?? undefined, chainId);

  const factory = useFactoryContract();
  const isFeeCollector = !!address && !!factory.feeCollector && String(address).toLowerCase() === String(factory.feeCollector).toLowerCase();
  const [claimDeal, setClaimDeal] = useState<string | null>(null);

  const selectedStatus = dealAddress ? dealStatuses[dealAddress.toLowerCase()] : undefined;
  const selectedTerminal = isTerminalStatus(selectedStatus);

  /**
   * The premium the pool will actually accept, straight from the coverage record.
   *
   * This used to be recomputed client-side as `totalValue * riskScore / 10000`
   * with a local floor of 1e12 wei. On-chain `riskScore` is 0 on every deployed
   * deal, so that always collapsed to the floor — 1000x below the pool's real
   * minimum — and `payPremium`'s exact-value check reverted every single time.
   * A price the contract quotes must be read, never re-derived.
   */
  const premium = cov?.exists ? cov.premium : undefined;

  const hasCoverage = !!cov?.exists;
  const isProtected = !!protEnabled;
  const isCoverageBuyer = !!address && !!cov?.buyer && String(cov.buyer).toLowerCase() === String(address).toLowerCase();
  // `premiumPaid === undefined` means the live pool cannot tell us; don't block on a guess.
  const premiumAlreadyPaid = cov?.premiumPaid === true;

  const canPayPremium = hasCoverage && !!cov?.active && !premiumAlreadyPaid && !!premium;
  const canFileClaim = hasCoverage && !!cov?.active && isCoverageBuyer && !cov?.claimed && !selectedTerminal;

  const fileClaimBlockedReason = !hasCoverage
    ? 'This deal has no coverage record in the pool.'
    : !cov?.active
      ? 'Coverage is no longer active.'
      : !isCoverageBuyer
        ? 'Only the covered buyer can file a claim.'
        : cov?.claimed
          ? 'A claim has already been filed for this deal.'
          : selectedTerminal
            ? `This deal is ${dealStatusLabel(selectedStatus)} — a claim can only be filed against a live or disputed deal.`
            : null;

  // totalPremiums on the deployed pool counted quoted premiums, not received
  // ones, so it can exceed what the pool actually holds.
  const premiumsOverstated =
    protection.totalPremiums !== undefined &&
    protection.poolBalance !== undefined &&
    (protection.totalPremiums as bigint) > protection.poolBalance;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Living Protection</h1>
        <p className="text-zinc-400 text-sm mt-1">On-chain protection pool for your deals.</p>
      </div>

      <ChainGuard what="the protection pool is" />

      {!address ? (
        <Card>
          <CardContent className="p-12 text-center text-zinc-500">Connect your wallet to view protection details.</CardContent>
        </Card>
      ) : (
        <div className="grid lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Protection Pool</CardTitle>
                  <CardDescription>Total premiums and payouts from Synq's protection contract</CardDescription>
                </div>
                <Badge variant={onSupportedChain ? 'success' : 'secondary'} className="gap-1">
                  <ShieldCheck size={12} /> {onSupportedChain ? 'Contract Active' : 'Not on this network'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="p-4 rounded-xl bg-zinc-800/30 border border-zinc-800/50">
                  <div className="text-xs text-zinc-500 mb-1">Pool Balance</div>
                  <div className="text-2xl font-bold text-white">
                    {protection.poolBalance !== undefined ? `${formatTokenAmount(protection.poolBalance)} ETH` : '—'}
                  </div>
                  <div className="text-[10px] text-zinc-600 mt-1">What claims can actually pay from</div>
                </div>
                <div className="p-4 rounded-xl bg-zinc-800/30 border border-zinc-800/50">
                  <div className="text-xs text-zinc-500 mb-1">Premiums Counted</div>
                  <div className={cn('text-2xl font-bold', premiumsOverstated ? 'text-amber-400' : 'text-white')}>
                    {formatTokenAmount(protection.totalPremiums as bigint | undefined)} ETH
                  </div>
                  <div className="text-[10px] text-zinc-600 mt-1">Counter reported by the contract</div>
                </div>
                <div className="p-4 rounded-xl bg-zinc-800/30 border border-zinc-800/50">
                  <div className="text-xs text-zinc-500 mb-1">Total Payouts</div>
                  <div className="text-2xl font-bold text-white">
                    {formatTokenAmount(protection.totalPayouts as bigint | undefined)} ETH
                  </div>
                  <div className="text-[10px] text-zinc-600 mt-1">Paid out to buyers</div>
                </div>
              </div>

              {premiumsOverstated && (
                <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/25">
                  <div className="flex items-center gap-2 text-sm text-amber-400 mb-1">
                    <AlertTriangle size={14} /> Premium counter exceeds the pool balance
                  </div>
                  <p className="text-xs text-zinc-300">
                    The deployed pool increments its premium counter when coverage is <em>quoted</em>, not when ETH
                    arrives, so it reports {formatTokenAmount(protection.totalPremiums as bigint | undefined)} ETH against a
                    real balance of {formatTokenAmount(protection.poolBalance)} ETH. Only the Pool Balance figure is
                    payable. This is fixed in the contract source and takes effect on the next deployment.
                  </p>
                </div>
              )}

              <div className="p-4 rounded-xl bg-blue-600/10 border border-blue-500/20">
                <div className="flex items-center gap-2 text-sm text-blue-400 mb-2">
                  <ShieldCheck size={14} />
                  On-Chain Protection
                </div>
                <p className="text-sm text-zinc-300">
                  The protection pool collects premiums from covered deals and pays out claims when disputes are resolved in favor of the buyer. All funds are managed by the protection smart contract.
                </p>
              </div>

              <div className="mt-6 space-y-4">
                <div>
                  <h4 className="text-xs text-zinc-500 font-medium uppercase tracking-wider mb-3">Pay Premium for a Deal</h4>
                  {dealsLoading ? (
                    <div className="flex justify-center py-6"><Loader2 size={18} className="animate-spin text-blue-400" /></div>
                  ) : deals.length === 0 ? (
                    <p className="text-sm text-zinc-500">No deals yet. Create a deal to fund coverage.</p>
                  ) : (
                    <>
                      <div className="space-y-2 max-h-[160px] overflow-y-auto pr-1">
                        {deals.map((deal: any, i: number) => {
                          const st = dealStatuses[String(deal.dealAddress).toLowerCase()];
                          return (
                            <button
                              key={deal.dealAddress}
                              onClick={() => setSelectedAddr(deal.dealAddress)}
                              className={cn(
                                'w-full flex items-center justify-between p-3 rounded-lg border text-left transition-all',
                                selectedAddr === deal.dealAddress ? 'border-blue-500/50 bg-blue-600/10' : 'border-zinc-800/50 bg-zinc-800/30 hover:border-zinc-700',
                              )}
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <ShieldCheck size={14} className={cn('shrink-0', i === 0 ? 'text-violet-400' : 'text-zinc-500')} />
                                <span className="text-xs font-mono text-zinc-400 truncate">{shortenAddress(deal.dealAddress)}</span>
                                <Badge
                                  variant={st === 1 ? 'success' : st === 3 ? 'destructive' : 'secondary'}
                                  className="text-[10px] shrink-0"
                                >
                                  {dealStatusLabel(st)}
                                </Badge>
                              </div>
                              <span className="text-xs text-zinc-300 shrink-0">{formatTokenAmount(deal.totalValue as bigint, 18, 4)} ETH</span>
                            </button>
                          );
                        })}
                      </div>

                      {dealAddress && (
                        <div className="mt-3 p-4 rounded-xl bg-zinc-800/30 border border-zinc-800/50 space-y-2 text-sm">
                          {isProtected ? (
                            <>
                              <div className="flex justify-between">
                                <span className="text-zinc-400">Deal Status</span>
                                <span className="text-white">{dealStatusLabel(selectedStatus)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-zinc-400">Coverage Amount</span>
                                <span className="text-white font-semibold">
                                  {formatTokenAmount((cov?.coverageAmount ?? (dealTotalValue as bigint | undefined)), 18, 4)} ETH
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-zinc-400">Risk Score</span>
                                <span className="text-white">{dealRiskScore !== undefined ? `${dealRiskScore}/100` : '—'}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-zinc-400">Premium Due</span>
                                <span className="text-white font-semibold">
                                  {premium !== undefined ? `${formatTokenAmount(premium)} ETH` : 'No coverage record'}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-zinc-400">Coverage Active</span>
                                <span className="text-white">{cov ? String(cov.active) : '—'}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-zinc-400">Premium Paid</span>
                                <span className={cn(premiumAlreadyPaid ? 'text-green-400' : 'text-zinc-400')}>
                                  {tracksPremiumPaid ? (premiumAlreadyPaid ? 'Yes' : 'No') : 'Not tracked by this pool'}
                                </span>
                              </div>
                              {cov?.claimed && (
                                <div className="flex justify-between">
                                  <span className="text-zinc-400">Claim Filed</span>
                                  <span className="text-amber-400">Yes</span>
                                </div>
                              )}
                              <Separator className="my-2" />

                              {!hasCoverage && (
                                <p className="text-xs text-amber-400 flex items-center gap-1.5">
                                  <AlertTriangle size={13} /> This deal is flagged as protected but the pool holds no
                                  coverage record for it, so there is nothing to pay a premium against.
                                </p>
                              )}

                              <div className="flex items-center gap-2">
                                <Button
                                  size="sm"
                                  className="gap-1 flex-1"
                                  onClick={() => premium !== undefined && protection.payPremium(dealAddress, premium)}
                                  disabled={protection.isPending || !canPayPremium}
                                >
                                  {protection.isPending ? <><Loader2 size={14} className="animate-spin" /> Sending...</> : <><ShieldCheck size={14} /> Pay Premium{premium !== undefined ? ` (${formatTokenAmount(premium)} ETH)` : ''}</>}
                                </Button>
                              </div>
                              {premiumAlreadyPaid && (
                                <p className="text-[11px] text-zinc-500">Premium already received by the pool.</p>
                              )}
                              {!tracksPremiumPaid && hasCoverage && cov?.active && (
                                <p className="text-[11px] text-zinc-500">
                                  This pool does not record premium receipts, so it cannot stop you paying twice. Fixed
                                  in the contract source, pending a redeployment.
                                </p>
                              )}

                              {/* File Claim is the buyer's remedy, not a public button. The
                                  deployed pool has no access control at all, so the guard here
                                  is the only thing preventing a pointless reverting transaction
                                  — or worse, a claim filed against a settled deal, which locks
                                  that coverage permanently. */}
                              {isCoverageBuyer && (
                                <>
                                  <div className="flex items-center gap-2">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="gap-1 flex-1 text-red-400 border-red-500/30 hover:bg-red-500/10"
                                      onClick={() => protection.fileClaim(dealAddress)}
                                      disabled={protection.isPending || !canFileClaim}
                                    >
                                      {protection.isPending ? <><Loader2 size={14} className="animate-spin" /> Filing...</> : <><AlertTriangle size={14} /> File Claim</>}
                                    </Button>
                                  </div>
                                  {fileClaimBlockedReason && (
                                    <p className="text-[11px] text-zinc-500">{fileClaimBlockedReason}</p>
                                  )}
                                </>
                              )}
                              {!isCoverageBuyer && hasCoverage && (
                                <p className="text-[11px] text-zinc-500">
                                  Claims can only be filed by the covered buyer ({shortenAddress(String(cov?.buyer ?? ''))}).
                                </p>
                              )}
                            </>
                          ) : (
                            <p className="text-xs text-zinc-400 flex items-center gap-1.5">
                              <AlertTriangle size={13} className="text-amber-400" /> This deal was created without protection. Protected deals are covered by the factory automatically.
                            </p>
                          )}
                          {protection.txReceipt.isSuccess && (
                            <p className="text-xs text-green-400 flex items-center gap-1"><CheckCircle size={12} /> Transaction confirmed on-chain.</p>
                          )}
                          {protection.txReceipt.isError && <p className="text-xs text-red-400">Transaction failed.</p>}
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div className="p-3 rounded-lg bg-zinc-800/20 border border-zinc-800/50 text-xs text-zinc-500">
                  <span className="text-zinc-400 font-medium">Note:</span> Coverage creation and claim resolution are executed by the Factory contract — they are not callable directly from a wallet.
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Contract Details</CardTitle>
                <CardDescription>Protection contract info</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-400">Status</span>
                  {protection.protAddress ? (
                    <Badge variant="success" className="text-[10px]">Deployed</Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[10px]">Not on this network</Badge>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-zinc-400">Coverage Type</span>
                  <span className="text-white">On-Chain Pool</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between">
                  <span className="text-zinc-400">Contract</span>
                  <span className="text-white font-mono text-xs">
                    {protection.protAddress ? `${protection.protAddress.substring(0, 10)}...` : '—'}
                  </span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Protection Agent</CardTitle>
                <CardDescription>Real-time monitoring</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex items-center gap-2 text-zinc-400">
                  <ShieldCheck size={14} className="text-blue-400" />
                  <span>Contract deployed on-chain</span>
                </div>
                <div className="flex items-center gap-2 text-zinc-400">
                  <ShieldCheck size={14} className={protection.poolBalance && protection.poolBalance > 0n ? 'text-green-400' : 'text-zinc-600'} />
                  <span>
                    {protection.poolBalance !== undefined && protection.poolBalance > 0n
                      ? `Pool capitalised: ${formatTokenAmount(protection.poolBalance)} ETH`
                      : 'Pool holds no ETH — claims cannot pay out yet'}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-zinc-400">
                  <ShieldCheck size={14} className="text-violet-400" />
                  <span>Coverage managed by the factory</span>
                </div>
              </CardContent>
            </Card>

            {isFeeCollector && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Scale size={16} className="text-amber-400" /> Fee Collector Admin</CardTitle>
                  <CardDescription>Resolve filed claims — payout the buyer or reject</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-zinc-500">Select a deal with a filed claim, then approve (payout buyer) or reject.</p>
                  <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1">
                    {deals.map((d: any) => (
                      <button
                        key={d.dealAddress}
                        onClick={() => setClaimDeal(d.dealAddress)}
                        className={cn(
                          'w-full flex items-center justify-between p-3 rounded-lg border text-left transition-all',
                          claimDeal === d.dealAddress ? 'border-amber-500/40 bg-amber-600/10' : 'border-zinc-800/50 bg-zinc-800/30 hover:border-zinc-700'
                        )}
                      >
                        <span className="text-xs font-mono text-zinc-400 truncate">{shortenAddress(d.dealAddress)}</span>
                        <span className="text-xs text-zinc-300 shrink-0">{formatTokenAmount(d.totalValue as bigint, 18, 4)} ETH</span>
                      </button>
                    ))}
                  </div>
                  {claimDeal && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        className="gap-1.5 flex-1 bg-green-600 hover:bg-green-500"
                        disabled={factory.isPending}
                        onClick={() => factory.resolveClaim(claimDeal as `0x${string}`, true)}
                      >
                        {factory.isPending ? <><Loader2 size={14} className="animate-spin" /> Resolving...</> : <><ThumbsUp size={14} /> Approve Claim (Payout Buyer)</>}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 flex-1 text-red-400 border-red-500/30 hover:bg-red-500/10"
                        disabled={factory.isPending}
                        onClick={() => factory.resolveClaim(claimDeal as `0x${string}`, false)}
                      >
                        <ThumbsDown size={14} /> Reject Claim
                      </Button>
                    </div>
                  )}
                  {factory.txReceipt.isSuccess && (
                    <p className="text-xs text-green-400 flex items-center gap-1"><CheckCircle size={12} /> Claim resolved on-chain!</p>
                  )}
                  {factory.txReceipt.isError && <p className="text-xs text-red-400">Resolution failed.</p>}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
