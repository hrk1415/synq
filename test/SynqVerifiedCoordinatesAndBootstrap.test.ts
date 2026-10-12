/**
 * SYNQ — B.12.3.20 Verified Factory Coordinates & Scanner Bootstrap Hardening
 * Offline Regression Suite
 *
 * Verifies all 10 core safety requirements:
 * 1. All three verified deployment coordinates in config & manifests.
 * 2. Inclusive first-block scanning (deployment block included in batch).
 * 3. Missing cursor atomic initialization at anchor block with real parent hash.
 * 4. Concurrent initialization safety and idempotency.
 * 5. Existing cursor validation and mismatch rejection without mutation.
 * 6. V1 history preceding V2 scanned and processed.
 * 7. Legacy history preceding V1/V2 with scope isolation.
 * 8. Historical deal discovered behind live cursor flagged for targeted replay.
 * 9. Cursor compare-and-swap (CAS) fencing and monotonicity protection.
 * 10. Disabled worker behavior fails closed with 403.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import {
  InMemoryChainCursorRepository,
  setChainCursorRepository,
  resetChainCursorRepository,
  isZeroBlockHash,
} from '../src/lib/deals/chain-sync-db';

import {
  InMemoryDealOutboxRepository,
  setDealOutboxRepository,
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
  DealContractRegistry,
  type RawLog,
} from '../src/lib/deals/chain-event-ingestion';

import {
  BlockchainScanner,
  SUPPORTED_SEPOLIA_FACTORIES,
  VERIFIED_SEPOLIA_COORDINATES,
  SCANNER_SCOPES,
  validateScannerCursor,
  type IScannerRpcClient,
} from '../src/lib/deals/chain-scanner';

import { POST as scannerCronHandler } from '../src/app/api/cron/scanner/route';
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters, toEventSelector } from 'viem';
import { synqFactoryV2ABI, synqDealV1ABI } from '../src/lib/contracts/abis';
import sepoliaV2Deployment from '../deployments/sepolia-v2-standard.json';
import sepoliaV1Deployment from '../deployments/sepolia-v1-standard.json';

class MockScannerRpcClient implements IScannerRpcClient {
  public headBlock: bigint = 12000000n;
  public blocks = new Map<bigint, { hash: string; parentHash: string }>();
  public logs: RawLog[] = [];

  constructor() {
    // Generate deterministic block hashes
    for (let i = 11500000n; i <= 11508000n; i++) {
      this.blocks.set(i, {
        hash: `0xhash_${i.toString().padStart(64, '0')}`,
        parentHash: `0xhash_${(i - 1n).toString().padStart(64, '0')}`,
      });
    }
    for (let i = 11832000n; i <= 11835000n; i++) {
      this.blocks.set(i, {
        hash: `0xhash_${i.toString().padStart(64, '0')}`,
        parentHash: `0xhash_${(i - 1n).toString().padStart(64, '0')}`,
      });
    }
  }

  async getBlockNumber(): Promise<bigint> {
    return this.headBlock;
  }

  async getBlock(params: { blockNumber: bigint }): Promise<{ hash: string; parentHash: string }> {
    const existing = this.blocks.get(params.blockNumber);
    if (existing) return existing;

    const hash = `0xhash_${params.blockNumber.toString().padStart(64, '0')}`;
    const parentHash = `0xhash_${(params.blockNumber - 1n).toString().padStart(64, '0')}`;
    const block = { hash, parentHash };
    this.blocks.set(params.blockNumber, block);
    return block;
  }

  async getLogs(params: {
    address?: string | string[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RawLog[]> {
    const addresses = Array.isArray(params.address)
      ? params.address.map((a) => a.toLowerCase())
      : params.address
      ? [params.address.toLowerCase()]
      : [];

    return this.logs.filter((l) => {
      const addrMatch = addresses.length === 0 || addresses.includes(l.address.toLowerCase());
      const blockMatch = l.blockNumber >= params.fromBlock && l.blockNumber <= params.toBlock;
      return addrMatch && blockMatch;
    });
  }
}

describe('SYNQ — B.12.3.20 Verified Coordinates & Scanner Bootstrap Hardening', () => {
  let rpcClient: MockScannerRpcClient;
  let cursorRepo: InMemoryChainCursorRepository;
  let outboxRepo: InMemoryDealOutboxRepository;
  let notifRepo: InMemoryNotificationsRepository;
  let trackedRepo: InMemoryTrackedContractsRepository;
  let proposalRepo: InMemoryDealProposalRepository;
  let registry: DealContractRegistry;

  beforeEach(() => {
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
  });

  describe('1. Authoritative Verified Factory Deployment Coordinates', () => {
    it('records verified coordinates for V2, V1, and Legacy Nexotiq', () => {
      assert.equal(VERIFIED_SEPOLIA_COORDINATES.chainId, 11155111);

      // V2 Factory
      assert.equal(VERIFIED_SEPOLIA_COORDINATES.v2.address, '0x9b7C5B529A420d015a85fD77040eF63b0e6cbdb0');
      assert.equal(VERIFIED_SEPOLIA_COORDINATES.v2.deploymentBlock, 11833191n);
      assert.equal(
        VERIFIED_SEPOLIA_COORDINATES.v2.deploymentTxHash,
        '0x5ef5707ffcff74fa83ba71bd07177429e84d02d2739f7601184825063d700841',
      );

      // V1 Factory
      assert.equal(VERIFIED_SEPOLIA_COORDINATES.v1.address, '0x7482c3439Aa6065066c7759b87eeD25a403CbB03');
      assert.equal(VERIFIED_SEPOLIA_COORDINATES.v1.deploymentBlock, 11832783n);
      assert.equal(
        VERIFIED_SEPOLIA_COORDINATES.v1.deploymentTxHash,
        '0x5f5cb3d115d0f8b159e0b0d249679b6f8cf8f507766deae109a4763e605b0330',
      );

      // Legacy Nexotiq Factory
      assert.equal(VERIFIED_SEPOLIA_COORDINATES.legacy.address, '0x569146151D79B30087B27B6D3Df1FD16a846ae23');
      assert.equal(VERIFIED_SEPOLIA_COORDINATES.legacy.deploymentBlock, 11507082n);
      assert.equal(
        VERIFIED_SEPOLIA_COORDINATES.legacy.deploymentTxHash,
        '0x568ac0a917c4fa670ae8a60ed47ddf454920c5ea7eb1459a2efb4667978bcdc4',
      );
    });

    it('manifest files contain verified deployment blocks and creation tx hashes', () => {
      // Sepolia V2 manifest
      assert.equal((sepoliaV2Deployment as any).deploymentBlock, 11833191);
      assert.equal(
        (sepoliaV2Deployment as any).deploymentTxHash,
        '0x5ef5707ffcff74fa83ba71bd07177429e84d02d2739f7601184825063d700841',
      );

      // Sepolia V1 manifest
      assert.equal((sepoliaV1Deployment as any).deploymentBlock, 11832783);
      assert.equal(
        (sepoliaV1Deployment as any).deploymentTxHash,
        '0x5f5cb3d115d0f8b159e0b0d249679b6f8cf8f507766deae109a4763e605b0330',
      );
    });

    it('SUPPORTED_SEPOLIA_FACTORIES correctly passes deploymentBlock to tracked contracts', async () => {
      const scanner = new BlockchainScanner(
        11155111,
        'synq-sepolia-scanner-v1',
        rpcClient,
        cursorRepo,
        registry,
        outboxRepo,
        notifRepo,
        5n,
        100n,
        trackedRepo,
        VERIFIED_SEPOLIA_COORDINATES.v1.deploymentBlock,
        proposalRepo,
        SUPPORTED_SEPOLIA_FACTORIES,
      );

      await scanner.bootstrapFactories();

      const tracked = await trackedRepo.getAll(11155111);
      const v2Tracked = tracked.find((t) => t.contractAddress.toLowerCase() === VERIFIED_SEPOLIA_COORDINATES.v2.address.toLowerCase());
      const v1Tracked = tracked.find((t) => t.contractAddress.toLowerCase() === VERIFIED_SEPOLIA_COORDINATES.v1.address.toLowerCase());
      const legTracked = tracked.find((t) => t.contractAddress.toLowerCase() === VERIFIED_SEPOLIA_COORDINATES.legacy.address.toLowerCase());

      assert.equal(v2Tracked?.deploymentBlock, 11833191n);
      assert.equal(v1Tracked?.deploymentBlock, 11832783n);
      assert.equal(legTracked?.deploymentBlock, 11507082n);
    });
  });

  describe('2. Inclusive First-Block Scanning & Bootstrap Anchor', () => {
    it('initializes anchor at startBlock - 1n so startBlock is scanned inclusively', async () => {
      const v2StartBlock = 11833191n;
      const scanner = new BlockchainScanner(
        11155111,
        'synq-sepolia-scanner-v1',
        rpcClient,
        cursorRepo,
        registry,
        outboxRepo,
        notifRepo,
        5n,
        100n,
        trackedRepo,
        11832783n,
        proposalRepo,
        SUPPORTED_SEPOLIA_FACTORIES,
      );

      // Initialize cursor for v2StartBlock
      const cursor = await scanner.initializeCursorIfMissing({ startBlock: v2StartBlock });
      assert.equal(cursor.lastBlockNumber, v2StartBlock - 1n); // 11833190n anchor
      assert.equal(cursor.isBootstrap, true);

      // Verify anchor hash is the real parentHash of v2StartBlock
      const v2Block = await rpcClient.getBlock({ blockNumber: v2StartBlock });
      assert.equal(cursor.lastBlockHash, v2Block.parentHash);

      // Seed a clone creation event in block 11833191 (the deployment block itself)
      const testDealAddr = '0x1111222233334444555566667777888899990000';
      const factoryTopics = encodeEventTopics({
        abi: synqFactoryV2ABI,
        eventName: 'DealCreated',
        args: {
          dealAddress: testDealAddr,
          client: '0x1111111111111111111111111111111111111111',
          freelancer: '0x2222222222222222222222222222222222222222',
        },
      });
      const factoryData = encodeAbiParameters(
        parseAbiParameters('address, address, address, address, uint256, uint256'),
        ['0x1111111111111111111111111111111111111111', '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', '0x0000000000000000000000000000000000000002', '0x0000000000000000000000000000000000000003', 1000000n, 1n],
      );

      rpcClient.logs.push({
        address: VERIFIED_SEPOLIA_COORDINATES.v2.address,
        topics: factoryTopics,
        data: factoryData,
        blockNumber: 11833191n, // Exact first block!
        transactionHash: '0xdeal_creation_tx',
        logIndex: 0,
      });

      // Execute scan batch
      const result = await scanner.scanNextBatch();
      assert.equal(result.scanned, true);
      assert.equal(result.fromBlock, 11833191n); // First block included!
      assert.equal(result.newContractsDiscovered.length, 1);
      assert.equal(result.newContractsDiscovered[0].toLowerCase(), testDealAddr.toLowerCase());

      // Cursor is now advanced and no longer bootstrap
      const updatedCursor = await cursorRepo.get(11155111, 'synq-sepolia-scanner-v1');
      assert.equal(updatedCursor?.isBootstrap, false);
      assert.ok(updatedCursor!.lastBlockNumber >= 11833191n);
    });
  });

  describe('3. Missing Cursor Atomic Initialization & Zero Hash Rejection', () => {
    it('atomic initialization re-reads and returns persisted cursor with isBootstrap=true', async () => {
      const scanner = new BlockchainScanner(
        11155111,
        'synq-sepolia-scanner-v1',
        rpcClient,
        cursorRepo,
        registry,
        outboxRepo,
        notifRepo,
        5n,
        100n,
        trackedRepo,
        11832783n,
        proposalRepo,
        SUPPORTED_SEPOLIA_FACTORIES,
      );

      const created = await scanner.initializeCursorIfMissing({ startBlock: 11832783n });
      assert.equal(created.lastBlockNumber, 11832782n);
      assert.equal(created.isBootstrap, true);

      // Second call returns identical cursor without modifying it
      const second = await scanner.initializeCursorIfMissing({ startBlock: 11832783n });
      assert.equal(second.lastBlockNumber, 11832782n);
      assert.equal(second.createdAt.getTime(), created.createdAt.getTime());
    });

    it('rejects zero block hashes as invalid proof of chain history', async () => {
      // Zero hash helper correctly identifies zero hashes
      assert.equal(isZeroBlockHash('0x0000000000000000000000000000000000000000000000000000000000000000'), true);
      assert.equal(isZeroBlockHash('0x0'), true);
      assert.equal(isZeroBlockHash(''), true);
      assert.equal(isZeroBlockHash(null), true);
      assert.equal(isZeroBlockHash('0xhash_real_block_1234'), false);

      // Repository rejects zero hash on initialization
      await assert.rejects(
        async () => {
          await cursorRepo.initializeIfMissing({
            chainId: 11155111,
            scannerId: 'test-zero-hash',
            initialBlockNumber: 100n,
            initialBlockHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
          });
        },
        /zero block hash/i,
      );
    });
  });

  describe('4. Concurrent Initialization Safety', () => {
    it('simultaneous worker initializations return identical persisted cursor without collision', async () => {
      const [w1, w2] = await Promise.all([
        cursorRepo.initializeIfMissing({
          chainId: 11155111,
          scannerId: 'concurrent-scanner',
          initialBlockNumber: 11833190n,
          initialBlockHash: '0xhash_11833190_real_parent',
          isBootstrap: true,
        }),
        cursorRepo.initializeIfMissing({
          chainId: 11155111,
          scannerId: 'concurrent-scanner',
          initialBlockNumber: 11833190n,
          initialBlockHash: '0xhash_11833190_real_parent',
          isBootstrap: true,
        }),
      ]);

      assert.equal(w1.id, w2.id);
      assert.equal(w1.lastBlockNumber, w2.lastBlockNumber);
      assert.equal(w1.lastBlockHash, w2.lastBlockHash);
      assert.equal(w1.isBootstrap, true);
      assert.equal(w2.isBootstrap, true);
    });
  });

  describe('5. Existing Cursor Validation & Mismatch Rejection', () => {
    it('rejects cursor with wrong chain ID without mutating it', () => {
      const badCursor = {
        chainId: 1, // Mainnet instead of Sepolia
        scannerId: 'synq-sepolia-scanner-v1',
        lastBlockNumber: 11833190n,
        lastBlockHash: '0xhash_11833190',
        isBootstrap: true,
      };

      const result = validateScannerCursor({
        cursor: badCursor,
        expectedChainId: 11155111,
        expectedScannerId: 'synq-sepolia-scanner-v1',
        scope: SCANNER_SCOPES.live_v1_v2,
      });

      assert.equal(result.valid, false);
      assert.match(result.reason!, /chain ID mismatch/i);
    });

    it('rejects cursor below scope minimum coordinate without mutating it', () => {
      const corruptCursor = {
        chainId: 11155111,
        scannerId: 'synq-sepolia-scanner-v1',
        lastBlockNumber: 500n, // Corrupt coordinate far below V1/V2
        lastBlockHash: '0xhash_500',
        isBootstrap: true,
      };

      const result = validateScannerCursor({
        cursor: corruptCursor,
        expectedChainId: 11155111,
        expectedScannerId: 'synq-sepolia-scanner-v1',
        scope: SCANNER_SCOPES.live_v1_v2,
      });

      assert.equal(result.valid, false);
      assert.match(result.reason!, /below minimum allowed coordinate/i);
    });

    it('rejects cursor with zero block hash without mutating it', () => {
      const zeroCursor = {
        chainId: 11155111,
        scannerId: 'synq-sepolia-scanner-v1',
        lastBlockNumber: 11833190n,
        lastBlockHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        isBootstrap: true,
      };

      const result = validateScannerCursor({
        cursor: zeroCursor,
        expectedChainId: 11155111,
        expectedScannerId: 'synq-sepolia-scanner-v1',
        scope: SCANNER_SCOPES.live_v1_v2,
      });

      assert.equal(result.valid, false);
      assert.match(result.reason!, /zero/i);
    });

    it('route returns 409 Conflict on existing cursor validation failure without altering DB', async () => {
      const origSecret = process.env.CRON_SECRET;
      const origFlag = process.env.ENABLE_CHAIN_SCANNER;

      try {
        process.env.CRON_SECRET = 'test-secret';
        process.env.ENABLE_CHAIN_SCANNER = 'true';

        // Pre-populate corrupt cursor in DB
        await cursorRepo.initializeIfMissing({
          chainId: 11155111,
          scannerId: 'synq-sepolia-scanner-v1',
          initialBlockNumber: 500n, // Invalid coordinate for live scope
          initialBlockHash: '0xhash_500',
          isBootstrap: true,
        });

        const req = new NextRequest('http://localhost:3000/api/cron/scanner', {
          method: 'POST',
          headers: { Authorization: 'Bearer test-secret' },
        });

        const res = await scannerCronHandler(req);
        assert.equal(res.status, 409);
        const data = await res.json();
        assert.match(data.error, /Existing cursor validation failed/i);

        // Verify corrupt cursor was NOT modified, deleted, or reset
        const after = await cursorRepo.get(11155111, 'synq-sepolia-scanner-v1');
        assert.equal(after?.lastBlockNumber, 500n);
      } finally {
        process.env.CRON_SECRET = origSecret;
        process.env.ENABLE_CHAIN_SCANNER = origFlag;
      }
    });
  });

  describe('6. V1 History Preceding V2 Scanned and Processed', () => {
    it('live_v1_v2 scope starts at V1 deployment (11832783) and handles V1 events before V2 (11833191)', async () => {
      const v1Start = VERIFIED_SEPOLIA_COORDINATES.v1.deploymentBlock;
      assert.equal(SCANNER_SCOPES.live_v1_v2.verifiedStartBlock, v1Start);

      const scanner = new BlockchainScanner(
        11155111,
        'synq-sepolia-scanner-v1',
        rpcClient,
        cursorRepo,
        registry,
        outboxRepo,
        notifRepo,
        5n,
        100n,
        trackedRepo,
        v1Start,
        proposalRepo,
        SUPPORTED_SEPOLIA_FACTORIES,
      );

      // Initialize at V1 start
      await scanner.initializeCursorIfMissing({ startBlock: v1Start });
      const cursor = await cursorRepo.get(11155111, 'synq-sepolia-scanner-v1');
      assert.equal(cursor?.lastBlockNumber, v1Start - 1n);

      // Seed V1 event at block 11832800 (preceding V2 at 11833191)
      const v1DealAddr = '0x2222333344445555666677778888999900001111';
      const v1Block = await rpcClient.getBlock({ blockNumber: 11832800n });
      const factoryTopics = encodeEventTopics({
        abi: synqFactoryV2ABI,
        eventName: 'DealCreated',
        args: {
          dealAddress: v1DealAddr,
          client: '0x3333333333333333333333333333333333333333',
          freelancer: '0x4444444444444444444444444444444444444444',
        },
      });
      const factoryData = encodeAbiParameters(
        parseAbiParameters('address, address, address, address, uint256, uint256'),
        ['0x3333333333333333333333333333333333333333', '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', '0x0000000000000000000000000000000000000002', '0x0000000000000000000000000000000000000003', 5000000n, 1n],
      );

      rpcClient.logs.push({
        address: VERIFIED_SEPOLIA_COORDINATES.v1.address,
        topics: factoryTopics,
        data: factoryData,
        blockNumber: 11832800n,
        transactionHash: '0xv1_deal_creation_tx',
        logIndex: 0,
      });

      const result = await scanner.scanNextBatch();
      assert.equal(result.scanned, true);
      assert.equal(result.newContractsDiscovered.length, 1);
      assert.equal(result.newContractsDiscovered[0].toLowerCase(), v1DealAddr.toLowerCase());

      // Tracked contract metadata records v1 generation
      const tracked = await trackedRepo.get(11155111, v1DealAddr);
      assert.equal(tracked?.metadata?.generation, 'v1');
    });
  });

  describe('7. Legacy History Preceding V1/V2 With Scope Isolation', () => {
    it('legacy scope has dedicated cursor and does not force 326k-block stall on live scanner', async () => {
      // Legacy scope configuration
      assert.equal(SCANNER_SCOPES.legacy_nexotiq.scannerId, 'synq-sepolia-legacy-v1');
      assert.equal(SCANNER_SCOPES.legacy_nexotiq.verifiedStartBlock, 11507082n);
      assert.equal(SCANNER_SCOPES.legacy_nexotiq.maxAllowedBlock, 11832782n);

      // Initialize legacy cursor
      const legScanner = new BlockchainScanner(
        11155111,
        SCANNER_SCOPES.legacy_nexotiq.scannerId,
        rpcClient,
        cursorRepo,
        registry,
        outboxRepo,
        notifRepo,
        5n,
        100n,
        trackedRepo,
        11507082n,
        proposalRepo,
        SUPPORTED_SEPOLIA_FACTORIES.filter((f) => f.generation === 'legacy'),
      );

      await legScanner.initializeCursorIfMissing({ startBlock: 11507082n });

      // Initialize live scanner
      const liveScanner = new BlockchainScanner(
        11155111,
        SCANNER_SCOPES.live_v1_v2.scannerId,
        rpcClient,
        cursorRepo,
        registry,
        outboxRepo,
        notifRepo,
        5n,
        100n,
        trackedRepo,
        11832783n,
        proposalRepo,
        SUPPORTED_SEPOLIA_FACTORIES.filter((f) => f.generation !== 'legacy'),
      );

      await liveScanner.initializeCursorIfMissing({ startBlock: 11832783n });

      // Verify separate cursor identities and independent coordinates
      const legCursor = await cursorRepo.get(11155111, 'synq-sepolia-legacy-v1');
      const liveCursor = await cursorRepo.get(11155111, 'synq-sepolia-scanner-v1');

      assert.equal(legCursor?.lastBlockNumber, 11507081n);
      assert.equal(liveCursor?.lastBlockNumber, 11832782n);

      // Advance legacy cursor without affecting live cursor
      await cursorRepo.advance({
        chainId: 11155111,
        scannerId: 'synq-sepolia-legacy-v1',
        expectedLastBlockNumber: 11507081n,
        newBlockNumber: 11507181n,
        newBlockHash: '0xhash_leg_adv',
      });

      const liveAfter = await cursorRepo.get(11155111, 'synq-sepolia-scanner-v1');
      assert.equal(liveAfter?.lastBlockNumber, 11832782n); // Live unaffected!
    });
  });

  describe('8. Historical Deal Discovered Behind the Live Cursor', () => {
    it('detects replay requirement and does not regress live cursor', () => {
      const liveCursorBlock = 11834000n;
      const historicalDealAddr = '0x3333444455556666777788889999000011112222';
      const historicalDeployBlock = 11833500n; // Deployed 500 blocks behind live cursor!

      registry.registerContract({
        address: historicalDealAddr,
        contractType: 'deal_v2',
        deploymentBlock: historicalDeployBlock,
        metadata: { generation: 'v2' },
      });

      const replayCheck = registry.checkReplayRequirement(historicalDealAddr, liveCursorBlock);
      assert.equal(replayCheck.shouldReplay, true);
      assert.equal(replayCheck.deploymentBlock, historicalDeployBlock);

      // Future/same-block deal does not require replay
      const currentDealAddr = '0x4444555566667777888899990000111122223333';
      registry.registerContract({
        address: currentDealAddr,
        contractType: 'deal_v2',
        deploymentBlock: liveCursorBlock,
        metadata: { generation: 'v2' },
      });

      const currentCheck = registry.checkReplayRequirement(currentDealAddr, liveCursorBlock);
      assert.equal(currentCheck.shouldReplay, false);
    });
  });

  describe('9. Cursor Compare-and-Swap (CAS) Fencing', () => {
    it('stale worker update fails with conflict_stale and prevents regression', async () => {
      await cursorRepo.initializeIfMissing({
        chainId: 11155111,
        scannerId: 'cas-test-worker',
        initialBlockNumber: 11833000n,
        initialBlockHash: '0xhash_11833000',
        isBootstrap: true,
      });

      // Worker 1 advances to 11833100
      const adv1 = await cursorRepo.advance({
        chainId: 11155111,
        scannerId: 'cas-test-worker',
        expectedLastBlockNumber: 11833000n,
        newBlockNumber: 11833100n,
        newBlockHash: '0xhash_11833100',
      });
      assert.equal(adv1.status, 'advanced');

      // Worker 2 attempts advance with stale expected 11833000 -> rejected
      const adv2 = await cursorRepo.advance({
        chainId: 11155111,
        scannerId: 'cas-test-worker',
        expectedLastBlockNumber: 11833000n,
        newBlockNumber: 11833050n,
        newBlockHash: '0xhash_11833050',
      });
      assert.equal(adv2.status, 'conflict_stale');

      // Monotonicity violation: cannot advance backward
      await assert.rejects(
        async () => {
          await cursorRepo.advance({
            chainId: 11155111,
            scannerId: 'cas-test-worker',
            expectedLastBlockNumber: 11833100n,
            newBlockNumber: 11833000n, // Backward!
            newBlockHash: '0xhash_backward',
          });
        },
        /Monotonicity violation/i,
      );
    });
  });

  describe('10. Disabled Worker Behavior', () => {
    it('route returns 403 status=disabled when ENABLE_CHAIN_SCANNER !== true without touching RPC or DB', async () => {
      const origSecret = process.env.CRON_SECRET;
      const origFlag = process.env.ENABLE_CHAIN_SCANNER;

      try {
        process.env.CRON_SECRET = 'test-secret';
        process.env.ENABLE_CHAIN_SCANNER = 'false';

        const req = new NextRequest('http://localhost:3000/api/cron/scanner', {
          method: 'POST',
          headers: { Authorization: 'Bearer test-secret' },
        });

        const res = await scannerCronHandler(req);
        assert.equal(res.status, 403);
        const data = await res.json();
        assert.equal(data.status, 'disabled');

        // Verify DB was never touched
        const cursor = await cursorRepo.get(11155111, 'synq-sepolia-scanner-v1');
        assert.equal(cursor, null);
      } finally {
        process.env.CRON_SECRET = origSecret;
        process.env.ENABLE_CHAIN_SCANNER = origFlag;
      }
    });
  });

  describe('11. B.12.3.21 Migration 0019 & Cursor Safety Validation', () => {
    it('pre-existing cursors retain historical meaning with isBootstrap=false and unchanged coordinates', async () => {
      // Simulate an existing cursor present before migration 0019
      const existing = await cursorRepo.initializeIfMissing({
        chainId: 11155111,
        scannerId: 'synq-sepolia-scanner-v1',
        initialBlockNumber: 11833500n,
        initialBlockHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        isBootstrap: false, // As populated by migration 0019 DEFAULT false
      });

      assert.equal(existing.lastBlockNumber, 11833500n);
      assert.equal(existing.lastBlockHash, '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
      assert.equal(existing.isBootstrap, false, 'Migrated cursor must retain isBootstrap=false');

      // Verify validation accepts it for head scanning but does not assume bootstrap anchor
      const val = validateScannerCursor({
        cursor: existing,
        expectedChainId: 11155111,
        expectedScannerId: 'synq-sepolia-scanner-v1',
        scope: SCANNER_SCOPES.live_v1_v2,
      });
      assert.equal(val.valid, true);
    });

    it('new bootstrap cursors are initialized with isBootstrap=true at anchor block (startBlock - 1n)', async () => {
      const scope = SCANNER_SCOPES.live_v1_v2;
      const v1Start = scope.verifiedStartBlock; // 11832783n
      const anchor = v1Start - 1n; // 11832782n

      const newCursor = await cursorRepo.initializeIfMissing({
        chainId: 11155111,
        scannerId: scope.scannerId,
        initialBlockNumber: anchor,
        initialBlockHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        isBootstrap: true,
      });

      assert.equal(newCursor.lastBlockNumber, anchor);
      assert.equal(newCursor.isBootstrap, true);

      // Validate bootstrap cursor matches scope anchor
      const val = validateScannerCursor({
        cursor: newCursor,
        expectedChainId: 11155111,
        expectedScannerId: scope.scannerId,
        scope,
      });
      assert.equal(val.valid, true);
    });

    it('rejects invalid bootstrap metadata (zero hash, malformed hash, chain ID mismatch)', async () => {
      const scope = SCANNER_SCOPES.live_v1_v2;

      // 1. Zero block hash
      const zeroHashCursor = {
        chainId: 11155111,
        scannerId: scope.scannerId,
        lastBlockNumber: scope.verifiedStartBlock - 1n,
        lastBlockHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        isBootstrap: true,
      };
      const res1 = validateScannerCursor({
        cursor: zeroHashCursor,
        expectedChainId: 11155111,
        expectedScannerId: scope.scannerId,
        scope,
      });
      assert.equal(res1.valid, false);
      assert.match(res1.reason || '', /zero or malformed/i);

      // 2. Malformed hex hash (not 32 bytes)
      const malformedCursor = {
        chainId: 11155111,
        scannerId: scope.scannerId,
        lastBlockNumber: scope.verifiedStartBlock - 1n,
        lastBlockHash: '0xinvalid_hash',
        isBootstrap: true,
      };
      const res2 = validateScannerCursor({
        cursor: malformedCursor,
        expectedChainId: 11155111,
        expectedScannerId: scope.scannerId,
        scope,
      });
      assert.equal(res2.valid, false);
      assert.match(res2.reason || '', /zero or malformed/i);

      // 3. Chain ID mismatch
      const wrongChainCursor = {
        chainId: 1, // Mainnet instead of Sepolia
        scannerId: scope.scannerId,
        lastBlockNumber: scope.verifiedStartBlock - 1n,
        lastBlockHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        isBootstrap: true,
      };
      const res3 = validateScannerCursor({
        cursor: wrongChainCursor,
        expectedChainId: 11155111,
        expectedScannerId: scope.scannerId,
        scope,
      });
      assert.equal(res3.valid, false);
      assert.match(res3.reason || '', /chain ID mismatch/i);
    });

    it('combined live_v1_v2 scope rejects V2-only start block to prevent silently skipping V1 events', async () => {
      const scope = SCANNER_SCOPES.live_v1_v2;
      const v2Start = VERIFIED_SEPOLIA_COORDINATES.v2.deploymentBlock; // 11833191n

      // 1. validateScannerCursor rejects configuredStartBlock at V2 deployment
      const cursor = {
        chainId: 11155111,
        scannerId: scope.scannerId,
        lastBlockNumber: scope.verifiedStartBlock - 1n,
        lastBlockHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        isBootstrap: true,
      };
      const val = validateScannerCursor({
        cursor,
        expectedChainId: 11155111,
        expectedScannerId: scope.scannerId,
        scope,
        configuredStartBlock: v2Start,
      });
      assert.equal(val.valid, false);
      assert.match(val.reason || '', /V2-only or truncated starting block/i);

      // 2. validateScannerCursor rejects bootstrap anchor at V2 deployment coordinate
      const v2AnchorCursor = {
        chainId: 11155111,
        scannerId: scope.scannerId,
        lastBlockNumber: v2Start - 1n, // 11833190n (skips V1 blocks 11832783..11833190)
        lastBlockHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        isBootstrap: true,
      };
      const val2 = validateScannerCursor({
        cursor: v2AnchorCursor,
        expectedChainId: 11155111,
        expectedScannerId: scope.scannerId,
        scope,
      });
      assert.equal(val2.valid, false);
      assert.match(val2.reason || '', /reflects a V2-only start coordinate/i);

      // 3. Scanner cron route rejects V2 start on combined scope with 400 Bad Request
      const origSecret = process.env.CRON_SECRET;
      const origFlag = process.env.ENABLE_CHAIN_SCANNER;
      try {
        process.env.CRON_SECRET = 'test-secret';
        process.env.ENABLE_CHAIN_SCANNER = 'true';

        const req = new NextRequest('http://localhost:3000/api/cron/scanner', {
          method: 'POST',
          headers: { Authorization: 'Bearer test-secret' },
          body: JSON.stringify({
            scope: 'live_v1_v2',
            startBlock: Number(v2Start),
          }),
        });

        const res = await scannerCronHandler(req);
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.match(data.error, /V2-only or truncated starting block/i);
      } finally {
        process.env.CRON_SECRET = origSecret;
        process.env.ENABLE_CHAIN_SCANNER = origFlag;
      }
    });

    it('dedicated v2_only scope allows starting at V2 deployment block without skipping check error', () => {
      const v2Scope = SCANNER_SCOPES.v2_only;
      assert.ok(v2Scope, 'v2_only scope must be registered');
      assert.equal(v2Scope.verifiedStartBlock, 11833191n);
      assert.equal(v2Scope.minAllowedBlock, 11833191n);
      assert.deepEqual(v2Scope.supportedGenerations, ['v2']);

      const cursor = {
        chainId: 11155111,
        scannerId: v2Scope.scannerId,
        lastBlockNumber: 11833190n, // Anchor block
        lastBlockHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        isBootstrap: true,
      };

      const val = validateScannerCursor({
        cursor,
        expectedChainId: 11155111,
        expectedScannerId: v2Scope.scannerId,
        scope: v2Scope,
        configuredStartBlock: 11833191n,
      });
      assert.equal(val.valid, true);
    });

    it('legacy scope isolation preserves separate historical boundaries without global minBlock exclusion', () => {
      const legacyScope = SCANNER_SCOPES.legacy_nexotiq;
      assert.equal(legacyScope.verifiedStartBlock, 11507082n);
      assert.equal(legacyScope.minAllowedBlock, 11507082n);
      assert.equal(legacyScope.maxAllowedBlock, 11832782n);

      // Verify anchor coordinate is accepted
      const legacyAnchor = {
        chainId: 11155111,
        scannerId: legacyScope.scannerId,
        lastBlockNumber: 11507081n,
        lastBlockHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        isBootstrap: true,
      };

      const val = validateScannerCursor({
        cursor: legacyAnchor,
        expectedChainId: 11155111,
        expectedScannerId: legacyScope.scannerId,
        scope: legacyScope,
      });
      assert.equal(val.valid, true);

      // Block exceeding historical ceiling is rejected
      const overCeilingCursor = {
        ...legacyAnchor,
        lastBlockNumber: 11832783n, // V1 deployment block
      };
      const valOver = validateScannerCursor({
        cursor: overCeilingCursor,
        expectedChainId: 11155111,
        expectedScannerId: legacyScope.scannerId,
        scope: legacyScope,
      });
      assert.equal(valOver.valid, false);
      assert.match(valOver.reason || '', /exceeds maximum historical ceiling/i);
    });

    it('unknown historical coverage fails closed without rewinding or mutating persisted cursor', async () => {
      const scope = SCANNER_SCOPES.live_v1_v2;
      const initialBlock = 12000000n;
      const initialHash = '0x1111111111111111111111111111111111111111111111111111111111111111';

      // Persist cursor in repository
      await cursorRepo.initializeIfMissing({
        chainId: 11155111,
        scannerId: scope.scannerId,
        initialBlockNumber: initialBlock,
        initialBlockHash: initialHash,
        isBootstrap: false,
      });

      const cursor = (await cursorRepo.get(11155111, scope.scannerId))!;

      // 1. When requireHistoricalCoverage is true, fail closed
      const auditResult = validateScannerCursor({
        cursor,
        expectedChainId: 11155111,
        expectedScannerId: scope.scannerId,
        scope,
        requireHistoricalCoverage: true,
      });
      assert.equal(auditResult.valid, false);
      assert.equal(auditResult.historicalCoverageEstablished, false);
      assert.match(auditResult.reason || '', /Unknown historical coverage/i);

      // 2. Persisted cursor must NOT be rewound, overwritten, or modified
      const persistedAfterAudit = await cursorRepo.get(11155111, scope.scannerId);
      assert.equal(persistedAfterAudit?.lastBlockNumber, initialBlock, 'Cursor block number must remain unchanged');
      assert.equal(persistedAfterAudit?.lastBlockHash, initialHash, 'Cursor block hash must remain unchanged');
      assert.equal(persistedAfterAudit?.isBootstrap, false, 'isBootstrap must remain unchanged');
    });

    it('concurrent initialization and CAS advancement lifecycle executes safely in-memory', async () => {
      const chainId = 11155111;
      const scannerId = 'synq-mem-concurrent-test';
      const anchorBlock = 11832782n;
      const anchorHash = '0x1111111111111111111111111111111111111111111111111111111111111111';

      // 1. Parallel initialization
      const promises = Array.from({ length: 10 }, () =>
        cursorRepo.initializeIfMissing({
          chainId,
          scannerId,
          initialBlockNumber: anchorBlock,
          initialBlockHash: anchorHash,
          isBootstrap: true,
        }),
      );
      const results = await Promise.all(promises);
      for (const r of results) {
        assert.equal(r.lastBlockNumber, anchorBlock);
        assert.equal(r.isBootstrap, true);
      }

      // 2. Repeatability: re-calling initialize does not alter state
      const repeated = await cursorRepo.initializeIfMissing({
        chainId,
        scannerId,
        initialBlockNumber: 99999999n,
        initialBlockHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
        isBootstrap: false,
      });
      assert.equal(repeated.lastBlockNumber, anchorBlock);
      assert.equal(repeated.isBootstrap, true);

      // 3. CAS advancement flips isBootstrap to false
      const advanceBlock = 11832800n;
      const advanceHash = '0x2222222222222222222222222222222222222222222222222222222222222222';
      const advanceRes = await cursorRepo.advance({
        chainId,
        scannerId,
        expectedLastBlockNumber: anchorBlock,
        newBlockNumber: advanceBlock,
        newBlockHash: advanceHash,
      });
      assert.equal(advanceRes.status, 'advanced');
      assert.equal(advanceRes.cursor?.lastBlockNumber, advanceBlock);
      assert.equal(advanceRes.cursor?.isBootstrap, false, 'Advancement must transition isBootstrap to false');

      // 4. Stale CAS advancement fails
      const staleRes = await cursorRepo.advance({
        chainId,
        scannerId,
        expectedLastBlockNumber: anchorBlock, // Stale!
        newBlockNumber: 11832900n,
        newBlockHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      });
      assert.equal(staleRes.status, 'conflict_stale');
    });
  });
});
