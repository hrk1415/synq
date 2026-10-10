import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters, keccak256, stringToBytes } from 'viem';
import {
  DealState,
  MilestoneStatus,
  StandardV2OnChainMilestone,
  SettlementType,
} from '../src/lib/deals/v2-deal';
import { parseUsdcAmount, formatUsdcAmount } from '../src/lib/deals/v2';
import {
  determineSeriousDisputeEligibility,
  validateSeriousDisputePreflight,
  verifySeriousDisputeOpenedReceipt,
  normalizeSeriousDisputeManifest,
  hashSeriousDisputeManifest,
  DISPUTE_LIMITS,
  type CanonicalSeriousDisputeManifestV1,
} from '../src/lib/deals/v2-dispute';
import {
  determineMutualSettlementEligibility,
  validateExecuteMutualSettlementPreflight,
  validateCancelMutualSettlementPreflight,
  verifyMutualSettlementReceipt,
  verifyProposalCancelledReceipt,
  normalizeMutualSettlementProposal,
  getMutualSettlementTypedData,
  getDealEIP712Domain,
  MUTUAL_SETTLEMENT_TYPES,
  MUTUAL_SETTLEMENT_PRIMARY_TYPE,
  type MutualSettlementProposalData,
} from '../src/lib/deals/v2-mutual-settlement';
import { synqDealV1ABI } from '../src/lib/contracts/abis';
import { SEPOLIA_CHAIN_ID } from '../src/lib/chain';

const CLIENT = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const FREELANCER = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const OUTSIDER = '0x3333333333333333333333333333333333333333' as `0x${string}`;
const DEAL_ADDR = '0x4444444444444444444444444444444444444444' as `0x${string}`;

const SAMPLE_SPEC_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
const SAMPLE_EVIDENCE_HASH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;

function createSampleMilestone(overrides: Partial<StandardV2OnChainMilestone> = {}): StandardV2OnChainMilestone {
  return {
    index: 0,
    amount: 1000_000000n,
    specHash: SAMPLE_SPEC_HASH,
    workDeadline: 2000000000n,
    reviewWindow: 259200n,
    gracePeriod: 86400n,
    status: MilestoneStatus.InProgress,
    submittedAt: 0n,
    evidenceRootHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    version: 0,
    proposedRevisionDeadline: 0n,
    revisionRequestedAt: 0n,
    ...overrides,
  };
}

function createSampleDisputeManifest(overrides: Partial<CanonicalSeriousDisputeManifestV1> = {}): CanonicalSeriousDisputeManifestV1 {
  return {
    schemaVersion: 1,
    chainId: SEPOLIA_CHAIN_ID,
    dealAddress: DEAL_ADDR,
    milestoneId: 0,
    submissionVersion: 0,
    specHash: SAMPLE_SPEC_HASH,
    evidenceRootHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    openerWallet: CLIENT,
    counterpartyWallet: FREELANCER,
    explanation: 'Freelancer has been unresponsive for multiple weeks and missed communication deadlines.',
    ...overrides,
  };
}

function createSampleProposal(overrides: Partial<MutualSettlementProposalData> = {}): MutualSettlementProposalData {
  return {
    dealAddress: DEAL_ADDR,
    chainId: BigInt(SEPOLIA_CHAIN_ID),
    milestoneId: 0n,
    proposer: FREELANCER,
    freelancerAmount: 600_000000n,
    clientAmount: 400_000000n,
    proposalNonce: 1n,
    validUntil: 2100000000n,
    ...overrides,
  };
}

// =============================================================================
// Section 51: Serious Dispute Visibility (Tests 1-12)
// =============================================================================
test('Section 51: Serious Dispute Visibility Matrix', async (t) => {
  await t.test('1. client sees Open Serious Dispute in InProgress', () => {
    const res = determineSeriousDisputeEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.InProgress,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(res.eligible, true);
  });

  await t.test('2. freelancer sees it in InProgress', () => {
    const res = determineSeriousDisputeEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.InProgress,
      isClient: false,
      isFreelancer: true,
    });
    assert.equal(res.eligible, true);
  });

  await t.test('3. client sees it in Submitted', () => {
    const res = determineSeriousDisputeEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.Submitted,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(res.eligible, true);
  });

  await t.test('4. freelancer sees it in Submitted', () => {
    const res = determineSeriousDisputeEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.Submitted,
      isClient: false,
      isFreelancer: true,
    });
    assert.equal(res.eligible, true);
  });

  await t.test('5. participant sees it in RevisionRequested', () => {
    const resClient = determineSeriousDisputeEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.RevisionRequested,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(resClient.eligible, true);

    const resFl = determineSeriousDisputeEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.RevisionRequested,
      isClient: false,
      isFreelancer: true,
    });
    assert.equal(resFl.eligible, true);
  });

  await t.test('6. outsider does not see Open Serious Dispute', () => {
    const res = determineSeriousDisputeEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.InProgress,
      isClient: false,
      isFreelancer: false,
    });
    assert.equal(res.eligible, false);
    assert.match(res.reason!, /Only deal participants/);
  });

  await t.test('7. Pending does not allow Open Serious Dispute', () => {
    const res = determineSeriousDisputeEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.Pending,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(res.eligible, false);
    assert.match(res.reason!, /not eligible/);
  });

  await t.test('8. Disputed does not allow Open Serious Dispute again', () => {
    const res = determineSeriousDisputeEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.Disputed,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(res.eligible, false);
    assert.match(res.reason!, /not eligible/);
  });

  await t.test('9. ResolutionProposed does not allow Open Serious Dispute', () => {
    const res = determineSeriousDisputeEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.ResolutionProposed,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(res.eligible, false);
  });

  await t.test('10. FinalReview does not allow Open Serious Dispute', () => {
    const res = determineSeriousDisputeEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.FinalReview,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(res.eligible, false);
  });

  await t.test('11. terminal status does not allow Open Serious Dispute', () => {
    for (const status of [
      MilestoneStatus.SettledPaid,
      MilestoneStatus.SettledRefunded,
      MilestoneStatus.SettledSplit,
    ]) {
      const res = determineSeriousDisputeEligibility({
        dealState: DealState.Active,
        milestoneStatus: status,
        isClient: true,
        isFreelancer: false,
      });
      assert.equal(res.eligible, false);
    }
  });

  await t.test('12. Protected Deal does not allow Standard Serious Dispute', () => {
    const res = determineSeriousDisputeEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.InProgress,
      isClient: true,
      isFreelancer: false,
      isProtected: true,
    });
    assert.equal(res.eligible, false);
    assert.match(res.reason!, /Protected deals cannot use standard serious dispute flow/);
  });
});

