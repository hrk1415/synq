import fs from 'fs';
import path from 'path';
import { Redis } from '@upstash/redis';

interface Database {
  users: any[];
  deals: any[];
  escrows: any[];
  payments: any[];
  activities: any[];
  reputations: any[];
  disputes: any[];
  authTokens: any[];
  verifications: any[];
  conversations: any[];
  messages: any[];
  reviews: any[];
}

const emptyDb = (): Database => ({
  users: [],
  deals: [],
  escrows: [],
  payments: [],
  activities: [],
  reputations: [],
  disputes: [],
  authTokens: [],
  verifications: [],
  conversations: [],
  messages: [],
  reviews: [],
});

// ---------------------------------------------------------------------------
// Backend selection
//
// Vercel (and most serverless hosts) have a read-only / ephemeral filesystem, so
// the file-based store below silently loses every write between invocations.
// When UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set we persist to
// Upstash Redis instead; otherwise we fall back to data/db.json for local dev.
// ---------------------------------------------------------------------------
function isRedisEnabled(): boolean {
  return !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;
}

let cachedRedis: Redis | null = null;
function getRedis(): Redis | null {
  if (!isRedisEnabled()) return null;
  if (!cachedRedis) {
    cachedRedis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL as string,
      token: process.env.UPSTASH_REDIS_REST_TOKEN as string,
    });
  }
  return cachedRedis;
}

const keyFor = (collection: string, id: string) => `synq:${collection}:${id}`;
const indexKey = (collection: string) => `synq:${collection}:index`;

/**
 * @upstash/redis deserialises automatically by default, so a value may come back
 * as an object OR (from older writes) as a JSON string. Handle both.
 */
function parseMaybe<T = any>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

function genId(collection: string): string {
  return `${collection.slice(0, 3).toUpperCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// File-based fallback (local dev only)
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function readDbFile(): Database {
  try {
    if (!fs.existsSync(DB_FILE)) return emptyDb();
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return { ...emptyDb(), ...JSON.parse(raw) };
  } catch {
    return emptyDb();
  }
}

function writeDbFile(db: Database) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DB_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (e: any) {
    // On a read-only serverless FS this is the moment data is lost. Fail loudly
    // instead of pretending the write succeeded.
    throw new Error(
      `Database write failed (${e?.code || e?.message || e}). This host's filesystem is likely read-only — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to persist to Redis.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API — always async so the Redis and file backends are interchangeable.
// ---------------------------------------------------------------------------
export async function getAll(collection: string): Promise<any[]> {
  const redis = getRedis();
  if (redis) {
    const ids = (await redis.smembers(indexKey(collection))) as string[];
    if (!ids || !ids.length) return [];
    const items = await redis.mget(...ids.map((id) => keyFor(collection, id)));
    return (items || []).map((i) => parseMaybe(i)).filter(Boolean);
  }
  const db = readDbFile() as any;
  return db[collection] || [];
}

export async function getById(collection: string, id: string): Promise<any | null> {
  const redis = getRedis();
  if (redis) {
    return parseMaybe(await redis.get(keyFor(collection, id)));
  }
  const db = readDbFile() as any;
  return (db[collection] || []).find((item: any) => item.id === id) || null;
}

export async function create(collection: string, data: any): Promise<any> {
  const id = data.id || genId(collection);
  const item = { ...data, id };
  const redis = getRedis();
  if (redis) {
    await redis.set(keyFor(collection, id), item);
    await redis.sadd(indexKey(collection), id);
    return item;
  }
  const db = readDbFile() as any;
  if (!Array.isArray(db[collection])) db[collection] = [];
  db[collection].push(item);
  writeDbFile(db);
  return item;
}

export async function update(collection: string, id: string, data: any): Promise<any | null> {
  const redis = getRedis();
  if (redis) {
    const existing = parseMaybe<any>(await redis.get(keyFor(collection, id)));
    if (!existing) return null;
    const updated = { ...existing, ...data, id, updatedAt: new Date().toISOString() };
    await redis.set(keyFor(collection, id), updated);
    return updated;
  }
  const db = readDbFile() as any;
  const items: any[] = db[collection] || [];
  const idx = items.findIndex((item: any) => item.id === id);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...data, id, updatedAt: new Date().toISOString() };
  writeDbFile(db);
  return items[idx];
}

export async function remove(collection: string, id: string): Promise<boolean> {
  const redis = getRedis();
  if (redis) {
    await redis.del(keyFor(collection, id));
    await redis.srem(indexKey(collection), id);
    return true;
  }
  const db = readDbFile() as any;
  const items: any[] = db[collection] || [];
  const idx = items.findIndex((item: any) => item.id === id);
  if (idx === -1) return false;
  items.splice(idx, 1);
  writeDbFile(db);
  return true;
}

export async function query(collection: string, fn: (item: any) => boolean): Promise<any[]> {
  const all = await getAll(collection);
  return all.filter(fn);
}

export async function seedDatabase() {
  const users = await getAll('users');
  if (users.length > 0) return;

  await create('users', {
    id: 'user-1',
    name: 'Alex Morgan',
    email: 'alex@nexotiq.io',
    walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
    trustScore: 94,
    totalProtected: 12450,
    activeEscrow: 8200,
    pendingPayments: 1250,
    createdAt: new Date().toISOString(),
  });
}
