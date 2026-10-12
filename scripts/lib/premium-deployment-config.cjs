// scripts/lib/premium-deployment-config.cjs
/**
 * Pure validation, plan building, and manifest generation logic for
 * Synq Premium Protection V1 Sepolia deployment.
 *
 * Enforces:
 * - Canonical Standard V2 dependency verification from deployments/sepolia-v2-standard.json
 * - Exact Premium contract names: SynqProtectionCommittee, SynqProtectionPool, SynqPremiumProtectionManager
 * - Mandatory explicit PREMIUM_FEE_BPS (strictly 1 to 3000 bps)
 * - Fixed COVERAGE_RATE_BPS = 2000 (20%)
 * - 3 distinct, non-zero EVM committee signers for SynqProtectionCommittee (threshold = 2)
 * - Exact 4-step deployment sequence with pool.setManager(manager) wiring
 * - Exhaustive post-deployment assertions
 * - Manifest write only after successful deployment and assertions
 * - Zero private key exposure
 */
const fs = require('fs');
const path = require('path');

const SEPOLIA_CHAIN_ID = 11155111;
const CANONICAL_V2_MANIFEST_PATH = path.join(__dirname, '..', '..', 'deployments', 'sepolia-v2-standard.json');
const PREMIUM_MANIFEST_PATH = path.join(__dirname, '..', '..', 'deployments', 'sepolia-premium-protection-v1.json');

const EXPECTED_CANONICAL_FACTORY = '0x9b7C5B529A420d015a85fD77040eF63b0e6cbdb0';
const EXPECTED_CANONICAL_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const EXPECTED_CANONICAL_OWNER = '0xD2D4d415a4730b1490c9Ce27944529B83ff76319';

const MIN_PREMIUM_FEE_BPS = 1;
const MAX_PREMIUM_FEE_BPS = 3000; // 30% cap matching Solidity
const FIXED_COVERAGE_RATE_BPS = 2000; // 20% fixed V1 coverage
const COMMITTEE_THRESHOLD = 2;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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
 * Strictly verifies network configuration and observed provider chainId.
 * Both explicit network label ('sepolia') and observed chainId (11155111) are required.
 * Network label alone cannot bypass observed chain check.
 */
function assertSepoliaNetwork(configuredNetworkName, observedChainId) {
  if (configuredNetworkName !== 'sepolia') {
    throw new Error(
      `NETWORK HARD STOP: Synq Premium Protection deployment script requires network 'sepolia', got '${configuredNetworkName}'. Use --network sepolia.`
    );
  }

  const numericChainId = Number(observedChainId);
  if (numericChainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `NETWORK HARD STOP: Synq Premium Protection deployment script strictly refuses to execute on chainId ${numericChainId}. Only Sepolia (${SEPOLIA_CHAIN_ID}) is supported.`
    );
  }

  return true;
}

/**
 * Loads and validates canonical Standard V2 dependencies from sepolia-v2-standard.json.
 * Hard-stops if canonical values mismatch.
 */