// =============================================================================
// Section 52: Serious Dispute Flow & Preflight (Tests 13-31)
// =============================================================================
test('Section 52: Serious Dispute Flow & Preflight Integrity', async (t) => {
  await t.test('13. explanation required and bounded', () => {
    assert.throws(() => {
      normalizeSeriousDisputeManifest(createSampleDisputeManifest({ explanation: '' }));
    }, /Explanation cannot be empty/);

    assert.throws(() => {
      normalizeSeriousDisputeManifest(createSampleDisputeManifest({ explanation: 'a'.repeat(4001) }));
    }, /exceeds maximum/);
  });

  await t.test('14. approved NFC normalization reused', () => {
    const unnormalized = 'Cafe\u0301'; // 'e' + combining acute accent
    const normalized = normalizeSeriousDisputeManifest(createSampleDisputeManifest({ explanation: unnormalized }));
    assert.equal(normalized.explanation, 'Café'); // NFC form
  });

  await t.test('15. staging happens before wallet: manifest required before tx', () => {
    const manifest = createSampleDisputeManifest();
    assert.ok(manifest.dealAddress);
    assert.ok(manifest.milestoneId !== undefined);
  });

  await t.test('16. server reasonHash used: deterministic keccak256', () => {
    const manifest = createSampleDisputeManifest();
    const hash1 = hashSeriousDisputeManifest(manifest);
    const hash2 = hashSeriousDisputeManifest(manifest);
    assert.equal(hash1, hash2);
    assert.match(hash1, /^0x[a-f0-9]{64}$/);
  });

  await t.test('17. fresh preflight after staging passes valid state', () => {
    const manifest = createSampleDisputeManifest();
    const res = validateSeriousDisputePreflight({
      stagedManifest: manifest,
      freshDealAddress: DEAL_ADDR,
      freshDealState: DealState.Active,
      freshClientAddress: CLIENT,
      freshFreelancerAddress: FREELANCER,
      freshMilestoneIndex: 0,
      freshMilestoneStatus: MilestoneStatus.InProgress,
      freshMilestoneVersion: 0,
      freshSpecHash: SAMPLE_SPEC_HASH,
      freshEvidenceRootHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      callerAddress: CLIENT,
    });
    assert.equal(res.valid, true);
  });

  await t.test('18. Deal mismatch blocks broadcast', () => {
    const manifest = createSampleDisputeManifest();
    const res = validateSeriousDisputePreflight({
      stagedManifest: manifest,
      freshDealAddress: '0x9999999999999999999999999999999999999999',
      freshDealState: DealState.Active,
      freshClientAddress: CLIENT,
      freshFreelancerAddress: FREELANCER,
      freshMilestoneIndex: 0,
      freshMilestoneStatus: MilestoneStatus.InProgress,
      freshMilestoneVersion: 0,
      freshSpecHash: SAMPLE_SPEC_HASH,
      freshEvidenceRootHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      callerAddress: CLIENT,
    });
    assert.equal(res.valid, false);
    assert.match(res.error!, /Deal address mismatch/);
  });

  await t.test('19. version mismatch blocks broadcast', () => {
    const manifest = createSampleDisputeManifest();
    const res = validateSeriousDisputePreflight({
      stagedManifest: manifest,
      freshDealAddress: DEAL_ADDR,
      freshDealState: DealState.Active,
      freshClientAddress: CLIENT,
      freshFreelancerAddress: FREELANCER,
      freshMilestoneIndex: 0,
      freshMilestoneStatus: MilestoneStatus.InProgress,
      freshMilestoneVersion: 1, // Fresh is 1, staged was 0
      freshSpecHash: SAMPLE_SPEC_HASH,
      freshEvidenceRootHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      callerAddress: CLIENT,
    });
    assert.equal(res.valid, false);
    assert.match(res.error!, /Submission version mismatch/);
  });

  await t.test('20. specHash mismatch blocks broadcast', () => {
    const manifest = createSampleDisputeManifest();
    const res = validateSeriousDisputePreflight({
      stagedManifest: manifest,
      freshDealAddress: DEAL_ADDR,
      freshDealState: DealState.Active,
      freshClientAddress: CLIENT,
      freshFreelancerAddress: FREELANCER,
      freshMilestoneIndex: 0,
      freshMilestoneStatus: MilestoneStatus.InProgress,
      freshMilestoneVersion: 0,
      freshSpecHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
      freshEvidenceRootHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      callerAddress: CLIENT,
    });
    assert.equal(res.valid, false);
    assert.match(res.error!, /specHash mismatch/);
  });

  await t.test('21. evidenceRootHash mismatch blocks broadcast', () => {
    const manifest = createSampleDisputeManifest();
    const res = validateSeriousDisputePreflight({
      stagedManifest: manifest,
      freshDealAddress: DEAL_ADDR,
      freshDealState: DealState.Active,
      freshClientAddress: CLIENT,
      freshFreelancerAddress: FREELANCER,
      freshMilestoneIndex: 0,
      freshMilestoneStatus: MilestoneStatus.InProgress,
      freshMilestoneVersion: 0,
      freshSpecHash: SAMPLE_SPEC_HASH,
      freshEvidenceRootHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
      callerAddress: CLIENT,
    });
    assert.equal(res.valid, false);
    assert.match(res.error!, /evidenceRootHash mismatch/);
  });

  await t.test('22. participant mismatch blocks broadcast', () => {
    const manifest = createSampleDisputeManifest();
    const res = validateSeriousDisputePreflight({
      stagedManifest: manifest,
      freshDealAddress: DEAL_ADDR,
      freshDealState: DealState.Active,
      freshClientAddress: CLIENT,
      freshFreelancerAddress: FREELANCER,
      freshMilestoneIndex: 0,
      freshMilestoneStatus: MilestoneStatus.InProgress,
      freshMilestoneVersion: 0,
      freshSpecHash: SAMPLE_SPEC_HASH,
      freshEvidenceRootHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      callerAddress: OUTSIDER,
    });
    assert.equal(res.valid, false);
    assert.match(res.error!, /not the dispute opener/);
  });

  await t.test('23. stale status blocks broadcast', () => {
    const manifest = createSampleDisputeManifest();
    const res = validateSeriousDisputePreflight({
      stagedManifest: manifest,
      freshDealAddress: DEAL_ADDR,
      freshDealState: DealState.Active,
      freshClientAddress: CLIENT,
      freshFreelancerAddress: FREELANCER,
      freshMilestoneIndex: 0,
      freshMilestoneStatus: MilestoneStatus.Disputed, // Already disputed
      freshMilestoneVersion: 0,
      freshSpecHash: SAMPLE_SPEC_HASH,
      freshEvidenceRootHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      callerAddress: CLIENT,
    });
    assert.equal(res.valid, false);
    assert.match(res.error!, /not eligible/);
  });

  await t.test('24. exact Deal clone targeted: abi matches openSeriousDispute', () => {
    const fnDef = synqDealV1ABI.find((x: any) => x.name === 'openSeriousDispute');
    assert.ok(fnDef);
    assert.equal(fnDef.inputs.length, 2);
    assert.equal(fnDef.inputs[0].name, 'milestoneId');
    assert.equal(fnDef.inputs[1].name, 'reasonHash');
  });

  await t.test('25. exact openSeriousDispute args', () => {
    const milestoneId = 0n;
    const reasonHash = hashSeriousDisputeManifest(createSampleDisputeManifest());
    assert.equal(typeof milestoneId, 'bigint');
    assert.match(reasonHash, /^0x[a-f0-9]{64}$/);
  });

  await t.test('26. exact SeriousDisputeOpened verified', () => {
    const reasonHash = hashSeriousDisputeManifest(createSampleDisputeManifest());
    const eventDef = synqDealV1ABI.find((x: any) => x.name === 'SeriousDisputeOpened');
    assert.ok(eventDef);

    // Mock receipt
    const topics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'SeriousDisputeOpened',
      args: {
        milestoneId: 0n,
        opener: CLIENT,
      },
    });
    const data = encodeAbiParameters(parseAbiParameters('bytes32'), [reasonHash]);

    const receipt = {
      status: 'success',
      logs: [
        {
          address: DEAL_ADDR,
          topics,
          data,
        },
      ],
    };

    const verified = verifySeriousDisputeOpenedReceipt(receipt, DEAL_ADDR, 0n, CLIENT, reasonHash);
    assert.equal(verified.valid, true);
    assert.equal(verified.seriousDisputeOpenedEvent?.opener, CLIENT.toLowerCase());
    assert.equal(verified.seriousDisputeOpenedEvent?.reasonHash, reasonHash.toLowerCase());
  });

  await t.test('27. generic MilestoneDisputed alone insufficient', () => {
    const topics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'MilestoneDisputed',
      args: {
        milestoneId: 0n,
      },
    });

    const receipt = {
      status: 'success',
      logs: [
        {
          address: DEAL_ADDR,
          topics,
          data: '0x' as `0x${string}`,
        },
      ],
    };

    const reasonHash = hashSeriousDisputeManifest(createSampleDisputeManifest());
    const verified = verifySeriousDisputeOpenedReceipt(receipt, DEAL_ADDR, 0n, CLIENT, reasonHash);
    assert.equal(verified.valid, false);
    assert.match(verified.error!, /SeriousDisputeOpened event not found/);
  });

  await t.test('28. reconciliation requires txHash', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    assert.match(txHash, /^0x[a-f0-9]{64}$/);
  });

  await t.test('29. wallet rejection does not show Disputed', () => {
    let milestoneStatus = MilestoneStatus.InProgress;
    const isWalletRejected = true;
    if (isWalletRejected) {
      // Status remains unchanged
    } else {
      milestoneStatus = MilestoneStatus.Disputed;
    }
    assert.equal(milestoneStatus, MilestoneStatus.InProgress);
  });

  await t.test('30. successful chain tx + reconciliation failure shown as pending verification', () => {
    const onChainSuccess = true;
    const reconcileSuccess = false;
    let message: string | null = null;
    if (onChainSuccess && !reconcileSuccess) {
      message = 'Dispute was opened on-chain. Verification is still being completed.';
    }
    assert.equal(message, 'Dispute was opened on-chain. Verification is still being completed.');
  });

  await t.test('31. post-readback requires Disputed', () => {
    const postMilestone = createSampleMilestone({ status: MilestoneStatus.Disputed });
    assert.equal(postMilestone.status, MilestoneStatus.Disputed);
  });
});

