import { NextRequest } from 'next/server';
import {
  notifyBuyerDealConfirmed,
  notifyDealConfirmedToSeller,
  notifyBuyerWorkSubmitted,
  notifyFreelancerRevisionRequested,
  notifyBuyerDealCompleted,
  notifySellerDealCompleted,
  notifyDealCancelled,
  notifySellerPaymentReleased,
  notifyBuyerMilestoneRefunded,
  formatAppUrl,
  formatDealAmount,
  formatUsdcBaseUnits,
  type NotifyPayload,
} from '@/lib/notify';
import { getAuthenticatedWallet, unauthorized } from '@/lib/auth';
import { normalizeWallet } from '@/lib/utils';
import { sepoliaPublicClient } from '@/lib/chain';
import { nexotiqDealABI, synqDealV1ABI } from '@/lib/contracts/abis';
import { getDealProposalById, getDealProposalByDealAddress } from '@/lib/deals/proposals-db';
import { getMilestoneSubmissionRepository } from '@/lib/deals/submissions-db';
import {
  generateNotificationKey,
  generateCanonicalDealEventKey,
  getNotificationsRepository,
  NotificationPersistenceError,
  type NotificationClaimResult,
} from '@/lib/deals/notifications-db';
import { getDb } from '@/db';
import { milestoneSubmissions, milestoneResolutionReports, milestoneRevisions } from '@/db/schema';
import { and, eq, gt, desc } from 'drizzle-orm';
import { parseEventLogs, toEventSelector, decodeAbiParameters, parseAbiParameters } from 'viem';

/** Retained as an explicit tombstone; mail configuration is server-only. */
export async function GET() {
  return Response.json(
    { error: 'Notification configuration is not publicly available' },
    { status: 410 },
  );
}

const ALLOWED_CLIENT_EVENTS = new Set([
  'deal_confirmed',
  'work_submitted',
  'revision_requested',
  'deal_completed',
  'deal_completed_seller',
  'deal_cancelled',
  'payment_released',
  'milestone_refunded',
]);

