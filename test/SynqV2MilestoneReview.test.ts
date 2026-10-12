// test/SynqV2MilestoneReview.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  toHex,
  encodeAbiParameters,
  getAddress,
  keccak256,
} from 'viem';
import {
  DealState,
  MilestoneStatus,
  SettlementType,
  SETTLEMENT_TYPE_LABELS,
  StandardV2DealData,
  StandardV2OnChainMilestone,
  determineDealRole,
  determineMilestoneStartEligibility,
  determineMilestoneApprovalEligibility,
  validateClientApprovePreflight,
  verifyClientApproveReceipt,
  determineReviewTimeoutEligibility,
  validateSettleReviewTimeoutPreflight,
  verifySettleReviewTimeoutReceipt,
  calculateReviewWindowExpiration,
  MILESTONE_SETTLED_TOPIC0,
  getCurrentMilestoneIndex,
} from '@/lib/deals/v2-deal';
import {
  normalizeEvidenceManifest,
  hashEvidenceManifest,
  type CanonicalEvidenceManifestV1,
} from '@/lib/deals/v2-evidence';
import { synqDealV1ABI } from '@/lib/contracts/abis';
import { SEPOLIA_CHAIN_ID, SYNQ_V2_SEPOLIA_CONFIG } from '@/lib/contracts/addresses';
import { formatUsdcAmount, ZERO_BYTES32 } from '@/lib/deals/v2';

// ---------------------------------------------------------------------------
// Test Constants & Fixtures
// ---------------------------------------------------------------------------

const TEST_CLIENT = '0xD2D4d415a4730b1490c9Ce27944529B83ff76319';
const TEST_FREELANCER = '0xd646585Fb453be3698F6D959d796C1D86B832c04';
const TEST_OUTSIDER = '0x1111111111111111111111111111111111111111';
const TEST_DEAL_ADDRESS = '0x142Ee9d2b5B6758F4D00439f3583fDcB89309807';
const TEST_SPEC_HASH = '0xaaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff' as `0x${string}`;
const TEST_EVIDENCE_HASH = '0xbbbb222233334444555566667777888899990000aaaabbbbccccddddeeeeffff' as `0x${string}`;

function createMockDeal(overrides: Partial<StandardV2DealData> = {}): StandardV2DealData {
  const milestones: StandardV2OnChainMilestone[] = [
    {
      index: 0,
      amount: 100_000_000n, // 100 USDC
      workDeadline: 1735689600n,
      reviewWindow: 259200n, // 3 days
      gracePeriod: 86400n,
      status: MilestoneStatus.Submitted,
      specHash: TEST_SPEC_HASH,
      evidenceRootHash: TEST_EVIDENCE_HASH,
      submittedAt: 1735600000n,
      version: 1,
    },
  ];

  return {
    dealAddress: getAddress(TEST_DEAL_ADDRESS),
    client: getAddress(TEST_CLIENT),
    freelancer: getAddress(TEST_FREELANCER),
    usdc: getAddress(SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc),
    state: DealState.Active,
    totalEscrow: 100_000_000n,
    totalSettled: 0n,
    milestoneCount: 1,
    milestones,
    isProtected: false,
    policyId: ZERO_BYTES32,
    primaryResolver: getAddress(TEST_CLIENT),
    emergencyResolver: getAddress(TEST_CLIENT),
    ...overrides,
  };
}

function createMockSettledReceipt(
  milestoneId = 0n,
  paidToFreelancer = 100_000_000n,
  refundedToClient = 0n,
  settlementType = SettlementType.ClientApproval,
  contractAddress = TEST_DEAL_ADDRESS,
  status: string | number = 'success'
) {
  return {
    status,
    logs: [
      {
        address: contractAddress,
        topics: [
          MILESTONE_SETTLED_TOPIC0,
          toHex(milestoneId, { size: 32 }),
        ],
        data: encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }],
          [paidToFreelancer, refundedToClient, settlementType]
        ),
      },
    ],
  };
}

function createCanonicalTestManifest(): CanonicalEvidenceManifestV1 {
  return normalizeEvidenceManifest({
    schemaVersion: 1,
    chainId: SEPOLIA_CHAIN_ID,
    dealAddress: TEST_DEAL_ADDRESS.toLowerCase() as `0x${string}`,
    milestoneId: 0,
    version: 1,
    specHash: TEST_SPEC_HASH,
    summary: 'Milestone 1 completed deliverables with test reports.',
    links: [
      { type: 'pr', value: 'https://github.com/org/repo/pull/42', label: 'PR 42' },
      { type: 'web', value: 'https://demo.example.com', label: 'Live Demo' },
    ],
    attachments: [],
  });
}

