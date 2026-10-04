// scripts/lib/v2-deployment-config.cjs
/**
 * Pure validation, plan building, and manifest generation logic for Synq Deal V2 Standard deployment.
 * Enforces:
 * - Reused SynqDealV1 implementation verification
 * - Circular dependency bootstrap choreography for SynqFactoryV2 and Committees
 * - Signer set integrity and non-overlap verification
 * - Protection disabled (standard rollout)
 * - Safe manifest generation with secret isolation and overwrite protection
 *
 * Independent of live network connections, RPC, or private keys.
 */
const fs = require('fs');
const path = require('path');

const SEPOLIA_CHAIN_ID = 11155111;
const SEPOLIA_CANONICAL_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const SEPOLIA_DEAL_IMPLEMENTATION = '0x2a3C8A880398FF6DD8e6F9976c8BE6C8aBef2435';
const SEPOLIA_PREVIOUS_FACTORY_V1 = '0x7482c3439Aa6065066c7759b87eeD25a403CbB03';
const SEPOLIA_PREVIOUS_PRIMARY_RESOLVER = '0x50Ee032d382B49A687EBDa08c5192fb7c5b9e392';
const SEPOLIA_PREVIOUS_EMERGENCY_RESOLVER = '0x9F45E79288f1766553E88C45CD5B254CD4662854';

const USDC_DECIMALS = 6;
const PROTOCOL_VERSION = 'synq-deal-v2-standard';
const COMMITTEE_THRESHOLD = 2;
const EXPECTED_DEAL_BYTECODE_LENGTH = 23551;
const EXPECTED_FACTORY_V2_BYTECODE_LENGTH = 12924;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

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

/**
 * Validates the runtime bytecode of the existing SynqDealV1 implementation.
 * Accounts for solc CBOR metadata differences while strictly checking executable bytecode
 * and exact byte length (23,551 bytes).
 */
function verifyDealImplementationBytecode(bytecode, expectedBytecode) {
  if (!bytecode || bytecode === '0x' || bytecode === '0x0') {
    throw new Error('Deal implementation address has no bytecode on-chain');
  }

  const cleanActual = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
  const actualLengthBytes = cleanActual.length / 2;

  if (actualLengthBytes !== EXPECTED_DEAL_BYTECODE_LENGTH) {
    throw new Error(
      `Deal implementation runtime size mismatch: expected ${EXPECTED_DEAL_BYTECODE_LENGTH} bytes, got ${actualLengthBytes} bytes`
    );
  }

  if (expectedBytecode) {
    const cleanExpected = expectedBytecode.startsWith('0x') ? expectedBytecode.slice(2) : expectedBytecode;
    if (cleanActual === cleanExpected) {
      return { match: 'exact', bytes: actualLengthBytes };
    }

    // Check executable prefix (first 20,000 bytes / 40,000 hex chars before EIP-712 constructor immutables)
    // and suffix (executable logic & CBOR metadata after constructor immutables: from char 41000 to end)
    const prefixActual = cleanActual.slice(0, 40000);
    const prefixExpected = cleanExpected.slice(0, 40000);
    const suffixActual = cleanActual.slice(41000);
    const suffixExpected = cleanExpected.slice(41000);

    if (prefixActual.toLowerCase() === prefixExpected.toLowerCase() && suffixActual.toLowerCase() === suffixExpected.toLowerCase()) {
      return { match: 'verified-immutable-match', bytes: actualLengthBytes };
    }

    // Fallback: standard CBOR metadata strip
    const executableActual = cleanActual.slice(0, -106);
    const executableExpected = cleanExpected.slice(0, -106);
    if (executableActual === executableExpected) {
      return { match: 'executable-prefix', bytes: actualLengthBytes };
    }

    throw new Error('Deal implementation bytecode differs from local SynqDealV1 artifact');
  }

  return { match: 'length-only', bytes: actualLengthBytes };
}

