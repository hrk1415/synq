/**
 * Synq Tracked Deal Contracts Repository (B.12.3.5)
 *
 * Durable registry of dynamically discovered deal clone instances.
 * Guarantees cross-restart and serverless cold-start contract visibility.
 */

import { getDb } from '@/db';
import { trackedDealContracts, type TrackedContractType } from '@/db/schema';
import { eq, and, gt, ne, sql } from 'drizzle-orm';

export interface TrackedDealContract {
  id: string; // `${chainId}:${contractAddress.toLowerCase()}`
  chainId: number;
  contractAddress: string;
  contractType: TrackedContractType;
  factoryAddress?: string | null;
  deploymentBlock: bigint;
  discoveryTxHash?: string | null;
  discoveryLogIndex?: number | null;
  buyerWallet?: string | null;
  sellerWallet?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TrackedDealContractInput {
  chainId: number;
  contractAddress: string;
  contractType: TrackedContractType;
  factoryAddress?: string | null;
  deploymentBlock: bigint;
  discoveryTxHash?: string | null;
  discoveryLogIndex?: number | null;
  buyerWallet?: string | null;
  sellerWallet?: string | null;
  metadata?: Record<string, unknown> | null;
}

export class TrackedContractPersistenceError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'TrackedContractPersistenceError';
  }
}

export function formatTrackedContractId(chainId: number, contractAddress: string): string {
  return `${chainId}:${contractAddress.trim().toLowerCase()}`;
}

export interface ITrackedContractsRepository {
  upsert(contract: TrackedDealContractInput): Promise<void>;
  get(chainId: number, contractAddress: string): Promise<TrackedDealContract | null>;
  getAll(chainId: number): Promise<TrackedDealContract[]>;
  deleteOrphanedAboveBlock(chainId: number, blockNumber: bigint): Promise<number>;
}

export class InMemoryTrackedContractsRepository implements ITrackedContractsRepository {
  private contracts = new Map<string, TrackedDealContract>();

  async upsert(contract: TrackedDealContractInput): Promise<void> {
    const id = formatTrackedContractId(contract.chainId, contract.contractAddress);
    const now = new Date();
    const existing = this.contracts.get(id);

    this.contracts.set(id, {
      id,
      chainId: contract.chainId,
      contractAddress: contract.contractAddress.toLowerCase(),
      contractType: contract.contractType,
      factoryAddress: contract.factoryAddress ? contract.factoryAddress.toLowerCase() : null,
      deploymentBlock: contract.deploymentBlock,
      discoveryTxHash: contract.discoveryTxHash ? contract.discoveryTxHash.toLowerCase() : null,
      discoveryLogIndex: contract.discoveryLogIndex ?? null,
      buyerWallet: contract.buyerWallet ? contract.buyerWallet.toLowerCase() : null,
      sellerWallet: contract.sellerWallet ? contract.sellerWallet.toLowerCase() : null,
      metadata: contract.metadata ? { ...contract.metadata } : null,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    });
  }

  async get(chainId: number, contractAddress: string): Promise<TrackedDealContract | null> {
    const id = formatTrackedContractId(chainId, contractAddress);
    const item = this.contracts.get(id);
    return item ? { ...item, metadata: item.metadata ? { ...item.metadata } : null } : null;
  }

  async getAll(chainId: number): Promise<TrackedDealContract[]> {
    const results: TrackedDealContract[] = [];
    for (const item of this.contracts.values()) {
      if (item.chainId === chainId) {
        results.push({ ...item, metadata: item.metadata ? { ...item.metadata } : null });
      }
    }
    return results;
  }

  async deleteOrphanedAboveBlock(chainId: number, blockNumber: bigint): Promise<number> {
    let deletedCount = 0;
    for (const [id, item] of this.contracts.entries()) {
      if (item.chainId === chainId && item.deploymentBlock > blockNumber && item.contractType !== 'factory') {
        this.contracts.delete(id);
        deletedCount++;
      }
    }
    return deletedCount;
  }

  clear(): void {
    this.contracts.clear();
  }
}