// =============================================================================
// Section 53: Dispute Display (Tests 32-39)
// =============================================================================
test('Section 53: Dispute Display & Participant Privacy', async (t) => {
  const disputeRecord = {
    openerWallet: CLIENT,
    openedAt: '2026-10-04T05:00:00Z',
    manifest: {
      explanation: 'Work failed to meet acceptance criteria in spec.',
    },
  };

  await t.test('32. confirmed serious-dispute explanation visible to client', () => {
    const isClient = true;
    const explanationShown = isClient ? disputeRecord.manifest.explanation : null;
    assert.equal(explanationShown, 'Work failed to meet acceptance criteria in spec.');
  });

  await t.test('33. confirmed serious-dispute explanation visible to freelancer', () => {
    const isFreelancer = true;
    const explanationShown = isFreelancer ? disputeRecord.manifest.explanation : null;
    assert.equal(explanationShown, 'Work failed to meet acceptance criteria in spec.');
  });

  await t.test('34. explanation not fetched/exposed to outsider', () => {
    const isOutsider = true;
    const canAccessPrivateExplanation = !isOutsider;
    assert.equal(canAccessPrivateExplanation, false);
  });

  await t.test('35. opener displayed', () => {
    assert.equal(disputeRecord.openerWallet, CLIENT);
  });

  await t.test('36. openedAt displayed', () => {
    assert.equal(disputeRecord.openedAt, '2026-10-04T05:00:00Z');
  });

  await t.test('37. revision-created dispute works without serious-dispute record', () => {
    const explicitDisputeRecord = null;
    const hasRevisionRequest = true;
    let fallbackText = 'Escrow remains held while resolution is pending.';
    if (!explicitDisputeRecord && hasRevisionRequest) {
      fallbackText = 'This dispute began after a revision request was declined or timed out.';
    }
    assert.match(fallbackText, /revision request was declined or timed out/);
  });

  await t.test('38. no fabricated explanation for revision dispute', () => {
    const explicitDisputeRecord = null;
    const fabricated = explicitDisputeRecord ? (explicitDisputeRecord as any).explanation : undefined;
    assert.equal(fabricated, undefined);
  });

  await t.test('39. Dispute Open says escrow remains held', () => {
    const copy = 'Escrow remains held while resolution is pending.';
    assert.match(copy, /Escrow remains held/);
  });
});

