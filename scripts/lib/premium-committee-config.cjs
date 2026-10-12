// scripts/lib/premium-committee-config.cjs
/**
 * Pure validation, EIP-712 typed-data generation, and signature verification logic
 * for Synq Premium Protection Committee claim determinations.
 *
 * Enforces:
 * - Sepolia network & chainId 11155111
 * - Strict EIP-712 domain and ProtectionClaimDecisionAuth typed data
 * - Binary decisions: APPROVE (1) or REJECT (2)
 * - Exactly 2 distinct authorized committee signers (2-of-3 multisig threshold)
 * - Local signature recovery and authorization preflight before broadcast
 * - Replay protection (nonce & validUntil)
 * - Zero private key exposure
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const SEPOLIA_CHAIN_ID = 11155111;
const PREMIUM_MANIFEST_PATH = path.join(__dirname, '..', '..', 'deployments', 'sepolia-premium-protection-v1.json');

const EXPECTED_CANONICAL_POOL = '0xA1f4991597869ba11EbD94edED4d69960063cbc2';
const EXPECTED_CANONICAL_MANAGER = '0xEbD3654548371f2dc2d1420226b99983a42e2FE8';
const EXPECTED_CANONICAL_COMMITTEE = '0x8e77aFf09Dd37EEa35d2931Ac1aA624abBF94e12';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const COMMITTEE_DECISION_ENUM = {
  Approve: 1,
  Reject: 2,
};

const CLAIM_DECISION_TYPES = {
  ProtectionClaimDecisionAuth: [
    { name: 'committee', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'manager', type: 'address' },
    { name: 'deal', type: 'address' },
    { name: 'milestoneId', type: 'uint256' },
    { name: 'decision', type: 'uint8' },
    { name: 'decisionReportHash', type: 'bytes32' },
    { name: 'decisionNonce', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
  ],
};

function isValidAddress(addr) {
  if (typeof addr !== 'string') return false;
  if (!/^0[xX][0-9a-fA-F]{40}$/.test(addr)) return false;
  if (addr.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return false;
  return true;
}

function isValidBytes32(hex) {
  if (typeof hex !== 'string') return false;
  return /^0[xX][0-9a-fA-F]{64}$/.test(hex);
}

function parseDecision(input) {
  if (input === undefined || input === null) {
    throw new Error('Committee decision is required (APPROVE or REJECT)');
  }
  const str = String(input).trim().toUpperCase();
  if (str === 'APPROVE' || str === '1') {
    return COMMITTEE_DECISION_ENUM.Approve;
  }
  if (str === 'REJECT' || str === '2') {
    return COMMITTEE_DECISION_ENUM.Reject;
  }
  throw new Error(`Invalid committee decision: "${input}". Must be APPROVE (1) or REJECT (2).`);
}

function assertSepoliaNetwork(configuredNetworkName, observedChainId) {
  if (configuredNetworkName !== 'sepolia') {
    throw new Error(
      `NETWORK HARD STOP: Committee decision tooling requires network 'sepolia', got '${configuredNetworkName}'. Use --network sepolia.`
    );
  }

  const numericChainId = Number(observedChainId);
  if (numericChainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `NETWORK HARD STOP: Committee decision tooling strictly refuses to execute on chainId ${numericChainId}. Only Sepolia (${SEPOLIA_CHAIN_ID}) is supported.`
    );
  }

  return true;
}

function loadAndValidatePremiumManifest(manifestPath = PREMIUM_MANIFEST_PATH) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Premium Protection deployment manifest not found at: ${manifestPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse Premium Protection manifest at ${manifestPath}: ${err.message}`);
  }

  if (manifest.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `MANIFEST MISMATCH: Expected chainId ${SEPOLIA_CHAIN_ID}, manifest has ${manifest.chainId}`
    );
  }

  const committee = manifest.contracts?.protectionCommittee;
  if (!committee || committee.toLowerCase() !== EXPECTED_CANONICAL_COMMITTEE.toLowerCase()) {
    throw new Error(
      `MANIFEST MISMATCH: Expected ProtectionCommittee ${EXPECTED_CANONICAL_COMMITTEE}, manifest has ${committee}`
    );
  }

  const manager = manifest.contracts?.protectionManager;
  if (!manager || manager.toLowerCase() !== EXPECTED_CANONICAL_MANAGER.toLowerCase()) {
    throw new Error(
      `MANIFEST MISMATCH: Expected ProtectionManager ${EXPECTED_CANONICAL_MANAGER}, manifest has ${manager}`
    );
  }

  const pool = manifest.contracts?.protectionPool;
  if (!pool || pool.toLowerCase() !== EXPECTED_CANONICAL_POOL.toLowerCase()) {
    throw new Error(
      `MANIFEST MISMATCH: Expected ProtectionPool ${EXPECTED_CANONICAL_POOL}, manifest has ${pool}`
    );
  }

  const signers = manifest.governance?.committeeSigners || [];
  if (signers.length !== 3) {
    throw new Error('MANIFEST MISMATCH: Expected 3 committee signers in manifest');
  }

  return {
    chainId: manifest.chainId,
    committee: EXPECTED_CANONICAL_COMMITTEE,
    manager: EXPECTED_CANONICAL_MANAGER,
    pool: EXPECTED_CANONICAL_POOL,
    signers: signers.map((s) => s.toLowerCase()),
    threshold: Number(manifest.governance?.threshold || 2),
    manifestPath,
  };
}

function getCommitteeDomain(committeeAddress, chainId = SEPOLIA_CHAIN_ID) {
  return {
    name: 'SynqProtectionCommittee',
    version: '1',
    chainId: Number(chainId),
    verifyingContract: committeeAddress,
  };
}

function buildClaimDecisionAuth(params) {
  const {
    committee,
    manager,
    deal,
    milestoneId,
    decision,
    decisionReportHash,
    decisionNonce,
    validUntil,
    chainId = SEPOLIA_CHAIN_ID,
  } = params;

  if (!isValidAddress(committee)) {
    throw new Error(`Invalid committee address: "${committee}"`);
  }
  if (!isValidAddress(manager)) {
    throw new Error(`Invalid manager address: "${manager}"`);
  }
  if (!isValidAddress(deal)) {
    throw new Error(`Invalid deal address: "${deal}"`);
  }

  const parsedMilestoneId = BigInt(milestoneId);
  if (parsedMilestoneId < 0n) {
    throw new Error('Milestone ID cannot be negative');
  }

  const parsedDecision = typeof decision === 'number' ? decision : parseDecision(decision);
  if (parsedDecision !== 1 && parsedDecision !== 2) {
    throw new Error(`Decision must be 1 (Approve) or 2 (Reject), got ${parsedDecision}`);
  }

  if (!isValidBytes32(decisionReportHash)) {
    throw new Error(`decisionReportHash must be a valid 32-byte hex string (0x-prefixed 64 hex chars), got "${decisionReportHash}"`);
  }

  const parsedNonce = BigInt(decisionNonce);
  if (parsedNonce <= 0n) {
    throw new Error('decisionNonce must be greater than zero');
  }

  const parsedValidUntil = BigInt(validUntil);
  if (parsedValidUntil <= 0n) {
    throw new Error('validUntil timestamp must be greater than zero');
  }

  const auth = {
    committee,
    chainId: BigInt(chainId),
    manager,
    deal,
    milestoneId: parsedMilestoneId,
    decision: parsedDecision,
    decisionReportHash,
    decisionNonce: parsedNonce,
    validUntil: parsedValidUntil,
  };

  const domain = getCommitteeDomain(committee, chainId);

  return {
    domain,
    types: CLAIM_DECISION_TYPES,
    auth,
  };
}

/**
 * Computes EIP-712 digest and verifies that sig1 and sig2 recover distinct authorized signers.
 */
