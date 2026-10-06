import { TOKENS } from '@/lib/contracts/addresses';

export const SYNQ_MESSAGE_KINDS = [
  'text',
  'file',
  'deal_receipt',
  'payment_receipt',
  'deal_proposal',
  'order',
  'confirm',
] as const;

export type SynqMessageKind = (typeof SYNQ_MESSAGE_KINDS)[number];
export type SynqMessagePayload = Record<string, unknown>;
export const MAX_SYNQ_FILE_SIZE = 10 * 1024 * 1024;
export const SYNQ_FILE_MIME_EXTENSIONS = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
  'application/msword': ['doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
} as const;

export type SynqFileMimeType = keyof typeof SYNQ_FILE_MIME_EXTENSIONS;
export const SYNQ_PAYMENT_STRUCTURES = ['custom', '50-50', 'single'] as const;
export type SynqPaymentStructure = (typeof SYNQ_PAYMENT_STRUCTURES)[number];

export interface SynqFileMessagePayload extends SynqMessagePayload {
  storagePath: string;
  fileName: string;
  mimeType: SynqFileMimeType;
  size: number;
}

export interface SynqDealReceiptPayload extends SynqMessagePayload {
  dealAddress: string;
  chainId: number;
  transactionHash: string;
  title: string;
  scope: string;
  totalValue: string;
  assetAddress: string;
  deadline: string;
  protectionEnabled: boolean;
  factoryDealId?: string;
  /** Authenticated buyer-selected metadata; this value is not derived from or enforced on-chain. */
  paymentStructure?: SynqPaymentStructure;
}

export interface SynqPaymentReceiptPayload extends SynqMessagePayload {
  transactionHash: string;
  chainId: 11155111;
  assetType: 'native' | 'erc20';
  assetAddress: string;
  amount: string;
  decimals: 18 | 6;
  symbol: 'ETH' | 'USDC';
  transferLogIndex?: number;
  note?: string;
}

export interface SynqDealProposalPayload extends SynqMessagePayload {
  proposalId: string;
  clientWallet: string;
  freelancerWallet: string;
  title: string;
  totalAmount: string;
  milestoneCount: number;
  expiry: string;
  cachedStatus?: string;
  protectionSelection?: 'STANDARD' | 'PREMIUM';
}
export type LegacyOrderMeta = Record<string, unknown> & {
  type?: string;
  requirements?: string;
  budget?: string;
  deadline?: string;
  paymentSplit?: '50/50' | 'full';
  confirmed?: boolean;
};

const MESSAGE_KIND_SET = new Set<string>(SYNQ_MESSAGE_KINDS);
const PUBLIC_MESSAGE_KINDS = new Set<SynqMessageKind>(['text', 'order']);