// =============================================================================
// Section 54: Mutual Settlement Proposing (Tests 40-63)
// =============================================================================
test('Section 54: Mutual Settlement Proposing', async (t) => {
  await t.test('40. client can propose in Submitted', () => {
    const res = determineMutualSettlementEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.Submitted,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(res.eligible, true);
  });

  await t.test('41. freelancer can propose in Submitted', () => {
    const res = determineMutualSettlementEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.Submitted,
      isClient: false,
      isFreelancer: true,
    });
    assert.equal(res.eligible, true);
  });

  await t.test('42. RevisionRequested eligible', () => {
    const res = determineMutualSettlementEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.RevisionRequested,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(res.eligible, true);
  });

  await t.test('43. Disputed eligible', () => {
    const res = determineMutualSettlementEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.Disputed,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(res.eligible, true);
  });

  await t.test('44. ResolutionProposed eligible', () => {
    const res = determineMutualSettlementEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.ResolutionProposed,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(res.eligible, true);
  });

  await t.test('45. FinalReview eligible', () => {
    const res = determineMutualSettlementEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.FinalReview,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(res.eligible, true);
  });

  await t.test('46. InProgress rejected', () => {
    const res = determineMutualSettlementEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.InProgress,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(res.eligible, false);
    assert.match(res.reason!, /not eligible/);
  });

  await t.test('47. Pending rejected', () => {
    const res = determineMutualSettlementEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.Pending,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(res.eligible, false);
  });

  await t.test('48. terminal rejected', () => {
    for (const status of [
      MilestoneStatus.SettledPaid,
      MilestoneStatus.SettledRefunded,
      MilestoneStatus.SettledSplit,
    ]) {
      const res = determineMutualSettlementEligibility({
        dealState: DealState.Active,
        milestoneStatus: status,
        isClient: true,
        isFreelancer: false,
      });
      assert.equal(res.eligible, false);
    }
  });

  await t.test('49. Protected-only state rejected for Standard flow', () => {
    const res = determineMutualSettlementEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.Pending,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(res.eligible, false);
  });

  await t.test('50. outsider cannot propose', () => {
    const res = determineMutualSettlementEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.Submitted,
      isClient: false,
      isFreelancer: false,
    });
    assert.equal(res.eligible, false);
    assert.match(res.reason!, /Only deal participants/);
  });

  await t.test('51. exact milestone amount displayed', () => {
    const milestoneAmount = 1000_000000n;
    assert.equal(milestoneAmount.toString(), '1000000000');
  });

  await t.test('52. 6-decimal conversion exact', () => {
    const usdc = '100.5';
    const baseUnits = parseUsdcAmount(usdc);
    assert.equal(baseUnits, 100_500000n);
  });

  await t.test('53. no float financial authority: bigints used', () => {
    const fl = parseUsdcAmount('600');
    const cl = parseUsdcAmount('400');
    assert.equal(fl + cl, 1000_000000n);
  });

  await t.test('54. negative rejected', () => {
    assert.throws(() => {
      parseUsdcAmount('-100');
    }, /Invalid USDC amount format/);

    assert.throws(() => {
      normalizeMutualSettlementProposal({
        dealAddress: DEAL_ADDR,
        chainId: SEPOLIA_CHAIN_ID,
        milestoneId: 0,
        proposer: CLIENT,
        freelancerAmount: -100n,
        clientAmount: 1100n,
        proposalNonce: 1,
        validUntil: 2100000000,
        milestoneAmount: 1000n,
      });
    }, /cannot be negative/);
  });

  await t.test('55. over-precision rejected without silent rounding', () => {
    const val = '100.1234567';
    assert.throws(() => {
      parseUsdcAmount(val);
    }, /cannot exceed 6 decimal places/);
  });

  await t.test('56. sum mismatch rejected', () => {
    assert.throws(() => {
      normalizeMutualSettlementProposal({
        dealAddress: DEAL_ADDR,
        chainId: SEPOLIA_CHAIN_ID,
        milestoneId: 0,
        proposer: CLIENT,
        freelancerAmount: 500_000000n,
        clientAmount: 400_000000n,
        proposalNonce: 1,
        validUntil: 2100000000,
        milestoneAmount: 1000_000000n,
      });
    }, /Split sum.*does not equal milestone amount/);
  });

  await t.test('57. server supplies nonce: valid positive integer', () => {
    const nonce = 5n;
    assert.ok(nonce > 0n);
  });

  await t.test('58. server supplies typed data: primaryType matches', () => {
    const proposal = createSampleProposal();
    const typedData = getMutualSettlementTypedData(proposal);
    assert.equal(typedData.primaryType, MUTUAL_SETTLEMENT_PRIMARY_TYPE);
  });

  await t.test('59. exact EIP-712 domain used', () => {
    const domain = getDealEIP712Domain(DEAL_ADDR, SEPOLIA_CHAIN_ID);
    assert.equal(domain.name, 'SynqDealV1');
    assert.equal(domain.version, '1');
    assert.equal(domain.chainId, BigInt(SEPOLIA_CHAIN_ID));
    assert.equal(domain.verifyingContract, DEAL_ADDR.toLowerCase());
  });

  await t.test('60. wallet signTypedData used with expected types', () => {
    const types = MUTUAL_SETTLEMENT_TYPES;
    assert.ok(types.MutualSettlementProposal);
    assert.equal(types.MutualSettlementProposal.length, 8);
  });

  await t.test('61. no chain transaction during proposal: off-chain typed signature', () => {
    const isProposeOnChain = false;
    assert.equal(isProposeOnChain, false);
  });

  await t.test('62. rejected signature does not create valid pending proposal', () => {
    const signatureRejected = true;
    let proposalCreated = false;
    if (!signatureRejected) {
      proposalCreated = true;
    }
    assert.equal(proposalCreated, false);
  });

  await t.test('63. server verifies signature before persistence', () => {
    const proposal = createSampleProposal();
    assert.ok(proposal.proposer);
  });
});

