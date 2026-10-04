import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters } from 'viem';
import {
  DealState,
  MilestoneStatus,
  StandardV2OnChainMilestone,
  validateRequestChangesPreflight,
  verifyRevisionRequestedReceipt,
  validateAcceptRevisionPreflight,
  verifyAcceptRevisionReceipt,
  validateDeclineRevisionPreflight,
  verifyDeclineRevisionReceipt,
  validateTimeoutRevisionResponsePreflight,
  verifyTimeoutRevisionResponseReceipt,
  determineRequestChangesEligibility,
  determineFreelancerRevisionResponseEligibility,
  determineTimeoutRevisionResponseEligibility,
  hashRevisionManifest,
  REVISION_RESPONSE_WINDOW,
} from '../src/lib/deals/v2-deal';
import { SEPOLIA_CHAIN_ID } from '../src/lib/chain';

const CLIENT = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const FREELANCER = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const OTHER = '0x3333333333333333333333333333333333333333' as `0x${string}`;
const DEAL_ADDR = '0x4444444444444444444444444444444444444444' as `0x${string}`;

const SAMPLE_SPEC_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
const SAMPLE_EVIDENCE_HASH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;
const SAMPLE_REASON_HASH = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' as `0x${string}`;

function createSampleMilestone(overrides: Partial<StandardV2OnChainMilestone> = {}): StandardV2OnChainMilestone {
  return {
    index: 0,
    amount: 1000_000000n,
    specHash: SAMPLE_SPEC_HASH,
    workDeadline: 2000000000n,
    reviewWindow: 259200n,
    gracePeriod: 86400n,
    status: MilestoneStatus.Submitted,
    submittedAt: 1999900000n,
    evidenceRootHash: SAMPLE_EVIDENCE_HASH,
    version: 1,
    proposedRevisionDeadline: 0n,
    revisionRequestedAt: 0n,
    ...overrides,
  };
}

function createSampleManifest(overrides: Record<string, any> = {}) {
  return {
    schemaVersion: 1,
    chainId: SEPOLIA_CHAIN_ID,
    dealAddress: DEAL_ADDR,
    milestoneId: 0,
    submissionVersion: 1,
    specHash: SAMPLE_SPEC_HASH,
    evidenceRootHash: SAMPLE_EVIDENCE_HASH,
    clientWallet: CLIENT,
    freelancerWallet: FREELANCER,
    feedback: 'Please update documentation and API endpoints.',
    proposedRevisionDeadline: 2050000000,
    ...overrides,
  };
}

test('SynqV2RevisionDispute - Canonical Reason Hash Determinism', async (t) => {
  await t.test('computes deterministic keccak256 hash for identical manifest input', () => {
    const manifest = createSampleManifest();
    const hash1 = hashRevisionManifest(manifest);
    const hash2 = hashRevisionManifest(manifest);
    assert.equal(hash1, hash2);
    assert.match(hash1, /^0x[a-f0-9]{64}$/i);
  });

  await t.test('handles whitespace normalization in feedback', () => {
    const hash1 = hashRevisionManifest(createSampleManifest({ feedback: 'Fix documentation' }));
    const hash2 = hashRevisionManifest(createSampleManifest({ feedback: '   Fix documentation   ' }));
    assert.equal(hash1, hash2);
  });

  await t.test('produces distinct hashes for different deadlines or feedback', () => {
    const hash1 = hashRevisionManifest(createSampleManifest({ proposedRevisionDeadline: 2050000000 }));
    const hash2 = hashRevisionManifest(createSampleManifest({ proposedRevisionDeadline: 2050000001 }));
    const hash3 = hashRevisionManifest(createSampleManifest({ feedback: 'Different feedback text' }));
    assert.notEqual(hash1, hash2);
    assert.notEqual(hash1, hash3);
  });
});

