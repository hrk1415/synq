/**
 * SYNQ — Scanner Reliability and Observability Regression Suite
 *
 * Verifies:
 * 1. Idempotent bootstrapFactories() execution on success.
 * 2. bootstrapFactories() failure handling and safe retry.
 * 3. Newly accepted deal discovery on subsequent scans across reused instances.
 * 4. Per-stage structured duration logs with correlation IDs.
 * 5. Safe abort without cursor advancement on RPC failures (getLogs).
 * 6. Safe abort without cursor advancement on event persistence failure.
 * 7. Receipt timeout with unresolved accepted deal fails closed and blocks cursor advancement.
 * 8. CAS protection against concurrent cursor modification.
 * 9. Production RPC transport configuration (bounded timeouts, retryCount: 0 on fallback, no HTTP batching).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters } from 'viem';
import {
  BlockchainScanner,
  IScannerRpcClient,
  RawLog,
  SUPPORTED_SEPOLIA_FACTORIES,
} from '../src/lib/deals/chain-scanner';
import { synqDealV1ABI } from '../src/lib/contracts/abis';
import {
  IChainCursorRepository,
  ChainSyncCursor,
} from '../src/lib/deals/chain-sync-db';
import {
  ITrackedContractsRepository,
  TrackedContract,
} from '../src/lib/deals/tracked-contracts-db';
import {
  IDealProposalRepository,
  DealProposalRecord,
} from '../src/lib/deals/proposals-db';
import {
  IDealOutboxRepository,
} from '../src/lib/deals/outbox-db';
import { DealContractRegistry } from '../src/lib/deals/chain-event-ingestion';
import { sepoliaPublicClient } from '../src/lib/chain';

class MockCursorRepo implements IChainCursorRepository {
  public cursor: ChainSyncCursor | null = null;
  public advanceCalls = 0;

  async get(chainId: number, scannerId: string): Promise<ChainSyncCursor | null> {
    return this.cursor;
  }

  async advance(params: {
    chainId: number;
    scannerId: string;
    expectedLastBlockNumber: bigint;
    newBlockNumber: bigint;
    newBlockHash: string;
  }): Promise<{ status: 'advanced' | 'conflict'; currentBlockNumber: bigint; currentBlockHash: string }> {
    this.advanceCalls++;
    if (!this.cursor || this.cursor.lastBlockNumber !== params.expectedLastBlockNumber) {
      return {
        status: 'conflict',
        currentBlockNumber: this.cursor ? this.cursor.lastBlockNumber : 0n,
        currentBlockHash: this.cursor ? this.cursor.lastBlockHash : '0x0',
      };
    }
    this.cursor = {
      ...this.cursor,
      lastBlockNumber: params.newBlockNumber,
      lastBlockHash: params.newBlockHash,
      updatedAt: new Date(),
    };
    return {
      status: 'advanced',
      currentBlockNumber: params.newBlockNumber,
      currentBlockHash: params.newBlockHash,
    };
  }

  async rewind(): Promise<ChainSyncCursor> {
    throw new Error('Not implemented');
  }

  async initializeIfMissing(): Promise<ChainSyncCursor> {
    throw new Error('Not implemented');
  }
}

class MockTrackedContractsRepo implements ITrackedContractsRepository {
  public upsertCalls = 0;
  public shouldFailUpsert = false;
  public contracts: TrackedContract[] = [];

  async upsert(contract: any): Promise<TrackedContract> {
    this.upsertCalls++;
    if (this.shouldFailUpsert) {
      throw new Error('Database write error during contract upsert');
    }
    const existingIdx = this.contracts.findIndex(
      (c) => c.contractAddress.toLowerCase() === contract.contractAddress.toLowerCase()
    );
    const saved: TrackedContract = {
      id: `tc_${Date.now()}_${Math.random()}`,
      chainId: contract.chainId,
      contractAddress: contract.contractAddress,
      contractType: contract.contractType,
      factoryAddress: contract.factoryAddress,
      deploymentBlock: contract.deploymentBlock ?? 0n,
      buyerWallet: contract.buyerWallet,
      sellerWallet: contract.sellerWallet,
      metadata: contract.metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (existingIdx >= 0) {
      this.contracts[existingIdx] = saved;
    } else {
      this.contracts.push(saved);
    }
    return saved;
  }

  async get(chainId: number, address: string): Promise<TrackedContract | null> {
    return (
      this.contracts.find((c) => c.contractAddress.toLowerCase() === address.toLowerCase()) ?? null
    );
  }

  async getAll(chainId: number): Promise<TrackedContract[]> {
    return this.contracts;
  }

  async deleteOrphanedAboveBlock(): Promise<number> {
    return 0;
  }
}

class MockProposalRepo implements IDealProposalRepository {
  public getAcceptedDealsCalls = 0;
  public proposals: DealProposalRecord[] = [];

  async getAcceptedDeals(chainId: number): Promise<DealProposalRecord[]> {
    this.getAcceptedDealsCalls++;
    return this.proposals;
  }

  async getById(): Promise<any> { return null; }
  async getByDealAddress(): Promise<any> { return null; }
  async create(): Promise<any> { throw new Error('Not implemented'); }
  async updateStatus(): Promise<any> { return null; }
}

class MockOutboxRepo implements IDealOutboxRepository {
  public enqueuedEvents: any[] = [];
  public shouldFail = false;

  async enqueue(event: any): Promise<'enqueued' | 'duplicate'> {
    if (this.shouldFail) {
      throw new Error('Database connection failed while enqueueing event');
    }
    this.enqueuedEvents.push(event);
    return 'enqueued';
  }

  async get(): Promise<any> { return null; }
  async getPending(): Promise<any> { return []; }
  async claim(): Promise<any> { return false; }
  async releaseClaim(): Promise<any> {}
  async markProcessed(): Promise<any> {}
  async markFailed(): Promise<any> {}
  async markSkipped(): Promise<any> {}
  async invalidateOrphanedEvents(): Promise<number> { return 0; }
}

describe('SYNQ — Scanner Reliability and Observability Suite', () => {
  it('1. bootstrapFactories seeds factories idempotently only once per instance', async () => {
    const cursorRepo = new MockCursorRepo();
    const trackedRepo = new MockTrackedContractsRepo();
    const proposalRepo = new MockProposalRepo();
    const outboxRepo = new MockOutboxRepo();
    const registry = new DealContractRegistry();

    const rpcClient: IScannerRpcClient = {
      async getBlockNumber() { return 11845400n; },
      async getBlock(p) { return { hash: `0xhash_${p.blockNumber}`, parentHash: `0xhash_${p.blockNumber - 1n}` }; },
      async getLogs() { return []; },
    };

    const scanner = new BlockchainScanner(
      11155111,
      'synq-sepolia-scanner-v1',
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      undefined as any,
      5n,
      100n,
      trackedRepo,
      0n,
      proposalRepo,
    );

    // Call 1
    await scanner.bootstrapFactories();
    const upsertsAfterFirstBootstrap = trackedRepo.upsertCalls;
    assert.ok(upsertsAfterFirstBootstrap > 0, 'First bootstrap should perform factory upserts');

    // Call 2 (should be idempotent no-op)
    await scanner.bootstrapFactories();
    assert.strictEqual(trackedRepo.upsertCalls, upsertsAfterFirstBootstrap, 'Second bootstrap must be a no-op');
  });

  it('2. bootstrapFactories failure allows safe retry without permanent failure flag', async () => {
    const cursorRepo = new MockCursorRepo();
    const trackedRepo = new MockTrackedContractsRepo();
    const proposalRepo = new MockProposalRepo();
    const outboxRepo = new MockOutboxRepo();
    const registry = new DealContractRegistry();

    trackedRepo.shouldFailUpsert = true; // DB failure during initialization

    const rpcClient: IScannerRpcClient = {
      async getBlockNumber() { return 11845400n; },
      async getBlock(p) { return { hash: `0xhash_${p.blockNumber}`, parentHash: `0xhash_${p.blockNumber - 1n}` }; },
      async getLogs() { return []; },
    };

    const scanner = new BlockchainScanner(
      11155111,
      'synq-sepolia-scanner-v1',
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      undefined as any,
      5n,
      100n,
      trackedRepo,
      0n,
      proposalRepo,
    );

    // Attempt 1: fails
    await assert.rejects(
      async () => { await scanner.bootstrapFactories(); },
      /Database write error during contract upsert/
    );

    // DB recovers
    trackedRepo.shouldFailUpsert = false;

    // Attempt 2: retries cleanly and succeeds
    await scanner.bootstrapFactories();
    assert.ok(trackedRepo.upsertCalls > 1, 'Retry should execute after previous failure');
    assert.ok(registry.isRegistered(SUPPORTED_SEPOLIA_FACTORIES[0].address), 'Factory must be registered');
  });

  it('3. Newly accepted deals are discovered on subsequent scans across a reused scanner instance', async () => {
    const cursorRepo = new MockCursorRepo();
    cursorRepo.cursor = {
      chainId: 11155111,
      scannerId: 'synq-sepolia-scanner-v1',
      lastBlockNumber: 11845392n,
      lastBlockHash: '0xhash_11845392',
      updatedAt: new Date(),
    };

    const trackedRepo = new MockTrackedContractsRepo();
    const proposalRepo = new MockProposalRepo();
    const outboxRepo = new MockOutboxRepo();
    const registry = new DealContractRegistry();

    // Deal 1 initially accepted
    proposalRepo.proposals = [
      {
        proposalId: 'prop_deal_1',
        chainId: 11155111,
        dealAddress: '0x1111111111111111111111111111111111111111',
        factoryAddress: SUPPORTED_SEPOLIA_FACTORIES[0].address,
        clientWallet: '0x2222222222222222222222222222222222222222',
        freelancerWallet: '0x3333333333333333333333333333333333333333',
        status: 'ACCEPTED',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any,
    ];

    const rpcClient: IScannerRpcClient = {
      async getBlockNumber() { return 11845450n; },
      async getBlock(p) { return { hash: `0xhash_${p.blockNumber}`, parentHash: `0xhash_${p.blockNumber - 1n}` }; },
      async getLogs() { return []; },
    };

    const scanner = new BlockchainScanner(
      11155111,
      'synq-sepolia-scanner-v1',
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      undefined as any,
      5n,
      20n,
      trackedRepo,
      0n,
      proposalRepo,
    );

    // Scan Batch 1
    const res1 = await scanner.scanNextBatch({ correlationId: 'batch_1' });
    assert.strictEqual(res1.scanned, true);
    assert.ok(registry.isRegistered('0x1111111111111111111111111111111111111111'));
    assert.strictEqual(registry.isRegistered('0x4444444444444444444444444444444444444444'), false);

    // User accepts Deal 2 between scans
    proposalRepo.proposals.push({
      proposalId: 'prop_deal_2',
      chainId: 11155111,
      dealAddress: '0x4444444444444444444444444444444444444444',
      factoryAddress: SUPPORTED_SEPOLIA_FACTORIES[0].address,
      clientWallet: '0x5555555555555555555555555555555555555555',
      freelancerWallet: '0x6666666666666666666666666666666666666666',
      status: 'ACCEPTED',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    // Scan Batch 2 on the SAME scanner instance
    const res2 = await scanner.scanNextBatch({ correlationId: 'batch_2' });
    assert.strictEqual(res2.scanned, true);
    assert.ok(registry.isRegistered('0x4444444444444444444444444444444444444444'), 'Deal 2 must be discovered and registered');
  });

  it('4. Structured stage duration logs include correlation ID and block ranges without secrets', async () => {
    const cursorRepo = new MockCursorRepo();
    cursorRepo.cursor = {
      chainId: 11155111,
      scannerId: 'synq-sepolia-scanner-v1',
      lastBlockNumber: 11845392n,
      lastBlockHash: '0xhash_11845392',
      updatedAt: new Date(),
    };

    const trackedRepo = new MockTrackedContractsRepo();
    const proposalRepo = new MockProposalRepo();
    const outboxRepo = new MockOutboxRepo();
    const registry = new DealContractRegistry();

    const rpcClient: IScannerRpcClient = {
      async getBlockNumber() { return 11845500n; },
      async getBlock(p) { return { hash: `0xhash_${p.blockNumber}`, parentHash: `0xhash_${p.blockNumber - 1n}` }; },
      async getLogs() { return []; },
    };

    const scanner = new BlockchainScanner(
      11155111,
      'synq-sepolia-scanner-v1',
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      undefined as any,
      5n,
      50n,
      trackedRepo,
      0n,
      proposalRepo,
    );

    const loggedLines: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: any[]) => {
      loggedLines.push(args.join(' '));
    };

    try {
      const result = await scanner.scanNextBatch({ correlationId: 'test_req_42' });
      assert.strictEqual(result.scanned, true);
      assert.strictEqual(result.fromBlock, 11845393n);
      assert.strictEqual(result.toBlock, 11845442n);
    } finally {
      console.log = originalConsoleLog;
    }

    const scannerLogs = loggedLines.filter((l) => l.includes('[Scanner:test_req_42]'));
    assert.ok(scannerLogs.length >= 6, 'Should emit multiple structured stage logs with correlation ID');
    assert.ok(scannerLogs.some((l) => l.includes("Stage 'cursorRepo.get'")), 'Should log cursor read stage');
    assert.ok(scannerLogs.some((l) => l.includes("Stage 'rpcGetBlockNumber'")), 'Should log getBlockNumber stage');
    assert.ok(scannerLogs.some((l) => l.includes('Scanning range 11845393..11845442')), 'Should log block range');
    assert.ok(scannerLogs.some((l) => l.includes("Stage 'rpcGetLogs'")), 'Should log getLogs stage');
    assert.ok(scannerLogs.some((l) => l.includes("Stage 'cursorAdvance'")), 'Should log cursor advance stage');
  });

  it('5. RPC failure during getLogs aborts scanning without advancing cursor', async () => {
    const cursorRepo = new MockCursorRepo();
    cursorRepo.cursor = {
      chainId: 11155111,
      scannerId: 'synq-sepolia-scanner-v1',
      lastBlockNumber: 11845392n,
      lastBlockHash: '0xhash_11845392',
      updatedAt: new Date(),
    };

    const trackedRepo = new MockTrackedContractsRepo();
    const proposalRepo = new MockProposalRepo();
    const outboxRepo = new MockOutboxRepo();
    const registry = new DealContractRegistry();

    const rpcClient: IScannerRpcClient = {
      async getBlockNumber() { return 11845500n; },
      async getBlock(p) { return { hash: `0xhash_${p.blockNumber}`, parentHash: `0xhash_${p.blockNumber - 1n}` }; },
      async getLogs() {
        throw new Error('RPC rate limit: HTTP 429 Too Many Requests');
      },
    };

    const scanner = new BlockchainScanner(
      11155111,
      'synq-sepolia-scanner-v1',
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      undefined as any,
      5n,
      50n,
      trackedRepo,
      0n,
      proposalRepo,
    );

    await assert.rejects(
      async () => {
        await scanner.scanNextBatch({ correlationId: 'fail_getlogs' });
      },
      /RPC rate limit/,
      'Should propagate getLogs error without swallowing'
    );

    assert.strictEqual(cursorRepo.advanceCalls, 0, 'advance() must not be called when getLogs fails');
    assert.strictEqual(cursorRepo.cursor.lastBlockNumber, 11845392n, 'Cursor must remain unchanged');
  });

  it('6. Event persistence failure aborts scanning without advancing cursor', async () => {
    const cursorRepo = new MockCursorRepo();
    cursorRepo.cursor = {
      chainId: 11155111,
      scannerId: 'synq-sepolia-scanner-v1',
      lastBlockNumber: 11845392n,
      lastBlockHash: '0xhash_11845392',
      updatedAt: new Date(),
    };

    const trackedRepo = new MockTrackedContractsRepo();
    const proposalRepo = new MockProposalRepo();
    const outboxRepo = new MockOutboxRepo();
    outboxRepo.shouldFail = true; // Simulate DB write failure on outbox
    const registry = new DealContractRegistry();

    const dealAddress = '0x1111111111111111111111111111111111111111';
    registry.registerContract({
      address: dealAddress,
      contractType: 'deal_v1',
      deploymentBlock: 11845000n,
      metadata: {
        generation: 'v1',
        buyerWallet: '0x2222222222222222222222222222222222222222',
        sellerWallet: '0x3333333333333333333333333333333333333333',
      },
    });

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

    const mockLog: RawLog = {
      address: dealAddress,
      topics: msTopics,
      data: msData,
      blockNumber: 11845393n,
      blockHash: '0xblockhash_11845393',
      transactionHash: '0xtx_1',
      transactionIndex: 0,
      logIndex: 0,
    };

    const rpcClient: IScannerRpcClient = {
      async getBlockNumber() { return 11845500n; },
      async getBlock(p) { return { hash: `0xhash_${p.blockNumber}`, parentHash: `0xhash_${p.blockNumber - 1n}` }; },
      async getLogs() { return [mockLog]; },
    };

    const scanner = new BlockchainScanner(
      11155111,
      'synq-sepolia-scanner-v1',
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      undefined as any,
      5n,
      50n,
      trackedRepo,
      0n,
      proposalRepo,
    );

    await assert.rejects(
      async () => {
        await scanner.scanNextBatch({ correlationId: 'fail_outbox' });
      },
      /Database connection failed while enqueueing event/
    );

    assert.strictEqual(cursorRepo.advanceCalls, 0, 'advance() must not be called when outbox persistence fails');
    assert.strictEqual(cursorRepo.cursor.lastBlockNumber, 11845392n, 'Cursor must remain strictly at 11845392');
  });

  it('7. Receipt timeout with unresolved accepted deal fails closed and prevents cursor advancement', async () => {
    const cursorRepo = new MockCursorRepo();
    cursorRepo.cursor = {
      chainId: 11155111,
      scannerId: 'synq-sepolia-scanner-v1',
      lastBlockNumber: 11845392n,
      lastBlockHash: '0xhash_11845392',
      updatedAt: new Date(),
    };

    const trackedRepo = new MockTrackedContractsRepo();
    const proposalRepo = new MockProposalRepo();
    proposalRepo.proposals = [
      {
        proposalId: 'prop_hung',
        chainId: 11155111,
        dealAddress: '0x4444444444444444444444444444444444444444',
        factoryAddress: SUPPORTED_SEPOLIA_FACTORIES[0].address,
        clientWallet: '0x2222222222222222222222222222222222222222',
        freelancerWallet: '0x3333333333333333333333333333333333333333',
        status: 'ACCEPTED',
        acceptedTxHash: '0xhung_tx_hash',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any,
    ];

    const outboxRepo = new MockOutboxRepo();
    const registry = new DealContractRegistry();

    const rpcClient: IScannerRpcClient = {
      async getBlockNumber() { return 11845450n; },
      async getBlock(p) { return { hash: `0xhash_${p.blockNumber}`, parentHash: `0xhash_${p.blockNumber - 1n}` }; },
      async getLogs() { return []; },
      async getTransactionReceipt() {
        // Intentionally reject to simulate RPC timeout / hung network
        throw new Error('Receipt lookup timed out after 6000ms for 0xhung_tx_hash');
      },
    };

    const scanner = new BlockchainScanner(
      11155111,
      'synq-sepolia-scanner-v1',
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      undefined as any,
      5n,
      50n,
      trackedRepo,
      0n,
      proposalRepo,
    );

    // Must fail closed to prevent advancing the cursor past unverified blocks
    await assert.rejects(
      async () => {
        await scanner.scanNextBatch({ correlationId: 'fail_receipt_timeout' });
      },
      /Failed to verify creation receipt for accepted deal prop_hung/,
      'Scan must fail closed when creation receipt lookup fails/times out'
    );

    assert.strictEqual(cursorRepo.advanceCalls, 0, 'Cursor advance must not be attempted');
    assert.strictEqual(cursorRepo.cursor.lastBlockNumber, 11845392n, 'Cursor must remain at 11845392');
  });

  it('8. CAS conflict prevents cursor advancement if another process advanced it concurrently', async () => {
    const cursorRepo = new MockCursorRepo();
    cursorRepo.cursor = {
      chainId: 11155111,
      scannerId: 'synq-sepolia-scanner-v1',
      lastBlockNumber: 11845392n,
      lastBlockHash: '0xhash_11845392',
      updatedAt: new Date(),
    };

    const trackedRepo = new MockTrackedContractsRepo();
    const proposalRepo = new MockProposalRepo();
    const outboxRepo = new MockOutboxRepo();
    const registry = new DealContractRegistry();

    const rpcClient: IScannerRpcClient = {
      async getBlockNumber() { return 11845500n; },
      async getBlock(p) {
        if (p.blockNumber === 11845442n) {
          cursorRepo.cursor = {
            chainId: 11155111,
            scannerId: 'synq-sepolia-scanner-v1',
            lastBlockNumber: 11845442n,
            lastBlockHash: '0xconcurrent_winner_hash',
            updatedAt: new Date(),
          };
        }
        return { hash: `0xhash_${p.blockNumber}`, parentHash: `0xhash_${p.blockNumber - 1n}` };
      },
      async getLogs() { return []; },
    };

    const scanner = new BlockchainScanner(
      11155111,
      'synq-sepolia-scanner-v1',
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      undefined as any,
      5n,
      50n,
      trackedRepo,
      0n,
      proposalRepo,
    );

    const result = await scanner.scanNextBatch({ correlationId: 'cas_conflict_test' });
    assert.strictEqual(result.cursorAdvanced, false, 'cursorAdvanced must be false on CAS conflict');
    assert.strictEqual(cursorRepo.advanceCalls, 1, 'advance() was attempted');
  });

  it('9. RPC transport configuration enforces bounded fallback retryCount: 0 and no HTTP request batching', () => {
    const client = sepoliaPublicClient;
    assert.strictEqual(client.chain.id, 11155111, 'Must target Sepolia chain');

    const transport = client.transport as any;
    assert.strictEqual(transport.type, 'fallback', 'Must use fallback transport');
    assert.strictEqual(transport.retryCount, 0, 'Fallback transport retryCount must be 0 to prevent cascading retries across endpoints');

    const innerTransports = transport.transports;
    assert.ok(Array.isArray(innerTransports), 'Must contain inner transport list');
    assert.ok(innerTransports.length >= 3, 'Must have at least 3 fallback endpoints');

    for (const t of innerTransports) {
      assert.strictEqual(t.config?.type, 'http', 'Inner transport must be HTTP');
      assert.strictEqual(t.config?.timeout, 6000, 'Public HTTP timeout must be bounded to 6000ms');
      assert.strictEqual(t.config?.retryCount, 1, 'Public HTTP retryCount must be bounded to 1');
      assert.strictEqual(t.config?.batch, undefined, 'HTTP request batching must not be enabled on public endpoints');
    }
  });
});