export const isSynqMessageKind = (value: unknown): value is SynqMessageKind =>
  typeof value === 'string' && MESSAGE_KIND_SET.has(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isSynqFileMimeType = (value: unknown): value is SynqFileMimeType =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(SYNQ_FILE_MIME_EXTENSIONS, value);

export const isSynqPaymentStructure = (value: unknown): value is SynqPaymentStructure =>
  typeof value === 'string' && (SYNQ_PAYMENT_STRUCTURES as readonly string[]).includes(value);

export function validateFileMessagePayload(value: unknown): SynqFileMessagePayload {
  if (!isPlainObject(value)) throw new Error('A valid file payload is required');
  const keys = Object.keys(value);
  if (keys.some((key) => !['storagePath', 'fileName', 'mimeType', 'size'].includes(key))) {
    throw new Error('File payload contains unsupported fields');
  }
  if (
    typeof value.storagePath !== 'string'
    || !/^attachments\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/i.test(value.storagePath)
  ) throw new Error('Invalid file storage path');
  if (typeof value.fileName !== 'string' || !value.fileName.trim() || value.fileName.length > 180) {
    throw new Error('Invalid file name');
  }
  if (!isSynqFileMimeType(value.mimeType)) throw new Error('Unsupported file type');
  if (typeof value.size !== 'number' || !Number.isInteger(value.size) || value.size <= 0 || value.size > MAX_SYNQ_FILE_SIZE) {
    throw new Error('Invalid file size');
  }
  return {
    storagePath: value.storagePath,
    fileName: value.fileName,
    mimeType: value.mimeType,
    size: value.size,
  };
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/;
const UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/;
const SEPOLIA_USDC_ADDRESS = Object.keys(TOKENS.sepolia)
  .find((address) => TOKENS.sepolia[address].symbol === 'USDC')
  ?.toLowerCase();
const PAYMENT_NOTE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;

export function normalizePaymentNote(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('Payment note must be plain text');
  if (PAYMENT_NOTE_CONTROLS.test(value)) throw new Error('Payment note must be a single line');
  const note = value.trim();
  if (!note) return undefined;
  if (note.length > 160) throw new Error('Payment note is too long (max 160 characters)');
  return note;
}

export function validateDealReceiptPayload(value: unknown): SynqDealReceiptPayload {
  if (!isPlainObject(value)) throw new Error('A valid Deal receipt payload is required');
  const allowedKeys = [
    'dealAddress',
    'chainId',
    'transactionHash',
    'title',
    'scope',
    'totalValue',
    'assetAddress',
    'deadline',
    'protectionEnabled',
    'factoryDealId',
    'paymentStructure',
  ];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new Error('Deal receipt payload contains unsupported fields');
  }

  const dealAddress = typeof value.dealAddress === 'string' ? value.dealAddress.toLowerCase() : '';
  const transactionHash = typeof value.transactionHash === 'string' ? value.transactionHash.toLowerCase() : '';
  const assetAddress = typeof value.assetAddress === 'string' ? value.assetAddress.toLowerCase() : '';
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const scope = typeof value.scope === 'string' ? value.scope.trim() : '';
  const totalValue = typeof value.totalValue === 'string' ? value.totalValue : '';
  const deadline = typeof value.deadline === 'string' ? value.deadline : '';
  const factoryDealId = value.factoryDealId === undefined
    ? undefined
    : typeof value.factoryDealId === 'string' ? value.factoryDealId : '';
  const paymentStructure = value.paymentStructure;

  if (!EVM_ADDRESS.test(dealAddress)) throw new Error('Invalid Deal address');
  if (value.chainId !== 11155111) throw new Error('Deal receipt must use Ethereum Sepolia');
  if (!TRANSACTION_HASH.test(transactionHash)) throw new Error('Invalid Deal transaction hash');
  if (!title || title.length > 512) throw new Error('Invalid Deal title');
  if (!scope || scope.length > 20_000) throw new Error('Invalid Deal scope');
  if (!UNSIGNED_INTEGER.test(totalValue) || totalValue === '0' || totalValue.length > 78) {
    throw new Error('Invalid Deal value');
  }
  if (!EVM_ADDRESS.test(assetAddress)) throw new Error('Invalid Deal asset address');
  if (!UNSIGNED_INTEGER.test(deadline) || deadline === '0' || deadline.length > 78) {
    throw new Error('Invalid Deal deadline');
  }
  if (typeof value.protectionEnabled !== 'boolean') throw new Error('Invalid Deal protection setting');
  if (factoryDealId !== undefined && (!UNSIGNED_INTEGER.test(factoryDealId) || factoryDealId.length > 78)) {
    throw new Error('Invalid Factory Deal ID');
  }
  if (paymentStructure !== undefined && !isSynqPaymentStructure(paymentStructure)) {
    throw new Error('Invalid Deal payment structure');
  }

  return {
    dealAddress,
    chainId: value.chainId,
    transactionHash,
    title,
    scope,
    totalValue,
    assetAddress,
    deadline,
    protectionEnabled: value.protectionEnabled,
    ...(factoryDealId === undefined ? {} : { factoryDealId }),
    ...(paymentStructure === undefined ? {} : { paymentStructure }),
  };
}

export function validatePaymentReceiptPayload(value: unknown): SynqPaymentReceiptPayload {
  if (!isPlainObject(value)) throw new Error('A valid payment receipt payload is required');
  const allowedKeys = [
    'transactionHash', 'chainId', 'assetType', 'assetAddress', 'amount', 'decimals', 'symbol', 'transferLogIndex', 'note',
  ];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new Error('Payment receipt payload contains unsupported fields');
  }

  const transactionHash = typeof value.transactionHash === 'string' ? value.transactionHash.toLowerCase() : '';
  const assetAddress = typeof value.assetAddress === 'string' ? value.assetAddress.toLowerCase() : '';
  const amount = typeof value.amount === 'string' ? value.amount : '';
  if (!TRANSACTION_HASH.test(transactionHash)) throw new Error('Invalid payment transaction hash');
  if (value.chainId !== 11155111) throw new Error('Payment receipt must use Ethereum Sepolia');
  if (!EVM_ADDRESS.test(assetAddress)) throw new Error('Invalid payment asset address');
  if (!UNSIGNED_INTEGER.test(amount) || amount === '0' || amount.length > 78) throw new Error('Invalid payment amount');

  const transferLogIndex = value.transferLogIndex;
  const note = normalizePaymentNote(value.note);
  if (value.assetType === 'native') {
    if (assetAddress !== '0x0000000000000000000000000000000000000000') throw new Error('Invalid ETH asset address');
    if (value.decimals !== 18 || value.symbol !== 'ETH') throw new Error('Invalid ETH asset metadata');
    if (transferLogIndex !== undefined) throw new Error('ETH receipts cannot include a transfer log index');
  } else if (value.assetType === 'erc20') {
    if (!SEPOLIA_USDC_ADDRESS || assetAddress !== SEPOLIA_USDC_ADDRESS) throw new Error('Invalid USDC asset address');
    if (value.decimals !== 6 || value.symbol !== 'USDC') throw new Error('Invalid USDC asset metadata');
    if (!Number.isSafeInteger(transferLogIndex) || (transferLogIndex as number) < 0) {
      throw new Error('USDC receipts require a valid transfer log index');
    }
  } else {
    throw new Error('Invalid payment asset type');
  }

  return {
    transactionHash,
    chainId: 11155111,
    assetType: value.assetType,
    assetAddress,
    amount,
    decimals: value.decimals,
    symbol: value.symbol,
    ...(transferLogIndex === undefined ? {} : { transferLogIndex: transferLogIndex as number }),
    ...(note === undefined ? {} : { note }),
  } as SynqPaymentReceiptPayload;
}