test('SynqV2RevisionDispute - Request Changes Preflight Validation', async (t) => {
  const futureDeadline = 2010000000n;
  const currentTimestamp = 2000000000n;
  const validMilestone = createSampleMilestone();

  await t.test('valid preflight passes all integrity constraints', () => {
    const result = validateRequestChangesPreflight({
      connectedWallet: CLIENT,
      clientAddress: CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealState: DealState.Active,
      isProtected: false,
      targetMilestoneIndex: 0,
      milestones: [validMilestone],
      currentTimeSeconds: currentTimestamp,
      stagedRevision: {
        submissionVersion: 1,
        specHash: SAMPLE_SPEC_HASH,
        evidenceRootHash: SAMPLE_EVIDENCE_HASH,
        proposedRevisionDeadline: futureDeadline,
      },
    });
    assert.equal(result.valid, true);
    assert.equal(result.error, undefined);
  });

  await t.test('fails if caller is not the client', () => {
    const result = validateRequestChangesPreflight({
      connectedWallet: FREELANCER,
      clientAddress: CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealState: DealState.Active,
      isProtected: false,
      targetMilestoneIndex: 0,
      milestones: [validMilestone],
      currentTimeSeconds: currentTimestamp,
      stagedRevision: {
        submissionVersion: 1,
        specHash: SAMPLE_SPEC_HASH,
        evidenceRootHash: SAMPLE_EVIDENCE_HASH,
        proposedRevisionDeadline: futureDeadline,
      },
    });
    assert.equal(result.valid, false);
    assert.match(result.error!, /Only the designated client/i);
  });

  await t.test('fails if chainId is not Sepolia', () => {
    const result = validateRequestChangesPreflight({
      connectedWallet: CLIENT,
      clientAddress: CLIENT,
      chainId: 1,
      isCanonicalV2Deal: true,
      dealState: DealState.Active,
      isProtected: false,
      targetMilestoneIndex: 0,
      milestones: [validMilestone],
      currentTimeSeconds: currentTimestamp,
      stagedRevision: {
        submissionVersion: 1,
        specHash: SAMPLE_SPEC_HASH,
        evidenceRootHash: SAMPLE_EVIDENCE_HASH,
        proposedRevisionDeadline: futureDeadline,
      },
    });
    assert.equal(result.valid, false);
    assert.match(result.error!, /Invalid network/i);
  });

  await t.test('fails if deal is protected (Standard deals only)', () => {
    const result = validateRequestChangesPreflight({
      connectedWallet: CLIENT,
      clientAddress: CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealState: DealState.Active,
      isProtected: true,
      targetMilestoneIndex: 0,
      milestones: [validMilestone],
      currentTimeSeconds: currentTimestamp,
      stagedRevision: {
        submissionVersion: 1,
        specHash: SAMPLE_SPEC_HASH,
        evidenceRootHash: SAMPLE_EVIDENCE_HASH,
        proposedRevisionDeadline: futureDeadline,
      },
    });
    assert.equal(result.valid, false);
    assert.match(result.error!, /Protected deals cannot request revision/i);
  });

  await t.test('fails if deal state is not Active', () => {
    const result = validateRequestChangesPreflight({
      connectedWallet: CLIENT,
      clientAddress: CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealState: DealState.Completed,
      isProtected: false,
      targetMilestoneIndex: 0,
      milestones: [validMilestone],
      currentTimeSeconds: currentTimestamp,
      stagedRevision: {
        submissionVersion: 1,
        specHash: SAMPLE_SPEC_HASH,
        evidenceRootHash: SAMPLE_EVIDENCE_HASH,
        proposedRevisionDeadline: futureDeadline,
      },
    });
    assert.equal(result.valid, false);
    assert.match(result.error!, /not in Active state/i);
  });

  await t.test('fails if milestone status is not Submitted', () => {
    const inProgressMilestone = createSampleMilestone({ status: MilestoneStatus.InProgress });
    const result = validateRequestChangesPreflight({
      connectedWallet: CLIENT,
      clientAddress: CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealState: DealState.Active,
      isProtected: false,
      targetMilestoneIndex: 0,
      milestones: [inProgressMilestone],
      currentTimeSeconds: currentTimestamp,
      stagedRevision: {
        submissionVersion: 1,
        specHash: SAMPLE_SPEC_HASH,
        evidenceRootHash: SAMPLE_EVIDENCE_HASH,
        proposedRevisionDeadline: futureDeadline,
      },
    });
    assert.equal(result.valid, false);
    assert.match(result.error!, /not in Submitted status/i);
  });

  await t.test('fails if proposed revision deadline is not in the future', () => {
    const result = validateRequestChangesPreflight({
      connectedWallet: CLIENT,
      clientAddress: CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealState: DealState.Active,
      isProtected: false,
      targetMilestoneIndex: 0,
      milestones: [validMilestone],
      currentTimeSeconds: currentTimestamp,
      stagedRevision: {
        submissionVersion: 1,
        specHash: SAMPLE_SPEC_HASH,
        evidenceRootHash: SAMPLE_EVIDENCE_HASH,
        proposedRevisionDeadline: currentTimestamp - 10n,
      },
    });
    assert.equal(result.valid, false);
    assert.match(result.error!, /strictly in the future/i);
  });

  await t.test('fails if submission version mismatches on-chain version', () => {
    const result = validateRequestChangesPreflight({
      connectedWallet: CLIENT,
      clientAddress: CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealState: DealState.Active,
      isProtected: false,
      targetMilestoneIndex: 0,
      milestones: [validMilestone],
      currentTimeSeconds: currentTimestamp,
      stagedRevision: {
        submissionVersion: 2, // on-chain is 1
        specHash: SAMPLE_SPEC_HASH,
        evidenceRootHash: SAMPLE_EVIDENCE_HASH,
        proposedRevisionDeadline: futureDeadline,
      },
    });
    assert.equal(result.valid, false);
    assert.match(result.error!, /version mismatch/i);
  });
});

