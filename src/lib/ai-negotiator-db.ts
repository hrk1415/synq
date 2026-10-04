import { isAddress } from 'viem';
import { getDb, schema } from '@/db';
import { normalizeWallet } from '@/lib/utils';
export { getAuthenticatedWallet } from '@/lib/auth';
import { eq, and, sql, desc, asc } from 'drizzle-orm';
import type { AiNegotiatorMessagePayload, AiNegotiatorSuggestion, AiNegotiatorSellerResult, NegotiationStateData } from '@/db/schema';

export const MAX_NEGOTIATOR_CHATS = 10;

export function titleFromMessage(content: string): string {
  const clean = content.replace(/\s+/g, ' ').trim();
  if (!clean) return 'New Chat';
  return clean.length > 42 ? `${clean.slice(0, 42).trimEnd()}…` : clean;
}

export function validatePayload(payload: unknown): { valid: boolean; error?: string; cleaned?: AiNegotiatorMessagePayload } {
  if (payload === undefined || payload === null) {
    return { valid: true, cleaned: undefined };
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, error: 'Payload must be an object' };
  }

  // Serialized payload size limit: max 50 KB (50,000 bytes)
  try {
    const jsonString = JSON.stringify(payload);
    if (jsonString.length > 50_000) {
      return { valid: false, error: 'Payload size exceeds 50 KB limit' };
    }
  } catch {
    return { valid: false, error: 'Payload is not serializable' };
  }

  const obj = payload as Record<string, unknown>;
  const allowedKeys = new Set(['suggestions', 'sellers', 'intent', 'negotiationState', 'attachment', 'pendingClarification', 'resolvedActions']);
  for (const k of Object.keys(obj)) {
    if (!allowedKeys.has(k)) {
      return { valid: false, error: `Unknown field '${k}' in payload` };
    }
  }

  const cleaned: AiNegotiatorMessagePayload = {};

  if ('intent' in obj && typeof obj.intent === 'string') {
    cleaned.intent = obj.intent;
  }

  if ('negotiationState' in obj && obj.negotiationState && typeof obj.negotiationState === 'object') {
    cleaned.negotiationState = obj.negotiationState as any;
  }

  if ('attachment' in obj && obj.attachment && typeof obj.attachment === 'object') {
    cleaned.attachment = obj.attachment as any;
  }

  if ('pendingClarification' in obj) {
    cleaned.pendingClarification = (obj.pendingClarification as any) || null;
  }

  if ('resolvedActions' in obj && Array.isArray(obj.resolvedActions)) {
    cleaned.resolvedActions = obj.resolvedActions as any;
  }

  if ('suggestions' in obj && obj.suggestions !== undefined) {
    if (!Array.isArray(obj.suggestions)) {
      return { valid: false, error: 'suggestions must be an array' };
    }
    if (obj.suggestions.length > 20) {
      return { valid: false, error: 'suggestions array exceeds maximum length of 20' };
    }
    for (const item of obj.suggestions) {
      if (!item || typeof item !== 'object') {
        return { valid: false, error: 'Each suggestion must be an object' };
      }
      const s = item as Record<string, unknown>;
      if (
        typeof s.label !== 'string' ||
        typeof s.amount !== 'number' ||
        typeof s.timeline !== 'string' ||
        typeof s.risk !== 'string' ||
        typeof s.description !== 'string'
      ) {
        return { valid: false, error: 'Invalid suggestion item structure' };
      }
    }
    cleaned.suggestions = obj.suggestions as AiNegotiatorSuggestion[];
  }

  if ('sellers' in obj && obj.sellers !== undefined) {
    if (!Array.isArray(obj.sellers)) {
      return { valid: false, error: 'sellers must be an array' };
    }
    if (obj.sellers.length > 20) {
      return { valid: false, error: 'sellers array exceeds maximum length of 20' };
    }
    for (const item of obj.sellers) {
      if (!item || typeof item !== 'object') {
        return { valid: false, error: 'Each seller must be an object' };
      }
      const sel = item as Record<string, unknown>;
      if (
        typeof sel.wallet !== 'string' ||
        typeof sel.name !== 'string' ||
        typeof sel.category !== 'string' ||
        !Array.isArray(sel.skills) ||
        sel.skills.length > 50 ||
        !sel.skills.every((sk) => typeof sk === 'string') ||
        typeof sel.rate !== 'string' ||
        typeof sel.bio !== 'string' ||
        typeof sel.available !== 'boolean' ||
        typeof sel.match !== 'number'
      ) {
        return { valid: false, error: 'Invalid seller item structure' };
      }
    }
    cleaned.sellers = obj.sellers as AiNegotiatorSellerResult[];
  }

  return { valid: true, cleaned };
}

