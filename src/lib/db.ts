import { getDb, schema } from '@/db';
import { normalizeWallet } from '@/lib/utils';
import { and, eq, or } from 'drizzle-orm';
import { canonicalizeConversationPair } from '@/lib/conversation-pair';
import { validateTrustedMessageData, type SynqMessageKind, type SynqMessagePayload } from '@/lib/synq-message';
import { deriveConversationPreview, type SynqDealReceiptPayload, type SynqFileMessagePayload, type SynqPaymentReceiptPayload } from '@/lib/synq-message';

/**
 * PostgreSQL-backed Database Adapter (Phase C1 Runtime Cutover)
 *
 * All authoritative off-chain application data (users, marketProfiles, reviews,
 * conversations, messages) is read from and written to PostgreSQL / Supabase via Drizzle ORM.
 *
 * Runtime dependence on data/db.json and Upstash Redis is retired.
 *
 * Preserves camelCase application object contracts and existing function signatures
 * to guarantee zero regressions for API routes and frontend components.
 */

function genId(collection: string): string {
  return `${collection.slice(0, 3).toUpperCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Drizzle Row Mappers (PostgreSQL -> CamelCase Application Objects)
// ---------------------------------------------------------------------------

function mapUser(r: any) {
  if (!r) return null;
  return {
    id: r.walletAddress,
    walletAddress: r.walletAddress,
    name: r.name || null,
    email: r.email || null,
    avatar: r.avatar || null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
  };
}

function mapMarketProfile(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    walletAddress: r.walletAddress,
    wallet: r.walletAddress,
    headline: r.headline || '',
    secondaryCategories: Array.isArray(r.secondaryCategories) ? r.secondaryCategories : [],
    about: r.about || '',
    typicalDelivery: r.typicalDelivery || '',
    links: typeof r.links === 'object' && r.links !== null ? r.links : {},
    portfolio: Array.isArray(r.portfolio) ? r.portfolio : [],
    draftName: r.draftName || '',
    draftCategory: r.draftCategory || '',
    draftSkills: Array.isArray(r.draftSkills) ? r.draftSkills : [],
    draftRate: r.draftRate || '',
    draftBio: r.draftBio || '',
    startingRateAmount: r.startingRateAmount ? String(r.startingRateAmount) : null,
    startingRateCurrency: r.startingRateCurrency || null,
    startingRateType: r.startingRateType || null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
  };
}

function mapReview(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    dealAddress: r.dealAddress,
    reviewerWallet: r.reviewerWallet,
    sellerWallet: r.sellerWallet,
    rating: r.rating,
    comment: r.comment || '',
    role: r.role || '',
    verifiedDeal: typeof r.verifiedDeal === 'boolean' ? r.verifiedDeal : true,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
  };
}

function mapConversation(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    participantA: r.participantA,
    participantB: r.participantB,
    buyerWallet: r.buyerWallet,
    sellerWallet: r.sellerWallet,
    buyerName: r.buyerName || undefined,
    sellerName: r.sellerName || undefined,
    subject: r.subject || '',
    orderMeta: r.orderMeta || undefined,
    dealAddress: r.dealAddress || undefined,
    lastMessageAt: r.lastMessageAt instanceof Date ? r.lastMessageAt.toISOString() : r.lastMessageAt,
    lastMessagePreview: r.lastMessagePreview || '',
    lastMessageFrom: r.lastMessageFrom || '',
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
  };
}

function mapMessage(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    conversationId: r.conversationId,
    fromWallet: r.fromWallet,
    toWallet: r.toWallet,
    fromName: r.fromName || '',
    body: r.body,
    kind: r.kind || 'text',
    payload: r.payload || null,
    orderMeta: r.orderMeta || undefined,
    readAt: r.readAt instanceof Date ? r.readAt.toISOString() : r.readAt || null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
  };
}

function mapEmailVerification(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    email: r.email,
    walletAddress: r.walletAddress || undefined,
    name: r.name || undefined,
    codeHash: r.codeHash,
    attempts: r.attempts,
    expiresAt: r.expiresAt instanceof Date ? r.expiresAt.toISOString() : r.expiresAt,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
  };
}

function mapMilestoneVerification(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    dealAddress: r.dealAddress,
    milestoneId: r.milestoneId,
    completionPct: r.completionPct,
    summary: r.summary,
    verified: r.verified,
    notes: r.notes || undefined,
    recommendation: r.recommendation || undefined,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Public Async API (Matches legacy src/lib/db.ts function signatures)
// ---------------------------------------------------------------------------

export async function getAll(collection: string): Promise<any[]> {
  if (process.env.NODE_ENV !== 'production') {
    if (collection === 'users' && _testUsersList) {
      return _testUsersList();
    }
    if (collection === 'verifications' && _testVerificationsStore) {
      return Array.from(_testVerificationsStore.values());
    }
  }

  const db = getDb();

  switch (collection) {
    case 'users': {
      const rows = await db.select().from(schema.users);
      return rows.map(mapUser);
    }
    case 'marketProfiles': {
      const rows = await db.select().from(schema.marketProfiles);
      return rows.map(mapMarketProfile);
    }
    case 'reviews': {
      const rows = await db.select().from(schema.reviews);
      return rows.map(mapReview);
    }
    case 'conversations': {
      const rows = await db.select().from(schema.conversations);
      return rows.map(mapConversation);
    }
    case 'messages': {
      const rows = await db.select().from(schema.messages);
      return rows.map(mapMessage);
    }
    case 'verifications': {
      const [emailRows, milestoneRows] = await Promise.all([
        db.select().from(schema.emailVerifications),
        db.select().from(schema.milestoneVerifications),
      ]);
      return [...emailRows.map(mapEmailVerification), ...milestoneRows.map(mapMilestoneVerification)];
    }
    default: {
      return [];
    }
  }
}

let _testUserLookup: ((wallet: string) => Promise<any | null>) | null = null;
let _testUsersList: (() => Promise<any[]>) | null = null;
let _testVerificationsStore: Map<string, any> | null = null;

export function setTestUserLookup(fn: ((wallet: string) => Promise<any | null>) | null) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Test user lookup hook is prohibited in production environment');
  }
  _testUserLookup = fn;
}

export function setTestUsersList(fn: (() => Promise<any[]>) | null) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Test users list hook is prohibited in production environment');
  }
  _testUsersList = fn;
}

export function setTestVerificationsStore(store: Map<string, any> | null) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Test verifications store hook is prohibited in production environment');
  }
  _testVerificationsStore = store;
}

export async function getById(collection: string, id: string): Promise<any | null> {
  if (process.env.NODE_ENV !== 'production' && collection === 'users' && _testUserLookup) {
    return _testUserLookup(id);
  }

  const db = getDb();

  switch (collection) {
    case 'users': {
      const normalized = normalizeWallet(id);
      const rows = await db.select().from(schema.users).where(eq(schema.users.walletAddress, normalized));
      return rows[0] ? mapUser(rows[0]) : null;
    }
    case 'marketProfiles': {
      const normalized = normalizeWallet(id);
      const rows = await db
        .select()
        .from(schema.marketProfiles)
        .where(or(eq(schema.marketProfiles.id, id), eq(schema.marketProfiles.walletAddress, normalized)));
      return rows[0] ? mapMarketProfile(rows[0]) : null;
    }
    case 'reviews': {
      const rows = await db
        .select()
        .from(schema.reviews)
        .where(or(eq(schema.reviews.id, id), eq(schema.reviews.dealAddress, id)));
      return rows[0] ? mapReview(rows[0]) : null;
    }
    case 'conversations': {
      const rows = await db.select().from(schema.conversations).where(eq(schema.conversations.id, id));
      return rows[0] ? mapConversation(rows[0]) : null;
    }
    case 'messages': {
      const rows = await db.select().from(schema.messages).where(eq(schema.messages.id, id));
      return rows[0] ? mapMessage(rows[0]) : null;
    }
    case 'verifications': {
      const emailRows = await db.select().from(schema.emailVerifications).where(eq(schema.emailVerifications.id, id));
      if (emailRows[0]) return mapEmailVerification(emailRows[0]);
      const milestoneRows = await db.select().from(schema.milestoneVerifications).where(eq(schema.milestoneVerifications.id, id));
      if (milestoneRows[0]) return mapMilestoneVerification(milestoneRows[0]);
      return null;
    }
    default: {
      return null;
    }
  }
}

export async function getConversationByParticipants(walletA: string, walletB: string): Promise<any | null> {
  const { participantA, participantB } = canonicalizeConversationPair(walletA, walletB);
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.conversations)
    .where(and(
      eq(schema.conversations.participantA, participantA),
      eq(schema.conversations.participantB, participantB),
    ));
  return rows[0] ? mapConversation(rows[0]) : null;
}

export async function getOrCreateCanonicalConversation(data: any): Promise<{ conversation: any; created: boolean }> {
  const legacyBuyer = normalizeWallet(data.buyerWallet);
  const legacySeller = normalizeWallet(data.sellerWallet);
  const { participantA, participantB } = canonicalizeConversationPair(legacyBuyer, legacySeller);
  const db = getDb();
  const now = new Date();
  const insertData = {
    id: data.id || genId('conversations'),
    participantA,
    participantB,
    buyerWallet: legacyBuyer,
    sellerWallet: legacySeller,
    buyerName: data.buyerName || null,
    sellerName: data.sellerName || null,
    subject: data.subject || null,
    orderMeta: data.orderMeta || null,
    dealAddress: data.dealAddress ? data.dealAddress.trim() : null,
    lastMessageAt: data.lastMessageAt ? new Date(data.lastMessageAt) : now,
    lastMessagePreview: data.lastMessagePreview || null,
    lastMessageFrom: data.lastMessageFrom ? normalizeWallet(data.lastMessageFrom) : null,
    createdAt: data.createdAt ? new Date(data.createdAt) : now,
    updatedAt: data.updatedAt ? new Date(data.updatedAt) : now,
  };

  const inserted = await db
    .insert(schema.conversations)
    .values(insertData)
    .onConflictDoNothing({
      target: [schema.conversations.participantA, schema.conversations.participantB],
    })
    .returning();
  if (inserted[0]) return { conversation: mapConversation(inserted[0]), created: true };

  const existing = await getConversationByParticipants(participantA, participantB);
  if (!existing) throw new Error('Canonical conversation could not be created or reused');
  return { conversation: existing, created: false };
}

export interface CreateSynqMessageInput {
  id?: string;
  conversationId: string;
  fromWallet: string;
  toWallet: string;
  fromName?: string;
  body?: string;
  kind: SynqMessageKind;
  payload?: SynqMessagePayload | null;
  orderMeta?: Record<string, unknown> | null;
  readAt?: string | Date | null;
  createdAt?: string | Date;
}

/** Persistence helper; API/business callers remain responsible for authorization. */
export async function createSynqMessage(data: CreateSynqMessageInput): Promise<any> {
  const validated = validateTrustedMessageData(data);
  const fromWallet = normalizeWallet(data.fromWallet);
  const toWallet = normalizeWallet(data.toWallet);
  if (!/^0x[0-9a-f]{40}$/.test(fromWallet) || !/^0x[0-9a-f]{40}$/.test(toWallet)) {
    throw new Error('Valid sender and recipient wallets are required');
  }
  if (fromWallet === toWallet) throw new Error('A message recipient must differ from its sender');
  const db = getDb();
  const insertData = {
    id: data.id || genId('messages'),
    conversationId: data.conversationId,
    fromWallet,
    toWallet,
    fromName: data.fromName || null,
    body: validated.body,
    kind: validated.kind,
    payload: validated.payload,
    orderMeta: validated.orderMeta,
    readAt: data.readAt ? new Date(data.readAt) : null,
    createdAt: data.createdAt ? new Date(data.createdAt) : new Date(),
  };

  const rows = await db
    .insert(schema.messages)
    .values(insertData)
    .onConflictDoUpdate({
      target: schema.messages.id,
      set: {
        conversationId: insertData.conversationId,
        fromWallet: insertData.fromWallet,
        toWallet: insertData.toWallet,
        fromName: insertData.fromName,
        body: insertData.body,
        kind: insertData.kind,
        payload: insertData.payload,
        orderMeta: insertData.orderMeta,
        readAt: insertData.readAt,
      },
    })
    .returning();

  return mapMessage(rows[0]);
}

/** Atomically creates/reuses a canonical thread, inserts one trusted file event, and updates activity. */
export async function createCanonicalFileMessage(data: {
  fromWallet: string;
  toWallet: string;
  fromName?: string;
  toName?: string;
  payload: SynqFileMessagePayload;
}): Promise<{ conversation: any; message: any }> {
  const fromWallet = normalizeWallet(data.fromWallet);
  const toWallet = normalizeWallet(data.toWallet);
  const { participantA, participantB } = canonicalizeConversationPair(fromWallet, toWallet);
  const validated = validateTrustedMessageData({ kind: 'file', body: '', payload: data.payload });
  const db = getDb();

  return db.transaction(async (tx) => {
    const now = new Date();
    await tx.insert(schema.conversations).values({
      id: genId('conversations'),
      participantA,
      participantB,
      // Transitional legacy roles only; canonical participants remain authoritative.
      buyerWallet: fromWallet,
      sellerWallet: toWallet,
      buyerName: data.fromName || null,
      sellerName: data.toName || null,
      lastMessageAt: now,
      lastMessagePreview: deriveConversationPreview('file', ''),
      lastMessageFrom: fromWallet,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({
      target: [schema.conversations.participantA, schema.conversations.participantB],
    });

    const conversationRows = await tx.select().from(schema.conversations).where(and(
      eq(schema.conversations.participantA, participantA),
      eq(schema.conversations.participantB, participantB),
    ));
    const conversationRow = conversationRows[0];
    if (!conversationRow) throw new Error('Canonical conversation could not be created or reused');

    const messageRows = await tx.insert(schema.messages).values({
      id: genId('messages'),
      conversationId: conversationRow.id,
      fromWallet,
      toWallet,
      fromName: data.fromName || null,
      body: validated.body,
      kind: validated.kind,
      payload: validated.payload,
      orderMeta: null,
      readAt: null,
      createdAt: now,
    }).returning();

    const updatedRows = await tx.update(schema.conversations).set({
      lastMessageAt: now,
      lastMessagePreview: deriveConversationPreview('file', ''),
      lastMessageFrom: fromWallet,
      updatedAt: now,
    }).where(eq(schema.conversations.id, conversationRow.id)).returning();

    return {
      conversation: mapConversation(updatedRows[0] || conversationRow),
      message: mapMessage(messageRows[0]),
    };
  });
}

/** Atomically creates/reuses a canonical thread and one idempotent, verified Deal receipt event. */
export async function createCanonicalDealReceiptMessage(data: {
  buyerWallet: string;
  sellerWallet: string;
  payload: SynqDealReceiptPayload;
}): Promise<{ conversation: any; message: any; created: boolean }> {
  const buyerWallet = normalizeWallet(data.buyerWallet);
  const sellerWallet = normalizeWallet(data.sellerWallet);
  const { participantA, participantB } = canonicalizeConversationPair(buyerWallet, sellerWallet);
  const validated = validateTrustedMessageData({ kind: 'deal_receipt', body: '', payload: data.payload });
  const receiptId = `deal-receipt:${data.payload.chainId}:${data.payload.dealAddress.toLowerCase()}`;
  const db = getDb();

  return db.transaction(async (tx) => {
    const now = new Date();
    await tx.insert(schema.conversations).values({
      id: genId('conversations'),
      participantA,
      participantB,
      // Transitional legacy roles reflect the verified on-chain Deal roles.
      buyerWallet,
      sellerWallet,
      lastMessageAt: now,
      lastMessagePreview: deriveConversationPreview('deal_receipt', ''),
      lastMessageFrom: buyerWallet,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({
      target: [schema.conversations.participantA, schema.conversations.participantB],
    });

    const conversationRows = await tx.select().from(schema.conversations).where(and(
      eq(schema.conversations.participantA, participantA),
      eq(schema.conversations.participantB, participantB),
    ));
    const conversationRow = conversationRows[0];
    if (!conversationRow) throw new Error('Canonical conversation could not be created or reused');

    const insertedRows = await tx.insert(schema.messages).values({
      id: receiptId,
      conversationId: conversationRow.id,
      fromWallet: buyerWallet,
      toWallet: sellerWallet,
      fromName: null,
      body: validated.body,
      kind: validated.kind,
      payload: validated.payload,
      orderMeta: null,
      readAt: null,
      createdAt: now,
    }).onConflictDoNothing({ target: schema.messages.id }).returning();

    let messageRow = insertedRows[0];
    const created = !!messageRow;
    if (!messageRow) {
      const existingRows = await tx.select().from(schema.messages).where(eq(schema.messages.id, receiptId));
      messageRow = existingRows[0];
      const existingPayload = messageRow?.payload as Record<string, unknown> | null | undefined;
      if (
        !messageRow
        || messageRow.conversationId !== conversationRow.id
        || messageRow.kind !== 'deal_receipt'
        || normalizeWallet(messageRow.fromWallet) !== buyerWallet
        || normalizeWallet(messageRow.toWallet) !== sellerWallet
        || existingPayload?.dealAddress !== data.payload.dealAddress
        || existingPayload?.transactionHash !== data.payload.transactionHash
      ) {
        throw new Error('Deal receipt idempotency conflict');
      }
    } else {
      const updatedRows = await tx.update(schema.conversations).set({
        lastMessageAt: now,
        lastMessagePreview: deriveConversationPreview('deal_receipt', ''),
        lastMessageFrom: buyerWallet,
        updatedAt: now,
      }).where(eq(schema.conversations.id, conversationRow.id)).returning();
      if (updatedRows[0]) Object.assign(conversationRow, updatedRows[0]);
    }

    return {
      conversation: mapConversation(conversationRow),
      message: mapMessage(messageRow),
      created,
    };
  });
}

/** Atomically creates/reuses a canonical thread and one idempotent, verified payment receipt event. */
export async function createCanonicalPaymentReceiptMessage(data: {
  fromWallet: string;
  toWallet: string;
  payload: SynqPaymentReceiptPayload;
}): Promise<{ conversation: any; message: any; created: boolean }> {
  const fromWallet = normalizeWallet(data.fromWallet);
  const toWallet = normalizeWallet(data.toWallet);
  const { participantA, participantB } = canonicalizeConversationPair(fromWallet, toWallet);
  const validated = validateTrustedMessageData({ kind: 'payment_receipt', body: '', payload: data.payload });
  const suffix = data.payload.assetType === 'native' ? 'native' : String(data.payload.transferLogIndex);
  const receiptId = `payment-receipt:${data.payload.chainId}:${data.payload.transactionHash}:${suffix}`;
  const db = getDb();

  return db.transaction(async (tx) => {
    const now = new Date();
    await tx.insert(schema.conversations).values({
      id: genId('conversations'),
      participantA,
      participantB,
      buyerWallet: fromWallet,
      sellerWallet: toWallet,
      lastMessageAt: now,
      lastMessagePreview: deriveConversationPreview('payment_receipt', ''),
      lastMessageFrom: fromWallet,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({
      target: [schema.conversations.participantA, schema.conversations.participantB],
    });

    const conversationRows = await tx.select().from(schema.conversations).where(and(
      eq(schema.conversations.participantA, participantA),
      eq(schema.conversations.participantB, participantB),
    ));
    const conversationRow = conversationRows[0];
    if (!conversationRow) throw new Error('Canonical conversation could not be created or reused');

    const insertedRows = await tx.insert(schema.messages).values({
      id: receiptId,
      conversationId: conversationRow.id,
      fromWallet,
      toWallet,
      fromName: null,
      body: validated.body,
      kind: validated.kind,
      payload: validated.payload,
      orderMeta: null,
      readAt: null,
      createdAt: now,
    }).onConflictDoNothing({ target: schema.messages.id }).returning();

    let messageRow = insertedRows[0];
    const created = !!messageRow;
    if (!messageRow) {
      const existingRows = await tx.select().from(schema.messages).where(eq(schema.messages.id, receiptId));
      messageRow = existingRows[0];
      const existingPayload = messageRow?.payload as Record<string, unknown> | null | undefined;
      if (
        !messageRow
        || messageRow.conversationId !== conversationRow.id
        || messageRow.kind !== 'payment_receipt'
        || normalizeWallet(messageRow.fromWallet) !== fromWallet
        || normalizeWallet(messageRow.toWallet) !== toWallet
        || existingPayload?.transactionHash !== data.payload.transactionHash
        || existingPayload?.chainId !== data.payload.chainId
        || existingPayload?.assetType !== data.payload.assetType
        || existingPayload?.assetAddress !== data.payload.assetAddress
        || existingPayload?.amount !== data.payload.amount
        || existingPayload?.decimals !== data.payload.decimals
        || existingPayload?.symbol !== data.payload.symbol
        || existingPayload?.transferLogIndex !== data.payload.transferLogIndex
        || existingPayload?.note !== data.payload.note
      ) throw new Error('Payment receipt idempotency conflict');
    } else {
      const updatedRows = await tx.update(schema.conversations).set({
        lastMessageAt: now,
        lastMessagePreview: deriveConversationPreview('payment_receipt', ''),
        lastMessageFrom: fromWallet,
        updatedAt: now,
      }).where(eq(schema.conversations.id, conversationRow.id)).returning();
      if (updatedRows[0]) Object.assign(conversationRow, updatedRows[0]);
    }

    return { conversation: mapConversation(conversationRow), message: mapMessage(messageRow), created };
  });
}

export async function create(collection: string, data: any): Promise<any> {
  if (process.env.NODE_ENV !== 'production') {
    if (collection === 'verifications' && _testVerificationsStore) {
      const item = { ...data, id: data.id || genId(collection) };
      _testVerificationsStore.set(item.id, item);
      return item;
    }
  }

  const db = getDb();
  const id = data.id || genId(collection);
  const now = new Date();

  switch (collection) {
    case 'users': {
      const walletAddress = normalizeWallet(data.walletAddress || data.wallet || id);
      const insertData = {
        walletAddress,
        name: data.name || null,
        email: data.email || null,
        avatar: data.avatar || null,
        createdAt: data.createdAt ? new Date(data.createdAt) : now,
        updatedAt: data.updatedAt ? new Date(data.updatedAt) : now,
      };

      const rows = await db
        .insert(schema.users)
        .values(insertData)
        .onConflictDoUpdate({
          target: schema.users.walletAddress,
          set: {
            name: insertData.name,
            email: insertData.email,
            avatar: insertData.avatar,
            updatedAt: insertData.updatedAt,
          },
        })
        .returning();

      return mapUser(rows[0]);
    }
    case 'marketProfiles': {
      const walletAddress = normalizeWallet(data.walletAddress || data.wallet);
      const insertData = {
        id,
        walletAddress,
        headline: data.headline || null,
        secondaryCategories: Array.isArray(data.secondaryCategories) ? data.secondaryCategories : [],
        about: data.about || null,
        typicalDelivery: data.typicalDelivery || null,
        links: typeof data.links === 'object' && data.links !== null ? data.links : {},
        portfolio: Array.isArray(data.portfolio) ? data.portfolio : [],
        draftName: data.draftName || null,
        draftCategory: data.draftCategory || null,
        draftSkills: Array.isArray(data.draftSkills) ? data.draftSkills : [],
        draftRate: data.draftRate || null,
        draftBio: data.draftBio || null,
        startingRateAmount: data.startingRateAmount !== undefined ? (data.startingRateAmount === null ? null : String(data.startingRateAmount)) : null,
        startingRateCurrency: data.startingRateCurrency !== undefined ? (data.startingRateCurrency === null ? null : String(data.startingRateCurrency)) : null,
        startingRateType: data.startingRateType !== undefined ? (data.startingRateType === null ? null : String(data.startingRateType)) : null,
        createdAt: data.createdAt ? new Date(data.createdAt) : now,
        updatedAt: data.updatedAt ? new Date(data.updatedAt) : now,
      };

      const rows = await db
        .insert(schema.marketProfiles)
        .values(insertData)
        .onConflictDoUpdate({
          target: schema.marketProfiles.walletAddress,
          set: {
            headline: insertData.headline,
            secondaryCategories: insertData.secondaryCategories,
            about: insertData.about,
            typicalDelivery: insertData.typicalDelivery,
            links: insertData.links,
            portfolio: insertData.portfolio,
            draftName: insertData.draftName,
            draftCategory: insertData.draftCategory,
            draftSkills: insertData.draftSkills,
            draftRate: insertData.draftRate,
            draftBio: insertData.draftBio,
            startingRateAmount: insertData.startingRateAmount,
            startingRateCurrency: insertData.startingRateCurrency,
            startingRateType: insertData.startingRateType,
            updatedAt: insertData.updatedAt,
          },
        })
        .returning();

      return mapMarketProfile(rows[0]);
    }
    case 'reviews': {
      const insertData = {
        id,
        dealAddress: data.dealAddress?.trim(),
        reviewerWallet: normalizeWallet(data.reviewerWallet),
        sellerWallet: normalizeWallet(data.sellerWallet),
        rating: Math.floor(Number(data.rating)),
        comment: data.comment || null,
        role: data.role || null,
        verifiedDeal: typeof data.verifiedDeal === 'boolean' ? data.verifiedDeal : true,
        createdAt: data.createdAt ? new Date(data.createdAt) : now,
        updatedAt: data.updatedAt ? new Date(data.updatedAt) : now,
      };

      const rows = await db
        .insert(schema.reviews)
        .values(insertData)
        .onConflictDoUpdate({
          target: schema.reviews.dealAddress,
          set: {
            reviewerWallet: insertData.reviewerWallet,
            sellerWallet: insertData.sellerWallet,
            rating: insertData.rating,
            comment: insertData.comment,
            role: insertData.role,
            verifiedDeal: insertData.verifiedDeal,
            updatedAt: insertData.updatedAt,
          },
        })
        .returning();

      return mapReview(rows[0]);
    }
    case 'conversations': {
      return (await getOrCreateCanonicalConversation({ ...data, id })).conversation;
    }
    case 'messages': {
      return createSynqMessage({ ...data, id, kind: data.kind || 'text' });
    }
    case 'verifications': {
      if (data.dealAddress !== undefined || data.milestoneId !== undefined) {
        const insertData = {
          id,
          dealAddress: normalizeWallet(data.dealAddress),
          milestoneId: Number(data.milestoneId),
          completionPct: Number(data.completionPct || 0),
          summary: String(data.summary || ''),
          verified: Boolean(data.verified),
          notes: data.notes ? String(data.notes) : null,
          recommendation: data.recommendation ? String(data.recommendation) : null,
          createdAt: data.createdAt ? new Date(data.createdAt) : now,
          updatedAt: data.updatedAt ? new Date(data.updatedAt) : now,
        };

        const rows = await db
          .insert(schema.milestoneVerifications)
          .values(insertData)
          .onConflictDoUpdate({
            target: schema.milestoneVerifications.id,
            set: {
              completionPct: insertData.completionPct,
              summary: insertData.summary,
              verified: insertData.verified,
              notes: insertData.notes,
              recommendation: insertData.recommendation,
              updatedAt: insertData.updatedAt,
            },
          })
          .returning();

        return mapMilestoneVerification(rows[0]);
      } else {
        const insertData = {
          id,
          email: String(data.email || '').toLowerCase().trim(),
          walletAddress: data.walletAddress ? normalizeWallet(data.walletAddress) : null,
          name: data.name ? String(data.name) : null,
          codeHash: String(data.codeHash || ''),
          attempts: Number(data.attempts || 0),
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : now,
          createdAt: data.createdAt ? new Date(data.createdAt) : now,
          updatedAt: data.updatedAt ? new Date(data.updatedAt) : now,
        };

        const rows = await db
          .insert(schema.emailVerifications)
          .values(insertData)
          .onConflictDoUpdate({
            target: schema.emailVerifications.id,
            set: {
              attempts: insertData.attempts,
              codeHash: insertData.codeHash,
              expiresAt: insertData.expiresAt,
              updatedAt: insertData.updatedAt,
            },
          })
          .returning();

        return mapEmailVerification(rows[0]);
      }
    }
    default: {
      throw new Error(`Unsupported database collection: ${collection}`);
    }
  }
}

export async function update(collection: string, id: string, data: any): Promise<any | null> {
  if (process.env.NODE_ENV !== 'production') {
    if (collection === 'verifications' && _testVerificationsStore) {
      const existing = _testVerificationsStore.get(id) || {};
      const updated = { ...existing, ...data };
      _testVerificationsStore.set(id, updated);
      return updated;
    }
  }

  const db = getDb();
  const now = new Date();

  switch (collection) {
    case 'users': {
      const normalized = normalizeWallet(id);
      const updatePayload: Record<string, any> = { updatedAt: now };
      if (data.name !== undefined) updatePayload.name = data.name;
      if (data.email !== undefined) updatePayload.email = data.email;
      if (data.avatar !== undefined) updatePayload.avatar = data.avatar;

      const rows = await db
        .update(schema.users)
        .set(updatePayload)
        .where(eq(schema.users.walletAddress, normalized))
        .returning();

      return rows[0] ? mapUser(rows[0]) : null;
    }
    case 'marketProfiles': {
      const normalized = normalizeWallet(id);
      const updatePayload: Record<string, any> = { updatedAt: now };
      if (data.headline !== undefined) updatePayload.headline = data.headline;
      if (data.secondaryCategories !== undefined) updatePayload.secondaryCategories = data.secondaryCategories;
      if (data.about !== undefined) updatePayload.about = data.about;
      if (data.typicalDelivery !== undefined) updatePayload.typicalDelivery = data.typicalDelivery;
      if (data.links !== undefined) updatePayload.links = data.links;
      if (data.portfolio !== undefined) updatePayload.portfolio = data.portfolio;
      if (data.draftName !== undefined) updatePayload.draftName = data.draftName;
      if (data.draftCategory !== undefined) updatePayload.draftCategory = data.draftCategory;
      if (data.draftSkills !== undefined) updatePayload.draftSkills = data.draftSkills;
      if (data.draftRate !== undefined) updatePayload.draftRate = data.draftRate;
      if (data.draftBio !== undefined) updatePayload.draftBio = data.draftBio;
      if (data.startingRateAmount !== undefined) updatePayload.startingRateAmount = data.startingRateAmount === null ? null : String(data.startingRateAmount);
      if (data.startingRateCurrency !== undefined) updatePayload.startingRateCurrency = data.startingRateCurrency === null ? null : String(data.startingRateCurrency);
      if (data.startingRateType !== undefined) updatePayload.startingRateType = data.startingRateType === null ? null : String(data.startingRateType);

      const rows = await db
        .update(schema.marketProfiles)
        .set(updatePayload)
        .where(or(eq(schema.marketProfiles.id, id), eq(schema.marketProfiles.walletAddress, normalized)))
        .returning();

      return rows[0] ? mapMarketProfile(rows[0]) : null;
    }
    case 'reviews': {
      const updatePayload: Record<string, any> = { updatedAt: now };
      if (data.reviewerWallet !== undefined) updatePayload.reviewerWallet = normalizeWallet(data.reviewerWallet);
      if (data.sellerWallet !== undefined) updatePayload.sellerWallet = normalizeWallet(data.sellerWallet);
      if (data.rating !== undefined) updatePayload.rating = Math.floor(Number(data.rating));
      if (data.comment !== undefined) updatePayload.comment = data.comment;
      if (data.role !== undefined) updatePayload.role = data.role;
      if (data.verifiedDeal !== undefined) updatePayload.verifiedDeal = data.verifiedDeal;

      const rows = await db
        .update(schema.reviews)
        .set(updatePayload)
        .where(or(eq(schema.reviews.id, id), eq(schema.reviews.dealAddress, id)))
        .returning();

      return rows[0] ? mapReview(rows[0]) : null;
    }
    case 'conversations': {
      const updatePayload: Record<string, any> = { updatedAt: now };
      if (data.participantA !== undefined || data.participantB !== undefined) {
        const pair = canonicalizeConversationPair(data.participantA, data.participantB);
        updatePayload.participantA = pair.participantA;
        updatePayload.participantB = pair.participantB;
      }
      if (data.buyerWallet !== undefined) updatePayload.buyerWallet = normalizeWallet(data.buyerWallet);
      if (data.sellerWallet !== undefined) updatePayload.sellerWallet = normalizeWallet(data.sellerWallet);
      if (data.buyerName !== undefined) updatePayload.buyerName = data.buyerName;
      if (data.sellerName !== undefined) updatePayload.sellerName = data.sellerName;
      if (data.subject !== undefined) updatePayload.subject = data.subject;
      if (data.orderMeta !== undefined) updatePayload.orderMeta = data.orderMeta;
      if (data.dealAddress !== undefined) updatePayload.dealAddress = data.dealAddress;
      if (data.lastMessageAt !== undefined) updatePayload.lastMessageAt = new Date(data.lastMessageAt);
      if (data.lastMessagePreview !== undefined) updatePayload.lastMessagePreview = data.lastMessagePreview;
      if (data.lastMessageFrom !== undefined) updatePayload.lastMessageFrom = normalizeWallet(data.lastMessageFrom);

      const rows = await db
        .update(schema.conversations)
        .set(updatePayload)
        .where(eq(schema.conversations.id, id))
        .returning();

      return rows[0] ? mapConversation(rows[0]) : null;
    }
    case 'messages': {
      const updatePayload: Record<string, any> = {};
      if (data.readAt !== undefined) updatePayload.readAt = data.readAt ? new Date(data.readAt) : null;
      if (data.fromName !== undefined) updatePayload.fromName = data.fromName;
      if (data.body !== undefined) updatePayload.body = data.body;
      if (data.payload !== undefined) updatePayload.payload = data.payload;
      if (data.orderMeta !== undefined) updatePayload.orderMeta = data.orderMeta;

      const rows = await db
        .update(schema.messages)
        .set(updatePayload)
        .where(eq(schema.messages.id, id))
        .returning();

      return rows[0] ? mapMessage(rows[0]) : null;
    }
    case 'verifications': {
      const updateEmailPayload: Record<string, any> = { updatedAt: now };
      if (data.attempts !== undefined) updateEmailPayload.attempts = Number(data.attempts);
      if (data.codeHash !== undefined) updateEmailPayload.codeHash = data.codeHash;
      if (data.expiresAt !== undefined) updateEmailPayload.expiresAt = new Date(data.expiresAt);

      const emailRows = await db
        .update(schema.emailVerifications)
        .set(updateEmailPayload)
        .where(eq(schema.emailVerifications.id, id))
        .returning();

      if (emailRows[0]) return mapEmailVerification(emailRows[0]);

      const updateMsPayload: Record<string, any> = { updatedAt: now };
      if (data.completionPct !== undefined) updateMsPayload.completionPct = Number(data.completionPct);
      if (data.summary !== undefined) updateMsPayload.summary = data.summary;
      if (data.verified !== undefined) updateMsPayload.verified = Boolean(data.verified);
      if (data.notes !== undefined) updateMsPayload.notes = data.notes;
      if (data.recommendation !== undefined) updateMsPayload.recommendation = data.recommendation;

      const msRows = await db
        .update(schema.milestoneVerifications)
        .set(updateMsPayload)
        .where(eq(schema.milestoneVerifications.id, id))
        .returning();

      if (msRows[0]) return mapMilestoneVerification(msRows[0]);
      return null;
    }
    default: {
      return null;
    }
  }
}

export async function remove(collection: string, id: string): Promise<boolean> {
  if (process.env.NODE_ENV !== 'production') {
    if (collection === 'verifications' && _testVerificationsStore) {
      return _testVerificationsStore.delete(id);
    }
  }

  const db = getDb();

  switch (collection) {
    case 'users': {
      const normalized = normalizeWallet(id);
      const rows = await db.delete(schema.users).where(eq(schema.users.walletAddress, normalized)).returning();
      return rows.length > 0;
    }
    case 'marketProfiles': {
      const normalized = normalizeWallet(id);
      const rows = await db
        .delete(schema.marketProfiles)
        .where(or(eq(schema.marketProfiles.id, id), eq(schema.marketProfiles.walletAddress, normalized)))
        .returning();
      return rows.length > 0;
    }
    case 'reviews': {
      const rows = await db
        .delete(schema.reviews)
        .where(or(eq(schema.reviews.id, id), eq(schema.reviews.dealAddress, id)))
        .returning();
      return rows.length > 0;
    }
    case 'conversations': {
      const rows = await db.delete(schema.conversations).where(eq(schema.conversations.id, id)).returning();
      return rows.length > 0;
    }
    case 'messages': {
      const rows = await db.delete(schema.messages).where(eq(schema.messages.id, id)).returning();
      return rows.length > 0;
    }
    case 'verifications': {
      const emailRows = await db
        .delete(schema.emailVerifications)
        .where(eq(schema.emailVerifications.id, id))
        .returning();
      if (emailRows.length > 0) return true;

      const msRows = await db
        .delete(schema.milestoneVerifications)
        .where(eq(schema.milestoneVerifications.id, id))
        .returning();
      return msRows.length > 0;
    }
    default: {
      return false;
    }
  }
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

// ---------------------------------------------------------------------------
// Standard V2 Deal Proposals Persistence Re-exports
// ---------------------------------------------------------------------------
export {
  createDealProposal,
  createCanonicalDealProposalReceiptMessage,
  getDealProposalById,
  getDealProposalByDealAddress,
  getDealProposalByClientNonce,
  updateDealProposalStatus,
  serializeDealProposal,
  type SerializedDealProposal,
  defaultDealProposalRepository,
  DrizzleDealProposalRepository,
  InMemoryDealProposalRepository,
} from '@/lib/deals/proposals-db';
