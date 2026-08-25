import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

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
}

const defaultDb: Database = {
  users: [],
  deals: [],
  escrows: [],
  payments: [],
  activities: [],
  reputations: [],
  disputes: [],
  authTokens: [],
  verifications: [],
};

const COLLECTIONS = Object.keys(defaultDb) as (keyof Database)[];

/** Fresh empty DB. Must be a deep copy — a shallow `{...defaultDb}` shares the
 * arrays with the module-level object, so one caller's push would leak into
 * every later "empty" database for the lifetime of the process. */
function emptyDb(): Database {
  return { users: [], deals: [], escrows: [], payments: [], activities: [], reputations: [], disputes: [], authTokens: [], verifications: [] };
}

/** Force every collection to be an array so callers can always .push/.filter. */
function normalize(parsed: any): Database {
  const db = emptyDb();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return db;
  for (const key of COLLECTIONS) {
    if (Array.isArray(parsed[key])) db[key] = parsed[key];
  }
  return db;
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readDb(): Database {
  ensureDir();
  if (!fs.existsSync(DB_FILE)) {
    const fresh = emptyDb();
    writeDb(fresh);
    return fresh;
  }
  const raw = fs.readFileSync(DB_FILE, 'utf-8');
  try {
    return normalize(JSON.parse(raw));
  } catch (e: any) {
    // Do NOT just return defaults: the very next write would overwrite the file
    // and destroy whatever was in it. Quarantine the unparseable file first so
    // the data is recoverable by hand, and say so loudly.
    const backup = path.join(DATA_DIR, `db.corrupt-${Date.now()}.json`);
    try {
      fs.writeFileSync(backup, raw);
      console.error(`[db] ${DB_FILE} is not valid JSON (${e?.message}). Copied it to ${backup} and started from an empty database.`);
    } catch (copyErr: any) {
      // Could not preserve it — refuse to continue rather than silently wipe.
      console.error(`[db] ${DB_FILE} is corrupt and the backup failed (${copyErr?.message}).`);
      throw new Error('Local database is corrupt and could not be backed up; refusing to overwrite it.');
    }
    return emptyDb();
  }
}

function writeDb(db: Database) {
  ensureDir();
  // Write-then-rename: a crash mid-write leaves the old file intact instead of
  // a half-written one. fs.renameSync replaces the target atomically.
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/** Monotonic within the process, so two records created in the same
 * millisecond can never collide (the old `PREFIX-Date.now()` did). */
let idSeq = 0;
function nextId(collection: string, items: any[]): string {
  const prefix = collection.slice(0, 3).toUpperCase();
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = `${prefix}-${Date.now()}-${(idSeq++).toString(36)}`;
    if (!items.some((item: any) => item?.id === id)) return id;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getAll<T extends keyof Database>(collection: T): Database[T] {
  const db = readDb();
  return db[collection];
}

export function getById<T extends keyof Database>(collection: T, id: string): any {
  const db = readDb();
  const items = db[collection] as any[];
  return items.find((item: any) => item.id === id) || null;
}

export function create<T extends keyof Database>(collection: T, data: any): any {
  const db = readDb();
  const items = db[collection] as any[];
  const newItem = { ...data, id: data.id || nextId(String(collection), items) };
  items.push(newItem);
  writeDb(db);
  return newItem;
}

export function update<T extends keyof Database>(collection: T, id: string, data: any): any | null {
  const db = readDb();
  const items = db[collection] as any[];
  const idx = items.findIndex((item: any) => item.id === id);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...data, updatedAt: new Date().toISOString() };
  writeDb(db);
  return items[idx];
}

export function remove<T extends keyof Database>(collection: T, id: string): boolean {
  const db = readDb();
  const items = db[collection] as any[];
  const idx = items.findIndex((item: any) => item.id === id);
  if (idx === -1) return false;
  items.splice(idx, 1);
  writeDb(db);
  return true;
}

export function query<T extends keyof Database>(collection: T, fn: (item: any) => boolean): any[] {
  const db = readDb();
  const items = db[collection] as any[];
  return items.filter(fn);
}

export function seedDatabase() {
  const db = readDb();
  if (db.users.length > 0) return;

  const now = new Date().toISOString();

  db.users.push({
    id: 'user-1',
    name: 'Alex Morgan',
    email: 'alex@nexotiq.io',
    walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
    trustScore: 94,
    totalProtected: 12450,
    activeEscrow: 8200,
    pendingPayments: 1250,
    createdAt: now,
  });

  db.reputations.push({
    id: 'rep-1',
    userId: 'user-1',
    score: 94,
    totalDeals: 47,
    totalVolume: 128500,
    successfulDeals: 46,
    failedDeals: 1,
    successRate: 98,
    paymentReliability: 100,
    deliveryRate: 96,
    disputeRate: 2,
    averageResponseTime: '2.4 hours',
    timeline: [
      { date: '2026-07-19', type: 'deal_completed', label: 'NFT Collection Design completed', impact: 2 },
      { date: '2026-07-15', type: 'payment_received', label: 'Payment of $1,200 received', impact: 1 },
      { date: '2026-07-10', type: 'milestone_approved', label: 'Concept Art milestone approved', impact: 1 },
    ],
  });

  const deal1 = {
    id: 'NX-1024',
    title: 'DeFi Dashboard Development',
    buyer: 'Alex Morgan',
    seller: 'Nova Labs',
    value: 5000,
    deadline: '30 Days',
    status: 'in_progress',
    description: 'Build a comprehensive DeFi dashboard with real-time analytics, portfolio tracking, and transaction monitoring.',
    protection: 'enhanced',
    risk: 'low',
    escrowId: 'ESC-1024',
    userId: 'user-1',
    milestones: [
      { id: 'm1', title: 'Discovery', description: 'Requirements gathering and architecture design', amount: 1000, status: 'approved', dueDate: '2026-08-01', completedAt: '2026-07-28', evidence: 'Requirements document submitted' },
      { id: 'm2', title: 'Development', description: 'Core dashboard development and API integration', amount: 2500, status: 'in_progress', dueDate: '2026-08-15' },
      { id: 'm3', title: 'Final Delivery', description: 'Testing, deployment, and handover', amount: 1500, status: 'pending', dueDate: '2026-08-30' },
    ],
    createdAt: '2026-07-20T10:30:00Z',
    updatedAt: '2026-07-28T14:22:00Z',
  };

  const deal2 = {
    id: 'NX-1023',
    title: 'Smart Contract Audit',
    buyer: 'Alex Morgan',
    seller: 'SecureChain Labs',
    value: 3200,
    deadline: '14 Days',
    status: 'negotiating',
    description: 'Comprehensive security audit for ERC-20 token contract.',
    protection: 'standard',
    risk: 'medium',
    escrowId: 'ESC-1023',
    userId: 'user-1',
    milestones: [
      { id: 'm1', title: 'Initial Review', description: 'Code review and vulnerability assessment', amount: 1200, status: 'pending', dueDate: '2026-08-05' },
      { id: 'm2', title: 'Final Report', description: 'Detailed audit report with recommendations', amount: 2000, status: 'pending', dueDate: '2026-08-12' },
    ],
    createdAt: '2026-07-22T09:15:00Z',
    updatedAt: '2026-07-25T11:00:00Z',
  };

  db.deals.push(deal1, deal2);

  db.escrows.push(
    {
      id: 'ESC-1024',
      dealId: 'NX-1024',
      buyer: 'Alex Morgan',
      seller: 'Nova Labs',
      totalValue: 5000,
      lockedAmount: 5000,
      status: 'locked',
      currentMilestone: 1,
      milestones: deal1.milestones,
      userId: 'user-1',
      createdAt: '2026-07-20T10:30:00Z',
      transactionHash: '0x8f3b6c2a1d4e5f7a8b9c0d1e2f3a4b5c6d7e8f9',
      network: 'Ethereum',
    }
  );

  db.payments.push(
    {
      id: 'pay-1',
      recipient: 'Nova Labs',
      amount: 1000,
      networkFee: 0.12,
      source: 'Nexotiq Wallet',
      status: 'confirmed',
      transactionHash: '0x8f3b6c2a1d4e5f7a8b9c0d1e2f3a4b5c6d7e8f9',
      userId: 'user-1',
      dealId: 'NX-1024',
      timestamp: '2026-07-28T15:00:00Z',
    }
  );

  db.activities.push(
    { id: 'act-1', type: 'milestone_completed', title: 'Milestone Approved', description: 'Discovery milestone for NX-1024 was approved', timestamp: '2026-07-28T14:22:00Z', dealId: 'NX-1024', amount: 1000, userId: 'user-1' },
    { id: 'act-2', type: 'risk_alert', title: 'Risk Score Updated', description: 'Risk score for NX-1024 decreased to 18', timestamp: '2026-07-28T14:20:00Z', dealId: 'NX-1024', userId: 'user-1' },
    { id: 'act-3', type: 'protection_activated', title: 'Protection Activated', description: 'Adaptive Protection is active for NX-1024', timestamp: '2026-07-20T10:35:00Z', dealId: 'NX-1024', userId: 'user-1' },
    { id: 'act-4', type: 'deal_created', title: 'Deal Created', description: 'DeFi Dashboard Development deal was created', timestamp: '2026-07-20T10:30:00Z', dealId: 'NX-1024', amount: 5000, userId: 'user-1' },
  );

  writeDb(db);
}
