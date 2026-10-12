// scripts/fund-premium-protection-pool-sepolia.cjs
/**
 * Synq Premium Protection V1 — Protection Pool Capitalization Tooling
 * Target: Ethereum Sepolia (chainId: 11155111)
 *
 * Sequence:
 * 1. Strictly enforce Sepolia network and chainId 11155111
 * 2. Validate canonical dependencies from deployments/sepolia-premium-protection-v1.json
 * 3. Enforce funding signer == canonical deployment owner (0xD2D4d415a4730b1490c9Ce27944529B83ff76319)
 * 4. Perform exhaustive read-only preflight (balances, allowances, immutabilities)
 * 5. Derive exact approval spender from contract code: SynqProtectionPool (NOT Manager)
 * 6. Dry-run mode (default): prints plan, asserts parameters, halts safely with ZERO transactions
 * 7. Live mode: only executes after explicit --live flag, performs exact-amount approval and fundPool,
 *    and verifies post-funding state.
 *
 * NO automatic fallback wallets. NO floating-point math. NO private key exposure.
 */

// Ensure Sepolia is the default target network if executed via Node directly
if (!process.env.HARDHAT_NETWORK) {
  process.env.HARDHAT_NETWORK = 'sepolia';
}

const { ethers, network } = require('hardhat');
const fs = require('fs');
const path = require('path');
const {
  SEPOLIA_CHAIN_ID,
  PREMIUM_MANIFEST_PATH,
  EXPECTED_CANONICAL_POOL,
  EXPECTED_CANONICAL_MANAGER,
  EXPECTED_CANONICAL_USDC,
  EXPECTED_FUNDING_WALLET,
  TARGET_CAPITALIZATION_USDC,
  TARGET_CAPITALIZATION_BASE_UNITS,
  formatUsdc,
  toUsdcBaseUnits,
  assertSepoliaNetwork,
  loadAndValidatePremiumManifest,
  assertFundingSigner,
  buildFundingPlan,
  verifyPreflightReadings,
  verifyPostFundingAssertions,
} = require('./lib/premium-pool-funding-config.cjs');

// Minimal ABIs for read/write
const ERC20_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
];

const POOL_ABI = [
  'function usdc() external view returns (address)',
  'function manager() external view returns (address)',
  'function owner() external view returns (address)',
  'function availableBalance() external view returns (uint256)',
  'function fundPool(uint256 amount) external',
];

const MANAGER_ABI = [
  'function owner() external view returns (address)',
  'function factory() external view returns (address)',
  'function usdc() external view returns (address)',
  'function pool() external view returns (address)',
  'function protectionCommittee() external view returns (address)',
  'function premiumFeeBps() external view returns (uint256)',
  'function COVERAGE_RATE_BPS() external view returns (uint256)',
];

