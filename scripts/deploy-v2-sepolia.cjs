// scripts/deploy-v2-sepolia.cjs
/**
 * Synq Deal Protocol V2 Standard Deployment Tooling
 * Target: Ethereum Sepolia (chainId: 11155111)
 *
 * Deploys V2 Freelancer Consent Infrastructure:
 * 1. Verifies existing deployed SynqDealV1 implementation (reused at 0x2a3C8A880398FF6DD8e6F9976c8BE6C8aBef2435)
 * 2. Deploys SynqFactoryV2 (bootstrap mode)
 * 3. Deploys New Primary SynqResolutionCommittee bound to Factory V2
 * 4. Deploys New Emergency SynqResolutionCommittee bound to Factory V2
 * 5. Wires real committee resolvers into SynqFactoryV2
 * 6. Executes exhaustive 19-point post-deployment assertions
 * 7. Writes sanitized deployment manifest to deployments/sepolia-v2-standard.json
 *
 * NOTE: Active Protection remains DISABLED. SynqDealV1 is REUSED and NOT redeployed.
 */
const { ethers, network } = require('hardhat');
const path = require('path');
const fs = require('fs');
const {
  SEPOLIA_CHAIN_ID,
  SEPOLIA_CANONICAL_USDC,
  SEPOLIA_DEAL_IMPLEMENTATION,
  validateV2DeploymentConfig,
  verifyDealImplementationBytecode,
  buildSanitizedV2Plan,
  buildV2Manifest,
  saveV2Manifest,
  executeV2Assertions,
} = require('./lib/v2-deployment-config.cjs');

const MANIFEST_PATH = path.join(__dirname, '..', 'deployments', 'sepolia-v2-standard.json');

