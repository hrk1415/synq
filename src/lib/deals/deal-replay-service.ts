/**
 * Synq Historical Deal Replay Service (B.12.3.22)
 *
 * Implements bounded, resumable historical event replay for deal contracts
 * discovered behind an already-advanced scanner cursor.
 *
 * Requirements:
 * - Scans one deal contract at a time in bounded batches.
 * - Uses authoritative ABI for V2, V1, or Legacy Nexotiq.
 * - Begins at the verified contract creation/deployment block.
 * - Processes events in deterministic (blockNumber ASC, logIndex ASC) order.
 * - Advances durable progress watermark only after successful event persistence.
 * - Enqueues events idempotently into outbox (reusing canonical key derivation).
 * - Respects RPC batch limits and handles transient errors with bounded retries.
 * - Supports worker lease fencing (fences stale workers).
 * - Never rewinds or modifies the live scanner cursor (chain_sync_cursors).
 * - Never silently skips an unprocessed historical range.
 */

import { normalizeWallet } from '@/lib/utils';
import {
  type IDealReplayRepository,
  type DealReplayJob,
  type CreateReplayJobParams,
  getDealReplayRepository,
} from './deal-replay-db';
import {
  type IDealOutboxRepository,
  getDealOutboxRepository,
} from './outbox-db';
import {
  type ITrackedContractsRepository,
  getTrackedContractsRepository,
} from './tracked-contracts-db';
import {
  type IScannerRpcClient,
  type RawLog,
  decodeDealContractLog,
  persistDecodedEventToOutbox,
} from './chain-scanner';

export const DEFAULT_REPLAY_BATCH_SIZE = 100n;
export const DEFAULT_MAX_BATCHES_PER_RUN = 10;

export interface ReplayProcessResult {
  status: 'completed' | 'progressed' | 'fenced' | 'failed';
  jobId: string;
  fromBlock: bigint;
  toBlock: bigint;
  lastProcessedBlock: bigint | null;
  blocksProcessed: bigint;
  eventsProcessed: number;
  batchesRun: number;
  error?: string;
}

export interface ReplayBatchResult {
  jobsClaimed: number;
  jobsCompleted: number;
  jobsProgressed: number;
  jobsFailed: number;
  totalEventsProcessed: number;
  results: ReplayProcessResult[];
}

export class HistoricalDealReplayService {
  constructor(
    private rpcClient: IScannerRpcClient,
    private replayRepo: IDealReplayRepository = getDealReplayRepository(),
    private outboxRepo: IDealOutboxRepository = getDealOutboxRepository(),
    private trackedContractsRepo: ITrackedContractsRepository = getTrackedContractsRepository(),
    private maxBatchSize: bigint = DEFAULT_REPLAY_BATCH_SIZE,
    private workerId: string = 'replay-worker',
  ) {}

  /**
   * Durably schedules a replay job for a historical deal contract.
   * Idempotent: returns existing job if already created.
   */
  async scheduleReplay(params: CreateReplayJobParams): Promise<{ status: 'created' | 'exists'; job: DealReplayJob }> {
    return this.replayRepo.createJob(params);
  }

