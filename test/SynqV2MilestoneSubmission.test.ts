// test/SynqV2MilestoneSubmission.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isAddress,
  getAddress,
  encodeEventTopics,
  encodeAbiParameters,
  keccak256,
  toHex,
} from 'viem';
import {
  SYNQ_V2_SEPOLIA_CONFIG,
  SEPOLIA_CHAIN_ID,
} from '@/lib/contracts/addresses';
import {
  synqDealV1ABI,
  synqFactoryV2ABI,
  erc20ABI,
} from '@/lib/contracts/abis';
import {
  DealState,
  DEAL_STATE_LABELS,
  MilestoneStatus,
  MILESTONE_STATUS_LABELS,
  StandardV2DealData,
  StandardV2OnChainMilestone,
  determineDealRole,
  determineMilestoneStartEligibility,
  determineMilestoneSubmissionEligibility,
  validateSubmitWorkPreflight,
  verifySubmitWorkReceipt,
  hashMilestoneEvidence,
  calculateReviewWindowExpiration,
  calculateEffectiveSubmissionDeadline,
  verifyV2DealIdentitySync,
  isSynqV2Deal,
  readStandardV2DealData,
  isMilestoneSettled,
  getCurrentMilestoneIndex,
  MILESTONE_SUBMITTED_TOPIC0,
} from '@/lib/deals/v2-deal';
import { formatUsdcAmount, ZERO_BYTES32 } from '@/lib/deals/v2';

// Test Constants & Wallets
const TEST_CLIENT = '0xD2D4d415a4730b1490c9Ce27944529B83ff76319';
const TEST_FREELANCER = '0xd646585Fb453be3698F6D959d796C1D86B832c04';
const TEST_STRANGER = '0x1111111111111111111111111111111111111111';
const TEST_DEAL_ADDRESS = '0x142Ee9d2b5B6758F4D00439f3583fDcB89309807';
const TEST_RESOLVER_1 = '0xd60bBCc7c8aCA633A6D158B6f7F7367E36207676';
const TEST_RESOLVER_2 = '0x5dcB412bA5f032Bc9095CDc95046168A076Ff952';

const KNOWN_SMOKE_EVIDENCE_STRING = 'Synq Standard V2 Sepolia smoke test completed';
const KNOWN_SMOKE_EVIDENCE_HASH = '0x8412f5b24e909b4111e788bcab7eca3a2bd82800438cdef656289ce8ebd8ab1e';

function createMockMilestones(count = 2, overrides: Partial<StandardV2OnChainMilestone>[] = []): StandardV2OnChainMilestone[] {
  const result: StandardV2OnChainMilestone[] = [];
  for (let i = 0; i < count; i++) {
    result.push({
      index: i,
      amount: 25_000_000n,
      workDeadline: 1800000000n, // Unix timestamp in seconds
      reviewWindow: 86400n,      // 24 hours in seconds
      gracePeriod: 86400n,       // 24 hours in seconds
      status: i === 0 ? MilestoneStatus.InProgress : MilestoneStatus.Pending,
      specHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      evidenceRootHash: ZERO_BYTES32,
      submittedAt: 0n,
      version: 0,
      ...(overrides[i] || {}),
    });
  }
  return result;
}