export async function listAiConversations(wallet: string) {
  const normalized = normalizeWallet(wallet);
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.aiConversations)
    .where(eq(schema.aiConversations.walletAddress, normalized))
    .orderBy(desc(schema.aiConversations.updatedAt));

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
  }));
}

export async function getAiConversationCount(wallet: string): Promise<number> {
  const normalized = normalizeWallet(wallet);
  const db = getDb();
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.aiConversations)
    .where(eq(schema.aiConversations.walletAddress, normalized));
  return count;
}

export async function createAiConversationWithFirstMessage(
  wallet: string,
  content: string
) {
  const normalized = normalizeWallet(wallet);
  const db = getDb();
  const title = titleFromMessage(content);

  return await db.transaction(async (tx) => {
    // Transaction-level advisory lock per wallet to prevent race conditions
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${normalized}))`);

    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.aiConversations)
      .where(eq(schema.aiConversations.walletAddress, normalized));

    if (count >= MAX_NEGOTIATOR_CHATS) {
      return {
        success: false as const,
        reason: 'LIMIT_REACHED' as const,
        count,
        limit: MAX_NEGOTIATOR_CHATS,
      };
    }

    const [conv] = await tx
      .insert(schema.aiConversations)
      .values({
        walletAddress: normalized,
        title,
      })
      .returning();

    const [msg] = await tx
      .insert(schema.aiMessages)
      .values({
        conversationId: conv.id,
        role: 'user',
        content: content.trim(),
      })
      .returning();

    return {
      success: true as const,
      conversation: {
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt instanceof Date ? conv.createdAt.toISOString() : conv.createdAt,
        updatedAt: conv.updatedAt instanceof Date ? conv.updatedAt.toISOString() : conv.updatedAt,
      },
      firstMessage: {
        id: msg.id,
        role: msg.role,
        content: msg.content,
        createdAt: msg.createdAt instanceof Date ? msg.createdAt.toISOString() : msg.createdAt,
      },
      count: count + 1,
      limit: MAX_NEGOTIATOR_CHATS,
    };
  });
}

export async function getAiConversationWithMessages(wallet: string, conversationId: string) {
  const normalized = normalizeWallet(wallet);
  const db = getDb();

  const [conv] = await db
    .select()
    .from(schema.aiConversations)
    .where(
      and(
        eq(schema.aiConversations.id, conversationId),
        eq(schema.aiConversations.walletAddress, normalized)
      )
    );

  if (!conv) return null;

  const msgs = await db
    .select()
    .from(schema.aiMessages)
    .where(eq(schema.aiMessages.conversationId, conversationId))
    .orderBy(asc(schema.aiMessages.createdAt), asc(schema.aiMessages.id));

  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt instanceof Date ? conv.createdAt.toISOString() : conv.createdAt,
    updatedAt: conv.updatedAt instanceof Date ? conv.updatedAt.toISOString() : conv.updatedAt,
    messages: msgs.map((m) => {
      const payload = (m.payload || {}) as AiNegotiatorMessagePayload;
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        suggestions: payload.suggestions || undefined,
        sellers: payload.sellers || undefined,
        attachment: payload.attachment || undefined,
        negotiationState: payload.negotiationState || undefined,
        pendingClarification: payload.pendingClarification || undefined,
        resolvedActions: payload.resolvedActions || undefined,
        createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
      };
    }),
  };
}

export async function deleteAiConversation(wallet: string, conversationId: string): Promise<boolean> {
  const normalized = normalizeWallet(wallet);
  const db = getDb();

  const rows = await db
    .delete(schema.aiConversations)
    .where(
      and(
        eq(schema.aiConversations.id, conversationId),
        eq(schema.aiConversations.walletAddress, normalized)
      )
    )
    .returning();

  return rows.length > 0;
}

export async function appendAiMessage(
  wallet: string,
  conversationId: string,
  role: 'user' | 'ai' | 'system',
  content: string,
  payload?: AiNegotiatorMessagePayload
) {
  const normalized = normalizeWallet(wallet);
  const db = getDb();
  const now = new Date();

  return await db.transaction(async (tx) => {
    const [conv] = await tx
      .select()
      .from(schema.aiConversations)
      .where(
        and(
          eq(schema.aiConversations.id, conversationId),
          eq(schema.aiConversations.walletAddress, normalized)
        )
      );

    if (!conv) return null;

    const [msg] = await tx
      .insert(schema.aiMessages)
      .values({
        conversationId,
        role,
        content: content.trim(),
        payload: payload && Object.keys(payload).length > 0 ? payload : null,
        createdAt: now,
      })
      .returning();

    await tx
      .update(schema.aiConversations)
      .set({ updatedAt: now })
      .where(eq(schema.aiConversations.id, conversationId));

    const p = (msg.payload || {}) as AiNegotiatorMessagePayload;
    return {
      id: msg.id,
      conversationId: msg.conversationId,
      role: msg.role,
      content: msg.content,
      suggestions: p.suggestions || undefined,
      sellers: p.sellers || undefined,
      attachment: p.attachment || undefined,
      negotiationState: p.negotiationState || undefined,
      pendingClarification: p.pendingClarification || undefined,
      resolvedActions: p.resolvedActions || undefined,
      createdAt: msg.createdAt instanceof Date ? msg.createdAt.toISOString() : msg.createdAt,
    };
  });
}

/**
 * Atomic user-message append enforcing turn order (requires conversation tail to be AI or system).
 * Uses a short conversation-scoped transaction advisory lock.
 */
export async function appendUserMessageIfReady(
  wallet: string,
  conversationId: string,
  content: string,
  payload?: AiNegotiatorMessagePayload
) {
  const normalized = normalizeWallet(wallet);
  const db = getDb();
  const now = new Date();

  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`negotiator_conv_${conversationId}`}))`);

    const [conv] = await tx
      .select()
      .from(schema.aiConversations)
      .where(
        and(
          eq(schema.aiConversations.id, conversationId),
          eq(schema.aiConversations.walletAddress, normalized)
        )
      );

    if (!conv) {
      return { success: false as const, reason: 'CONVERSATION_NOT_FOUND' as const };
    }

    const msgs = await tx
      .select()
      .from(schema.aiMessages)
      .where(eq(schema.aiMessages.conversationId, conversationId))
      .orderBy(desc(schema.aiMessages.createdAt), desc(schema.aiMessages.id))
      .limit(1);

    if (msgs.length > 0) {
      const latest = msgs[0];
      if (latest.role === 'user') {
        return { success: false as const, reason: 'CONVERSATION_AWAITING_AI' as const };
      }
    }

    const [msg] = await tx
      .insert(schema.aiMessages)
      .values({
        conversationId,
        role: 'user',
        content: content.trim(),
        payload: payload && Object.keys(payload).length > 0 ? payload : null,
        createdAt: now,
      })
      .returning();

    await tx
      .update(schema.aiConversations)
      .set({ updatedAt: now })
      .where(eq(schema.aiConversations.id, conversationId));

    const p = (msg.payload || {}) as AiNegotiatorMessagePayload;
    return {
      success: true as const,
      message: {
        id: msg.id,
        conversationId: msg.conversationId,
        role: msg.role,
        content: msg.content,
        suggestions: p.suggestions || undefined,
        sellers: p.sellers || undefined,
        createdAt: msg.createdAt instanceof Date ? msg.createdAt.toISOString() : msg.createdAt,
      },
    };
  });
}

