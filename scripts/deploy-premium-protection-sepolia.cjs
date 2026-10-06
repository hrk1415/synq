// scripts/deploy-premium-protection-sepolia.cjs
/**
 * Synq Premium Protection V1 Sepolia Deployment Tooling
 * Target: Ethereum Sepolia (chainId: 11155111)
 *
 * Sequence:
 * 1. Validate canonical dependencies from deployments/sepolia-v2-standard.json
 * 2. Validate explicit economic parameters (PREMIUM_FEE_BPS)
 * 3. Validate 3 distinct, non-zero committee signers
 * 4. Verify compiled artifacts (SynqProtectionCommittee, SynqProtectionPool, SynqPremiumProtectionManager)
 * 5. Dry-run mode: prints deployment plan, asserts parameters, and halts safely
 * 6. Live mode: deploys contracts, wires pool manager, executes assertions, and writes manifest
 *
 * NO automatic pool funding. NO private key exposure.
 */
// Ensure Sepolia is the default target network if executed via Node directly
if (!process.env.HARDHAT_NETWORK) {
  process.env.HARDHAT_NETWORK = 'sepolia';
}

const { ethers, network } = require('hardhat');
const path = require('path');
const fs = require('fs');
const {
  SEPOLIA_CHAIN_ID,
  CANONICAL_V2_MANIFEST_PATH,
  PREMIUM_MANIFEST_PATH,
  ZERO_ADDRESS,
  assertSepoliaNetwork,
  validatePremiumDeploymentConfig,
  assertLiveDeployerIdentity,
  validateCompiledArtifacts,
  buildSanitizedPremiumPlan,
  buildPremiumManifest,
  savePremiumManifest,
  executePremiumPostDeploymentAssertions,
} = require('./lib/premium-deployment-config.cjs');

