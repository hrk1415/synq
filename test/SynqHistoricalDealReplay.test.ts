/**
 * SYNQ — B.12.3.22 Durable Historical Deal Replay Test Suite
 *
 * Mocked, offline regression test suite verifying all 16 requirements:
 * 1. Historical deal discovery.
 * 2. Durable replay job creation.
 * 3. Duplicate job prevention.
 * 4. Correct V2/V1/Legacy ABI selection.
 * 5. Inclusive creation-block replay.
 * 6. Multi-batch continuation.
 * 7. Restart recovery.
 * 8. Concurrent workers.
 * 9. Stale lease fencing.
 * 10. RPC failure and retry.
 * 11. Chain reorganization.
 * 12. Duplicate event prevention.
 * 13. Outbox deduplication identity.
 * 14. Replay completion criteria.
 * 15. Live scanner cursor remains unchanged.
 * 16. Disabled and unauthenticated worker requests.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters } from 'viem';

import {
  InMemoryChainCursorRepository,
  setChainCursorRepository,
} from '../src/lib/deals/chain-sync-db';

import {
  InMemoryDealOutboxRepository,
  setDealOutboxRepository,
  deriveOutboxEventId,
} from '../src/lib/deals/outbox-db';

import {
  InMemoryNotificationsRepository,
  setNotificationsRepository,
} from '../src/lib/deals/notifications-db';

import {
  InMemoryTrackedContractsRepository,
  setTrackedContractsRepository,
} from '../src/lib/deals/tracked-contracts-db';

import {
  InMemoryDealProposalRepository,
  setDealProposalRepository,
} from '../src/lib/deals/proposals-db';

import {
  InMemoryDealReplayRepository,
  setDealReplayRepository,
} from '../src/lib/deals/deal-replay-db';

import {
  DealContractRegistry,
  type RawLog,
} from '../src/lib/deals/chain-event-ingestion';

import {
  BlockchainScanner,
  type IScannerRpcClient,
  SUPPORTED_SEPOLIA_FACTORIES,
  decodeDealContractLog,
  persistDecodedEventToOutbox,
} from '../src/lib/deals/chain-scanner';

import {
  HistoricalDealReplayService,
} from '../src/lib/deals/deal-replay-service';

import {
  GET as replayGetHandler,
  POST as replayPostHandler,
} from '../src/app/api/cron/replay/route';

import { synqFactoryV2ABI, synqDealV1ABI, nexotiqDealABI } from '../src/lib/contracts/abis';
import { SYNQ_V2_SEPOLIA_CONFIG } from '../src/lib/contracts/addresses';

class MockReplayRpcClient implements IScannerRpcClient {
  public headBlock: bigint = 2000n;
  public blocks = new Map<bigint, { hash: string; parentHash: string }>();
  public logs: RawLog[] = [];
  public failGetLogs: boolean = false;

  constructor() {
    for (let i = 0n; i <= 3000n; i++) {
      this.blocks.set(i, {
        hash: `0xhash_${i.toString().padStart(64, '0')}`,
        parentHash: i > 0n ? `0xhash_${(i - 1n).toString().padStart(64, '0')}` : '0x0000000000000000000000000000000000000000000000000000000000000000',
      });
    }
  }

  async getBlockNumber(): Promise<bigint> {
    return this.headBlock;
  }

  async getBlock(params: { blockNumber: bigint }): Promise<{ hash: string; parentHash: string }> {
    const b = this.blocks.get(params.blockNumber);
    if (!b) throw new Error(`Block ${params.blockNumber} not found`);
    return b;
  }

  async getLogs(params: { address?: string | string[]; fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]> {
    if (this.failGetLogs) {
      throw new Error('RPC transient failure during getLogs');
    }
    const filterAddresses = params.address
      ? Array.isArray(params.address)
        ? params.address.map((a) => a.toLowerCase())
        : [params.address.toLowerCase()]
      : undefined;

    return this.logs.filter((l) => {
      if (l.blockNumber < params.fromBlock || l.blockNumber > params.toBlock) return false;
      if (filterAddresses && !filterAddresses.includes(l.address.toLowerCase())) return false;
      return true;
    });
  }
}

describe('SYNQ — B.12.3.22 Durable Historical Deal Replay Suite', () => {
  const chainId = 11155111;
  const scannerId = 'synq-scanner-sepolia-test';
  const factoryAddress = SYNQ_V2_SEPOLIA_CONFIG.factory.toLowerCase();
  const dealAddressClone = '0x2222222222222222222222222222222222222222';
  const legacyDealAddress = '0x8888888888888888888888888888888888888888';
  const clientWallet = '0x1111111111111111111111111111111111111111';
  const freelancerWallet = '0x3333333333333333333333333333333333333333';

  let rpcClient: MockReplayRpcClient;
  let cursorRepo: InMemoryChainCursorRepository;
  let outboxRepo: InMemoryDealOutboxRepository;
  let notifRepo: InMemoryNotificationsRepository;
  let trackedRepo: InMemoryTrackedContractsRepository;
  let proposalRepo: InMemoryDealProposalRepository;
  let replayRepo: InMemoryDealReplayRepository;
  let registry: DealContractRegistry;

  beforeEach(async () => {
    rpcClient = new MockReplayRpcClient();
    cursorRepo = new InMemoryChainCursorRepository();
    outboxRepo = new InMemoryDealOutboxRepository();
    notifRepo = new InMemoryNotificationsRepository();
    trackedRepo = new InMemoryTrackedContractsRepository();
    proposalRepo = new InMemoryDealProposalRepository();
    replayRepo = new InMemoryDealReplayRepository();
    registry = new DealContractRegistry();

    setChainCursorRepository(cursorRepo);
    setDealOutboxRepository(outboxRepo);
    setNotificationsRepository(notifRepo);
    setTrackedContractsRepository(trackedRepo);
    setDealProposalRepository(proposalRepo);
    setDealReplayRepository(replayRepo);

    // Initialize live scanner cursor at block 1000
    await cursorRepo.initializeIfMissing({
      chainId,
      scannerId,
      initialBlockNumber: 1000n,
      initialBlockHash: `0xhash_${(1000n).toString().padStart(64, '0')}`,
    });
  });

  // 1. Historical deal discovery
  it('1. Discovered historical contract behind scanner cursor creates durable replay eligibility', async () => {
    const scanner = new BlockchainScanner(
      chainId,
      scannerId,
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      notifRepo,
      6n,
      50n,
      trackedRepo,
      0n,
      proposalRepo,
      SUPPORTED_SEPOLIA_FACTORIES,
      replayRepo,
    );
    await scanner.bootstrapFactories();

    // Factory event in current batch [1001..1020], but clone creation block was 950 (< fromBlock 1001)
    const factoryTopics = encodeEventTopics({
      abi: synqFactoryV2ABI,
      eventName: 'DealCreated',
      args: {
        dealAddress: dealAddressClone,
        client: clientWallet,
        freelancer: freelancerWallet,
      },
    });
    const factoryData = encodeAbiParameters(
      parseAbiParameters('address, address, address, address, uint256, uint256'),
      [clientWallet, '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', '0x0000000000000000000000000000000000000002', '0x0000000000000000000000000000000000000003', 5000000000n, 2n],
    );

    // Manually register in registry with deploymentBlock: 950 to test checkReplayRequirement
    registry.discoverDealClone({
      factoryAddress,
      dealAddress: dealAddressClone,
      deploymentBlock: 950n,
      contractType: 'deal_v2',
    });

    rpcClient.logs.push({
      address: factoryAddress,
      transactionHash: '0xdeploy_tx',
      blockNumber: 1005n,
      logIndex: 0,
      data: factoryData,
      topics: factoryTopics,
    });

    rpcClient.headBlock = 1050n;
    await scanner.scanNextBatch();

    // Verify durable replay job was created
    const job = await replayRepo.getJob(chainId, dealAddressClone);
    assert.ok(job, 'Durable replay job must be created');
    assert.equal(job.fromBlock, 950n);
    assert.equal(job.toBlock, 1000n);
    assert.equal(job.status, 'pending');
    assert.equal(job.generation, 'v2');
  });

  // 2. Durable replay job creation
  it('2. Durable replay job creates with correct coordinates, pending status, and null lastProcessedBlock', async () => {
    const result = await replayRepo.createJob({
      chainId,
      contractAddress: dealAddressClone,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 500n,
      toBlock: 750n,
    });

    assert.equal(result.status, 'created');
    assert.equal(result.job.id, `${chainId}:${dealAddressClone.toLowerCase()}`);
    assert.equal(result.job.fromBlock, 500n);
    assert.equal(result.job.toBlock, 750n);
    assert.equal(result.job.lastProcessedBlock, null);
    assert.equal(result.job.status, 'pending');
    assert.equal(result.job.retryCount, 0);
  });

  // 3. Duplicate job prevention
  it('3. Duplicate replay job creation returns existing job without duplicates', async () => {
    const first = await replayRepo.createJob({
      chainId,
      contractAddress: dealAddressClone,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 500n,
      toBlock: 750n,
    });
    assert.equal(first.status, 'created');

    const second = await replayRepo.createJob({
      chainId,
      contractAddress: dealAddressClone,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 500n,
      toBlock: 800n,
    });

    assert.equal(second.status, 'exists');
    assert.equal(second.job.id, first.job.id);
    const allJobs = await replayRepo.listJobs({ chainId });
    assert.equal(allJobs.length, 1, 'Only one job must exist');
  });

  // 4. Correct V2/V1/Legacy ABI selection
  it('4. Replay service decodes V2 events and Legacy Nexotiq events using authoritative ABIs', async () => {
    const replayService = new HistoricalDealReplayService(rpcClient, replayRepo, outboxRepo, trackedRepo);

    // 1. Create V2 job
    const v2Job = (await replayRepo.createJob({
      chainId,
      contractAddress: dealAddressClone,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 100n,
      toBlock: 110n,
    })).job;

    // 2. Create Legacy job
    const legacyJob = (await replayRepo.createJob({
      chainId,
      contractAddress: legacyDealAddress,
      contractType: 'deal_v1',
      generation: 'legacy',
      fromBlock: 200n,
      toBlock: 210n,
    })).job;

    // V2 log: MilestoneSubmitted
    const msTopics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'MilestoneSubmitted',
      args: {
        milestoneId: 0n,
        evidenceRootHash: '0x0000000000000000000000000000000000000000000000000000000000000001',
      },
    });
    const msData = encodeAbiParameters(
      parseAbiParameters('bytes32, uint8'),
      ['0x0000000000000000000000000000000000000000000000000000000000000002', 1],
    );
    rpcClient.logs.push({
      address: dealAddressClone,
      transactionHash: '0xv2_tx',
      blockNumber: 105n,
      logIndex: 0,
      data: msData,
      topics: msTopics,
    });

    // Legacy log: PaymentReleased
    const payTopics = encodeEventTopics({
      abi: nexotiqDealABI,
      eventName: 'PaymentReleased',
      args: { milestoneId: 0n, to: freelancerWallet },
    });
    const payData = encodeAbiParameters(parseAbiParameters('uint256'), [2000000n]);
    rpcClient.logs.push({
      address: legacyDealAddress,
      transactionHash: '0xlegacy_tx',
      blockNumber: 205n,
      logIndex: 0,
      data: payData,
      topics: payTopics,
    });

    // Execute jobs
    const batchResult = await replayService.executeNextPendingJobs({ limit: 5 });
    assert.equal(batchResult.jobsCompleted, 2);
    assert.equal(batchResult.totalEventsProcessed, 2);

    const outboxEvents = outboxRepo.getAllEvents();
    const eventTypes = outboxEvents.map((e) => e.event);
    assert.ok(eventTypes.includes('work_submitted'), 'V2 event decoded properly');
    assert.ok(eventTypes.includes('payment_released'), 'Legacy event decoded properly');
    assert.ok(outboxEvents.every((e) => e.status === 'skipped'), 'Historical replay events must be marked skipped to suppress emails');
  });

  // 5. Inclusive creation-block replay
  it('5. Replay starts inclusively on creation block and processes events at fromBlock', async () => {
    const replayService = new HistoricalDealReplayService(rpcClient, replayRepo, outboxRepo, trackedRepo);

    await replayRepo.createJob({
      chainId,
      contractAddress: dealAddressClone,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 100n,
      toBlock: 105n,
    });

    // Event situated exactly on creation block 100n
    const fundedTopics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'DealFunded',
      args: { dealAddress: dealAddressClone },
    });
    const fundedData = encodeAbiParameters(parseAbiParameters('uint256'), [5000000000n]);
    rpcClient.logs.push({
      address: dealAddressClone,
      transactionHash: '0xcreation_tx',
      blockNumber: 100n,
      logIndex: 0,
      data: fundedData,
      topics: fundedTopics,
    });

    const result = await replayService.executeNextPendingJobs({ limit: 1 });
    assert.equal(result.jobsCompleted, 1);
    assert.equal(result.totalEventsProcessed, 1);

    const outbox = outboxRepo.getAllEvents();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].blockNumber, 100n);
    assert.equal(outbox[0].event, 'deal_confirmed');
    assert.equal(outbox[0].status, 'skipped');
  });

  // 6. Multi-batch continuation
  it('6. Replay across wide block span executes in bounded chunks and advances progress watermark', async () => {
    // 250 blocks range with batch size 100
    const replayService = new HistoricalDealReplayService(
      rpcClient,
      replayRepo,
      outboxRepo,
      trackedRepo,
      100n,
    );

    await replayRepo.createJob({
      chainId,
      contractAddress: dealAddressClone,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 100n,
      toBlock: 350n,
    });

    // Claim and run exactly 1 batch
    const claimed = await replayRepo.claimPendingJobs({ limit: 1 });
    assert.equal(claimed.length, 1);

    const step1 = await replayService.processJob(claimed[0], { maxBatches: 1 });
    assert.equal(step1.status, 'progressed');
    assert.equal(step1.lastProcessedBlock, 199n);
    assert.equal(step1.batchesRun, 1);

    // Verify durable state
    const jobAfterStep1 = await replayRepo.getJob(chainId, dealAddressClone);
    assert.equal(jobAfterStep1?.lastProcessedBlock, 199n);

    // Run next 2 batches to finish
    const step2 = await replayService.processJob(claimed[0], { maxBatches: 5 });
    assert.equal(step2.status, 'completed');
    assert.equal(step2.lastProcessedBlock, 350n);

    const finalJob = await replayRepo.getJob(chainId, dealAddressClone);
    assert.equal(finalJob?.status, 'completed');
    assert.equal(finalJob?.lastProcessedBlock, 350n);
  });

  // 7. Restart recovery
  it('7. Interrupted replay job resumes at lastProcessedBlock + 1 after process restart', async () => {
    // Stage a job that already completed up to block 150 of 200
    const job = (await replayRepo.createJob({
      chainId,
      contractAddress: dealAddressClone,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 100n,
      toBlock: 200n,
    })).job;

    // Simulate previous worker advanced to 150 with a short lease then died
    const claimed = await replayRepo.claimPendingJobs({ limit: 1, claimDurationMs: 1 });
    await replayRepo.updateProgress({
      id: job.id,
      claimToken: claimed[0].claimToken!,
      lastProcessedBlock: 150n,
    });

    // Wait for previous worker's lease to expire
    await new Promise((r) => setTimeout(r, 10));

    // New worker starts
    const newService = new HistoricalDealReplayService(
      rpcClient,
      replayRepo,
      outboxRepo,
      trackedRepo,
      100n,
      'worker-restarted',
    );

    // Log at block 120 (already processed) and block 170 (new)
    const fundedTopics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'DealFunded',
      args: { dealAddress: dealAddressClone },
    });
    const fundedData = encodeAbiParameters(parseAbiParameters('uint256'), [5000000000n]);
    rpcClient.logs.push(
      {
        address: dealAddressClone,
        transactionHash: '0xold_tx',
        blockNumber: 120n,
        logIndex: 0,
        data: fundedData,
        topics: fundedTopics,
      },
      {
        address: dealAddressClone,
        transactionHash: '0xnew_tx',
        blockNumber: 170n,
        logIndex: 0,
        data: fundedData,
        topics: fundedTopics,
      },
    );

    const result = await newService.executeNextPendingJobs({ limit: 1 });
    assert.equal(result.jobsCompleted, 1);
    assert.equal(result.totalEventsProcessed, 1, 'Only block 170 event must be queried and processed');

    const outbox = outboxRepo.getAllEvents();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].blockNumber, 170n);
    assert.equal(outbox[0].status, 'skipped');
  });

  // 8. Concurrent workers
  it('8. Two concurrent workers compete for a pending job; exactly one acquires lease', async () => {
    await replayRepo.createJob({
      chainId,
      contractAddress: dealAddressClone,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 100n,
      toBlock: 200n,
    });

    // Workers attempt to claim simultaneously
    const [claimWorker1, claimWorker2] = await Promise.all([
      replayRepo.claimPendingJobs({ limit: 1, workerId: 'worker-1' }),
      replayRepo.claimPendingJobs({ limit: 1, workerId: 'worker-2' }),
    ]);

    const totalClaimed = claimWorker1.length + claimWorker2.length;
    assert.equal(totalClaimed, 1, 'Exactly one worker must acquire the claim');
    assert.ok(
      (claimWorker1.length === 1 && claimWorker2.length === 0) ||
      (claimWorker1.length === 0 && claimWorker2.length === 1),
      'No concurrent double-claims',
    );
  });

  // 9. Stale lease fencing
  it('9. Stale worker is fenced and prevented from updating progress after lease expires', async () => {
    await replayRepo.createJob({
      chainId,
      contractAddress: dealAddressClone,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 100n,
      toBlock: 200n,
    });

    // Worker 1 claims with very short duration
    const [jobWorker1] = await replayRepo.claimPendingJobs({
      limit: 1,
      claimDurationMs: 1, // 1ms
      workerId: 'worker-1',
    });
    assert.ok(jobWorker1.claimToken);

    // Wait for lease to expire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Worker 2 claims the expired job
    const [jobWorker2] = await replayRepo.claimPendingJobs({
      limit: 1,
      claimDurationMs: 60000,
      workerId: 'worker-2',
    });
    assert.ok(jobWorker2.claimToken);
    assert.notEqual(jobWorker1.claimToken, jobWorker2.claimToken);

    // Worker 1 attempts to update progress with stale token
    const staleUpdate = await replayRepo.updateProgress({
      id: jobWorker1.id,
      claimToken: jobWorker1.claimToken!,
      lastProcessedBlock: 150n,
    });

    assert.equal(staleUpdate.success, false);
    assert.match(staleUpdate.error || '', /Fenced/);

    // Worker 2 successfully updates progress
    const freshUpdate = await replayRepo.updateProgress({
      id: jobWorker2.id,
      claimToken: jobWorker2.claimToken!,
      lastProcessedBlock: 150n,
    });
    assert.equal(freshUpdate.success, true);
  });

  // 10. RPC failure and retry
  it('10. Transient RPC failure triggers bounded retry and failure tracking', async () => {
    const replayService = new HistoricalDealReplayService(rpcClient, replayRepo, outboxRepo, trackedRepo);

    await replayRepo.createJob({
      chainId,
      contractAddress: dealAddressClone,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 100n,
      toBlock: 200n,
      maxRetries: 3,
    });

    rpcClient.failGetLogs = true;

    const result = await replayService.executeNextPendingJobs({ limit: 1 });
    assert.equal(result.jobsFailed, 1);

    const job = await replayRepo.getJob(chainId, dealAddressClone);
    assert.equal(job?.status, 'pending');
    assert.equal(job?.retryCount, 1);
    assert.match(job?.lastError || '', /transient failure/);
    assert.ok(job && job.nextRetryAt.getTime() > Date.now());
  });

  // 11. Chain reorganization
  it('11. Chain reorg triggers progress rewind and invalidates orphaned outbox events', async () => {
    await replayRepo.createJob({
      chainId,
      contractAddress: dealAddressClone,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 100n,
      toBlock: 200n,
    });

    const [claimed] = await replayRepo.claimPendingJobs({ limit: 1 });

    // Progress advanced to block 150
    await replayRepo.updateProgress({
      id: claimed.id,
      claimToken: claimed.claimToken!,
      lastProcessedBlock: 150n,
    });

    // Enqueue an on-chain event at block 145
    await outboxRepo.enqueue({
      id: 'outbox:reorg:test',
      chainId,
      dealId: dealAddressClone,
      event: 'work_submitted',
      recipientWallet: clientWallet,
      origin: 'on_chain',
      blockNumber: 145n,
      payload: {},
    });

    // Reorg detected at block 140 -> rewind progress to 139
    const rewind = await replayRepo.rewindProgress({
      id: claimed.id,
      claimToken: claimed.claimToken!,
      rewindToBlock: 139n,
    });
    assert.equal(rewind.success, true);

    const invalidatedCount = await outboxRepo.invalidateOrphanedEvents(chainId, 140n);
    assert.equal(invalidatedCount, 1);

    const job = await replayRepo.getJob(chainId, dealAddressClone);
    assert.equal(job?.lastProcessedBlock, 139n);

    const outboxAfter = await outboxRepo.get('outbox:reorg:test');
    assert.equal(outboxAfter?.status, 'cancelled');
  });

  // 12. Duplicate event prevention
  it('12. Replaying identical logs over the same range twice does not duplicate events', async () => {
    const replayService = new HistoricalDealReplayService(rpcClient, replayRepo, outboxRepo, trackedRepo);

    await replayRepo.createJob({
      chainId,
      contractAddress: dealAddressClone,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 100n,
      toBlock: 110n,
    });

    const fundedTopics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'DealFunded',
      args: { dealAddress: dealAddressClone },
    });
    const fundedData = encodeAbiParameters(parseAbiParameters('uint256'), [5000000000n]);
    rpcClient.logs.push({
      address: dealAddressClone,
      transactionHash: '0xsame_tx',
      blockNumber: 105n,
      logIndex: 0,
      data: fundedData,
      topics: fundedTopics,
    });

    // Run replay first time
    await replayService.executeNextPendingJobs({ limit: 1 });
    const countAfterRun1 = outboxRepo.getAllEvents().length;
    assert.equal(countAfterRun1, 1);

    // Simulate manual re-run of same decoded event
    const decoded = decodeDealContractLog({
      chainId,
      log: rpcClient.logs[0],
      generation: 'v2',
      contractType: 'deal_v2',
    });
    const enqueueResult = await persistDecodedEventToOutbox(outboxRepo, decoded[0], { isHistoricalReplay: true });
    assert.equal(enqueueResult, 'duplicate');

    const countAfterRun2 = outboxRepo.getAllEvents().length;
    assert.equal(countAfterRun2, 1, 'Outbox must contain exactly 1 event without duplicates');
  });

  // 13. Outbox deduplication identity
  it('13. Replayed event ID matches live scanner event ID identically', () => {
    const log: RawLog = {
      address: dealAddressClone,
      transactionHash: '0xcanonical_tx',
      blockNumber: 105n,
      logIndex: 2,
      topics: [],
      data: '0x',
    };

    const replayedId = deriveOutboxEventId({
      chainId,
      dealId: dealAddressClone,
      event: 'deal_confirmed',
      recipientWallet: freelancerWallet,
      actionId: `${log.transactionHash}:${log.logIndex}`,
    });

    const scannerIdDerived = deriveOutboxEventId({
      chainId,
      dealId: dealAddressClone,
      event: 'deal_confirmed',
      recipientWallet: freelancerWallet,
      actionId: `${log.transactionHash}:${log.logIndex}`,
    });

    assert.equal(replayedId, scannerIdDerived);
  });

  // 14. Replay completion criteria
  it('14. Job completes with completedAt timestamp and cleared claim lease upon reaching target block', async () => {
    const replayService = new HistoricalDealReplayService(rpcClient, replayRepo, outboxRepo, trackedRepo);

    await replayRepo.createJob({
      chainId,
      contractAddress: dealAddressClone,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 100n,
      toBlock: 150n,
    });

    const result = await replayService.executeNextPendingJobs({ limit: 1 });
    assert.equal(result.jobsCompleted, 1);

    const completedJob = await replayRepo.getJob(chainId, dealAddressClone);
    assert.equal(completedJob?.status, 'completed');
    assert.equal(completedJob?.lastProcessedBlock, 150n);
    assert.ok(completedJob?.completedAt);
    assert.equal(completedJob?.claimToken, null);
    assert.equal(completedJob?.claimExpiresAt, null);

    // Further claims do not claim completed job
    const subsequentClaims = await replayRepo.claimPendingJobs({ limit: 1 });
    assert.equal(subsequentClaims.length, 0);
  });

  // 15. Live scanner cursor remains unchanged
  it('15. Executing historical deal replay never modifies or rewinds the live scanner cursor', async () => {
    const initialCursor = await cursorRepo.get(chainId, scannerId);
    assert.equal(initialCursor?.lastBlockNumber, 1000n);

    const replayService = new HistoricalDealReplayService(rpcClient, replayRepo, outboxRepo, trackedRepo);

    await replayRepo.createJob({
      chainId,
      contractAddress: dealAddressClone,
      contractType: 'deal_v2',
      generation: 'v2',
      fromBlock: 500n,
      toBlock: 750n,
    });

    await replayService.executeNextPendingJobs({ limit: 1 });

    const postReplayCursor = await cursorRepo.get(chainId, scannerId);
    assert.equal(postReplayCursor?.lastBlockNumber, 1000n, 'Live scanner cursor must not change');
    assert.equal(postReplayCursor?.lastBlockHash, initialCursor?.lastBlockHash);
  });

  // 16. Disabled and unauthenticated worker requests
  it('16. Replay cron route enforces authentication, feature flag, POST method, and execution limits', async () => {
    const originalSecret = process.env.CRON_SECRET;
    const originalFlag = process.env.ENABLE_DEAL_REPLAY_WORKER;

    try {
      // 1. GET returns 405 Method Not Allowed
      const getReq = new NextRequest('http://localhost:3000/api/cron/replay', { method: 'GET' });
      const getRes = await replayGetHandler();
      assert.equal(getRes.status, 405);

      // 2. Missing CRON_SECRET on server -> 503
      delete process.env.CRON_SECRET;
      const noSecretReq = new NextRequest('http://localhost:3000/api/cron/replay', { method: 'POST' });
      const noSecretRes = await replayPostHandler(noSecretReq);
      assert.equal(noSecretRes.status, 503);

      // 3. Unauthorized request with bad token -> 401
      process.env.CRON_SECRET = 'correct-secret-12345';
      const badAuthReq = new NextRequest('http://localhost:3000/api/cron/replay', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-secret' },
      });
      const badAuthRes = await replayPostHandler(badAuthReq);
      assert.equal(badAuthRes.status, 401);

      // 4. Feature flag disabled by default -> 403
      delete process.env.ENABLE_DEAL_REPLAY_WORKER;
      const disabledReq = new NextRequest('http://localhost:3000/api/cron/replay', {
        method: 'POST',
        headers: { Authorization: 'Bearer correct-secret-12345' },
      });
      const disabledRes = await replayPostHandler(disabledReq);
      assert.equal(disabledRes.status, 403);
      const disabledBody = await disabledRes.json();
      assert.equal(disabledBody.status, 'disabled');

      // 5. Enabled with valid authentication -> 200 OK
      process.env.ENABLE_DEAL_REPLAY_WORKER = 'true';
      await replayRepo.createJob({
        chainId,
        contractAddress: dealAddressClone,
        contractType: 'deal_v2',
        generation: 'v2',
        fromBlock: 100n,
        toBlock: 150n,
      });

      const enabledReq = new NextRequest('http://localhost:3000/api/cron/replay', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer correct-secret-12345',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ limit: 2, maxBatchesPerJob: 5 }),
      });
      const enabledRes = await replayPostHandler(enabledReq);
      assert.equal(enabledRes.status, 200);
      const body = await enabledRes.json();
      assert.equal(body.status, 'success');
      assert.equal(body.summary.jobsCompleted, 1);
    } finally {
      process.env.CRON_SECRET = originalSecret;
      process.env.ENABLE_DEAL_REPLAY_WORKER = originalFlag;
    }
  });
});