test('SynqV2RevisionDispute - Request Changes Receipt Verification', async (t) => {
  const milestoneId = 0n;
  const reasonHash = SAMPLE_REASON_HASH;
  const proposedDeadline = 2050000000n;

  // event RevisionRequested(uint256 indexed milestoneId, bytes32 indexed reasonHash, uint64 proposedRevisionDeadline)
  const [topic0] = encodeEventTopics({
    abi: [{
      type: 'event',
      name: 'RevisionRequested',
      inputs: [
        { type: 'uint256', name: 'milestoneId', indexed: true },
        { type: 'bytes32', name: 'reasonHash', indexed: true },
        { type: 'uint64', name: 'proposedRevisionDeadline', indexed: false },
      ],
    }],
    eventName: 'RevisionRequested',
    args: { milestoneId, reasonHash },
  });

  const nonIndexedData = encodeAbiParameters(parseAbiParameters('uint64'), [proposedDeadline]);

  const validReceipt = {
    status: 'success',
    logs: [{
      address: DEAL_ADDR,
      topics: [
        topic0,
        encodeAbiParameters(parseAbiParameters('uint256'), [milestoneId]),
        encodeAbiParameters(parseAbiParameters('bytes32'), [reasonHash]),
      ],
      data: nonIndexedData,
    }],
  };

  await t.test('verifies receipt containing correct RevisionRequested event', () => {
    const result = verifyRevisionRequestedReceipt(
      validReceipt,
      DEAL_ADDR,
      milestoneId,
      reasonHash,
      proposedDeadline
    );
    assert.equal(result.valid, true);
    assert.equal(result.error, undefined);
  });

  await t.test('fails if receipt status is reverted', () => {
    const revertedReceipt = { ...validReceipt, status: 'reverted' };
    const result = verifyRevisionRequestedReceipt(
      revertedReceipt,
      DEAL_ADDR,
      milestoneId,
      reasonHash,
      proposedDeadline
    );
    assert.equal(result.valid, false);
    assert.match(result.error!, /reverted/i);
  });

  await t.test('fails if event was emitted by different contract', () => {
    const otherDealReceipt = {
      ...validReceipt,
      logs: [{ ...validReceipt.logs[0], address: OTHER }],
    };
    const result = verifyRevisionRequestedReceipt(
      otherDealReceipt,
      DEAL_ADDR,
      milestoneId,
      reasonHash,
      proposedDeadline
    );
    assert.equal(result.valid, false);
    assert.match(result.error!, /did not contain a matching RevisionRequested event/i);
  });

  await t.test('fails if reasonHash does not match expected staged hash', () => {
    const differentHash = '0x9999999999999999999999999999999999999999999999999999999999999999' as `0x${string}`;
    const result = verifyRevisionRequestedReceipt(
      validReceipt,
      DEAL_ADDR,
      milestoneId,
      differentHash,
      proposedDeadline
    );
    assert.equal(result.valid, false);
    assert.match(result.error!, /unexpected reasonHash/i);
  });
});

