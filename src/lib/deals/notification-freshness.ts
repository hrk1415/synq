/**
 * SYNQ — Shared Notification Freshness Guard (B.12.3.65)
 *
 * Implements the "Fresh Notifications Only" production recovery policy across
 * both asynchronous outbox processing and synchronous direct lifecycle routes.
 *
 * Requirements:
 * 1. Uses NOTIFICATION_LIVE_START_BLOCK as authoritative activation boundary.
 * 2. Missing or invalid cutoff configuration fails closed for blockchain-derived notifications.
 * 3. Requires trustworthy, verified receipt or event block coordinates.
 * 4. Missing, malformed, or unverified block coordinates fail closed.
 * 5. Block numbers below the cutoff are historical and permanently suppressed.
 * 6. Block numbers at or above the cutoff are eligible, subject to deduplication.
 * 7. Never uses application created_at timestamps as substitutes for block numbers.
 * 8. Preserves normal delivery for genuine off-chain notifications (e.g. proposal_received).
 * 9. Distinguishes confirmed historical suppression from temporary configuration/verification gaps.
 */

export interface NotificationCutoffConfig {
  configured: boolean;
  startBlock?: bigint;
  error?: string;
}

/**
 * Validates and safely parses NOTIFICATION_LIVE_START_BLOCK.
 * Rejects non-integers, empty strings, and negative values.
 * Fails closed without throwing unhandled BigInt exceptions.
 */
export function parseNotificationLiveStartBlock(envValue?: string): NotificationCutoffConfig {
  if (envValue === undefined || envValue === null) {
    return {
      configured: false,
      error: 'NOTIFICATION_LIVE_START_BLOCK is unset. Historical email safety gate is active (fail-closed).',
    };
  }
  const trimmed = envValue.trim();
  if (trimmed === '') {
    return {
      configured: false,
      error: 'NOTIFICATION_LIVE_START_BLOCK is empty. Historical email safety gate is active (fail-closed).',
    };
  }
  // Accept only valid non-negative integer digits
  if (!/^\d+$/.test(trimmed)) {
    return {
      configured: false,
      error: `NOTIFICATION_LIVE_START_BLOCK contains invalid integer characters: "${trimmed}". Historical email safety gate is active (fail-closed).`,
    };
  }
  try {
    const block = BigInt(trimmed);
    if (block < 0n) {
      return {
        configured: false,
        error: `NOTIFICATION_LIVE_START_BLOCK must be non-negative: "${trimmed}". Historical email safety gate is active (fail-closed).`,
      };
    }
    return {
      configured: true,
      startBlock: block,
    };
  } catch (err: any) {
    return {
      configured: false,
      error: `Failed to parse NOTIFICATION_LIVE_START_BLOCK: ${err?.message || err}`,
    };
  }
}

/**
 * Safely parses and validates a block number coordinate.
 * Prevents unhandled BigInt exceptions on malformed or invalid inputs.
 */
export function extractSafeBlockNumber(raw: unknown): {
  valid: boolean;
  blockNumber?: bigint;
  error?: string;
} {
  if (raw === null || raw === undefined) {
    return { valid: false, error: 'blockNumber is missing' };
  }
  if (typeof raw === 'bigint') {
    if (raw < 0n) return { valid: false, error: 'blockNumber must be non-negative' };
    return { valid: true, blockNumber: raw };
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
      return { valid: false, error: `Invalid numeric blockNumber: ${raw}` };
    }
    return { valid: true, blockNumber: BigInt(raw) };
  }
  const str = String(raw).trim();
  if (str === '') {
    return { valid: false, error: 'blockNumber is empty' };
  }
  if (!/^\d+$/.test(str)) {
    return { valid: false, error: `Invalid blockNumber characters: "${str}"` };
  }
  try {
    const b = BigInt(str);
    if (b < 0n) return { valid: false, error: 'blockNumber must be non-negative' };
    return { valid: true, blockNumber: b };
  } catch (err: any) {
    return { valid: false, error: `Failed to convert blockNumber to BigInt: ${err?.message || err}` };
  }
}