function validateV2DeploymentConfig(rawConfig, options = {}) {
  const chainId = Number(rawConfig.chainId);
  if (!options.allowTestNetwork && chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Network hard stop: Synq Deal V2 deployment script requires Sepolia chainId ${SEPOLIA_CHAIN_ID}, got ${chainId}`
    );
  }

  const canonicalUsdc = rawConfig.canonicalUsdc || SEPOLIA_CANONICAL_USDC;
  if (!options.allowCustomUsdc && canonicalUsdc.toLowerCase() !== SEPOLIA_CANONICAL_USDC.toLowerCase()) {
    throw new Error(
      `Canonical USDC mismatch: expected ${SEPOLIA_CANONICAL_USDC}, got ${canonicalUsdc}`
    );
  }

  const dealImplementation = rawConfig.dealImplementation || SEPOLIA_DEAL_IMPLEMENTATION;
  if (!options.allowCustomDealImplementation && dealImplementation.toLowerCase() !== SEPOLIA_DEAL_IMPLEMENTATION.toLowerCase()) {
    throw new Error(
      `Deal implementation mismatch: expected existing Sepolia implementation ${SEPOLIA_DEAL_IMPLEMENTATION}, got ${dealImplementation}`
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
    dealImplementation,
    primarySigners,
    emergencySigners,
    factoryOwner: factoryOwner || null,
    warnings,
  };
}

function buildSanitizedV2Plan(validatedConfig, deployerAddress) {
  return {
    network: 'sepolia',
    chainId: validatedConfig.chainId,
    version: PROTOCOL_VERSION,
    deployer: deployerAddress || '(pending connected signer)',
    factoryOwner: validatedConfig.factoryOwner || deployerAddress || '(defaults to deployer)',
    canonicalUsdc: validatedConfig.canonicalUsdc,
    usdcDecimals: USDC_DECIMALS,
    reusedDealImplementation: validatedConfig.dealImplementation,
    supersededFactoryV1: SEPOLIA_PREVIOUS_FACTORY_V1,
    steps: [
      {
        step: 1,
        action: 'Verify Existing SynqDealV1 Implementation',
        notes: `Asserts runtime code exists at ${validatedConfig.dealImplementation}, matches 23,551 bytes, client() == address(0), and milestoneCount() == 0. Does NOT redeploy SynqDealV1.`,
      },
      {
        step: 2,
        action: 'Deploy SynqFactoryV2 (Bootstrap state)',
        notes: 'Constructed with initialOwner, canonicalUsdc, dealImplementation, and temporary resolver placeholders to satisfy code.length > 0 circular dependency.',
        status: 'BOOTSTRAPPING / NOT READY (Direct deal creation disabled; no proposals accepted until resolvers wired)',
      },
      {
        step: 3,
        action: 'Deploy New Primary SynqResolutionCommittee',
        notes: 'Binds immutable factoryV2 address. Configures 3 signers, threshold 2-of-3.',
        signers: validatedConfig.primarySigners,
      },
      {
        step: 4,
        action: 'Deploy New Emergency SynqResolutionCommittee',
        notes: 'Binds immutable factoryV2 address. Configures 3 signers, threshold 2-of-3.',
        signers: validatedConfig.emergencySigners,
      },
      {
        step: 5,
        action: 'Wire Real Resolvers into SynqFactoryV2',
        notes: 'Executes setDefaultPrimaryResolver and setDefaultEmergencyResolver. Transitions Factory to READY FOR PROPOSALS.',
        status: 'READY FOR PROPOSALS',
      },
      {
        step: 6,
        action: 'Post-Deployment Readback Assertions',
        notes: 'Asserts 19 state invariants: immutables, resolvers, owner, signers, uninitialized logic, disabled direct creation staticCall, and EIP-712 domain.',
      },
      {
        step: 7,
        action: 'Generate Sanitized V2 Manifest',
        notes: 'Writes deployments/sepolia-v2-standard.json with overwrite protection and sanitized configuration.',
      },
    ],
    consent: {
      model: 'EIP-712 DealProposal',
      directCreationDisabled: true,
      notes: 'Deal clone materialization strictly requires explicit freelancer on-chain acceptDealProposal.',
    },
    protection: {
      enabled: false,
      reason: 'Active Protection is NOT enabled in Standard V2 rollout. module=address(0), policyId=bytes32(0).',
    },
    warnings: validatedConfig.warnings,
  };
}

function buildV2Manifest(params) {
  for (const k of Object.keys(params)) {
    if (/private|secret|mnemonic|seed/i.test(k) && !/policy|public/i.test(k)) {
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
      dealImplementation: params.dealImplementation || SEPOLIA_DEAL_IMPLEMENTATION,
      factory: params.factory,
      primaryResolver: params.primaryResolver,
      emergencyResolver: params.emergencyResolver,
      supersededFactoryV1: SEPOLIA_PREVIOUS_FACTORY_V1,
      supersededPrimaryResolverV1: SEPOLIA_PREVIOUS_PRIMARY_RESOLVER,
      supersededEmergencyResolverV1: SEPOLIA_PREVIOUS_EMERGENCY_RESOLVER,
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
    consent: {
      model: 'EIP-712 DealProposal',
      eip712DomainName: 'SynqFactoryV2',
      eip712DomainVersion: '1',
      directCreationDisabled: true,
    },
    protection: {
      enabled: false,
      module: null,
      policyId: null,
    },
    history: {
      v1Manifest: 'deployments/sepolia-v1-standard.json',
      reusedDealImplementation: true,
      reason: 'Upgraded to SynqFactoryV2 for explicit freelancer EIP-712 on-chain consent before Deal clone creation.',
    },
  };
}

function saveV2Manifest(targetPath, manifestData, options = {}) {
  const resolved = path.resolve(targetPath);
  if (fs.existsSync(resolved) && !options.overwrite) {
    throw new Error(
      `Deployment manifest already exists at "${resolved}". Refusing to overwrite by default to protect deployment history. Set SYNQ_OVERWRITE_V2_MANIFEST=true to overwrite.`
    );
  }

  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }

  fs.writeFileSync(resolved, JSON.stringify(manifestData, null, 2) + '\n', 'utf8');
  return resolved;
}

/**
 * Exhaustive post-deployment assertions for SynqFactoryV2 and its committees.
 * Verifies all 19 invariants required before declaring READY FOR PROPOSALS.
 */
async function executeV2Assertions({
  factory,
  primaryCommittee,
  emergencyCommittee,
  dealImpl,
  expectedConfig,
  factoryOwner,
  deployerAddress,
  expectedChainId,
}) {
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
  const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000';

  const factoryAddress = await factory.getAddress();
  const primaryAddress = await primaryCommittee.getAddress();
  const emergencyAddress = await emergencyCommittee.getAddress();
  const dealImplAddress = await dealImpl.getAddress();

  // 1. Factory V2 canonicalUsdc == expected USDC
  const readUsdc = await factory.canonicalUsdc();
  if (readUsdc.toLowerCase() !== expectedConfig.canonicalUsdc.toLowerCase()) {
    throw new Error(`Assertion 1 failed: factory.canonicalUsdc ${readUsdc} !== ${expectedConfig.canonicalUsdc}`);
  }

  // 2. Factory V2 dealImplementation == expected deal implementation
  const readImpl = await factory.dealImplementation();
  if (readImpl.toLowerCase() !== dealImplAddress.toLowerCase()) {
    throw new Error(`Assertion 2 failed: factory.dealImplementation ${readImpl} !== ${dealImplAddress}`);
  }

  // 3. defaultPrimaryResolver == new Primary Committee
  const readPrimary = await factory.defaultPrimaryResolver();
  if (readPrimary.toLowerCase() !== primaryAddress.toLowerCase()) {
    throw new Error(`Assertion 3 failed: factory.defaultPrimaryResolver ${readPrimary} !== ${primaryAddress}`);
  }

  // 4. defaultEmergencyResolver == new Emergency Committee
  const readEmergency = await factory.defaultEmergencyResolver();
  if (readEmergency.toLowerCase() !== emergencyAddress.toLowerCase()) {
    throw new Error(`Assertion 4 failed: factory.defaultEmergencyResolver ${readEmergency} !== ${emergencyAddress}`);
  }

  // 5. defaultProtectionModule == address(0)
  const readModule = await factory.defaultProtectionModule();
  if (readModule !== ZERO_ADDR) {
    throw new Error(`Assertion 5 failed: factory.defaultProtectionModule must be zero address, got ${readModule}`);
  }

  // 6. defaultProtectionPolicyId == bytes32(0)
  const readPolicy = await factory.defaultProtectionPolicyId();
  if (readPolicy !== ZERO_HASH) {
    throw new Error(`Assertion 6 failed: factory.defaultProtectionPolicyId must be zero bytes32, got ${readPolicy}`);
  }

  // 7. Factory owner == expected owner
  const readOwner = await factory.owner();
  if (readOwner.toLowerCase() !== factoryOwner.toLowerCase()) {
    throw new Error(`Assertion 7 failed: factory.owner ${readOwner} !== ${factoryOwner}`);
  }

  // 8. Primary committee factory() == Factory V2
  const primaryBoundFactory = await primaryCommittee.factory();
  if (primaryBoundFactory.toLowerCase() !== factoryAddress.toLowerCase()) {
    throw new Error(`Assertion 8 failed: primaryCommittee.factory ${primaryBoundFactory} !== ${factoryAddress}`);
  }

  // 9. Emergency committee factory() == Factory V2
  const emergencyBoundFactory = await emergencyCommittee.factory();
  if (emergencyBoundFactory.toLowerCase() !== factoryAddress.toLowerCase()) {
    throw new Error(`Assertion 9 failed: emergencyCommittee.factory ${emergencyBoundFactory} !== ${factoryAddress}`);
  }

  // 10. Primary committee epoch == 0
  const primaryEpoch = await primaryCommittee.committeeEpoch();
  if (primaryEpoch !== 0n) {
    throw new Error(`Assertion 10 failed: primaryCommittee.committeeEpoch must be 0, got ${primaryEpoch}`);
  }

  // 11. Emergency committee epoch == 0
  const emergencyEpoch = await emergencyCommittee.committeeEpoch();
  if (emergencyEpoch !== 0n) {
    throw new Error(`Assertion 11 failed: emergencyCommittee.committeeEpoch must be 0, got ${emergencyEpoch}`);
  }

  // 12. Primary signer set exact
  const pSigners = await primaryCommittee.getSigners();
  for (let i = 0; i < 3; i++) {
    if (pSigners[i].toLowerCase() !== expectedConfig.primarySigners[i].toLowerCase()) {
      throw new Error(`Assertion 12 failed: primarySigner [${i}] ${pSigners[i]} !== ${expectedConfig.primarySigners[i]}`);
    }
  }

  // 13. Emergency signer set exact
  const eSigners = await emergencyCommittee.getSigners();
  for (let i = 0; i < 3; i++) {
    if (eSigners[i].toLowerCase() !== expectedConfig.emergencySigners[i].toLowerCase()) {
      throw new Error(`Assertion 13 failed: emergencySigner [${i}] ${eSigners[i]} !== ${expectedConfig.emergencySigners[i]}`);
    }
  }

  // 14. Factory V2 getDealCount() == 0
  const dealCount = await factory.getDealCount();
  if (dealCount !== 0n) {
    throw new Error(`Assertion 14 failed: factory.getDealCount must be 0, got ${dealCount}`);
  }

  // 15. Existing Deal implementation client() == address(0)
  const implClient = await dealImpl.client();
  if (implClient !== ZERO_ADDR) {
    throw new Error(`Assertion 15 failed: dealImplementation cannot hold active client, got ${implClient}`);
  }

  // 16. Existing Deal implementation milestoneCount() == 0
  const implMilestoneCount = await dealImpl.milestoneCount();
  if (implMilestoneCount !== 0n) {
    throw new Error(`Assertion 16 failed: dealImplementation milestoneCount must be 0, got ${implMilestoneCount}`);
  }

  // 17. Direct Factory V2 createDeal remains disabled
  let directCreateReverted = false;
  try {
    await factory.createDeal.staticCall(
      deployerAddress,
      deployerAddress,
      [
        {
          amount: 1_000_000n,
          workDeadline: 9999999999n,
          reviewWindow: 86400n,
          gracePeriod: 0n,
          specHash: ZERO_HASH,
        },
      ]
    );
  } catch (err) {
    if (err.message.includes('Direct creation disabled: use acceptDealProposal')) {
      directCreateReverted = true;
    } else {
      throw new Error(`Assertion 17 failed: createDeal reverted with unexpected message: ${err.message}`);
    }
  }
  if (!directCreateReverted) {
    throw new Error('Assertion 17 failed: factory.createDeal did NOT revert with "Direct creation disabled: use acceptDealProposal"');
  }

  // 18. Direct Factory V2 createProtectedDeal remains disabled
  let directProtectedCreateReverted = false;
  try {
    await factory.createProtectedDeal.staticCall(
      deployerAddress,
      deployerAddress,
      [
        {
          amount: 1_000_000n,
          workDeadline: 9999999999n,
          reviewWindow: 86400n,
          gracePeriod: 0n,
          specHash: ZERO_HASH,
        },
      ]
    );
  } catch (err) {
    if (err.message.includes('Direct creation disabled: use acceptDealProposal')) {
      directProtectedCreateReverted = true;
    } else {
      throw new Error(`Assertion 18 failed: createProtectedDeal reverted with unexpected message: ${err.message}`);
    }
  }
  if (!directProtectedCreateReverted) {
    throw new Error('Assertion 18 failed: factory.createProtectedDeal did NOT revert with "Direct creation disabled: use acceptDealProposal"');
  }

  // 19. EIP-712 Domain verification
  const domain = await factory.eip712Domain();
  if (domain.name !== 'SynqFactoryV2') {
    throw new Error(`Assertion 19 failed: eip712Domain.name "${domain.name}" !== "SynqFactoryV2"`);
  }
  if (domain.version !== '1') {
    throw new Error(`Assertion 19 failed: eip712Domain.version "${domain.version}" !== "1"`);
  }
  if (expectedChainId && domain.chainId !== BigInt(expectedChainId)) {
    throw new Error(`Assertion 19 failed: eip712Domain.chainId ${domain.chainId} !== ${expectedChainId}`);
  }
  if (domain.verifyingContract.toLowerCase() !== factoryAddress.toLowerCase()) {
    throw new Error(`Assertion 19 failed: eip712Domain.verifyingContract ${domain.verifyingContract} !== ${factoryAddress}`);
  }

  return true;
}

module.exports = {
  SEPOLIA_CHAIN_ID,
  SEPOLIA_CANONICAL_USDC,
  SEPOLIA_DEAL_IMPLEMENTATION,
  SEPOLIA_PREVIOUS_FACTORY_V1,
  SEPOLIA_PREVIOUS_PRIMARY_RESOLVER,
  SEPOLIA_PREVIOUS_EMERGENCY_RESOLVER,
  USDC_DECIMALS,
  PROTOCOL_VERSION,
  COMMITTEE_THRESHOLD,
  EXPECTED_DEAL_BYTECODE_LENGTH,
  EXPECTED_FACTORY_V2_BYTECODE_LENGTH,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  isValidAddress,
  normalizeAddress,
  validateCommittee,
  analyzeCommitteeOverlap,
  verifyDealImplementationBytecode,
  validateV2DeploymentConfig,
  buildSanitizedV2Plan,
  buildV2Manifest,
  saveV2Manifest,
  executeV2Assertions,
};