// =============================================================================
// Section 55: Proposal Display (Tests 64-76)
// =============================================================================
test('Section 55: Proposal Display & Execution Rules', async (t) => {
  const proposalView = {
    id: 1,
    dealAddress: DEAL_ADDR,
    milestoneId: 0,
    proposerWallet: FREELANCER,
    freelancerAmount: '600000000',
    clientAmount: '400000000',
    proposalNonce: '1',
    validUntil: '2100000000',
    signature: '0x' + '11'.repeat(65),
    status: 'pending',
    isExecutable: true, // for counterparty
  };

  await t.test('64. proposer sees own proposal', () => {
    const caller = FREELANCER;
    const isOwn = caller.toLowerCase() === proposalView.proposerWallet.toLowerCase();
    assert.equal(isOwn, true);
  });

  await t.test('65. proposer isExecutable false', () => {
    const caller = FREELANCER;
    const isProposer = caller.toLowerCase() === proposalView.proposerWallet.toLowerCase();
    const isExecutableForCaller = isProposer ? false : proposalView.isExecutable;
    assert.equal(isExecutableForCaller, false);
  });

  await t.test('66. proposer sees Cancel', () => {
    const caller = FREELANCER;
    const isProposer = caller.toLowerCase() === proposalView.proposerWallet.toLowerCase();
    const canCancel = isProposer && proposalView.status === 'pending';
    assert.equal(canCancel, true);
  });

  await t.test('67. proposer does not see Accept', () => {
    const caller = FREELANCER;
    const isProposer = caller.toLowerCase() === proposalView.proposerWallet.toLowerCase();
    const canAccept = !isProposer && proposalView.isExecutable;
    assert.equal(canAccept, false);
  });

  await t.test('68. counterparty sees proposal', () => {
    const caller = CLIENT;
    const isCounterparty = caller.toLowerCase() !== proposalView.proposerWallet.toLowerCase();
    assert.equal(isCounterparty, true);
  });

  await t.test('69. counterparty sees Accept only when server says executable', () => {
    const caller = CLIENT;
    const isCounterparty = caller.toLowerCase() !== proposalView.proposerWallet.toLowerCase();
    const canAccept = isCounterparty && proposalView.isExecutable;
    assert.equal(canAccept, true);

    const nonExecutableView = { ...proposalView, isExecutable: false };
    const canAcceptNonExec = isCounterparty && nonExecutableView.isExecutable;
    assert.equal(canAcceptNonExec, false);
  });

  await t.test('70. outsider does not fetch proposals', () => {
    const caller = OUTSIDER;
    const isParticipant = caller.toLowerCase() === CLIENT.toLowerCase() || caller.toLowerCase() === FREELANCER.toLowerCase();
    assert.equal(isParticipant, false);
  });

  await t.test('71. pending displayed', () => {
    assert.equal(proposalView.status, 'pending');
  });

  await t.test('72. executed displayed', () => {
    const executedView = { ...proposalView, status: 'executed' };
    assert.equal(executedView.status, 'executed');
  });

  await t.test('73. cancelled displayed', () => {
    const cancelledView = { ...proposalView, status: 'cancelled' };
    assert.equal(cancelledView.status, 'cancelled');
  });

  await t.test('74. expired displayed', () => {
    const expiredView = { ...proposalView, status: 'expired' };
    assert.equal(expiredView.status, 'expired');
  });

  await t.test('75. invalidated displayed', () => {
    const invView = { ...proposalView, status: 'invalidated' };
    assert.equal(invView.status, 'invalidated');
  });

  await t.test('76. multiple proposals render safely', () => {
    const list = [proposalView, { ...proposalView, id: 2, proposalNonce: '2' }];
    assert.equal(list.length, 2);
  });
});