test('SynqV2RevisionDispute - Freelancer Accept Revision Preflight & Receipt', async (t) => {
  const currentTimestamp = 2000000000n;
  const proposedDeadline = 2020000000n;
  const revisionMilestone = createSampleMilestone({
    status: MilestoneStatus.RevisionRequested,
    proposedRevisionDeadline: proposedDeadline,
    revisionRequestedAt: 1999950000n,
  });

  await t.test('valid accept preflight passes constraints', () => {
    const result = validateAcceptRevisionPreflight({
      connectedWallet: FREELANCER,
      freelancerAddress: FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealState: DealState.Active,
      targetMilestoneIndex: 0,
      milestones: [revisionMilestone],
      proposedRevisionDeadline: proposedDeadline,
      currentTimeSeconds: currentTimestamp,
    });
    assert.equal(result.valid, true);
  });

  await t.test('fails if caller is not the freelancer', () => {
    const result = validateAcceptRevisionPreflight({
      connectedWallet: CLIENT,
      freelancerAddress: FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealState: DealState.Active,
      targetMilestoneIndex: 0,
      milestones: [revisionMilestone],
      proposedRevisionDeadline: proposedDeadline,
      currentTimeSeconds: currentTimestamp,
    });
    assert.equal(result.valid, false);
    assert.match(result.error!, /Only the designated freelancer/i);
  });

  await t.test('fails if milestone status is not RevisionRequested', () => {
    const submittedMilestone = createSampleMilestone({ status: MilestoneStatus.Submitted });
    const result = validateAcceptRevisionPreflight({
      connectedWallet: FREELANCER,
      freelancerAddress: FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealState: DealState.Active,
      targetMilestoneIndex: 0,
      milestones: [submittedMilestone],
      proposedRevisionDeadline: proposedDeadline,
      currentTimeSeconds: currentTimestamp,
    });
    assert.equal(result.valid, false);
    assert.match(result.error!, /not in RevisionRequested status/i);
  });

  await t.test('fails if proposed revision deadline is in the past', () => {
    const expiredRevisionMilestone = createSampleMilestone({
      status: MilestoneStatus.RevisionRequested,
      proposedRevisionDeadline: currentTimestamp - 100n,
    });
    const result = validateAcceptRevisionPreflight({
      connectedWallet: FREELANCER,
      freelancerAddress: FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealState: DealState.Active,
      targetMilestoneIndex: 0,
      milestones: [expiredRevisionMilestone],
      proposedRevisionDeadline: currentTimestamp - 100n,
      currentTimeSeconds: currentTimestamp,
    });
    assert.equal(result.valid, false);
    assert.match(result.error!, /already expired/i);
  });

  await t.test('verifies receipt containing RevisionAccepted event', () => {
    const milestoneId = 0n;
    // ISynqDeal defines: event RevisionAccepted(uint256 indexed milestoneId, uint64 newDeadline)
    const [topic0] = encodeEventTopics({
      abi: [{
        type: 'event',
        name: 'RevisionAccepted',
        inputs: [
          { type: 'uint256', name: 'milestoneId', indexed: true },
          { type: 'uint64', name: 'newDeadline', indexed: false },
        ],
      }],
      eventName: 'RevisionAccepted',
      args: { milestoneId },
    });

    const nonIndexedData = encodeAbiParameters(parseAbiParameters('uint64'), [proposedDeadline]);

    const receipt = {
      status: 'success',
      logs: [{
        address: DEAL_ADDR,
        topics: [topic0, encodeAbiParameters(parseAbiParameters('uint256'), [milestoneId])],
        data: nonIndexedData,
      }],
    };

    const result = verifyAcceptRevisionReceipt(receipt, DEAL_ADDR, milestoneId, proposedDeadline);
    assert.equal(result.valid, true);
  });
});

