/**
 * ABI compatibility shims for NexotiqProtection.
 *
 * The `Coverage` struct gained a `premiumPaid` field and the contract gained
 * `poolBalance()` / `fundPool()`, but the pool live on Sepolia
 * (0x96a09E859b893934B955169d888BeE1510cC4F8F) predates both and still returns a
 * 7-word struct.
 *
 * viem tolerates *extra* trailing words when decoding but not missing ones, so
 * reading the live 7-word return with the regenerated 8-field ABI throws
 * ("Position 255 is out of bounds") and takes the entire coverage read down with
 * it — the page would show nothing at all. Reading with the 7-field shape works
 * against both the live pool and a redeployed one (the trailing `premiumPaid`
 * word is simply ignored).
 *
 * So: read the shared fields through `coverageCompatABI`, and probe the new
 * field separately through `coverageModernABI`, where a decode failure just
 * means "this pool does not track premium payment yet".
 */

const COVERAGE_SHARED_FIELDS = [
  { name: 'dealAddress', type: 'address', internalType: 'address' },
  { name: 'buyer', type: 'address', internalType: 'address' },
  { name: 'coverageAmount', type: 'uint256', internalType: 'uint256' },
  { name: 'premium', type: 'uint256', internalType: 'uint256' },
  { name: 'riskScore', type: 'uint256', internalType: 'uint256' },
  { name: 'active', type: 'bool', internalType: 'bool' },
  { name: 'claimed', type: 'bool', internalType: 'bool' },
] as const;

/** `getCoverage` as it exists on *every* deployment, old and new. */
export const coverageCompatABI = [
  {
    type: 'function',
    name: 'getCoverage',
    stateMutability: 'view',
    inputs: [{ name: '_dealAddress', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'tuple', internalType: 'struct NexotiqProtection.Coverage', components: COVERAGE_SHARED_FIELDS }],
  },
] as const;

/** `getCoverage` with `premiumPaid` — only decodes against a redeployed pool. */
export const coverageModernABI = [
  {
    type: 'function',
    name: 'getCoverage',
    stateMutability: 'view',
    inputs: [{ name: '_dealAddress', type: 'address', internalType: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct NexotiqProtection.Coverage',
        components: [...COVERAGE_SHARED_FIELDS, { name: 'premiumPaid', type: 'bool', internalType: 'bool' }],
      },
    ],
  },
] as const;

/** Fields shared by both pool versions, as decoded. */
export type CoverageShared = {
  dealAddress: `0x${string}`;
  buyer: `0x${string}`;
  coverageAmount: bigint;
  premium: bigint;
  riskScore: bigint;
  active: boolean;
  claimed: boolean;
};

export type CoverageView = CoverageShared & {
  /**
   * `undefined` means unknowable, not false: the live pool never recorded
   * whether the premium arrived. Treat it as "cannot tell" in the UI rather
   * than blocking or greenlighting a payment on a guess.
   */
  premiumPaid: boolean | undefined;
  /** False when `getCoverage` returned the zero struct — no coverage was ever created. */
  exists: boolean;
};

const ZERO = '0x0000000000000000000000000000000000000000';

export function toCoverageView(shared: unknown, premiumPaid: boolean | undefined): CoverageView | null {
  if (!shared || typeof shared !== 'object') return null;
  const c = shared as CoverageShared;
  if (typeof c.premium !== 'bigint') return null;
  return {
    dealAddress: c.dealAddress,
    buyer: c.buyer,
    coverageAmount: c.coverageAmount,
    premium: c.premium,
    riskScore: c.riskScore,
    active: c.active,
    claimed: c.claimed,
    premiumPaid,
    exists: !!c.dealAddress && c.dealAddress !== ZERO,
  };
}