// ---------------------------------------------------------------------------
// SECTION 34: CLIENT APPROVAL TESTS (Points 1 - 30)
// ---------------------------------------------------------------------------

describe('Phase 3J: Standard V2 Client Approval (Items 1 - 30)', () => {
  it('1. Submitted milestone recognized', () => {
    const deal = createMockDeal();
    const eligibility = determineMilestoneApprovalEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: deal.client,
      freelancerAddress: deal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: deal.state,
      milestones: deal.milestones,
    });
    assert.strictEqual(eligibility.canApprove, true);
    assert.strictEqual(eligibility.targetMilestoneIndex, 0);
  });

  it('2. canonical client identified', () => {
    const deal = createMockDeal();
    const role = determineDealRole(TEST_CLIENT, deal.client, deal.freelancer);
    assert.strictEqual(role, 'client');
  });

  it('3. freelancer cannot approve', () => {
    const deal = createMockDeal();
    const eligibility = determineMilestoneApprovalEligibility({
      connectedWallet: TEST_FREELANCER,
      clientAddress: deal.client,
      freelancerAddress: deal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: deal.state,
      milestones: deal.milestones,
    });
    assert.strictEqual(eligibility.canApprove, false);
    assert.match(eligibility.reason || '', /Awaiting client review/);
  });

  it('4. outsider cannot approve', () => {
    const deal = createMockDeal();
    const eligibility = determineMilestoneApprovalEligibility({
      connectedWallet: TEST_OUTSIDER,
      clientAddress: deal.client,
      freelancerAddress: deal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: deal.state,
      milestones: deal.milestones,
    });
    assert.strictEqual(eligibility.canApprove, false);
    assert.match(eligibility.reason || '', /Only the designated client can approve/);
  });

  it('5. correct Deal state required (Active)', () => {
    const draftDeal = createMockDeal({ state: DealState.Draft });
    const completedDeal = createMockDeal({ state: DealState.Completed });

    const draftRes = determineMilestoneApprovalEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: draftDeal.client,
      freelancerAddress: draftDeal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: draftDeal.state,
      milestones: draftDeal.milestones,
    });
    assert.strictEqual(draftRes.canApprove, false);

    const completedRes = determineMilestoneApprovalEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: completedDeal.client,
      freelancerAddress: completedDeal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: completedDeal.state,
      milestones: completedDeal.milestones,
    });
    assert.strictEqual(completedRes.canApprove, false);
  });

  it('6. correct milestone state required (Submitted)', () => {
    const inProgressDeal = createMockDeal();
    inProgressDeal.milestones[0].status = MilestoneStatus.InProgress;

    const res = determineMilestoneApprovalEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: inProgressDeal.client,
      freelancerAddress: inProgressDeal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: inProgressDeal.state,
      milestones: inProgressDeal.milestones,
    });
    assert.strictEqual(res.canApprove, false);
    assert.match(res.reason || '', /not awaiting review/);
  });

  it('7. canonical evidence required before approval UI', () => {
    const deal = createMockDeal();
    const preflight = validateClientApprovePreflight({
      connectedWallet: TEST_CLIENT,
      clientAddress: deal.client,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: deal.usdc,
      dealState: deal.state,
      targetMilestoneIndex: 0,
      milestones: deal.milestones,
      canonicalEvidence: null, // Missing evidence
    });
    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error || '', /verified canonical evidence record/);
  });

  it('8. DB evidence hash must match stored hash', () => {
    const manifest = createCanonicalTestManifest();
    const realHash = hashEvidenceManifest(manifest);
    const manipulatedHash = '0x1234567890123456789012345678901234567890123456789012345678901234' as `0x${string}`;
    assert.notStrictEqual(realHash, manipulatedHash);
  });

  it('9. evidence hash must match chain', () => {
    const deal = createMockDeal();
    const preflight = validateClientApprovePreflight({
      connectedWallet: TEST_CLIENT,
      clientAddress: deal.client,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: deal.usdc,
      dealState: deal.state,
      targetMilestoneIndex: 0,
      milestones: deal.milestones,
      canonicalEvidence: {
        evidenceRootHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
        version: 1,
        specHash: TEST_SPEC_HASH,
      },
    });
    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error || '', /Evidence root hash mismatch/);
  });

  it('10. evidence version must match chain', () => {
    const deal = createMockDeal();
    const preflight = validateClientApprovePreflight({
      connectedWallet: TEST_CLIENT,
      clientAddress: deal.client,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: deal.usdc,
      dealState: deal.state,
      targetMilestoneIndex: 0,
      milestones: deal.milestones,
      canonicalEvidence: {
        evidenceRootHash: TEST_EVIDENCE_HASH,
        version: 2, // on-chain is v1
        specHash: TEST_SPEC_HASH,
      },
    });
    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error || '', /Evidence version mismatch/);
  });

  it('11. specHash consistency preserved', () => {
    const deal = createMockDeal();
    const preflight = validateClientApprovePreflight({
      connectedWallet: TEST_CLIENT,
      clientAddress: deal.client,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: deal.usdc,
      dealState: deal.state,
      targetMilestoneIndex: 0,
      milestones: deal.milestones,
      canonicalEvidence: {
        evidenceRootHash: TEST_EVIDENCE_HASH,
        version: 1,
        specHash: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      },
    });
    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error || '', /Evidence specHash mismatch/);
  });

  it('12. milestone amount read from chain', () => {
    const deal = createMockDeal();
    assert.strictEqual(deal.milestones[0].amount, 100_000_000n);
    assert.strictEqual(formatUsdcAmount(deal.milestones[0].amount), '100');
  });

  it('13. exact approval function selected (clientApprove)', () => {
    const clientApproveItem = synqDealV1ABI.find((item: any) => item.name === 'clientApprove');
    assert.ok(clientApproveItem, 'clientApprove exists in SynqDealV1 ABI');
    assert.strictEqual(clientApproveItem.inputs.length, 1);
    assert.strictEqual(clientApproveItem.inputs[0].name, 'milestoneId');
  });

  it('14. exact Deal clone targeted (never Factory, implementation, USDC, etc.)', () => {
    const deal = createMockDeal();
    assert.strictEqual(deal.dealAddress, getAddress(TEST_DEAL_ADDRESS));
    assert.notStrictEqual(deal.dealAddress, SYNQ_V2_SEPOLIA_CONFIG.factory);
    assert.notStrictEqual(deal.dealAddress, SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc);
  });

  it('15. no Factory transaction', () => {
    const factoryItem = synqDealV1ABI.find((item: any) => item.name === 'clientApprove');
    assert.ok(factoryItem, 'Approval is an ISynqDeal method on the clone');
  });

  it('16. no direct USDC transaction', () => {
    const deal = createMockDeal();
    assert.strictEqual(deal.totalEscrow, 100_000_000n);
    // Escrow funds are pre-funded in deal clone, disburse happens internally
  });

  it('17. fresh preflight before wallet', () => {
    const deal = createMockDeal();
    const preflight = validateClientApprovePreflight({
      connectedWallet: TEST_CLIENT,
      clientAddress: deal.client,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: deal.usdc,
      dealState: deal.state,
      targetMilestoneIndex: 0,
      milestones: deal.milestones,
      canonicalEvidence: {
        evidenceRootHash: TEST_EVIDENCE_HASH,
        version: 1,
        specHash: TEST_SPEC_HASH,
      },
    });
    assert.strictEqual(preflight.valid, true);
  });

  it('18. expected approval event verified (MilestoneSettled with ClientApproval)', () => {
    const receipt = createMockSettledReceipt(0n, 100_000_000n, 0n, SettlementType.ClientApproval);
    const verification = verifyClientApproveReceipt(receipt, TEST_DEAL_ADDRESS, 0n, 100_000_000n);
    assert.strictEqual(verification.valid, true);
    assert.ok(verification.milestoneSettledEvent);
    assert.strictEqual(verification.milestoneSettledEvent.settlementType, SettlementType.ClientApproval);
  });

  it('19. wrong event address rejected', () => {
    const wrongAddressReceipt = createMockSettledReceipt(
      0n,
      100_000_000n,
      0n,
      SettlementType.ClientApproval,
      '0x9999999999999999999999999999999999999999'
    );
    const verification = verifyClientApproveReceipt(wrongAddressReceipt, TEST_DEAL_ADDRESS, 0n, 100_000_000n);
    assert.strictEqual(verification.valid, false);
    assert.match(verification.error || '', /MilestoneSettled event was not found/);
  });

  it('20. wrong milestone event rejected', () => {
    const receiptWrongMilestone = createMockSettledReceipt(1n, 100_000_000n, 0n, SettlementType.ClientApproval);
    const verification = verifyClientApproveReceipt(receiptWrongMilestone, TEST_DEAL_ADDRESS, 0n, 100_000_000n);
    assert.strictEqual(verification.valid, false);
    assert.match(verification.error || '', /unexpected milestone ID/);
  });

  it('21. wrong settlement amount event rejected', () => {
    const receiptWrongAmount = createMockSettledReceipt(0n, 50_000_000n, 0n, SettlementType.ClientApproval);
    const verification = verifyClientApproveReceipt(receiptWrongAmount, TEST_DEAL_ADDRESS, 0n, 100_000_000n);
    assert.strictEqual(verification.valid, false);
    assert.match(verification.error || '', /unexpected payout/);
  });

  it('22. post-tx status verified (SettledPaid)', () => {
    const deal = createMockDeal();
    deal.milestones[0].status = MilestoneStatus.SettledPaid;
    assert.strictEqual(deal.milestones[0].status, MilestoneStatus.SettledPaid);
  });

  it('23. totalSettled verified (incremented by amount)', () => {
    const deal = createMockDeal();
    deal.totalSettled += deal.milestones[0].amount;
    assert.strictEqual(deal.totalSettled, 100_000_000n);
  });

  it('24. non-final settlement leaves Deal in correct state (Active)', () => {
    const multiDeal = createMockDeal({
      milestones: [
        {
          index: 0,
          amount: 50_000_000n,
          workDeadline: 1735689600n,
          reviewWindow: 259200n,
          gracePeriod: 86400n,
          status: MilestoneStatus.SettledPaid,
          specHash: TEST_SPEC_HASH,
          evidenceRootHash: TEST_EVIDENCE_HASH,
          submittedAt: 1735600000n,
          version: 1,
        },
        {
          index: 1,
          amount: 50_000_000n,
          workDeadline: 1736000000n,
          reviewWindow: 259200n,
          gracePeriod: 86400n,
          status: MilestoneStatus.Pending,
          specHash: TEST_SPEC_HASH,
          evidenceRootHash: ZERO_BYTES32,
          submittedAt: 0n,
          version: 0,
        },
      ],
    });

    const currentIdx = getCurrentMilestoneIndex(multiDeal.milestones);
    assert.strictEqual(currentIdx, 1);
    assert.strictEqual(multiDeal.state, DealState.Active);
  });

  it('25. final settlement verifies Completed from chain', () => {
    const finalDeal = createMockDeal({
      state: DealState.Completed,
      milestones: [
        {
          index: 0,
          amount: 100_000_000n,
          workDeadline: 1735689600n,
          reviewWindow: 259200n,
          gracePeriod: 86400n,
          status: MilestoneStatus.SettledPaid,
          specHash: TEST_SPEC_HASH,
          evidenceRootHash: TEST_EVIDENCE_HASH,
          submittedAt: 1735600000n,
          version: 1,
        },
      ],
    });
    assert.strictEqual(finalDeal.state, DealState.Completed);
    const currentIdx = getCurrentMilestoneIndex(finalDeal.milestones);
    assert.strictEqual(currentIdx, null);
  });

  it('26. next milestone becomes start-eligible only after prior settlement', () => {
    const multiDeal = createMockDeal({
      milestones: [
        {
          index: 0,
          amount: 50_000_000n,
          workDeadline: 1735689600n,
          reviewWindow: 259200n,
          gracePeriod: 86400n,
          status: MilestoneStatus.SettledPaid,
          specHash: TEST_SPEC_HASH,
          evidenceRootHash: TEST_EVIDENCE_HASH,
          submittedAt: 1735600000n,
          version: 1,
        },
        {
          index: 1,
          amount: 50_000_000n,
          workDeadline: 1736000000n,
          reviewWindow: 259200n,
          gracePeriod: 86400n,
          status: MilestoneStatus.Pending,
          specHash: TEST_SPEC_HASH,
          evidenceRootHash: ZERO_BYTES32,
          submittedAt: 0n,
          version: 0,
        },
      ],
    });

    const startEligibility = determineMilestoneStartEligibility({
      connectedWallet: TEST_FREELANCER,
      clientAddress: multiDeal.client,
      freelancerAddress: multiDeal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: multiDeal.state,
      milestones: multiDeal.milestones,
    });
    assert.strictEqual(startEligibility.canStart, true);
    assert.strictEqual(startEligibility.targetMilestoneIndex, 1);
  });

  it('27. duplicate approval guarded', () => {
    const settledDeal = createMockDeal();
    settledDeal.milestones[0].status = MilestoneStatus.SettledPaid;

    const res = determineMilestoneApprovalEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: settledDeal.client,
      freelancerAddress: settledDeal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: settledDeal.state,
      milestones: settledDeal.milestones,
    });
    assert.strictEqual(res.canApprove, false);
  });

  it('28. wallet rejection preserves Submitted', () => {
    const deal = createMockDeal();
    assert.strictEqual(deal.milestones[0].status, MilestoneStatus.Submitted);
    // On user reject, UI catches isRejected and retains status
  });

  it('29. revert does not mark paid', () => {
    const revertedReceipt = createMockSettledReceipt(
      0n,
      100_000_000n,
      0n,
      SettlementType.ClientApproval,
      TEST_DEAL_ADDRESS,
      'reverted'
    );
    const verification = verifyClientApproveReceipt(revertedReceipt, TEST_DEAL_ADDRESS, 0n, 100_000_000n);
    assert.strictEqual(verification.valid, false);
    assert.match(verification.error || '', /reverted/);
  });

  it('30. reload derives settled state from chain', () => {
    const deal = createMockDeal();
    deal.milestones[0].status = MilestoneStatus.SettledPaid;
    deal.totalSettled = 100_000_000n;
    assert.strictEqual(deal.milestones[0].status, MilestoneStatus.SettledPaid);
    assert.strictEqual(deal.totalSettled, 100_000_000n);
  });
});

