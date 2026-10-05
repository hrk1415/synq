import { pgTable, text, timestamp, integer, boolean, jsonb, index, uniqueIndex, check, numeric } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * 1. USERS TABLE
 * Optional off-chain profile data for EVM wallets.
 * Normalized lowercase wallet addresses serve as stable Web3 primary keys.
 */
export const users = pgTable('users', {
  walletAddress: text('wallet_address').primaryKey(),
  name: text('name'),
  email: text('email'),
  avatar: text('avatar'), // Base64 Data URI or image URL string
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check('chk_users_wallet_lower', sql`wallet_address = LOWER(wallet_address)`),
]);

/**
 * 2. MARKET PROFILES TABLE
 * Rich off-chain freelancer profile metadata & draft edits.
 * One market profile per normalized seller wallet.
 * Uses text id defaulting to UUID string to accommodate legacy IDs (MAR-...).
 */
export const marketProfiles = pgTable('market_profiles', {
  id: text('id').$defaultFn(() => crypto.randomUUID()).primaryKey(),
  walletAddress: text('wallet_address').notNull().unique(),
  headline: text('headline'),
  secondaryCategories: jsonb('secondary_categories').$type<string[]>().default([]).notNull(),
  about: text('about'),
  typicalDelivery: text('typical_delivery'),
  links: jsonb('links').$type<Record<string, string>>().default({}).notNull(),
  portfolio: jsonb('portfolio').$type<Array<{ id?: string; title: string; description?: string; image?: string; link?: string; tags?: string[] }>>().default([]).notNull(),
  // Modern USDC starting rate metadata
  startingRateAmount: numeric('starting_rate_amount', { precision: 18, scale: 6 }),
  startingRateCurrency: text('starting_rate_currency'),
  startingRateType: text('starting_rate_type'),
  // Private owner-only draft fields
  draftName: text('draft_name'),
  draftCategory: text('draft_category'),
  draftSkills: jsonb('draft_skills').$type<string[]>().default([]).notNull(),
  draftRate: text('draft_rate'),
  draftBio: text('draft_bio'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check('chk_market_profiles_wallet_lower', sql`wallet_address = LOWER(wallet_address)`),
  check('chk_market_profiles_rate_amount_pos', sql`starting_rate_amount IS NULL OR starting_rate_amount > 0`),
  check('chk_market_profiles_rate_currency_usdc', sql`starting_rate_currency IS NULL OR starting_rate_currency = 'USDC'`),
  check('chk_market_profiles_rate_type_valid', sql`starting_rate_type IS NULL OR starting_rate_type IN ('PER_PROJECT', 'PER_HOUR')`),
]);

/**
 * 3. REVIEWS TABLE
 * Ratings & feedback tied to completed on-chain deals.
 * Unique constraint on deal_address enforces Phase 6A rules (one review per deal).
 * Uses text id defaulting to UUID string to accommodate legacy IDs (REV-...).
 * Includes CHECK constraint enforcing 1 <= rating <= 5.
 */
export const reviews = pgTable('reviews', {
  id: text('id').$defaultFn(() => crypto.randomUUID()).primaryKey(),
  dealAddress: text('deal_address').notNull().unique(),
  reviewerWallet: text('reviewer_wallet').notNull(),
  sellerWallet: text('seller_wallet').notNull(),
  rating: integer('rating').notNull(),
  comment: text('comment'),
  role: text('role'),
  verifiedDeal: boolean('verified_deal').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_reviews_seller_wallet').on(table.sellerWallet),
  index('idx_reviews_reviewer_wallet').on(table.reviewerWallet),
  check('chk_reviews_reviewer_lower', sql`reviewer_wallet = LOWER(reviewer_wallet)`),
  check('chk_reviews_seller_lower', sql`seller_wallet = LOWER(seller_wallet)`),
  check('chk_reviews_rating_range', sql`rating >= 1 AND rating <= 5`),
]);

/**
 * 4. CONVERSATIONS TABLE
 * Neutral 1:1 wallet conversations. Legacy buyer/seller fields remain during
 * the order/Deal transition but are not generic chat identity.
 * Uses text id defaulting to UUID string to accommodate legacy IDs (CON-...).
 * A database unique index enforces one row per canonical unordered wallet pair.
 */
export const conversations = pgTable('conversations', {
  id: text('id').$defaultFn(() => crypto.randomUUID()).primaryKey(),
  participantA: text('participant_a').notNull(),
  participantB: text('participant_b').notNull(),
  buyerWallet: text('buyer_wallet').notNull(),
  sellerWallet: text('seller_wallet').notNull(),
  buyerName: text('buyer_name'),
  sellerName: text('seller_name'),
  subject: text('subject'),
  orderMeta: jsonb('order_meta').$type<Record<string, any>>(),
  dealAddress: text('deal_address'),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }).defaultNow().notNull(),
  lastMessagePreview: text('last_message_preview'),
  lastMessageFrom: text('last_message_from'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('uq_conversations_participant_pair').on(table.participantA, table.participantB),
  index('idx_conversations_participant_b').on(table.participantB),
  index('idx_conversations_buyer').on(table.buyerWallet),
  index('idx_conversations_seller').on(table.sellerWallet),
  index('idx_conversations_deal').on(table.dealAddress),
  check('chk_conv_participant_a_lower', sql`participant_a = LOWER(participant_a)`),
  check('chk_conv_participant_b_lower', sql`participant_b = LOWER(participant_b)`),
  check(
    'chk_conv_participant_order',
    sql`decode(substr(participant_a, 3), 'hex') < decode(substr(participant_b, 3), 'hex')`,
  ),
  check('chk_conv_participant_a_evm', sql`participant_a ~ '^0x[0-9a-f]{40}$'`),
  check('chk_conv_participant_b_evm', sql`participant_b ~ '^0x[0-9a-f]{40}$'`),
  check('chk_conv_buyer_lower', sql`buyer_wallet = LOWER(buyer_wallet)`),
  check('chk_conv_seller_lower', sql`seller_wallet = LOWER(seller_wallet)`),
  check('chk_conv_last_msg_from_lower', sql`last_message_from IS NULL OR last_message_from = LOWER(last_message_from)`),
]);

