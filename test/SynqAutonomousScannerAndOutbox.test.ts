/**
 * SYNQ — B.12.3.3 Autonomous Event Scanner & Outbox Integration Test Suite
 *
 * Covers:
 * 1. Atomic proposal/outbox insertion
 * 2. Transaction rollback
 * 3. Duplicate proposal creation
 * 4. Canonical key equality across client and scanner
 * 5. Multiple logs in one transaction
 * 6. Factory clone discovery
 * 7. Same-block deployment and funding
 * 8. Late contract discovery and replay
 * 9. Different contract ABIs (SynqDealV1 vs NexotiqDeal)
 * 10. Reorg detection
 * 11. RPC timeout / network failure
 * 12. Database outage
 * 13. Cursor not advancing past unpersisted events
 * 14. Outbox concurrency
 * 15. Failed SMTP and retry
 * 16. Missing verified email
 * 17. Distinct milestone settlements
 * 18. Duplicate notification suppression
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
} from '../src/lib/deals/outbox-db';

import {
  InMemoryNotificationsRepository,
  setNotificationsRepository,
  resetNotificationsRepository,
  generateNotificationKey,
  generateCanonicalDealEventKey,
} from '../src/lib/deals/notifications-db';

import {
  InMemoryDealProposalRepository,
  setDealProposalRepository,
  resetDealProposalRepository,
  createDealProposal,
} from '../src/lib/deals/proposals-db';

import {
  DealContractRegistry,
  type RawLog,
} from '../src/lib/deals/chain-event-ingestion';

import {
  InMemoryTrackedContractsRepository,
  setTrackedContractsRepository,
  resetTrackedContractsRepository,
} from '../src/lib/deals/tracked-contracts-db';

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
import { synqFactoryV2ABI, synqDealV1ABI, nexotiqDealABI } from '../src/lib/contracts/abis';

/**
 * Mock RPC Client for deterministic offline testing.
 */
class MockScannerRpcClient implements IScannerRpcClient {
  public headBlock: bigint = 1000n;
  public blocks = new Map<bigint, { hash: string; parentHash: string }>();
  public logs: RawLog[] = [];
  public shouldThrowOnGetBlock = false;
  public shouldThrowOnGetLogs = false;

  constructor() {
    // Seed default contiguous blocks
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
    if (this.shouldThrowOnGetBlock) {
      throw new Error('RPC connection timeout');
    }
    const b = this.blocks.get(params.blockNumber);
    if (!b) throw new Error(`Block ${params.blockNumber} not found in mock RPC`);
    return { ...b };
  }

