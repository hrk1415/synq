import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import {
  checkCommitteeSignerStatus,
  getCommitteeQueueItems,
  type CommitteeQueueItem,
} from '../src/lib/deals/committee-queue';
import { MilestoneStatus, DealState } from '../src/lib/deals/v2-deal';
import { SYNQ_V2_SEPOLIA_CONFIG } from '../src/lib/contracts/addresses';
import { PRIMARY_RESOLVER_SLA_SECONDS } from '../src/lib/deals/v2-resolution-report';

const SIGNER_PRIMARY = privateKeyToAccount('0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d');
const SIGNER_EMERGENCY = privateKeyToAccount('0x6cbed15c793ce57650b9877cf6fa156fbef513c4e6134f022a85b1ffdd59b2a1');
const NON_SIGNER = privateKeyToAccount('0x6370fd033278c143033d34f774182378f56ef7a9c82c66600000000000000001');

const DEAL_A = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const CLIENT_ADDR = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const FREELANCER_ADDR = '0x3333333333333333333333333333333333333333' as `0x${string}`;

function createMockPublicClient(options: {
  isPrimarySigner?: boolean;
  isEmergencySigner?: boolean;
  milestoneStatus?: MilestoneStatus;
  disputeOpenedAt?: bigint;
  proposalResolver?: string;
  blockTimestamp?: bigint;
}) {
  const timestamp = options.blockTimestamp ?? 1000000n;
  const isPrimary = options.isPrimarySigner ?? false;
  const isEmergency = options.isEmergencySigner ?? false;
  const status = options.milestoneStatus ?? MilestoneStatus.Disputed;
  const disputeOpenedAt = options.disputeOpenedAt ?? 100000n;
  const proposalResolver = options.proposalResolver ?? SYNQ_V2_SEPOLIA_CONFIG.primaryResolver;

  return {
    getBlock: async () => ({ timestamp }),
    readContract: async (args: any) => {
      const fn = args.functionName;
      const addr = (args.address || '').toLowerCase();

      if (fn === 'isSynqDeal') return true;

      if (fn === 'isSigner') {
        if (addr === SYNQ_V2_SEPOLIA_CONFIG.primaryResolver.toLowerCase()) {
          return isPrimary;
        }
        if (addr === SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver.toLowerCase()) {
          return isEmergency;
        }
        return false;
      }

      if (fn === 'state') return DealState.Active;
      if (fn === 'client') return CLIENT_ADDR;
      if (fn === 'freelancer') return FREELANCER_ADDR;
      if (fn === 'usdc') return SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc;
      if (fn === 'totalEscrow') return 1000000n;
      if (fn === 'totalSettled') return 0n;
      if (fn === 'milestoneCount') return 1n;
      if (fn === 'isProtected') return false;
      if (fn === 'policyId') return '0x0000000000000000000000000000000000000000000000000000000000000000';
      if (fn === 'primaryResolver') return SYNQ_V2_SEPOLIA_CONFIG.primaryResolver;
      if (fn === 'emergencyResolver') return SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver;

      if (fn === 'getMilestone') {
        return [
          1000000n, // amount
          2000000n, // workDeadline
          86400n,   // reviewWindow
          86400n,   // gracePeriod
          status,   // status
          '0x1111111111111111111111111111111111111111111111111111111111111111', // specHash
          '0x2222222222222222222222222222222222222222222222222222222222222222', // evidenceRootHash
          1500000n, // submittedAt
          1,        // version
        ];
      }

      if (fn === 'milestoneDisputeOpenedAt') return disputeOpenedAt;

      if (fn === 'getResolutionProposal') {
        return {
          freelancerAmount: 600000n,
          clientAmount: 400000n,
          justificationHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
          proposedAt: 1200000n,
          reconsiderationDeadline: 1459200n,
          resolver: proposalResolver,
        };
      }

      return null;
    },
  };
}

test('3M-G Signer Access Evaluation', async (t) => {
  await t.test('detects primary resolver signer correctly', async () => {
    const client = createMockPublicClient({ isPrimarySigner: true, isEmergencySigner: false });
    const status = await checkCommitteeSignerStatus(SIGNER_PRIMARY.address, client as any);
    assert.equal(status.isPrimarySigner, true);
    assert.equal(status.isEmergencySigner, false);
    assert.equal(status.isAnySigner, true);
  });

  await t.test('detects emergency resolver signer correctly', async () => {
    const client = createMockPublicClient({ isPrimarySigner: false, isEmergencySigner: true });
    const status = await checkCommitteeSignerStatus(SIGNER_EMERGENCY.address, client as any);
    assert.equal(status.isPrimarySigner, false);
    assert.equal(status.isEmergencySigner, true);
    assert.equal(status.isAnySigner, true);
  });

  await t.test('rejects non-signer cleanly', async () => {
    const client = createMockPublicClient({ isPrimarySigner: false, isEmergencySigner: false });
    const status = await checkCommitteeSignerStatus(NON_SIGNER.address, client as any);
    assert.equal(status.isPrimarySigner, false);
    assert.equal(status.isEmergencySigner, false);
    assert.equal(status.isAnySigner, false);
  });
});