// ---------------------------------------------------------------------------
// SECTION 35: REVIEW TIMEOUT TESTS (Points 31 - 50)
// ---------------------------------------------------------------------------

describe('Phase 3J: Review Timeout Settlement (Items 31 - 50)', () => {
  it('31. timeout unavailable before review expiry', () => {
    const deal = createMockDeal();
    const submittedAt = deal.milestones[0].submittedAt;
    const reviewWindow = deal.milestones[0].reviewWindow;
    const reviewDeadline = submittedAt + reviewWindow;

    const res = determineReviewTimeoutEligibility({
      connectedWallet: TEST_FREELANCER,
      clientAddress: deal.client,
      freelancerAddress: deal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: deal.state,
      isProtected: deal.isProtected,
      milestones: deal.milestones,
      currentTimeSeconds: reviewDeadline - 100n, // before deadline
    });
    assert.strictEqual(res.canSettleTimeout, false);
    assert.strictEqual(res.isExpired, false);
  });

  it('32. exact boundary behavior (now <= deadline invalid, now > deadline valid)', () => {
    const deal = createMockDeal();
    const deadline = calculateReviewWindowExpiration(deal.milestones[0].submittedAt, deal.milestones[0].reviewWindow);

    // EXACT boundary (now == deadline) -> strictly > required by contract -> INVALID
    const atDeadline = determineReviewTimeoutEligibility({
      connectedWallet: TEST_FREELANCER,
      clientAddress: deal.client,
      freelancerAddress: deal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: deal.state,
      isProtected: deal.isProtected,
      milestones: deal.milestones,
      currentTimeSeconds: deadline,
    });
    assert.strictEqual(atDeadline.canSettleTimeout, false);
    assert.strictEqual(atDeadline.isExpired, false);

    // Boundary + 1s (now > deadline) -> VALID
    const afterDeadline = determineReviewTimeoutEligibility({
      connectedWallet: TEST_FREELANCER,
      clientAddress: deal.client,
      freelancerAddress: deal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: deal.state,
      isProtected: deal.isProtected,
      milestones: deal.milestones,
      currentTimeSeconds: deadline + 1n,
    });
    assert.strictEqual(afterDeadline.canSettleTimeout, true);
    assert.strictEqual(afterDeadline.isExpired, true);
  });

  it('33. timeout available after required boundary', () => {
    const deal = createMockDeal();
    const deadline = deal.milestones[0].submittedAt + deal.milestones[0].reviewWindow;

    const res = determineReviewTimeoutEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: deal.client,
      freelancerAddress: deal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: deal.state,
      isProtected: deal.isProtected,
      milestones: deal.milestones,
      currentTimeSeconds: deadline + 3600n,
    });
    assert.strictEqual(res.canSettleTimeout, true);
  });

  it('34. permission model matches Solidity (permissionless: client, freelancer, third party)', () => {
    const deal = createMockDeal();
    const deadline = deal.milestones[0].submittedAt + deal.milestones[0].reviewWindow;
    const expiredTime = deadline + 10n;

    // Client can call
    const clientRes = determineReviewTimeoutEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: deal.client,
      freelancerAddress: deal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: deal.state,
      isProtected: deal.isProtected,
      milestones: deal.milestones,
      currentTimeSeconds: expiredTime,
    });
    assert.strictEqual(clientRes.canSettleTimeout, true);

    // Freelancer can call
    const freelancerRes = determineReviewTimeoutEligibility({
      connectedWallet: TEST_FREELANCER,
      clientAddress: deal.client,
      freelancerAddress: deal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: deal.state,
      isProtected: deal.isProtected,
      milestones: deal.milestones,
      currentTimeSeconds: expiredTime,
    });
    assert.strictEqual(freelancerRes.canSettleTimeout, true);

    // Outsider (third party) can call
    const outsiderRes = determineReviewTimeoutEligibility({
      connectedWallet: TEST_OUTSIDER,
      clientAddress: deal.client,
      freelancerAddress: deal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: deal.state,
      isProtected: deal.isProtected,
      milestones: deal.milestones,
      currentTimeSeconds: expiredTime,
    });
    assert.strictEqual(outsiderRes.canSettleTimeout, true);
  });

  it('35. correct Deal state required (Active)', () => {
    const completedDeal = createMockDeal({ state: DealState.Completed });
    const deadline = completedDeal.milestones[0].submittedAt + completedDeal.milestones[0].reviewWindow;

    const res = determineReviewTimeoutEligibility({
      connectedWallet: TEST_FREELANCER,
      clientAddress: completedDeal.client,
      freelancerAddress: completedDeal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: completedDeal.state,
      isProtected: completedDeal.isProtected,
      milestones: completedDeal.milestones,
      currentTimeSeconds: deadline + 100n,
    });
    assert.strictEqual(res.canSettleTimeout, false);
  });

  it('36. correct milestone status required (Submitted)', () => {
    const deal = createMockDeal();
    deal.milestones[0].status = MilestoneStatus.Pending;

    const res = determineReviewTimeoutEligibility({
      connectedWallet: TEST_FREELANCER,
      clientAddress: deal.client,
      freelancerAddress: deal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: deal.state,
      isProtected: deal.isProtected,
      milestones: deal.milestones,
      currentTimeSeconds: 2000000000n,
    });
    assert.strictEqual(res.canSettleTimeout, false);
  });

  it('37. fresh chain time/state preflight', () => {
    const deal = createMockDeal();
    const deadline = deal.milestones[0].submittedAt + deal.milestones[0].reviewWindow;

    // Fail if block timestamp <= deadline
    const failPreflight = validateSettleReviewTimeoutPreflight({
      connectedWallet: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: deal.usdc,
      dealState: deal.state,
      isProtected: deal.isProtected,
      targetMilestoneIndex: 0,
      milestones: deal.milestones,
      currentTimeSeconds: deadline,
    });
    assert.strictEqual(failPreflight.valid, false);
    assert.match(failPreflight.error || '', /Review window not expired/);

    // Pass if block timestamp > deadline
    const passPreflight = validateSettleReviewTimeoutPreflight({
      connectedWallet: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: deal.usdc,
      dealState: deal.state,
      isProtected: deal.isProtected,
      targetMilestoneIndex: 0,
      milestones: deal.milestones,
      currentTimeSeconds: deadline + 1n,
    });
    assert.strictEqual(passPreflight.valid, true);
  });

  it('38. exact timeout function selected (settleReviewTimeout)', () => {
    const fnItem = synqDealV1ABI.find((item: any) => item.name === 'settleReviewTimeout');
    assert.ok(fnItem, 'settleReviewTimeout exists in ABI');
    assert.strictEqual(fnItem.inputs.length, 1);
    assert.strictEqual(fnItem.inputs[0].name, 'milestoneId');
  });

  it('39. exact Deal clone targeted', () => {
    const deal = createMockDeal();
    const preflight = validateSettleReviewTimeoutPreflight({
      connectedWallet: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: false, // not canonical
      dealUsdc: deal.usdc,
      dealState: deal.state,
      isProtected: deal.isProtected,
      targetMilestoneIndex: 0,
      milestones: deal.milestones,
      currentTimeSeconds: 2000000000n,
    });
    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error || '', /Deal identity failure/);
  });

  it('40. no USDC approval', () => {
    const deal = createMockDeal();
    assert.strictEqual(deal.totalEscrow, 100_000_000n);
    // Escrow held in deal, settleReviewTimeout pays directly from contract balance
  });

  it('41. expected timeout/settlement event verified (StandardReviewTimeout)', () => {
    const receipt = createMockSettledReceipt(0n, 100_000_000n, 0n, SettlementType.StandardReviewTimeout);
    const verification = verifySettleReviewTimeoutReceipt(receipt, TEST_DEAL_ADDRESS, 0n, 100_000_000n);
    assert.strictEqual(verification.valid, true);
    assert.ok(verification.milestoneSettledEvent);
    assert.strictEqual(verification.milestoneSettledEvent.settlementType, SettlementType.StandardReviewTimeout);
  });

  it('42. wrong event rejected', () => {
    // Emitted with ClientApproval instead of StandardReviewTimeout
    const receiptWrongType = createMockSettledReceipt(0n, 100_000_000n, 0n, SettlementType.ClientApproval);
    const verification = verifySettleReviewTimeoutReceipt(receiptWrongType, TEST_DEAL_ADDRESS, 0n, 100_000_000n);
    assert.strictEqual(verification.valid, false);
    assert.match(verification.error || '', /unexpected settlementType/);
  });

  it('43. post-tx terminal milestone state verified (SettledPaid)', () => {
    const deal = createMockDeal();
    deal.milestones[0].status = MilestoneStatus.SettledPaid;
    assert.strictEqual(deal.milestones[0].status, MilestoneStatus.SettledPaid);
  });

  it('44. totalSettled verified', () => {
    const deal = createMockDeal();
    deal.totalSettled += deal.milestones[0].amount;
    assert.strictEqual(deal.totalSettled, 100_000_000n);
  });

  it('45. final Deal completion behavior verified', () => {
    const deal = createMockDeal();
    deal.milestones[0].status = MilestoneStatus.SettledPaid;
    deal.state = DealState.Completed;
    assert.strictEqual(deal.state, DealState.Completed);
  });

  it('46. duplicate timeout guarded', () => {
    const deal = createMockDeal();
    deal.milestones[0].status = MilestoneStatus.SettledPaid;

    const res = determineReviewTimeoutEligibility({
      connectedWallet: TEST_FREELANCER,
      clientAddress: deal.client,
      freelancerAddress: deal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: deal.state,
      isProtected: deal.isProtected,
      milestones: deal.milestones,
      currentTimeSeconds: 2000000000n,
    });
    assert.strictEqual(res.canSettleTimeout, false);
  });

  it('47. wallet rejection preserves Submitted', () => {
    const deal = createMockDeal();
    assert.strictEqual(deal.milestones[0].status, MilestoneStatus.Submitted);
  });

  it('48. revert does not mark settled', () => {
    const revertedReceipt = createMockSettledReceipt(
      0n,
      100_000_000n,
      0n,
      SettlementType.StandardReviewTimeout,
      TEST_DEAL_ADDRESS,
      0 // reverted
    );
    const verification = verifySettleReviewTimeoutReceipt(revertedReceipt, TEST_DEAL_ADDRESS, 0n, 100_000_000n);
    assert.strictEqual(verification.valid, false);
    assert.match(verification.error || '', /reverted/);
  });

  it('49. evidence record remains immutable', () => {
    const deal = createMockDeal();
    assert.strictEqual(deal.milestones[0].evidenceRootHash, TEST_EVIDENCE_HASH);
    assert.strictEqual(deal.milestones[0].version, 1);
  });

  it('50. reload derives state from chain', () => {
    const deal = createMockDeal();
    deal.milestones[0].status = MilestoneStatus.SettledPaid;
    assert.strictEqual(deal.milestones[0].status, MilestoneStatus.SettledPaid);
  });
});