/**
 * Atomic AI response insertion enforcing expected user message ID and pending status.
 * Uses a short conversation-scoped transaction advisory lock.
 */
export async function appendAiResponseIfPending(
  wallet: string,
  conversationId: string,
  expectedUserMessageId: string,
  content: string,
  payload?: AiNegotiatorMessagePayload
) {
  const normalized = normalizeWallet(wallet);
  const db = getDb();
  const now = new Date();

  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`negotiator_conv_${conversationId}`}))`);

    const [conv] = await tx
      .select()
      .from(schema.aiConversations)
      .where(
        and(
          eq(schema.aiConversations.id, conversationId),
          eq(schema.aiConversations.walletAddress, normalized)
        )
      );

    if (!conv) {
      return { success: false as const, reason: 'CONVERSATION_NOT_FOUND' as const };
    }

    const msgs = await tx
      .select()
      .from(schema.aiMessages)
      .where(eq(schema.aiMessages.conversationId, conversationId))
      .orderBy(desc(schema.aiMessages.createdAt), desc(schema.aiMessages.id))
      .limit(1);

    if (msgs.length === 0) {
      return { success: false as const, reason: 'NO_MESSAGES' as const };
    }

    const latest = msgs[0];

    if (latest.role === 'ai') {
      const p = (latest.payload || {}) as AiNegotiatorMessagePayload;
      return {
        success: false as const,
        reason: 'AI_RESPONSE_ALREADY_EXISTS' as const,
        existingMessage: {
          id: latest.id,
          conversationId: latest.conversationId,
          role: latest.role,
          content: latest.content,
          suggestions: p.suggestions || undefined,
          sellers: p.sellers || undefined,
          attachment: p.attachment || undefined,
          negotiationState: p.negotiationState || undefined,
          pendingClarification: p.pendingClarification || undefined,
          resolvedActions: p.resolvedActions || undefined,
          createdAt: latest.createdAt instanceof Date ? latest.createdAt.toISOString() : latest.createdAt,
        },
      };
    }

    if (latest.role !== 'user' || latest.id !== expectedUserMessageId) {
      return { success: false as const, reason: 'CONVERSATION_TAIL_CHANGED' as const };
    }

    const [msg] = await tx
      .insert(schema.aiMessages)
      .values({
        conversationId,
        role: 'ai',
        content: content.trim(),
        payload: payload && Object.keys(payload).length > 0 ? payload : null,
        createdAt: now,
      })
      .returning();

    await tx
      .update(schema.aiConversations)
      .set({ updatedAt: now })
      .where(eq(schema.aiConversations.id, conversationId));

    const p = (msg.payload || {}) as AiNegotiatorMessagePayload;
    return {
      success: true as const,
      message: {
        id: msg.id,
        conversationId: msg.conversationId,
        role: msg.role,
        content: msg.content,
        suggestions: p.suggestions || undefined,
        sellers: p.sellers || undefined,
        attachment: p.attachment || undefined,
        negotiationState: p.negotiationState || undefined,
        pendingClarification: p.pendingClarification || undefined,
        resolvedActions: p.resolvedActions || undefined,
        createdAt: msg.createdAt instanceof Date ? msg.createdAt.toISOString() : msg.createdAt,
      },
    };
  });
}

export interface NegotiatorDealHandoff {
  source: 'AI_NEGOTIATOR';
  conversationId: string;
  seller?: `0x${string}`;
  title?: string;
  scope?: string;
  amount?: string;
  asset?: 'ETH' | 'USDC';
  deadline?: string; // YYYY-MM-DD
  paymentStructure?: 'single' | '50-50' | 'custom';
  protectionEnabled: false;
  targetStep?: number;
}

export type HandoffResult =
  | { success: true; handoff: NegotiatorDealHandoff }
  | { success: false; status: number; code: string; error: string };

export async function getNegotiatorDealHandoff(
  wallet: string,
  conversationId: string,
  mode?: string
): Promise<HandoffResult> {
  const normalized = normalizeWallet(wallet);
  const db = getDb();

  // 1. Verify conversation ownership using existing ownership model
  const [conv] = await db
    .select()
    .from(schema.aiConversations)
    .where(
      and(
        eq(schema.aiConversations.id, conversationId),
        eq(schema.aiConversations.walletAddress, normalized)
      )
    );

  if (!conv) {
    return {
      success: false,
      status: 404,
      code: 'CONVERSATION_NOT_FOUND',
      error: 'Negotiated draft not found or inaccessible.',
    };
  }

  // 2. Load conversation messages in canonical order to find the LATEST message containing payload.negotiationState
  const msgs = await db
    .select()
    .from(schema.aiMessages)
    .where(eq(schema.aiMessages.conversationId, conversationId))
    .orderBy(desc(schema.aiMessages.createdAt), desc(schema.aiMessages.id));

  let latestState: NegotiationStateData | null = null;
  let messageCreatedAt: Date | null = null;

  for (const m of msgs) {
    const payload = (m.payload || {}) as AiNegotiatorMessagePayload;
    if (payload.negotiationState) {
      latestState = payload.negotiationState;
      messageCreatedAt = m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt);
      break;
    }
  }

  if (!latestState) {
    return {
      success: false,
      status: 409,
      code: 'DRAFT_NOT_ACTIVE',
      error: 'No negotiation draft exists in this conversation.',
    };
  }

  const st = latestState;

  // 3. EDIT MODE HANDOFF: Allow incomplete drafts and calculate targetStep
  if (mode === 'edit') {
    if (st.draftStatus !== 'ACTIVE') {
      return {
        success: false,
        status: 409,
        code: 'DRAFT_INACTIVE',
        error: 'Negotiation draft is currently inactive.',
      };
    }

    const titleVal = (st.title?.value || '').trim();
    const isTitleValid = Boolean(titleVal && st.title?.status === 'CONFIRMED');

    const sellerWallet = st.seller?.value;
    const isSellerValid = Boolean(sellerWallet && isAddress(sellerWallet) && st.seller?.status === 'CONFIRMED');

    const amountObj = st.amount?.value;
    const numAmount = amountObj?.amount ? parseFloat(String(amountObj.amount)) : 0;
    const isAmountValid = Boolean(amountObj && !isNaN(numAmount) && numAmount > 0 && st.amount?.status === 'CONFIRMED');
    const isAssetValid = Boolean(amountObj?.asset === 'ETH' || amountObj?.asset === 'USDC');

    const scopeVal = (st.scope?.value || '').trim();
    const isScopeValid = Boolean(scopeVal && st.scope?.status === 'CONFIRMED');

    const rawDeadline = st.deadline?.value?.raw || '';
    const isDeadlineConfirmed = Boolean(rawDeadline && st.deadline?.status === 'CONFIRMED');
    const normalizedDeadline = isDeadlineConfirmed ? normalizeHandoffDeadline(rawDeadline, messageCreatedAt || new Date()) : null;

    const payStruct = st.paymentStructure?.value;
    const isPayStructValid = Boolean(payStruct && (payStruct === 'single' || payStruct === '50-50' || payStruct === 'custom') && st.paymentStructure?.status === 'CONFIRMED');

    // Calculate earliest missing wizard step index (0..6) or 7 if complete
    let targetStep: number | undefined;
    if (!isTitleValid) {
      targetStep = 0; // Step 1: Type
    } else if (!isSellerValid) {
      targetStep = 1; // Step 2: Counterparty
    } else if (!isAmountValid || !isAssetValid) {
      targetStep = 2; // Step 3: Budget
    } else if (!isScopeValid) {
      targetStep = 3; // Step 4: Deliverables
    } else if (!isDeadlineConfirmed || !normalizedDeadline) {
      targetStep = 4; // Step 5: Deadline
    } else if (!isPayStructValid) {
      targetStep = 5; // Step 6: Payment
    } else {
      targetStep = 7; // Step 8: Review
    }

    const editHandoff: NegotiatorDealHandoff = {
      source: 'AI_NEGOTIATOR',
      conversationId,
      seller: isSellerValid ? (sellerWallet!.toLowerCase() as `0x${string}`) : undefined,
      title: isTitleValid ? titleVal : undefined,
      scope: isScopeValid ? scopeVal : undefined,
      amount: isAmountValid ? String(amountObj!.amount) : undefined,
      asset: isAssetValid ? amountObj!.asset : undefined,
      deadline: normalizedDeadline || undefined,
      paymentStructure: (isPayStructValid && (payStruct === 'single' || payStruct === '50-50' || payStruct === 'custom')) ? payStruct : undefined,
      protectionEnabled: false,
      targetStep,
    };

    return {
      success: true,
      handoff: editHandoff,
    };
  }

  // 4. DEFAULT COMPLETE HANDOFF: Strictly enforce draft completeness
  if (st.draftStatus !== 'ACTIVE' || !st.isReadyToCreate) {
    return {
      success: false,
      status: 409,
      code: 'DRAFT_INCOMPLETE',
      error: 'This negotiated draft is no longer complete.',
    };
  }

  const sellerWallet = st.seller?.value;
  if (!sellerWallet || st.seller?.status !== 'CONFIRMED' || !isAddress(sellerWallet)) {
    return {
      success: false,
      status: 422,
      code: 'INVALID_SELLER',
      error: 'Draft contains an unverified freelancer wallet address.',
    };
  }

  const title = (st.title?.value || '').trim();
  if (!title || st.title?.status !== 'CONFIRMED') {
    return {
      success: false,
      status: 422,
      code: 'INVALID_TITLE',
      error: 'Draft title is missing or unconfirmed.',
    };
  }

  const scope = (st.scope?.value || '').trim();
  if (!scope || st.scope?.status !== 'CONFIRMED') {
    return {
      success: false,
      status: 422,
      code: 'INVALID_SCOPE',
      error: 'Draft scope is missing or unconfirmed.',
    };
  }

  const amountObj = st.amount?.value;
  const numAmount = amountObj?.amount ? parseFloat(String(amountObj.amount)) : 0;
  if (!amountObj || st.amount?.status !== 'CONFIRMED' || isNaN(numAmount) || numAmount <= 0) {
    return {
      success: false,
      status: 422,
      code: 'INVALID_AMOUNT',
      error: 'Draft budget must be a positive number.',
    };
  }

  const asset = amountObj.asset;
  if (asset !== 'ETH' && asset !== 'USDC') {
    return {
      success: false,
      status: 422,
      code: 'UNSUPPORTED_ASSET',
      error: `Asset '${asset}' is not supported for automated deal handoff.`,
    };
  }

  const rawDeadline = st.deadline?.value?.raw || '';
  if (!rawDeadline || st.deadline?.status !== 'CONFIRMED') {
    return {
      success: false,
      status: 422,
      code: 'INVALID_DEADLINE',
      error: 'Draft deadline is missing or unconfirmed.',
    };
  }

  // Normalize deadline to YYYY-MM-DD using message creation anchor date
  const normalizedDeadline = normalizeHandoffDeadline(rawDeadline, messageCreatedAt || new Date());
  if (!normalizedDeadline) {
    return {
      success: false,
      status: 422,
      code: 'UNRESOLVABLE_DEADLINE',
      error: 'Draft deadline could not be resolved into a valid future date.',
    };
  }

  const payStruct = st.paymentStructure?.value;
  if (!payStruct || (payStruct !== 'single' && payStruct !== '50-50' && payStruct !== 'custom')) {
    return {
      success: false,
      status: 422,
      code: 'INVALID_PAYMENT_STRUCTURE',
      error: 'Draft payment structure is missing or invalid.',
    };
  }

  const handoff: NegotiatorDealHandoff = {
    source: 'AI_NEGOTIATOR',
    conversationId,
    seller: sellerWallet.toLowerCase() as `0x${string}`,
    title,
    scope,
    amount: String(amountObj.amount),
    asset,
    deadline: normalizedDeadline,
    paymentStructure: payStruct,
    protectionEnabled: false,
    targetStep: 7,
  };

  return {
    success: true,
    handoff,
  };
}

export function normalizeHandoffDeadline(rawDeadline: string, anchorDate: Date): string | null {
  const clean = rawDeadline.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return clean;
  }

  let days: number | null = null;
  const daysMatch = clean.match(/(\d+)\s*days?/i);
  const weeksMatch = clean.match(/(\d+)\s*weeks?/i);

  if (daysMatch) {
    days = parseInt(daysMatch[1], 10);
  } else if (weeksMatch) {
    days = parseInt(weeksMatch[1], 10) * 7;
  }

  if (days === null || isNaN(days) || days <= 0) {
    return null;
  }

  const now = new Date();
  const base = anchorDate.getTime() > now.getTime() - 86400 * 1000 ? anchorDate : now;
  const target = new Date(base);
  target.setDate(target.getDate() + days);

  const yyyy = target.getFullYear();
  const mm = String(target.getMonth() + 1).padStart(2, '0');
  const dd = String(target.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
