/**
 * Synq Autonomous Blockchain Scanner (B.12.3.3 / B.12.3.5)
 *
 * Server-side, bounded scanner for Sepolia deal events:
 * - Reads persistent cursor.
 * - Retrieves confirmed blocks using injected RPC client.
 * - Reloads tracked contracts from durable store across serverless restarts.
 * - Verifies block hash continuity and triggers reorg rollback when needed.
 * - Discovers deal clones dynamically from factory events (handling same-batch deployment).
 * - Decodes authoritative lifecycle events for V1 and V2 deals.
 * - Dispatches completion events to both buyer and seller.
 * - Distinguishes settlement payouts, refunds, and splits.
 * - Enqueues durable outbox events without pre-claiming delivery.
 */

import { parseEventLogs } from 'viem';
import { normalizeWallet } from '@/lib/utils';
import {
  synqFactoryV2ABI,
  nexotiqFactoryABI,
  synqDealV1ABI,
  nexotiqDealABI,
} from '@/lib/contracts/abis';
import { SYNQ_V2_SEPOLIA_CONFIG, CONTRACT_ADDRESSES } from '@/lib/contracts/addresses';
import sepoliaV2Deployment from '../../../deployments/sepolia-v2-standard.json';
import {
  type IChainCursorRepository,
  getChainCursorRepository,
  isZeroBlockHash,
} from './chain-sync-db';
import {
  type IDealOutboxRepository,
  getDealOutboxRepository,
  deriveOutboxEventId,
} from './outbox-db';
import {
  type INotificationsRepository,
  getNotificationsRepository,
  generateCanonicalDealEventKey,
} from './notifications-db';
import {
  type ITrackedContractsRepository,
  getTrackedContractsRepository,
} from './tracked-contracts-db';
import {
  type IDealReplayRepository,
  getDealReplayRepository,
} from './deal-replay-db';
import {
  DealContractRegistry,
  calculateScanRange,
  verifyBlockHashContinuity,
  calculateReorgRewindBlock,
  deriveCanonicalLogId,
  type RawLog,
  type TrackedContract,
  DEFAULT_CONFIRMATION_DEPTH,
  DEFAULT_MAX_BATCH_SIZE,
} from './chain-event-ingestion';
export type { RawLog };
import { getDealProposalByDealAddress, getDealProposalRepository, type IDealProposalRepository } from './proposals-db';

export interface SupportedFactoryConfig {
  address: string;
  contractType: 'factory';
  generation: 'v2' | 'v1' | 'legacy';
  deploymentBlock: bigint;
  deploymentTxHash?: string;
}

export const VERIFIED_SEPOLIA_COORDINATES = {
  chainId: 11155111,
  v2: {
    address: '0x9b7C5B529A420d015a85fD77040eF63b0e6cbdb0',
    deploymentBlock: 11833191n,
    deploymentTxHash: '0x5ef5707ffcff74fa83ba71bd07177429e84d02d2739f7601184825063d700841',
  },
  v1: {
    address: '0x7482c3439Aa6065066c7759b87eeD25a403CbB03',
    deploymentBlock: 11832783n,
    deploymentTxHash: '0x5f5cb3d115d0f8b159e0b0d249679b6f8cf8f507766deae109a4763e605b0330',
  },
  legacy: {
    address: '0x569146151D79B30087B27B6D3Df1FD16a846ae23',
    deploymentBlock: 11507082n,
    deploymentTxHash: '0x568ac0a917c4fa670ae8a60ed47ddf454920c5ea7eb1459a2efb4667978bcdc4',
  },
} as const;

export const SUPPORTED_SEPOLIA_FACTORIES: SupportedFactoryConfig[] = [
  {
    address: normalizeWallet(SYNQ_V2_SEPOLIA_CONFIG.factory),
    contractType: 'factory',
    generation: 'v2',
    deploymentBlock: VERIFIED_SEPOLIA_COORDINATES.v2.deploymentBlock,
    deploymentTxHash: VERIFIED_SEPOLIA_COORDINATES.v2.deploymentTxHash,
  },
  {
    address: normalizeWallet(sepoliaV2Deployment.contracts.supersededFactoryV1),
    contractType: 'factory',
    generation: 'v1',
    deploymentBlock: VERIFIED_SEPOLIA_COORDINATES.v1.deploymentBlock,
    deploymentTxHash: VERIFIED_SEPOLIA_COORDINATES.v1.deploymentTxHash,
  },
  {
    address: normalizeWallet(CONTRACT_ADDRESSES.sepolia.NexotiqFactory),
    contractType: 'factory',
    generation: 'legacy',
    deploymentBlock: VERIFIED_SEPOLIA_COORDINATES.legacy.deploymentBlock,
    deploymentTxHash: VERIFIED_SEPOLIA_COORDINATES.legacy.deploymentTxHash,
  },
];

export type ScannerScopeType = 'live_v1_v2' | 'v2_only' | 'legacy_nexotiq' | 'deal_backfill';

export interface ScannerScopeDefinition {
  scope: ScannerScopeType;
  scannerId: string;
  verifiedStartBlock: bigint;
  minAllowedBlock: bigint;
  maxAllowedBlock?: bigint;
  supportedGenerations: ('v2' | 'v1' | 'legacy')[];
  description: string;
}

export const SCANNER_SCOPES: Record<ScannerScopeType, ScannerScopeDefinition> = {
  live_v1_v2: {
    scope: 'live_v1_v2',
    scannerId: 'synq-sepolia-scanner-v1',
    verifiedStartBlock: VERIFIED_SEPOLIA_COORDINATES.v1.deploymentBlock, // 11832783n covers V1 and V2
    minAllowedBlock: VERIFIED_SEPOLIA_COORDINATES.v1.deploymentBlock,
    supportedGenerations: ['v1', 'v2'],
    description: 'V1/V2 active monitoring and event ingestion',
  },
  v2_only: {
    scope: 'v2_only',
    scannerId: 'synq-sepolia-v2-only',
    verifiedStartBlock: VERIFIED_SEPOLIA_COORDINATES.v2.deploymentBlock, // 11833191n
    minAllowedBlock: VERIFIED_SEPOLIA_COORDINATES.v2.deploymentBlock,
    supportedGenerations: ['v2'],
    description: 'Dedicated V2-only active monitoring (excludes V1 history)',
  },
  legacy_nexotiq: {
    scope: 'legacy_nexotiq',
    scannerId: 'synq-sepolia-legacy-v1',
    verifiedStartBlock: VERIFIED_SEPOLIA_COORDINATES.legacy.deploymentBlock, // 11507082n
    minAllowedBlock: VERIFIED_SEPOLIA_COORDINATES.legacy.deploymentBlock,
    maxAllowedBlock: VERIFIED_SEPOLIA_COORDINATES.v1.deploymentBlock - 1n, // 11832782n historical ceiling
    supportedGenerations: ['legacy'],
    description: 'Historical Legacy Nexotiq discovery and event recovery',
  },
  deal_backfill: {
    scope: 'deal_backfill',
    scannerId: 'synq-sepolia-deal-backfill',
    verifiedStartBlock: VERIFIED_SEPOLIA_COORDINATES.legacy.deploymentBlock, // Earliest supported deployment coordinate
    minAllowedBlock: VERIFIED_SEPOLIA_COORDINATES.legacy.deploymentBlock,
    supportedGenerations: ['v1', 'v2', 'legacy'],
    description: 'Targeted historical deal clone replay',
  },
};