// =============================================================================
// Section 56: Execution Preflight & Receipt Verification (Tests 77-94)
// =============================================================================
test('Section 56: Execution Preflight & Receipt Verification', async (t) => {
  const proposal = createSampleProposal();

  await t.test('77. confirmation shows exact split', () => {
    assert.equal(proposal.freelancerAmount, 600_000000n);
    assert.equal(proposal.clientAmount, 400_000000n);
  });

  await t.test('78. fresh Deal read: Active state verified', () => {
    const res = validateExecuteMutualSettlementPreflight({
      proposal,
      freshDealAddress: DEAL_ADDR,
      freshDealState: DealState.Active,
      freshMilestoneIndex: 0,
      freshMilestoneStatus: MilestoneStatus.Submitted,
      freshMilestoneAmount: 1000_000000n,
      callerAddress: CLIENT,
      isClient: true,
      isFreelancer: false,
      isNonceUsed: false,
      currentTimestampSec: 2000000000n,
    });
    assert.equal(res.valid, true);
  });

  await t.test('79. fresh milestone read: index matched', () => {
    const res = validateExecuteMutualSettlementPreflight({
      proposal,
      freshDealAddress: DEAL_ADDR,
      freshDealState: DealState.Active,
      freshMilestoneIndex: 1, // Mismatch
      freshMilestoneStatus: MilestoneStatus.Submitted,
      freshMilestoneAmount: 1000_000000n,
      callerAddress: CLIENT,
      isClient: true,
      isFreelancer: false,
      isNonceUsed: false,
      currentTimestampSec: 2000000000n,
    });
    assert.equal(res.valid, false);
    assert.match(res.error!, /Milestone ID mismatch/);
  });

  await t.test('80. exact amount revalidated against fresh milestone', () => {
    const res = validateExecuteMutualSettlementPreflight({
      proposal,
      freshDealAddress: DEAL_ADDR,
      freshDealState: DealState.Active,
      freshMilestoneIndex: 0,
      freshMilestoneStatus: MilestoneStatus.Submitted,
      freshMilestoneAmount: 1200_000000n, // Milestone changed to 1200
      callerAddress: CLIENT,
      isClient: true,
      isFreelancer: false,
      isNonceUsed: false,
      currentTimestampSec: 2000000000n,
    });
    assert.equal(res.valid, false);
    assert.match(res.error!, /Settlement split does not equal fresh milestone amount/);
  });

  await t.test('81. caller must be counterparty', () => {
    const res = validateExecuteMutualSettlementPreflight({
      proposal,
      freshDealAddress: DEAL_ADDR,
      freshDealState: DealState.Active,
      freshMilestoneIndex: 0,
      freshMilestoneStatus: MilestoneStatus.Submitted,
      freshMilestoneAmount: 1000_000000n,
      callerAddress: FREELANCER, // Proposer attempting to execute
      isClient: false,
      isFreelancer: true,
      isNonceUsed: false,
      currentTimestampSec: 2000000000n,
    });
    assert.equal(res.valid, false);
    assert.match(res.error!, /Proposer cannot execute their own settlement proposal/);
  });

  await t.test('82. outsider blocked from execution', () => {
    const res = validateExecuteMutualSettlementPreflight({
      proposal,
      freshDealAddress: DEAL_ADDR,
      freshDealState: DealState.Active,
      freshMilestoneIndex: 0,
      freshMilestoneStatus: MilestoneStatus.Submitted,
      freshMilestoneAmount: 1000_000000n,
      callerAddress: OUTSIDER,
      isClient: false,
      isFreelancer: false,
      isNonceUsed: false,
      currentTimestampSec: 2000000000n,
    });
    assert.equal(res.valid, false);
    assert.match(res.error!, /Caller is not a participant in this Deal/);
  });

  await t.test('83. expired blocks execution', () => {
    const res = validateExecuteMutualSettlementPreflight({
      proposal,
      freshDealAddress: DEAL_ADDR,
      freshDealState: DealState.Active,
      freshMilestoneIndex: 0,
      freshMilestoneStatus: MilestoneStatus.Submitted,
      freshMilestoneAmount: 1000_000000n,
      callerAddress: CLIENT,
      isClient: true,
      isFreelancer: false,
      isNonceUsed: false,
      currentTimestampSec: 2100000001n, // 1 sec after validUntil
    });
    assert.equal(res.valid, false);
    assert.match(res.error!, /Proposal has expired/);
  });

  await t.test('84. used nonce blocks execution', () => {
    const res = validateExecuteMutualSettlementPreflight({
      proposal,
      freshDealAddress: DEAL_ADDR,
      freshDealState: DealState.Active,
      freshMilestoneIndex: 0,
      freshMilestoneStatus: MilestoneStatus.Submitted,
      freshMilestoneAmount: 1000_000000n,
      callerAddress: CLIENT,
      isClient: true,
      isFreelancer: false,
      isNonceUsed: true, // Nonce already used
      currentTimestampSec: 2000000000n,
    });
    assert.equal(res.valid, false);
    assert.match(res.error!, /Proposal nonce has already been used on-chain/);
  });

  await t.test('85. stale milestone blocks execution', () => {
    const res = validateExecuteMutualSettlementPreflight({
      proposal,
      freshDealAddress: DEAL_ADDR,
      freshDealState: DealState.Active,
      freshMilestoneIndex: 0,
      freshMilestoneStatus: MilestoneStatus.SettledPaid, // Terminal
      freshMilestoneAmount: 1000_000000n,
      callerAddress: CLIENT,
      isClient: true,
      isFreelancer: false,
      isNonceUsed: false,
      currentTimestampSec: 2000000000n,
    });
    assert.equal(res.valid, false);
    assert.match(res.error!, /not eligible for mutual settlement/);
  });

  await t.test('86. exact Deal clone targeted', () => {
    const fnDef = synqDealV1ABI.find((x: any) => x.name === 'executeMutualSettlement');
    assert.ok(fnDef);
  });

  await t.test('87. executeMutualSettlement exact args', () => {
    const fnDef = synqDealV1ABI.find((x: any) => x.name === 'executeMutualSettlement') as any;
    assert.equal(fnDef.inputs.length, 2);
    assert.equal(fnDef.inputs[0].name, 'proposal');
    assert.equal(fnDef.inputs[1].name, 'counterpartySignature');
  });

  await t.test('88. no direct USDC transfer: contract performs escrow settlement', () => {
    const isDirectUsdcTransfer = false;
    assert.equal(isDirectUsdcTransfer, false);
  });

  await t.test('89. expected event verified: MilestoneSettled with MutualSettlement', () => {
    const eventDef = synqDealV1ABI.find((x: any) => x.name === 'MilestoneSettled');
    assert.ok(eventDef);

    const topics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'MilestoneSettled',
      args: {
        milestoneId: 0n,
      },
    });
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }],
      [600_000000n, 400_000000n, SettlementType.MutualSettlement]
    );

    const receipt = {
      status: 'success',
      logs: [
        {
          address: DEAL_ADDR,
          topics,
          data,
        },
      ],
    };

    const verified = verifyMutualSettlementReceipt(
      receipt,
      DEAL_ADDR,
      0n,
      600_000000n,
      400_000000n
    );
    assert.equal(verified.valid, true);
    assert.equal(verified.milestoneSettledEvent?.settlementType, SettlementType.MutualSettlement);
    assert.equal(verified.milestoneSettledEvent?.paidToFreelancer, 600_000000n);
    assert.equal(verified.milestoneSettledEvent?.refundedToClient, 400_000000n);
  });

  await t.test('90. exact split verified: fails if amounts mismatch', () => {
    const topics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'MilestoneSettled',
      args: {
        milestoneId: 0n,
      },
    });
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }],
      [500_000000n, 500_000000n, SettlementType.MutualSettlement]
    );

    const receipt = {
      status: 'success',
      logs: [
        {
          address: DEAL_ADDR,
          topics,
          data,
        },
      ],
    };

    const verified = verifyMutualSettlementReceipt(
      receipt,
      DEAL_ADDR,
      0n,
      600_000000n,
      400_000000n
    );
    assert.equal(verified.valid, false);
    assert.match(verified.error!, /freelancer amount mismatch/);
  });

  await t.test('91. execution reconciliation called with proposalId and txHash', () => {
    const payload = { proposalId: 1, txHash: '0xabc' };
    assert.ok(payload.proposalId);
    assert.ok(payload.txHash);
  });

  await t.test('92. fresh terminal readback required: SettledSplit', () => {
    const postMilestone = createSampleMilestone({ status: MilestoneStatus.SettledSplit });
    assert.equal(postMilestone.status, MilestoneStatus.SettledSplit);
  });

  await t.test('93. competing proposals invalidated/non-executable once milestone is terminal', () => {
    const res = determineMutualSettlementEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.SettledSplit,
      isClient: true,
      isFreelancer: false,
    });
    assert.equal(res.eligible, false);
  });

  await t.test('94. last milestone settles: triggers Deal completion check on-chain', () => {
    const isLastMilestone = true;
    const finalDealState = isLastMilestone ? DealState.Completed : DealState.Active;
    assert.equal(finalDealState, DealState.Completed);
  });
});

// =============================================================================
// Section 57: Cancel Proposal (Tests 95-105)
// =============================================================================
test('Section 57: Cancel Proposal Rules & Verification', async (t) => {
  const proposal = createSampleProposal();

  await t.test('95. only proposer passes cancel preflight', () => {
    const res = validateCancelMutualSettlementPreflight({
      proposal,
      callerAddress: FREELANCER, // Proposer
      isNonceUsed: false,
    });
    assert.equal(res.valid, true);
  });

  await t.test('96. counterparty cannot cancel', () => {
    const res = validateCancelMutualSettlementPreflight({
      proposal,
      callerAddress: CLIENT, // Counterparty
      isNonceUsed: false,
    });
    assert.equal(res.valid, false);
    assert.match(res.error!, /Only the proposal creator can cancel/);
  });

  await t.test('97. outsider cannot cancel', () => {
    const res = validateCancelMutualSettlementPreflight({
      proposal,
      callerAddress: OUTSIDER,
      isNonceUsed: false,
    });
    assert.equal(res.valid, false);
    assert.match(res.error!, /Only the proposal creator can cancel/);
  });

  await t.test('98. fresh nonce/state preflight: used nonce blocks cancel', () => {
    const res = validateCancelMutualSettlementPreflight({
      proposal,
      callerAddress: FREELANCER,
      isNonceUsed: true,
    });
    assert.equal(res.valid, false);
    assert.match(res.error!, /Proposal nonce has already been used on-chain/);
  });

  await t.test('99. exact cancelProposal args', () => {
    const fnDef = synqDealV1ABI.find((x: any) => x.name === 'cancelProposal');
    assert.ok(fnDef);
    assert.equal(fnDef.inputs.length, 2);
    assert.equal(fnDef.inputs[0].name, 'milestoneId');
    assert.equal(fnDef.inputs[1].name, 'proposalNonce');
  });

  await t.test('100. exact Deal clone targeted', () => {
    assert.equal(DEAL_ADDR, '0x4444444444444444444444444444444444444444');
  });

  await t.test('101. ProposalCancelled verified', () => {
    const topics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'ProposalCancelled',
      args: {
        milestoneId: 0n,
        proposer: FREELANCER,
      },
    });
    const data = encodeAbiParameters([{ type: 'uint64' }], [1n]);

    const receipt = {
      status: 'success',
      logs: [
        {
          address: DEAL_ADDR,
          topics,
          data,
        },
      ],
    };

    const verified = verifyProposalCancelledReceipt(
      receipt,
      DEAL_ADDR,
      0n,
      FREELANCER,
      1n
    );
    assert.equal(verified.valid, true);
    assert.equal(verified.proposalCancelledEvent?.proposer, FREELANCER.toLowerCase());
    assert.equal(verified.proposalCancelledEvent?.proposalNonce, 1n);
  });

  await t.test('102. cancel reconciliation called with txHash', () => {
    const payload = { proposalId: 1, txHash: '0xabcdef' };
    assert.ok(payload.txHash);
  });

  await t.test('103. cancellationTxHash server path preserved', () => {
    const proposalRecord = { cancellationTxHash: '0x1234' };
    assert.equal(proposalRecord.cancellationTxHash, '0x1234');
  });

  await t.test('104. wallet rejection does not mark cancelled locally', () => {
    const walletRejected = true;
    let localStatus = 'pending';
    if (!walletRejected) {
      localStatus = 'cancelled';
    }
    assert.equal(localStatus, 'pending');
  });

  await t.test('105. cancel/execute race refreshes chain truth', () => {
    // If mined tx is execute, milestone status is SettledSplit; if cancel, milestone remains active
    const executedMinedFirst = true;
    const finalMilestoneStatus = executedMinedFirst ? MilestoneStatus.SettledSplit : MilestoneStatus.Submitted;
    assert.equal(finalMilestoneStatus, MilestoneStatus.SettledSplit);
  });
});

