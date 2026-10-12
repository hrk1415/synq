// test/SynqDeploymentTooling.test.cjs
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ethers } = require('hardhat');
const {
  SEPOLIA_CHAIN_ID,
  SEPOLIA_CANONICAL_USDC,
  COMMITTEE_THRESHOLD,
  validateDeploymentConfig,
  buildSanitizedPlan,
  buildManifest,
  saveManifest,
} = require('../scripts/lib/v1-deployment-config.cjs');

describe('Synq Deployment Tooling Phase 2B Test Suite', function () {
  const SIGNER_P1 = '0x1111111111111111111111111111111111111111';
  const SIGNER_P2 = '0x2222222222222222222222222222222222222222';
  const SIGNER_P3 = '0x3333333333333333333333333333333333333333';

  const SIGNER_E1 = '0x4444444444444444444444444444444444444444';
  const SIGNER_E2 = '0x5555555555555555555555555555555555555555';
  const SIGNER_E3 = '0x6666666666666666666666666666666666666666';

  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
  const OWNER_ADDR = '0x7777777777777777777777777777777777777777';

  function validRawConfig() {
    return {
      chainId: SEPOLIA_CHAIN_ID,
      canonicalUsdc: SEPOLIA_CANONICAL_USDC,
      primarySignerA: SIGNER_P1,
      primarySignerB: SIGNER_P2,
      primarySignerC: SIGNER_P3,
      emergencySignerA: SIGNER_E1,
      emergencySignerB: SIGNER_E2,
      emergencySignerC: SIGNER_E3,
      factoryOwner: OWNER_ADDR,
    };
  }

  describe('1. Network & Chain ID Hard Stop', function () {
    it('accepts exact Sepolia chainId (11155111)', function () {
      const cfg = validRawConfig();
      const res = validateDeploymentConfig(cfg);
      assert.equal(res.chainId, 11155111);
    });

    it('rejects wrong chainId (e.g. 1 mainnet, 31337 hardhat)', function () {
      const cfgMainnet = { ...validRawConfig(), chainId: 1 };
      assert.throws(
        () => validateDeploymentConfig(cfgMainnet),
        /Network hard stop: Synq Deal V1 deployment script requires Sepolia chainId 11155111, got 1/
      );

      const cfgLocal = { ...validRawConfig(), chainId: 31337 };
      assert.throws(
        () => validateDeploymentConfig(cfgLocal),
        /Network hard stop: Synq Deal V1 deployment script requires Sepolia chainId 11155111, got 31337/
      );
    });
  });

  describe('2. Signer Validation & Committee Integrity', function () {
    it('rejects zero signer address', function () {
      const cfg = { ...validRawConfig(), primarySignerA: ZERO_ADDR };
      assert.throws(
        () => validateDeploymentConfig(cfg),
        /not a valid non-zero address/
      );
    });

    it('rejects invalid/malformed address string', function () {
      const cfg = { ...validRawConfig(), primarySignerB: '0xinvalidEthAddress' };
      assert.throws(
        () => validateDeploymentConfig(cfg),
        /not a valid non-zero address/
      );
    });

    it('rejects duplicate signer inside Primary Committee', function () {
      const cfg = { ...validRawConfig(), primarySignerC: SIGNER_P1 };
      assert.throws(
        () => validateDeploymentConfig(cfg),
        /Primary Resolution Committee contains duplicate signer address/
      );
    });

    it('rejects duplicate signer inside Emergency Committee', function () {
      const cfg = { ...validRawConfig(), emergencySignerB: SIGNER_E1 };
      assert.throws(
        () => validateDeploymentConfig(cfg),
        /Emergency Resolution Committee contains duplicate signer address/
      );
    });

    it('rejects identical Primary and Emergency signer sets by default', function () {
      const cfg = {
        ...validRawConfig(),
        emergencySignerA: SIGNER_P1,
        emergencySignerB: SIGNER_P2,
        emergencySignerC: SIGNER_P3,
      };
      assert.throws(
        () => validateDeploymentConfig(cfg),
        /Primary and Emergency committees have identical signer sets/
      );
    });

    it('allows identical committees only with explicit override flag and warns', function () {
      const cfg = {
        ...validRawConfig(),
        emergencySignerA: SIGNER_P1,
        emergencySignerB: SIGNER_P2,
        emergencySignerC: SIGNER_P3,
      };
      const validated = validateDeploymentConfig(cfg, { allowIdenticalCommittees: true });
      assert.equal(validated.primarySigners.length, 3);
      assert.equal(validated.emergencySigners.length, 3);
    });

    it('warns on partial overlap across Primary and Emergency', function () {
      const cfg = {
        ...validRawConfig(),
        emergencySignerA: SIGNER_P1, // 1 overlapping
      };
      const validated = validateDeploymentConfig(cfg);
      assert.equal(validated.warnings.length, 1);
      assert(validated.warnings[0].includes('share 1 overlapping signer'));
    });

    it('accepts completely valid independent config with zero warnings', function () {
      const validated = validateDeploymentConfig(validRawConfig());
      assert.equal(validated.warnings.length, 0);
      assert.equal(validated.primarySigners.length, 3);
      assert.equal(validated.emergencySigners.length, 3);
      assert.equal(validated.factoryOwner, OWNER_ADDR);
    });
  });

  describe('3. Canonical USDC & Constants', function () {
    it('enforces canonical Sepolia USDC address', function () {
      const validated = validateDeploymentConfig(validRawConfig());
      assert.equal(validated.canonicalUsdc, SEPOLIA_CANONICAL_USDC);
    });

    it('rejects mismatched canonical USDC address', function () {
      const cfg = { ...validRawConfig(), canonicalUsdc: '0x9999999999999999999999999999999999999999' };
      assert.throws(
        () => validateDeploymentConfig(cfg),
        /Canonical USDC mismatch/
      );
    });

    it('enforces expected committee threshold == 2', function () {
      assert.equal(COMMITTEE_THRESHOLD, 2);
    });
  });

  describe('4. Sanitized Plan & Secret Isolation', function () {
    it('sanitized plan contains zero secret fields and marks Protection DISABLED', function () {
      const validated = validateDeploymentConfig(validRawConfig());
      const plan = buildSanitizedPlan(validated, '0xDeployerAddress123456789012345678901234');

      const planStr = JSON.stringify(plan);
      assert(!/private|secret|mnemonic/i.test(planStr), 'Plan must not contain private/secret terms');
      assert.equal(plan.protection.enabled, false);
      assert(plan.protection.reason.includes('Active Protection is NOT enabled in Standard V1 rollout'));
    });

    it('sanitized plan explicitly marks Factory in bootstrap mode before resolver wiring', function () {
      const validated = validateDeploymentConfig(validRawConfig());
      const plan = buildSanitizedPlan(validated, '0xDeployerAddress123456789012345678901234');

      const step2 = plan.steps.find((s) => s.step === 2);
      assert(step2.status.includes('BOOTSTRAPPING / NOT READY'));

      const step5 = plan.steps.find((s) => s.step === 5);
      assert(step5.status.includes('READY FOR STANDARD DEALS'));
    });
  });

  describe('5. Manifest Builder & Overwrite Protection', function () {
    it('manifest builder includes all required fields and disables Protection', function () {
      const manifest = buildManifest({
        deployer: '0xDeployer11111111111111111111111111111111',
        dealImplementation: '0xDealImpl22222222222222222222222222222222',
        factory: '0xFactory33333333333333333333333333333333',
        primaryResolver: '0xPrimary44444444444444444444444444444444',
        emergencyResolver: '0xEmergency5555555555555555555555555555555',
        factoryOwner: OWNER_ADDR,
        primarySigners: [SIGNER_P1, SIGNER_P2, SIGNER_P3],
        emergencySigners: [SIGNER_E1, SIGNER_E2, SIGNER_E3],
      });

      assert.equal(manifest.network, 'sepolia');
      assert.equal(manifest.chainId, 11155111);
      assert.equal(manifest.status, 'standard-ready');
      assert.equal(manifest.protection.enabled, false);
      assert.equal(manifest.protection.module, null);
      assert.equal(manifest.protection.policyId, null);
      assert.equal(manifest.governance.primaryCommittee.threshold, 2);
      assert.equal(manifest.governance.primaryCommittee.epoch, 0);
      assert.equal(manifest.governance.emergencyCommittee.threshold, 2);
      assert.equal(manifest.governance.emergencyCommittee.epoch, 0);
    });

    it('manifest builder rejects serialization if secret key is present in input', function () {
      assert.throws(
        () =>
          buildManifest({
            deployer: '0xDeployer',
            privateKey: '0xsecret',
          }),
        /Security violation: Key "privateKey" cannot be serialized into manifest/
      );
    });

    it('saveManifest protects existing file by default and requires explicit overwrite', function () {
      const testDir = path.join(__dirname, 'tmp-tooling-test');
      const testFile = path.join(testDir, 'test-manifest.json');

      if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testFile, '{"test": true}', 'utf8');

      // Attempt save without overwrite -> throws
      assert.throws(
        () => saveManifest(testFile, { test: 2 }, { overwrite: false }),
        /Deployment manifest already exists at .* Refusing to overwrite by default/
      );

      // Attempt save with overwrite -> succeeds
      saveManifest(testFile, { test: 2 }, { overwrite: true });
      const read = JSON.parse(fs.readFileSync(testFile, 'utf8'));
      assert.equal(read.test, 2);

      // Cleanup
      fs.unlinkSync(testFile);
      fs.rmdirSync(testDir);
    });
  });

  describe('6. Local Hardhat Bootstrap Choreography & Assertion Simulation', function () {
    it('executes full 5-step Standard bootstrap choreography and validates all assertions locally', async function () {
      const [deployer, owner, p1, p2, p3, e1, e2, e3] = await ethers.getSigners();

      // Mock USDC
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const usdc = await MockERC20.deploy('USDC', 'USDC', 6, 1_000_000_000_000n);
      await usdc.waitForDeployment();
      const usdcAddr = await usdc.getAddress();

      // Step 1: Deploy SynqDealV1 implementation
      const SynqDealV1 = await ethers.getContractFactory('SynqDealV1');
      const dealImpl = await SynqDealV1.deploy();
      await dealImpl.waitForDeployment();
      const dealImplAddr = await dealImpl.getAddress();

      // Verify implementation cannot be used directly as an initialized deal
      assert.equal(await dealImpl.client(), ZERO_ADDR);

      // Step 2: Deploy SynqFactoryV1 in bootstrap state (resolvers set to dealImpl temporary placeholder)
      const SynqFactoryV1 = await ethers.getContractFactory('SynqFactoryV1');
      const factory = await SynqFactoryV1.deploy(
        owner.address,
        usdcAddr,
        dealImplAddr,
        dealImplAddr, // temporary placeholder
        dealImplAddr  // temporary placeholder
      );
      await factory.waitForDeployment();
      const factoryAddr = await factory.getAddress();

      // Step 3: Deploy Primary Committee
      const SynqResolutionCommittee = await ethers.getContractFactory('SynqResolutionCommittee');
      const primaryCommittee = await SynqResolutionCommittee.deploy(
        factoryAddr,
        p1.address,
        p2.address,
        p3.address
      );
      await primaryCommittee.waitForDeployment();
      const primaryAddr = await primaryCommittee.getAddress();

      // Step 4: Deploy Emergency Committee
      const emergencyCommittee = await SynqResolutionCommittee.deploy(
        factoryAddr,
        e1.address,
        e2.address,
        e3.address
      );
      await emergencyCommittee.waitForDeployment();
      const emergencyAddr = await emergencyCommittee.getAddress();

      // Step 5: Wire real resolvers into Factory
      await factory.connect(owner).setDefaultPrimaryResolver(primaryAddr);
      await factory.connect(owner).setDefaultEmergencyResolver(emergencyAddr);

      // Post-deployment readback assertions
      assert.equal(await factory.canonicalUsdc(), usdcAddr);
      assert.equal(await factory.dealImplementation(), dealImplAddr);
      assert.equal(await factory.defaultPrimaryResolver(), primaryAddr);
      assert.equal(await factory.defaultEmergencyResolver(), emergencyAddr);
      assert.equal(await factory.defaultProtectionModule(), ZERO_ADDR);
      assert.equal(await factory.defaultProtectionPolicyId(), ethers.ZeroHash);
      assert.equal(await factory.owner(), owner.address);

      assert.equal(await primaryCommittee.factory(), factoryAddr);
      assert.equal(await emergencyCommittee.factory(), factoryAddr);
      assert.equal(await primaryCommittee.committeeEpoch(), 0n);
      assert.equal(await emergencyCommittee.committeeEpoch(), 0n);

      const pSigners = await primaryCommittee.getSigners();
      assert.equal(pSigners[0], p1.address);
      assert.equal(pSigners[1], p2.address);
      assert.equal(pSigners[2], p3.address);

      const eSigners = await emergencyCommittee.getSigners();
      assert.equal(eSigners[0], e1.address);
      assert.equal(eSigners[1], e2.address);
      assert.equal(eSigners[2], e3.address);

      // Verify a Standard Deal can immediately be created on the wired Factory
      const latestBlock = await ethers.provider.getBlock('latest');
      const nowTime = BigInt(latestBlock.timestamp);

      const tx = await factory.connect(deployer).createDeal(
        deployer.address,
        p1.address,
        [
          {
            amount: 1_000_000n,
            workDeadline: nowTime + 86400n * 7n,
            reviewWindow: 86400n * 3n,
            gracePeriod: 0n,
            specHash: ethers.keccak256(ethers.toUtf8Bytes('Standard Spec')),
          },
        ]
      );
      const receipt = await tx.wait();
      assert.equal(await factory.getDealCount(), 1n);

      const dealAddr = await factory.allDeals(0);
      assert.equal(await factory.isSynqDeal(dealAddr), true);
    });
  });
});