export interface CursorValidationParams {
  cursor: {
    chainId: number;
    scannerId: string;
    lastBlockNumber: bigint;
    lastBlockHash: string;
    isBootstrap?: boolean;
  };
  expectedChainId: number;
  expectedScannerId: string;
  scope: ScannerScopeDefinition;
  configuredStartBlock?: bigint;
  requireHistoricalCoverage?: boolean;
}

export interface CursorValidationResult {
  valid: boolean;
  reason?: string;
  historicalCoverageEstablished?: boolean;
}

/**
 * Validates existing cursor consistency, scope boundaries, and continuity.
 * Rejects untrusted or inconsistent cursors without modifying them.
 */
export function validateScannerCursor(params: CursorValidationParams): CursorValidationResult {
  const { cursor, expectedChainId, expectedScannerId, scope, configuredStartBlock, requireHistoricalCoverage } = params;

  // 1. Chain ID validation
  if (cursor.chainId !== expectedChainId) {
    return {
      valid: false,
      reason: `Cursor chain ID mismatch: expected ${expectedChainId}, got ${cursor.chainId}`,
    };
  }

  // 2. Scanner identity validation
  if (cursor.scannerId.toLowerCase() !== expectedScannerId.toLowerCase()) {
    return {
      valid: false,
      reason: `Cursor scanner ID mismatch: expected ${expectedScannerId}, got ${cursor.scannerId}`,
    };
  }

  // 3. Starting coordinate & scope boundary validation
  const minValidAnchor = scope.minAllowedBlock - 1n;
  if (cursor.lastBlockNumber < minValidAnchor) {
    return {
      valid: false,
      reason: `Cursor block ${cursor.lastBlockNumber} is below minimum allowed coordinate ${minValidAnchor} for scope ${scope.scope}`,
    };
  }

  // Maximum allowed block for historical scope (if bounded)
  if (scope.maxAllowedBlock !== undefined && cursor.lastBlockNumber > scope.maxAllowedBlock) {
    return {
      valid: false,
      reason: `Cursor block ${cursor.lastBlockNumber} exceeds maximum historical ceiling ${scope.maxAllowedBlock} for scope ${scope.scope}`,
    };
  }

  // 4. Zero block hash check & malformed format (must not be zero, empty, or placeholder)
  if (
    !cursor.lastBlockHash ||
    isZeroBlockHash(cursor.lastBlockHash) ||
    cursor.lastBlockHash.length < 10 ||
    cursor.lastBlockHash === '0xinvalid_hash'
  ) {
    return {
      valid: false,
      reason: `Cursor block hash is zero or malformed: valid 32-byte hex hash required as proof of chain history`,
    };
  }

  // 5. Scope-specific start coordinate and V1/V2 combined scope enforcement
  if (scope.scope === 'live_v1_v2') {
    // A combined V1/V2 scope claims to cover V1 and V2 history. It must not start above V1 deployment block
    // which would silently skip V1 deployment and events (11832783..11833190).
    if (configuredStartBlock !== undefined && configuredStartBlock > VERIFIED_SEPOLIA_COORDINATES.v1.deploymentBlock) {
      return {
        valid: false,
        reason: `V2-only or truncated starting block (${configuredStartBlock}) rejected: scope 'live_v1_v2' claims combined V1 and V2 history. Combined scope must start at verified V1 deployment block ${VERIFIED_SEPOLIA_COORDINATES.v1.deploymentBlock} to prevent silently skipping V1 events. For V2 only, use dedicated 'v2_only' scope.`,
      };
    }

    // A bootstrap anchor for live_v1_v2 must be anchored at V1 deployment (11832782n or 11832783n).
    // If it is anchored at V2 deployment block (>= 11833190n), reject because V1 history is omitted.
    if (cursor.isBootstrap && cursor.lastBlockNumber >= VERIFIED_SEPOLIA_COORDINATES.v2.deploymentBlock - 1n) {
      return {
        valid: false,
        reason: `Bootstrap cursor block ${cursor.lastBlockNumber} reflects a V2-only start coordinate. Combined scope 'live_v1_v2' requires V1 deployment start coordinate (${VERIFIED_SEPOLIA_COORDINATES.v1.deploymentBlock}) to cover complete V1/V2 history without skipping V1 events.`,
      };
    }
  }

  // 6. Configured start block consistency (if provided)
  if (configuredStartBlock !== undefined) {
    const configuredAnchor = configuredStartBlock - 1n;
    if (cursor.isBootstrap && cursor.lastBlockNumber !== configuredAnchor && cursor.lastBlockNumber !== configuredStartBlock) {
      return {
        valid: false,
        reason: `Bootstrap cursor block ${cursor.lastBlockNumber} conflicts with configured SCANNER_START_BLOCK ${configuredStartBlock}`,
      };
    }
    if (!cursor.isBootstrap && cursor.lastBlockNumber < configuredAnchor) {
      return {
        valid: false,
        reason: `Active cursor block ${cursor.lastBlockNumber} precedes configured SCANNER_START_BLOCK anchor ${configuredAnchor}`,
      };
    }
  }

  // 7. Historical coverage trust validation (fail closed for unknown historical coverage)
  // An existing cursor at lastBlockNumber proves head progress but does not prove contiguous coverage
  // from scope.verifiedStartBlock if historical range logs are missing.
  if (requireHistoricalCoverage) {
    if (cursor.isBootstrap) {
      return {
        valid: false,
        historicalCoverageEstablished: false,
        reason: `Bootstrap anchor at block ${cursor.lastBlockNumber} has not yet scanned historical range [${scope.verifiedStartBlock}...]`,
      };
    }
    return {
      valid: false,
      historicalCoverageEstablished: false,
      reason: `Unknown historical coverage: persisted cursor tracks block ${cursor.lastBlockNumber} but does not prove contiguous event scanning from verified scope start ${scope.verifiedStartBlock}. Coverage audit fails closed.`,
    };
  }

  return {
    valid: true,
    historicalCoverageEstablished: false,
  };
}

export interface FactoryResolutionResult {
  supported: boolean;
  generation?: 'v2' | 'v1' | 'legacy';
  contractType?: 'deal_v2' | 'deal_v1';
  factoryAddress?: string;
  reason?: string;
}

/**
 * Resolves the authoritative contract generation and deal contract type from a factory address.
 * Fails closed if the factory is unknown, unsupported, or invalid.
 */
export function resolveFactoryGeneration(
  factoryAddress?: string | null,
  factories: SupportedFactoryConfig[] = SUPPORTED_SEPOLIA_FACTORIES,
): FactoryResolutionResult {
  if (!factoryAddress || !/^0x[0-9a-fA-F]{40}$/.test(factoryAddress)) {
    return {
      supported: false,
      reason: `Invalid or missing factory address: ${factoryAddress ?? 'null'}`,
    };
  }

  const normFactory = normalizeWallet(factoryAddress);
  const matched = factories.find((f) => normalizeWallet(f.address) === normFactory);

  if (!matched) {
    return {
      supported: false,
      reason: `Unrecognized or unsupported factory address: ${normFactory}`,
    };
  }

  return {
    supported: true,
    generation: matched.generation,
    contractType: matched.generation === 'v2' ? 'deal_v2' : 'deal_v1',
    factoryAddress: normFactory,
  };
}