function loadAndValidateCanonicalV2Manifest(manifestPath = CANONICAL_V2_MANIFEST_PATH) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Canonical Standard V2 manifest not found at: ${manifestPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse canonical Standard V2 manifest at ${manifestPath}: ${err.message}`);
  }

  if (manifest.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `CANONICAL MANIFEST MISMATCH: Expected chainId ${SEPOLIA_CHAIN_ID}, manifest has ${manifest.chainId}`
    );
  }

  const factory = manifest.contracts?.factory;
  if (!factory || factory.toLowerCase() !== EXPECTED_CANONICAL_FACTORY.toLowerCase()) {
    throw new Error(
      `CANONICAL MANIFEST MISMATCH: Expected Factory V2 ${EXPECTED_CANONICAL_FACTORY}, manifest has ${factory}`
    );
  }

  const canonicalUsdc = manifest.assets?.canonicalUsdc;
  if (!canonicalUsdc || canonicalUsdc.toLowerCase() !== EXPECTED_CANONICAL_USDC.toLowerCase()) {
    throw new Error(
      `CANONICAL MANIFEST MISMATCH: Expected canonical USDC ${EXPECTED_CANONICAL_USDC}, manifest has ${canonicalUsdc}`
    );
  }

  const owner = manifest.deployer || manifest.governance?.factoryOwner;
  if (!owner || owner.toLowerCase() !== EXPECTED_CANONICAL_OWNER.toLowerCase()) {
    throw new Error(
      `CANONICAL MANIFEST MISMATCH: Expected deployment owner ${EXPECTED_CANONICAL_OWNER}, manifest has ${owner}`
    );
  }

  return {
    chainId: manifest.chainId,
    factory: EXPECTED_CANONICAL_FACTORY,
    canonicalUsdc: EXPECTED_CANONICAL_USDC,
    owner: EXPECTED_CANONICAL_OWNER,
    manifestPath,
  };
}

/**
 * Validates committee signers for SynqProtectionCommittee.
 * Requires 3 valid, non-zero, distinct EVM addresses.
 */
function validateProtectionCommitteeSigners(signers) {
  if (!Array.isArray(signers) || signers.length !== 3) {
    throw new Error('Protection committee requires exactly 3 signer addresses');
  }

  const normalized = [];
  const seen = new Set();

  for (let i = 0; i < signers.length; i++) {
    const s = signers[i];
    if (!isValidAddress(s)) {
      throw new Error(`Protection committee signer [${i}] is not a valid non-zero address: "${s}"`);
    }
    const norm = s.toLowerCase();
    if (seen.has(norm)) {
      throw new Error(`Duplicate protection committee signer detected: "${s}"`);
    }
    seen.add(norm);
    normalized.push(norm);
  }

  return normalized;
}

/**
 * Validates PREMIUM_FEE_BPS.
 * Must be explicitly provided, integer, and within [1, 3000].
 */
function validatePremiumFeeBps(feeBps) {
  if (feeBps === undefined || feeBps === null || feeBps === '') {
    throw new Error(
      'PREMIUM_FEE_BPS is required and must be explicitly configured. Deployment tooling strictly refuses to assume default economic parameters.'
    );
  }

  const parsed = Number(feeBps);
  if (!Number.isInteger(parsed) || parsed < MIN_PREMIUM_FEE_BPS || parsed > MAX_PREMIUM_FEE_BPS) {
    throw new Error(
      `PREMIUM_FEE_BPS must be an integer between ${MIN_PREMIUM_FEE_BPS} and ${MAX_PREMIUM_FEE_BPS} bps (0.01% - 30.00%), got ${feeBps}`
    );
  }

  return parsed;
}

/**
 * Validates full deployment configuration input.
 */
function validatePremiumDeploymentConfig(rawConfig, options = {}) {
  // 1. Chain ID Enforcement
  if (rawConfig.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `NETWORK HARD STOP: Synq Premium Protection deployment requires Sepolia chainId ${SEPOLIA_CHAIN_ID}, got ${rawConfig.chainId}`
    );
  }

  // 2. Canonical V2 Dependencies
  const canonicalDeps = loadAndValidateCanonicalV2Manifest(options.manifestPath || CANONICAL_V2_MANIFEST_PATH);

  // 3. Premium Fee BPS
  const premiumFeeBps = validatePremiumFeeBps(rawConfig.premiumFeeBps);

  // 4. Protection Committee Signers
  const committeeSigners = validateProtectionCommitteeSigners([
    rawConfig.signerA,
    rawConfig.signerB,
    rawConfig.signerC,
  ]);

  // 5. Deployer / Owner - strictly canonical owner, no alternate deployer bypass in Premium V1
  const owner = canonicalDeps.owner;
  if (rawConfig.owner) {
    if (!isValidAddress(rawConfig.owner) || rawConfig.owner.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(
        `Live deployment signer does not match canonical Synq deployment owner. Alternate deployers are not permitted.\n` +
        `Expected owner: ${owner}\n` +
        `Provided owner: ${rawConfig.owner}`
      );
    }
  }

  return {
    chainId: SEPOLIA_CHAIN_ID,
    canonicalFactory: canonicalDeps.factory,
    canonicalUsdc: canonicalDeps.canonicalUsdc,
    owner,
    premiumFeeBps,
    coverageRateBps: FIXED_COVERAGE_RATE_BPS,
    committeeSigners,
    committeeThreshold: COMMITTEE_THRESHOLD,
    manifestPath: canonicalDeps.manifestPath,
  };
}

/**
 * Asserts that the live deployment signer strictly matches the canonical deployment owner
 * from sepolia-v2-standard.json.
 * Comparison is case-insensitive.
 * Rejects any mismatch, null, or invalid addresses.
 * Never prints or accepts private keys.
 */
function assertLiveDeployerIdentity(actualSignerAddress, expectedOwnerAddress) {
  if (!isValidAddress(actualSignerAddress)) {
    throw new Error(
      `Live deployment signer address is invalid or missing: "${actualSignerAddress}"`
    );
  }
  if (!isValidAddress(expectedOwnerAddress)) {
    throw new Error(
      `Canonical expected owner address is invalid or missing: "${expectedOwnerAddress}"`
    );
  }
  if (actualSignerAddress.toLowerCase() !== expectedOwnerAddress.toLowerCase()) {
    throw new Error(
      `Live deployment signer does not match canonical Synq deployment owner.\n` +
      `Expected owner: ${expectedOwnerAddress}\n` +
      `Actual signer:   ${actualSignerAddress}`
    );
  }
  return true;
}

/**
 * Validates that compiled artifacts for the exact 3 Premium contracts exist and are ready.
 */
function validateCompiledArtifacts(artifactsDir = path.join(__dirname, '..', '..', 'src', 'lib', 'contracts', 'artifacts')) {
  const contracts = [
    {
      name: 'SynqProtectionCommittee',
      relPath: 'contracts/v1/protection/SynqProtectionCommittee.sol/SynqProtectionCommittee.json',
    },
    {
      name: 'SynqProtectionPool',
      relPath: 'contracts/v1/protection/SynqProtectionPool.sol/SynqProtectionPool.json',
    },
    {
      name: 'SynqPremiumProtectionManager',
      relPath: 'contracts/v1/protection/SynqPremiumProtectionManager.sol/SynqPremiumProtectionManager.json',
    },
  ];

  for (const c of contracts) {
    const fullPath = path.join(artifactsDir, c.relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Missing compiled artifact for ${c.name} at: ${fullPath}`);
    }
    try {
      const artifact = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      if (!artifact.bytecode || artifact.bytecode === '0x' || !artifact.abi) {
        throw new Error(`Invalid or empty artifact for ${c.name} at: ${fullPath}`);
      }
    } catch (err) {
      throw new Error(`Failed to read artifact for ${c.name}: ${err.message}`);
    }
  }

  return true;
}