export function validateDealProposalPayload(value: unknown): SynqDealProposalPayload {
  if (!isPlainObject(value)) throw new Error('A valid Deal proposal payload is required');
  const allowedKeys = [
    'proposalId',
    'clientWallet',
    'freelancerWallet',
    'title',
    'totalAmount',
    'milestoneCount',
    'expiry',
    'cachedStatus',
    'protectionSelection',
  ];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new Error('Deal proposal payload contains unsupported fields');
  }

  const proposalId = typeof value.proposalId === 'string' ? value.proposalId.toLowerCase() : '';
  const clientWallet = typeof value.clientWallet === 'string' ? value.clientWallet.toLowerCase() : '';
  const freelancerWallet = typeof value.freelancerWallet === 'string' ? value.freelancerWallet.toLowerCase() : '';
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const totalAmount = typeof value.totalAmount === 'string' ? value.totalAmount : '';
  const milestoneCount = value.milestoneCount;
  const expiry = typeof value.expiry === 'string' ? value.expiry : '';
  const cachedStatus = typeof value.cachedStatus === 'string' ? value.cachedStatus : undefined;
  const rawProtection = value.protectionSelection;

  if (!TRANSACTION_HASH.test(proposalId)) throw new Error('Invalid proposalId format');
  if (!EVM_ADDRESS.test(clientWallet)) throw new Error('Invalid client wallet address');
  if (!EVM_ADDRESS.test(freelancerWallet)) throw new Error('Invalid freelancer wallet address');
  if (clientWallet === freelancerWallet) throw new Error('Client and freelancer cannot be the same address');
  if (!title || title.length > 140) throw new Error('Invalid proposal title');
  if (!UNSIGNED_INTEGER.test(totalAmount) || totalAmount === '0' || totalAmount.length > 78) {
    throw new Error('Invalid proposal total amount');
  }
  if (!Number.isSafeInteger(milestoneCount) || (milestoneCount as number) < 1 || (milestoneCount as number) > 10) {
    throw new Error('Invalid proposal milestone count');
  }
  if (!UNSIGNED_INTEGER.test(expiry) || expiry === '0' || expiry.length > 78) {
    throw new Error('Invalid proposal expiry');
  }
  if (cachedStatus !== undefined && !['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED'].includes(cachedStatus)) {
    throw new Error('Invalid proposal cached status');
  }
  if (rawProtection !== undefined && rawProtection !== 'STANDARD' && rawProtection !== 'PREMIUM') {
    throw new Error('Invalid proposal protection selection');
  }
  const protectionSelection = rawProtection as 'STANDARD' | 'PREMIUM' | undefined;

  return {
    proposalId,
    clientWallet,
    freelancerWallet,
    title,
    totalAmount,
    milestoneCount: milestoneCount as number,
    expiry,
    ...(cachedStatus ? { cachedStatus } : {}),
    ...(protectionSelection ? { protectionSelection } : {})
  };
}

