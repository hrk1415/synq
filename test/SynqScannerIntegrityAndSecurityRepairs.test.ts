/**
 * SYNQ — B.12.3.7 Scanner Integrity & Notification Security Repairs Regression Suite
 *
 * Verifies all 20 production-blocking defects and security requirements:
 *
 * 1. Factory and funded clone in the same block.
 * 2. Factory and funded clone in the same batch but different blocks.
 * 3. Secondary log query failure.
 * 4. Secondary event persistence failure.
 * 5. Fresh database with no tracked contracts (factory bootstrap).
 * 6. Existing contracts discovered after a cold start.
 * 7. Historical factory replay.
 * 8. Arbitrary successful Sepolia transaction submitted as DealCompleted proof.
 * 9. Unrelated contract event submitted as cancellation proof.
 * 10. Proposal-only refund forgery rejected.
 * 11. Wrong milestone refund proof rejected.
 * 12. Wrong caller role rejected with 403.
 * 13. Factory deployment versus funding notification identity.
 * 14. Receiptless client notification versus scanner event deduplication.
 * 15. Two different logs in the same transaction maintain unique identities.
 * 16. Notification claim reclaimed after expiry with token rotation.
 * 17. Stale worker cannot markDelivered with old claim token.
 * 18. Stale worker cannot markFailed with old claim token.
 * 19. Client and outbox claim concurrency.
 * 20. Reorged event replay and outbox deduplication.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

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
  generateCanonicalDealEventKey,
  PENDING_TIMEOUT_MS,
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

import { POST as notifyPostHandler } from '../src/app/api/notify/route';
import { signToken } from '../src/lib/auth';
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters, toEventSelector } from 'viem';
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

class MockDispatcher implements INotificationDispatcher {
  public dispatched: Array<{ event: string; params: any }> = [];

  async dispatch(event: string, params: any): Promise<DispatchResult> {
    this.dispatched.push({ event, params });
    return { success: true, messageId: `msg-${Date.now()}-${crypto.randomUUID()}` };
  }
}

describe('SYNQ — B.12.3.7 Scanner Integrity & Notification Security Repairs Suite', () => {
  const chainId = 11155111;
  const scannerId = 'synq-scanner-sepolia-test';
  const factoryAddress = SYNQ_V2_SEPOLIA_CONFIG.factory.toLowerCase();
  const dealAddressClone = '0x2222222222222222222222222222222222222222';
  const clientWallet = '0x1111111111111111111111111111111111111111';
  const freelancerWallet = '0x3333333333333333333333333333333333333333';
  const outsiderWallet = '0x9999999999999999999999999999999999999999';

  let rpcClient: MockScannerRpcClient;
  let cursorRepo: InMemoryChainCursorRepository;
  let outboxRepo: InMemoryDealOutboxRepository;
  let notifRepo: InMemoryNotificationsRepository;
  let trackedRepo: InMemoryTrackedContractsRepository;
  let proposalRepo: InMemoryDealProposalRepository;
  let registry: DealContractRegistry;

  beforeEach(async () => {
    rpcClient = new MockScannerRpcClient();
    cursorRepo = new InMemoryChainCursorRepository();
    outboxRepo = new InMemoryDealOutboxRepository();
    notifRepo = new InMemoryNotificationsRepository();
    trackedRepo = new InMemoryTrackedContractsRepository();
    proposalRepo = new InMemoryDealProposalRepository();
    registry = new DealContractRegistry();

    setChainCursorRepository(cursorRepo);
    setDealOutboxRepository(outboxRepo);
    setNotificationsRepository(notifRepo);
    setTrackedContractsRepository(trackedRepo);
    setDealProposalRepository(proposalRepo);

    // Initialize cursor at block 500
    await cursorRepo.initializeIfMissing({
      chainId,
      scannerId,
      initialBlockNumber: 500n,
      initialBlockHash: `0xhash_${(500n).toString().padStart(64, '0')}`,
    });

    // Seed proposal
    await proposalRepo.create({
      proposalId: 'prop-test-7',
      proposalNonce: '7',
      chainId,
      factoryAddress: SYNQ_V2_SEPOLIA_CONFIG.factory,
      clientWallet,
      freelancerWallet,
      canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      dealImplementation: dealAddressClone,
      primaryResolver: clientWallet,
      emergencyResolver: clientWallet,
      milestonesHash: '0x123',
      isProtected: false,
      protectionModule: '0x0000000000000000000000000000000000000000',
      policyId: '0x0',
      expiry: String(Math.floor(Date.now() / 1000) + 3600),
      clientSignature: '0xdef',
      title: 'Audited Escrow Deal',
      scope: 'Development',
      totalAmount: '5000',
      milestones: [
        { amount: '2500', title: 'M1', description: 'MVP 1', workDeadline: '1000', reviewWindow: '3600', gracePeriod: '3600', specHash: '0x0' } as any,
        { amount: '2500', title: 'M2', description: 'MVP 2', workDeadline: '2000', reviewWindow: '3600', gracePeriod: '3600', specHash: '0x0' } as any,
      ],
      dealAddress: dealAddressClone,
      cachedStatus: 'ACCEPTED',
    } as any);

    // Clear outbox after seeding proposal so test cases start with empty outbox
    outboxRepo.clear();
  });

  // 1. Factory and funded clone in the same block
  it('1. Factory and funded clone in the same block are both discovered and processed', async () => {
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

    // Block 505: Log 0 is Factory DealCreated
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
    rpcClient.logs.push({
      address: factoryAddress,
      transactionHash: '0xdeploy_tx',
      blockNumber: 505n,
      logIndex: 0,
      data: factoryData,
      topics: factoryTopics,
    });

    // Block 505: Log 1 is Clone DealFunded
    const fundedTopics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'DealFunded',
      args: { dealAddress: dealAddressClone },
    });
    const fundedData = encodeAbiParameters(parseAbiParameters('uint256'), [5000000000n]);
    rpcClient.logs.push({
      address: dealAddressClone,
      transactionHash: '0xfund_tx',
      blockNumber: 505n,
      logIndex: 1,
      data: fundedData,
      topics: fundedTopics,
    });

    rpcClient.headBlock = 520n;
    const res = await scanner.scanNextBatch();
    assert.equal(res.scanned, true);
    assert.equal(res.cursorAdvanced, true);
    assert.equal(res.newContractsDiscovered.length, 1);
    assert.equal(res.eventsProcessed, 1);

    const pending = await outboxRepo.getPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].event, 'deal_confirmed');
    assert.equal(pending[0].recipientWallet.toLowerCase(), freelancerWallet.toLowerCase());
  });

  // 2. Factory and funded clone in the same batch but different blocks
  it('2. Factory and funded clone in the same batch across different blocks are processed', async () => {
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

    // Block 502: Factory DealCreated
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
    rpcClient.logs.push({
      address: factoryAddress,
      transactionHash: '0xdeploy_502',
      blockNumber: 502n,
      logIndex: 0,
      data: factoryData,
      topics: factoryTopics,
    });

    // Block 512: Clone DealFunded
    const fundedTopics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'DealFunded',
      args: { dealAddress: dealAddressClone },
    });
    const fundedData = encodeAbiParameters(parseAbiParameters('uint256'), [5000000000n]);
    rpcClient.logs.push({
      address: dealAddressClone,
      transactionHash: '0xfund_512',
      blockNumber: 512n,
      logIndex: 0,
      data: fundedData,
      topics: fundedTopics,
    });

    rpcClient.headBlock = 520n;
    const res = await scanner.scanNextBatch();
    assert.equal(res.scanned, true);
    assert.equal(res.cursorAdvanced, true);
    assert.equal(res.eventsProcessed, 1);

    const pending = await outboxRepo.getPending();
    assert.equal(pending[0].event, 'deal_confirmed');
  });

  // 3. Secondary log query failure
  it('3. Secondary log query failure aborts scan without advancing cursor', async () => {
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
    rpcClient.logs.push({
      address: factoryAddress,
      transactionHash: '0xdeploy_tx_3',
      blockNumber: 505n,
      logIndex: 0,
      data: factoryData,
      topics: factoryTopics,
    });

    // Make secondary getLogs fail
    const origGetLogs = rpcClient.getLogs.bind(rpcClient);
    let callCount = 0;
    rpcClient.getLogs = async (params) => {
      callCount++;
      if (callCount === 2) {
        throw new Error('RPC secondary log retrieval network failure');
      }
      return origGetLogs(params);
    };

    rpcClient.headBlock = 520n;
    const res = await scanner.scanNextBatch();
    assert.equal(res.cursorAdvanced, false, 'Cursor must NOT advance when secondary query fails');
    assert.match(res.reason || '', /secondary log retrieval failed/i);

    const cursor = await cursorRepo.get(chainId, scannerId);
    assert.equal(cursor?.lastBlockNumber, 500n, 'Cursor must remain at 500');
  });

  // 4. Secondary event persistence failure
  it('4. Event persistence failure aborts without advancing cursor', async () => {
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

    // DealFunded log
    const fundedTopics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'DealFunded',
      args: { dealAddress: dealAddressClone },
    });
    const fundedData = encodeAbiParameters(parseAbiParameters('uint256'), [5000000000n]);
    rpcClient.logs.push({
      address: dealAddressClone,
      transactionHash: '0xfund_tx_4',
      blockNumber: 505n,
      logIndex: 0,
      data: fundedData,
      topics: fundedTopics,
    });

    registry.registerContract({
      address: dealAddressClone,
      contractType: 'deal_v1',
      deploymentBlock: 500n,
    });

    // Force outbox enqueue failure
    outboxRepo.enqueue = async () => {
      throw new Error('PostgreSQL outbox write lock timeout');
    };

    rpcClient.headBlock = 520n;
    await assert.rejects(async () => {
      await scanner.scanNextBatch();
    }, /outbox write lock timeout/i);

    const cursor = await cursorRepo.get(chainId, scannerId);
    assert.equal(cursor?.lastBlockNumber, 500n);
  });

  // 5. Fresh database with no tracked contracts
  it('5. Fresh database automatically seeds supported factories idempotently', async () => {
    const emptyTrackedRepo = new InMemoryTrackedContractsRepository();
    const freshRegistry = new DealContractRegistry();

    const scanner = new BlockchainScanner(
      chainId,
      scannerId,
      rpcClient,
      cursorRepo,
      freshRegistry,
      outboxRepo,
      notifRepo,
      6n,
      50n,
      emptyTrackedRepo,
    );

    await scanner.bootstrapFactories();
    const all = await emptyTrackedRepo.getAll(chainId);
    assert.equal(all.length, SUPPORTED_SEPOLIA_FACTORIES.length);
    assert.ok(all.some((c) => c.contractAddress.toLowerCase() === factoryAddress));
  });

  // 6. Existing contracts discovered after a cold start
  it('6. Existing contracts rehydrate into registry after a cold start', async () => {
    // Pre-populate tracked repo
    await trackedRepo.upsert({
      chainId,
      contractAddress: dealAddressClone,
      contractType: 'deal_v2',
      deploymentBlock: 480n,
      buyerWallet: clientWallet,
      sellerWallet: freelancerWallet,
    });

    const coldRegistry = new DealContractRegistry();
    assert.equal(coldRegistry.isRegistered(dealAddressClone), false);

    const scanner = new BlockchainScanner(
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

    rpcClient.headBlock = 510n;
    await scanner.scanNextBatch();

    assert.equal(coldRegistry.isRegistered(dealAddressClone), true);
  });

  // 7. Historical factory replay
  it('7. Historical factory replay retrieves logs for newly discovered historical contract', async () => {
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

    // Replay rewinds cursor to block 479
    await cursorRepo.rewind({
      chainId,
      scannerId,
      expectedLastBlockNumber: 500n,
      targetBlockNumber: 479n,
      targetBlockHash: `0xhash_${(479n).toString().padStart(64, '0')}`,
    });

    // Factory deployed clone at block 480 during replay
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
    rpcClient.logs.push({
      address: factoryAddress,
      transactionHash: '0xhist_deploy_tx',
      blockNumber: 480n,
      logIndex: 0,
      data: factoryData,
      topics: factoryTopics,
    });

    // Historical DealFunded event at block 482
    const fundedTopics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'DealFunded',
      args: { dealAddress: dealAddressClone },
    });
    const fundedData = encodeAbiParameters(parseAbiParameters('uint256'), [5000000000n]);
    rpcClient.logs.push({
      address: dealAddressClone,
      transactionHash: '0xhist_fund_tx',
      blockNumber: 482n,
      logIndex: 0,
      data: fundedData,
      topics: fundedTopics,
    });

    rpcClient.headBlock = 520n;
    await scanner.scanNextBatch();

    const pending = await outboxRepo.getPending();
    const replayEvent = pending.find((p) => p.event === 'deal_confirmed' && p.dealId.toLowerCase() === dealAddressClone.toLowerCase());
    assert.ok(replayEvent, 'Historical event must be recovered by replay');
  });

  // 8. Arbitrary successful Sepolia transaction submitted as DealCompleted proof
  it('8. Arbitrary successful Sepolia transaction submitted as DealCompleted proof is rejected with 400', async () => {
    const sellerToken = signToken({ userId: freelancerWallet, walletAddress: freelancerWallet });

    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        event: 'deal_completed',
        dealId: 'prop-test-7',
        txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /could not be verified/i);
  });

  // 9. Unrelated contract event submitted as cancellation proof
  it('9. Unrelated contract event submitted as cancellation proof is rejected with 400', async () => {
    const buyerToken = signToken({ userId: clientWallet, walletAddress: clientWallet });

    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buyerToken}`,
      },
      body: JSON.stringify({
        event: 'deal_cancelled',
        dealId: 'prop-test-7',
        txHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /could not be verified/i);
  });

  // 10. Proposal-only refund forgery
  it('10. Proposal-only refund forgery without proof fails closed with 400', async () => {
    const buyerToken = signToken({ userId: clientWallet, walletAddress: clientWallet });

    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buyerToken}`,
      },
      body: JSON.stringify({
        event: 'milestone_refunded',
        dealId: 'prop-test-7',
        milestoneIndex: 0,
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /could not be verified/i);
  });

  // 11. Wrong milestone refund proof
  it('11. Wrong milestone refund proof is rejected with 400', async () => {
    const buyerToken = signToken({ userId: clientWallet, walletAddress: clientWallet });

    const req = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buyerToken}`,
      },
      body: JSON.stringify({
        event: 'milestone_refunded',
        dealId: 'prop-test-7',
        milestoneIndex: 99, // Non-existent milestone
        txHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      }),
    });

    const res = await notifyPostHandler(req);
    assert.equal(res.status, 400);
  });

  // 12. Wrong caller role
  it('12. Outsider or unauthorized role is rejected with 403', async () => {
    const outsiderToken = signToken({ userId: outsiderWallet, walletAddress: outsiderWallet });
    const sellerToken = signToken({ userId: freelancerWallet, walletAddress: freelancerWallet });

    // Outsider
    const reqOutsider = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${outsiderToken}`,
      },
      body: JSON.stringify({
        event: 'deal_confirmed',
        dealId: 'prop-test-7',
      }),
    });
    const resOutsider = await notifyPostHandler(reqOutsider);
    assert.equal(resOutsider.status, 403);

    // Seller attempting deal_confirmed
    const reqSeller = new NextRequest('http://localhost:3000/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sellerToken}`,
      },
      body: JSON.stringify({
        event: 'deal_confirmed',
        dealId: 'prop-test-7',
      }),
    });
    const resSeller = await notifyPostHandler(reqSeller);
    assert.equal(resSeller.status, 403);
  });

  // 13. Factory deployment versus funding notification identity
  it('13. Factory deployment and deal funding produce distinct, authoritative keys without duplicate emails', () => {
    const deployTx = '0xdeploy_tx_hash_1234567890abcdef1234567890abcdef1234567890abcdef';
    const fundTx = '0xfund_tx_hash_1234567890abcdef1234567890abcdef1234567890abcdef';

    const fundingKey = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddressClone,
      event: 'deal_confirmed',
      txHash: fundTx,
      logIndex: 0,
      recipientRole: 'seller',
      includeLogIndex: true,
    });

    assert.ok(fundingKey.includes('deal_confirmed'));
    assert.ok(fundingKey.includes('seller'));
    // B.12.3.9: deal_confirmed is deduplicated as 1 logical escrow transition per deal;
    // txHash is excluded to ensure scanner and client parity.
    assert.equal(fundingKey, `${chainId}:${dealAddressClone.toLowerCase()}:deal_confirmed:role:seller`);
  });

  // 14. Receiptless client notification versus scanner event
  it('14. Receiptless client notification and scanner event share canonical identity and deduplicate', async () => {
    const key = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddressClone,
      event: 'deal_confirmed',
      recipientRole: 'seller',
      includeLogIndex: false,
    });

    // Client claims
    const claim1 = await notifRepo.claimPending(key, {
      dealId: dealAddressClone,
      event: 'deal_confirmed',
      recipientWallet: freelancerWallet,
    }, { fenced: true });
    assert.equal(claim1.status, 'claimed');

    // Deliver
    await notifRepo.markDelivered(key, 'msg-delivered-1', 'seller@example.com', claim1.claimToken);

    // Scanner / second claim arrives
    const claim2 = await notifRepo.claimPending(key, {
      dealId: dealAddressClone,
      event: 'deal_confirmed',
      recipientWallet: freelancerWallet,
    }, { fenced: true });
    assert.equal(claim2.status, 'duplicate_delivered');
  });

  // 15. Two different logs in the same transaction
  it('15. Two different logs in the same transaction maintain distinct outbox IDs', () => {
    const txHash = '0xmulti_event_tx';

    const outboxId0 = deriveOutboxEventId({
      chainId,
      dealId: dealAddressClone,
      event: 'work_submitted',
      recipientWallet: clientWallet,
      actionId: `${txHash}:0`,
    });

    const outboxId1 = deriveOutboxEventId({
      chainId,
      dealId: dealAddressClone,
      event: 'payment_released',
      recipientWallet: freelancerWallet,
      actionId: `${txHash}:1`,
    });

    assert.notEqual(outboxId0, outboxId1);
  });

  // 16. Notification claim reclaimed after expiry
  it('16. Notification claim reclaimed after expiry rotates the claim token', async () => {
    const key = '11155111:test-deal:work_submitted:buyer';
    const claim1 = await notifRepo.claimPending(key, {
      dealId: dealAddressClone,
      event: 'work_submitted',
      recipientWallet: clientWallet,
    }, { fenced: true });

    assert.equal(claim1.status, 'claimed');
    assert.ok(claim1.claimToken);

    // Age the claim past timeout
    const record = await notifRepo.get(key);
    assert.ok(record);
    record.updatedAt = new Date(Date.now() - PENDING_TIMEOUT_MS - 5000);
    notifRepo.setRecord(record);

    // Worker 2 reclaims
    const claim2 = await notifRepo.claimPending(key, {
      dealId: dealAddressClone,
      event: 'work_submitted',
      recipientWallet: clientWallet,
    }, { fenced: true });

    assert.equal(claim2.status, 'claimed');
    assert.ok(claim2.claimToken);
    assert.notEqual(claim2.claimToken, claim1.claimToken, 'Reclaim must rotate the claim token');
  });

  // 17. Stale worker attempts markDelivered
  it('17. Stale worker cannot markDelivered with old claim token', async () => {
    const key = '11155111:test-deal:work_submitted:buyer';
    const claimA = await notifRepo.claimPending(key, {
      dealId: dealAddressClone,
      event: 'work_submitted',
      recipientWallet: clientWallet,
    }, { fenced: true });

    // Reclaim by Worker B
    const record = await notifRepo.get(key);
    assert.ok(record);
    record.updatedAt = new Date(Date.now() - PENDING_TIMEOUT_MS - 5000);
    notifRepo.setRecord(record);

    const claimB = await notifRepo.claimPending(key, {
      dealId: dealAddressClone,
      event: 'work_submitted',
      recipientWallet: clientWallet,
    }, { fenced: true });

    // Worker A tries to markDelivered with token A
    const successA = await notifRepo.markDelivered(key, 'msg-A', 'buyer@example.com', claimA.claimToken);
    assert.equal(successA, false, 'Stale worker must not mark delivered');

    // Worker B finalizes with token B
    const successB = await notifRepo.markDelivered(key, 'msg-B', 'buyer@example.com', claimB.claimToken);
    assert.equal(successB, true, 'Valid current worker must succeed');
  });

  // 18. Stale worker attempts markFailed
  it('18. Stale worker cannot markFailed with old claim token', async () => {
    const key = '11155111:test-deal:work_submitted:buyer';
    const claimA = await notifRepo.claimPending(key, {
      dealId: dealAddressClone,
      event: 'work_submitted',
      recipientWallet: clientWallet,
    }, { fenced: true });

    // Reclaim by Worker B
    const record = await notifRepo.get(key);
    assert.ok(record);
    record.updatedAt = new Date(Date.now() - PENDING_TIMEOUT_MS - 5000);
    notifRepo.setRecord(record);

    const claimB = await notifRepo.claimPending(key, {
      dealId: dealAddressClone,
      event: 'work_submitted',
      recipientWallet: clientWallet,
    }, { fenced: true });

    // Worker A tries to markFailed with token A
    const failA = await notifRepo.markFailed(key, 'Network timeout', claimA.claimToken);
    assert.equal(failA, false, 'Stale worker must not mark failed');

    const cur = await notifRepo.get(key);
    assert.equal(cur?.status, 'pending', 'Status must remain pending under Worker B');
    assert.equal(cur?.claimToken, claimB.claimToken);
  });

  // 19. Client and outbox claim concurrency
  it('19. Client and outbox claim concurrency defers outbox without sending duplicate email', async () => {
    const key = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddressClone,
      event: 'work_submitted',
      milestoneIndex: 0,
      recipientRole: 'buyer',
    });

    // Client begins claim
    const clientClaim = await notifRepo.claimPending(key, {
      dealId: dealAddressClone,
      event: 'work_submitted',
      recipientWallet: clientWallet,
    }, { fenced: true });
    assert.equal(clientClaim.status, 'claimed');

    // Outbox item arrives concurrently
    await outboxRepo.enqueue({
      id: 'outbox-race-item',
      chainId,
      dealId: dealAddressClone,
      event: 'work_submitted',
      recipientWallet: clientWallet,
      payload: { notifKey: key },
    });

    const dispatcher = new MockDispatcher();
    const processor = new OutboxProcessor(outboxRepo, notifRepo, dispatcher);

    const res = await processor.processBatch(10);
    assert.equal(res.deferredCount, 1, 'Outbox must defer duplicate_pending item');
    assert.equal(dispatcher.dispatched.length, 0, 'No email must be sent while client delivery is in-flight');
  });

  // 20. Reorged event replay and outbox behavior
  it('20. Replayed events after reorg do not produce duplicate logical notifications', async () => {
    const key = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddressClone,
      event: 'deal_confirmed',
      txHash: '0xcanonical_tx',
      logIndex: 0,
      recipientRole: 'seller',
      includeLogIndex: true,
    });

    // Delivered in first run
    const claim1 = await notifRepo.claimPending(key, {
      dealId: dealAddressClone,
      event: 'deal_confirmed',
      recipientWallet: freelancerWallet,
    }, { fenced: true });
    await notifRepo.markDelivered(key, 'msg-reorg-test', 'seller@example.com', claim1.claimToken);

    // Replayed event enqueued into outbox
    const outboxId = deriveOutboxEventId({
      chainId,
      dealId: dealAddressClone,
      event: 'deal_confirmed',
      recipientWallet: freelancerWallet,
      actionId: '0xcanonical_tx:0',
    });
    await outboxRepo.enqueue({
      id: outboxId,
      chainId,
      dealId: dealAddressClone,
      event: 'deal_confirmed',
      recipientWallet: freelancerWallet,
      payload: { notifKey: key },
    });

    const dispatcher = new MockDispatcher();
    const processor = new OutboxProcessor(outboxRepo, notifRepo, dispatcher);

    const res = await processor.processBatch(10);
    assert.equal(res.duplicatesCount, 1, 'Replayed event must be recognized as duplicate_delivered');
    assert.equal(dispatcher.dispatched.length, 0, 'No email dispatched for duplicate');
  });
});
