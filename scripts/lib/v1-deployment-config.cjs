// scripts/lib/v1-deployment-config.cjs
/**
 * Pure validation, plan building, and manifest generation logic for Synq Deal V1 Standard deployment.
 * Independent of network connections, RPC, or private keys.
 */
const fs = require('fs');
const path = require('path');

const SEPOLIA_CHAIN_ID = 11155111;
const SEPOLIA_CANONICAL_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const USDC_DECIMALS = 6;
const PROTOCOL_VERSION = 'synq-deal-v1-standard';
const COMMITTEE_THRESHOLD = 2;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function isValidAddress(addr) {
  if (typeof addr !== 'string') return false;
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return false;
  if (addr.toLowerCase() === ZERO_ADDRESS) return false;
  return true;
}

function normalizeAddress(addr) {
  if (!isValidAddress(addr)) {
    throw new Error(`Invalid Ethereum address: "${addr}"`);
  }
  return addr.toLowerCase();
}

function validateCommittee(name, signers) {
  if (!Array.isArray(signers)) {
    throw new Error(`${name} must be an array of 3 addresses`);
  }
  if (signers.length !== 3) {
    throw new Error(`${name} must contain exactly 3 addresses, received ${signers.length}`);
  }

  const seen = new Set();
  const normalized = [];

  for (let i = 0; i < signers.length; i++) {
    const s = signers[i];
    if (!isValidAddress(s)) {
      throw new Error(`${name} signer [${i}] is not a valid non-zero address: "${s}"`);
    }
    const lower = s.toLowerCase();
    if (seen.has(lower)) {
      throw new Error(`${name} contains duplicate signer address: "${s}"`);
    }
    seen.add(lower);
    normalized.push(s);
  }

  return normalized;
}

function analyzeCommitteeOverlap(primarySigners, emergencySigners) {
  const primarySet = new Set(primarySigners.map((s) => s.toLowerCase()));
  const overlapping = [];

  for (const s of emergencySigners) {
    if (primarySet.has(s.toLowerCase())) {
      overlapping.push(s);
    }
  }

  return {
    identical: overlapping.length === 3,
    overlapCount: overlapping.length,
    overlapping,
  };
}

