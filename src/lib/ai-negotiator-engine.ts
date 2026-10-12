import { isAddress } from 'viem';
import {
  getAISuggestions,
  findSellers,
  getNegotiatorAICompletion,
  getPaymentConsultationDecision,
  getDealAnalyzerDecision,
  getDeadlineFeasibilityDecision,
} from '@/lib/ai';
import { sepoliaPublicClient } from '@/lib/chain';
import { nexotiqRegistryABI, nexotiqDirectoryABI } from '@/lib/contracts/abis';
import { CONTRACT_ADDRESSES } from '@/lib/contracts/addresses';
import {
  getSynqKnowledgeContext,
  resolveProductCapabilities,
  composeProductFactResponse,
  detectPaymentConsultation,
  buildPaymentConsultationPrompt,
  renderPaymentConsultationResponse,
  detectDealAnalyzer,
  buildDealAnalyzerPrompt,
  renderDealAnalyzerResponse,
  detectDeadlineFeasibility,
  buildDeadlineFeasibilityPrompt,
  renderDeadlineFeasibilityResponse,
  detectLiveDataRequirements,
  composeLiveDataBoundaryResponse,
} from '@/lib/synq-knowledge';
import type {
  AiNegotiatorSuggestion,
  AiNegotiatorSellerResult,
  AiNegotiatorMessagePayload,
  NegotiationStateData,
  TermState,
  AiNegotiatorAttachment,
  PendingClarificationPayload,
  PendingClarificationOperation,
  ResolvedActionPayload,
  DealReferenceField,
  ScalarReferenceField,
} from '@/db/schema';


declare module '@/db/schema' {
  interface AiNegotiatorSellerResult {
    completedDeals?: number;
  }
}

const LOOKS_LIKE_SELLER_SEARCH = /find|suggest|recommend|marketplace|freelancer|freelance|seller|hire|someone|khoj|khuje|darkar|dorkar|lagbe|chai|looking for|developer|designer|expert|koto\s+(pai|chete|chai)/i;

export interface NegotiatorContextMessage {
  role: 'user' | 'ai' | 'assistant';
  content: string;
  payload?: AiNegotiatorMessagePayload | null;
}

export interface GenerateNegotiationInput {
  currentPrompt: string;
  messages: NegotiatorContextMessage[];
  previousNegotiationState?: NegotiationStateData;
}

export interface AiNegotiationResult {
  message: string;
  suggestions?: AiNegotiatorSuggestion[];
  sellers?: AiNegotiatorSellerResult[];
  intent?: string;
  negotiationState?: NegotiationStateData;
  attachment?: AiNegotiatorAttachment;
  pendingClarification?: PendingClarificationPayload | null;
  resolvedActions?: ResolvedActionPayload[];
  rawResult?: any;
}

export type MissingDraftTerm = 'seller' | 'title' | 'scope' | 'amount' | 'deadline' | 'paymentStructure' | null;

export type NegotiationFieldChange =
  | 'seller'
  | 'title'
  | 'scope'
  | 'amount'
  | 'deadline'
  | 'paymentStructure'
  | null;

export function detectNegotiationDelta(
  prev: NegotiationStateData | undefined,
  curr: NegotiationStateData
): { changes: NegotiationFieldChange[]; count: number } {
  if (!prev) return { changes: [], count: 0 };
  const changes: NegotiationFieldChange[] = [];

  if (prev.seller?.value !== curr.seller?.value || prev.sellerName !== curr.sellerName) {
    changes.push('seller');
  }
  if (prev.title?.value !== curr.title?.value) {
    changes.push('title');
  }
  if (prev.scope?.value !== curr.scope?.value) {
    changes.push('scope');
  }
  if (
    prev.amount?.value?.amount !== curr.amount?.value?.amount ||
    prev.amount?.value?.asset !== curr.amount?.value?.asset
  ) {
    changes.push('amount');
  }
  if (prev.deadline?.value?.raw !== curr.deadline?.value?.raw) {
    changes.push('deadline');
  }
  if (prev.paymentStructure?.value !== curr.paymentStructure?.value) {
    changes.push('paymentStructure');
  }

  return { changes, count: changes.length };
}

export type HandleResolutionResult =
  | {
      status: 'RESOLVED';
      handle: string;
      wallet: `0x${string}`;
      name: string;
    }
  | {
      status: 'NOT_FREELANCER';
      handle: string;
      wallet: `0x${string}`;
    }
  | {
      status: 'NOT_FOUND';
      handle: string;
    }
  | {
      status: 'READ_ERROR';
      handle: string;
    };

export type NegotiationTermKey =
  | 'seller'
  | 'title'
  | 'scope'
  | 'amount'
  | 'deadline'
  | 'paymentStructure';

export function getMissingNegotiationTerms(state: NegotiationStateData): NegotiationTermKey[] {
  const missing: NegotiationTermKey[] = [];
  if (!state.seller?.value || state.seller.status === 'MISSING') missing.push('seller');
  if (!state.title?.value || state.title.status === 'MISSING') missing.push('title');
  if (!state.scope?.value || state.scope.status === 'MISSING') missing.push('scope');
  if (!state.amount?.value || state.amount.status === 'MISSING') missing.push('amount');
  if (!state.deadline?.value || state.deadline.status === 'MISSING') missing.push('deadline');
  if (!state.paymentStructure?.value || state.paymentStructure.status === 'MISSING') missing.push('paymentStructure');
  return missing;
}

export interface DraftReadinessResult {
  missingTerms: NegotiationTermKey[];
  termsComplete: boolean;
  draftStatus: 'ACTIVE' | 'INACTIVE';
  readyToCreate: boolean;
  userFacingText?: string;
}

export function getDraftReadiness(state: NegotiationStateData): DraftReadinessResult {
  const missingTerms = getMissingNegotiationTerms(state);
  const termsComplete = missingTerms.length === 0;
  const draftStatus = state.draftStatus === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
  const readyToCreate = termsComplete && draftStatus === 'ACTIVE';

  const readiness: DraftReadinessResult = {
    missingTerms,
    termsComplete,
    draftStatus,
    readyToCreate,
  };
  readiness.userFacingText = renderMissingTermsAnswer(readiness);
  return readiness;
}

export function renderMissingTermsAnswer(readiness: DraftReadinessResult): string {
  if (readiness.readyToCreate) {
    return "No deal terms are missing. The draft is active and ready to create.";
  }
  if (readiness.termsComplete && readiness.draftStatus !== 'ACTIVE') {
    return "No terms are missing, but the draft is currently inactive. Activate the draft when you're ready to proceed.";
  }

  const termLabels: Record<NegotiationTermKey, string> = {
    seller: 'freelancer',
    title: 'title',
    scope: 'scope',
    amount: 'budget',
    deadline: 'deadline',
    paymentStructure: 'payment structure',
  };
  const missingLabels = readiness.missingTerms.map((k) => termLabels[k]);
  let missingStr = '';
  if (missingLabels.length === 1) {
    missingStr = `the ${missingLabels[0]}`;
  } else if (missingLabels.length === 2) {
    missingStr = `the ${missingLabels[0]} and ${missingLabels[1]}`;
  } else {
    const last = missingLabels.pop();
    missingStr = `${missingLabels.join(', ')}, and ${last}`;
  }

  if (readiness.draftStatus !== 'ACTIVE') {
    return `The missing terms are ${missingStr}. The draft is also inactive, so once those terms are set, activate the draft before proceeding.`;
  }
  return `The missing terms are ${missingStr}. Provide those details to complete the draft.`;
}

export function renderReadinessAnswer(readiness: DraftReadinessResult): string {
  if (readiness.readyToCreate) {
    return "Yes, the deal draft is complete and active. You can create the deal now.";
  }
  if (readiness.termsComplete && readiness.draftStatus !== 'ACTIVE') {
    return "Not yet. All terms are set, but the draft is currently inactive. Activate the draft when you're ready to proceed.";
  }

  const termLabels: Record<NegotiationTermKey, string> = {
    seller: 'freelancer',
    title: 'title',
    scope: 'scope',
    amount: 'budget',
    deadline: 'deadline',
    paymentStructure: 'payment structure',
  };
  const missingLabels = readiness.missingTerms.map((k) => termLabels[k]);
  let missingStr = '';
  if (missingLabels.length === 1) {
    missingStr = `a ${missingLabels[0]}`;
  } else if (missingLabels.length === 2) {
    missingStr = `a ${missingLabels[0]} and ${missingLabels[1]}`;
  } else {
    const last = missingLabels.pop();
    missingStr = `${missingLabels.map((l) => 'a ' + l).join(', ')}, and a ${last}`;
  }

  if (readiness.draftStatus !== 'ACTIVE') {
    return `Not yet. You still need to choose ${missingStr}, and the draft is currently inactive. Once those are resolved and the draft is activated, it will be ready to proceed.`;
  }
  return `Not yet. You still need to choose ${missingStr}. Once those details are set, it will be ready to proceed.`;
}

export function getNextMissingDraftTerm(state: NegotiationStateData): MissingDraftTerm {
  if (state.draftStatus !== 'ACTIVE') return null;
  const missing = getMissingNegotiationTerms(state);
  return (missing[0] as MissingDraftTerm) ?? null;
}

export type WalletFreelancerResolutionResult =
  | {
      status: 'RESOLVED';
      wallet: `0x${string}`;
      name: string;
    }
  | {
      status: 'NOT_FREELANCER';
      wallet: `0x${string}`;
    }
  | {
      status: 'READ_ERROR';
      wallet: `0x${string}`;
    };

/**
 * Validates whether an Ethereum wallet is registered as a freelancer in NexotiqDirectory.
 */
async function resolveWalletFreelancer(walletLower: `0x${string}`): Promise<WalletFreelancerResolutionResult> {
  try {
    const directoryAddress = CONTRACT_ADDRESSES.sepolia.NexotiqDirectory as `0x${string}`;
    const profiles = (await sepoliaPublicClient.readContract({
      address: directoryAddress,
      abi: nexotiqDirectoryABI,
      functionName: 'getAllProfiles',
    })) as any[];

    const foundProfile = (profiles || []).find(
      (p) => p && p.wallet && String(p.wallet).toLowerCase() === walletLower
    );

    if (foundProfile) {
      return {
        status: 'RESOLVED',
        wallet: walletLower,
        name: String(foundProfile.name || walletLower),
      };
    } else {
      return {
        status: 'NOT_FREELANCER',
        wallet: walletLower,
      };
    }
  } catch (dirErr) {
    console.error('Directory profile check error:', dirErr);
    return {
      status: 'READ_ERROR',
      wallet: walletLower,
    };
  }
}

/**
 * Resolves a Synq handle (@handle) to its canonical on-chain wallet address using NexotiqRegistry,
 * and verifies that the wallet is a registered freelancer in NexotiqDirectory.
 */
async function resolveHandleToWallet(handleRaw: string): Promise<HandleResolutionResult> {
  const cleanHandle = handleRaw.replace(/^@/, '').trim();
  if (!cleanHandle || cleanHandle.length < 3) {
    return { status: 'NOT_FOUND', handle: cleanHandle };
  }

  try {
    const registryAddress = CONTRACT_ADDRESSES.sepolia.NexotiqRegistry as `0x${string}`;
    const result = (await sepoliaPublicClient.readContract({
      address: registryAddress,
      abi: nexotiqRegistryABI,
      functionName: 'getAddress',
      args: [cleanHandle],
    })) as string;

    if (
      result &&
      typeof result === 'string' &&
      isAddress(result) &&
      result.toLowerCase() !== '0x0000000000000000000000000000000000000000'
    ) {
      const walletLower = result.toLowerCase() as `0x${string}`;
      const dirRes = await resolveWalletFreelancer(walletLower);

      if (dirRes.status === 'RESOLVED') {
        return {
          status: 'RESOLVED',
          handle: cleanHandle,
          wallet: walletLower,
          name: dirRes.name,
        };
      } else if (dirRes.status === 'NOT_FREELANCER') {
        return {
          status: 'NOT_FREELANCER',
          handle: cleanHandle,
          wallet: walletLower,
        };
      } else {
        return {
          status: 'READ_ERROR',
          handle: cleanHandle,
        };
      }
    }

    return { status: 'NOT_FOUND', handle: cleanHandle };
  } catch (err) {
    console.error('Handle resolution readContract error:', err);
    return { status: 'READ_ERROR', handle: cleanHandle };
  }
}

/**
 * Extracts a non-authoritative candidate seller display name from user prose for formulation of clarification questions.
 * Isolates single/double-word name tokens (e.g. "Ali", "John") and stops before structural keywords or punctuation.
 */
function extractCandidateSellerName(text: string): string | null {
  if (/0x[0-9a-fA-F]{40}/.test(text) || /@([a-zA-Z0-9_]{3,32})\b/.test(text)) {
    return null;
  }

  const match = text.match(
    /(?:draft\s+(?:a\s+)?deal\s+with|create\s+(?:a\s+)?deal\s+with|deal\s+with|hire|use|select|pick|go\s+with|with)\s+([A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+)?)/i
  );

  if (!match) return null;

  let candidate = match[1].trim();
  const stopWords = ['for', 'to', 'on', 'at', 'with', 'budget', 'deadline', 'landing', 'react', 'web3', 'app', 'design', 'logo', 'eth', 'usdc', '1st', '2nd', '3rd', 'first', 'second', 'third'];
  const words = candidate.split(/\s+/);
  const cleanWords: string[] = [];
  for (const w of words) {
    if (stopWords.includes(w.toLowerCase())) break;
    cleanWords.push(w);
  }

  const result = cleanWords.join(' ').replace(/[.,!?]+$/, '').trim();
  return result.length > 0 ? result : null;
}

export type ScopeOperation =
  | { type: 'replace'; value: string; items: string[] }
  | { type: 'add'; value: string; items: string[]; addedCount?: number; addedItems?: string[] }
  | { type: 'remove'; value: string; items: string[]; targetItem?: string; targetIndex?: number; removedCount: number }
  | { type: 'clear'; value: ''; items: string[] }
  | null;

export type NegotiatorPrimaryIntent =
  | 'INFORMATIONAL_QUESTION'
  | 'GENERAL_CONVERSATION'
  | 'FIND_FREELANCER'
  | 'SELECT_FREELANCER'
  | 'MODIFY_TERMS'
  | 'CANCEL_DRAFT'
  | 'ACTIVATE_DRAFT'
  | 'CONFIRM_TERMS'
  | 'REVIEW_DRAFT';

export type NegotiatorInformationalRequest =
  | 'WHY_INACTIVE'
  | 'CURRENT_BUDGET'
  | 'CURRENT_SCOPE'
  | 'CURRENT_DEADLINE'
  | 'CURRENT_PAYMENT_STRUCTURE'
  | 'CURRENT_FREELANCER'
  | 'HYPOTHETICAL_PAYMENT'
  | 'MISSING_TERMS'
  | 'CHECK_READINESS'
  | 'GENERAL';

export type LifecycleReason = 'NOT_STARTED' | 'USER_CANCELLED' | 'ACTIVE';

export type NegotiatorTurnActionType =
  | 'CANCEL_DRAFT'
  | 'ACTIVATE_DRAFT'
  | 'SEARCH_FREELANCERS'
  | 'SELECT_FREELANCER'
  | 'SET_AMOUNT'
  | 'CLEAR_AMOUNT'
  | 'UNSUPPORTED_ASSET'
  | 'AMBIGUOUS_ASSET'
  | 'MISSING_ASSET'
  | 'SET_DEADLINE'
  | 'CLEAR_DEADLINE'
  | 'SET_PAYMENT_STRUCTURE'
  | 'CLEAR_PAYMENT_STRUCTURE'
  | 'CLEAR_SELLER'
  | 'SET_TITLE'
  | 'CLEAR_TITLE'
  | 'REPLACE_SCOPE'
  | 'ADD_SCOPE'
  | 'REMOVE_SCOPE'
  | 'CLEAR_SCOPE'
  | 'REPLACE_SCOPE_ITEM'
  | 'REQUEST_CLARIFICATION'
  | 'CONFIRM_TERMS'
  | 'REVIEW_DRAFT';

export interface NegotiatorTurnAction {
  type: NegotiatorTurnActionType;
  payload?: any;
}

export interface NegotiatorTurnClassification {
  primaryIntent: NegotiatorPrimaryIntent;
  informationalRequests: NegotiatorInformationalRequest[];
  informationalClauses: string[];
  actions: NegotiatorTurnAction[];
}

export type BudgetParseResult =
  | { type: 'VALID'; amount: string; asset: 'ETH' | 'USDC' }
  | { type: 'UNSUPPORTED_ASSET'; amount: string; asset: string }
  | { type: 'AMBIGUOUS_ASSET'; amount: string; symbol: string }
  | { type: 'MISSING_ASSET'; amount: string }
  | null;

/**
 * Deterministic parser for budget/amount operations and asset validation.
 * Shared between classifyUserTurn and extractNegotiationState to prevent classification/reconstruction divergence.
 */
export function parseBudgetOperation(clause: string): BudgetParseResult {
  if (!clause || typeof clause !== 'string') return null;
  const trimmed = clause.trim();
  if (isInformationalQuestion(trimmed) || isConditionalCommand(trimmed)) return null;

  // Destructive operations must never be interpreted as positive budget mutations
  const isDestructive = /^(?:please\s+)?(?:remove|drop|delete|clear|reset|discard|take\s+out)\b/i.test(trimmed);
  if (isDestructive) return null;

  // Pattern 1: Explicit supported native ETH / Ethereum
  const ethMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*(?:eth|ethereum)\b/i);
  if (ethMatch) {
    return { type: 'VALID', amount: ethMatch[1], asset: 'ETH' };
  }

  // Pattern 2: Explicit supported USDC
  const usdcMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*usdc\b/i);
  if (usdcMatch) {
    return { type: 'VALID', amount: usdcMatch[1], asset: 'USDC' };
  }

  // Pattern 3: Ambiguous dollar symbol ($500 or 500$)
  const dollarMatch = trimmed.match(/(?:^|\s)\$(\d+(?:\.\d+)?)\b/i) || trimmed.match(/(\d+(?:\.\d+)?)\s*\$/i);
  if (dollarMatch) {
    return { type: 'AMBIGUOUS_ASSET', amount: dollarMatch[1], symbol: '$' };
  }

  // Pattern 4: Explicit unsupported token / fiat currency symbol attached to a number
  // e.g. 50 USDT, 1 BTC, 500 DAI, 20 SOL, 500 EUR, 500 USD, 100 XYZ
  const explicitTokenMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*([a-zA-Z]{2,10})\b/i);
  if (explicitTokenMatch) {
    const rawAmount = explicitTokenMatch[1];
    const rawSymbol = explicitTokenMatch[2].toUpperCase();

    // Stop-words list for non-asset unit words
    const NON_ASSET_UNITS = new Set([
      'DAY', 'DAYS', 'WEEK', 'WEEKS', 'HOUR', 'HOURS', 'MONTH', 'MONTHS', 'YEAR', 'YEARS',
      'FEATURE', 'FEATURES', 'PAGE', 'PAGES', 'VERSION', 'VERSIONS', 'DEAL', 'DEALS',
      'MILESTONE', 'MILESTONES', 'PERCENT', 'PCT', 'FIRST', 'SECOND', 'THIRD', 'ONE', 'TWO'
    ]);

    if (!NON_ASSET_UNITS.has(rawSymbol)) {
      if (rawSymbol === 'ETH' || rawSymbol === 'ETHEREUM') {
        return { type: 'VALID', amount: rawAmount, asset: 'ETH' };
      }
      if (rawSymbol === 'USDC') {
        return { type: 'VALID', amount: rawAmount, asset: 'USDC' };
      }
      return { type: 'UNSUPPORTED_ASSET', amount: rawAmount, asset: rawSymbol };
    }
  }

  // Pattern 5: Assetless budget command (e.g., "set budget to 500", "change budget to 100")
  const isBudgetCmd = /(?:set|change|update|make|put|specify|raise|lower|adjust)?\s*(?:the\s+)?(?:budget|amount|price|cost|fee)\s*(?:to|is|=|of|at)?\s*(\d+(?:\.\d+)?)\b/i.test(trimmed);
  if (isBudgetCmd) {
    const numMatch = trimmed.match(/(?:budget|amount|price|cost|fee)\s*(?:to|is|=|of|at)?\s*(\d+(?:\.\d+)?)\b/i);
    if (numMatch) {
      return { type: 'MISSING_ASSET', amount: numMatch[1] };
    }
  }

  return null;
}

/**
 * Pure deterministic parser for live payment structure commands and phrases.
 * Returns canonical '50-50' | 'single' | 'custom' or null if unsupported.
 */
function parsePaymentStructure(input: string): '50-50' | 'single' | 'custom' | null {
  if (!input || typeof input !== 'string') return null;
  const clean = input.trim();
  if (/(?:50-50|50\/50|half and half)/i.test(clean)) return '50-50';
  if (/(?:single release|single payment|upfront|100% at end|single)/i.test(clean)) return 'single';
  if (/(?:custom milestone|custom payment)/i.test(clean)) return 'custom';
  return null;
}

const CALENDAR_MONTH_MAP: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const CALENDAR_MONTH_NAMES_PATTERN =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

/**
 * Pure deterministic parser and calendar validator for explicit-year deadline dates.
 * Accepts dates with explicit 4-digit years (2000-2099) in month-first, day-first, or ISO format.
 * Validates actual calendar correctness (including leap years) via integer arithmetic.
 * Returns canonical "YYYY-MM-DD" if valid, or null if invalid or not an explicit-year calendar date.
 */
export function parseExplicitCalendarDeadline(input: string): string | null {
  if (!input || typeof input !== 'string') return null;
  const clean = input
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/[.,;]+$/, '')
    .trim();
  if (!clean) return null;

  let year = 0;
  let month = 0;
  let day = 0;

  // 1. ISO format: YYYY-MM-DD
  const isoMatch = clean.match(/^(20\d{2})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])$/);
  if (isoMatch) {
    year = parseInt(isoMatch[1], 10);
    month = parseInt(isoMatch[2], 10);
    day = parseInt(isoMatch[3], 10);
  } else {
    // 2. Month-first format: e.g. "October 20, 2026", "Oct 20th 2026", "October 20 2026"
    const monthFirstMatch = clean.match(
      new RegExp(`^(${CALENDAR_MONTH_NAMES_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,)?\\s+(20\\d{2})$`, 'i')
    );
    if (monthFirstMatch) {
      const rawMonth = monthFirstMatch[1].toLowerCase();
      month = CALENDAR_MONTH_MAP[rawMonth] || 0;
      day = parseInt(monthFirstMatch[2], 10);
      year = parseInt(monthFirstMatch[3], 10);
    } else {
      // 3. Day-first format: e.g. "20 October 2026", "20th Oct 2026", "20 Oct, 2026"
      const dayFirstMatch = clean.match(
        new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(${CALENDAR_MONTH_NAMES_PATTERN})(?:,)?\\s+(20\\d{2})$`, 'i')
      );
      if (dayFirstMatch) {
        day = parseInt(dayFirstMatch[1], 10);
        const rawMonth = dayFirstMatch[2].toLowerCase();
        month = CALENDAR_MONTH_MAP[rawMonth] || 0;
        year = parseInt(dayFirstMatch[3], 10);
      }
    }
  }

  if (!year || !month || !day) return null;
  if (year < 2000 || year > 2099) return null;
  if (month < 1 || month > 12) return null;

  // Pure integer arithmetic leap-year & days-in-month validation (no JS Date APIs)
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  let maxDays = 31;
  if (month === 2) {
    maxDays = isLeapYear ? 29 : 28;
  } else if (month === 4 || month === 6 || month === 9 || month === 11) {
    maxDays = 30;
  }

  if (day < 1 || day > maxDays) return null;

  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${year}-${pad(month)}-${pad(day)}`;
}

export type ClausePolarity = 'AFFIRMATIVE' | 'NEGATED';

export interface InterpretedClause {
  rawText: string;
  normalizedText: string;
  quotedLiterals: string[];
  polarity: ClausePolarity;
  isKeep: boolean;
  hasInstead: boolean;
  hasActually: boolean;
}

interface QuotedSpan {
  start: number;
  end: number;
  raw: string;
  content: string;
  delimiter: '"' | "'" | '`';
}

/**
 * Deterministically scans text for genuine quoted spans (double, single, backtick).
 * Prevents English contractions and possessives (e.g. don't, it's, what's, buyer's)
 * from acting as single-quote delimiters.
 */
function findQuotedSpans(text: string): QuotedSpan[] {
  if (!text || typeof text !== 'string') return [];
  const spans: QuotedSpan[] = [];
  const len = text.length;
  let i = 0;

  while (i < len) {
    const ch = text[i];

    if (ch === '"' || ch === '`') {
      const delim = ch;
      const start = i;
      i++; // skip opening delimiter
      let content = '';
      let closed = false;

      while (i < len) {
        if (text[i] === '\\' && i + 1 < len) {
          content += text[i] + text[i + 1];
          i += 2;
        } else if (text[i] === delim) {
          closed = true;
          i++; // skip closing delimiter
          break;
        } else {
          content += text[i];
          i++;
        }
      }

      if (closed) {
        spans.push({
          start,
          end: i,
          raw: text.slice(start, i),
          content,
          delimiter: delim,
        });
      }
    } else if (ch === "'") {
      // Opening single quote: must NOT be preceded by an alphanumeric/word character (e.g. don't, it's, buyer's)
      const prevChar = i > 0 ? text[i - 1] : '';
      const isWordBefore = /[a-zA-Z0-9_]/.test(prevChar);

      if (!isWordBefore) {
        const start = i;
        i++; // skip opening single quote
        let content = '';
        let closed = false;

        while (i < len) {
          if (text[i] === '\\' && i + 1 < len) {
            content += text[i] + text[i + 1];
            i += 2;
          } else if (text[i] === "'") {
            // Check if this single quote is an intra-word apostrophe (e.g. "Client's" inside 'Client's Website')
            const nextChar = i + 1 < len ? text[i + 1] : '';
            const isWordAfter = /[a-zA-Z0-9_]/.test(nextChar);
            if (isWordAfter) {
              content += text[i];
              i++;
            } else {
              closed = true;
              i++; // skip closing single quote
              break;
            }
          } else {
            content += text[i];
            i++;
          }
        }

        if (closed) {
          spans.push({
            start,
            end: i,
            raw: text.slice(start, i),
            content,
            delimiter: "'",
          });
        }
      } else {
        // Intra-word apostrophe (don't, buyer's), advance past it
        i++;
      }
    } else {
      i++;
    }
  }

  return spans;
}

export function extractQuotedLiterals(text: string): string[] {
  if (!text || typeof text !== 'string') return [];
  return findQuotedSpans(text).map((s) => s.content);
}

export function interpretClause(clause: string): InterpretedClause {
  const rawText = clause || '';
  const normalizedText = rawText.trim();
  const quotedLiterals = extractQuotedLiterals(normalizedText);

  // Check for explicit negation: don't, dont, do not, should not, shouldn't, cannot, can't, wouldn't, won't, never
  const isNegated = /\b(?:don'?t|do\s+not|should\s+not|shouldn'?t|cannot|can'?t|would\s+not|wouldn'?t|won'?t|never)\b/i.test(normalizedText);

  // Check for explicit keep: keep, leave, maintain, retain
  const isKeep = /\b(?:keep|leave|maintain|retain)\b/i.test(normalizedText);

  const hasInstead = /\binstead\b/i.test(normalizedText);
  const hasActually = /\bactually\b/i.test(normalizedText);

  return {
    rawText,
    normalizedText,
    quotedLiterals,
    polarity: isNegated ? 'NEGATED' : 'AFFIRMATIVE',
    isKeep,
    hasInstead,
    hasActually,
  };
}

function getActionScalarDomain(type: NegotiatorTurnActionType): string | null {
  if (type === 'SET_AMOUNT' || type === 'CLEAR_AMOUNT') return 'BUDGET';
  if (type === 'SET_DEADLINE' || type === 'CLEAR_DEADLINE') return 'DEADLINE';
  if (type === 'SET_TITLE' || type === 'CLEAR_TITLE') return 'TITLE';
  if (type === 'SET_PAYMENT_STRUCTURE' || type === 'CLEAR_PAYMENT_STRUCTURE') return 'PAYMENT';
  if (type === 'SELECT_FREELANCER' || type === 'CLEAR_SELLER') return 'SELLER';
  return null;
}

export function normalizeTurnActions(actions: NegotiatorTurnAction[]): NegotiatorTurnAction[] {
  if (!actions || actions.length <= 1) return actions || [];

  const result: NegotiatorTurnAction[] = [];
  const seenDomains = new Set<string>();

  for (let i = actions.length - 1; i >= 0; i--) {
    const act = actions[i];
    const domain = getActionScalarDomain(act.type);
    if (domain) {
      if (!seenDomains.has(domain)) {
        seenDomains.add(domain);
        result.unshift(act);
      }
    } else {
      result.unshift(act);
    }
  }

  return result;
}

/**
 * Pure deterministic helper to separate explicit compound command clauses
 * before term-specific parsers consume them.
 */
export function segmentCommandClauses(text: string): string[] {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Quote-masking: Protect quoted strings (double, single, backtick) from clause splitting
  const spans = findQuotedSpans(trimmed);
  const quotes: string[] = [];
  let maskedText = '';
  let lastIndex = 0;
  for (const span of spans) {
    maskedText += trimmed.slice(lastIndex, span.start);
    const idx = quotes.length;
    quotes.push(span.raw);
    maskedText += `__QUOTE_PLACEHOLDER_${idx}__`;
    lastIndex = span.end;
  }
  maskedText += trimmed.slice(lastIndex);

  // Decimal-masking: Protect numeric decimals (e.g., 0.2, 10.25, .5, .25) from period-based clause splitting
  const decimals: string[] = [];
  maskedText = maskedText.replace(/(?:\b\d+\.\d+|(?<![\w.])\.\d+\b)/g, (match) => {
    const idx = decimals.length;
    decimals.push(match);
    return `__DECIMAL_PLACEHOLDER_${idx}__`;
  });

  const COMMAND_VERB_PATTERN = /(?:\b(?:set|change|replace|update|make|add|include|remove|drop|clear|reset|delete|find|search|show|suggest|recommend|select|pick|choose|use|hire|cancel|stop|discard|deactivate|draft|create|start|prepare|activate|active|reactivate|reopen|resume|continue|undo|don'?t|dont|do\s+not|keep|leave|maintain|actually|instead)\b)/i;
  const INFORMATIONAL_STARTER_PATTERN = /(?:\b(?:what|what's|why|how|who|when|which|where|is|are|does|do|can\s+(?:you|i|we)|could\s+(?:you|i|we)|would\s+you|should|tell\s+me|explain|compare|describe|walk\s+me\s+through|give\s+me\s+(?:an?|the)\s+overview(?:\s+of)?|help\s+me\s+understand|analyze)\b)/i;
  const CLAUSE_BOUNDARY_PATTERN = new RegExp(`(?:${COMMAND_VERB_PATTERN.source}|${INFORMATIONAL_STARTER_PATTERN.source})`, 'i');

  // Split on sentence boundaries (. ? ! ;), sequential "then" transitions, conjunctions (and, also, but, or commas) followed by a command verb or informational question starter, or correction boundary
  const splitRegex = new RegExp(`(?:[.?!;]+\\s*|\\s*(?:(?:,|\\band\\b|\\balso\\b|\\bbut\\b)\\s+)?\\bthen\\b\\s+(?=${CLAUSE_BOUNDARY_PATTERN.source})|\\s*(?:,|\\band\\b|\\balso\\b|\\bbut\\b)\\s+(?=${CLAUSE_BOUNDARY_PATTERN.source})|,\\s*actually\\s+|\\s+actually\\s+)`, 'gi');
  const clauses = maskedText.split(splitRegex).map((c) => c.trim()).filter(Boolean);

  // Unmask quotes and decimals in resulting clauses
  const unmaskedClauses = clauses.map((clause) => {
    let unmasked = clause.replace(/__QUOTE_PLACEHOLDER_(\d+)__/g, (_, numStr) => {
      const quoteIndex = parseInt(numStr, 10);
      return quotes[quoteIndex] !== undefined ? quotes[quoteIndex] : '';
    });
    unmasked = unmasked.replace(/__DECIMAL_PLACEHOLDER_(\d+)__/g, (_, numStr) => {
      const decimalIndex = parseInt(numStr, 10);
      return decimals[decimalIndex] !== undefined ? decimals[decimalIndex] : '';
    });
    return unmasked;
  });

  return unmaskedClauses.length > 0 ? unmaskedClauses : [trimmed];
}

/**
 * Pure deterministic classifier for conditional commands.
 * Identifies phrasing like "if so", "if that's okay", "if reasonable" that must remain read-only.
 */
export function isConditionalCommand(clause: string): boolean {
  if (!clause) return false;
  const trimmed = clause.trim();
  return /(?:if\s+(?:so|that'?s?\s+(?:ok|okay|fine|good|work)|you\s+think|reasonable|appropriate|it\s+works)|depending\s+on\s+your\s+recommendation)/i.test(trimmed);
}

/**
 * Pure deterministic detector for explicit informational requests within turn prose.
 */
export function detectInformationalRequests(text: string): NegotiatorInformationalRequest[] {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  const requests: NegotiatorInformationalRequest[] = [];

  if (/(?:why\s+(?:is\s+)?(?:my\s+|the\s+)?draft\s+inactive|why\s+is\s+it\s+inactive|why\s+(?:is\s+)?(?:this|the)\s+draft\s+not\s+active)/i.test(trimmed)) {
    requests.push('WHY_INACTIVE');
  }

  if (/(?:what(?:'s|\s+is)\s+(?:the\s+)?(?:current\s+)?budget|show\s+me\s+(?:the\s+)?(?:current\s+)?budget|what\s+is\s+the\s+budget)/i.test(trimmed)) {
    requests.push('CURRENT_BUDGET');
  }

  if (/(?:what(?:'s|\s+is)\s+(?:the\s+)?(?:current\s+)?scope|show\s+me\s+(?:the\s+)?(?:current\s+)?scope|what\s+does\s+the\s+scope\s+include|what\s+is\s+in\s+(?:the\s+)?scope)/i.test(trimmed)) {
    requests.push('CURRENT_SCOPE');
  }

  if (/(?:what(?:'s|\s+is)\s+(?:the\s+)?(?:current\s+)?deadline|show\s+me\s+(?:the\s+)?(?:current\s+)?deadline)/i.test(trimmed)) {
    requests.push('CURRENT_DEADLINE');
  }

  if (/(?:what(?:'s|\s+is)\s+(?:the\s+)?(?:current\s+)?payment|show\s+me\s+(?:the\s+)?(?:current\s+)?payment)/i.test(trimmed)) {
    requests.push('CURRENT_PAYMENT_STRUCTURE');
  }

  if (/(?:why\s+is\s+@?\w+\s+selected|who\s+(?:is\s+)?(?:the\s+)?(?:selected\s+)?(?:freelancer|developer|seller)|why\s+is\s+.*?\s+selected)/i.test(trimmed)) {
    requests.push('CURRENT_FREELANCER');
  }

  if (/(?:what\s+terms|what\s+is\s+missing|what\s+do\s+we\s+(?:still\s+)?need|what\s+is\s+incomplete|show\s+me\s+what'?s?\s+incomplete|incomplete\s+terms)/i.test(trimmed)) {
    requests.push('MISSING_TERMS');
  }

  if (/(?:is\s+(?:this\s+|the\s+)?(?:deal|draft)\s+ready|can\s+i\s+proceed|are\s+we\s+ready)/i.test(trimmed)) {
    requests.push('CHECK_READINESS');
  }

  if (requests.length === 0 && isInformationalQuestion(trimmed)) {
    requests.push('GENERAL');
  }

  return requests;
}

/**
 * Canonical draft-activation detector.
 * Evaluates whether text matches explicit activation/reactivation intent.
 */
export function isExplicitDraftActivation(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();

  // Direct activation verbs with target or standalone phrase
  if (/(?:activate|active|reactivate|reopen|resume|continue|start|undo)\s+(?:it|the\s+draft|draft|this\s+draft|the\s+deal|deal|this\s+deal|the\s+cancellation|cancellation)/i.test(trimmed)) {
    return true;
  }
  if (/^(?:activate|active|reactivate|reopen|resume)\s*(?:it|the\s+draft|this\s+draft|draft)?$/i.test(trimmed)) {
    return true;
  }
  if (/undo\s+the\s+cancellation/i.test(trimmed)) {
    return true;
  }
  if (/start\s+(?:the\s+)?draft\s+again/i.test(trimmed)) {
    return true;
  }
  if (
    /^(?:please\s+)?(?:draft|create|start|set up|prepare|build)\s+(?:a\s+|the\s+)?(?:deal|agreement|order|receipt)\b/i.test(trimmed) ||
    /let'?s\s+(?:make\s+this\s+a\s+deal|draft\s+it)|use\s+these\s+terms\s+and\s+create|draft\s+this\s+for\s+me/i.test(trimmed)
  ) {
    return true;
  }

  return false;
}

/**
 * Helper to identify parser artifacts produced from title command phrasing.
 * Distinguishes command artifacts like 'title "Web Design".' from legitimate deliverables like 'updating page title and metadata'.
 */
export function isTitleCommandArtifact(str: string): boolean {
  if (!str) return false;
  const trimmed = str.trim().replace(/[.\s]+$/, '');

  if (/^(?:the\s+)?title\s+["'`].+?["'`]$/i.test(trimmed)) return true;
  if (/^(?:please\s+)?(?:set|change|update|add|make)\s+(?:the\s+)?title\s+(?:to|=|is)?\s+["'`]?.+?["'`]?$/i.test(trimmed)) return true;
  if (/^(?:call\s+(?:the\s+)?deal|title\s+it)\s+["'`]?.+?["'`]?$/i.test(trimmed)) return true;
  if (
    /^(?:please\s+)?(?:add|set|change|update|make|put|use)\s+["'`]?.+?["'`]?\s+(?:as|to|for|in|into)\s+(?:the\s+)?title$/i.test(
      trimmed
    )
  ) {
    return true;
  }

  const parsedTitle = parseTitleOperation(trimmed);
  if (
    parsedTitle &&
    (trimmed.toLowerCase().startsWith('title ') ||
      trimmed.toLowerCase().startsWith('the title ') ||
      /\b(?:to|as|for|in|into)\s+(?:the\s+)?title$/i.test(trimmed.toLowerCase()))
  ) {
    return true;
  }

  return false;
}

/**
 * Pure deterministic guard to reject non-deliverable vague placeholders from scope deliverables.
 */
export function isVagueScopePlaceholder(str: string): boolean {
  if (!str) return true;
  const cleaned = str.trim().toLowerCase().replace(/[.\s]+$/, '');
  const PLACEHOLDERS = new Set([
    'something',
    'anything',
    'something else',
    'anything else',
    'some work',
    'a thing',
    'the thing',
    'thing',
    'stuff',
    'whatever',
    'that',
    'it',
    'a feature',
    'the feature',
    'feature',
    'some feature',
    'some features',
  ]);
  return PLACEHOLDERS.has(cleaned);
}

/**
 * Cleans an individual scope item by stripping trailing command target phrases
 * (e.g., "to the scope", "in scope", "to the deliverables").
 */
export function cleanSingleScopeItem(item: string): string {
  if (!item) return '';
  let cleaned = item.trim();
  // Repair historical scope command pollution artifacts (including compound command trailing clauses and optional conversational suffixes)
  cleaned = cleaned
    .replace(/\s+(?:to|in|into)\s+(?:the\s+)?(?:scope|deliverables|requirements|contract)(?:\s+(?:and|also|,)\s+(?:make|set|change|update|add|remove|find|search|cancel).*)*[.\s]*$/i, '')
    .replace(/\s+(?:to|in|into)\s+(?:the\s+)?(?:scope|deliverables|requirements|contract)(?:\s+(?:too|as\s+well|also|please|only|for\s+this\s+deal|for\s+the\s+deal))?[.\s]*$/i, '')
    .replace(/\s+and\s+(?:make|set|change|update|add|remove|find|search|cancel)\s+the\s+deadline.*$/i, '')
    .trim();

  // Strip leading/trailing conversational command modifiers like "only", "too", "please"
  cleaned = cleaned
    .replace(/^(?:only|please)\s+/i, '')
    .replace(/\s+(?:only|too|as\s+well|also|please)$/i, '')
    .trim();

  // Strip wrapping quotes if present
  cleaned = cleaned.replace(/^["'`](.*)["'`]$/, '$1').trim();

  // Strip conversational command modifiers again if they sat outside outer quotes (e.g. '"Landing page" only')
  cleaned = cleaned
    .replace(/^(?:only|please)\s+/i, '')
    .replace(/\s+(?:only|too|as\s+well|also|please)$/i, '')
    .trim();

  cleaned = cleaned.replace(/[.\s]+$/, '').trim();

  if (isTitleCommandArtifact(cleaned) || isVagueScopePlaceholder(cleaned)) {
    return '';
  }

  return cleaned;
}

/**
 * Cleans user input text or scope string by stripping leading/trailing command prose and punctuation.
 */
export function cleanScopeText(raw: string): string {
  if (!raw) return '';
  const cleaned = cleanSingleScopeItem(raw);
  return cleaned ? `${cleaned}.` : '';
}

/**
 * Deterministic helper to parse individual scope items or quoted literals.
 * If the string contains comma/semicolon list enumeration (e.g., "Landing page, dashboard, and wallet integration"),
 * splits it into individual scope items while handling terminal list conjunctions (e.g. ", and ").
 * If no list punctuation (comma/semicolon) is present (e.g., "login and wallet integration"),
 * preserves the literal atomically.
 */
export function parseQuotedScopeLiteral(literal: string): string[] {
  if (!literal) return [];
  const cleaned = cleanSingleScopeItem(literal);
  if (!cleaned) return [];

  // Check if string contains explicit list enumeration punctuation (, or ;)
  const hasListPunctuation = /[,;]/.test(cleaned);
  if (!hasListPunctuation) {
    return [cleaned];
  }

  // Split on commas or semicolons
  const parts = cleaned
    .split(/[,;]+/)
    .map((part) => {
      let p = part.trim();
      p = p.replace(/^(?:and|&)\s+/i, '').trim();
      return cleanSingleScopeItem(p);
    })
    .filter(Boolean);

  return parts.length > 0 ? parts : [cleaned];
}

export function splitScopeItems(scopeStr: string): string[] {
  if (!scopeStr || typeof scopeStr !== 'string') return [];
  const trimmed = scopeStr.trim();
  if (!trimmed) return [];

  // Quote-masking: Protect quoted strings from unquoted comma/and splitting
  const spans = findQuotedSpans(trimmed);
  const quotes: string[] = [];
  let masked = '';
  let lastIndex = 0;
  for (const span of spans) {
    masked += trimmed.slice(lastIndex, span.start);
    const idx = quotes.length;
    quotes.push(span.content);
    masked += `__SCOPE_QUOTE_MASK_${idx}__`;
    lastIndex = span.end;
  }
  masked += trimmed.slice(lastIndex);

  const resultItems: string[] = [];
  const topLevelParts = masked.split(/,|\band\b|&/i);

  for (const part of topLevelParts) {
    const hasQuoteMask = part.includes('__SCOPE_QUOTE_MASK_');
    const unmasked = part.replace(/__SCOPE_QUOTE_MASK_(\d+)__/g, (_, numStr) => {
      const idx = parseInt(numStr, 10);
      return quotes[idx] !== undefined ? quotes[idx] : '';
    });

    const partTrimmed = unmasked.trim().replace(/^and\s+/i, '');
    if (!partTrimmed) continue;

    if (hasQuoteMask) {
      const expanded = parseQuotedScopeLiteral(partTrimmed);
      resultItems.push(...expanded);
    } else {
      const cleaned = cleanSingleScopeItem(partTrimmed);
      if (cleaned) {
        resultItems.push(cleaned);
      }
    }
  }

  // Deduplicate result items preserving order
  const seen = new Set<string>();
  const finalItems: string[] = [];
  for (const item of resultItems) {
    const norm = cleanSingleScopeItem(item).toLowerCase();
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      finalItems.push(cleanSingleScopeItem(item));
    }
  }

  return finalItems;
}

export function formatScopeItems(items: string[]): string {
  if (!items || items.length === 0) return '';
  const cleanedItems = items.map((i) => cleanSingleScopeItem(i)).filter(Boolean);
  if (cleanedItems.length === 0) return '';
  if (cleanedItems.length === 1) return `${cleanedItems[0]}.`;
  if (cleanedItems.length === 2) return `${cleanedItems[0]}, and ${cleanedItems[1]}.`;
  return `${cleanedItems.slice(0, -1).join(', ')}, and ${cleanedItems[cleanedItems.length - 1]}.`;
}

/**
 * Pure deterministic classifier for explicit seller selection commands.
 * Matches handle/wallet mentions or ordinal positions ("1st freelancer", "second one").
 */
export function isExplicitSellerSelection(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();

  // 1. Handles or wallets with selection verb: "use @aliorbz", "I want to hire @aliorbz for this", "select 0x123..."
  if (/@([a-zA-Z0-9_]{3,32})\b/.test(trimmed) || /0x[0-9a-fA-F]{40}/.test(trimmed)) {
    if (/(?:use|select|pick|choose|go with|hire|draft with|deal with|with)\b/i.test(trimmed)) {
      return true;
    }
    // Inverted selection: "add @alice as the freelancer", "set @alice as seller"
    if (
      /^(?:please\s+)?(?:add|set|make|put|use)\b/i.test(trimmed) &&
      /\b(?:as|for|to)\s+(?:the\s+|our\s+)?(?:freelancer|seller)\b/i.test(trimmed)
    ) {
      return true;
    }
    // Forward selection: "set freelancer to @alice", "make seller @alice"
    if (
      /^(?:please\s+)?(?:set|make|change|update|assign)\s+(?:the\s+)?(?:freelancer|seller)\b/i.test(trimmed)
    ) {
      return true;
    }
    return false;
  }

  // 2. Ordinal or position selection: "pick the first freelancer", "use 1st freelancer", "go with the second one"
  return /(?:use|select|pick|choose|go with|hire)\s+(@?[\w\s\.-]+|1st|2nd|3rd|first|second|third|number\s*\d)/i.test(trimmed);
}

/**
 * Pure deterministic classifier for explicit seller search action requests.
 * Differentiates search requests from informational questions about freelancers.
 */
export function isExplicitSellerSearchRequest(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();

  // Explicit seller selection takes precedence over search
  if (isExplicitSellerSelection(trimmed)) return false;

  // Check if prompt is an advice or opinion question ABOUT freelancers rather than a search action request
  // Examples: "Would you recommend finding another freelancer?", "Is this freelancer a good fit?", "Why should I hire a freelancer?"
  const isAdviceOrOpinionQuestion = /^(?:would\s+you\s+recommend|is\s+this|why\s+should|do\s+you\s+think|what\s+should|how\s+could)\b/i.test(trimmed);
  if (isAdviceOrOpinionQuestion) return false;

  // Search request patterns:
  // 1. Explicit search commands: "find", "search for", "show me", "suggest", "recommend" followed by seller noun
  const explicitSearchCmd = /(?:please\s+)?(?:can\s+you\s+|could\s+you\s+|would\s+you\s+)?(?:find|search(?:\s+for)?|show\s+me|suggest|recommend|look\s+for|get|fetch)\s+(?:me\s+)?(?:a|an|another|some|available|cheaper)?\s*(?:freelancer|freelance|seller|developer|designer|expert|someone|provider|contractor|person)/i.test(trimmed);

  // 2. Direct search phrases starting with "find me", "find a", "find another", "looking for", "need a"
  const searchDirect = /(?:find|search|show\s+me|suggest|looking\s+for|need|want)\s+(?:me\s+)?(?:a|an|another|some|available|cheaper)?\s*(?:freelancer|freelance|seller|developer|designer|expert|someone|provider|contractor)/i.test(trimmed);

  // 3. Question-shaped action requests: "can you find someone cheaper?", "could you find another developer?"
  const questionActionReq = /(?:can\s+you|could\s+you|would\s+you|can\s+we)\s+(?:find|search|suggest|recommend|get)\b/i.test(trimmed);

  // 4. Multilingual Banglish/Bangla search phrases
  const banglaSearch = /(?:khoj|khuje|darkar|dorkar|lagbe|chai|koto\s+(?:pai|chete|chai))/i.test(trimmed);

  return explicitSearchCmd || searchDirect || questionActionReq || banglaSearch;
}

/**
 * Pure deterministic classifier for read-only informational questions and hypothetical turns.
 */
export function isInformationalQuestion(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  // If prompt starts with an explicit command verb or polite mutation request, it is an action turn, NOT an informational question.
  const isCommand = /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:set|change|replace|update|make|add|include|remove|drop|cancel|stop|discard|draft|create|select|pick|choose|use|activate|active|reactivate|reopen|resume)\b/i.test(trimmed);
  if (isCommand) return false;

  const questionWords = /^(?:what|why|how|who|when|which|would|could|should|can\s+you|could\s+you|is|are|does|do|explain|tell\s+me|show\s+me|compare|describe|walk\s+me\s+through|give\s+me\s+(?:an?|the)\s+overview(?:\s+of)?|help\s+me\s+understand|analyze)\b/i;
  const hypotheticalPhrases = /(?:would|could|should|what if|is it|is 0\.\d|too much|too short|reasonable|make sense)/i;

  return questionWords.test(trimmed) || hypotheticalPhrases.test(trimmed) || trimmed.includes('?');
}

export type ValueShape = 'AMOUNT' | 'DURATION' | 'PAYMENT' | 'SELLER' | 'GENERIC_STRING';

export function detectValueShape(text: string): ValueShape {
  if (!text || typeof text !== 'string') return 'GENERIC_STRING';
  const trimmed = text.trim();

  if (/^@[\w.-]+$/i.test(trimmed) || /^0x[a-fA-F0-9]{40}$/i.test(trimmed)) {
    return 'SELLER';
  }

  if (
    /^\d+\s*(?:days?|d|weeks?|w|months?|m|hours?|hrs?)\b/i.test(trimmed) ||
    /^(?:a|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:day|week|month)s?\b/i.test(trimmed) ||
    Boolean(parseExplicitCalendarDeadline(trimmed))
  ) {
    return 'DURATION';
  }

  if (/(?:50\s*[-/]\s*50|milestones?|upfront|completion|single\s+release|staged|50%)/i.test(trimmed)) {
    return 'PAYMENT';
  }

  if (/^\d+(?:\.\d+)?\s*(?:eth|ether|usdc|usdt|dollars?|\$)?$/i.test(trimmed) || /^\$\d+(?:\.\d+)?$/i.test(trimmed)) {
    if (/(?:days?|weeks?|months?)/i.test(trimmed)) {
      return 'DURATION';
    }
    return 'AMOUNT';
  }

  return 'GENERIC_STRING';
}

/**
 * Maps a strongly typed ValueShape to its natural scalar deal domain.
 * Generic strings or unclassified shapes map to null (no cross-domain conflict).
 */
export function getValueShapeTarget(shape: ValueShape): ScalarReferenceField | null {
  switch (shape) {
    case 'AMOUNT':
      return 'BUDGET';
    case 'DURATION':
      return 'DEADLINE';
    case 'SELLER':
      return 'SELLER';
    case 'PAYMENT':
      return 'PAYMENT';
    default:
      return null;
  }
}

/**
 * Matches a clause against contextual reference / pronoun mutation patterns with an extracted target value.
 * e.g. "set it to Web Development", "change that to 10 days", "make it 0.3 ETH", "replace it with ...", "set to 10 days"
 */
export function matchContextualReferenceCommand(clause: string): RegExpMatchArray | null {
  if (!clause || typeof clause !== 'string') return null;
  const t = clause.trim();
  const explicitTarget = detectExplicitTarget(t);

  // If the clause has an explicit target, it is not a contextual or targetless reference
  if (explicitTarget !== 'NONE') return null;

  return (
    t.match(/^(?:please\s+)?(?:set|change|make|update|replace)\s+(?:it|that)\s+(?:to|=|is|with)\s+(.+)$/i) ||
    t.match(/^(?:please\s+)?(?:make)\s+(?:it|that)\s+(.+)$/i) ||
    t.match(/^(?:please\s+)?(?:set|change|update|replace)\s+(?:to|with)\s+(.+)$/i) ||
    t.match(/^(?:please\s+)?(?:set|put|make|adjust|specify|modify|edit|raise|lower)\s+(?:to\s+)?(.+)$/i)
  );
}

/**
 * Detects whether a command clause is a contextual reference mutation command where the target
 * depends on conversational reference resolution (pronoun or omitted target) and therefore raw
 * scalar reconstruction must NOT independently infer a target from raw value shapes.
 */
export function isContextualReferenceCommand(clause: string): boolean {
  if (!clause || typeof clause !== 'string') return false;
  const t = clause.trim();
  return (
    matchContextualReferenceCommand(t) !== null ||
    /^(?:please\s+)?(?:set|change|update|replace)\s+(?:it|that)\b/i.test(t)
  );
}

export type ExplicitDealTarget =
  | 'TITLE'
  | 'BUDGET'
  | 'DEADLINE'
  | 'PAYMENT'
  | 'SELLER'
  | 'SCOPE'
  | 'NONE';

export type DiagnosticValueKind =
  | 'BUDGET'
  | 'DEADLINE'
  | 'PAYMENT'
  | 'SELLER'
  | 'FREEFORM'
  | 'UNKNOWN';

export type TurnDiagnostic =
  | {
      reason: 'INVALID_VALUE_FOR_TARGET';
      operation: 'SET' | 'ADD' | 'CHANGE' | 'UPDATE';
      requestedTarget: 'BUDGET' | 'DEADLINE' | 'PAYMENT' | 'SELLER';
      rawValue: string;
      detectedValueKind: DiagnosticValueKind;
    }
  | {
      reason: 'DESTRUCTIVE_SCALAR_ATTEMPT';
      operation: 'REMOVE' | 'DELETE' | 'DROP';
      rawValue: string;
      detectedValueKind: 'BUDGET' | 'DEADLINE' | 'PAYMENT';
    };

export function detectDiagnosticValueKind(text: string): DiagnosticValueKind {
  const shape = detectValueShape(text);
  if (shape === 'AMOUNT') return 'BUDGET';
  if (shape === 'DURATION') return 'DEADLINE';
  if (shape === 'PAYMENT') return 'PAYMENT';
  if (shape === 'SELLER') return 'SELLER';
  if (shape === 'GENERIC_STRING') return 'FREEFORM';
  return 'UNKNOWN';
}

export function extractExplicitTargetPayload(clause: string, target: ExplicitDealTarget): string {
  if (!clause || typeof clause !== 'string') return '';
  let text = clause.trim();

  // Strip leading command verbs / polite starters
  text = text.replace(/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:also\s+)?(?:add|set|change|update|put|make|use|choose|select)\s+/i, '');

  // Strip terminal or leading target envelopes based on explicit target
  if (target === 'BUDGET') {
    text = text.replace(/(?:\s+(?:to|in|for|into)\s+(?:the\s+)?(?:budget|amount|cost|price|fee))$/i, '');
    text = text.replace(/^(?:the\s+)?(?:budget|amount|cost|price|fee)\s+(?:to|=|is|as|with)\s+/i, '');
  } else if (target === 'DEADLINE') {
    text = text.replace(/(?:\s+(?:to|in|for|into)\s+(?:the\s+)?(?:deadline|timeline|timeframe|duration))$/i, '');
    text = text.replace(/^(?:the\s+)?(?:deadline|timeline|timeframe|duration)\s+(?:to|=|is|as|with)\s+/i, '');
  } else if (target === 'PAYMENT') {
    text = text.replace(/(?:\s+(?:to|in|for|into)\s+(?:the\s+)?(?:payment(?:\s+structure)?|milestones?))$/i, '');
    text = text.replace(/^(?:the\s+)?(?:payment(?:\s+structure)?|milestones?)\s+(?:to|=|is|as|with)\s+/i, '');
  } else if (target === 'SELLER') {
    text = text.replace(/(?:\s+(?:as|to|for)\s+(?:the\s+)?(?:freelancer|seller|contractor|developer))$/i, '');
    text = text.replace(/^(?:the\s+)?(?:freelancer|seller|contractor|developer)\s+(?:to|=|is|as|with)\s+/i, '');
  }

  // Strip trailing punctuation
  text = text.replace(/[.,;]+$/, '').trim();
  // Strip surrounding quotes
  text = text.replace(/^["'](.*)["']$/, '$1').trim();
  return text;
}

export function renderDiagnosticMessage(diagnostic: TurnDiagnostic): string {
  if (diagnostic.reason === 'INVALID_VALUE_FOR_TARGET') {
    const rawVal = diagnostic.rawValue ? `"${diagnostic.rawValue}"` : 'That value';

    if (diagnostic.requestedTarget === 'BUDGET') {
      const base = `${rawVal} isn't a valid budget amount. Budget expects a positive amount in ETH or USDC.`;
      if (diagnostic.detectedValueKind === 'DEADLINE') {
        return `${base} ${rawVal} looks like a deadline. If that's what you meant, use set deadline to ${diagnostic.rawValue}.`;
      }
      if (diagnostic.detectedValueKind === 'PAYMENT') {
        return `${base} ${rawVal} looks like a payment structure. If that's what you meant, use set payment to ${diagnostic.rawValue}.`;
      }
      if (diagnostic.detectedValueKind === 'SELLER') {
        return `${base} ${rawVal} looks like a freelancer identifier. If that's what you meant, use select ${diagnostic.rawValue} as the freelancer.`;
      }
      if (diagnostic.detectedValueKind === 'FREEFORM') {
        return `${base} If you meant this as a deliverable, use add "${diagnostic.rawValue}" to scope. If you meant it as the deal title, use set title to "${diagnostic.rawValue}".`;
      }
      return base;
    }

    if (diagnostic.requestedTarget === 'DEADLINE') {
      const base = `${rawVal} isn't a valid deadline. Deadline expects a supported timeframe or date (e.g. 10 days or 3 weeks).`;
      if (diagnostic.detectedValueKind === 'BUDGET') {
        return `${rawVal} isn't a valid deadline. Deadline expects a supported timeframe or date. ${rawVal} looks like a budget amount. If that's what you meant, use set budget to ${diagnostic.rawValue}.`;
      }
      if (diagnostic.detectedValueKind === 'PAYMENT') {
        return `${base} ${rawVal} looks like a payment structure. If that's what you meant, use set payment to ${diagnostic.rawValue}.`;
      }
      if (diagnostic.detectedValueKind === 'SELLER') {
        return `${base} ${rawVal} looks like a freelancer identifier. If that's what you meant, use select ${diagnostic.rawValue} as the freelancer.`;
      }
      if (diagnostic.detectedValueKind === 'FREEFORM') {
        return `${base} If you meant this as a deliverable, use add "${diagnostic.rawValue}" to scope. If you meant it as the deal title, use set title to "${diagnostic.rawValue}".`;
      }
      return base;
    }

    if (diagnostic.requestedTarget === 'PAYMENT') {
      const base = `${rawVal} isn't a supported payment structure. Synq currently supports Single Release, 50/50 Milestones, and Custom Milestones.`;
      if (diagnostic.detectedValueKind === 'BUDGET') {
        return `${base} ${rawVal} looks like a budget amount. If that's what you meant, use set budget to ${diagnostic.rawValue}.`;
      }
      if (diagnostic.detectedValueKind === 'DEADLINE') {
        return `${base} ${rawVal} looks like a deadline. If that's what you meant, use set deadline to ${diagnostic.rawValue}.`;
      }
      if (diagnostic.detectedValueKind === 'SELLER') {
        return `${base} ${rawVal} looks like a freelancer identifier. If that's what you meant, use select ${diagnostic.rawValue} as the freelancer.`;
      }
      if (diagnostic.detectedValueKind === 'FREEFORM') {
        return `${base} If you meant this as a deliverable, use add "${diagnostic.rawValue}" to scope. If you meant it as the deal title, use set title to "${diagnostic.rawValue}".`;
      }
      return base;
    }

    if (diagnostic.requestedTarget === 'SELLER') {
      const base = `${rawVal} isn't a valid freelancer identifier. Select a freelancer using a supported handle or wallet address.`;
      if (diagnostic.detectedValueKind === 'BUDGET') {
        return `${base} ${rawVal} looks like a budget amount. If that's what you meant, use set budget to ${diagnostic.rawValue}.`;
      }
      if (diagnostic.detectedValueKind === 'DEADLINE') {
        return `${base} ${rawVal} looks like a deadline. If that's what you meant, use set deadline to ${diagnostic.rawValue}.`;
      }
      if (diagnostic.detectedValueKind === 'PAYMENT') {
        return `${base} ${rawVal} looks like a payment structure. If that's what you meant, use set payment to ${diagnostic.rawValue}.`;
      }
      if (diagnostic.detectedValueKind === 'FREEFORM') {
        return `${base} If you meant this as a deliverable, use add "${diagnostic.rawValue}" to scope. If you meant it as the deal title, use set title to "${diagnostic.rawValue}".`;
      }
      return base;
    }
  }

  if (diagnostic.reason === 'DESTRUCTIVE_SCALAR_ATTEMPT') {
    const rawVal = diagnostic.rawValue ? `"${diagnostic.rawValue}"` : 'That';
    if (diagnostic.detectedValueKind === 'BUDGET') {
      return `${rawVal} looks like a budget amount. If you want to change the budget, tell me the new total amount, for example "set budget to 1 ETH".`;
    }
    if (diagnostic.detectedValueKind === 'DEADLINE') {
      return `${rawVal} looks like a deadline value. If you want to change the deadline, tell me the new timeframe, for example "set deadline to 14 days".`;
    }
    if (diagnostic.detectedValueKind === 'PAYMENT') {
      return `${rawVal} looks like a payment structure. If you want to change the payment structure, choose another supported option such as Single Release or Custom Milestones.`;
    }
  }

  return 'What detail would you like to update for the deal?';
}

/**
 * Pure deterministic structural target detector.
 * Identifies explicit destination from control syntax / target position.
 * Terminal prepositional target forms take precedence because they identify
 * the structural destination slot (e.g. "add [PAYLOAD] to the budget").
 */
export function detectExplicitTarget(clause: string): ExplicitDealTarget {
  if (!clause || typeof clause !== 'string') return 'NONE';
  const controlClause = maskQuotedControlSyntax(clause.trim());

  // 1. Terminal prepositional target forms: anchored at the end of the clause
  // e.g. "to the budget", "to the scope", "as the freelancer", "to the title", etc.
  // Guard: Pure informational questions must not treat descriptive terminal prepositions as target assignments.
  if (!isInformationalQuestion(controlClause)) {
    const terminalNoise = '(?:[.\\s]+for\\s+(?:this\\s+)?(?:deal|draft)|[.\\s]+(?:too|as\\s+well|also|please|only)|[.\\s])*$';

    // Terminal SCOPE: "to the scope", "in scope", "to deliverables", "to requirements"
    // NOTE: "contract" is strictly EXCLUDED. Payload words like "contract" must never imply Scope.
    if (
      new RegExp(`\\b(?:to|in|into|from|out\\s+of)\\s+(?:the\\s+|our\\s+)?(?:scope|deliverables|requirements)${terminalNoise}`, 'i').test(controlClause) ||
      new RegExp(`\\b(?:to|in|into|from)\\s+(?:scope|deliverables|requirements)${terminalNoise}`, 'i').test(controlClause)
    ) {
      return 'SCOPE';
    }

    // Terminal TITLE: "to the title", "as the title", "for the title", "as title"
    if (
      new RegExp(`\\b(?:to|as|for|in|into)\\s+(?:the\\s+|our\\s+)?(?:title|name)${terminalNoise}`, 'i').test(controlClause) ||
      new RegExp(`\\b(?:as|to)\\s+title${terminalNoise}`, 'i').test(controlClause)
    ) {
      return 'TITLE';
    }

    // Terminal BUDGET: "to the budget", "to budget", "for the budget", "to the amount", "to the price", "to the cost"
    if (
      new RegExp(`\\b(?:to|as|for|in|into)\\s+(?:the\\s+|our\\s+)?(?:budget|amount|price|cost|fee)${terminalNoise}`, 'i').test(controlClause) ||
      new RegExp(`\\b(?:to|as|for)\\s+budget${terminalNoise}`, 'i').test(controlClause)
    ) {
      return 'BUDGET';
    }

    // Terminal DEADLINE: "to the deadline", "to deadline", "to the timeline", "to the timeframe"
    if (
      new RegExp(`\\b(?:to|as|for|in|into)\\s+(?:the\\s+|our\\s+)?(?:deadline|timeline|timeframe|duration)${terminalNoise}`, 'i').test(controlClause) ||
      new RegExp(`\\b(?:to|as|for)\\s+deadline${terminalNoise}`, 'i').test(controlClause)
    ) {
      return 'DEADLINE';
    }

    // Terminal PAYMENT: "to the payment structure", "to the payment", "to payment", "to milestones"
    if (
      new RegExp(`\\b(?:to|as|for|in|into)\\s+(?:the\\s+|our\\s+)?(?:payment\\s+structure|payment|milestones?)${terminalNoise}`, 'i').test(controlClause) ||
      new RegExp(`\\b(?:to|as|for)\\s+(?:payment|payment\\s+structure)${terminalNoise}`, 'i').test(controlClause)
    ) {
      return 'PAYMENT';
    }

    // Terminal SELLER: "as the freelancer", "to the freelancer", "as the seller", "to the seller", "as freelancer"
    // Guard: Descriptive transfer verbs (e.g. "released to", "paid to", "sent to") must not be treated as seller selection.
    if (
      !/(?:released|paid|sent|transferred|distributed|given)\s+to\b/i.test(controlClause) &&
      (new RegExp(`\\b(?:to|as|for|in|into)\\s+(?:the\\s+|our\\s+)?(?:freelancer|seller|contractor|developer|designer)${terminalNoise}`, 'i').test(controlClause) ||
       new RegExp(`\\b(?:as|to)\\s+(?:freelancer|seller)${terminalNoise}`, 'i').test(controlClause))
    ) {
      return 'SELLER';
    }
  }

  // 2. Forward target forms: anchored at the start with command verb + target
  // Forward TITLE: "set title to...", "change the title...", "call the deal..."
  if (
    /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:change|set|update|modify|edit|make)\s+(?:the\s+)?(?:title|name)\b/i.test(controlClause) ||
    /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:call\s+(?:the\s+)?(?:deal|draft)|title\s+it)\b/i.test(controlClause)
  ) {
    return 'TITLE';
  }

  // Forward BUDGET: "set budget to...", "change the budget...", "update the amount..."
  if (
    /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:change|set|update|modify|edit|make)\s+(?:the\s+)?(?:budget|amount|price|cost|fee)\b/i.test(controlClause)
  ) {
    return 'BUDGET';
  }

  // Forward DEADLINE: "set deadline to...", "change timeline to...", "update deadline..."
  if (
    /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:change|set|update|modify|edit|make)\s+(?:the\s+)?(?:deadline|timeline|timeframe|duration)\b/i.test(controlClause)
  ) {
    return 'DEADLINE';
  }

  // Forward PAYMENT: "set payment to...", "change payment structure to...", "use 50/50 payment"
  if (
    /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:change|set|update|modify|edit|make|use)\s+(?:the\s+)?(?:payment(?:\s+structure)?|milestones?)\b/i.test(controlClause)
  ) {
    return 'PAYMENT';
  }

  // Forward SELLER: "select ... as freelancer", "set freelancer to...", "use @alice", "hire @bob"
  if (
    /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:change|set|update|modify|edit|make|select|choose|pick|hire)\s+(?:the\s+)?(?:freelancer|seller)\b/i.test(controlClause) ||
    /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:use|select|pick|choose|hire|go\s+with|draft\s+with|deal\s+with)\s+@/i.test(controlClause) ||
    /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:use|select|pick|choose|hire)\s+0x[0-9a-fA-F]{40}/i.test(controlClause)
  ) {
    return 'SELLER';
  }

  // Forward SCOPE: "set scope to...", "clear scope", "remove all deliverables"
  if (
    /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:change|set|update|modify|edit|make|replace)\s+(?:the\s+)?(?:scope|deliverables|requirements)\b/i.test(controlClause) ||
    /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:clear|reset)\s+(?:the\s+)?(?:scope|deliverables|requirements)\b/i.test(controlClause) ||
    /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?remove\s+(?:everything|all)\s+(?:from|out\s+of)\s+(?:the\s+)?(?:scope|deliverables|requirements)\b/i.test(controlClause) ||
    /^(?:the\s+)?(?:scope|deliverables)\s+(?:should\s+be|is|are|set\s+to|updated\s+to)\b/i.test(controlClause)
  ) {
    return 'SCOPE';
  }

  // 3. Payment-preset fallback: direct commands whose value IS a recognized payment preset.
  // Catches: "set 50/50 milestone", "use 50/50", "set single release", "set custom milestones"
  // Must NOT fire for contextual pronoun commands ("set it to 50/50") — those stay in
  // matchContextualReferenceCommand. The pronoun guard below ensures that separation.
  // Named targets (TITLE, SCOPE, etc.) already returned above, so "set the title to
  // Single Release" and "set the scope to 50/50 milestone planning" are already handled.
  if (/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:set|change|update|modify|use|make)\b/i.test(controlClause)) {
    // Guard: if the clause contains a pronoun reference ("it", "that"), skip this fallback.
    if (!/\b(?:set|change|update|modify|use|make)\s+(?:it|that)\b/i.test(controlClause)) {
      // Strip the command verb prefix to isolate the value + optional noun
      const afterVerb = controlClause.replace(/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:set|change|update|modify|use|make)\s+/i, '').trim();
      if (parsePaymentStructure(afterVerb) !== null) {
        return 'PAYMENT';
      }
    }
  }

  return 'NONE';
}

/**
 * Pure deterministic parser for target-only follow-up responses
 * to an ambiguous ADD destination clarification question (e.g. "scope", "to the budget", "title").
 */
export function parseTargetFollowUp(clause: string): ExplicitDealTarget {
  if (!clause || typeof clause !== 'string') return 'NONE';
  const t = clause.trim();
  if (/^(?:(?:to|in|into|for|as)\s+)?(?:the\s+)?(?:scope|deliverables|requirements)[.\s]*$/i.test(t)) {
    return 'SCOPE';
  }
  if (/^(?:(?:to|as|for)\s+)?(?:the\s+)?(?:title|name)[.\s]*$/i.test(t)) {
    return 'TITLE';
  }
  if (/^(?:(?:to|for)\s+)?(?:the\s+)?(?:budget|amount|cost|price|fee)[.\s]*$/i.test(t)) {
    return 'BUDGET';
  }
  if (/^(?:(?:to|for)\s+)?(?:the\s+)?(?:deadline|timeline|timeframe|duration)[.\s]*$/i.test(t)) {
    return 'DEADLINE';
  }
  if (/^(?:(?:to|for)\s+)?(?:the\s+)?(?:payment(?:\s+structure)?|milestones?)[.\s]*$/i.test(t)) {
    return 'PAYMENT';
  }
  if (/^(?:(?:to|as|for)\s+)?(?:the\s+)?(?:freelancer|seller|contractor|developer)[.\s]*$/i.test(t)) {
    return 'SELLER';
  }
  return 'NONE';
}

export type ScalarClearTarget = 'BUDGET' | 'DEADLINE' | 'PAYMENT' | 'SELLER' | 'TITLE';

/**
 * Pure deterministic recognizer for exact whole-field scalar clear commands (Phase 3B.1 / 3B.2).
 * Matches strictly bare whole-clause commands (e.g. "clear budget", "please reset the deadline").
 * Whole-clause anchored; does not match commands with values, payloads, or prepositions.
 */
export function parseScalarClearCommand(clause: string): ScalarClearTarget | null {
  if (!clause || typeof clause !== 'string') return null;
  const controlClause = maskQuotedControlSyntax(clause.trim());

  // BUDGET
  if (
    /^(?:please\s+)?(?:clear|reset|remove|delete|drop)\s+(?:(?:the\s+)?(?:current|existing)\s+)?(?:the\s+)?budget[.\s]*$/i.test(controlClause) ||
    /^(?:please\s+)?(?:remove|delete|drop)\s+(?:that|it)\s+(?:from|out\s+of)\s+(?:the\s+)?budget[.\s]*$/i.test(controlClause)
  ) {
    return 'BUDGET';
  }

  // DEADLINE
  if (
    /^(?:please\s+)?(?:clear|reset|remove|delete|drop)\s+(?:(?:the\s+)?(?:current|existing)\s+)?(?:the\s+)?deadline[.\s]*$/i.test(controlClause) ||
    /^(?:please\s+)?(?:remove|delete|drop)\s+(?:that|it)\s+(?:from|out\s+of)\s+(?:the\s+)?deadline[.\s]*$/i.test(controlClause)
  ) {
    return 'DEADLINE';
  }

  // PAYMENT
  if (
    /^(?:please\s+)?(?:clear|reset|remove|delete|drop)\s+(?:(?:the\s+)?(?:current|existing)\s+)?(?:the\s+)?payment(?:\s+structure)?[.\s]*$/i.test(controlClause) ||
    /^(?:please\s+)?(?:remove|delete|drop)\s+(?:that|it)\s+(?:from|out\s+of)\s+(?:the\s+)?payment(?:\s+structure)?[.\s]*$/i.test(controlClause)
  ) {
    return 'PAYMENT';
  }

  // SELLER (selected is allowed here)
  if (
    /^(?:please\s+)?(?:clear|reset|remove|delete|drop)\s+(?:(?:the\s+)?(?:current|existing|selected)\s+)?(?:the\s+)?(?:freelancer|seller)[.\s]*$/i.test(controlClause) ||
    /^(?:please\s+)?(?:remove|delete|drop)\s+(?:that|it)\s+(?:from|out\s+of)\s+(?:the\s+)?(?:freelancer|seller)[.\s]*$/i.test(controlClause)
  ) {
    return 'SELLER';
  }

  // TITLE
  if (
    /^(?:please\s+)?(?:clear|reset|remove|delete|drop)\s+(?:(?:the\s+)?(?:current|existing)\s+)?(?:the\s+)?(?:deal\s+)?title[.\s]*$/i.test(controlClause) ||
    /^(?:please\s+)?(?:remove|delete|drop)\s+(?:that|it)\s+(?:from|out\s+of)\s+(?:the\s+)?(?:deal\s+)?title[.\s]*$/i.test(controlClause)
  ) {
    return 'TITLE';
  }

  return null;
}

export function isBudgetReferentialMatch(
  refVal: string,
  currentAmount: string | null,
  currentAsset: 'ETH' | 'USDC'
): boolean {
  if (!currentAmount) return false;
  const clean = refVal.trim();
  if (clean.includes('$')) return false;

  const match = clean.match(/^(\d+(?:\.\d+)?|\.\d+)\s*(eth|ethereum|usdc)$/i);
  if (!match) return false;

  const rawNum = match[1];
  const rawAsset = match[2].toUpperCase();
  const normAsset: 'ETH' | 'USDC' = rawAsset === 'ETH' || rawAsset === 'ETHEREUM' ? 'ETH' : 'USDC';

  if (normAsset !== currentAsset) return false;

  const numVal = parseFloat(rawNum);
  const curNum = parseFloat(currentAmount);
  return !isNaN(numVal) && !isNaN(curNum) && numVal === curNum;
}

export function isDeadlineReferentialMatch(
  refVal: string,
  currentDeadline: string | null
): boolean {
  if (!currentDeadline) return false;
  const clean = refVal.trim().toLowerCase();
  const cur = currentDeadline.trim().toLowerCase();

  const refMatch = clean.match(/^(\d+)\s*(days?|weeks?|months?)$/i);
  const curMatch = cur.match(/^(\d+)\s*(days?|weeks?|months?)$/i);

  if (refMatch && curMatch) {
    const refNum = parseInt(refMatch[1], 10);
    const curNum = parseInt(curMatch[1], 10);
    const refUnit = refMatch[2].replace(/s$/, '');
    const curUnit = curMatch[2].replace(/s$/, '');
    return refNum === curNum && refUnit === curUnit;
  }

  const refCal = parseExplicitCalendarDeadline(clean);
  const curCal = parseExplicitCalendarDeadline(cur);
  if (refCal && curCal) {
    return refCal === curCal;
  }

  return clean === cur;
}

export function isPaymentReferentialMatch(
  refVal: string,
  currentPayment: string | null
): boolean {
  if (!currentPayment) return false;
  const clean = refVal.trim().toLowerCase();

  let parsed: '50-50' | 'single' | 'custom' | null = null;
  if (/^(?:50\s*[-/]\s*50|half and half)$/i.test(clean)) {
    parsed = '50-50';
  } else if (/^(?:single(?:\s+release|\s+payment)?|upfront|100%\s+at\s+end)$/i.test(clean)) {
    parsed = 'single';
  } else if (/^(?:custom(?:\s+milestones?|\s+payment)?)$/i.test(clean)) {
    parsed = 'custom';
  }

  if (!parsed) return false;
  return parsed === currentPayment;
}

/**
 * Strips exactly one matching pair of outer quotes (double, single, or backtick) if present.
 * Leaves mismatched delimiters (e.g. "foo', 'foo`) and internal quotes/apostrophes intact.
 */
export function stripMatchingOuterQuote(value: string): string {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' || first === "'" || first === '`') && first === last) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function isTitleReferentialMatch(
  refVal: string,
  currentTitle: string | null
): boolean {
  if (!currentTitle) return false;
  const clean = stripMatchingOuterQuote(refVal).trim().toLowerCase();
  const cur = stripMatchingOuterQuote(currentTitle).trim().toLowerCase();
  return clean === cur;
}

export function isSellerReferentialMatch(
  refVal: string,
  currentSeller: string | null
): boolean {
  if (!currentSeller) return false;
  const clean = refVal.trim().toLowerCase();
  const cur = currentSeller.trim().toLowerCase();

  // Direct wallet match
  if (/^0x[0-9a-fA-F]{40}$/i.test(clean)) {
    return clean === cur;
  }

  return false;
}

/**
 * Detects whether a command clause is an explicit field-directed scalar mutation command
 * (e.g. "set the deadline to 10 days", "change the title", "set the budget to 0.4 ETH").
 */
export function isFieldDirectedMutationCommand(clause: string): boolean {
  if (!clause || typeof clause !== 'string') return false;
  const target = detectExplicitTarget(clause);
  return target !== 'NONE' && target !== 'SCOPE';
}

/**
 * Detects whether a command clause is a target-reference mutation (pronoun or field-directed mutation)
 * such as "set it to Web Development", "make it 0.3 ETH", "change it to 10 days", "update that to ...",
 * "replace it with ...", or "change the title". These must never be treated as implicit scope fallback.
 */
export function isReferenceMutationCommand(clause: string): boolean {
  return isContextualReferenceCommand(clause) || isFieldDirectedMutationCommand(clause);
}

export type ScopeOrdinalResolution =
  | { status: 'RESOLVED'; index: number; targetItem: string; isLast?: boolean }
  | { status: 'OUT_OF_BOUNDS'; requestedOrdinal: string; requestedPosition?: number; currentLength: number }
  | { status: 'NO_ORDINAL' };

const ORDINAL_WORD_TO_POS: Record<string, number> = {
  first: 1, '1st': 1,
  second: 2, '2nd': 2,
  third: 3, '3rd': 3,
  fourth: 4, '4th': 4,
  fifth: 5, '5th': 5,
  sixth: 6, '6th': 6,
  seventh: 7, '7th': 7,
  eighth: 8, '8th': 8,
  ninth: 9, '9th': 9,
  tenth: 10, '10th': 10,
};

export const ORDINAL_SCOPE_NOUNS_PATTERN = '(?:one|item|scope\\s+item|deliverable|requirement|feature)';
export const ORDINAL_SCOPE_TOKEN_PATTERN = '(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|last|final|\\d+(?:st|nd|rd|th))';

export const ORDINAL_SCOPE_REMOVE_REGEX = new RegExp(
  `^(?:please\\s+)?(?:remove|drop|delete|take\\s+out)\\s+(?:the\\s+)?${ORDINAL_SCOPE_TOKEN_PATTERN}(?:\\s+${ORDINAL_SCOPE_NOUNS_PATTERN})?(?:\\s+(?:from|out\\s+of)\\s+(?:the\\s+)?(?:scope|deliverables|requirements))?[.\\s]*$`,
  'i'
);

export const ORDINAL_SCOPE_REPLACE_REGEX = new RegExp(
  `^(?:please\\s+)?(?:replace|change|update)\\s+(?:the\\s+)?${ORDINAL_SCOPE_TOKEN_PATTERN}(?:\\s+${ORDINAL_SCOPE_NOUNS_PATTERN})?(?:\\s+(?:in|from|of)\\s+(?:the\\s+)?(?:scope|deliverables))?\\s+(?:with|to|=|for)\\s+(.+)$`,
  'i'
);

export function parseScopeOrdinalReference(
  text: string,
  scopeItems: string[]
): ScopeOrdinalResolution {
  if (!text || typeof text !== 'string') return { status: 'NO_ORDINAL' };
  const currentLength = Array.isArray(scopeItems) ? scopeItems.length : 0;

  // Check for "last" or "final"
  const isLast = /\b(?:last|final)\b/i.test(text);
  if (isLast) {
    if (currentLength === 0) {
      return { status: 'OUT_OF_BOUNDS', requestedOrdinal: 'last', currentLength: 0 };
    }
    const index = currentLength - 1;
    return {
      status: 'RESOLVED',
      index,
      targetItem: scopeItems[index],
      isLast: true,
    };
  }

  // Check for word or numeric ordinals: e.g. "first", "1st", "second", "2nd", etc.
  const match = text.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th|(\d+)(?:st|nd|rd|th))\b/i);
  if (!match) {
    return { status: 'NO_ORDINAL' };
  }

  const rawToken = match[1].toLowerCase();
  let pos: number | undefined = ORDINAL_WORD_TO_POS[rawToken];
  if (!pos && match[2]) {
    pos = parseInt(match[2], 10);
  }

  if (!pos || isNaN(pos) || pos <= 0) {
    return { status: 'NO_ORDINAL' };
  }

  if (pos > currentLength) {
    return {
      status: 'OUT_OF_BOUNDS',
      requestedOrdinal: rawToken,
      requestedPosition: pos,
      currentLength,
    };
  }

  const index = pos - 1;
  return {
    status: 'RESOLVED',
    index,
    targetItem: scopeItems[index],
  };
}

export const CONTEXTUAL_SCOPE_REMOVE_REGEX =
  /^(?:please\s+)?(?:remove|drop|delete|take\s+out)\s+(?:that|it)(?:\s+(?:from|out\s+of)\s+(?:the\s+)?(?:scope|deliverables|deal))?[.\s]*$/i;

export function isScopeItemReferenceCommand(clause: string): boolean {
  if (!clause || typeof clause !== 'string') return false;
  const t = clause.trim();
  return (
    ORDINAL_SCOPE_REMOVE_REGEX.test(t) ||
    ORDINAL_SCOPE_REPLACE_REGEX.test(t) ||
    CONTEXTUAL_SCOPE_REMOVE_REGEX.test(t)
  );
}

/**
 * Determines whether a previous user message is an eligible informational/read-only turn
 * capable of establishing an INFORMATIONAL_SUBJECT candidate for future reference resolution.
 * Failed, ambiguous, command-shaped, or mutation requests MUST NEVER be eligible.
 */
export function isEligibleInformationalSubjectTurn(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Strip polite wrappers e.g. "can you", "could you", "would you", "will you", "please"
  const unpeeled = trimmed
    .replace(/^(?:can\s+you|could\s+you|would\s+you|will\s+you|please)\s+(?:please\s+)?/i, '')
    .trim();

  // If the unpeeled phrase begins with any mutation verb, it is an action request, NOT an informational question
  const isCommandVerb = /^(?:set|change|replace|update|make|add|include|remove|drop|clear|reset|delete|cancel|stop|discard|draft|create|select|pick|choose|use|activate|active|reactivate|reopen|resume)\b/i.test(unpeeled);
  if (isCommandVerb) return false;

  // Check against reference and scope mutation command patterns
  if (
    isReferenceMutationCommand(unpeeled) ||
    isScopeItemReferenceCommand(unpeeled) ||
    isReferenceMutationCommand(trimmed) ||
    isScopeItemReferenceCommand(trimmed)
  ) {
    return false;
  }

  // Must be recognized as an informational question
  return isInformationalQuestion(trimmed);
}

/**
 * Deterministic compatibility validator for contextual scalar mutation targets.
 * Ensures contextual pronoun mutations (e.g. "change it to X", "make it Y") only mutate
 * scalar fields when the proposed value conforms to that field's expected value shape.
 * Arbitrary generic text (e.g. "admin dashboard", "banana") must never mutate DEADLINE, BUDGET, or PAYMENT.
 */
export function isContextualValueCompatible(
  field: ScalarReferenceField,
  rawValue: string,
  shape: ValueShape
): boolean {
  if (!rawValue || typeof rawValue !== 'string') return false;
  const trimmed = rawValue.replace(/^["']|["']$/g, '').trim();
  if (!trimmed) return false;

  switch (field) {
    case 'TITLE': {
      // Title is freeform text, but must not match a strong conflicting scalar shape
      return shape !== 'AMOUNT' && shape !== 'DURATION' && shape !== 'PAYMENT' && shape !== 'SELLER';
    }
    case 'BUDGET': {
      // Must be a valid budget amount or numeric pattern with optional asset
      const bOp = parseBudgetOperation(`set budget to ${trimmed}`);
      if (bOp && bOp.type === 'VALID') return true;
      return /^(\d+(?:\.\d+)?)\s*(eth|usdc)?$/i.test(trimmed);
    }
    case 'DEADLINE': {
      // Must be a recognized duration or timeline pattern
      if (shape === 'DURATION') return true;
      return (
        /^\d+\s*(?:days?|d|weeks?|w|months?|m|hours?|hrs?)\b/i.test(trimmed) ||
        /^(?:a|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:day|week|month)s?\b/i.test(trimmed) ||
        /(\d+)\s*(?:days?|weeks?)/i.test(trimmed) ||
        Boolean(parseExplicitCalendarDeadline(trimmed))
      );
    }
    case 'PAYMENT': {
      // Must be a recognized payment structure pattern
      if (shape === 'PAYMENT') return true;
      return /(?:50\s*[-/]\s*50|milestones?|upfront|completion|single\s+release|single\s+payment|half\s+and\s+half|custom\s+milestone|custom\s+payment|single|50-50|custom)/i.test(trimmed);
    }
    case 'SELLER': {
      // Must be a seller handle, valid Ethereum address, or recognized seller shape
      return shape === 'SELLER' || /^@[\w.-]+$/i.test(trimmed) || isAddress(trimmed);
    }
    default:
      return false;
  }
}

export interface NegotiatorMessageSemanticMetadata {
  pendingClarification: PendingClarificationPayload | null | undefined;
  resolvedActions: ResolvedActionPayload[] | undefined;
}

/**
 * Normalizes semantic message metadata access across supported message representations:
 * 1. Flattened application message: message.pendingClarification, message.resolvedActions
 * 2. Nested context/persisted representation: message.payload?.pendingClarification, message.payload?.resolvedActions
 */
export function getNegotiatorMessageMetadata(message: any): NegotiatorMessageSemanticMetadata {
  if (!message || typeof message !== 'object') {
    return { pendingClarification: undefined, resolvedActions: undefined };
  }

  // Precedence: top-level application message properties first, falling back to payload nesting
  const pendingClarification =
    message.pendingClarification !== undefined
      ? message.pendingClarification
      : message.payload?.pendingClarification;

  const resolvedActions =
    Array.isArray(message.resolvedActions)
      ? message.resolvedActions
      : Array.isArray(message.payload?.resolvedActions)
      ? message.payload.resolvedActions
      : undefined;

  return {
    pendingClarification,
    resolvedActions,
  };
}

export interface ScalarCandidateResult {
  field: ScalarReferenceField;
  source: 'PENDING_CLARIFICATION' | 'PREVIOUS_MUTATION' | 'INFORMATIONAL_SUBJECT';
}

export function getScalarCandidateFromHistory(history: any[]): ScalarCandidateResult | null {
  if (!Array.isArray(history) || history.length === 0) return null;

  const msgs = [...history];
  const lastAiMsg = msgs.slice().reverse().find((m) => m && (m.role === 'ai' || m.role === 'assistant'));

  const aiMeta = getNegotiatorMessageMetadata(lastAiMsg);

  // 1. PENDING_CLARIFICATION on immediately preceding AI message
  const pendingClar = aiMeta.pendingClarification;
  if (pendingClar?.targetField && ['TITLE', 'BUDGET', 'DEADLINE', 'PAYMENT', 'SELLER'].includes(pendingClar.targetField)) {
    return { field: pendingClar.targetField as ScalarReferenceField, source: 'PENDING_CLARIFICATION' };
  }

  // 2. PREVIOUS_MUTATION on immediately preceding turn
  const lastResolved = aiMeta.resolvedActions;
  if (Array.isArray(lastResolved) && lastResolved.length > 0) {
    const scalarAct = lastResolved.find((a) => a && a.targetField && ['TITLE', 'BUDGET', 'DEADLINE', 'PAYMENT', 'SELLER'].includes(a.targetField));
    if (scalarAct?.targetField) {
      return { field: scalarAct.targetField as ScalarReferenceField, source: 'PREVIOUS_MUTATION' };
    }
  }

  // 3. INFORMATIONAL_SUBJECT on immediately preceding user message
  const lastUserMsg = msgs.slice().reverse().find((m) => m && m.role === 'user');
  if (lastUserMsg?.content && isEligibleInformationalSubjectTurn(lastUserMsg.content)) {
    const userText = lastUserMsg.content;
    if (/(?:budget|amount|cost|price)/i.test(userText) && !/(?:scope|deliverable|deadline|title)/i.test(userText)) {
      return { field: 'BUDGET', source: 'INFORMATIONAL_SUBJECT' };
    }
    if (/(?:deadline|timeline|timeframe|duration|days)/i.test(userText) && !/(?:budget|scope|title)/i.test(userText)) {
      return { field: 'DEADLINE', source: 'INFORMATIONAL_SUBJECT' };
    }
    if (/(?:title|name)/i.test(userText) && !/(?:budget|scope|deadline)/i.test(userText)) {
      return { field: 'TITLE', source: 'INFORMATIONAL_SUBJECT' };
    }
    if (/(?:payment|milestones?)/i.test(userText) && !/(?:budget|scope|deadline)/i.test(userText)) {
      return { field: 'PAYMENT', source: 'INFORMATIONAL_SUBJECT' };
    }
    if (/(?:freelancer|developer|seller)/i.test(userText) && !/(?:budget|scope|deadline)/i.test(userText)) {
      return { field: 'SELLER', source: 'INFORMATIONAL_SUBJECT' };
    }
  }

  return null;
}

export const CONFIRM_AFFIRMATIVE_REGEX =
  /^(?:yes(?:\s+please)?|sure|okay|ok|yep|yeah|do\s+it|go\s+ahead|confirm|correct|proceed)[.!]?$/i;

export const CONFIRM_NEGATIVE_REGEX =
  /^(?:no|nope|don'?t|do\s+not|cancel(?:\s+that)?|never\s*mind|nevermind|leave\s+it|stop)[.!]?$/i;

/**
 * Detects whether the immediately preceding turn explicitly superseded a Phase 2
 * confirmation proposal (either via an explicit rejection like "no", or via an
 * explicit whole-field CLEAR of the same target field).
 *
 * Scans chronological message metadata from history without requiring any schema changes:
 * 1. priorAi had pendingClarification.operation === 'CONFIRM' with targetField in BUDGET | DEADLINE | PAYMENT.
 * 2. lastAi had pendingClarification === null (or falsy).
 * 3. Either:
 *    a) lastAi executed a matching CLEAR resolvedAction for that target, or intervening user issued a matching scalar clear.
 *    b) intervening user between priorAi and lastAi issued an explicit rejection matching CONFIRM_NEGATIVE_REGEX.
 */
export function detectRecentSupersededConfirmation(
  history: any[]
): ScalarReferenceField | null {
  if (!Array.isArray(history) || history.length === 0) return null;

  const aiIndices: number[] = [];
  for (let i = 0; i < history.length; i++) {
    const role = history[i]?.role;
    if (role === 'ai' || role === 'assistant') {
      aiIndices.push(i);
    }
  }

  if (aiIndices.length < 2) return null;

  const lastAiIdx = aiIndices[aiIndices.length - 1];
  const lastAiMsg = history[lastAiIdx];
  const lastAiMeta = getNegotiatorMessageMetadata(lastAiMsg);

  // If the last AI message currently has an active pending clarification, it is NOT superseded!
  if (lastAiMeta.pendingClarification) {
    return null;
  }

  const priorAiIdx = aiIndices[aiIndices.length - 2];
  const priorAiMsg = history[priorAiIdx];
  const priorAiMeta = getNegotiatorMessageMetadata(priorAiMsg);

  // Check if prior AI message had a Phase 2 CONFIRM pending proposal
  const priorPending = priorAiMeta.pendingClarification;
  if (!priorPending || priorPending.operation !== 'CONFIRM') {
    return null;
  }

  const target = priorPending.targetField;
  if (target !== 'BUDGET' && target !== 'DEADLINE' && target !== 'PAYMENT') {
    return null;
  }

  // Supersession Case 1: Explicit CLEAR of the SAME target on the last AI turn
  const matchingClearType =
    target === 'BUDGET'
      ? 'CLEAR_AMOUNT'
      : target === 'DEADLINE'
      ? 'CLEAR_DEADLINE'
      : 'CLEAR_PAYMENT_STRUCTURE';

  const hadMatchingClear =
    Array.isArray(lastAiMeta.resolvedActions) &&
    lastAiMeta.resolvedActions.some((a) => a && a.type === matchingClearType);

  const interveningUserMsgs = history
    .slice(priorAiIdx + 1, lastAiIdx)
    .filter((m) => m && m.role === 'user');

  if (interveningUserMsgs.length === 1) {
    const userText = (interveningUserMsgs[0]?.content || '').trim();
    const userClear = parseScalarClearCommand(userText);
    if (userClear === target || hadMatchingClear) {
      return target as ScalarReferenceField;
    }

    // Supersession Case 2: Explicit confirmation rejection by intervening user
    if (CONFIRM_NEGATIVE_REGEX.test(userText)) {
      return target as ScalarReferenceField;
    }
  } else if (hadMatchingClear) {
    return target as ScalarReferenceField;
  }

  return null;
}

/**
 * Deterministic domain-aware wording for superseded confirmation notices.
 * Never includes the stale suggested value.
 */
export function renderSupersededConfirmationMessage(target: ScalarReferenceField): string {
  switch (target) {
    case 'PAYMENT':
      return 'The earlier payment suggestion is no longer pending. If you want to set the payment structure, tell me the payment structure you want.';
    case 'BUDGET':
      return 'The earlier budget suggestion is no longer pending. If you want to set the budget, tell me the amount and asset.';
    case 'DEADLINE':
      return 'The earlier deadline suggestion is no longer pending. If you want to set the deadline, tell me the deadline you want.';
    default:
      return 'The earlier suggestion is no longer pending.';
  }
}

export type ContextualCandidateDomain = 'SCALAR' | 'SCOPE_ITEM';

export type ContextualReferenceCandidate =
  | {
      domain: 'SCALAR';
      field: ScalarReferenceField;
      source:
        | 'PENDING_CLARIFICATION'
        | 'PREVIOUS_MUTATION'
        | 'INFORMATIONAL_SUBJECT'
        | 'SAME_TURN_MUTATION'
        | 'SAME_TURN_INFORMATIONAL_SUBJECT';
    }
  | {
      domain: 'SCOPE_ITEM';
      field: 'SCOPE_ITEM';
      targetItem: string;
      targetIndex?: number;
      source:
        | 'PENDING_CLARIFICATION'
        | 'PREVIOUS_MUTATION'
        | 'SAME_TURN_MUTATION';
      pendingOperation?: PendingClarificationOperation;
      pendingValue?: string;
    };

export type SameTurnReferenceState =
  | { status: 'UNTOUCHED' }
  | {
      status: 'CANDIDATE';
      candidate: ContextualReferenceCandidate;
    }
  | { status: 'BLOCKED' };

export interface WorkingScalarState {
  title: string | null;
  budgetAmount: string | null;
  budgetAsset: 'ETH' | 'USDC';
  deadline: string | null;
  paymentStructure: string | null;
  seller: string | null;
}

export function getEffectiveContextualCandidate(
  sameTurnState: SameTurnReferenceState,
  history: any[],
  currentScopeItems: string[]
): ContextualReferenceCandidate | null {
  if (sameTurnState.status === 'CANDIDATE') {
    return sameTurnState.candidate;
  }
  if (sameTurnState.status === 'UNTOUCHED') {
    return getContextualCandidateFromHistory(history, currentScopeItems);
  }
  return null;
}

export function getInformationalSubjectField(clause: string): ScalarReferenceField | null {
  if (!isEligibleInformationalSubjectTurn(clause)) return null;
  const userText = clause.trim();
  const isBudget = /(?:budget|amount|cost|price)/i.test(userText) && !/(?:scope|deliverable|deadline|title)/i.test(userText);
  const isDeadline = /(?:deadline|timeline|timeframe|duration|days)/i.test(userText) && !/(?:budget|scope|title)/i.test(userText);
  const isTitle = /(?:title|name)/i.test(userText) && !/(?:budget|scope|deadline)/i.test(userText);
  const isPayment = /(?:payment|milestones?)/i.test(userText) && !/(?:budget|scope|deadline)/i.test(userText);
  const isSeller = /(?:freelancer|developer|seller)/i.test(userText) && !/(?:budget|scope|deadline)/i.test(userText);

  const matched = [isBudget, isDeadline, isTitle, isPayment, isSeller].filter(Boolean).length;
  if (matched !== 1) return null;

  if (isBudget) return 'BUDGET';
  if (isDeadline) return 'DEADLINE';
  if (isTitle) return 'TITLE';
  if (isPayment) return 'PAYMENT';
  if (isSeller) return 'SELLER';
  return null;
}


export function getContextualCandidateFromHistory(
  history: any[],
  currentScopeItems: string[]
): ContextualReferenceCandidate | null {
  if (!Array.isArray(history) || history.length === 0) return null;

  const msgs = [...history];
  const lastAiMsg = msgs.slice().reverse().find((m) => m && (m.role === 'ai' || m.role === 'assistant'));
  if (!lastAiMsg) return null;

  const aiMeta = getNegotiatorMessageMetadata(lastAiMsg);

  // 1. Immediately preceding PENDING_CLARIFICATION
  const pendingClar = aiMeta.pendingClarification;
  if (pendingClar?.targetField) {
    if (['TITLE', 'BUDGET', 'DEADLINE', 'PAYMENT', 'SELLER'].includes(pendingClar.targetField)) {
      return {
        domain: 'SCALAR',
        field: pendingClar.targetField as ScalarReferenceField,
        source: 'PENDING_CLARIFICATION',
      };
    }
    if (pendingClar.targetField === 'SCOPE_ITEM') {
      return {
        domain: 'SCOPE_ITEM',
        field: 'SCOPE_ITEM',
        targetItem: '',
        source: 'PENDING_CLARIFICATION',
        pendingOperation: pendingClar.operation,
        pendingValue: pendingClar.value,
      };
    }
  }

  // 2. Immediately preceding PREVIOUS_MUTATION in resolvedActions
  const lastResolved = aiMeta.resolvedActions;
  if (Array.isArray(lastResolved) && lastResolved.length > 0) {
    const lastAct = lastResolved[lastResolved.length - 1];
    if (lastAct && typeof lastAct === 'object') {
      // Destructive / clear actions never become previous-mutation candidates
      if (
        lastAct.type === 'CLEAR_AMOUNT' ||
        lastAct.type === 'CLEAR_DEADLINE' ||
        lastAct.type === 'CLEAR_TITLE' ||
        lastAct.type === 'CLEAR_PAYMENT_STRUCTURE' ||
        lastAct.type === 'CLEAR_SELLER' ||
        lastAct.type === 'CLEAR_SCOPE' ||
        lastAct.type === 'REMOVE_SCOPE' ||
        lastAct.type === 'REPLACE_SCOPE'
      ) {
        return null;
      }

      // Scalar action
      if (
        lastAct.targetField &&
        ['TITLE', 'BUDGET', 'DEADLINE', 'PAYMENT', 'SELLER'].includes(lastAct.targetField)
      ) {
        return {
          domain: 'SCALAR',
          field: lastAct.targetField as ScalarReferenceField,
          source: 'PREVIOUS_MUTATION',
        };
      }

      // ADD_SCOPE
      if (lastAct.type === 'ADD_SCOPE') {
        if (
          lastAct.targetField === 'SCOPE_ITEM' &&
          typeof lastAct.targetItem === 'string' &&
          lastAct.targetItem.trim().length > 0
        ) {
          const cleanTarget = cleanSingleScopeItem(lastAct.targetItem);
          const targetNorm = cleanTarget.toLowerCase();
          const curIdx = currentScopeItems.findIndex(
            (it) => cleanSingleScopeItem(it).toLowerCase() === targetNorm
          );
          if (curIdx !== -1) {
            return {
              domain: 'SCOPE_ITEM',
              field: 'SCOPE_ITEM',
              targetItem: currentScopeItems[curIdx],
              targetIndex: curIdx,
              source: 'PREVIOUS_MUTATION',
            };
          }
        }
        return null;
      }

      // REPLACE_SCOPE_ITEM
      if (lastAct.type === 'REPLACE_SCOPE_ITEM') {
        // Section 7: the currently-existing referent is replacementItem, NOT the old targetItem
        // Section 11: no-op actions must NOT become candidates (already excluded from resolvedActions at persistence)
        if (
          lastAct.targetField === 'SCOPE_ITEM' &&
          typeof lastAct.replacementItem === 'string' &&
          lastAct.replacementItem.trim().length > 0
        ) {
          const cleanRepl = cleanSingleScopeItem(lastAct.replacementItem);
          const replNorm = cleanRepl.toLowerCase();
          const curIdx = currentScopeItems.findIndex(
            (it) => cleanSingleScopeItem(it).toLowerCase() === replNorm
          );
          if (curIdx !== -1) {
            return {
              domain: 'SCOPE_ITEM',
              field: 'SCOPE_ITEM',
              targetItem: currentScopeItems[curIdx],
              targetIndex: curIdx,
              source: 'PREVIOUS_MUTATION',
            };
          }
        }
        return null;
      }

      // REMOVE_SCOPE, CLEAR_SCOPE, REPLACE_SCOPE
      if (
        lastAct.type === 'REMOVE_SCOPE' ||
        lastAct.type === 'CLEAR_SCOPE' ||
        lastAct.type === 'REPLACE_SCOPE'
      ) {
        return null;
      }
    }
  }

  // 3. Immediately preceding INFORMATIONAL_SUBJECT on user message
  const lastUserMsg = msgs.slice().reverse().find((m) => m && m.role === 'user');
  if (lastUserMsg?.content && isEligibleInformationalSubjectTurn(lastUserMsg.content)) {
    const userText = lastUserMsg.content;
    if (/(?:budget|amount|cost|price)/i.test(userText) && !/(?:scope|deliverable|deadline|title)/i.test(userText)) {
      return { domain: 'SCALAR', field: 'BUDGET', source: 'INFORMATIONAL_SUBJECT' };
    }
    if (/(?:deadline|timeline|timeframe|duration|days)/i.test(userText) && !/(?:budget|scope|title)/i.test(userText)) {
      return { domain: 'SCALAR', field: 'DEADLINE', source: 'INFORMATIONAL_SUBJECT' };
    }
    if (/(?:title|name)/i.test(userText) && !/(?:budget|scope|deadline)/i.test(userText)) {
      return { domain: 'SCALAR', field: 'TITLE', source: 'INFORMATIONAL_SUBJECT' };
    }
    if (/(?:payment|milestones?)/i.test(userText) && !/(?:budget|scope|deadline)/i.test(userText)) {
      return { domain: 'SCALAR', field: 'PAYMENT', source: 'INFORMATIONAL_SUBJECT' };
    }
    if (/(?:freelancer|developer|seller)/i.test(userText) && !/(?:budget|scope|deadline)/i.test(userText)) {
      return { domain: 'SCALAR', field: 'SELLER', source: 'INFORMATIONAL_SUBJECT' };
    }
  }

  return null;
}

/**
 * Masks quoted spans (double, single, backtick) with empty quotes for semantic control inspection.
 * Prevents literal quoted data payloads from leaking into unanchored control and informational regexes.
 */
function maskQuotedControlSyntax(clause: string): string {
  if (!clause || typeof clause !== 'string') return '';
  const spans = findQuotedSpans(clause);
  if (spans.length === 0) return clause;

  let result = '';
  let lastIndex = 0;
  for (const span of spans) {
    result += clause.slice(lastIndex, span.start) + '""';
    lastIndex = span.end;
  }
  result += clause.slice(lastIndex);
  return result;
}

/**
 * Classifies a user turn into a primary intent, informational requests, and a set of deterministic semantic actions.
 * Segments compound prompts into clauses to prevent cross-clause prose capture.
 */
export function classifyUserTurn(
  text: string,
  currentScopeItems: string[] | string | null = null,
  history: any[] = [],
  preTurnState?: NegotiationStateData | null
): NegotiatorTurnClassification {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { primaryIntent: 'GENERAL_CONVERSATION', informationalRequests: [], informationalClauses: [], actions: [] };
  }

  const trimmed = text.trim();
  const clauses = segmentCommandClauses(trimmed);
  let rawActions: NegotiatorTurnAction[] = [];
  const informationalRequests: NegotiatorInformationalRequest[] = [];
  const informationalClauses: string[] = [];
  let isAnyClauseSearch = false;
  let isAnyClauseSelect = false;
  let isAnyClauseCancel = false;
  let isAnyClauseActivate = false;

  let sameTurnRefState: SameTurnReferenceState = { status: 'UNTOUCHED' };

  const workingScalar: WorkingScalarState = {
    title: preTurnState?.title?.value ? preTurnState.title.value.trim() : null,
    budgetAmount: preTurnState?.amount?.value?.amount || null,
    budgetAsset: preTurnState?.amount?.value?.asset || 'ETH',
    deadline: preTurnState?.deadline?.value?.raw ? preTurnState.deadline.value.raw.trim().toLowerCase() : null,
    paymentStructure: preTurnState?.paymentStructure?.value || null,
    seller: preTurnState?.seller?.value ? preTurnState.seller.value.trim().toLowerCase() : null,
  };

  const preTurnSellerName = preTurnState?.sellerName || (preTurnState?.seller?.value ? preTurnState.seller.value : null);

  const scopeBeforeTurn = Array.isArray(currentScopeItems)
    ? [...currentScopeItems]
    : currentScopeItems
    ? splitScopeItems(currentScopeItems)
    : [];
  let workingScopeItems = [...scopeBeforeTurn];

  for (const clause of clauses) {
    const actionsCountBeforeClause = rawActions.length;
    const controlClause = maskQuotedControlSyntax(clause);
    const interp = interpretClause(controlClause);

    const clauseInfos = detectInformationalRequests(controlClause);
    const isInformationalClause = isInformationalQuestion(controlClause);
    if (clauseInfos.length > 0 && isInformationalClause) {
      informationalClauses.push(clause);
    }
    for (const req of clauseInfos) {
      if (!informationalRequests.includes(req)) {
        informationalRequests.push(req);
      }
    }

    // Skip mutation extraction for NEGATED or KEEP clauses
    if (interp.polarity === 'NEGATED' || interp.isKeep) {
      continue;
    }

    // Skip mutation extraction for pure informational question clauses
    if (isInformationalClause) {
      continue;
    }

    // Check if immediately preceding turn had pending ADD awaiting destination
    const lastAiMsg = history.slice().reverse().find((m) => m && (m.role === 'ai' || m.role === 'assistant'));
    const aiMeta = getNegotiatorMessageMetadata(lastAiMsg);
    const pendingAdd = aiMeta.pendingClarification?.operation === 'ADD' ? aiMeta.pendingClarification : null;

    if (pendingAdd) {
      const followUpTarget = parseTargetFollowUp(clause);
      if (followUpTarget !== 'NONE') {
        const rawPendingVal = pendingAdd.value || '';
        const cleanPendingVal = rawPendingVal.replace(/^["'](.*)["']$/, '$1').trim();

        if (followUpTarget === 'SCOPE') {
          const itemsToAdd = (pendingAdd.items && pendingAdd.items.length > 0)
            ? pendingAdd.items
            : splitScopeItems(cleanPendingVal);

          if (itemsToAdd.length > 0) {
            const existingNorms = new Set(
              workingScopeItems.map((item) => cleanSingleScopeItem(item).toLowerCase())
            );
            const newItems = itemsToAdd.filter(
              (item) => !existingNorms.has(cleanSingleScopeItem(item).toLowerCase())
            );
            const updated = [...workingScopeItems, ...newItems];
            workingScopeItems = [...updated];

            rawActions.push({
              type: 'ADD_SCOPE',
              payload: {
                value: formatScopeItems(updated),
                items: updated,
                addedCount: newItems.length,
                addedItems: newItems,
              },
            });
            sameTurnRefState = { status: 'BLOCKED' };
            continue;
          }
        } else if (followUpTarget === 'TITLE') {
          workingScalar.title = cleanPendingVal;
          rawActions.push({ type: 'SET_TITLE', payload: { value: cleanPendingVal } });
          sameTurnRefState = {
            status: 'CANDIDATE',
            candidate: { domain: 'SCALAR', field: 'TITLE', source: 'SAME_TURN_MUTATION' },
          };
          continue;
        } else if (followUpTarget === 'BUDGET') {
          const bOp = parseBudgetOperation(cleanPendingVal) || parseBudgetOperation(`set budget to ${cleanPendingVal}`);
          if (bOp && bOp.type === 'VALID') {
            workingScalar.budgetAmount = bOp.amount;
            workingScalar.budgetAsset = bOp.asset;
            rawActions.push({ type: 'SET_AMOUNT', payload: { amount: bOp.amount, asset: bOp.asset } });
            sameTurnRefState = {
              status: 'CANDIDATE',
              candidate: { domain: 'SCALAR', field: 'BUDGET', source: 'SAME_TURN_MUTATION' },
            };
            continue;
          } else {
            rawActions.push({
              type: 'REQUEST_CLARIFICATION',
              payload: {
                kind: 'BUDGET',
                message: 'What budget would you like to set for the deal, and should it be ETH or USDC?',
                raw: clause,
              },
            });
            sameTurnRefState = { status: 'BLOCKED' };
            continue;
          }
        } else if (followUpTarget === 'DEADLINE') {
          const dlMatch = cleanPendingVal.match(/(\d+)\s*(?:days?|weeks?)/i);
          const calDl = !dlMatch ? parseExplicitCalendarDeadline(cleanPendingVal) : null;
          if (dlMatch) {
            const dlRaw = dlMatch[0];
            workingScalar.deadline = dlRaw.toLowerCase();
            rawActions.push({ type: 'SET_DEADLINE', payload: { raw: dlRaw } });
            sameTurnRefState = {
              status: 'CANDIDATE',
              candidate: { domain: 'SCALAR', field: 'DEADLINE', source: 'SAME_TURN_MUTATION' },
            };
            continue;
          } else if (calDl) {
            workingScalar.deadline = calDl;
            rawActions.push({ type: 'SET_DEADLINE', payload: { raw: calDl } });
            sameTurnRefState = {
              status: 'CANDIDATE',
              candidate: { domain: 'SCALAR', field: 'DEADLINE', source: 'SAME_TURN_MUTATION' },
            };
            continue;
          } else {
            rawActions.push({
              type: 'REQUEST_CLARIFICATION',
              payload: {
                kind: 'DEADLINE',
                message: 'What deadline would you like to set for the deal?',
                raw: clause,
              },
            });
            sameTurnRefState = { status: 'BLOCKED' };
            continue;
          }
        } else if (followUpTarget === 'PAYMENT') {
          const pVal = parsePaymentStructure(cleanPendingVal);

          if (pVal) {
            workingScalar.paymentStructure = pVal;
            rawActions.push({ type: 'SET_PAYMENT_STRUCTURE', payload: { value: pVal } });
            sameTurnRefState = {
              status: 'CANDIDATE',
              candidate: { domain: 'SCALAR', field: 'PAYMENT', source: 'SAME_TURN_MUTATION' },
            };
            continue;
          } else {
            rawActions.push({
              type: 'REQUEST_CLARIFICATION',
              payload: {
                kind: 'PAYMENT',
                message: 'How should payment be released: Single Release, 50/50 Milestones, or Custom Milestones?',
                raw: clause,
              },
            });
            sameTurnRefState = { status: 'BLOCKED' };
            continue;
          }
        } else if (followUpTarget === 'SELLER') {
          const addrMatch = cleanPendingVal.match(/0x[0-9a-fA-F]{40}/i);
          const handleMatch = cleanPendingVal.match(/@([a-zA-Z0-9_]{3,32})/i);
          if (addrMatch || handleMatch) {
            isAnyClauseSelect = true;
            rawActions.push({ type: 'SELECT_FREELANCER', payload: { raw: cleanPendingVal } });
            sameTurnRefState = { status: 'BLOCKED' };
            continue;
          } else {
            rawActions.push({
              type: 'REQUEST_CLARIFICATION',
              payload: {
                kind: 'SELLER',
                message: 'Which freelancer would you like to select?',
                raw: clause,
              },
            });
            sameTurnRefState = { status: 'BLOCKED' };
            continue;
          }
        }
      }
    }

    // Check if immediately preceding turn had pending CONFIRM awaiting confirmation
    const pendingConfirm = aiMeta.pendingClarification?.operation === 'CONFIRM' ? aiMeta.pendingClarification : null;
    if (pendingConfirm) {
      const isConfirmAffirmative = CONFIRM_AFFIRMATIVE_REGEX.test(clause.trim());
      const isConfirmNegative = CONFIRM_NEGATIVE_REGEX.test(clause.trim());
      const followUpTarget = parseTargetFollowUp(clause);
      const isSameTarget = followUpTarget !== 'NONE' && followUpTarget === pendingConfirm.targetField;
      const isDifferentTarget = followUpTarget !== 'NONE' && followUpTarget !== pendingConfirm.targetField;

      if (isConfirmAffirmative || isSameTarget) {
        if (pendingConfirm.targetField === 'BUDGET') {
          workingScalar.budgetAmount = pendingConfirm.value;
          workingScalar.budgetAsset = (pendingConfirm as any).asset || 'ETH';
          rawActions.push({
            type: 'SET_AMOUNT',
            payload: { amount: pendingConfirm.value, asset: (pendingConfirm as any).asset || 'ETH' },
          });
          sameTurnRefState = {
            status: 'CANDIDATE',
            candidate: { domain: 'SCALAR', field: 'BUDGET', source: 'SAME_TURN_MUTATION' },
          };
          continue;
        } else if (pendingConfirm.targetField === 'DEADLINE') {
          workingScalar.deadline = pendingConfirm.value.toLowerCase();
          rawActions.push({
            type: 'SET_DEADLINE',
            payload: { raw: pendingConfirm.value },
          });
          sameTurnRefState = {
            status: 'CANDIDATE',
            candidate: { domain: 'SCALAR', field: 'DEADLINE', source: 'SAME_TURN_MUTATION' },
          };
          continue;
        } else if (pendingConfirm.targetField === 'PAYMENT') {
          workingScalar.paymentStructure = pendingConfirm.value;
          rawActions.push({
            type: 'SET_PAYMENT_STRUCTURE',
            payload: { value: pendingConfirm.value },
          });
          sameTurnRefState = {
            status: 'CANDIDATE',
            candidate: { domain: 'SCALAR', field: 'PAYMENT', source: 'SAME_TURN_MUTATION' },
          };
          continue;
        }
      } else if (isConfirmNegative) {
        let targetNoun = 'budget';
        if (pendingConfirm.targetField === 'DEADLINE') targetNoun = 'deadline';
        else if (pendingConfirm.targetField === 'PAYMENT') targetNoun = 'payment structure';

        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: {
            kind: 'REJECT_CONFIRMATION',
            message: `Okay, I won't change the ${targetNoun}.`,
            raw: clause,
          },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      } else if (isDifferentTarget) {
        let diffMsg = `"${pendingConfirm.value}" is not valid for ${followUpTarget.toLowerCase()}.`;
        if (followUpTarget === 'DEADLINE') {
          diffMsg = `${pendingConfirm.value} isn't a valid deadline. Please provide a timeframe such as 10 days or 3 weeks.`;
        } else if (followUpTarget === 'BUDGET') {
          diffMsg = `${pendingConfirm.value} isn't a valid budget. Please specify an amount and currency (e.g. 0.5 ETH or 500 USDC).`;
        } else if (followUpTarget === 'PAYMENT') {
          diffMsg = `${pendingConfirm.value} isn't a valid payment structure. Please specify 50/50 Milestones or Single Release.`;
        } else if (followUpTarget === 'SCOPE') {
          diffMsg = `${pendingConfirm.value} cannot be set as scope. Please specify the deliverables you'd like to add.`;
        } else if (followUpTarget === 'TITLE') {
          diffMsg = `${pendingConfirm.value} is not a valid title. Please specify a descriptive title.`;
        } else if (followUpTarget === 'SELLER') {
          diffMsg = `${pendingConfirm.value} is not a valid freelancer address or handle.`;
        }

        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: {
            kind: 'INCOMPATIBLE_CORRECTION',
            message: diffMsg,
            raw: clause,
          },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }
    } else {
      // Guard: Phase 3B.2B Stale Confirmation After Explicit Clear or Rejection
      const supersededTarget = detectRecentSupersededConfirmation(history);
      if (supersededTarget && CONFIRM_AFFIRMATIVE_REGEX.test(clause.trim())) {
        const staleMsg = renderSupersededConfirmationMessage(supersededTarget);
        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: {
            kind: 'SUPERSEDED_CONFIRMATION',
            targetField: supersededTarget,
            message: staleMsg,
            raw: clause,
          },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }
    }

    // Phase 3B.1 / 3B.2: Exact bare scalar clear commands
    const scalarClear = parseScalarClearCommand(clause);
    if (scalarClear === 'BUDGET') {
      workingScalar.budgetAmount = null;
      rawActions.push({
        type: 'CLEAR_AMOUNT',
        payload: { targetField: 'BUDGET' },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }
    if (scalarClear === 'DEADLINE') {
      workingScalar.deadline = null;
      rawActions.push({
        type: 'CLEAR_DEADLINE',
        payload: { targetField: 'DEADLINE' },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }
    if (scalarClear === 'PAYMENT') {
      workingScalar.paymentStructure = null;
      rawActions.push({
        type: 'CLEAR_PAYMENT_STRUCTURE',
        payload: { targetField: 'PAYMENT' },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }
    if (scalarClear === 'SELLER') {
      workingScalar.seller = null;
      rawActions.push({
        type: 'CLEAR_SELLER',
        payload: { targetField: 'SELLER' },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }
    if (scalarClear === 'TITLE') {
      workingScalar.title = null;
      rawActions.push({
        type: 'CLEAR_TITLE',
        payload: { targetField: 'TITLE' },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }

    // Defensive barrier: Value-qualified scalar removal commands (e.g. "remove 0.5 ETH from budget", "remove 10 days from deadline")
    // must NOT clear the field, subtract values, or leak into Scope item removal.
    const isValQualifiedBudgetRemoval =
      /^(?:please\s+)?(?:remove|drop|delete|subtract|take\s+out)\s+(.+?)\s+(?:from|out\s+of)\s+(?:the\s+)?budget[.\s]*$/i.test(controlClause);
    if (isValQualifiedBudgetRemoval) {
      const match = clause.match(/^(?:please\s+)?(?:remove|drop|delete|subtract|take\s+out)\s+(.+?)\s+(?:from|out\s+of)\s+(?:the\s+)?budget[.\s]*$/i);
      const rawPayload = match ? match[1].trim() : '';
      const isEligibleReferentialVerb = /^(?:please\s+)?(?:remove|delete|drop)\b/i.test(controlClause);
      const refMatch = rawPayload.match(/^(?:that|this)\s+(.+)$/i);

      if (isEligibleReferentialVerb && refMatch) {
        const refVal = stripMatchingOuterQuote(refMatch[1]);
        if (workingScalar.budgetAmount === null) {
          rawActions.push({
            type: 'REQUEST_CLARIFICATION',
            payload: {
              kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
              message: 'The budget is already unset.',
              raw: clause,
            },
          });
        } else if (isBudgetReferentialMatch(refVal, workingScalar.budgetAmount, workingScalar.budgetAsset)) {
          workingScalar.budgetAmount = null;
          rawActions.push({
            type: 'CLEAR_AMOUNT',
            payload: { targetField: 'BUDGET' },
          });
        } else {
          rawActions.push({
            type: 'REQUEST_CLARIFICATION',
            payload: {
              kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
              message: `The current budget is ${workingScalar.budgetAmount} ${workingScalar.budgetAsset}, not ${refVal}. If you want to remove the budget entirely, say "clear budget".`,
              raw: clause,
            },
          });
        }
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }

      const budgetMsg =
        workingScalar.budgetAmount === null
          ? 'The budget is already unset.'
          : 'Budget is a single total amount. If you want to change it, tell me the new total amount, for example "set budget to 1 ETH". To remove it entirely, say "clear budget".';
      rawActions.push({
        type: 'REQUEST_CLARIFICATION',
        payload: {
          kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
          message: budgetMsg,
          raw: clause,
        },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }

    const isValQualifiedDeadlineRemoval =
      /^(?:please\s+)?(?:remove|drop|delete|subtract|take\s+out)\s+(.+?)\s+(?:from|out\s+of)\s+(?:the\s+)?deadline[.\s]*$/i.test(controlClause);
    if (isValQualifiedDeadlineRemoval) {
      const match = clause.match(/^(?:please\s+)?(?:remove|drop|delete|subtract|take\s+out)\s+(.+?)\s+(?:from|out\s+of)\s+(?:the\s+)?deadline[.\s]*$/i);
      const rawPayload = match ? match[1].trim() : '';
      const isEligibleReferentialVerb = /^(?:please\s+)?(?:remove|delete|drop)\b/i.test(controlClause);
      const refMatch = rawPayload.match(/^(?:that|this)\s+(.+)$/i);

      if (isEligibleReferentialVerb && refMatch) {
        const refVal = stripMatchingOuterQuote(refMatch[1]);
        if (workingScalar.deadline === null) {
          rawActions.push({
            type: 'REQUEST_CLARIFICATION',
            payload: {
              kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
              message: 'The deadline is already unset.',
              raw: clause,
            },
          });
        } else if (isDeadlineReferentialMatch(refVal, workingScalar.deadline)) {
          workingScalar.deadline = null;
          rawActions.push({
            type: 'CLEAR_DEADLINE',
            payload: { targetField: 'DEADLINE' },
          });
        } else {
          rawActions.push({
            type: 'REQUEST_CLARIFICATION',
            payload: {
              kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
              message: `The current deadline is ${workingScalar.deadline}, not ${refVal}. If you want to remove the deadline entirely, say "clear deadline".`,
              raw: clause,
            },
          });
        }
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }

      const deadlineMsg =
        workingScalar.deadline === null
          ? 'The deadline is already unset.'
          : 'Deadline is a single value. If you want to change it, tell me the new deadline. To remove it entirely, say "clear deadline".';
      rawActions.push({
        type: 'REQUEST_CLARIFICATION',
        payload: {
          kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
          message: deadlineMsg,
          raw: clause,
        },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }

    const isValQualifiedPaymentRemoval =
      /^(?:please\s+)?(?:remove|drop|delete|subtract|take\s+out)\s+(.+?)\s+(?:from|out\s+of)\s+(?:the\s+)?payment(?:\s+structure)?[.\s]*$/i.test(controlClause);
    if (isValQualifiedPaymentRemoval) {
      const match = clause.match(/^(?:please\s+)?(?:remove|drop|delete|subtract|take\s+out)\s+(.+?)\s+(?:from|out\s+of)\s+(?:the\s+)?payment(?:\s+structure)?[.\s]*$/i);
      const rawPayload = match ? match[1].trim() : '';
      const isEligibleReferentialVerb = /^(?:please\s+)?(?:remove|delete|drop)\b/i.test(controlClause);
      const refMatch = rawPayload.match(/^(?:that|this)\s+(.+)$/i);

      if (isEligibleReferentialVerb && refMatch) {
        const refVal = stripMatchingOuterQuote(refMatch[1]);
        if (workingScalar.paymentStructure === null) {
          rawActions.push({
            type: 'REQUEST_CLARIFICATION',
            payload: {
              kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
              message: 'The payment structure is already unset.',
              raw: clause,
            },
          });
        } else if (isPaymentReferentialMatch(refVal, workingScalar.paymentStructure)) {
          workingScalar.paymentStructure = null;
          rawActions.push({
            type: 'CLEAR_PAYMENT_STRUCTURE',
            payload: { targetField: 'PAYMENT' },
          });
        } else {
          const curLabel =
            workingScalar.paymentStructure === '50-50'
              ? '50/50 Milestones'
              : workingScalar.paymentStructure === 'single'
              ? 'Single Release'
              : 'Custom Milestones';
          rawActions.push({
            type: 'REQUEST_CLARIFICATION',
            payload: {
              kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
              message: `The current payment structure is ${curLabel}, not ${refVal}. If you want to remove it entirely, say "clear payment".`,
              raw: clause,
            },
          });
        }
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }

      const paymentMsg =
        workingScalar.paymentStructure === null
          ? 'The payment structure is already unset.'
          : 'Payment structure is a single setting. If you want to change it, tell me the payment structure you want. To remove it entirely, say "clear payment".';
      rawActions.push({
        type: 'REQUEST_CLARIFICATION',
        payload: {
          kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
          message: paymentMsg,
          raw: clause,
        },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }

    const isValQualifiedSellerRemoval =
      /^(?:please\s+)?(?:remove|drop|delete|subtract|take\s+out)\s+(.+?)\s+(?:from|out\s+of)\s+(?:the\s+)?(?:freelancer|seller)[.\s]*$/i.test(controlClause);
    if (isValQualifiedSellerRemoval) {
      const match = clause.match(/^(?:please\s+)?(?:remove|drop|delete|subtract|take\s+out)\s+(.+?)\s+(?:from|out\s+of)\s+(?:the\s+)?(?:freelancer|seller)[.\s]*$/i);
      const rawPayload = match ? match[1].trim() : '';
      const isEligibleReferentialVerb = /^(?:please\s+)?(?:remove|delete|drop)\b/i.test(controlClause);
      const refMatch = rawPayload.match(/^(?:that|this)\s+(.+)$/i);

      if (isEligibleReferentialVerb && refMatch) {
        const refVal = stripMatchingOuterQuote(refMatch[1]);
        if (workingScalar.seller === null) {
          rawActions.push({
            type: 'REQUEST_CLARIFICATION',
            payload: {
              kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
              message: 'No freelancer is currently selected.',
              raw: clause,
            },
          });
        } else if (isSellerReferentialMatch(refVal, workingScalar.seller)) {
          workingScalar.seller = null;
          rawActions.push({
            type: 'CLEAR_SELLER',
            payload: { targetField: 'SELLER' },
          });
        } else {
          rawActions.push({
            type: 'REQUEST_CLARIFICATION',
            payload: {
              kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
              message: `The current freelancer doesn't match that identifier. If you want to remove the current freelancer, say "clear freelancer".`,
              raw: clause,
            },
          });
        }
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }

      const sellerMsg =
        workingScalar.seller === null
          ? 'No freelancer is currently selected.'
          : 'Freelancer selection is a single value. If you want to choose someone else, select the new freelancer. To remove the current freelancer, say "clear freelancer".';
      rawActions.push({
        type: 'REQUEST_CLARIFICATION',
        payload: {
          kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
          message: sellerMsg,
          raw: clause,
        },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }

    const isValQualifiedTitleRemoval =
      /^(?:please\s+)?(?:remove|drop|delete|subtract|take\s+out)\s+(.+?)\s+(?:from|out\s+of)\s+(?:the\s+)?(?:deal\s+)?title[.\s]*$/i.test(controlClause);
    if (isValQualifiedTitleRemoval) {
      const match = clause.match(/^(?:please\s+)?(?:remove|drop|delete|subtract|take\s+out)\s+(.+?)\s+(?:from|out\s+of)\s+(?:the\s+)?(?:deal\s+)?title[.\s]*$/i);
      const rawPayload = match ? match[1].trim() : '';
      const isEligibleReferentialVerb = /^(?:please\s+)?(?:remove|delete|drop)\b/i.test(controlClause);
      const refMatch = rawPayload.match(/^(?:that|this)\s+(.+)$/i);

      if (isEligibleReferentialVerb && refMatch) {
        const refVal = stripMatchingOuterQuote(refMatch[1]);
        if (workingScalar.title === null) {
          rawActions.push({
            type: 'REQUEST_CLARIFICATION',
            payload: {
              kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
              message: 'The deal title is already unset.',
              raw: clause,
            },
          });
        } else if (isTitleReferentialMatch(refVal, workingScalar.title)) {
          workingScalar.title = null;
          rawActions.push({
            type: 'CLEAR_TITLE',
            payload: { targetField: 'TITLE' },
          });
        } else {
          rawActions.push({
            type: 'REQUEST_CLARIFICATION',
            payload: {
              kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
              message: `The current title is "${workingScalar.title}", not "${refVal}". If you want to remove it entirely, say "clear title".`,
              raw: clause,
            },
          });
        }
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }

      const titleMsg =
        workingScalar.title === null
          ? 'The deal title is already unset.'
          : 'Deal title is a single value. If you want to change it, tell me the new title. To remove it entirely, say "clear title".';
      rawActions.push({
        type: 'REQUEST_CLARIFICATION',
        payload: {
          kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
          message: titleMsg,
          raw: clause,
        },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }

    // Defensive barrier: "remove current budget" / "remove current deadline" / "remove current payment" / "remove current freelancer" / "remove current title"
    // must NOT clear the field, remove scope items, or leak into scope removal.
    const isRemoveCurrentBudget =
      /^(?:please\s+)?(?:remove|drop|delete|clear|reset)\s+(?:the\s+)?current\s+(?:budget|amount|price|cost)[.\s]*$/i.test(controlClause);
    if (isRemoveCurrentBudget) {
      const budgetMsg =
        workingScalar.budgetAmount === null
          ? 'The budget is already unset.'
          : 'Budget is a single total amount. If you want to change it, tell me the new total amount, for example "set budget to 1 ETH". To remove it entirely, say "clear budget".';
      rawActions.push({
        type: 'REQUEST_CLARIFICATION',
        payload: {
          kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
          message: budgetMsg,
          raw: clause,
        },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }

    const isRemoveCurrentDeadline =
      /^(?:please\s+)?(?:remove|drop|delete|clear|reset)\s+(?:the\s+)?current\s+(?:deadline|timeline|timeframe)[.\s]*$/i.test(controlClause);
    if (isRemoveCurrentDeadline) {
      const deadlineMsg =
        workingScalar.deadline === null
          ? 'The deadline is already unset.'
          : 'Deadline is a single value. If you want to change it, tell me the new deadline. To remove it entirely, say "clear deadline".';
      rawActions.push({
        type: 'REQUEST_CLARIFICATION',
        payload: {
          kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
          message: deadlineMsg,
          raw: clause,
        },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }

    const isRemoveCurrentPayment =
      /^(?:please\s+)?(?:remove|drop|delete|clear|reset)\s+(?:the\s+)?current\s+payment(?:\s+structure)?[.\s]*$/i.test(controlClause);
    if (isRemoveCurrentPayment) {
      const paymentMsg =
        workingScalar.paymentStructure === null
          ? 'The payment structure is already unset.'
          : 'Payment structure is a single setting. If you want to change it, tell me the payment structure you want. To remove it entirely, say "clear payment".';
      rawActions.push({
        type: 'REQUEST_CLARIFICATION',
        payload: {
          kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
          message: paymentMsg,
          raw: clause,
        },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }

    const isRemoveCurrentSeller =
      /^(?:please\s+)?(?:remove|drop|delete|clear|reset)\s+(?:the\s+)?current\s+(?:freelancer|seller)[.\s]*$/i.test(controlClause);
    if (isRemoveCurrentSeller) {
      const sellerMsg =
        workingScalar.seller === null
          ? 'No freelancer is currently selected.'
          : 'Freelancer selection is a single value. If you want to choose someone else, select the new freelancer. To remove the current freelancer, say "clear freelancer".';
      rawActions.push({
        type: 'REQUEST_CLARIFICATION',
        payload: {
          kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
          message: sellerMsg,
          raw: clause,
        },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }

    const isRemoveCurrentTitle =
      /^(?:please\s+)?(?:remove|drop|delete|clear|reset)\s+(?:the\s+)?current\s+(?:deal\s+)?title[.\s]*$/i.test(controlClause);
    if (isRemoveCurrentTitle) {
      const titleMsg =
        workingScalar.title === null
          ? 'The deal title is already unset.'
          : 'Deal title is a single value. If you want to change it, tell me the new title. To remove it entirely, say "clear title".';
      rawActions.push({
        type: 'REQUEST_CLARIFICATION',
        payload: {
          kind: 'UNSUPPORTED_SCALAR_SUBTRACTION',
          message: titleMsg,
          raw: clause,
        },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }

    // Tier 3: Referential Value + Whole-Draft Target (e.g. "remove that 50/50 from the draft", "delete that 10 days from the deal")
    const isWholeDraftReferentialRemove =
      /^(?:please\s+)?(?:remove|delete|drop)\s+(?:that|this)\s+(.+?)\s+(?:from|out\s+of)\s+(?:the\s+)?(?:draft|deal|terms|agreement)[.\s]*$/i.test(controlClause);
    if (isWholeDraftReferentialRemove) {
      const match = clause.match(/^(?:please\s+)?(?:remove|delete|drop)\s+(?:that|this)\s+(.+?)\s+(?:from|out\s+of)\s+(?:the\s+)?(?:draft|deal|terms|agreement)[.\s]*$/i);
      const rawDraftRefPayload = match ? match[1].trim() : '';
      const draftRefPayload = stripMatchingOuterQuote(rawDraftRefPayload);

      // 1. Identify all currently SET scalar fields that authoritatively match draftRefPayload
      const candidateFields: ScalarReferenceField[] = [];

      if (workingScalar.budgetAmount !== null && isBudgetReferentialMatch(draftRefPayload, workingScalar.budgetAmount, workingScalar.budgetAsset)) {
        candidateFields.push('BUDGET');
      }
      if (workingScalar.deadline !== null && isDeadlineReferentialMatch(draftRefPayload, workingScalar.deadline)) {
        candidateFields.push('DEADLINE');
      }
      if (workingScalar.paymentStructure !== null && isPaymentReferentialMatch(draftRefPayload, workingScalar.paymentStructure)) {
        candidateFields.push('PAYMENT');
      }
      if (workingScalar.title !== null && isTitleReferentialMatch(draftRefPayload, workingScalar.title)) {
        candidateFields.push('TITLE');
      }
      if (workingScalar.seller !== null && isSellerReferentialMatch(draftRefPayload, workingScalar.seller)) {
        candidateFields.push('SELLER');
      }

      // 2. Identify all Scope items that authoritatively match draftRefPayload via normalized exact equality
      const normPayload = cleanSingleScopeItem(draftRefPayload).trim().toLowerCase();
      const matchingScopeIndices = workingScopeItems
        .map((item, idx) => (cleanSingleScopeItem(item).trim().toLowerCase() === normPayload ? idx : -1))
        .filter((idx) => idx !== -1);

      // Case 1: True Cross-Domain Collision (both scalar deal term(s) and deliverable(s) match)
      if (candidateFields.length > 0 && matchingScopeIndices.length > 0) {
        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: {
            kind: 'GENERAL_CHANGE',
            message: `Both a deal term and a deliverable mention "${draftRefPayload}". Which one would you like to remove?`,
            raw: clause,
          },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }

      // Case 2: Multiple Scalar Matches (multiple distinct scalar fields match)
      if (candidateFields.length > 1 && matchingScopeIndices.length === 0) {
        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: {
            kind: 'GENERAL_CHANGE',
            message: `Multiple draft terms match "${draftRefPayload}". Which one would you like to remove?`,
            raw: clause,
          },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }

      // Case 3: Multiple Scope Matches (multiple deliverables match)
      if (candidateFields.length === 0 && matchingScopeIndices.length > 1) {
        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: {
            kind: 'GENERAL_CHANGE',
            message: `Multiple deliverables match "${draftRefPayload}". Which one would you like to remove?`,
            raw: clause,
          },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }

      // Case 4: Unique Scalar Match
      if (candidateFields.length === 1 && matchingScopeIndices.length === 0) {
        const uniqueField = candidateFields[0];
        if (uniqueField === 'BUDGET') {
          workingScalar.budgetAmount = null;
          rawActions.push({ type: 'CLEAR_AMOUNT', payload: { targetField: 'BUDGET' } });
        } else if (uniqueField === 'DEADLINE') {
          workingScalar.deadline = null;
          rawActions.push({ type: 'CLEAR_DEADLINE', payload: { targetField: 'DEADLINE' } });
        } else if (uniqueField === 'PAYMENT') {
          workingScalar.paymentStructure = null;
          rawActions.push({ type: 'CLEAR_PAYMENT_STRUCTURE', payload: { targetField: 'PAYMENT' } });
        } else if (uniqueField === 'TITLE') {
          workingScalar.title = null;
          rawActions.push({ type: 'CLEAR_TITLE', payload: { targetField: 'TITLE' } });
        } else if (uniqueField === 'SELLER') {
          workingScalar.seller = null;
          rawActions.push({ type: 'CLEAR_SELLER', payload: { targetField: 'SELLER' } });
        }
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }

      // Case 5: Unique Scope Match
      if (candidateFields.length === 0 && matchingScopeIndices.length === 1) {
        const targetIndex = matchingScopeIndices[0];
        const targetItem = workingScopeItems[targetIndex];
        const remainingItems = workingScopeItems.filter((_, idx) => idx !== targetIndex);
        workingScopeItems = [...remainingItems];
        rawActions.push({
          type: 'REMOVE_SCOPE',
          payload: {
            value: formatScopeItems(remainingItems),
            items: remainingItems,
            targetItem,
            targetIndex,
            removedCount: 1,
          },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }

      // Case 6: Zero Matches
      rawActions.push({
        type: 'REQUEST_CLARIFICATION',
        payload: {
          kind: 'GENERAL_CHANGE',
          message: `I couldn't find "${draftRefPayload}" in the current draft terms.`,
          raw: clause,
        },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }

    // Natural milestone(s) referential resolution: ambiguous container with candidate domains PAYMENT and SCOPE ONLY
    const isMilestoneReferentialRemove =
      /^(?:please\s+)?(?:remove|delete|drop)\s+(?:that|this)\s+(.+?)\s+(?:from|out\s+of)\s+(?:the\s+)?milestones?[.\s]*$/i.test(controlClause);
    if (isMilestoneReferentialRemove) {
      const match = clause.match(/^(?:please\s+)?(?:remove|delete|drop)\s+(?:that|this)\s+(.+?)\s+(?:from|out\s+of)\s+(?:the\s+)?milestones?[.\s]*$/i);
      const rawPayload = match ? match[1].trim() : '';
      const milestonePayload = stripMatchingOuterQuote(rawPayload);

      // 1. Payment candidate: authoritatively matches existing canonical payment structure
      const isPaymentMatch =
        workingScalar.paymentStructure !== null &&
        isPaymentReferentialMatch(milestonePayload, workingScalar.paymentStructure);

      // 2. Scope candidates: normalized exact equality matching against existing deliverables
      const normPayload = cleanSingleScopeItem(milestonePayload).trim().toLowerCase();
      const matchingScopeIndices = workingScopeItems
        .map((item, idx) => (cleanSingleScopeItem(item).trim().toLowerCase() === normPayload ? idx : -1))
        .filter((idx) => idx !== -1);

      // Case 1: True Payment/Scope Collision
      if (isPaymentMatch && matchingScopeIndices.length > 0) {
        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: {
            kind: 'GENERAL_CHANGE',
            message: `Both the payment structure and a deliverable match "${milestonePayload}". Which one would you like to remove?`,
            raw: clause,
          },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }

      // Case 2: Multiple Scope Matches
      if (!isPaymentMatch && matchingScopeIndices.length > 1) {
        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: {
            kind: 'GENERAL_CHANGE',
            message: `Multiple deliverables match "${milestonePayload}". Which one would you like to remove?`,
            raw: clause,
          },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }

      // Case 3: Unique Payment Match
      if (isPaymentMatch && matchingScopeIndices.length === 0) {
        workingScalar.paymentStructure = null;
        rawActions.push({
          type: 'CLEAR_PAYMENT_STRUCTURE',
          payload: { targetField: 'PAYMENT' },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }

      // Case 4: Unique Scope Match
      if (!isPaymentMatch && matchingScopeIndices.length === 1) {
        const targetIndex = matchingScopeIndices[0];
        const targetItem = workingScopeItems[targetIndex];
        const remainingItems = workingScopeItems.filter((_, idx) => idx !== targetIndex);
        workingScopeItems = [...remainingItems];
        rawActions.push({
          type: 'REMOVE_SCOPE',
          payload: {
            value: formatScopeItems(remainingItems),
            items: remainingItems,
            targetItem,
            targetIndex,
            removedCount: 1,
          },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }

      // Case 5: Zero Matches
      rawActions.push({
        type: 'REQUEST_CLARIFICATION',
        payload: {
          kind: 'GENERAL_CHANGE',
          message: `I couldn't find "${milestonePayload}" in the current milestones or payment terms.`,
          raw: clause,
        },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }

    // Check if clause is a bare ADD (no explicit target destination)
    const isAddVerb = /^(?:please\s+)?(?:also\s+)?(?:add|include)\b/i.test(controlClause);
    const explicitTarget = detectExplicitTarget(clause);

    if (isAddVerb && explicitTarget === 'NONE') {
      const rawPayload = clause.replace(/^(?:please\s+)?(?:also\s+)?(?:add|include)\s+/i, '').trim();
      let cleanPayload = rawPayload.replace(/^["'](.*)["']$/, '$1').trim();
      cleanPayload = cleanPayload.replace(/[.,;]+$/, '').trim();
      const items = splitScopeItems(cleanPayload);

      rawActions.push({
        type: 'REQUEST_CLARIFICATION',
        payload: {
          kind: 'AMBIGUOUS_ADD',
          message: `Where would you like me to add "${cleanPayload}"?`,
          value: cleanPayload,
          items: items.length > 0 ? items : [cleanPayload],
          raw: clause,
        },
      });
      sameTurnRefState = { status: 'BLOCKED' };
      continue;
    }

    // Explicit non-scope target routing: once a target is identified, it owns the clause
    if (explicitTarget === 'BUDGET') {
      const bOp = parseBudgetOperation(controlClause) || parseBudgetOperation(clause);
      if (bOp && bOp.type === 'VALID') {
        workingScalar.budgetAmount = bOp.amount;
        workingScalar.budgetAsset = bOp.asset;
        rawActions.push({ type: 'SET_AMOUNT', payload: { amount: bOp.amount, asset: bOp.asset } });
        sameTurnRefState = {
          status: 'CANDIDATE',
          candidate: { domain: 'SCALAR', field: 'BUDGET', source: 'SAME_TURN_MUTATION' },
        };
      } else if (bOp && bOp.type === 'UNSUPPORTED_ASSET') {
        rawActions.push({ type: 'UNSUPPORTED_ASSET', payload: { amount: bOp.amount, asset: bOp.asset } });
        sameTurnRefState = { status: 'BLOCKED' };
      } else if (bOp && bOp.type === 'AMBIGUOUS_ASSET') {
        rawActions.push({ type: 'AMBIGUOUS_ASSET', payload: { amount: bOp.amount, symbol: bOp.symbol } });
        sameTurnRefState = { status: 'BLOCKED' };
      } else if (bOp && bOp.type === 'MISSING_ASSET') {
        rawActions.push({ type: 'MISSING_ASSET', payload: { amount: bOp.amount } });
        sameTurnRefState = { status: 'BLOCKED' };
      } else {
        const rawPayload = extractExplicitTargetPayload(clause, 'BUDGET');
        const valKind = detectDiagnosticValueKind(rawPayload);
        const op: 'ADD' | 'SET' | 'CHANGE' = /^(?:please\s+)?(?:also\s+)?add\b/i.test(controlClause)
          ? 'ADD'
          : /^(?:please\s+)?(?:change|update|modify)\b/i.test(controlClause)
          ? 'CHANGE'
          : 'SET';

        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: {
            kind: 'BUDGET',
            message: 'What budget would you like to set for the deal, and should it be ETH or USDC?',
            raw: clause,
            diagnostic: {
              reason: 'INVALID_VALUE_FOR_TARGET',
              operation: op,
              requestedTarget: 'BUDGET',
              rawValue: rawPayload,
              detectedValueKind: valKind,
            },
          },
        });
        sameTurnRefState = { status: 'BLOCKED' };
      }
      continue;
    }

    if (explicitTarget === 'DEADLINE') {
      const dlMatch = (clause.match(/(\d+)\s*days?/i) || clause.match(/(\d+)\s*weeks?/i));
      if (dlMatch) {
        const dlRaw = dlMatch[0];
        workingScalar.deadline = dlRaw.toLowerCase();
        rawActions.push({ type: 'SET_DEADLINE', payload: { raw: dlRaw } });
        sameTurnRefState = {
          status: 'CANDIDATE',
          candidate: { domain: 'SCALAR', field: 'DEADLINE', source: 'SAME_TURN_MUTATION' },
        };
      } else {
        const rawPayload = extractExplicitTargetPayload(clause, 'DEADLINE');
        const calDl = parseExplicitCalendarDeadline(rawPayload);
        if (calDl) {
          workingScalar.deadline = calDl;
          rawActions.push({ type: 'SET_DEADLINE', payload: { raw: calDl } });
          sameTurnRefState = {
            status: 'CANDIDATE',
            candidate: { domain: 'SCALAR', field: 'DEADLINE', source: 'SAME_TURN_MUTATION' },
          };
        } else {
          const valKind = detectDiagnosticValueKind(rawPayload);
          const op: 'ADD' | 'SET' | 'CHANGE' = /^(?:please\s+)?(?:also\s+)?add\b/i.test(controlClause)
            ? 'ADD'
            : /^(?:please\s+)?(?:change|update|modify)\b/i.test(controlClause)
            ? 'CHANGE'
            : 'SET';

          rawActions.push({
            type: 'REQUEST_CLARIFICATION',
            payload: {
              kind: 'DEADLINE',
              message: 'What deadline would you like to set for the deal?',
              raw: clause,
              diagnostic: {
                reason: 'INVALID_VALUE_FOR_TARGET',
                operation: op,
                requestedTarget: 'DEADLINE',
                rawValue: rawPayload,
                detectedValueKind: valKind,
              },
            },
          });
          sameTurnRefState = { status: 'BLOCKED' };
        }
      }
      continue;
    }

    if (explicitTarget === 'PAYMENT') {
      const pVal = parsePaymentStructure(clause);

      if (pVal) {
        workingScalar.paymentStructure = pVal;
        rawActions.push({ type: 'SET_PAYMENT_STRUCTURE', payload: { value: pVal } });
        sameTurnRefState = {
          status: 'CANDIDATE',
          candidate: { domain: 'SCALAR', field: 'PAYMENT', source: 'SAME_TURN_MUTATION' },
        };
      } else {
        const rawPayload = extractExplicitTargetPayload(clause, 'PAYMENT');
        const valKind = detectDiagnosticValueKind(rawPayload);
        const op: 'ADD' | 'SET' | 'CHANGE' = /^(?:please\s+)?(?:also\s+)?add\b/i.test(controlClause)
          ? 'ADD'
          : /^(?:please\s+)?(?:change|update|modify)\b/i.test(controlClause)
          ? 'CHANGE'
          : 'SET';

        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: {
            kind: 'PAYMENT',
            message: 'How should payment be released: Single Release, 50/50 Milestones, or Custom Milestones?',
            raw: clause,
            diagnostic: {
              reason: 'INVALID_VALUE_FOR_TARGET',
              operation: op,
              requestedTarget: 'PAYMENT',
              rawValue: rawPayload,
              detectedValueKind: valKind,
            },
          },
        });
        sameTurnRefState = { status: 'BLOCKED' };
      }
      continue;
    }

    if (explicitTarget === 'SELLER') {
      const addrMatch = clause.match(/0x[0-9a-fA-F]{40}/i);
      const handleMatch = clause.match(/@([a-zA-Z0-9_]{3,32})/i);
      if (addrMatch || handleMatch) {
        isAnyClauseSelect = true;
        rawActions.push({ type: 'SELECT_FREELANCER', payload: { raw: clause } });
        const normSel = addrMatch ? addrMatch[0].toLowerCase() : handleMatch ? handleMatch[0].toLowerCase() : clause.trim().toLowerCase();
        workingScalar.seller = normSel;
        sameTurnRefState = {
          status: 'CANDIDATE',
          candidate: { domain: 'SCALAR', field: 'SELLER', source: 'SAME_TURN_MUTATION' },
        };
      } else {
        const rawPayload = extractExplicitTargetPayload(clause, 'SELLER');
        const valKind = detectDiagnosticValueKind(rawPayload);
        const op: 'ADD' | 'SET' | 'CHANGE' = /^(?:please\s+)?(?:also\s+)?add\b/i.test(controlClause)
          ? 'ADD'
          : /^(?:please\s+)?(?:change|update|modify)\b/i.test(controlClause)
          ? 'CHANGE'
          : 'SET';

        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: {
            kind: 'SELLER',
            message: 'Which freelancer would you like to select?',
            raw: clause,
            diagnostic: {
              reason: 'INVALID_VALUE_FOR_TARGET',
              operation: op,
              requestedTarget: 'SELLER',
              rawValue: rawPayload,
              detectedValueKind: valKind,
            },
          },
        });
        sameTurnRefState = { status: 'BLOCKED' };
      }
      continue;
    }

    if (explicitTarget === 'TITLE') {
      const parsedTitle = parseTitleOperation(clause);
      if (parsedTitle) {
        const cleanTitle = parsedTitle.trim();
        workingScalar.title = cleanTitle;
        rawActions.push({ type: 'SET_TITLE', payload: { value: cleanTitle } });
        sameTurnRefState = {
          status: 'CANDIDATE',
          candidate: { domain: 'SCALAR', field: 'TITLE', source: 'SAME_TURN_MUTATION' },
        };
      } else {
        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: {
            kind: 'TITLE',
            message: 'What title would you like to set for the deal?',
            raw: clause,
          },
        });
        sameTurnRefState = { status: 'BLOCKED' };
      }
      continue;
    }

    // Check 1: Cancel draft action
    const isCancel = isExplicitDraftCancellation(controlClause);
    if (isCancel) {
      isAnyClauseCancel = true;
      if (!rawActions.some((a) => a.type === 'CANCEL_DRAFT')) {
        rawActions.push({ type: 'CANCEL_DRAFT' });
      }
      sameTurnRefState = { status: 'BLOCKED' };
    }

    // Check 2: Explicit activation action
    const isActivate = isExplicitDraftActivation(controlClause);
    if (isActivate) {
      isAnyClauseActivate = true;
      if (!rawActions.some((a) => a.type === 'ACTIVATE_DRAFT')) {
        rawActions.push({ type: 'ACTIVATE_DRAFT' });
      }
      sameTurnRefState = { status: 'BLOCKED' };
    }

    // Check 3: Seller selection action (only if clause does not explicitly target scope)
    if (explicitTarget !== 'SCOPE') {
      const isSelect = isExplicitSellerSelection(controlClause);
      if (isSelect) {
        isAnyClauseSelect = true;
        if (!rawActions.some((a) => a.type === 'SELECT_FREELANCER')) {
          rawActions.push({ type: 'SELECT_FREELANCER', payload: { raw: clause } });
        }
        const addrMatch = clause.match(/0x[0-9a-fA-F]{40}/i);
        const handleMatch = clause.match(/@([a-zA-Z0-9_]{3,32})/i);
        const normSel = addrMatch ? addrMatch[0].toLowerCase() : handleMatch ? handleMatch[0].toLowerCase() : clause.trim().toLowerCase();
        if (workingScalar.seller && normSel === workingScalar.seller) {
          sameTurnRefState = { status: 'BLOCKED' };
        } else {
          workingScalar.seller = normSel;
          sameTurnRefState = {
            status: 'CANDIDATE',
            candidate: { domain: 'SCALAR', field: 'SELLER', source: 'SAME_TURN_MUTATION' },
          };
        }
      }

      // Check 4: Seller search request action
      const isSearch = isExplicitSellerSearchRequest(controlClause);
      if (isSearch) {
        isAnyClauseSearch = true;
        if (!rawActions.some((a) => a.type === 'SEARCH_FREELANCERS')) {
          rawActions.push({ type: 'SEARCH_FREELANCERS', payload: { raw: clause } });
        }
        sameTurnRefState = { status: 'BLOCKED' };
      }
    }

    // Check if clause is an informational question or conditional command
    const isInfoQuestion = isInformationalQuestion(controlClause);
    const isConditional = isConditionalCommand(controlClause);

    if (isInfoQuestion) {
      if (sameTurnRefState.status === 'UNTOUCHED') {
        const infoField = getInformationalSubjectField(controlClause);
        if (infoField) {
          sameTurnRefState = {
            status: 'CANDIDATE',
            candidate: {
              domain: 'SCALAR',
              field: infoField,
              source: 'SAME_TURN_INFORMATIONAL_SUBJECT',
            },
          };
        }
      }
      // If CANDIDATE or BLOCKED, sameTurnRefState remains UNCHANGED
    }

    // Extract term mutations ONLY IF clause is NOT a read-only question and NOT a conditional command
    if (!isInfoQuestion && !isConditional) {
      const isDestructiveCmd = /^(?:please\s+)?(?:remove|drop|delete|clear|reset|discard|take\s+out)\b/i.test(controlClause);

      // Step 1: Check for vague/ambiguous mutation phrasing requiring clarification BEFORE running deterministic parsers
      const isCheaperCmd = /(?:make\s+it|make\s+the\s+deal|get\s+it)\s+(?:cheaper|less\s+expensive|lower\s+cost)/i.test(controlClause) || /^(?:make\s+it|make\s+deal)\s+(?:cheaper|less\s+expensive)$/i.test(controlClause);
      const isBetterCmd = /(?:make\s+it|make\s+the\s+deal)\s+(?:better|simpler|more\s+flexible|nicer|great)/i.test(controlClause);
      const isVagueTitle = /^(?:please\s+)?(?:change|set|update|make)\s+(?:the\s+)?title[.\s]*$/i.test(controlClause);
      const isVagueDeadline = /^(?:please\s+)?(?:change|set|update|make)\s+(?:the\s+)?(?:deadline|timeline)[.\s]*$/i.test(controlClause);
      const isVaguePayment = /^(?:please\s+)?(?:change|set|update|make)\s+(?:the\s+)?(?:payment|payment\s+structure|milestones?)[.\s]*$/i.test(controlClause);
      const isVagueAddScope = /^(?:please\s+)?add\s+(?:something|anything|stuff|a\s+thing|a\s+feature|whatever)(?:\s+to\s+the\s+scope)?[.\s]*$/i.test(controlClause);
      const isVagueRemoveScope = /^(?:please\s+)?(?:remove|drop|delete)\s+(?:that|it|something|anything|stuff)(?:\s+(?:from|out\s+of)\s+(?:the\s+)?scope)?[.\s]*$/i.test(controlClause) || /^(?:remove|drop|delete)\s+(?:that|it)[.\s]*$/i.test(controlClause);
      const isVagueGeneralChange = /^(?:please\s+)?(?:change|update|replace|set)\s+(?:it|that)\b[.\s]*$/i.test(controlClause);

      const contextualCand = getEffectiveContextualCandidate(sameTurnRefState, history, workingScopeItems);

      // Check if there is an active pending clarification follow-up for SCOPE_ITEM
      if (contextualCand?.domain === 'SCOPE_ITEM' && contextualCand.source === 'PENDING_CLARIFICATION') {
        if (contextualCand.pendingOperation === 'REMOVE') {
          // Check for ordinal follow-up (e.g. "the second one", "second", "2nd", "the last deliverable", "the third one")
          const ordRes = parseScopeOrdinalReference(clause, workingScopeItems);
          if (ordRes.status === 'OUT_OF_BOUNDS') {
            const count = workingScopeItems.length;
            const noun = count === 1 ? 'deliverable' : 'deliverables';
            const clarMsg =
              count === 0
                ? 'The scope is currently empty. What deliverables would you like to add?'
                : `There are only ${count} ${noun} in the scope. Which one would you like to remove?`;
            rawActions.push({
              type: 'REQUEST_CLARIFICATION',
              payload: { kind: 'SCOPE_ITEM_REMOVE', message: clarMsg, raw: clause },
            });
            sameTurnRefState = { status: 'BLOCKED' };
            continue;
          } else if (ordRes.status === 'RESOLVED') {
            const targetIndex = ordRes.index;
            const targetItem = ordRes.targetItem;
            const remainingItems = workingScopeItems.filter((_, idx) => idx !== targetIndex);
            workingScopeItems = [...remainingItems];
            rawActions.push({
              type: 'REMOVE_SCOPE',
              payload: {
                value: formatScopeItems(remainingItems),
                items: remainingItems,
                targetItem,
                targetIndex,
                removedCount: 1,
              },
            });
            sameTurnRefState = { status: 'BLOCKED' };
            continue;
          } else {
            // Check for explicit item follow-up (e.g. "dashboard")
            const isOtherExplicitCmd =
              Boolean(parseBudgetOperation(controlClause)) ||
              Boolean(parseTitleOperation(clause)) ||
              isExplicitSellerSelection(controlClause) ||
              isExplicitDraftCancellation(controlClause) ||
              isExplicitDraftActivation(controlClause);

            if (!isOtherExplicitCmd) {
              const rawTarget = clause.replace(/^(?:please\s+)?(?:remove|drop|delete|take\s+out)?\s*(?:the\s+|a\s+|an\s+)?/i, '').trim();
              const cleanedTarget = cleanSingleScopeItem(rawTarget);
              if (cleanedTarget) {
                const targetNorm = cleanedTarget.toLowerCase();
                const matchingIndices = workingScopeItems
                  .map((item, idx) => (cleanSingleScopeItem(item).toLowerCase() === targetNorm ? idx : -1))
                  .filter((idx) => idx !== -1);
                if (matchingIndices.length === 1) {
                  const targetIndex = matchingIndices[0];
                  const targetItem = workingScopeItems[targetIndex];
                  const remainingItems = workingScopeItems.filter((_, idx) => idx !== targetIndex);
                  workingScopeItems = [...remainingItems];
                  rawActions.push({
                    type: 'REMOVE_SCOPE',
                    payload: {
                      value: formatScopeItems(remainingItems),
                      items: remainingItems,
                      targetItem,
                      targetIndex,
                      removedCount: 1,
                    },
                  });
                  sameTurnRefState = { status: 'BLOCKED' };
                  continue;
                } else if (matchingIndices.length > 1) {
                  rawActions.push({
                    type: 'REQUEST_CLARIFICATION',
                    payload: { kind: 'SCOPE_ITEM_REMOVE', message: 'Which deliverable would you like to remove?', raw: clause },
                  });
                  sameTurnRefState = { status: 'BLOCKED' };
                  continue;
                }
              }
              rawActions.push({
                type: 'REQUEST_CLARIFICATION',
                payload: { kind: 'SCOPE_ITEM_REMOVE', message: 'Which deliverable would you like to remove?', raw: clause },
              });
              sameTurnRefState = { status: 'BLOCKED' };
              continue;
            }
          }
        }
      }

      // Check for contextual pronoun removal (e.g. "remove that", "remove it", "drop that")
      const isContextualRemove = CONTEXTUAL_SCOPE_REMOVE_REGEX.test(controlClause);
      if (isContextualRemove) {
        if (contextualCand?.domain === 'SCOPE_ITEM' && (contextualCand.source === 'PREVIOUS_MUTATION' || contextualCand.source === 'SAME_TURN_MUTATION')) {
          const cleanTarget = cleanSingleScopeItem(contextualCand.targetItem);
          const targetNorm = cleanTarget.toLowerCase();
          const curIdx = contextualCand.targetIndex ?? workingScopeItems.findIndex(
            (it) => cleanSingleScopeItem(it).toLowerCase() === targetNorm
          );
          if (curIdx !== -1) {
            const targetItem = workingScopeItems[curIdx];
            const remainingItems = workingScopeItems.filter((_, idx) => idx !== curIdx);
            workingScopeItems = [...remainingItems];
            rawActions.push({
              type: 'REMOVE_SCOPE',
              payload: {
                value: formatScopeItems(remainingItems),
                items: remainingItems,
                targetItem,
                targetIndex: curIdx,
                removedCount: 1,
              },
            });
            sameTurnRefState = { status: 'BLOCKED' };
            continue;
          }
        } else if (contextualCand?.domain === 'SCALAR') {
          const isSafeScalarCandidateSource =
            contextualCand.source === 'PREVIOUS_MUTATION' ||
            contextualCand.source === 'INFORMATIONAL_SUBJECT' ||
            contextualCand.source === 'SAME_TURN_MUTATION' ||
            contextualCand.source === 'SAME_TURN_INFORMATIONAL_SUBJECT';

          if (isSafeScalarCandidateSource) {
            const f = contextualCand.field;
            if (f === 'BUDGET') {
              if (workingScalar.budgetAmount === null) {
                rawActions.push({
                  type: 'REQUEST_CLARIFICATION',
                  payload: { kind: 'UNSUPPORTED_SCALAR_SUBTRACTION', message: 'The budget is already unset.', raw: clause },
                });
              } else {
                workingScalar.budgetAmount = null;
                rawActions.push({ type: 'CLEAR_AMOUNT', payload: { targetField: 'BUDGET' } });
              }
              sameTurnRefState = { status: 'BLOCKED' };
              continue;
            }
            if (f === 'DEADLINE') {
              if (workingScalar.deadline === null) {
                rawActions.push({
                  type: 'REQUEST_CLARIFICATION',
                  payload: { kind: 'UNSUPPORTED_SCALAR_SUBTRACTION', message: 'The deadline is already unset.', raw: clause },
                });
              } else {
                workingScalar.deadline = null;
                rawActions.push({ type: 'CLEAR_DEADLINE', payload: { targetField: 'DEADLINE' } });
              }
              sameTurnRefState = { status: 'BLOCKED' };
              continue;
            }
            if (f === 'PAYMENT') {
              if (workingScalar.paymentStructure === null) {
                rawActions.push({
                  type: 'REQUEST_CLARIFICATION',
                  payload: { kind: 'UNSUPPORTED_SCALAR_SUBTRACTION', message: 'The payment structure is already unset.', raw: clause },
                });
              } else {
                workingScalar.paymentStructure = null;
                rawActions.push({ type: 'CLEAR_PAYMENT_STRUCTURE', payload: { targetField: 'PAYMENT' } });
              }
              sameTurnRefState = { status: 'BLOCKED' };
              continue;
            }
            if (f === 'TITLE') {
              if (workingScalar.title === null) {
                rawActions.push({
                  type: 'REQUEST_CLARIFICATION',
                  payload: { kind: 'UNSUPPORTED_SCALAR_SUBTRACTION', message: 'The deal title is already unset.', raw: clause },
                });
              } else {
                workingScalar.title = null;
                rawActions.push({ type: 'CLEAR_TITLE', payload: { targetField: 'TITLE' } });
              }
              sameTurnRefState = { status: 'BLOCKED' };
              continue;
            }
            if (f === 'SELLER') {
              if (workingScalar.seller === null) {
                rawActions.push({
                  type: 'REQUEST_CLARIFICATION',
                  payload: { kind: 'UNSUPPORTED_SCALAR_SUBTRACTION', message: 'No freelancer is currently selected.', raw: clause },
                });
              } else {
                workingScalar.seller = null;
                rawActions.push({ type: 'CLEAR_SELLER', payload: { targetField: 'SELLER' } });
              }
              sameTurnRefState = { status: 'BLOCKED' };
              continue;
            }
          }

          rawActions.push({
            type: 'REQUEST_CLARIFICATION',
            payload: {
              kind: 'GENERAL_CHANGE',
              message: 'Which deal term or scope item would you like to update, and what value should it have?',
              raw: clause,
            },
          });
          sameTurnRefState = { status: 'BLOCKED' };
          continue;
        }

        // Unresolved remove that -> Scope-specific clarification
        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: {
            kind: 'SCOPE_ITEM_REMOVE',
            message: 'Which deliverable would you like to remove?',
            raw: clause,
          },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }

      // Check for contextual pronoun mutation (e.g., "set it to Web Development", "change it to 10 days", "make it 0.3 ETH", "replace that with admin dashboard")
      const contextualMatch = matchContextualReferenceCommand(clause);

      if (contextualMatch) {
        const rawTargetValue = contextualMatch[1].trim();

        if (contextualCand?.domain === 'SCALAR') {
          const shape = detectValueShape(rawTargetValue);
          const valueDomain = getValueShapeTarget(shape);
          const isConflict = valueDomain !== null && valueDomain !== contextualCand.field;

          if (isConflict) {
            // Direct DOMAIN_CONFLICT clarification between scalar fields
            const currentLabel =
              contextualCand.field === 'DEADLINE'
                ? 'deadline'
                : contextualCand.field === 'BUDGET'
                ? 'budget'
                : contextualCand.field === 'PAYMENT'
                ? 'payment structure'
                : contextualCand.field === 'TITLE'
                ? 'title'
                : 'freelancer';
            const targetLabel =
              valueDomain === 'DEADLINE'
                ? 'deadline'
                : valueDomain === 'BUDGET'
                ? 'budget'
                : valueDomain === 'PAYMENT'
                ? 'payment structure'
                : valueDomain === 'SELLER'
                ? 'freelancer'
                : valueDomain.toLowerCase();

            rawActions.push({
              type: 'REQUEST_CLARIFICATION',
              payload: {
                kind: 'DOMAIN_CONFLICT',
                currentDomain: 'SCALAR',
                currentField: contextualCand.field,
                proposedDomain: valueDomain,
                proposedValue: rawTargetValue,
                message: `Do you mean set the ${targetLabel} to ${rawTargetValue}, or update the ${currentLabel}?`,
                raw: clause,
              },
            });
            sameTurnRefState = { status: 'BLOCKED' };
            continue;
          }

          // Check positive value compatibility before mutating scalar
          if (!isContextualValueCompatible(contextualCand.field, rawTargetValue, shape)) {
            if (contextualCand.field === 'DEADLINE') {
              rawActions.push({
                type: 'REQUEST_CLARIFICATION',
                payload: { kind: 'DEADLINE', message: 'What deadline would you like to set for the deal?', raw: clause },
              });
              sameTurnRefState = { status: 'BLOCKED' };
              continue;
            }
            if (contextualCand.field === 'PAYMENT') {
              rawActions.push({
                type: 'REQUEST_CLARIFICATION',
                payload: { kind: 'PAYMENT', message: 'How should payment be released: Single Release, 50/50 Milestones, or Custom Milestones?', raw: clause },
              });
              sameTurnRefState = { status: 'BLOCKED' };
              continue;
            }
            if (contextualCand.field === 'BUDGET') {
              rawActions.push({
                type: 'REQUEST_CLARIFICATION',
                payload: { kind: 'BUDGET', message: 'What budget would you like to set for the deal, and should it be ETH or USDC?', raw: clause },
              });
              sameTurnRefState = { status: 'BLOCKED' };
              continue;
            }
            if (contextualCand.field === 'SELLER') {
              rawActions.push({
                type: 'REQUEST_CLARIFICATION',
                payload: { kind: 'SELLER', message: 'Which freelancer would you like to select?', raw: clause },
              });
              sameTurnRefState = { status: 'BLOCKED' };
              continue;
            }
            if (contextualCand.field === 'TITLE') {
              rawActions.push({
                type: 'REQUEST_CLARIFICATION',
                payload: { kind: 'TITLE', message: 'What title would you like to set for the deal?', raw: clause },
              });
              sameTurnRefState = { status: 'BLOCKED' };
              continue;
            }
          }

          if (contextualCand.field === 'TITLE') {
            const titleVal = rawTargetValue.replace(/^["']|["']$/g, '').trim();
            if (titleVal.toLowerCase() === (workingScalar.title?.toLowerCase() ?? '')) {
              rawActions.push({ type: 'SET_TITLE', payload: { value: titleVal } });
              sameTurnRefState = { status: 'BLOCKED' };
            } else {
              workingScalar.title = titleVal;
              rawActions.push({ type: 'SET_TITLE', payload: { value: titleVal } });
              sameTurnRefState = {
                status: 'CANDIDATE',
                candidate: { domain: 'SCALAR', field: 'TITLE', source: 'SAME_TURN_MUTATION' },
              };
            }
            continue;
          }
          if (contextualCand.field === 'DEADLINE') {
            const dlVal = rawTargetValue.replace(/^["']|["']$/g, '').trim();
            const calDl = parseExplicitCalendarDeadline(dlVal);
            const normDl = calDl || dlVal.toLowerCase();
            const payloadRaw = calDl || dlVal;
            if (normDl === workingScalar.deadline) {
              rawActions.push({ type: 'SET_DEADLINE', payload: { raw: payloadRaw } });
              sameTurnRefState = { status: 'BLOCKED' };
            } else {
              workingScalar.deadline = normDl;
              rawActions.push({ type: 'SET_DEADLINE', payload: { raw: payloadRaw } });
              sameTurnRefState = {
                status: 'CANDIDATE',
                candidate: { domain: 'SCALAR', field: 'DEADLINE', source: 'SAME_TURN_MUTATION' },
              };
            }
            continue;
          }
          if (contextualCand.field === 'BUDGET') {
            let bAmount: string | null = null;
            let bAsset: 'ETH' | 'USDC' = workingScalar.budgetAsset || 'ETH';
            const bOp = parseBudgetOperation(`set budget to ${rawTargetValue}`);
            if (bOp && bOp.type === 'VALID') {
              bAmount = bOp.amount;
              bAsset = bOp.asset;
            } else {
              const numMatch = rawTargetValue.match(/^(\d+(?:\.\d+)?)\s*(eth|usdc)?$/i);
              if (numMatch) {
                bAmount = numMatch[1];
                if (numMatch[2]) {
                  bAsset = numMatch[2].toUpperCase() as 'ETH' | 'USDC';
                }
              }
            }
            if (bAmount) {
              if (bAmount === workingScalar.budgetAmount && bAsset === workingScalar.budgetAsset) {
                rawActions.push({ type: 'SET_AMOUNT', payload: { amount: bAmount, asset: bAsset } });
                sameTurnRefState = { status: 'BLOCKED' };
              } else {
                workingScalar.budgetAmount = bAmount;
                workingScalar.budgetAsset = bAsset;
                rawActions.push({ type: 'SET_AMOUNT', payload: { amount: bAmount, asset: bAsset } });
                sameTurnRefState = {
                  status: 'CANDIDATE',
                  candidate: { domain: 'SCALAR', field: 'BUDGET', source: 'SAME_TURN_MUTATION' },
                };
              }
              continue;
            }
          }
          if (contextualCand.field === 'PAYMENT') {
            const rawClean = rawTargetValue.replace(/^["']|["']$/g, '').trim();
            const payVal = parsePaymentStructure(rawClean) || rawClean;
            if (payVal === workingScalar.paymentStructure) {
              rawActions.push({ type: 'SET_PAYMENT_STRUCTURE', payload: { value: payVal } });
              sameTurnRefState = { status: 'BLOCKED' };
            } else {
              workingScalar.paymentStructure = payVal;
              rawActions.push({ type: 'SET_PAYMENT_STRUCTURE', payload: { value: payVal } });
              sameTurnRefState = {
                status: 'CANDIDATE',
                candidate: { domain: 'SCALAR', field: 'PAYMENT', source: 'SAME_TURN_MUTATION' },
              };
            }
            continue;
          }
          if (contextualCand.field === 'SELLER') {
            const selVal = rawTargetValue.replace(/^["']|["']$/g, '').trim();
            const normSel = selVal.toLowerCase();
            if (normSel === workingScalar.seller) {
              rawActions.push({ type: 'SELECT_FREELANCER', payload: { raw: selVal } });
              sameTurnRefState = { status: 'BLOCKED' };
            } else {
              workingScalar.seller = normSel;
              rawActions.push({ type: 'SELECT_FREELANCER', payload: { raw: selVal } });
              sameTurnRefState = {
                status: 'CANDIDATE',
                candidate: { domain: 'SCALAR', field: 'SELLER', source: 'SAME_TURN_MUTATION' },
              };
            }
            continue;
          }
        } else if (contextualCand?.domain === 'SCOPE_ITEM' && (contextualCand.source === 'PREVIOUS_MUTATION' || contextualCand.source === 'SAME_TURN_MUTATION')) {
          const shape = detectValueShape(rawTargetValue);
          const valueDomain = getValueShapeTarget(shape);

          if (valueDomain !== null) {
            // Direct DOMAIN_CONFLICT clarification (e.g. "change it to 10 days" when previous is scope item)
            const cleanTarget = cleanSingleScopeItem(contextualCand.targetItem);
            const domainLabel =
              valueDomain === 'DEADLINE'
                ? 'deadline'
                : valueDomain === 'BUDGET'
                ? 'budget'
                : valueDomain === 'PAYMENT'
                ? 'payment structure'
                : valueDomain === 'SELLER'
                ? 'freelancer'
                : valueDomain.toLowerCase();

            rawActions.push({
              type: 'REQUEST_CLARIFICATION',
              payload: {
                kind: 'DOMAIN_CONFLICT',
                currentDomain: 'SCOPE_ITEM',
                scopeItem: cleanTarget,
                proposedDomain: valueDomain,
                proposedValue: rawTargetValue,
                message: `Do you mean set the ${domainLabel} to ${rawTargetValue}, or change the "${cleanTarget}" deliverable?`,
                raw: clause,
              },
            });
            sameTurnRefState = { status: 'BLOCKED' };
            continue;
          }

          // Generic replacement text -> SCOPE_ITEM replacement
          const cleanTarget = cleanSingleScopeItem(contextualCand.targetItem);
          const targetNorm = cleanTarget.toLowerCase();
          const targetIndex = workingScopeItems.findIndex(
            (it) => cleanSingleScopeItem(it).toLowerCase() === targetNorm
          );

          if (targetIndex !== -1) {
            const cleanReplacement = cleanSingleScopeItem(rawTargetValue);
            if (cleanReplacement) {
              const replNorm = cleanReplacement.toLowerCase();
              if (replNorm === targetNorm) {
                // Same item already at targetIndex: deterministic no-op
                rawActions.push({
                  type: 'REPLACE_SCOPE_ITEM',
                  payload: {
                    targetItem: workingScopeItems[targetIndex],
                    targetIndex,
                    replacementItem: cleanReplacement,
                    items: [...workingScopeItems],
                    noop: true,
                    noopReason: 'SAME_ITEM',
                  },
                });
                sameTurnRefState = { status: 'BLOCKED' };
                continue;
              }

              const existsElsewhere = workingScopeItems.some(
                (it, idx) => idx !== targetIndex && cleanSingleScopeItem(it).toLowerCase() === replNorm
              );

              if (existsElsewhere) {
                // Duplicate replacement: zero mutation
                rawActions.push({
                  type: 'REPLACE_SCOPE_ITEM',
                  payload: {
                    targetItem: workingScopeItems[targetIndex],
                    targetIndex,
                    replacementItem: cleanReplacement,
                    items: [...workingScopeItems],
                    noop: true,
                    noopReason: 'ALREADY_EXISTS',
                  },
                });
                sameTurnRefState = { status: 'BLOCKED' };
                continue;
              }

              // Successful replacement in place
              const updatedItems = [...workingScopeItems];
              updatedItems[targetIndex] = cleanReplacement;
              workingScopeItems = [...updatedItems];

              rawActions.push({
                type: 'REPLACE_SCOPE_ITEM',
                payload: {
                  targetItem: contextualCand.targetItem,
                  targetIndex,
                  replacementItem: cleanReplacement,
                  items: updatedItems,
                },
              });
              sameTurnRefState = {
                status: 'CANDIDATE',
                candidate: {
                  domain: 'SCOPE_ITEM',
                  field: 'SCOPE_ITEM',
                  targetItem: cleanReplacement,
                  targetIndex,
                  source: 'SAME_TURN_MUTATION',
                },
              };
              continue;
            }
          }
        }

        // Check for deterministic intelligent confirmation before generic GENERAL_CHANGE
        const bOp = parseBudgetOperation(rawTargetValue);
        const dlDaysMatch = rawTargetValue.match(/^(\d+)\s*days?$/i);
        const dlWeeksMatch = rawTargetValue.match(/^(\d+)\s*weeks?$/i);
        const is5050 = /^(?:50\s*[-/]\s*50|half\s+and\s+half)$/i.test(rawTargetValue);
        const isSingle = /^(?:single\s+release|single\s+payment|upfront|single)$/i.test(rawTargetValue);
        const isCustom = /^(?:custom\s+milestones?|custom\s+payment)$/i.test(rawTargetValue);

        if (bOp && bOp.type === 'VALID') {
          rawActions.push({
            type: 'REQUEST_CLARIFICATION',
            payload: {
              kind: 'CONFIRM_SUGGESTED_TARGET',
              targetField: 'BUDGET',
              suggestedAction: 'SET_AMOUNT',
              value: bOp.amount,
              asset: bOp.asset,
              displayValue: `${bOp.amount} ${bOp.asset}`,
              message: `${bOp.amount} ${bOp.asset} looks like a budget amount. Would you like me to set the deal budget to ${bOp.amount} ${bOp.asset}?`,
              raw: clause,
            },
          });
          sameTurnRefState = { status: 'BLOCKED' };
          continue;
        }

        const calDlSuggested = (!dlDaysMatch && !dlWeeksMatch) ? parseExplicitCalendarDeadline(rawTargetValue) : null;
        if (dlDaysMatch || dlWeeksMatch || calDlSuggested) {
          const normDl = dlDaysMatch ? `${dlDaysMatch[1]} days` : dlWeeksMatch ? `${dlWeeksMatch[1]} weeks` : calDlSuggested!;
          rawActions.push({
            type: 'REQUEST_CLARIFICATION',
            payload: {
              kind: 'CONFIRM_SUGGESTED_TARGET',
              targetField: 'DEADLINE',
              suggestedAction: 'SET_DEADLINE',
              value: normDl,
              displayValue: normDl,
              message: `${normDl} looks like a delivery timeframe. Would you like me to set the deal deadline to ${normDl}?`,
              raw: clause,
            },
          });
          sameTurnRefState = { status: 'BLOCKED' };
          continue;
        }

        if (is5050 || isSingle || isCustom) {
          const pVal: '50-50' | 'single' | 'custom' = is5050 ? '50-50' : isSingle ? 'single' : 'custom';
          const displayVal = is5050 ? '50/50' : isSingle ? 'single release' : 'custom milestones';
          rawActions.push({
            type: 'REQUEST_CLARIFICATION',
            payload: {
              kind: 'CONFIRM_SUGGESTED_TARGET',
              targetField: 'PAYMENT',
              suggestedAction: 'SET_PAYMENT_STRUCTURE',
              value: pVal,
              displayValue: displayVal,
              message: `${displayVal} looks like a payment structure. Would you like me to use ${displayVal} for the deal?`,
              raw: clause,
            },
          });
          sameTurnRefState = { status: 'BLOCKED' };
          continue;
        }

        // Fallback: clarification when no candidate or conflict
        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: { kind: 'GENERAL_CHANGE', message: 'Which deal term or scope item would you like to update, and what value should it have?', raw: clause },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }

      if (isCheaperCmd) {
        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: { kind: 'CHEAPER', message: 'What budget would you like to set for the deal, and should it be ETH or USDC?', raw: clause },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      } else if (isBetterCmd) {
        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: { kind: 'MAKE_BETTER', message: 'What changes would you like to make to the deal?', raw: clause },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      } else if (isVagueTitle) {
        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: { kind: 'TITLE', message: 'What title would you like to set for the deal?', raw: clause },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      } else if (isVagueDeadline) {
        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: { kind: 'DEADLINE', message: 'What deadline would you like to set for the deal?', raw: clause },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      } else if (isVaguePayment) {
        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: { kind: 'PAYMENT', message: 'How should payment be released: Single Release, 50/50 Milestones, or Custom Milestones?', raw: clause },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      } else if (isVagueAddScope) {
        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: { kind: 'ADD_SCOPE', message: 'What specific deliverables or items would you like to add to the scope?', raw: clause },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      } else if (isVagueRemoveScope) {
        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: { kind: 'REMOVE_SCOPE', message: 'What would you like to remove from the deal?', raw: clause },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      } else if (isVagueGeneralChange) {
        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: { kind: 'GENERAL_CHANGE', message: 'Which deal term or scope item would you like to update, and what would you like to set it to?', raw: clause },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }

      // Step 2: Unambiguous clauses continue to deterministic mutation parsers (only if clause does not explicitly target scope and is not destructive)
      if (explicitTarget !== 'SCOPE' && !isDestructiveCmd) {
        // Amount / budget operation parsing & asset validation
        const hasBudgetEnvelope = /(?:budget|amount|cost|price|fee)\b/i.test(controlClause);
        const budgetOp = parseBudgetOperation(controlClause) || (hasBudgetEnvelope ? parseBudgetOperation(clause) : null);
        if (budgetOp) {
          if (budgetOp.type === 'VALID') {
            if (budgetOp.amount === workingScalar.budgetAmount && budgetOp.asset === workingScalar.budgetAsset) {
              rawActions.push({ type: 'SET_AMOUNT', payload: { amount: budgetOp.amount, asset: budgetOp.asset } });
              sameTurnRefState = { status: 'BLOCKED' };
            } else {
              workingScalar.budgetAmount = budgetOp.amount;
              workingScalar.budgetAsset = budgetOp.asset;
              rawActions.push({ type: 'SET_AMOUNT', payload: { amount: budgetOp.amount, asset: budgetOp.asset } });
              sameTurnRefState = {
                status: 'CANDIDATE',
                candidate: { domain: 'SCALAR', field: 'BUDGET', source: 'SAME_TURN_MUTATION' },
              };
            }
          } else if (budgetOp.type === 'UNSUPPORTED_ASSET') {
            rawActions.push({ type: 'UNSUPPORTED_ASSET', payload: { amount: budgetOp.amount, asset: budgetOp.asset } });
            sameTurnRefState = { status: 'BLOCKED' };
          } else if (budgetOp.type === 'AMBIGUOUS_ASSET') {
            rawActions.push({ type: 'AMBIGUOUS_ASSET', payload: { amount: budgetOp.amount, symbol: budgetOp.symbol } });
            sameTurnRefState = { status: 'BLOCKED' };
          } else if (budgetOp.type === 'MISSING_ASSET') {
            rawActions.push({ type: 'MISSING_ASSET', payload: { amount: budgetOp.amount } });
            sameTurnRefState = { status: 'BLOCKED' };
          }
        }

        // Deadline extraction
        const hasDeadlineEnvelope = /(?:deadline|timeline|timeframe|duration|days?|weeks?|months?)\b/i.test(controlClause);
        const daysMatch = (hasDeadlineEnvelope ? clause : controlClause).match(/(\d+)\s*days?/i);
        const weeksMatch = (hasDeadlineEnvelope ? clause : controlClause).match(/(\d+)\s*weeks?/i);
        let calDlFallback: string | null = null;
        if (!daysMatch && !weeksMatch && hasDeadlineEnvelope) {
          const rawEnvelopePayload = extractExplicitTargetPayload(clause, 'DEADLINE');
          calDlFallback = parseExplicitCalendarDeadline(rawEnvelopePayload);
          if (!calDlFallback) {
            // Also try parsing the remainder or clause directly if extractExplicitTargetPayload was empty
            calDlFallback = parseExplicitCalendarDeadline(clause.replace(/^(?:set|change|update|make)\s+(?:the\s+)?(?:deadline|timeline|timeframe|duration)\s+(?:to|is|=|of|at)?\s*/i, '').trim());
          }
        }
        if (daysMatch) {
          const dlRaw = `${daysMatch[1]} days`;
          const normDl = dlRaw.toLowerCase();
          if (normDl === workingScalar.deadline) {
            rawActions.push({ type: 'SET_DEADLINE', payload: { raw: dlRaw } });
            sameTurnRefState = { status: 'BLOCKED' };
          } else {
            workingScalar.deadline = normDl;
            rawActions.push({ type: 'SET_DEADLINE', payload: { raw: dlRaw } });
            sameTurnRefState = {
              status: 'CANDIDATE',
              candidate: { domain: 'SCALAR', field: 'DEADLINE', source: 'SAME_TURN_MUTATION' },
            };
          }
        } else if (weeksMatch) {
          const dlRaw = `${weeksMatch[1]} weeks`;
          const normDl = dlRaw.toLowerCase();
          if (normDl === workingScalar.deadline) {
            rawActions.push({ type: 'SET_DEADLINE', payload: { raw: dlRaw } });
            sameTurnRefState = { status: 'BLOCKED' };
          } else {
            workingScalar.deadline = normDl;
            rawActions.push({ type: 'SET_DEADLINE', payload: { raw: dlRaw } });
            sameTurnRefState = {
              status: 'CANDIDATE',
              candidate: { domain: 'SCALAR', field: 'DEADLINE', source: 'SAME_TURN_MUTATION' },
            };
          }
        } else if (calDlFallback) {
          if (calDlFallback === workingScalar.deadline) {
            rawActions.push({ type: 'SET_DEADLINE', payload: { raw: calDlFallback } });
            sameTurnRefState = { status: 'BLOCKED' };
          } else {
            workingScalar.deadline = calDlFallback;
            rawActions.push({ type: 'SET_DEADLINE', payload: { raw: calDlFallback } });
            sameTurnRefState = {
              status: 'CANDIDATE',
              candidate: { domain: 'SCALAR', field: 'DEADLINE', source: 'SAME_TURN_MUTATION' },
            };
          }
        }

        // Title extraction
        const parsedTitle = parseTitleOperation(clause);
        if (parsedTitle) {
          const cleanTitle = parsedTitle.trim();
          if (cleanTitle.toLowerCase() === (workingScalar.title?.toLowerCase() ?? '')) {
            rawActions.push({ type: 'SET_TITLE', payload: { value: parsedTitle } });
            sameTurnRefState = { status: 'BLOCKED' };
          } else {
            workingScalar.title = cleanTitle;
            rawActions.push({ type: 'SET_TITLE', payload: { value: parsedTitle } });
            sameTurnRefState = {
              status: 'CANDIDATE',
              candidate: { domain: 'SCALAR', field: 'TITLE', source: 'SAME_TURN_MUTATION' },
            };
          }
        }

        // Payment structure extraction
        let payVal: string | null = null;
        const hasPaymentEnvelope = /(?:payment|milestones?|release|structure)\b/i.test(controlClause);
        const payInspectText = hasPaymentEnvelope ? clause : controlClause;
        if (/(?:50-50|50\/50|half and half)/i.test(payInspectText)) {
          payVal = '50-50';
        } else if (/(?:single release|single payment|upfront|100% at end)/i.test(payInspectText)) {
          payVal = 'single';
        } else if (/(?:custom milestone|custom payment)/i.test(payInspectText)) {
          payVal = 'custom';
        }
        if (payVal) {
          if (payVal === workingScalar.paymentStructure) {
            rawActions.push({ type: 'SET_PAYMENT_STRUCTURE', payload: { value: payVal } });
            sameTurnRefState = { status: 'BLOCKED' };
          } else {
            workingScalar.paymentStructure = payVal;
            rawActions.push({ type: 'SET_PAYMENT_STRUCTURE', payload: { value: payVal } });
            sameTurnRefState = {
              status: 'CANDIDATE',
              candidate: { domain: 'SCALAR', field: 'PAYMENT', source: 'SAME_TURN_MUTATION' },
            };
          }
        }
      }

      // Scope operation extraction with current-turn supersession handling (instead / actually)
      if (interp.hasInstead || (interp.hasActually && /\b(?:scope|deliverables|add|replace)\b/i.test(controlClause))) {
        const candidateScopeOp = parseScopeOperation(clause, scopeBeforeTurn);
        if (candidateScopeOp) {
          rawActions = rawActions.filter((a) => !a.type.endsWith('_SCOPE') && a.type !== 'REPLACE_SCOPE_ITEM');
          workingScopeItems = [...scopeBeforeTurn];
        }
      }

      // Check ordinal scope removal (e.g. "remove the second one", "remove the last deliverable")
      const ordinalRemoveMatch = controlClause.match(ORDINAL_SCOPE_REMOVE_REGEX);
      if (ordinalRemoveMatch) {
        const ordRes = parseScopeOrdinalReference(clause, workingScopeItems);
        if (ordRes.status === 'OUT_OF_BOUNDS') {
          const count = workingScopeItems.length;
          const noun = count === 1 ? 'deliverable' : 'deliverables';
          const clarMsg =
            count === 0
              ? 'The scope is currently empty. What deliverables would you like to add?'
              : `There are only ${count} ${noun} in the scope. Which one would you like to remove?`;
          rawActions.push({
            type: 'REQUEST_CLARIFICATION',
            payload: { kind: 'GENERAL_CHANGE', message: clarMsg, raw: clause },
          });
          sameTurnRefState = { status: 'BLOCKED' };
          continue;
        } else if (ordRes.status === 'RESOLVED') {
          const targetIndex = ordRes.index;
          const targetItem = ordRes.targetItem;
          const remainingItems = workingScopeItems.filter((_, idx) => idx !== targetIndex);
          workingScopeItems = [...remainingItems];
          rawActions.push({
            type: 'REMOVE_SCOPE',
            payload: {
              value: formatScopeItems(remainingItems),
              items: remainingItems,
              targetItem,
              targetIndex,
              removedCount: 1,
            },
          });
          sameTurnRefState = { status: 'BLOCKED' };
          continue;
        }
      }

      // Check ordinal scope replacement (e.g. "replace the second deliverable with admin dashboard")
      const ordinalReplaceMatch = clause.match(ORDINAL_SCOPE_REPLACE_REGEX);
      if (ordinalReplaceMatch) {
        const ordRes = parseScopeOrdinalReference(clause, workingScopeItems);
        if (ordRes.status === 'OUT_OF_BOUNDS') {
          const count = workingScopeItems.length;
          const noun = count === 1 ? 'deliverable' : 'deliverables';
          const clarMsg =
            count === 0
              ? 'The scope is currently empty. What deliverables would you like to add?'
              : `There are only ${count} ${noun} in the scope. Which one would you like to replace?`;
          rawActions.push({
            type: 'REQUEST_CLARIFICATION',
            payload: { kind: 'GENERAL_CHANGE', message: clarMsg, raw: clause },
          });
          sameTurnRefState = { status: 'BLOCKED' };
          continue;
        } else if (ordRes.status === 'RESOLVED') {
          const targetIndex = ordRes.index;
          const targetItem = ordRes.targetItem;
          const rawReplacement = ordinalReplaceMatch[1].trim();
          const cleanReplacement = cleanSingleScopeItem(rawReplacement);

          if (!cleanReplacement) {
            rawActions.push({
              type: 'REQUEST_CLARIFICATION',
              payload: {
                kind: 'GENERAL_CHANGE',
                message: 'What would you like to replace that deliverable with?',
                raw: clause,
              },
            });
            sameTurnRefState = { status: 'BLOCKED' };
            continue;
          }

          const targetNorm = cleanSingleScopeItem(targetItem).toLowerCase();
          const replNorm = cleanReplacement.toLowerCase();

          if (replNorm === targetNorm) {
            // Same item already at targetIndex: deterministic no-op
            rawActions.push({
              type: 'REPLACE_SCOPE_ITEM',
              payload: {
                targetItem,
                targetIndex,
                replacementItem: cleanReplacement,
                items: [...workingScopeItems],
                noop: true,
                noopReason: 'SAME_ITEM',
              },
            });
            sameTurnRefState = { status: 'BLOCKED' };
            continue;
          }

          const existsElsewhere = workingScopeItems.some(
            (it, idx) => idx !== targetIndex && cleanSingleScopeItem(it).toLowerCase() === replNorm
          );

          if (existsElsewhere) {
            // Duplicate replacement: zero mutation
            rawActions.push({
              type: 'REPLACE_SCOPE_ITEM',
              payload: {
                targetItem,
                targetIndex,
                replacementItem: cleanReplacement,
                items: [...workingScopeItems],
                noop: true,
                noopReason: 'ALREADY_EXISTS',
              },
            });
            sameTurnRefState = { status: 'BLOCKED' };
            continue;
          }

          // Successful replacement preserving array position
          const updatedItems = [...workingScopeItems];
          updatedItems[targetIndex] = cleanReplacement;
          workingScopeItems = [...updatedItems];

          rawActions.push({
            type: 'REPLACE_SCOPE_ITEM',
            payload: {
              targetItem,
              targetIndex,
              replacementItem: cleanReplacement,
              items: updatedItems,
            },
          });
          sameTurnRefState = {
            status: 'CANDIDATE',
            candidate: {
              domain: 'SCOPE_ITEM',
              field: 'SCOPE_ITEM',
              targetItem: cleanReplacement,
              targetIndex,
              source: 'SAME_TURN_MUTATION',
            },
          };
          continue;
        }
      }

      const scopeOp = parseScopeOperation(clause, workingScopeItems);
      if (scopeOp) {
        workingScopeItems = [...scopeOp.items];
        if (scopeOp.type === 'clear') {
          rawActions.push({ type: 'CLEAR_SCOPE', payload: { value: '', items: [] } });
          sameTurnRefState = { status: 'BLOCKED' };
        } else if (scopeOp.type === 'replace') {
          rawActions.push({ type: 'REPLACE_SCOPE', payload: { value: scopeOp.value, items: scopeOp.items } });
          sameTurnRefState = { status: 'BLOCKED' };
        } else if (scopeOp.type === 'add') {
          rawActions.push({
            type: 'ADD_SCOPE',
            payload: {
              value: scopeOp.value,
              items: scopeOp.items,
              addedCount: scopeOp.addedCount ?? 1,
              addedItems: scopeOp.addedItems ?? [],
            },
          });
          const addedCount = scopeOp.addedCount ?? (scopeOp.addedItems ? scopeOp.addedItems.length : 1);
          if (addedCount === 1 && scopeOp.addedItems && scopeOp.addedItems.length === 1) {
            const newlyAdded = scopeOp.addedItems[0];
            const targetIndex = workingScopeItems.findIndex(
              (it) => cleanSingleScopeItem(it).toLowerCase() === cleanSingleScopeItem(newlyAdded).toLowerCase()
            );
            sameTurnRefState = {
              status: 'CANDIDATE',
              candidate: {
                domain: 'SCOPE_ITEM',
                field: 'SCOPE_ITEM',
                targetItem: newlyAdded,
                targetIndex: targetIndex !== -1 ? targetIndex : undefined,
                source: 'SAME_TURN_MUTATION',
              },
            };
          } else {
            sameTurnRefState = { status: 'BLOCKED' };
          }
        } else if (scopeOp.type === 'remove') {
          rawActions.push({
            type: 'REMOVE_SCOPE',
            payload: {
              value: scopeOp.value,
              items: scopeOp.items,
              targetItem: scopeOp.targetItem,
              targetIndex: scopeOp.targetIndex,
              removedCount: scopeOp.removedCount ?? 0,
            },
          });
          sameTurnRefState = { status: 'BLOCKED' };
        }
      }
      if (isDestructiveCmd && rawActions.length === actionsCountBeforeClause) {
        const rawPayload = clause
          .replace(/^(?:please\s+)?(?:remove|drop|delete|clear|reset|discard|take\s+out)\s+/i, '')
          .replace(/[.,;]+$/, '')
          .trim();
        const cleanPayload = rawPayload.replace(/^["'](.*)["']$/, '$1').trim();
        const shape = detectValueShape(cleanPayload);

        let destructiveDiagnostic: TurnDiagnostic | undefined = undefined;
        if (shape === 'AMOUNT') {
          destructiveDiagnostic = {
            reason: 'DESTRUCTIVE_SCALAR_ATTEMPT',
            operation: /delete/i.test(controlClause) ? 'DELETE' : /drop/i.test(controlClause) ? 'DROP' : 'REMOVE',
            rawValue: cleanPayload,
            detectedValueKind: 'BUDGET',
          };
        } else if (shape === 'DURATION') {
          destructiveDiagnostic = {
            reason: 'DESTRUCTIVE_SCALAR_ATTEMPT',
            operation: /delete/i.test(controlClause) ? 'DELETE' : /drop/i.test(controlClause) ? 'DROP' : 'REMOVE',
            rawValue: cleanPayload,
            detectedValueKind: 'DEADLINE',
          };
        } else if (shape === 'PAYMENT') {
          destructiveDiagnostic = {
            reason: 'DESTRUCTIVE_SCALAR_ATTEMPT',
            operation: /delete/i.test(controlClause) ? 'DELETE' : /drop/i.test(controlClause) ? 'DROP' : 'REMOVE',
            rawValue: cleanPayload,
            detectedValueKind: 'PAYMENT',
          };
        }

        rawActions.push({
          type: 'REQUEST_CLARIFICATION',
          payload: {
            kind: 'REMOVE_SCOPE',
            message: 'What would you like to remove from the deal?',
            raw: clause,
            diagnostic: destructiveDiagnostic,
          },
        });
        sameTurnRefState = { status: 'BLOCKED' };
        continue;
      }
    }
  }

  // Multiple independent targetless suggestions collapse to ONE general clarification
  const confirmSuggestions = rawActions.filter(
    (a) => a.type === 'REQUEST_CLARIFICATION' && a.payload?.kind === 'CONFIRM_SUGGESTED_TARGET'
  );
  if (confirmSuggestions.length > 1) {
    const suggestionLabels = confirmSuggestions.map((s) => s.payload?.displayValue || s.payload?.value).filter(Boolean);
    rawActions = rawActions.filter((a) => !(a.type === 'REQUEST_CLARIFICATION' && a.payload?.kind === 'CONFIRM_SUGGESTED_TARGET'));
    rawActions.push({
      type: 'REQUEST_CLARIFICATION',
      payload: {
        kind: 'MULTIPLE_AMBIGUOUS_SUGGESTIONS',
        message: `I can identify multiple values (${suggestionLabels.join(' and ')}), but please specify which deal terms you would like to update.`,
        raw: trimmed,
      },
    });
  }

  const actions = normalizeTurnActions(rawActions);

  // Determine Primary Intent based on precedence
  const isWholeTurnInfoQuestion = isInformationalQuestion(maskQuotedControlSyntax(trimmed));
  let primaryIntent: NegotiatorPrimaryIntent = 'GENERAL_CONVERSATION';

  if (isAnyClauseActivate) {
    primaryIntent = 'ACTIVATE_DRAFT';
  } else if (isAnyClauseCancel) {
    primaryIntent = 'CANCEL_DRAFT';
  } else if (actions.some((a) => a.type === 'SELECT_FREELANCER') || isAnyClauseSelect) {
    primaryIntent = 'SELECT_FREELANCER';
  } else if (isAnyClauseSearch) {
    primaryIntent = 'FIND_FREELANCER';
  } else if (actions.some((a) => a.type.startsWith('SET_') || a.type.startsWith('CLEAR_') || a.type.endsWith('_SCOPE') || a.type === 'REPLACE_SCOPE_ITEM' || a.type === 'SELECT_FREELANCER')) {
    primaryIntent = 'MODIFY_TERMS';
  } else if (informationalRequests.length > 0 || isWholeTurnInfoQuestion) {
    primaryIntent = 'INFORMATIONAL_QUESTION';
  } else if (/(?:confirm|accept|looks good|agree|proceed)/i.test(trimmed)) {
    primaryIntent = 'CONFIRM_TERMS';
  } else if (/(?:review|draft|receipt|summary|show me|what do we have)/i.test(trimmed)) {
    primaryIntent = 'REVIEW_DRAFT';
  }

  return { primaryIntent, informationalRequests, informationalClauses, actions };
}

/**
 * Pure deterministic scope command parser.
 * Parses explicit REPLACE, ADD, and REMOVE scope operations from user text.
 */
export function parseScopeOperation(
  text: string,
  currentScopeItems: string[] | string | null
): ScopeOperation {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // Explicit target check: If the clause structurally targets a non-scope domain, scope parser must NEVER execute
  const explicitTarget = detectExplicitTarget(trimmed);
  if (explicitTarget !== 'NONE' && explicitTarget !== 'SCOPE') {
    return null;
  }

  // Guard: Scope ordinal and item-reference commands must not be parsed by raw scope parser
  if (isScopeItemReferenceCommand(trimmed)) {
    return null;
  }

  const existingItems = Array.isArray(currentScopeItems)
    ? [...currentScopeItems]
    : currentScopeItems
    ? splitScopeItems(currentScopeItems)
    : [];

  // Explicit non-scope command isolation: Clauses recognized as deterministic non-scope commands must NOT execute scope parsing unless clause explicitly targets scope/deliverables
  const hasExplicitScopeKeyword = /\b(?:scope|deliverables|requirements)\b/i.test(trimmed);
  if (!hasExplicitScopeKeyword) {
    const isTitleCmd = Boolean(parseTitleOperation(trimmed));
    const isSellerCmd = isExplicitSellerSelection(trimmed) || isExplicitSellerSearchRequest(trimmed);
    const isLifecycleCmd = isExplicitDraftActivation(trimmed) || isExplicitDraftCancellation(trimmed);
    const isAmountCmd =
      /^(?:please\s+)?(?:set|change|replace|update|make)\s+(?:the\s+)?(?:budget|amount|price|cost)\b/i.test(trimmed) ||
      /(\d+(?:\.\d+)?)\s*(?:eth|ethereum|usdc|\$)/i.test(trimmed);
    const isDeadlineCmd =
      /^(?:please\s+)?(?:set|change|replace|update|make)\s+(?:the\s+)?(?:deadline|timeline)\b/i.test(trimmed) ||
      /(\d+)\s*(?:days?|weeks?)/i.test(trimmed);
    const isPaymentCmd =
      /^(?:please\s+)?(?:set|change|replace|update|make|use)\s+(?:the\s+)?(?:payment\s+structure|milestones?)\b/i.test(trimmed) ||
      /(?:50-50|50\/50|single release|custom milestone)/i.test(trimmed);

    const isRefCmd = isReferenceMutationCommand(trimmed);
    if (isTitleCmd || isSellerCmd || isLifecycleCmd || isAmountCmd || isDeadlineCmd || isPaymentCmd || isRefCmd) {
      return null;
    }
  }

  // Rule 11: Do not overmatch ordinary questions or general chat
  const isQuestion = /^(?:what|why|how|can\s+you|could\s+you|explain|tell\s+me|is\s+the|is\s+this)\b/i.test(trimmed) || trimmed.includes('?');
  if (isQuestion && !/^(?:set|change|replace|update|add|include|remove|drop|clear|reset|delete)\b/i.test(trimmed)) {
    return null;
  }

  // 0. Check CLEAR / RESET phrases
  const isExplicitClear =
    /^(?:please\s+)?(?:clear|reset)\s+(?:the\s+)?(?:scope|deliverables|requirements)[.\s]*$/i.test(trimmed) ||
    /^(?:please\s+)?remove\s+(?:everything|all)\s+(?:from|out\s+of)\s+(?:the\s+)?(?:scope|deliverables|requirements)[.\s]*$/i.test(trimmed) ||
    /^(?:please\s+)?remove\s+all\s+(?:deliverables|requirements)[.\s]*$/i.test(trimmed) ||
    /^(?:please\s+)?delete\s+(?:the\s+)?(?:entire\s+)?(?:scope|deliverables|requirements)[.\s]*$/i.test(trimmed) ||
    /^(?:please\s+)?delete\s+all\s+(?:deliverables|requirements)[.\s]*$/i.test(trimmed);

  if (isExplicitClear) {
    return { type: 'clear', value: '', items: [] };
  }

  // 1. Check REMOVE phrases
  const removeMatch =
    trimmed.match(/^(?:please\s+)?(?:remove|drop|delete)\s+(.+?)\s+(?:from|out of)\s+(?:the\s+)?(?:scope|deliverables|requirements)$/i) ||
    trimmed.match(/^(?:please\s+)?take\s+(.+?)\s+out\s+of\s+(?:the\s+)?(?:scope|deliverables|requirements)$/i) ||
    trimmed.match(/^(?:please\s+)?(?:remove|drop|delete)\s+(?:the\s+)?(.+?)\s+from\s+(?:the\s+)?(?:scope|deliverables)$/i) ||
    trimmed.match(/^(?:please\s+)?(?:remove|drop|delete)\s+(?:the\s+)?(.*?)(?:\s+from\s+the\s+scope|\s+from\s+scope)?$/i);

  if (removeMatch && /remove|drop|delete|take/i.test(trimmed)) {
    const rawTarget = removeMatch[1] ? removeMatch[1].trim() : '';
    let target = rawTarget
      .replace(/^(?:the|a|an)\s+/i, '')
      .replace(/(?:from|out of)\s+(?:the\s+)?(?:scope|deliverables)$/i, '')
      .trim();
    target = cleanSingleScopeItem(target);

    if (target) {
      const targetNorm = target.toLowerCase();
      const remainingItems = existingItems.filter((item) => {
        const itemNorm = cleanSingleScopeItem(item).toLowerCase();
        return itemNorm !== targetNorm;
      });

      const removedCount = existingItems.length - remainingItems.length;
      const targetIndex =
        removedCount === 1
          ? existingItems.findIndex((item) => cleanSingleScopeItem(item).toLowerCase() === targetNorm)
          : undefined;

      return {
        type: 'remove',
        value: formatScopeItems(remainingItems),
        items: remainingItems,
        targetItem: target,
        targetIndex: targetIndex !== -1 ? targetIndex : undefined,
        removedCount,
      };
    }
    if (removeMatch[1] && /scope|deliverable/i.test(trimmed)) {
      return null;
    }
  }

  // 2. Check ADD / EXTEND phrases (strictly requires explicit scope destination)
  const addMatch =
    trimmed.match(/^(?:please\s+)?(?:also\s+)?(?:add|include)\s+(.+?)\s+(?:to|in|into)\s+(?:the\s+)?(?:scope|deliverables|requirements)(?:\s+(?:too|as\s+well|also|please|only|for\s+this\s+deal|for\s+the\s+deal))?[.\s]*$/i) ||
    trimmed.match(/^(?:please\s+)?(?:also\s+)?(?:add|include)\s+(.+?)\s+to\s+(?:the\s+)?deliverables(?:\s+(?:too|as\s+well|also|please|only))?[.\s]*$/i);

  if (addMatch && /add|include/i.test(trimmed)) {
    let addition = addMatch[1].trim();
    addition = addition
      .replace(/[.\s]+$/, '')
      .replace(/\s+(?:to|in|into)\s+(?:the\s+)?(?:scope|deliverables|requirements)(?:\s+(?:too|as\s+well|also|please|only|for\s+this\s+deal|for\s+the\s+deal))?[.\s]*$/i, '')
      .replace(/^(?:the|a|an)\s+/i, '')
      .trim();

    if (addition) {
      const incomingItems = splitScopeItems(addition);
      if (incomingItems.length === 0) return null;

      if (existingItems.length === 0) {
        return {
          type: 'add',
          value: formatScopeItems(incomingItems),
          items: incomingItems,
          addedCount: incomingItems.length,
          addedItems: incomingItems,
        };
      }

      const existingNorms = new Set(
        existingItems.map((item) => cleanSingleScopeItem(item).toLowerCase())
      );

      const newIncomingItems = incomingItems.filter((item) => {
        const norm = cleanSingleScopeItem(item).toLowerCase();
        return norm.length > 0 && !existingNorms.has(norm);
      });

      if (newIncomingItems.length === 0) {
        return {
          type: 'add',
          value: formatScopeItems(existingItems),
          items: existingItems,
          addedCount: 0,
          addedItems: [],
        };
      }

      const updatedItems = [...existingItems, ...newIncomingItems];
      return {
        type: 'add',
        value: formatScopeItems(updatedItems),
        items: updatedItems,
        addedCount: newIncomingItems.length,
        addedItems: newIncomingItems,
      };
    }
  }

  // 3. Check REPLACE / SET phrases
  const replaceMatch =
    trimmed.match(/^(?:please\s+)?(?:set|change|replace|update|make)\s+(?:the\s+)?(?:scope|deliverables|requirements)\s+(?:to|with|=|is|for)?\s+(.+)$/i) ||
    trimmed.match(/^(?:the\s+)?(?:scope|deliverables)\s+(?:should\s+be|is|are|set\s+to|updated\s+to)\s+(.+)$/i);

  if (replaceMatch) {
    const rawVal = replaceMatch[1].trim();
    const items = splitScopeItems(rawVal);
    if (items.length > 0) {
      return { type: 'replace', value: formatScopeItems(items), items };
    }
  }

  return null;
}

/**
 * Pure deterministic title command parser.
 * Extracts explicit title content from user text (preserving exact casing and spaces).
 */
export function parseTitleOperation(clause: string): string | null {
  if (!clause || typeof clause !== 'string') return null;
  const trimmed = clause.trim();

  if (isInformationalQuestion(trimmed) && !/^(?:add|set|change|title|call|update|make|use|put)\b/i.test(trimmed)) {
    return null;
  }

  // 1. Centralized quote-aware extraction using findQuotedSpans
  const spans = findQuotedSpans(trimmed);
  if (spans.length === 1) {
    const span = spans[0];
    const prefix = trimmed.slice(0, span.start).trim();
    const suffix = trimmed.slice(span.end).trim();

    // Check inverted: "add 'UX design' to the title", "use 'Brand Platform' as the title"
    const isInvertedTitlePrefix = /^(?:please\s+)?(?:add|set|change|update|make|put|use)\b/i.test(prefix);
    const isInvertedTitleSuffix =
      /^(?:as|to|for|in|into)\s+(?:the\s+)?title(?:[.\s]+for\s+(?:this\s+)?(?:deal|draft)|[.\s]*)*$/i.test(suffix);
    if (isInvertedTitlePrefix && isInvertedTitleSuffix && span.content.trim()) {
      return span.content.trim();
    }

    // Check forward: "set the title to 'UX design'", "title 'UX design'", "call the deal 'UX design'"
    const isForwardTitlePrefix =
      /^(?:please\s+)?(?:add|set|change|update|make|put)?\s*(?:the\s+)?title\s*(?:to|it|=|is|as|for)?$/i.test(prefix) ||
      /^(?:please\s+)?call\s+(?:the\s+)?(?:deal|draft)$/i.test(prefix) ||
      /^(?:please\s+)?title\s+it$/i.test(prefix);
    const isForwardTitleSuffix = /^(?:[.\s]|for\s+(?:this\s+)?(?:deal|draft))*$/i.test(suffix);
    if (isForwardTitlePrefix && isForwardTitleSuffix && span.content.trim()) {
      return span.content.trim();
    }
  }

  // 2. Existing forward quoted regex fallback
  const quotedMatch =
    trimmed.match(/(?:add|set|change|update|make|put)?\s*(?:the\s+)?title\s*(?:to|it|=|is|as|for)?\s*["'`](.+?)["'`]/i) ||
    trimmed.match(/(?:call\s+(?:the\s+)?(?:deal|draft))\s*["'`](.+?)["'`]/i) ||
    trimmed.match(/(?:title\s+it)\s*["'`](.+?)["'`]/i);

  if (quotedMatch && quotedMatch[1]?.trim()) {
    return quotedMatch[1].trim();
  }

  // 3. Inverted unquoted: "add UX design to the title", "use Brand Platform as the title"
  const invertedUnquotedMatch = trimmed.match(
    /^(?:please\s+)?(?:add|set|change|update|make|put|use)\s+(.+?)\s+(?:as|to|for|in|into)\s+(?:the\s+)?title[.\s]*$/i
  );
  if (invertedUnquotedMatch && invertedUnquotedMatch[1]?.trim()) {
    let extracted = invertedUnquotedMatch[1].trim();
    extracted = extracted
      .replace(/^["'`](.*)["'`]$/, '$1')
      .replace(/[.\s]+$/, '')
      .replace(/\s+(?:for|on|in)\s+(?:this\s+)?(?:deal|draft)$/i, '')
      .trim();
    if (extracted && extracted.length > 0 && !/^(?:to|is|for|as|the)$/i.test(extracted)) {
      return extracted;
    }
  }

  // 4. Forward unquoted: "set the title to UX design"
  const explicitUnquotedMatch =
    trimmed.match(/^(?:please\s+)?(?:add|set|change|update|make)\s+(?:the\s+)?title\s+(?:to|=|is)\s+(.+)$/i) ||
    trimmed.match(/^(?:please\s+)?(?:call\s+(?:the\s+)?deal|title\s+it)\s+(.+)$/i);

  if (explicitUnquotedMatch && explicitUnquotedMatch[1]?.trim()) {
    let extracted = explicitUnquotedMatch[1].trim();
    extracted = extracted
      .replace(/^["'`](.*)["'`]$/, '$1')
      .replace(/[.\s]+$/, '')
      .replace(/\s+(?:for|on|in)\s+(?:this\s+)?(?:deal|draft)$/i, '')
      .trim();
    if (extracted && extracted.length > 0 && !/^(?:to|is|for|as|the)$/i.test(extracted)) {
      return extracted;
    }
  }

  return null;
}

/**
 * Canonical draft-cancellation detector.
 * Evaluates whether text matches explicit deactivation/cancellation intent.
 */
export function isExplicitDraftCancellation(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (/(?:cancel|stop|discard|deactivate)\s+(?:it|the\s+draft|this\s+draft|draft|the\s+deal|this\s+deal|deal)/i.test(trimmed)) {
    return true;
  }
  if (/^(?:deactivate|cancel|stop|discard)\s*(?:it|the\s+draft|this\s+draft|draft|the\s+deal|this\s+deal|deal)?$/i.test(trimmed)) {
    return true;
  }
  if (/(?:make|set)\s+(?:the\s+|this\s+)?(?:draft|deal|it)\s+inactive/i.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Reconstructs authoritative negotiation state across full conversation history.
 * Chronologically merges terms while independently managing ACTIVE/INACTIVE lifecycle.
 */
export async function reconstructAuthoritativeNegotiationState(
  messages: (NegotiatorContextMessage | any)[]
): Promise<
  NegotiationStateData & {
    cancellationReason: LifecycleReason;
    unresolvedHandle?: string | null;
    handleResolutionStatus?: 'RESOLVED' | 'NOT_FOUND' | 'NOT_FREELANCER' | 'READ_ERROR' | null;
    sellerAmbiguous?: boolean;
    ambiguousName?: string | null;
    candidateSellerName?: string | null;
  }
> {
  return extractNegotiationState(messages);
}

export interface ExtractedNegotiationState extends NegotiationStateData {
  seller: TermState<string>;
  title: TermState<string>;
  scope: TermState<string>;
  scopeItems: string[];
  amount: TermState<{ amount: string; asset: 'ETH' | 'USDC' }>;
  deadline: TermState<{ raw?: string; timestamp?: number }>;
  paymentStructure: TermState<'custom' | '50-50' | 'single'>;
  cancellationReason: LifecycleReason;
  unresolvedHandle?: string | null;
  handleResolutionStatus?: 'RESOLVED' | 'NOT_FOUND' | 'NOT_FREELANCER' | 'READ_ERROR' | null;
  sellerAmbiguous?: boolean;
  ambiguousName?: string | null;
  candidateSellerName?: string | null;
}

/**
 * Extracts and tracks canonical negotiation state across multi-turn conversation context.
 * Implements N3.3 grounded identity resolution & deterministic missing-term sequence boundaries.
 */
async function extractNegotiationState(
  messages: (NegotiatorContextMessage | any)[],
  initialState?: NegotiationStateData
): Promise<ExtractedNegotiationState> {
  let draftStatus: 'INACTIVE' | 'ACTIVE' = initialState?.draftStatus || 'INACTIVE';
  let cancellationReason: LifecycleReason =
    (initialState as any)?.cancellationReason ||
    (initialState?.draftStatus === 'ACTIVE' ? 'ACTIVE' : 'NOT_STARTED');
  let pendingAction: 'DRAFT_DEAL' | null = initialState?.pendingAction ?? null;

  let lastExplicitLifecycleAction: 'CANCEL' | 'ACTIVATE' | null =
    initialState?.draftStatus === 'ACTIVE'
      ? 'ACTIVATE'
      : initialState?.draftStatus === 'INACTIVE' && (initialState as any)?.cancellationReason === 'USER_CANCELLED'
      ? 'CANCEL'
      : null;

  let userSetTitle = false;
  let userSetScope = false;
  let userSetSeller = false;
  let userSetAmount = false;
  let userSetDeadline = false;
  let userSetPayStruct = false;

  let sellerVal: string | null = initialState?.seller?.value ? initialState.seller.value.toLowerCase() : null;
  let sellerStatus: 'CONFIRMED' | 'PROPOSED' | 'MISSING' = initialState?.seller?.status || 'MISSING';
  let sellerNameVal: string | null = initialState?.sellerName || null;

  let unresolvedHandle: string | null = null;
  let handleResolutionStatus: 'RESOLVED' | 'NOT_FOUND' | 'NOT_FREELANCER' | 'READ_ERROR' | null = null;
  let sellerAmbiguous = false;
  let ambiguousName: string | null = null;
  let candidateSellerName: string | null = null;

  let titleVal: string | null = initialState?.title?.value || null;
  let titleStatus: 'CONFIRMED' | 'PROPOSED' | 'MISSING' = initialState?.title?.status || 'MISSING';

  let scopeItemsVal: string[] = initialState?.scopeItems
    ? [...initialState.scopeItems]
    : initialState?.scope?.value
    ? splitScopeItems(initialState.scope.value)
    : [];
  let scopeStatus: 'CONFIRMED' | 'PROPOSED' | 'MISSING' = initialState?.scope?.status || 'MISSING';

  let amountNum: string | null = initialState?.amount?.value?.amount || null;
  let assetType: 'ETH' | 'USDC' = initialState?.amount?.value?.asset || 'ETH';
  let amountStatus: 'CONFIRMED' | 'PROPOSED' | 'MISSING' = initialState?.amount?.status || 'MISSING';

  let deadlineRaw: string | null = initialState?.deadline?.value?.raw || null;
  let deadlineStatus: 'CONFIRMED' | 'PROPOSED' | 'MISSING' = initialState?.deadline?.status || 'MISSING';

  let payStructVal: 'custom' | '50-50' | 'single' | null = initialState?.paymentStructure?.value || null;
  let payStructStatus: 'CONFIRMED' | 'PROPOSED' | 'MISSING' = initialState?.paymentStructure?.status || 'MISSING';

  const rawList = Array.isArray(messages) ? messages : [];
  let lastAssistantIndex = -1;
  for (let i = rawList.length - 1; i >= 0; i--) {
    const role = rawList[i]?.role;
    if (role === 'ai' || role === 'assistant') {
      lastAssistantIndex = i;
      break;
    }
  }

  // Canonical state is derived strictly from settled conversation history.
  // Any trailing user messages after the last assistant response are in-flight / unresolved
  // and must have zero authority over canonical deal reconstruction.
  const settledMessages =
    lastAssistantIndex >= 0 ? rawList.slice(0, lastAssistantIndex + 1) : [];

  for (let idx = 0; idx < settledMessages.length; idx++) {
    const m = settledMessages[idx];
    const text = m.content || '';

    // Check if preceding message was a user read-only question
    const prevMsg = idx > 0 ? settledMessages[idx - 1] : null;
    const prevWasQuestion = prevMsg && prevMsg.role === 'user' && isInformationalQuestion(prevMsg.content || '');

    // Restore payload state if previously set by engine (acting as fallback seed information, NOT overriding user actions)
    const st = (m as any).negotiationState || m.payload?.negotiationState;
    if (st && !prevWasQuestion) {
      if (st.draftStatus === 'INACTIVE') {
        draftStatus = 'INACTIVE';
        if ((st as any).cancellationReason) {
          cancellationReason = (st as any).cancellationReason;
        }
        lastExplicitLifecycleAction = 'CANCEL';
      } else if (st.draftStatus === 'ACTIVE') {
        if (lastExplicitLifecycleAction !== 'CANCEL') {
          draftStatus = 'ACTIVE';
          cancellationReason = 'ACTIVE';
          lastExplicitLifecycleAction = 'ACTIVATE';
        }
      }
      if (st.pendingAction !== undefined && lastExplicitLifecycleAction !== 'CANCEL') {
        pendingAction = st.pendingAction;
      }
      if (st.seller?.value && isAddress(st.seller.value) && (!userSetSeller || sellerStatus !== 'CONFIRMED')) {
        sellerVal = st.seller.value.toLowerCase();
        sellerStatus = st.seller.status;
      }
      if (st.sellerName && !st.sellerName.startsWith('@') && (!userSetSeller || !sellerNameVal)) {
        sellerNameVal = st.sellerName;
      }
      if (st.title?.value && (!userSetTitle || titleStatus !== 'CONFIRMED')) {
        titleVal = st.title.value;
        titleStatus = st.title.status;
      }
      if (((st.scopeItems && Array.isArray(st.scopeItems) && st.scopeItems.length > 0) || st.scope?.value) && (!userSetScope || scopeStatus !== 'CONFIRMED')) {
        const rawScopeStr = st.scope?.value ? String(st.scope.value).trim() : (st.scopeItems ? formatScopeItems(st.scopeItems) : '');
        const isPollutedScope =
          isExplicitSellerSelection(rawScopeStr) ||
          isTitleCommandArtifact(rawScopeStr) ||
          /^(?:use|select|pick|choose|go with|hire|draft with|deal with|with)\s+@/i.test(rawScopeStr) ||
          /^use\s+@[\w\.-]+\s+as\s+(?:the\s+)?freelancer/i.test(rawScopeStr);

        if (!isPollutedScope) {
          if (st.scopeItems && Array.isArray(st.scopeItems) && st.scopeItems.length > 0) {
            scopeItemsVal = [...st.scopeItems];
          } else if (st.scope?.value) {
            scopeItemsVal = splitScopeItems(st.scope.value);
          }
          scopeStatus = st.scope?.status || 'CONFIRMED';
        }
      }
      if (st.amount?.value && (!userSetAmount || amountStatus !== 'CONFIRMED')) {
        amountNum = st.amount.value.amount;
        assetType = st.amount.value.asset;
        amountStatus = st.amount.status;
      }
      if (st.deadline?.value && (!userSetDeadline || deadlineStatus !== 'CONFIRMED')) {
        deadlineRaw = st.deadline.value.raw || null;
        deadlineStatus = st.deadline.status;
      }
      if (st.paymentStructure?.value && (!userSetPayStruct || payStructStatus !== 'CONFIRMED')) {
        payStructVal = st.paymentStructure.value;
        payStructStatus = st.paymentStructure.status;
      }
    }

    // Replay deterministic server-resolved actions from AI turns (authoritative deterministic transitions)
    const { resolvedActions: resActions } = getNegotiatorMessageMetadata(m);
    if (Array.isArray(resActions) && resActions.length > 0) {
      for (const act of resActions) {
        if (!act || typeof act !== 'object' || typeof act.type !== 'string') continue;

        if (act.type === 'SET_TITLE' && (!act.targetField || act.targetField === 'TITLE')) {
          if (typeof act.value === 'string' && act.value.trim().length > 0) {
            titleVal = act.value.trim();
            titleStatus = 'CONFIRMED';
            userSetTitle = true;
          }
        } else if (act.type === 'SET_AMOUNT' && (!act.targetField || act.targetField === 'BUDGET')) {
          if (
            typeof act.value === 'string' &&
            act.value.trim().length > 0 &&
            !isNaN(Number(act.value.trim())) &&
            Number(act.value.trim()) > 0 &&
            (act.asset === 'ETH' || act.asset === 'USDC')
          ) {
            amountNum = act.value.trim();
            assetType = act.asset;
            amountStatus = 'CONFIRMED';
            userSetAmount = true;
          }
        } else if (act.type === 'CLEAR_AMOUNT' && (!act.targetField || act.targetField === 'BUDGET')) {
          amountNum = null;
          amountStatus = 'MISSING';
          userSetAmount = true;
        } else if (act.type === 'SET_DEADLINE' && (!act.targetField || act.targetField === 'DEADLINE')) {
          if (typeof act.value === 'string' && act.value.trim().length > 0) {
            deadlineRaw = act.value.trim();
            deadlineStatus = 'CONFIRMED';
            userSetDeadline = true;
          }
        } else if (act.type === 'CLEAR_DEADLINE' && (!act.targetField || act.targetField === 'DEADLINE')) {
          deadlineRaw = null;
          deadlineStatus = 'MISSING';
          userSetDeadline = true;
        } else if (act.type === 'SET_PAYMENT_STRUCTURE' && (!act.targetField || act.targetField === 'PAYMENT')) {
          if (act.value === 'custom' || act.value === '50-50' || act.value === 'single') {
            payStructVal = act.value;
            payStructStatus = 'CONFIRMED';
            userSetPayStruct = true;
          }
        } else if (act.type === 'CLEAR_PAYMENT_STRUCTURE' && (!act.targetField || act.targetField === 'PAYMENT')) {
          payStructVal = null;
          payStructStatus = 'MISSING';
          userSetPayStruct = true;
        } else if (act.type === 'CLEAR_TITLE' && (!act.targetField || act.targetField === 'TITLE')) {
          titleVal = null;
          titleStatus = 'MISSING';
          userSetTitle = true;
        } else if (act.type === 'SELECT_FREELANCER' && (!act.targetField || act.targetField === 'SELLER')) {
          if (typeof act.value === 'string' && isAddress(act.value)) {
            sellerVal = act.value.toLowerCase();
            sellerStatus = 'CONFIRMED';
            userSetSeller = true;
            if (st?.sellerName && !st.sellerName.startsWith('@')) {
              sellerNameVal = st.sellerName;
            }
          }
        } else if (act.type === 'CLEAR_SELLER' && (!act.targetField || act.targetField === 'SELLER')) {
          sellerVal = null;
          sellerStatus = 'MISSING';
          sellerNameVal = null;
          userSetSeller = true;
          unresolvedHandle = null;
          handleResolutionStatus = null;
          sellerAmbiguous = false;
          ambiguousName = null;
          candidateSellerName = null;
        } else if (
          ['ADD_SCOPE', 'REMOVE_SCOPE', 'REPLACE_SCOPE_ITEM', 'REPLACE_SCOPE', 'CLEAR_SCOPE'].includes(act.type) &&
          (!act.targetField || act.targetField === 'SCOPE' || act.targetField === 'SCOPE_ITEM')
        ) {
          if (Array.isArray(act.items)) {
            scopeItemsVal = act.items.map((i) => cleanSingleScopeItem(i)).filter(Boolean);
            scopeStatus = scopeItemsVal.length > 0 ? 'CONFIRMED' : 'MISSING';
            userSetScope = true;
          }
        }
      }
    }

    // Extract heuristics & intent boundaries from user messages ONLY if turn is NOT a read-only question
    if (m.role === 'user' && !isInformationalQuestion(maskQuotedControlSyntax(text))) {
      // 1. Explicit cancellation check using canonical helper (skipping if user is rejecting an immediate pending confirmation)
      let prevAiHadConfirm = false;
      for (let p = idx - 1; p >= 0; p--) {
        if (settledMessages[p].role === 'ai' || settledMessages[p].role === 'assistant') {
          const prevMeta = getNegotiatorMessageMetadata(settledMessages[p]);
          if (prevMeta.pendingClarification?.operation === 'CONFIRM') {
            prevAiHadConfirm = true;
          }
          break;
        }
      }
      const isConfirmNegative = CONFIRM_NEGATIVE_REGEX.test(text.trim());
      const isCancelDraft = !(prevAiHadConfirm && isConfirmNegative) && isExplicitDraftCancellation(maskQuotedControlSyntax(text));
      if (isCancelDraft) {
        draftStatus = 'INACTIVE';
        cancellationReason = 'USER_CANCELLED';
        pendingAction = null;
        lastExplicitLifecycleAction = 'CANCEL';
      }

      // 2. Explicit activation check
      const isExplicitActivate = isExplicitDraftActivation(maskQuotedControlSyntax(text));

      // 3. Affirmative response check to an explicit draft offer (pendingAction === 'DRAFT_DEAL' or prose offer)
      let prevAiOfferedDraft = pendingAction === 'DRAFT_DEAL';
      if (!prevAiOfferedDraft) {
        for (let p = idx - 1; p >= 0; p--) {
          if (settledMessages[p].role === 'ai') {
            const prevText = settledMessages[p].content || '';
            const prevPayload = settledMessages[p].payload?.negotiationState;
            if (prevPayload?.pendingAction === 'DRAFT_DEAL') {
              prevAiOfferedDraft = true;
            } else if (/(?:would you like me to draft|draft the deal|turn these terms into a deal draft)/i.test(prevText)) {
              prevAiOfferedDraft = true;
            }
            break;
          }
        }
      }

      const isAffirmative = /^(?:yes|sure|okay|ok|yep|yeah|do it|go ahead|please|lets do it|let's do it)$/i.test(text.trim()) || /(?:yes,\s*draft|okay\s*draft|please\s*draft|draft\s+it)/i.test(text);

      if (!isCancelDraft && (isExplicitActivate || (isAffirmative && prevAiOfferedDraft))) {
        draftStatus = 'ACTIVE';
        cancellationReason = 'ACTIVE';
        pendingAction = null;
        lastExplicitLifecycleAction = 'ACTIVATE';
      } else if (isAffirmative && !prevAiOfferedDraft) {
        pendingAction = null;
      }

      // Find the paired assistant message responding to this user turn
      let pairedAiMsg: any = null;
      for (let j = idx + 1; j < settledMessages.length; j++) {
        if (settledMessages[j].role === 'ai' || settledMessages[j].role === 'assistant') {
          pairedAiMsg = settledMessages[j];
          break;
        }
      }

      const { resolvedActions: pairedResolvedActions } = getNegotiatorMessageMetadata(pairedAiMsg);
      const isModernTurn = pairedResolvedActions !== undefined;

      // Modern turns derive canonical state mutations exclusively from the assistant's
      // deterministic resolvedActions. Raw heuristics must ONLY execute on legacy turns.
      if (!isModernTurn) {
        // Segment turn into clauses for sequential deterministic term extraction
        const turnClauses = segmentCommandClauses(text);

        for (const clause of turnClauses) {
          const controlClause = maskQuotedControlSyntax(clause);
          const interp = interpretClause(controlClause);
          if (isInformationalQuestion(controlClause) || isConditionalCommand(controlClause) || interp.polarity === 'NEGATED' || interp.isKeep) {
            continue;
          }

          // Contextual reference mutations (e.g. "change it to 10 days", "make it 0.3 ETH", "set it to Web Development")
          // depend on server semantic resolution and must NOT have raw scalar heuristics independently guess a target.
          // Their deterministic transitions are replayed exclusively via structured resolvedActions from the AI turn.
          if (isContextualReferenceCommand(clause)) {
            continue;
          }

          // Scope ordinal / item-reference mutations (e.g. "remove the second one", "replace the last deliverable with...")
          // depend on server ordinal resolution and must NOT have raw heuristic guessing independently mutate scope.
          // Their deterministic transitions are replayed authoritatively via structured resolvedActions from the AI turn.
          if (isScopeItemReferenceCommand(clause)) {
            continue;
          }

          // Ambiguous targetless ADD commands (e.g. "add 0.5 ETH", "add 10 days", "add dashboard")
          // have zero canonical mutation authority and must NOT have raw legacy heuristics infer a target.
          // Their deterministic transitions are replayed authoritatively via structured resolvedActions from the AI turn.
          const isBareAdd =
            /^(?:please\s+)?(?:also\s+)?(?:add|include)\b/i.test(controlClause) &&
            detectExplicitTarget(clause) === 'NONE';
          if (isBareAdd) {
            continue;
          }

          // Targetless destructive commands in legacy turns
          const isDestructive = /^(?:please\s+)?(?:remove|drop|delete|clear|reset|discard|take\s+out)\b/i.test(controlClause);
          if (isDestructive && detectExplicitTarget(clause) === 'NONE') {
            continue;
          }

        // --- Grounded Seller Resolution Logic ---
        // Source 1: Explicit 0x EVM Wallet Address
        const walletMatch = clause.match(/0x[0-9a-fA-F]{40}/);
        if (walletMatch) {
          sellerVal = walletMatch[0].toLowerCase();
          sellerStatus = 'CONFIRMED';
          userSetSeller = true;
          unresolvedHandle = null;
          handleResolutionStatus = null;
          sellerAmbiguous = false;
          candidateSellerName = null;
        } else {
          // Source 2: Synq Handle (@handle) Mention
          const handleMatches = Array.from(clause.matchAll(/@([a-zA-Z0-9_]{3,32})\b/g));
          if (handleMatches.length > 0) {
            const rawHandle = handleMatches[0][1];
            const res = await resolveHandleToWallet(rawHandle);
            handleResolutionStatus = res.status;
            if (res.status === 'RESOLVED') {
              sellerVal = res.wallet;
              sellerNameVal = res.name;
              sellerStatus = 'CONFIRMED';
              userSetSeller = true;
              unresolvedHandle = null;
              sellerAmbiguous = false;
              candidateSellerName = null;
            } else {
              sellerVal = null;
              sellerNameVal = null;
              sellerStatus = 'MISSING';
              unresolvedHandle = `@${rawHandle}`;
              sellerAmbiguous = false;
            }
          } else {
            // Source 3: Grounded Freelancer Selection or Candidate Display Name
            const selectMatch = clause.match(
              /(?:use|select|pick|choose|go with|hire|draft with|deal with|with)\s+(@?[\w\s\.-]+|1st|2nd|3rd|first|second|third|number\s*\d)/i
            );
            if (selectMatch && sellerStatus !== 'CONFIRMED') {
              const rawTarget = selectMatch[1].trim().toLowerCase();

              let priorSellers: AiNegotiatorSellerResult[] = [];
              for (let i = idx - 1; i >= 0; i--) {
                const pm = settledMessages[i];
                const payloadSellers =
                  pm.payload?.sellers ||
                  (pm as any).sellers ||
                  pm.payload?.attachment?.sellers;
                if (Array.isArray(payloadSellers) && payloadSellers.length > 0) {
                  priorSellers = payloadSellers;
                  break;
                }
              }

              if (priorSellers.length > 0) {
                let matches: AiNegotiatorSellerResult[] = [];
                if (/1st|first|number\s*1|^1$/.test(rawTarget)) {
                  if (priorSellers[0]) matches = [priorSellers[0]];
                } else if (/2nd|second|number\s*2|^2$/.test(rawTarget)) {
                  if (priorSellers[1]) matches = [priorSellers[1]];
                } else if (/3rd|third|number\s*3|^3$/.test(rawTarget)) {
                  if (priorSellers[2]) matches = [priorSellers[2]];
                } else {
                  const targetClean = rawTarget.replace(/^@/, '');
                  matches = priorSellers.filter((s) => {
                    const nameLower = s.name.toLowerCase();
                    const walletLower = s.wallet.toLowerCase();
                    return (
                      nameLower.includes(targetClean) ||
                      targetClean.includes(nameLower) ||
                      walletLower.includes(targetClean)
                    );
                  });
                }

                if (matches.length === 1) {
                  const chosen = matches[0];
                  sellerVal = chosen.wallet.toLowerCase();
                  sellerNameVal = chosen.name;
                  sellerStatus = 'CONFIRMED';
                  userSetSeller = true;
                  sellerAmbiguous = false;
                  candidateSellerName = null;
                } else if (matches.length > 1) {
                  sellerVal = null;
                  sellerStatus = 'MISSING';
                  sellerAmbiguous = true;
                  ambiguousName = selectMatch[1].trim();
                }
              } else {
                // No prior grounded sellers in history. User used a display name (e.g. "Draft a deal with Ali...")
                // Display name MUST NOT set sellerStatus = 'CONFIRMED'!
                const candidate = extractCandidateSellerName(clause);
                if (!sellerVal || !isAddress(sellerVal)) {
                  sellerVal = null;
                  sellerStatus = 'MISSING';
                  candidateSellerName = candidate;
                }
              }
            }
          }
        }

        // Budget operation parsing & asset validation
        const hasBudgetEnvelope = /(?:budget|amount|cost|price|fee)\b/i.test(controlClause);
        const budgetOp = parseBudgetOperation(controlClause) || (hasBudgetEnvelope ? parseBudgetOperation(clause) : null);
        if (budgetOp?.type === 'VALID') {
          amountNum = budgetOp.amount;
          assetType = budgetOp.asset;
          amountStatus = 'CONFIRMED';
          userSetAmount = true;
        }

        // Deadline detection
        const hasDeadlineEnvelope = /(?:deadline|timeline|timeframe|duration|days?|weeks?|months?)\b/i.test(controlClause);
        const daysMatch = (hasDeadlineEnvelope ? clause : controlClause).match(/(\d+)\s*days?/i);
        const weeksMatch = (hasDeadlineEnvelope ? clause : controlClause).match(/(\d+)\s*weeks?/i);
        if (daysMatch) {
          deadlineRaw = `${daysMatch[1]} days`;
          deadlineStatus = 'CONFIRMED';
          userSetDeadline = true;
        } else if (weeksMatch) {
          deadlineRaw = `${weeksMatch[1]} weeks`;
          deadlineStatus = 'CONFIRMED';
          userSetDeadline = true;
        }

        // Payment structure explicit mention detection
        const hasPaymentEnvelope = /(?:payment|milestones?|release|structure)\b/i.test(controlClause);
        const payInspectText = hasPaymentEnvelope ? clause : controlClause;
        if (/(?:50-50|50\/50|half and half)/i.test(payInspectText)) {
          payStructVal = '50-50';
          payStructStatus = 'CONFIRMED';
          userSetPayStruct = true;
        } else if (/(?:single release|single payment|upfront|100% at end)/i.test(payInspectText)) {
          payStructVal = 'single';
          payStructStatus = 'CONFIRMED';
          userSetPayStruct = true;
        } else if (/(?:custom milestone|custom payment)/i.test(payInspectText)) {
          payStructVal = 'custom';
          payStructStatus = 'CONFIRMED';
          userSetPayStruct = true;
        }

        // Title & Scope operations
        const titleOp = parseTitleOperation(clause);
        if (titleOp) {
          titleVal = titleOp;
          titleStatus = 'CONFIRMED';
          userSetTitle = true;
        }

        // Scope extraction & operation parsing
        const scopeOp = parseScopeOperation(clause, scopeItemsVal);
        if (scopeOp) {
          scopeItemsVal = [...scopeOp.items];
          if (scopeOp.type === 'clear' || scopeItemsVal.length === 0) {
            scopeStatus = 'MISSING';
            userSetScope = true;
          } else {
            scopeStatus = 'CONFIRMED';
            userSetScope = true;
          }
        } else if (scopeStatus === 'MISSING') {
          const hasHandleMention = /@([a-zA-Z0-9_]{3,32})\b/.test(controlClause);
          const isSellerCmd =
            isExplicitSellerSelection(controlClause) ||
            /(?:use|select|pick|choose|go with|hire|draft with|deal with|with)\s+@?/i.test(controlClause);

          const hasExplicitOtherCommand =
            isSellerCmd ||
            isExplicitSellerSearchRequest(controlClause) ||
            isExplicitDraftActivation(controlClause) ||
            isExplicitDraftCancellation(controlClause) ||
            Boolean(parseTitleOperation(clause)) ||
            isReferenceMutationCommand(clause) ||
            hasHandleMention;

          const isScopeQuestion = /^(?:what|why|how|can|explain|is)\b/i.test(controlClause.trim()) || controlClause.includes('?');
          const isExplicitScopeInput = /(?:include|deliverables|features|contains|scope|responsive|contact form|deployment)/i.test(controlClause);
          if (
            !isScopeQuestion &&
            !budgetOp &&
            !daysMatch &&
            !weeksMatch &&
            !walletMatch &&
            !hasExplicitOtherCommand &&
            (isExplicitScopeInput || (controlClause.length > 20 && !isInformationalQuestion(controlClause)))
          ) {
            const items = splitScopeItems(clause);
            if (items.length > 0) {
              scopeItemsVal = items;
              scopeStatus = 'CONFIRMED';
              userSetScope = true;
            }
          }
        }
      }

      // Confirmation phrases for proposed terms
        if (/(?:yes|confirm|looks good|agree|proceed|fine)/i.test(text) && !isAffirmative) {
          if (sellerVal && isAddress(sellerVal) && sellerStatus === 'PROPOSED') sellerStatus = 'CONFIRMED';
          if (titleVal && titleStatus === 'PROPOSED') titleStatus = 'CONFIRMED';
          if (scopeItemsVal.length > 0 && scopeStatus === 'PROPOSED') scopeStatus = 'CONFIRMED';
          if (amountNum && amountStatus === 'PROPOSED') amountStatus = 'CONFIRMED';
          if (deadlineRaw && deadlineStatus === 'PROPOSED') deadlineStatus = 'CONFIRMED';
        }
      }
    }
  }

  if (draftStatus === 'ACTIVE') {
    pendingAction = null;
  }

  // Enforce invariant: sellerStatus === 'CONFIRMED' requires valid 0x address
  if (sellerStatus === 'CONFIRMED' && (!sellerVal || !isAddress(sellerVal))) {
    sellerStatus = 'MISSING';
    sellerVal = null;
  }

  // Enforce invariant: scopeItemsVal & scopeVal must not be polluted seller-selection string or title-command artifact
  if (scopeItemsVal.length > 0) {
    const rawScopeStr = formatScopeItems(scopeItemsVal);
    if (
      isExplicitSellerSelection(rawScopeStr) ||
      isTitleCommandArtifact(rawScopeStr) ||
      /^(?:use|select|pick|choose|go with|hire|draft with|deal with|with)\s+@/i.test(rawScopeStr) ||
      /^use\s+@[\w\.-]+\s+as\s+(?:the\s+)?freelancer/i.test(rawScopeStr)
    ) {
      scopeItemsVal = [];
      scopeStatus = 'MISSING';
    }
  }

  const derivedScopeVal = formatScopeItems(scopeItemsVal);

  const contractTermsComplete =
    Boolean(sellerVal && isAddress(sellerVal)) &&
    sellerStatus === 'CONFIRMED' &&
    titleStatus === 'CONFIRMED' &&
    scopeStatus === 'CONFIRMED' &&
    amountStatus === 'CONFIRMED' &&
    deadlineStatus === 'CONFIRMED';

  const isReadyToCreate =
    draftStatus === 'ACTIVE' &&
    contractTermsComplete &&
    payStructStatus === 'CONFIRMED';

  return {
    draftStatus,
    cancellationReason,
    pendingAction,
    seller: { value: sellerVal, status: sellerStatus },
    sellerName: sellerNameVal,
    title: { value: titleVal, status: titleStatus },
    scope: { value: scopeItemsVal.length > 0 ? derivedScopeVal : null, status: scopeStatus },
    scopeItems: scopeItemsVal,
    amount: {
      value: amountNum ? { amount: amountNum, asset: assetType } : null,
      status: amountStatus,
    },
    deadline: {
      value: deadlineRaw ? { raw: deadlineRaw } : null,
      status: deadlineStatus,
    },
    paymentStructure: { value: payStructVal, status: payStructStatus },
    protectionEnabled: false,
    isReadyToCreate,
    unresolvedHandle,
    handleResolutionStatus,
    sellerAmbiguous,
    ambiguousName,
    candidateSellerName,
  };
}

type DealIntelligenceResponseLane =
  | 'DETERMINISTIC_ONLY'
  | 'READ_ONLY_INTELLIGENCE'
  | 'MIXED_READ_ONLY_INTELLIGENCE';

function renderDeterministicMutationConfirmation(
  contextState: NegotiationStateData,
  actionPrefixes: string[],
  infoPrefixes: string[]
): string {
  const compositeParts = [
    ...infoPrefixes,
    ...actionPrefixes,
  ];
  let compositeMsg = compositeParts.join(' ').trim();
  if (contextState.draftStatus === 'ACTIVE') {
    const nextMissing = getNextMissingDraftTerm(contextState);
    if (nextMissing === 'seller') {
      compositeMsg += " I need the freelancer's Synq handle or wallet address to draft the deal.";
    } else if (nextMissing === 'title') {
      compositeMsg += " What is the title or main service for this deal?";
    } else if (nextMissing === 'scope') {
      const tName = contextState.title?.value || 'deal';
      compositeMsg += ` What should the ${tName.toLowerCase()} include?`;
    } else if (nextMissing === 'paymentStructure') {
      compositeMsg += " How should payment be released: Single Release, 50/50 Milestones, or Custom Milestones?";
    } else if (nextMissing === null) {
      compositeMsg += " The deal draft is complete.";
    }
  }
  return compositeMsg.trim();
}

/**
 * Strips a redundant leading mutation acknowledgment from Branch 4 intelligence text in mixed turns.
 * When the deterministic engine already prepends the authoritative mutation confirmation,
 * removes any leading sentence in which the model repeats or paraphrases that mutation.
 */
function stripLeadingMutationAcknowledgment(
  intelligenceText: string,
  resolvedActions: ResolvedActionPayload[] = []
): string {
  if (!intelligenceText || typeof intelligenceText !== 'string') return '';
  const trimmed = intelligenceText.trim();
  if (!trimmed) return '';

  const mutatedDomains = new Set<string>();
  for (const act of resolvedActions) {
    if (act.targetField) mutatedDomains.add(act.targetField.toLowerCase());
    if (act.type.includes('AMOUNT') || act.type.includes('BUDGET')) mutatedDomains.add('budget');
    if (act.type.includes('DEADLINE')) mutatedDomains.add('deadline');
    if (act.type.includes('PAYMENT')) mutatedDomains.add('payment');
    if (act.type.includes('TITLE')) mutatedDomains.add('title');
    if (act.type.includes('SELLER')) mutatedDomains.add('freelancer');
    if (act.type.includes('SCOPE')) mutatedDomains.add('scope');
  }

  const domainWords = [
    ...Array.from(mutatedDomains).map((d) => (d === 'payment' ? 'payment(?:\\s+structure)?' : d)),
    'deal(?:\\s+details|\\s+terms)?',
    'draft',
    'it',
    'terms?',
  ].join('|');

  const leadingAcknowledgmentRegex = new RegExp(
    `^(?:(?:I(?:'ve|\\s+have)?\\s+(?:updated|set|changed|added|modified)|The\\s+(?:${domainWords})\\s+(?:has\\s+been\\s+)?(?:set|updated|changed)|(?:${domainWords})\\s+(?:is\\s+now|has\\s+been|set|updated|changed))[^.!?\\n]*[.!?\\n]+)\\s*`,
    'i'
  );

  return trimmed.replace(leadingAcknowledgmentRegex, '').trim();
}

export async function generateAiNegotiation(
  rawInput: string | GenerateNegotiationInput
): Promise<AiNegotiationResult> {
  // Legacy String Input Compatibility (Used by generic /api/ai callers)
  if (typeof rawInput === 'string') {
    const cleanLegacyPrompt = rawInput.trim();
    if (LOOKS_LIKE_SELLER_SEARCH.test(cleanLegacyPrompt)) {
      const found = await findSellers(cleanLegacyPrompt);
      const sellers: AiNegotiatorSellerResult[] = Array.isArray(found?.sellers) ? found.sellers : [];
      return {
        message: typeof found?.message === 'string' && found.message ? found.message : 'Matching sellers found.',
        sellers: sellers.length > 0 ? sellers : undefined,
        rawResult: found,
      };
    }

    const legacyRaw = await getAISuggestions(cleanLegacyPrompt);
    let parsedLegacy: any = legacyRaw;
    try { parsedLegacy = JSON.parse(legacyRaw); } catch { /* ignore */ }
    return {
      message: parsedLegacy?.message || "I've analyzed your request. Here are some options.",
      suggestions: Array.isArray(parsedLegacy?.suggestions) ? parsedLegacy.suggestions : undefined,
      rawResult: parsedLegacy,
    };
  }

  // Trusted Negotiator V2 Contextual Engine Path
  const input: GenerateNegotiationInput = rawInput;
  const cleanPrompt = (input.currentPrompt || '').trim();

  let previousState: NegotiationStateData | undefined = input.previousNegotiationState;
  if (!previousState && Array.isArray(input.messages)) {
    for (let i = input.messages.length - 1; i >= 0; i--) {
      const m = input.messages[i];
      if (m.role === 'ai' && m.payload?.negotiationState) {
        previousState = m.payload.negotiationState;
        break;
      }
    }
  }

  const rawMessages = Array.isArray(input.messages) ? input.messages : [];
  const lastMsg = rawMessages.length > 0 ? rawMessages[rawMessages.length - 1] : null;
  const historyBeforeCurrentTurn =
    lastMsg && lastMsg.role === 'user' ? rawMessages.slice(0, -1) : rawMessages;

  const contextState = await extractNegotiationState(historyBeforeCurrentTurn, previousState);

  // Capture Pre-Turn state snapshot for truthful informational answers & action comparisons
  const preTurnCancellationReason = contextState.cancellationReason;
  const preTurnTitle = contextState.title.value || null;
  const preTurnAmount = contextState.amount.value ? `${contextState.amount.value.amount} ${contextState.amount.value.asset}` : null;
  const preTurnDeadline = contextState.deadline.value?.raw || null;
  const preTurnScopeItems = [...(contextState.scopeItems || [])];
  const preTurnScope = contextState.scope.value || null;
  const preTurnPayStruct = contextState.paymentStructure.value || null;
  const preTurnSeller = contextState.seller?.value && isAddress(contextState.seller.value) ? contextState.seller.value : null;
  const preTurnSellerName = contextState.sellerName || (contextState.seller.value ? contextState.seller.value : null);

  // Determine intent & actions via structured classifier
  const turnClassification = classifyUserTurn(cleanPrompt, preTurnScopeItems, historyBeforeCurrentTurn, contextState);
  let intent: string = turnClassification.primaryIntent;

  // Normalize internal primary intents to engine expectation strings
  if (intent === 'INFORMATIONAL_QUESTION') {
    intent = 'GENERAL_QUESTION';
  } else if (intent === 'ACTIVATE_DRAFT') {
    intent = 'START_DEAL';
  }

  const hasSearchAction = turnClassification.actions.some((a) => a.type === 'SEARCH_FREELANCERS');
  const hasActivateAction = turnClassification.actions.some((a) => a.type === 'ACTIVATE_DRAFT');
  const isSellerSearch = intent === 'FIND_FREELANCER' || hasSearchAction;
  const isSelectFreelancer = intent === 'SELECT_FREELANCER';
  const isCancelDraft = intent === 'CANCEL_DRAFT' || turnClassification.actions.some((a) => a.type === 'CANCEL_DRAFT');

  // Execute explicit actions in memory on contextState
  let actionPrefixes: string[] = [];
  let currentScopeItemsVal = [...preTurnScopeItems];

  for (const act of turnClassification.actions) {
    if (act.type === 'CANCEL_DRAFT') {
      contextState.draftStatus = 'INACTIVE';
      contextState.cancellationReason = 'USER_CANCELLED';
      contextState.pendingAction = null;
      actionPrefixes.push('The deal draft has been cancelled.');
    } else if (act.type === 'ACTIVATE_DRAFT') {
      contextState.draftStatus = 'ACTIVE';
      contextState.cancellationReason = 'ACTIVE';
      contextState.pendingAction = null;
      if (preTurnCancellationReason === 'USER_CANCELLED') {
        actionPrefixes.push("I've reactivated it.");
      } else if (preTurnCancellationReason === 'NOT_STARTED') {
        actionPrefixes.push("I've started a deal draft.");
      } else {
        actionPrefixes.push("I've reactivated the deal draft.");
      }
    } else if (act.type === 'REQUEST_CLARIFICATION') {
      // Clarification prompt is handled exclusively by the clarification fast path (clarMsg)
      // to avoid polluting actionPrefixes with duplicate prompts.
    } else if (act.type === 'SET_TITLE') {
      contextState.title = {
        value: act.payload.value,
        status: 'CONFIRMED',
      };
      if (preTurnTitle === act.payload.value) {
        actionPrefixes.push(`Title is already "${act.payload.value}".`);
      } else {
        actionPrefixes.push(`Title set to "${act.payload.value}".`);
      }
    } else if (act.type === 'CLEAR_TITLE') {
      const hadTitle = Boolean(preTurnTitle);
      contextState.title = {
        value: null,
        status: 'MISSING',
      };
      if (hadTitle) {
        actionPrefixes.push('Deal title cleared.');
      } else {
        actionPrefixes.push('The deal title is already unset.');
      }
    } else if (act.type === 'SET_AMOUNT') {
      contextState.amount = {
        value: { amount: act.payload.amount, asset: act.payload.asset },
        status: 'CONFIRMED',
      };
      const targetAmountStr = `${act.payload.amount} ${act.payload.asset}`;
      if (preTurnAmount === targetAmountStr) {
        actionPrefixes.push(`Budget is already ${targetAmountStr}.`);
      } else if (preTurnAmount) {
        actionPrefixes.push(`I've updated it to ${targetAmountStr}.`);
      } else {
        actionPrefixes.push(`Budget set to ${targetAmountStr}.`);
      }
    } else if (act.type === 'CLEAR_AMOUNT') {
      const hadAmount = Boolean(preTurnAmount);
      contextState.amount = {
        value: null,
        status: 'MISSING',
      };
      if (hadAmount) {
        actionPrefixes.push('Budget cleared.');
      } else {
        actionPrefixes.push('The budget is already unset.');
      }
    } else if (act.type === 'UNSUPPORTED_ASSET') {
      actionPrefixes.push(`${act.payload.asset} is not supported for Synq deals. Please specify your budget in ETH or USDC.`);
    } else if (act.type === 'AMBIGUOUS_ASSET') {
      actionPrefixes.push(`${act.payload.symbol}${act.payload.amount} is ambiguous for settlement. Synq currently supports ETH and USDC. Please specify the asset.`);
    } else if (act.type === 'MISSING_ASSET') {
      actionPrefixes.push(`Please specify the budget asset. Synq currently supports ETH and USDC.`);
    } else if (act.type === 'SET_DEADLINE') {
      contextState.deadline = {
        value: { raw: act.payload.raw },
        status: 'CONFIRMED',
      };
      if (preTurnDeadline === act.payload.raw) {
        actionPrefixes.push(`Deadline is already ${act.payload.raw}.`);
      } else if (preTurnDeadline) {
        actionPrefixes.push(`I've updated it to ${act.payload.raw}.`);
      } else {
        actionPrefixes.push(`Deadline set to ${act.payload.raw}.`);
      }
    } else if (act.type === 'CLEAR_DEADLINE') {
      const hadDeadline = Boolean(preTurnDeadline);
      contextState.deadline = {
        value: null,
        status: 'MISSING',
      };
      if (hadDeadline) {
        actionPrefixes.push('Deadline cleared.');
      } else {
        actionPrefixes.push('The deadline is already unset.');
      }
    } else if (act.type === 'SET_PAYMENT_STRUCTURE') {
      contextState.paymentStructure = {
        value: act.payload.value,
        status: 'CONFIRMED',
      };
      const pLabel = act.payload.value === '50-50' ? '50/50 Milestones' : act.payload.value === 'single' ? 'Single Release' : 'Custom Milestones';
      if (preTurnPayStruct === act.payload.value) {
        actionPrefixes.push(`Payment structure is already ${pLabel}.`);
      } else {
        actionPrefixes.push(`Payment structure set to ${pLabel}.`);
      }
    } else if (act.type === 'CLEAR_PAYMENT_STRUCTURE') {
      const hadPayment = Boolean(preTurnPayStruct);
      contextState.paymentStructure = {
        value: null,
        status: 'MISSING',
      };
      if (hadPayment) {
        actionPrefixes.push('Payment structure cleared.');
      } else {
        actionPrefixes.push('Payment structure is already unset.');
      }
    } else if (act.type === 'SELECT_FREELANCER') {
      const rawClause = act.payload?.raw || '';
      const handleMatch = rawClause.match(/@([a-zA-Z0-9_]{3,32})\b/i);
      const walletMatch = rawClause.match(/0x[0-9a-fA-F]{40}/i);

      if (handleMatch) {
        const rawHandle = handleMatch[1];
        const res = await resolveHandleToWallet(rawHandle);
        contextState.handleResolutionStatus = res.status;
        if (res.status === 'RESOLVED') {
          contextState.seller = {
            value: res.wallet,
            status: 'CONFIRMED',
          };
          contextState.sellerName = res.name;
          contextState.unresolvedHandle = null;
          contextState.sellerAmbiguous = false;
          contextState.ambiguousName = null;
          contextState.candidateSellerName = null;

          actionPrefixes.push(`Freelancer selected: ${res.name} (@${res.handle}).`);
        } else if (res.status === 'NOT_FOUND') {
          contextState.unresolvedHandle = `@${res.handle}`;
        } else if (res.status === 'NOT_FREELANCER') {
          contextState.unresolvedHandle = `@${res.handle}`;
        } else {
          contextState.unresolvedHandle = `@${res.handle}`;
        }
      } else if (walletMatch) {
        const walletLower = walletMatch[0].toLowerCase() as `0x${string}`;
        const dirRes = await resolveWalletFreelancer(walletLower);
        contextState.handleResolutionStatus = dirRes.status;
        if (dirRes.status === 'RESOLVED') {
          contextState.seller = {
            value: walletLower,
            status: 'CONFIRMED',
          };
          contextState.sellerName = dirRes.name;
          contextState.unresolvedHandle = null;
          contextState.sellerAmbiguous = false;
          contextState.ambiguousName = null;
          contextState.candidateSellerName = null;

          const displayName = dirRes.name && dirRes.name.toLowerCase() !== walletLower ? dirRes.name : walletLower;
          actionPrefixes.push(`Freelancer selected: ${displayName}.`);
        } else if (dirRes.status === 'NOT_FREELANCER') {
          contextState.unresolvedHandle = walletMatch[0];
        } else {
          contextState.unresolvedHandle = walletMatch[0];
        }
      }
    } else if (act.type === 'CLEAR_SELLER') {
      const hadSeller = Boolean(preTurnSeller);
      contextState.seller = {
        value: null,
        status: 'MISSING',
      };
      contextState.sellerName = null;
      contextState.unresolvedHandle = null;
      contextState.handleResolutionStatus = null;
      contextState.sellerAmbiguous = false;
      contextState.ambiguousName = null;
      contextState.candidateSellerName = null;
      if (hadSeller) {
        actionPrefixes.push('Freelancer removed.');
      } else {
        actionPrefixes.push('No freelancer is currently selected.');
      }
    } else if (act.type === 'CLEAR_SCOPE') {
      const itemsBeforeAct = [...currentScopeItemsVal];
      currentScopeItemsVal = [];
      contextState.scopeItems = [];
      contextState.scope = {
        value: '',
        status: 'MISSING',
      };
      if (itemsBeforeAct.length > 0) {
        if (!actionPrefixes.includes("Scope cleared.")) {
          actionPrefixes.push("Scope cleared.");
        }
      } else {
        if (!actionPrefixes.includes("The scope is already empty.")) {
          actionPrefixes.push("The scope is already empty.");
        }
      }
    } else if (act.type === 'REPLACE_SCOPE' || act.type === 'ADD_SCOPE' || act.type === 'REMOVE_SCOPE') {
      const itemsBeforeAct = [...currentScopeItemsVal];
      const newItems: string[] = act.payload?.items || [];
      currentScopeItemsVal = [...newItems];
      contextState.scopeItems = currentScopeItemsVal;
      const derivedScopeStr = formatScopeItems(currentScopeItemsVal);
      contextState.scope = {
        value: derivedScopeStr || null,
        status: currentScopeItemsVal.length > 0 ? 'CONFIRMED' : 'MISSING',
      };

      if (act.type === 'REMOVE_SCOPE') {
        const removedCount = typeof act.payload?.removedCount === 'number'
          ? act.payload.removedCount
          : (itemsBeforeAct.length - currentScopeItemsVal.length);

        if (removedCount > 0) {
          if (!actionPrefixes.includes("I've removed it.")) actionPrefixes.push("I've removed it.");
        } else {
          const targetItem = act.payload?.targetItem;
          const notFoundMsg = targetItem
            ? `I couldn't find a standalone "${targetItem}" item in the scope.`
            : "That item was not found in the scope.";
          if (!actionPrefixes.includes(notFoundMsg)) actionPrefixes.push(notFoundMsg);
        }
      } else {
        const hasChange = JSON.stringify(itemsBeforeAct) !== JSON.stringify(currentScopeItemsVal);
        if (hasChange) {
          if (!actionPrefixes.includes("Scope updated.")) actionPrefixes.push("Scope updated.");
        } else {
          if (!actionPrefixes.includes("That item is already included in the scope.")) actionPrefixes.push("That item is already included in the scope.");
        }
      }
    } else if (act.type === 'REPLACE_SCOPE_ITEM') {
      if (act.payload?.noop) {
        if (act.payload?.noopReason === 'SAME_ITEM') {
          const itemText = act.payload.targetItem ? ` "${act.payload.targetItem}"` : '';
          const msg = `That deliverable is already${itemText}.`;
          if (!actionPrefixes.includes(msg)) actionPrefixes.push(msg);
        } else if (act.payload?.noopReason === 'ALREADY_EXISTS') {
          const msg = "That item is already included in the scope.";
          if (!actionPrefixes.includes(msg)) actionPrefixes.push(msg);
        }
      } else {
        const newItems: string[] = act.payload?.items || [];
        currentScopeItemsVal = [...newItems];
        contextState.scopeItems = currentScopeItemsVal;
        const derivedScopeStr = formatScopeItems(currentScopeItemsVal);
        contextState.scope = {
          value: derivedScopeStr || null,
          status: currentScopeItemsVal.length > 0 ? 'CONFIRMED' : 'MISSING',
        };
        if (!actionPrefixes.includes("Scope updated.")) actionPrefixes.push("Scope updated.");
      }
    }
  }

  // Recalculate isReadyToCreate after executing turn actions using canonical missing-terms helper
  const missingTerms = getMissingNegotiationTerms(contextState);
  contextState.isReadyToCreate =
    contextState.draftStatus === 'ACTIVE' &&
    missingTerms.length === 0;

  // Build Truthful Answers for Informational Requests using Pre-Turn State
  let infoPrefixes: string[] = [];
  for (const req of turnClassification.informationalRequests) {
    if (req === 'MISSING_TERMS') {
      const readiness = getDraftReadiness(contextState);
      infoPrefixes.push(renderMissingTermsAnswer(readiness));
    } else if (req === 'CHECK_READINESS') {
      const readiness = getDraftReadiness(contextState);
      infoPrefixes.push(renderReadinessAnswer(readiness));
    } else if (req === 'WHY_INACTIVE') {
      if (preTurnCancellationReason === 'USER_CANCELLED') {
        infoPrefixes.push('You cancelled this draft earlier.');
      } else if (preTurnCancellationReason === 'NOT_STARTED') {
        infoPrefixes.push("We haven't started a deal draft in this conversation yet.");
      } else {
        infoPrefixes.push('The deal draft is currently inactive.');
      }
    } else if (req === 'CURRENT_BUDGET') {
      if (preTurnAmount) {
        infoPrefixes.push(`The budget was ${preTurnAmount}.`);
      } else {
        infoPrefixes.push('The budget is not specified yet.');
      }
    } else if (req === 'CURRENT_SCOPE') {
      if (preTurnScopeItems.length > 0) {
        const removeAct = turnClassification.actions.find((a) => a.type === 'REMOVE_SCOPE');
        if (removeAct) {
          const targetItem = removeAct.payload?.targetItem || 'item';
          infoPrefixes.push(`The scope included ${targetItem}.`);
        } else {
          infoPrefixes.push(`The current scope is ${formatScopeItems(preTurnScopeItems)}`);
        }
      } else {
        infoPrefixes.push('The scope is not specified yet.');
      }
    } else if (req === 'CURRENT_DEADLINE') {
      if (preTurnDeadline) {
        infoPrefixes.push(`The deadline was ${preTurnDeadline}.`);
      } else {
        infoPrefixes.push('The deadline is not specified yet.');
      }
    } else if (req === 'CURRENT_FREELANCER') {
      if (preTurnSellerName) {
        infoPrefixes.push(`${preTurnSellerName} is the currently selected freelancer.`);
      } else {
        infoPrefixes.push('No freelancer is currently selected.');
      }
    }
  }

  // HARD RENDERING RULE: Receipt may ONLY be attached when draftStatus === 'ACTIVE' AND current turn warrants receipt presentation.
  const RECEIPT_INTENTS = new Set([
    'START_DEAL',
    'MODIFY_TERMS',
    'SELECT_FREELANCER',
    'REVIEW_DRAFT',
    'CONFIRM_TERMS',
  ]);

  const EXPLICIT_RECEIPT_REQUEST = /(?:show|view|see|display|get)\s+(?:me\s+)?(?:the\s+)?(?:deal|receipt|draft|summary|terms|status|so far)/i;

  const shouldAttachReceipt =
    contextState.draftStatus === 'ACTIVE' &&
    intent !== 'FIND_FREELANCER' &&
    intent !== 'CANCEL_DRAFT' &&
    (RECEIPT_INTENTS.has(intent) || EXPLICIT_RECEIPT_REQUEST.test(cleanPrompt) || intent === 'GENERAL_QUESTION' || hasActivateAction);

  const attachment: AiNegotiatorAttachment | undefined = shouldAttachReceipt
    ? { type: 'deal_receipt', dealDraft: contextState }
    : undefined;

  const clarAction = turnClassification.actions.find((a) => a.type === 'REQUEST_CLARIFICATION');
  let pendingClarification: PendingClarificationPayload | null = null;
  if (clarAction?.payload?.kind) {
    const k = clarAction.payload.kind;
    if (['TITLE', 'BUDGET', 'DEADLINE', 'PAYMENT', 'SELLER'].includes(k)) {
      pendingClarification = { targetField: k as ScalarReferenceField, operation: 'SET' };
    } else if (k === 'SCOPE_ITEM_REMOVE') {
      pendingClarification = { targetField: 'SCOPE_ITEM', operation: 'REMOVE' };
    } else if (k === 'SCOPE_ITEM_REPLACE') {
      pendingClarification = {
        targetField: 'SCOPE_ITEM',
        operation: 'REPLACE',
        value: clarAction.payload.value,
      };
    } else if (k === 'AMBIGUOUS_ADD') {
      pendingClarification = {
        operation: 'ADD',
        targetField: 'UNKNOWN',
        value: clarAction.payload.value || '',
        items: clarAction.payload.items,
      };
    } else if (k === 'CONFIRM_SUGGESTED_TARGET') {
      if (clarAction.payload.targetField === 'BUDGET') {
        pendingClarification = {
          operation: 'CONFIRM',
          targetField: 'BUDGET',
          suggestedAction: 'SET_AMOUNT',
          value: clarAction.payload.value,
          asset: clarAction.payload.asset,
        };
      } else if (clarAction.payload.targetField === 'DEADLINE') {
        pendingClarification = {
          operation: 'CONFIRM',
          targetField: 'DEADLINE',
          suggestedAction: 'SET_DEADLINE',
          value: clarAction.payload.value,
        };
      } else if (clarAction.payload.targetField === 'PAYMENT') {
        pendingClarification = {
          operation: 'CONFIRM',
          targetField: 'PAYMENT',
          suggestedAction: 'SET_PAYMENT_STRUCTURE',
          value: clarAction.payload.value,
        };
      }
    } else if (k === 'DOMAIN_CONFLICT') {
      const propDom = clarAction.payload.proposedDomain;
      const propVal = clarAction.payload.proposedValue || '';
      if (propDom === 'PAYMENT') {
        const normVal = parsePaymentStructure(propVal);
        if (normVal) {
          pendingClarification = {
            operation: 'CONFIRM',
            targetField: 'PAYMENT',
            suggestedAction: 'SET_PAYMENT_STRUCTURE',
            value: normVal,
          };
        }
      }
    }
  }

  const resolvedActions: ResolvedActionPayload[] = [];
  for (const act of turnClassification.actions) {
    if (act.type === 'SET_TITLE' && contextState.title?.value) {
      resolvedActions.push({ type: 'SET_TITLE', targetField: 'TITLE', value: contextState.title.value });
    } else if (act.type === 'SET_AMOUNT' && contextState.amount?.value) {
      resolvedActions.push({
        type: 'SET_AMOUNT',
        targetField: 'BUDGET',
        value: String(contextState.amount.value.amount),
        asset: contextState.amount.value.asset,
      });
    } else if (act.type === 'CLEAR_AMOUNT') {
      resolvedActions.push({
        type: 'CLEAR_AMOUNT',
        targetField: 'BUDGET',
      });
    } else if (act.type === 'SET_DEADLINE' && contextState.deadline?.value) {
      resolvedActions.push({
        type: 'SET_DEADLINE',
        targetField: 'DEADLINE',
        value: contextState.deadline.value.raw || (contextState.deadline.value.timestamp ? String(contextState.deadline.value.timestamp) : ''),
      });
    } else if (act.type === 'CLEAR_DEADLINE') {
      resolvedActions.push({
        type: 'CLEAR_DEADLINE',
        targetField: 'DEADLINE',
      });
    } else if (act.type === 'CLEAR_TITLE') {
      resolvedActions.push({
        type: 'CLEAR_TITLE',
        targetField: 'TITLE',
      });
    } else if (act.type === 'SET_PAYMENT_STRUCTURE' && contextState.paymentStructure?.value) {
      resolvedActions.push({ type: 'SET_PAYMENT_STRUCTURE', targetField: 'PAYMENT', value: contextState.paymentStructure.value });
    } else if (act.type === 'CLEAR_PAYMENT_STRUCTURE') {
      resolvedActions.push({
        type: 'CLEAR_PAYMENT_STRUCTURE',
        targetField: 'PAYMENT',
      });
    } else if (act.type === 'SELECT_FREELANCER' && contextState.seller?.value && contextState.handleResolutionStatus === 'RESOLVED') {
      resolvedActions.push({ type: 'SELECT_FREELANCER', targetField: 'SELLER', value: contextState.seller.value });
    } else if (act.type === 'CLEAR_SELLER') {
      resolvedActions.push({
        type: 'CLEAR_SELLER',
        targetField: 'SELLER',
      });
    } else if (act.type === 'ADD_SCOPE') {
      const actItems: string[] = Array.isArray(act.payload?.items) ? act.payload.items : [];
      const addedItems: string[] = Array.isArray(act.payload?.addedItems)
        ? act.payload.addedItems
        : typeof act.payload?.value === 'string' && act.payload.value
        ? splitScopeItems(act.payload.value)
        : [];
      const addedCount = typeof act.payload?.addedCount === 'number' ? act.payload.addedCount : addedItems.length;

      if (addedCount > 0) {
        const resAct: ResolvedActionPayload = {
          type: 'ADD_SCOPE',
          targetField: 'SCOPE_ITEM',
          items: [...actItems],
        };
        if (addedItems.length === 1) {
          const singleItem = cleanSingleScopeItem(addedItems[0]);
          resAct.targetItem = singleItem;
          const idx = actItems.findIndex((it) => cleanSingleScopeItem(it).toLowerCase() === singleItem.toLowerCase());
          if (idx !== -1) {
            resAct.targetIndex = idx;
          }
        }
        resolvedActions.push(resAct);
      }
    } else if (act.type === 'REMOVE_SCOPE') {
      const removedCount = typeof act.payload?.removedCount === 'number' ? act.payload.removedCount : 0;
      if (removedCount > 0) {
        const actItems: string[] = Array.isArray(act.payload?.items) ? act.payload.items : [];
        const resAct: ResolvedActionPayload = {
          type: 'REMOVE_SCOPE',
          targetField: 'SCOPE_ITEM',
          items: [...actItems],
        };
        if (act.payload?.targetItem) {
          resAct.targetItem = act.payload.targetItem;
        }
        if (removedCount === 1 && typeof act.payload?.targetIndex === 'number' && act.payload.targetIndex >= 0) {
          resAct.targetIndex = act.payload.targetIndex;
        }
        resolvedActions.push(resAct);
      }
    } else if (act.type === 'REPLACE_SCOPE_ITEM') {
      if (!act.payload?.noop) {
        const actItems: string[] = Array.isArray(act.payload?.items) ? act.payload.items : [];
        resolvedActions.push({
          type: 'REPLACE_SCOPE_ITEM',
          targetField: 'SCOPE_ITEM',
          targetItem: act.payload?.targetItem,
          targetIndex: act.payload?.targetIndex,
          replacementItem: act.payload?.replacementItem,
          items: [...actItems],
        });
      }
    } else if (act.type === 'REPLACE_SCOPE') {
      const actItems: string[] = Array.isArray(act.payload?.items) ? act.payload.items : [];
      resolvedActions.push({
        type: 'REPLACE_SCOPE',
        targetField: 'SCOPE',
        items: [...actItems],
      });
    } else if (act.type === 'CLEAR_SCOPE') {
      resolvedActions.push({
        type: 'CLEAR_SCOPE',
        targetField: 'SCOPE',
        items: [],
      });
    }
  }

  // Fast Path 1: Deterministic cancellation/deactivation
  if (isCancelDraft) {
    return {
      message: 'The deal draft is now inactive.',
      intent: 'CANCEL_DRAFT',
      negotiationState: contextState,
      pendingClarification: null,
      resolvedActions: [],
    };
  }

  // Fast Path: Clarification Outcome (for vague/ambiguous phrasing like "change title", "make it cheaper", "remove that", "set it to Web Development")
  const hasClarification = turnClassification.actions.some((a) => a.type === 'REQUEST_CLARIFICATION');
  if (hasClarification) {
    let clarMsg: string;
    if (clarAction?.payload?.diagnostic) {
      clarMsg = renderDiagnosticMessage(clarAction.payload.diagnostic);
    } else {
      clarMsg = clarAction?.payload?.message || 'What detail would you like to update for the deal?';
    }
    const combinedMsg = actionPrefixes.length > 0
      ? (clarAction?.payload?.kind === 'SUPERSEDED_CONFIRMATION'
          ? `${clarMsg} ${actionPrefixes.join(' ').trim()}`
          : `${actionPrefixes.join(' ').trim()} ${clarMsg}`)
      : clarMsg;

    const hasMutations = turnClassification.actions.some(
      (a) =>
        a.type.startsWith('SET_') ||
        a.type.startsWith('CLEAR_') ||
        a.type.endsWith('_SCOPE') ||
        a.type === 'REPLACE_SCOPE_ITEM' ||
        a.type === 'SELECT_FREELANCER'
    );
    const returnIntent = hasMutations ? (intent === 'SELECT_FREELANCER' ? 'SELECT_FREELANCER' : 'MODIFY_TERMS') : 'GENERAL_QUESTION';

    return {
      message: combinedMsg,
      intent: returnIntent,
      negotiationState: contextState,
      attachment,
      pendingClarification,
      resolvedActions,
    };
  }

  // Fast Path: Contextless Affirmative Response (Fresh chat with no prior assistant exchange or pending context)
  const hasPriorAssistantMsg = historyBeforeCurrentTurn.some((m) => m && (m.role === 'ai' || m.role === 'assistant'));
  const isContextlessAffirmative =
    !hasPriorAssistantMsg &&
    CONFIRM_AFFIRMATIVE_REGEX.test(cleanPrompt) &&
    turnClassification.actions.length === 0 &&
    actionPrefixes.length === 0;

  if (isContextlessAffirmative) {
    return {
      message: "I'm ready to help. Tell me what you'd like to work on.",
      intent: 'GENERAL_CONVERSATION',
      negotiationState: contextState,
      pendingClarification: null,
      resolvedActions: [],
    };
  }

  // Fast Path 1b: Deterministic command response when draft is INACTIVE
  if (contextState.draftStatus === 'INACTIVE' && actionPrefixes.length > 0 && intent === 'MODIFY_TERMS' && !turnClassification.informationalRequests.includes('GENERAL')) {
    const compositeParts = [
      ...infoPrefixes,
      ...actionPrefixes,
    ];
    const responseMsg = compositeParts.join(' ').trim();
    if (responseMsg) {
      contextState.pendingAction = 'DRAFT_DEAL';
      return {
        message: responseMsg,
        intent: 'MODIFY_TERMS',
        negotiationState: contextState,
        pendingClarification,
        resolvedActions,
      };
    }
  }

  // Fast Path: Pure Missing Terms / Readiness Informational Queries
  if ((turnClassification.informationalRequests.includes('MISSING_TERMS') || turnClassification.informationalRequests.includes('CHECK_READINESS')) && infoPrefixes.length > 0) {
    return {
      message: infoPrefixes.join(' ').trim(),
      intent: 'GENERAL_QUESTION',
      negotiationState: contextState,
      attachment,
      pendingClarification: null,
      resolvedActions,
    };
  }

  // Fast Path 2: Deterministic draft activation
  if (hasActivateAction) {
    const nextMissing = getNextMissingDraftTerm(contextState);
    let actMsg = "The deal draft is active again.";
    if (nextMissing === 'title') {
      actMsg = "The deal draft is active again. What is the title or main service for this deal?";
    } else if (nextMissing === 'seller') {
      actMsg = "The deal draft is active again. I need the freelancer's Synq handle or wallet address to draft the deal.";
    } else if (nextMissing === 'scope') {
      actMsg = "The deal draft is active again. What should the scope include?";
    } else if (nextMissing === 'paymentStructure') {
      actMsg = "The deal draft is active again. How should payment be released: Single Release, 50/50 Milestones, or Custom Milestones?";
    } else if (nextMissing === null) {
      actMsg = "The deal draft is active again. All deal terms are set and ready to create.";
    }

    return {
      message: actMsg,
      intent: 'START_DEAL',
      negotiationState: contextState,
      attachment,
    };
  }

  // Fast Path 3: Deterministic handle resolution error paths
  if (intent === 'SELECT_FREELANCER' || turnClassification.actions.some((a) => a.type === 'SELECT_FREELANCER')) {
    if (contextState.handleResolutionStatus === 'NOT_FREELANCER' && contextState.unresolvedHandle) {
      const msg = contextState.unresolvedHandle.startsWith('@')
        ? `${contextState.unresolvedHandle} is registered on Synq, but is not registered as a freelancer on Deal Port.`
        : 'That wallet is not registered as a freelancer on Deal Port.';
      return {
        message: msg,
        intent: 'SELECT_FREELANCER',
        negotiationState: contextState,
        attachment,
        pendingClarification: null,
        resolvedActions,
      };
    }
    if (contextState.handleResolutionStatus === 'NOT_FOUND' && contextState.unresolvedHandle) {
      return {
        message: `I couldn't find a Synq user with the handle ${contextState.unresolvedHandle}. Check the handle or choose a freelancer from Deal Port.`,
        intent: 'SELECT_FREELANCER',
        negotiationState: contextState,
        attachment,
        pendingClarification: null,
        resolvedActions,
      };
    }
    if (contextState.handleResolutionStatus === 'READ_ERROR' && contextState.unresolvedHandle) {
      const msg = contextState.unresolvedHandle.startsWith('@')
        ? `I couldn't verify ${contextState.unresolvedHandle} right now. Please try again.`
        : "I couldn't verify that wallet right now. Please try again.";
      return {
        message: msg,
        intent: 'SELECT_FREELANCER',
        negotiationState: contextState,
        attachment,
        pendingClarification: null,
        resolvedActions,
      };
    }
  }

  // Branch 1: Freelancer Discovery (Draft remains INACTIVE or current ACTIVE state preserved)
  if (intent === 'FIND_FREELANCER' || isSellerSearch) {
    const handleMatch = cleanPrompt.match(/@([a-zA-Z0-9_]{3,32})\b/);
    if (handleMatch) {
      const rawHandle = handleMatch[1];
      const res = await resolveHandleToWallet(rawHandle);

      if (res.status === 'RESOLVED') {
        let exactSeller: AiNegotiatorSellerResult = {
          wallet: res.wallet,
          name: res.name,
          category: 'Web Development',
          skills: [],
          rate: '0',
          bio: '',
          available: true,
          completedDeals: 0,
          match: 99,
        };

        try {
          const found = await findSellers(cleanPrompt);
          if (Array.isArray(found?.sellers)) {
            const matchedInFound = found.sellers.find(
              (s: any) => s.wallet.toLowerCase() === res.wallet.toLowerCase()
            );
            if (matchedInFound) {
              exactSeller = matchedInFound;
            }
          }
        } catch { /* fallback to exactSeller */ }

        const sellers = [exactSeller];
        const message = `I found freelancer ${res.name} (@${res.handle}) in Deal Port.`;
        const exactAttachment: AiNegotiatorAttachment = { type: 'freelancers', sellers };

        return {
          message,
          sellers,
          intent: 'FIND_FREELANCER',
          negotiationState: contextState,
          attachment: exactAttachment,
        };
      } else if (res.status === 'NOT_FREELANCER') {
        return {
          message: `@${rawHandle} is registered on Synq, but is not registered as a freelancer on Deal Port.`,
          sellers: undefined,
          intent: 'FIND_FREELANCER',
          negotiationState: contextState,
        };
      } else {
        return {
          message: `I couldn't find a freelancer with the handle @${rawHandle} in Deal Port.`,
          sellers: undefined,
          intent: 'FIND_FREELANCER',
          negotiationState: contextState,
        };
      }
    }

    const searchTerms = [
      contextState.title.value,
      contextState.scope.value,
      cleanPrompt,
    ].filter(Boolean).join(' ');

    const found = await findSellers(searchTerms || cleanPrompt);
    let rawSellers: AiNegotiatorSellerResult[] = Array.isArray(found?.sellers) ? found.sellers : [];

    // Exclude current seller if user used replacement/discovery language ("another", "different", "alternative")
    const isReplacementSearch = /\b(?:another|different|alternative)\b/i.test(cleanPrompt);
    if (isReplacementSearch && contextState.seller?.value && contextState.seller.status === 'CONFIRMED') {
      const currentSellerWallet = contextState.seller.value.toLowerCase();
      rawSellers = rawSellers.filter((s) => (s.wallet || '').toLowerCase() !== currentSellerWallet);
    }

    const sellers = rawSellers.slice(0, 3);

    let messagePrefix = '';
    if (actionPrefixes.length > 0) {
      messagePrefix = `${actionPrefixes.join(' ').trim()} `;
    }

    const searchMsg = typeof found?.message === 'string' && found.message
      ? found.message
      : sellers.length > 0
      ? `I found ${sellers.length} matching ${sellers.length === 1 ? 'freelancer' : 'freelancers'} in Deal Port based on the current deal requirements.`
      : 'I could not find matching freelancers for that request. Provide a skill or service description.';

    const message = `${messagePrefix}${searchMsg}`.trim();

    const searchAttachment: AiNegotiatorAttachment | undefined = sellers.length > 0
      ? { type: 'freelancers', sellers }
      : undefined;

    return {
      message,
      sellers: sellers.length > 0 ? sellers : undefined,
      intent: 'FIND_FREELANCER',
      negotiationState: contextState,
      attachment: searchAttachment,
      rawResult: found,
    };
  }

  // Fast Path 4: Pure deterministic term mutation response
  const hasPureDeterministicMutation = turnClassification.actions.some(
    (a) =>
      a.type.startsWith('SET_') ||
      a.type.startsWith('CLEAR_') ||
      a.type.endsWith('_SCOPE') ||
      a.type === 'REPLACE_SCOPE_ITEM' ||
      a.type === 'UNSUPPORTED_ASSET' ||
      a.type === 'AMBIGUOUS_ASSET' ||
      a.type === 'MISSING_ASSET' ||
      (a.type === 'SELECT_FREELANCER' && contextState.handleResolutionStatus === 'RESOLVED' && contextState.draftStatus === 'ACTIVE')
  );

  const hasGeneralIntelligenceRequest = turnClassification.informationalRequests.includes('GENERAL');
  const responseLane: DealIntelligenceResponseLane =
    hasPureDeterministicMutation && hasGeneralIntelligenceRequest
      ? 'MIXED_READ_ONLY_INTELLIGENCE'
      : hasGeneralIntelligenceRequest
      ? 'READ_ONLY_INTELLIGENCE'
      : 'DETERMINISTIC_ONLY';

  const deterministicMutationConfirmation = renderDeterministicMutationConfirmation(
    contextState,
    actionPrefixes,
    infoPrefixes
  );

  if (responseLane === 'DETERMINISTIC_ONLY' && hasPureDeterministicMutation) {
    if (deterministicMutationConfirmation) {
      return {
        message: deterministicMutationConfirmation,
        intent: intent === 'SELECT_FREELANCER' ? 'SELECT_FREELANCER' : 'MODIFY_TERMS',
        negotiationState: contextState,
        attachment,
        pendingClarification: null,
        resolvedActions,
      };
    }
  }

  // Branch 2: Grounded Freelancer Selection while INACTIVE (Stage 2)
  if (intent === 'SELECT_FREELANCER' && contextState.draftStatus === 'INACTIVE') {
    if (contextState.seller.status === 'CONFIRMED') {
      contextState.pendingAction = 'DRAFT_DEAL';
      const sName = contextState.sellerName || 'The freelancer';
      const selectMsg = actionPrefixes.length > 0
        ? actionPrefixes.join(' ').trim()
        : `Freelancer selected: ${sName}.`;

      return {
        message: selectMsg,
        intent: 'SELECT_FREELANCER',
        negotiationState: contextState,
        attachment: undefined,
        pendingClarification: null,
        resolvedActions,
      };
    }
  }

  // Branch: Pure Inactive "Why is my draft inactive?" or Informational Questions
  if (turnClassification.informationalRequests.includes('WHY_INACTIVE') && !hasActivateAction && contextState.draftStatus === 'INACTIVE') {
    const whyMsg = infoPrefixes.length > 0 ? infoPrefixes.join(' ') : 'The deal draft is currently inactive.';
    return {
      message: whyMsg,
      intent: 'GENERAL_QUESTION',
      negotiationState: contextState,
    };
  }

  // Deterministic Grounded Question Answers for Active / Structured Contexts
  if (intent === 'GENERAL_QUESTION' && contextState.draftStatus === 'ACTIVE') {
    // 1. Scope question
    if (/(?:what|tell me|show me).*?\b(?:scope|deliverables)\b/i.test(cleanPrompt) && !/mean|explain/i.test(cleanPrompt)) {
      const sVal = contextState.scope.value || 'not specified yet';
      return {
        message: `The current scope is ${sVal}`,
        intent: 'GENERAL_QUESTION',
        negotiationState: contextState,
        attachment,
      };
    }

    // 2. Budget question
    if (/(?:what|how much|tell me).*?\b(?:budget|amount|price|cost)\b/i.test(cleanPrompt) && !/mean|explain/i.test(cleanPrompt)) {
      const bVal = contextState.amount.value ? `${contextState.amount.value.amount} ${contextState.amount.value.asset}` : 'not specified yet';
      return {
        message: `The current budget is ${bVal}.`,
        intent: 'GENERAL_QUESTION',
        negotiationState: contextState,
        attachment,
      };
    }

    // 3. Freelancer question
    if (/(?:who|tell me).*?\b(?:freelancer|seller|counterparty)\b/i.test(cleanPrompt)) {
      const sName = contextState.sellerName || (contextState.seller.value ? contextState.seller.value : 'not specified yet');
      return {
        message: `The selected freelancer is ${sName}.`,
        intent: 'GENERAL_QUESTION',
        negotiationState: contextState,
        attachment,
      };
    }

    // 4. Current deadline-state question
    const isCurrentDeadlineStateQuestion =
      /^(?:what|show\s+me|tell\s+me)\b/i.test(cleanPrompt) &&
      /\b(?:deadline|timeline)\b/i.test(cleanPrompt) &&
      (/\b(?:current|currently)\b/i.test(cleanPrompt) ||
        /\b(?:deadline|timeline)\s+(?:is\s+)?(?:currently\s+)?set\b/i.test(cleanPrompt) ||
        /\b(?:deadline|timeline)\s+(?:are\s+)?we\s+(?:currently\s+)?using\b/i.test(cleanPrompt) ||
        /\b(?:deadline|timeline)\s+set\s+to\b/i.test(cleanPrompt));

    if (isCurrentDeadlineStateQuestion) {
      const dVal = contextState.deadline.value?.raw || 'not specified yet';
      return {
        message: `The current deadline is ${dVal}.`,
        intent: 'GENERAL_QUESTION',
        negotiationState: contextState,
        attachment,
      };
    }

    // 5. Current payment-structure question
    const isCurrentPaymentStateQuestion =
      /^(?:what|which|show\s+me|tell\s+me)\b/i.test(cleanPrompt) &&
      /\bpayment\s+(?:structure|setup|configuration)\b/i.test(cleanPrompt) &&
      /\b(?:current|currently|selected|chosen|using|right\s+now)\b|\bpayment\s+setup\b/i.test(cleanPrompt);

    if (isCurrentPaymentStateQuestion) {
      const pVal = contextState.paymentStructure.value;
      const pLabel = pVal === '50-50' ? '50/50 Milestones' : pVal === 'single' ? 'Single Release' : pVal === 'custom' ? 'Custom Milestones' : 'not specified yet';

      return {
        message: `The deal is currently using ${pLabel}.`,
        intent: 'GENERAL_QUESTION',
        negotiationState: contextState,
        attachment,
      };
    }
  }

  // Branch 3: Deterministic Active Draft Questioning & Completion Flow
  if (contextState.draftStatus === 'ACTIVE' && intent !== 'GENERAL_QUESTION' && intent !== 'CANCEL_DRAFT' && responseLane !== 'MIXED_READ_ONLY_INTELLIGENCE') {
    const nextMissing = getNextMissingDraftTerm(contextState);

    if (nextMissing === 'seller') {
      let promptMsg = "I need the freelancer's Synq handle or wallet address to draft the deal. You can also ask me to find freelancers on Deal Port.";

      if (contextState.handleResolutionStatus === 'READ_ERROR' && contextState.unresolvedHandle) {
        promptMsg = `I couldn't verify ${contextState.unresolvedHandle} right now. Please try again, or provide the freelancer's wallet address.`;
      } else if (contextState.unresolvedHandle) {
        promptMsg = `${contextState.unresolvedHandle} could not be found in Synq. Please check the handle or provide the freelancer's wallet address.`;
      } else if (contextState.sellerAmbiguous && contextState.ambiguousName) {
        promptMsg = `Multiple freelancers named '${contextState.ambiguousName}' were found in your search results. Please specify which one by handle (e.g. @handle) or position (e.g. the first one).`;
      } else if (contextState.candidateSellerName) {
        promptMsg = `I need ${contextState.candidateSellerName}'s Synq handle or wallet address to identify the correct freelancer. You can also ask me to find them on Deal Port.`;
      }

      return {
        message: promptMsg,
        intent: 'MODIFY_TERMS',
        negotiationState: contextState,
        attachment,
      };
    } else if (nextMissing === 'title') {
      const promptMsg = "The deal draft is started. What is the title or main service for this deal?";
      return {
        message: promptMsg,
        intent: 'MODIFY_TERMS',
        negotiationState: contextState,
        attachment,
      };
    } else if (nextMissing === 'scope') {
      const tName = contextState.title.value || 'landing page';
      const promptMsg = `The deal draft is started. What should the ${tName.toLowerCase()} include?`;

      const userMessages = input.messages.slice(-8).map(m => ({
        role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.content,
      }));

      const rawCompletion = await getNegotiatorAICompletion(systemPromptForActive(contextState, 'SCOPE'), userMessages);
      let resMsg = promptMsg;
      if (rawCompletion) {
        try {
          const parsed = JSON.parse(rawCompletion);
          if (typeof parsed?.message === 'string' && parsed.message.trim() && !/draft complete|all terms confirmed/i.test(parsed.message)) {
            resMsg = parsed.message.trim();
          }
        } catch { /* use promptMsg */ }
      }

      return {
        message: resMsg,
        intent: 'MODIFY_TERMS',
        negotiationState: contextState,
        attachment,
      };
    } else if (nextMissing === 'paymentStructure') {
      const promptMsg = "The scope is set. How should payment be released: Single Release, 50/50 Milestones, or Custom Milestones?";

      const userMessages = input.messages.slice(-8).map(m => ({
        role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.content,
      }));

      const rawCompletion = await getNegotiatorAICompletion(systemPromptForActive(contextState, 'PAYMENTSTRUCTURE'), userMessages);
      let resMsg = promptMsg;
      if (rawCompletion) {
        try {
          const parsed = JSON.parse(rawCompletion);
          if (typeof parsed?.message === 'string' && parsed.message.trim() && !/draft complete|all terms confirmed/i.test(parsed.message)) {
            resMsg = parsed.message.trim();
          }
        } catch { /* use promptMsg */ }
      }

      return {
        message: resMsg,
        intent: 'MODIFY_TERMS',
        negotiationState: contextState,
        attachment,
      };
    } else if (nextMissing === null) {
      const pVal = contextState.paymentStructure.value;
      const pLabel = pVal === '50-50' ? '50/50 Milestones' : pVal === 'single' ? 'Single Release' : 'Custom Milestones';

      let compositeParts: string[] = [];
      if (infoPrefixes.length > 0) compositeParts.push(...infoPrefixes);
      if (actionPrefixes.length > 0) compositeParts.push(...actionPrefixes);
      const compositePrefix = compositeParts.join(' ').trim();

      let promptMsg = compositePrefix;
      if (!promptMsg) {
        promptMsg = `Payment is set to ${pLabel}. The deal draft is complete.`;
      } else if (!/complete/i.test(promptMsg) && previousState?.isReadyToCreate) {
        promptMsg = `${promptMsg} The deal draft is still complete.`;
      }

      if (previousState?.isReadyToCreate && !compositePrefix) {
        if (/(?:budget|amount|price|cost|eth|usdc)/i.test(cleanPrompt) && contextState.amount.value) {
          promptMsg = `Budget is already ${contextState.amount.value.amount} ${contextState.amount.value.asset}. The deal draft is still complete.`;
        } else if (/(?:deadline|time|days?|weeks?)/i.test(cleanPrompt) && contextState.deadline.value?.raw) {
          promptMsg = `Deadline is already ${contextState.deadline.value.raw}. The deal draft is still complete.`;
        } else if (/(?:scope|deliverable)/i.test(cleanPrompt)) {
          promptMsg = `Scope is already set. The deal draft is still complete.`;
        } else if (/(?:payment|milestone|release)/i.test(cleanPrompt)) {
          promptMsg = `Payment is already set to ${pLabel}. The deal draft is still complete.`;
        } else if (/(?:seller|freelancer|handle|wallet)/i.test(cleanPrompt)) {
          promptMsg = `Freelancer is already set. The deal draft is still complete.`;
        } else {
          promptMsg = `The deal draft is complete.`;
        }
      }

      return {
        message: promptMsg,
        intent: 'CONFIRM_TERMS',
        negotiationState: contextState,
        attachment,
      };
    }
  }

  // Branch 4: Grounded Deal Consultant + Draft Analyzer AI Negotiation
  // R1: Deterministic Product Fact Sub-Mode
  // Closed-world verified product capability questions are answered directly from typed knowledge
  // without an LLM call, guaranteeing zero synthesized workarounds or unsupported remedies.
  const matchedCapabilities = resolveProductCapabilities(cleanPrompt);
  if (matchedCapabilities.length > 0) {
    const factAnswer = composeProductFactResponse(matchedCapabilities);
    const finalFactMessage =
      responseLane === 'MIXED_READ_ONLY_INTELLIGENCE' && deterministicMutationConfirmation
        ? `${deterministicMutationConfirmation}\n\n${factAnswer}`
        : factAnswer;

    return {
      message: finalFactMessage,
      intent: 'GENERAL_QUESTION',
      negotiationState: contextState,
      attachment,
      pendingClarification,
      resolvedActions,
    };
  }

  // R1.5: Deterministic Live-Data Boundary
  // Questions requiring current wallet, deal, escrow, freelancer, or swap state are recognized
  // deterministically and answered with a grounded boundary response. No provider call, no fake
  // values, no guessing. The boundary composes naturally with deterministic mutation confirmations.
  // When live-data retrieval is implemented, this boundary response is replaced with actual data.
  const liveDataCategories = detectLiveDataRequirements(cleanPrompt);
  if (liveDataCategories.length > 0) {
    const liveDataBoundary = composeLiveDataBoundaryResponse(liveDataCategories, cleanPrompt);
    const finalLiveDataMessage =
      responseLane === 'MIXED_READ_ONLY_INTELLIGENCE' && deterministicMutationConfirmation
        ? `${deterministicMutationConfirmation}\n\n${liveDataBoundary}`
        : liveDataBoundary;

    return {
      message: finalLiveDataMessage,
      intent: 'GENERAL_QUESTION',
      negotiationState: contextState,
      attachment,
      pendingClarification,
      resolvedActions,
    };
  }

  // R2: Grounded Bounded Consultation Sub-Mode (Payment Structure Selection)
  // Consultative question in supported R2 domain -> 1 provider call returning strict structured semantic enums only ->
  // Server deterministically renders final answer. Model-generated free-form prose is NEVER produced or rendered.
  if (detectPaymentConsultation(cleanPrompt)) {
    const consultationPrompt = buildPaymentConsultationPrompt({
      scope: contextState.scope.value || undefined,
      scopeItems: contextState.scopeItems || undefined,
    });

    const decision = await getPaymentConsultationDecision(consultationPrompt, cleanPrompt);

    if (decision) {
      const renderedConsultation = renderPaymentConsultationResponse(decision);
      const finalConsultationMessage =
        responseLane === 'MIXED_READ_ONLY_INTELLIGENCE' && deterministicMutationConfirmation
          ? `${deterministicMutationConfirmation}\n\n${renderedConsultation}`
          : renderedConsultation;

      return {
        message: finalConsultationMessage,
        intent: 'GENERAL_QUESTION',
        negotiationState: contextState, // NOTE: paymentStructure is NOT mutated by recommendation
        attachment,
        pendingClarification,
        resolvedActions,
      };
    }

    // Provider unavailable or invalid structured output fallback
    console.warn('[Negotiator Branch 4] r2_payment_consultation_unavailable');
    const fallbackConsultation = "I couldn't evaluate the payment structure options right now. Please try that part again.";
    const finalFallbackMessage =
      responseLane === 'MIXED_READ_ONLY_INTELLIGENCE' && deterministicMutationConfirmation
        ? `${deterministicMutationConfirmation}\n\n${fallbackConsultation}`
        : fallbackConsultation;

    return {
      message: finalFallbackMessage,
      intent: 'GENERAL_QUESTION',
      negotiationState: contextState,
      attachment,
      pendingClarification,
      resolvedActions,
    };
  }

  // Bounded Deadline Feasibility Advisor
  // Uses post-mutation canonical state and returns only deterministic user-facing prose.
  if (detectDeadlineFeasibility(cleanPrompt)) {
    const deadline = contextState.deadline?.value?.raw || null;
    const scopeText = contextState.scope?.value?.trim() || '';
    const scopeItemsForDeadline = (contextState.scopeItems || []).filter((item) => item.trim().length > 0);
    const hasScope = Boolean(scopeText || scopeItemsForDeadline.length > 0);
    const scopeIsPlaceholder = Boolean(
      scopeItemsForDeadline.length === 0 && scopeText && isVagueScopePlaceholder(scopeText)
    );
    const composeDeadlineResponse = (message: string) =>
      responseLane === 'MIXED_READ_ONLY_INTELLIGENCE' && deterministicMutationConfirmation
        ? `${deterministicMutationConfirmation}\n\n${message}`
        : message;

    if (!deadline) {
      return {
        message: composeDeadlineResponse('There is no deadline set to assess yet. What timeframe are you considering?'),
        intent: 'GENERAL_QUESTION',
        negotiationState: contextState,
        attachment,
        pendingClarification,
        resolvedActions,
      };
    }

    if (!hasScope || scopeIsPlaceholder) {
      return {
        message: composeDeadlineResponse(`I can't assess ${deadline} against the current scope yet because the work is not specific enough. What concrete deliverables should be completed?`),
        intent: 'GENERAL_QUESTION',
        negotiationState: contextState,
        attachment,
        pendingClarification,
        resolvedActions,
      };
    }

    if (/\bwhat\s+(?:deadline|timeline|timeframe)\s+should\s+i\s+set\b/i.test(cleanPrompt)) {
      return {
        message: composeDeadlineResponse(`I can't responsibly invent a replacement duration from the current draft. Use the listed deliverables, known dependencies, and review or handoff expectations to agree on a planning target; Synq deadlines are informational and do not guarantee completion.`),
        intent: 'GENERAL_QUESTION',
        negotiationState: contextState,
        attachment,
        pendingClarification,
        resolvedActions,
      };
    }

    if (/\bguarantee\b/i.test(cleanPrompt)) {
      return {
        message: composeDeadlineResponse(`I can't guarantee completion by ${deadline}. I can only assess it as an informational planning target against the canonical scope; actual completion still depends on the parties and execution details.`),
        intent: 'GENERAL_QUESTION',
        negotiationState: contextState,
        attachment,
        pendingClarification,
        resolvedActions,
      };
    }

    const hasDeadlineMutationThisTurn = resolvedActions.some((action) => action.type === 'SET_DEADLINE');
    const containsExplicitDuration = /\b\d+\s*(?:calendar\s+)?(?:days?|weeks?|months?)\b/i.test(cleanPrompt);
    if (containsExplicitDuration && !hasDeadlineMutationThisTurn) {
      return {
        message: composeDeadlineResponse(`The draft deadline remains ${deadline}. I haven't treated the timeframe in your question as a draft change. Should I assess the current deadline, or update it first?`),
        intent: 'GENERAL_QUESTION',
        negotiationState: contextState,
        attachment,
        pendingClarification,
        resolvedActions,
      };
    }

    const deadlinePrompt = buildDeadlineFeasibilityPrompt({
      title: contextState.title?.value,
      scope: contextState.scope?.value,
      scopeItems: contextState.scopeItems,
      deadline,
      budget: contextState.amount?.value,
      paymentStructure: contextState.paymentStructure?.value,
    });
    const intelligencePrompt =
      responseLane === 'MIXED_READ_ONLY_INTELLIGENCE' && turnClassification.informationalClauses.length > 0
        ? turnClassification.informationalClauses.join('. ')
        : cleanPrompt;
    const deadlineDecision = await getDeadlineFeasibilityDecision(deadlinePrompt, intelligencePrompt);

    if (deadlineDecision) {
      return {
        message: composeDeadlineResponse(renderDeadlineFeasibilityResponse(deadlineDecision, {
          deadline,
          scope: contextState.scope?.value,
          scopeItems: contextState.scopeItems,
        })),
        intent: 'GENERAL_QUESTION',
        negotiationState: contextState,
        attachment,
        pendingClarification,
        resolvedActions,
      };
    }

    console.warn('[Negotiator Branch 4] deadline_feasibility_unavailable');
    const fallback = `I couldn't complete the qualitative timeline assessment right now. The current deadline remains set to ${deadline} and has not been changed. Review that target against the listed deliverables, dependencies, and review expectations before relying on it.`;
    return {
      message: composeDeadlineResponse(fallback),
      intent: 'GENERAL_QUESTION',
      negotiationState: contextState,
      attachment,
      pendingClarification,
      resolvedActions,
    };
  }

  // R4: Grounded Bounded Current-Draft Deal Analyzer Sub-Mode
  // Explicit current-draft review/risk analysis question ->
  // If no usable scope text: 0 provider calls -> natural deterministic scope prompt.
  // If usable scope text: 1 provider call -> strict semantic classification only ->
  // Server deterministically renders final response. Model-generated free-form prose is NEVER produced.
  if (detectDealAnalyzer(cleanPrompt)) {
    const hasScope = Boolean(
      contextState.scope?.value?.trim() ||
      (contextState.scopeItems && contextState.scopeItems.length > 0)
    );

    if (!hasScope) {
      const emptyScopeMsg =
        "I can review the draft, but there isn't enough scope detail yet for a useful scope analysis. What work or deliverables are you planning?";
      const finalEmptyScopeMessage =
        responseLane === 'MIXED_READ_ONLY_INTELLIGENCE' && deterministicMutationConfirmation
          ? `${deterministicMutationConfirmation}\n\n${emptyScopeMsg}`
          : emptyScopeMsg;

      return {
        message: finalEmptyScopeMessage,
        intent: 'GENERAL_QUESTION',
        negotiationState: contextState,
        attachment,
        pendingClarification,
        resolvedActions,
      };
    }

    const analyzerPrompt = buildDealAnalyzerPrompt({
      scope: contextState.scope?.value || undefined,
      scopeItems: contextState.scopeItems || undefined,
    });

    const decision = await getDealAnalyzerDecision(analyzerPrompt, cleanPrompt);

    if (decision) {
      const renderedAnalysis = renderDealAnalyzerResponse(decision, {
        title: contextState.title?.value,
        seller: contextState.seller?.value,
        sellerName: contextState.sellerName,
        amount: contextState.amount?.value,
        deadline: contextState.deadline?.value,
        paymentStructure: contextState.paymentStructure?.value,
        scope: contextState.scope?.value,
        scopeItems: contextState.scopeItems,
      });

      const finalAnalysisMessage =
        responseLane === 'MIXED_READ_ONLY_INTELLIGENCE' && deterministicMutationConfirmation
          ? `${deterministicMutationConfirmation}\n\n${renderedAnalysis}`
          : renderedAnalysis;

      return {
        message: finalAnalysisMessage,
        intent: 'GENERAL_QUESTION',
        negotiationState: contextState,
        attachment,
        pendingClarification,
        resolvedActions,
      };
    }

    // Provider unavailable or invalid structured output fallback
    console.warn('[Negotiator Branch 4] r4_deal_analyzer_unavailable');
    const scopeCountForFallback = contextState.scopeItems?.length || 0;
    const budgetFallbackStr = contextState.amount?.value
      ? ` and a ${contextState.amount.value.amount} ${contextState.amount.value.asset} budget`
      : '';
    const fallbackAnalyzer =
      `I can see the current draft has ${scopeCountForFallback} deliverable${scopeCountForFallback === 1 ? '' : 's'}${budgetFallbackStr}, but I couldn't complete the qualitative scope review right now. You can still review the expected outputs, boundaries, handoff, and review expectations for each deliverable.\n\n` +
      `In Synq, deals deploy with zero initial milestones; specific milestone amounts and dates are configured post-creation in the Deal Workspace. Escrow is funded by the buyer in one full deposit, and deadlines serve as informational targets.`;

    const finalFallbackMessage =
      responseLane === 'MIXED_READ_ONLY_INTELLIGENCE' && deterministicMutationConfirmation
        ? `${deterministicMutationConfirmation}\n\n${fallbackAnalyzer}`
        : fallbackAnalyzer;

    return {
      message: finalFallbackMessage,
      intent: 'GENERAL_QUESTION',
      negotiationState: contextState,
      attachment,
      pendingClarification,
      resolvedActions,
    };
  }

  const scopeItems = contextState.scopeItems || [];
  const scopeCount = scopeItems.length;

  const resolvedActionsSummary = resolvedActions.length > 0
    ? resolvedActions.map((a) => {
        if (a.type === 'SET_AMOUNT') return `Set budget to ${a.value} ${a.asset || ''}`.trim();
        if (a.type === 'CLEAR_AMOUNT') return 'Cleared budget';
        if (a.type === 'SET_DEADLINE') return `Set deadline to ${a.value}`;
        if (a.type === 'CLEAR_DEADLINE') return 'Cleared deadline';
        if (a.type === 'SET_TITLE') return `Set title to "${a.value}"`;
        if (a.type === 'CLEAR_TITLE') return 'Cleared title';
        if (a.type === 'SET_PAYMENT_STRUCTURE') return `Set payment structure to ${a.value}`;
        if (a.type === 'CLEAR_PAYMENT_STRUCTURE') return 'Cleared payment structure';
        if (a.type === 'SELECT_FREELANCER') return `Selected freelancer ${contextState.sellerName ? `${contextState.sellerName} (${a.value})` : a.value}`;
        if (a.type === 'CLEAR_SELLER') return 'Cleared freelancer';
        if (a.type === 'ADD_SCOPE') return `Added scope deliverable(s): ${a.targetItem || (a.items ? a.items.join(', ') : 'deliverables')}`;
        if (a.type === 'REMOVE_SCOPE') return `Removed scope deliverable: ${a.targetItem || 'item'}`;
        if (a.type === 'REPLACE_SCOPE_ITEM') return `Replaced scope item with: ${a.replacementItem}`;
        if (a.type === 'CLEAR_SCOPE') return 'Cleared entire scope';
        return a.type;
      }).join('; ')
    : 'None';

  const actionConfirmationsSummary = deterministicMutationConfirmation
    ? deterministicMutationConfirmation
    : actionPrefixes.length > 0
    ? actionPrefixes.join(' ').trim()
    : 'None';

  const synqKnowledgeContext = getSynqKnowledgeContext();

  const formattedState = `
CANONICAL DRAFT (AUTHORITATIVE FACTS):
- Title: ${contextState.title.value ? `"${contextState.title.value}"` : 'Not specified'}
- Freelancer: ${contextState.sellerName ? `${contextState.sellerName} (${contextState.seller.value || 'No address'})` : contextState.seller.value || 'Not specified'}
- Budget: ${contextState.amount.value ? `${contextState.amount.value.amount} ${contextState.amount.value.asset}` : 'Not specified'}
- Deadline: ${contextState.deadline.value?.raw || 'Not specified'}
- Payment Structure: ${contextState.paymentStructure.value || 'Not specified'}
- Scope: ${contextState.scope.value || 'Not specified'}
- Scope Items (${scopeCount} item${scopeCount === 1 ? '' : 's'}): ${scopeCount > 0 ? scopeItems.map((item, idx) => `[${idx + 1}] "${item}"`).join('; ') : 'None specified'}

CURRENT TURN MUTATIONS (ALREADY EXECUTED DETERMINISTICALLY):
- Resolved Actions This Turn: ${resolvedActionsSummary}
- Deterministic Confirmations Already Displayed: ${actionConfirmationsSummary}

AUTHORITATIVE SYNQ PRODUCT KNOWLEDGE:
------------------------------------
${synqKnowledgeContext}
`;

  const systemPrompt = `${formattedState}

You are Nexotiq AI, a deal negotiation assistant for Synq.
You operate as a grounded Deal Consultant, Draft Analyzer, and Synq Product Guide.
Your role is to advise on deal terms, evaluate clarity, analyze qualitative risks, and answer platform and workflow questions in natural, plain-text chat.

AUTHORITY DOMAINS & FACTUAL GROUNDING:
- DOMAIN A: CURRENT DRAFT FACTS (Supplied in Canonical Draft above)
  Canonical draft values, term statuses, and resolved deterministic mutations this turn. The Canonical Draft is a strictly closed world for this specific deal. You MUST NOT contradict or invent draft values.
- DOMAIN B: STATIC SYNQ PRODUCT FACTS (Supplied in Authoritative Synq Product Knowledge above)
  Platform identity, feature purposes, routes, Create Deal workflow, payment presets & execution reality, escrow rules, milestone lifecycle, disputes, identity/handles, reviews, reputation, Negotiator capabilities, ChatPay, Agent Controller, Swap, Adaptive Protection, network support, and known limitations. You may explain Synq product mechanics ONLY from this knowledge. Do not supplement from general Web3 assumptions.
- DOMAIN C: DYNAMIC / LIVE FACTS
  Current wallet/account, user profile, user deals, specific deal state, escrow balance, milestone progress, specific freelancer profile/availability, specific handle ownership, completed-deal counts, reviews, portfolio, token balances, and live swap quotes are DYNAMIC. Static knowledge does NOT establish them. If live data is not supplied in context, do NOT guess or invent it; explain naturally that current/live data is required.
- MODEL MAY REASON ABOUT:
  Deliverable clarity, scope depth, workload alignment, qualitative tradeoffs, and explaining Synq product behavior using the authoritative knowledge.

CORE BEHAVIOR RULES:

1. CANONICAL FACTUAL GROUNDING & KNOWLEDGE PRECEDENCE (CLOSED WORLD):
   - For describing this deal, the Canonical Draft is a strictly closed world. Anything not explicitly present in the draft is UNKNOWN.
   - For describing Synq platform and product mechanics, the Authoritative Synq Product Knowledge is a strictly closed world. Anything not established in the knowledge is UNKNOWN.
   - KNOWLEDGE PRECEDENCE & RECENT HISTORY AUTHORITY: For Synq product facts, AUTHORITATIVE SYNQ PRODUCT KNOWLEDGE strictly supersedes previous assistant messages, previous hallucinated product statements, generic model knowledge, or assumptions based on similar Web3 platforms. Recent conversation history provides conversational continuity only; previous ASSISTANT messages are NOT authoritative product knowledge. Never treat an earlier assistant claim about Synq mechanics as verified merely because it appears in history. If prior assistant prose conflicts with Verified Core, IGNORE the prior claim. If prior assistant prose introduces a Synq mechanic not established by Verified Core, do not repeat or build upon it. Canonical current Draft state strictly overrides historical draft descriptions, and deterministic current-turn mutations override older conversation state.
   - UNSUPPORTED WORKAROUND & REMEDY RULE: When Verified Core establishes that a product operation or capability is unavailable, state that limitation plainly. Do not recommend, suggest, or imply another action, feature, primitive, or workflow as a correction, replacement, recovery path, workaround, or remedy unless Verified Core explicitly establishes that specific action or workflow as a remedy for that specific limitation. A feature being supported in isolation does not make it a verified remedy for another unavailable operation. Explicitly verified alternatives and multi-step workflows remain valid and explainable.
   - Never state, imply, or assume that the deal includes tasks, deliverables, technologies, workflows, project durations, revision processes, integrations, acceptance requirements, freelancer history, market rates, or dependencies unless explicitly present in the Canonical Draft.
   - Do NOT fill missing details using typical freelance project templates or industry assumptions.

2. NO CONTRADICTION OF CANONICAL VALUES:
   - NEVER call a canonical field missing or unset when its supplied canonical value shows that it is set.
   - If Budget is 1 ETH, NEVER say budget is missing.
   - If Deadline is 5 days, NEVER say deadline or timeline is missing.
   - If Scope Items contains "Landing Page", NEVER say scope is missing or that there are no deliverables.
   - You MAY make qualitative observations (e.g., "The current scope only says 'Landing Page', so there isn't enough detail to judge the workload"), but you must NEVER claim the field itself is missing.

3. STOP READINESS REPORTING & NEVER INVENT "REQUIRED FIELDS":
   - You are NOT the authority for declaring form fields required, reporting contract readiness, or deciding whether a deal can be created. The deterministic engine handles form readiness and creation enablement separately.
   - NEVER make statements declaring or implying that the deal or draft is blocked, incomplete, or unable to proceed, such as:
     * "your draft is inactive" / "because the draft is still inactive"
     * "your deal is not ready" / "the deal is not ready to be created"
     * "this field is required" / "mandatory field" / "creation requirement"
     * "you cannot create the deal" / "the deal cannot be created"
     * "Synq will not let you proceed" / "Synq will not let you proceed to Deal Workspace until..."
     * "you must populate these fields first"
   - In particular, NEVER describe acceptance criteria, revisions, testing, integrations, scope details, deliverable format, milestones, timeline breakdown, or project background as required fields or platform prerequisites. They may be useful qualitative planning context, but they are NEVER canonical required fields or creation blockers.
   - Do NOT turn analysis into a form-readiness checklist. Do NOT dump lists of unset deal terms (such as title, freelancer, payment structure) unless explicitly asked.

4. CONTEXT-FIRST ANALYZER (ASK FOR DEAL CONTEXT, NOT FORM COMPLETION):
   - When asked to analyze, review, assess risks, or evaluate the deal:
   - Base your analysis ONLY on risks and tradeoffs supported by:
     A. Canonical Draft facts
     B. AUTHORITATIVE SYNQ PRODUCT KNOWLEDGE
   - Clearly distinguish qualitative planning guidance from enforced Synq platform behavior.
   - Never invent technical consequences or platform barriers simply because a planning detail is absent.
   - Never turn qualitative best practices into platform requirements, contract enforcement, lifecycle gating, automatic deadline behavior, revision-policy enforcement, acceptance-criteria enforcement, or Protection behavior.
   - MILESTONE PRE-CREATE BOUNDARY: A Negotiator / Create Deal draft having no on-chain milestones is normal execution behavior (new deals deploy with zero milestones; milestones are added post-creation in Deal Workspace). Never treat "no milestones defined" or "no configured milestones" as a missing Negotiator draft field or a blocker before creating the deal. You may discuss milestone planning when relevant, but never frame absent milestones as a pre-create defect.
   - ADAPTIVE PROTECTION BOUNDARY: Adaptive Protection is disabled / Coming Soon for new deals. You may state that it is unavailable when relevant, but do NOT invent what protection it would provide, do NOT describe it as an "extra safety net", and do NOT compare hypothetical protection behavior with other platforms unless authoritative knowledge explicitly establishes that behavior.
   - If the canonical terms are too thin to support useful analysis (e.g., only "Landing Page" is given):
     1. Briefly acknowledge the actual context that IS known (e.g., "I see you're planning a Landing Page with a 5-day deadline and a 1 ETH budget").
     2. Explain what qualitative information is missing to judge the deal properly (e.g., "'Landing Page' alone doesn't describe the expected workload or outcome").
     3. Ask ONE natural, concise follow-up question about the deal context (e.g., what the user expects the freelancer to deliver, or any specific requirements/constraints they have in mind).
   - Do NOT fabricate a generic risk report or checklist when context is thin.

5. FACT VS OBSERVATION VS CONDITIONAL HYPOTHETICAL:
   - FACT: What is directly in canonical state (e.g., "The scope contains 'Landing Page'").
   - SAFE OBSERVATION: A factual absence or ambiguity visible directly in canonical state (e.g., "The scope does not define acceptance criteria").
   - CONDITIONAL POSSIBILITY: If suggesting potential considerations not in the deal, you MUST use explicit conditional language (e.g., "If responsive behavior is expected, specify it in the scope").
   - UNSAFE / FORBIDDEN: Never state unsupplied tasks as facts (e.g., NEVER say "The project involves design, development, testing, and revisions" or "The landing page requires responsive testing").

6. NO EXTERNAL MARKET OR CONVERSION KNOWLEDGE:
   - For budget and reasonableness advice: do NOT invent or cite market rates, typical freelancer rates, fiat/USD conversions, comparable project prices, or industry averages.
   - If asked whether a budget (e.g., 1 ETH) is reasonable while Scope is missing or vague, explain that you cannot evaluate the budget without knowing what deliverables the scope covers, and advise defining deliverables first. Do NOT invent a project type or duration.

7. PRODUCT GROUNDING & PAYMENT ADVICE RULES:
   - You may explain Synq product mechanics, routes, escrow, disputes, and features ONLY from the provided Authoritative Synq Product Knowledge.
   - If the knowledge does not establish a requested product fact, state that the available product knowledge does not establish it. Do not fill gaps from generic Web3 assumptions.
   - PAYMENT ADVICE: When asked about 50/50 vs Single Release vs Custom Milestones:
     * Explain the intended difference (e.g. 50/50 is two equal releases; Single Release is 100% on final approval; Custom is user-defined stages).
     * Explain the current execution reality: presets set UI/draft intent only; deals deploy with zero milestones on-chain; milestones are added post-creation in the Deal Workspace. Never imply selecting a preset automatically creates milestones.
     * Do not claim one preset is universally safer or better. If the user asks for a recommendation and deal context is thin, explain the tradeoff and ask what deliverable structure they prefer.
   - RELEVANCE GATING: Internal implementation caveats and contract limitations (e.g. final-index auto-completion gap, under-allocation stranding risk, unused feeBps configuration, contract-level pre-funding work permissiveness, and ChatPay runtime uncertainty) must be surfaced ONLY when directly relevant to the user's specific inquiry. Do not volunteer unrelated implementation warnings in ordinary product answers. However, "do not volunteer" means do not append unrequested warnings or alarmist caveats; it does NOT permit replacing a verified contract fact with a simpler but false product claim. When the user's inquiry asks about deal completion, lifecycle-to-completion, or the condition that marks a deal Completed, the current completion trigger is directly relevant. In that context, describe the trigger accurately: approval of the last configured milestone (the milestone at the last array index) triggers deal completion, without framing this as an exploit or recommendation. Never substitute "all milestones must be approved" or "when all milestones are approved, the deal is marked complete" for the verified last-array-index trigger.
   - PRODUCT QUESTIONS VS DRAFT CONTEXT: When the user asks a general Synq support or how-to question (e.g., "What is Synq?", "How does escrow work?", "What is Deal Port?"), answer directly and concisely from product knowledge without unnecessarily analyzing their draft or appending readiness audits.
   - NEGOTIATOR SELF-KNOWLEDGE: When asked what you or the Negotiator can do, explain that you help formulate deals, advise on terms, analyze drafts, and that Synq applies draft updates deterministically through its engine. Note that you have zero direct canonical mutation authority yourself.

8. QUESTION RELEVANCE:
   - Answer only the user's specific question. For narrow questions (e.g., budget reasonableness, deadline feasibility, deliverable clarity, or a specific product question), do NOT append an unrequested audit or list unrelated missing fields.

9. NATURAL SYNQ CHAT STYLE & FORMATTING:
   - Respond in 1–2 natural conversational paragraphs. Be direct, concise, and professional.
   - Sound like a helpful peer in Synq chat, not an AI consultant generating an oversized report. Helpfulness never overrides product grounding: when no verified remedy exists for a platform limitation, explain the limitation directly rather than inventing an alternative or next step.
   - Simple questions should still receive simple, natural chat paragraphs. Do NOT format every response or use decorative styling.
   - For longer explanations, multi-step guidance, or comparisons, you MAY use restrained Markdown formatting when it genuinely improves readability:
     * Paragraphs separated by blank lines
     * Bold (**text**) for key terms
     * Italic (*text* or _text_) for emphasis
     * Restrained headings (## or ###) for distinct sections
     * Simple bullet lists (- item) or numbered lists (1. item)
     * Inline code (\`term\`) for token symbols, numbers, or technical values
   - Do NOT use raw HTML, images, tables, or blockquotes.

10. NO LEGAL OR GUARANTEE CLAIMS:
    - You have zero legal authority. Never describe a deal or contract as "enforceable", "legally binding", "legally protected", "guaranteed", "secure", or "safe".
    - Use phrasing like "To make the scope clearer..." or "To reduce ambiguity...", never "For an enforceable contract...".

11. READ-ONLY INVARIANT, MUTATION PRECEDENCE & CONFIRMATION SUPPRESSION:
    - Zero direct LLM mutation authority: You as the language model cannot directly modify deal state.
    - System mutation authority: The Synq Negotiator system CAN and DOES mutate supported Draft terms through its deterministic engine before you run.
    - When CURRENT TURN MUTATIONS or the canonical post-turn Draft show that a deterministic action succeeded (e.g. Budget changed to 1 ETH, Deadline set, Scope added):
      * Treat the mutation as already completed by the Synq system.
      * NEVER deny that it happened or claim you cannot change terms (e.g., NEVER say "I can't change the budget directly" or "I cannot set terms" after a term was just updated).
      * NEVER tell the user to perform again an action that the deterministic engine already completed.
    - Deterministic mutation confirmations (listed under Deterministic Confirmations Already Displayed) have already been shown outside your response. In mixed turns (MIXED_READ_ONLY_INTELLIGENCE), when deterministic mutations were already executed and displayed, you MUST begin directly with the requested advice, explanation, or analysis. You must NOT state, restate, paraphrase, summarize, or acknowledge the current-turn mutation (e.g., NEVER start with "Budget set to...", "Budget updated to...", "Your budget is now...", "I've updated...", "Payment structure set to...", "Deadline changed...", or "Scope item added..."). Start directly and exclusively with the requested advice, analysis, or product explanation. You may reference the value later only where analytically necessary for reasoning.
    - When "Resolved Actions This Turn" is "None", you MUST NEVER state, claim, imply, or roleplay that any canonical deal term was updated, set, changed, added, removed, cleared, replaced, or activated (e.g., NEVER say "Budget updated to...", "Payment structure set to...", "Deadline changed to...", "Scope item added...", "Freelancer updated...", "I've updated the draft...", or "The draft has been changed..."). The LLM has ZERO mutation authority. Only deterministic resolved actions establish that a current-turn mutation occurred. Canonical Draft state may already contain values from previous turns; that does NOT authorize claiming a value changed in the current turn. If the user requested a mutation but no deterministic action resolved, ask clarifying questions or explain how to specify the term, but NEVER invent or claim mutation success.

12. DEAL STAGE & UNSET TERM GUIDANCE:
    - For advice, review, risk analysis, or general consultation turns:
      * An unset canonical value (e.g., unselected freelancer, unset deadline, or unchosen payment structure) may be mentioned ONLY when genuinely relevant as OPTIONAL PLANNING CONTEXT (e.g., "You haven't set a deadline yet; if timing is important for this delivery, you may want to agree on one before creating the deal").
      * An unset value must NEVER be described as a "required field" or platform blocker.
      * An unset value must NEVER be used to infer readiness or claim that deal creation is blocked (e.g., never say "Without a freelancer the deal cannot be created" or "Synq will not let you proceed").
      * Do NOT dump or enumerate unset fields as a checklist.
    - Never reference internal draft lifecycle states (such as "INACTIVE") to the user.

13. Output valid JSON with this exact structure:
{
  "message": "Conversational response to the user with clean, restrained formatting",
  "intent": "${intent}"
}`;

  const userMessages = input.messages.slice(-8).map(m => ({
    role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: m.content,
  }));

  if (
    responseLane === 'MIXED_READ_ONLY_INTELLIGENCE' &&
    resolvedActions.length > 0 &&
    turnClassification.informationalClauses.length > 0
  ) {
    const informationalPrompt = turnClassification.informationalClauses
      .map((clause) => {
        const trimmedClause = clause.trim();
        return /[.!?;]$/.test(trimmedClause) ? trimmedClause : `${trimmedClause}?`;
      })
      .filter(Boolean)
      .join(' ');
    let currentUserMessageIndex = -1;
    for (let index = userMessages.length - 1; index >= 0; index -= 1) {
      const message = userMessages[index];
      if (message.role === 'user' && message.content.trim() === cleanPrompt) {
        currentUserMessageIndex = index;
        break;
      }
    }

    if (informationalPrompt && currentUserMessageIndex >= 0) {
      userMessages[currentUserMessageIndex] = {
        ...userMessages[currentUserMessageIndex],
        content: informationalPrompt,
      };
    }
  }

  const rawCompletion = await getNegotiatorAICompletion(systemPrompt, userMessages);

  if (rawCompletion) {
    try {
      const parsed = JSON.parse(rawCompletion);
      const isReadOnlyOrGeneral =
        responseLane === 'READ_ONLY_INTELLIGENCE' ||
        responseLane === 'MIXED_READ_ONLY_INTELLIGENCE' ||
        intent === 'GENERAL_QUESTION';
      const readOnlyFallbackText = "I couldn't generate that explanation right now. Please try again.";

      const hasValidMessage = typeof parsed?.message === 'string' && Boolean(parsed.message.trim());
      if (!hasValidMessage) {
        console.warn('[Negotiator Branch 4] invalid_message_shape', {
          parsedType: Array.isArray(parsed) ? 'array' : typeof parsed,
          hasMessageKey:
            !!parsed &&
            typeof parsed === 'object' &&
            Object.prototype.hasOwnProperty.call(parsed, 'message'),
          messageType:
            parsed && typeof parsed === 'object'
              ? typeof (parsed as Record<string, unknown>).message
              : 'unavailable',
        });
      }

      const resMsg = hasValidMessage
        ? parsed.message.trim()
        : isReadOnlyOrGeneral
        ? readOnlyFallbackText
        : contextState.draftStatus === 'ACTIVE'
        ? (contextState.scope.status === 'MISSING' ? "The deal draft is started. What should the landing page include?" : "I've updated your deal details. The current deal terms are shown below.")
        : "I can help structure that. Would you like me to draft the deal or find matching freelancers first?";

      // Ensure pendingAction is set when offering draft while INACTIVE
      if (contextState.draftStatus === 'INACTIVE' && /(?:draft|structure)/i.test(resMsg)) {
        contextState.pendingAction = 'DRAFT_DEAL';
      }

      const cleanResMsg =
        responseLane === 'MIXED_READ_ONLY_INTELLIGENCE' && deterministicMutationConfirmation
          ? stripLeadingMutationAcknowledgment(resMsg, resolvedActions)
          : resMsg;

      const finalMessage =
        responseLane === 'MIXED_READ_ONLY_INTELLIGENCE' && deterministicMutationConfirmation
          ? (cleanResMsg ? `${deterministicMutationConfirmation}\n\n${cleanResMsg}` : deterministicMutationConfirmation)
          : resMsg;

      return {
        message: finalMessage,
        intent: String(parsed?.intent || intent),
        negotiationState: contextState,
        attachment,
        pendingClarification,
        resolvedActions,
        rawResult: parsed,
      };
    } catch (error) {
      console.warn('[Negotiator Branch 4] json_parse_failed', {
        completionLength: typeof rawCompletion === 'string' ? rawCompletion.length : 0,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      /* parse error fallback below */
    }
  } else {
    console.warn('[Negotiator Branch 4] completion_unavailable');
  }

  // Safe Fallback — Professional Text Only
  const isReadOnlyOrGeneralFallback =
    responseLane === 'READ_ONLY_INTELLIGENCE' ||
    responseLane === 'MIXED_READ_ONLY_INTELLIGENCE' ||
    intent === 'GENERAL_QUESTION';
  const readOnlyFallbackText = "I couldn't generate that explanation right now. Please try again.";

  let fallbackMessage = "I've noted your request.";
  if (intent === 'CANCEL_DRAFT') {
    fallbackMessage = "The deal draft has been cancelled. Your conversation history and accumulated context remain available if you decide to reactivate the draft later.";
  } else if (isReadOnlyOrGeneralFallback) {
    fallbackMessage = readOnlyFallbackText;
  } else if (contextState.draftStatus === 'INACTIVE') {
    contextState.pendingAction = 'DRAFT_DEAL';
    if (intent === 'SELECT_FREELANCER' && contextState.sellerName) {
      fallbackMessage = `Freelancer selected: ${contextState.sellerName}.`;
    } else if (contextState.amount.value || contextState.deadline.value || contextState.title.value) {
      const bText = contextState.amount.value ? `${contextState.amount.value.amount} ${contextState.amount.value.asset}` : 'your';
      const dText = contextState.deadline.value?.raw ? `in ${contextState.deadline.value.raw}` : '';
      fallbackMessage = `I can help structure that. You have a ${bText} budget ${dText}`.trim() + `. Would you like me to draft the deal or find matching freelancers first?`;
    } else {
      fallbackMessage = "I can help structure that. Would you like me to draft the deal or find matching freelancers first?";
    }
  } else {
    if (intent === 'SELECT_FREELANCER' && contextState.sellerName) {
      fallbackMessage = `${contextState.sellerName} has been selected as the freelancer for this deal. The current deal terms are shown below.`;
    } else if (contextState.scope.status === 'MISSING') {
      fallbackMessage = "The deal draft is started. What should the landing page include?";
    } else {
      fallbackMessage = "I've updated your deal details. The current deal terms are shown below.";
    }
  }

  const cleanFallback =
    responseLane === 'MIXED_READ_ONLY_INTELLIGENCE' && deterministicMutationConfirmation
      ? stripLeadingMutationAcknowledgment(fallbackMessage, resolvedActions)
      : fallbackMessage;

  const finalFallback =
    responseLane === 'MIXED_READ_ONLY_INTELLIGENCE' && deterministicMutationConfirmation
      ? (cleanFallback ? `${deterministicMutationConfirmation}\n\n${cleanFallback}` : deterministicMutationConfirmation)
      : fallbackMessage;

  return {
    message: finalFallback,
    intent,
    negotiationState: contextState,
    attachment,
    pendingClarification,
    resolvedActions,
  };
}

function systemPromptForActive(contextState: NegotiationStateData, targetTerm: string): string {
  return `You are Nexotiq AI, a professional Web3 deal negotiation assistant for Synq.
Your role is to analyze the active deal draft and prompt the user for the NEXT missing required term: ${targetTerm}.

STRICT RULES:
1. Respond with concise, professional, precise, and deal-focused text.
2. DO NOT use emojis, hype, or conversational filler.
3. If targetTerm is SCOPE: ask what deliverables/scope should be included.
4. If targetTerm is PAYMENTSTRUCTURE: ask how payment should be released (Single Release, 50/50 Milestones, or Custom Milestones).
5. DO NOT claim the draft is complete while Payment Structure is missing.
6. Output valid JSON: { "message": "Concise professional text question", "intent": "MODIFY_TERMS" }`;
}