test('SynqV2RevisionDispute - Freelancer Decline Revision Preflight & Receipt', async (t) => {
  const revisionMilestone = createSampleMilestone({
    status: MilestoneStatus.RevisionRequested,
    proposedRevisionDeadline: 2020000000n,
    revisionRequestedAt: 1999950000n,
  });

  await t.test('valid decline preflight passes constraints', () => {
    const result = validateDeclineRevisionPreflight({
      connectedWallet: FREELANCER,
      freelancerAddress: FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealState: DealState.Active,
      targetMilestoneIndex: 0,
      milestones: [revisionMilestone],
    });
    assert.equal(result.valid, true);
  });

  await t.test('fails if caller is not the freelancer', () => {
    const result = validateDeclineRevisionPreflight({
      connectedWallet: CLIENT,
      freelancerAddress: FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealState: DealState.Active,
      targetMilestoneIndex: 0,
      milestones: [revisionMilestone],
    });
    assert.equal(result.valid, false);
    assert.match(result.error!, /Only the designated freelancer/i);
  });

  await t.test('verifies receipt containing RevisionDeclined and MilestoneDisputed events', () => {
    const milestoneId = 0n;
    const [revDeclinedTopic0] = encodeEventTopics({
      abi: [{
        type: 'event',
        name: 'RevisionDeclined',
        inputs: [{ type: 'uint256', name: 'milestoneId', indexed: true }],
      }],
      eventName: 'RevisionDeclined',
      args: { milestoneId },
    });

    // event MilestoneDisputed(uint256 indexed milestoneId, address indexed opener, bytes32 reasonHash)
    const [milestoneDisputedTopic0] = encodeEventTopics({
      abi: [{
        type: 'event',
        name: 'MilestoneDisputed',
        inputs: [
          { type: 'uint256', name: 'milestoneId', indexed: true },
          { type: 'address', name: 'opener', indexed: true },
          { type: 'bytes32', name: 'reasonHash', indexed: false },
        ],
      }],
      eventName: 'MilestoneDisputed',
      args: { milestoneId, opener: FREELANCER },
    });

    const receipt = {
      status: 'success',
      logs: [
        {
          address: DEAL_ADDR,
          topics: [revDeclinedTopic0, encodeAbiParameters(parseAbiParameters('uint256'), [milestoneId])],
          data: '0x' as `0x${string}`,
        },
        {
          address: DEAL_ADDR,
          topics: [
            milestoneDisputedTopic0,
            encodeAbiParameters(parseAbiParameters('uint256'), [milestoneId]),
            encodeAbiParameters(parseAbiParameters('address'), [FREELANCER]),
          ],
          data: encodeAbiParameters(parseAbiParameters('bytes32'), [SAMPLE_REASON_HASH]),
        },
      ],
    };

    const result = verifyDeclineRevisionReceipt(receipt, DEAL_ADDR, milestoneId);
    assert.equal(result.valid, true);
  });
});

test('SynqV2RevisionDispute - Permissionless Revision Timeout Preflight & Receipt', async (t) => {
  const revisionRequestedAt = 2000000000n;
  const timeoutDeadline = revisionRequestedAt + REVISION_RESPONSE_WINDOW; // exactly 48h later
  const revisionMilestone = createSampleMilestone({
    status: MilestoneStatus.RevisionRequested,
    revisionRequestedAt,
  });

  await t.test('fails if current timestamp is strictly before or at 48 hours', () => {
    // 1 second before
    const resultBefore = validateTimeoutRevisionResponsePreflight({
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealState: DealState.Active,
      targetMilestoneIndex: 0,
      milestones: [revisionMilestone],
      revisionRequestedAt,
      currentTimeSeconds: timeoutDeadline - 1n,
    });
    assert.equal(resultBefore.valid, false);
    assert.match(resultBefore.error!, /not expired/i);

    // Exactly at boundary (contract uses strictly >)
    const resultAtBoundary = validateTimeoutRevisionResponsePreflight({
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealState: DealState.Active,
      targetMilestoneIndex: 0,
      milestones: [revisionMilestone],
      revisionRequestedAt,
      currentTimeSeconds: timeoutDeadline,
    });
    assert.equal(resultAtBoundary.valid, false);
    assert.match(resultAtBoundary.error!, /not expired/i);
  });

  await t.test('passes strictly after 48 hours', () => {
    const result = validateTimeoutRevisionResponsePreflight({
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealState: DealState.Active,
      targetMilestoneIndex: 0,
      milestones: [revisionMilestone],
      revisionRequestedAt,
      currentTimeSeconds: timeoutDeadline + 1n,
    });
    assert.equal(result.valid, true);
  });

  await t.test('verifies receipt containing MilestoneDisputed event', () => {
    const milestoneId = 0n;
    const [milestoneDisputedTopic0] = encodeEventTopics({
      abi: [{
        type: 'event',
        name: 'MilestoneDisputed',
        inputs: [
          { type: 'uint256', name: 'milestoneId', indexed: true },
          { type: 'address', name: 'opener', indexed: true },
          { type: 'bytes32', name: 'reasonHash', indexed: false },
        ],
      }],
      eventName: 'MilestoneDisputed',
      args: { milestoneId, opener: '0x0000000000000000000000000000000000000000' },
    });

    const receipt = {
      status: 'success',
      logs: [{
        address: DEAL_ADDR,
        topics: [
          milestoneDisputedTopic0,
          encodeAbiParameters(parseAbiParameters('uint256'), [milestoneId]),
          encodeAbiParameters(parseAbiParameters('address'), ['0x0000000000000000000000000000000000000000']),
        ],
        data: encodeAbiParameters(parseAbiParameters('bytes32'), [SAMPLE_REASON_HASH]),
      }],
    };

    const result = verifyTimeoutRevisionResponseReceipt(receipt, DEAL_ADDR, milestoneId);
    assert.equal(result.valid, true);
  });
});