function validateDeploymentConfig(rawConfig, options = {}) {
  const chainId = Number(rawConfig.chainId);
  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Network hard stop: Synq Deal V1 deployment script requires Sepolia chainId ${SEPOLIA_CHAIN_ID}, got ${chainId}`
    );
  }

  const canonicalUsdc = rawConfig.canonicalUsdc || SEPOLIA_CANONICAL_USDC;
  if (canonicalUsdc.toLowerCase() !== SEPOLIA_CANONICAL_USDC.toLowerCase()) {
    throw new Error(
      `Canonical USDC mismatch: expected ${SEPOLIA_CANONICAL_USDC}, got ${canonicalUsdc}`
    );
  }

  const primarySigners = validateCommittee('Primary Resolution Committee', [
    rawConfig.primarySignerA,
    rawConfig.primarySignerB,
    rawConfig.primarySignerC,
  ]);

  const emergencySigners = validateCommittee('Emergency Resolution Committee', [
    rawConfig.emergencySignerA,
    rawConfig.emergencySignerB,
    rawConfig.emergencySignerC,
  ]);

  const overlap = analyzeCommitteeOverlap(primarySigners, emergencySigners);
  if (overlap.identical && !options.allowIdenticalCommittees) {
    throw new Error(
      'Security error: Primary and Emergency committees have identical signer sets. Separate independent committees are required for production/testnet deployment.'
    );
  }

  let warnings = [];
  if (overlap.overlapCount > 0 && !overlap.identical) {
    warnings.push(
      `Operational warning: Primary and Emergency committees share ${overlap.overlapCount} overlapping signer(s): ${overlap.overlapping.join(', ')}`
    );
  }

  let factoryOwner = rawConfig.factoryOwner;
  if (factoryOwner) {
    if (!isValidAddress(factoryOwner)) {
      throw new Error(`Invalid SYNQ_FACTORY_OWNER address: "${factoryOwner}"`);
    }
  }

  return {
    chainId,
    canonicalUsdc,
    primarySigners,
    emergencySigners,
    factoryOwner: factoryOwner || null,
    warnings,
  };
}

function buildSanitizedPlan(validatedConfig, deployerAddress) {
  return {
    network: 'sepolia',
    chainId: validatedConfig.chainId,
    version: PROTOCOL_VERSION,
    deployer: deployerAddress || '(pending connected signer)',
    factoryOwner: validatedConfig.factoryOwner || deployerAddress || '(defaults to deployer)',
    canonicalUsdc: validatedConfig.canonicalUsdc,
    usdcDecimals: USDC_DECIMALS,
    steps: [
      {
        step: 1,
        action: 'Deploy SynqDealV1 (Implementation)',
        notes: 'Disables initializers in constructor. Used exclusively as logic blueprint for clones.',
      },
      {
        step: 2,
        action: 'Deploy SynqFactoryV1 (Bootstrap state)',
        notes: 'Constructed with dealImplementation as temporary placeholder for resolvers to satisfy code.length > 0.',
        status: 'BOOTSTRAPPING / NOT READY (No deals can be created yet)',
      },
      {
        step: 3,
        action: 'Deploy Primary SynqResolutionCommittee',
        notes: 'Binds immutable factory address. Configures 3 signers, threshold 2-of-3.',
        signers: validatedConfig.primarySigners,
      },
      {
        step: 4,
        action: 'Deploy Emergency SynqResolutionCommittee',
        notes: 'Binds immutable factory address. Configures 3 signers, threshold 2-of-3.',
        signers: validatedConfig.emergencySigners,
      },
      {
        step: 5,
        action: 'Wire Real Resolvers into SynqFactoryV1',
        notes: 'Executes setDefaultPrimaryResolver and setDefaultEmergencyResolver. Transitions Factory to READY.',
        status: 'READY FOR STANDARD DEALS',
      },
      {
        step: 6,
        action: 'Post-Deployment Readback Assertions',
        notes: 'Asserts all state variables, immutables, signers, and non-initialized implementation lock on-chain.',
      },
      {
        step: 7,
        action: 'Generate Sanitized Manifest',
        notes: 'Writes deployments/sepolia-v1-standard.json without exposing sensitive material.',
      },
    ],
    protection: {
      enabled: false,
      reason: 'Active Protection is NOT enabled in Standard V1 rollout. module=address(0), policyId=bytes32(0).',
    },
    warnings: validatedConfig.warnings,
  };
}

function buildManifest(params) {
  // Assert no secrets leaked into params
  for (const k of Object.keys(params)) {
    if (/private|secret|key/i.test(k) && !/policy|public/i.test(k)) {
      throw new Error(`Security violation: Key "${k}" cannot be serialized into manifest`);
    }
  }

  return {
    network: 'sepolia',
    chainId: SEPOLIA_CHAIN_ID,
    version: PROTOCOL_VERSION,
    status: 'standard-ready',
    deployedAt: params.deployedAt || new Date().toISOString(),
    deployer: params.deployer,
    contracts: {
      dealImplementation: params.dealImplementation,
      factory: params.factory,
      primaryResolver: params.primaryResolver,
      emergencyResolver: params.emergencyResolver,
    },
    assets: {
      canonicalUsdc: SEPOLIA_CANONICAL_USDC,
      usdcDecimals: USDC_DECIMALS,
    },
    governance: {
      factoryOwner: params.factoryOwner,
      primaryCommittee: {
        address: params.primaryResolver,
        signers: params.primarySigners,
        threshold: COMMITTEE_THRESHOLD,
        epoch: 0,
      },
      emergencyCommittee: {
        address: params.emergencyResolver,
        signers: params.emergencySigners,
        threshold: COMMITTEE_THRESHOLD,
        epoch: 0,
      },
    },
    protection: {
      enabled: false,
      module: null,
      policyId: null,
    },
  };
}

function saveManifest(targetPath, manifestData, options = {}) {
  const resolved = path.resolve(targetPath);
  if (fs.existsSync(resolved) && !options.overwrite) {
    throw new Error(
      `Deployment manifest already exists at "${resolved}". Refusing to overwrite by default to protect deployment history.`
    );
  }

  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }

  fs.writeFileSync(resolved, JSON.stringify(manifestData, null, 2) + '\n', 'utf8');
  return resolved;
}

module.exports = {
  SEPOLIA_CHAIN_ID,
  SEPOLIA_CANONICAL_USDC,
  USDC_DECIMALS,
  PROTOCOL_VERSION,
  COMMITTEE_THRESHOLD,
  isValidAddress,
  validateCommittee,
  analyzeCommitteeOverlap,
  validateDeploymentConfig,
  buildSanitizedPlan,
  buildManifest,
  saveManifest,
};
