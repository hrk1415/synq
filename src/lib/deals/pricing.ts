/**
 * Canonical Modern Freelancer Pricing Layer
 * Off-chain USDC Starting Rate (PER_PROJECT / PER_HOUR)
 * 
 * Standard V2 Deal escrow operates in canonical USDC.
 * Public marketplace surfaces exclusively display modern USDC starting rates.
 * Legacy on-chain ETH rate remains an identity anchor in NexotiqDirectory,
 * visible only to the profile owner in their personal settings.
 */

export type FreelancerRateType = 'PER_PROJECT' | 'PER_HOUR';

export interface FreelancerPricing {
  amount: string;
  currency: 'USDC';
  rateType: FreelancerRateType;
}

export interface ValidateUsdcPricingResult {
  valid: boolean;
  error?: string;
  amount?: string;
  rateType?: FreelancerRateType;
  currency?: 'USDC';
  cleanAmount?: string;
  cleanType?: FreelancerRateType;
}

/**
 * Validates a user-entered or API-provided USDC starting rate.
 * - Required when provided / validating
 * - Must be a valid positive decimal string
 * - Max 6 decimal places (canonical USDC scale)
 * - Exact string representation (no floating point drift)
 * - Rate type must be PER_PROJECT or PER_HOUR
 * - Currency is fixed to USDC
 */
export function validateUsdcPricing(
  amount: unknown,
  rateType: unknown,
  currency: unknown = 'USDC'
): ValidateUsdcPricingResult {
  if (currency !== undefined && currency !== null && currency !== 'USDC') {
    return { valid: false, error: 'Only USDC currency is supported for modern marketplace pricing' };
  }

  if (amount === undefined || amount === null || typeof amount !== 'string' || !amount.trim()) {
    return { valid: false, error: 'USDC starting rate amount is required' };
  }

  const trimmedAmount = amount.trim();

  // Validate exact decimal format with up to 6 decimal places
  // Disallow exponential notation, negative signs, multiple dots, non-digits
  if (!/^\d+(\.\d+)?$/.test(trimmedAmount)) {
    return { valid: false, error: 'USDC rate must be a valid positive number' };
  }

  const parts = trimmedAmount.split('.');
  const intPart = parts[0].replace(/^0+(?=\d)/, ''); // strip leading zeroes except if zero itself
  const decimalPart = parts[1] || '';

  if (decimalPart.length > 6) {
    return { valid: false, error: 'USDC rate cannot have more than 6 decimal places' };
  }

  const numVal = Number(trimmedAmount);
  if (!isFinite(numVal) || numVal <= 0) {
    return { valid: false, error: 'USDC rate must be greater than zero' };
  }

  // Canonicalize string: e.g. "050.5" -> "50.5"
  const cleanAmount = decimalPart ? `${intPart || '0'}.${decimalPart}` : intPart || '0';

  if (!rateType || typeof rateType !== 'string') {
    return { valid: false, error: 'Rate type is required (Per Project or Per Hour)' };
  }

  const cleanTypeUpper = rateType.trim().toUpperCase();
  if (cleanTypeUpper !== 'PER_PROJECT' && cleanTypeUpper !== 'PER_HOUR') {
    return { valid: false, error: 'Rate type must be PER_PROJECT or PER_HOUR' };
  }

  return {
    valid: true,
    amount: cleanAmount,
    rateType: cleanTypeUpper as FreelancerRateType,
    currency: 'USDC',
    cleanAmount,
    cleanType: cleanTypeUpper as FreelancerRateType,
  };
}

/**
 * Strips insignificant trailing fractional zeros from a decimal string.
 * Preserves exact string precision and never converts to IEEE-754 floating point.
 * Examples:
 * - "100.000000" -> "100"
 * - "100.500000" -> "100.5"
 * - "100.250000" -> "100.25"
 * - "99.123400" -> "99.1234"
 * - "99.123456" -> "99.123456"
 * - "0.500000" -> "0.5"
 */
export function formatUsdcDisplayAmount(amount: unknown): string {
  if (amount === undefined || amount === null) return '';
  const trimmed = String(amount).trim();
  if (!trimmed || !trimmed.includes('.')) {
    return trimmed;
  }
  const [intPart, fracPart] = trimmed.split('.');
  const cleanFrac = (fracPart || '').replace(/0+$/, '');
  return cleanFrac ? `${intPart || '0'}.${cleanFrac}` : intPart || '0';
}

/**
 * Formats public pricing for display across marketplace cards, profiles, and recommendations.
 * Returns null if pricing is unconfigured or invalid.
 */
export function formatPublicPricing(
  pricing?: Partial<FreelancerPricing> | null
): {
  amountDisplay: string;
  unitDisplay: string;
  typeLabel: string;
  fullLine: string;
  formatted: string;
  amount: string;
  currency: 'USDC';
} | null {
  if (!pricing || !pricing.amount || !pricing.rateType) {
    return null;
  }

  const trimmedAmount = String(pricing.amount).trim();
  const numVal = Number(trimmedAmount);
  if (!trimmedAmount || isNaN(numVal) || numVal <= 0) {
    return null;
  }

  const rateType = pricing.rateType;
  if (rateType !== 'PER_PROJECT' && rateType !== 'PER_HOUR') {
    return null;
  }

  const cleanAmount = formatUsdcDisplayAmount(trimmedAmount);
  const typeLabel = rateType === 'PER_PROJECT' ? 'per project' : 'per hour';
  const shortSuffix = rateType === 'PER_PROJECT' ? 'project' : 'hour';
  const formatted = `${cleanAmount} USDC / ${shortSuffix}`;

  return {
    amountDisplay: cleanAmount,
    unitDisplay: 'USDC',
    typeLabel,
    fullLine: formatted,
    formatted,
    amount: cleanAmount,
    currency: 'USDC',
  };
}

/**
 * Returns the suggested deal budget for /deal/new prefill.
 * - PER_PROJECT: suggests the exact project starting rate
 * - PER_HOUR: returns null (hours are unknown)
 * - Unconfigured: returns null
 * - Never returns or converts legacy ETH rate
 */
export function getSuggestedDealBudget(
  pricing?: Partial<FreelancerPricing> | null
): string | null {
  if (!pricing || !pricing.amount || pricing.rateType !== 'PER_PROJECT') {
    return null;
  }
  const trimmed = String(pricing.amount).trim();
  const num = Number(trimmed);
  if (isNaN(num) || num <= 0) {
    return null;
  }
  return trimmed;
}

/**
 * Safely parses user-entered ETH rate string to 18-decimal BigInt wei units.
 * Returns null if invalid or <= 0.
 */
export function parseEthRateToWei(ethStr: string): bigint | null {
  try {
    const trimmed = (ethStr || '').trim();
    if (!trimmed || !/^\d+(\.\d+)?$/.test(trimmed)) return null;
    const parts = trimmed.split('.');
    const whole = parts[0] || '0';
    let fraction = parts[1] || '';
    if (fraction.length > 18) {
      fraction = fraction.slice(0, 18);
    } else {
      fraction = fraction.padEnd(18, '0');
    }
    const totalWei = BigInt(whole) * 10n ** 18n + BigInt(fraction);
    return totalWei > 0n ? totalWei : null;
  } catch {
    return null;
  }
}
