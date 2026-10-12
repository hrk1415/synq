/**
 * SYNQ — Historical Deal Replay Cron Endpoint (B.12.3.22)
 *
 * Dormant, authenticated entry point for scheduled or triggered historical deal replay.
 * Worker Safety Guarantees:
 * - Disabled by default via ENABLE_DEAL_REPLAY_WORKER=true.
 * - Authenticated via CRON_SECRET using constant-time comparison.
 * - Rejects unauthenticated and missing secret requests.
 * - Strict execution limits (batch sizes, max jobs, bounded retries).
 * - POST-only (GET returns 405).
 * - Never modifies or rewinds the live scanner cursor.
 */

import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { sepoliaPublicClient } from '@/lib/chain';
import { type IScannerRpcClient } from '@/lib/deals/chain-scanner';
import { getDealReplayRepository } from '@/lib/deals/deal-replay-db';
import { getDealOutboxRepository } from '@/lib/deals/outbox-db';
import { getTrackedContractsRepository } from '@/lib/deals/tracked-contracts-db';
import { HistoricalDealReplayService } from '@/lib/deals/deal-replay-service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Retained as an explicit tombstone; cron trigger is POST-only. */
export async function GET() {
  return Response.json(
    { error: 'Replay cron endpoint is POST-only' },
    { status: 405 },
  );
}

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.trim() === '') {
    return false;
  }

  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return false;
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest();
  const secretHash = crypto.createHash('sha256').update(secret.trim()).digest();
  return crypto.timingSafeEqual(tokenHash, secretHash);
}

/** Adapts viem sepoliaPublicClient to the scanner IScannerRpcClient interface */
function createViemScannerRpcClient(): IScannerRpcClient {
  return {
    async getBlockNumber(): Promise<bigint> {
      return sepoliaPublicClient.getBlockNumber();
    },
    async getBlock(params: { blockNumber: bigint }): Promise<{ hash: string; parentHash: string }> {
      const block = await sepoliaPublicClient.getBlock({ blockNumber: params.blockNumber });
      return {
        hash: block.hash,
        parentHash: block.parentHash,
      };
    },
    async getLogs(params: {
      address?: string | string[];
      fromBlock: bigint;
      toBlock: bigint;
    }): Promise<any[]> {
      const rawLogs = await sepoliaPublicClient.getLogs({
        address: params.address as any,
        fromBlock: params.fromBlock,
        toBlock: params.toBlock,
      });
      return rawLogs.map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: l.blockNumber,
        blockHash: l.blockHash,
        transactionHash: l.transactionHash,
        transactionIndex: l.transactionIndex,
        logIndex: l.logIndex,
      }));
    },
  };
}

export async function POST(req: NextRequest) {
  // 1. Authenticate with CRON_SECRET using constant-time comparison
  const configuredSecret = process.env.CRON_SECRET;
  if (!configuredSecret || configuredSecret.trim() === '') {
    return Response.json(
      { error: 'CRON_SECRET is not configured on the server' },
      { status: 503 },
    );
  }

  if (!verifyCronSecret(req)) {
    return Response.json(
      { error: 'Unauthorized: Invalid or missing authorization token' },
      { status: 401 },
    );
  }

  // 2. Check disabled-by-default environment flag
  const isEnabled = process.env.ENABLE_DEAL_REPLAY_WORKER === 'true';
  if (!isEnabled) {
    return Response.json(
      {
        status: 'disabled',
        message: 'Historical deal replay worker is disabled by default. Set ENABLE_DEAL_REPLAY_WORKER=true to enable.',
      },
      { status: 403 },
    );
  }

  // 3. Parse request payload for batch and execution limits
  let requestedLimit = 5;
  let requestedBatchesPerJob = 10;
  let requestedChainId: number | undefined;

  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body === 'object') {
      if (typeof body.limit === 'number' && body.limit > 0) {
        requestedLimit = Math.min(body.limit, 20); // Strict upper bound
      }
      if (typeof body.maxBatchesPerJob === 'number' && body.maxBatchesPerJob > 0) {
        requestedBatchesPerJob = Math.min(body.maxBatchesPerJob, 50); // Strict upper bound
      }
      if (typeof body.chainId === 'number') {
        requestedChainId = body.chainId;
      }
    }
  } catch {
    // Default limits apply
  }

  // 4. Initialize replay service with authenticated dependencies
  const rpcClient = createViemScannerRpcClient();
  const replayRepo = getDealReplayRepository();
  const outboxRepo = getDealOutboxRepository();
  const trackedContractsRepo = getTrackedContractsRepository();

  const replayService = new HistoricalDealReplayService(
    rpcClient,
    replayRepo,
    outboxRepo,
    trackedContractsRepo,
    100n,
    'cron-replay-worker',
  );

  // 5. Execute bounded historical replay for pending jobs
  const result = await replayService.executeNextPendingJobs({
    chainId: requestedChainId,
    limit: requestedLimit,
    maxBatchesPerJob: requestedBatchesPerJob,
  });

  return Response.json({
    status: 'success',
    summary: {
      jobsClaimed: result.jobsClaimed,
      jobsCompleted: result.jobsCompleted,
      jobsProgressed: result.jobsProgressed,
      jobsFailed: result.jobsFailed,
      totalEventsProcessed: result.totalEventsProcessed,
    },
    results: result.results.map((r) => ({
      status: r.status,
      jobId: r.jobId,
      fromBlock: r.fromBlock.toString(),
      toBlock: r.toBlock.toString(),
      lastProcessedBlock: r.lastProcessedBlock ? r.lastProcessedBlock.toString() : null,
      blocksProcessed: r.blocksProcessed.toString(),
      eventsProcessed: r.eventsProcessed,
      batchesRun: r.batchesRun,
      error: r.error,
    })),
  });
}