/**
 * Known smart contract escrow lifecycle event types emitted by on-chain contracts.
 */
export const ON_CHAIN_DEAL_EVENTS = new Set([
  'deal_confirmed',
  'proposal_declined',
  'escrow_funded',
  'work_submitted',
  'revision_requested',
  'payment_released',
  'deal_completed',
  'deal_completed_seller',
  'deal_cancelled',
  'milestone_refunded',
  'resolution_finalized',
  'mutual_settlement_executed',
  'mutual_settlement_cancelled',
  'milestone_disputed',
]);

/**
 * Authoritatively determines whether a notification represents a blockchain-derived event.
 */
export function isBlockchainDerivedNotification(event: string, origin?: string): boolean {
  if (origin === 'on_chain') return true;
  if (origin === 'off_chain' && event === 'proposal_received') return false;
  if (ON_CHAIN_DEAL_EVENTS.has(event)) return true;
  return false;
}

export type NotificationFreshnessResult =
  | {
      eligible: true;
      isOffChain: boolean;
      blockNumber?: bigint;
      cutoffBlock?: bigint;
    }
  | {
      eligible: false;
      reason: 'historical';
      blockNumber: bigint;
      cutoffBlock: bigint;
      message: string;
    }
  | {
      eligible: false;
      reason: 'missing_or_invalid_cutoff';
      error: string;
      message: string;
    }
  | {
      eligible: false;
      reason: 'unverified_block_coordinates';
      error: string;
      message: string;
    };

export interface EvaluateFreshnessParams {
  event: string;
  origin?: 'on_chain' | 'off_chain';
  blockNumber?: unknown;
  txHash?: string | null;
  cutoffEnvValue?: string;
}

/**
 * Authoritative shared helper for verifying whether a notification is eligible for delivery.
 * Evaluates event provenance, cutoff configuration, and block coordinates.
 */
export function evaluateNotificationFreshness(params: EvaluateFreshnessParams): NotificationFreshnessResult {
  const isBlockchain = isBlockchainDerivedNotification(params.event, params.origin);

  // 1. Genuine off-chain notifications (e.g. proposal_received) bypass blockchain block cutoff
  if (!isBlockchain) {
    return {
      eligible: true,
      isOffChain: true,
    };
  }

  // 2. Validate live start block cutoff configuration
  const cutoff = parseNotificationLiveStartBlock(
    params.cutoffEnvValue !== undefined ? params.cutoffEnvValue : process.env.NOTIFICATION_LIVE_START_BLOCK,
  );

  if (!cutoff.configured || cutoff.startBlock === undefined) {
    return {
      eligible: false,
      reason: 'missing_or_invalid_cutoff',
      error: cutoff.error || 'NOTIFICATION_LIVE_START_BLOCK is not configured',
      message: `Blockchain-derived notification '${params.event}' cannot be verified: ${cutoff.error}`,
    };
  }

  // 3. Extract and validate block number coordinates
  const blockCoord = extractSafeBlockNumber(params.blockNumber);

  if (!blockCoord.valid || blockCoord.blockNumber === undefined) {
    return {
      eligible: false,
      reason: 'unverified_block_coordinates',
      error: blockCoord.error || 'Block coordinate is missing or invalid',
      message: `Blockchain-derived notification '${params.event}' lacks verified block coordinate (${blockCoord.error})`,
    };
  }

  // 4. Historical check against activation boundary
  if (blockCoord.blockNumber < cutoff.startBlock) {
    return {
      eligible: false,
      reason: 'historical',
      blockNumber: blockCoord.blockNumber,
      cutoffBlock: cutoff.startBlock,
      message: `Historical on-chain event (block ${blockCoord.blockNumber}) prior to live activation block (${cutoff.startBlock})`,
    };
  }

  // 5. Eligible live blockchain event
  return {
    eligible: true,
    isOffChain: false,
    blockNumber: blockCoord.blockNumber,
    cutoffBlock: cutoff.startBlock,
  };
}
