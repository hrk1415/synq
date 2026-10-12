import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeEventTopics, encodeAbiParameters } from 'viem';
import {
  MUTUAL_SETTLEMENT_EIP712_NAME,
  MUTUAL_SETTLEMENT_EIP712_VERSION,
  MUTUAL_SETTLEMENT_TYPES,
  getMutualSettlementEIP712Domain,
  getMutualSettlementTypedData,
  normalizeMutualSettlementProposal,
  verifyMutualSettlementSignature,
  verifyMutualSettlementReceipt,
  verifyProposalCancelledReceipt,
  determineMutualSettlementEligibility,
  MutualSettlementValidationError,
} from '../src/lib/deals/v2-mutual-settlement';
import {
  createMutualSettlementProposal,
  reconcileMutualSettlementExecution,
  reconcileMutualSettlementCancel,
  getMutualSettlementProposals,
  MutualSettlementAuthError,
  MutualSettlementConflictError,
  MutualSettlementIntegrityError,
  type IMutualSettlementRepository,
} from '../src/lib/deals/mutual-settlements-db';
import { DealState, MilestoneStatus } from '../src/lib/deals/v2-deal';
import { SYNQ_V2_SEPOLIA_CONFIG } from '../src/lib/contracts/addresses';
import { synqDealV1ABI } from '../src/lib/contracts/abis';
import type { MutualSettlementProposalRow, NewMutualSettlementProposalRow } from '../src/db/schema';

// Mock in-memory repository
class MockMutualSettlementRepository implements IMutualSettlementRepository {
  private rows: Map<string, MutualSettlementProposalRow> = new Map();

  async getById(id: string): Promise<MutualSettlementProposalRow | null> {
    return this.rows.get(id) ?? null;
  }

  async listByMilestone(
    chainId: number,
    dealAddress: string,
    milestoneId: number
  ): Promise<MutualSettlementProposalRow[]> {
    return Array.from(this.rows.values()).filter(
      (r) =>
        r.chainId === chainId &&
        r.dealAddress.toLowerCase() === dealAddress.toLowerCase() &&
        r.milestoneId === milestoneId
    );
  }

  async getByNonce(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    proposerWallet: string,
    proposalNonce: string
  ): Promise<MutualSettlementProposalRow | null> {
    return (
      Array.from(this.rows.values()).find(
        (r) =>
          r.chainId === chainId &&
          r.dealAddress.toLowerCase() === dealAddress.toLowerCase() &&
          r.milestoneId === milestoneId &&
          r.proposerWallet.toLowerCase() === proposerWallet.toLowerCase() &&
          r.proposalNonce === proposalNonce
      ) ?? null
    );
  }

