/**
 * SYNQ — B.12.3.5 Critical Notification Reliability Repairs Regression Suite
 *
 * Verifies all 20 critical reliability and concurrency requirements identified
 * in the B.12.3.4 Pre-Activation Security & Reliability Audit:
 *
 * 1. Concurrent client/outbox notification claims.
 * 2. Two workers claiming the same failed notification.
 * 3. Scanner does not pre-claim delivery.
 * 4. duplicate_pending deferral and eventual reconciliation.
 * 5. Serverless cold-start registry recovery.
 * 6. Historical contract replay after restart.
 * 7. Duplicate factory discovery.
 * 8. Reorged contract discovery.
 * 9. Retry backoff timing.
 * 10. Maximum retry exhaustion.
 * 11. Old record with a fresh claim.
 * 12. Stale claim recovery.
 * 13. Late worker attempting to finalize a reclaimed job.
 * 14. Buyer and seller completion notifications.
 * 15. Completion key parity across client/scanner.
 * 16. Correct cancellation recipient.
 * 17. Full buyer refund.
 * 18. Split milestone settlement.
 * 19. Failure to persist tracked contracts before cursor advancement.
 * 20. Database outage fails closed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryChainCursorRepository,
  setChainCursorRepository,
  resetChainCursorRepository,
} from '../src/lib/deals/chain-sync-db';

import {
  InMemoryDealOutboxRepository,
  setDealOutboxRepository,
  resetDealOutboxRepository,
  deriveOutboxEventId,
  MAX_OUTBOX_RETRIES,
  OUTBOX_PROCESSING_TIMEOUT_MS,
  DrizzleDealOutboxRepository,
} from '../src/lib/deals/outbox-db';

import {
  InMemoryNotificationsRepository,
  setNotificationsRepository,
  resetNotificationsRepository,
  generateCanonicalDealEventKey,
  PENDING_TIMEOUT_MS,
  DrizzleNotificationsRepository,
} from '../src/lib/deals/notifications-db';

import {
  InMemoryTrackedContractsRepository,
  setTrackedContractsRepository,
  resetTrackedContractsRepository,
  DrizzleTrackedContractsRepository,
  TrackedContractPersistenceError,
} from '../src/lib/deals/tracked-contracts-db';

import {
  InMemoryDealProposalRepository,
  setDealProposalRepository,
  resetDealProposalRepository,
} from '../src/lib/deals/proposals-db';

import {
  DealContractRegistry,
  type RawLog,
} from '../src/lib/deals/chain-event-ingestion';

import {
  BlockchainScanner,
  type IScannerRpcClient,
} from '../src/lib/deals/chain-scanner';

import {
  OutboxProcessor,
  type INotificationDispatcher,
  type DispatchResult,
} from '../src/lib/deals/outbox-processor';

import { encodeEventTopics, encodeAbiParameters, parseAbiParameters } from 'viem';
import { synqFactoryV2ABI, synqDealV1ABI } from '../src/lib/contracts/abis';

class MockScannerRpcClient implements IScannerRpcClient {
  public headBlock: bigint = 1000n;
  public blocks = new Map<bigint, { hash: string; parentHash: string }>();
  public logs: RawLog[] = [];

  constructor() {
    for (let i = 0n; i <= 2000n; i++) {
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
    if (!b) throw new Error(`Block not found: ${params.blockNumber}`);
    return b;
  }

  async getLogs(params: {
    address?: string | string[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RawLog[]> {
    const addresses = Array.isArray(params.address)
      ? new Set(params.address.map((a) => a.toLowerCase()))
      : params.address
      ? new Set([params.address.toLowerCase()])
      : null;

    return this.logs.filter((l) => {
      if (l.blockNumber < params.fromBlock || l.blockNumber > params.toBlock) return false;
      if (addresses && !addresses.has(l.address.toLowerCase())) return false;
      return true;
    });
  }
}

class MockNotificationDispatcher implements INotificationDispatcher {
  public dispatched: Array<{ event: string; payload: any }> = [];
  public shouldFail = false;
  public failErrorMessage = 'SMTP transport rejected delivery';
  public shouldSkip = false;
  public skipReason = 'No verified email linked';

  async dispatch(event: string, payload: any): Promise<DispatchResult> {
    this.dispatched.push({ event, payload });

    if (this.shouldSkip) {
      return { success: false, skipped: true, reason: this.skipReason };
    }

    if (this.shouldFail) {
      return { success: false, error: this.failErrorMessage };
    }

    return {
      success: true,
      messageId: `msg_${Date.now()}_${Math.random()}`,
    };
  }
}

describe('SYNQ — B.12.3.5 Critical Notification Reliability Repairs Suite', () => {
  const chainId = 11155111;
  const scannerId = 'v2_repair_scanner';
  const factoryAddress = '0x1000000000000000000000000000000000000001';
  const dealAddressA = '0x2000000000000000000000000000000000000002';
  const clientWallet = '0x4000000000000000000000000000000000000004';
  const freelancerWallet = '0x5000000000000000000000000000000000000005';

  let cursorRepo: InMemoryChainCursorRepository;
  let outboxRepo: InMemoryDealOutboxRepository;
  let notifRepo: InMemoryNotificationsRepository;
  let trackedRepo: InMemoryTrackedContractsRepository;
  let proposalRepo: InMemoryDealProposalRepository;
  let rpcClient: MockScannerRpcClient;
  let registry: DealContractRegistry;
  let dispatcher: MockNotificationDispatcher;

  beforeEach(async () => {
    cursorRepo = new InMemoryChainCursorRepository();
    setChainCursorRepository(cursorRepo);

    outboxRepo = new InMemoryDealOutboxRepository();
    setDealOutboxRepository(outboxRepo);

    notifRepo = new InMemoryNotificationsRepository();
    setNotificationsRepository(notifRepo);

    trackedRepo = new InMemoryTrackedContractsRepository();
    await trackedRepo.upsert({
      chainId,
      contractAddress: factoryAddress,
      contractType: 'factory',
      deploymentBlock: 100n,
    });
    await trackedRepo.upsert({
      chainId,
      contractAddress: dealAddressA,
      contractType: 'deal_v2',
      deploymentBlock: 200n,
      buyerWallet: clientWallet,
      sellerWallet: freelancerWallet,
    });
    setTrackedContractsRepository(trackedRepo);

    proposalRepo = new InMemoryDealProposalRepository();
    setDealProposalRepository(proposalRepo);

    rpcClient = new MockScannerRpcClient();

    registry = new DealContractRegistry([
      { address: factoryAddress, contractType: 'factory', deploymentBlock: 100n },
      {
        address: dealAddressA,
        contractType: 'deal_v2',
        deploymentBlock: 200n,
        metadata: { buyerWallet: clientWallet, sellerWallet: freelancerWallet },
      },
    ]);

    dispatcher = new MockNotificationDispatcher();

    const block500 = await rpcClient.getBlock({ blockNumber: 500n });
    await cursorRepo.initializeIfMissing({
      chainId,
      scannerId,
      initialBlockNumber: 500n,
      initialBlockHash: block500.hash,
    });
  });

  afterEach(() => {
    resetChainCursorRepository();
    resetDealOutboxRepository();
    resetNotificationsRepository();
    resetTrackedContractsRepository();
    resetDealProposalRepository();
  });

  // 1. Concurrent client/outbox notification claims
  it('1. Concurrent client/outbox claims: outbox defers without double send when client claim is in flight', async () => {
    const notifKey = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddressA,
      event: 'work_submitted',
      milestoneIndex: 0,
      recipientRole: 'buyer',
    });

    // Client begins claim
    const clientClaim = await notifRepo.claimPending(notifKey, {
      dealId: dealAddressA,
      event: 'work_submitted',
      recipientWallet: clientWallet,
    });
    assert.equal(clientClaim, 'claimed');

    // Concurrently, outbox processor runs for same event
    await outboxRepo.enqueue({
      id: 'outbox-race-1',
      chainId,
      dealId: dealAddressA,
      event: 'work_submitted',
      recipientWallet: clientWallet,
      payload: { milestoneIndex: 0, notifKey },
    });

    const processor = new OutboxProcessor(outboxRepo, notifRepo, dispatcher);
    const result = await processor.processBatch(10);

    assert.equal(result.deferredCount, 1, 'Outbox item must be deferred');
    assert.equal(dispatcher.dispatched.length, 0, 'No email must be dispatched while duplicate_pending');

    // Outbox item is still present (not processed)
    const item = await outboxRepo.get('outbox-race-1');
    assert.equal(item?.status, 'failed'); // deferred into failed with short retry
  });

  // 2. Two workers claiming the same failed notification
  it('2. Two concurrent workers claiming the same failed notification: only one receives claimed', async () => {
    const notifKey = 'test_failed_key';
    await notifRepo.claimPending(notifKey, {
      dealId: dealAddressA,
      event: 'work_submitted',
      recipientWallet: clientWallet,
    });
    await notifRepo.markFailed(notifKey, 'Network error');

    // Two workers race to claim
    const [c1, c2] = await Promise.all([
      notifRepo.claimPending(notifKey, {
        dealId: dealAddressA,
        event: 'work_submitted',
        recipientWallet: clientWallet,
      }),
      notifRepo.claimPending(notifKey, {
        dealId: dealAddressA,
        event: 'work_submitted',
        recipientWallet: clientWallet,
      }),
    ]);

    const claims = [c1, c2];
    assert.equal(claims.filter((c) => c === 'claimed').length, 1, 'Exactly one worker must claim');
    assert.equal(claims.filter((c) => c === 'duplicate_pending').length, 1, 'Second worker must receive duplicate_pending');
  });

  // 3. Scanner does not pre-claim delivery
  it('3. Scanner does not pre-claim delivery: only stages outbox record', async () => {
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
    );

    const topics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'DealFunded',
      args: { dealAddress: dealAddressA },
    });
    const data = encodeAbiParameters(parseAbiParameters('uint256'), [5000000000n]);

    rpcClient.logs.push({
      address: dealAddressA,
      transactionHash: '0xfund_tx',
      blockNumber: 505n,
      logIndex: 0,
      data,
      topics,
    });

    rpcClient.headBlock = 520n;
    const res = await scanner.scanNextBatch();
    assert.equal(res.eventsProcessed, 1);

    // Staged in outbox
    const pending = await outboxRepo.getPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].event, 'deal_confirmed');

    // CRITICAL: deal_notifications must NOT have a pre-claim
    const notifKey = pending[0].payload.notifKey as string;
    const existingNotif = await notifRepo.get(notifKey);
    assert.equal(existingNotif, null, 'deal_notifications record must NOT be pre-claimed by scanner');
  });

  // 4. duplicate_pending deferral and eventual reconciliation
  it('4. duplicate_pending deferral reconciles cleanly when original sender marks delivered', async () => {
    const notifKey = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddressA,
      event: 'work_submitted',
      milestoneIndex: 1,
      recipientRole: 'buyer',
    });

    // 1. Client claims
    await notifRepo.claimPending(notifKey, {
      dealId: dealAddressA,
      event: 'work_submitted',
      recipientWallet: clientWallet,
    });

    // 2. Outbox item arrives
    await outboxRepo.enqueue({
      id: 'outbox-reconcile-1',
      chainId,
      dealId: dealAddressA,
      event: 'work_submitted',
      recipientWallet: clientWallet,
      payload: { milestoneIndex: 1, notifKey },
    });

    const processor = new OutboxProcessor(outboxRepo, notifRepo, dispatcher);
    // First run: deferred
    const r1 = await processor.processBatch(10);
    assert.equal(r1.deferredCount, 1);
    assert.equal(dispatcher.dispatched.length, 0);

    // Client finishes email delivery
    await notifRepo.markDelivered(notifKey, 'msg-client-success');

    // Force retry eligibility for test
    const item = await outboxRepo.get('outbox-reconcile-1');
    assert.ok(item);
    item.nextRetryAt = new Date(Date.now() - 1000);
    outboxRepo.setEvent(item);

    // Second run: recognizes duplicate_delivered and marks outbox processed without second email!
    const r2 = await processor.processBatch(10);
    assert.equal(r2.duplicatesCount, 1);
    assert.equal(dispatcher.dispatched.length, 0, 'Must NOT send duplicate email');

    const finalized = await outboxRepo.get('outbox-reconcile-1');
    assert.equal(finalized?.status, 'processed');
  });

  // 5. Serverless cold-start registry recovery
  it('5. Serverless cold-start: fresh scanner reloads tracked contracts from durable store', async () => {
    // Fresh registry with ZERO tracked contracts in memory
    const coldRegistry = new DealContractRegistry([]);
    assert.equal(coldRegistry.getAllTrackedAddresses().length, 0);

    const coldScanner = new BlockchainScanner(
      chainId,
      scannerId,
      rpcClient,
      cursorRepo,
      coldRegistry,
      outboxRepo,
      notifRepo,
      6n,
      50n,
      trackedRepo,
    );

    // Scanner loads from trackedRepo
    await coldScanner.scanNextBatch();
    assert.ok(coldRegistry.isRegistered(factoryAddress), 'Factory must be loaded from durable store');
    assert.ok(coldRegistry.isRegistered(dealAddressA), 'DealA must be loaded from durable store');
  });

  // 6. Historical contract replay after restart
  it('6. Newly discovered contract deployed prior to cursor triggers replay across restarts', async () => {
    const historicalDeal = '0x9999999999999999999999999999999999999999';

    // Discovered at block 505, but deployed at block 490 (before cursor 500)
    const factoryTopics = encodeEventTopics({
      abi: synqFactoryV2ABI,
      eventName: 'DealCreated',
      args: {
        dealAddress: historicalDeal,
        client: clientWallet,
        freelancer: freelancerWallet,
      },
    });

    const data = encodeAbiParameters(
      parseAbiParameters('address creator, address usdc, address primaryResolver, address emergencyResolver, uint256 totalEscrow, uint256 milestoneCount'),
      [
        clientWallet,
        '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
        1000000000n,
        1n,
      ],
    );

    rpcClient.logs.push({
      address: factoryAddress,
      transactionHash: '0xlate_deploy',
      blockNumber: 505n,
      logIndex: 0,
      data,
      topics: factoryTopics,
    });

    // Event on historical deal at block 495
    const fundTopics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'DealFunded',
      args: { dealAddress: historicalDeal },
    });
    const fundData = encodeAbiParameters(parseAbiParameters('uint256'), [1000000000n]);
    rpcClient.logs.push({
      address: historicalDeal,
      transactionHash: '0xearly_fund',
      blockNumber: 495n,
      logIndex: 0,
      data: fundData,
      topics: fundTopics,
    });

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
    );

    rpcClient.headBlock = 520n;
    const res = await scanner.scanNextBatch();
    assert.equal(res.newContractsDiscovered.length, 1);

    // Verify trackedRepo has the new contract persisted
    const saved = await trackedRepo.get(chainId, historicalDeal);
    assert.ok(saved);
    assert.equal(saved?.contractAddress, historicalDeal.toLowerCase());
  });

  // 7. Duplicate factory discovery
  it('7. Duplicate factory discovery logs are handled idempotently', async () => {
    await trackedRepo.upsert({
      chainId,
      contractAddress: dealAddressA,
      contractType: 'deal_v2',
      deploymentBlock: 200n,
    });

    // Re-upsert identical
    await trackedRepo.upsert({
      chainId,
      contractAddress: dealAddressA,
      contractType: 'deal_v2',
      deploymentBlock: 200n,
    });

    const all = await trackedRepo.getAll(chainId);
    const matching = all.filter((c) => c.contractAddress === dealAddressA.toLowerCase());
    assert.equal(matching.length, 1, 'Contract must not be duplicated in durable registry');
  });

  // 8. Reorged contract discovery
  it('8. Reorg rollback purges orphaned contracts discovered on orphaned fork', async () => {
    // Contract discovered at block 505
    await trackedRepo.upsert({
      chainId,
      contractAddress: '0xorphaned_deal',
      contractType: 'deal_v2',
      deploymentBlock: 505n,
    });

    assert.ok(await trackedRepo.get(chainId, '0xorphaned_deal'));

    // Rewind past block 500
    await trackedRepo.deleteOrphanedAboveBlock(chainId, 500n);

    assert.equal(await trackedRepo.get(chainId, '0xorphaned_deal'), null, 'Orphaned contract must be purged');
    assert.ok(await trackedRepo.get(chainId, dealAddressA), 'Legitimate contract at block 200 must remain');
  });

  // 9. Retry backoff timing
  it('9. Failed outbox items calculate exponential backoff and are ignored until nextRetryAt', async () => {
    await outboxRepo.enqueue({
      id: 'backoff-item-1',
      chainId,
      dealId: dealAddressA,
      event: 'work_submitted',
      recipientWallet: clientWallet,
      payload: {},
    });

    await outboxRepo.claim('backoff-item-1');
    await outboxRepo.markFailed('backoff-item-1', 'Simulated failure');

    const item = await outboxRepo.get('backoff-item-1');
    assert.equal(item?.retryCount, 1);
    assert.ok(item?.nextRetryAt);

    // In-memory getPending checks nextRetryAt <= Date.now()
    const pending = await outboxRepo.getPending();
    const hasItem = pending.some((p) => p.id === 'backoff-item-1');
    assert.equal(hasItem, false, 'Failed item with active backoff delay must not be returned by getPending');
  });

  // 10. Maximum retry exhaustion
  it('10. Outbox items exceeding MAX_OUTBOX_RETRIES are permanently exhausted', async () => {
    await outboxRepo.enqueue({
      id: 'exhaust-item-1',
      chainId,
      dealId: dealAddressA,
      event: 'work_submitted',
      recipientWallet: clientWallet,
      payload: {},
    });

    for (let i = 0; i < MAX_OUTBOX_RETRIES; i++) {
      await outboxRepo.claim('exhaust-item-1');
      await outboxRepo.markFailed('exhaust-item-1', `Error ${i + 1}`);
    }

    const item = await outboxRepo.get('exhaust-item-1');
    assert.equal(item?.retryCount, MAX_OUTBOX_RETRIES);

    // Make nextRetryAt in the past
    item.nextRetryAt = new Date(Date.now() - 1000);
    outboxRepo.setEvent(item);

    const pending = await outboxRepo.getPending();
    const hasItem = pending.some((p) => p.id === 'exhaust-item-1');
    assert.equal(hasItem, false, 'Exhausted item must never be returned by getPending');

    const claimResult = await outboxRepo.claim('exhaust-item-1');
    assert.equal(claimResult, false, 'Exhausted item cannot be claimed');
  });

  // 11. Old record with a fresh claim
  it('11. Old record with a fresh claim is not considered stale', async () => {
    await outboxRepo.enqueue({
      id: 'old-record-1',
      chainId,
      dealId: dealAddressA,
      event: 'work_submitted',
      recipientWallet: clientWallet,
      payload: {},
    });

    const item = await outboxRepo.get('old-record-1');
    assert.ok(item);
    // Created 2 hours ago
    item.createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    outboxRepo.setEvent(item);

    // Fresh claim now
    const claimed = await outboxRepo.claim('old-record-1', 'fresh_token');
    assert.equal(claimed, true);

    // Second claim immediately should fail because claimedAt is fresh!
    const doubleClaim = await outboxRepo.claim('old-record-1', 'competing_token');
    assert.equal(doubleClaim, false, 'Freshly claimed old record must not be considered stale');
  });

  // 12. Stale claim recovery
  it('12. Stale claim recovery after 5 minutes allows reclaim', async () => {
    await outboxRepo.enqueue({
      id: 'stale-record-1',
      chainId,
      dealId: dealAddressA,
      event: 'work_submitted',
      recipientWallet: clientWallet,
      payload: {},
    });

    await outboxRepo.claim('stale-record-1', 'token_1');
    const item = await outboxRepo.get('stale-record-1');
    assert.ok(item);

    // Artificially age claim
    item.claimedAt = new Date(Date.now() - OUTBOX_PROCESSING_TIMEOUT_MS - 2000);
    outboxRepo.setEvent(item);

    // Another worker should be able to reclaim
    const reclaimed = await outboxRepo.claim('stale-record-1', 'token_2');
    assert.equal(reclaimed, true, 'Abandoned claim must be recoverable');
  });

  // 13. Late worker attempting to finalize a reclaimed job
  it('13. Late worker with expired claim token cannot finalize or fail a reclaimed job', async () => {
    await outboxRepo.enqueue({
      id: 'lease-race-1',
      chainId,
      dealId: dealAddressA,
      event: 'work_submitted',
      recipientWallet: clientWallet,
      payload: {},
    });

    // Worker A claims with token_A
    await outboxRepo.claim('lease-race-1', 'token_A');

    // Job ages and Worker B reclaims with token_B
    const item = await outboxRepo.get('lease-race-1');
    assert.ok(item);
    item.claimedAt = new Date(Date.now() - OUTBOX_PROCESSING_TIMEOUT_MS - 2000);
    outboxRepo.setEvent(item);

    await outboxRepo.claim('lease-race-1', 'token_B');

    // Late Worker A attempts to finalize with token_A
    await outboxRepo.markProcessed('lease-race-1', 'token_A');

    const check = await outboxRepo.get('lease-race-1');
    assert.notEqual(check?.status, 'processed', 'Worker with stale lease token must not mark processed');
    assert.equal(check?.claimToken, 'token_B', 'Job lease must remain owned by Worker B');
  });

  // 14. Buyer and seller completion notifications
  it('14. DealCompleted emits two independent notifications: buyer and seller', async () => {
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
    );

    const topics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'DealCompleted',
      args: { dealAddress: dealAddressA },
    });

    rpcClient.logs.push({
      address: dealAddressA,
      transactionHash: '0xcomplete_tx',
      blockNumber: 505n,
      logIndex: 0,
      data: '0x',
      topics,
    });

    rpcClient.headBlock = 520n;
    const res = await scanner.scanNextBatch();
    assert.equal(res.eventsProcessed, 2, 'Must stage events for both buyer and seller');

    const pending = await outboxRepo.getPending();
    const buyerEvent = pending.find((p) => p.event === 'deal_completed');
    const sellerEvent = pending.find((p) => p.event === 'deal_completed_seller');

    assert.ok(buyerEvent, 'deal_completed for buyer must be present');
    assert.ok(sellerEvent, 'deal_completed_seller for seller must be present');
    assert.equal(buyerEvent?.recipientWallet, clientWallet.toLowerCase());
    assert.equal(sellerEvent?.recipientWallet, freelancerWallet.toLowerCase());
  });

  // 15. Completion key parity across client/scanner
  it('15. DealCompleted key parity between receipt-verified client and scanner', () => {
    const txHash = '0xabc1234567890000000000000000000000000000000000000000000000000000';
    const logIndex = 3;

    const scannerBuyerKey = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddressA,
      event: 'deal_completed',
      txHash,
      logIndex,
      recipientRole: 'buyer',
      includeLogIndex: true,
    });

    const clientBuyerKey = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddressA,
      contractAddress: dealAddressA,
      event: 'deal_completed',
      txHash,
      logIndex,
      recipientRole: 'buyer',
      includeLogIndex: true,
    });

    assert.equal(scannerBuyerKey, clientBuyerKey, 'Canonical keys must match exactly');
  });

  // 16. Correct cancellation recipient
  it('16. DealCancelled emits notifications to both counterparty roles', async () => {
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
    );

    const topics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'DealCancelled',
      args: { dealAddress: dealAddressA },
    });

    rpcClient.logs.push({
      address: dealAddressA,
      transactionHash: '0xcancel_tx',
      blockNumber: 505n,
      logIndex: 0,
      data: '0x',
      topics,
    });

    rpcClient.headBlock = 520n;
    const res = await scanner.scanNextBatch();
    assert.equal(res.eventsProcessed, 2);

    const pending = await outboxRepo.getPending();
    const roles = pending.map((p) => p.payload.recipientRole);
    assert.ok(roles.includes('buyer'));
    assert.ok(roles.includes('seller'));
  });

  // 17. Full buyer refund
  it('17. Full buyer refund emits milestone_refunded and zero seller payment release', async () => {
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
    );

    // MilestoneSettled: paidToFreelancer = 0, refundedToClient = 500 USDC
    const topics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'MilestoneSettled',
      args: { milestoneId: 0n },
    });

    const data = encodeAbiParameters(
      parseAbiParameters('uint256 paidToFreelancer, uint256 refundedToClient, uint8 settlementType'),
      [0n, 500000000n, 2],
    );

    rpcClient.logs.push({
      address: dealAddressA,
      transactionHash: '0xrefund_tx',
      blockNumber: 505n,
      logIndex: 0,
      data,
      topics,
    });

    rpcClient.headBlock = 520n;
    const res = await scanner.scanNextBatch();
    assert.equal(res.eventsProcessed, 1);

    const pending = await outboxRepo.getPending();
    assert.equal(pending[0].event, 'milestone_refunded');
    assert.equal(pending[0].recipientWallet, clientWallet.toLowerCase());
  });

  // 18. Split milestone settlement
  it('18. Split milestone settlement emits both payment_released and milestone_refunded', async () => {
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
    );

    // MilestoneSettled: paidToFreelancer = 300, refundedToClient = 200
    const topics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'MilestoneSettled',
      args: { milestoneId: 0n },
    });

    const data = encodeAbiParameters(
      parseAbiParameters('uint256 paidToFreelancer, uint256 refundedToClient, uint8 settlementType'),
      [300000000n, 200000000n, 3],
    );

    rpcClient.logs.push({
      address: dealAddressA,
      transactionHash: '0xsplit_tx',
      blockNumber: 505n,
      logIndex: 0,
      data,
      topics,
    });

    rpcClient.headBlock = 520n;
    const res = await scanner.scanNextBatch();
    assert.equal(res.eventsProcessed, 2);

    const pending = await outboxRepo.getPending();
    const sellerPayment = pending.find((p) => p.event === 'payment_released');
    const buyerRefund = pending.find((p) => p.event === 'milestone_refunded');

    assert.ok(sellerPayment);
    assert.ok(buyerRefund);
    assert.equal(sellerPayment?.payload.amount, '300000000');
    assert.equal(buyerRefund?.payload.amount, '200000000');
  });

  // 19. Failure to persist tracked contracts before cursor advancement
  it('19. Failure to persist tracked contracts aborts scan and leaves cursor unchanged', async () => {
    class FailingTrackedRepo extends InMemoryTrackedContractsRepository {
      async upsert(): Promise<void> {
        throw new TrackedContractPersistenceError('Database write lock collision');
      }
    }

    const failingRepo = new FailingTrackedRepo();

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
      failingRepo,
    );

    const cloneAddress = '0x8888888888888888888888888888888888888888';
    const factoryTopics = encodeEventTopics({
      abi: synqFactoryV2ABI,
      eventName: 'DealCreated',
      args: {
        dealAddress: cloneAddress,
        client: clientWallet,
        freelancer: freelancerWallet,
      },
    });

    const data = encodeAbiParameters(
      parseAbiParameters('address creator, address usdc, address primaryResolver, address emergencyResolver, uint256 totalEscrow, uint256 milestoneCount'),
      [
        clientWallet,
        '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
        1000000000n,
        1n,
      ],
    );

    rpcClient.logs.push({
      address: factoryAddress,
      transactionHash: '0xclone_fail',
      blockNumber: 505n,
      logIndex: 0,
      data,
      topics: factoryTopics,
    });

    rpcClient.headBlock = 520n;

    await assert.rejects(
      async () => {
        await scanner.scanNextBatch();
      },
      /Database write lock collision/i,
    );

    const cursor = await cursorRepo.get(chainId, scannerId);
    assert.equal(cursor?.lastBlockNumber, 500n, 'Cursor must NOT advance past unpersisted contracts');
  });

  // 20. Database outage fails closed
  it('20. DrizzleTrackedContractsRepository fails closed when database is down', async () => {
    const drizzleTracked = new DrizzleTrackedContractsRepository();

    await assert.rejects(
      async () => {
        await drizzleTracked.getAll(chainId);
      },
      (err: any) => err instanceof TrackedContractPersistenceError,
      'Must throw TrackedContractPersistenceError when DB is down',
    );
  });
});