/**
 * 5. MESSAGES TABLE
 * SynqChat message history.
 * Uses text id defaulting to UUID string to accommodate legacy IDs (MES-...).
 * conversation_id is text foreign key referencing conversations.id.
 * Indexed for deterministic cursor-based pagination (conversation_id, created_at DESC, id DESC) and unread counts.
 */
export const messages = pgTable('messages', {
  id: text('id').$defaultFn(() => crypto.randomUUID()).primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  fromWallet: text('from_wallet').notNull(),
  toWallet: text('to_wallet').notNull(),
  fromName: text('from_name'),
  body: text('body').notNull(),
  kind: text('kind').default('text').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  orderMeta: jsonb('order_meta').$type<Record<string, any>>(), // Legacy order/confirm compatibility only.
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_messages_pagination').on(table.conversationId, table.createdAt.desc(), table.id.desc()),
  index('idx_messages_unread').on(table.toWallet, table.readAt),
  check('chk_msg_from_lower', sql`from_wallet = LOWER(from_wallet)`),
  check('chk_msg_to_lower', sql`to_wallet = LOWER(to_wallet)`),
]);

/**
 * 6. EMAIL VERIFICATIONS TABLE
 * Temporary email OTP challenges for wallet binding and email sign-in.
 * Uses text id defaulting to UUID string to accommodate legacy IDs (VER-...).
 * Indexed by email for rapid lookup during code verification.
 */
export const emailVerifications = pgTable('email_verifications', {
  id: text('id').$defaultFn(() => crypto.randomUUID()).primaryKey(),
  email: text('email').notNull(),
  walletAddress: text('wallet_address'),
  name: text('name'),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').default(0).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_email_verifications_email').on(table.email),
  check('chk_email_verifications_wallet_lower', sql`wallet_address IS NULL OR wallet_address = LOWER(wallet_address)`),
]);

/**
 * 7. MILESTONE VERIFICATIONS TABLE
 * AI evidence & milestone verification reports.
 * Uses text id defaulting to UUID string to accommodate legacy IDs (VER-...).
 * Indexed by deal_address and milestone_id for fast lookup in deal detail view.
 */