export async function POST(req: NextRequest) {
  const authenticatedWallet = getAuthenticatedWallet(req);
  if (!authenticatedWallet) return unauthorized();

  try {
    const body = await req.json();
    const event = body.event as NotifyPayload['event'];

    if (!ALLOWED_CLIENT_EVENTS.has(event)) {
      return Response.json(
        { error: 'Unsupported or unverifiable event for client notification API' },
        { status: 400 },
      );
    }

    const fnMap: Record<string, (p: NotifyPayload) => Promise<any>> = {
      deal_confirmed: notifyBuyerDealConfirmed,
      work_submitted: notifyBuyerWorkSubmitted,
      revision_requested: notifyFreelancerRevisionRequested,
      deal_completed: notifyBuyerDealCompleted,
      deal_completed_seller: notifySellerDealCompleted,
      deal_cancelled: notifyDealCancelled,
      payment_released: notifySellerPaymentReleased,
      milestone_refunded: notifyBuyerMilestoneRefunded,
    };

    const fn = fnMap[event];
    if (!fn) {
      return Response.json({ error: 'Invalid event handler' }, { status: 400 });
    }

    const dealId = typeof body.dealId === 'string' ? body.dealId.trim() : '';
    if (!dealId) {
      return Response.json(
        { error: 'dealId is required for deal notification authorization' },
        { status: 400 },
      );
    }

    const rawMs = body.milestone !== undefined ? body.milestone : body.milestoneIndex;
    let milestoneIndex: number | undefined = undefined;
    if (rawMs !== undefined && rawMs !== null) {
      if (typeof rawMs === 'number' && Number.isInteger(rawMs) && rawMs >= 0) {
        milestoneIndex = rawMs;
      } else if (typeof rawMs === 'string' && /^\d+$/.test(rawMs.trim())) {
        milestoneIndex = parseInt(rawMs.trim(), 10);
      } else {
        return Response.json(
          { error: 'Invalid milestone index: must be a non-negative integer' },
          { status: 400 },
        );
      }
    }
    const txHash = typeof body.txHash === 'string' ? body.txHash.trim() : undefined;

    // 1. Authoritative verification of deal existence & participants
    let trustedBuyer: string | null = null;
    let trustedSeller: string | null = null;
    let trustedTitle: string | null = null;
    let trustedAmount: string | null = null;
    let trustedMilestoneCount: number | null = null;
    let onChainStatus: number | null = null;

    // Check deal proposals DB
    const proposal = await getDealProposalById(dealId).catch(() => null)
      || (dealId.startsWith('0x') ? await getDealProposalByDealAddress(dealId).catch(() => null) : null);

    const isMilestoneSpecificEvent = (
      event === 'work_submitted' ||
      event === 'revision_requested' ||
      event === 'payment_released' ||
      event === 'milestone_refunded' ||
      event === 'mutual_settlement_proposed' ||
      event === 'mutual_settlement_executed'
    );

    if (proposal) {
      trustedBuyer = normalizeWallet(proposal.clientWallet);
      trustedSeller = normalizeWallet(proposal.freelancerWallet);
      trustedTitle = proposal.title || null;
      trustedMilestoneCount = Array.isArray(proposal.milestones) ? proposal.milestones.length : null;
      let rawProposalAmount: string | null = null;
      if (isMilestoneSpecificEvent && milestoneIndex !== undefined && Array.isArray(proposal.milestones) && proposal.milestones[milestoneIndex]?.amount) {
        rawProposalAmount = proposal.milestones[milestoneIndex].amount;
      } else {
        rawProposalAmount = proposal.totalAmount || null;
      }
      trustedAmount = rawProposalAmount ? formatUsdcBaseUnits(rawProposalAmount) : null;
    } else if (/^0x[0-9a-fA-F]{40}$/.test(dealId)) {
      // Check on-chain deal contract on Sepolia
      try {
        const [buyer, seller, title, totalValue, status, msCount] = await Promise.all([
          sepoliaPublicClient.readContract({
            address: dealId as `0x${string}`,
            abi: nexotiqDealABI,
            functionName: 'buyer',
          }).catch(() =>
            sepoliaPublicClient.readContract({
              address: dealId as `0x${string}`,
              abi: synqDealV1ABI,
              functionName: 'client',
            }).catch(() => null)
          ),
          sepoliaPublicClient.readContract({
            address: dealId as `0x${string}`,
            abi: nexotiqDealABI,
            functionName: 'seller',
          }).catch(() =>
            sepoliaPublicClient.readContract({
              address: dealId as `0x${string}`,
              abi: synqDealV1ABI,
              functionName: 'freelancer',
            }).catch(() => null)
          ),
          sepoliaPublicClient.readContract({
            address: dealId as `0x${string}`,
            abi: nexotiqDealABI,
            functionName: 'title',
          }).catch(() => null),
          sepoliaPublicClient.readContract({
            address: dealId as `0x${string}`,
            abi: nexotiqDealABI,
            functionName: 'totalValue',
          }).catch(() =>
            sepoliaPublicClient.readContract({
              address: dealId as `0x${string}`,
              abi: synqDealV1ABI,
              functionName: 'totalEscrow',
            }).catch(() => null)
          ),
          sepoliaPublicClient.readContract({
            address: dealId as `0x${string}`,
            abi: nexotiqDealABI,
            functionName: 'status',
          }).catch(() =>
            sepoliaPublicClient.readContract({
              address: dealId as `0x${string}`,
              abi: synqDealV1ABI,
              functionName: 'state',
            }).catch(() => null)
          ),
          sepoliaPublicClient.readContract({
            address: dealId as `0x${string}`,
            abi: synqDealV1ABI,
            functionName: 'milestoneCount',
          }).catch(() =>
            sepoliaPublicClient.readContract({
              address: dealId as `0x${string}`,
              abi: nexotiqDealABI,
              functionName: 'getMilestoneCount',
            }).catch(() => null)
          ),
        ]);

        if (buyer && seller) {
          trustedBuyer = normalizeWallet(buyer as string);
          trustedSeller = normalizeWallet(seller as string);
          if (title) trustedTitle = String(title);
          if (totalValue !== null && totalValue !== undefined) {
            trustedAmount = formatUsdcBaseUnits(totalValue as bigint);
          }
          if (status !== null && status !== undefined) onChainStatus = Number(status);
          if (msCount !== null && msCount !== undefined) trustedMilestoneCount = Number(msCount);
        }
      } catch {
        // Contract not readable
      }
    }

    // Fail closed: if neither proposal database nor on-chain contract can verify participants
    if (!trustedBuyer || !trustedSeller) {
      return Response.json(
        { error: 'Cannot verify deal existence or participant authorization' },
        { status: 400 },
      );
    }

    // Validate milestone index boundary against actual milestone count
    if (event === 'work_submitted' || event === 'revision_requested') {
      if (milestoneIndex === undefined) {
        return Response.json(
          { error: `Milestone index is required for '${event}' notifications` },
          { status: 400 },
        );
      }
      if (trustedMilestoneCount !== null && milestoneIndex >= trustedMilestoneCount) {
        return Response.json(
          { error: `Milestone index ${milestoneIndex} is out of bounds (deal has ${trustedMilestoneCount} milestone${trustedMilestoneCount === 1 ? '' : 's'})` },
          { status: 400 },
        );
      }
    } else if (milestoneIndex !== undefined && trustedMilestoneCount !== null && milestoneIndex >= trustedMilestoneCount) {
      return Response.json(
        { error: `Milestone index ${milestoneIndex} is out of bounds (deal has ${trustedMilestoneCount} milestone${trustedMilestoneCount === 1 ? '' : 's'})` },
        { status: 400 },
      );
    }

    // 2. Authorize requester against trusted deal participants
    const authWallet = normalizeWallet(authenticatedWallet);
    const isBuyer = authWallet === trustedBuyer;
    const isSeller = authWallet === trustedSeller;

    if (!isBuyer && !isSeller) {
      return Response.json(
        { error: 'Forbidden: Authenticated wallet is not a participant of this deal' },
        { status: 403 },
      );
    }

    // 3. Enforce strict role-to-event rules
    if (event === 'deal_confirmed' && !isBuyer && !isSeller) {
      return Response.json(
        { error: 'Forbidden: Authenticated wallet is not a participant of this deal' },
        { status: 403 },
      );
    }

    if (event === 'work_submitted' && !isSeller) {
      return Response.json(
        { error: 'Forbidden: Only the seller can dispatch work_submitted notifications' },
        { status: 403 },
      );
    }

    if (event === 'payment_released' && !isBuyer) {
      return Response.json(
        { error: 'Forbidden: Only the buyer can dispatch payment_released notifications' },
        { status: 403 },
      );
    }

    if (event === 'revision_requested' && !isBuyer) {
      return Response.json(
        { error: 'Forbidden: Only the buyer can dispatch revision_requested notifications' },
        { status: 403 },
      );
    }

    // 4. Verify Event Authenticity
    let eventVerified = false;
    let verifiedLogIndex: number | undefined = undefined;
    let verifiedSubmissionVersion: number | undefined = undefined;
    let verifiedTxHash: string | undefined = undefined;
    const targetDealAddress = (proposal?.dealAddress || (dealId.startsWith('0x') ? dealId : '')).toLowerCase();

    if (event === 'deal_confirmed') {
      if (proposal && (proposal.cachedStatus === 'ACCEPTED' || proposal.acceptedTxHash)) {
        eventVerified = true;
      } else if (onChainStatus === 1 || onChainStatus === 2) {
        // Active or Completed on-chain
        eventVerified = true;
      }
    } else if (event === 'work_submitted') {
      // Must verify confirmed deliverable submission against authoritative persisted DB or on-chain state.
      // 1. Authoritative check: persisted milestoneSubmissions record in database / repository
      try {
        const subRepo = getMilestoneSubmissionRepository();
        const sub = await subRepo.getLatestConfirmed(
          targetDealAddress || dealId,
          trustedSeller,
          milestoneIndex
        );

        if (sub) {
          eventVerified = true;
          verifiedSubmissionVersion = sub.version;
          if (sub.txHash) {
            verifiedTxHash = sub.txHash;
          }
          if (!body.evidence && sub.manifest) {
            const manifestObj = sub.manifest as any;
            body.evidence = typeof manifestObj.summary === 'string'
              ? manifestObj.summary
              : (Array.isArray(manifestObj.links) && manifestObj.links[0] ? String(manifestObj.links[0]) : undefined);
          }
        }
      } catch {}

      // 2. Authoritative check: on-chain milestone status on deployed deal contract (Submitted=2 or higher)
      if (!eventVerified && targetDealAddress) {
        try {
          const msIdx = milestoneIndex !== undefined ? BigInt(milestoneIndex) : 0n;
          try {
            const msV1 = await sepoliaPublicClient.readContract({
              address: targetDealAddress as `0x${string}`,
              abi: synqDealV1ABI,
              functionName: 'getMilestone',
              args: [msIdx],
            });
            if (msV1 && Number((msV1 as any).status) >= 2) {
              eventVerified = true;
              if (Number((msV1 as any).version) > 0) {
                verifiedSubmissionVersion = Number((msV1 as any).version);
              }
            }
          } catch {
            const ms = await sepoliaPublicClient.readContract({
              address: targetDealAddress as `0x${string}`,
              abi: nexotiqDealABI,
              functionName: 'milestones',
              args: [msIdx],
            });
            if (ms && Number((ms as any)[3] ?? (ms as any).msStatus) >= 2) {
              eventVerified = true;
            }
          }
        } catch {}
      }

      // 3. Authoritative check: on-chain transaction receipt contains MilestoneSubmitted log
      if (!eventVerified && txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash) && targetDealAddress) {
        try {
          const receipt = await sepoliaPublicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
          if (receipt && receipt.status === 'success') {
            const milestoneSubmittedSelector = toEventSelector('MilestoneSubmitted(uint256,bytes32,bytes32,uint8)');
            const matchingSubmissionLog = receipt.logs.find(
              (l) => l.address.toLowerCase() === targetDealAddress &&
                     l.topics[0] === milestoneSubmittedSelector &&
                     (milestoneIndex === undefined || Number(BigInt(l.topics[1] || '0')) === milestoneIndex)
            );
            if (matchingSubmissionLog) {
              eventVerified = true;
              verifiedTxHash = txHash.toLowerCase();
              if (matchingSubmissionLog.logIndex !== undefined) {
                verifiedLogIndex = Number(matchingSubmissionLog.logIndex);
              }
              try {
                const [, ver] = decodeAbiParameters(
                  parseAbiParameters('bytes32 specHash, uint8 version'),
                  matchingSubmissionLog.data
                );
                if (ver !== undefined) {
                  verifiedSubmissionVersion = Number(ver);
                }
              } catch {}
            }
          }
        } catch {}
      }
    } else if (event === 'revision_requested') {
      // Must verify confirmed revision request from milestone_revisions table
      try {
        const db = getDb();
        const conditions = [
          eq(milestoneRevisions.dealAddress, targetDealAddress || dealId.toLowerCase()),
          eq(milestoneRevisions.clientWallet, trustedBuyer),
          eq(milestoneRevisions.status, 'confirmed'),
        ];
        if (milestoneIndex !== undefined) {
          conditions.push(eq(milestoneRevisions.milestoneId, milestoneIndex));
        }
        if (verifiedSubmissionVersion !== undefined) {
          conditions.push(eq(milestoneRevisions.submissionVersion, verifiedSubmissionVersion));
        }
        const revs = await db
          .select()
          .from(milestoneRevisions)
          .where(and(...conditions))
          .orderBy(desc(milestoneRevisions.submissionVersion))
          .limit(1);
        if (revs.length > 0) {
          eventVerified = true;
          verifiedSubmissionVersion = revs[0].submissionVersion;
          if (!body.evidence && revs[0].manifest && (revs[0].manifest as any).feedback) {
            body.evidence = String((revs[0].manifest as any).feedback);
          }
        }
      } catch {}

      // On-chain check: if deal contract address is queried, check milestone status (msStatus === 4 = RevisionRequested or on-chain state)
      if (!eventVerified && /^0x[0-9a-fA-F]{40}$/.test(dealId)) {
        try {
          const msIdx = milestoneIndex !== undefined ? BigInt(milestoneIndex) : 0n;
          const ms = await sepoliaPublicClient.readContract({
            address: dealId as `0x${string}`,
            abi: nexotiqDealABI,
            functionName: 'milestones',
            args: [msIdx],
          });
          // RevisionRequested status on ISynqDeal is 4 (Pending=0, InProgress=1, Completed=2, Approved=3, RevisionRequested=4)
          if (ms && Number((ms as any)[3] ?? (ms as any).msStatus) === 4) {
            eventVerified = true;
          }
        } catch {}
      }

      // If txHash is provided, verify on-chain receipt contains RevisionRequested event
      if (!eventVerified && txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        try {
          const receipt = await sepoliaPublicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
          if (receipt && receipt.status === 'success') {
            const revisionRequestedSelector = toEventSelector('RevisionRequested(uint256,bytes32,uint64,uint8)');
            const matchingRevLog = receipt.logs.find(
              (l) => (!targetDealAddress || l.address.toLowerCase() === targetDealAddress) &&
                     l.topics[0] === revisionRequestedSelector
            );
            if (matchingRevLog) {
              eventVerified = true;
              if (verifiedLogIndex === undefined && (matchingRevLog as any).logIndex !== undefined) {
                verifiedLogIndex = Number((matchingRevLog as any).logIndex);
              }
            }
          }
        } catch {}
      }
    } else if (event === 'payment_released') {
      // STRICT REQUIREMENT (B.12.2.3):
      // - Do NOT treat an ACTIVE proposal as proof of payment.
      // - Do NOT treat a generic transaction hash as proof.
      // - Verify a confirmed settlement state or the correct contract event.
      // - Match chain ID, contract address, milestone, recipient, and transaction details.
      // - Reject unverifiable claims.

      // 1. Transaction receipt verification (if txHash provided)
      if (txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        try {
          const receipt = await sepoliaPublicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
          if (receipt && receipt.status === 'success') {
            const matchesDealContract =
              (receipt.to && targetDealAddress && receipt.to.toLowerCase() === targetDealAddress) ||
              receipt.logs.some((l) => targetDealAddress && l.address.toLowerCase() === targetDealAddress);

            if (matchesDealContract) {
              const relevantLogs = targetDealAddress
                ? receipt.logs.filter((l) => l.address.toLowerCase() === targetDealAddress)
                : receipt.logs;

              const parsedLogs = parseEventLogs({
                abi: nexotiqDealABI,
                logs: relevantLogs,
              }) as any[];

              for (const log of parsedLogs) {
                if (log.eventName === 'PaymentReleased') {
                  const msMatches = milestoneIndex === undefined || Number(log.args?.milestoneId) === milestoneIndex;
                  const recipMatches = !trustedSeller || (String(log.args?.to || '').toLowerCase() === trustedSeller);
                  if (msMatches && recipMatches) {
                    eventVerified = true;
                    if (verifiedLogIndex === undefined && (log as any).logIndex !== undefined) {
                      verifiedLogIndex = Number((log as any).logIndex);
                    }
                    break;
                  }
                } else if (log.eventName === 'MilestoneApproved') {
                  const msMatches = milestoneIndex === undefined || Number(log.args?.milestoneId) === milestoneIndex;
                  if (msMatches) {
                    eventVerified = true;
                    if (verifiedLogIndex === undefined && (log as any).logIndex !== undefined) {
                      verifiedLogIndex = Number((log as any).logIndex);
                    }
                    break;
                  }
                }
              }

              // Also check ISynqDeal MilestoneSettled event
              if (!eventVerified) {
                const milestoneSettledSelector = toEventSelector('MilestoneSettled(uint256,uint256,uint256,uint8)');
                const matchingSettledLog = relevantLogs.find(
                  (l) => l.topics[0] === milestoneSettledSelector &&
                         (milestoneIndex === undefined || Number(BigInt(l.topics[1] || '0')) === milestoneIndex)
                );
                if (matchingSettledLog) {
                  eventVerified = true;
                  if (verifiedLogIndex === undefined && (matchingSettledLog as any).logIndex !== undefined) {
                    verifiedLogIndex = Number((matchingSettledLog as any).logIndex);
                  }
                }
              }
            }
          }
        } catch {
          // RPC or receipt lookup failed
        }
      }

      // 2. On-chain contract state verification (if contract exists and txHash was not provided or failed)
      if (!eventVerified && /^0x[0-9a-fA-F]{40}$/.test(dealId)) {
        try {
          if (milestoneIndex !== undefined) {
            const ms = await sepoliaPublicClient.readContract({
              address: dealId as `0x${string}`,
              abi: nexotiqDealABI,
              functionName: 'milestones',
              args: [BigInt(milestoneIndex)],
            });
            // ms[3] is msStatus: Approved = 3
            if (ms && Number((ms as any)[3] ?? (ms as any).msStatus) === 3) {
              eventVerified = true;
            }
          } else if (onChainStatus === 2) {
            // Overall deal is Completed on-chain
            eventVerified = true;
          }
        } catch {}
      }

      // 3. Off-chain proposal settlement verification (must be explicitly completed or settled milestone, never merely ACCEPTED)
      if (!eventVerified && proposal) {
        if (proposal.cachedStatus === 'COMPLETED') {
          eventVerified = true;
        } else if (milestoneIndex !== undefined && Array.isArray(proposal.milestones)) {
          const ms = (proposal.milestones as any[])[milestoneIndex];
          if (ms && (ms.settled === true || ms.status === 'approved' || ms.status === 'settled' || ms.paidTxHash)) {
            eventVerified = true;
          }
        } else {
          // Check milestoneResolutionReports for confirmed final resolution
          try {
            const db = getDb();
            const conditions = [
              eq(milestoneResolutionReports.dealAddress, targetDealAddress || dealId.toLowerCase()),
              eq(milestoneResolutionReports.status, 'confirmed'),
            ];
            if (milestoneIndex !== undefined) {
              conditions.push(eq(milestoneResolutionReports.milestoneId, milestoneIndex));
            }
            const reports = await db
              .select()
              .from(milestoneResolutionReports)
              .where(and(...conditions))
              .limit(1);
            if (reports.length > 0) {
              eventVerified = true;
            }
          } catch {}
        }
      }
    } else if (event === 'deal_completed' || event === 'deal_completed_seller') {
      if (txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        try {
          const receipt = await sepoliaPublicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
          if (receipt && receipt.status === 'success' && targetDealAddress) {
            const dealCompletedSelectorA = toEventSelector('DealCompleted(address)');
            const dealCompletedSelectorB = toEventSelector('DealCompleted(uint256)');
            const matchingLog = receipt.logs.find(
              (l) => l.address.toLowerCase() === targetDealAddress &&
                     (l.topics[0] === dealCompletedSelectorA || l.topics[0] === dealCompletedSelectorB)
            );
            if (matchingLog) {
              eventVerified = true;
              if (verifiedLogIndex === undefined && (matchingLog as any).logIndex !== undefined) {
                verifiedLogIndex = Number((matchingLog as any).logIndex);
              }
            }
          }
        } catch {}
      }
      if (!txHash) {
        if (!eventVerified && proposal && proposal.cachedStatus === 'COMPLETED') {
          eventVerified = true;
        } else if (!eventVerified && onChainStatus === 2) {
          eventVerified = true;
        }
      }
    } else if (event === 'deal_cancelled') {
      if (txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        try {
          const receipt = await sepoliaPublicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
          if (receipt && receipt.status === 'success' && targetDealAddress) {
            const dealCancelledSelectorA = toEventSelector('DealCancelled(address)');
            const dealCancelledSelectorB = toEventSelector('DealCancelled(uint256)');
            const matchingLog = receipt.logs.find(
              (l) => l.address.toLowerCase() === targetDealAddress &&
                     (l.topics[0] === dealCancelledSelectorA || l.topics[0] === dealCancelledSelectorB)
            );
            if (matchingLog) {
              eventVerified = true;
              if (verifiedLogIndex === undefined && (matchingLog as any).logIndex !== undefined) {
                verifiedLogIndex = Number((matchingLog as any).logIndex);
              }
            }
          }
        } catch {}
      }
      if (!txHash) {
        if (!eventVerified && proposal && (proposal.cachedStatus === 'CANCELLED' || proposal.cancelledTxHash)) {
          eventVerified = true;
        } else if (!eventVerified && onChainStatus === 4) {
          eventVerified = true;
        }
      }
    } else if (event === 'milestone_refunded') {
      if (txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        try {
          const receipt = await sepoliaPublicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
          if (receipt && receipt.status === 'success' && targetDealAddress) {
            const milestoneSettledSelector = toEventSelector('MilestoneSettled(uint256,uint256,uint256,uint8)');
            const dealTerminatedSelector = toEventSelector('DealTerminatedEarly(address,uint256)');
            const matchingLog = receipt.logs.find((l) => {
              if (l.address.toLowerCase() !== targetDealAddress) return false;
              if (l.topics[0] === milestoneSettledSelector) {
                if (milestoneIndex !== undefined && Number(BigInt(l.topics[1] || '0')) !== milestoneIndex) {
                  return false;
                }
                try {
                  const [paid, refunded] = decodeAbiParameters(
                    parseAbiParameters('uint256 paidToFreelancer, uint256 refundedToClient, uint8 settlementType'),
                    l.data
                  );
                  return refunded > 0n;
                } catch {
                  return false;
                }
              }
              if (l.topics[0] === dealTerminatedSelector) {
                try {
                  const [refunded] = decodeAbiParameters(
                    parseAbiParameters('uint256 refundedToClient'),
                    l.data
                  );
                  return refunded > 0n;
                } catch {
                  return false;
                }
              }
              return false;
            });

            if (matchingLog) {
              eventVerified = true;
              if (verifiedLogIndex === undefined && (matchingLog as any).logIndex !== undefined) {
                verifiedLogIndex = Number((matchingLog as any).logIndex);
              }
            }
          }
        } catch {}
      }
      if (!txHash) {
        try {
          const db = getDb();
          const conditions = [
            eq(milestoneResolutionReports.dealAddress, targetDealAddress || dealId.toLowerCase()),
            eq(milestoneResolutionReports.status, 'confirmed'),
            gt(milestoneResolutionReports.clientAmount, '0'),
          ];
          if (milestoneIndex !== undefined) {
            conditions.push(eq(milestoneResolutionReports.milestoneId, milestoneIndex));
          }
          const reports = await db
            .select()
            .from(milestoneResolutionReports)
            .where(and(...conditions))
            .limit(1);
          if (reports.length > 0) {
            eventVerified = true;
          }
        } catch {}

        if (!eventVerified && proposal && milestoneIndex !== undefined && Array.isArray(proposal.milestones)) {
          const ms = (proposal.milestones as any[])[milestoneIndex];
          if (ms && (ms.status === 'refunded' || ms.refunded === true || ms.refundedTxHash)) {
            eventVerified = true;
          }
        }
      }
    }

    if (!eventVerified) {
      return Response.json(
        { error: `Claimed event '${event}' could not be verified against deal state` },
        { status: 400 },
      );
    }

    // 5. Derive recipient from trusted deal data
    let trustedRecipient: string;
    let recipientRole: 'buyer' | 'seller';

    if (event === 'payment_released' || event === 'deal_completed_seller' || event === 'revision_requested') {
      trustedRecipient = trustedSeller;
      recipientRole = 'seller';
    } else if (event === 'deal_confirmed' || event === 'work_submitted' || event === 'deal_completed' || event === 'milestone_refunded') {
      trustedRecipient = trustedBuyer;
      recipientRole = 'buyer';
    } else {
      // deal_cancelled: notify counterparty
      trustedRecipient = isBuyer ? trustedSeller : trustedBuyer;
      recipientRole = isBuyer ? 'seller' : 'buyer';
    }

    // 6. Deduplication & Idempotency Key
    const notifRepo = getNotificationsRepository();
    const eventKey = generateCanonicalDealEventKey({
      chainId: 11155111,
      dealId: targetDealAddress || dealId,
      contractAddress: targetDealAddress || (dealId.startsWith('0x') ? dealId : undefined),
      event,
      milestoneIndex,
      submissionVersion: verifiedSubmissionVersion,
      txHash: verifiedTxHash,
      logIndex: verifiedLogIndex,
      recipientRole,
      includeLogIndex: verifiedLogIndex !== undefined,
    });

    let claimStatus: NotificationClaimResult;
    try {
      claimStatus = await notifRepo.claimPending(
        eventKey,
        {
          dealId,
          event,
          recipientWallet: trustedRecipient,
        },
        { fenced: true },
      );
    } catch (err: any) {
      if (err instanceof NotificationPersistenceError) {
        console.error('[Notify] Durable persistence unavailable:', err.message);
        return Response.json(
          { error: 'Durable notification deduplication is unavailable; email dispatch aborted' },
          { status: 503 },
        );
      }
      throw err;
    }

    if (claimStatus.status === 'duplicate_delivered' || String(claimStatus) === 'duplicate_delivered') {
      return Response.json({
        messageId: 'duplicate-skipped',
        mode: 'skipped',
        skipped: true,
        reason: 'Notification already delivered for this event',
        recipientResolved: true,
      });
    }

    if (claimStatus.status === 'duplicate_pending' || String(claimStatus) === 'duplicate_pending') {
      return Response.json(
        { error: 'Conflict: notification delivery is currently in-flight for this event' },
        { status: 409 },
      );
    }

    // 7. Sanitize links to canonical origin
    const validatedLink = body.link ? formatAppUrl(String(body.link)) : undefined;

    const payload: NotifyPayload = {
      event,
      dealId,
      recipientWallet: trustedRecipient,
      recipientName: recipientRole,
      freelancerWallet: trustedSeller,
      counterpartyWallet: isBuyer ? trustedSeller : trustedBuyer,
      dealTitle: trustedTitle || (body.dealTitle ? String(body.dealTitle).slice(0, 100) : 'Untitled deal'),
      dealAmount: trustedAmount || (body.dealAmount ? formatDealAmount(String(body.dealAmount).slice(0, 50)) : ''),
      note: body.note ? String(body.note).slice(0, 500) : undefined,
      evidence: body.evidence ? String(body.evidence).slice(0, 500) : undefined,
      link: validatedLink,
    };

    const result = await fn(payload);

    // 8. Update delivery status in notifications repository
    try {
      if (result.deliveryStatus === 'log_only' || result.mode === 'log') {
        await notifRepo.markDeferred(
          eventKey,
          result.error || 'SMTP delivery disabled (log-only mode)',
          claimStatus.claimToken,
        );
      } else if (result.deliveryStatus === 'permanent_fail') {
        await notifRepo.markFailed(eventKey, result.error || 'Permanent delivery failure', claimStatus.claimToken);
      } else if (result.error || result.deliveryStatus === 'retryable_fail') {
        await notifRepo.markFailed(eventKey, result.error || 'Transient delivery failure', claimStatus.claimToken);
      } else if (result.mode === 'skipped' || result.skipped) {
        await notifRepo.markSkipped(eventKey, result.reason || 'Notification skipped', claimStatus.claimToken);
      } else if (result.deliveryStatus === 'delivered' || (result.mode === 'smtp' && !result.error)) {
        await notifRepo.markDelivered(eventKey, result.messageId, result.to, claimStatus.claimToken);
      } else {
        await notifRepo.markFailed(eventKey, 'Unknown delivery result', claimStatus.claimToken);
      }
    } catch (dbErr: any) {
      console.error('[Notify] Failed to update durable delivery status:', dbErr?.message || dbErr);
    }

    if (result.deliveryStatus === 'log_only' || result.mode === 'log') {
      return Response.json({
        ...result,
        deferred: true,
        message: 'SMTP delivery is not configured (log-only mode). Notification is recorded and deferred.',
      });
    }

    return Response.json(result);
  } catch (err: any) {
    if (err instanceof NotificationPersistenceError) {
      return Response.json(
        { error: 'Durable notification deduplication is unavailable; email dispatch aborted' },
        { status: 503 },
      );
    }
    return Response.json({ error: 'Notification delivery failed' }, { status: 500 });
  }
}