async function main() {
  console.log('====================================================');
  console.log('  SYNQ FACTORY V2 SEPOLIA DEPLOYMENT TOOLING');
  console.log('====================================================\n');

  const isDryRun =
    process.env.SYNQ_DEPLOY_DRY_RUN === 'true' ||
    process.argv.includes('--dry-run');

  // --- Network Hard Stop ---
  let chainId;
  if (isDryRun) {
    // In dry-run mode, validate configuration against Sepolia target without requiring network connection
    chainId = SEPOLIA_CHAIN_ID;
  } else {
    const net = await ethers.provider.getNetwork();
    chainId = Number(net.chainId);
    if (chainId !== SEPOLIA_CHAIN_ID) {
      throw new Error(
        `NETWORK HARD STOP: Synq Factory V2 deployment script strictly refuses to execute on chainId ${chainId}. Only Sepolia (${SEPOLIA_CHAIN_ID}) is supported.`
      );
    }
  }

  // --- Load and Validate Configuration ---
  const rawConfig = {
    chainId,
    canonicalUsdc: SEPOLIA_CANONICAL_USDC,
    dealImplementation: SEPOLIA_DEAL_IMPLEMENTATION,
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
    overwriteManifest: process.env.SYNQ_OVERWRITE_V2_MANIFEST === 'true',
  };

  const validatedConfig = validateV2DeploymentConfig(rawConfig, options);

  let deployerAddress = null;
  let deployer = null;
  try {
    const signers = await ethers.getSigners();
    if (signers.length > 0) {
      deployer = signers[0];
      deployerAddress = deployer.address;
    }
  } catch {
    // offline dry run fallback
  }

  const plan = buildSanitizedV2Plan(validatedConfig, deployerAddress);

  console.log('Validated V2 Deployment Plan:');
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

  if (!deployerAddress || !deployer) {
    throw new Error('No deployer signer configured for Sepolia. Check SEPOLIA_PRIVATE_KEY.');
  }

  const balance = await ethers.provider.getBalance(deployerAddress);
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH\n`);

  if (balance === 0n) {
    throw new Error('Deployer wallet has 0 ETH. Please fund with Sepolia ETH before deploying.');
  }

  // --- Pre-Deployment On-Chain Verification of Reused SynqDealV1 Implementation ---
  console.log('Performing pre-deployment checks on existing infrastructure...');
  const dealImplCode = await ethers.provider.getCode(validatedConfig.dealImplementation);
  if (!dealImplCode || dealImplCode === '0x' || dealImplCode === '0x0') {
    throw new Error(
      `PREDEPLOYMENT BLOCKER: Existing SynqDealV1 at ${validatedConfig.dealImplementation} has no code on Sepolia.`
    );
  }

  // Load local SynqDealV1 artifact to verify bytecode match
  const dealArtifactPath = path.join(
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
  let localDealArtifact = null;
  if (fs.existsSync(dealArtifactPath)) {
    localDealArtifact = JSON.parse(fs.readFileSync(dealArtifactPath, 'utf8'));
  }

  const codeVerification = verifyDealImplementationBytecode(
    dealImplCode,
    localDealArtifact ? localDealArtifact.deployedBytecode : null
  );
  console.log(`  -> SynqDealV1 bytecode verified: ${codeVerification.bytes} bytes (${codeVerification.match} match)`);

  const dealImplContract = await ethers.getContractAt('SynqDealV1', validatedConfig.dealImplementation);
  const existingClient = await dealImplContract.client();
  if (existingClient !== ethers.ZeroAddress) {
    throw new Error(
      `PREDEPLOYMENT BLOCKER: Existing SynqDealV1 implementation at ${validatedConfig.dealImplementation} is initialized! client=${existingClient}`
    );
  }
  const existingMilestones = await dealImplContract.milestoneCount();
  if (existingMilestones !== 0n) {
    throw new Error(
      `PREDEPLOYMENT BLOCKER: Existing SynqDealV1 implementation milestoneCount is non-zero: ${existingMilestones}`
    );
  }

  // Verify Canonical USDC
  const usdcCode = await ethers.provider.getCode(validatedConfig.canonicalUsdc);
  if (!usdcCode || usdcCode === '0x') {
    throw new Error(
      `PREDEPLOYMENT BLOCKER: Canonical USDC at ${validatedConfig.canonicalUsdc} has no code on Sepolia.`
    );
  }
  const usdcContract = await ethers.getContractAt('IERC20Metadata', validatedConfig.canonicalUsdc);
  const usdcDecimals = await usdcContract.decimals();
  if (Number(usdcDecimals) !== 6) {
    throw new Error(`PREDEPLOYMENT BLOCKER: Canonical USDC decimals != 6 (got ${usdcDecimals})`);
  }
  console.log(`  -> Canonical USDC verified: ${validatedConfig.canonicalUsdc} (decimals: ${usdcDecimals})\n`);

  // --- Deployment Recovery Tracker ---
  const recoveryState = {
    step: 0,
    status: 'NOT_STARTED',
    dealImplementation: validatedConfig.dealImplementation,
    factory: null,
    primaryCommittee: null,
    emergencyCommittee: null,
    txHashes: {},
  };

  try {
    // Step 1: Reused Deal Implementation
    console.log('[Step 1/5] Verified existing SynqDealV1 implementation...');
    console.log(`  -> Reusing deployed SynqDealV1: ${recoveryState.dealImplementation} (NOT redeployed)\n`);
    recoveryState.step = 1;

    // Step 2: Deploy SynqFactoryV2 in Bootstrap Mode
    console.log('[Step 2/5] Deploying SynqFactoryV2 (BOOTSTRAP MODE)...');
    console.log('  NOTE: Initial resolvers temporarily bound to dealImplementation to satisfy code.length > 0 circular dependency.');
    const factoryOwner = validatedConfig.factoryOwner || deployerAddress;
    const FactoryV2 = await ethers.getContractFactory('SynqFactoryV2');
    const factory = await FactoryV2.deploy(
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
    console.log(`  -> SynqFactoryV2 deployed at: ${recoveryState.factory}`);
    console.log('  -> Factory status: BOOTSTRAPPING / NOT READY (deal creation prohibited until resolvers wired)\n');

    // Step 3: Primary SynqResolutionCommittee
    console.log('[Step 3/5] Deploying New Primary SynqResolutionCommittee...');
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
    console.log(`  -> New Primary Committee deployed at: ${recoveryState.primaryCommittee}\n`);

    // Step 4: Emergency SynqResolutionCommittee
    console.log('[Step 4/5] Deploying New Emergency SynqResolutionCommittee...');
    const emergencyCommittee = await Committee.deploy(
      recoveryState.factory,
      validatedConfig.emergencySigners[0],
      validatedConfig.emergencySigners[1],
      validatedConfig.emergencySigners[2]
    );
    await emergencyCommittee.waitForDeployment();
    recoveryState.emergencyCommittee = await emergencyCommittee.getAddress();
    recoveryState.step = 4;
    console.log(`  -> New Emergency Committee deployed at: ${recoveryState.emergencyCommittee}\n`);

    // Step 5: Wire real resolvers into SynqFactoryV2
    console.log('[Step 5/5] Wiring real resolvers into SynqFactoryV2...');
    const tx1 = await factory.setDefaultPrimaryResolver(recoveryState.primaryCommittee);
    const rc1 = await tx1.wait();
    recoveryState.txHashes.setDefaultPrimaryResolver = rc1.hash;
    console.log(`  -> setDefaultPrimaryResolver tx mined: ${rc1.hash}`);

    const tx2 = await factory.setDefaultEmergencyResolver(recoveryState.emergencyCommittee);
    const rc2 = await tx2.wait();
    recoveryState.txHashes.setDefaultEmergencyResolver = rc2.hash;
    console.log(`  -> setDefaultEmergencyResolver tx mined: ${rc2.hash}\n`);

    recoveryState.step = 5;
    recoveryState.status = 'WIRED_AWAITING_ASSERTIONS';

    // --- Post-Deployment Readback Assertions ---
    console.log('Executing exhaustive 19-point post-deployment assertions...');
    await executeV2Assertions({
      factory,
      primaryCommittee,
      emergencyCommittee,
      dealImpl: dealImplContract,
      expectedConfig: validatedConfig,
      factoryOwner,
      deployerAddress,
      expectedChainId: SEPOLIA_CHAIN_ID,
    });
    console.log('All 19 post-deployment assertions PASSED.\n');

    recoveryState.status = 'READY_FOR_PROPOSALS';

    // --- Write Deployment Manifest ---
    const manifestData = buildV2Manifest({
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

    const savedFile = saveV2Manifest(MANIFEST_PATH, manifestData, {
      overwrite: options.overwriteManifest,
    });
    console.log(`Sanitized V2 deployment manifest written to:\n  ${savedFile}\n`);

    // --- Final Summary ---
    console.log('====================================================');
    console.log('  SYNQ FACTORY V2 SEPOLIA DEPLOYMENT SUCCESSFUL');
    console.log('====================================================');
    console.log(`Network:                   Sepolia (chainId: ${SEPOLIA_CHAIN_ID})`);
    console.log(`Reused Deal Logic:         ${recoveryState.dealImplementation}`);
    console.log(`SynqFactoryV2:             ${recoveryState.factory}`);
    console.log(`New Primary Resolver:      ${recoveryState.primaryCommittee}`);
    console.log(`New Emergency Resolver:    ${recoveryState.emergencyCommittee}`);
    console.log(`Canonical USDC:            ${validatedConfig.canonicalUsdc}`);
    console.log(`Factory Owner:             ${factoryOwner}`);
    console.log(`Consent Model:             EIP-712 DealProposal -> on-chain acceptDealProposal`);
    console.log(`Direct Deal Creation:      DISABLED`);
    console.log(`Active Protection:         DISABLED (Standard Deals only)`);
    console.log(`Status:                    READY FOR PROPOSALS`);
    console.log('====================================================\n');
  } catch (err) {
    console.error('\n****************************************************');
    console.error('  INCOMPLETE V2 DEPLOYMENT — DO NOT USE FACTORY');
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