export const milestoneVerifications = pgTable('milestone_verifications', {
  id: text('id').$defaultFn(() => crypto.randomUUID()).primaryKey(),
  dealAddress: text('deal_address').notNull(),
  milestoneId: integer('milestone_id').notNull(),
  completionPct: integer('completion_pct').notNull(),
  summary: text('summary').notNull(),
  verified: boolean('verified').default(false).notNull(),
  notes: text('notes'),
  recommendation: text('recommendation'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_milestone_verifications_deal_ms').on(table.dealAddress, table.milestoneId),
  check('chk_milestone_verifications_deal_lower', sql`deal_address = LOWER(deal_address)`),
]);

/**
 * 8. AI CONVERSATIONS TABLE
 * Dedicated persistent AI Negotiator conversations for EVM wallet owners.
 * Uses text id defaulting to UUID string.
 * Indexed by wallet_address and updated_at DESC for recency queries.
 */
export const aiConversations = pgTable('ai_conversations', {
  id: text('id').$defaultFn(() => crypto.randomUUID()).primaryKey(),
  walletAddress: text('wallet_address').notNull(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_ai_conversations_wallet_updated').on(table.walletAddress, table.updatedAt.desc()),
  check('chk_ai_conv_wallet_lower', sql`wallet_address = LOWER(wallet_address)`),
]);

export interface AiNegotiatorSuggestion {
  label: string;
  amount: number;
  timeline: string;
  risk: string;
  description: string;
}

export interface AiNegotiatorSellerResult {
  wallet: string;
  name: string;
  category: string;
  skills: string[];
  rate: string;
  bio: string;
  available: boolean;
  match: number;
  pricing?: {
    amount: string;
    currency: 'USDC';
    rateType: 'PER_PROJECT' | 'PER_HOUR';
  } | null;
}

export interface TermState<T> {
  value: T | null;
  status: 'CONFIRMED' | 'PROPOSED' | 'MISSING';
}

export interface NegotiationStateData {
  draftStatus?: 'INACTIVE' | 'ACTIVE';
  pendingAction?: 'DRAFT_DEAL' | null;
  seller?: TermState<string>;
  sellerName?: string | null;
  title?: TermState<string>;
  scope?: TermState<string>;
  scopeItems?: string[];
  amount?: TermState<{ amount: string; asset: 'ETH' | 'USDC' }>;
  deadline?: TermState<{ raw?: string; timestamp?: number }>;
  paymentStructure?: TermState<'custom' | '50-50' | 'single'>;
  protectionEnabled?: boolean;
  isReadyToCreate?: boolean;
}

export interface AiNegotiatorAttachment {
  type: 'freelancers' | 'deal_receipt';
  sellers?: AiNegotiatorSellerResult[];
  dealDraft?: NegotiationStateData;
}

export type ScalarReferenceField = 'TITLE' | 'BUDGET' | 'DEADLINE' | 'PAYMENT' | 'SELLER';

export type DealReferenceField = ScalarReferenceField | 'SCOPE' | 'SCOPE_ITEM';

export type PendingClarificationOperation =
  | 'SET'
  | 'CHANGE'
  | 'SELECT'
  | 'REMOVE'
  | 'REPLACE'
  | 'ADD'
  | 'CONFIRM';

export type StandardPendingClarificationPayload = {
  operation: 'SET' | 'CHANGE' | 'SELECT' | 'REMOVE' | 'REPLACE';
  targetField: DealReferenceField;
  value?: string;
};

export type AddPendingClarificationPayload = {
  operation: 'ADD';
  targetField: 'UNKNOWN';
  value: string;
  items?: string[];
};

export type ConfirmBudgetPendingPayload = {
  operation: 'CONFIRM';
  targetField: 'BUDGET';
  suggestedAction: 'SET_AMOUNT';
  value: string;
  asset: 'ETH' | 'USDC';
};

export type ConfirmDeadlinePendingPayload = {
  operation: 'CONFIRM';
  targetField: 'DEADLINE';
  suggestedAction: 'SET_DEADLINE';
  value: string;
};

export type ConfirmPaymentPendingPayload = {
  operation: 'CONFIRM';
  targetField: 'PAYMENT';
  suggestedAction: 'SET_PAYMENT_STRUCTURE';
  value: '50-50' | 'single' | 'custom';
};

export type ConfirmPendingClarificationPayload =
  | ConfirmBudgetPendingPayload
  | ConfirmDeadlinePendingPayload
  | ConfirmPaymentPendingPayload;

export type PendingClarificationPayload =
  | StandardPendingClarificationPayload
  | AddPendingClarificationPayload
  | ConfirmPendingClarificationPayload;

export interface ResolvedActionPayload {
  type: string;
  targetField?: DealReferenceField;
  value?: string;
  asset?: string;
  targetItem?: string;
  targetIndex?: number;
  replacementItem?: string;
  items?: string[];
}

export interface AiNegotiatorMessagePayload {
  suggestions?: AiNegotiatorSuggestion[];
  sellers?: AiNegotiatorSellerResult[];
  intent?: string;
  negotiationState?: NegotiationStateData;
  attachment?: AiNegotiatorAttachment;
  pendingClarification?: PendingClarificationPayload | null;
  resolvedActions?: ResolvedActionPayload[];
}


/**
 * 9. AI MESSAGES TABLE
 * Persistent message log for AI Negotiator sessions.
 * Uses text id defaulting to UUID string.
 * conversation_id references ai_conversations.id with ON DELETE CASCADE.
 * Nullable JSONB payload holds structured AI response options (suggestions, sellers).
 * Indexed by conversation_id, created_at ASC, id ASC for deterministic chronological loading.
 */
export const aiMessages = pgTable('ai_messages', {
  id: text('id').$defaultFn(() => crypto.randomUUID()).primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => aiConversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'user' | 'ai' | 'system'
  content: text('content').notNull(),
  payload: jsonb('payload').$type<AiNegotiatorMessagePayload>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_ai_messages_conv_created').on(table.conversationId, table.createdAt.asc(), table.id.asc()),
  check('chk_ai_msg_role_valid', sql`role IN ('user', 'ai', 'system')`),
]);

export type AiConversation = typeof aiConversations.$inferSelect;
export type NewAiConversation = typeof aiConversations.$inferInsert;
export type AiMessage = typeof aiMessages.$inferSelect;
export type NewAiMessage = typeof aiMessages.$inferInsert;

/**
 * 10. DEAL PROPOSALS TABLE (Standard V2)
 * Canonical off-chain persistent store for signed EIP-712 Deal Proposals.
 *
 * CRYPTOGRAPHICALLY BOUND / IMMUTABLE FIELDS:
 * - proposal_id (bytes32 EIP-712 digest = primary key)
 * - proposal_nonce (uint256 client nonce)
 * - chain_id (EIP-712 domain chain ID)
 * - factory_address (EIP-712 domain verifyingContract)
 * - client_wallet (proposer / payer EOA)
 * - freelancer_wallet (designated counterparty)
 * - canonical_usdc (contract USDC token address)
 * - deal_implementation (SynqDealV1 clone implementation)
 * - primary_resolver (primary committee address)
 * - emergency_resolver (emergency committee address)
 * - milestones_hash (keccak256(abi.encode(MilestoneInit[])))
 * - is_protected (false for Standard V2)
 * - protection_module (address(0) for Standard V2)
 * - policy_id (bytes32(0) for Standard V2)
 * - expiry (Unix timestamp uint256)
 * - client_signature (65-byte EOA signature)
 * - total_amount (sum of milestone base units)
 * - milestones (exact JSON preimage for MilestonesInit[])
 * - title, scope (application metadata)
 *
 * MUTABLE LIFECYCLE CACHE FIELDS:
 * - cached_status ('PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED')
 * - deal_address (cloned Deal instance on-chain once accepted)
 * - accepted_tx_hash
 * - declined_tx_hash
 * - cancelled_tx_hash
 * - updated_at
 */
export interface PersistedMilestoneV2 {
  amount: string; // USDC base units (6 decimals) as decimal string
  workDeadline: string; // Unix timestamp in seconds
  reviewWindow: string; // Seconds (3600 to 2592000)
  gracePeriod: string; // Seconds
  specHash: `0x${string}`; // keccak256 hash of criteria
  title?: string;
  description?: string;
}

export const dealProposals = pgTable('deal_proposals', {
  proposalId: text('proposal_id').primaryKey(),
  proposalNonce: numeric('proposal_nonce', { precision: 78, scale: 0 }).notNull(),
  chainId: integer('chain_id').notNull(),
  factoryAddress: text('factory_address').notNull(),

  clientWallet: text('client_wallet').notNull(),
  freelancerWallet: text('freelancer_wallet').notNull(),

  canonicalUsdc: text('canonical_usdc').notNull(),
  dealImplementation: text('deal_implementation').notNull(),
  primaryResolver: text('primary_resolver').notNull(),
  emergencyResolver: text('emergency_resolver').notNull(),

  milestonesHash: text('milestones_hash').notNull(),

  isProtected: boolean('is_protected').notNull(),
  protectionModule: text('protection_module').notNull(),
  policyId: text('policy_id').notNull(),

  expiry: numeric('expiry', { precision: 78, scale: 0 }).notNull(),

  clientSignature: text('client_signature').notNull(),

  title: text('title').notNull(),
  scope: text('scope').notNull(),

  totalAmount: numeric('total_amount', { precision: 78, scale: 0 }).notNull(),
  milestones: jsonb('milestones').$type<PersistedMilestoneV2[]>().notNull(),

  cachedStatus: text('cached_status').default('PENDING').notNull(),

  dealAddress: text('deal_address'),
  acceptedTxHash: text('accepted_tx_hash'),
  declinedTxHash: text('declined_tx_hash'),
  cancelledTxHash: text('cancelled_tx_hash'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('uq_deal_proposals_client_nonce').on(table.chainId, table.factoryAddress, table.clientWallet, table.proposalNonce),
  index('idx_deal_proposals_client').on(table.clientWallet),
  index('idx_deal_proposals_freelancer').on(table.freelancerWallet),
  index('idx_deal_proposals_deal_address').on(table.dealAddress),
  index('idx_deal_proposals_status').on(table.cachedStatus),
  check('chk_deal_proposals_client_lower', sql`client_wallet = LOWER(client_wallet)`),
  check('chk_deal_proposals_freelancer_lower', sql`freelancer_wallet = LOWER(freelancer_wallet)`),
  check('chk_deal_proposals_factory_lower', sql`factory_address = LOWER(factory_address)`),
  check('chk_deal_proposals_deal_addr_lower', sql`deal_address IS NULL OR deal_address = LOWER(deal_address)`),
  check('chk_deal_proposals_status_valid', sql`cached_status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED')`),
]);

export type DealProposalRow = typeof dealProposals.$inferSelect;
export type NewDealProposalRow = typeof dealProposals.$inferInsert;

/**
 * 12. MILESTONE SUBMISSIONS TABLE (Phase 3I-B)
 * Durable off-chain persistence for canonical deliverable evidence manifests.
 * Cryptographically committed on-chain via submitWork(uint256, bytes32).
 *
 * Lifecycle:
 * - 'staged': Freelancer prepared manifest and verified hash; awaiting on-chain submitWork().
 *             Can be updated/replaced by the same freelancer before on-chain confirmation.
 * - 'confirmed': submitWork() confirmed on-chain and verified against MilestoneSubmitted event.
 *                Immutable audit record. Cannot be mutated or replaced.
 */
export type MilestoneSubmissionStatus = 'staged' | 'confirmed';

export const milestoneSubmissions = pgTable('milestone_submissions', {
  id: text('id').$defaultFn(() => crypto.randomUUID()).primaryKey(),
  chainId: integer('chain_id').notNull(),
  dealAddress: text('deal_address').notNull(),
  milestoneId: integer('milestone_id').notNull(),
  version: integer('version').notNull(),
  freelancerWallet: text('freelancer_wallet').notNull(),
  specHash: text('spec_hash').notNull(),
  evidenceRootHash: text('evidence_root_hash').notNull(),
  manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
  status: text('status').$type<MilestoneSubmissionStatus>().default('staged').notNull(),
  txHash: text('tx_hash'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('uq_milestone_submissions_deal_ms_ver').on(
    table.chainId,
    table.dealAddress,
    table.milestoneId,
    table.version
  ),
  index('idx_milestone_submissions_deal').on(table.chainId, table.dealAddress),
  index('idx_milestone_submissions_evidence_hash').on(table.evidenceRootHash),
  index('idx_milestone_submissions_freelancer').on(table.freelancerWallet),
  check('chk_milestone_submissions_deal_lower', sql`deal_address = LOWER(deal_address)`),
  check('chk_milestone_submissions_freelancer_lower', sql`freelancer_wallet = LOWER(freelancer_wallet)`),
  check('chk_milestone_submissions_spec_lower', sql`spec_hash = LOWER(spec_hash)`),
  check('chk_milestone_submissions_evidence_lower', sql`evidence_root_hash = LOWER(evidence_root_hash)`),
  check('chk_milestone_submissions_status_valid', sql`status IN ('staged', 'confirmed')`),
]);

export type MilestoneSubmissionRow = typeof milestoneSubmissions.$inferSelect;
export type NewMilestoneSubmissionRow = typeof milestoneSubmissions.$inferInsert;

/**
 * 13. MILESTONE REVISIONS TABLE (Phase 3K-B)
 * Durable off-chain persistence for canonical revision request manifests.
 * Cryptographically committed on-chain via requestRevision(uint256, bytes32, uint64).
 *
 * Lifecycle:
 * - 'staged': Client prepared feedback and verified reasonHash; awaiting on-chain requestRevision().
 *             Can be updated/replaced by the same client before on-chain confirmation.
 * - 'confirmed': requestRevision() confirmed on-chain and verified against RevisionRequested event.
 *                Immutable audit record. Cannot be mutated or replaced.
 */
export type MilestoneRevisionStatus = 'staged' | 'confirmed';

export const milestoneRevisions = pgTable('milestone_revisions', {
  id: text('id').$defaultFn(() => crypto.randomUUID()).primaryKey(),
  chainId: integer('chain_id').notNull(),
  dealAddress: text('deal_address').notNull(),
  milestoneId: integer('milestone_id').notNull(),
  submissionVersion: integer('submission_version').notNull(),
  clientWallet: text('client_wallet').notNull(),
  freelancerWallet: text('freelancer_wallet').notNull(),
  specHash: text('spec_hash').notNull(),
  evidenceRootHash: text('evidence_root_hash').notNull(),
  reasonHash: text('reason_hash').notNull(),
  manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
  proposedRevisionDeadline: numeric('proposed_revision_deadline', { precision: 78, scale: 0 }).notNull(),
  status: text('status').$type<MilestoneRevisionStatus>().default('staged').notNull(),
  txHash: text('tx_hash'),
  requestedAt: timestamp('requested_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('uq_milestone_revisions_deal_ms_ver').on(
    table.chainId,
    table.dealAddress,
    table.milestoneId,
    table.submissionVersion
  ),
  index('idx_milestone_revisions_deal').on(table.chainId, table.dealAddress),
  index('idx_milestone_revisions_reason_hash').on(table.reasonHash),
  index('idx_milestone_revisions_client').on(table.clientWallet),
  index('idx_milestone_revisions_freelancer').on(table.freelancerWallet),
  check('chk_milestone_revisions_deal_lower', sql`deal_address = LOWER(deal_address)`),
  check('chk_milestone_revisions_client_lower', sql`client_wallet = LOWER(client_wallet)`),
  check('chk_milestone_revisions_freelancer_lower', sql`freelancer_wallet = LOWER(freelancer_wallet)`),
  check('chk_milestone_revisions_spec_lower', sql`spec_hash = LOWER(spec_hash)`),
  check('chk_milestone_revisions_evidence_lower', sql`evidence_root_hash = LOWER(evidence_root_hash)`),
  check('chk_milestone_revisions_reason_lower', sql`reason_hash = LOWER(reason_hash)`),
  check('chk_milestone_revisions_status_valid', sql`status IN ('staged', 'confirmed')`),
]);

export type MilestoneRevisionRow = typeof milestoneRevisions.$inferSelect;
export type NewMilestoneRevisionRow = typeof milestoneRevisions.$inferInsert;

/**
 * 14. MILESTONE DISPUTES TABLE (Phase 3L-B)
 * Durable off-chain persistence for canonical serious dispute manifests.
 * Cryptographically committed on-chain via openSeriousDispute(uint256, bytes32).
 *
 * Lifecycle:
 * - 'staged': Participant prepared explanation and verified reasonHash; awaiting on-chain openSeriousDispute().
 *             Can be updated/replaced by the same participant before on-chain confirmation.
 * - 'confirmed': openSeriousDispute() confirmed on-chain and verified against SeriousDisputeOpened event.
 *                Immutable audit record. Cannot be mutated or replaced.
 */
export type MilestoneDisputeStatus = 'staged' | 'confirmed';

export const milestoneDisputes = pgTable('milestone_disputes', {
  id: text('id').$defaultFn(() => crypto.randomUUID()).primaryKey(),
  chainId: integer('chain_id').notNull(),
  dealAddress: text('deal_address').notNull(),
  milestoneId: integer('milestone_id').notNull(),
  submissionVersion: integer('submission_version').notNull(),
  specHash: text('spec_hash').notNull(),
  evidenceRootHash: text('evidence_root_hash').notNull(),
  openerWallet: text('opener_wallet').notNull(),
  counterpartyWallet: text('counterparty_wallet').notNull(),
  reasonHash: text('reason_hash').notNull(),
  canonicalManifest: jsonb('canonical_manifest').$type<Record<string, unknown>>().notNull(),
  status: text('status').$type<MilestoneDisputeStatus>().default('staged').notNull(),
  txHash: text('tx_hash'),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('uq_milestone_disputes_deal_ms').on(
    table.chainId,
    table.dealAddress,
    table.milestoneId
  ),
  index('idx_milestone_disputes_deal').on(table.chainId, table.dealAddress),
  index('idx_milestone_disputes_reason_hash').on(table.reasonHash),
  index('idx_milestone_disputes_opener').on(table.openerWallet),
  index('idx_milestone_disputes_counterparty').on(table.counterpartyWallet),
  check('chk_milestone_disputes_deal_lower', sql`deal_address = LOWER(deal_address)`),
  check('chk_milestone_disputes_opener_lower', sql`opener_wallet = LOWER(opener_wallet)`),
  check('chk_milestone_disputes_counterparty_lower', sql`counterparty_wallet = LOWER(counterparty_wallet)`),
  check('chk_milestone_disputes_spec_lower', sql`spec_hash = LOWER(spec_hash)`),
  check('chk_milestone_disputes_evidence_lower', sql`evidence_root_hash = LOWER(evidence_root_hash)`),
  check('chk_milestone_disputes_reason_lower', sql`reason_hash = LOWER(reason_hash)`),
  check('chk_milestone_disputes_status_valid', sql`status IN ('staged', 'confirmed')`),
]);

export type MilestoneDisputeRow = typeof milestoneDisputes.$inferSelect;
export type NewMilestoneDisputeRow = typeof milestoneDisputes.$inferInsert;

/**
 * 15. MUTUAL SETTLEMENT PROPOSALS TABLE (Phase 3L-B)
 * Off-chain EIP-712 exchange layer for mutual settlement proposals.
 * Executed on-chain via executeMutualSettlement(proposal, counterpartySignature).
 *
 * Lifecycle:
 * - 'pending': Signed proposal stored off-chain awaiting counterparty execution or proposer cancellation.
 * - 'executed': executeMutualSettlement() executed on-chain with counterparty signature and confirmed.
 * - 'cancelled': Proposer revoked/cancelled proposal on-chain via cancelProposal().
 * - 'expired': Proposal reached validUntil timestamp without execution.
 * - 'invalidated': Milestone reached terminal state through another settlement path.
 */
export type MutualSettlementStatus = 'pending' | 'executed' | 'cancelled' | 'expired' | 'invalidated';

export const mutualSettlementProposals = pgTable('mutual_settlement_proposals', {
  id: text('id').$defaultFn(() => crypto.randomUUID()).primaryKey(),
  chainId: integer('chain_id').notNull(),
  dealAddress: text('deal_address').notNull(),
  milestoneId: integer('milestone_id').notNull(),
  proposerWallet: text('proposer_wallet').notNull(),
  counterpartyWallet: text('counterparty_wallet').notNull(),
  freelancerAmount: numeric('freelancer_amount', { precision: 78, scale: 0 }).notNull(),
  clientAmount: numeric('client_amount', { precision: 78, scale: 0 }).notNull(),
  proposalNonce: numeric('proposal_nonce', { precision: 78, scale: 0 }).notNull(),
  validUntil: numeric('valid_until', { precision: 78, scale: 0 }).notNull(),
  signature: text('signature').notNull(),
  status: text('status').$type<MutualSettlementStatus>().default('pending').notNull(),
  executionTxHash: text('execution_tx_hash'),
  cancellationTxHash: text('cancellation_tx_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('uq_mutual_settlements_nonce').on(
    table.chainId,
    table.dealAddress,
    table.milestoneId,
    table.proposerWallet,
    table.proposalNonce
  ),
  index('idx_mutual_settlements_deal_ms').on(table.chainId, table.dealAddress, table.milestoneId),
  index('idx_mutual_settlements_proposer').on(table.proposerWallet),
  index('idx_mutual_settlements_counterparty').on(table.counterpartyWallet),
  index('idx_mutual_settlements_status').on(table.status),
  check('chk_mutual_settlements_deal_lower', sql`deal_address = LOWER(deal_address)`),
  check('chk_mutual_settlements_proposer_lower', sql`proposer_wallet = LOWER(proposer_wallet)`),
  check('chk_mutual_settlements_counterparty_lower', sql`counterparty_wallet = LOWER(counterparty_wallet)`),
  check('chk_mutual_settlements_status_valid', sql`status IN ('pending', 'executed', 'cancelled', 'expired', 'invalidated')`),
]);

export type MutualSettlementProposalRow = typeof mutualSettlementProposals.$inferSelect;
export type NewMutualSettlementProposalRow = typeof mutualSettlementProposals.$inferInsert;

/**
 * 16. MILESTONE RESOLUTION REPORTS TABLE (Phase 3M-B)
 * Durable off-chain persistence for canonical committee resolution reports.
 * Justification preimage for on-chain proposeMilestoneResolution(...) and executeFinalResolution(...).
 *
 * Lifecycle:
 * - 'staged': Prepared and hashed by an authorized on-chain committee signer.
 *             Can be updated by authorized signers before on-chain confirmation.
 * - 'confirmed': Successfully executed and reconciled against ResolutionProposed or FinalResolutionExecuted events.
 *                Immutable audit record.
 */
export type ResolutionReportPhase = 'INITIAL_RESOLUTION' | 'FINAL_RESOLUTION';
export type MilestoneResolutionReportStatus = 'staged' | 'confirmed';

export const milestoneResolutionReports = pgTable('milestone_resolution_reports', {
  id: text('id').$defaultFn(() => crypto.randomUUID()).primaryKey(),
  chainId: integer('chain_id').notNull(),
  committeeAddress: text('committee_address').notNull(),
  dealAddress: text('deal_address').notNull(),
  milestoneId: integer('milestone_id').notNull(),
  phase: text('phase').$type<ResolutionReportPhase>().notNull(),
  submissionVersion: integer('submission_version').notNull(),
  specHash: text('spec_hash').notNull(),
  evidenceRootHash: text('evidence_root_hash').notNull(),
  freelancerAmount: numeric('freelancer_amount', { precision: 78, scale: 0 }).notNull(),
  clientAmount: numeric('client_amount', { precision: 78, scale: 0 }).notNull(),
  justificationHash: text('justification_hash').notNull(),
  canonicalReport: jsonb('canonical_report').$type<Record<string, unknown>>().notNull(),
  status: text('status').$type<MilestoneResolutionReportStatus>().default('staged').notNull(),
  txHash: text('tx_hash'),
  stagedByWallet: text('staged_by_wallet').notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('uq_milestone_resolution_reports_candidate').on(
    table.chainId,
    table.dealAddress,
    table.milestoneId,
    table.phase,
    table.justificationHash
  ),
  uniqueIndex('uq_milestone_resolution_reports_confirmed').on(
    table.chainId,
    table.dealAddress,
    table.milestoneId,
    table.phase
  ).where(sql`status = 'confirmed'`),
  index('idx_milestone_resolution_reports_deal_ms').on(table.chainId, table.dealAddress, table.milestoneId),
  index('idx_milestone_resolution_reports_justification').on(table.justificationHash),
  index('idx_milestone_resolution_reports_committee').on(table.committeeAddress),
  index('idx_milestone_resolution_reports_staged_by').on(table.stagedByWallet),
  index('idx_milestone_resolution_reports_tx_hash').on(table.txHash),
  check('chk_milestone_resolution_reports_deal_lower', sql`deal_address = LOWER(deal_address)`),
  check('chk_milestone_resolution_reports_committee_lower', sql`committee_address = LOWER(committee_address)`),
  check('chk_milestone_resolution_reports_staged_by_lower', sql`staged_by_wallet = LOWER(staged_by_wallet)`),
  check('chk_milestone_resolution_reports_spec_lower', sql`spec_hash = LOWER(spec_hash)`),
  check('chk_milestone_resolution_reports_evidence_lower', sql`evidence_root_hash = LOWER(evidence_root_hash)`),
  check('chk_milestone_resolution_reports_justification_lower', sql`justification_hash = LOWER(justification_hash)`),
  check('chk_milestone_resolution_reports_phase_valid', sql`phase IN ('INITIAL_RESOLUTION', 'FINAL_RESOLUTION')`),
  check('chk_milestone_resolution_reports_status_valid', sql`status IN ('staged', 'confirmed')`),
]);

export type MilestoneResolutionReportRow = typeof milestoneResolutionReports.$inferSelect;
export type NewMilestoneResolutionReportRow = typeof milestoneResolutionReports.$inferInsert;

/**
 * 17. COMMITTEE RESOLUTION AUTHORIZATIONS TABLE (Phase 3M-C)
 * Stores immutable EIP-712 typed-data authorization records for 2-of-3 committee signatures.
 * Binds directly to a canonical 3M-B milestone resolution report.
 *
 * Status lifecycle:
 * - 'collecting': Actively collecting signatures from verified active committee signers.
 * - 'threshold_ready': Threshold (2 of 3) verified active signer signatures collected and validated.
 * - 'invalidated': Milestone status changed, committee rotated, or nonce became used.
 * - 'expired': Chain timestamp passed validUntil boundary.
 */
export type CommitteeAuthorizationType = 'ResolutionProposalAuth' | 'FinalResolutionAuth';
export type CommitteeAuthorizationStatus = 'collecting' | 'threshold_ready' | 'invalidated' | 'expired' | 'executed';

export const committeeResolutionAuthorizations = pgTable('committee_resolution_authorizations', {
  id: text('id').$defaultFn(() => crypto.randomUUID()).primaryKey(),
  reportId: text('report_id').notNull(),
  chainId: integer('chain_id').notNull(),
  committeeAddress: text('committee_address').notNull(),
  dealAddress: text('deal_address').notNull(),
  milestoneId: integer('milestone_id').notNull(),
  phase: text('phase').$type<ResolutionReportPhase>().notNull(),
  authorizationType: text('authorization_type').$type<CommitteeAuthorizationType>().notNull(),
  resolutionNonce: numeric('resolution_nonce', { precision: 78, scale: 0 }).notNull(),
  validUntil: numeric('valid_until', { precision: 78, scale: 0 }).notNull(),
  committeeEpoch: numeric('committee_epoch', { precision: 78, scale: 0 }).notNull(),
  submissionVersion: integer('submission_version').notNull(),
  specHash: text('spec_hash').notNull(),
  evidenceRootHash: text('evidence_root_hash').notNull(),
  freelancerAmount: numeric('freelancer_amount', { precision: 78, scale: 0 }).notNull(),
  clientAmount: numeric('client_amount', { precision: 78, scale: 0 }).notNull(),
  justificationHash: text('justification_hash').notNull(),
  typedData: jsonb('typed_data').$type<Record<string, unknown>>().notNull(),
  typedDataHash: text('typed_data_hash').notNull(),
  status: text('status').$type<CommitteeAuthorizationStatus>().default('collecting').notNull(),
  createdBySigner: text('created_by_signer').notNull(),
  executionTxHash: text('execution_tx_hash'),
  executedByWallet: text('executed_by_wallet'),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('uq_comm_auth_nonce').on(
    table.chainId,
    table.committeeAddress,
    table.dealAddress,
    table.milestoneId,
    table.phase,
    table.resolutionNonce
  ),
  index('idx_comm_auth_report').on(table.reportId),
  index('idx_comm_auth_deal_ms').on(table.chainId, table.dealAddress, table.milestoneId),
  index('idx_comm_auth_committee').on(table.committeeAddress),
  index('idx_comm_auth_typed_hash').on(table.typedDataHash),
  index('idx_comm_auth_status').on(table.status),
  index('idx_comm_auth_execution_tx').on(table.executionTxHash),
  check('chk_comm_auth_deal_lower', sql`deal_address = LOWER(deal_address)`),
  check('chk_comm_auth_committee_lower', sql`committee_address = LOWER(committee_address)`),
  check('chk_comm_auth_created_by_lower', sql`created_by_signer = LOWER(created_by_signer)`),
  check('chk_comm_auth_executed_by_lower', sql`executed_by_wallet IS NULL OR executed_by_wallet = LOWER(executed_by_wallet)`),
  check('chk_comm_auth_spec_lower', sql`spec_hash = LOWER(spec_hash)`),
  check('chk_comm_auth_evidence_lower', sql`evidence_root_hash = LOWER(evidence_root_hash)`),
  check('chk_comm_auth_justification_lower', sql`justification_hash = LOWER(justification_hash)`),
  check('chk_comm_auth_typed_hash_lower', sql`typed_data_hash = LOWER(typed_data_hash)`),
  check('chk_comm_auth_phase_valid', sql`phase IN ('INITIAL_RESOLUTION', 'FINAL_RESOLUTION')`),
  check('chk_comm_auth_type_valid', sql`authorization_type IN ('ResolutionProposalAuth', 'FinalResolutionAuth')`),
  check('chk_comm_auth_status_valid', sql`status IN ('collecting', 'threshold_ready', 'invalidated', 'expired', 'executed')`),
]);

export type CommitteeResolutionAuthorizationRow = typeof committeeResolutionAuthorizations.$inferSelect;
export type NewCommitteeResolutionAuthorizationRow = typeof committeeResolutionAuthorizations.$inferInsert;

/**
 * 18. COMMITTEE RESOLUTION SIGNATURES TABLE (Phase 3M-C)
 * Stores individual verified EIP-712 signer signatures for an authorization record.
 * Guarantees at most 1 signature per signer per authorization.
 */
export const committeeResolutionSignatures = pgTable('committee_resolution_signatures', {
  id: text('id').$defaultFn(() => crypto.randomUUID()).primaryKey(),
  authorizationId: text('authorization_id').notNull(),
  signerWallet: text('signer_wallet').notNull(),
  signature: text('signature').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('uq_comm_sig_auth_signer').on(table.authorizationId, table.signerWallet),
  index('idx_comm_sig_auth').on(table.authorizationId),
  index('idx_comm_sig_signer').on(table.signerWallet),
  check('chk_comm_sig_wallet_lower', sql`signer_wallet = LOWER(signer_wallet)`),
]);

export type CommitteeResolutionSignatureRow = typeof committeeResolutionSignatures.$inferSelect;
export type NewCommitteeResolutionSignatureRow = typeof committeeResolutionSignatures.$inferInsert;



