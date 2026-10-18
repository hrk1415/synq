'use client';

import React, { useState, useEffect } from 'react';
import {
  Handshake,
  Scale,
  CheckCircle2,
  ExternalLink,
  FileText,
  ChevronDown,
  ChevronUp,
  Loader2,
  Info,
} from 'lucide-react';
import { isAddress } from 'viem';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { sepoliaPublicClient } from '@/lib/chain';
import { synqDealV1ABI } from '@/lib/contracts/abis';
import {
  MilestoneStatus,
  StandardV2OnChainMilestone,
  SettlementType,
  StandardV2ResolutionProposal,
} from '@/lib/deals/v2-deal';
import { formatUsdcAmount } from '@/lib/deals/v2';
import type { MutualSettlementProposalView } from '@/lib/deals/mutual-settlements-db';
import type { CanonicalResolutionReportV1 } from '@/lib/deals/v2-resolution-report';
import { useAuthSession } from '@/hooks/useAuthSession';

export interface MilestoneSettledSplitCardProps {
  dealAddress: string;
  milestone: StandardV2OnChainMilestone;
  clientAddress: string;
  freelancerAddress: string;
  currentUserAddress?: string;
  initialProposals?: MutualSettlementProposalView[];
  initialFinalReport?: CanonicalResolutionReportV1 | null;
  initialResolutionProposal?: StandardV2ResolutionProposal | null;
  className?: string;
}

function isSafeHttpUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  return /^https?:\/\/\S+/i.test(trimmed);
}

function isValidPayoutAmount(val: any): boolean {
  if (val === undefined || val === null || val === '') return false;
  if (typeof val === 'number') return !isNaN(val) && val >= 0;
  if (typeof val === 'string') return /^\d+$/.test(val.trim());
  if (typeof val === 'bigint') return val >= 0n;
  return false;
}

interface VerifiedSettlementLog {
  paidToFreelancer: bigint;
  refundedToClient: bigint;
  settlementType: number;
  transactionHash: string;
}

const V2_DEPLOYMENT_BLOCK = 11833190n;
const RPC_CHUNK_SIZE = 20000n;
const MAX_BACKWARD_CHUNKS = 25;

async function fetchMilestoneSettledLog(
  dealAddress: `0x${string}`,
  milestoneIndex: number
): Promise<VerifiedSettlementLog | null> {
  const parseLog = (log: any): VerifiedSettlementLog | null => {
    if (!log || !log.args) return null;
    const args = log.args as any;
    if (args.paidToFreelancer !== undefined && args.refundedToClient !== undefined) {
      return {
        paidToFreelancer: BigInt(args.paidToFreelancer),
        refundedToClient: BigInt(args.refundedToClient),
        settlementType: Number(args.settlementType),
        transactionHash: log.transactionHash,
      };
    }
    return null;
  };

  // Attempt 1: Direct query from V2 deployment block
  try {
    const logs = await sepoliaPublicClient.getLogs({
      address: dealAddress,
      abi: synqDealV1ABI,
      eventName: 'MilestoneSettled',
      args: {
        milestoneId: BigInt(milestoneIndex),
      },
      fromBlock: V2_DEPLOYMENT_BLOCK,
      toBlock: 'latest',
    });

    if (logs && logs.length > 0) {
      return parseLog(logs[logs.length - 1]);
    }
    return null;
  } catch (err: any) {
    const errStr = String(err?.message || err || '').toLowerCase();
    const isRangeError =
      errStr.includes('block range') ||
      errStr.includes('exceed') ||
      errStr.includes('limit') ||
      errStr.includes('-32005') ||
      errStr.includes('too many');

    if (!isRangeError) {
      console.warn('[MilestoneSettledSplitCard] on-chain log query error:', err);
      return null;
    }

    // Attempt 2: Bounded backwards chunking to avoid RPC block range limits
    try {
      const latestBlock = await sepoliaPublicClient.getBlockNumber();
      let currentTo = latestBlock;
      let chunksQueried = 0;

      while (currentTo >= V2_DEPLOYMENT_BLOCK && chunksQueried < MAX_BACKWARD_CHUNKS) {
        chunksQueried++;
        const currentFrom =
          currentTo > RPC_CHUNK_SIZE && currentTo - RPC_CHUNK_SIZE > V2_DEPLOYMENT_BLOCK
            ? currentTo - RPC_CHUNK_SIZE
            : V2_DEPLOYMENT_BLOCK;

        const chunkLogs = await sepoliaPublicClient.getLogs({
          address: dealAddress,
          abi: synqDealV1ABI,
          eventName: 'MilestoneSettled',
          args: {
            milestoneId: BigInt(milestoneIndex),
          },
          fromBlock: currentFrom,
          toBlock: currentTo,
        });

        if (chunkLogs && chunkLogs.length > 0) {
          return parseLog(chunkLogs[chunkLogs.length - 1]);
        }

        if (currentFrom <= V2_DEPLOYMENT_BLOCK) break;
        currentTo = currentFrom - 1n;
      }
    } catch (chunkErr) {
      console.warn('[MilestoneSettledSplitCard] bounded log query fallback error:', chunkErr);
    }

    return null;
  }
}

