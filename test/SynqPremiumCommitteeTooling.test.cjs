// test/SynqPremiumCommitteeTooling.test.cjs
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { ethers } = require('ethers');
const {
  SEPOLIA_CHAIN_ID,
  EXPECTED_CANONICAL_COMMITTEE,
  EXPECTED_CANONICAL_MANAGER,
  COMMITTEE_DECISION_ENUM,
  CLAIM_DECISION_TYPES,
  assertSepoliaNetwork,
  loadAndValidatePremiumManifest,
  getCommitteeDomain,
  buildClaimDecisionAuth,
  verifyCommitteeSignatures,
  parseDecision,
} = require('../scripts/lib/premium-committee-config.cjs');

describe('SYNQ PREMIUM PROTECTION V1 — PHASE 7B COMMITTEE OPERATOR TOOLING', function () {
  const TEST_DEAL = '0x1234567890123456789012345678901234567890';
  const TEST_REPORT_HASH = ethers.keccak256(ethers.toUtf8Bytes('TEST_REPORT'));

  // 1. Network enforcement
  it('1. strictly enforces Sepolia network name and chainId (11155111)', function () {
    assert.strictEqual(assertSepoliaNetwork('sepolia', 11155111), true);
    assert.throws(() => assertSepoliaNetwork('hardhat', 31337), /requires network 'sepolia'/);
    assert.throws(() => assertSepoliaNetwork('sepolia', 31337), /strictly refuses to execute on chainId 31337/);
  });

  // 2. Manifest loading
  it('2. loads and verifies canonical Committee and Manager from live manifest', function () {
    const manifest = loadAndValidatePremiumManifest();
    assert.strictEqual(manifest.chainId, 11155111);
    assert.strictEqual(manifest.committee.toLowerCase(), EXPECTED_CANONICAL_COMMITTEE.toLowerCase());
    assert.strictEqual(manifest.manager.toLowerCase(), EXPECTED_CANONICAL_MANAGER.toLowerCase());
    assert.strictEqual(manifest.signers.length, 3);
    assert.strictEqual(manifest.threshold, 2);
  });

  // 3. EIP-712 Domain and types
  it('3. constructs exact EIP-712 domain and types expected by SynqProtectionCommittee', function () {
    const domain = getCommitteeDomain(EXPECTED_CANONICAL_COMMITTEE, 11155111);
    assert.strictEqual(domain.name, 'SynqProtectionCommittee');
    assert.strictEqual(domain.version, '1');
    assert.strictEqual(domain.chainId, 11155111);
    assert.strictEqual(domain.verifyingContract, EXPECTED_CANONICAL_COMMITTEE);

    const typeFields = CLAIM_DECISION_TYPES.ProtectionClaimDecisionAuth.map((f) => f.name);
    assert.deepStrictEqual(typeFields, [
      'committee',
      'chainId',
      'manager',
      'deal',
      'milestoneId',
      'decision',
      'decisionReportHash',
      'decisionNonce',
      'validUntil',
    ]);
  });

  // 4. Decision parsing
  it('4. strictly parses binary decision (APPROVE = 1, REJECT = 2)', function () {
    assert.strictEqual(parseDecision('APPROVE'), 1);
    assert.strictEqual(parseDecision('approve'), 1);
    assert.strictEqual(parseDecision(1), 1);
    assert.strictEqual(parseDecision('REJECT'), 2);
    assert.strictEqual(parseDecision('reject'), 2);
    assert.strictEqual(parseDecision(2), 2);

    assert.throws(() => parseDecision('INVALID'), /Invalid committee decision/);
    assert.throws(() => parseDecision(0), /Invalid committee decision/);
    assert.throws(() => parseDecision(3), /Invalid committee decision/);
  });

  // 5. Auth struct construction
  it('5. builds sanitized ProtectionClaimDecisionAuth structure with BigInt safety', function () {
    const authPayload = buildClaimDecisionAuth({
      committee: EXPECTED_CANONICAL_COMMITTEE,
      manager: EXPECTED_CANONICAL_MANAGER,
      deal: TEST_DEAL,
      milestoneId: 0,
      decision: 'APPROVE',
      decisionReportHash: TEST_REPORT_HASH,
      decisionNonce: 1,
      validUntil: 2000000000,
      chainId: 11155111,
    });

    assert.strictEqual(authPayload.auth.committee, EXPECTED_CANONICAL_COMMITTEE);
    assert.strictEqual(authPayload.auth.manager, EXPECTED_CANONICAL_MANAGER);
    assert.strictEqual(authPayload.auth.deal, TEST_DEAL);
    assert.strictEqual(authPayload.auth.milestoneId, 0n);
    assert.strictEqual(authPayload.auth.decision, 1);
    assert.strictEqual(authPayload.auth.decisionNonce, 1n);
    assert.strictEqual(authPayload.auth.validUntil, 2000000000n);
  });

  // 6 & 7: 2-of-3 signature generation and local verification
  it('6-7. verifies two valid distinct committee signatures locally before broadcast', async function () {
    const w1 = ethers.Wallet.createRandom();
    const w2 = ethers.Wallet.createRandom();
    const w3 = ethers.Wallet.createRandom();

    const authorizedSet = [w1.address, w2.address, w3.address];

    const authPayload = buildClaimDecisionAuth({
      committee: EXPECTED_CANONICAL_COMMITTEE,
      manager: EXPECTED_CANONICAL_MANAGER,
      deal: TEST_DEAL,
      milestoneId: 0,
      decision: 'APPROVE',
      decisionReportHash: TEST_REPORT_HASH,
      decisionNonce: 1,
      validUntil: Math.floor(Date.now() / 1000) + 86400,
      chainId: 11155111,
    });

    const sig1 = await w1.signTypedData(authPayload.domain, authPayload.types, authPayload.auth);
    const sig2 = await w2.signTypedData(authPayload.domain, authPayload.types, authPayload.auth);

    const result = verifyCommitteeSignatures(authPayload, sig1, sig2, authorizedSet);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.signer1.toLowerCase(), w1.address.toLowerCase());
    assert.strictEqual(result.signer2.toLowerCase(), w2.address.toLowerCase());
  });

  // 8. Rejects duplicate signer signatures
  it('8. rejects duplicate signatures from the same committee signer', async function () {
    const w1 = ethers.Wallet.createRandom();
    const w2 = ethers.Wallet.createRandom();
    const authorizedSet = [w1.address, w2.address];

    const authPayload = buildClaimDecisionAuth({
      committee: EXPECTED_CANONICAL_COMMITTEE,
      manager: EXPECTED_CANONICAL_MANAGER,
      deal: TEST_DEAL,
      milestoneId: 0,
      decision: 'APPROVE',
      decisionReportHash: TEST_REPORT_HASH,
      decisionNonce: 1,
      validUntil: Math.floor(Date.now() / 1000) + 86400,
      chainId: 11155111,
    });

    const sig1 = await w1.signTypedData(authPayload.domain, authPayload.types, authPayload.auth);

    assert.throws(
      () => verifyCommitteeSignatures(authPayload, sig1, sig1, authorizedSet),
      /Duplicate committee signature detected/
    );
  });

  // 9. Rejects unauthorized non-committee signers
  it('9. rejects signatures from unauthorized third parties', async function () {
    const w1 = ethers.Wallet.createRandom();
    const rogue = ethers.Wallet.createRandom();
    const authorizedSet = [w1.address]; // rogue is not authorized

    const authPayload = buildClaimDecisionAuth({
      committee: EXPECTED_CANONICAL_COMMITTEE,
      manager: EXPECTED_CANONICAL_MANAGER,
      deal: TEST_DEAL,
      milestoneId: 0,
      decision: 'APPROVE',
      decisionReportHash: TEST_REPORT_HASH,
      decisionNonce: 1,
      validUntil: Math.floor(Date.now() / 1000) + 86400,
      chainId: 11155111,
    });

    const sig1 = await w1.signTypedData(authPayload.domain, authPayload.types, authPayload.auth);
    const sigRogue = await rogue.signTypedData(authPayload.domain, authPayload.types, authPayload.auth);

    assert.throws(
      () => verifyCommitteeSignatures(authPayload, sig1, sigRogue, authorizedSet),
      /not an authorized committee member/
    );
  });

  // 10. Rejects expired authorizations
  it('10. rejects expired authorization timestamps', async function () {
    const w1 = ethers.Wallet.createRandom();
    const w2 = ethers.Wallet.createRandom();
    const authorizedSet = [w1.address, w2.address];

    const authPayload = buildClaimDecisionAuth({
      committee: EXPECTED_CANONICAL_COMMITTEE,
      manager: EXPECTED_CANONICAL_MANAGER,
      deal: TEST_DEAL,
      milestoneId: 0,
      decision: 'APPROVE',
      decisionReportHash: TEST_REPORT_HASH,
      decisionNonce: 1,
      validUntil: Math.floor(Date.now() / 1000) - 100, // expired 100s ago
      chainId: 11155111,
    });

    const sig1 = await w1.signTypedData(authPayload.domain, authPayload.types, authPayload.auth);
    const sig2 = await w2.signTypedData(authPayload.domain, authPayload.types, authPayload.auth);

    assert.throws(
      () => verifyCommitteeSignatures(authPayload, sig1, sig2, authorizedSet),
      /Authorization expired/
    );
  });
});