function getArgValue(flag) {
  const prefix = `${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

async function main() {
  console.log('====================================================');
  console.log('  SYNQ PREMIUM PROTECTION POOL CAPITALIZATION');
  console.log('====================================================\n');

  const isLive = process.argv.includes('--live') || process.env.SYNQ_POOL_FUNDING_LIVE === 'true';
  const isDryRun = !isLive || process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

  // --- Network Hard Stop ---
  const configuredNetwork = network.name;
  const net = await ethers.provider.getNetwork();
  const observedChainId = Number(net.chainId);

  assertSepoliaNetwork(configuredNetwork, observedChainId);

  // --- Validate Manifest & Canonical Addresses ---
  const manifestData = loadAndValidatePremiumManifest();

  // --- Determine Signer Safely ---
  let fundingSigner = null;
  let signerAddress = null;

  const rawPrivateKey = process.env.SEPOLIA_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (rawPrivateKey && typeof rawPrivateKey === 'string' && rawPrivateKey.trim().length > 0) {
    try {
      fundingSigner = new ethers.Wallet(rawPrivateKey.trim(), ethers.provider);
      signerAddress = fundingSigner.address;
    } catch (err) {
      throw new Error(`Failed to initialize funding wallet from private key: ${err.message}`);
    }
  } else {
    try {
      const signers = await ethers.getSigners();
      if (signers && signers.length > 0) {
        fundingSigner = signers[0];
        signerAddress = fundingSigner.address;
      }
    } catch {
      // offline / keyless
    }
  }

  if (!signerAddress) {
    throw new Error('Signer could not be resolved. Ensure SEPOLIA_PRIVATE_KEY is configured in .env.local.');
  }

  // --- Enforce Signer Identity ---
  assertFundingSigner(signerAddress, EXPECTED_FUNDING_WALLET);

  // --- Attach Contracts ---
  const usdc = new ethers.Contract(manifestData.usdc, ERC20_ABI, ethers.provider);
  const pool = new ethers.Contract(manifestData.pool, POOL_ABI, ethers.provider);
  const manager = new ethers.Contract(manifestData.manager, MANAGER_ABI, ethers.provider);

  // --- Preflight Readings ---
  console.log('Performing read-only preflight checks against Sepolia...\n');

  const [
    walletBalance,
    currentAllowance,
    poolAvailableBalance,
    poolRawBalance,
    poolUsdc,
    poolManager,
    poolOwner,
    managerFeeBps,
    managerCoverageBps,
  ] = await Promise.all([
    usdc.balanceOf(signerAddress),
    usdc.allowance(signerAddress, manifestData.pool),
    pool.availableBalance(),
    usdc.balanceOf(manifestData.pool),
    pool.usdc(),
    pool.manager(),
    pool.owner(),
    manager.premiumFeeBps(),
    manager.COVERAGE_RATE_BPS(),
  ]);

  // --- Validate Contract Invariants ---
  verifyPreflightReadings(
    {
      walletBalance: BigInt(walletBalance),
      currentAllowance: BigInt(currentAllowance),
      poolAvailableBalance: BigInt(poolAvailableBalance),
      poolRawBalance: BigInt(poolRawBalance),
      poolUsdc,
      poolManager,
      poolOwner,
      expectedUsdc: manifestData.usdc,
      expectedManager: manifestData.manager,
      expectedOwner: EXPECTED_FUNDING_WALLET,
      targetAmountBaseUnits: TARGET_CAPITALIZATION_BASE_UNITS,
    },
    { enforceSolvency: false }
  );

  // --- Build Funding Plan ---
  const plan = buildFundingPlan({
    poolAddress: manifestData.pool,
    usdcAddress: manifestData.usdc,
    signerAddress,
    currentAllowance: BigInt(currentAllowance),
    currentBalance: BigInt(walletBalance),
    targetAmountBaseUnits: TARGET_CAPITALIZATION_BASE_UNITS,
  });

  // --- Display Preflight and Plan ---
  console.log(`Execution Mode:            ${isDryRun ? 'DRY-RUN (Preflight Inspection Only)' : 'LIVE SEPOLIA CAPITALIZATION'}`);
  console.log(`Configured Network:        ${configuredNetwork}`);
  console.log(`Observed Provider ChainId: ${observedChainId}`);
  console.log(`Target Network:            sepolia (chainId: ${SEPOLIA_CHAIN_ID})`);
  console.log(`Observed Funding Signer:   ${signerAddress}`);
  console.log(`Canonical Expected Wallet: ${EXPECTED_FUNDING_WALLET}`);
  console.log(`Canonical Pool Contract:   ${manifestData.pool}`);
  console.log(`Canonical Manager Contract:${manifestData.manager}`);
  console.log(`Canonical Sepolia USDC:    ${manifestData.usdc}`);
  console.log('');
  console.log('Current On-Chain State:');
  console.log(`  - Signer USDC Balance:   ${plan.currentBalanceFormatted} (${plan.currentBalance} base units)`);
  console.log(`  - Pool Available Balance:${formatUsdc(poolAvailableBalance)} (${poolAvailableBalance} base units)`);
  console.log(`  - Pool Raw USDC Balance: ${formatUsdc(poolRawBalance)} (${poolRawBalance} base units)`);
  console.log(`  - Existing Pool Allowance:${plan.currentAllowanceFormatted} (${plan.currentAllowance} base units)`);
  console.log(`  - Pool USDC Wire:        ${poolUsdc}`);
  console.log(`  - Pool Manager Wire:     ${poolManager}`);
  console.log(`  - Pool Owner:            ${poolOwner}`);
  console.log(`  - Manager Premium Fee:   ${managerFeeBps} bps (${Number(managerFeeBps) / 100}%)`);
  console.log(`  - Manager Coverage Rate: ${managerCoverageBps} bps (${Number(managerCoverageBps) / 100}%)`);
  console.log('');
  console.log('Capitalization Parameters:');
  console.log(`  - Target Capitalization: ${plan.targetAmountFormatted} (${plan.targetAmountBaseUnits} base units)`);
  console.log(`  - Exact Spender:         ${plan.spenderAddress} (SynqProtectionPool)`);
  console.log(`  - Approval Required:     ${plan.needsApproval ? `YES (Current allowance < ${plan.targetAmountFormatted})` : 'NO (Existing allowance is sufficient)'}`);
  console.log('');
  console.log('Planned Transaction Sequence:');
  for (const tx of plan.plannedTransactions) {
    console.log(`  Step ${tx.step}: ${tx.description}`);
    console.log(`          Target: ${tx.target}`);
    console.log(`          Call:   ${tx.call}`);
    if (tx.spender) {
      console.log(`          Spender: ${tx.spender}`);
    }
    console.log(`          Amount:  ${tx.amountFormatted} (${tx.amount} base units)`);
    if (tx.isMaxUint256 !== undefined) {
      console.log(`          MaxUint256 Used: ${tx.isMaxUint256 ? 'YES' : 'NO (Exact Amount Only)'}`);
    }
  }
  console.log('');
  console.log('Expected Post-Funding Invariants:');
  console.log(`  - Expected Pool Available: ${formatUsdc(BigInt(poolAvailableBalance) + plan.targetAmountBaseUnits)}`);
  console.log(`  - Expected Pool Raw USDC:  ${formatUsdc(BigInt(poolRawBalance) + plan.targetAmountBaseUnits)}`);
  console.log('  - Pool Manager:            Unchanged');
  console.log('  - Pool Owner:              Unchanged');
  console.log('  - Pool USDC Address:       Unchanged');
  console.log('  - Policies Created:        ZERO (Capitalization creates zero policies)');
  console.log('\n');

  // --- Check Solvency Blocker ---
  if (!plan.hasSufficientBalance) {
    console.log('====================================================');
    console.log('  [!] CAPITALIZATION BLOCKER DETECTED');
    console.log('====================================================');
    console.log('Funding wallet has insufficient USDC balance:');
    console.log(`  - Required: ${plan.targetAmountFormatted} (${plan.targetAmountBaseUnits} base units)`);
    console.log(`  - Current:  ${plan.currentBalanceFormatted} (${plan.currentBalance} base units)`);
    console.log(`  - Deficit:  ${formatUsdc(plan.balanceDeficit)} (${plan.balanceDeficit} base units)`);
    console.log('\nSAFETY RULE ENFORCEMENT:');
    console.log('  - DO NOT attempt to obtain additional USDC.');
    console.log('  - REPORT BLOCKER TO OPERATOR.');
    console.log('  - EXECUTION HALTED BEFORE ANY TRANSACTION CONSTRUCTION.');
    console.log('====================================================\n');
  }

  // --- DRY RUN HALT ---
  if (isDryRun) {
    console.log('====================================================');
    console.log('  DRY RUN ONLY — NO TRANSACTIONS BROADCAST');
    console.log('  ZERO USDC TRANSFERRED — ZERO APPROVALS EXECUTED');
    console.log('====================================================');
    return {
      status: plan.hasSufficientBalance ? 'dry-run-completed' : 'blocked-insufficient-balance',
      plan,
      readings: {
        walletBalance: BigInt(walletBalance),
        currentAllowance: BigInt(currentAllowance),
        poolAvailableBalance: BigInt(poolAvailableBalance),
        poolRawBalance: BigInt(poolRawBalance),
        poolUsdc,
        poolManager,
        poolOwner,
        managerFeeBps: Number(managerFeeBps),
        managerCoverageBps: Number(managerCoverageBps),
      },
    };
  }

  // --- LIVE CAPITALIZATION (Future Explicit Instruction Only) ---
  if (!plan.hasSufficientBalance) {
    throw new Error(
      `BLOCKER: Cannot proceed with live funding. Insufficient USDC balance (deficit: ${formatUsdc(plan.balanceDeficit)}).`
    );
  }
  if (!fundingSigner) {
    throw new Error('Funding signer with private key is required for live capitalization.');
  }

  console.log('Broadcasting live capitalization transactions to Sepolia...\n');

  const usdcWithSigner = usdc.connect(fundingSigner);
  const poolWithSigner = pool.connect(fundingSigner);

  let approveTx = null;
  let approveReceipt = null;

  // Step 1: Approve (if needed)
  if (plan.needsApproval) {
    console.log(`[1/2] Approving exact ${plan.targetAmountFormatted} to ProtectionPool...`);
    approveTx = await usdcWithSigner.approve(plan.spenderAddress, plan.targetAmountBaseUnits);
    console.log(`      Approve Tx broadcast: ${approveTx.hash}`);
    approveReceipt = await approveTx.wait(1);
    console.log(`      Approve confirmed. Status: ${approveReceipt.status === 1 ? 'SUCCESS (1)' : approveReceipt.status}`);

    // Verify allowance on-chain before proceeding to fundPool
    const verifiedAllowance = await usdc.allowance(signerAddress, plan.spenderAddress);
    if (BigInt(verifiedAllowance) < plan.targetAmountBaseUnits) {
      throw new Error(
        `Approval verification failed: allowance is ${formatUsdc(verifiedAllowance)}, expected >= ${plan.targetAmountFormatted}`
      );
    }
    console.log(`      Verified allowance on-chain: ${formatUsdc(verifiedAllowance)} (${verifiedAllowance} base units).\n`);
  } else {
    console.log(`[1/2] Existing allowance of ${plan.currentAllowanceFormatted} is sufficient. Skipping approval.\n`);
  }

  // Step 2: fundPool
  const fundStepNum = plan.needsApproval ? 2 : 1;
  console.log(`[${fundStepNum}/${plan.plannedTransactions.length}] Calling pool.fundPool(${plan.targetAmountFormatted})...`);
  const fundTx = await poolWithSigner.fundPool(plan.targetAmountBaseUnits);
  console.log(`      fundPool Tx broadcast: ${fundTx.hash}`);
  const fundReceipt = await fundTx.wait(1);
  console.log(`      fundPool confirmed. Status: ${fundReceipt.status === 1 ? 'SUCCESS (1)' : fundReceipt.status}.\n`);

  // Post-funding Assertions
  console.log('Verifying post-funding assertions against Sepolia...');
  const [
    newPoolAvailable,
    newPoolRaw,
    newPoolUsdc,
    newPoolManager,
    newPoolOwner,
    newManagerOwner,
    newManagerFactory,
    newManagerUsdc,
    newManagerPool,
    newManagerCommittee,
    newManagerFeeBps,
    newManagerCoverageBps,
    postWalletBalance,
  ] = await Promise.all([
    pool.availableBalance(),
    usdc.balanceOf(manifestData.pool),
    pool.usdc(),
    pool.manager(),
    pool.owner(),
    manager.owner(),
    manager.factory(),
    manager.usdc(),
    manager.pool(),
    manager.protectionCommittee(),
    manager.premiumFeeBps(),
    manager.COVERAGE_RATE_BPS(),
    usdc.balanceOf(signerAddress),
  ]);

  // Run invariant checks
  verifyPostFundingAssertions(
    {
      poolAvailableBalance: BigInt(poolAvailableBalance),
      poolRawBalance: BigInt(poolRawBalance),
      poolUsdc,
      poolManager,
      poolOwner,
      managerFeeBps: Number(managerFeeBps),
      managerCoverageBps: Number(managerCoverageBps),
    },
    {
      poolAvailableBalance: BigInt(newPoolAvailable),
      poolRawBalance: BigInt(newPoolRaw),
      poolUsdc: newPoolUsdc,
      poolManager: newPoolManager,
      poolOwner: newPoolOwner,
      managerFeeBps: Number(newManagerFeeBps),
      managerCoverageBps: Number(newManagerCoverageBps),
    },
    plan.targetAmountBaseUnits
  );

  // Additional Manager & Wallet Checks
  if (newManagerOwner.toLowerCase() !== EXPECTED_FUNDING_WALLET.toLowerCase()) {
    throw new Error(`Post-funding assertion failed: manager.owner() mutated: ${newManagerOwner}`);
  }
  if (newManagerPool.toLowerCase() !== manifestData.pool.toLowerCase()) {
    throw new Error(`Post-funding assertion failed: manager.pool() mutated: ${newManagerPool}`);
  }
  if (newManagerUsdc.toLowerCase() !== manifestData.usdc.toLowerCase()) {
    throw new Error(`Post-funding assertion failed: manager.usdc() mutated: ${newManagerUsdc}`);
  }
  if (Number(newManagerFeeBps) !== 200) {
    throw new Error(`Post-funding assertion failed: manager.premiumFeeBps() != 200, got ${newManagerFeeBps}`);
  }
  if (Number(newManagerCoverageBps) !== 2000) {
    throw new Error(`Post-funding assertion failed: manager.COVERAGE_RATE_BPS() != 2000, got ${newManagerCoverageBps}`);
  }

  const expectedPostWalletBalance = BigInt(walletBalance) - plan.targetAmountBaseUnits;
  if (BigInt(postWalletBalance) !== expectedPostWalletBalance) {
    throw new Error(
      `Post-funding assertion failed: wallet balance expected ${formatUsdc(expectedPostWalletBalance)}, got ${formatUsdc(postWalletBalance)}`
    );
  }

  console.log('All post-funding assertions passed successfully.\n');
  console.log('====================================================');
  console.log('  LIVE CAPITALIZATION COMPLETED SUCCESSFULLY');
  console.log('====================================================');
  console.log(`Protection Pool successfully capitalized with ${plan.targetAmountFormatted}.`);
  console.log(`Pre-funding Pool Balance:   ${formatUsdc(poolAvailableBalance)} (${poolAvailableBalance} base units)`);
  console.log(`Post-funding Pool Balance:  ${formatUsdc(newPoolAvailable)} (${newPoolAvailable} base units)`);
  console.log(`Delta Pool Balance:         +${formatUsdc(BigInt(newPoolAvailable) - BigInt(poolAvailableBalance))}`);
  console.log(`Pre-funding Wallet Balance: ${formatUsdc(walletBalance)} (${walletBalance} base units)`);
  console.log(`Post-funding Wallet Balance:${formatUsdc(postWalletBalance)} (${postWalletBalance} base units)`);
  if (approveTx) {
    console.log(`Approval Tx Hash:           ${approveTx.hash}`);
    console.log(`Approval Receipt Status:    ${approveReceipt.status === 1 ? 'SUCCESS (1)' : approveReceipt.status}`);
  } else {
    console.log(`Approval:                   SKIPPED (Already sufficient)`);
  }
  console.log(`fundPool Tx Hash:           ${fundTx.hash}`);
  console.log(`fundPool Receipt Status:    ${fundReceipt.status === 1 ? 'SUCCESS (1)' : fundReceipt.status}`);
  console.log('====================================================\n');

  return {
    status: 'funded',
    preWalletBalance: BigInt(walletBalance),
    postWalletBalance: BigInt(postWalletBalance),
    prePoolBalance: BigInt(poolAvailableBalance),
    postPoolAvailableBalance: BigInt(newPoolAvailable),
    postPoolRawBalance: BigInt(newPoolRaw),
    deltaPoolBalance: BigInt(newPoolAvailable) - BigInt(poolAvailableBalance),
    preAllowance: BigInt(currentAllowance),
    needsApproval: plan.needsApproval,
    approvalAmount: plan.approvalAmount,
    approveTxHash: approveTx ? approveTx.hash : null,
    approveReceiptStatus: approveReceipt ? approveReceipt.status : null,
    fundTxHash: fundTx.hash,
    fundReceiptStatus: fundReceipt.status,
  };
}

if (require.main === module) {
  main()
    .then((res) => {
      // Exit cleanly
    })
    .catch((err) => {
      console.error('\n[!] CAPITALIZATION ERROR:', err.message);
      process.exitCode = 1;
    });
}

module.exports = { main };
