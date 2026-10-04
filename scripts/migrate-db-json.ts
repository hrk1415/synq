import fs from 'fs';
import path from 'path';
import { loadEnvConfig } from '@next/env';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, schema } from '../src/db';
import { normalizeWallet } from '../src/lib/utils';
import { canonicalizeConversationPair } from '../src/lib/conversation-pair';

interface LegacyUser {
  id?: string;
  walletAddress?: string;
  name?: string;
  email?: string;
  avatar?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface LegacyMarketProfile {
  id?: string;
  walletAddress?: string;
  headline?: string;
  secondaryCategories?: string[];
  about?: string;
  typicalDelivery?: string;
  links?: Record<string, string>;
  portfolio?: Array<any>;
  draftName?: string;
  draftCategory?: string;
  draftSkills?: string[];
  draftRate?: string;
  draftBio?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface LegacyReview {
  id?: string;
  dealAddress?: string;
  reviewerWallet?: string;
  sellerWallet?: string;
  rating?: number;
  comment?: string;
  role?: string;
  verifiedDeal?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface LegacyConversation {
  id?: string;
  buyerWallet?: string;
  sellerWallet?: string;
  subject?: string;
  orderMeta?: Record<string, any>;
  dealAddress?: string;
  lastMessageAt?: string;
  lastMessagePreview?: string;
  lastMessageFrom?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface LegacyMessage {
  id?: string;
  conversationId?: string;
  fromWallet?: string;
  toWallet?: string;
  fromName?: string;
  body?: string;
  kind?: string;
  orderMeta?: Record<string, any>;
  readAt?: string;
  createdAt?: string;
}

interface LegacyDatabase {
  users?: LegacyUser[];
  marketProfiles?: LegacyMarketProfile[];
  reviews?: LegacyReview[];
  conversations?: LegacyConversation[];
  messages?: LegacyMessage[];
}

export async function migrateDbJson() {
  // Explicitly load .env.local configuration before any database initialization or environment checks
  loadEnvConfig(process.cwd());

  const dbFilePath = path.join(process.cwd(), 'data', 'db.json');
  if (!fs.existsSync(dbFilePath)) {
    throw new Error(`data/db.json file not found at ${dbFilePath}`);
  }

  const rawContent = fs.readFileSync(dbFilePath, 'utf-8');
  const legacyDb: LegacyDatabase = JSON.parse(rawContent);

  const rawUsers = Array.isArray(legacyDb.users) ? legacyDb.users : [];
  const rawMarketProfiles = Array.isArray(legacyDb.marketProfiles) ? legacyDb.marketProfiles : [];
  const rawReviews = Array.isArray(legacyDb.reviews) ? legacyDb.reviews : [];
  const rawConversations = Array.isArray(legacyDb.conversations) ? legacyDb.conversations : [];
  const rawMessages = Array.isArray(legacyDb.messages) ? legacyDb.messages : [];

  console.log('--- PREFLIGHT VALIDATION ---');
  console.log(`Audited records to migrate:
  - users: ${rawUsers.length}
  - marketProfiles: ${rawMarketProfiles.length}
  - reviews: ${rawReviews.length}
  - conversations: ${rawConversations.length}
  - messages: ${rawMessages.length}`);

  // 1. Validate Users
  const seenUserWallets = new Set<string>();
  const validatedUsers = rawUsers.map((u, i) => {
    if (!u.walletAddress) throw new Error(`User at index ${i} missing walletAddress`);
    const normalized = normalizeWallet(u.walletAddress);
    if (!normalized) throw new Error(`User at index ${i} has invalid empty walletAddress`);
    if (seenUserWallets.has(normalized)) throw new Error(`Duplicate user wallet in db.json: ${normalized}`);
    seenUserWallets.add(normalized);

    return {
      walletAddress: normalized,
      name: typeof u.name === 'string' ? u.name : null,
      email: typeof u.email === 'string' ? u.email : null,
      avatar: typeof u.avatar === 'string' ? u.avatar : null,
      createdAt: u.createdAt ? new Date(u.createdAt) : new Date(),
      updatedAt: u.updatedAt ? new Date(u.updatedAt) : new Date(),
    };
  });

  // 2. Validate Market Profiles
  const seenMarketWallets = new Set<string>();
  const seenMarketIds = new Set<string>();
  const validatedMarketProfiles = rawMarketProfiles.map((m, i) => {
    if (!m.walletAddress) throw new Error(`Market profile at index ${i} missing walletAddress`);
    const normalized = normalizeWallet(m.walletAddress);
    if (!normalized) throw new Error(`Market profile at index ${i} has invalid walletAddress`);
    if (seenMarketWallets.has(normalized)) throw new Error(`Duplicate marketProfile wallet in db.json: ${normalized}`);
    seenMarketWallets.add(normalized);

    const id = m.id || `MAR-${Date.now()}-${i}`;
    if (seenMarketIds.has(id)) throw new Error(`Duplicate marketProfile ID: ${id}`);
    seenMarketIds.add(id);

    return {
      id,
      walletAddress: normalized,
      headline: typeof m.headline === 'string' ? m.headline : null,
      secondaryCategories: Array.isArray(m.secondaryCategories) ? m.secondaryCategories : [],
      about: typeof m.about === 'string' ? m.about : null,
      typicalDelivery: typeof m.typicalDelivery === 'string' ? m.typicalDelivery : null,
      links: typeof m.links === 'object' && m.links !== null ? m.links : {},
      portfolio: Array.isArray(m.portfolio) ? m.portfolio : [],
      draftName: typeof m.draftName === 'string' ? m.draftName : null,
      draftCategory: typeof m.draftCategory === 'string' ? m.draftCategory : null,
      draftSkills: Array.isArray(m.draftSkills) ? m.draftSkills : [],
      draftRate: typeof m.draftRate === 'string' ? m.draftRate : null,
      draftBio: typeof m.draftBio === 'string' ? m.draftBio : null,
      createdAt: m.createdAt ? new Date(m.createdAt) : new Date(),
      updatedAt: m.updatedAt ? new Date(m.updatedAt) : new Date(),
    };
  });

  // 3. Validate Reviews
  const seenReviewDeals = new Set<string>();
  const seenReviewIds = new Set<string>();
  const validatedReviews = rawReviews.map((r, i) => {
    if (!r.dealAddress) throw new Error(`Review at index ${i} missing dealAddress`);
    const dealAddr = r.dealAddress.trim();
    if (seenReviewDeals.has(dealAddr)) throw new Error(`Duplicate review dealAddress: ${dealAddr}`);
    seenReviewDeals.add(dealAddr);

    if (!r.reviewerWallet) throw new Error(`Review at index ${i} missing reviewerWallet`);
    if (!r.sellerWallet) throw new Error(`Review at index ${i} missing sellerWallet`);
    const rating = Number(r.rating);
    if (isNaN(rating) || rating < 1 || rating > 5) throw new Error(`Review at index ${i} has invalid rating (must be 1-5): ${r.rating}`);

    const id = r.id || `REV-${Date.now()}-${i}`;
    if (seenReviewIds.has(id)) throw new Error(`Duplicate review ID: ${id}`);
    seenReviewIds.add(id);

    return {
      id,
      dealAddress: dealAddr,
      reviewerWallet: normalizeWallet(r.reviewerWallet),
      sellerWallet: normalizeWallet(r.sellerWallet),
      rating: Math.floor(rating),
      comment: typeof r.comment === 'string' ? r.comment : null,
      role: typeof r.role === 'string' ? r.role : null,
      verifiedDeal: typeof r.verifiedDeal === 'boolean' ? r.verifiedDeal : true,
      createdAt: r.createdAt ? new Date(r.createdAt) : new Date(),
      updatedAt: r.updatedAt ? new Date(r.updatedAt) : new Date(),
    };
  });

  // 4. Validate Conversations
  const validConversationIds = new Set<string>();
  const sourceConversationToCanonicalId = new Map<string, string>();
  const canonicalConversationByPair = new Map<string, any>();
  const validatedConversations = rawConversations.map((c, i) => {
    if (!c.id) throw new Error(`Conversation at index ${i} missing id`);
    if (validConversationIds.has(c.id)) throw new Error(`Duplicate conversation ID: ${c.id}`);
    if (!c.buyerWallet || !c.sellerWallet) throw new Error(`Conversation ${c.id} missing buyer or seller wallet`);
    const buyerWallet = normalizeWallet(c.buyerWallet);
    const sellerWallet = normalizeWallet(c.sellerWallet);
    const { participantA, participantB } = canonicalizeConversationPair(buyerWallet, sellerWallet);
    const pairKey = `${participantA}:${participantB}`;

    const existing = canonicalConversationByPair.get(pairKey);
    if (existing) {
      throw new Error(
        `Duplicate canonical conversation pair in db.json: ${existing.id} and ${c.id}. `
        + 'Merge the source conversations and their messages explicitly before importing.',
      );
    }

    validConversationIds.add(c.id);
    sourceConversationToCanonicalId.set(c.id, c.id);

    const validated = {
      id: c.id,
      participantA,
      participantB,
      buyerWallet,
      sellerWallet,
      subject: typeof c.subject === 'string' ? c.subject : null,
      orderMeta: typeof c.orderMeta === 'object' ? c.orderMeta : null,
      dealAddress: typeof c.dealAddress === 'string' ? c.dealAddress.trim() : null,
      lastMessageAt: c.lastMessageAt ? new Date(c.lastMessageAt) : new Date(),
      lastMessagePreview: typeof c.lastMessagePreview === 'string' ? c.lastMessagePreview : null,
      lastMessageFrom: c.lastMessageFrom ? normalizeWallet(c.lastMessageFrom) : null,
      createdAt: c.createdAt ? new Date(c.createdAt) : new Date(),
      updatedAt: c.updatedAt ? new Date(c.updatedAt) : new Date(),
    };
    canonicalConversationByPair.set(pairKey, validated);
    return validated;
  });

  // 5. Validate Messages & Foreign Key Integrity
  const seenMessageIds = new Set<string>();
  const validatedMessages = rawMessages.map((m, i) => {
    if (!m.id) throw new Error(`Message at index ${i} missing id`);
    if (seenMessageIds.has(m.id)) throw new Error(`Duplicate message ID: ${m.id}`);
    seenMessageIds.add(m.id);

    if (!m.conversationId) throw new Error(`Message ${m.id} missing conversationId`);
    const canonicalConversationId = sourceConversationToCanonicalId.get(m.conversationId);
    if (!canonicalConversationId || !validConversationIds.has(canonicalConversationId)) {
      throw new Error(`ORPHAN MESSAGE DETECTED: Message ${m.id} references non-existent conversationId: ${m.conversationId}`);
    }

    if (!m.fromWallet || !m.toWallet) throw new Error(`Message ${m.id} missing fromWallet or toWallet`);
    if (!m.body) throw new Error(`Message ${m.id} missing body`);

    return {
      id: m.id,
      conversationId: canonicalConversationId,
      fromWallet: normalizeWallet(m.fromWallet),
      toWallet: normalizeWallet(m.toWallet),
      fromName: typeof m.fromName === 'string' ? m.fromName : null,
      body: m.body,
      kind: typeof m.kind === 'string' ? m.kind : 'text',
      orderMeta: typeof m.orderMeta === 'object' ? m.orderMeta : null,
      readAt: m.readAt ? new Date(m.readAt) : null,
      createdAt: m.createdAt ? new Date(m.createdAt) : new Date(),
    };
  });

  console.log('Preflight validation passed cleanly. Zero errors found.');

  // Initialize DB client lazily after environment is loaded and preflight passes
  const db = getDb();

  console.log('--- STARTING TRANSACTIONAL IMPORT ---');

  await db.transaction(async (tx) => {
    const destinationConversationIds = new Map<string, string>();
    // 1. Users
    for (const u of validatedUsers) {
      await tx
        .insert(schema.users)
        .values(u)
        .onConflictDoUpdate({
          target: schema.users.walletAddress,
          set: {
            name: u.name,
            email: u.email,
            avatar: u.avatar,
            updatedAt: u.updatedAt,
          },
        });
    }

    // 2. Market Profiles
    for (const m of validatedMarketProfiles) {
      await tx
        .insert(schema.marketProfiles)
        .values(m)
        .onConflictDoUpdate({
          target: schema.marketProfiles.walletAddress,
          set: {
            headline: m.headline,
            secondaryCategories: m.secondaryCategories,
            about: m.about,
            typicalDelivery: m.typicalDelivery,
            links: m.links,
            portfolio: m.portfolio,
            draftName: m.draftName,
            draftCategory: m.draftCategory,
            draftSkills: m.draftSkills,
            draftRate: m.draftRate,
            draftBio: m.draftBio,
            updatedAt: m.updatedAt,
          },
        });
    }

    // 3. Reviews
    for (const r of validatedReviews) {
      await tx
        .insert(schema.reviews)
        .values(r)
        .onConflictDoUpdate({
          target: schema.reviews.dealAddress,
          set: {
            reviewerWallet: r.reviewerWallet,
            sellerWallet: r.sellerWallet,
            rating: r.rating,
            comment: r.comment,
            role: r.role,
            verifiedDeal: r.verifiedDeal,
            updatedAt: r.updatedAt,
          },
        });
    }

    // 4. Conversations
    for (const c of validatedConversations) {
      let imported = await tx
        .insert(schema.conversations)
        .values(c)
        .onConflictDoNothing({
          target: [schema.conversations.participantA, schema.conversations.participantB],
        })
        .returning({ id: schema.conversations.id });

      if (!imported[0]) {
        const existingRows = await tx
          .select()
          .from(schema.conversations)
          .where(and(
            eq(schema.conversations.participantA, c.participantA),
            eq(schema.conversations.participantB, c.participantB),
          ));
        const existing = existingRows[0];
        if (!existing) {
          throw new Error(`Canonical conversation ${c.id} conflicted but could not be resolved`);
        }

        const carriesOrderMetadata = c.orderMeta !== null || existing.orderMeta !== null;
        const sameLegacyRoles = existing.buyerWallet === c.buyerWallet && existing.sellerWallet === c.sellerWallet;
        if (carriesOrderMetadata && !sameLegacyRoles) {
          throw new Error(
            `Conversation ${c.id} conflicts with ${existing.id} under reversed buyer/seller roles while order metadata exists`,
          );
        }
        if (
          c.orderMeta !== null
          && existing.orderMeta !== null
          && JSON.stringify(c.orderMeta) !== JSON.stringify(existing.orderMeta)
        ) {
          throw new Error(`Conversation ${c.id} has conflicting order metadata with ${existing.id}`);
        }
        if (c.dealAddress && existing.dealAddress && c.dealAddress !== existing.dealAddress) {
          throw new Error(`Conversation ${c.id} has conflicting Deal address with ${existing.id}`);
        }

        imported = await tx
          .update(schema.conversations)
          .set({
            subject: c.subject ?? existing.subject,
            orderMeta: c.orderMeta ?? existing.orderMeta,
            dealAddress: c.dealAddress || existing.dealAddress,
            lastMessageAt: c.lastMessageAt,
            lastMessagePreview: c.lastMessagePreview,
            lastMessageFrom: c.lastMessageFrom,
            updatedAt: c.updatedAt,
          })
          .where(eq(schema.conversations.id, existing.id))
          .returning({ id: schema.conversations.id });
      }

      if (!imported[0]?.id) {
        throw new Error(`Conversation ${c.id} could not be imported or resolved by canonical pair`);
      }
      destinationConversationIds.set(c.id, imported[0].id);
    }

    // 5. Messages
    for (const m of validatedMessages) {
      const destinationConversationId = destinationConversationIds.get(m.conversationId);
      if (!destinationConversationId) {
        throw new Error(`Message ${m.id} has no imported canonical conversation for ${m.conversationId}`);
      }
      await tx
        .insert(schema.messages)
        .values({ ...m, conversationId: destinationConversationId })
        .onConflictDoUpdate({
          target: schema.messages.id,
          set: {
            conversationId: destinationConversationId,
            fromWallet: m.fromWallet,
            toWallet: m.toWallet,
            fromName: m.fromName,
            body: m.body,
            kind: m.kind,
            orderMeta: m.orderMeta,
            readAt: m.readAt,
          },
        });
    }
  });

  console.log(`--- IMPORT COMPLETE ---
Imported counts:
  - users: ${validatedUsers.length}
  - marketProfiles: ${validatedMarketProfiles.length}
  - reviews: ${validatedReviews.length}
  - conversations: ${validatedConversations.length}
  - messages: ${validatedMessages.length}`);
}

if (require.main === module) {
  (async () => {
    try {
      await migrateDbJson();
      console.log('Legacy db.json migration completed successfully.');
    } catch (err: any) {
      console.error('Migration failed:', err?.message || err);
      process.exitCode = 1;
    } finally {
      await closeDb();
    }
  })();
}