export type PublicMessageValidation =
  | { ok: true; kind: 'text' | 'order'; body: string; orderMeta?: LegacyOrderMeta }
  | { ok: false; error: string };

/** Validation boundary for the authenticated, user-facing POST /api/messages. */
export function validatePublicMessageInput(input: {
  kind?: unknown;
  body?: unknown;
  payload?: unknown;
  orderMeta?: unknown;
}): PublicMessageValidation {
  const requestedKind = input.kind === undefined ? 'text' : input.kind;
  if (!isSynqMessageKind(requestedKind) || !PUBLIC_MESSAGE_KINDS.has(requestedKind)) {
    return { ok: false, error: 'Unsupported message kind' };
  }
  if (input.payload !== undefined && input.payload !== null) {
    return { ok: false, error: 'Structured payloads cannot be sent through this endpoint' };
  }

  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) return { ok: false, error: 'Message body is required' };
  if (body.length > 4000) return { ok: false, error: 'Message is too long (max 4000 characters)' };

  if (requestedKind === 'text') {
    if (input.orderMeta !== undefined && input.orderMeta !== null) {
      return { ok: false, error: 'Text messages cannot include order metadata' };
    }
    return { ok: true, kind: 'text', body };
  }

  if (!isPlainObject(input.orderMeta)) {
    return { ok: false, error: 'Order metadata is required for an order message' };
  }
  return { ok: true, kind: 'order', body, orderMeta: input.orderMeta as LegacyOrderMeta };
}

export function deriveConversationPreview(
  kind: SynqMessageKind,
  body: string,
  payload?: SynqMessagePayload | null,
): string {
  const neutral = kind === 'file'
    ? 'Sent a file'
    : kind === 'deal_receipt'
      ? 'Deal created'
      : kind === 'payment_receipt'
        ? 'Payment recorded'
        : kind === 'deal_proposal'
          ? (payload && typeof payload.title === 'string' && payload.title.trim()
              ? `Deal proposal: ${payload.title.trim()}`
              : 'Deal proposal')
          : body;
  const flat = neutral.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 137)}...` : flat;
}

export function validateTrustedMessageData(input: {
  kind: unknown;
  body?: unknown;
  payload?: unknown;
  orderMeta?: unknown;
}): { kind: SynqMessageKind; body: string; payload: SynqMessagePayload | null; orderMeta: Record<string, unknown> | null } {
  if (!isSynqMessageKind(input.kind)) throw new Error('Unsupported message kind');
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (body.length > 4000) throw new Error('Message is too long (max 4000 characters)');

  if (input.kind === 'text' || input.kind === 'order' || input.kind === 'confirm') {
    if (!body) throw new Error('Message body is required');
    if (input.payload !== undefined && input.payload !== null) {
      throw new Error('Legacy and text messages cannot include a structured payload');
    }
  } else if (input.kind === 'file') {
    validateFileMessagePayload(input.payload);
  } else if (input.kind === 'deal_receipt') {
    validateDealReceiptPayload(input.payload);
  } else if (input.kind === 'payment_receipt') {
    validatePaymentReceiptPayload(input.payload);
  } else if (input.kind === 'deal_proposal') {
    validateDealProposalPayload(input.payload);
  } else if (!isPlainObject(input.payload)) {
    throw new Error(`Structured payload is required for ${input.kind}`);
  }

  if (input.kind === 'order' && !isPlainObject(input.orderMeta)) {
    throw new Error('Order metadata is required for an order message');
  }

  return {
    kind: input.kind,
    body,
    payload: input.kind === 'file'
      ? validateFileMessagePayload(input.payload)
      : input.kind === 'deal_receipt'
        ? validateDealReceiptPayload(input.payload)
      : input.kind === 'payment_receipt'
        ? validatePaymentReceiptPayload(input.payload)
      : input.kind === 'deal_proposal'
        ? validateDealProposalPayload(input.payload)
      : isPlainObject(input.payload) ? input.payload : null,
    orderMeta: isPlainObject(input.orderMeta) ? input.orderMeta : null,
  };
}