function getArgValue(flag) {
  const prefix = `${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

async function main() {
  console.log('====================================================');
  console.log('  SYNQ PREMIUM PROTECTION V1 SEPOLIA DEPLOYMENT');
  console.log('====================================================\n');

  const isDryRun =
    process.env.DRY_RUN === 'true' ||
    process.env.SYNQ_DEPLOY_DRY_RUN === 'true' ||
    process.argv.includes('--dry-run');

  const isExplicitKeyless =
    isDryRun &&
    (process.env.KEYLESS === 'true' ||
      process.env.SYNQ_DEPLOY_KEYLESS === 'true' ||
      process.argv.includes('--keyless'));

  // --- Network Hard Stop ---
  const configuredNetwork = network.name;
  const net = await ethers.provider.getNetwork();
  const observedChainId = Number(net.chainId);

  // Must verify both configured network name AND real observed provider chainId
  // Operates in BOTH dry-run and live modes
  assertSepoliaNetwork(configuredNetwork, observedChainId);

  // --- Parse Raw Configuration ---
  const rawConfig = {
    chainId: observedChainId,
    premiumFeeBps:
      process.env.PREMIUM_FEE_BPS ||
      process.env.SYNQ_PREMIUM_FEE_BPS ||
      getArgValue('--fee'),
    signerA:
      process.env.PROTECTION_SIGNER_A ||
      process.env.SYNQ_PROTECTION_SIGNER_A ||
      getArgValue('--signerA'),
    signerB:
      process.env.PROTECTION_SIGNER_B ||
      process.env.SYNQ_PROTECTION_SIGNER_B ||
      getArgValue('--signerB'),
    signerC:
      process.env.PROTECTION_SIGNER_C ||
      process.env.SYNQ_PROTECTION_SIGNER_C ||
      getArgValue('--signerC'),
    owner:
      process.env.DEPLOYER_OWNER ||
      process.env.SYNQ_PREMIUM_OWNER ||
      getArgValue('--owner'),
  };

  // --- Validate Configuration ---
  const validatedConfig = validatePremiumDeploymentConfig(rawConfig);

  // --- Validate Artifact Availability ---
  validateCompiledArtifacts();

  // --- Determine Deployer Address Safely ---
  const HARDHAT_DEFAULT_DEV_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  let deployerAddress = null;
  let deployerSigner = null;

  const rawPrivateKey = !isExplicitKeyless ? (process.env.SEPOLIA_PRIVATE_KEY || process.env.PRIVATE_KEY) : null;
  if (rawPrivateKey && typeof rawPrivateKey === 'string' && rawPrivateKey.trim().length > 0) {
    try {
      deployerSigner = new ethers.Wallet(rawPrivateKey.trim(), ethers.provider);
      deployerAddress = deployerSigner.address;
    } catch (err) {
      throw new Error(`Failed to initialize deployment wallet from private key: ${err.message}`);
    }
  } else {
    try {
      const signers = !isExplicitKeyless ? await ethers.getSigners() : [];
      if (signers && signers.length > 0) {
        const candidateAddress = signers[0].address;
        // In dry-run mode, ignore hardhat default development account so it does not masquerade as live signer
        if (!isDryRun || candidateAddress.toLowerCase() !== HARDHAT_DEFAULT_DEV_ACCOUNT.toLowerCase()) {
          deployerSigner = signers[0];
          deployerAddress = candidateAddress;
        }
      }
    } catch {
      // Offline / keyless dry-run fallback
    }
  }

  // If a live signer is loaded (either in live mode or dry-run with key provided),
  // strictly assert identity against canonical deployment owner
  if (deployerAddress) {
    assertLiveDeployerIdentity(deployerAddress, validatedConfig.owner);
  }

  const plan = buildSanitizedPremiumPlan(validatedConfig, deployerAddress);

  // --- Print Plan Summary ---
  console.log(`Execution Mode:            ${isDryRun ? 'DRY-RUN (Validation & Inspection Only)' : 'LIVE SEPOLIA BROADCAST'}`);
  console.log(`Configured Network:        ${configuredNetwork}`);
  console.log(`Observed Provider ChainId: ${observedChainId}`);
  console.log(`Target Network:            ${plan.network} (chainId: ${plan.chainId})`);
  console.log(`Observed Live Signer:      ${plan.deployer}`);
  console.log(`Canonical Owner:           ${plan.owner}`);
  console.log(`Canonical Factory V2:      ${plan.canonicalFactoryV2}`);
  console.log(`Canonical Sepolia USDC:    ${plan.canonicalUsdc}`);
  console.log(`Configured Premium Fee:    ${plan.parameters.premiumFeeBps} bps (${plan.parameters.premiumFeeBps / 100}%)`);
  console.log(`Fixed Coverage Rate:       ${plan.parameters.coverageRateBps} bps (${plan.parameters.coverageRateBps / 100}%)`);
  console.log(`Protection Committee:      Threshold ${plan.governance.threshold}-of-3`);
  console.log(`  - Signer A:              ${plan.governance.committeeSigners[0]}`);
  console.log(`  - Signer B:              ${plan.governance.committeeSigners[1]}`);
  console.log(`  - Signer C:              ${plan.governance.committeeSigners[2]}\n`);

  console.log('Planned Deployment Choreography:');
  for (const step of plan.deploymentOrder) {
    if (step.contract) {
      console.log(`  Step ${step.step}: Deploy ${step.contract}`);
      console.log(`          Args: ${JSON.stringify(step.constructorArgs)}`);
    } else {
      console.log(`  Step ${step.step}: ${step.action}`);
    }
  }
  console.log('\nArtifact Validation:     All 3 contract artifacts verified and intact.');
  console.log('Post-Deployment Checks: 10 automated assertions prepared.');
  console.log('Initial Pool Funding:   NONE (Pool capitalization is strictly decoupled from deployment).\n');

  // --- DRY RUN HALT ---
  if (isDryRun) {
    console.log('====================================================');
    console.log('  DRY RUN ONLY — NO TRANSACTIONS BROADCAST');
    console.log('====================================================');
    return;
  }

  // --- LIVE DEPLOYMENT ---
  if (!deployerSigner || !deployerAddress) {
    throw new Error('Deployment signer is required for live execution. Set SEPOLIA_PRIVATE_KEY in .env.local.');
  }

  // Hard assertion: actual signing wallet MUST match canonical expected owner
  // Executed strictly BEFORE any deployment transaction is constructed or broadcast
  assertLiveDeployerIdentity(deployerAddress, plan.owner);

  console.log('Broadcasting transactions to Sepolia...\n');

  // Step 1: SynqProtectionCommittee
  console.log('[1/4] Deploying SynqProtectionCommittee...');
  const CommitteeFactory = await ethers.getContractFactory('SynqProtectionCommittee', deployerSigner);
  const committee = await CommitteeFactory.deploy(
    plan.governance.committeeSigners[0],
    plan.governance.committeeSigners[1],
    plan.governance.committeeSigners[2]
  );
  await committee.waitForDeployment();
  const committeeAddress = await committee.getAddress();
  console.log(`      SynqProtectionCommittee deployed at: ${committeeAddress}`);

  // Step 2: SynqProtectionPool (bootstrapped with ZERO_ADDRESS manager)
  console.log('[2/4] Deploying SynqProtectionPool...');
  const PoolFactory = await ethers.getContractFactory('SynqProtectionPool', deployerSigner);
  const pool = await PoolFactory.deploy(
    deployerAddress, // Verified canonical signer == owner
    plan.canonicalUsdc,
    ZERO_ADDRESS
  );
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  console.log(`      SynqProtectionPool deployed at: ${poolAddress}`);

  // Step 3: SynqPremiumProtectionManager
  console.log('[3/4] Deploying SynqPremiumProtectionManager...');
  const ManagerFactory = await ethers.getContractFactory('SynqPremiumProtectionManager', deployerSigner);
  const manager = await ManagerFactory.deploy(
    deployerAddress, // Verified canonical signer == owner
    plan.canonicalFactoryV2,
    plan.canonicalUsdc,
    poolAddress,
    committeeAddress,
    plan.parameters.premiumFeeBps
  );
  await manager.waitForDeployment();
  const managerAddress = await manager.getAddress();
  console.log(`      SynqPremiumProtectionManager deployed at: ${managerAddress}`);

  // Step 4: Authorize Manager on ProtectionPool
  console.log('[4/4] Authorizing Manager on ProtectionPool (pool.setManager)...');
  const setManagerTx = await pool.setManager(managerAddress);
  await setManagerTx.wait(1);
  console.log('      Manager authorized on ProtectionPool.');

  // Post-Deployment Assertions
  console.log('\nRunning post-deployment assertions...');
  const deployedContracts = {
    protectionPool: poolAddress,
    protectionManager: managerAddress,
    protectionCommittee: committeeAddress,
  };

  await executePremiumPostDeploymentAssertions(
    { pool, manager, committee },
    validatedConfig,
    ethers.provider
  );
  console.log('All 10 post-deployment assertions passed successfully.');

  // Write Manifest
  console.log(`\nWriting deployment manifest to: ${PREMIUM_MANIFEST_PATH}`);
  const manifest = buildPremiumManifest(plan, deployedContracts, deployerAddress);
  savePremiumManifest(PREMIUM_MANIFEST_PATH, manifest);
  console.log('Deployment manifest successfully saved.');

  // Frontend Environment Variables Output
  console.log('\n====================================================');
  console.log('  FRONTEND ENVIRONMENT CONFIGURATION');
  console.log('====================================================');
  console.log(`NEXT_PUBLIC_SYNQ_PREMIUM_MANAGER_ADDRESS=${managerAddress}`);
  console.log(`NEXT_PUBLIC_SYNQ_PREMIUM_POOL_ADDRESS=${poolAddress}`);
  console.log(`NEXT_PUBLIC_SYNQ_PREMIUM_COMMITTEE_ADDRESS=${committeeAddress}`);
  console.log('====================================================\n');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('\n[!] DEPLOYMENT ERROR:', err.message);
      process.exit(1);
    });
}

module.exports = { main };
