// scripts/lib/premium-pool-funding-config.cjs
/**
 * Pure validation, planning, and assertion logic for
 * Synq Premium Protection V1 Protection Pool Capitalization.
 *
 * Enforces:
 * - Sepolia network & chainId 11155111
 * - Exact canonical contract addresses from manifest
 * - Funding wallet strictly matches expected deployer/owner
 * - Correct approval spender is SynqProtectionPool (NOT Manager)
 * - Exact 6-decimal base-unit conversion (100 USDC = 100_000_000 base units)
 * - Exact approval amount (NEVER MaxUint256)
 * - Safe preflight readings and post-funding invariant assertions
 * - Zero private key exposure
 */

const fs = require('fs');
const path = require('path');

const SEPOLIA_CHAIN_ID = 11155111;
const PREMIUM_MANIFEST_PATH = path.join(__dirname, '..', '..', 'deployments', 'sepolia-premium-protection-v1.json');

const EXPECTED_CANONICAL_POOL = '0xA1f4991597869ba11EbD94edED4d69960063cbc2';
const EXPECTED_CANONICAL_MANAGER = '0xEbD3654548371f2dc2d1420226b99983a42e2FE8';
const EXPECTED_CANONICAL_COMMITTEE = '0x8e77aFf09Dd37EEa35d2931Ac1aA624abBF94e12';
const EXPECTED_CANONICAL_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const EXPECTED_FUNDING_WALLET = '0xD2D4d415a4730b1490c9Ce27944529B83ff76319';

const TARGET_CAPITALIZATION_USDC = 10n;
const USDC_DECIMALS = 6n;
const TARGET_CAPITALIZATION_BASE_UNITS = 10_000_000n; // 10 * 10^6

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;

function isValidAddress(addr) {
  if (typeof addr !== 'string') return false;
  if (!/^0[xX][0-9a-fA-F]{40}$/.test(addr)) return false;
  if (addr.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return false;
  return true;
}

function normalizeAddress(addr) {
  if (!isValidAddress(addr)) {
    throw new Error(`Invalid non-zero Ethereum address: "${addr}"`);
  }
  return addr.toLowerCase();
}

/**
 * Converts integer USDC to 6-decimal base units using BigInt arithmetic only.
 * Prohibits floating point math.
 */
function toUsdcBaseUnits(amountUsdc) {
  if (amountUsdc === undefined || amountUsdc === null || amountUsdc === '') {
    throw new Error('USDC amount is required');
  }

  let bigAmount;
  if (typeof amountUsdc === 'bigint') {
    bigAmount = amountUsdc;
  } else if (typeof amountUsdc === 'number') {
    if (!Number.isInteger(amountUsdc) || amountUsdc < 0) {
      throw new Error(`USDC amount must be a positive integer, got ${amountUsdc}`);
    }
    bigAmount = BigInt(amountUsdc);
  } else if (typeof amountUsdc === 'string') {
    if (!/^\d+$/.test(amountUsdc.trim())) {
      throw new Error(`USDC amount must be an integer string, got "${amountUsdc}"`);
    }
    bigAmount = BigInt(amountUsdc.trim());
  } else {
    throw new Error(`Unsupported amount type: ${typeof amountUsdc}`);
  }

  if (bigAmount <= 0n) {
    throw new Error(`USDC amount must be greater than zero, got ${bigAmount}`);
  }

  return bigAmount * (10n ** USDC_DECIMALS);
}

/**
 * Formats base units to human-readable USDC string.
 */
function formatUsdc(baseUnits) {
  const units = BigInt(baseUnits);
  const divisor = 10n ** USDC_DECIMALS;
  const whole = units / divisor;
  const fraction = units % divisor;
  const fracPadded = fraction.toString().padStart(6, '0').replace(/0+$/, '') || '0';
  return `${whole}.${fracPadded} USDC`;
}

/**
 * Strictly verifies network configuration and observed provider chainId.
 */
function assertSepoliaNetwork(configuredNetworkName, observedChainId) {
  if (configuredNetworkName !== 'sepolia') {
    throw new Error(
      `NETWORK HARD STOP: Synq Premium Protection capitalization requires network 'sepolia', got '${configuredNetworkName}'. Use --network sepolia.`
    );
  }

  const numericChainId = Number(observedChainId);
  if (numericChainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `NETWORK HARD STOP: Synq Premium Protection capitalization strictly refuses to execute on chainId ${numericChainId}. Only Sepolia (${SEPOLIA_CHAIN_ID}) is supported.`
    );
  }

  return true;
}

/**
 * Loads and validates canonical deployment addresses from deployments/sepolia-premium-protection-v1.json.
 */