test('SynqV2RevisionDispute - Action Eligibility Evaluation Helpers', async (t) => {
  const submittedMilestone = createSampleMilestone({ status: MilestoneStatus.Submitted });
  const revisionMilestone = createSampleMilestone({
    status: MilestoneStatus.RevisionRequested,
    proposedRevisionDeadline: 2500000000n, // safely in future
    revisionRequestedAt: 2000000000n,
  });

  await t.test('determineRequestChangesEligibility allows client on submitted milestone with verified evidence', () => {
    const clientElig = determineRequestChangesEligibility({
      connectedWallet: CLIENT,
      clientAddress: CLIENT,
      freelancerAddress: FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Active,
      milestones: [submittedMilestone],
      isProtected: false,
      targetMilestoneIndex: 0,
      hasVerifiedEvidence: true,
    });
    assert.equal(clientElig.canRequestChanges, true);

    // Freelancer cannot request changes
    const freeElig = determineRequestChangesEligibility({
      connectedWallet: FREELANCER,
      clientAddress: CLIENT,
      freelancerAddress: FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Active,
      milestones: [submittedMilestone],
      isProtected: false,
      targetMilestoneIndex: 0,
      hasVerifiedEvidence: true,
    });
    assert.equal(freeElig.canRequestChanges, false);
  });

  await t.test('determineFreelancerRevisionResponseEligibility allows freelancer to accept/decline', () => {
    const freeElig = determineFreelancerRevisionResponseEligibility({
      connectedWallet: FREELANCER,
      clientAddress: CLIENT,
      freelancerAddress: FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Active,
      milestones: [revisionMilestone],
      targetMilestoneIndex: 0,
      currentTimeSeconds: 2000000000n,
    });
    assert.equal(freeElig.canAccept, true);
    assert.equal(freeElig.canDecline, true);

    // Client cannot accept or decline
    const clientElig = determineFreelancerRevisionResponseEligibility({
      connectedWallet: CLIENT,
      clientAddress: CLIENT,
      freelancerAddress: FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Active,
      milestones: [revisionMilestone],
      targetMilestoneIndex: 0,
      currentTimeSeconds: 2000000000n,
    });
    assert.equal(clientElig.canAccept, false);
    assert.equal(clientElig.canDecline, false);
  });

  await t.test('determineTimeoutRevisionResponseEligibility evaluates expiration strictly', () => {
    const requestedAt = 2000000000n;
    const timeoutDeadline = requestedAt + REVISION_RESPONSE_WINDOW;

    // Before expiration
    const beforeElig = determineTimeoutRevisionResponseEligibility({
      dealState: DealState.Active,
      milestones: [revisionMilestone],
      currentTimeSeconds: timeoutDeadline - 10n,
      targetMilestoneIndex: 0,
    });
    assert.equal(beforeElig.isExpired, false);
    assert.equal(beforeElig.canTimeout, false);

    // After expiration
    const afterElig = determineTimeoutRevisionResponseEligibility({
      dealState: DealState.Active,
      milestones: [revisionMilestone],
      currentTimeSeconds: timeoutDeadline + 10n,
      targetMilestoneIndex: 0,
    });
    assert.equal(afterElig.isExpired, true);
    assert.equal(afterElig.canTimeout, true);
  });
});