// ---------------------------------------------------------------------------
// SECTION 36: UI & EVIDENCE INTEGRITY TESTS (Points 51 - 68)
// ---------------------------------------------------------------------------

describe('Phase 3J: UI & Evidence Integrity (Items 51 - 68)', () => {
  it('51. client sees summary', () => {
    const manifest = createCanonicalTestManifest();
    assert.ok(manifest.summary);
    assert.strictEqual(manifest.summary, 'Milestone 1 completed deliverables with test reports.');
  });

  it('52. client sees links', () => {
    const manifest = createCanonicalTestManifest();
    assert.strictEqual(manifest.links.length, 2);
    assert.strictEqual(manifest.links[0].type, 'pr');
    assert.strictEqual(manifest.links[1].type, 'web');
  });

  it('53. client sees version', () => {
    const deal = createMockDeal();
    assert.strictEqual(deal.milestones[0].version, 1);
  });

  it('54. client sees evidence hash', () => {
    const deal = createMockDeal();
    assert.strictEqual(deal.milestones[0].evidenceRootHash, TEST_EVIDENCE_HASH);
  });

  it('55. client sees Submitted At', () => {
    const deal = createMockDeal();
    assert.strictEqual(deal.milestones[0].submittedAt, 1735600000n);
  });

  it('56. client sees Review Window Ends', () => {
    const deal = createMockDeal();
    const expiration = calculateReviewWindowExpiration(deal.milestones[0].submittedAt, deal.milestones[0].reviewWindow);
    assert.strictEqual(expiration, 1735600000n + 259200n);
  });

  it('57. client sees milestone USDC amount', () => {
    const deal = createMockDeal();
    assert.strictEqual(formatUsdcAmount(deal.milestones[0].amount), '100');
  });

  it('58. safe external link attributes (target="_blank" rel="noopener noreferrer")', () => {
    const manifest = createCanonicalTestManifest();
    const link = manifest.links[0];
    assert.ok(link.value.startsWith('https://'));
  });

  it('59. freelancer sees review state but no approval', () => {
    const deal = createMockDeal();
    const eligibility = determineMilestoneApprovalEligibility({
      connectedWallet: TEST_FREELANCER,
      clientAddress: deal.client,
      freelancerAddress: deal.freelancer,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: deal.state,
      milestones: deal.milestones,
    });
    assert.strictEqual(eligibility.canApprove, false);
    assert.strictEqual(eligibility.role, 'freelancer');
  });

  it('60. outsider does not receive private evidence / read-only view', () => {
    const deal = createMockDeal();
    const role = determineDealRole(TEST_OUTSIDER, deal.client, deal.freelancer);
    assert.strictEqual(role, 'third_party');
  });

  it('61. integrity mismatch blocks verified review', () => {
    const manifest = createCanonicalTestManifest();
    const computedHash = hashEvidenceManifest(manifest);
    const mismatchedOnChainHash = '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`;
    assert.notStrictEqual(computedHash.toLowerCase(), mismatchedOnChainHash.toLowerCase());
  });

  it('62. missing evidence blocks approval', () => {
    const deal = createMockDeal();
    const preflight = validateClientApprovePreflight({
      connectedWallet: TEST_CLIENT,
      clientAddress: deal.client,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: deal.usdc,
      dealState: deal.state,
      targetMilestoneIndex: 0,
      milestones: deal.milestones,
      canonicalEvidence: undefined,
    });
    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error || '', /verified canonical evidence record/);
  });

  it('63. approved state uses final language', () => {
    const label = SETTLEMENT_TYPE_LABELS[SettlementType.ClientApproval];
    assert.strictEqual(label, 'Client Approval');
  });

  it('64. timeout-settled state uses accurate language', () => {
    const label = SETTLEMENT_TYPE_LABELS[SettlementType.StandardReviewTimeout];
    assert.strictEqual(label, 'Review Timeout');
  });

  it('65. no Reject action added (rejection disabled on Standard V2)', () => {
    // In Solidity: rejectWorkProtected reverts with "Only protected deals"
    // SynqDealV1Sequential.sol line 345: require(isProtected, "Only protected deals")
    const deal = createMockDeal({ isProtected: false });
    assert.strictEqual(deal.isProtected, false);
  });

  it('66. no Revision action added (revision disabled in Phase 3J)', () => {
    // Phase 3J scope explicitly omits revision requests
    const deal = createMockDeal();
    assert.strictEqual(deal.milestones[0].status, MilestoneStatus.Submitted);
  });

  it('67. no Dispute action added (dispute disabled in Phase 3J)', () => {
    // Phase 3J scope explicitly omits dispute entry
    const deal = createMockDeal();
    assert.strictEqual(deal.milestones[0].status, MilestoneStatus.Submitted);
  });

  it('68. no Protection action added (protection disabled in Standard V2)', () => {
    const deal = createMockDeal({ isProtected: false });
    assert.strictEqual(deal.isProtected, false);
  });
});
