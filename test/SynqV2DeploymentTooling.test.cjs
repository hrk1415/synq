// test/SynqV2DeploymentTooling.test.cjs
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ethers } = require('hardhat');
const {
  SEPOLIA_CHAIN_ID,
  SEPOLIA_CANONICAL_USDC,
  SEPOLIA_DEAL_IMPLEMENTATION,
  SEPOLIA_PREVIOUS_FACTORY_V1,
  COMMITTEE_THRESHOLD,
  EXPECTED_DEAL_BYTECODE_LENGTH,
  EXPECTED_FACTORY_V2_BYTECODE_LENGTH,
  verifyDealImplementationBytecode,
  validateV2DeploymentConfig,
  buildSanitizedV2Plan,
  buildV2Manifest,
  saveV2Manifest,
  executeV2Assertions,
} = require('../scripts/lib/v2-deployment-config.cjs');

describe('Synq Factory V2 Deployment Tooling Test Suite (Phase 2D-4)', function () {
  const SIGNER_P1 = '0x6F270E8c6DE66fB53A97e59E3e89E2A02290e7Fa';
  const SIGNER_P2 = '0x17Cd3B3B214191805EB92BaA31518c7Ea76078b3';
  const SIGNER_P3 = '0x0491C59AdC81774dEeaB0777dC9eCEB1ea882f34';

  const SIGNER_E1 = '0x90d2b8EB2ec109880D7f29474f1E323e156cc659';
  const SIGNER_E2 = '0xd0098BD613753d6d591fCc172108CE4bF314bCf7';
  const SIGNER_E3 = '0x8acB20e0a0E2c8a8327C8fCf8bc482C9BAa9772E';

  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
  const OWNER_ADDR = '0xD2D4d415a4730b1490c9Ce27944529B83ff76319';

  function validRawConfig() {
    return {
      chainId: SEPOLIA_CHAIN_ID,
      canonicalUsdc: SEPOLIA_CANONICAL_USDC,
      dealImplementation: SEPOLIA_DEAL_IMPLEMENTATION,
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
      const res = validateV2DeploymentConfig(cfg);
      assert.equal(res.chainId, 11155111);
    });

    it('rejects wrong chainId (e.g. 1 mainnet, 31337 hardhat)', function () {
      const cfgMainnet = { ...validRawConfig(), chainId: 1 };
      assert.throws(
        () => validateV2DeploymentConfig(cfgMainnet),
        /Network hard stop: Synq Deal V2 deployment script requires Sepolia chainId 11155111, got 1/
      );

      const cfgLocal = { ...validRawConfig(), chainId: 31337 };
      assert.throws(
        () => validateV2DeploymentConfig(cfgLocal),
        /Network hard stop: Synq Deal V2 deployment script requires Sepolia chainId 11155111, got 31337/
      );
    });
  });

  describe('2. Canonical USDC & Deal Implementation Constants', function () {
    it('enforces canonical Sepolia USDC address', function () {
      const validated = validateV2DeploymentConfig(validRawConfig());
      assert.equal(validated.canonicalUsdc, SEPOLIA_CANONICAL_USDC);
    });

    it('rejects mismatched canonical USDC address', function () {
      const cfg = { ...validRawConfig(), canonicalUsdc: '0x9999999999999999999999999999999999999999' };
      assert.throws(
        () => validateV2DeploymentConfig(cfg),
        /Canonical USDC mismatch/
      );
    });

    it('enforces expected reused Deal implementation address', function () {
      const validated = validateV2DeploymentConfig(validRawConfig());
      assert.equal(validated.dealImplementation, SEPOLIA_DEAL_IMPLEMENTATION);
    });

    it('rejects unexpected Deal implementation address', function () {
      const cfg = { ...validRawConfig(), dealImplementation: '0x8888888888888888888888888888888888888888' };
      assert.throws(
        () => validateV2DeploymentConfig(cfg),
        /Deal implementation mismatch/
      );
    });

    it('enforces expected committee threshold == 2', function () {
      assert.equal(COMMITTEE_THRESHOLD, 2);
    });
  });

  describe('3. Signer Validation & Committee Integrity', function () {
    it('rejects zero signer address', function () {
      const cfg = { ...validRawConfig(), primarySignerA: ZERO_ADDR };
      assert.throws(
        () => validateV2DeploymentConfig(cfg),
        /not a valid non-zero address/
      );
    });

    it('rejects invalid/malformed address string', function () {
      const cfg = { ...validRawConfig(), primarySignerB: '0xinvalidEthAddress' };
      assert.throws(
        () => validateV2DeploymentConfig(cfg),
        /not a valid non-zero address/
      );
    });

    it('rejects duplicate signer inside Primary Committee', function () {
      const cfg = { ...validRawConfig(), primarySignerC: SIGNER_P1 };
      assert.throws(
        () => validateV2DeploymentConfig(cfg),
        /Primary Resolution Committee contains duplicate signer address/
      );
    });

    it('rejects duplicate signer inside Emergency Committee', function () {
      const cfg = { ...validRawConfig(), emergencySignerB: SIGNER_E1 };
      assert.throws(
        () => validateV2DeploymentConfig(cfg),
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
        () => validateV2DeploymentConfig(cfg),
        /Primary and Emergency committees have identical signer sets/
      );
    });

    it('warns on partial overlap across Primary and Emergency', function () {
      const cfg = {
        ...validRawConfig(),
        emergencySignerA: SIGNER_P1, // 1 overlapping
      };
      const validated = validateV2DeploymentConfig(cfg);
      assert.equal(validated.warnings.length, 1);
      assert(validated.warnings[0].includes('share 1 overlapping signer'));
    });

    it('accepts completely valid independent production signer set with zero warnings', function () {
      const validated = validateV2DeploymentConfig(validRawConfig());
      assert.equal(validated.warnings.length, 0);
      assert.equal(validated.primarySigners.length, 3);
      assert.equal(validated.emergencySigners.length, 3);
      assert.equal(validated.factoryOwner, OWNER_ADDR);
    });

    it('falls back to deployer if factoryOwner is null/unset', function () {
      const cfg = validRawConfig();
      delete cfg.factoryOwner;
      const validated = validateV2DeploymentConfig(cfg);
      assert.equal(validated.factoryOwner, null);

      const plan = buildSanitizedV2Plan(validated, '0xDeployerAddress123456789012345678901234');
      assert.equal(plan.factoryOwner, '0xDeployerAddress123456789012345678901234');
    });
  });

  describe('4. SynqDealV1 Bytecode Verification Logic', function () {
    it('verifies exact bytecode match against local compiled artifact', function () {
      const artifactPath = path.join(
        __dirname,
        '..',
        'src',
        'lib',
        'contracts',
        'artifacts',
        'contracts',
        'v1',
        'SynqDealV1.sol',
        'SynqDealV1.json'
      );
      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      const result = verifyDealImplementationBytecode(artifact.deployedBytecode, artifact.deployedBytecode);
      assert.equal(result.match, 'exact');
      assert.equal(result.bytes, EXPECTED_DEAL_BYTECODE_LENGTH);
    });

    it('verifies executable-prefix match when CBOR metadata hash varies', function () {
      const artifactPath = path.join(
        __dirname,
        '..',
        'src',
        'lib',
        'contracts',
        'artifacts',
        'contracts',
        'v1',
        'SynqDealV1.sol',
        'SynqDealV1.json'
      );
      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      // Mutate the last 53 bytes (106 hex chars) of CBOR metadata
      const fakeDeployed =
        artifact.deployedBytecode.slice(0, -106) + 'aa'.repeat(53);
      const result = verifyDealImplementationBytecode(fakeDeployed, artifact.deployedBytecode);
      assert.equal(result.match, 'executable-prefix');
      assert.equal(result.bytes, EXPECTED_DEAL_BYTECODE_LENGTH);
    });

    it('rejects bytecode with wrong size or code modifications', function () {
      // Bytecode too short
      assert.throws(
        () => verifyDealImplementationBytecode('0x1234', '0x123456'),
        /Deal implementation runtime size mismatch/
      );

      // Modified executable code
      const artifactPath = path.join(
        __dirname,
        '..',
        'src',
        'lib',
        'contracts',
        'artifacts',
        'contracts',
        'v1',
        'SynqDealV1.sol',
        'SynqDealV1.json'
      );
      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      const mutatedExecutable = '0x' + '00'.repeat(10) + artifact.deployedBytecode.slice(22);
      assert.throws(
        () => verifyDealImplementationBytecode(mutatedExecutable, artifact.deployedBytecode),
        /Deal implementation bytecode differs from local SynqDealV1 artifact/
      );
    });
  });

  describe('5. Sanitized V2 Plan & Secret Isolation', function () {
    it('sanitized plan contains zero secret fields and documents consent + disabled protection', function () {
      const validated = validateV2DeploymentConfig(validRawConfig());
      const plan = buildSanitizedV2Plan(validated, '0xDeployerAddress123456789012345678901234');

      const planStr = JSON.stringify(plan);
      assert(!/private|secret|mnemonic/i.test(planStr), 'Plan must not contain private/secret terms');
      assert.equal(plan.protection.enabled, false);
      assert.equal(plan.consent.directCreationDisabled, true);
      assert.equal(plan.reusedDealImplementation, SEPOLIA_DEAL_IMPLEMENTATION);
      assert.equal(plan.supersededFactoryV1, SEPOLIA_PREVIOUS_FACTORY_V1);
    });

    it('sanitized plan explicitly marks Factory V2 in bootstrap mode before resolver wiring', function () {
      const validated = validateV2DeploymentConfig(validRawConfig());
      const plan = buildSanitizedV2Plan(validated, '0xDeployerAddress123456789012345678901234');

      const step1 = plan.steps.find((s) => s.step === 1);
      assert(step1.action.includes('Verify Existing SynqDealV1'));

      const step2 = plan.steps.find((s) => s.step === 2);
      assert(step2.status.includes('BOOTSTRAPPING / NOT READY'));

      const step5 = plan.steps.find((s) => s.step === 5);
      assert(step5.status.includes('READY FOR PROPOSALS'));
    });
  });

  describe('6. Manifest Builder, Overwrite Protection & V1 Isolation', function () {
    it('manifest builder creates complete V2 manifest with superseded V1 references', function () {
      const manifest = buildV2Manifest({
        deployer: '0xDeployer11111111111111111111111111111111',
        dealImplementation: SEPOLIA_DEAL_IMPLEMENTATION,
        factory: '0xFactoryV2333333333333333333333333333333',
        primaryResolver: '0xPrimary44444444444444444444444444444444',
        emergencyResolver: '0xEmergency5555555555555555555555555555555',
        factoryOwner: OWNER_ADDR,
        primarySigners: [SIGNER_P1, SIGNER_P2, SIGNER_P3],
        emergencySigners: [SIGNER_E1, SIGNER_E2, SIGNER_E3],
      });

      assert.equal(manifest.network, 'sepolia');
      assert.equal(manifest.chainId, 11155111);
      assert.equal(manifest.version, 'synq-deal-v2-standard');
      assert.equal(manifest.status, 'standard-ready');
      assert.equal(manifest.consent.directCreationDisabled, true);
      assert.equal(manifest.consent.model, 'EIP-712 DealProposal');
      assert.equal(manifest.contracts.dealImplementation, SEPOLIA_DEAL_IMPLEMENTATION);
      assert.equal(manifest.contracts.supersededFactoryV1, SEPOLIA_PREVIOUS_FACTORY_V1);
      assert.equal(manifest.history.reusedDealImplementation, true);
      assert.equal(manifest.protection.enabled, false);
    });

    it('manifest builder rejects serialization if private/secret key is present', function () {
      assert.throws(
        () =>
          buildV2Manifest({
            deployer: '0xDeployer',
            privateKey: '0xsecret',
          }),
        /Security violation: Key "privateKey" cannot be serialized into manifest/
      );
    });

    it('saveV2Manifest protects existing file by default and requires explicit overwrite', function () {
      const testDir = path.join(__dirname, 'tmp-v2-tooling-test');
      const testFile = path.join(testDir, 'test-v2-manifest.json');

      if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testFile, '{"test": true}', 'utf8');

      // Attempt save without overwrite -> throws
      assert.throws(
        () => saveV2Manifest(testFile, { test: 2 }, { overwrite: false }),
        /Deployment manifest already exists at .* Refusing to overwrite by default/
      );

      // Attempt save with overwrite -> succeeds
      saveV2Manifest(testFile, { test: 2 }, { overwrite: true });
      const read = JSON.parse(fs.readFileSync(testFile, 'utf8'));
      assert.equal(read.test, 2);

      // Cleanup
      fs.unlinkSync(testFile);
      fs.rmdirSync(testDir);
    });

    it('confirms existing deployments/sepolia-v1-standard.json remains untouched', function () {
      const v1Path = path.join(__dirname, '..', 'deployments', 'sepolia-v1-standard.json');
      assert(fs.existsSync(v1Path), 'V1 manifest must exist');
      const v1Data = JSON.parse(fs.readFileSync(v1Path, 'utf8'));
      assert.equal(v1Data.version, 'synq-deal-v1-standard');
      assert.equal(v1Data.contracts.factory, SEPOLIA_PREVIOUS_FACTORY_V1);
    });
  });

  describe('7. Local Hardhat V2 Bootstrap Choreography & 19 Post-Deployment Assertions', function () {
    it('executes full V2 bootstrap choreography, resolves circular dependency, and passes all 19 assertions', async function () {
      const [deployer, owner, p1, p2, p3, e1, e2, e3] = await ethers.getSigners();

      // Deploy Mock USDC
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const usdc = await MockERC20.deploy('USDC', 'USDC', 6, 1_000_000_000_000n);
      await usdc.waitForDeployment();
      const usdcAddr = await usdc.getAddress();

      // Step 1: Deploy SynqDealV1 implementation (reusable logic)
      const SynqDealV1 = await ethers.getContractFactory('SynqDealV1');
      const dealImpl = await SynqDealV1.deploy();
      await dealImpl.waitForDeployment();
      const dealImplAddr = await dealImpl.getAddress();

      assert.equal(await dealImpl.client(), ZERO_ADDR);
      assert.equal(await dealImpl.milestoneCount(), 0n);

      // Step 2: Deploy SynqFactoryV2 in bootstrap state (resolvers set to dealImpl placeholder)
      const SynqFactoryV2 = await ethers.getContractFactory('SynqFactoryV2');
      const factory = await SynqFactoryV2.deploy(
        owner.address,
        usdcAddr,
        dealImplAddr,
        dealImplAddr, // temporary placeholder
        dealImplAddr  // temporary placeholder
      );
      await factory.waitForDeployment();
      const factoryAddr = await factory.getAddress();

      // Step 3: Deploy New Primary Committee bound to Factory V2
      const SynqResolutionCommittee = await ethers.getContractFactory('SynqResolutionCommittee');
      const primaryCommittee = await SynqResolutionCommittee.deploy(
        factoryAddr,
        p1.address,
        p2.address,
        p3.address
      );
      await primaryCommittee.waitForDeployment();
      const primaryAddr = await primaryCommittee.getAddress();

      // Step 4: Deploy New Emergency Committee bound to Factory V2
      const emergencyCommittee = await SynqResolutionCommittee.deploy(
        factoryAddr,
        e1.address,
        e2.address,
        e3.address
      );
      await emergencyCommittee.waitForDeployment();
      const emergencyAddr = await emergencyCommittee.getAddress();

      // Step 5: Wire real resolvers into SynqFactoryV2
      await factory.connect(owner).setDefaultPrimaryResolver(primaryAddr);
      await factory.connect(owner).setDefaultEmergencyResolver(emergencyAddr);

      // Step 6: Post-Deployment Readback Assertions
      const currentNetwork = await ethers.provider.getNetwork();
      const currentChainId = Number(currentNetwork.chainId);

      const assertionConfig = {
        canonicalUsdc: usdcAddr,
        dealImplementation: dealImplAddr,
        primarySigners: [p1.address, p2.address, p3.address],
        emergencySigners: [e1.address, e2.address, e3.address],
      };

      const result = await executeV2Assertions({
        factory,
        primaryCommittee,
        emergencyCommittee,
        dealImpl,
        expectedConfig: assertionConfig,
        factoryOwner: owner.address,
        deployerAddress: deployer.address,
        expectedChainId: currentChainId,
      });

      assert.equal(result, true, 'All 19 assertions must pass');
    });
  });
});
