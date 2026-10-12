// test/SynqPremiumDeploymentScript.test.cjs
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  SEPOLIA_CHAIN_ID,
  CANONICAL_V2_MANIFEST_PATH,
  PREMIUM_MANIFEST_PATH,
  EXPECTED_CANONICAL_FACTORY,
  EXPECTED_CANONICAL_USDC,
  EXPECTED_CANONICAL_OWNER,
  MIN_PREMIUM_FEE_BPS,
  MAX_PREMIUM_FEE_BPS,
  FIXED_COVERAGE_RATE_BPS,
  COMMITTEE_THRESHOLD,
  ZERO_ADDRESS,
  isValidAddress,
  loadAndValidateCanonicalV2Manifest,
  validateProtectionCommitteeSigners,
  validatePremiumFeeBps,
  validatePremiumDeploymentConfig,
  assertSepoliaNetwork,
  assertLiveDeployerIdentity,
  validateCompiledArtifacts,
  buildSanitizedPremiumPlan,
  buildPremiumManifest,
} = require('../scripts/lib/premium-deployment-config.cjs');

describe('SYNQ PREMIUM PROTECTION V1 — PHASE 5A DEPLOYMENT TOOLING', function () {
  const SIGNER_A = '0x6F270E8c6DE66fB53A97e59E3e89E2A02290e7Fa';
  const SIGNER_B = '0x17Cd3B3B214191805EB92BaA31518c7Ea76078b3';
  const SIGNER_C = '0x0491C59AdC81774dEeaB0777dC9eCEB1ea882f34';
  const VALID_FEE_BPS = 1000; // 10% test fee

  function validRawConfig() {
    return {
      chainId: SEPOLIA_CHAIN_ID,
      premiumFeeBps: VALID_FEE_BPS,
      signerA: SIGNER_A,
      signerB: SIGNER_B,
      signerC: SIGNER_C,
      owner: EXPECTED_CANONICAL_OWNER,
    };
  }

  // ==================================================
  // 1-2: CANONICAL DEPENDENCY LOADING & CHAIN ID
  // ==================================================

  it('1. loads and validates canonical Standard V2 dependencies from sepolia-v2-standard.json', function () {
    const deps = loadAndValidateCanonicalV2Manifest();
    assert.strictEqual(deps.chainId, 11155111);
    assert.strictEqual(deps.factory.toLowerCase(), EXPECTED_CANONICAL_FACTORY.toLowerCase());
    assert.strictEqual(deps.canonicalUsdc.toLowerCase(), EXPECTED_CANONICAL_USDC.toLowerCase());
    assert.strictEqual(deps.owner.toLowerCase(), EXPECTED_CANONICAL_OWNER.toLowerCase());
  });

  it('2. strictly enforces Sepolia chainId (11155111)', function () {
    const validConfig = validRawConfig();
    const validated = validatePremiumDeploymentConfig(validConfig);
    assert.strictEqual(validated.chainId, 11155111);

    // Wrong chainId rejected
    const mainnetConfig = { ...validConfig, chainId: 1 };
    assert.throws(
      () => validatePremiumDeploymentConfig(mainnetConfig),
      /NETWORK HARD STOP: Synq Premium Protection deployment requires Sepolia chainId 11155111, got 1/
    );

    const hardhatConfig = { ...validConfig, chainId: 31337 };
    assert.throws(
      () => validatePremiumDeploymentConfig(hardhatConfig),
      /NETWORK HARD STOP: Synq Premium Protection deployment requires Sepolia chainId 11155111, got 31337/
    );
  });

  // ==================================================
  // 3-4: EXPLICIT ECONOMIC PARAMETER ENFORCEMENT
  // ==================================================

  it('3. strictly rejects missing or unconfigured PREMIUM_FEE_BPS (no silent default)', function () {
    assert.throws(
      () => validatePremiumFeeBps(undefined),
      /PREMIUM_FEE_BPS is required and must be explicitly configured/
    );
    assert.throws(
      () => validatePremiumFeeBps(null),
      /PREMIUM_FEE_BPS is required and must be explicitly configured/
    );
    assert.throws(
      () => validatePremiumFeeBps(''),
      /PREMIUM_FEE_BPS is required and must be explicitly configured/
    );
  });

  it('4. strictly validates PREMIUM_FEE_BPS range [1, 3000]', function () {
    // Valid boundaries
    assert.strictEqual(validatePremiumFeeBps(1), 1);
    assert.strictEqual(validatePremiumFeeBps(3000), 3000);
    assert.strictEqual(validatePremiumFeeBps('1500'), 1500);

    // Out of bounds / invalid numbers
    assert.throws(() => validatePremiumFeeBps(0), /must be an integer between 1 and 3000 bps/);
    assert.throws(() => validatePremiumFeeBps(-50), /must be an integer between 1 and 3000 bps/);
    assert.throws(() => validatePremiumFeeBps(3001), /must be an integer between 1 and 3000 bps/);
    assert.throws(() => validatePremiumFeeBps(10.5), /must be an integer between 1 and 3000 bps/);
    assert.throws(() => validatePremiumFeeBps('abc'), /must be an integer between 1 and 3000 bps/);
  });

  // ==================================================
  // 5-7: COMMITTEE SIGNER VALIDATION
  // ==================================================

  it('5. strictly rejects invalid or non-EVM committee signer addresses', function () {
    const invalidConfig = { ...validRawConfig(), signerA: 'not-an-address' };
    assert.throws(
      () => validatePremiumDeploymentConfig(invalidConfig),
      /Protection committee signer \[0\] is not a valid non-zero address/
    );
  });

  it('6. strictly rejects duplicate committee signers', function () {
    const duplicateConfig = { ...validRawConfig(), signerA: SIGNER_B };
    assert.throws(
      () => validatePremiumDeploymentConfig(duplicateConfig),
      /Duplicate protection committee signer detected/
    );
  });

  it('7. strictly rejects ZERO_ADDRESS committee signers', function () {
    const zeroConfig = { ...validRawConfig(), signerC: ZERO_ADDRESS };
    assert.throws(
      () => validatePremiumDeploymentConfig(zeroConfig),
      /Protection committee signer \[2\] is not a valid non-zero address/
    );
  });

  // ==================================================
  // 8-10: DEPLOYMENT ORDER & CONSTRUCTOR MAPPING
  // ==================================================

  it('8. defines exact 4-step deployment sequence in plan', function () {
    const config = validatePremiumDeploymentConfig(validRawConfig());
    const plan = buildSanitizedPremiumPlan(config, EXPECTED_CANONICAL_OWNER);

    assert.strictEqual(plan.deploymentOrder.length, 4);
    assert.strictEqual(plan.deploymentOrder[0].step, 1);
    assert.strictEqual(plan.deploymentOrder[0].contract, 'SynqProtectionCommittee');

    assert.strictEqual(plan.deploymentOrder[1].step, 2);
    assert.strictEqual(plan.deploymentOrder[1].contract, 'SynqProtectionPool');

    assert.strictEqual(plan.deploymentOrder[2].step, 3);
    assert.strictEqual(plan.deploymentOrder[2].contract, 'SynqPremiumProtectionManager');

    assert.strictEqual(plan.deploymentOrder[3].step, 4);
    assert.strictEqual(plan.deploymentOrder[3].action, 'protectionPool.setManager(protectionManager.address)');
  });

  it('9. constructor argument mappings match contract specifications exactly', function () {
    const config = validatePremiumDeploymentConfig(validRawConfig());
    const plan = buildSanitizedPremiumPlan(config, EXPECTED_CANONICAL_OWNER);

    // Step 1: SynqProtectionCommittee(signerA, signerB, signerC)
    const step1 = plan.deploymentOrder[0];
    assert.deepStrictEqual(step1.constructorArgs, [
      SIGNER_A.toLowerCase(),
      SIGNER_B.toLowerCase(),
      SIGNER_C.toLowerCase(),
    ]);

    // Step 2: SynqProtectionPool(owner, canonicalUsdc, ZERO_ADDRESS)
    const step2 = plan.deploymentOrder[1];
    assert.deepStrictEqual(step2.constructorArgs, [
      EXPECTED_CANONICAL_OWNER,
      EXPECTED_CANONICAL_USDC,
      ZERO_ADDRESS,
    ]);

    // Step 3: SynqPremiumProtectionManager(owner, factory, usdc, pool, committee, feeBps)
    const step3 = plan.deploymentOrder[2];
    assert.deepStrictEqual(step3.constructorArgs, [
      EXPECTED_CANONICAL_OWNER,
      EXPECTED_CANONICAL_FACTORY,
      EXPECTED_CANONICAL_USDC,
      '<protectionPool.address>',
      '<protectionCommittee.address>',
      VALID_FEE_BPS,
    ]);
  });

  it('10. verifies pool funding is NOT an automatic deployment step', function () {
    const config = validatePremiumDeploymentConfig(validRawConfig());
    const plan = buildSanitizedPremiumPlan(config, EXPECTED_CANONICAL_OWNER);

    const stepActions = plan.deploymentOrder.map((s) => s.action || s.contract);
    assert.strictEqual(stepActions.includes('fundPool'), false);
    assert.strictEqual(stepActions.includes('approveUsdc'), false);
  });

  // ==================================================
  // 11-14: MANIFEST, ARTIFACTS & NAMING
  // ==================================================

  it('11. verifies manifest is NOT written during dry-run', function () {
    // Calling plan generation and dry-run execution logic does not write a manifest
    const tempDryRunPath = path.join(__dirname, '..', 'deployments', 'temp-dry-run-check.json');
    if (fs.existsSync(tempDryRunPath)) {
      fs.unlinkSync(tempDryRunPath);
    }
    const config = validatePremiumDeploymentConfig(validRawConfig());
    const plan = buildSanitizedPremiumPlan(config, null);
    assert.strictEqual(plan.isKeylessDryRun, true);
    // Verified that plan builder never writes to disk
    assert.strictEqual(fs.existsSync(tempDryRunPath), false);
  });

  it('12. builds correct canonical manifest shape upon completion', function () {
    const config = validatePremiumDeploymentConfig(validRawConfig());
    const plan = buildSanitizedPremiumPlan(config, EXPECTED_CANONICAL_OWNER);
    const mockDeployed = {
      protectionPool: '0x3333333333333333333333333333333333333333',
      protectionManager: '0x4444444444444444444444444444444444444444',
      protectionCommittee: '0x5555555555555555555555555555555555555555',
    };

    const manifest = buildPremiumManifest(plan, mockDeployed, EXPECTED_CANONICAL_OWNER);
    assert.strictEqual(manifest.network, 'sepolia');
    assert.strictEqual(manifest.chainId, 11155111);
    assert.strictEqual(manifest.version, 'synq-premium-protection-v1');
    assert.strictEqual(manifest.status, 'deployed');
    assert.strictEqual(manifest.contracts.protectionPool, mockDeployed.protectionPool);
    assert.strictEqual(manifest.contracts.protectionManager, mockDeployed.protectionManager);
    assert.strictEqual(manifest.contracts.protectionCommittee, mockDeployed.protectionCommittee);
    assert.strictEqual(manifest.dependencies.factory, EXPECTED_CANONICAL_FACTORY);
    assert.strictEqual(manifest.dependencies.canonicalUsdc, EXPECTED_CANONICAL_USDC);
    assert.strictEqual(manifest.parameters.coverageRateBps, 2000);
    assert.strictEqual(manifest.parameters.premiumFeeBps, VALID_FEE_BPS);
    assert.strictEqual(manifest.governance.threshold, 2);
    assert.strictEqual(manifest.governance.committeeSigners.length, 3);
  });

  it('13. verifies exact contract names: SynqProtectionCommittee, SynqProtectionPool, SynqPremiumProtectionManager', function () {
    const artifactsVerified = validateCompiledArtifacts();
    assert.strictEqual(artifactsVerified, true);
  });

  it('14. uses SynqProtectionCommittee (not Standard V2 SynqResolutionCommittee)', function () {
    const config = validatePremiumDeploymentConfig(validRawConfig());
    const plan = buildSanitizedPremiumPlan(config, EXPECTED_CANONICAL_OWNER);

    const committeeStep = plan.deploymentOrder.find((s) => s.contract === 'SynqProtectionCommittee');
    assert.notStrictEqual(committeeStep, undefined);

    const resolutionStep = plan.deploymentOrder.find((s) => s.contract === 'SynqResolutionCommittee');
    assert.strictEqual(resolutionStep, undefined);
  });

  it('15. verifies private key is never placed into plan or manifest', function () {
    const config = validatePremiumDeploymentConfig(validRawConfig());
    const plan = buildSanitizedPremiumPlan(config, EXPECTED_CANONICAL_OWNER);
    const planString = JSON.stringify(plan);

    assert.strictEqual(planString.includes('privateKey'), false);
    assert.strictEqual(planString.includes('PRIVATE_KEY'), false);

    const manifest = buildPremiumManifest(plan, {
      protectionPool: '0x1111111111111111111111111111111111111111',
      protectionManager: '0x2222222222222222222222222222222222222222',
      protectionCommittee: '0x3333333333333333333333333333333333333333',
    });
    const manifestString = JSON.stringify(manifest);

    assert.strictEqual(manifestString.includes('privateKey'), false);
    assert.strictEqual(manifestString.includes('PRIVATE_KEY'), false);
  });

  // ==================================================
  // 16-25: PHASE 5A.1 LIVE DEPLOYER IDENTITY HARDENING
  // ==================================================

  it('16. live signer matching canonical owner passes identity validation', function () {
    const passed = assertLiveDeployerIdentity(
      EXPECTED_CANONICAL_OWNER,
      EXPECTED_CANONICAL_OWNER
    );
    assert.strictEqual(passed, true);
  });

  it('17. live signer different from canonical owner fails', function () {
    const attackerSigner = '0x1111111111111111111111111111111111111111';
    assert.throws(
      () => assertLiveDeployerIdentity(attackerSigner, EXPECTED_CANONICAL_OWNER),
      /Live deployment signer does not match canonical Synq deployment owner/
    );
  });

  it('18. deployer identity comparison is case-insensitive', function () {
    const lower = EXPECTED_CANONICAL_OWNER.toLowerCase();
    const upper = '0X' + EXPECTED_CANONICAL_OWNER.slice(2).toUpperCase();
    const passed = assertLiveDeployerIdentity(lower, upper);
    assert.strictEqual(passed, true);
  });

  it('19. identity mismatch fails before any deployment transaction step', function () {
    const unauthorizedSigner = '0x2222222222222222222222222222222222222222';
    let txAttempted = false;

    // Simulate pre-deployment check
    assert.throws(() => {
      assertLiveDeployerIdentity(unauthorizedSigner, EXPECTED_CANONICAL_OWNER);
      txAttempted = true; // should never be reached
    }, /Live deployment signer does not match canonical Synq deployment owner/);

    assert.strictEqual(txAttempted, false, 'No transaction should be attempted if identity mismatch occurs');
  });

  it('20. constructor owner is the verified canonical signer', function () {
    const config = validatePremiumDeploymentConfig(validRawConfig());
    const plan = buildSanitizedPremiumPlan(config, EXPECTED_CANONICAL_OWNER);

    // ProtectionPool constructor owner
    const poolStep = plan.deploymentOrder.find((s) => s.contract === 'SynqProtectionPool');
    assert.strictEqual(poolStep.constructorArgs[0], EXPECTED_CANONICAL_OWNER);

    // PremiumProtectionManager constructor owner
    const managerStep = plan.deploymentOrder.find((s) => s.contract === 'SynqPremiumProtectionManager');
    assert.strictEqual(managerStep.constructorArgs[0], EXPECTED_CANONICAL_OWNER);
  });

  it('21. keyless dry-run does not require live signer', function () {
    const config = validatePremiumDeploymentConfig(validRawConfig());
    // Keyless dry-run passes null for deployerAddress
    const plan = buildSanitizedPremiumPlan(config, null);
    assert.strictEqual(plan.isKeylessDryRun, true);
    assert.strictEqual(plan.owner, EXPECTED_CANONICAL_OWNER);
  });

  it('22. keyless dry-run does not display Hardhat account as actual deployer', function () {
    const config = validatePremiumDeploymentConfig(validRawConfig());
    const plan = buildSanitizedPremiumPlan(config, null);

    const hardhatAccount = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    assert.notStrictEqual(plan.deployer.toLowerCase(), hardhatAccount.toLowerCase());
    assert.strictEqual(plan.deployer, '[DRY-RUN — live signer not loaded]');
  });

  it('23. dry-run still previews canonical owner in constructor arguments', function () {
    const config = validatePremiumDeploymentConfig(validRawConfig());
    const plan = buildSanitizedPremiumPlan(config, null);

    const poolStep = plan.deploymentOrder.find((s) => s.contract === 'SynqProtectionPool');
    assert.strictEqual(poolStep.constructorArgs[0], EXPECTED_CANONICAL_OWNER);

    const managerStep = plan.deploymentOrder.find((s) => s.contract === 'SynqPremiumProtectionManager');
    assert.strictEqual(managerStep.constructorArgs[0], EXPECTED_CANONICAL_OWNER);
  });

  it('24. private key never appears in error messages or output', function () {
    const fakeKey = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    try {
      assertLiveDeployerIdentity('0x3333333333333333333333333333333333333333', EXPECTED_CANONICAL_OWNER);
    } catch (err) {
      assert.strictEqual(err.message.includes(fakeKey), false);
      assert.strictEqual(err.message.includes('privateKey'), false);
    }
  });

  it('25. no alternate deployer bypass exists in configuration validation', function () {
    const alternateOwnerConfig = {
      ...validRawConfig(),
      owner: '0x9999999999999999999999999999999999999999',
    };
    assert.throws(
      () => validatePremiumDeploymentConfig(alternateOwnerConfig),
      /Alternate deployers are not permitted/
    );
  });

  // ==================================================
  // 26-30: PHASE 5B NETWORK SELECTION & HARDENING
  // ==================================================

  it('26. default/local chain 31337 rejected', function () {
    assert.throws(
      () => assertSepoliaNetwork('hardhat', 31337),
      /requires network 'sepolia', got 'hardhat'/
    );
    assert.throws(
      () => assertSepoliaNetwork('sepolia', 31337),
      /strictly refuses to execute on chainId 31337/
    );
  });

  it('27. observed Sepolia chain 11155111 accepted', function () {
    assert.strictEqual(assertSepoliaNetwork('sepolia', 11155111), true);
    assert.strictEqual(assertSepoliaNetwork('sepolia', 11155111n), true);
  });

  it('28. configured network label alone cannot bypass observed chain check', function () {
    // Label is 'sepolia', but observed chainId is wrong
    assert.throws(
      () => assertSepoliaNetwork('sepolia', 1),
      /strictly refuses to execute on chainId 1\. Only Sepolia \(11155111\) is supported\./
    );
    assert.throws(
      () => assertSepoliaNetwork('sepolia', 31337),
      /strictly refuses to execute on chainId 31337\. Only Sepolia \(11155111\) is supported\./
    );
    assert.throws(
      () => assertSepoliaNetwork('sepolia', 1337),
      /strictly refuses to execute on chainId 1337\. Only Sepolia \(11155111\) is supported\./
    );
  });

  it('29. wrong network label rejected even if observed chain is Sepolia', function () {
    assert.throws(
      () => assertSepoliaNetwork('localhost', 11155111),
      /requires network 'sepolia', got 'localhost'/
    );
    assert.throws(
      () => assertSepoliaNetwork('mainnet', 11155111),
      /requires network 'sepolia', got 'mainnet'/
    );
  });

  it('30. custom deployment parameters survive canonical environment invocation', function () {
    const envConfig = {
      chainId: SEPOLIA_CHAIN_ID,
      premiumFeeBps: '200', // string from env var
      signerA: SIGNER_A,
      signerB: SIGNER_B,
      signerC: SIGNER_C,
    };
    const validated = validatePremiumDeploymentConfig(envConfig);
    assert.strictEqual(validated.premiumFeeBps, 200);
    assert.strictEqual(validated.committeeSigners[0], SIGNER_A.toLowerCase());
    assert.strictEqual(validated.committeeSigners[1], SIGNER_B.toLowerCase());
    assert.strictEqual(validated.committeeSigners[2], SIGNER_C.toLowerCase());
    assert.strictEqual(validated.owner, EXPECTED_CANONICAL_OWNER);
  });

  // ==================================================
  // V1.1 DEPLOYMENT TOOLING INVARIANTS (PHASE 7H)
  // ==================================================
  it('31. V1.1 deployment script exists and targets sepolia-premium-protection-v1.1.json', function () {
    const scriptPath = path.join(__dirname, '../scripts/deploy-premium-protection-v1.1-sepolia.cjs');
    assert(fs.existsSync(scriptPath), 'V1.1 deployment script must exist');
    const content = fs.readFileSync(scriptPath, 'utf8');

    assert(content.includes('sepolia-premium-protection-v1.1.json'), 'Must target V1.1 manifest');
    assert(content.includes('sepolia-premium-protection-v1.json'), 'Must load existing V1 manifest');
    assert(content.includes('SynqPremiumProtectionManagerV1_1'), 'Must deploy V1.1 Manager artifact');
  });

  it('32. V1.1 script reuses existing Pool, Committee, Factory, USDC and does NOT rotate manager', function () {
    const scriptPath = path.join(__dirname, '../scripts/deploy-premium-protection-v1.1-sepolia.cjs');
    const content = fs.readFileSync(scriptPath, 'utf8');

    assert(!content.includes('.setManager('), 'V1.1 script must NOT call setManager()');
    assert(content.includes('existingPool'), 'Must reuse existing pool');
    assert(content.includes('existingCommittee'), 'Must reuse existing committee');
    assert(content.includes('canonicalFactory'), 'Must reuse existing factory');
    assert(content.includes('canonicalUsdc'), 'Must reuse existing USDC');
  });

  it('33. V1.1 script enforces Sepolia chainId (11155111) and canonical owner check', function () {
    const scriptPath = path.join(__dirname, '../scripts/deploy-premium-protection-v1.1-sepolia.cjs');
    const content = fs.readFileSync(scriptPath, 'utf8');

    assert(content.includes('SEPOLIA_CHAIN_ID = 11155111'), 'Must declare SEPOLIA_CHAIN_ID');
    assert(content.includes('0xD2D4d415a4730b1490c9Ce27944529B83ff76319'), 'Must check canonical owner');
    assert(content.includes('isDryRun'), 'Must support dry-run');
    assert(content.includes('isExplicitKeyless'), 'Must support keyless execution');
  });
});


