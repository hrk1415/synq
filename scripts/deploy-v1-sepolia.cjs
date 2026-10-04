// scripts/deploy-v1-sepolia.cjs
/**
 * Synq Deal V1 Standard Protocol Deployment Tooling
 * Target: Ethereum Sepolia (chainId: 11155111)
 *
 * Deploys Standard Deal infrastructure:
 * 1. SynqDealV1 implementation
 * 2. SynqFactoryV1 (bootstrap mode)
 * 3. Primary SynqResolutionCommittee
 * 4. Emergency SynqResolutionCommittee
 * 5. Wires resolvers into SynqFactoryV1
 * 6. Executes exhaustive post-deployment assertions
 * 7. Writes sanitized deployment manifest
 *
 * NOTE: Active Protection is NOT deployed in this phase.
 */
const { ethers, network } = require('hardhat');
const path = require('path');
const {
  SEPOLIA_CHAIN_ID,
  SEPOLIA_CANONICAL_USDC,
  validateDeploymentConfig,
  buildSanitizedPlan,
  buildManifest,
  saveManifest,
} = require('./lib/v1-deployment-config.cjs');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';
const MANIFEST_PATH = path.join(__dirname, '..', 'deployments', 'sepolia-v1-standard.json');

async function main() {
  console.log('====================================================');
  console.log('  SYNQ DEAL V1 STANDARD DEPLOYMENT TOOLING');
  console.log('====================================================\n');

  const isDryRun =
    process.env.SYNQ_DEPLOY_DRY_RUN === 'true' ||
    process.argv.includes('--dry-run');

  // --- Network Hard Stop ---
  const chainId = Number(network.config.chainId || (await ethers.provider.getNetwork()).chainId);
  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `NETWORK HARD STOP: Synq Deal V1 deployment script strictly refuses to execute on chainId ${chainId}. Only Sepolia (${SEPOLIA_CHAIN_ID}) is supported.`
    );
  }

  // --- Load and Validate Configuration ---
  const rawConfig = {
    chainId,
    canonicalUsdc: SEPOLIA_CANONICAL_USDC,
    primarySignerA: process.env.SYNQ_PRIMARY_SIGNER_A,
    primarySignerB: process.env.SYNQ_PRIMARY_SIGNER_B,
    primarySignerC: process.env.SYNQ_PRIMARY_SIGNER_C,
    emergencySignerA: process.env.SYNQ_EMERGENCY_SIGNER_A,
    emergencySignerB: process.env.SYNQ_EMERGENCY_SIGNER_B,
    emergencySignerC: process.env.SYNQ_EMERGENCY_SIGNER_C,
    factoryOwner: process.env.SYNQ_FACTORY_OWNER,
  };

  const options = {
    allowIdenticalCommittees: process.env.SYNQ_ALLOW_IDENTICAL_COMMITTEES === 'true',
    overwriteManifest: process.env.SYNQ_OVERWRITE_MANIFEST === 'true',
  };

  const validatedConfig = validateDeploymentConfig(rawConfig, options);

  const [deployer] = await ethers.getSigners();
  const deployerAddress = deployer ? deployer.address : null;

  const plan = buildSanitizedPlan(validatedConfig, deployerAddress);

  console.log('Validated Deployment Plan:');
  console.log(JSON.stringify(plan, null, 2));
  console.log('\n');

  if (validatedConfig.warnings.length > 0) {
    console.log('--- WARNINGS ---');
    for (const w of validatedConfig.warnings) {
      console.log(`[!] ${w}`);
    }
    console.log('----------------\n');
  }

  // --- Dry-Run Exit ---
  if (isDryRun) {
    console.log('>>> DRY-RUN MODE: Configuration validated successfully. Zero transactions sent. Exiting. <<<');
    return;
  }

  if (!deployerAddress) {
    throw new Error('No deployer signer configured for Sepolia. Check SEPOLIA_PRIVATE_KEY.');
  }

  const balance = await ethers.provider.getBalance(deployerAddress);
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH\n`);

  if (balance === 0n) {
    throw new Error('Deployer wallet has 0 ETH. Please fund with Sepolia ETH before deploying.');
  }

  // --- Deployment Recovery Tracker ---
  const recoveryState = {
    step: 0,
    status: 'NOT_STARTED',
    dealImplementation: null,
    factory: null,
    primaryCommittee: null,
    emergencyCommittee: null,
    txHashes: {},
  };

  try {
    // Step 1: SynqDealV1 implementation
    console.log('[Step 1/5] Deploying SynqDealV1 implementation...');
    const DealImpl = await ethers.getContractFactory('SynqDealV1');
    const dealImpl = await DealImpl.deploy();
    await dealImpl.waitForDeployment();
    recoveryState.dealImplementation = await dealImpl.getAddress();
    recoveryState.step = 1;
    console.log(`  -> SynqDealV1 implementation deployed at: ${recoveryState.dealImplementation}\n`);

    // Step 2: SynqFactoryV1 in Bootstrap Mode
    console.log('[Step 2/5] Deploying SynqFactoryV1 (BOOTSTRAP MODE)...');
    console.log('  NOTE: Initial resolvers temporarily bound to dealImplementation to resolve code.length > 0 circular dependency.');
    const factoryOwner = validatedConfig.factoryOwner || deployerAddress;
    const Factory = await ethers.getContractFactory('SynqFactoryV1');
    const factory = await Factory.deploy(
      factoryOwner,
      validatedConfig.canonicalUsdc,
      recoveryState.dealImplementation,
      recoveryState.dealImplementation, // temporary resolver placeholder
      recoveryState.dealImplementation  // temporary resolver placeholder
    );
    await factory.waitForDeployment();
    recoveryState.factory = await factory.getAddress();
    recoveryState.step = 2;
    recoveryState.status = 'BOOTSTRAPPING_NOT_READY';
    console.log(`  -> SynqFactoryV1 deployed at: ${recoveryState.factory}`);
    console.log('  -> Factory status: BOOTSTRAPPING / NOT READY (deal creation prohibited until resolvers wired)\n');

    // Step 3: Primary SynqResolutionCommittee
    console.log('[Step 3/5] Deploying Primary SynqResolutionCommittee...');
    const Committee = await ethers.getContractFactory('SynqResolutionCommittee');
    const primaryCommittee = await Committee.deploy(
      recoveryState.factory,
      validatedConfig.primarySigners[0],
      validatedConfig.primarySigners[1],
      validatedConfig.primarySigners[2]
    );
    await primaryCommittee.waitForDeployment();
    recoveryState.primaryCommittee = await primaryCommittee.getAddress();
    recoveryState.step = 3;
    console.log(`  -> Primary Committee deployed at: ${recoveryState.primaryCommittee}\n`);

    // Step 4: Emergency SynqResolutionCommittee
    console.log('[Step 4/5] Deploying Emergency SynqResolutionCommittee...');
    const emergencyCommittee = await Committee.deploy(
      recoveryState.factory,
      validatedConfig.emergencySigners[0],
      validatedConfig.emergencySigners[1],
      validatedConfig.emergencySigners[2]
    );
    await emergencyCommittee.waitForDeployment();
    recoveryState.emergencyCommittee = await emergencyCommittee.getAddress();
    recoveryState.step = 4;
    console.log(`  -> Emergency Committee deployed at: ${recoveryState.emergencyCommittee}\n`);

    // Step 5: Wire real resolvers into SynqFactoryV1
    console.log('[Step 5/5] Wiring real resolvers into SynqFactoryV1...');
    const tx1 = await factory.setDefaultPrimaryResolver(recoveryState.primaryCommittee);
    const rc1 = await tx1.wait();
    recoveryState.txHashes.setPrimaryResolver = rc1.hash;
    console.log(`  -> setDefaultPrimaryResolver tx mined: ${rc1.hash}`);

    const tx2 = await factory.setDefaultEmergencyResolver(recoveryState.emergencyCommittee);
    const rc2 = await tx2.wait();
    recoveryState.txHashes.setEmergencyResolver = rc2.hash;
    console.log(`  -> setDefaultEmergencyResolver tx mined: ${rc2.hash}\n`);

    recoveryState.step = 5;
    recoveryState.status = 'WIRED_AWAITING_ASSERTIONS';

    // --- Post-Deployment Readback Assertions ---
    console.log('Executing exhaustive post-deployment assertions...');

    const readUsdc = await factory.canonicalUsdc();
    if (readUsdc.toLowerCase() !== validatedConfig.canonicalUsdc.toLowerCase()) {
      throw new Error(`Assertion failed: factory.canonicalUsdc ${readUsdc} !== ${validatedConfig.canonicalUsdc}`);
    }

    const readImpl = await factory.dealImplementation();
    if (readImpl.toLowerCase() !== recoveryState.dealImplementation.toLowerCase()) {
      throw new Error(`Assertion failed: factory.dealImplementation ${readImpl} !== ${recoveryState.dealImplementation}`);
    }

    const readPrimary = await factory.defaultPrimaryResolver();
    if (readPrimary.toLowerCase() !== recoveryState.primaryCommittee.toLowerCase()) {
      throw new Error(`Assertion failed: factory.defaultPrimaryResolver ${readPrimary} !== ${recoveryState.primaryCommittee}`);
    }

    const readEmergency = await factory.defaultEmergencyResolver();
    if (readEmergency.toLowerCase() !== recoveryState.emergencyCommittee.toLowerCase()) {
      throw new Error(`Assertion failed: factory.defaultEmergencyResolver ${readEmergency} !== ${recoveryState.emergencyCommittee}`);
    }

    const readModule = await factory.defaultProtectionModule();
    if (readModule !== ZERO_ADDRESS) {
      throw new Error(`Assertion failed: factory.defaultProtectionModule must be zero address, got ${readModule}`);
    }

    const readPolicy = await factory.defaultProtectionPolicyId();
    if (readPolicy !== ZERO_BYTES32) {
      throw new Error(`Assertion failed: factory.defaultProtectionPolicyId must be zero bytes32, got ${readPolicy}`);
    }

    const readOwner = await factory.owner();
    if (readOwner.toLowerCase() !== factoryOwner.toLowerCase()) {
      throw new Error(`Assertion failed: factory.owner ${readOwner} !== ${factoryOwner}`);
    }

    const primaryBoundFactory = await primaryCommittee.factory();
    if (primaryBoundFactory.toLowerCase() !== recoveryState.factory.toLowerCase()) {
      throw new Error(`Assertion failed: primaryCommittee.factory ${primaryBoundFactory} !== ${recoveryState.factory}`);
    }

    const emergencyBoundFactory = await emergencyCommittee.factory();
    if (emergencyBoundFactory.toLowerCase() !== recoveryState.factory.toLowerCase()) {
      throw new Error(`Assertion failed: emergencyCommittee.factory ${emergencyBoundFactory} !== ${recoveryState.factory}`);
    }

    const primaryEpoch = await primaryCommittee.committeeEpoch();
    if (primaryEpoch !== 0n) {
      throw new Error(`Assertion failed: primaryCommittee.committeeEpoch must be 0, got ${primaryEpoch}`);
    }

    const emergencyEpoch = await emergencyCommittee.committeeEpoch();
    if (emergencyEpoch !== 0n) {
      throw new Error(`Assertion failed: emergencyCommittee.committeeEpoch must be 0, got ${emergencyEpoch}`);
    }

    const primarySigners = await primaryCommittee.getSigners();
    for (let i = 0; i < 3; i++) {
      if (primarySigners[i].toLowerCase() !== validatedConfig.primarySigners[i].toLowerCase()) {
        throw new Error(`Assertion failed: primarySigner [${i}] ${primarySigners[i]} !== ${validatedConfig.primarySigners[i]}`);
      }
    }

    const emergencySigners = await emergencyCommittee.getSigners();
    for (let i = 0; i < 3; i++) {
      if (emergencySigners[i].toLowerCase() !== validatedConfig.emergencySigners[i].toLowerCase()) {
        throw new Error(`Assertion failed: emergencySigner [${i}] ${emergencySigners[i]} !== ${validatedConfig.emergencySigners[i]}`);
      }
    }

    // Verify implementation logic cannot hold active user deal
    const implClient = await dealImpl.client();
    if (implClient !== ZERO_ADDRESS) {
      throw new Error(`Assertion failed: dealImplementation cannot hold active client, got ${implClient}`);
    }

    console.log('All 15 post-deployment readback assertions PASSED.\n');

    recoveryState.status = 'STANDARD_READY';

    // --- Write Deployment Manifest ---
    const manifestData = buildManifest({
      deployedAt: new Date().toISOString(),
      deployer: deployerAddress,
      dealImplementation: recoveryState.dealImplementation,
      factory: recoveryState.factory,
      primaryResolver: recoveryState.primaryCommittee,
      emergencyResolver: recoveryState.emergencyCommittee,
      factoryOwner,
      primarySigners: validatedConfig.primarySigners,
      emergencySigners: validatedConfig.emergencySigners,
    });

    const savedFile = saveManifest(MANIFEST_PATH, manifestData, {
      overwrite: options.overwriteManifest,
    });
    console.log(`Sanitized deployment manifest written to:\n  ${savedFile}\n`);

    // --- Final Summary ---
    console.log('====================================================');
    console.log('  SYNQ DEAL V1 STANDARD DEPLOYMENT SUCCESSFUL');
    console.log('====================================================');
    console.log(`Network:             Sepolia (chainId: ${SEPOLIA_CHAIN_ID})`);
    console.log(`Deal Implementation: ${recoveryState.dealImplementation}`);
    console.log(`SynqFactoryV1:       ${recoveryState.factory}`);
    console.log(`Primary Resolver:    ${recoveryState.primaryCommittee}`);
    console.log(`Emergency Resolver:  ${recoveryState.emergencyCommittee}`);
    console.log(`Canonical USDC:      ${validatedConfig.canonicalUsdc}`);
    console.log(`Factory Owner:       ${factoryOwner}`);
    console.log('Active Protection:   DISABLED (Standard Deals only)');
    console.log('====================================================\n');
  } catch (err) {
    console.error('\n****************************************************');
    console.error('  INCOMPLETE DEPLOYMENT — DO NOT USE FACTORY');
    console.error('****************************************************');
    console.error(`Error encountered at step ${recoveryState.step}: ${err.message}\n`);
    console.error('Sanitized Recovery State:');
    console.error(JSON.stringify(recoveryState, null, 2));
    console.error('****************************************************\n');
    throw err;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { main };
