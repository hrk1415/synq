/**
 * SYNQ — B.12.3.2 Durable Autonomous Notification Foundation Offline Tests
 *
 * Covers:
 * 1. Initial cursor creation
 * 2. Monotonic cursor advancement
 * 3. Concurrent cursor updates
 * 4. Interrupted scan recovery
 * 5. Block hash mismatch
 * 6. Reorg replay
 * 7. Duplicate blockchain logs
 * 8. Different logs in the same transaction
 * 9. Newly discovered contract with earlier events
 * 10. Multiple deal contracts
 * 11. Duplicate off-chain proposal events
 * 12. Interrupted off-chain notification scheduling
 * 13. Database failure
 * 14. Existing B.12.2 notification compatibility
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryChainCursorRepository,
  DrizzleChainCursorRepository,
  ChainSyncPersistenceError,
  setChainCursorRepository,
  resetChainCursorRepository,
  formatCursorId,
} from '../src/lib/deals/chain-sync-db';

import {
  InMemoryDealOutboxRepository,
  DrizzleDealOutboxRepository,
  DealOutboxPersistenceError,
  deriveOutboxEventId,
  setDealOutboxRepository,
  resetDealOutboxRepository,
  OUTBOX_PROCESSING_TIMEOUT_MS,
} from '../src/lib/deals/outbox-db';

import {
  validateChainId,
  calculateScanRange,
  verifyBlockHashContinuity,
  calculateReorgRewindBlock,
  deriveCanonicalLogId,
  DealContractRegistry,
  deduplicateAndFilterLogs,
  type RawLog,
  DEFAULT_CONFIRMATION_DEPTH,
} from '../src/lib/deals/chain-event-ingestion';

import {
  generateNotificationKey,
  generateCanonicalDealEventKey,
  InMemoryNotificationsRepository,
  DrizzleNotificationsRepository,
  NotificationPersistenceError,
} from '../src/lib/deals/notifications-db';

import {
  InMemoryDealProposalRepository,
  setDealProposalRepository,
  resetDealProposalRepository,
  createDealProposal,
} from '../src/lib/deals/proposals-db';

describe('SYNQ — B.12.3.2 Durable Autonomous Notification Foundation Suite', () => {
  const chainId = 11155111;
  const scannerId = 'v2_deal_scanner';
  const clientWallet = '0x1111111111111111111111111111111111111111';
  const freelancerWallet = '0x2222222222222222222222222222222222222222';
  const factoryAddress = '0x3333333333333333333333333333333333333333';
  const dealAddressA = '0x4444444444444444444444444444444444444444';
  const dealAddressB = '0x5555555555555555555555555555555555555555';

  let cursorRepo: InMemoryChainCursorRepository;
  let outboxRepo: InMemoryDealOutboxRepository;
  let notifRepo: InMemoryNotificationsRepository;
  let proposalRepo: InMemoryDealProposalRepository;

  beforeEach(() => {
    cursorRepo = new InMemoryChainCursorRepository();
    setChainCursorRepository(cursorRepo);

    outboxRepo = new InMemoryDealOutboxRepository();
    setDealOutboxRepository(outboxRepo);

    notifRepo = new InMemoryNotificationsRepository();
    proposalRepo = new InMemoryDealProposalRepository();
    setDealProposalRepository(proposalRepo);
  });

  afterEach(() => {
    resetChainCursorRepository();
    resetDealOutboxRepository();
    resetDealProposalRepository();
  });

  // ---------------------------------------------------------------------------
  // 1. Initial cursor creation
  // ---------------------------------------------------------------------------
  it('1. Initial cursor creation persists cleanly and subsequent initialization is idempotent', async () => {
    const initialBlock = 1000n;
    const initialHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const cursor = await cursorRepo.initializeIfMissing({
      chainId,
      scannerId,
      initialBlockNumber: initialBlock,
      initialBlockHash: initialHash,
    });

    assert.equal(cursor.id, formatCursorId(chainId, scannerId));
    assert.equal(cursor.chainId, chainId);
    assert.equal(cursor.scannerId, scannerId);
    assert.equal(cursor.lastBlockNumber, initialBlock);
    assert.equal(cursor.lastBlockHash, initialHash.toLowerCase());

    // Second initialization call must return existing record without overwriting
    const existing = await cursorRepo.initializeIfMissing({
      chainId,
      scannerId,
      initialBlockNumber: 2000n,
      initialBlockHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });

    assert.equal(existing.lastBlockNumber, 1000n, 'Cursor must not be overwritten by redundant initialization');
    assert.equal(existing.lastBlockHash, initialHash.toLowerCase());
  });

  // ---------------------------------------------------------------------------
  // 2. Monotonic cursor advancement
  // ---------------------------------------------------------------------------
  it('2. Cursor advances monotonically and rejects backwards or equal block advancement', async () => {
    await cursorRepo.initializeIfMissing({
      chainId,
      scannerId,
      initialBlockNumber: 1000n,
      initialBlockHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
    });

    const advanceResult = await cursorRepo.advance({
      chainId,
      scannerId,
      expectedLastBlockNumber: 1000n,
      newBlockNumber: 1020n,
      newBlockHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
    });

    assert.equal(advanceResult.status, 'advanced');
    if (advanceResult.status === 'advanced') {
      assert.equal(advanceResult.cursor.lastBlockNumber, 1020n);
    }

    // Monotonicity check: Advancing backwards or to same block must throw
    await assert.rejects(
      async () => {
        await cursorRepo.advance({
          chainId,
          scannerId,
          expectedLastBlockNumber: 1020n,
          newBlockNumber: 1015n, // Lower than current!
          newBlockHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
        });
      },
      /Monotonicity violation/i,
    );
  });

  // ---------------------------------------------------------------------------
  // 3. Concurrent cursor updates
  // ---------------------------------------------------------------------------
  it('3. Concurrent cursor updates with CAS condition protect against lost updates and race conditions', async () => {
    await cursorRepo.initializeIfMissing({
      chainId,
      scannerId,
      initialBlockNumber: 500n,
      initialBlockHash: '0x5000000000000000000000000000000000000000000000000000000000000000',
    });

    // Worker 1 and Worker 2 both read block 500
    // Worker 1 finishes first and advances cursor to 510
    const worker1Result = await cursorRepo.advance({
      chainId,
      scannerId,
      expectedLastBlockNumber: 500n,
      newBlockNumber: 510n,
      newBlockHash: '0x5100000000000000000000000000000000000000000000000000000000000000',
    });
    assert.equal(worker1Result.status, 'advanced');

    // Worker 2 attempts to advance based on stale cursor (expected 500n, but now it is 510n)
    const worker2Result = await cursorRepo.advance({
      chainId,
      scannerId,
      expectedLastBlockNumber: 500n,
      newBlockNumber: 510n,
      newBlockHash: '0x5100000000000000000000000000000000000000000000000000000000000000',
    });

    assert.equal(worker2Result.status, 'conflict_stale', 'Worker 2 must receive conflict_stale result');
    if (worker2Result.status === 'conflict_stale') {
      assert.equal(worker2Result.currentCursor.lastBlockNumber, 510n);
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Interrupted scan recovery
  // ---------------------------------------------------------------------------
  it('4. Interrupted scan recovery resumes from cursor.lastBlockNumber + 1 without skipping blocks', async () => {
    await cursorRepo.initializeIfMissing({
      chainId,
      scannerId,
      initialBlockNumber: 200n,
      initialBlockHash: '0x2000000000000000000000000000000000000000000000000000000000000000',
    });

    // Scanner crashed after processing up to 250n
    await cursorRepo.advance({
      chainId,
      scannerId,
      expectedLastBlockNumber: 200n,
      newBlockNumber: 250n,
      newBlockHash: '0x2500000000000000000000000000000000000000000000000000000000000000',
    });

    const stored = await cursorRepo.get(chainId, scannerId);
    assert.ok(stored);

    // Calculate scan range with latest head 300n and confirmation depth 5n
    const range = calculateScanRange({
      currentCursorBlock: stored.lastBlockNumber,
      latestHeadBlock: 300n,
      confirmationDepth: 5n,
      maxBatchSize: 100n,
    });

    assert.equal(range.shouldScan, true);
    assert.equal(range.fromBlock, 251n, 'Scan must resume strictly from block 251');
    assert.equal(range.toBlock, 295n, 'Scan must respect confirmation depth (300 - 5 = 295)');
  });

  // ---------------------------------------------------------------------------
  // 5. Block hash mismatch
  // ---------------------------------------------------------------------------
  it('5. Block hash verification detects parent hash mismatch during reorganization', () => {
    const recordedCursorHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const legitimateParentHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const reorganizedParentHash = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

    const valid = verifyBlockHashContinuity({
      expectedParentHash: recordedCursorHash,
      actualParentHash: legitimateParentHash,
    });
    assert.equal(valid, true);

    const reorg = verifyBlockHashContinuity({
      expectedParentHash: recordedCursorHash,
      actualParentHash: reorganizedParentHash,
    });
    assert.equal(reorg, false, 'Parent hash mismatch must be detected');
  });

  // ---------------------------------------------------------------------------
  // 6. Reorg replay
  // ---------------------------------------------------------------------------
  it('6. Reorg recovery calculates rollback target and atomically rewinds cursor', async () => {
    await cursorRepo.initializeIfMissing({
      chainId,
      scannerId,
      initialBlockNumber: 1000n,
      initialBlockHash: '0x1000000000000000000000000000000000000000000000000000000000000000',
    });

    // Advance cursor to 1050n
    await cursorRepo.advance({
      chainId,
      scannerId,
      expectedLastBlockNumber: 1000n,
      newBlockNumber: 1050n,
      newBlockHash: '0x1050000000000000000000000000000000000000000000000000000000000000',
    });

    // Calculate reorg rewind block with rewind depth 10n
    const targetBlock = calculateReorgRewindBlock({
      currentCursorBlock: 1050n,
      rewindDepth: 10n,
      minAllowedBlock: 1000n,
    });
    assert.equal(targetBlock, 1040n);

    // Execute atomic rewind
    const rewindResult = await cursorRepo.rewind({
      chainId,
      scannerId,
      expectedLastBlockNumber: 1050n,
      targetBlockNumber: 1040n,
      targetBlockHash: '0x1040000000000000000000000000000000000000000000000000000000000000',
    });

    assert.equal(rewindResult.status, 'rewound');
    const updated = await cursorRepo.get(chainId, scannerId);
    assert.equal(updated?.lastBlockNumber, 1040n);
  });

  // ---------------------------------------------------------------------------
  // 7. Duplicate blockchain logs
  // ---------------------------------------------------------------------------
  it('7. Duplicate blockchain logs in a block batch are deduplicated by canonical log identity', () => {
    const registry = new DealContractRegistry([
      { address: dealAddressA, contractType: 'deal_v2', deploymentBlock: 100n },
    ]);

    const logs: RawLog[] = [
      {
        address: dealAddressA,
        transactionHash: '0xabc123',
        blockNumber: 105n,
        logIndex: 0,
        data: '0x',
        topics: ['0x111'],
      },
      {
        address: dealAddressA,
        transactionHash: '0xabc123',
        blockNumber: 105n,
        logIndex: 0, // Duplicate!
        data: '0x',
        topics: ['0x111'],
      },
    ];

    const result = deduplicateAndFilterLogs({
      chainId,
      logs,
      registry,
    });

    assert.equal(result.relevantLogs.length, 1);
    assert.equal(result.duplicateCount, 1);
  });

  // ---------------------------------------------------------------------------
  // 8. Different logs in the same transaction
  // ---------------------------------------------------------------------------
  it('8. Different logs in the same transaction maintain unique identities and do not collide', () => {
    const logAId = deriveCanonicalLogId({ chainId, transactionHash: '0xdeadbeef', logIndex: 0 });
    const logBId = deriveCanonicalLogId({ chainId, transactionHash: '0xdeadbeef', logIndex: 1 });

    assert.notEqual(logAId, logBId, 'Log IDs in the same transaction must be unique');

    // Canonical notification keys with log disambiguation
    const notifA = generateNotificationKey({
      chainId,
      dealId: dealAddressA,
      event: 'payment_released',
      milestoneIndex: 0,
      txHash: '0xdeadbeef',
      logIndex: 0,
      recipientRole: 'seller',
    });

    const notifB = generateNotificationKey({
      chainId,
      dealId: dealAddressA,
      event: 'deal_completed',
      txHash: '0xdeadbeef',
      logIndex: 1,
      recipientRole: 'buyer',
    });

    assert.notEqual(notifA, notifB, 'Notification keys in the same transaction must not collide');
  });

  // ---------------------------------------------------------------------------
  // 9. Newly discovered contract with earlier events
  // ---------------------------------------------------------------------------
  it('9. Newly discovered contract detects replay requirement from its deployment block', () => {
    const registry = new DealContractRegistry();

    // Dynamically register newly discovered deal clone deployed at block 500n
    const discovered = registry.discoverDealClone({
      factoryAddress,
      dealAddress: dealAddressA,
      deploymentBlock: 500n,
    });

    assert.equal(discovered.address.toLowerCase(), dealAddressA.toLowerCase());
    assert.equal(registry.isRegistered(dealAddressA), true);

    // If scanner cursor is currently at block 600n, contract deployed at 500n requires replay
    const replayCheck = registry.checkReplayRequirement(dealAddressA, 600n);
    assert.equal(replayCheck.shouldReplay, true);
    assert.equal(replayCheck.deploymentBlock, 500n);

    // If scanner cursor is at block 450n, no retroactive replay needed
    const noReplay = registry.checkReplayRequirement(dealAddressA, 450n);
    assert.equal(noReplay.shouldReplay, false);
  });

  // ---------------------------------------------------------------------------
  // 10. Multiple deal contracts
  // ---------------------------------------------------------------------------
  it('10. Multiple deal contracts are tracked concurrently and untracked contracts are filtered out', () => {
    const registry = new DealContractRegistry([
      { address: dealAddressA, contractType: 'deal_v2', deploymentBlock: 100n },
      { address: dealAddressB, contractType: 'deal_v2', deploymentBlock: 120n },
    ]);

    const untrackedAddress = '0x9999999999999999999999999999999999999999';

    const logs: RawLog[] = [
      { address: dealAddressA, transactionHash: '0x1', blockNumber: 150n, logIndex: 0, data: '0x', topics: [] },
      { address: dealAddressB, transactionHash: '0x2', blockNumber: 150n, logIndex: 0, data: '0x', topics: [] },
      { address: untrackedAddress, transactionHash: '0x3', blockNumber: 150n, logIndex: 0, data: '0x', topics: [] },
    ];

    const result = deduplicateAndFilterLogs({
      chainId,
      logs,
      registry,
    });

    assert.equal(result.relevantLogs.length, 2);
    assert.equal(result.untrackedCount, 1);
  });

  // ---------------------------------------------------------------------------
  // 11. Duplicate off-chain proposal events
  // ---------------------------------------------------------------------------
  it('11. Duplicate off-chain proposal event enqueueing is idempotent and does not create duplicate entries', async () => {
    const eventId = deriveOutboxEventId({
      chainId,
      dealId: 'prop-123',
      event: 'proposal_received',
      recipientWallet: freelancerWallet,
    });

    const firstResult = await outboxRepo.enqueue({
      id: eventId,
      chainId,
      dealId: 'prop-123',
      event: 'proposal_received',
      recipientWallet: freelancerWallet,
      payload: { title: 'Synq Audit' },
    });
    assert.equal(firstResult, 'enqueued');

    // Repeated request
    const secondResult = await outboxRepo.enqueue({
      id: eventId,
      chainId,
      dealId: 'prop-123',
      event: 'proposal_received',
      recipientWallet: freelancerWallet,
      payload: { title: 'Synq Audit' },
    });
    assert.equal(secondResult, 'duplicate', 'Repeated enqueue must return duplicate');

    const pending = await outboxRepo.getPending();
    assert.equal(pending.length, 1, 'Only one outbox entry must exist');
  });

  // ---------------------------------------------------------------------------
  // 12. Interrupted off-chain notification scheduling
  // ---------------------------------------------------------------------------
  it('12. Interrupted off-chain notification claim recovers after timeout and supports retry on failure', async () => {
    const eventId = deriveOutboxEventId({
      chainId,
      dealId: 'prop-456',
      event: 'proposal_received',
      recipientWallet: freelancerWallet,
    });

    await outboxRepo.enqueue({
      id: eventId,
      chainId,
      dealId: 'prop-456',
      event: 'proposal_received',
      recipientWallet: freelancerWallet,
      payload: { title: 'Freelance Dev' },
    });

    // Worker claims event
    const claimed = await outboxRepo.claim(eventId);
    assert.equal(claimed, true);

    // Immediate second claim while processing is blocked
    const doubleClaim = await outboxRepo.claim(eventId);
    assert.equal(doubleClaim, false);

    // Simulate crash/interruption by making record stale
    const item = await outboxRepo.get(eventId);
    assert.ok(item);
    item.createdAt = new Date(Date.now() - OUTBOX_PROCESSING_TIMEOUT_MS - 1000);
    outboxRepo.setEvent(item);

    // Stale crash recovery: can be claimed again
    const recoveredClaim = await outboxRepo.claim(eventId);
    assert.equal(recoveredClaim, true, 'Stale processing outbox item must be reclaimable');

    // Mark failed and verify retry eligibility
    await outboxRepo.markFailed(eventId, 'Network timeout');
    const failedItem = await outboxRepo.get(eventId);
    assert.equal(failedItem?.status, 'failed');
    assert.equal(failedItem?.retryCount, 1);

    const retryClaim = await outboxRepo.claim(eventId);
    assert.equal(retryClaim, true, 'Failed outbox item must be eligible for retry');
  });

  // ---------------------------------------------------------------------------
  // 13. Database failure
  // ---------------------------------------------------------------------------
  it('13. Drizzle cursor and outbox repositories fail closed with specific persistence errors when database is down', async () => {
    const drizzleCursor = new DrizzleChainCursorRepository();
    const drizzleOutbox = new DrizzleDealOutboxRepository();

    // In offline test without live PostgreSQL, drizzle repositories must throw persistence errors
    await assert.rejects(
      async () => {
        await drizzleCursor.get(chainId, scannerId);
      },
      (err: any) => err instanceof ChainSyncPersistenceError,
    );

    await assert.rejects(
      async () => {
        await drizzleOutbox.get('any-id');
      },
      (err: any) => err instanceof DealOutboxPersistenceError,
    );
  });

  // ---------------------------------------------------------------------------
  // 14. Existing B.12.2 notification compatibility
  // ---------------------------------------------------------------------------
  it('14. Client-triggered and server-scanned events generate consistent canonical keys and deduplicate identically', async () => {
    const txHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

    // 1. Client triggers notification after submitting payment tx
    const clientKey = generateNotificationKey({
      chainId: 11155111,
      dealId: dealAddressA,
      event: 'payment_released',
      milestoneIndex: 0,
      txHash,
      recipientRole: 'seller',
    });

    // 2. Autonomous server scanner scans the block containing the payment log
    const serverKey = generateCanonicalDealEventKey({
      chainId: 11155111,
      contractAddress: dealAddressA,
      event: 'payment_released',
      milestoneIndex: 0,
      txHash,
      recipientRole: 'seller',
      logIndex: 2, // Log index is available on-chain
      includeLogIndex: false, // Default canonical mode matching client
    });

    assert.equal(clientKey, serverKey, 'Client and server keys for the same logical event must be identical');

    // 3. Verify deduplication in notification persistence
    const claim1 = await notifRepo.claimPending(clientKey, {
      dealId: dealAddressA,
      event: 'payment_released',
      recipientWallet: freelancerWallet,
    });
    assert.equal(claim1, 'claimed');
    await notifRepo.markDelivered(clientKey, 'msg-123');

    // Server scanner encounters same event later
    const claim2 = await notifRepo.claimPending(serverKey, {
      dealId: dealAddressA,
      event: 'payment_released',
      recipientWallet: freelancerWallet,
    });
    assert.equal(claim2, 'duplicate_delivered', 'Server scanner must recognize event already delivered by client');
  });

  // ---------------------------------------------------------------------------
  // Additional: Proposal creation automatically stages off-chain outbox event
  // ---------------------------------------------------------------------------
  it('15. Creating a deal proposal automatically stages a pending outbox event without sending emails', async () => {
    const newProposal = {
      proposalId: 'prop-stage-test',
      proposalNonce: '1',
      chainId,
      factoryAddress,
      clientWallet,
      freelancerWallet,
      canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      dealImplementation: '0x0000000000000000000000000000000000000001',
      primaryResolver: '0x0000000000000000000000000000000000000002',
      emergencyResolver: '0x0000000000000000000000000000000000000003',
      milestonesHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
      isProtected: false,
      protectionModule: '0x0000000000000000000000000000000000000000',
      policyId: '0x0000000000000000000000000000000000000000000000000000000000000000',
      expiry: '9999999999',
      clientSignature: '0x00' as `0x${string}`,
      title: 'Outbox Test Deal',
      scope: 'Testing durable outbox',
      totalAmount: '500',
      milestones: [
        {
          amount: '500',
          title: 'M1',
          workDeadline: '1000',
          reviewWindow: '100',
          gracePeriod: '50',
          specHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
        },
      ],
      cachedStatus: 'PENDING' as const,
      dealAddress: null,
      acceptedTxHash: null,
      declinedTxHash: null,
      cancelledTxHash: null,
      protectionSelection: 'STANDARD' as const,
    };

    await createDealProposal(newProposal, proposalRepo);

    // Check outbox
    const pendingEvents = await outboxRepo.getPending();
    assert.equal(pendingEvents.length, 1);
    assert.equal(pendingEvents[0].dealId, 'prop-stage-test');
    assert.equal(pendingEvents[0].event, 'proposal_received');
    assert.equal(pendingEvents[0].recipientWallet.toLowerCase(), freelancerWallet.toLowerCase());
    assert.equal(pendingEvents[0].status, 'pending');
  });
});