function verifyCommitteeSignatures(authPayload, sig1, sig2, authorizedSigners = []) {
  const { domain, types, auth } = authPayload;

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (auth.validUntil <= nowSec) {
    throw new Error(
      `Authorization expired: validUntil (${auth.validUntil}) <= current time (${nowSec})`
    );
  }

  if (!sig1 || typeof sig1 !== 'string' || !sig1.startsWith('0x')) {
    throw new Error('Invalid signature 1 format');
  }
  if (!sig2 || typeof sig2 !== 'string' || !sig2.startsWith('0x')) {
    throw new Error('Invalid signature 2 format');
  }

  const signer1 = ethers.verifyTypedData(domain, types, auth, sig1);
  const signer2 = ethers.verifyTypedData(domain, types, auth, sig2);

  const s1Norm = signer1.toLowerCase();
  const s2Norm = signer2.toLowerCase();

  if (s1Norm === s2Norm) {
    throw new Error(`Duplicate committee signature detected: both signatures recovered from ${signer1}`);
  }

  const authorizedNorm = authorizedSigners.map((s) => s.toLowerCase());
  if (authorizedNorm.length > 0) {
    if (!authorizedNorm.includes(s1Norm)) {
      throw new Error(`Signer 1 (${signer1}) is not an authorized committee member`);
    }
    if (!authorizedNorm.includes(s2Norm)) {
      throw new Error(`Signer 2 (${signer2}) is not an authorized committee member`);
    }
  }

  return {
    signer1,
    signer2,
    valid: true,
  };
}

module.exports = {
  SEPOLIA_CHAIN_ID,
  PREMIUM_MANIFEST_PATH,
  EXPECTED_CANONICAL_POOL,
  EXPECTED_CANONICAL_MANAGER,
  EXPECTED_CANONICAL_COMMITTEE,
  COMMITTEE_DECISION_ENUM,
  CLAIM_DECISION_TYPES,
  isValidAddress,
  isValidBytes32,
  parseDecision,
  assertSepoliaNetwork,
  loadAndValidatePremiumManifest,
  getCommitteeDomain,
  buildClaimDecisionAuth,
  verifyCommitteeSignatures,
};