  /**
   * Processes a single claimed replay job in bounded batches.
   * Stops early if fenced, if target block reached, or if maxBatches reached.
   */
  async processJob(
    job: DealReplayJob,
    options?: { maxBatches?: number; maxBatchSize?: bigint },
  ): Promise<ReplayProcessResult> {
    if (!job.claimToken) {
      return {
        status: 'failed',
        jobId: job.id,
        fromBlock: job.fromBlock,
        toBlock: job.toBlock,
        lastProcessedBlock: job.lastProcessedBlock,
        blocksProcessed: 0n,
        eventsProcessed: 0,
        batchesRun: 0,
        error: 'Cannot process job: missing claim token (job must be claimed before execution)',
      };
    }

    const maxBatches = options?.maxBatches ?? DEFAULT_MAX_BATCHES_PER_RUN;
    const batchSize = options?.maxBatchSize ?? this.maxBatchSize;

    let totalBlocksProcessed = 0n;
    let totalEventsProcessed = 0;
    let batchesRun = 0;
    let currentLastProcessed = job.lastProcessedBlock;

    // Resolve buyer and seller for event payloads
    let buyer = '';
    let seller = '';
    try {
      const tracked = await this.trackedContractsRepo.get(job.chainId, job.contractAddress);
      if (tracked) {
        buyer = (tracked.metadata?.buyerWallet as string) || tracked.buyerWallet || '';
        seller = (tracked.metadata?.sellerWallet as string) || tracked.sellerWallet || '';
      }
    } catch {}

    while (batchesRun < maxBatches) {
      const batchFrom = currentLastProcessed !== null ? currentLastProcessed + 1n : job.fromBlock;

      // Check if replay is already complete
      if (batchFrom > job.toBlock) {
        const markResult = await this.replayRepo.markCompleted({
          id: job.id,
          claimToken: job.claimToken,
          finalProcessedBlock: job.toBlock,
        });

        if (!markResult.success) {
          return {
            status: 'fenced',
            jobId: job.id,
            fromBlock: job.fromBlock,
            toBlock: job.toBlock,
            lastProcessedBlock: currentLastProcessed,
            blocksProcessed: totalBlocksProcessed,
            eventsProcessed: totalEventsProcessed,
            batchesRun,
            error: markResult.error || 'Worker fenced: unable to mark completed',
          };
        }

        return {
          status: 'completed',
          jobId: job.id,
          fromBlock: job.fromBlock,
          toBlock: job.toBlock,
          lastProcessedBlock: job.toBlock,
          blocksProcessed: totalBlocksProcessed,
          eventsProcessed: totalEventsProcessed,
          batchesRun,
        };
      }

      const batchTo = batchFrom + batchSize - 1n <= job.toBlock ? batchFrom + batchSize - 1n : job.toBlock;

      // 1. Query RPC logs for target contract in bounded block range
      let rawLogs: RawLog[];
      try {
        rawLogs = await this.rpcClient.getLogs({
          address: job.contractAddress,
          fromBlock: batchFrom,
          toBlock: batchTo,
        });
      } catch (rpcErr: any) {
        const errMsg = rpcErr?.message || String(rpcErr);
        await this.replayRepo.markFailed({
          id: job.id,
          claimToken: job.claimToken,
          error: `RPC failure on range [${batchFrom}..${batchTo}]: ${errMsg}`,
          retryable: true,
        });

        return {
          status: 'failed',
          jobId: job.id,
          fromBlock: job.fromBlock,
          toBlock: job.toBlock,
          lastProcessedBlock: currentLastProcessed,
          blocksProcessed: totalBlocksProcessed,
          eventsProcessed: totalEventsProcessed,
          batchesRun,
          error: errMsg,
        };
      }

      // 2. Deterministically sort logs by blockNumber ASC, logIndex ASC
      const sortedLogs = [...rawLogs].sort((a, b) => {
        if (a.blockNumber < b.blockNumber) return -1;
        if (a.blockNumber > b.blockNumber) return 1;
        return a.logIndex - b.logIndex;
      });

      // 3. Decode logs using authoritative contract ABI generation
      let batchEventsCount = 0;
      for (const log of sortedLogs) {
        const decodedList = decodeDealContractLog({
          chainId: job.chainId,
          log,
          generation: job.generation,
          contractType: job.contractType,
          buyerWallet: buyer,
          sellerWallet: seller,
        });

        // 4. Persist each event idempotently into outbox
        for (const decoded of decodedList) {
          await persistDecodedEventToOutbox(this.outboxRepo, decoded);
          batchEventsCount++;
        }
      }

      totalEventsProcessed += batchEventsCount;
      const blocksInRange = batchTo - batchFrom + 1n;
      totalBlocksProcessed += blocksInRange;
      batchesRun++;

      // 5. Durably advance progress watermark
      const updateResult = await this.replayRepo.updateProgress({
        id: job.id,
        claimToken: job.claimToken,
        lastProcessedBlock: batchTo,
      });

      if (!updateResult.success) {
        return {
          status: 'fenced',
          jobId: job.id,
          fromBlock: job.fromBlock,
          toBlock: job.toBlock,
          lastProcessedBlock: currentLastProcessed,
          blocksProcessed: totalBlocksProcessed,
          eventsProcessed: totalEventsProcessed,
          batchesRun,
          error: updateResult.error || 'Worker fenced: lease lost or preempted',
        };
      }

      currentLastProcessed = batchTo;

      // 6. Check if target ceiling reached
      if (batchTo >= job.toBlock) {
        const markResult = await this.replayRepo.markCompleted({
          id: job.id,
          claimToken: job.claimToken,
          finalProcessedBlock: job.toBlock,
        });

        if (!markResult.success) {
          return {
            status: 'fenced',
            jobId: job.id,
            fromBlock: job.fromBlock,
            toBlock: job.toBlock,
            lastProcessedBlock: currentLastProcessed,
            blocksProcessed: totalBlocksProcessed,
            eventsProcessed: totalEventsProcessed,
            batchesRun,
            error: markResult.error || 'Worker fenced: unable to mark completed',
          };
        }

        return {
          status: 'completed',
          jobId: job.id,
          fromBlock: job.fromBlock,
          toBlock: job.toBlock,
          lastProcessedBlock: job.toBlock,
          blocksProcessed: totalBlocksProcessed,
          eventsProcessed: totalEventsProcessed,
          batchesRun,
        };
      }
    }

    return {
      status: 'progressed',
      jobId: job.id,
      fromBlock: job.fromBlock,
      toBlock: job.toBlock,
      lastProcessedBlock: currentLastProcessed,
      blocksProcessed: totalBlocksProcessed,
      eventsProcessed: totalEventsProcessed,
      batchesRun,
    };
  }

  /**
   * Claims and processes pending replay jobs in bounded batches.
   * Atomically leases jobs, executes progress, and handles retries.
   */
  async executeNextPendingJobs(options?: {
    chainId?: number;
    limit?: number;
    maxBatchesPerJob?: number;
  }): Promise<ReplayBatchResult> {
    const limit = options?.limit ?? 5;
    const maxBatchesPerJob = options?.maxBatchesPerJob ?? DEFAULT_MAX_BATCHES_PER_RUN;

    const claimedJobs = await this.replayRepo.claimPendingJobs({
      chainId: options?.chainId,
      limit,
      workerId: this.workerId,
    });

    const results: ReplayProcessResult[] = [];
    let jobsCompleted = 0;
    let jobsProgressed = 0;
    let jobsFailed = 0;
    let totalEventsProcessed = 0;

    for (const job of claimedJobs) {
      const res = await this.processJob(job, { maxBatches: maxBatchesPerJob });
      results.push(res);
      totalEventsProcessed += res.eventsProcessed;

      if (res.status === 'completed') {
        jobsCompleted++;
      } else if (res.status === 'progressed') {
        jobsProgressed++;
      } else if (res.status === 'failed' || res.status === 'fenced') {
        jobsFailed++;
      }
    }

    return {
      jobsClaimed: claimedJobs.length,
      jobsCompleted,
      jobsProgressed,
      jobsFailed,
      totalEventsProcessed,
      results,
    };
  }
}
