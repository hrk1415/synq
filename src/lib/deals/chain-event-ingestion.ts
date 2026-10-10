/**
 * Synq Blockchain Event Ingestion Foundation (B.12.3.2)
 *
 * Core server-side utilities for robust, reorg-safe event ingestion:
 * - Confirmed block range calculations with conservative confirmation depth.
 * - Parent block hash continuity verification & reorg rewind calculations.
 * - Canonical event & log identity derivation.
 * - Dynamic deal contract discovery and generation tracking.
 * - On-demand bounded batch execution (no infinite background loops).
 */

import { normalizeWallet } from '@/lib/utils';

export const SUPPORTED_CHAIN_IDS = [11155111] as const;
export const DEFAULT_CONFIRMATION_DEPTH = 5n; // >3 confirmations to prevent premature finality
export const DEFAULT_MAX_BATCH_SIZE = 100n;
export const DEFAULT_REORG_REWIND_DEPTH = 10n;

export function validateChainId(chainId: number): number {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid chain ID: ${chainId}. Must be a positive integer.`);
  }
  if (!SUPPORTED_CHAIN_IDS.includes(chainId as 11155111)) {
    throw new Error(
      `Unsupported chain ID: ${chainId}. Supported chains: ${SUPPORTED_CHAIN_IDS.join(', ')}`,
    );
  }
  return chainId;
}

export interface ScanRangeResult {
  shouldScan: boolean;
  fromBlock?: bigint;
  toBlock?: bigint;
  reason?: string;
}

/**
 * Calculates a safe, bounded block range respecting confirmation depth.
 */
export function calculateScanRange(params: {
  currentCursorBlock: bigint;
  latestHeadBlock: bigint;
  confirmationDepth?: bigint;
  maxBatchSize?: bigint;
}): ScanRangeResult {
  const depth = params.confirmationDepth ?? DEFAULT_CONFIRMATION_DEPTH;
  const maxBatch = params.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;

  if (params.latestHeadBlock < depth) {
    return {
      shouldScan: false,
      reason: `Latest head block ${params.latestHeadBlock} is lower than confirmation depth ${depth}`,
    };
  }

  const confirmedHead = params.latestHeadBlock - depth;

  if (confirmedHead <= params.currentCursorBlock) {
    return {
      shouldScan: false,
      reason: `Cursor block ${params.currentCursorBlock} is already at or past confirmed head ${confirmedHead}`,
    };
  }

  const fromBlock = params.currentCursorBlock + 1n;
  const potentialTo = fromBlock + maxBatch - 1n;
  const toBlock = potentialTo < confirmedHead ? potentialTo : confirmedHead;

  return {
    shouldScan: true,
    fromBlock,
    toBlock,
  };
}

/**
 * Verifies that the parent hash of the incoming fromBlock matches the recorded cursor block hash.
 */
export function verifyBlockHashContinuity(params: {
  expectedParentHash: string;
  actualParentHash: string;
}): boolean {
  if (!params.expectedParentHash || !params.actualParentHash) return false;
  return params.expectedParentHash.trim().toLowerCase() === params.actualParentHash.trim().toLowerCase();
}

/**
 * Calculates a safe reorg rollback block target.
 */
export function calculateReorgRewindBlock(params: {
  currentCursorBlock: bigint;
  rewindDepth?: bigint;
  minAllowedBlock: bigint;
}): bigint {
  const depth = params.rewindDepth ?? DEFAULT_REORG_REWIND_DEPTH;
  const calculated = params.currentCursorBlock > depth ? params.currentCursorBlock - depth : params.minAllowedBlock;
  return calculated < params.minAllowedBlock ? params.minAllowedBlock : calculated;
}

/**
 * Canonical log identity helper to eliminate duplicate log processing.
 */
export function deriveCanonicalLogId(params: {
  chainId: number;
  transactionHash: string;
  logIndex: number;
}): string {
  const chain = params.chainId;
  const tx = params.transactionHash.trim().toLowerCase();
  return `${chain}:${tx}:${params.logIndex}`;
}

export type ContractType = 'factory' | 'deal_v1' | 'deal_v2';

export interface TrackedContract {
  address: string;
  contractType: ContractType;
  deploymentBlock: bigint;
  metadata?: Record<string, unknown>;
}

/**
 * Registry to track multiple contract generations and dynamically discovered deal contracts.
 */
export class DealContractRegistry {
  private contracts = new Map<string, TrackedContract>();

  constructor(initialContracts: TrackedContract[] = []) {
    for (const c of initialContracts) {
      this.registerContract(c);
    }
  }

  registerContract(contract: TrackedContract): void {
    const addr = normalizeWallet(contract.address);
    this.contracts.set(addr, {
      ...contract,
      address: addr,
    });
  }

  getContract(address: string): TrackedContract | null {
    const addr = normalizeWallet(address);
    const existing = this.contracts.get(addr);
    return existing ? { ...existing } : null;
  }

  isRegistered(address: string): boolean {
    return this.contracts.has(normalizeWallet(address));
  }

  getAllTrackedAddresses(): string[] {
    return Array.from(this.contracts.keys());
  }

  getContractsByType(type: ContractType): TrackedContract[] {
    return Array.from(this.contracts.values())
      .filter((c) => c.contractType === type)
      .map((c) => ({ ...c }));
  }

  /**
   * Evaluates if a newly discovered contract requires retroactive replay from its deployment block.
   */
  checkReplayRequirement(address: string, currentCursorBlock: bigint): {
    shouldReplay: boolean;
    deploymentBlock?: bigint;
  } {
    const contract = this.getContract(address);
    if (!contract) return { shouldReplay: false };

    if (contract.deploymentBlock < currentCursorBlock) {
      return {
        shouldReplay: true,
        deploymentBlock: contract.deploymentBlock,
      };
    }
    return { shouldReplay: false };
  }

  /**
   * Dynamically registers newly discovered deal clone from a factory log.
   */
  discoverDealClone(params: {
    factoryAddress: string;
    dealAddress: string;
    deploymentBlock: bigint;
    contractType?: ContractType;
  }): TrackedContract {
    const newContract: TrackedContract = {
      address: normalizeWallet(params.dealAddress),
      contractType: params.contractType || 'deal_v2',
      deploymentBlock: params.deploymentBlock,
      metadata: {
        factory: normalizeWallet(params.factoryAddress),
        discoveredAt: new Date().toISOString(),
      },
    };
    this.registerContract(newContract);
    return newContract;
  }
}

export interface RawLog {
  address: string;
  transactionHash: string;
  blockNumber: bigint;
  logIndex: number;
  data: string;
  topics: (string | string[] | null)[];
}

/**
 * Deduplicates and filters raw blockchain logs across a batch of blocks.
 */
export function deduplicateAndFilterLogs(params: {
  chainId: number;
  logs: RawLog[];
  registry: DealContractRegistry;
  processedLogIds?: Set<string>;
}): {
  relevantLogs: RawLog[];
  duplicateCount: number;
  untrackedCount: number;
} {
  const seenIds = params.processedLogIds || new Set<string>();
  const relevantLogs: RawLog[] = [];
  let duplicateCount = 0;
  let untrackedCount = 0;

  for (const log of params.logs) {
    const logId = deriveCanonicalLogId({
      chainId: params.chainId,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
    });

    if (seenIds.has(logId)) {
      duplicateCount += 1;
      continue;
    }

    if (!params.registry.isRegistered(log.address)) {
      untrackedCount += 1;
      continue;
    }

    seenIds.add(logId);
    relevantLogs.push(log);
  }

  return {
    relevantLogs,
    duplicateCount,
    untrackedCount,
  };
}
