import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import {
  BlockchainScanner,
  SUPPORTED_SEPOLIA_FACTORIES,
  SCANNER_SCOPES,
  validateScannerCursor,
  type ScannerScopeType,
  type IScannerRpcClient,
} from '@/lib/deals/chain-scanner';
import { getChainCursorRepository, isZeroBlockHash } from '@/lib/deals/chain-sync-db';
import { getDealOutboxRepository } from '@/lib/deals/outbox-db';
import { getNotificationsRepository } from '@/lib/deals/notifications-db';
import { getTrackedContractsRepository } from '@/lib/deals/tracked-contracts-db';
import { getDealProposalRepository } from '@/lib/deals/proposals-db';
import { DealContractRegistry } from '@/lib/deals/chain-event-ingestion';
import { sepoliaPublicClient } from '@/lib/chain';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Retained as an explicit tombstone; cron trigger is POST-only. */
export async function GET() {
  return Response.json(
    { error: 'Scanner cron endpoint is POST-only' },
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
    async getTransactionReceipt(params: { hash: `0x${string}` | string }): Promise<any> {
      return sepoliaPublicClient.getTransactionReceipt({ hash: params.hash as `0x${string}` });
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
  const isEnabled = process.env.ENABLE_CHAIN_SCANNER === 'true';
  if (!isEnabled) {
    return Response.json(
      {
        status: 'disabled',
        message: 'Chain scanner worker is disabled by default. Set ENABLE_CHAIN_SCANNER=true to enable.',
      },
      { status: 403 },
    );
  }

  // 3. Parse request payload for scope, batch size, and start coordinate
  let requestedScope: string | undefined;
  let requestedMaxBatch: number | undefined;
  let requestedStartBlock: string | undefined;
  let requestedRequireCoverage = false;

  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body === 'object') {
      if (typeof body.scope === 'string') requestedScope = body.scope;
      if (typeof body.maxBatchSize === 'number') requestedMaxBatch = body.maxBatchSize;
      if (typeof body.startBlock === 'string' || typeof body.startBlock === 'number') {
        requestedStartBlock = String(body.startBlock);
      }
      if (body.requireHistoricalCoverage === true) {
        requestedRequireCoverage = true;
      }
    }
  } catch {
    // Default limit applies
  }

  const urlScope = req.nextUrl?.searchParams?.get('scope');
  const scopeKey = (requestedScope || urlScope || process.env.SCANNER_SCOPE || 'live_v1_v2') as ScannerScopeType;
  const scopeDef = SCANNER_SCOPES[scopeKey];

  if (!scopeDef) {
    return Response.json(
      {
        status: 'error',
        error: `Unsupported scanner scope: '${scopeKey}'. Supported scopes: ${Object.keys(SCANNER_SCOPES).join(', ')}`,
      },
      { status: 400 },
    );
  }

  const rawStartBlock = requestedStartBlock || process.env.SCANNER_START_BLOCK;
  const configuredStartBlock = rawStartBlock ? BigInt(rawStartBlock) : undefined;

  // Reject V2-only starting block when scope claims combined V1 and V2 coverage
  if (scopeDef.scope === 'live_v1_v2' && configuredStartBlock !== undefined && configuredStartBlock > scopeDef.verifiedStartBlock) {
    return Response.json(
      {
        status: 'error',
        error: `V2-only or truncated starting block (${configuredStartBlock}) rejected: scope 'live_v1_v2' claims combined V1 and V2 history. To avoid silently skipping V1 events, live_v1_v2 must start at verified V1 deployment block ${scopeDef.verifiedStartBlock}. For V2 only, use dedicated 'v2_only' scope.`,
      },
      { status: 400 },
    );
  }

  const urlRequireCoverage = req.nextUrl?.searchParams?.get('requireCoverage') === 'true';
  const requireHistoricalCoverage = requestedRequireCoverage || urlRequireCoverage;

  // 4. Resolve cursor and enforce verified coordinates & atomic bootstrap
  const cursorRepo = getChainCursorRepository();
  let existingCursor = await cursorRepo.get(11155111, scopeDef.scannerId);

  // If no cursor exists and no explicit scope or start block was configured, reject execution (Fail closed)
  if (!existingCursor && !requestedScope && !urlScope && !process.env.SCANNER_SCOPE && configuredStartBlock === undefined) {
    return Response.json(
      {
        status: 'error',
        error: 'Deployment coordinates unverified: No initialized cursor found. Explicit verified scope (e.g. live_v1_v2 at 11832783) or valid starting block required.',
      },
      { status: 412 },
    );
  }

  const rpcClient = createViemScannerRpcClient();

  // If cursor is missing, atomically initialize at anchor block (targetStartBlock - 1n) with verified parent hash
  if (!existingCursor) {
    const targetStartBlock = configuredStartBlock ?? scopeDef.verifiedStartBlock;

    if (targetStartBlock < scopeDef.minAllowedBlock) {
      return Response.json(
        {
          status: 'error',
          error: `Target start block ${targetStartBlock} is strictly lower than scope minimum coordinate ${scopeDef.minAllowedBlock}`,
        },
        { status: 400 },
      );
    }

    if (scopeDef.maxAllowedBlock !== undefined && targetStartBlock > scopeDef.maxAllowedBlock) {
      return Response.json(
        {
          status: 'error',
          error: `Target start block ${targetStartBlock} exceeds scope historical maximum ${scopeDef.maxAllowedBlock}`,
        },
        { status: 400 },
      );
    }

    const anchorBlockNumber = targetStartBlock - 1n;
    try {
      const startBlockInfo = await rpcClient.getBlock({ blockNumber: targetStartBlock });
      const anchorBlockHash = startBlockInfo.parentHash;

      if (!anchorBlockHash || isZeroBlockHash(anchorBlockHash)) {
        return Response.json(
          {
            status: 'error',
            error: `Failed to retrieve verified anchor block hash for start block ${targetStartBlock}`,
          },
          { status: 502 },
        );
      }

      existingCursor = await cursorRepo.initializeIfMissing({
        chainId: 11155111,
        scannerId: scopeDef.scannerId,
        initialBlockNumber: anchorBlockNumber,
        initialBlockHash: anchorBlockHash,
        isBootstrap: true,
      });
    } catch (initErr: any) {
      return Response.json(
        {
          status: 'error',
          error: `Failed to initialize cursor for scope ${scopeDef.scope}: ${initErr?.message || initErr}`,
        },
        { status: 502 },
      );
    }
  } else {
    // Existing cursor validation: reject untrusted or inconsistent cursors without modifying them
    const cursorValidation = validateScannerCursor({
      cursor: existingCursor,
      expectedChainId: 11155111,
      expectedScannerId: scopeDef.scannerId,
      scope: scopeDef,
      configuredStartBlock,
      requireHistoricalCoverage,
    });

    if (!cursorValidation.valid) {
      return Response.json(
        {
          status: 'error',
          error: `Existing cursor validation failed: ${cursorValidation.reason}`,
        },
        { status: 409 },
      );
    }
  }

  // 5. Parse bounded batch limits
  let maxBatch = 100n;
  if (typeof requestedMaxBatch === 'number' && Number.isInteger(requestedMaxBatch)) {
    maxBatch = BigInt(Math.max(1, Math.min(requestedMaxBatch, 250)));
  }

  // 6. Execute bounded scan batch reusing existing database-backed leases and cursor CAS
  try {
    const registry = new DealContractRegistry();
    const outboxRepo = getDealOutboxRepository();
    const notifRepo = getNotificationsRepository();
    const trackedContractsRepo = getTrackedContractsRepository();
    const proposalRepo = getDealProposalRepository();

    const filteredFactories = SUPPORTED_SEPOLIA_FACTORIES.filter((f) =>
      scopeDef.supportedGenerations.includes(f.generation),
    );

    const scanner = new BlockchainScanner(
      11155111,
      scopeDef.scannerId,
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      notifRepo,
      5n, // 5-block confirmation depth
      maxBatch,
      trackedContractsRepo,
      scopeDef.minAllowedBlock,
      proposalRepo,
      filteredFactories,
    );

    await scanner.bootstrapFactories();
    await scanner.rehydrateAcceptedDeals();
    const result = await scanner.scanNextBatch();

    return Response.json({
      status: 'success',
      scope: scopeDef.scope,
      scannerId: scopeDef.scannerId,
      scanned: result.scanned,
      fromBlock: result.fromBlock !== undefined ? result.fromBlock.toString() : null,
      toBlock: result.toBlock !== undefined ? result.toBlock.toString() : null,
      logsFound: result.logsFound,
      eventsProcessed: result.eventsProcessed,
      newContractsDiscovered: result.newContractsDiscovered.length,
      reorgDetected: result.reorgDetected,
      cursorAdvanced: result.cursorAdvanced,
      reason: result.reason || null,
    });
  } catch (err: any) {
    console.error('[CronScanner] Worker execution error:', err?.message || err);
    return Response.json(
      {
        status: 'error',
        error: 'Scanner worker execution failed',
      },
      { status: 500 },
    );
  }
}
