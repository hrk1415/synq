/**
 * SYNQ — B.12.3.24: Mail Correctness & Historical Replay Repairs Test Suite
 *
 * Comprehensive offline regression test suite verifying:
 * 1. Log-only delivery in /api/notify records deferred, never delivered.
 * 2. Log-only delivery remains eligible for later claim and SMTP delivery.
 * 3. Log-only processing in OutboxProcessor does not burn retry attempts.
 * 4. Correct transitions for delivered, skipped, failed, and deferred states.
 * 5. Fencing and duplicate protection across claim tokens.
 * 6. Rehydration with valid persisted deployment block creates durable replay job.
 * 7. Rehydration with verified receipt event recovers block and schedules replay.
 * 8. Mismatched or reverted receipt fails closed without scheduling replay.
 * 9. Proposal with missing block metadata reports explicit unresolved state.
 * 10. Multi-factory compatibility (V2, V1, Legacy) and unverified factory fail-closed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';

import {
  InMemoryNotificationsRepository,
  setNotificationsRepository,
  resetNotificationsRepository,
  generateCanonicalDealEventKey,
} from '../src/lib/deals/notifications-db';

import {
  InMemoryDealOutboxRepository,
  setDealOutboxRepository,
  resetDealOutboxRepository,
} from '../src/lib/deals/outbox-db';

import {
  InMemoryTrackedContractsRepository,
  setTrackedContractsRepository,
  resetTrackedContractsRepository,
} from '../src/lib/deals/tracked-contracts-db';

import {
  InMemoryDealProposalRepository,
  setDealProposalRepository,
  resetDealProposalRepository,
} from '../src/lib/deals/proposals-db';

import {
  InMemoryDealReplayRepository,
  setDealReplayRepository,
} from '../src/lib/deals/deal-replay-db';

import {
  InMemoryChainCursorRepository,
  setChainCursorRepository,
  resetChainCursorRepository,
} from '../src/lib/deals/chain-sync-db';

import {
  BlockchainScanner,
  SUPPORTED_SEPOLIA_FACTORIES,
  verifyReceiptEstablishesDeal,
  type IScannerRpcClient,
} from '../src/lib/deals/chain-scanner';

import { DealContractRegistry } from '../src/lib/deals/chain-event-ingestion';
import { OutboxProcessor, type INotificationDispatcher, type DispatchResult } from '../src/lib/deals/outbox-processor';
import { POST as notifyPostHandler } from '../src/app/api/notify/route';
import { signToken } from '../src/lib/auth';
import * as db from '../src/lib/db';
import { type PersistedMilestoneV2 } from '../src/db/schema';

const defaultMilestone: PersistedMilestoneV2 = {
  amount: '1000',
  workDeadline: '1800000000',
  reviewWindow: '604800',
  gracePeriod: '86400',
  specHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
  title: 'M1',
  description: 'D1',
};

class MockScannerRpcClient implements IScannerRpcClient {
  public headBlock = 12000000n;
  public receipts = new Map<string, any>();
  public logs: any[] = [];

  async getBlockNumber(): Promise<bigint> {
    return this.headBlock;
  }

  async getBlock(params: { blockNumber: bigint }): Promise<{ hash: string; parentHash: string }> {
    return {
      hash: `0x${params.blockNumber.toString(16).padStart(64, '0')}`,
      parentHash: `0x${(params.blockNumber - 1n).toString(16).padStart(64, '0')}`,
    };
  }

  async getLogs(params: { address?: string | string[]; fromBlock: bigint; toBlock: bigint }): Promise<any[]> {
    return this.logs.filter((l) => {
      const b = BigInt(l.blockNumber);
      return b >= params.fromBlock && b <= params.toBlock;
    });
  }

  async getTransactionReceipt(params: { hash: string }): Promise<any> {
    return this.receipts.get(params.hash.toLowerCase()) || null;
  }
}

describe('SYNQ — B.12.3.24: Mail Correctness & Historical Replay Repairs', () => {
  const chainId = 11155111;
  const scannerId = 'synq-sepolia-scanner-v1';
  const buyerWallet = '0x1111111111111111111111111111111111111111';
  const sellerWallet = '0x2222222222222222222222222222222222222222';
  const v2Factory = SUPPORTED_SEPOLIA_FACTORIES[0].address;
  const v1Factory = SUPPORTED_SEPOLIA_FACTORIES[1].address;
  const legacyFactory = SUPPORTED_SEPOLIA_FACTORIES[2].address;

  let notifRepo: InMemoryNotificationsRepository;
  let outboxRepo: InMemoryDealOutboxRepository;
  let trackedRepo: InMemoryTrackedContractsRepository;
  let proposalRepo: InMemoryDealProposalRepository;
  let replayRepo: InMemoryDealReplayRepository;
  let cursorRepo: InMemoryChainCursorRepository;
  let rpcClient: MockScannerRpcClient;
  let registry: DealContractRegistry;

  const inMemoryUsers = new Map<string, any>();

  beforeEach(() => {
    inMemoryUsers.clear();
    notifRepo = new InMemoryNotificationsRepository();
    setNotificationsRepository(notifRepo);

    outboxRepo = new InMemoryDealOutboxRepository();
    setDealOutboxRepository(outboxRepo);

    trackedRepo = new InMemoryTrackedContractsRepository();
    setTrackedContractsRepository(trackedRepo);

    proposalRepo = new InMemoryDealProposalRepository();
    setDealProposalRepository(proposalRepo);

    replayRepo = new InMemoryDealReplayRepository();
    setDealReplayRepository(replayRepo);

    cursorRepo = new InMemoryChainCursorRepository();
    setChainCursorRepository(cursorRepo);

    rpcClient = new MockScannerRpcClient();
    registry = new DealContractRegistry([]);

    db.setTestUserLookup(async (id: string) => {
      return inMemoryUsers.get(id.toLowerCase()) || null;
    });

    // Seed buyer and seller users with verified emails
    inMemoryUsers.set(buyerWallet.toLowerCase(), {
      id: buyerWallet,
      walletAddress: buyerWallet,
      email: 'buyer@example.com',
    });
    inMemoryUsers.set(sellerWallet.toLowerCase(), {
      id: sellerWallet,
      walletAddress: sellerWallet,
      email: 'seller@example.com',
    });
  });

  afterEach(() => {
    resetNotificationsRepository();
    resetDealOutboxRepository();
    resetTrackedContractsRepository();
    resetDealProposalRepository();
    setDealReplayRepository(new InMemoryDealReplayRepository());
    resetChainCursorRepository();
  });

  // =========================================================================
  // TASK 1: Mail Delivery Correctness & False-Delivery Fixes
  // =========================================================================

  describe('Task 1 — /api/notify log-only deferral & delivery correctness', () => {
    it('1. /api/notify in log-only mode records deferred, never delivered', async () => {
      // Seed accepted proposal
      const proposalId = '0x' + '1'.repeat(64);
      const dealAddress = '0x4444444444444444444444444444444444444444';

      await proposalRepo.create({
        proposalId,
        proposalNonce: '1',
        chainId,
        factoryAddress: v2Factory,
        clientWallet: buyerWallet,
        freelancerWallet: sellerWallet,
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x0000000000000000000000000000000000000001',
        primaryResolver: '0x0000000000000000000000000000000000000002',
        emergencyResolver: '0x0000000000000000000000000000000000000003',
        milestonesHash: '0x' + '2'.repeat(64),
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x' + '0'.repeat(64),
        expiry: '9999999999',
        clientSignature: '0x' + '3'.repeat(130),
        title: 'Audit Fix Test',
        scope: 'Scope',
        totalAmount: '1000',
        milestones: [defaultMilestone],
        cachedStatus: 'ACCEPTED',
        dealAddress,
      });

      const token = signToken({ userId: buyerWallet, walletAddress: buyerWallet });
      const req = new NextRequest('http://localhost:3000/api/notify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          event: 'deal_confirmed',
          dealId: proposalId,
        }),
      });

      const res = await notifyPostHandler(req);
      assert.equal(res.status, 200);
      const data = await res.json();

      // Response must explicitly flag deferred and not claim success
      assert.equal(data.mode, 'log');
      assert.equal(data.deliveryStatus, 'log_only');
      assert.equal(data.deferred, true);
      assert.match(data.message, /deferred/i);

      // Verify repository status is 'deferred' and NOT 'delivered'
      const expectedKey = generateCanonicalDealEventKey({
        chainId: 11155111,
        dealId: dealAddress,
        contractAddress: dealAddress,
        event: 'deal_confirmed',
        recipientRole: 'seller',
      });

      const record = await notifRepo.get(expectedKey);
      assert.ok(record, `Notification record must exist for key ${expectedKey}`);
      assert.equal(record.status, 'deferred', 'Notification must be in deferred state, NOT delivered');
      assert.ok(!record.messageId, 'MessageId must not be present for log-only');
    });

    it('2. Deferred notification can be re-claimed and delivered when SMTP is live', async () => {
      const notifKey = '11155111:0xdeal1:deal_confirmed:role:seller';

      // 1. Initial attempt in log-only mode: claim and defer
      const claim1 = await notifRepo.claimPending(notifKey, {
        dealId: '0xdeal1',
        event: 'deal_confirmed',
        recipientWallet: sellerWallet,
      }, { fenced: true });
      assert.equal(claim1.status, 'claimed');
      await notifRepo.markDeferred(notifKey, 'SMTP log-only mode', claim1.claimToken);

      const recordAfterLog = await notifRepo.get(notifKey);
      assert.equal(recordAfterLog?.status, 'deferred');

      // 2. Immediate re-claim attempt within cooldown window is protected (preventing rapid retry loop)
      const immediateClaim = await notifRepo.claimPending(notifKey, {
        dealId: '0xdeal1',
        event: 'deal_confirmed',
        recipientWallet: sellerWallet,
      }, { fenced: true });
      assert.equal(immediateClaim.status, 'duplicate_pending', 'Immediate re-claim within cooldown must return duplicate_pending');

      // 3. Later, when cooldown has elapsed or via retry bypass, claimPending succeeds on the deferred record
      const claim2 = await notifRepo.claimPending(notifKey, {
        dealId: '0xdeal1',
        event: 'deal_confirmed',
        recipientWallet: sellerWallet,
      }, { fenced: true, bypassCooldown: true });
      assert.equal(claim2.status, 'claimed', 'Deferred record must be re-claimable once cooldown elapses');
      assert.ok(claim2.claimToken);

      // 3. Mark delivered with messageId
      const delivered = await notifRepo.markDelivered(notifKey, 'msg-12345', 'seller@example.com', claim2.claimToken);
      assert.equal(delivered, true);

      const recordDelivered = await notifRepo.get(notifKey);
      assert.equal(recordDelivered?.status, 'delivered');
      assert.equal(recordDelivered?.messageId, 'msg-12345');

      // 4. Subsequent claim is rejected as duplicate_delivered
      const claim3 = await notifRepo.claimPending(notifKey, {
        dealId: '0xdeal1',
        event: 'deal_confirmed',
        recipientWallet: sellerWallet,
      }, { fenced: true });
      assert.equal(claim3.status, 'duplicate_delivered');
    });

    it('3. OutboxProcessor defers log-only without burning retry attempts', async () => {
      const mockDispatcher: INotificationDispatcher = {
        async dispatch(): Promise<DispatchResult> {
          return {
            success: false,
            deliveryStatus: 'log_only',
            error: 'SMTP transport disabled (log-only mode)',
          };
        },
      };

      await outboxRepo.enqueue({
        id: 'outbox-log-retry-test',
        chainId,
        dealId: '0xdeal1',
        event: 'deal_confirmed',
        recipientWallet: sellerWallet,
        payload: { title: 'Test Deal' },
      });

      const processor = new OutboxProcessor(outboxRepo, notifRepo, mockDispatcher);
      const batchResult = await processor.processBatch(10);

      assert.equal(batchResult.deferredCount, 1);
      assert.equal(batchResult.processedCount, 0);
      assert.equal(batchResult.failedCount, 0);

      // Verify outbox item was deferred and retryCount was NOT incremented
      const item = await outboxRepo.get('outbox-log-retry-test');
      assert.ok(item);
      assert.equal(item.retryCount, 0, 'Log-only mode must NOT burn retries');
      assert.ok(item.nextRetryAt !== undefined, 'nextRetryAt must be set for backoff');

      // Verify notification repository recorded deferred
      const notifKey = generateCanonicalDealEventKey({
        chainId,
        dealId: '0xdeal1',
        event: 'deal_confirmed',
        recipientRole: 'seller',
      });
      const notif = await notifRepo.get(notifKey);
      assert.ok(notif);
      assert.equal(notif.status, 'deferred');
    });

    it('4. Stale claim token fencing prevents unauthorized status updates', async () => {
      const notifKey = '11155111:0xdeal1:work_submitted:ms:0:role:buyer';

      const claim = await notifRepo.claimPending(notifKey, {
        dealId: '0xdeal1',
        event: 'work_submitted',
        recipientWallet: buyerWallet,
      }, { fenced: true });

      assert.equal(claim.status, 'claimed');
      const validToken = claim.claimToken!;
      const invalidToken = 'wrong-token-uuid';

      // Updates with invalid token fail
      assert.equal(await notifRepo.markDelivered(notifKey, 'msg-1', 'b@ex.com', invalidToken), false);
      assert.equal(await notifRepo.markDeferred(notifKey, 'reason', invalidToken), false);
      assert.equal(await notifRepo.markFailed(notifKey, 'err', invalidToken), false);
      assert.equal(await notifRepo.markSkipped(notifKey, 'skip', invalidToken), false);

      // Record remains pending with valid token
      const current = await notifRepo.get(notifKey);
      assert.equal(current?.status, 'pending');

      // Update with valid token succeeds
      assert.equal(await notifRepo.markDelivered(notifKey, 'msg-1', 'b@ex.com', validToken), true);
      const updated = await notifRepo.get(notifKey);
      assert.equal(updated?.status, 'delivered');
    });
  });

  // =========================================================================
  // TASK 2: Accepted Deal Historical Replay Repairs
  // =========================================================================

  describe('Task 2 — Accepted deal historical replay discovery & deployment block recovery', () => {
    it('5. Rehydrates proposal with persisted deploymentBlock and schedules replay behind cursor', async () => {
      const dealAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const proposalId = '0x' + 'a'.repeat(64);

      // Seed cursor at block 12000000
      await cursorRepo.initializeIfMissing({
        chainId,
        scannerId,
        initialBlockNumber: 12000000n,
        initialBlockHash: '0x' + 'f'.repeat(64),
      });

      // Seed accepted proposal with valid deploymentBlock
      await proposalRepo.create({
        proposalId,
        proposalNonce: '1',
        chainId,
        factoryAddress: v2Factory,
        clientWallet: buyerWallet,
        freelancerWallet: sellerWallet,
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x0000000000000000000000000000000000000001',
        primaryResolver: '0x0000000000000000000000000000000000000002',
        emergencyResolver: '0x0000000000000000000000000000000000000003',
        milestonesHash: '0x' + '2'.repeat(64),
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x' + '0'.repeat(64),
        expiry: '9999999999',
        clientSignature: '0x' + '3'.repeat(130),
        title: 'Persisted Block Test',
        scope: 'Scope',
        totalAmount: '1000',
        milestones: [defaultMilestone],
        cachedStatus: 'ACCEPTED',
        dealAddress,
        deploymentBlock: '11833500', // Persisted verified block
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
        100n,
        trackedRepo,
        0n,
        proposalRepo,
        SUPPORTED_SEPOLIA_FACTORIES,
        replayRepo,
      );

      const count = await scanner.rehydrateAcceptedDeals();
      assert.equal(count, 1);

      // Verify contract was tracked with exact deploymentBlock
      const tracked = await trackedRepo.get(chainId, dealAddress);
      assert.ok(tracked);
      assert.equal(tracked.deploymentBlock, 11833500n);

      // Verify replay job was created spanning [11833500n, 12000000n]
      const job = await replayRepo.getJob(chainId, dealAddress);
      assert.ok(job);
      assert.equal(job.contractAddress, dealAddress.toLowerCase());
      assert.equal(job.fromBlock, 11833500n);
      assert.equal(job.toBlock, 12000000n);

      // Live cursor was NOT modified
      const cursor = await cursorRepo.get(chainId, scannerId);
      assert.equal(cursor?.lastBlockNumber, 12000000n);
    });

    it('6. Recovers deploymentBlock from verified acceptance receipt and backfills proposal', async () => {
      const dealAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const proposalId = '0x' + 'b'.repeat(64);
      const txHash = '0x' + 'e'.repeat(64);

      // Cursor at 12000000n
      await cursorRepo.initializeIfMissing({
        chainId,
        scannerId,
        initialBlockNumber: 12000000n,
        initialBlockHash: '0x' + 'f'.repeat(64),
      });

      // Proposal lacks deploymentBlock, but has acceptedTxHash
      await proposalRepo.create({
        proposalId,
        proposalNonce: '2',
        chainId,
        factoryAddress: v2Factory,
        clientWallet: buyerWallet,
        freelancerWallet: sellerWallet,
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x0000000000000000000000000000000000000001',
        primaryResolver: '0x0000000000000000000000000000000000000002',
        emergencyResolver: '0x0000000000000000000000000000000000000003',
        milestonesHash: '0x' + '2'.repeat(64),
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x' + '0'.repeat(64),
        expiry: '9999999999',
        clientSignature: '0x' + '3'.repeat(130),
        title: 'Receipt Recovery Test',
        scope: 'Scope',
        totalAmount: '1000',
        milestones: [defaultMilestone],
        cachedStatus: 'ACCEPTED',
        dealAddress,
        acceptedTxHash: txHash,
      });

      // Mock receipt with event evidence establishing contract creation
      rpcClient.receipts.set(txHash.toLowerCase(), {
        blockNumber: 11834000n,
        status: 'success',
        logs: [
          {
            address: v2Factory,
            topics: ['0xDealCreatedTopic', `0x000000000000000000000000${dealAddress.slice(2).toLowerCase()}`],
            data: '0x',
          },
        ],
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
        100n,
        trackedRepo,
        0n,
        proposalRepo,
        SUPPORTED_SEPOLIA_FACTORIES,
        replayRepo,
      );

      const count = await scanner.rehydrateAcceptedDeals();
      assert.equal(count, 1);

      // Verify tracked contract received verified block
      const tracked = await trackedRepo.get(chainId, dealAddress);
      assert.ok(tracked);
      assert.equal(tracked.deploymentBlock, 11834000n);

      // Verify proposal in repository was backfilled with deploymentBlock
      const proposalAfter = await proposalRepo.getById(proposalId);
      assert.equal(proposalAfter?.deploymentBlock, '11834000');

      // Verify replay job was scheduled
      const job = await replayRepo.getJob(chainId, dealAddress);
      assert.ok(job);
      assert.equal(job.fromBlock, 11834000n);
      assert.equal(job.toBlock, 12000000n);
    });

    it('7. Mismatched or reverted receipt fails closed: does NOT schedule replay, marks unresolved', async () => {
      const dealAddress = '0xcccccccccccccccccccccccccccccccccccccccc';
      const proposalId = '0x' + 'c'.repeat(64);
      const txHashReverted = '0x' + 'd'.repeat(64);

      await cursorRepo.initializeIfMissing({
        chainId,
        scannerId,
        initialBlockNumber: 12000000n,
        initialBlockHash: '0x' + 'f'.repeat(64),
      });

      await proposalRepo.create({
        proposalId,
        proposalNonce: '3',
        chainId,
        factoryAddress: v2Factory,
        clientWallet: buyerWallet,
        freelancerWallet: sellerWallet,
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x0000000000000000000000000000000000000001',
        primaryResolver: '0x0000000000000000000000000000000000000002',
        emergencyResolver: '0x0000000000000000000000000000000000000003',
        milestonesHash: '0x' + '2'.repeat(64),
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x' + '0'.repeat(64),
        expiry: '9999999999',
        clientSignature: '0x' + '3'.repeat(130),
        title: 'Reverted Receipt Test',
        scope: 'Scope',
        totalAmount: '1000',
        milestones: [defaultMilestone],
        cachedStatus: 'ACCEPTED',
        dealAddress,
        acceptedTxHash: txHashReverted,
      });

      // Receipt is reverted and unrelated
      rpcClient.receipts.set(txHashReverted.toLowerCase(), {
        blockNumber: 11835000n,
        status: 'reverted',
        logs: [],
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
        100n,
        trackedRepo,
        0n,
        proposalRepo,
        SUPPORTED_SEPOLIA_FACTORIES,
        replayRepo,
      );

      const count = await scanner.rehydrateAcceptedDeals();
      assert.equal(count, 1);

      // Must NOT schedule a replay job for block zero or unverified block
      const job = await replayRepo.getJob(chainId, dealAddress);
      assert.equal(job, null, 'Must NOT schedule replay job for unverified receipt');

      // Tracked metadata records explicit unresolved state
      const tracked = await trackedRepo.get(chainId, dealAddress);
      assert.ok(tracked);
      assert.equal(tracked.metadata?.deploymentBlockUnresolved, true);
    });

    it('8. verifyReceiptEstablishesDeal rejects unrelated transaction logs', () => {
      const dealAddr = '0x1234567890123456789012345678901234567890';
      const resolution = {
        supported: true,
        contractType: 'deal_v2' as const,
        generation: 'v2' as const,
        factoryAddress: v2Factory,
      };

      // 1. Completely unrelated log
      const unrelatedReceipt = {
        status: 'success',
        logs: [
          {
            address: '0x9999999999999999999999999999999999999999',
            topics: ['0xUnrelated'],
            data: '0x',
          },
        ],
      };
      assert.equal(verifyReceiptEstablishesDeal(unrelatedReceipt, dealAddr, resolution), false);

      // 2. Factory log but for a different deal address
      const otherDeal = '0x9999999999999999999999999999999999999999';
      const otherReceipt = {
        status: 'success',
        logs: [
          {
            address: v2Factory,
            topics: ['0xDealCreatedTopic', `0x000000000000000000000000${otherDeal.slice(2)}`],
            data: '0x',
          },
        ],
      };
      assert.equal(verifyReceiptEstablishesDeal(otherReceipt, dealAddr, resolution), false);

      // 3. Reverted status with matching logs
      const revertedReceipt = {
        status: 'reverted',
        logs: [
          {
            address: dealAddr,
            topics: ['0xSomeTopic'],
            data: '0x',
          },
        ],
      };
      assert.equal(verifyReceiptEstablishesDeal(revertedReceipt, dealAddr, resolution), false);

      // 4. Matching log from dealAddr directly
      const validDirectReceipt = {
        status: 'success',
        logs: [
          {
            address: dealAddr,
            topics: ['0xSomeTopic'],
            data: '0x',
          },
        ],
      };
      assert.equal(verifyReceiptEstablishesDeal(validDirectReceipt, dealAddr, resolution), true);
    });

    it('9. Rehydration idempotency: running twice does not duplicate replay jobs', async () => {
      const dealAddress = '0xdddddddddddddddddddddddddddddddddddddddd';
      const proposalId = '0x' + 'd'.repeat(64);

      await cursorRepo.initializeIfMissing({
        chainId,
        scannerId,
        initialBlockNumber: 12000000n,
        initialBlockHash: '0x' + 'f'.repeat(64),
      });

      await proposalRepo.create({
        proposalId,
        proposalNonce: '4',
        chainId,
        factoryAddress: v2Factory,
        clientWallet: buyerWallet,
        freelancerWallet: sellerWallet,
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x0000000000000000000000000000000000000001',
        primaryResolver: '0x0000000000000000000000000000000000000002',
        emergencyResolver: '0x0000000000000000000000000000000000000003',
        milestonesHash: '0x' + '2'.repeat(64),
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x' + '0'.repeat(64),
        expiry: '9999999999',
        clientSignature: '0x' + '3'.repeat(130),
        title: 'Idempotency Test',
        scope: 'Scope',
        totalAmount: '1000',
        milestones: [defaultMilestone],
        cachedStatus: 'ACCEPTED',
        dealAddress,
        deploymentBlock: '11833600',
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
        100n,
        trackedRepo,
        0n,
        proposalRepo,
        SUPPORTED_SEPOLIA_FACTORIES,
        replayRepo,
      );

      // Run 1
      const count1 = await scanner.rehydrateAcceptedDeals();
      assert.equal(count1, 1);

      // Run 2: already registered in memory registry -> skipped cleanly
      const count2 = await scanner.rehydrateAcceptedDeals();
      assert.equal(count2, 0);

      const job = await replayRepo.getJob(chainId, dealAddress);
      assert.ok(job, 'Must have replay job');
    });

    it('10. Multi-factory support: Synq V1 and Legacy Nexotiq proposals rehydrate cleanly', async () => {
      const v1Deal = '0x1111111111111111111111111111111111111112';
      const legacyDeal = '0x2222222222222222222222222222222222222223';

      await cursorRepo.initializeIfMissing({
        chainId,
        scannerId,
        initialBlockNumber: 12000000n,
        initialBlockHash: '0x' + 'f'.repeat(64),
      });

      // V1 proposal
      await proposalRepo.create({
        proposalId: '0x' + '1'.repeat(64),
        proposalNonce: '5',
        chainId,
        factoryAddress: v1Factory,
        clientWallet: buyerWallet,
        freelancerWallet: sellerWallet,
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x0000000000000000000000000000000000000001',
        primaryResolver: '0x0000000000000000000000000000000000000002',
        emergencyResolver: '0x0000000000000000000000000000000000000003',
        milestonesHash: '0x' + '2'.repeat(64),
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x' + '0'.repeat(64),
        expiry: '9999999999',
        clientSignature: '0x' + '3'.repeat(130),
        title: 'V1 Proposal',
        scope: 'Scope',
        totalAmount: '1000',
        milestones: [defaultMilestone],
        cachedStatus: 'ACCEPTED',
        dealAddress: v1Deal,
        deploymentBlock: '11832800',
      });

      // Legacy Nexotiq proposal
      await proposalRepo.create({
        proposalId: '0x' + '2'.repeat(64),
        proposalNonce: '6',
        chainId,
        factoryAddress: legacyFactory,
        clientWallet: buyerWallet,
        freelancerWallet: sellerWallet,
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x0000000000000000000000000000000000000001',
        primaryResolver: '0x0000000000000000000000000000000000000002',
        emergencyResolver: '0x0000000000000000000000000000000000000003',
        milestonesHash: '0x' + '2'.repeat(64),
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x' + '0'.repeat(64),
        expiry: '9999999999',
        clientSignature: '0x' + '3'.repeat(130),
        title: 'Legacy Proposal',
        scope: 'Scope',
        totalAmount: '1000',
        milestones: [defaultMilestone],
        cachedStatus: 'ACCEPTED',
        dealAddress: legacyDeal,
        deploymentBlock: '11508000',
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
        100n,
        trackedRepo,
        0n,
        proposalRepo,
        SUPPORTED_SEPOLIA_FACTORIES,
        replayRepo,
      );

      const count = await scanner.rehydrateAcceptedDeals();
      assert.equal(count, 2);

      const v1Tracked = await trackedRepo.get(chainId, v1Deal);
      assert.equal(v1Tracked?.metadata?.generation, 'v1');
      assert.equal(v1Tracked?.contractType, 'deal_v1');

      const legacyTracked = await trackedRepo.get(chainId, legacyDeal);
      assert.equal(legacyTracked?.metadata?.generation, 'legacy');
      assert.equal(legacyTracked?.contractType, 'deal_v1');

      const v1Job = await replayRepo.getJob(chainId, v1Deal);
      assert.ok(v1Job);
      const legacyJob = await replayRepo.getJob(chainId, legacyDeal);
      assert.ok(legacyJob);
    });

    it('11. Unverified or unrecognized factory fails closed', async () => {
      const unknownDeal = '0x3333333333333333333333333333333333333334';
      const unknownFactory = '0x9999999999999999999999999999999999999999';

      await cursorRepo.initializeIfMissing({
        chainId,
        scannerId,
        initialBlockNumber: 12000000n,
        initialBlockHash: '0x' + 'f'.repeat(64),
      });

      await proposalRepo.create({
        proposalId: '0x' + '3'.repeat(64),
        proposalNonce: '7',
        chainId,
        factoryAddress: unknownFactory,
        clientWallet: buyerWallet,
        freelancerWallet: sellerWallet,
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x0000000000000000000000000000000000000001',
        primaryResolver: '0x0000000000000000000000000000000000000002',
        emergencyResolver: '0x0000000000000000000000000000000000000003',
        milestonesHash: '0x' + '2'.repeat(64),
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x' + '0'.repeat(64),
        expiry: '9999999999',
        clientSignature: '0x' + '3'.repeat(130),
        title: 'Unknown Factory Proposal',
        scope: 'Scope',
        totalAmount: '1000',
        milestones: [defaultMilestone],
        cachedStatus: 'ACCEPTED',
        dealAddress: unknownDeal,
        deploymentBlock: '11833500',
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
        100n,
        trackedRepo,
        0n,
        proposalRepo,
        SUPPORTED_SEPOLIA_FACTORIES,
        replayRepo,
      );

      const count = await scanner.rehydrateAcceptedDeals();
      assert.equal(count, 0, 'Unrecognized factory must be rejected');

      const tracked = await trackedRepo.get(chainId, unknownDeal);
      assert.equal(tracked, null, 'Contract must NOT be tracked');

      const job = await replayRepo.getJob(chainId, unknownDeal);
      assert.equal(job, null, 'No replay jobs must be created');
    });
  });
});