export interface IScannerRpcClient {
  getBlockNumber(): Promise<bigint>;
  getBlock(params: { blockNumber: bigint }): Promise<{
    hash: string;
    parentHash: string;
  }>;
  getLogs(params: {
    address?: string | string[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RawLog[]>;
  getTransactionReceipt?(params: { hash: `0x${string}` | string }): Promise<any>;
}

/**
 * Verifies that a transaction receipt establishes the creation or verified activity of a deal contract.
 * Fails closed if receipt is reverted, has no logs, or does not emit event evidence for the target deal.
 */
export function verifyReceiptEstablishesDeal(
  receipt: any,
  targetDealAddress: string,
  resolution: FactoryResolutionResult,
): boolean {
  if (!receipt || !Array.isArray(receipt.logs) || receipt.logs.length === 0) {
    return false;
  }
  if (receipt.status === 'reverted' || receipt.status === 0 || receipt.status === 0n) {
    return false;
  }
  const normTarget = normalizeWallet(targetDealAddress);
  const normFactory = resolution.factoryAddress ? normalizeWallet(resolution.factoryAddress) : '';

  const cleanHexTarget = normTarget.slice(2).toLowerCase();
  const paddedTarget = `0x000000000000000000000000${cleanHexTarget}`;

  for (const log of receipt.logs) {
    const logAddr = normalizeWallet(log.address || '');

    // 1. Direct log emitted by the target deal contract
    if (logAddr === normTarget) {
      return true;
    }

    // 2. Factory log matching the canonical factory address
    if (normFactory && logAddr === normFactory) {
      // Check indexed topics for the target address
      if (Array.isArray(log.topics)) {
        for (const topic of log.topics) {
          if (typeof topic === 'string' && topic.toLowerCase() === paddedTarget) {
            return true;
          }
        }
      }
      // Check non-indexed data (e.g. DealProposalAccepted has unindexed address dealAddress)
      if (typeof log.data === 'string' && log.data.toLowerCase().includes(cleanHexTarget)) {
        return true;
      }
    }
  }

  return false;
}

export interface DecodedDealEvent {
  chainId: number;
  contractAddress: string;
  transactionHash: string;
  blockNumber: bigint;
  logIndex: number;
  event: string;
  milestoneIndex?: number;
  submissionVersion?: number;
  buyerWallet?: string;
  sellerWallet?: string;
  recipientWallet: string;
  recipientRole: 'buyer' | 'seller';
  amount?: string;
  title?: string;
}

export interface ScanBatchResult {
  scanned: boolean;
  fromBlock?: bigint;
  toBlock?: bigint;
  logsFound: number;
  eventsProcessed: number;
  newContractsDiscovered: string[];
  reorgDetected: boolean;
  rewoundToBlock?: bigint;
  cursorAdvanced: boolean;
  reason?: string;
}

export class BlockchainScanner {
  constructor(
    private chainId: number,
    private scannerId: string,
    private rpcClient: IScannerRpcClient,
    private cursorRepo: IChainCursorRepository = getChainCursorRepository(),
    private registry: DealContractRegistry,
    private outboxRepo: IDealOutboxRepository = getDealOutboxRepository(),
    private notifRepo: INotificationsRepository = getNotificationsRepository(),
    private confirmationDepth: bigint = DEFAULT_CONFIRMATION_DEPTH,
    private maxBatchSize: bigint = DEFAULT_MAX_BATCH_SIZE,
    private trackedContractsRepo: ITrackedContractsRepository = getTrackedContractsRepository(),
    private minAllowedBlock: bigint = 0n,
    private proposalRepo: IDealProposalRepository = getDealProposalRepository(),
    private supportedFactories: SupportedFactoryConfig[] = SUPPORTED_SEPOLIA_FACTORIES,
    private replayRepo: IDealReplayRepository = getDealReplayRepository(),
  ) {}

  /**
   * Idempotently seeds supported factory addresses into registry and durable tracking.
   * Fails closed if factory configuration address is missing or invalid.
   */
  async bootstrapFactories(): Promise<void> {
    if (this.chainId === 11155111) {
      for (const f of this.supportedFactories) {
        if (!f.address || !/^0x[0-9a-fA-F]{40}$/.test(f.address)) {
          throw new Error(`Invalid factory configuration address: ${f.address}`);
        }
        this.registry.registerContract({
          address: f.address,
          contractType: 'factory',
          deploymentBlock: f.deploymentBlock ?? 0n,
          metadata: { generation: f.generation },
        });
        await this.trackedContractsRepo.upsert({
          chainId: this.chainId,
          contractAddress: f.address,
          contractType: 'factory',
          deploymentBlock: f.deploymentBlock ?? 0n,
          metadata: { generation: f.generation },
        });
      }
    }
  }

  /**
   * Rehydrates accepted deal contracts from trusted PostgreSQL deal_proposals records.
   * Resolves authoritative factory generation (V2 vs V1 vs Legacy Nexotiq) and fails closed on unknown factories.
   * Ensures active accepted deals are tracked even on cold start with an empty tracked_deal_contracts table.
   * Does NOT alter proposal business status when tracking is skipped.
   */
  async rehydrateAcceptedDeals(): Promise<number> {
    let rehydratedCount = 0;
    try {
      const acceptedDeals = (await this.proposalRepo.getAcceptedDeals?.(this.chainId)) || [];
      for (const deal of acceptedDeals) {
        try {
          if (!deal.dealAddress || !/^0x[0-9a-fA-F]{40}$/.test(deal.dealAddress)) {
            console.warn(`[rehydrateAcceptedDeals] Skipping proposal ${deal.proposalId}: invalid or missing dealAddress`);
            continue;
          }
          const normAddr = normalizeWallet(deal.dealAddress);

          if (this.registry.isRegistered(normAddr)) {
            continue;
          }

          if (!deal.factoryAddress || !/^0x[0-9a-fA-F]{40}$/.test(deal.factoryAddress)) {
            console.warn(
              `[rehydrateAcceptedDeals] Skipping proposal ${deal.proposalId} (${normAddr}): missing or invalid factoryAddress`
            );
            continue;
          }

          const resolution = resolveFactoryGeneration(deal.factoryAddress, this.supportedFactories);
          if (!resolution.supported || !resolution.contractType || !resolution.generation) {
            console.warn(
              `[rehydrateAcceptedDeals] Skipping proposal ${deal.proposalId} (${normAddr}): ${resolution.reason || 'unsupported factory'}`
            );
            // Fail closed: do not change proposal status, do not silently default to deal_v2
            continue;
          }

          const existingTracked = await this.trackedContractsRepo.get(this.chainId, normAddr);
          const rawDeployment = (deal as any).deploymentBlock ?? (deal as any).metadata?.deploymentBlock ?? existingTracked?.deploymentBlock;
          let creationBlock = rawDeployment !== undefined && BigInt(rawDeployment) > 0n ? BigInt(rawDeployment) : 0n;

          // Attempt verified receipt recovery if creationBlock is missing but acceptedTxHash is available
          if (creationBlock === 0n && deal.acceptedTxHash && this.rpcClient.getTransactionReceipt) {
            try {
              const receipt = await this.rpcClient.getTransactionReceipt({ hash: deal.acceptedTxHash });
              if (
                receipt &&
                receipt.blockNumber &&
                receipt.status !== 'reverted' &&
                receipt.status !== 0 &&
                receipt.status !== 0n
              ) {
                const verifiedBlock = BigInt(receipt.blockNumber);
                const isCreationVerified = verifyReceiptEstablishesDeal(receipt, normAddr, resolution);
                if (isCreationVerified && verifiedBlock > 0n) {
                  creationBlock = verifiedBlock;
                  // Persist back to proposal repository if supported
                  if (this.proposalRepo.updateStatus) {
                    await this.proposalRepo.updateStatus(deal.proposalId, 'ACCEPTED', {
                      deploymentBlock: verifiedBlock.toString(),
                    });
                  }
                }
              }
            } catch (receiptErr: any) {
              console.warn(
                `[rehydrateAcceptedDeals] Error resolving receipt for proposal ${deal.proposalId}: ${receiptErr?.message || receiptErr}`
              );
            }
          }

          const isUnresolved = creationBlock === 0n;
          if (isUnresolved) {
            console.warn(
              `[rehydrateAcceptedDeals] Proposal ${deal.proposalId} (${normAddr}) deployment block is unresolved; historical replay job cannot be scheduled safely without verified block coordinate.`
            );
          }

          this.registry.registerContract({
            address: normAddr,
            contractType: resolution.contractType,
            deploymentBlock: creationBlock,
            metadata: {
              buyerWallet: normalizeWallet(deal.clientWallet),
              sellerWallet: normalizeWallet(deal.freelancerWallet),
              factoryAddress: resolution.factoryAddress,
              generation: resolution.generation,
              proposalId: deal.proposalId,
              rehydratedFromProposal: true,
              ...(isUnresolved ? { deploymentBlockUnresolved: true } : {}),
            },
          });

          await this.trackedContractsRepo.upsert({
            chainId: this.chainId,
            contractAddress: normAddr,
            contractType: resolution.contractType,
            factoryAddress: resolution.factoryAddress,
            deploymentBlock: creationBlock,
            buyerWallet: normalizeWallet(deal.clientWallet),
            sellerWallet: normalizeWallet(deal.freelancerWallet),
            metadata: {
              generation: resolution.generation,
              proposalId: deal.proposalId,
              rehydratedFromProposal: true,
              ...(isUnresolved ? { deploymentBlockUnresolved: true } : {}),
            },
          });

          // Check if replay eligibility exists behind an advanced cursor
          if (creationBlock > 0n) {
            const cursor = await this.cursorRepo.get(this.chainId, this.scannerId);
            if (cursor && creationBlock < cursor.lastBlockNumber) {
              await this.replayRepo.createJob({
                chainId: this.chainId,
                contractAddress: normAddr,
                contractType: resolution.contractType,
                generation: resolution.generation,
                fromBlock: creationBlock,
                toBlock: cursor.lastBlockNumber,
              });
            }
          }
          rehydratedCount++;
        } catch (itemErr: any) {
          // A malformed proposal or upsert failure must not prevent other proposals from being rehydrated
          console.warn(
            `[rehydrateAcceptedDeals] Error processing proposal ${deal.proposalId}: ${itemErr?.message || itemErr}`
          );
        }
      }
    } catch (err: any) {
      console.warn(`[rehydrateAcceptedDeals] Failed to load accepted deals: ${err?.message || err}`);
    }
    return rehydratedCount;
  }

  /**
   * Atomically initializes missing cursor using an anchor block coordinate (startBlock - 1n)
   * to ensure startBlock is scanned inclusively.
   * Never silently overwrites or resets an existing cursor.
   * Re-reads and returns the persisted cursor.
   */
  async initializeCursorIfMissing(params: {
    startBlock: bigint;
  }): Promise<import('./chain-sync-db').ChainSyncCursor> {
    const existing = await this.cursorRepo.get(this.chainId, this.scannerId);
    if (existing) {
      return existing;
    }

    if (params.startBlock < this.minAllowedBlock) {
      throw new Error(
        `Invalid start block ${params.startBlock}: strictly lower than minAllowedBlock ${this.minAllowedBlock}`,
      );
    }

    const anchorBlockNumber = params.startBlock - 1n;
    const startBlockInfo = await this.rpcClient.getBlock({ blockNumber: params.startBlock });
    const anchorBlockHash = startBlockInfo.parentHash;

    if (!anchorBlockHash || isZeroBlockHash(anchorBlockHash)) {
      throw new Error(
        `Invalid or zero parent block hash retrieved for block ${params.startBlock}: ${anchorBlockHash}`,
      );
    }

    return this.cursorRepo.initializeIfMissing({
      chainId: this.chainId,
      scannerId: this.scannerId,
      initialBlockNumber: anchorBlockNumber,
      initialBlockHash: anchorBlockHash,
      isBootstrap: true,
    });
  }

  /**
   * Executes a single bounded scan batch.
   * Returns deterministic status without running an infinite background loop.
   */
  async scanNextBatch(): Promise<ScanBatchResult> {
    const cursor = await this.cursorRepo.get(this.chainId, this.scannerId);
    if (!cursor) {
      return {
        scanned: false,
        logsFound: 0,
        eventsProcessed: 0,
        newContractsDiscovered: [],
        reorgDetected: false,
        cursorAdvanced: false,
        reason: `Cursor not initialized for chain ${this.chainId} and scanner ${this.scannerId}`,
      };
    }

    // 0. Ensure supported factories are seeded, accepted deals rehydrated, and reload durable tracked contracts for cold-start serverless resilience
    await this.bootstrapFactories();
    await this.rehydrateAcceptedDeals();
    const persisted = await this.trackedContractsRepo.getAll(this.chainId);
    for (const c of persisted) {
      this.registry.registerContract({
        address: c.contractAddress,
        contractType: c.contractType,
        deploymentBlock: c.deploymentBlock,
        metadata: {
          buyerWallet: c.buyerWallet,
          sellerWallet: c.sellerWallet,
          factoryAddress: c.factoryAddress,
          ...c.metadata,
        },
      });
    }

    const latestHead = await this.rpcClient.getBlockNumber();
    const range = calculateScanRange({
      currentCursorBlock: cursor.lastBlockNumber,
      latestHeadBlock: latestHead,
      confirmationDepth: this.confirmationDepth,
      maxBatchSize: this.maxBatchSize,
    });

    if (!range.shouldScan || range.fromBlock === undefined || range.toBlock === undefined) {
      return {
        scanned: false,
        logsFound: 0,
        eventsProcessed: 0,
        newContractsDiscovered: [],
        reorgDetected: false,
        cursorAdvanced: false,
        reason: range.reason || 'No confirmed blocks available to scan',
      };
    }

    const fromBlock = range.fromBlock;
    const toBlock = range.toBlock;

    // 1. Verify parent block hash continuity
    const firstBlock = await this.rpcClient.getBlock({ blockNumber: fromBlock });
    const isContinuous = verifyBlockHashContinuity({
      expectedParentHash: cursor.lastBlockHash,
      actualParentHash: firstBlock.parentHash,
    });

    if (!isContinuous) {
      // Reorg detected! Roll back cursor and delete orphaned tracked contracts
      const rewindTarget = calculateReorgRewindBlock({
        currentCursorBlock: cursor.lastBlockNumber,
        minAllowedBlock: this.minAllowedBlock,
      });
      const rollbackBlockInfo = await this.rpcClient.getBlock({ blockNumber: rewindTarget });
      await this.cursorRepo.rewind({
        chainId: this.chainId,
        scannerId: this.scannerId,
        expectedLastBlockNumber: cursor.lastBlockNumber,
        targetBlockNumber: rewindTarget,
        targetBlockHash: rollbackBlockInfo.hash,
      });

      // Purge tracked contracts discovered on the orphaned branch (never factories)
      await this.trackedContractsRepo.deleteOrphanedAboveBlock(this.chainId, rewindTarget);

      // Invalidate pending/processing on-chain outbox items discovered above rewindTarget
      await this.outboxRepo.invalidateOrphanedEvents(this.chainId, rewindTarget);

      return {
        scanned: false,
        logsFound: 0,
        eventsProcessed: 0,
        newContractsDiscovered: [],
        reorgDetected: true,
        rewoundToBlock: rewindTarget,
        cursorAdvanced: false,
        reason: `Reorg detected at block ${fromBlock}. Rewound cursor to ${rewindTarget}.`,
      };
    }

    // 2. Query logs across all currently tracked contracts
    const trackedAddresses = this.registry.getAllTrackedAddresses();
    if (trackedAddresses.length === 0) {
      // Advance cursor through empty range
      const endBlock = await this.rpcClient.getBlock({ blockNumber: toBlock });
      await this.cursorRepo.advance({
        chainId: this.chainId,
        scannerId: this.scannerId,
        expectedLastBlockNumber: cursor.lastBlockNumber,
        newBlockNumber: toBlock,
        newBlockHash: endBlock.hash,
      });

      return {
        scanned: true,
        fromBlock,
        toBlock,
        logsFound: 0,
        eventsProcessed: 0,
        newContractsDiscovered: [],
        reorgDetected: false,
        cursorAdvanced: true,
      };
    }

    const rawLogs = await this.rpcClient.getLogs({
      address: trackedAddresses,
      fromBlock,
      toBlock,
    });

    // 3. Discover newly deployed deal clones from factory events in the batch
    const newContracts: { address: string; deploymentBlock: bigint }[] = [];

    for (const log of rawLogs) {
      const logAddress = normalizeWallet(log.address);
      const contractInfo = this.registry.getContract(logAddress);
      if (!contractInfo || contractInfo.contractType !== 'factory') continue;

      const factoryClone = this.decodeFactoryEvent(log);
      if (factoryClone) {
        const existingContract = this.registry.getContract(factoryClone.dealAddress);
        const effectiveDeploymentBlock = existingContract && existingContract.deploymentBlock > 0n && existingContract.deploymentBlock < log.blockNumber
          ? existingContract.deploymentBlock
          : log.blockNumber;

        const discovered = this.registry.discoverDealClone({
          factoryAddress: logAddress,
          dealAddress: factoryClone.dealAddress,
          deploymentBlock: effectiveDeploymentBlock,
          contractType: factoryClone.contractType,
        });

        discovered.metadata = {
          ...discovered.metadata,
          buyerWallet: factoryClone.buyerWallet,
          sellerWallet: factoryClone.sellerWallet,
          generation: factoryClone.generation,
        };
        this.registry.registerContract(discovered);

        // Persist discovered clone in durable storage before cursor advancement
        await this.trackedContractsRepo.upsert({
          chainId: this.chainId,
          contractAddress: discovered.address,
          contractType: discovered.contractType,
          factoryAddress: logAddress,
          deploymentBlock: effectiveDeploymentBlock,
          discoveryTxHash: log.transactionHash,
          discoveryLogIndex: log.logIndex,
          buyerWallet: factoryClone.buyerWallet,
          sellerWallet: factoryClone.sellerWallet,
          metadata: {
            generation: factoryClone.generation,
          },
        });

        newContracts.push({
          address: discovered.address,
          deploymentBlock: effectiveDeploymentBlock,
        });
      }
    }

    // 4. Query lifecycle logs for newly discovered contracts across [deploymentBlock, toBlock]
    let secondaryLogs: RawLog[] = [];
    if (newContracts.length > 0) {
      const newCloneAddresses = newContracts.map((c) => c.address);
      const minDeploymentBlock = newContracts.reduce(
        (min, c) => (c.deploymentBlock < min ? c.deploymentBlock : min),
        toBlock,
      );

      try {
        secondaryLogs = await this.rpcClient.getLogs({
          address: newCloneAddresses,
          fromBlock: minDeploymentBlock,
          toBlock,
        });
      } catch (err: any) {
        // Abort without cursor advancement if secondary log retrieval fails
        return {
          scanned: false,
          fromBlock,
          toBlock,
          logsFound: rawLogs.length,
          eventsProcessed: 0,
          newContractsDiscovered: newContracts.map((c) => c.address),
          reorgDetected: false,
          cursorAdvanced: false,
          reason: `Secondary log retrieval failed for newly discovered contracts: ${err?.message || err}`,
        };
      }
    }

    // 5. Merge and deduplicate all logs deterministically
    const allLogs = [...rawLogs, ...secondaryLogs];
    const seenLogIds = new Set<string>();
    const deduplicatedLogs: RawLog[] = [];

    for (const log of allLogs) {
      const logId = deriveCanonicalLogId({
        chainId: this.chainId,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      });

      if (seenLogIds.has(logId)) continue;
      seenLogIds.add(logId);
      deduplicatedLogs.push(log);
    }

    // Deterministic blockchain ordering: block number ascending, then logIndex ascending
    deduplicatedLogs.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber < b.blockNumber ? -1 : 1;
      }
      return a.logIndex - b.logIndex;
    });

    // 6. Process lifecycle events on deduplicated, ordered logs
    const decodedEvents: DecodedDealEvent[] = [];
    const seenSettlementsInTx = new Set<string>();

    for (const log of deduplicatedLogs) {
      const logAddress = normalizeWallet(log.address);
      const contractInfo = this.registry.getContract(logAddress);
      if (!contractInfo) continue;

      if (contractInfo.contractType === 'factory') {
        // Factory events handled during discovery; do not process as deal lifecycle events
        continue;
      }

      const decodedList = await this.decodeDealContractEvent(log, contractInfo);
      for (const decoded of decodedList) {
        if (decoded.event === 'payment_released') {
          const settlementKey = `${decoded.transactionHash}:${decoded.milestoneIndex ?? 0}`;
          if (seenSettlementsInTx.has(settlementKey)) {
            continue;
          }
          seenSettlementsInTx.add(settlementKey);
        }

        decodedEvents.push(decoded);
      }
    }

    // 7. Persist all required event records before advancing the cursor
    for (const event of decodedEvents) {
      await this.persistDecodedEvent(event);
    }

    // 8. Check if any newly discovered contract was deployed before fromBlock and needs retroactive replay
    for (const contract of newContracts) {
      const replay = this.registry.checkReplayRequirement(contract.address, fromBlock);
      if (replay.shouldReplay && replay.deploymentBlock !== undefined) {
        const trackedInfo = this.registry.getContract(contract.address);
        // Durably schedule replay job
        await this.replayRepo.createJob({
          chainId: this.chainId,
          contractAddress: contract.address,
          contractType: (trackedInfo?.contractType as any) || 'deal_v2',
          generation: (trackedInfo?.metadata?.generation as any) || 'v2',
          fromBlock: replay.deploymentBlock,
          toBlock: fromBlock - 1n,
        });

        await this.replayContractLogs(contract.address, replay.deploymentBlock, fromBlock - 1n);
      }
    }

    // 9. Atomically advance cursor to toBlock
    const endBlock = await this.rpcClient.getBlock({ blockNumber: toBlock });
    const advanceResult = await this.cursorRepo.advance({
      chainId: this.chainId,
      scannerId: this.scannerId,
      expectedLastBlockNumber: cursor.lastBlockNumber,
      newBlockNumber: toBlock,
      newBlockHash: endBlock.hash,
    });

    return {
      scanned: true,
      fromBlock,
      toBlock,
      logsFound: deduplicatedLogs.length,
      eventsProcessed: decodedEvents.length,
      newContractsDiscovered: newContracts.map((c) => c.address),
      reorgDetected: false,
      cursorAdvanced: advanceResult.status === 'advanced',
    };
  }

