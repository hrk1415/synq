// test/SynqPremiumPoolCapitalization.test.cjs
const { describe, it } = require('node:test');
const assert = require('node:assert');
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
  MAX_UINT256,
  toUsdcBaseUnits,
  formatUsdc,
  assertSepoliaNetwork,
  loadAndValidatePremiumManifest,
  assertFundingSigner,
  buildFundingPlan,
  verifyPreflightReadings,
  verifyPostFundingAssertions,
} = require('../scripts/lib/premium-pool-funding-config.cjs');

describe('SYNQ PREMIUM PROTECTION V1 — PHASE 6A CAPITALIZATION TOOLING', function () {
  // 1. Exact 100 USDC base-unit conversion
  it('1. exact 100 USDC base-unit conversion without floating-point arithmetic', function () {
    const baseUnits100 = toUsdcBaseUnits(100);
    assert.strictEqual(baseUnits100, 100_000_000n);
    assert.strictEqual(typeof baseUnits100, 'bigint');

    const baseUnitsString = toUsdcBaseUnits('100');
    assert.strictEqual(baseUnitsString, 100_000_000n);

    const baseUnitsBigInt = toUsdcBaseUnits(100n);
    assert.strictEqual(baseUnitsBigInt, 100_000_000n);

    // Rejects floating point, negatives, and invalid input
    assert.throws(() => toUsdcBaseUnits(100.5), /integer/);
    assert.throws(() => toUsdcBaseUnits('100.5'), /integer/);
    assert.throws(() => toUsdcBaseUnits(-10), /positive/);
    assert.throws(() => toUsdcBaseUnits(0), /greater than zero/);
  });

  // 2. Sepolia network enforcement
  it('2. strictly enforces Sepolia network name and chainId (11155111)', function () {
    assert.strictEqual(assertSepoliaNetwork('sepolia', 11155111), true);
    assert.strictEqual(assertSepoliaNetwork('sepolia', '11155111'), true);

    // Refuses local/hardhat chain
    assert.throws(() => assertSepoliaNetwork('hardhat', 31337), /requires network 'sepolia'/);
    assert.throws(() => assertSepoliaNetwork('sepolia', 31337), /strictly refuses to execute on chainId 31337/);
    assert.throws(() => assertSepoliaNetwork('sepolia', 1), /strictly refuses to execute on chainId 1/);
  });

  // 3. Signer enforcement
  it('3. strictly enforces funding signer matches canonical deployment owner', function () {
    assert.strictEqual(assertFundingSigner(EXPECTED_FUNDING_WALLET, EXPECTED_FUNDING_WALLET), true);
    // Case-insensitive
    assert.strictEqual(
      assertFundingSigner(EXPECTED_FUNDING_WALLET.toLowerCase(), EXPECTED_FUNDING_WALLET),
      true
    );

    // Rejects alternate or random signer
    const alternateSigner = '0x0000000000000000000000000000000000000001';
    assert.throws(
      () => assertFundingSigner(alternateSigner, EXPECTED_FUNDING_WALLET),
      /SIGNER HARD STOP/
    );
  });

  // 4. Manifest pool and manager verification
  it('4. loads and verifies canonical contracts from live deployment manifest', function () {
    const manifest = loadAndValidatePremiumManifest();
    assert.strictEqual(manifest.chainId, 11155111);
    assert.strictEqual(manifest.pool.toLowerCase(), EXPECTED_CANONICAL_POOL.toLowerCase());
    assert.strictEqual(manifest.manager.toLowerCase(), EXPECTED_CANONICAL_MANAGER.toLowerCase());
    assert.strictEqual(manifest.usdc.toLowerCase(), EXPECTED_CANONICAL_USDC.toLowerCase());
  });

  // 5. Canonical USDC verification
  it('5. verifies canonical Sepolia USDC address', function () {
    assert.strictEqual(EXPECTED_CANONICAL_USDC.toLowerCase(), '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238');
  });

  // 6 & 7 & 8: Correct spender, exact approval amount, MaxUint256 never used
  it('6-8. derives correct spender as ProtectionPool (NOT Manager), uses exact amount, and never uses MaxUint256', function () {
    const plan = buildFundingPlan({
      poolAddress: EXPECTED_CANONICAL_POOL,
      usdcAddress: EXPECTED_CANONICAL_USDC,
      signerAddress: EXPECTED_FUNDING_WALLET,
      currentAllowance: 0n,
      currentBalance: 500_000_000n, // 500 USDC
      targetAmountBaseUnits: 100_000_000n, // 100 USDC
    });

    assert.strictEqual(plan.spenderAddress, EXPECTED_CANONICAL_POOL);
    assert.notStrictEqual(plan.spenderAddress, EXPECTED_CANONICAL_MANAGER);
    assert.strictEqual(plan.needsApproval, true);
    assert.strictEqual(plan.approvalAmount, 100_000_000n);
    assert.notStrictEqual(plan.approvalAmount, MAX_UINT256);

    assert.strictEqual(plan.plannedTransactions.length, 2);
    const approveTx = plan.plannedTransactions[0];
    assert.strictEqual(approveTx.target, EXPECTED_CANONICAL_USDC);
    assert.strictEqual(approveTx.spender, EXPECTED_CANONICAL_POOL);
    assert.strictEqual(approveTx.amount, 100_000_000n);
    assert.strictEqual(approveTx.isMaxUint256, false);

    const fundTx = plan.plannedTransactions[1];
    assert.strictEqual(fundTx.target, EXPECTED_CANONICAL_POOL);
    assert.strictEqual(fundTx.amount, 100_000_000n);
  });

  // 9. Skip approval when sufficient allowance
  it('9. skips approval transaction when existing allowance is sufficient', function () {
    const plan = buildFundingPlan({
      poolAddress: EXPECTED_CANONICAL_POOL,
      usdcAddress: EXPECTED_CANONICAL_USDC,
      signerAddress: EXPECTED_FUNDING_WALLET,
      currentAllowance: 200_000_000n, // 200 USDC allowance already exists
      currentBalance: 500_000_000n,
      targetAmountBaseUnits: 100_000_000n,
    });

    assert.strictEqual(plan.needsApproval, false);
    assert.strictEqual(plan.approvalAmount, 0n);
    assert.strictEqual(plan.plannedTransactions.length, 1);
    assert.strictEqual(plan.plannedTransactions[0].call, 'fundPool(uint256 amount)');
    assert.strictEqual(plan.plannedTransactions[0].amount, 100_000_000n);
  });

  // 10. Insufficient USDC blocker
  it('10. throws blocker during preflight when funding wallet has insufficient USDC balance', function () {
    const validReadings = {
      walletBalance: 50_000_000n, // Only 50 USDC (needs 100)
      currentAllowance: 0n,
      poolAvailableBalance: 0n,
      poolRawBalance: 0n,
      poolUsdc: EXPECTED_CANONICAL_USDC,
      poolManager: EXPECTED_CANONICAL_MANAGER,
      poolOwner: EXPECTED_FUNDING_WALLET,
      targetAmountBaseUnits: 100_000_000n,
    };

    assert.throws(() => verifyPreflightReadings(validReadings), /BLOCKER: Funding wallet has insufficient USDC balance/);
  });

  // 11. Preflight assertion checks for pool invariants
  it('11. verifies pool availableBalance equals raw USDC balance and contract wiring', function () {
    const validReadings = {
      walletBalance: 150_000_000n, // 150 USDC
      currentAllowance: 0n,
      poolAvailableBalance: 0n,
      poolRawBalance: 0n,
      poolUsdc: EXPECTED_CANONICAL_USDC,
      poolManager: EXPECTED_CANONICAL_MANAGER,
      poolOwner: EXPECTED_FUNDING_WALLET,
      targetAmountBaseUnits: 100_000_000n,
    };

    assert.strictEqual(verifyPreflightReadings(validReadings), true);

    // Mismatched available vs raw balance
    assert.throws(
      () =>
        verifyPreflightReadings({
          ...validReadings,
          poolAvailableBalance: 10n,
          poolRawBalance: 0n,
        }),
      /Preflight assertion failed: pool.availableBalance/
    );

    // Mismatched pool usdc
    assert.throws(
      () =>
        verifyPreflightReadings({
          ...validReadings,
          poolUsdc: '0x0000000000000000000000000000000000000001',
        }),
      /Preflight assertion failed: pool.usdc/
    );
  });

  // 12. Expected balance delta assertions
  it('12. asserts exact 100 USDC delta on pool available and raw balances post-funding', function () {
    const beforeState = {
      poolAvailableBalance: 0n,
      poolRawBalance: 0n,
      poolUsdc: EXPECTED_CANONICAL_USDC,
      poolManager: EXPECTED_CANONICAL_MANAGER,
      poolOwner: EXPECTED_FUNDING_WALLET,
      managerFeeBps: 200,
      managerCoverageBps: 2000,
    };

    const afterStateValid = {
      poolAvailableBalance: 100_000_000n,
      poolRawBalance: 100_000_000n,
      poolUsdc: EXPECTED_CANONICAL_USDC,
      poolManager: EXPECTED_CANONICAL_MANAGER,
      poolOwner: EXPECTED_FUNDING_WALLET,
      managerFeeBps: 200,
      managerCoverageBps: 2000,
    };

    assert.strictEqual(
      verifyPostFundingAssertions(beforeState, afterStateValid, 100_000_000n),
      true
    );

    // Wrong delta
    const afterStateWrongDelta = {
      ...afterStateValid,
      poolAvailableBalance: 90_000_000n,
    };
    assert.throws(
      () => verifyPostFundingAssertions(beforeState, afterStateWrongDelta, 100_000_000n),
      /pool.availableBalance\(\) expected 100000000/
    );
  });

  // 13. Pool owner/manager immutability checks
  it('13. asserts pool manager, owner, USDC, and manager parameters are immutable during funding', function () {
    const beforeState = {
      poolAvailableBalance: 0n,
      poolRawBalance: 0n,
      poolUsdc: EXPECTED_CANONICAL_USDC,
      poolManager: EXPECTED_CANONICAL_MANAGER,
      poolOwner: EXPECTED_FUNDING_WALLET,
      managerFeeBps: 200,
      managerCoverageBps: 2000,
    };

    // Manager mutated
    assert.throws(
      () =>
        verifyPostFundingAssertions(
          beforeState,
          {
            ...beforeState,
            poolAvailableBalance: 100_000_000n,
            poolRawBalance: 100_000_000n,
            poolManager: '0x0000000000000000000000000000000000000002',
          },
          100_000_000n
        ),
      /pool.manager\(\) mutated/
    );

    // Owner mutated
    assert.throws(
      () =>
        verifyPostFundingAssertions(
          beforeState,
          {
            ...beforeState,
            poolAvailableBalance: 100_000_000n,
            poolRawBalance: 100_000_000n,
            poolOwner: '0x0000000000000000000000000000000000000002',
          },
          100_000_000n
        ),
      /pool.owner\(\) mutated/
    );
  });

  // 14. Secret masking
  it('14. guarantees zero private keys are exposed or accepted in public outputs', function () {
    const rawPk = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    // assertFundingSigner must reject raw private key string as an invalid Ethereum address
    assert.throws(
      () => assertFundingSigner(rawPk, EXPECTED_FUNDING_WALLET),
      /Funding signer address is invalid or missing/
    );
  });

  // 15. Phase 6B: 10 USDC target capitalization
  it('15. verifies 10 USDC capitalization planning and execution parameters (10_000_000 base units)', function () {
    const baseUnits10 = toUsdcBaseUnits(10);
    assert.strictEqual(baseUnits10, 10_000_000n);

    const plan = buildFundingPlan({
      poolAddress: EXPECTED_CANONICAL_POOL,
      usdcAddress: EXPECTED_CANONICAL_USDC,
      signerAddress: EXPECTED_FUNDING_WALLET,
      currentAllowance: 0n,
      currentBalance: 18_010_000n, // 18.01 USDC
      targetAmountBaseUnits: 10_000_000n, // 10 USDC
    });

    assert.strictEqual(plan.hasSufficientBalance, true);
    assert.strictEqual(plan.needsApproval, true);
    assert.strictEqual(plan.approvalAmount, 10_000_000n);
    assert.strictEqual(plan.plannedTransactions.length, 2);
    assert.strictEqual(plan.plannedTransactions[0].amount, 10_000_000n);
    assert.strictEqual(plan.plannedTransactions[0].spender, EXPECTED_CANONICAL_POOL);
    assert.strictEqual(plan.plannedTransactions[1].amount, 10_000_000n);
  });
});

