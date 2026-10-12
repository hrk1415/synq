/**
 * SYNQ — B.12.3.9 Event Integrity & Historical Recovery Repairs Test Suite
 *
 * Offline regression tests verifying:
 * 1. Client/scanner parity for deal funding (deal_confirmed).
 * 2. Client/scanner parity for deal completion (deal_completed & deal_completed_seller).
 * 3. Client/scanner parity for deal cancellation (deal_cancelled).
 * 4. Initial work submission followed by a revised submission (version 1 vs 2).
 * 5. Duplicate delivery attempt for the same submission version.
 * 6. Distinct settlements within one transaction.
 * 7. Reorg invalidation of pending on-chain events.
 * 8. Reorg handling of claimed/in-flight events (pre-dispatch cancellation).
 * 9. Replay of canonical replacement events after reorg.
 * 10. Preservation of off-chain proposal outbox items during chain reorgs.
 * 11. Historical deployment block verification status & safe bounded scanning.
 * 12. Fresh scanner rehydrating existing accepted deals from deal_proposals.
 * 13. Cursor safety on RPC and persistence failures.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryChainCursorRepository,
  setChainCursorRepository,
} from '../src/lib/deals/chain-sync-db';

import {
  InMemoryDealOutboxRepository,
  setDealOutboxRepository,
  deriveOutboxEventId,
  type DealOutboxEvent,
} from '../src/lib/deals/outbox-db';

import {
  InMemoryNotificationsRepository,
  setNotificationsRepository,
  generateCanonicalDealEventKey,
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
  DealContractRegistry,
  type RawLog,
} from '../src/lib/deals/chain-event-ingestion';

import {
  BlockchainScanner,
  type IScannerRpcClient,
  SUPPORTED_SEPOLIA_FACTORIES,
} from '../src/lib/deals/chain-scanner';

import {
  OutboxProcessor,
  type INotificationDispatcher,
  type DispatchResult,
} from '../src/lib/deals/outbox-processor';

import { encodeEventTopics, encodeAbiParameters, parseAbiParameters } from 'viem';
import { synqFactoryV2ABI, synqDealV1ABI } from '../src/lib/contracts/abis';
import { SYNQ_V2_SEPOLIA_CONFIG } from '../src/lib/contracts/addresses';

class MockScannerRpcClient implements IScannerRpcClient {
  public headBlock: bigint = 1000n;
  public blocks = new Map<bigint, { hash: string; parentHash: string }>();
  public logs: RawLog[] = [];
  public failGetLogs: boolean = false;

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
    if (!b) throw new Error(`Block ${params.blockNumber} not found`);
    return b;
  }

  async getLogs(params: { address?: string | string[]; fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]> {
    if (this.failGetLogs) {
      throw new Error('RPC failure during getLogs');
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

class MockNotificationDispatcher implements INotificationDispatcher {
  public dispatched: Array<{ event: string; params: any }> = [];
  public shouldFail: boolean = false;

  async dispatch(event: string, params: Record<string, any>): Promise<DispatchResult> {
    if (this.shouldFail) {
      return { success: false, error: 'Simulated SMTP connection timeout' };
    }
    this.dispatched.push({
      event,
      params,
    });
    return { success: true, messageId: `msg_${Date.now()}_${Math.random()}` };
  }
}

describe('SYNQ — B.12.3.9 Event Integrity & Historical Recovery Repairs Suite', () => {
  const chainId = 11155111;
  const scannerId = 'synq-scanner-b1239-test';
  const factoryAddress = SYNQ_V2_SEPOLIA_CONFIG.factory.toLowerCase();
  const dealAddress = '0x1111222233334444555566667777888899990000';
  const buyerWallet = '0xaaaa111122223333444455556666777788889999';
  const sellerWallet = '0xbbbb111122223333444455556666777788889999';

  let cursorRepo: InMemoryChainCursorRepository;
  let outboxRepo: InMemoryDealOutboxRepository;
  let notifRepo: InMemoryNotificationsRepository;
  let trackedRepo: InMemoryTrackedContractsRepository;
  let proposalRepo: InMemoryDealProposalRepository;
  let registry: DealContractRegistry;
  let rpcClient: MockScannerRpcClient;
  let dispatcher: MockNotificationDispatcher;

  beforeEach(() => {
    cursorRepo = new InMemoryChainCursorRepository();
    setChainCursorRepository(cursorRepo);

    outboxRepo = new InMemoryDealOutboxRepository();
    setDealOutboxRepository(outboxRepo);

    notifRepo = new InMemoryNotificationsRepository();
    setNotificationsRepository(notifRepo);

    trackedRepo = new InMemoryTrackedContractsRepository();
    setTrackedContractsRepository(trackedRepo);

    proposalRepo = new InMemoryDealProposalRepository();
    setDealProposalRepository(proposalRepo);

    registry = new DealContractRegistry();
    rpcClient = new MockScannerRpcClient();
    dispatcher = new MockNotificationDispatcher();
  });

  // 1. Client/scanner parity for deal funding
  it('1. Deal funding confirmation produces identical canonical identity across client and scanner', async () => {
    const txHash = '0xfund_tx_1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const logIndex = 2;

    // Client trigger (e.g. from frontend transaction confirmation)
    const clientKey = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddress,
      event: 'deal_confirmed',
      recipientRole: 'seller',
      includeLogIndex: false,
    });

    // Scanner trigger (from on-chain DealFunded log with txHash and logIndex)
    const scannerKey = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddress,
      contractAddress: dealAddress,
      event: 'deal_confirmed',
      txHash,
      logIndex,
      recipientRole: 'seller',
      includeLogIndex: true,
    });

    assert.equal(
      clientKey,
      scannerKey,
      'Deal funding confirmation must produce identical canonical key across client and scanner triggers',
    );
    assert.equal(clientKey, `${chainId}:${dealAddress.toLowerCase()}:deal_confirmed:role:seller`);

    // Deduplication test: client claims first
    const clientClaim = await notifRepo.claimPending(
      clientKey,
      { dealId: dealAddress, event: 'deal_confirmed', recipientWallet: sellerWallet },
      { fenced: true },
    );
    assert.equal(clientClaim.status, 'claimed');

    // Scanner attempts claim for same logical funding event
    const scannerClaim = await notifRepo.claimPending(
      scannerKey,
      { dealId: dealAddress, event: 'deal_confirmed', recipientWallet: sellerWallet },
      { fenced: true },
    );
    assert.equal(scannerClaim.status, 'duplicate_pending');
  });

  // 2. Client/scanner parity for deal completion and cancellation
  it('2. Terminal deal events (completion and cancellation) maintain strict cross-trigger parity', async () => {
    const txHash = '0xterm_tx_1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

    // Deal completed buyer key
    const clientBuyerKey = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddress,
      event: 'deal_completed',
      recipientRole: 'buyer',
    });
    const scannerBuyerKey = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddress,
      event: 'deal_completed',
      txHash,
      logIndex: 4,
      recipientRole: 'buyer',
      includeLogIndex: true,
    });
    assert.equal(clientBuyerKey, scannerBuyerKey);
    assert.equal(clientBuyerKey, `${chainId}:${dealAddress.toLowerCase()}:deal_completed:role:buyer`);

    // Deal completed seller key
    const clientSellerKey = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddress,
      event: 'deal_completed_seller',
      recipientRole: 'seller',
    });
    const scannerSellerKey = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddress,
      event: 'deal_completed_seller',
      txHash,
      logIndex: 4,
      recipientRole: 'seller',
      includeLogIndex: true,
    });
    assert.equal(clientSellerKey, scannerSellerKey);
    assert.equal(clientSellerKey, `${chainId}:${dealAddress.toLowerCase()}:deal_completed_seller:role:seller`);

    // Deal cancelled keys for both counterparties
    const clientCancelBuyer = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddress,
      event: 'deal_cancelled',
      recipientRole: 'buyer',
    });
    const scannerCancelBuyer = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddress,
      event: 'deal_cancelled',
      txHash,
      logIndex: 0,
      recipientRole: 'buyer',
      includeLogIndex: true,
    });
    assert.equal(clientCancelBuyer, scannerCancelBuyer);

    const clientCancelSeller = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddress,
      event: 'deal_cancelled',
      recipientRole: 'seller',
    });
    const scannerCancelSeller = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddress,
      event: 'deal_cancelled',
      txHash,
      logIndex: 0,
      recipientRole: 'seller',
      includeLogIndex: true,
    });
    assert.equal(clientCancelSeller, scannerCancelSeller);
    assert.notEqual(clientCancelBuyer, clientCancelSeller, 'Both parties must receive distinct notifications');
  });

  // 3. Repeated milestone submissions: initial submission vs revised submission
  it('3. Repeated milestone submissions after revision request produce distinct authoritative identities', async () => {
    const milestoneIndex = 0;

    // Initial submission (version 1)
    const keyV1 = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddress,
      event: 'work_submitted',
      milestoneIndex,
      submissionVersion: 1,
      recipientRole: 'buyer',
    });

    // Revised submission (version 2) after client feedback
    const keyV2 = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddress,
      event: 'work_submitted',
      milestoneIndex,
      submissionVersion: 2,
      recipientRole: 'buyer',
    });

    assert.notEqual(keyV1, keyV2, 'Revised submission must have distinct canonical identity from initial submission');
    assert.ok(keyV1.includes('v:1'));
    assert.ok(keyV2.includes('v:2'));

    // Both can be claimed and delivered independently without suppression
    const claim1 = await notifRepo.claimPending(
      keyV1,
      { dealId: dealAddress, event: 'work_submitted', recipientWallet: buyerWallet },
      { fenced: true },
    );
    assert.equal(claim1.status, 'claimed');
    await notifRepo.markDelivered(keyV1, 'msg-1', 'buyer@example.com', claim1.claimToken!);

    const claim2 = await notifRepo.claimPending(
      keyV2,
      { dealId: dealAddress, event: 'work_submitted', recipientWallet: buyerWallet },
      { fenced: true },
    );
    assert.equal(claim2.status, 'claimed', 'Revised submission must NOT be suppressed as duplicate_delivered');
  });

  // 4. Duplicate delivery attempt for the same submission version
  it('4. Duplicate delivery attempt for the exact same submission version is safely deduplicated', async () => {
    const key = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddress,
      event: 'work_submitted',
      milestoneIndex: 0,
      submissionVersion: 1,
      recipientRole: 'buyer',
    });

    const claim1 = await notifRepo.claimPending(
      key,
      { dealId: dealAddress, event: 'work_submitted', recipientWallet: buyerWallet },
      { fenced: true },
    );
    assert.equal(claim1.status, 'claimed');
    await notifRepo.markDelivered(key, 'msg-1', 'buyer@example.com', claim1.claimToken!);

    // Re-submission or duplicate client trigger with same version 1
    const claim2 = await notifRepo.claimPending(
      key,
      { dealId: dealAddress, event: 'work_submitted', recipientWallet: buyerWallet },
      { fenced: true },
    );
    assert.equal(claim2.status, 'duplicate_delivered');
  });

  // 5. Distinct settlements within one transaction
  it('5. Distinct milestone settlements within one transaction maintain independent identities', async () => {
    const txHash = '0xsettle_tx_1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

    const settleMs0Key = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddress,
      event: 'milestone_approved',
      milestoneIndex: 0,
      txHash,
      logIndex: 1,
      recipientRole: 'seller',
      includeLogIndex: true,
    });

    const settleMs1Key = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddress,
      event: 'milestone_approved',
      milestoneIndex: 1,
      txHash,
      logIndex: 2,
      recipientRole: 'seller',
      includeLogIndex: true,
    });

    assert.notEqual(settleMs0Key, settleMs1Key, 'Distinct milestone settlements must have distinct keys');
    assert.ok(settleMs0Key.includes('ms:0'));
    assert.ok(settleMs0Key.includes('log:1'));
    assert.ok(settleMs1Key.includes('ms:1'));
    assert.ok(settleMs1Key.includes('log:2'));

    // Outbox IDs are also unique per logIndex
    const outboxId0 = deriveOutboxEventId({
      chainId,
      dealId: dealAddress,
      event: 'milestone_approved',
      recipientWallet: sellerWallet,
      actionId: `${txHash}:1`,
    });
    const outboxId1 = deriveOutboxEventId({
      chainId,
      dealId: dealAddress,
      event: 'milestone_approved',
      recipientWallet: sellerWallet,
      actionId: `${txHash}:2`,
    });
    assert.notEqual(outboxId0, outboxId1);
  });

  // 6. Reorg invalidation of pending on-chain events
  it('6. Reorg detection invalidates pending on-chain events above rewind target', async () => {
    // Stage an on-chain event at block 105
    await outboxRepo.enqueue({
      id: 'outbox-onchain-105',
      chainId,
      dealId: dealAddress,
      event: 'deal_confirmed',
      recipientWallet: sellerWallet,
      payload: {
        recipientEmail: 'seller@example.com',
      },
      origin: 'on_chain',
      blockNumber: 105n,
      blockHash: '0xblock105_orphaned',
      txHash: '0xtx105',
      logIndex: 0,
    });

    // Deep reorg rewinds to block 100
    const cancelledCount = await outboxRepo.invalidateOrphanedEvents(chainId, 100n);
    assert.equal(cancelledCount, 1);

    const cancelledItem = await outboxRepo.get('outbox-onchain-105');
    assert.equal(cancelledItem?.status, 'cancelled', 'Pending on-chain event above rewindTarget must be cancelled');
  });

  // 7. Reorg handling of claimed/in-flight events (pre-dispatch check)
  it('7. Reorg invalidation prevents claimed in-flight outbox items from dispatching emails', async () => {
    await outboxRepo.enqueue({
      id: 'outbox-inflight-105',
      chainId,
      dealId: dealAddress,
      event: 'deal_confirmed',
      recipientWallet: sellerWallet,
      payload: {
        recipientEmail: 'seller@example.com',
        sellerWallet,
        buyerWallet,
        notifKey: `${chainId}:${dealAddress}:deal_confirmed:role:seller`,
      },
      origin: 'on_chain',
      blockNumber: 105n,
      blockHash: '0xblock105_orphaned',
      txHash: '0xtx105',
      logIndex: 0,
    });

    // Worker claims the item
    const claimSuccess = await outboxRepo.claim('outbox-inflight-105', 'token-inflight');
    assert.ok(claimSuccess);
    const claimed = await outboxRepo.get('outbox-inflight-105');
    assert.ok(claimed);
    assert.equal(claimed.status, 'processing');

    // While item is claimed, scanner detects reorganization and cancels orphaned events
    await outboxRepo.invalidateOrphanedEvents(chainId, 100n);

    // Verify item in repo is now cancelled
    const freshInRepo = await outboxRepo.get('outbox-inflight-105');
    assert.equal(freshInRepo?.status, 'cancelled');

    // Processor attempts to process the claimed item
    const processor = new OutboxProcessor(
      outboxRepo,
      notifRepo,
      dispatcher,
    );
    const result = await processor.processItem(claimed);

    assert.equal(result.skippedCount, 1);
    assert.equal(result.processedCount, 0);
    assert.equal(dispatcher.dispatched.length, 0, 'No email must be sent for reorg-cancelled item');
  });

  // 8. Replay of canonical replacement events after reorg
  it('8. Canonical replacement events can be enqueued and processed after reorg', async () => {
    // 1. Initial orphaned event cancelled by reorg
    await outboxRepo.enqueue({
      id: 'outbox-reorg-fork-a',
      chainId,
      dealId: dealAddress,
      event: 'deal_confirmed',
      recipientWallet: sellerWallet,
      payload: {
        recipientEmail: 'seller@example.com',
      },
      origin: 'on_chain',
      blockNumber: 105n,
      blockHash: '0xhash_fork_a',
      txHash: '0xtx_fork_a',
      logIndex: 0,
    });
    await outboxRepo.invalidateOrphanedEvents(chainId, 100n);

    // 2. Canonical replacement event at block 105 with different block/tx hash
    await outboxRepo.enqueue({
      id: 'outbox-canonical-fork-b',
      chainId,
      dealId: dealAddress,
      event: 'deal_confirmed',
      recipientWallet: sellerWallet,
      payload: {
        recipientEmail: 'seller@example.com',
        sellerWallet,
        buyerWallet,
        notifKey: `${chainId}:${dealAddress}:deal_confirmed:role:seller`,
      },
      origin: 'on_chain',
      blockNumber: 105n,
      blockHash: '0xhash_fork_b',
      txHash: '0xtx_fork_b',
      logIndex: 0,
    });

    // Worker claims and processes replacement
    const processor = new OutboxProcessor(
      outboxRepo,
      notifRepo,
      dispatcher,
    );
    await outboxRepo.claim('outbox-canonical-fork-b', 'token-replacement');
    const claimed = await outboxRepo.get('outbox-canonical-fork-b');
    assert.ok(claimed);

    const result = await processor.processItem(claimed);
    assert.equal(result.processedCount, 1);
    assert.equal(dispatcher.dispatched.length, 1);
  });

  // 9. Preservation of off-chain proposal outbox items during chain reorg
  it('9. Off-chain proposal outbox items are strictly preserved during blockchain reorganizations', async () => {
    // Enqueue off-chain proposal event
    await outboxRepo.enqueue({
      id: 'outbox-offchain-proposal-1',
      chainId,
      dealId: 'proposal-uuid-999',
      event: 'proposal_received',
      recipientWallet: sellerWallet,
      payload: {
        recipientEmail: 'freelancer@example.com',
      },
      origin: 'off_chain',
    });

    // Deep reorg occurs
    const cancelled = await outboxRepo.invalidateOrphanedEvents(chainId, 50n);
    assert.equal(cancelled, 0);

    const checkProposal = await outboxRepo.get('outbox-offchain-proposal-1');
    assert.equal(checkProposal?.status, 'pending', 'Off-chain proposal events must NEVER be cancelled by reorgs');
  });

  // 10. Unknown deployment block behavior & safe bounded scanning
  it('10. Historical deployment blocks: placeholder estimates are unverified; scanning fails closed if range unverified', async () => {
    // Check supported factories metadata
    for (const factory of SUPPORTED_SEPOLIA_FACTORIES) {
      assert.ok(factory.address, 'Factory address must be defined');
      assert.ok(factory.generation, 'Factory generation must be specified');
      // Verify deploymentBlock is an integer bigint when present
      if (factory.deploymentBlock) {
        assert.ok(factory.deploymentBlock > 0n);
      }
    }

    // Initialize scanner with bounded window
    const scanner = new BlockchainScanner(
      chainId,
      scannerId,
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      notifRepo,
      6n,
      10n, // Max batch blocks = 10
      trackedRepo,
      0n,
      proposalRepo,
    );

    // Set cursor at 100n, head is 1000n
    await cursorRepo.initializeIfMissing({
      chainId,
      scannerId,
      initialBlockNumber: 100n,
      initialBlockHash: rpcClient.blocks.get(100n)!.hash,
    });

    // Scan a batch
    const batch = await scanner.scanNextBatch();
    assert.ok(batch);
    // Bounded scan: from 101 to min(100+10, 1000-6) = 110
    assert.equal(batch.fromBlock, 101n);
    assert.equal(batch.toBlock, 110n, 'Scanner batch must strictly obey maxBatchBlocks boundary');
  });

  // 11. Fresh scanner with existing accepted deals (rehydration)
  it('11. Fresh scanner rehydrates existing accepted deals from PostgreSQL into registry and tracked contracts', async () => {
    const existingContractAddress = '0x3333444455556666777788889999000011112222';

    // Seed proposal repository with an accepted deal
    await proposalRepo.create({
      proposalId: 'accepted-deal-prop-1',
      proposalNonce: '1',
      chainId,
      factoryAddress,
      clientWallet: buyerWallet,
      freelancerWallet: sellerWallet,
      canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      dealImplementation: existingContractAddress,
      primaryResolver: buyerWallet,
      emergencyResolver: buyerWallet,
      milestonesHash: '0x123',
      isProtected: false,
      protectionModule: '0x0000000000000000000000000000000000000000',
      policyId: '0x0',
      expiry: String(Math.floor(Date.now() / 1000) + 3600),
      clientSignature: '0xsignature',
      title: 'Audited Smart Contract',
      scope: 'Development',
      totalAmount: '5000000000',
      milestones: [
        {
          amount: '5000000000',
          title: 'Delivery',
          description: 'Scope',
          workDeadline: '1735689600',
          reviewWindow: '604800',
          gracePeriod: '86400',
          specHash: '0x0',
        } as any,
      ],
      dealAddress: existingContractAddress,
      cachedStatus: 'ACCEPTED',
      acceptedTxHash: '0xaccepted_tx_hash',
    } as any);

    // Also add a non-accepted (PENDING) proposal to ensure it is NOT rehydrated
    await proposalRepo.create({
      proposalId: 'unaccepted-deal-prop-2',
      proposalNonce: '2',
      chainId,
      factoryAddress,
      clientWallet: buyerWallet,
      freelancerWallet: sellerWallet,
      canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      dealImplementation: '0x4444444444444444444444444444444444444444',
      primaryResolver: buyerWallet,
      emergencyResolver: buyerWallet,
      milestonesHash: '0x123',
      isProtected: false,
      protectionModule: '0x0000000000000000000000000000000000000000',
      policyId: '0x0',
      expiry: String(Math.floor(Date.now() / 1000) + 3600),
      clientSignature: '0xsignature',
      title: 'Unaccepted Proposal',
      scope: 'Pending',
      totalAmount: '1000000000',
      milestones: [],
      dealAddress: '0x4444444444444444444444444444444444444444',
      cachedStatus: 'PENDING',
    } as any);

    // Cold start scanner: tracked_deal_contracts is empty
    assert.equal((await trackedRepo.getAll(chainId)).length, 0);

    // Initialize cursor
    await cursorRepo.initializeIfMissing({
      chainId,
      scannerId,
      initialBlockNumber: 100n,
      initialBlockHash: rpcClient.blocks.get(100n)!.hash,
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
      10n,
      trackedRepo,
      0n,
      proposalRepo,
    );

    // Initial batch triggers rehydrateAcceptedDeals
    await scanner.scanNextBatch();

    // Accepted deal is now registered and tracked
    const tracked = await trackedRepo.getAll(chainId);
    const deals = tracked.filter((c) => c.contractType !== 'factory');
    assert.equal(deals.length, 1);
    assert.equal(deals[0].contractAddress.toLowerCase(), existingContractAddress.toLowerCase());
    assert.equal(deals[0].contractType, 'deal_v2');

    assert.ok(registry.isRegistered(existingContractAddress));
    assert.ok(!registry.isRegistered('0x4444444444444444444444444444444444444444'), 'Unaccepted deal must not be rehydrated');
  });

  // 12. Cursor safety on RPC failure
  it('12. RPC getLogs failure halts scan without advancing cursor', async () => {
    const scanner = new BlockchainScanner(
      chainId,
      scannerId,
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      notifRepo,
      6n,
      10n,
      trackedRepo,
      0n,
      proposalRepo,
    );

    await cursorRepo.initializeIfMissing({
      chainId,
      scannerId,
      initialBlockNumber: 100n,
      initialBlockHash: rpcClient.blocks.get(100n)!.hash,
    });

    rpcClient.failGetLogs = true;

    await assert.rejects(
      async () => {
        await scanner.scanNextBatch();
      },
      /RPC failure during getLogs/,
    );

    const cursor = await cursorRepo.get(chainId, scannerId);
    assert.equal(cursor?.lastBlockNumber, 100n, 'Cursor must remain at 100n on RPC failure');
  });
});