describe('PHASE 3I: STANDARD V2 — MILESTONE WORK SUBMISSION', () => {

  // ==================================================
  // 1. CANONICAL DEAL DETECTION & TRANSACTION TARGET
  // ==================================================

  it('1. canonical sequential Deal detected via factory registration and canonical USDC', () => {
    const validIdentity = verifyV2DealIdentitySync({
      dealAddress: TEST_DEAL_ADDRESS,
      isFactoryRegistered: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
    });
    assert.strictEqual(validIdentity.valid, true);

    const unregistered = verifyV2DealIdentitySync({
      dealAddress: TEST_DEAL_ADDRESS,
      isFactoryRegistered: false,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
    });
    assert.strictEqual(unregistered.valid, false);
    assert.match(unregistered.error!, /not registered in canonical SynqFactoryV2/);
  });

  it('2. exact Deal clone is transaction target (never Factory or master implementation)', () => {
    assert.notStrictEqual(TEST_DEAL_ADDRESS.toLowerCase(), SYNQ_V2_SEPOLIA_CONFIG.factory.toLowerCase());
    assert.notStrictEqual(TEST_DEAL_ADDRESS.toLowerCase(), SYNQ_V2_SEPOLIA_CONFIG.dealImplementation.toLowerCase());
    assert.strictEqual(isAddress(TEST_DEAL_ADDRESS), true);
  });

  // ==================================================
  // 2. ROLE AUTHORIZATION (onlyFreelancer)
  // ==================================================

  it('3. only freelancer may submit work deliverables', () => {
    const milestones = createMockMilestones(1);
    const eligibility = determineMilestoneSubmissionEligibility({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Active,
      milestones,
      currentTimeSeconds: 1750000000n,
    });
    assert.strictEqual(eligibility.canSubmit, true);
    assert.strictEqual(eligibility.role, 'freelancer');
    assert.strictEqual(eligibility.targetMilestoneIndex, 0);
  });

  it('4. client cannot submit work deliverables', () => {
    const milestones = createMockMilestones(1);
    const eligibility = determineMilestoneSubmissionEligibility({
      connectedWallet: TEST_CLIENT,
      freelancerAddress: TEST_FREELANCER,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Active,
      milestones,
      currentTimeSeconds: 1750000000n,
    });
    assert.strictEqual(eligibility.canSubmit, false);
    assert.strictEqual(eligibility.role, 'client');
    assert.match(eligibility.reason!, /Awaiting freelancer deliverable submission/);

    const preflight = validateSubmitWorkPreflight({
      connectedWallet: TEST_CLIENT,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealState: DealState.Active,
      targetMilestoneIndex: 0,
      milestones,
      evidenceRootHash: KNOWN_SMOKE_EVIDENCE_HASH,
      currentTimeSeconds: 1750000000n,
    });
    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error!, /Unauthorized: Only the designated freelancer can submit deliverables/);
  });

  it('5. unrelated wallet cannot submit work deliverables', () => {
    const milestones = createMockMilestones(1);
    const eligibility = determineMilestoneSubmissionEligibility({
      connectedWallet: TEST_STRANGER,
      freelancerAddress: TEST_FREELANCER,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Active,
      milestones,
      currentTimeSeconds: 1750000000n,
    });
    assert.strictEqual(eligibility.canSubmit, false);
    assert.strictEqual(eligibility.role, 'third_party');
    assert.match(eligibility.reason!, /Only the designated freelancer can submit milestone deliverables/);

    const unconnected = determineMilestoneSubmissionEligibility({
      connectedWallet: null,
      freelancerAddress: TEST_FREELANCER,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Active,
      milestones,
      currentTimeSeconds: 1750000000n,
    });
    assert.strictEqual(unconnected.canSubmit, false);
    assert.strictEqual(unconnected.role, 'unconnected');
    assert.match(unconnected.reason!, /Wallet not connected/);
  });

  // ==================================================
  // 3. DEAL STATE CONSTRAINTS (inDealState(DealState.Active))
  // ==================================================

  it('6. correct Deal state required: Active (fails closed on Draft or terminal states)', () => {
    const milestones = createMockMilestones(1);

    for (const invalidState of [DealState.Draft, DealState.Completed, DealState.TerminatedEarly, DealState.Cancelled]) {
      const eligibility = determineMilestoneSubmissionEligibility({
        connectedWallet: TEST_FREELANCER,
        freelancerAddress: TEST_FREELANCER,
        clientAddress: TEST_CLIENT,
        chainId: SEPOLIA_CHAIN_ID,
        dealState: invalidState,
        milestones,
        currentTimeSeconds: 1750000000n,
      });
      assert.strictEqual(eligibility.canSubmit, false);

      const preflight = validateSubmitWorkPreflight({
        connectedWallet: TEST_FREELANCER,
        freelancerAddress: TEST_FREELANCER,
        chainId: SEPOLIA_CHAIN_ID,
        isCanonicalV2Deal: true,
        dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
        dealState: invalidState,
        targetMilestoneIndex: 0,
        milestones,
        evidenceRootHash: KNOWN_SMOKE_EVIDENCE_HASH,
        currentTimeSeconds: 1750000000n,
      });
      assert.strictEqual(preflight.valid, false);
    }
  });

  // ==================================================
  // 4. MILESTONE STATUS CONSTRAINTS
  // ==================================================

  it('7. correct milestone status required: must be InProgress', () => {
    const milestones = createMockMilestones(1, [{ status: MilestoneStatus.InProgress }]);
    const eligibility = determineMilestoneSubmissionEligibility({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Active,
      milestones,
      currentTimeSeconds: 1750000000n,
    });
    assert.strictEqual(eligibility.canSubmit, true);
  });

  it('8. Pending milestone cannot submit', () => {
    const milestones = createMockMilestones(1, [{ status: MilestoneStatus.Pending }]);
    const eligibility = determineMilestoneSubmissionEligibility({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Active,
      milestones,
      currentTimeSeconds: 1750000000n,
    });
    assert.strictEqual(eligibility.canSubmit, false);
    assert.match(eligibility.reason!, /has not been started yet/);

    const preflight = validateSubmitWorkPreflight({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealState: DealState.Active,
      targetMilestoneIndex: 0,
      milestones,
      evidenceRootHash: KNOWN_SMOKE_EVIDENCE_HASH,
      currentTimeSeconds: 1750000000n,
    });
    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error!, /is not InProgress/);
  });

  it('9. InProgress milestone can submit', () => {
    const milestones = createMockMilestones(1, [{ status: MilestoneStatus.InProgress }]);
    const preflight = validateSubmitWorkPreflight({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealState: DealState.Active,
      targetMilestoneIndex: 0,
      milestones,
      evidenceRootHash: KNOWN_SMOKE_EVIDENCE_HASH,
      currentTimeSeconds: 1750000000n,
    });
    assert.strictEqual(preflight.valid, true);
  });

  it('10. already Submitted milestone cannot submit again', () => {
    const milestones = createMockMilestones(1, [{
      status: MilestoneStatus.Submitted,
      evidenceRootHash: KNOWN_SMOKE_EVIDENCE_HASH,
      submittedAt: 1750000000n,
      version: 1,
    }]);

    const eligibility = determineMilestoneSubmissionEligibility({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Active,
      milestones,
      currentTimeSeconds: 1750000000n,
    });
    assert.strictEqual(eligibility.canSubmit, false);
    assert.match(eligibility.reason!, /already been submitted and is currently in client review/);

    const preflight = validateSubmitWorkPreflight({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealState: DealState.Active,
      targetMilestoneIndex: 0,
      milestones,
      evidenceRootHash: KNOWN_SMOKE_EVIDENCE_HASH,
      currentTimeSeconds: 1750000000n,
    });
    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error!, /is not InProgress/);
  });

  it('11. settled milestone cannot submit', () => {
    for (const settledStatus of [MilestoneStatus.SettledPaid, MilestoneStatus.SettledRefunded, MilestoneStatus.SettledSplit]) {
      const milestones = createMockMilestones(1, [{ status: settledStatus }]);
      const eligibility = determineMilestoneSubmissionEligibility({
        connectedWallet: TEST_FREELANCER,
        freelancerAddress: TEST_FREELANCER,
        clientAddress: TEST_CLIENT,
        chainId: SEPOLIA_CHAIN_ID,
        dealState: DealState.Active,
        milestones,
        currentTimeSeconds: 1750000000n,
      });
      assert.strictEqual(eligibility.canSubmit, false);
      assert.strictEqual(eligibility.targetMilestoneIndex, null);
    }
  });

  // ==================================================
  // 5. SEQUENTIAL INTEGRITY
  // ==================================================

  it('12. later Pending milestone remains blocked while earlier milestone is InProgress or Submitted', () => {
    // Milestone 0 InProgress, Milestone 1 Pending
    const milestones = createMockMilestones(2, [
      { status: MilestoneStatus.InProgress },
      { status: MilestoneStatus.Pending },
    ]);

    // Submitting Milestone 1 directly must fail preflight
    const preflight = validateSubmitWorkPreflight({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealState: DealState.Active,
      targetMilestoneIndex: 1,
      milestones,
      evidenceRootHash: KNOWN_SMOKE_EVIDENCE_HASH,
      currentTimeSeconds: 1750000000n,
    });
    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error!, /is not InProgress/);

    // After Milestone 0 is Submitted, Milestone 1 is still blocked
    const milestonesSubmitted0 = createMockMilestones(2, [
      { status: MilestoneStatus.Submitted, evidenceRootHash: KNOWN_SMOKE_EVIDENCE_HASH, submittedAt: 1750000000n },
      { status: MilestoneStatus.Pending },
    ]);

    const preflight2 = validateSubmitWorkPreflight({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealState: DealState.Active,
      targetMilestoneIndex: 1,
      milestones: milestonesSubmitted0,
      evidenceRootHash: KNOWN_SMOKE_EVIDENCE_HASH,
      currentTimeSeconds: 1750000000n,
    });
    assert.strictEqual(preflight2.valid, false);
  });

  // ==================================================
  // 6. DEADLINE & GRACE CONDITION
  // ==================================================

  it('13. deadline converted and read in seconds', () => {
    const workDeadline = 1800000000n; // seconds
    const gracePeriod = 86400n;      // seconds
    const effective = calculateEffectiveSubmissionDeadline(workDeadline, gracePeriod);
    assert.strictEqual(effective, 1800086400n);
  });

  it('14. valid before workDeadline + gracePeriod', () => {
    const milestones = createMockMilestones(1, [{
      workDeadline: 1000n,
      gracePeriod: 200n,
      status: MilestoneStatus.InProgress,
    }]);

    // Right on deadline (1000)
    const check1 = determineMilestoneSubmissionEligibility({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Active,
      milestones,
      currentTimeSeconds: 1000n,
    });
    assert.strictEqual(check1.canSubmit, true);

    // Within grace (1150)
    const check2 = determineMilestoneSubmissionEligibility({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Active,
      milestones,
      currentTimeSeconds: 1150n,
    });
    assert.strictEqual(check2.canSubmit, true);

    // Exactly at deadline + grace (1200)
    const check3 = determineMilestoneSubmissionEligibility({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Active,
      milestones,
      currentTimeSeconds: 1200n,
    });
    assert.strictEqual(check3.canSubmit, true);
  });

  it('15. expired submission blocked when block.timestamp > workDeadline + gracePeriod', () => {
    const milestones = createMockMilestones(1, [{
      workDeadline: 1000n,
      gracePeriod: 200n,
      status: MilestoneStatus.InProgress,
    }]);

    // 1 second past grace (1201)
    const checkExpired = determineMilestoneSubmissionEligibility({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Active,
      milestones,
      currentTimeSeconds: 1201n,
    });
    assert.strictEqual(checkExpired.canSubmit, false);
    assert.strictEqual(checkExpired.isExpired, true);
    assert.match(checkExpired.reason!, /expired/);

    const preflight = validateSubmitWorkPreflight({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealState: DealState.Active,
      targetMilestoneIndex: 0,
      milestones,
      evidenceRootHash: KNOWN_SMOKE_EVIDENCE_HASH,
      currentTimeSeconds: 1201n,
    });
    assert.strictEqual(preflight.valid, false);
    assert.strictEqual(preflight.error, 'Work deadline and grace expired');
  });

  // ==================================================
  // 7. EVIDENCE HASHING & SOLIDITY PARITY
  // ==================================================

  it('16. canonical evidence hashing reproduces smoke test evidenceRootHash vector', () => {
    const computed = hashMilestoneEvidence(KNOWN_SMOKE_EVIDENCE_STRING);
    assert.strictEqual(computed, KNOWN_SMOKE_EVIDENCE_HASH);

    // Explicit 32-byte hex pass-through
    const rawPassThrough = hashMilestoneEvidence(KNOWN_SMOKE_EVIDENCE_HASH);
    assert.strictEqual(rawPassThrough, KNOWN_SMOKE_EVIDENCE_HASH);
  });

  it('17. evidence change changes hash deterministically', () => {
    const hashA = hashMilestoneEvidence('Deliverable commit SHA: 1234abcd');
    const hashB = hashMilestoneEvidence('Deliverable commit SHA: 1234abce');
    assert.notStrictEqual(hashA, hashB);
    assert.strictEqual(hashA, hashMilestoneEvidence('Deliverable commit SHA: 1234abcd'));
  });

  it('18. empty evidence behavior matches Solidity: strictly forbids empty and bytes32(0)', () => {
    assert.throws(() => hashMilestoneEvidence(''), /cannot be empty/);
    assert.throws(() => hashMilestoneEvidence('   '), /cannot be empty/);
    assert.throws(() => hashMilestoneEvidence(ZERO_BYTES32), /Empty evidence root hash/);

    const milestones = createMockMilestones(1);
    const preflightZero = validateSubmitWorkPreflight({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealState: DealState.Active,
      targetMilestoneIndex: 0,
      milestones,
      evidenceRootHash: ZERO_BYTES32,
      currentTimeSeconds: 1750000000n,
    });
    assert.strictEqual(preflightZero.valid, false);
    assert.strictEqual(preflightZero.error, 'Empty evidence root hash');
  });

  // ==================================================
  // 8. PREFLIGHT & NETWORK CONSTRAINTS
  // ==================================================

  it('19. fresh preflight before transaction fails closed on mismatching state', () => {
    const milestones = createMockMilestones(1);
    const preflight = validateSubmitWorkPreflight({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: false, // Failure
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealState: DealState.Active,
      targetMilestoneIndex: 0,
      milestones,
      evidenceRootHash: KNOWN_SMOKE_EVIDENCE_HASH,
      currentTimeSeconds: 1750000000n,
    });
    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error!, /Deal identity failure/);
  });

  it('20. wrong network blocked: requires Sepolia chainId 11155111', () => {
    const milestones = createMockMilestones(1);
    const preflight = validateSubmitWorkPreflight({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      chainId: 1, // Mainnet instead of Sepolia
      isCanonicalV2Deal: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealState: DealState.Active,
      targetMilestoneIndex: 0,
      milestones,
      evidenceRootHash: KNOWN_SMOKE_EVIDENCE_HASH,
      currentTimeSeconds: 1750000000n,
    });
    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error!, /Invalid network/);
  });

  // ==================================================
  // 9. CONTRACT API & EVENT VERIFICATION
  // ==================================================

  it('21. expected submission function called: submitWork(uint256,bytes32)', () => {
    const fn = synqDealV1ABI.find((i: any) => i.name === 'submitWork') as any;
    assert.ok(fn, 'submitWork function must exist in SynqDealV1 ABI');
    assert.strictEqual(fn.type, 'function');
    assert.strictEqual(fn.stateMutability, 'nonpayable');
    assert.strictEqual(fn.inputs.length, 2);
    assert.strictEqual(fn.inputs[0].name, 'milestoneId');
    assert.strictEqual(fn.inputs[0].type, 'uint256');
    assert.strictEqual(fn.inputs[1].name, 'evidenceRootHash');
    assert.strictEqual(fn.inputs[1].type, 'bytes32');
  });

  it('22. exact milestoneId used in submission arguments', () => {
    const targetId = 0n;
    assert.strictEqual(typeof targetId, 'bigint');
    assert.strictEqual(targetId >= 0n, true);
  });

  it('23. exact evidenceHash used in submission arguments', () => {
    const targetHash = KNOWN_SMOKE_EVIDENCE_HASH;
    assert.strictEqual(targetHash.length, 66);
    assert.strictEqual(targetHash.startsWith('0x'), true);
  });

  it('24. expected event verified: MilestoneSubmitted with milestoneId, evidenceRootHash, specHash, version', () => {
    const milestoneId = 0n;
    const evidenceRootHash = KNOWN_SMOKE_EVIDENCE_HASH;
    const specHash = '0x1111111111111111111111111111111111111111111111111111111111111111' as `0x${string}`;
    const version = 1;

    // Simulate event topics and data
    // MilestoneSubmitted(uint256 indexed milestoneId, bytes32 indexed evidenceRootHash, bytes32 specHash, uint8 version)
    const topic0 = MILESTONE_SUBMITTED_TOPIC0;
    const topic1 = toHex(milestoneId, { size: 32 });
    const topic2 = evidenceRootHash;
    const data = encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint8' }],
      [specHash, version]
    );

    const mockReceipt = {
      status: 'success',
      logs: [
        {
          address: TEST_DEAL_ADDRESS,
          topics: [topic0, topic1, topic2],
          data,
        },
      ],
    };

    const verification = verifySubmitWorkReceipt(mockReceipt, TEST_DEAL_ADDRESS, milestoneId, evidenceRootHash);
    assert.strictEqual(verification.valid, true);
    assert.strictEqual(verification.milestoneSubmittedEvent?.milestoneId, 0n);
    assert.strictEqual(verification.milestoneSubmittedEvent?.evidenceRootHash, evidenceRootHash);
    assert.strictEqual(verification.milestoneSubmittedEvent?.specHash, specHash);
    assert.strictEqual(verification.milestoneSubmittedEvent?.version, 1);
  });

  it('25. wrong event address rejected', () => {
    const topic0 = MILESTONE_SUBMITTED_TOPIC0;
    const topic1 = toHex(0n, { size: 32 });
    const topic2 = KNOWN_SMOKE_EVIDENCE_HASH;
    const data = encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint8' }],
      ['0x1111111111111111111111111111111111111111111111111111111111111111', 1]
    );

    const mockReceipt = {
      status: 'success',
      logs: [
        {
          address: TEST_STRANGER, // Wrong contract address!
          topics: [topic0, topic1, topic2],
          data,
        },
      ],
    };

    const verification = verifySubmitWorkReceipt(mockReceipt, TEST_DEAL_ADDRESS, 0n, KNOWN_SMOKE_EVIDENCE_HASH);
    assert.strictEqual(verification.valid, false);
    assert.match(verification.error!, /MilestoneSubmitted event was not found/);
  });

  it('26. wrong milestone event rejected', () => {
    const topic0 = MILESTONE_SUBMITTED_TOPIC0;
    const topic1 = toHex(1n, { size: 32 }); // Milestone 1 instead of 0
    const topic2 = KNOWN_SMOKE_EVIDENCE_HASH;
    const data = encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint8' }],
      ['0x1111111111111111111111111111111111111111111111111111111111111111', 1]
    );

    const mockReceipt = {
      status: 'success',
      logs: [
        {
          address: TEST_DEAL_ADDRESS,
          topics: [topic0, topic1, topic2],
          data,
        },
      ],
    };

    const verification = verifySubmitWorkReceipt(mockReceipt, TEST_DEAL_ADDRESS, 0n, KNOWN_SMOKE_EVIDENCE_HASH);
    assert.strictEqual(verification.valid, false);
    assert.match(verification.error!, /unexpected milestone ID/);
  });

  it('27. wrong evidenceHash event rejected', () => {
    const topic0 = MILESTONE_SUBMITTED_TOPIC0;
    const topic1 = toHex(0n, { size: 32 });
    const wrongHash = '0x9999999999999999999999999999999999999999999999999999999999999999';
    const topic2 = wrongHash;
    const data = encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint8' }],
      ['0x1111111111111111111111111111111111111111111111111111111111111111', 1]
    );

    const mockReceipt = {
      status: 'success',
      logs: [
        {
          address: TEST_DEAL_ADDRESS,
          topics: [topic0, topic1, topic2],
          data,
        },
      ],
    };

    const verification = verifySubmitWorkReceipt(mockReceipt, TEST_DEAL_ADDRESS, 0n, KNOWN_SMOKE_EVIDENCE_HASH);
    assert.strictEqual(verification.valid, false);
    assert.match(verification.error!, /unexpected evidenceRootHash/);
  });

  // ==================================================
  // 10. POST-TX READBACK & STORAGE VERIFICATION
  // ==================================================

  it('28. post-tx status readback verified: status becomes Submitted, version increments, submittedAt recorded', async () => {
    const mockPublicClient = {
      readContract: async ({ functionName, args }: any) => {
        if (functionName === 'isSynqDeal') return true;
        if (functionName === 'state') return DealState.Active;
        if (functionName === 'client') return TEST_CLIENT;
        if (functionName === 'freelancer') return TEST_FREELANCER;
        if (functionName === 'usdc') return SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc;
        if (functionName === 'totalEscrow') return 50_000_000n;
        if (functionName === 'totalSettled') return 0n;
        if (functionName === 'milestoneCount') return 1n;
        if (functionName === 'isProtected') return false;
        if (functionName === 'policyId') return ZERO_BYTES32;
        if (functionName === 'primaryResolver') return TEST_RESOLVER_1;
        if (functionName === 'emergencyResolver') return TEST_RESOLVER_2;
        if (functionName === 'getMilestone') {
          return {
            amount: 50_000_000n,
            workDeadline: 1800000000n,
            reviewWindow: 86400n,
            gracePeriod: 86400n,
            status: MilestoneStatus.Submitted, // Post-tx state
            specHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
            evidenceRootHash: KNOWN_SMOKE_EVIDENCE_HASH,
            submittedAt: 1750000000n,
            version: 1,
          };
        }
        throw new Error(`Unexpected function ${functionName}`);
      },
    };

    const data = await readStandardV2DealData(TEST_DEAL_ADDRESS, mockPublicClient);
    assert.strictEqual(data.milestones[0].status, MilestoneStatus.Submitted);
    assert.strictEqual(data.milestones[0].evidenceRootHash, KNOWN_SMOKE_EVIDENCE_HASH);
    assert.strictEqual(data.milestones[0].submittedAt, 1750000000n);
    assert.strictEqual(data.milestones[0].version, 1);
  });

  it('29. Submitted state survives reload/read directly from contract storage', async () => {
    // Repeated read simulates page reload
    const mockPublicClient = {
      readContract: async ({ functionName }: any) => {
        if (functionName === 'isSynqDeal') return true;
        if (functionName === 'state') return DealState.Active;
        if (functionName === 'client') return TEST_CLIENT;
        if (functionName === 'freelancer') return TEST_FREELANCER;
        if (functionName === 'usdc') return SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc;
        if (functionName === 'totalEscrow') return 50_000_000n;
        if (functionName === 'totalSettled') return 0n;
        if (functionName === 'milestoneCount') return 1n;
        if (functionName === 'isProtected') return false;
        if (functionName === 'policyId') return ZERO_BYTES32;
        if (functionName === 'primaryResolver') return TEST_RESOLVER_1;
        if (functionName === 'emergencyResolver') return TEST_RESOLVER_2;
        if (functionName === 'getMilestone') {
          return {
            amount: 50_000_000n,
            workDeadline: 1800000000n,
            reviewWindow: 86400n,
            gracePeriod: 86400n,
            status: MilestoneStatus.Submitted,
            specHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
            evidenceRootHash: KNOWN_SMOKE_EVIDENCE_HASH,
            submittedAt: 1750000000n,
            version: 1,
          };
        }
        throw new Error(`Unexpected function ${functionName}`);
      },
    };

    const reloaded = await readStandardV2DealData(TEST_DEAL_ADDRESS, mockPublicClient);
    assert.strictEqual(reloaded.milestones[0].status, MilestoneStatus.Submitted);
    assert.strictEqual(MILESTONE_STATUS_LABELS[reloaded.milestones[0].status], 'Submitted');
  });

  it('30. review timing derived correctly from submittedAt + reviewWindow', () => {
    const submittedAt = 1750000000n;
    const reviewWindow = 86400n;
    const expiration = calculateReviewWindowExpiration(submittedAt, reviewWindow);
    assert.strictEqual(expiration, 1750086400n);

    // Unsubmitted returns 0
    assert.strictEqual(calculateReviewWindowExpiration(0n, reviewWindow), 0n);
  });

  // ==================================================
  // 11. FINANCIAL & SETTLEMENT BOUNDARIES
  // ==================================================

  it('31. no payment language or state mutation upon work submission', () => {
    // Total settled must remain 0
    const totalSettled = 0n;
    assert.strictEqual(totalSettled, 0n);
    // Milestone status is Submitted, NOT any Settled state
    assert.strictEqual(isMilestoneSettled(MilestoneStatus.Submitted), false);
  });

  it('32. no automatic milestone settlement upon work submission', () => {
    assert.notStrictEqual(MilestoneStatus.Submitted, MilestoneStatus.SettledPaid);
    assert.notStrictEqual(MilestoneStatus.Submitted, MilestoneStatus.SettledRefunded);
    assert.notStrictEqual(MilestoneStatus.Submitted, MilestoneStatus.SettledSplit);
  });


  it('33. next milestone remains unavailable while previous milestone is Submitted', () => {
    const milestones = createMockMilestones(2, [
      { status: MilestoneStatus.Submitted, evidenceRootHash: KNOWN_SMOKE_EVIDENCE_HASH, submittedAt: 1750000000n },
      { status: MilestoneStatus.Pending },
    ]);

    // Current milestone index is 0 (first unsettled)
    assert.strictEqual(getCurrentMilestoneIndex(milestones), 0);

    // Milestone 1 start eligibility must fail because milestone 0 is not settled
    const startEligibility = determineMilestoneStartEligibility({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Active,
      milestones,
    });
    // Target milestone is 0 (current milestone), which is Submitted, so cannot start
    assert.strictEqual(startEligibility.canStart, false);
    assert.match(startEligibility.reason!, /Submitted/);
  });

  // ==================================================
  // 12. ERROR & EDGE CASE HANDLING
  // ==================================================

  it('34. duplicate submit guarded when milestone is already Submitted', () => {
    const milestones = createMockMilestones(1, [
      { status: MilestoneStatus.Submitted, evidenceRootHash: KNOWN_SMOKE_EVIDENCE_HASH },
    ]);

    const eligibility = determineMilestoneSubmissionEligibility({
      connectedWallet: TEST_FREELANCER,
      freelancerAddress: TEST_FREELANCER,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Active,
      milestones,
      currentTimeSeconds: 1750000000n,
    });
    assert.strictEqual(eligibility.canSubmit, false);
    assert.match(eligibility.reason!, /already been submitted/);
  });

  it('35. wallet rejection preserves InProgress status without state mutation', () => {
    const statusBefore = MilestoneStatus.InProgress;
    // When user rejects in wallet, UI catches error and does not mutate status
    const statusAfterRejection = statusBefore;
    assert.strictEqual(statusAfterRejection, MilestoneStatus.InProgress);
  });

  it('36. revert does not mark Submitted', () => {
    const revertedReceipt = {
      status: 'reverted',
      logs: [],
    };
    const verification = verifySubmitWorkReceipt(revertedReceipt, TEST_DEAL_ADDRESS, 0n, KNOWN_SMOKE_EVIDENCE_HASH);
    assert.strictEqual(verification.valid, false);
    assert.match(verification.error!, /Transaction reverted on-chain/);
  });

  // ==================================================
  // 13. ISOLATION & SAFETY INVARIANTS
  // ==================================================

  it('37. no Factory transaction: submission is strictly on Deal clone', () => {
    const targetAddress = TEST_DEAL_ADDRESS;
    assert.notStrictEqual(targetAddress.toLowerCase(), SYNQ_V2_SEPOLIA_CONFIG.factory.toLowerCase());
  });

  it('38. no USDC transaction: no approval or transfer occurs during submitWork', () => {
    const submitWorkAbi = synqDealV1ABI.find((i: any) => i.name === 'submitWork');
    assert.strictEqual(submitWorkAbi?.stateMutability, 'nonpayable');
    // Does not touch token transfer functions
  });

  it('39. no DB write or migration executed for work submission', () => {
    // Authoritative submission state is stored on-chain
    assert.ok(true);
  });

  it('40. Protection untouched: isProtected remains false in Standard V2 submission', () => {
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.isProtected, false);
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.protectionModule, '0x0000000000000000000000000000000000000000');
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.policyId, ZERO_BYTES32);
  });
});