export class DrizzleTrackedContractsRepository implements ITrackedContractsRepository {
  async upsert(contract: TrackedDealContractInput): Promise<void> {
    const id = formatTrackedContractId(contract.chainId, contract.contractAddress);
    try {
      const db = getDb();
      if (!db) {
        throw new TrackedContractPersistenceError('Database connection unavailable');
      }

      const now = new Date();
      await db
        .insert(trackedDealContracts)
        .values({
          id,
          chainId: contract.chainId,
          contractAddress: contract.contractAddress.toLowerCase(),
          contractType: contract.contractType,
          factoryAddress: contract.factoryAddress ? contract.factoryAddress.toLowerCase() : null,
          deploymentBlock: contract.deploymentBlock.toString(),
          discoveryTxHash: contract.discoveryTxHash ? contract.discoveryTxHash.toLowerCase() : null,
          discoveryLogIndex: contract.discoveryLogIndex ?? null,
          buyerWallet: contract.buyerWallet ? contract.buyerWallet.toLowerCase() : null,
          sellerWallet: contract.sellerWallet ? contract.sellerWallet.toLowerCase() : null,
          metadata: contract.metadata || null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: trackedDealContracts.id,
          set: {
            contractType: contract.contractType,
            factoryAddress: contract.factoryAddress ? contract.factoryAddress.toLowerCase() : null,
            deploymentBlock: contract.deploymentBlock.toString(),
            discoveryTxHash: contract.discoveryTxHash ? contract.discoveryTxHash.toLowerCase() : null,
            discoveryLogIndex: contract.discoveryLogIndex ?? null,
            buyerWallet: contract.buyerWallet ? contract.buyerWallet.toLowerCase() : null,
            sellerWallet: contract.sellerWallet ? contract.sellerWallet.toLowerCase() : null,
            metadata: contract.metadata || null,
            updatedAt: now,
          },
        });
    } catch (err: any) {
      if (err instanceof TrackedContractPersistenceError) throw err;
      throw new TrackedContractPersistenceError(
        `Failed to upsert tracked contract ${id}: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }

  async get(chainId: number, contractAddress: string): Promise<TrackedDealContract | null> {
    const id = formatTrackedContractId(chainId, contractAddress);
    try {
      const db = getDb();
      if (!db) {
        throw new TrackedContractPersistenceError('Database connection unavailable');
      }

      const rows = await db
        .select()
        .from(trackedDealContracts)
        .where(eq(trackedDealContracts.id, id))
        .limit(1);

      if (!rows || rows.length === 0) return null;
      const row = rows[0];
      return {
        id: row.id,
        chainId: row.chainId,
        contractAddress: row.contractAddress,
        contractType: row.contractType,
        factoryAddress: row.factoryAddress,
        deploymentBlock: BigInt(row.deploymentBlock),
        discoveryTxHash: row.discoveryTxHash,
        discoveryLogIndex: row.discoveryLogIndex,
        buyerWallet: row.buyerWallet,
        sellerWallet: row.sellerWallet,
        metadata: (row.metadata as Record<string, unknown>) || null,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      };
    } catch (err: any) {
      if (err instanceof TrackedContractPersistenceError) throw err;
      throw new TrackedContractPersistenceError(
        `Failed to query tracked contract ${id}: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }

  async getAll(chainId: number): Promise<TrackedDealContract[]> {
    try {
      const db = getDb();
      if (!db) {
        throw new TrackedContractPersistenceError('Database connection unavailable');
      }

      const rows = await db
        .select()
        .from(trackedDealContracts)
        .where(eq(trackedDealContracts.chainId, chainId));

      return rows.map((row) => ({
        id: row.id,
        chainId: row.chainId,
        contractAddress: row.contractAddress,
        contractType: row.contractType,
        factoryAddress: row.factoryAddress,
        deploymentBlock: BigInt(row.deploymentBlock),
        discoveryTxHash: row.discoveryTxHash,
        discoveryLogIndex: row.discoveryLogIndex,
        buyerWallet: row.buyerWallet,
        sellerWallet: row.sellerWallet,
        metadata: (row.metadata as Record<string, unknown>) || null,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      }));
    } catch (err: any) {
      if (err instanceof TrackedContractPersistenceError) throw err;
      throw new TrackedContractPersistenceError(
        `Failed to query tracked contracts for chain ${chainId}: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }

  async deleteOrphanedAboveBlock(chainId: number, blockNumber: bigint): Promise<number> {
    try {
      const db = getDb();
      if (!db) {
        throw new TrackedContractPersistenceError('Database connection unavailable');
      }

      const res = await db
        .delete(trackedDealContracts)
        .where(
          and(
            eq(trackedDealContracts.chainId, chainId),
            sql`${trackedDealContracts.deploymentBlock} > ${blockNumber.toString()}`,
            ne(trackedDealContracts.contractType, 'factory'),
          ),
        )
        .returning();

      return res.length;
    } catch (err: any) {
      if (err instanceof TrackedContractPersistenceError) throw err;
      throw new TrackedContractPersistenceError(
        `Failed to delete orphaned tracked contracts above block ${blockNumber}: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }
}

// Global repository singleton
let globalTrackedContractsRepo: ITrackedContractsRepository | null = null;

export function getTrackedContractsRepository(): ITrackedContractsRepository {
  if (globalTrackedContractsRepo) return globalTrackedContractsRepo;
  return new DrizzleTrackedContractsRepository();
}

export function setTrackedContractsRepository(repo: ITrackedContractsRepository | null): void {
  globalTrackedContractsRepo = repo;
}

export function resetTrackedContractsRepository(): void {
  globalTrackedContractsRepo = null;
}