/**
 * Constructs sanitized deployment plan without exposing private keys.
 * In keyless dry-run mode, marks deployer as [DRY-RUN — live signer not loaded]
 * while preserving canonical owner for constructor previews.
 */
function buildSanitizedPremiumPlan(config, deployerAddress) {
  const isKeylessDryRun = !deployerAddress;
  const deployer = isKeylessDryRun ? '[DRY-RUN — live signer not loaded]' : deployerAddress;
  const owner = config.owner;

  return {
    network: 'sepolia',
    chainId: config.chainId,
    deployer,
    isKeylessDryRun,
    owner,
    canonicalFactoryV2: config.canonicalFactory,
    canonicalUsdc: config.canonicalUsdc,
    parameters: {
      coverageRateBps: config.coverageRateBps,
      premiumFeeBps: config.premiumFeeBps,
    },
    governance: {
      committeeSigners: config.committeeSigners,
      threshold: config.committeeThreshold,
    },
    deploymentOrder: [
      {
        step: 1,
        contract: 'SynqProtectionCommittee',
        description: 'Deploy 2-of-3 multisig claims resolution committee',
        constructorArgs: [
          config.committeeSigners[0],
          config.committeeSigners[1],
          config.committeeSigners[2],
        ],
      },
      {
        step: 2,
        contract: 'SynqProtectionPool',
        description: 'Deploy capital vault with ZERO_ADDRESS manager bootstrap',
        constructorArgs: [
          config.owner,
          config.canonicalUsdc,
          ZERO_ADDRESS,
        ],
      },
      {
        step: 3,
        contract: 'SynqPremiumProtectionManager',
        description: 'Deploy core policy and claim management engine',
        constructorArgs: [
          config.owner,
          config.canonicalFactory,
          config.canonicalUsdc,
          '<protectionPool.address>',
          '<protectionCommittee.address>',
          config.premiumFeeBps,
        ],
      },
      {
        step: 4,
        action: 'protectionPool.setManager(protectionManager.address)',
        description: 'Authorize Manager on ProtectionPool to permit claim payouts',
      },
    ],
  };
}

/**
 * Builds the canonical manifest JSON structure.
 */
function buildPremiumManifest(plan, deployedContracts, deployerAddress) {
  return {
    network: 'sepolia',
    chainId: plan.chainId,
    version: 'synq-premium-protection-v1',
    status: 'deployed',
    deployedAt: new Date().toISOString(),
    deployer: deployerAddress || plan.deployer,
    contracts: {
      protectionPool: deployedContracts.protectionPool,
      protectionManager: deployedContracts.protectionManager,
      protectionCommittee: deployedContracts.protectionCommittee,
    },
    dependencies: {
      standardV2Manifest: 'deployments/sepolia-v2-standard.json',
      factory: plan.canonicalFactoryV2,
      canonicalUsdc: plan.canonicalUsdc,
    },
    parameters: {
      coverageRateBps: plan.parameters.coverageRateBps,
      premiumFeeBps: plan.parameters.premiumFeeBps,
    },
    governance: {
      committeeSigners: plan.governance.committeeSigners,
      threshold: plan.governance.threshold,
    },
  };
}