  /**
   * Replays logs for a specific newly discovered contract between deployment block and current scan.
   */
  private async replayContractLogs(
    contractAddress: string,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<void> {
    if (fromBlock > toBlock) return;

    const contractInfo = this.registry.getContract(contractAddress);
    if (!contractInfo) return;

    const replayLogs = await this.rpcClient.getLogs({
      address: contractAddress,
      fromBlock,
      toBlock,
    });

    for (const log of replayLogs) {
      const decodedList = await this.decodeDealContractEvent(log, contractInfo);
      for (const decoded of decodedList) {
        await this.persistDecodedEvent(decoded);
      }
    }
  }

  /**
   * Decodes factory events to discover newly cloned deal contracts.
   */
  private decodeFactoryEvent(log: RawLog): {
    dealAddress: string;
    buyerWallet: string;
    sellerWallet: string;
    totalEscrow?: string;
    contractType: 'deal_v1' | 'deal_v2';
    generation: 'v2' | 'v1' | 'legacy';
  } | null {
    const factoryResolution = resolveFactoryGeneration(log.address, this.supportedFactories);
    const generation: 'v2' | 'v1' | 'legacy' = factoryResolution.supported && factoryResolution.generation
      ? factoryResolution.generation
      : 'v2';
    const contractType: 'deal_v1' | 'deal_v2' = factoryResolution.supported && factoryResolution.contractType
      ? factoryResolution.contractType
      : (generation === 'v2' ? 'deal_v2' : 'deal_v1');

    // 1. Try SynqFactory (V2/V1) DealCreated
    try {
      const parsedV2 = parseEventLogs({
        abi: synqFactoryV2ABI,
        logs: [log as any],
      }) as any[];
      if (parsedV2.length > 0 && parsedV2[0].eventName === 'DealCreated') {
        const args = (parsedV2[0] as any).args;
        return {
          dealAddress: normalizeWallet(args.dealAddress),
          buyerWallet: normalizeWallet(args.client),
          sellerWallet: normalizeWallet(args.freelancer),
          totalEscrow: args.totalEscrow ? args.totalEscrow.toString() : undefined,
          contractType,
          generation,
        };
      }
    } catch {}

    // 2. Try NexotiqFactory DealCreated
    try {
      const parsedNexotiq = parseEventLogs({
        abi: nexotiqFactoryABI,
        logs: [log as any],
      }) as any[];
      if (parsedNexotiq.length > 0 && parsedNexotiq[0].eventName === 'DealCreated') {
        const args = (parsedNexotiq[0] as any).args;
        return {
          dealAddress: normalizeWallet(args.dealAddress),
          buyerWallet: normalizeWallet(args.buyer),
          sellerWallet: normalizeWallet(args.seller),
          totalEscrow: args.value ? args.value.toString() : undefined,
          contractType: 'deal_v1',
          generation: 'legacy',
        };
      }
    } catch {}

    return null;
  }

  /**
   * Decodes deal contract logs for V1 or V2 contracts.
   * Respects contract generation (V2 vs V1 vs Legacy Nexotiq) to ensure distinct ABI handling.
   * Returns array of DecodedDealEvent (supporting multi-party notifications like DealCompleted).
   */
  private async decodeDealContractEvent(
    log: RawLog,
    contractInfo: TrackedContract,
  ): Promise<DecodedDealEvent[]> {
    const contractAddr = normalizeWallet(log.address);
    const generation = contractInfo.metadata?.generation as 'v2' | 'v1' | 'legacy' | undefined;

    // Resolve buyer and seller
    let buyer = (contractInfo.metadata?.buyerWallet as string) || '';
    let seller = (contractInfo.metadata?.sellerWallet as string) || '';

    if (!buyer || !seller) {
      const proposal = await getDealProposalByDealAddress(contractAddr);
      if (proposal) {
        buyer = normalizeWallet(proposal.clientWallet);
        seller = normalizeWallet(proposal.freelancerWallet);
      }
    }

    return decodeDealContractLog({
      chainId: this.chainId,
      log,
      generation,
      contractType: contractInfo.contractType as any,
      buyerWallet: buyer,
      sellerWallet: seller,
    });
  }

  private decodeSynqDealEvent(
    item: any,
    log: RawLog,
    contractAddr: string,
    buyer: string,
    seller: string,
  ): DecodedDealEvent[] {
    const args = item.args;

    if (item.eventName === 'DealFunded') {
      return [
        {
          chainId: this.chainId,
          contractAddress: contractAddr,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          event: 'deal_confirmed',
          buyerWallet: buyer,
          sellerWallet: seller,
          recipientWallet: seller,
          recipientRole: 'seller',
          amount: args.totalEscrow ? args.totalEscrow.toString() : undefined,
        },
      ];
    }

    if (item.eventName === 'MilestoneSubmitted') {
      const version = args.version !== undefined ? Number(args.version) : undefined;
      return [
        {
          chainId: this.chainId,
          contractAddress: contractAddr,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          event: 'work_submitted',
          milestoneIndex: Number(args.milestoneId),
          submissionVersion: version,
          buyerWallet: buyer,
          sellerWallet: seller,
          recipientWallet: buyer,
          recipientRole: 'buyer',
        },
      ];
    }

    if (item.eventName === 'MilestoneSettled') {
      const paid = BigInt(args.paidToFreelancer || 0);
      const refunded = BigInt(args.refundedToClient || 0);
      const events: DecodedDealEvent[] = [];

      if (paid > 0n) {
        events.push({
          chainId: this.chainId,
          contractAddress: contractAddr,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          event: 'payment_released',
          milestoneIndex: Number(args.milestoneId),
          buyerWallet: buyer,
          sellerWallet: seller,
          recipientWallet: seller,
          recipientRole: 'seller',
          amount: paid.toString(),
        });
      }

      if (refunded > 0n) {
        events.push({
          chainId: this.chainId,
          contractAddress: contractAddr,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          event: 'milestone_refunded',
          milestoneIndex: Number(args.milestoneId),
          buyerWallet: buyer,
          sellerWallet: seller,
          recipientWallet: buyer,
          recipientRole: 'buyer',
          amount: refunded.toString(),
        });
      }

      return events;
    }

    if (item.eventName === 'DealCompleted') {
      const events: DecodedDealEvent[] = [
        {
          chainId: this.chainId,
          contractAddress: contractAddr,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          event: 'deal_completed',
          buyerWallet: buyer,
          sellerWallet: seller,
          recipientWallet: buyer,
          recipientRole: 'buyer',
        },
      ];

      if (seller && seller.toLowerCase() !== buyer.toLowerCase()) {
        events.push({
          chainId: this.chainId,
          contractAddress: contractAddr,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          event: 'deal_completed_seller',
          buyerWallet: buyer,
          sellerWallet: seller,
          recipientWallet: seller,
          recipientRole: 'seller',
        });
      }

      return events;
    }

    if (item.eventName === 'DealCancelled') {
      const events: DecodedDealEvent[] = [
        {
          chainId: this.chainId,
          contractAddress: contractAddr,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          event: 'deal_cancelled',
          buyerWallet: buyer,
          sellerWallet: seller,
          recipientWallet: seller,
          recipientRole: 'seller',
        },
      ];

      if (buyer && buyer.toLowerCase() !== seller.toLowerCase()) {
        events.push({
          chainId: this.chainId,
          contractAddress: contractAddr,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          event: 'deal_cancelled',
          buyerWallet: buyer,
          sellerWallet: seller,
          recipientWallet: buyer,
          recipientRole: 'buyer',
        });
      }

      return events;
    }

    if (item.eventName === 'MilestoneDisputed') {
      const opener = normalizeWallet(args.opener || '');
      const recipient = opener === buyer ? seller : buyer;
      const role = opener === buyer ? 'seller' : 'buyer';
      return [
        {
          chainId: this.chainId,
          contractAddress: contractAddr,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          event: 'milestone_disputed',
          milestoneIndex: Number(args.milestoneId),
          buyerWallet: buyer,
          sellerWallet: seller,
          recipientWallet: recipient,
          recipientRole: role,
        },
      ];
    }

    return [];
  }

  private decodeNexotiqEvent(
    item: any,
    log: RawLog,
    contractAddr: string,
    buyer: string,
    seller: string,
  ): DecodedDealEvent[] {
    const args = item.args;

    if (item.eventName === 'PaymentReleased') {
      const toWallet = args.to ? normalizeWallet(args.to) : seller;
      return [
        {
          chainId: this.chainId,
          contractAddress: contractAddr,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          event: 'payment_released',
          milestoneIndex: Number(args.milestoneId),
          buyerWallet: buyer,
          sellerWallet: seller,
          recipientWallet: toWallet,
          recipientRole: 'seller',
          amount: args.amount ? args.amount.toString() : undefined,
        },
      ];
    }

    if (item.eventName === 'DealCompleted') {
      const events: DecodedDealEvent[] = [
        {
          chainId: this.chainId,
          contractAddress: contractAddr,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          event: 'deal_completed',
          buyerWallet: buyer,
          sellerWallet: seller,
          recipientWallet: buyer,
          recipientRole: 'buyer',
        },
      ];
      if (seller && seller.toLowerCase() !== buyer.toLowerCase()) {
        events.push({
          chainId: this.chainId,
          contractAddress: contractAddr,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          event: 'deal_completed_seller',
          buyerWallet: buyer,
          sellerWallet: seller,
          recipientWallet: seller,
          recipientRole: 'seller',
        });
      }
      return events;
    }

    if (item.eventName === 'DealCancelled') {
      const events: DecodedDealEvent[] = [
        {
          chainId: this.chainId,
          contractAddress: contractAddr,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          event: 'deal_cancelled',
          buyerWallet: buyer,
          sellerWallet: seller,
          recipientWallet: seller,
          recipientRole: 'seller',
        },
      ];
      if (buyer && buyer.toLowerCase() !== seller.toLowerCase()) {
        events.push({
          chainId: this.chainId,
          contractAddress: contractAddr,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          event: 'deal_cancelled',
          buyerWallet: buyer,
          sellerWallet: seller,
          recipientWallet: buyer,
          recipientRole: 'buyer',
        });
      }
      return events;
    }

    return [];
  }

  /**
   * Persists decoded event into Outbox without pre-claiming delivery.
   * Delivery claim belongs exclusively to OutboxProcessor at dispatch time.
   */
  private async persistDecodedEvent(event: DecodedDealEvent): Promise<void> {
    await persistDecodedEventToOutbox(this.outboxRepo, event);
  }
}

/**
 * Authoritative deal contract log decoding function.
 * Shared between BlockchainScanner and HistoricalDealReplayService to guarantee 100% decoding parity.
 */
export function decodeDealContractLog(params: {
  chainId: number;
  log: RawLog;
  generation?: 'v2' | 'v1' | 'legacy';
  contractType?: 'deal_v1' | 'deal_v2';
  buyerWallet?: string;
  sellerWallet?: string;
}): DecodedDealEvent[] {
  const { chainId, log, generation } = params;
  const contractAddr = normalizeWallet(log.address);
  const buyer = params.buyerWallet ? normalizeWallet(params.buyerWallet) : '';
  const seller = params.sellerWallet ? normalizeWallet(params.sellerWallet) : '';

  // 1. If explicitly legacy Nexotiq, decode using nexotiqDealABI
  if (generation === 'legacy') {
    try {
      const parsedNexotiq = parseEventLogs({
        abi: nexotiqDealABI,
        logs: [log as any],
      }) as any[];
      if (parsedNexotiq.length > 0) {
        return decodeNexotiqEvent(chainId, parsedNexotiq[0], log, contractAddr, buyer, seller);
      }
    } catch {}
    return [];
  }

  // 2. For V2 and V1 Synq deals, decode using synqDealV1ABI (ISynqDeal events)
  try {
    const parsedV1 = parseEventLogs({
      abi: synqDealV1ABI,
      logs: [log as any],
    }) as any[];

    if (parsedV1.length > 0) {
      return decodeSynqDealEvent(chainId, parsedV1[0], log, contractAddr, buyer, seller);
    }
  } catch {}

  // 3. Fallback for unclassified legacy records: try Nexotiq ABI
  if (!generation) {
    try {
      const parsedNexotiq = parseEventLogs({
        abi: nexotiqDealABI,
        logs: [log as any],
      }) as any[];

      if (parsedNexotiq.length > 0) {
        return decodeNexotiqEvent(chainId, parsedNexotiq[0], log, contractAddr, buyer, seller);
      }
    } catch {}
  }

  return [];
}

/**
 * Persists decoded event into Outbox without pre-claiming delivery.
 * Canonical implementation used across live scanner and historical replay.
 */
export async function persistDecodedEventToOutbox(
  outboxRepo: IDealOutboxRepository,
  event: DecodedDealEvent,
): Promise<'enqueued' | 'duplicate'> {
  const notifKey = generateCanonicalDealEventKey({
    chainId: event.chainId,
    dealId: event.contractAddress,
    contractAddress: event.contractAddress,
    event: event.event,
    milestoneIndex: event.milestoneIndex,
    submissionVersion: event.submissionVersion,
    txHash: event.transactionHash,
    logIndex: event.logIndex,
    recipientRole: event.recipientRole,
    includeLogIndex: true,
  });

  // Stage into deal_events_outbox for asynchronous, reliable email dispatch
  const outboxId = deriveOutboxEventId({
    chainId: event.chainId,
    dealId: event.contractAddress,
    event: event.event,
    recipientWallet: event.recipientWallet,
    actionId: `${event.transactionHash}:${event.logIndex}`,
  });

  return outboxRepo.enqueue({
    id: outboxId,
    chainId: event.chainId,
    dealId: event.contractAddress,
    event: event.event,
    recipientWallet: event.recipientWallet,
    origin: 'on_chain',
    blockNumber: event.blockNumber,
    txHash: event.transactionHash,
    logIndex: event.logIndex,
    payload: {
      dealId: event.contractAddress,
      event: event.event,
      milestoneIndex: event.milestoneIndex,
      submissionVersion: event.submissionVersion,
      txHash: event.transactionHash,
      logIndex: event.logIndex,
      buyerWallet: event.buyerWallet,
      sellerWallet: event.sellerWallet,
      recipientWallet: event.recipientWallet,
      recipientRole: event.recipientRole,
      amount: event.amount,
      title: event.title,
      notifKey,
    },
  });
}

function decodeSynqDealEvent(
  chainId: number,
  item: any,
  log: RawLog,
  contractAddr: string,
  buyer: string,
  seller: string,
): DecodedDealEvent[] {
  const args = item.args;

  if (item.eventName === 'DealFunded') {
    return [
      {
        chainId,
        contractAddress: contractAddr,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        event: 'deal_confirmed',
        buyerWallet: buyer,
        sellerWallet: seller,
        recipientWallet: seller,
        recipientRole: 'seller',
        amount: args.totalEscrow ? args.totalEscrow.toString() : undefined,
      },
    ];
  }

  if (item.eventName === 'MilestoneSubmitted') {
    const version = args.version !== undefined ? Number(args.version) : undefined;
    return [
      {
        chainId,
        contractAddress: contractAddr,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        event: 'work_submitted',
        milestoneIndex: Number(args.milestoneId),
        submissionVersion: version,
        buyerWallet: buyer,
        sellerWallet: seller,
        recipientWallet: buyer,
        recipientRole: 'buyer',
      },
    ];
  }

  if (item.eventName === 'MilestoneSettled') {
    const paid = BigInt(args.paidToFreelancer || 0);
    const refunded = BigInt(args.refundedToClient || 0);
    const events: DecodedDealEvent[] = [];

    if (paid > 0n) {
      events.push({
        chainId,
        contractAddress: contractAddr,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        event: 'payment_released',
        milestoneIndex: Number(args.milestoneId),
        buyerWallet: buyer,
        sellerWallet: seller,
        recipientWallet: seller,
        recipientRole: 'seller',
        amount: paid.toString(),
      });
    }

    if (refunded > 0n) {
      events.push({
        chainId,
        contractAddress: contractAddr,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        event: 'milestone_refunded',
        milestoneIndex: Number(args.milestoneId),
        buyerWallet: buyer,
        sellerWallet: seller,
        recipientWallet: buyer,
        recipientRole: 'buyer',
        amount: refunded.toString(),
      });
    }

    return events;
  }

  if (item.eventName === 'DealCompleted') {
    const events: DecodedDealEvent[] = [
      {
        chainId,
        contractAddress: contractAddr,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        event: 'deal_completed',
        buyerWallet: buyer,
        sellerWallet: seller,
        recipientWallet: buyer,
        recipientRole: 'buyer',
      },
    ];

    if (seller && seller.toLowerCase() !== buyer.toLowerCase()) {
      events.push({
        chainId,
        contractAddress: contractAddr,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        event: 'deal_completed_seller',
        buyerWallet: buyer,
        sellerWallet: seller,
        recipientWallet: seller,
        recipientRole: 'seller',
      });
    }

    return events;
  }

  if (item.eventName === 'DealCancelled') {
    const events: DecodedDealEvent[] = [
      {
        chainId,
        contractAddress: contractAddr,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        event: 'deal_cancelled',
        buyerWallet: buyer,
        sellerWallet: seller,
        recipientWallet: seller,
        recipientRole: 'seller',
      },
    ];

    if (buyer && buyer.toLowerCase() !== seller.toLowerCase()) {
      events.push({
        chainId,
        contractAddress: contractAddr,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        event: 'deal_cancelled',
        buyerWallet: buyer,
        sellerWallet: seller,
        recipientWallet: buyer,
        recipientRole: 'buyer',
      });
    }

    return events;
  }

  if (item.eventName === 'MilestoneDisputed') {
    const opener = normalizeWallet(args.opener || '');
    const recipient = opener === buyer ? seller : buyer;
    const role = opener === buyer ? 'seller' : 'buyer';
    return [
      {
        chainId,
        contractAddress: contractAddr,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        event: 'milestone_disputed',
        milestoneIndex: Number(args.milestoneId),
        buyerWallet: buyer,
        sellerWallet: seller,
        recipientWallet: recipient,
        recipientRole: role,
      },
    ];
  }

  return [];
}

function decodeNexotiqEvent(
  chainId: number,
  item: any,
  log: RawLog,
  contractAddr: string,
  buyer: string,
  seller: string,
): DecodedDealEvent[] {
  const args = item.args;

  if (item.eventName === 'PaymentReleased') {
    const toWallet = args.to ? normalizeWallet(args.to) : seller;
    return [
      {
        chainId,
        contractAddress: contractAddr,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        event: 'payment_released',
        milestoneIndex: Number(args.milestoneId),
        buyerWallet: buyer,
        sellerWallet: seller,
        recipientWallet: toWallet,
        recipientRole: 'seller',
        amount: args.amount ? args.amount.toString() : undefined,
      },
    ];
  }

  if (item.eventName === 'DealCompleted') {
    const events: DecodedDealEvent[] = [
      {
        chainId,
        contractAddress: contractAddr,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        event: 'deal_completed',
        buyerWallet: buyer,
        sellerWallet: seller,
        recipientWallet: buyer,
        recipientRole: 'buyer',
      },
    ];
    if (seller && seller.toLowerCase() !== buyer.toLowerCase()) {
      events.push({
        chainId,
        contractAddress: contractAddr,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        event: 'deal_completed_seller',
        buyerWallet: buyer,
        sellerWallet: seller,
        recipientWallet: seller,
        recipientRole: 'seller',
      });
    }
    return events;
  }

  if (item.eventName === 'DealCancelled') {
    const events: DecodedDealEvent[] = [
      {
        chainId,
        contractAddress: contractAddr,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        event: 'deal_cancelled',
        buyerWallet: buyer,
        sellerWallet: seller,
        recipientWallet: seller,
        recipientRole: 'seller',
      },
    ];
    if (buyer && buyer.toLowerCase() !== seller.toLowerCase()) {
      events.push({
        chainId,
        contractAddress: contractAddr,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        event: 'deal_cancelled',
        buyerWallet: buyer,
        sellerWallet: seller,
        recipientWallet: buyer,
        recipientRole: 'buyer',
      });
    }
    return events;
  }

  return [];
}
