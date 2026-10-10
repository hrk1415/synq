/**
 * Synq Premium Protection V1 Client & Server Helper Module (Phase 4B)
 *
 * Implements pure math, policy parsing, and deployment-safe preflight validation
 * for post-funding Premium Protection policies.
 *
 * Cryptographically decoupled from Standard V2 core deal escrow.
 */

import { getAddress, isAddress } from 'viem';
import { ZERO_ADDRESS } from '@/lib/deals/v2';
import {
  synqPremiumProtectionManagerABI,
  synqPremiumProtectionManagerV1_1ABI,
  synqProtectionPoolABI,
  erc20ABI,
} from '@/lib/contracts/abis';
import { SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { DealState, MilestoneStatus } from '@/lib/deals/v2-deal';

export const BPS_DENOMINATOR = 10000n;
export const DEFAULT_COVERAGE_RATE_BPS = 2000n; // 20%
export const MAX_PROTECTED_MILESTONES = 16;

export type PremiumManagerVersion = 'V1' | 'V1_1';

export interface PremiumPolicyState {
  client?: `0x${string}`;
  purchasedAt: bigint;
  premiumPaid: bigint;
  maxCoverage: bigint;
  totalPaid: bigint;
  active: boolean;
  coveredBitmap?: number;
  eligiblePrincipal?: bigint;
  version?: PremiumManagerVersion;
}

export interface MilestoneEligibilityInfo {
  index: number;
  amount: bigint;
  status: number;
  workDeadline: bigint;
  gracePeriod: bigint;
  isEligible: boolean;
  reason: string;
}

export interface MilestoneEligibilityResult {
  eligibleCount: number;
  totalCount: number;
  eligiblePrincipal: bigint;
  coveredBitmap: number;
  milestones: MilestoneEligibilityInfo[];
}

export interface PremiumManagerParameters {
  premiumFeeBps: number;
  coverageRateBps: number;
  maxMilestones?: number;
  version?: PremiumManagerVersion;
}

/**
 * Evaluates purchase-time eligibility across deal milestones.
 * Enforces V1.1 rules:
 * - Milestone must be in Pending status
 * - block.timestamp <= workDeadline + gracePeriod
 * - amount > 0
 * - index < 16
 */
export function calculateEligibleMilestones(
  milestones: readonly {
    amount: bigint;
    workDeadline: bigint;
    gracePeriod: bigint;
    status: number;
  }[],
  currentTimeSeconds?: bigint
): MilestoneEligibilityResult {
  if (milestones.length > MAX_PROTECTED_MILESTONES) {
    throw new Error(`Milestone count ${milestones.length} exceeds maximum ${MAX_PROTECTED_MILESTONES}`);
  }
  const now = currentTimeSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  let eligibleCount = 0;
  let eligiblePrincipal = 0n;
  let coveredBitmap = 0;

  const milestoneResults: MilestoneEligibilityInfo[] = milestones.map((m, index) => {
    const expiryThreshold = m.workDeadline + m.gracePeriod;
    const isUnexpired = now <= expiryThreshold;
    const isPending = m.status === MilestoneStatus.Pending;
    const hasAmount = m.amount > 0n;
    const withinCap = index < MAX_PROTECTED_MILESTONES;

    let isEligible = false;
    let reason = '';

    if (index >= MAX_PROTECTED_MILESTONES) {
      reason = 'Not eligible — milestone index exceeds maximum 16';
    } else if (m.status === MilestoneStatus.InProgress) {
      reason = 'Not eligible — work already started';
    } else if (m.status === MilestoneStatus.Submitted) {
      reason = 'Not eligible — work already submitted';
    } else if (m.status === MilestoneStatus.RevisionRequested) {
      reason = 'Not eligible — revision in progress';
    } else if (m.status === MilestoneStatus.Disputed) {
      reason = 'Not eligible — dispute active';
    } else if (
      m.status === MilestoneStatus.ResolutionProposed ||
      m.status === MilestoneStatus.FinalReview
    ) {
      reason = 'Not eligible — resolution in progress';
    } else if (
      m.status === MilestoneStatus.SettledPaid ||
      m.status === MilestoneStatus.SettledRefunded ||
      m.status === MilestoneStatus.SettledSplit
    ) {
      reason = 'Not eligible — milestone already settled';
    } else if (
      m.status === MilestoneStatus.AssessmentPending ||
      m.status === MilestoneStatus.AssessmentProposed
    ) {
      reason = 'Not eligible — assessment in progress';
    } else if (!isUnexpired) {
      reason = 'Not eligible — deadline elapsed';
    } else if (!hasAmount) {
      reason = 'Not eligible — zero escrow amount';
    } else if (isPending && isUnexpired && hasAmount && withinCap) {
      isEligible = true;
      reason = 'Eligible for Premium Protection';
    } else {
      reason = 'Not eligible for protection';
    }

    if (isEligible) {
      eligibleCount++;
      eligiblePrincipal += m.amount;
      coveredBitmap |= 1 << index;
    }

    return {
      index,
      amount: m.amount,
      status: m.status,
      workDeadline: m.workDeadline,
      gracePeriod: m.gracePeriod,
      isEligible,
      reason,
    };
  });

  return {
    eligibleCount,
    totalCount: milestones.length,
    eligiblePrincipal,
    coveredBitmap,
    milestones: milestoneResults,
  };
}

/**
 * Calculates exact USDC premium fee using integer floor division matching Solidity.
 * Formula: (principal * premiumFeeBps) / 10000
 */
export function calculatePremiumFee(
  principal: bigint,
  premiumFeeBps: number | bigint
): bigint {
  if (principal <= 0n) return 0n;
  const feeBps = BigInt(premiumFeeBps);
  if (feeBps <= 0n) return 0n;
  return (principal * feeBps) / BPS_DENOMINATOR;
}

/**
 * Calculates maximum USDC protection coverage using integer floor division matching Solidity.
 * Formula: (principal * coverageRateBps) / 10000
 */
export function calculateMaximumCoverage(
  principal: bigint,
  coverageRateBps: number | bigint = DEFAULT_COVERAGE_RATE_BPS
): bigint {
  if (principal <= 0n) return 0n;
  const rateBps = BigInt(coverageRateBps);
  if (rateBps <= 0n) return 0n;
  return (principal * rateBps) / BPS_DENOMINATOR;
}

function isValidContractAddress(val: string | null | undefined): val is string {
  if (!val || typeof val !== 'string') return false;
  const lower = val.toLowerCase();
  return isAddress(lower) && lower !== ZERO_ADDRESS.toLowerCase();
}

/**
 * Deterministically detects the version of a configured Premium Protection Manager.
 * - 'V1_1': implements MAX_MILESTONES() returning 16 and COVERAGE_RATE_BPS() returning 2000.
 * - 'V1': implements COVERAGE_RATE_BPS() returning 2000 and valid pool(), but MAX_MILESTONES() reverts.
 * - Unknown / incompatible contracts: fails closed and returns null.
 * - Does not query zero addresses or perform mutations.
 */
export async function detectPremiumManagerVersion(
  publicClient: any,
  managerAddress: string | null | undefined
): Promise<PremiumManagerVersion | null> {
  if (!isValidContractAddress(managerAddress)) {
    return null;
  }

  const checksummed = getAddress(managerAddress.toLowerCase());

  // 1. Probe for V1.1 via MAX_MILESTONES()
  try {
    const maxMilestones = await publicClient.readContract({
      address: checksummed,
      abi: [
        {
          inputs: [],
          name: 'MAX_MILESTONES',
          outputs: [{ name: '', type: 'uint256' }],
          stateMutability: 'view',
          type: 'function',
        },
      ],
      functionName: 'MAX_MILESTONES',
    });

    if (BigInt(maxMilestones) === 16n) {
      const coverageBps = await publicClient.readContract({
        address: checksummed,
        abi: synqPremiumProtectionManagerV1_1ABI,
        functionName: 'COVERAGE_RATE_BPS',
      });
      if (Number(coverageBps) === 2000) {
        return 'V1_1';
      }
    }
  } catch {
    // MAX_MILESTONES selector does not exist or reverted; check V1 below
  }

  // 2. Probe for V1: must implement COVERAGE_RATE_BPS and pool()
  try {
    const [coverageBps, poolAddr] = await Promise.all([
      publicClient.readContract({
        address: checksummed,
        abi: synqPremiumProtectionManagerABI,
        functionName: 'COVERAGE_RATE_BPS',
      }),
      publicClient.readContract({
        address: checksummed,
        abi: [
          {
            inputs: [],
            name: 'pool',
            outputs: [{ name: '', type: 'address' }],
            stateMutability: 'view',
            type: 'function',
          },
        ],
        functionName: 'pool',
      }),
    ]);

    if (
      Number(coverageBps) === 2000 &&
      typeof poolAddr === 'string' &&
      isAddress(poolAddr) &&
      poolAddr.toLowerCase() !== ZERO_ADDRESS.toLowerCase()
    ) {
      return 'V1';
    }
  } catch {
    // Incompatible or non-manager contract
  }

  // Fail closed
  return null;
}

/**
 * Reads manager protocol parameters from chain safely.
 * Returns null if manager address is unconfigured or zero.
 */
export async function readPremiumManagerParameters(
  publicClient: any,
  managerAddress: string | null | undefined,
  knownVersion?: PremiumManagerVersion | null
): Promise<PremiumManagerParameters | null> {
  if (!isValidContractAddress(managerAddress)) {
    return null;
  }

  const version = knownVersion ?? (await detectPremiumManagerVersion(publicClient, managerAddress));
  if (!version) {
    return null;
  }

  const checksummed = getAddress(managerAddress.toLowerCase());

  if (version === 'V1_1') {
    try {
      const [feeBps, coverageBps, maxMilestones] = await Promise.all([
        publicClient.readContract({
          address: checksummed,
          abi: synqPremiumProtectionManagerV1_1ABI,
          functionName: 'premiumFeeBps',
        }) as Promise<number>,
        publicClient.readContract({
          address: checksummed,
          abi: synqPremiumProtectionManagerV1_1ABI,
          functionName: 'COVERAGE_RATE_BPS',
        }) as Promise<number>,
        publicClient.readContract({
          address: checksummed,
          abi: synqPremiumProtectionManagerV1_1ABI,
          functionName: 'MAX_MILESTONES',
        }) as Promise<bigint>,
      ]);

      return {
        premiumFeeBps: Number(feeBps),
        coverageRateBps: Number(coverageBps),
        maxMilestones: Number(maxMilestones),
        version: 'V1_1',
      };
    } catch (err) {
      console.warn('[v2-protection] Error reading V1.1 manager parameters:', err);
      return null;
    }
  }

  // Version V1
  try {
    const [feeBps, coverageBps] = await Promise.all([
      publicClient.readContract({
        address: checksummed,
        abi: synqPremiumProtectionManagerABI,
        functionName: 'premiumFeeBps',
      }) as Promise<number>,
      publicClient.readContract({
        address: checksummed,
        abi: synqPremiumProtectionManagerABI,
        functionName: 'COVERAGE_RATE_BPS',
      }) as Promise<number>,
    ]);

    return {
      premiumFeeBps: Number(feeBps),
      coverageRateBps: Number(coverageBps),
      version: 'V1',
    };
  } catch (err) {
    console.warn('[v2-protection] Error reading V1 manager parameters:', err);
    return null;
  }
}

/**
 * Reads existing policy for a deal from the Premium Manager contract.
 * Returns null if manager address is unconfigured or zero address.
 */
export async function readDealPremiumPolicy(
  publicClient: any,
  managerAddress: string | null | undefined,
  dealAddress: string,
  knownVersion?: PremiumManagerVersion | null
): Promise<PremiumPolicyState | null> {
  if (!isValidContractAddress(managerAddress) || !isValidContractAddress(dealAddress)) {
    return null;
  }

  const version = knownVersion ?? (await detectPremiumManagerVersion(publicClient, managerAddress));
  if (!version) {
    return null;
  }

  const checksummedManager = getAddress(managerAddress.toLowerCase());
  const checksummedDeal = getAddress(dealAddress.toLowerCase());

  if (version === 'V1_1') {
    try {
      const rawPolicy = (await publicClient.readContract({
        address: checksummedManager,
        abi: synqPremiumProtectionManagerV1_1ABI,
        functionName: 'getPolicy',
        args: [checksummedDeal],
      })) as {
        client: string;
        purchasedAt: bigint | number;
        coveredBitmap: number;
        active: boolean;
        eligiblePrincipal: bigint;
        premiumPaid: bigint;
        maxCoverage: bigint;
        totalPaid: bigint;
      };

      if (!rawPolicy) return null;

      return {
        client: isAddress(rawPolicy.client) ? getAddress(rawPolicy.client) : undefined,
        purchasedAt: BigInt(rawPolicy.purchasedAt),
        coveredBitmap: Number(rawPolicy.coveredBitmap),
        active: Boolean(rawPolicy.active),
        eligiblePrincipal: BigInt(rawPolicy.eligiblePrincipal),
        premiumPaid: BigInt(rawPolicy.premiumPaid),
        maxCoverage: BigInt(rawPolicy.maxCoverage),
        totalPaid: BigInt(rawPolicy.totalPaid),
        version: 'V1_1',
      };
    } catch (err) {
      console.warn('[v2-protection] Error reading V1.1 deal policy:', err);
      return null;
    }
  }

  // Version V1
  try {
    const rawPolicy = (await publicClient.readContract({
      address: checksummedManager,
      abi: synqPremiumProtectionManagerABI,
      functionName: 'getPolicy',
      args: [checksummedDeal],
    })) as {
      client: string;
      purchasedAt: bigint | number;
      premiumPaid: bigint;
      maxCoverage: bigint;
      totalPaid: bigint;
      active: boolean;
    };

    if (!rawPolicy) return null;

    return {
      client: isAddress(rawPolicy.client) ? getAddress(rawPolicy.client) : undefined,
      purchasedAt: BigInt(rawPolicy.purchasedAt),
      premiumPaid: BigInt(rawPolicy.premiumPaid),
      maxCoverage: BigInt(rawPolicy.maxCoverage),
      totalPaid: BigInt(rawPolicy.totalPaid),
      active: Boolean(rawPolicy.active),
      version: 'V1',
    };
  } catch (err) {
    console.warn('[v2-protection] Error reading V1 deal policy:', err);
    return null;
  }
}

/**
 * Reads client USDC allowance dedicated to the Premium Protection Manager.
 */
export async function readClientPremiumAllowance(
  publicClient: any,
  usdcAddress: string,
  clientAddress: string,
  managerAddress: string | null | undefined
): Promise<bigint> {
  if (
    !managerAddress ||
    !isAddress(managerAddress) ||
    managerAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase() ||
    !isAddress(clientAddress) ||
    !isAddress(usdcAddress)
  ) {
    return 0n;
  }

  try {
    const allowance = (await publicClient.readContract({
      address: getAddress(usdcAddress),
      abi: erc20ABI,
      functionName: 'allowance',
      args: [getAddress(clientAddress), getAddress(managerAddress)],
    })) as bigint;

    return BigInt(allowance);
  } catch (err) {
    console.warn('[v2-protection] Error reading premium allowance:', err);
    return 0n;
  }
}

/**
 * Reads available liquidity in the Protection Pool.
 */
export async function readPoolAvailableBalance(
  publicClient: any,
  poolAddress: string | null | undefined
): Promise<bigint> {
  if (
    !poolAddress ||
    !isAddress(poolAddress) ||
    poolAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()
  ) {
    return 0n;
  }

  try {
    const balance = (await publicClient.readContract({
      address: getAddress(poolAddress),
      abi: synqProtectionPoolABI,
      functionName: 'availableBalance',
    })) as bigint;

    return BigInt(balance);
  } catch (err) {
    console.warn('[v2-protection] Error reading pool balance:', err);
    return 0n;
  }
}

export interface PremiumApprovalPreflightParams {
  connectedWallet?: string;
  clientAddress: string;
  chainId?: number;
  managerAddress: string | null | undefined;
  dealState: DealState;
  premiumFee: bigint;
  balance: bigint;
}

export function validatePremiumApprovalPreflight(
  params: PremiumApprovalPreflightParams
): { valid: true } | { valid: false; error: string } {
  if (!params.connectedWallet || !isAddress(params.connectedWallet)) {
    return { valid: false, error: 'Please connect your wallet' };
  }
  if (params.connectedWallet.toLowerCase() !== params.clientAddress.toLowerCase()) {
    return { valid: false, error: 'Only the deal client can approve and activate Premium Protection' };
  }
  if (params.chainId !== SEPOLIA_CHAIN_ID) {
    return { valid: false, error: 'Please switch your wallet to Ethereum Sepolia' };
  }
  if (
    !params.managerAddress ||
    !isAddress(params.managerAddress) ||
    params.managerAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()
  ) {
    return { valid: false, error: 'Premium Protection contracts are not configured in this environment' };
  }
  if (params.dealState !== DealState.Active) {
    return { valid: false, error: 'Deal must be funded and active before Premium Protection can be purchased' };
  }
  if (params.premiumFee <= 0n) {
    return { valid: false, error: 'Invalid premium fee calculation' };
  }
  if (params.balance < params.premiumFee) {
    return { valid: false, error: 'Insufficient USDC balance to pay premium fee' };
  }
  return { valid: true };
}

export interface PremiumActivationPreflightParams {
  connectedWallet?: string;
  clientAddress: string;
  chainId?: number;
  managerAddress: string | null | undefined;
  dealState: DealState;
  premiumFee: bigint;
  balance: bigint;
  allowance: bigint;
  existingPolicy: PremiumPolicyState | null;
}

export function validatePremiumActivationPreflight(
  params: PremiumActivationPreflightParams
): { valid: true } | { valid: false; error: string } {
  const approvalValidation = validatePremiumApprovalPreflight({
    connectedWallet: params.connectedWallet,
    clientAddress: params.clientAddress,
    chainId: params.chainId,
    managerAddress: params.managerAddress,
    dealState: params.dealState,
    premiumFee: params.premiumFee,
    balance: params.balance,
  });

  if (!approvalValidation.valid) {
    return approvalValidation;
  }

  if (params.allowance < params.premiumFee) {
    return { valid: false, error: 'USDC allowance is insufficient. Please approve the premium fee first.' };
  }

  if (params.existingPolicy && (params.existingPolicy.active || params.existingPolicy.purchasedAt > 0n)) {
    return { valid: false, error: 'A Premium Protection policy already exists for this deal' };
  }

  return { valid: true };
}