function loadAndValidatePremiumManifest(manifestPath = PREMIUM_MANIFEST_PATH) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Premium Protection deployment manifest not found at: ${manifestPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse Premium Protection manifest at ${manifestPath}: ${err.message}`);
  }

  if (manifest.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `MANIFEST MISMATCH: Expected chainId ${SEPOLIA_CHAIN_ID}, manifest has ${manifest.chainId}`
    );
  }

  const pool = manifest.contracts?.protectionPool;
  if (!pool || pool.toLowerCase() !== EXPECTED_CANONICAL_POOL.toLowerCase()) {
    throw new Error(
      `MANIFEST MISMATCH: Expected ProtectionPool ${EXPECTED_CANONICAL_POOL}, manifest has ${pool}`
    );
  }

  const manager = manifest.contracts?.protectionManager;
  if (!manager || manager.toLowerCase() !== EXPECTED_CANONICAL_MANAGER.toLowerCase()) {
    throw new Error(
      `MANIFEST MISMATCH: Expected ProtectionManager ${EXPECTED_CANONICAL_MANAGER}, manifest has ${manager}`
    );
  }

  const usdc = manifest.dependencies?.canonicalUsdc;
  if (!usdc || usdc.toLowerCase() !== EXPECTED_CANONICAL_USDC.toLowerCase()) {
    throw new Error(
      `MANIFEST MISMATCH: Expected canonical USDC ${EXPECTED_CANONICAL_USDC}, manifest has ${usdc}`
    );
  }

  return {
    chainId: manifest.chainId,
    pool: EXPECTED_CANONICAL_POOL,
    manager: EXPECTED_CANONICAL_MANAGER,
    usdc: EXPECTED_CANONICAL_USDC,
    manifestPath,
  };
}

/**
 * Asserts funding signer matches expected canonical funding wallet.
 */
function assertFundingSigner(actualSignerAddress, expectedWallet = EXPECTED_FUNDING_WALLET) {
  if (!isValidAddress(actualSignerAddress)) {
    throw new Error(`Funding signer address is invalid or missing: "${actualSignerAddress}"`);
  }
  if (!isValidAddress(expectedWallet)) {
    throw new Error(`Expected funding wallet address is invalid or missing: "${expectedWallet}"`);
  }
  if (actualSignerAddress.toLowerCase() !== expectedWallet.toLowerCase()) {
    throw new Error(
      `SIGNER HARD STOP: Funding wallet does not match canonical Synq deployment owner.\n` +
      `Expected wallet: ${expectedWallet}\n` +
      `Actual signer:   ${actualSignerAddress}`
    );
  }
  return true;
}

/**
 * Builds the exact transaction plan for pool capitalization.
 */
function buildFundingPlan(params) {
  const {
    poolAddress,
    usdcAddress,
    signerAddress,
    currentAllowance,
    currentBalance,
    targetAmountBaseUnits = TARGET_CAPITALIZATION_BASE_UNITS,
  } = params;

  if (targetAmountBaseUnits <= 0n) {
    throw new Error('Target capitalization amount must be greater than zero');
  }

  // Preflight solvency check
  const hasSufficientBalance = currentBalance >= targetAmountBaseUnits;
  const balanceDeficit = hasSufficientBalance ? 0n : (targetAmountBaseUnits - currentBalance);

  // Exact spender check - derived directly from SynqProtectionPool.sol safeTransferFrom(msg.sender, address(this), amount)
  const spenderAddress = poolAddress;

  // Allowance check
  const needsApproval = currentAllowance < targetAmountBaseUnits;
  const approvalAmount = needsApproval ? targetAmountBaseUnits : 0n;

  // Planned transactions
  const plannedTransactions = [];

  if (needsApproval) {
    plannedTransactions.push({
      step: 1,
      target: usdcAddress,
      call: 'approve(address spender, uint256 amount)',
      description: 'Approve exact USDC base units to ProtectionPool',
      spender: spenderAddress,
      amount: targetAmountBaseUnits,
      amountFormatted: formatUsdc(targetAmountBaseUnits),
      isMaxUint256: false,
    });
  }

  plannedTransactions.push({
    step: needsApproval ? 2 : 1,
    target: poolAddress,
    call: 'fundPool(uint256 amount)',
    description: 'Deposit canonical USDC into ProtectionPool',
    amount: targetAmountBaseUnits,
    amountFormatted: formatUsdc(targetAmountBaseUnits),
  });

  return {
    targetAmountBaseUnits,
    targetAmountFormatted: formatUsdc(targetAmountBaseUnits),
    signerAddress,
    poolAddress,
    usdcAddress,
    spenderAddress,
    currentBalance,
    currentBalanceFormatted: formatUsdc(currentBalance),
    currentAllowance,
    currentAllowanceFormatted: formatUsdc(currentAllowance),
    hasSufficientBalance,
    balanceDeficit,
    needsApproval,
    approvalAmount,
    plannedTransactions,
  };
}

/**
 * Validates preflight contract readings against canonical expectations.
 */
function verifyPreflightReadings(readings, options = {}) {
  const { enforceSolvency = true } = options;
  const {
    walletBalance,
    currentAllowance,
    poolAvailableBalance,
    poolRawBalance,
    poolUsdc,
    poolManager,
    poolOwner,
    expectedUsdc = EXPECTED_CANONICAL_USDC,
    expectedManager = EXPECTED_CANONICAL_MANAGER,
    expectedOwner = EXPECTED_FUNDING_WALLET,
    targetAmountBaseUnits = TARGET_CAPITALIZATION_BASE_UNITS,
  } = readings;

  // Invariant 1: pool.usdc() must match canonical USDC
  if (poolUsdc.toLowerCase() !== expectedUsdc.toLowerCase()) {
    throw new Error(`Preflight assertion failed: pool.usdc() ${poolUsdc} != expected ${expectedUsdc}`);
  }

  // Invariant 2: pool.manager() must match canonical Manager
  if (poolManager.toLowerCase() !== expectedManager.toLowerCase()) {
    throw new Error(`Preflight assertion failed: pool.manager() ${poolManager} != expected ${expectedManager}`);
  }

  // Invariant 3: pool.owner() must match expected owner
  if (poolOwner.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error(`Preflight assertion failed: pool.owner() ${poolOwner} != expected ${expectedOwner}`);
  }

  // Invariant 4: pool.availableBalance() must equal raw USDC.balanceOf(pool)
  if (poolAvailableBalance !== poolRawBalance) {
    throw new Error(
      `Preflight assertion failed: pool.availableBalance() (${poolAvailableBalance}) != raw USDC.balanceOf(pool) (${poolRawBalance})`
    );
  }

  // Invariant 5: funding wallet must have at least targetAmountBaseUnits
  if (enforceSolvency && walletBalance < targetAmountBaseUnits) {
    throw new Error(
      `BLOCKER: Funding wallet has insufficient USDC balance.\n` +
      `Required: ${formatUsdc(targetAmountBaseUnits)} (${targetAmountBaseUnits} base units)\n` +
      `Current:  ${formatUsdc(walletBalance)} (${walletBalance} base units)\n` +
      `Deficit:  ${formatUsdc(targetAmountBaseUnits - walletBalance)}`
    );
  }

  return true;
}

/**
 * Verifies post-funding state assertions after a live capitalization.
 */
function verifyPostFundingAssertions(beforeState, afterState, fundedAmountBaseUnits = TARGET_CAPITALIZATION_BASE_UNITS) {
  // 1. Available balance increment
  const expectedAvailable = beforeState.poolAvailableBalance + fundedAmountBaseUnits;
  if (afterState.poolAvailableBalance !== expectedAvailable) {
    throw new Error(
      `Post-funding assertion failed: pool.availableBalance() expected ${expectedAvailable}, got ${afterState.poolAvailableBalance}`
    );
  }

  // 2. Raw USDC balance increment
  const expectedRaw = beforeState.poolRawBalance + fundedAmountBaseUnits;
  if (afterState.poolRawBalance !== expectedRaw) {
    throw new Error(
      `Post-funding assertion failed: USDC.balanceOf(pool) expected ${expectedRaw}, got ${afterState.poolRawBalance}`
    );
  }

  // 3. Pool manager immutability
  if (afterState.poolManager.toLowerCase() !== beforeState.poolManager.toLowerCase()) {
    throw new Error('Post-funding assertion failed: pool.manager() mutated during capitalization');
  }

  // 4. Pool owner immutability
  if (afterState.poolOwner.toLowerCase() !== beforeState.poolOwner.toLowerCase()) {
    throw new Error('Post-funding assertion failed: pool.owner() mutated during capitalization');
  }

  // 5. Pool USDC address immutability
  if (afterState.poolUsdc.toLowerCase() !== beforeState.poolUsdc.toLowerCase()) {
    throw new Error('Post-funding assertion failed: pool.usdc() mutated during capitalization');
  }

  // 6. Manager economic parameters unchanged
  if (afterState.managerFeeBps !== beforeState.managerFeeBps) {
    throw new Error('Post-funding assertion failed: manager.premiumFeeBps mutated during pool capitalization');
  }
  if (afterState.managerCoverageBps !== beforeState.managerCoverageBps) {
    throw new Error('Post-funding assertion failed: manager.COVERAGE_RATE_BPS mutated during pool capitalization');
  }

  return true;
}

module.exports = {
  SEPOLIA_CHAIN_ID,
  PREMIUM_MANIFEST_PATH,
  EXPECTED_CANONICAL_POOL,
  EXPECTED_CANONICAL_MANAGER,
  EXPECTED_CANONICAL_COMMITTEE,
  EXPECTED_CANONICAL_USDC,
  EXPECTED_FUNDING_WALLET,
  TARGET_CAPITALIZATION_USDC,
  USDC_DECIMALS,
  TARGET_CAPITALIZATION_BASE_UNITS,
  ZERO_ADDRESS,
  MAX_UINT256,
  isValidAddress,
  normalizeAddress,
  toUsdcBaseUnits,
  formatUsdc,
  assertSepoliaNetwork,
  loadAndValidatePremiumManifest,
  assertFundingSigner,
  buildFundingPlan,
  verifyPreflightReadings,
  verifyPostFundingAssertions,
};