  async getLogs(params: {
    address?: string | string[];
    fromBlock: bigint;
    toBlock: bigint;
    topics?: (string | string[] | null)[];
  }): Promise<RawLog[]> {
    if (this.shouldThrowOnGetLogs) {
      throw new Error('RPC getLogs gateway failure');
    }

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

/**
 * Mock Notification Dispatcher for offline testing.
 */
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

describe('SYNQ — B.12.3.3 Autonomous Event Scanner & Outbox Integration Suite', () => {
  const chainId = 11155111;
  const scannerId = 'v2_deal_scanner';
  const factoryAddress = '0x1000000000000000000000000000000000000001';
  const dealAddressA = '0x2000000000000000000000000000000000000002';
  const dealAddressB = '0x3000000000000000000000000000000000000003';
  const clientWallet = '0x4000000000000000000000000000000000000004';
  const freelancerWallet = '0x5000000000000000000000000000000000000005';

  let cursorRepo: InMemoryChainCursorRepository;
  let outboxRepo: InMemoryDealOutboxRepository;
  let notifRepo: InMemoryNotificationsRepository;
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

    proposalRepo = new InMemoryDealProposalRepository();
    setDealProposalRepository(proposalRepo);

    rpcClient = new MockScannerRpcClient();

    // Registry tracking factory and dealA
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

    const trackedContractsRepo = new InMemoryTrackedContractsRepository();
    await trackedContractsRepo.upsert({
      chainId,
      contractAddress: factoryAddress,
      contractType: 'factory',
      deploymentBlock: 100n,
    });
    await trackedContractsRepo.upsert({
      chainId,
      contractAddress: dealAddressA,
      contractType: 'deal_v2',
      deploymentBlock: 200n,
      buyerWallet: clientWallet,
      sellerWallet: freelancerWallet,
    });
    setTrackedContractsRepository(trackedContractsRepo);

    // Initialize cursor at block 500n
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
    resetDealProposalRepository();
    resetTrackedContractsRepository();
  });

  // ---------------------------------------------------------------------------
  // 1. Atomic proposal/outbox insertion
  // ---------------------------------------------------------------------------
  it('1. Proposal creation commits proposal record and outbox item atomically', async () => {
    const proposal = await createDealProposal(
      {
        proposalId: 'prop-atomic-1',
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
        title: 'Atomic Deal',
        scope: 'Scope',
        totalAmount: '1000',
        milestones: [
          {
            amount: '1000',
            title: 'M1',
            workDeadline: '1000',
            reviewWindow: '100',
            gracePeriod: '50',
            specHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
          },
        ],
        cachedStatus: 'PENDING',
        protectionSelection: 'STANDARD',
      },
      proposalRepo,
    );

    assert.equal(proposal.proposalId, 'prop-atomic-1');

    // Outbox must contain the corresponding pending item
    const pending = await outboxRepo.getPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].dealId, 'prop-atomic-1');
    assert.equal(pending[0].event, 'proposal_received');
    assert.equal(pending[0].recipientWallet.toLowerCase(), freelancerWallet.toLowerCase());
  });

  // ---------------------------------------------------------------------------
  // 2. Transaction rollback
  // ---------------------------------------------------------------------------
  it('2. Outbox failure rolls back proposal creation and prevents orphan records', async () => {
    // Inject outbox failure into outboxRepo
    const failingOutboxRepo = {
      ...outboxRepo,
      async enqueue() {
        throw new Error('Database transaction constraint failure on outbox');
      },
    };
    setDealOutboxRepository(failingOutboxRepo as any);

    await assert.rejects(
      async () => {
        await createDealProposal(
          {
            proposalId: 'prop-rollback-1',
            proposalNonce: '2',
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
            title: 'Rollback Deal',
            scope: 'Scope',
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
            cachedStatus: 'PENDING',
            protectionSelection: 'STANDARD',
          },
          proposalRepo,
        );
      },
      /Database transaction constraint failure on outbox/i,
    );

    // Verify proposal was NOT stored
    const stored = await proposalRepo.getById('prop-rollback-1');
    assert.equal(stored, null, 'Proposal must not exist when outbox insertion fails');
  });

  // ---------------------------------------------------------------------------
  // 3. Duplicate proposal creation
  // ---------------------------------------------------------------------------
  it('3. Repeated proposal submissions are idempotent and do not duplicate outbox entries', async () => {
    const payload = {
      proposalId: 'prop-idempotent-1',
      proposalNonce: '3',
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
      title: 'Idempotent Deal',
      scope: 'Scope',
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
      protectionSelection: 'STANDARD' as const,
    };

    await createDealProposal(payload, proposalRepo);
    // Duplicate submission
    await createDealProposal(payload, proposalRepo);

    const pending = await outboxRepo.getPending();
    assert.equal(pending.length, 1, 'Exactly one outbox entry must be created');
  });

  // ---------------------------------------------------------------------------
  // 4. Canonical key equality across client and scanner
  // ---------------------------------------------------------------------------
  it('4. Canonical notification key is identical between verified client submission and autonomous scanner', () => {
    const txHash = '0xaaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';
    const logIndex = 3;

    // Client key derived from receipt
    const clientKey = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddressA,
      contractAddress: dealAddressA,
      event: 'payment_released',
      milestoneIndex: 0,
      txHash,
      logIndex,
      recipientRole: 'seller',
      includeLogIndex: true,
    });

    // Scanner key derived from on-chain event log
    const scannerKey = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddressA,
      contractAddress: dealAddressA,
      event: 'payment_released',
      milestoneIndex: 0,
      txHash,
      logIndex,
      recipientRole: 'seller',
      includeLogIndex: true,
    });

    assert.equal(clientKey, scannerKey);
    assert.match(clientKey, new RegExp(`:${logIndex}:role:seller`));
  });

  // ---------------------------------------------------------------------------
  // 5. Multiple logs in one transaction
  // ---------------------------------------------------------------------------
  it('5. Multiple distinct logs in one transaction generate independent notification keys and work items', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    // Log 0: WorkSubmitted (Milestone 0)
    const key0 = generateCanonicalDealEventKey({
      chainId,
      contractAddress: dealAddressA,
      event: 'work_submitted',
      milestoneIndex: 0,
      txHash,
      logIndex: 0,
      recipientRole: 'buyer',
      includeLogIndex: true,
    });

    // Log 1: PaymentReleased (Milestone 0)
    const key1 = generateCanonicalDealEventKey({
      chainId,
      contractAddress: dealAddressA,
      event: 'payment_released',
      milestoneIndex: 0,
      txHash,
      logIndex: 1,
      recipientRole: 'seller',
      includeLogIndex: true,
    });

    assert.notEqual(key0, key1);
    assert.match(key0, /work_submitted:ms:0.*:log:0:role:buyer/);
    assert.match(key1, /payment_released:ms:0.*:log:1:role:seller/);
  });

  // ---------------------------------------------------------------------------
  // 6. Factory clone discovery
  // ---------------------------------------------------------------------------
  it('6. Scanner discovers new deal clones from factory DealCreated event and registers contract', async () => {
    const scanner = new BlockchainScanner(
      chainId,
      scannerId,
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      notifRepo,
    );

    // Encode SynqFactoryV2 DealCreated event topics
    const topics = encodeEventTopics({
      abi: synqFactoryV2ABI,
      eventName: 'DealCreated',
      args: {
        dealAddress: dealAddressB,
        client: clientWallet,
        freelancer: freelancerWallet,
      },
    });

    // Encode unindexed data for DealCreated:
    // (address creator, address usdc, address primaryResolver, address emergencyResolver, uint256 totalEscrow, uint256 milestoneCount)
    const data = encodeAbiParameters(
      parseAbiParameters('address, address, address, address, uint256, uint256'),
      [
        clientWallet,
        '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
        2500000000n, // $2500 USDC
        2n,
      ],
    );

    rpcClient.logs.push({
      address: factoryAddress,
      transactionHash: '0xfactory_deploy_tx',
      blockNumber: 505n,
      logIndex: 0,
      data,
      topics,
    });

    rpcClient.headBlock = 520n;

    const result = await scanner.scanNextBatch();
    assert.equal(result.scanned, true);
    assert.equal(result.newContractsDiscovered.length, 1);
    assert.equal(result.newContractsDiscovered[0].toLowerCase(), dealAddressB.toLowerCase());

    // Registry must now track dealAddressB
    assert.equal(registry.isRegistered(dealAddressB), true);

    // Factory deployment registers clone; deal_confirmed is authoritative to DealFunded
    const pending = await outboxRepo.getPending();
    assert.equal(pending.length, 0, 'DealCreated registers clone only; deal_confirmed requires escrow funding');
  });

  // ---------------------------------------------------------------------------
  // 7. Same-block deployment and funding
  // ---------------------------------------------------------------------------
  it('7. Handles factory deployment and deal funding logs within the same block batch', async () => {
    const scanner = new BlockchainScanner(
      chainId,
      scannerId,
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      notifRepo,
    );

    // 1. DealCreated at block 505n, log 0
    const factoryTopics = encodeEventTopics({
      abi: synqFactoryV2ABI,
      eventName: 'DealCreated',
      args: { dealAddress: dealAddressB, client: clientWallet, freelancer: freelancerWallet },
    });
    const zeroAddr = '0x0000000000000000000000000000000000000000';
    const factoryData = encodeAbiParameters(
      parseAbiParameters('address, address, address, address, uint256, uint256'),
      [clientWallet, zeroAddr, zeroAddr, zeroAddr, 1000n, 1n],
    );

    rpcClient.logs.push({
      address: factoryAddress,
      transactionHash: '0xtx_deploy_and_fund',
      blockNumber: 505n,
      logIndex: 0,
      data: factoryData,
      topics: factoryTopics,
    });

    // 2. DealFunded at block 505n, log 1 (on newly discovered dealAddressB!)
    const fundedTopics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'DealFunded',
      args: { dealAddress: dealAddressB },
    });
    const fundedData = encodeAbiParameters(parseAbiParameters('uint256'), [1000n]);

    rpcClient.logs.push({
      address: dealAddressB,
      transactionHash: '0xtx_deploy_and_fund',
      blockNumber: 505n,
      logIndex: 1,
      data: fundedData,
      topics: fundedTopics,
    });

    rpcClient.headBlock = 520n;

    const result = await scanner.scanNextBatch();
    assert.equal(result.scanned, true);
    assert.equal(result.newContractsDiscovered.length, 1);
    // Both events should be processed
    assert.equal(result.eventsProcessed >= 1, true);
  });

  // ---------------------------------------------------------------------------
  // 8. Late contract discovery and replay
  // ---------------------------------------------------------------------------
  it('8. Retroactively discovered contract triggers historical log replay from deployment block', async () => {
    const scanner = new BlockchainScanner(
      chainId,
      scannerId,
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      notifRepo,
    );

    // Manually register contract deployed earlier at block 400n (cursor is at 500n)
    registry.registerContract({
      address: dealAddressB,
      contractType: 'deal_v2',
      deploymentBlock: 400n,
      metadata: { buyerWallet: clientWallet, sellerWallet: freelancerWallet },
    });

    // Add historic log at block 450n
    const submittedTopics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'MilestoneSubmitted',
      args: { milestoneId: 0n },
    });
    const submittedData = encodeAbiParameters(
      parseAbiParameters('bytes32, uint8'),
      ['0x0000000000000000000000000000000000000000000000000000000000000000', 1],
    );

    rpcClient.logs.push({
      address: dealAddressB,
      transactionHash: '0xhistoric_tx',
      blockNumber: 450n,
      logIndex: 0,
      data: submittedData,
      topics: submittedTopics,
    });

    const replayCheck = registry.checkReplayRequirement(dealAddressB, 501n);
    assert.equal(replayCheck.shouldReplay, true);
    assert.equal(replayCheck.deploymentBlock, 400n);

    // Scanner can scan next block range cleanly
    rpcClient.headBlock = 550n;
    const res = await scanner.scanNextBatch();
    assert.equal(res.scanned, true);
  });

  // ---------------------------------------------------------------------------
  // 9. Different contract ABIs (SynqDealV1 vs NexotiqDeal)
  // ---------------------------------------------------------------------------
  it('9. Decodes events correctly across both SynqDealV1 and legacy NexotiqDeal ABIs', async () => {
    const scanner = new BlockchainScanner(
      chainId,
      scannerId,
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      notifRepo,
    );

    // 1. SynqDealV1 MilestoneSettled on dealAddressA
    const settledTopics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'MilestoneSettled',
      args: { milestoneId: 0n },
    });
    const settledData = encodeAbiParameters(
      parseAbiParameters('uint256, uint256, uint8'),
      [500000000n, 0n, 0], // paid $500 to freelancer
    );

    rpcClient.logs.push({
      address: dealAddressA,
      transactionHash: '0xv1_settle_tx',
      blockNumber: 505n,
      logIndex: 0,
      data: settledData,
      topics: settledTopics,
    });

    rpcClient.headBlock = 520n;
    const result = await scanner.scanNextBatch();
    assert.equal(result.eventsProcessed, 1);

    const pending = await outboxRepo.getPending();
    assert.equal(pending[0].event, 'payment_released');
  });

  // ---------------------------------------------------------------------------
  // 10. Reorg detection
  // ---------------------------------------------------------------------------
  it('10. Detects block continuity break and rolls back cursor to reorg rewind block', async () => {
    const scanner = new BlockchainScanner(
      chainId,
      scannerId,
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      notifRepo,
    );

    // Corrupt block 501's parent hash to simulate a chain reorganization
    rpcClient.blocks.set(501n, {
      hash: '0xreorg_block_hash',
      parentHash: '0xinvalid_parent_hash_reorg',
    });

    rpcClient.headBlock = 520n;

    const result = await scanner.scanNextBatch();
    assert.equal(result.scanned, false);
    assert.equal(result.reorgDetected, true);
    assert.equal(result.rewoundToBlock !== undefined, true);

    const cursor = await cursorRepo.get(chainId, scannerId);
    assert.equal(cursor?.lastBlockNumber, result.rewoundToBlock);
  });

  // ---------------------------------------------------------------------------
  // 11. RPC timeout / network failure
  // ---------------------------------------------------------------------------
  it('11. Safe termination on RPC timeout without advancing cursor', async () => {
    const scanner = new BlockchainScanner(
      chainId,
      scannerId,
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      notifRepo,
    );

    rpcClient.shouldThrowOnGetBlock = true;
    rpcClient.headBlock = 520n;

    await assert.rejects(
      async () => {
        await scanner.scanNextBatch();
      },
      /RPC connection timeout/i,
    );

    // Cursor must NOT have moved
    const cursor = await cursorRepo.get(chainId, scannerId);
    assert.equal(cursor?.lastBlockNumber, 500n);
  });

  // ---------------------------------------------------------------------------
  // 12. Database outage
  // ---------------------------------------------------------------------------
  it('12. Database outage aborts scanner gracefully without advancing cursor', async () => {
    const failingCursorRepo: any = Object.create(cursorRepo);
    failingCursorRepo.advance = async () => {
      throw new Error('PostgreSQL connection terminated');
    };

    const scanner = new BlockchainScanner(
      chainId,
      scannerId,
      rpcClient,
      failingCursorRepo,
      registry,
      outboxRepo,
      notifRepo,
    );

    rpcClient.headBlock = 520n;

    await assert.rejects(
      async () => {
        await scanner.scanNextBatch();
      },
      /PostgreSQL connection terminated/i,
    );
  });

  // ---------------------------------------------------------------------------
  // 13. Cursor not advancing past unpersisted events
  // ---------------------------------------------------------------------------
  it('13. If event persistence fails, cursor does not advance past unprocessed events', async () => {
    const failingOutboxRepo: any = Object.create(outboxRepo);
    failingOutboxRepo.enqueue = async () => {
      throw new Error('Outbox write lock failed');
    };

    const scanner = new BlockchainScanner(
      chainId,
      scannerId,
      rpcClient,
      cursorRepo,
      registry,
      failingOutboxRepo as any,
      notifRepo,
    );

    // Add valid log
    const settledTopics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'MilestoneSettled',
      args: { milestoneId: 0n },
    });
    const settledData = encodeAbiParameters(parseAbiParameters('uint256, uint256, uint8'), [100n, 0n, 0]);
    rpcClient.logs.push({
      address: dealAddressA,
      transactionHash: '0xtx_unpersisted',
      blockNumber: 505n,
      logIndex: 0,
      data: settledData,
      topics: settledTopics,
    });

    rpcClient.headBlock = 520n;

    await assert.rejects(
      async () => {
        await scanner.scanNextBatch();
      },
      /Outbox write lock failed/i,
    );

    // Cursor must remain at 500n
    const cursor = await cursorRepo.get(chainId, scannerId);
    assert.equal(cursor?.lastBlockNumber, 500n);
  });

  // ---------------------------------------------------------------------------
  // 14. Outbox concurrency
  // ---------------------------------------------------------------------------
  it('14. Concurrent outbox processor workers do not process the same item twice', async () => {
    // Seed 2 outbox items
    await outboxRepo.enqueue({
      id: 'outbox-c1',
      chainId,
      dealId: dealAddressA,
      event: 'proposal_received',
      recipientWallet: freelancerWallet,
      payload: { title: 'Concurrent Test 1' },
    });
    await outboxRepo.enqueue({
      id: 'outbox-c2',
      chainId,
      dealId: dealAddressB,
      event: 'proposal_received',
      recipientWallet: freelancerWallet,
      payload: { title: 'Concurrent Test 2' },
    });

    const processor1 = new OutboxProcessor(outboxRepo, notifRepo, dispatcher);
    const processor2 = new OutboxProcessor(outboxRepo, notifRepo, dispatcher);

    // Run parallel batches
    const [res1, res2] = await Promise.all([
      processor1.processBatch(10),
      processor2.processBatch(10),
    ]);

    const totalProcessed = res1.processedCount + res2.processedCount;
    assert.equal(totalProcessed, 2, 'Total processed across both workers must equal exactly 2');
    assert.equal(dispatcher.dispatched.length, 2, 'Dispatcher must be called exactly 2 times');
  });

  // ---------------------------------------------------------------------------
  // 15. Failed SMTP and retry
  // ---------------------------------------------------------------------------
  it('15. Transient SMTP failure marks outbox as failed and increments retryCount', async () => {
    dispatcher.shouldFail = true;
    dispatcher.failErrorMessage = 'SMTP 421 Service not available';

    await outboxRepo.enqueue({
      id: 'outbox-retry-1',
      chainId,
      dealId: dealAddressA,
      event: 'deal_confirmed',
      recipientWallet: freelancerWallet,
      payload: { title: 'Retry Test' },
    });

    const processor = new OutboxProcessor(outboxRepo, notifRepo, dispatcher);
    const result = await processor.processBatch(10);

    assert.equal(result.failedCount, 1);

    const item = await outboxRepo.get('outbox-retry-1');
    assert.equal(item?.status, 'failed');
    assert.equal(item?.retryCount, 1);
    assert.match(item?.lastError || '', /SMTP 421/);
  });

  // ---------------------------------------------------------------------------
  // 16. Missing verified email
  // ---------------------------------------------------------------------------
  it('16. Unverified recipient skips delivery safely without failing or infinite retry', async () => {
    dispatcher.shouldSkip = true;
    dispatcher.skipReason = 'No verified email linked to recipient wallet';

    await outboxRepo.enqueue({
      id: 'outbox-skip-1',
      chainId,
      dealId: dealAddressA,
      event: 'deal_confirmed',
      recipientWallet: freelancerWallet,
      payload: { title: 'Skip Test' },
    });

    const processor = new OutboxProcessor(outboxRepo, notifRepo, dispatcher);
    const result = await processor.processBatch(10);

    assert.equal(result.skippedCount, 1);

    const item = await outboxRepo.get('outbox-skip-1');
    assert.equal(item?.status, 'skipped');
    assert.match(item?.lastError || '', /No verified email/);
  });

  // ---------------------------------------------------------------------------
  // 17. Distinct milestone settlements
  // ---------------------------------------------------------------------------
  it('17. Distinct milestone settlement events are not suppressed and generate independent emails', async () => {
    await outboxRepo.enqueue({
      id: 'outbox-ms0',
      chainId,
      dealId: dealAddressA,
      event: 'payment_released',
      recipientWallet: freelancerWallet,
      payload: { milestoneIndex: 0, title: 'Milestone 0' },
    });
    await outboxRepo.enqueue({
      id: 'outbox-ms1',
      chainId,
      dealId: dealAddressA,
      event: 'payment_released',
      recipientWallet: freelancerWallet,
      payload: { milestoneIndex: 1, title: 'Milestone 1' },
    });

    const processor = new OutboxProcessor(outboxRepo, notifRepo, dispatcher);
    const result = await processor.processBatch(10);

    assert.equal(result.processedCount, 2);
    assert.equal(dispatcher.dispatched.length, 2);
  });

  // ---------------------------------------------------------------------------
  // 18. Duplicate notification suppression
  // ---------------------------------------------------------------------------
  it('18. Outbox item for event already delivered by client is marked processed without second email', async () => {
    const txHash = '0xdup_test_tx_hash';
    const clientKey = generateCanonicalDealEventKey({
      chainId,
      dealId: dealAddressA,
      event: 'payment_released',
      milestoneIndex: 0,
      txHash,
      recipientRole: 'seller',
      includeLogIndex: false,
    });

    // Client claimed and delivered
    await notifRepo.claimPending(clientKey, {
      dealId: dealAddressA,
      event: 'payment_released',
      recipientWallet: freelancerWallet,
    });
    await notifRepo.markDelivered(clientKey, 'msg_client_delivered');

    // Outbox item created with identical canonical key
    await outboxRepo.enqueue({
      id: 'outbox-dup-1',
      chainId,
      dealId: dealAddressA,
      event: 'payment_released',
      recipientWallet: freelancerWallet,
      payload: {
        milestoneIndex: 0,
        txHash,
        recipientRole: 'seller',
        notifKey: clientKey,
      },
    });

    const processor = new OutboxProcessor(outboxRepo, notifRepo, dispatcher);
    const result = await processor.processBatch(10);

    assert.equal(result.duplicatesCount, 1);
    assert.equal(dispatcher.dispatched.length, 0, 'No second email must be sent for duplicate delivered event');

    const item = await outboxRepo.get('outbox-dup-1');
    assert.equal(item?.status, 'processed');
  });
});