test('3M-G Queue Discovery & Authorized Resolver Selection', async (t) => {
  await t.test('fails closed if caller is not an active signer', async () => {
    const client = createMockPublicClient({ isPrimarySigner: false, isEmergencySigner: false });
    await assert.rejects(
      async () => {
        await getCommitteeQueueItems({
          callerWallet: NON_SIGNER.address,
          candidateDeals: [DEAL_A],
          publicClient: client as any,
        });
      },
      /Caller is not an active signer on any resolution committee/
    );
  });

  await t.test('INITIAL Disputed before 14-day SLA boundary routes to Primary signer', async () => {
    const disputeOpenedAt = 100000n;
    // Current chain timestamp is well before disputeOpenedAt + 14 days (1,209,600s)
    const blockTimestamp = disputeOpenedAt + 1000n;

    const client = createMockPublicClient({
      isPrimarySigner: true,
      isEmergencySigner: false,
      milestoneStatus: MilestoneStatus.Disputed,
      disputeOpenedAt,
      blockTimestamp,
    });

    const items = await getCommitteeQueueItems({
      callerWallet: SIGNER_PRIMARY.address,
      candidateDeals: [DEAL_A],
      publicClient: client as any,
    });

    assert.equal(items.length, 1);
    assert.equal(items[0].phase, 'INITIAL_RESOLUTION');
    assert.equal(items[0].authorizedCommittee.toLowerCase(), SYNQ_V2_SEPOLIA_CONFIG.primaryResolver.toLowerCase());
  });

  await t.test('INITIAL Disputed after 14-day SLA boundary routes to Emergency signer', async () => {
    const disputeOpenedAt = 100000n;
    // Current chain timestamp is at or past disputeOpenedAt + 14 days
    const blockTimestamp = disputeOpenedAt + PRIMARY_RESOLVER_SLA_SECONDS + 50n;

    const client = createMockPublicClient({
      isPrimarySigner: false,
      isEmergencySigner: true,
      milestoneStatus: MilestoneStatus.Disputed,
      disputeOpenedAt,
      blockTimestamp,
    });

    const items = await getCommitteeQueueItems({
      callerWallet: SIGNER_EMERGENCY.address,
      candidateDeals: [DEAL_A],
      publicClient: client as any,
    });

    assert.equal(items.length, 1);
    assert.equal(items[0].phase, 'INITIAL_RESOLUTION');
    assert.equal(items[0].authorizedCommittee.toLowerCase(), SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver.toLowerCase());
  });

  await t.test('FINAL FinalReview routes strictly to stored proposal resolver (Primary)', async () => {
    // Even if 30 days have passed since dispute opened, FinalReview does NOT re-select resolver
    const disputeOpenedAt = 100000n;
    const blockTimestamp = disputeOpenedAt + PRIMARY_RESOLVER_SLA_SECONDS * 2n;

    const client = createMockPublicClient({
      isPrimarySigner: true,
      isEmergencySigner: false,
      milestoneStatus: MilestoneStatus.FinalReview,
      disputeOpenedAt,
      blockTimestamp,
      proposalResolver: SYNQ_V2_SEPOLIA_CONFIG.primaryResolver,
    });

    const items = await getCommitteeQueueItems({
      callerWallet: SIGNER_PRIMARY.address,
      candidateDeals: [DEAL_A],
      publicClient: client as any,
    });

    assert.equal(items.length, 1);
    assert.equal(items[0].phase, 'FINAL_RESOLUTION');
    assert.equal(items[0].authorizedCommittee.toLowerCase(), SYNQ_V2_SEPOLIA_CONFIG.primaryResolver.toLowerCase());
  });

  await t.test('Emergency signer cannot view FinalReview owned by Primary resolver', async () => {
    const disputeOpenedAt = 100000n;
    const blockTimestamp = disputeOpenedAt + PRIMARY_RESOLVER_SLA_SECONDS * 2n;

    const client = createMockPublicClient({
      isPrimarySigner: false,
      isEmergencySigner: true,
      milestoneStatus: MilestoneStatus.FinalReview,
      disputeOpenedAt,
      blockTimestamp,
      proposalResolver: SYNQ_V2_SEPOLIA_CONFIG.primaryResolver, // Primary owns it
    });

    const items = await getCommitteeQueueItems({
      callerWallet: SIGNER_EMERGENCY.address,
      candidateDeals: [DEAL_A],
      publicClient: client as any,
    });

    // Emergency signer should see 0 items because proposal was resolved by Primary
    assert.equal(items.length, 0);
  });
});

test('3M-G Financial Precision & Participant Settlement View Safeguards', async (t) => {
  await t.test('financial parsing safely handles 6-decimal USDC base-units without float conversion', async () => {
    const { parseUsdcAmount, formatUsdcAmount } = await import('../src/lib/deals/v2');
    // Amount that would suffer from IEEE 754 float precision loss: 1234567.890123
    const parsed = parseUsdcAmount('1234567.890123');
    assert.equal(parsed, 1234567890123n);
    assert.equal(formatUsdcAmount(parsed), '1234567.890123');

    // Float addition vs bigint addition
    const partA = parseUsdcAmount('0.100000');
    const partB = parseUsdcAmount('0.200000');
    const total = partA + partB;
    assert.equal(total, 300000n);
    assert.equal(formatUsdcAmount(total), '0.3');
  });

  await t.test('disallows invalid financial input strings in parseUsdcAmount', async () => {
    const { parseUsdcAmount } = await import('../src/lib/deals/v2');
    assert.throws(() => parseUsdcAmount(''), /cannot be empty/);
    assert.throws(() => parseUsdcAmount('-10.5'), /Invalid USDC amount format/);
    assert.throws(() => parseUsdcAmount('10.1234567'), /cannot exceed 6 decimal places/);
    assert.throws(() => parseUsdcAmount('abc'), /Invalid USDC amount format/);
  });
});