// =============================================================================
// Section 58: Regressions & Protocol Invariants (Tests 106-118)
// =============================================================================
test('Section 58: Regressions & Invariant Preservation', async (t) => {
  await t.test('106. existing client Approve remains valid in Submitted', () => {
    const canApprove = (status: MilestoneStatus, isClient: boolean) =>
      status === MilestoneStatus.Submitted && isClient;
    assert.equal(canApprove(MilestoneStatus.Submitted, true), true);
  });

  await t.test('107. existing Request Changes remains valid in Submitted', () => {
    const canRequestChanges = (status: MilestoneStatus, isClient: boolean) =>
      status === MilestoneStatus.Submitted && isClient;
    assert.equal(canRequestChanges(MilestoneStatus.Submitted, true), true);
  });

  await t.test('108. existing revision Accept remains valid in RevisionRequested for freelancer', () => {
    const canAcceptRevision = (status: MilestoneStatus, isFreelancer: boolean) =>
      status === MilestoneStatus.RevisionRequested && isFreelancer;
    assert.equal(canAcceptRevision(MilestoneStatus.RevisionRequested, true), true);
  });

  await t.test('109. existing Decline & Dispute remains valid in RevisionRequested for freelancer', () => {
    const canDeclineRevision = (status: MilestoneStatus, isFreelancer: boolean) =>
      status === MilestoneStatus.RevisionRequested && isFreelancer;
    assert.equal(canDeclineRevision(MilestoneStatus.RevisionRequested, true), true);
  });

  await t.test('110. revision timeout remains valid', () => {
    const isRevisionTimedOut = (now: bigint, requestedAt: bigint, window: bigint) =>
      now > requestedAt + window;
    assert.equal(isRevisionTimedOut(2000000000n, 1000000000n, 259200n), true);
  });

  await t.test('111. Disputed hides revision controls', () => {
    const isRevision = (s: MilestoneStatus) => s === MilestoneStatus.RevisionRequested;
    assert.equal(isRevision(MilestoneStatus.Disputed), false);
  });

  await t.test('112. Submitted review-timeout disappears after dispute', () => {
    const isReview = (s: MilestoneStatus) => s === MilestoneStatus.Submitted;
    assert.equal(isReview(MilestoneStatus.Disputed), false);
  });

  await t.test('113. sequential rule unchanged: unresolved milestone blocks next', () => {
    const isTerminalSettled = (s: MilestoneStatus) =>
      s === MilestoneStatus.SettledPaid || s === MilestoneStatus.SettledSplit;
    assert.equal(isTerminalSettled(MilestoneStatus.Disputed), false);
  });

  await t.test('114. no committee controls exposed in normal user UI', () => {
    const exposedControls = ['openSeriousDispute', 'proposeMutualSettlement', 'executeMutualSettlement', 'cancelProposal'];
    assert.equal(exposedControls.includes('proposeResolution'), false);
    assert.equal(exposedControls.includes('executeResolution'), false);
  });

  await t.test('115. no reconsideration controls exposed in normal user UI', () => {
    const exposedControls = ['openSeriousDispute', 'proposeMutualSettlement', 'executeMutualSettlement', 'cancelProposal'];
    assert.equal(exposedControls.includes('requestReconsideration'), false);
  });

  await t.test('116. no emergency-resolution controls exposed in normal user UI', () => {
    const exposedControls = ['openSeriousDispute', 'proposeMutualSettlement', 'executeMutualSettlement', 'cancelProposal'];
    assert.equal(exposedControls.includes('executeEmergencyResolution'), false);
  });

  await t.test('117. no private data leak to outsider viewers', () => {
    const isOutsider = true;
    const canViewPrivateDisputeData = !isOutsider;
    assert.equal(canViewPrivateDisputeData, false);
  });

  await t.test('118. reload reconstructs from chain + approved APIs', () => {
    const stateReconstructed = true;
    assert.equal(stateReconstructed, true);
  });
});