  async create(row: NewMutualSettlementProposalRow): Promise<MutualSettlementProposalRow> {
    const id = row.id ?? `proposal-${Date.now()}-${Math.random()}`;
    const fullRow: MutualSettlementProposalRow = {
      id,
      chainId: row.chainId,
      dealAddress: row.dealAddress.toLowerCase(),
      milestoneId: row.milestoneId,
      proposerWallet: row.proposerWallet.toLowerCase(),
      counterpartyWallet: row.counterpartyWallet.toLowerCase(),
      freelancerAmount: row.freelancerAmount,
      clientAmount: row.clientAmount,
      proposalNonce: row.proposalNonce,
      validUntil: row.validUntil,
      signature: row.signature.toLowerCase(),
      status: row.status ?? 'pending',
      executionTxHash: row.executionTxHash ?? null,
      cancellationTxHash: row.cancellationTxHash ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.set(id, fullRow);
    return fullRow;
  }

  async updateStatus(
    id: string,
    status: 'pending' | 'executed' | 'cancelled' | 'invalidated',
    hashes?: { executionTxHash?: string | null; cancellationTxHash?: string | null }
  ): Promise<MutualSettlementProposalRow> {
    const existing = this.rows.get(id);
    if (!existing) throw new Error('Not found');
    const updated: MutualSettlementProposalRow = {
      ...existing,
      status,
      executionTxHash: hashes?.executionTxHash !== undefined ? (hashes.executionTxHash ? hashes.executionTxHash.toLowerCase() : null) : existing.executionTxHash,
      cancellationTxHash: hashes?.cancellationTxHash !== undefined ? (hashes.cancellationTxHash ? hashes.cancellationTxHash.toLowerCase() : null) : existing.cancellationTxHash,
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async invalidateOtherPending(
    chainId: number,
    dealAddress: string,
    milestoneId: number,
    executedProposalId: string
  ): Promise<void> {
    for (const [id, row] of this.rows.entries()) {
      if (
        row.chainId === chainId &&
        row.dealAddress.toLowerCase() === dealAddress.toLowerCase() &&
        row.milestoneId === milestoneId &&
        id !== executedProposalId &&
        row.status === 'pending'
      ) {
        this.rows.set(id, {
          ...row,
          status: 'invalidated',
          updatedAt: new Date(),
        });
      }
    }
  }
}

// Deterministic test accounts
const CLIENT_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const FREELANCER_KEY = '0x2222222222222222222222222222222222222222222222222222222222222222' as const;
const OUTSIDER_KEY = '0x3333333333333333333333333333333333333333333333333333333333333333' as const;

const clientAccount = privateKeyToAccount(CLIENT_KEY);
const freelancerAccount = privateKeyToAccount(FREELANCER_KEY);
const outsiderAccount = privateKeyToAccount(OUTSIDER_KEY);

const DEAL_ADDR = '0x4444444444444444444444444444444444444444' as const;
const CHAIN_ID = 11155111;

function createMockPublicClient(dealState: DealState, milestoneStatus: MilestoneStatus, milestoneOverrides = {}) {
  const usedNonces = new Set<string>();

  return {
    usedNonces,
    readContract: async ({ functionName, args }: any) => {
      if (functionName === 'isSynqDeal' || functionName === 'isDeal') return true;
      if (functionName === 'state') return dealState;
      if (functionName === 'isProtected') return false;
      if (functionName === 'client') return clientAccount.address;
      if (functionName === 'freelancer') return freelancerAccount.address;
      if (functionName === 'usdc') return SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc;
      if (functionName === 'totalEscrow') return 1000000000n;
      if (functionName === 'totalSettled') return 0n;
      if (functionName === 'milestoneCount') return 1n;
      if (functionName === 'policyId') return '0x0000000000000000000000000000000000000000000000000000000000000000';
      if (functionName === 'primaryResolver') return '0x0000000000000000000000000000000000000000';
      if (functionName === 'emergencyResolver') return '0x0000000000000000000000000000000000000000';
      if (functionName === 'proposedRevisionDeadlines') return 0n;
      if (functionName === 'revisionRequestedAt') return 0n;
      if (functionName === 'getMilestone' || functionName === 'milestones') {
        return {
          amount: 1000000000n, // 1000 USDC
          workDeadline: 2000000000n,
          reviewWindow: 604800n,
          gracePeriod: 86400n,
          status: milestoneStatus,
          specHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          evidenceRootHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          submittedAt: 1900000000n,
          version: 1n,
          ...milestoneOverrides,
        };
      }
      if (functionName === 'usedProposalNonces') {
        const [mId, proposer, nonce] = args;
        const k = `${mId}:${proposer.toLowerCase()}:${nonce.toString()}`;
        return usedNonces.has(k);
      }
      throw new Error(`Unhandled mock function ${functionName}`);
    },
    getTransactionReceipt: async () => null,
  };
}

test('SYNQ Phase 3L-C: Mutual Settlement EIP-712 & Database Suite', async (t) => {
  await t.test('1. Normalizes valid mutual settlement proposal', () => {
    const normalized = normalizeMutualSettlementProposal({
      chainId: CHAIN_ID,
      dealAddress: DEAL_ADDR.toUpperCase(),
      milestoneId: 0,
      proposer: clientAccount.address,
      freelancerAmount: '600000000',
      clientAmount: '400000000',
      proposalNonce: '0',
      validUntil: '1999999999',
    });

    assert.equal(normalized.chainId, BigInt(CHAIN_ID));
    assert.equal(normalized.dealAddress, DEAL_ADDR.toLowerCase());
    assert.equal(normalized.milestoneId, 0n);
    assert.equal(normalized.proposer, clientAccount.address.toLowerCase());
    assert.equal(normalized.freelancerAmount, 600000000n);
    assert.equal(normalized.clientAmount, 400000000n);
    assert.equal(normalized.proposalNonce, 0n);
    assert.equal(normalized.validUntil, 1999999999n);
  });

  await t.test('2. Rejects negative or non-integer amounts', () => {
    assert.throws(
      () =>
        normalizeMutualSettlementProposal({
          chainId: CHAIN_ID,
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          proposer: clientAccount.address,
          freelancerAmount: '-1',
          clientAmount: '100',
          proposalNonce: '0',
          validUntil: '1999999999',
        }),
      /cannot be negative/
    );
  });

  await t.test('3. Rejects uint64 overflow on nonce or validUntil', () => {
    const maxUint64Plus1 = (2n ** 64n).toString();
    assert.throws(
      () =>
        normalizeMutualSettlementProposal({
          chainId: CHAIN_ID,
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          proposer: clientAccount.address,
          freelancerAmount: '500',
          clientAmount: '500',
          proposalNonce: maxUint64Plus1,
          validUntil: '1999999999',
        }),
      /uint64/
    );
  });

  await t.test('4. Generates and verifies valid EIP-712 signature from client', async () => {
    const proposal = normalizeMutualSettlementProposal({
      chainId: CHAIN_ID,
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      proposer: clientAccount.address,
      freelancerAmount: 700000000n,
      clientAmount: 300000000n,
      proposalNonce: 1n,
      validUntil: 2000000000n,
    });

    const typedData = getMutualSettlementTypedData(proposal);
    const signature = await clientAccount.signTypedData(typedData);

    const verification = await verifyMutualSettlementSignature(
      proposal,
      signature
    );

    assert.equal(verification.valid, true);
    assert.equal(verification.recoveredSigner, clientAccount.address.toLowerCase());
  });

  await t.test('5. Rejects signature if amounts or deal address are tampered', async () => {
    const proposal = normalizeMutualSettlementProposal({
      chainId: CHAIN_ID,
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      proposer: clientAccount.address,
      freelancerAmount: 700000000n,
      clientAmount: 300000000n,
      proposalNonce: 1n,
      validUntil: 2000000000n,
    });

    const typedData = getMutualSettlementTypedData(proposal);
    const signature = await clientAccount.signTypedData(typedData);

    // Tampered proposal: changed freelancerAmount from 700 to 800
    const tamperedProposal = {
      ...proposal,
      freelancerAmount: 800000000n,
    };

    const verification = await verifyMutualSettlementSignature(
      tamperedProposal,
      signature
    );

    assert.equal(verification.valid, false);
    assert.match(verification.error!, /does not match proposer/);
  });

  await t.test('6. Rejects signature from unauthorized signer (outsider)', async () => {
    const proposal = normalizeMutualSettlementProposal({
      chainId: CHAIN_ID,
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      proposer: clientAccount.address,
      freelancerAmount: 700000000n,
      clientAmount: 300000000n,
      proposalNonce: 1n,
      validUntil: 2000000000n,
    });

    // Outsider signs instead of client
    const typedData = getMutualSettlementTypedData(proposal);
    const signature = await outsiderAccount.signTypedData(typedData);

    const verification = await verifyMutualSettlementSignature(
      proposal,
      signature
    );

    assert.equal(verification.valid, false);
    assert.match(verification.error!, /does not match proposer/);
  });

  await t.test('7. Eligibility: allows Submitted, RevisionRequested, Disputed', () => {
    const statuses = [
      MilestoneStatus.Submitted,
      MilestoneStatus.RevisionRequested,
      MilestoneStatus.Disputed,
    ];

    for (const s of statuses) {
      const el = determineMutualSettlementEligibility({
        dealState: DealState.Active,
        milestoneStatus: s,
        isClient: true,
        isFreelancer: false,
      });
      assert.equal(el.eligible, true);
    }
  });

  await t.test('8. Eligibility: rejects Pending, InProgress, SettledPaid, and outsider', () => {
    const ineligibles = [
      MilestoneStatus.Pending,
      MilestoneStatus.InProgress,
      MilestoneStatus.SettledPaid,
      MilestoneStatus.SettledRefunded,
      MilestoneStatus.SettledSplit,
    ];

    for (const s of ineligibles) {
      const el = determineMutualSettlementEligibility({
        dealState: DealState.Active,
        milestoneStatus: s,
        isClient: true,
        isFreelancer: false,
      });
      assert.equal(el.eligible, false);
    }

    const outsider = determineMutualSettlementEligibility({
      dealState: DealState.Active,
      milestoneStatus: MilestoneStatus.Submitted,
      isClient: false,
      isFreelancer: false,
    });
    assert.equal(outsider.eligible, false);
  });

  await t.test('9. createMutualSettlementProposal: creates proposal in database', async () => {
    const repo = new MockMutualSettlementRepository();
    const mockClient = createMockPublicClient(DealState.Active, MilestoneStatus.Disputed);

    const proposal = normalizeMutualSettlementProposal({
      chainId: CHAIN_ID,
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      proposer: clientAccount.address,
      freelancerAmount: 600000000n,
      clientAmount: 400000000n,
      proposalNonce: 0n,
      validUntil: 2000000000n,
    });

    const typedData = getMutualSettlementTypedData(proposal);
    const signature = await clientAccount.signTypedData(typedData);

    const created = await createMutualSettlementProposal({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      proposerWallet: clientAccount.address,
      freelancerAmount: '600000000',
      clientAmount: '400000000',
      proposalNonce: '0',
      validUntil: '2000000000',
      signature,
      publicClient: mockClient as any,
      repo,
    });

    assert.equal(created.status, 'pending');
    assert.equal(created.proposerWallet, clientAccount.address.toLowerCase());
    assert.equal(created.freelancerAmount, '600000000');
    assert.equal(created.clientAmount, '400000000');
  });

  await t.test('10. createMutualSettlementProposal: rejects when sum != milestone amount', async () => {
    const repo = new MockMutualSettlementRepository();
    const mockClient = createMockPublicClient(DealState.Active, MilestoneStatus.Disputed);

    const proposal = normalizeMutualSettlementProposal({
      chainId: CHAIN_ID,
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      proposer: clientAccount.address,
      freelancerAmount: 500000000n,
      clientAmount: 400000000n, // sum = 900M, milestone is 1000M
      proposalNonce: 0n,
      validUntil: 2000000000n,
    });

    const typedData = getMutualSettlementTypedData(proposal);
    const signature = await clientAccount.signTypedData(typedData);

    await assert.rejects(
      () =>
        createMutualSettlementProposal({
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          proposerWallet: clientAccount.address,
          freelancerAmount: '500000000',
          clientAmount: '400000000',
          proposalNonce: '0',
          validUntil: '2000000000',
          signature,
          publicClient: mockClient as any,
          repo,
        }),
      MutualSettlementValidationError
    );
  });

  await t.test('11. createMutualSettlementProposal: rejects duplicate nonce in database or on-chain used nonce', async () => {
    const repo = new MockMutualSettlementRepository();
    const mockClient = createMockPublicClient(DealState.Active, MilestoneStatus.Disputed);

    const proposal = normalizeMutualSettlementProposal({
      chainId: CHAIN_ID,
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      proposer: clientAccount.address,
      freelancerAmount: 600000000n,
      clientAmount: 400000000n,
      proposalNonce: 5n,
      validUntil: 2000000000n,
    });

    const typedData = getMutualSettlementTypedData(proposal);
    const signature = await clientAccount.signTypedData(typedData);

    await createMutualSettlementProposal({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      proposerWallet: clientAccount.address,
      freelancerAmount: '600000000',
      clientAmount: '400000000',
      proposalNonce: '5',
      validUntil: '2000000000',
      signature,
      publicClient: mockClient as any,
      repo,
    });

    // Attempting same nonce again fails with Conflict
    await assert.rejects(
      () =>
        createMutualSettlementProposal({
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          proposerWallet: clientAccount.address,
          freelancerAmount: '600000000',
          clientAmount: '400000000',
          proposalNonce: '5',
          validUntil: '2000000000',
          signature,
          publicClient: mockClient as any,
          repo,
        }),
      MutualSettlementConflictError
    );

    // On-chain nonce already used fails
    mockClient.usedNonces.add(`0:${clientAccount.address.toLowerCase()}:6`);
    const proposal6 = normalizeMutualSettlementProposal({
      chainId: CHAIN_ID,
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      proposer: clientAccount.address,
      freelancerAmount: 600000000n,
      clientAmount: 400000000n,
      proposalNonce: 6n,
      validUntil: 2000000000n,
    });
    const sig6 = await clientAccount.signTypedData(getMutualSettlementTypedData(proposal6));

    await assert.rejects(
      () =>
        createMutualSettlementProposal({
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          proposerWallet: clientAccount.address,
          freelancerAmount: '600000000',
          clientAmount: '400000000',
          proposalNonce: '6',
          validUntil: '2000000000',
          signature: sig6,
          publicClient: mockClient as any,
          repo,
        }),
      MutualSettlementConflictError
    );
  });

  await t.test('12. reconcileMutualSettlementExecution: confirms execution and invalidates competing proposals', async () => {
    const repo = new MockMutualSettlementRepository();
    const mockClient = createMockPublicClient(DealState.Active, MilestoneStatus.Disputed);

    // Create proposal A
    const propA = normalizeMutualSettlementProposal({
      chainId: CHAIN_ID,
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      proposer: clientAccount.address,
      freelancerAmount: 600000000n,
      clientAmount: 400000000n,
      proposalNonce: 10n,
      validUntil: 2000000000n,
    });
    const sigA = await clientAccount.signTypedData(getMutualSettlementTypedData(propA));
    const createdA = await createMutualSettlementProposal({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      proposerWallet: clientAccount.address,
      freelancerAmount: '600000000',
      clientAmount: '400000000',
      proposalNonce: '10',
      validUntil: '2000000000',
      signature: sigA,
      publicClient: mockClient as any,
      repo,
    });

    // Create proposal B (competing)
    const propB = normalizeMutualSettlementProposal({
      chainId: CHAIN_ID,
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      proposer: freelancerAccount.address,
      freelancerAmount: 500000000n,
      clientAmount: 500000000n,
      proposalNonce: 11n,
      validUntil: 2000000000n,
    });
    const sigB = await freelancerAccount.signTypedData(getMutualSettlementTypedData(propB));
    const createdB = await createMutualSettlementProposal({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      proposerWallet: freelancerAccount.address,
      freelancerAmount: '500000000',
      clientAmount: '500000000',
      proposalNonce: '11',
      validUntil: '2000000000',
      signature: sigB,
      publicClient: mockClient as any,
      repo,
    });

    // Reconcile proposal A execution
    const txHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
    const topics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'MilestoneSettled',
      args: { milestoneId: 0n },
    });
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }],
      [600000000n, 400000000n, 4] // SettlementType.MutualSettlement = 4
    );

    const executionClient = {
      ...createMockPublicClient(DealState.Active, MilestoneStatus.SettledSplit),
      getTransactionReceipt: async () => ({
        status: 'success',
        logs: [{ address: DEAL_ADDR, topics, data }],
      }),
    };

    const executedA = await reconcileMutualSettlementExecution({
      proposalId: createdA.id,
      txHash,
      publicClient: executionClient as any,
      repo,
    });

    assert.equal(executedA.status, 'executed');
    assert.equal(executedA.executionTxHash, txHash.toLowerCase());

    // Proposal B should now be invalidated
    const retrievedB = await repo.getById(createdB.id);
    assert.equal(retrievedB?.status, 'invalidated');
  });

  await t.test('13. reconcileMutualSettlementCancel: cancels proposal and rejects cancellation by non-proposer', async () => {
    const repo = new MockMutualSettlementRepository();
    const mockClient = createMockPublicClient(DealState.Active, MilestoneStatus.Disputed);

    const prop = normalizeMutualSettlementProposal({
      chainId: CHAIN_ID,
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      proposer: clientAccount.address,
      freelancerAmount: 600000000n,
      clientAmount: 400000000n,
      proposalNonce: 20n,
      validUntil: 2000000000n,
    });
    const sig = await clientAccount.signTypedData(getMutualSettlementTypedData(prop));
    const created = await createMutualSettlementProposal({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      proposerWallet: clientAccount.address,
      freelancerAmount: '600000000',
      clientAmount: '400000000',
      proposalNonce: '20',
      validUntil: '2000000000',
      signature: sig,
      publicClient: mockClient as any,
      repo,
    });

    // Freelancer tries to cancel client proposal -> 403
    await assert.rejects(
      () =>
        reconcileMutualSettlementCancel({
          proposalId: created.id,
          callerWallet: freelancerAccount.address,
          publicClient: mockClient as any,
          repo,
        }),
      MutualSettlementAuthError
    );

    // Client cancels own proposal
    const cancelTx = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
    const cancelTopics = encodeEventTopics({
      abi: synqDealV1ABI,
      eventName: 'ProposalCancelled',
      args: { milestoneId: 0n, proposer: clientAccount.address },
    });
    const cancelData = encodeAbiParameters([{ type: 'uint64' }], [20n]);

    const cancelClient = {
      ...createMockPublicClient(DealState.Active, MilestoneStatus.Disputed),
      getTransactionReceipt: async () => ({
        status: 'success',
        logs: [{ address: DEAL_ADDR, topics: cancelTopics, data: cancelData }],
      }),
    };

    const cancelled = await reconcileMutualSettlementCancel({
      proposalId: created.id,
      callerWallet: clientAccount.address,
      txHash: cancelTx,
      publicClient: cancelClient as any,
      repo,
    });

    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancellationTxHash, cancelTx.toLowerCase());

    // Idempotent cancel reconciliation
    const cancelledAgain = await reconcileMutualSettlementCancel({
      proposalId: created.id,
      callerWallet: clientAccount.address,
      txHash: cancelTx,
      publicClient: cancelClient as any,
      repo,
    });
    assert.equal(cancelledAgain.status, 'cancelled');
    assert.equal(cancelledAgain.cancellationTxHash, cancelTx.toLowerCase());
  });

  await t.test('14. getMutualSettlementProposals: derives isExpired and isExecutable', async () => {
    const repo = new MockMutualSettlementRepository();
    const mockClient = createMockPublicClient(DealState.Active, MilestoneStatus.Disputed);

    // Active proposal from client
    const prop1 = normalizeMutualSettlementProposal({
      chainId: CHAIN_ID,
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      proposer: clientAccount.address,
      freelancerAmount: 600000000n,
      clientAmount: 400000000n,
      proposalNonce: 30n,
      validUntil: 2100000000n, // Future
    });
    const sig1 = await clientAccount.signTypedData(getMutualSettlementTypedData(prop1));
    await createMutualSettlementProposal({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      proposerWallet: clientAccount.address,
      freelancerAmount: '600000000',
      clientAmount: '400000000',
      proposalNonce: '30',
      validUntil: '2100000000',
      signature: sig1,
      publicClient: mockClient as any,
      repo,
    });

    // Query as freelancer (counterparty): proposal is executable
    const proposalsForFreelancer = await getMutualSettlementProposals({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: freelancerAccount.address,
      publicClient: mockClient as any,
      repo,
    });

    assert.equal(proposalsForFreelancer.length, 1);
    assert.equal(proposalsForFreelancer[0].isExecutable, true);
    assert.equal(proposalsForFreelancer[0].isExpired, false);

    // Query as client (proposer): proposal cannot be executed by self
    const proposalsForClient = await getMutualSettlementProposals({
      dealAddress: DEAL_ADDR,
      milestoneId: 0,
      callerWallet: clientAccount.address,
      publicClient: mockClient as any,
      repo,
    });

    assert.equal(proposalsForClient.length, 1);
    assert.equal(proposalsForClient[0].isExecutable, false);

    // Query as outsider: rejected
    await assert.rejects(
      () =>
        getMutualSettlementProposals({
          dealAddress: DEAL_ADDR,
          milestoneId: 0,
          callerWallet: outsiderAccount.address,
          publicClient: mockClient as any,
          repo,
        }),
      MutualSettlementAuthError
    );
  });
});
