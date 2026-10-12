/**
 * Synq Chain Sync Cursor Repository (B.12.3.2)
 *
 * Durable cursor tracking for autonomous blockchain log scanning.
 * Provides atomic Compare-And-Swap (CAS) advancement, reorg rewind support,
 * and concurrent worker collision protection.
 */

import { getDb } from '@/db';
import { chainSyncCursors } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export interface ChainSyncCursor {
  id: string; // `${chainId}:${scannerId}`
  chainId: number;
  scannerId: string;
  lastBlockNumber: bigint;
  lastBlockHash: string;
  isBootstrap: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type CursorAdvanceResult =
  | { status: 'advanced'; cursor: ChainSyncCursor }
  | { status: 'conflict_stale'; currentCursor: ChainSyncCursor }
  | { status: 'not_found' };

export type CursorRewindResult =
  | { status: 'rewound'; cursor: ChainSyncCursor }
  | { status: 'conflict_stale'; currentCursor: ChainSyncCursor }
  | { status: 'not_found' };

export class ChainSyncPersistenceError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'ChainSyncPersistenceError';
  }
}

export function isZeroBlockHash(hash?: string | null): boolean {
  if (!hash) return true;
  const clean = hash.trim().toLowerCase();
  return clean === '0x' || /^0x0+$/.test(clean) || clean === '0x0';
}

export function formatCursorId(chainId: number, scannerId: string): string {
  return `${chainId}:${scannerId.trim().toLowerCase()}`;
}

export interface IChainCursorRepository {
  get(chainId: number, scannerId: string): Promise<ChainSyncCursor | null>;

  initializeIfMissing(params: {
    chainId: number;
    scannerId: string;
    initialBlockNumber: bigint;
    initialBlockHash: string;
    isBootstrap?: boolean;
  }): Promise<ChainSyncCursor>;

  advance(params: {
    chainId: number;
    scannerId: string;
    expectedLastBlockNumber: bigint;
    newBlockNumber: bigint;
    newBlockHash: string;
  }): Promise<CursorAdvanceResult>;

  rewind(params: {
    chainId: number;
    scannerId: string;
    expectedLastBlockNumber: bigint;
    targetBlockNumber: bigint;
    targetBlockHash: string;
  }): Promise<CursorRewindResult>;
}

export class InMemoryChainCursorRepository implements IChainCursorRepository {
  private cursors = new Map<string, ChainSyncCursor>();

  async get(chainId: number, scannerId: string): Promise<ChainSyncCursor | null> {
    const id = formatCursorId(chainId, scannerId);
    const existing = this.cursors.get(id);
    return existing ? { ...existing } : null;
  }