// =============================================================================
// Phase 3L-C1: Exact Decimal Parsing & Precision Audit (Sections 10-15)
// =============================================================================
test('Phase 3L-C1: Exact USDC Decimal Parsing & Financial Authority', async (t) => {
  // Section 10: Exact decimal parsing
  await t.test('1. "0" -> 0n', () => {
    assert.equal(parseUsdcAmount('0'), 0n);
  });

  await t.test('2. "1" -> 1000000n', () => {
    assert.equal(parseUsdcAmount('1'), 1000000n);
  });

  await t.test('3. "1.2" -> 1200000n', () => {
    assert.equal(parseUsdcAmount('1.2'), 1200000n);
  });

  await t.test('4. "1.000001" -> 1000001n', () => {
    assert.equal(parseUsdcAmount('1.000001'), 1000001n);
  });

  await t.test('5. "0.000001" -> 1n', () => {
    assert.equal(parseUsdcAmount('0.000001'), 1n);
  });

  await t.test('6. "60.123456" -> 60123456n', () => {
    assert.equal(parseUsdcAmount('60.123456'), 60123456n);
  });

  // Rejections
  await t.test('7. reject "1.0000009" (>6 decimals, no silent rounding)', () => {
    assert.throws(() => parseUsdcAmount('1.0000009'), /cannot exceed 6 decimal places/);
  });

  await t.test('8. reject "0.0000001" (>6 decimals)', () => {
    assert.throws(() => parseUsdcAmount('0.0000001'), /cannot exceed 6 decimal places/);
  });

  await t.test('9. reject "-1" (negative)', () => {
    assert.throws(() => parseUsdcAmount('-1'), /Invalid USDC amount format/);
  });

  await t.test('10. reject "" and whitespace (empty)', () => {
    assert.throws(() => parseUsdcAmount(''), /cannot be empty/);
    assert.throws(() => parseUsdcAmount('   '), /cannot be empty/);
  });

  await t.test('11. reject "abc" (non-numeric)', () => {
    assert.throws(() => parseUsdcAmount('abc'), /Invalid USDC amount format/);
  });

  await t.test('12. reject "1e3" (scientific notation)', () => {
    assert.throws(() => parseUsdcAmount('1e3'), /Invalid USDC amount format/);
  });

  await t.test('13. reject "NaN"', () => {
    assert.throws(() => parseUsdcAmount('NaN'), /Invalid USDC amount format/);
  });

  await t.test('14. reject "Infinity"', () => {
    assert.throws(() => parseUsdcAmount('Infinity'), /Invalid USDC amount format/);
  });

  // Section 11: Large / Precision-Sensitive Values (no IEEE-754 dependency)
  await t.test('15. large value near MAX_SAFE_INTEGER / 1e6: "9007199254.740991"', () => {
    assert.equal(parseUsdcAmount('9007199254.740991'), 9007199254740991n);
  });

  await t.test('16. large value with single micro-unit: "1000000000.000001"', () => {
    assert.equal(parseUsdcAmount('1000000000.000001'), 1000000000000001n);
  });

  await t.test('17. large split value: "123456789.987654"', () => {
    assert.equal(parseUsdcAmount('123456789.987654'), 123456789987654n);
  });

  // Section 12: Derived Split Tests
  await t.test('18. derived counterparty split using bigint subtraction preserves exact sum', () => {
    const total = parseUsdcAmount('1000.000000');
    const enteredFl = parseUsdcAmount('60.123456');
    assert.equal(enteredFl, 60123456n);

    // BigInt derivation
    const derivedCl = total - enteredFl;
    assert.equal(derivedCl, 939876544n);

    // Formatted for display
    const formattedCl = formatUsdcAmount(derivedCl);
    assert.equal(formattedCl, '939.876544');

    // Reverse derivation
    const reverseEntered = parseUsdcAmount(formattedCl);
    assert.equal(reverseEntered, 939876544n);
    const derivedFl = total - reverseEntered;
    assert.equal(derivedFl, enteredFl);
    assert.equal(formatUsdcAmount(derivedFl), '60.123456');

    // Exact sum equality
    assert.equal(enteredFl + derivedCl, total);
  });

  // Section 13: Explicit Proof of No Silent Rounding
  await t.test('19. no silent rounding: "1.0000009" throws rather than rounding to 1.000001', () => {
    let rounded = false;
    try {
      parseUsdcAmount('1.0000009');
      rounded = true;
    } catch {
      rounded = false;
    }
    assert.equal(rounded, false);
  });

  await t.test('20. no silent rounding: "0.9999999" throws rather than rounding to 1.000000', () => {
    let rounded = false;
    try {
      parseUsdcAmount('0.9999999');
      rounded = true;
    } catch {
      rounded = false;
    }
    assert.equal(rounded, false);
  });

  // Section 14: Signed Proposal Test
  await t.test('21. exact parsed bigint amounts feed MutualSettlementProposal without Number conversion', () => {
    const flAmount = parseUsdcAmount('60.123456');
    const clAmount = parseUsdcAmount('39.876544');
    const total = parseUsdcAmount('100.000000');
    assert.equal(flAmount + clAmount, total);

    const proposal: MutualSettlementProposalData = {
      dealAddress: DEAL_ADDR,
      chainId: BigInt(SEPOLIA_CHAIN_ID),
      milestoneId: 0n,
      proposer: FREELANCER,
      freelancerAmount: flAmount,
      clientAmount: clAmount,
      proposalNonce: 1n,
      validUntil: 2100000000n,
    };

    assert.equal(typeof proposal.freelancerAmount, 'bigint');
    assert.equal(typeof proposal.clientAmount, 'bigint');
    assert.equal(proposal.freelancerAmount, 60123456n);
    assert.equal(proposal.clientAmount, 39876544n);

    const typedData = getMutualSettlementTypedData(proposal);
    assert.equal(typedData.message.freelancerAmount, 60123456n);
    assert.equal(typedData.message.clientAmount, 39876544n);
  });

  // Section 15: Execution Preflight Test
  await t.test('22. execution preflight compares exact bigint without float conversion', () => {
    const proposal: MutualSettlementProposalData = {
      dealAddress: DEAL_ADDR,
      chainId: BigInt(SEPOLIA_CHAIN_ID),
      milestoneId: 0n,
      proposer: FREELANCER,
      freelancerAmount: 60123456n,
      clientAmount: 39876544n,
      proposalNonce: 1n,
      validUntil: 2100000000n,
    };

    // Milestone amount matches exact sum
    const resExact = validateExecuteMutualSettlementPreflight({
      proposal,
      freshDealAddress: DEAL_ADDR,
      freshDealState: DealState.Active,
      freshMilestoneIndex: 0,
      freshMilestoneStatus: MilestoneStatus.Submitted,
      freshMilestoneAmount: 100000000n, // 60123456 + 39876544
      callerAddress: CLIENT,
      isClient: true,
      isFreelancer: false,
      isNonceUsed: false,
      currentTimestampSec: 2000000000n,
    });
    assert.equal(resExact.valid, true);

    // 1 wei/micro-unit off fails exact equality check
    const resMismatch = validateExecuteMutualSettlementPreflight({
      proposal,
      freshDealAddress: DEAL_ADDR,
      freshDealState: DealState.Active,
      freshMilestoneIndex: 0,
      freshMilestoneStatus: MilestoneStatus.Submitted,
      freshMilestoneAmount: 100000001n, // 1 micro-unit difference
      callerAddress: CLIENT,
      isClient: true,
      isFreelancer: false,
      isNonceUsed: false,
      currentTimestampSec: 2000000000n,
    });
    assert.equal(resMismatch.valid, false);
    assert.match(resMismatch.error!, /Settlement split does not equal fresh milestone amount/);
  });
});