export function MilestoneSettledSplitCard({
  dealAddress,
  milestone,
  clientAddress,
  freelancerAddress,
  currentUserAddress,
  initialProposals,
  initialFinalReport,
  className,
}: MilestoneSettledSplitCardProps) {
  const { getToken } = useAuthSession();

  const [loading, setLoading] = useState<boolean>(true);
  const [settlementPath, setSettlementPath] = useState<'mutual' | 'committee' | 'unknown'>('unknown');
  const [freelancerPayout, setFreelancerPayout] = useState<bigint | null>(null);
  const [clientPayout, setClientPayout] = useState<bigint | null>(null);
  const [verifiedTxHash, setVerifiedTxHash] = useState<string | null>(null);
  const [report, setReport] = useState<CanonicalResolutionReportV1 | null>(initialFinalReport || null);
  const [showReportDrawer, setShowReportDrawer] = useState<boolean>(false);

  const queryGenerationRef = React.useRef<number>(0);

  const isFreelancer = Boolean(
    currentUserAddress && currentUserAddress.toLowerCase() === freelancerAddress.toLowerCase()
  );
  const isClient = Boolean(
    currentUserAddress && currentUserAddress.toLowerCase() === clientAddress.toLowerCase()
  );
  const isParticipant = isFreelancer || isClient;

  useEffect(() => {
    if (milestone.status !== MilestoneStatus.SettledSplit) {
      setLoading(false);
      return;
    }

    let isCancelled = false;
    const currentGeneration = ++queryGenerationRef.current;

    // Reset stale settlement values appropriately while a new lookup begins
    setLoading(true);
    setSettlementPath('unknown');
    setFreelancerPayout(null);
    setClientPayout(null);
    setVerifiedTxHash(null);
    setReport(initialFinalReport || null);

    async function execute() {
      let resolvedFl: bigint | null = null;
      let resolvedCl: bigint | null = null;
      let resolvedPath: 'mutual' | 'committee' | 'unknown' = 'unknown';
      let resolvedTx: string | null = null;
      let resolvedReport: CanonicalResolutionReportV1 | null = initialFinalReport || null;

      try {
        // 1. Check initial proposals if provided
        if (initialProposals && initialProposals.length > 0) {
          const exec = initialProposals.find(
            (p) => p.status === 'executed' && Number(p.milestoneId) === milestone.index
          );
          if (
            exec &&
            isValidPayoutAmount(exec.freelancerAmount) &&
            isValidPayoutAmount(exec.clientAmount)
          ) {
            try {
              const fl = BigInt(exec.freelancerAmount);
              const cl = BigInt(exec.clientAmount);
              if (fl + cl === milestone.amount) {
                resolvedFl = fl;
                resolvedCl = cl;
                resolvedPath = 'mutual';
                if (exec.executionTxHash) {
                  resolvedTx = exec.executionTxHash;
                }
              }
            } catch {}
          }
        }

        // 2. Check initial final report if provided
        if (
          resolvedPath === 'unknown' &&
          initialFinalReport &&
          initialFinalReport.phase === 'FINAL_RESOLUTION' &&
          isValidPayoutAmount(initialFinalReport.freelancerAmount) &&
          isValidPayoutAmount(initialFinalReport.clientAmount)
        ) {
          try {
            const fl = BigInt(initialFinalReport.freelancerAmount);
            const cl = BigInt(initialFinalReport.clientAmount);
            if (fl + cl === milestone.amount) {
              resolvedFl = fl;
              resolvedCl = cl;
              resolvedPath = 'committee';
              if ((initialFinalReport as any).txHash) {
                resolvedTx = (initialFinalReport as any).txHash;
              }
            }
          } catch {}
        }

        if (isCancelled || currentGeneration !== queryGenerationRef.current) return;

        // 3. Query canonical on-chain MilestoneSettled event (Authoritative EVM proof)
        // If we don't already have fully verified transaction data, query on-chain
        if (!resolvedTx && dealAddress && isAddress(dealAddress)) {
          const logData = await fetchMilestoneSettledLog(
            dealAddress as `0x${string}`,
            milestone.index
          );

          if (isCancelled || currentGeneration !== queryGenerationRef.current) return;

          if (logData && logData.paidToFreelancer + logData.refundedToClient === milestone.amount) {
            resolvedFl = logData.paidToFreelancer;
            resolvedCl = logData.refundedToClient;
            resolvedTx = logData.transactionHash;
            if (logData.settlementType === SettlementType.MutualSettlement) {
              resolvedPath = 'mutual';
            } else if (logData.settlementType === SettlementType.ResolverResolution) {
              resolvedPath = 'committee';
            }
          }
        }

        if (isCancelled || currentGeneration !== queryGenerationRef.current) return;

        // 4. Enrich with DB records if participant is authenticated
        if (isParticipant && dealAddress && isAddress(dealAddress)) {
          try {
            const token = await getToken();
            if (isCancelled || currentGeneration !== queryGenerationRef.current) return;
            const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

            // If executed proposal details needed
            if (resolvedPath === 'unknown') {
              try {
                const res = await fetch(
                  `/api/deals/${dealAddress}/milestones/${milestone.index}/settlements`,
                  { headers }
                );
                if (isCancelled || currentGeneration !== queryGenerationRef.current) return;
                if (res.ok) {
                  const data = await res.json();
                  if (data.proposals && Array.isArray(data.proposals)) {
                    const exec = data.proposals.find(
                      (p: any) => p.status === 'executed' && Number(p.milestoneId) === milestone.index
                    );
                    if (
                      exec &&
                      isValidPayoutAmount(exec.freelancerAmount) &&
                      isValidPayoutAmount(exec.clientAmount)
                    ) {
                      const fl = BigInt(exec.freelancerAmount);
                      const cl = BigInt(exec.clientAmount);
                      if (fl + cl === milestone.amount) {
                        if (resolvedFl === null) resolvedFl = fl;
                        if (resolvedCl === null) resolvedCl = cl;
                        resolvedPath = 'mutual';
                        if (!resolvedTx && exec.executionTxHash) {
                          resolvedTx = exec.executionTxHash;
                        }
                      }
                    }
                  }
                }
              } catch {}
            }

            if (isCancelled || currentGeneration !== queryGenerationRef.current) return;

            // If committee resolution report needed
            if (!resolvedReport && (resolvedPath === 'committee' || resolvedPath === 'unknown')) {
              try {
                const res = await fetch(
                  `/api/deals/${dealAddress}/milestones/${milestone.index}/resolution-reports?phase=FINAL_RESOLUTION`,
                  { headers }
                );
                if (isCancelled || currentGeneration !== queryGenerationRef.current) return;
                if (res.ok) {
                  const data = await res.json();
                  if (data.record?.row?.status === 'confirmed' && data.record?.report) {
                    const rep = data.record.report;
                    resolvedReport = rep;
                    if (resolvedPath === 'unknown') resolvedPath = 'committee';
                    if (!resolvedTx && data.record.row.txHash) {
                      resolvedTx = data.record.row.txHash;
                    }
                    if (
                      isValidPayoutAmount(rep.freelancerAmount) &&
                      isValidPayoutAmount(rep.clientAmount)
                    ) {
                      const fl = BigInt(rep.freelancerAmount);
                      const cl = BigInt(rep.clientAmount);
                      if (fl + cl === milestone.amount) {
                        if (resolvedFl === null) resolvedFl = fl;
                        if (resolvedCl === null) resolvedCl = cl;
                      }
                    }
                  }
                } else if (res.status === 404) {
                  const resInit = await fetch(
                    `/api/deals/${dealAddress}/milestones/${milestone.index}/resolution-reports?phase=INITIAL_RESOLUTION`,
                    { headers }
                  );
                  if (isCancelled || currentGeneration !== queryGenerationRef.current) return;
                  if (resInit.ok) {
                    const dataInit = await resInit.json();
                    if (dataInit.record?.row?.status === 'confirmed' && dataInit.record?.report) {
                      const repInit = dataInit.record.report;
                      resolvedReport = repInit;
                      if (resolvedPath === 'unknown') resolvedPath = 'committee';
                      if (
                        isValidPayoutAmount(repInit.freelancerAmount) &&
                        isValidPayoutAmount(repInit.clientAmount)
                      ) {
                        const fl = BigInt(repInit.freelancerAmount);
                        const cl = BigInt(repInit.clientAmount);
                        if (fl + cl === milestone.amount) {
                          if (resolvedFl === null) resolvedFl = fl;
                          if (resolvedCl === null) resolvedCl = cl;
                        }
                      }
                    }
                  }
                }
              } catch {}
            }
          } catch {}
        }
      } finally {
        if (!isCancelled && currentGeneration === queryGenerationRef.current) {
          setFreelancerPayout(resolvedFl);
          setClientPayout(resolvedCl);
          setSettlementPath(resolvedPath);
          setVerifiedTxHash(resolvedTx);
          setReport(resolvedReport);
          setLoading(false);
        }
      }
    }

    execute();

    return () => {
      isCancelled = true;
    };
  }, [
    dealAddress,
    milestone.index,
    milestone.amount,
    milestone.status,
    initialProposals,
    initialFinalReport,
    isParticipant,
    getToken,
  ]);

  // Only render for SettledSplit
  if (milestone.status !== MilestoneStatus.SettledSplit) {
    return null;
  }

  return (
    <div className={cn('rounded-lg border border-zinc-800 bg-[#141414] p-3.5 space-y-3', className)}>
      {/* Header: Settlement Type Label + View Transaction Link */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 pb-2.5">
        <div className="flex items-center gap-2">
          {settlementPath === 'mutual' ? (
            <>
              <Handshake className="h-4 w-4 text-emerald-400 shrink-0" />
              <span className="text-xs font-semibold text-emerald-400">
                Settled by Mutual Agreement
              </span>
            </>
          ) : settlementPath === 'committee' ? (
            <>
              <Scale className="h-4 w-4 text-purple-400 shrink-0" />
              <span className="text-xs font-semibold text-purple-300">
                Settled by Committee Resolution
              </span>
            </>
          ) : (
            <>
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
              <span className="text-xs font-semibold text-white">Settlement Finalized</span>
            </>
          )}
        </div>

        {verifiedTxHash && (
          <a
            href={`https://sepolia.etherscan.io/tx/${verifiedTxHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[11px] font-mono text-zinc-400 hover:text-white transition-colors"
          >
            <span>View Transaction</span>
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {/* Confirmed Payout Distribution Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs font-mono">
        {/* Original Milestone Escrow */}
        <div className="rounded-md border border-zinc-800/70 bg-[#1B1B1B] p-2.5 space-y-1">
          <div className="text-[10px] uppercase font-sans font-medium text-zinc-400">
            Original Milestone Escrow
          </div>
          <div className="font-bold text-white text-sm">
            {formatUsdcAmount(milestone.amount)} USDC
          </div>
        </div>

        {/* Freelancer Received */}
        <div className="rounded-md border border-zinc-800/70 bg-[#1B1B1B] p-2.5 space-y-1">
          <div className="flex items-center justify-between text-[10px] uppercase font-sans font-medium text-zinc-400">
            <span>Freelancer Received</span>
            {isFreelancer && (
              <Badge
                variant="outline"
                className="border-emerald-500/40 bg-emerald-500/10 text-[9px] text-emerald-400 font-sans py-0 px-1"
              >
                Your Payout
              </Badge>
            )}
          </div>
          <div className="font-bold text-white text-sm">
            {loading ? (
              <span className="text-xs text-zinc-500 font-sans flex items-center gap-1.5 font-normal">
                <Loader2 className="h-3 w-3 animate-spin text-emerald-400" />
                <span>Confirming…</span>
              </span>
            ) : freelancerPayout !== null ? (
              `${formatUsdcAmount(freelancerPayout)} USDC`
            ) : (
              <span className="text-xs text-zinc-500 font-sans font-normal">Unavailable</span>
            )}
          </div>
          {isFreelancer && freelancerPayout !== null && (
            <div className="text-[10px] text-emerald-400/90 font-sans">
              {freelancerPayout > 0n ? 'Disbursed to your wallet' : 'Zero payout allocated'}
            </div>
          )}
        </div>

        {/* Client Refunded */}
        <div className="rounded-md border border-zinc-800/70 bg-[#1B1B1B] p-2.5 space-y-1">
          <div className="flex items-center justify-between text-[10px] uppercase font-sans font-medium text-zinc-400">
            <span>Client Refunded</span>
            {isClient && (
              <Badge
                variant="outline"
                className="border-indigo-500/40 bg-indigo-500/10 text-[9px] text-indigo-400 font-sans py-0 px-1"
              >
                Your Refund
              </Badge>
            )}
          </div>
          <div className="font-bold text-white text-sm">
            {loading ? (
              <span className="text-xs text-zinc-500 font-sans flex items-center gap-1.5 font-normal">
                <Loader2 className="h-3 w-3 animate-spin text-indigo-400" />
                <span>Confirming…</span>
              </span>
            ) : clientPayout !== null ? (
              `${formatUsdcAmount(clientPayout)} USDC`
            ) : (
              <span className="text-xs text-zinc-500 font-sans font-normal">Unavailable</span>
            )}
          </div>
          {isClient && clientPayout !== null && (
            <div className="text-[10px] text-indigo-400/90 font-sans">
              {clientPayout > 0n ? 'Refunded to your wallet' : 'Zero refund allocated'}
            </div>
          )}
        </div>
      </div>

      {/* Missing Verified Payout State Notice */}
      {!loading && freelancerPayout === null && (
        <div className="text-[11px] text-zinc-400 flex items-center gap-1.5 bg-zinc-900/60 border border-zinc-800 rounded px-2.5 py-1.5">
          <Info className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
          <span>Payout details unavailable from verified logs. Original milestone escrow remains recorded.</span>
        </div>
      )}

      {/* Relevant Committee Report Access (Participant Only) */}
      {isParticipant && report && (
        <div className="pt-0.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setShowReportDrawer((prev) => !prev)}
            className="h-7 text-xs text-purple-300 hover:text-purple-100 hover:bg-purple-950/30 flex items-center gap-1.5 px-2"
          >
            <FileText className="h-3.5 w-3.5" />
            <span>
              {showReportDrawer
                ? 'Hide Committee Resolution Report'
                : 'View Committee Resolution Report'}
            </span>
            {showReportDrawer ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </Button>

          {showReportDrawer && (
            <div className="rounded-lg border border-zinc-800 bg-[#101010] p-3 mt-2 space-y-2 text-xs">
              <div className="flex items-center justify-between border-b border-zinc-800 pb-1.5">
                <span className="text-[11px] font-semibold text-zinc-300 flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5 text-purple-400" /> Resolution Report Record
                </span>
                <Badge
                  variant="outline"
                  className="border-purple-500/30 bg-purple-500/10 text-[10px] text-purple-300"
                >
                  Confirmed Binding Record
                </Badge>
              </div>

              {report.summary && (
                <div className="space-y-0.5">
                  <div className="text-[10px] uppercase font-semibold text-zinc-400">
                    Resolution Summary
                  </div>
                  <div className="rounded bg-zinc-950/70 p-2 text-zinc-200 border border-zinc-800/80 whitespace-pre-wrap leading-relaxed text-[11px]">
                    {report.summary}
                  </div>
                </div>
              )}

              {report.findings && (
                <div className="space-y-0.5">
                  <div className="text-[10px] uppercase font-semibold text-zinc-400">Findings</div>
                  <div className="rounded bg-zinc-950/70 p-2 text-zinc-200 border border-zinc-800/80 whitespace-pre-wrap leading-relaxed text-[11px]">
                    {report.findings}
                  </div>
                </div>
              )}

              {report.justification && (
                <div className="space-y-0.5">
                  <div className="text-[10px] uppercase font-semibold text-zinc-400">
                    Justification
                  </div>
                  <div className="rounded bg-zinc-950/70 p-2 text-zinc-200 border border-zinc-800/80 whitespace-pre-wrap leading-relaxed text-[11px]">
                    {report.justification}
                  </div>
                </div>
              )}

              {report.evidenceReferences && report.evidenceReferences.length > 0 && (
                <div className="space-y-1 pt-1">
                  <div className="text-[10px] uppercase font-semibold text-zinc-400">
                    Evidence References ({report.evidenceReferences.length})
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {report.evidenceReferences.map((ref: any, idx: number) => {
                      const safeUrl = isSafeHttpUrl(ref.url) ? ref.url.trim() : null;
                      const title = ref.title || ref.url || `Evidence Reference #${idx + 1}`;
                      const cardContent = (
                        <div className="space-y-0.5 truncate">
                          <div className="truncate font-medium text-white">{title}</div>
                          {ref.hash && (
                            <div
                              className="font-mono text-[9px] text-zinc-500 truncate"
                              title={ref.hash}
                            >
                              Hash: {ref.hash}
                            </div>
                          )}
                        </div>
                      );

                      return safeUrl ? (
                        <a
                          key={idx}
                          href={safeUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1 text-xs text-purple-300 hover:border-purple-500/40 transition-colors"
                        >
                          {cardContent}
                          <ExternalLink className="h-3 w-3 shrink-0 ml-1.5 opacity-70" />
                        </a>
                      ) : (
                        <div
                          key={idx}
                          className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1 text-xs text-zinc-300"
                        >
                          {cardContent}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
