/**
 * SYNQ — B.12.3.12 Factory Classification & Accepted-Deal Rehydration Tests
 *
 * Verifies:
 * 1. Authoritative resolution of V2, V1, and legacy Nexotiq factory generations.
 * 2. Fail-closed rejection of unknown, invalid, or null factory addresses.
 * 3. Preservation of distinct V2, V1, and Nexotiq contract types in tracked contracts.
 * 4. Safe skipping of unsupported contracts without altering proposal business status.
 * 5. Malformed proposal resilience (valid proposals rehydrate even if one throws).
 * 6. Idempotency across multiple consecutive rehydration passes.
 * 7. Hardened scanner edge cases:
 *    - Unknown-factory proposals and unblocked cursor advancement.
 *    - Legacy contract ABI selection.
 *    - Missing generation metadata fallback.
 *    - Ambiguous event signatures (DealCompleted).
 *    - Rehydration across cold starts.
 *    - Unknown factories not blocking valid contracts.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveFactoryGeneration,
  BlockchainScanner,
  SUPPORTED_SEPOLIA_FACTORIES,
  type IScannerRpcClient,
} from '../src/lib/deals/chain-scanner';

import {
  DealContractRegistry,
  type RawLog,
} from '../src/lib/deals/chain-event-ingestion';

import {
  InMemoryChainCursorRepository,
} from '../src/lib/deals/chain-sync-db';

import {
  InMemoryDealOutboxRepository,
} from '../src/lib/deals/outbox-db';

import {
  InMemoryNotificationsRepository,
} from '../src/lib/deals/notifications-db';

import {
  InMemoryTrackedContractsRepository,
} from '../src/lib/deals/tracked-contracts-db';

import {
  InMemoryDealProposalRepository,
} from '../src/lib/deals/proposals-db';

import { encodeEventTopics, encodeAbiParameters, parseAbiParameters } from 'viem';
import { synqDealV1ABI, nexotiqDealABI } from '../src/lib/contracts/abis';
import { SYNQ_V2_SEPOLIA_CONFIG, CONTRACT_ADDRESSES } from '../src/lib/contracts/addresses';
import sepoliaV2Deployment from '../deployments/sepolia-v2-standard.json';

class MockScannerRpcClient implements IScannerRpcClient {
  public headBlock: bigint = 1000n;
  public blocks = new Map<bigint, { hash: string; parentHash: string }>();
  public logs: RawLog[] = [];

  constructor() {
    for (let i = 0n; i <= 2000n; i++) {
      this.blocks.set(i, {
        hash: `0xhash_${i.toString().padStart(64, '0')}`,
        parentHash:
          i > 0n
            ? `0xhash_${(i - 1n).toString().padStart(64, '0')}`
            : '0x0000000000000000000000000000000000000000000000000000000000000000',
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

  async getLogs(params: {
    address?: string | string[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RawLog[]> {
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

describe('SYNQ — B.12.3.12 Factory Classification & Rehydration Unit Tests', () => {
  const v2Factory = SYNQ_V2_SEPOLIA_CONFIG.factory; // 0x9b7C5B529A420d015a85fD77040eF63b0e6cbdb0
  const v1Factory = sepoliaV2Deployment.contracts.supersededFactoryV1; // 0x7482c3439Aa6065066c7759b87eeD25a403CbB03
  const legacyFactory = CONTRACT_ADDRESSES.sepolia.NexotiqFactory; // 0x569146151D79B30087B27B6D3Df1FD16a846ae23
  const unknownFactory = '0x1234567890123456789012345678901234567890';

  const chainId = 11155111;
  const scannerId = 'test-rehydration-scanner';

  let cursorRepo: InMemoryChainCursorRepository;
  let outboxRepo: InMemoryDealOutboxRepository;
  let notifRepo: InMemoryNotificationsRepository;
  let trackedRepo: InMemoryTrackedContractsRepository;
  let proposalRepo: InMemoryDealProposalRepository;
  let registry: DealContractRegistry;
  let rpcClient: MockScannerRpcClient;

  beforeEach(() => {
    cursorRepo = new InMemoryChainCursorRepository();
    outboxRepo = new InMemoryDealOutboxRepository();
    notifRepo = new InMemoryNotificationsRepository();
    trackedRepo = new InMemoryTrackedContractsRepository();
    proposalRepo = new InMemoryDealProposalRepository();
    registry = new DealContractRegistry();
    rpcClient = new MockScannerRpcClient();
  });

  function createScanner() {
    return new BlockchainScanner(
      chainId,
      scannerId,
      rpcClient,
      cursorRepo,
      registry,
      outboxRepo,
      notifRepo,
      5n,
      100n,
      trackedRepo,
      0n,
      proposalRepo,
      SUPPORTED_SEPOLIA_FACTORIES,
    );
  }

  // 1. Factory Resolution Tests
  describe('resolveFactoryGeneration', () => {
    it('correctly resolves active V2 factory to deal_v2 and generation v2', () => {
      const res = resolveFactoryGeneration(v2Factory);
      assert.equal(res.supported, true);
      assert.equal(res.generation, 'v2');
      assert.equal(res.contractType, 'deal_v2');
      assert.equal(res.factoryAddress?.toLowerCase(), v2Factory.toLowerCase());
    });

    it('correctly resolves historical V1 factory to deal_v1 and generation v1', () => {
      const res = resolveFactoryGeneration(v1Factory);
      assert.equal(res.supported, true);
      assert.equal(res.generation, 'v1');
      assert.equal(res.contractType, 'deal_v1');
      assert.equal(res.factoryAddress?.toLowerCase(), v1Factory.toLowerCase());
    });

    it('correctly resolves legacy Nexotiq factory to deal_v1 and generation legacy', () => {
      const res = resolveFactoryGeneration(legacyFactory);
      assert.equal(res.supported, true);
      assert.equal(res.generation, 'legacy');
      assert.equal(res.contractType, 'deal_v1');
      assert.equal(res.factoryAddress?.toLowerCase(), legacyFactory.toLowerCase());
    });

    it('fails closed on unknown factory address', () => {
      const res = resolveFactoryGeneration(unknownFactory);
      assert.equal(res.supported, false);
      assert.equal(res.generation, undefined);
      assert.equal(res.contractType, undefined);
      assert.ok(res.reason?.includes('Unrecognized or unsupported factory'));
    });

    it('fails closed on null or undefined factory address', () => {
      const resNull = resolveFactoryGeneration(null);
      assert.equal(resNull.supported, false);

      const resUndef = resolveFactoryGeneration(undefined);
      assert.equal(resUndef.supported, false);

      const resEmpty = resolveFactoryGeneration('');
      assert.equal(resEmpty.supported, false);

      const resMalformed = resolveFactoryGeneration('0xinvalid');
      assert.equal(resMalformed.supported, false);
    });
  });

  // 2. Accepted Deal Rehydration Tests
  describe('rehydrateAcceptedDeals', () => {
    it('rehydrates V2 deal proposal with contractType deal_v2 and generation v2', async () => {
      const dealAddr = '0x2222333344445555666677778888999900001111';
      await proposalRepo.create({
        proposalId: 'prop-v2-1',
        proposalNonce: '1',
        chainId,
        factoryAddress: v2Factory,
        clientWallet: '0xaaaa111122223333444455556666777788889999',
        freelancerWallet: '0xbbbb111122223333444455556666777788889999',
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x7E376b006Db7798165a6b8E6B191E20e791E4419',
        primaryResolver: '0xaaaa111122223333444455556666777788889999',
        emergencyResolver: '0xaaaa111122223333444455556666777788889999',
        milestonesHash: '0x123',
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x0',
        expiry: '9999999999',
        clientSignature: '0xsignature',
        title: 'V2 Deal',
        scope: 'Development',
        totalAmount: '1000000',
        milestones: [],
        dealAddress: dealAddr,
        cachedStatus: 'ACCEPTED',
      } as any);

      const scanner = createScanner();
      const count = await scanner.rehydrateAcceptedDeals();
      assert.equal(count, 1);

      const tracked = await trackedRepo.get(chainId, dealAddr);
      assert.ok(tracked);
      assert.equal(tracked.contractType, 'deal_v2');
      assert.equal(tracked.metadata?.generation, 'v2');
      assert.equal(tracked.factoryAddress?.toLowerCase(), v2Factory.toLowerCase());

      assert.ok(registry.isRegistered(dealAddr));
      assert.equal(registry.getContract(dealAddr)?.contractType, 'deal_v2');
    });

    it('rehydrates V1 deal proposal with contractType deal_v1 and generation v1', async () => {
      const dealAddr = '0x3333444455556666777788889999000011112222';
      await proposalRepo.create({
        proposalId: 'prop-v1-1',
        proposalNonce: '2',
        chainId,
        factoryAddress: v1Factory,
        clientWallet: '0xaaaa111122223333444455556666777788889999',
        freelancerWallet: '0xbbbb111122223333444455556666777788889999',
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x2a3C8A880398FF6DD8e6F9976c8BE6C8aBef2435',
        primaryResolver: '0xaaaa111122223333444455556666777788889999',
        emergencyResolver: '0xaaaa111122223333444455556666777788889999',
        milestonesHash: '0x123',
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x0',
        expiry: '9999999999',
        clientSignature: '0xsignature',
        title: 'V1 Deal',
        scope: 'Development',
        totalAmount: '1000000',
        milestones: [],
        dealAddress: dealAddr,
        cachedStatus: 'ACCEPTED',
      } as any);

      const scanner = createScanner();
      const count = await scanner.rehydrateAcceptedDeals();
      assert.equal(count, 1);

      const tracked = await trackedRepo.get(chainId, dealAddr);
      assert.ok(tracked);
      assert.equal(tracked.contractType, 'deal_v1');
      assert.equal(tracked.metadata?.generation, 'v1');
      assert.equal(tracked.factoryAddress?.toLowerCase(), v1Factory.toLowerCase());

      assert.ok(registry.isRegistered(dealAddr));
      assert.equal(registry.getContract(dealAddr)?.contractType, 'deal_v1');
    });

    it('rehydrates Legacy Nexotiq deal proposal with contractType deal_v1 and generation legacy', async () => {
      const dealAddr = '0x4444555566667777888899990000111122223333';
      await proposalRepo.create({
        proposalId: 'prop-legacy-1',
        proposalNonce: '3',
        chainId,
        factoryAddress: legacyFactory,
        clientWallet: '0xaaaa111122223333444455556666777788889999',
        freelancerWallet: '0xbbbb111122223333444455556666777788889999',
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x2a3C8A880398FF6DD8e6F9976c8BE6C8aBef2435',
        primaryResolver: '0xaaaa111122223333444455556666777788889999',
        emergencyResolver: '0xaaaa111122223333444455556666777788889999',
        milestonesHash: '0x123',
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x0',
        expiry: '9999999999',
        clientSignature: '0xsignature',
        title: 'Nexotiq Deal',
        scope: 'Development',
        totalAmount: '1000000',
        milestones: [],
        dealAddress: dealAddr,
        cachedStatus: 'ACCEPTED',
      } as any);

      const scanner = createScanner();
      const count = await scanner.rehydrateAcceptedDeals();
      assert.equal(count, 1);

      const tracked = await trackedRepo.get(chainId, dealAddr);
      assert.ok(tracked);
      assert.equal(tracked.contractType, 'deal_v1');
      assert.equal(tracked.metadata?.generation, 'legacy');
      assert.equal(tracked.factoryAddress?.toLowerCase(), legacyFactory.toLowerCase());

      assert.ok(registry.isRegistered(dealAddr));
      assert.equal(registry.getContract(dealAddr)?.contractType, 'deal_v1');
    });

    it('fails closed: skips unknown factory proposals without modifying proposal cachedStatus', async () => {
      const dealAddr = '0x5555666677778888999900001111222233334444';
      const createdProp = await proposalRepo.create({
        proposalId: 'prop-unknown-factory',
        proposalNonce: '4',
        chainId,
        factoryAddress: unknownFactory, // Unknown factory!
        clientWallet: '0xaaaa111122223333444455556666777788889999',
        freelancerWallet: '0xbbbb111122223333444455556666777788889999',
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x7E376b006Db7798165a6b8E6B191E20e791E4419',
        primaryResolver: '0xaaaa111122223333444455556666777788889999',
        emergencyResolver: '0xaaaa111122223333444455556666777788889999',
        milestonesHash: '0x123',
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x0',
        expiry: '9999999999',
        clientSignature: '0xsignature',
        title: 'Unknown Factory Deal',
        scope: 'Development',
        totalAmount: '1000000',
        milestones: [],
        dealAddress: dealAddr,
        cachedStatus: 'ACCEPTED',
      } as any);

      const scanner = createScanner();
      const count = await scanner.rehydrateAcceptedDeals();
      assert.equal(count, 0, 'Must NOT rehydrate proposal from unknown factory');

      // Contract must NOT be registered or tracked
      assert.ok(!registry.isRegistered(dealAddr));
      const tracked = await trackedRepo.get(chainId, dealAddr);
      assert.equal(tracked, null);

      // Proposal status must remain ACCEPTED (business status must not change)
      const freshProp = await proposalRepo.getById(createdProp.proposalId);
      assert.equal(freshProp?.cachedStatus, 'ACCEPTED');
    });

    it('fails closed: skips proposals with missing or null factory address', async () => {
      const dealAddr = '0x6666777788889999000011112222333344445555';
      await proposalRepo.create({
        proposalId: 'prop-null-factory',
        proposalNonce: '5',
        chainId,
        factoryAddress: '', // Empty factory address
        clientWallet: '0xaaaa111122223333444455556666777788889999',
        freelancerWallet: '0xbbbb111122223333444455556666777788889999',
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x7E376b006Db7798165a6b8E6B191E20e791E4419',
        primaryResolver: '0xaaaa111122223333444455556666777788889999',
        emergencyResolver: '0xaaaa111122223333444455556666777788889999',
        milestonesHash: '0x123',
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x0',
        expiry: '9999999999',
        clientSignature: '0xsignature',
        title: 'Empty Factory Deal',
        scope: 'Development',
        totalAmount: '1000000',
        milestones: [],
        dealAddress: dealAddr,
        cachedStatus: 'ACCEPTED',
      } as any);

      const scanner = createScanner();
      const count = await scanner.rehydrateAcceptedDeals();
      assert.equal(count, 0);
      assert.ok(!registry.isRegistered(dealAddr));
    });

    it('rehydration is idempotent across multiple passes', async () => {
      const dealAddr = '0x7777888899990000111122223333444455556666';
      await proposalRepo.create({
        proposalId: 'prop-idempotent-test',
        proposalNonce: '6',
        chainId,
        factoryAddress: v2Factory,
        clientWallet: '0xaaaa111122223333444455556666777788889999',
        freelancerWallet: '0xbbbb111122223333444455556666777788889999',
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x7E376b006Db7798165a6b8E6B191E20e791E4419',
        primaryResolver: '0xaaaa111122223333444455556666777788889999',
        emergencyResolver: '0xaaaa111122223333444455556666777788889999',
        milestonesHash: '0x123',
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x0',
        expiry: '9999999999',
        clientSignature: '0xsignature',
        title: 'Idempotency Deal',
        scope: 'Development',
        totalAmount: '1000000',
        milestones: [],
        dealAddress: dealAddr,
        cachedStatus: 'ACCEPTED',
      } as any);

      const scanner = createScanner();
      const firstCount = await scanner.rehydrateAcceptedDeals();
      assert.equal(firstCount, 1);

      // Second pass should not duplicate or error
      const secondCount = await scanner.rehydrateAcceptedDeals();
      assert.equal(secondCount, 0, 'Second pass must encounter 0 newly rehydrated deals');

      const allTracked = await trackedRepo.getAll(chainId);
      assert.equal(allTracked.length, 1);
    });

    it('valid proposals rehydrate even if preceded by an unsupported or malformed proposal', async () => {
      // 1. Proposal with unknown factory
      await proposalRepo.create({
        proposalId: 'prop-bad-1',
        proposalNonce: '7',
        chainId,
        factoryAddress: unknownFactory,
        clientWallet: '0xaaaa111122223333444455556666777788889999',
        freelancerWallet: '0xbbbb111122223333444455556666777788889999',
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x7E376b006Db7798165a6b8E6B191E20e791E4419',
        primaryResolver: '0xaaaa111122223333444455556666777788889999',
        emergencyResolver: '0xaaaa111122223333444455556666777788889999',
        milestonesHash: '0x123',
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x0',
        expiry: '9999999999',
        clientSignature: '0xsignature',
        title: 'Bad Deal 1',
        scope: 'Development',
        totalAmount: '1000000',
        milestones: [],
        dealAddress: '0x8888999900001111222233334444555566667777',
        cachedStatus: 'ACCEPTED',
      } as any);

      // 2. Proposal with valid V2 factory
      const validDealAddr = '0x9999000011112222333344445555666677778888';
      await proposalRepo.create({
        proposalId: 'prop-good-2',
        proposalNonce: '8',
        chainId,
        factoryAddress: v2Factory,
        clientWallet: '0xaaaa111122223333444455556666777788889999',
        freelancerWallet: '0xbbbb111122223333444455556666777788889999',
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x7E376b006Db7798165a6b8E6B191E20e791E4419',
        primaryResolver: '0xaaaa111122223333444455556666777788889999',
        emergencyResolver: '0xaaaa111122223333444455556666777788889999',
        milestonesHash: '0x123',
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x0',
        expiry: '9999999999',
        clientSignature: '0xsignature',
        title: 'Good Deal 2',
        scope: 'Development',
        totalAmount: '1000000',
        milestones: [],
        dealAddress: validDealAddr,
        cachedStatus: 'ACCEPTED',
      } as any);

      const scanner = createScanner();
      const count = await scanner.rehydrateAcceptedDeals();
      assert.equal(count, 1, 'Only valid proposal should be rehydrated');

      assert.ok(!registry.isRegistered('0x8888999900001111222233334444555566667777'));
      assert.ok(registry.isRegistered(validDealAddr));
    });
  });

  // 3. Scanner Edge Cases & ABI Routing
  describe('Scanner Edge Cases & ABI Routing', () => {
    it('unknown-factory proposal does not block scanNextBatch cursor advancement', async () => {
      // Seed cursor at block 100n
      await cursorRepo.initializeIfMissing({
        chainId,
        scannerId,
        initialBlockNumber: 100n,
        initialBlockHash: rpcClient.blocks.get(100n)!.hash,
      });

      // Seed proposal with unknown factory
      await proposalRepo.create({
        proposalId: 'prop-unknown-edge',
        proposalNonce: '99',
        chainId,
        factoryAddress: unknownFactory,
        clientWallet: '0xaaaa111122223333444455556666777788889999',
        freelancerWallet: '0xbbbb111122223333444455556666777788889999',
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x7E376b006Db7798165a6b8E6B191E20e791E4419',
        primaryResolver: '0xaaaa111122223333444455556666777788889999',
        emergencyResolver: '0xaaaa111122223333444455556666777788889999',
        milestonesHash: '0x123',
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x0',
        expiry: '9999999999',
        clientSignature: '0xsignature',
        title: 'Unknown Factory Deal',
        scope: 'Edge Test',
        totalAmount: '1000000',
        milestones: [],
        dealAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        cachedStatus: 'ACCEPTED',
      } as any);

      rpcClient.headBlock = 110n; // With confirmation depth 5n, confirmed head is 105n
      const scanner = createScanner();
      const res = await scanner.scanNextBatch();

      assert.equal(res.scanned, true);
      assert.equal(res.cursorAdvanced, true);
      assert.equal(res.toBlock, 105n);

      const cursor = await cursorRepo.get(chainId, scannerId);
      assert.equal(cursor?.lastBlockNumber, 105n, 'Cursor must advance smoothly');
      assert.ok(!registry.isRegistered('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'));
    });

    it('legacy Nexotiq contract correctly routes to nexotiqDealABI for PaymentReleased', async () => {
      const dealAddr = '0xaaaa0000aaaa0000aaaa0000aaaa0000aaaa0000';
      const seller = '0xbbbb111122223333444455556666777788889999';
      const buyer = '0xaaaa111122223333444455556666777788889999';

      const scanner = createScanner();
      const topics = encodeEventTopics({
        abi: nexotiqDealABI,
        eventName: 'PaymentReleased',
        args: { milestoneId: 1n, to: seller },
      });
      const data = encodeAbiParameters(parseAbiParameters('uint256 amount'), [2500000n]);

      const rawLog: RawLog = {
        address: dealAddr,
        topics: topics as string[],
        data,
        blockNumber: 150n,
        transactionHash: '0xtx_legacy_pay',
        logIndex: 0,
      };

      const decoded = await (scanner as any).decodeDealContractEvent(rawLog, {
        address: dealAddr,
        contractType: 'deal_v1',
        deploymentBlock: 100n,
        metadata: {
          generation: 'legacy',
          buyerWallet: buyer,
          sellerWallet: seller,
        },
      });

      assert.equal(decoded.length, 1);
      assert.equal(decoded[0].event, 'payment_released');
      assert.equal(decoded[0].milestoneIndex, 1);
      assert.equal(decoded[0].amount, '2500000');
      assert.equal(decoded[0].recipientWallet.toLowerCase(), seller.toLowerCase());
    });

    it('missing generation metadata falls back to Synq ABI then Nexotiq ABI', async () => {
      const dealAddr = '0xcccc0000cccc0000cccc0000cccc0000cccc0000';
      const seller = '0xbbbb111122223333444455556666777788889999';
      const buyer = '0xaaaa111122223333444455556666777788889999';
      const scanner = createScanner();

      // 1. Synq DealFunded log with NO generation metadata
      const synqFundedTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'DealFunded',
        args: { dealAddress: dealAddr },
      });
      const synqFundedData = encodeAbiParameters(parseAbiParameters('uint256 totalEscrow'), [5000000n]);

      const synqLog: RawLog = {
        address: dealAddr,
        topics: synqFundedTopics as string[],
        data: synqFundedData,
        blockNumber: 160n,
        transactionHash: '0xtx_synq_funded',
        logIndex: 0,
      };

      const decodedSynq = await (scanner as any).decodeDealContractEvent(synqLog, {
        address: dealAddr,
        contractType: 'deal_v1',
        deploymentBlock: 100n,
        metadata: { buyerWallet: buyer, sellerWallet: seller }, // No generation!
      });

      assert.equal(decodedSynq.length, 1);
      assert.equal(decodedSynq[0].event, 'deal_confirmed');

      // 2. Nexotiq PaymentReleased log with NO generation metadata
      const nexotiqTopics = encodeEventTopics({
        abi: nexotiqDealABI,
        eventName: 'PaymentReleased',
        args: { milestoneId: 0n, to: seller },
      });
      const nexotiqData = encodeAbiParameters(parseAbiParameters('uint256 amount'), [1000000n]);

      const nexotiqLog: RawLog = {
        address: dealAddr,
        topics: nexotiqTopics as string[],
        data: nexotiqData,
        blockNumber: 165n,
        transactionHash: '0xtx_nexotiq_fallback',
        logIndex: 1,
      };

      const decodedNexotiq = await (scanner as any).decodeDealContractEvent(nexotiqLog, {
        address: dealAddr,
        contractType: 'deal_v1',
        deploymentBlock: 100n,
        metadata: { buyerWallet: buyer, sellerWallet: seller }, // No generation!
      });

      assert.equal(decodedNexotiq.length, 1);
      assert.equal(decodedNexotiq[0].event, 'payment_released');
    });

    it('ambiguous DealCompleted event signature correctly distinguishes Synq vs Nexotiq layout', async () => {
      const dealAddr = '0xdddd0000dddd0000dddd0000dddd0000dddd0000';
      const seller = '0xbbbb111122223333444455556666777788889999';
      const buyer = '0xaaaa111122223333444455556666777788889999';
      const scanner = createScanner();

      // 1. Synq DealCompleted emits: event DealCompleted(address indexed dealAddress)
      const synqTopics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'DealCompleted',
        args: { dealAddress: dealAddr },
      });

      const synqLog: RawLog = {
        address: dealAddr,
        topics: synqTopics as string[],
        data: '0x',
        blockNumber: 170n,
        transactionHash: '0xtx_synq_completed',
        logIndex: 0,
      };

      const decodedSynq = await (scanner as any).decodeDealContractEvent(synqLog, {
        address: dealAddr,
        contractType: 'deal_v2',
        deploymentBlock: 100n,
        metadata: { generation: 'v2', buyerWallet: buyer, sellerWallet: seller },
      });

      assert.equal(decodedSynq.length, 2); // buyer and seller notifications
      assert.equal(decodedSynq[0].event, 'deal_completed');
      assert.equal(decodedSynq[1].event, 'deal_completed_seller');

      // 2. Nexotiq DealCompleted emits: event DealCompleted(uint256 timestamp)
      const nexotiqTopics = encodeEventTopics({
        abi: nexotiqDealABI,
        eventName: 'DealCompleted',
      });
      const nexotiqData = encodeAbiParameters(parseAbiParameters('uint256 timestamp'), [1700000000n]);

      const nexotiqLog: RawLog = {
        address: dealAddr,
        topics: nexotiqTopics as string[],
        data: nexotiqData,
        blockNumber: 175n,
        transactionHash: '0xtx_nexotiq_completed',
        logIndex: 0,
      };

      const decodedNexotiq = await (scanner as any).decodeDealContractEvent(nexotiqLog, {
        address: dealAddr,
        contractType: 'deal_v1',
        deploymentBlock: 100n,
        metadata: { generation: 'legacy', buyerWallet: buyer, sellerWallet: seller },
      });

      assert.equal(decodedNexotiq.length, 2); // buyer and seller notifications
      assert.equal(decodedNexotiq[0].event, 'deal_completed');
      assert.equal(decodedNexotiq[1].event, 'deal_completed_seller');
    });

    it('scanner cold-start reloads tracked contracts with original generations preserved', async () => {
      // 1. Initial scanner instance rehydrates 3 accepted deals
      const v2Addr = '0x1111000000000000000000000000000000001111';
      const v1Addr = '0x2222000000000000000000000000000000002222';
      const legacyAddr = '0x3333000000000000000000000000000000003333';

      await proposalRepo.create({
        proposalId: 'prop-cold-v2',
        proposalNonce: '1',
        chainId,
        factoryAddress: v2Factory,
        clientWallet: '0xaaaa111122223333444455556666777788889999',
        freelancerWallet: '0xbbbb111122223333444455556666777788889999',
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x7E376b006Db7798165a6b8E6B191E20e791E4419',
        primaryResolver: '0xaaaa111122223333444455556666777788889999',
        emergencyResolver: '0xaaaa111122223333444455556666777788889999',
        milestonesHash: '0x123',
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x0',
        expiry: '9999999999',
        clientSignature: '0xsignature',
        title: 'V2',
        scope: 'Test',
        totalAmount: '1000',
        milestones: [],
        dealAddress: v2Addr,
        cachedStatus: 'ACCEPTED',
      } as any);

      await proposalRepo.create({
        proposalId: 'prop-cold-v1',
        proposalNonce: '2',
        chainId,
        factoryAddress: v1Factory,
        clientWallet: '0xaaaa111122223333444455556666777788889999',
        freelancerWallet: '0xbbbb111122223333444455556666777788889999',
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x2a3C8A880398FF6DD8e6F9976c8BE6C8aBef2435',
        primaryResolver: '0xaaaa111122223333444455556666777788889999',
        emergencyResolver: '0xaaaa111122223333444455556666777788889999',
        milestonesHash: '0x123',
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x0',
        expiry: '9999999999',
        clientSignature: '0xsignature',
        title: 'V1',
        scope: 'Test',
        totalAmount: '1000',
        milestones: [],
        dealAddress: v1Addr,
        cachedStatus: 'ACCEPTED',
      } as any);

      await proposalRepo.create({
        proposalId: 'prop-cold-legacy',
        proposalNonce: '3',
        chainId,
        factoryAddress: legacyFactory,
        clientWallet: '0xaaaa111122223333444455556666777788889999',
        freelancerWallet: '0xbbbb111122223333444455556666777788889999',
        canonicalUsdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        dealImplementation: '0x2a3C8A880398FF6DD8e6F9976c8BE6C8aBef2435',
        primaryResolver: '0xaaaa111122223333444455556666777788889999',
        emergencyResolver: '0xaaaa111122223333444455556666777788889999',
        milestonesHash: '0x123',
        isProtected: false,
        protectionModule: '0x0000000000000000000000000000000000000000',
        policyId: '0x0',
        expiry: '9999999999',
        clientSignature: '0xsignature',
        title: 'Legacy',
        scope: 'Test',
        totalAmount: '1000',
        milestones: [],
        dealAddress: legacyAddr,
        cachedStatus: 'ACCEPTED',
      } as any);

      const scanner1 = createScanner();
      await scanner1.rehydrateAcceptedDeals();

      // 2. Simulate serverless reboot: new registry with zero in-memory entries
      const freshRegistry = new DealContractRegistry();
      assert.equal(freshRegistry.getAllTrackedAddresses().length, 0);

      // Initialize cursor
      await cursorRepo.initializeIfMissing({
        chainId,
        scannerId,
        initialBlockNumber: 100n,
        initialBlockHash: rpcClient.blocks.get(100n)!.hash,
      });

      const scanner2 = new BlockchainScanner(
        chainId,
        scannerId,
        rpcClient,
        cursorRepo,
        freshRegistry,
        outboxRepo,
        notifRepo,
        5n,
        100n,
        trackedRepo,
        0n,
        proposalRepo,
        SUPPORTED_SEPOLIA_FACTORIES,
      );

      // scanNextBatch bootstraps factories and reloads all durable tracked contracts
      rpcClient.headBlock = 105n;
      await scanner2.scanNextBatch();

      // Verify all 3 contracts are present in fresh registry with correct contract types
      assert.ok(freshRegistry.isRegistered(v2Addr));
      assert.equal(freshRegistry.getContract(v2Addr)?.contractType, 'deal_v2');

      assert.ok(freshRegistry.isRegistered(v1Addr));
      assert.equal(freshRegistry.getContract(v1Addr)?.contractType, 'deal_v1');

      assert.ok(freshRegistry.isRegistered(legacyAddr));
      assert.equal(freshRegistry.getContract(legacyAddr)?.contractType, 'deal_v1');
    });
  });
});
