// scripts/deploy-premium-protection-v1.1-sepolia.cjs
/**
 * Synq Premium Protection V1.1 Sepolia Deployment Tooling
 * Target: Ethereum Sepolia (chainId: 11155111)
 *
 * Deploys ONLY SynqPremiumProtectionManagerV1_1.
 * Reuses existing canonical Factory, USDC, SynqProtectionPool, and SynqProtectionCommittee.
 * DOES NOT rotate manager on pool (Manager rotation is separately authorized).
 *
 * Supports --dry-run and --keyless modes.
 * Writes manifest to deployments/sepolia-premium-protection-v1.1.json upon live execution.
 */
if (!process.env.HARDHAT_NETWORK) {
  process.env.HARDHAT_NETWORK = 'sepolia';
}

const { ethers, network } = require('hardhat');
const path = require('path');
const fs = require('fs');

const SEPOLIA_CHAIN_ID = 11155111;
const CANONICAL_V1_MANIFEST_PATH = path.join(__dirname, '../deployments/sepolia-premium-protection-v1.json');
const TARGET_V1_1_MANIFEST_PATH = path.join(__dirname, '../deployments/sepolia-premium-protection-v1.1.json');
const CANONICAL_OWNER = '0xD2D4d415a4730b1490c9Ce27944529B83ff76319';