  async initializeIfMissing(params: {
    chainId: number;
    scannerId: string;
    initialBlockNumber: bigint;
    initialBlockHash: string;
    isBootstrap?: boolean;
  }): Promise<ChainSyncCursor> {
    const id = formatCursorId(params.chainId, params.scannerId);
    const existing = this.cursors.get(id);
    if (existing) {
      return { ...existing };
    }

    if (isZeroBlockHash(params.initialBlockHash)) {
      throw new Error(`Invalid or zero block hash rejected as chain proof: ${params.initialBlockHash}`);
    }

    const now = new Date();
    const created: ChainSyncCursor = {
      id,
      chainId: params.chainId,
      scannerId: params.scannerId.trim().toLowerCase(),
      lastBlockNumber: params.initialBlockNumber,
      lastBlockHash: params.initialBlockHash.toLowerCase(),
      isBootstrap: params.isBootstrap ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.cursors.set(id, created);
    return { ...created };
  }

  async advance(params: {
    chainId: number;
    scannerId: string;
    expectedLastBlockNumber: bigint;
    newBlockNumber: bigint;
    newBlockHash: string;
  }): Promise<CursorAdvanceResult> {
    const id = formatCursorId(params.chainId, params.scannerId);
    const current = this.cursors.get(id);
    if (!current) {
      return { status: 'not_found' };
    }

    if (current.lastBlockNumber !== params.expectedLastBlockNumber) {
      return { status: 'conflict_stale', currentCursor: { ...current } };
    }

    if (params.newBlockNumber <= current.lastBlockNumber) {
      throw new Error(
        `Monotonicity violation: Cannot advance cursor from block ${current.lastBlockNumber} to ${params.newBlockNumber}`,
      );
    }

    const updated: ChainSyncCursor = {
      ...current,
      lastBlockNumber: params.newBlockNumber,
      lastBlockHash: params.newBlockHash.toLowerCase(),
      isBootstrap: false,
      updatedAt: new Date(),
    };
    this.cursors.set(id, updated);
    return { status: 'advanced', cursor: { ...updated } };
  }

  async rewind(params: {
    chainId: number;
    scannerId: string;
    expectedLastBlockNumber: bigint;
    targetBlockNumber: bigint;
    targetBlockHash: string;
  }): Promise<CursorRewindResult> {
    const id = formatCursorId(params.chainId, params.scannerId);
    const current = this.cursors.get(id);
    if (!current) {
      return { status: 'not_found' };
    }

    if (current.lastBlockNumber !== params.expectedLastBlockNumber) {
      return { status: 'conflict_stale', currentCursor: { ...current } };
    }

    if (params.targetBlockNumber >= current.lastBlockNumber) {
      throw new Error(
        `Invalid rewind: Target block ${params.targetBlockNumber} must be strictly lower than current block ${current.lastBlockNumber}`,
      );
    }

    const updated: ChainSyncCursor = {
      ...current,
      lastBlockNumber: params.targetBlockNumber,
      lastBlockHash: params.targetBlockHash.toLowerCase(),
      isBootstrap: false,
      updatedAt: new Date(),
    };
    this.cursors.set(id, updated);
    return { status: 'rewound', cursor: { ...updated } };
  }

  clear(): void {
    this.cursors.clear();
  }
}

export class DrizzleChainCursorRepository implements IChainCursorRepository {
  async get(chainId: number, scannerId: string): Promise<ChainSyncCursor | null> {
    const id = formatCursorId(chainId, scannerId);
    try {
      const db = getDb();
      if (!db) {
        throw new ChainSyncPersistenceError('Database connection unavailable');
      }
      const rows = await db
        .select()
        .from(chainSyncCursors)
        .where(eq(chainSyncCursors.id, id))
        .limit(1);

      if (!rows || rows.length === 0) return null;
      const row = rows[0];
      return {
        id: row.id,
        chainId: row.chainId,
        scannerId: row.scannerId,
        lastBlockNumber: BigInt(row.lastBlockNumber),
        lastBlockHash: row.lastBlockHash,
        isBootstrap: Boolean((row as any).isBootstrap ?? true),
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      };
    } catch (err: any) {
      if (err instanceof ChainSyncPersistenceError) throw err;
      throw new ChainSyncPersistenceError(
        `Failed to retrieve chain sync cursor for ${id}: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }

  async initializeIfMissing(params: {
    chainId: number;
    scannerId: string;
    initialBlockNumber: bigint;
    initialBlockHash: string;
    isBootstrap?: boolean;
  }): Promise<ChainSyncCursor> {
    const id = formatCursorId(params.chainId, params.scannerId);
    try {
      const db = getDb();
      if (!db) {
        throw new ChainSyncPersistenceError('Database connection unavailable');
      }

      const cleanScanner = params.scannerId.trim().toLowerCase();
      const cleanHash = params.initialBlockHash.toLowerCase();

      if (isZeroBlockHash(cleanHash)) {
        throw new Error(`Invalid or zero block hash rejected as chain proof: ${params.initialBlockHash}`);
      }

      // Upsert pattern with onConflictDoNothing
      try {
        await db
          .insert(chainSyncCursors)
          .values({
            id,
            chainId: params.chainId,
            scannerId: cleanScanner,
            lastBlockNumber: params.initialBlockNumber.toString(),
            lastBlockHash: cleanHash,
            isBootstrap: params.isBootstrap ?? true,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoNothing();
      } catch (insertErr: any) {
        // Catch concurrent unique constraint collisions (Postgres error code 23505)
        const isUniqueViolation =
          insertErr?.code === '23505' ||
          insertErr?.cause?.code === '23505' ||
          /duplicate key|violates unique constraint/i.test(insertErr?.message || '');
        if (!isUniqueViolation) {
          throw insertErr;
        }
      }

      const current = await this.get(params.chainId, params.scannerId);
      if (!current) {
        throw new ChainSyncPersistenceError(`Cursor row not found immediately after initialize for ${id}`);
      }
      return current;
    } catch (err: any) {
      if (err instanceof ChainSyncPersistenceError) throw err;
      throw new ChainSyncPersistenceError(
        `Failed to initialize chain sync cursor for ${id}: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }

  async advance(params: {
    chainId: number;
    scannerId: string;
    expectedLastBlockNumber: bigint;
    newBlockNumber: bigint;
    newBlockHash: string;
  }): Promise<CursorAdvanceResult> {
    const id = formatCursorId(params.chainId, params.scannerId);

    if (params.newBlockNumber <= params.expectedLastBlockNumber) {
      throw new Error(
        `Monotonicity violation: Cannot advance cursor from block ${params.expectedLastBlockNumber} to ${params.newBlockNumber}`,
      );
    }

    try {
      const db = getDb();
      if (!db) {
        throw new ChainSyncPersistenceError('Database connection unavailable');
      }

      // CAS update
      const result = await db
        .update(chainSyncCursors)
        .set({
          lastBlockNumber: params.newBlockNumber.toString(),
          lastBlockHash: params.newBlockHash.toLowerCase(),
          isBootstrap: false,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chainSyncCursors.id, id),
            eq(chainSyncCursors.lastBlockNumber, params.expectedLastBlockNumber.toString()),
          ),
        )
        .returning();

      if (result && result.length > 0) {
        const row = result[0];
        return {
          status: 'advanced',
          cursor: {
            id: row.id,
            chainId: row.chainId,
            scannerId: row.scannerId,
            lastBlockNumber: BigInt(row.lastBlockNumber),
            lastBlockHash: row.lastBlockHash,
            isBootstrap: false,
            createdAt: new Date(row.createdAt),
            updatedAt: new Date(row.updatedAt),
          },
        };
      }

      // If update returned 0 rows, check if cursor exists or is stale
      const current = await this.get(params.chainId, params.scannerId);
      if (!current) {
        return { status: 'not_found' };
      }
      return { status: 'conflict_stale', currentCursor: current };
    } catch (err: any) {
      if (err instanceof ChainSyncPersistenceError) throw err;
      throw new ChainSyncPersistenceError(
        `Failed to advance chain sync cursor for ${id}: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }

  async rewind(params: {
    chainId: number;
    scannerId: string;
    expectedLastBlockNumber: bigint;
    targetBlockNumber: bigint;
    targetBlockHash: string;
  }): Promise<CursorRewindResult> {
    const id = formatCursorId(params.chainId, params.scannerId);

    if (params.targetBlockNumber >= params.expectedLastBlockNumber) {
      throw new Error(
        `Invalid rewind: Target block ${params.targetBlockNumber} must be strictly lower than expected block ${params.expectedLastBlockNumber}`,
      );
    }

    try {
      const db = getDb();
      if (!db) {
        throw new ChainSyncPersistenceError('Database connection unavailable');
      }

      const result = await db
        .update(chainSyncCursors)
        .set({
          lastBlockNumber: params.targetBlockNumber.toString(),
          lastBlockHash: params.targetBlockHash.toLowerCase(),
          isBootstrap: false,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chainSyncCursors.id, id),
            eq(chainSyncCursors.lastBlockNumber, params.expectedLastBlockNumber.toString()),
          ),
        )
        .returning();

      if (result && result.length > 0) {
        const row = result[0];
        return {
          status: 'rewound',
          cursor: {
            id: row.id,
            chainId: row.chainId,
            scannerId: row.scannerId,
            lastBlockNumber: BigInt(row.lastBlockNumber),
            lastBlockHash: row.lastBlockHash,
            isBootstrap: false,
            createdAt: new Date(row.createdAt),
            updatedAt: new Date(row.updatedAt),
          },
        };
      }

      const current = await this.get(params.chainId, params.scannerId);
      if (!current) {
        return { status: 'not_found' };
      }
      return { status: 'conflict_stale', currentCursor: current };
    } catch (err: any) {
      if (err instanceof ChainSyncPersistenceError) throw err;
      throw new ChainSyncPersistenceError(
        `Failed to rewind chain sync cursor for ${id}: ${err?.message || 'Unknown error'}`,
        err,
      );
    }
  }
}

// Global repository singleton
let globalCursorRepo: IChainCursorRepository | null = null;

export function getChainCursorRepository(): IChainCursorRepository {
  if (globalCursorRepo) return globalCursorRepo;
  return new DrizzleChainCursorRepository();
}

export function setChainCursorRepository(repo: IChainCursorRepository | null): void {
  globalCursorRepo = repo;
}

export function resetChainCursorRepository(): void {
  globalCursorRepo = null;
}