/**
 * Writes manifest to disk.
 */
function savePremiumManifest(manifestPath, manifestData) {
  fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2) + '\n', 'utf8');
}

/**
 * Executes post-deployment assertions against live contracts.
 */
async function executePremiumPostDeploymentAssertions(contracts, config, provider) {
  const { pool, manager, committee } = contracts;

  // 1. Verify bytecodes non-empty
  const poolCode = await provider.getCode(pool.target || pool.address);
  if (poolCode === '0x' || poolCode.length <= 2) throw new Error('Assertion failed: SynqProtectionPool has empty bytecode');

  const managerCode = await provider.getCode(manager.target || manager.address);
  if (managerCode === '0x' || managerCode.length <= 2) throw new Error('Assertion failed: SynqPremiumProtectionManager has empty bytecode');

  const committeeCode = await provider.getCode(committee.target || committee.address);
  if (committeeCode === '0x' || committeeCode.length <= 2) throw new Error('Assertion failed: SynqProtectionCommittee has empty bytecode');

  // 2. Pool assertions
  const poolManager = await pool.manager();
  const expectedManagerAddr = manager.target || manager.address;
  if (poolManager.toLowerCase() !== expectedManagerAddr.toLowerCase()) {
    throw new Error(`Assertion failed: pool.manager() ${poolManager} != ${expectedManagerAddr}`);
  }

  const poolUsdc = await pool.usdc();
  if (poolUsdc.toLowerCase() !== config.canonicalUsdc.toLowerCase()) {
    throw new Error(`Assertion failed: pool.usdc() ${poolUsdc} != ${config.canonicalUsdc}`);
  }

  // 3. Manager assertions
  const managerFactory = await manager.factory();
  if (managerFactory.toLowerCase() !== config.canonicalFactory.toLowerCase()) {
    throw new Error(`Assertion failed: manager.factory() ${managerFactory} != ${config.canonicalFactory}`);
  }

  const managerUsdc = await manager.usdc();
  if (managerUsdc.toLowerCase() !== config.canonicalUsdc.toLowerCase()) {
    throw new Error(`Assertion failed: manager.usdc() ${managerUsdc} != ${config.canonicalUsdc}`);
  }

  const managerPool = await manager.pool();
  const expectedPoolAddr = pool.target || pool.address;
  if (managerPool.toLowerCase() !== expectedPoolAddr.toLowerCase()) {
    throw new Error(`Assertion failed: manager.pool() ${managerPool} != ${expectedPoolAddr}`);
  }

  const managerCommittee = await manager.protectionCommittee();
  const expectedCommitteeAddr = committee.target || committee.address;
  if (managerCommittee.toLowerCase() !== expectedCommitteeAddr.toLowerCase()) {
    throw new Error(`Assertion failed: manager.protectionCommittee() ${managerCommittee} != ${expectedCommitteeAddr}`);
  }

  const feeBps = await manager.premiumFeeBps();
  if (Number(feeBps) !== config.premiumFeeBps) {
    throw new Error(`Assertion failed: manager.premiumFeeBps() ${feeBps} != ${config.premiumFeeBps}`);
  }

  const coverageBps = await manager.COVERAGE_RATE_BPS();
  if (Number(coverageBps) !== FIXED_COVERAGE_RATE_BPS) {
    throw new Error(`Assertion failed: manager.COVERAGE_RATE_BPS() ${coverageBps} != ${FIXED_COVERAGE_RATE_BPS}`);
  }

  // 4. Committee assertions
  const threshold = await committee.THRESHOLD();
  if (Number(threshold) !== COMMITTEE_THRESHOLD) {
    throw new Error(`Assertion failed: committee.THRESHOLD() ${threshold} != ${COMMITTEE_THRESHOLD}`);
  }

  return true;
}

module.exports = {
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
  normalizeAddress,
  loadAndValidateCanonicalV2Manifest,
  validateProtectionCommitteeSigners,
  validatePremiumFeeBps,
  validatePremiumDeploymentConfig,
  assertSepoliaNetwork,
  assertLiveDeployerIdentity,
  validateCompiledArtifacts,
  buildSanitizedPremiumPlan,
  buildPremiumManifest,
  savePremiumManifest,
  executePremiumPostDeploymentAssertions,
};