function getArgValue(flag) {
  const prefix = `${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

async function main() {
  console.log('====================================================');
  console.log('  SYNQ PREMIUM PROTECTION V1.1 SEPOLIA DEPLOYMENT');
  console.log('====================================================\n');

  const isLive = process.env.SYNQ_LIVE_DEPLOY === 'true';
  const isDryRun = !isLive || process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');

  const isExplicitKeyless =
    isDryRun &&
    (process.env.KEYLESS === 'true' ||
      process.env.SYNQ_DEPLOY_KEYLESS === 'true' ||
      process.argv.includes('--keyless') ||
      !process.env.SEPOLIA_PRIVATE_KEY);

  // 1. Network Hard Stop
  const configuredNetwork = network.name;
  const net = await ethers.provider.getNetwork();
  const observedChainId = Number(net.chainId);

  if (configuredNetwork !== 'sepolia') {
    throw new Error(`Hard stop: Network must be configured as 'sepolia', got '${configuredNetwork}'`);
  }
  if (observedChainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(`Hard stop: Observed chainId must be ${SEPOLIA_CHAIN_ID}, got ${observedChainId}`);
  }

  // 2. Read Canonical V1 Deployment for Existing Dependencies
  if (!fs.existsSync(CANONICAL_V1_MANIFEST_PATH)) {
    throw new Error(`Missing V1 manifest at ${CANONICAL_V1_MANIFEST_PATH}`);
  }
  const v1Manifest = JSON.parse(fs.readFileSync(CANONICAL_V1_MANIFEST_PATH, 'utf8'));

  const canonicalFactory = v1Manifest.dependencies.canonicalFactoryV2 || v1Manifest.dependencies.factory;
  const canonicalUsdc = v1Manifest.dependencies.canonicalUsdc;
  const existingPool = v1Manifest.contracts.protectionPool;
  const existingCommittee = v1Manifest.contracts.protectionCommittee;
  const defaultFeeBps = v1Manifest.parameters.premiumFeeBps || 200;

  const rawFee = process.env.PREMIUM_FEE_BPS || getArgValue('--fee') || defaultFeeBps;
  const feeBps = Number(rawFee);

  if (!Number.isInteger(feeBps) || feeBps <= 0 || feeBps > 3000) {
    throw new Error(`Invalid fee: must be between 1 and 3000 bps, got ${feeBps}`);
  }

  const expectedOwner = process.env.DEPLOYER_OWNER || getArgValue('--owner') || CANONICAL_OWNER;

  console.log('Deployment Configuration:');
  console.log(`  Network:                 ${configuredNetwork} (chainId: ${observedChainId})`);
  console.log(`  Owner:                   ${expectedOwner}`);
  console.log(`  Factory V2:              ${canonicalFactory}`);
  console.log(`  USDC:                    ${canonicalUsdc}`);
  console.log(`  Existing Pool:           ${existingPool}`);
  console.log(`  Existing Committee:      ${existingCommittee}`);
  console.log(`  Premium Fee:             ${feeBps} bps (${feeBps / 100}%)\n`);

  // 3. Verify Artifact
  const artifactPath1 = path.join(
    __dirname,
    '../artifacts/contracts/v1/protection/SynqPremiumProtectionManagerV1_1.sol/SynqPremiumProtectionManagerV1_1.json'
  );
  const artifactPath2 = path.join(
    __dirname,
    '../src/lib/contracts/artifacts/contracts/v1/protection/SynqPremiumProtectionManagerV1_1.sol/SynqPremiumProtectionManagerV1_1.json'
  );
  if (!fs.existsSync(artifactPath1) && !fs.existsSync(artifactPath2)) {
    throw new Error('SynqPremiumProtectionManagerV1_1 artifact not found. Please compile contracts first.');
  }

  // 4. Validate Signer Identity if Live
  let deployerSigner = null;
  let deployerAddress = null;

  if (!isExplicitKeyless) {
    const signers = await ethers.getSigners();
    if (signers.length > 0) {
      deployerSigner = signers[0];
      deployerAddress = await deployerSigner.getAddress();
      console.log(`Deployer Wallet:          ${deployerAddress}`);
    }
  }

  if (isDryRun) {
    console.log('Planned Choreography:');
    console.log('  Deploy SynqPremiumProtectionManagerV1_1 with:');
    console.log(`    owner:               ${expectedOwner}`);
    console.log(`    factory:             ${canonicalFactory}`);
    console.log(`    usdc:                ${canonicalUsdc}`);
    console.log(`    pool:                ${existingPool}`);
    console.log(`    committee:           ${existingCommittee}`);
    console.log(`    initialFeeBps:       ${feeBps}`);
    console.log('  NOTE: Manager rotation is NOT performed (will be authorized in separate phase).\n');
    console.log('====================================================');
    console.log('  DRY RUN ONLY — NO TRANSACTIONS BROADCAST');
    console.log('====================================================');
    return;
  }

  if (!deployerSigner || !deployerAddress) {
    throw new Error('Signer required for live deployment. Set SEPOLIA_PRIVATE_KEY.');
  }

  if (deployerAddress.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error(`Deployer ${deployerAddress} does not match expected owner ${expectedOwner}`);
  }

  // Canonical Value Hard Stops Before Broadcast
  if (canonicalFactory.toLowerCase() !== '0x9b7c5b529a420d015a85fd77040ef63b0e6cbdb0') throw new Error('Canonical Factory mismatch');
  if (canonicalUsdc.toLowerCase() !== '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238') throw new Error('Canonical USDC mismatch');
  if (existingPool.toLowerCase() !== '0xa1f4991597869ba11ebd94eded4d69960063cbc2') throw new Error('Canonical Pool mismatch');
  if (existingCommittee.toLowerCase() !== '0x8e77aff09dd37eea35d2931ac1aa624abbf94e12') throw new Error('Canonical Committee mismatch');
  if (expectedOwner.toLowerCase() !== CANONICAL_OWNER.toLowerCase()) throw new Error('Canonical Owner mismatch');
  if (feeBps !== 200) throw new Error('Canonical Fee mismatch');

  console.log('Pre-Broadcast Live Execution Plan:');
  console.log(`  Network:                 ${configuredNetwork}`);
  console.log(`  Chain ID:                ${observedChainId}`);
  console.log(`  Signer:                  ${deployerAddress}`);
  console.log(`  Contract:                SynqPremiumProtectionManagerV1_1`);
  console.log(`  Owner:                   ${expectedOwner}`);
  console.log(`  Factory:                 ${canonicalFactory}`);
  console.log(`  USDC:                    ${canonicalUsdc}`);
  console.log(`  Pool:                    ${existingPool}`);
  console.log(`  Committee:               ${existingCommittee}`);
  console.log(`  Premium fee:             ${feeBps} bps (${feeBps / 100}%)`);
  console.log(`  Coverage rate:           2000 bps (20%)`);
  console.log(`  Target manifest:         ${TARGET_V1_1_MANIFEST_PATH}`);
  console.log(`  Pool manager rotation:   NO`);
  console.log(`  USDC approval:           NO`);
  console.log(`  USDC transfer:           NO`);
  console.log(`  Pool funding:            NO`);
  console.log(`  Policy purchase:         NO\n`);

  console.log('Broadcasting deployment of exactly ONE contract to Sepolia...\n');

  const ManagerV1_1Factory = await ethers.getContractFactory('SynqPremiumProtectionManagerV1_1', deployerSigner);
  const managerV1_1 = await ManagerV1_1Factory.deploy(
    deployerAddress,
    canonicalFactory,
    canonicalUsdc,
    existingPool,
    existingCommittee,
    feeBps
  );
  const deployTx = managerV1_1.deploymentTransaction();
  const deploymentTxHash = deployTx ? deployTx.hash : null;
  console.log(`Deployment transaction hash: ${deploymentTxHash}`);
  await managerV1_1.waitForDeployment();
  const managerV1_1Address = await managerV1_1.getAddress();
  console.log(`SynqPremiumProtectionManagerV1_1 deployed at: ${managerV1_1Address}`);

  // Assertions
  const deployedOwner = await managerV1_1.owner();
  const deployedFactory = await managerV1_1.factory();
  const deployedUsdc = await managerV1_1.usdc();
  const deployedPool = await managerV1_1.pool();
  const deployedCommittee = await managerV1_1.protectionCommittee();
  const deployedFeeBps = await managerV1_1.premiumFeeBps();

  if (deployedOwner.toLowerCase() !== deployerAddress.toLowerCase()) throw new Error('Owner mismatch');
  if (deployedFactory.toLowerCase() !== canonicalFactory.toLowerCase()) throw new Error('Factory mismatch');
  if (deployedUsdc.toLowerCase() !== canonicalUsdc.toLowerCase()) throw new Error('USDC mismatch');
  if (deployedPool.toLowerCase() !== existingPool.toLowerCase()) throw new Error('Pool mismatch');
  if (deployedCommittee.toLowerCase() !== existingCommittee.toLowerCase()) throw new Error('Committee mismatch');
  if (Number(deployedFeeBps) !== feeBps) throw new Error('Fee mismatch');

  console.log('Post-deployment assertions passed.\n');

  // Build V1.1 manifest
  const v1_1Manifest = {
    network: 'sepolia',
    chainId: SEPOLIA_CHAIN_ID,
    status: 'deployed',
    deploymentTxHash: deploymentTxHash,
    deployedAt: new Date().toISOString(),
    owner: deployerAddress,
    contracts: {
      protectionPool: existingPool,
      protectionCommittee: existingCommittee,
      protectionManager: managerV1_1Address,
      previousProtectionManagerV1: v1Manifest.contracts.protectionManager,
    },
    dependencies: {
      canonicalFactoryV2: canonicalFactory,
      canonicalUsdc: canonicalUsdc,
    },
    parameters: {
      premiumFeeBps: feeBps,
      coverageRateBps: 2000,
      maxPremiumFeeBps: 3000,
      maxMilestones: 16,
    },
    governance: v1Manifest.governance,
  };

  fs.writeFileSync(TARGET_V1_1_MANIFEST_PATH, JSON.stringify(v1_1Manifest, null, 2) + '\n');
  console.log(`Saved V1.1 manifest to: ${TARGET_V1_1_MANIFEST_PATH}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
