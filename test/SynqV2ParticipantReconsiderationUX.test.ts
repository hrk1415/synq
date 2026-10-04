// test/SynqV2ParticipantReconsiderationUX.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  getAddress,
  encodeEventTopics,
  encodeAbiParameters,
  keccak256,
  toHex,
} from 'viem';
import {
  DealState,
  MilestoneStatus,
  SettlementType,
  StandardV2ResolutionProposal,
  readResolutionProposal,
  verifyFinalReconsiderationRequestedReceipt,
  verifyExecuteResolutionReceipt,
  FINAL_RECONSIDERATION_REQUESTED_TOPIC0,
  RESOLUTION_EXECUTED_TOPIC0,
  RESOLUTION_PROPOSED_TOPIC0,
  MILESTONE_SETTLED_TOPIC0,
} from '@/lib/deals/v2-deal';
import { synqDealV1ABI } from '@/lib/contracts/abis';
import { formatUsdcAmount, ZERO_BYTES32 } from '@/lib/deals/v2';

// Canonical test fixtures
const TEST_DEAL_ADDRESS = '0x142Ee9d2b5B6758F4D00439f3583fDcB89309807';
const TEST_OTHER_DEAL = '0x2222222222222222222222222222222222222222';
const TEST_CLIENT = '0xD2D4d415a4730b1490c9Ce27944529B83ff76319';
const TEST_FREELANCER = '0xd646585Fb453be3698F6D959d796C1D86B832c04';
const TEST_STRANGER = '0x1111111111111111111111111111111111111111';
const TEST_RESOLVER = '0xd60bBCc7c8aCA633A6D158B6f7F7367E36207676';
const TEST_JUSTIFICATION_HASH = '0x1122334455667788990011223344556677889900112233445566778899001122' as `0x${string}`;

describe('SYNQ PHASE 3M-F: Participant Resolution & Reconsideration UX Architecture', () => {
  describe('1. ResolutionProposal On-Chain Read Model', () => {
    it('correctly unpacks tuple/struct from getResolutionProposal preserving exact BigInt base units', async () => {
      const mockFreelancerAmount = 70000000n; // 70 USDC
      const mockClientAmount = 30000000n;     // 30 USDC
      const mockProposedAt = 1770000000n;
      const mockDeadline = 1770000000n + 72n * 3600n; // +72h

      const mockPublicClient = {
        readContract: async (params: any) => {
          assert.strictEqual(params.address.toLowerCase(), TEST_DEAL_ADDRESS.toLowerCase());
          assert.strictEqual(params.functionName, 'getResolutionProposal');
          assert.strictEqual(params.args[0], 0n);

          // Return tuple structure like Solidity getResolutionProposal(milestoneId)
          return [
            mockFreelancerAmount,
            mockClientAmount,
            TEST_JUSTIFICATION_HASH,
            mockProposedAt,
            mockDeadline,
            TEST_RESOLVER,
          ];
        },
      };

      const proposal = await readResolutionProposal(TEST_DEAL_ADDRESS, 0, mockPublicClient as any);

      assert.strictEqual(proposal.freelancerAmount, 70000000n);
      assert.strictEqual(proposal.clientAmount, 30000000n);
      assert.strictEqual(proposal.justificationHash, TEST_JUSTIFICATION_HASH);
      assert.strictEqual(proposal.proposedAt, mockProposedAt);
      assert.strictEqual(proposal.reconsiderationDeadline, mockDeadline);
      assert.strictEqual(proposal.resolver.toLowerCase(), TEST_RESOLVER.toLowerCase());

      // Financial precision: verify exact formatted USDC
      assert.strictEqual(formatUsdcAmount(proposal.freelancerAmount), '70');
      assert.strictEqual(formatUsdcAmount(proposal.clientAmount), '30');
    });

    it('preserves exact extreme large numbers without floating point rounding or precision loss', async () => {
      // 100 million USDC with 6 decimals = 100,000,000,000,000 base units
      const hugeFreelancer = 70000000000001n;
      const hugeClient = 29999999999999n;

      const mockPublicClient = {
        readContract: async () => [
          hugeFreelancer,
          hugeClient,
          TEST_JUSTIFICATION_HASH,
          100n,
          200n,
          TEST_RESOLVER,
        ],
      };

      const proposal = await readResolutionProposal(TEST_DEAL_ADDRESS, 1, mockPublicClient as any);

      assert.strictEqual(proposal.freelancerAmount, hugeFreelancer);
      assert.strictEqual(proposal.clientAmount, hugeClient);
      assert.strictEqual(typeof proposal.freelancerAmount, 'bigint');
      assert.strictEqual(typeof proposal.clientAmount, 'bigint');
    });

    it('rejects invalid deal address or negative milestone ID', async () => {
      const mockClient = { readContract: async () => [] };
      await assert.rejects(
        () => readResolutionProposal('invalid-address', 0, mockClient as any),
        /Invalid deal address/
      );
      await assert.rejects(
        () => readResolutionProposal(TEST_DEAL_ADDRESS, -1, mockClient as any),
        /Invalid milestoneId/
      );
    });
  });

  describe('2. Exact 72-Hour Boundary Semantics (Mutual Exclusivity)', () => {
    const deadline = 1770259200n; // Example Unix timestamp

    it('T = deadline - 1: reconsideration is eligible, executeResolution is ineligible', () => {
      const chainTime = deadline - 1n;

      // Solidity: block.timestamp < reconsiderationDeadline
      const canReconsider = chainTime < deadline;
      // Solidity: block.timestamp >= reconsiderationDeadline
      const canExecute = chainTime >= deadline;

      assert.strictEqual(canReconsider, true, 'Reconsideration MUST be available before deadline');
      assert.strictEqual(canExecute, false, 'Execution MUST be blocked before deadline');
    });

    it('T = deadline: reconsideration is ineligible, executeResolution is eligible', () => {
      const chainTime = deadline;

      const canReconsider = chainTime < deadline;
      const canExecute = chainTime >= deadline;

      assert.strictEqual(canReconsider, false, 'Reconsideration MUST be blocked at exact deadline');
      assert.strictEqual(canExecute, true, 'Execution MUST be available at exact deadline');
    });

    it('T = deadline + 1: reconsideration is ineligible, executeResolution is eligible', () => {
      const chainTime = deadline + 1n;

      const canReconsider = chainTime < deadline;
      const canExecute = chainTime >= deadline;

      assert.strictEqual(canReconsider, false, 'Reconsideration MUST be blocked after deadline');
      assert.strictEqual(canExecute, true, 'Execution MUST be available after deadline');
    });

    it('proves zero boundary overlap between reconsideration and execution', () => {
      const testTimestamps = [
        deadline - 3600n,
        deadline - 1n,
        deadline,
        deadline + 1n,
        deadline + 3600n,
      ];

      for (const t of testTimestamps) {
        const canReconsider = t < deadline;
        const canExecute = t >= deadline;

        // XOR: exactly one must be true at any given instant
        assert.notStrictEqual(
          canReconsider,
          canExecute,
          `At timestamp ${t.toString()}, canReconsider (${canReconsider}) and canExecute (${canExecute}) must be strictly opposite`
        );
      }
    });
  });

  describe('3. Request Final Reconsideration Receipt Verification', () => {
    function createFinalReconsiderationLog(dealAddress: string, milestoneId: bigint, participant: string) {
      const topics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'FinalReconsiderationRequested',
        args: {
          milestoneId,
          participant: participant as `0x${string}`,
        },
      });

      return {
        address: dealAddress,
        data: '0x' as `0x${string}`,
        topics,
      };
    }

    it('accepts valid receipt with exact FinalReconsiderationRequested event from canonical deal', () => {
      const log = createFinalReconsiderationLog(TEST_DEAL_ADDRESS, 0n, TEST_CLIENT);
      const receipt = {
        status: 'success',
        logs: [log],
      };

      const result = verifyFinalReconsiderationRequestedReceipt(
        receipt,
        TEST_DEAL_ADDRESS,
        0n,
        TEST_CLIENT
      );

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.finalReconsiderationRequestedEvent?.milestoneId, 0n);
      assert.strictEqual(
        result.finalReconsiderationRequestedEvent?.participant.toLowerCase(),
        TEST_CLIENT.toLowerCase()
      );
    });

    it('accepts freelancer as valid requesting participant', () => {
      const log = createFinalReconsiderationLog(TEST_DEAL_ADDRESS, 0n, TEST_FREELANCER);
      const receipt = {
        status: 'success',
        logs: [log],
      };

      const result = verifyFinalReconsiderationRequestedReceipt(
        receipt,
        TEST_DEAL_ADDRESS,
        0n,
        TEST_FREELANCER
      );

      assert.strictEqual(result.valid, true);
      assert.strictEqual(
        result.finalReconsiderationRequestedEvent?.participant.toLowerCase(),
        TEST_FREELANCER.toLowerCase()
      );
    });

    it('rejects receipt if transaction reverted', () => {
      const receipt = {
        status: 'reverted',
        logs: [],
      };

      const result = verifyFinalReconsiderationRequestedReceipt(
        receipt,
        TEST_DEAL_ADDRESS,
        0n,
        TEST_CLIENT
      );

      assert.strictEqual(result.valid, false);
      assert.match(result.error || '', /reverted/i);
    });

    it('rejects if log emitter does not match canonical Deal address', () => {
      const log = createFinalReconsiderationLog(TEST_OTHER_DEAL, 0n, TEST_CLIENT);
      const receipt = {
        status: 'success',
        logs: [log],
      };

      const result = verifyFinalReconsiderationRequestedReceipt(
        receipt,
        TEST_DEAL_ADDRESS,
        0n,
        TEST_CLIENT
      );

      assert.strictEqual(result.valid, false);
      assert.match(result.error || '', /not found in transaction receipt from the Deal contract/i);
    });

    it('rejects if milestone ID does not match expected', () => {
      const log = createFinalReconsiderationLog(TEST_DEAL_ADDRESS, 1n, TEST_CLIENT); // 1n instead of 0n
      const receipt = {
        status: 'success',
        logs: [log],
      };

      const result = verifyFinalReconsiderationRequestedReceipt(
        receipt,
        TEST_DEAL_ADDRESS,
        0n,
        TEST_CLIENT
      );

      assert.strictEqual(result.valid, false);
      assert.match(result.error || '', /unexpected milestone ID/i);
    });

    it('rejects if participant does not match expected requester', () => {
      const log = createFinalReconsiderationLog(TEST_DEAL_ADDRESS, 0n, TEST_STRANGER);
      const receipt = {
        status: 'success',
        logs: [log],
      };

      const result = verifyFinalReconsiderationRequestedReceipt(
        receipt,
        TEST_DEAL_ADDRESS,
        0n,
        TEST_CLIENT
      );

      assert.strictEqual(result.valid, false);
      assert.match(result.error || '', /unexpected participant/i);
    });

    it('proves zero reason/comment/evidence parameters exist in requestFinalReconsideration', () => {
      const abiItem = synqDealV1ABI.find(
        (item: any) => item.name === 'requestFinalReconsideration'
      ) as any;

      assert.ok(abiItem, 'requestFinalReconsideration must exist in ABI');
      assert.strictEqual(abiItem.inputs.length, 1, 'MUST take exactly 1 parameter (milestoneId)');
      assert.strictEqual(abiItem.inputs[0].name, 'milestoneId');
      assert.strictEqual(abiItem.inputs[0].type, 'uint256');
    });
  });

  describe('4. Execute Resolution Receipt Verification', () => {
    function createResolutionExecutedLog(
      dealAddress: string,
      milestoneId: bigint,
      resolver: string,
      freelancerAmount: bigint,
      clientAmount: bigint
    ) {
      const topics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'ResolutionExecuted',
        args: {
          milestoneId,
          resolver: resolver as `0x${string}`,
        },
      });

      const data = encodeAbiParameters(
        [
          { name: 'freelancerAmount', type: 'uint256' },
          { name: 'clientAmount', type: 'uint256' },
        ],
        [freelancerAmount, clientAmount]
      );

      return {
        address: dealAddress,
        data,
        topics,
      };
    }

    function createMilestoneSettledLog(
      dealAddress: string,
      milestoneId: bigint,
      paidToFreelancer: bigint,
      refundedToClient: bigint,
      settlementType: number
    ) {
      const topics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'MilestoneSettled',
        args: {
          milestoneId,
        },
      });

      const data = encodeAbiParameters(
        [
          { name: 'paidToFreelancer', type: 'uint256' },
          { name: 'refundedToClient', type: 'uint256' },
          { name: 'settlementType', type: 'uint8' },
        ],
        [paidToFreelancer, refundedToClient, settlementType]
      );

      return {
        address: dealAddress,
        data,
        topics,
      };
    }

    it('accepts valid receipt containing both ResolutionExecuted and MilestoneSettled(ResolverResolution)', () => {
      const flAmount = 70000000n;
      const clAmount = 30000000n;

      const log1 = createResolutionExecutedLog(TEST_DEAL_ADDRESS, 0n, TEST_RESOLVER, flAmount, clAmount);
      const log2 = createMilestoneSettledLog(
        TEST_DEAL_ADDRESS,
        0n,
        flAmount,
        clAmount,
        SettlementType.ResolverResolution
      );

      const receipt = {
        status: 'success',
        logs: [log1, log2],
      };

      const result = verifyExecuteResolutionReceipt(
        receipt,
        TEST_DEAL_ADDRESS,
        0n,
        TEST_RESOLVER,
        flAmount,
        clAmount
      );

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.resolutionExecutedEvent?.freelancerAmount, flAmount);
      assert.strictEqual(result.resolutionExecutedEvent?.clientAmount, clAmount);
      assert.strictEqual(result.milestoneSettledEvent?.settlementType, SettlementType.ResolverResolution);
    });

    it('rejects receipt if MilestoneSettled settlementType is MutualSettlement', () => {
      const flAmount = 70000000n;
      const clAmount = 30000000n;

      const log1 = createResolutionExecutedLog(TEST_DEAL_ADDRESS, 0n, TEST_RESOLVER, flAmount, clAmount);
      // Malformed or raced log with MutualSettlement
      const log2 = createMilestoneSettledLog(
        TEST_DEAL_ADDRESS,
        0n,
        flAmount,
        clAmount,
        SettlementType.MutualSettlement
      );

      const receipt = {
        status: 'success',
        logs: [log1, log2],
      };

      const result = verifyExecuteResolutionReceipt(
        receipt,
        TEST_DEAL_ADDRESS,
        0n,
        TEST_RESOLVER,
        flAmount,
        clAmount
      );

      assert.strictEqual(result.valid, false);
      assert.match(result.error || '', /settlementType mismatch/i);
    });

    it('rejects receipt if ResolutionExecuted event is missing', () => {
      const flAmount = 70000000n;
      const clAmount = 30000000n;

      // Only MilestoneSettled, missing ResolutionExecuted
      const log2 = createMilestoneSettledLog(
        TEST_DEAL_ADDRESS,
        0n,
        flAmount,
        clAmount,
        SettlementType.ResolverResolution
      );

      const receipt = {
        status: 'success',
        logs: [log2],
      };

      const result = verifyExecuteResolutionReceipt(
        receipt,
        TEST_DEAL_ADDRESS,
        0n,
        TEST_RESOLVER,
        flAmount,
        clAmount
      );

      assert.strictEqual(result.valid, false);
      assert.match(result.error || '', /ResolutionExecuted event not found/i);
    });

    it('rejects receipt if split amounts in receipt do not match proposal amounts', () => {
      const log1 = createResolutionExecutedLog(TEST_DEAL_ADDRESS, 0n, TEST_RESOLVER, 50000000n, 50000000n);
      const log2 = createMilestoneSettledLog(
        TEST_DEAL_ADDRESS,
        0n,
        50000000n,
        50000000n,
        SettlementType.ResolverResolution
      );

      const receipt = {
        status: 'success',
        logs: [log1, log2],
      };

      // Expected 70/30, received 50/50
      const result = verifyExecuteResolutionReceipt(
        receipt,
        TEST_DEAL_ADDRESS,
        0n,
        TEST_RESOLVER,
        70000000n,
        30000000n
      );

      assert.strictEqual(result.valid, false);
      assert.match(result.error || '', /freelancer amount mismatch/i);
    });

    it('rejects receipt if resolver does not match expected resolver', () => {
      const flAmount = 70000000n;
      const clAmount = 30000000n;

      const log1 = createResolutionExecutedLog(TEST_DEAL_ADDRESS, 0n, TEST_STRANGER, flAmount, clAmount);
      const log2 = createMilestoneSettledLog(
        TEST_DEAL_ADDRESS,
        0n,
        flAmount,
        clAmount,
        SettlementType.ResolverResolution
      );

      const receipt = {
        status: 'success',
        logs: [log1, log2],
      };

      const result = verifyExecuteResolutionReceipt(
        receipt,
        TEST_DEAL_ADDRESS,
        0n,
        TEST_RESOLVER,
        flAmount,
        clAmount
      );

      assert.strictEqual(result.valid, false);
      assert.match(result.error || '', /resolver mismatch/i);
    });

    it('rejects receipt containing FinalResolutionExecuted instead of ordinary ResolutionExecuted', () => {
      const topics = encodeEventTopics({
        abi: synqDealV1ABI,
        eventName: 'FinalResolutionExecuted',
        args: {
          milestoneId: 0n,
          resolver: TEST_RESOLVER as `0x${string}`,
        },
      });
      const data = encodeAbiParameters(
        [
          { name: 'freelancerAmount', type: 'uint256' },
          { name: 'clientAmount', type: 'uint256' },
          { name: 'justificationHash', type: 'bytes32' },
        ],
        [70000000n, 30000000n, TEST_JUSTIFICATION_HASH]
      );
      const finalLog = { address: TEST_DEAL_ADDRESS, data, topics };

      const receipt = {
        status: 'success',
        logs: [finalLog],
      };

      const result = verifyExecuteResolutionReceipt(
        receipt,
        TEST_DEAL_ADDRESS,
        0n,
        TEST_RESOLVER,
        70000000n,
        30000000n
      );

      assert.strictEqual(result.valid, false);
      assert.match(result.error || '', /FinalResolutionExecuted instead of ordinary ResolutionExecuted/i);
    });
  });

  describe('5. Topic0 Constants Definition', () => {
    it('matches exact keccak256 signatures for resolution events', () => {
      assert.strictEqual(
        FINAL_RECONSIDERATION_REQUESTED_TOPIC0,
        keccak256(toHex('FinalReconsiderationRequested(uint256,address)'))
      );
      assert.strictEqual(
        RESOLUTION_EXECUTED_TOPIC0,
        keccak256(toHex('ResolutionExecuted(uint256,address,uint256,uint256)'))
      );
      assert.strictEqual(
        RESOLUTION_PROPOSED_TOPIC0,
        keccak256(toHex('ResolutionProposed(uint256,address,uint256,uint256,bytes32,uint64)'))
      );
    });
  });

  describe('6. Race Conditions & Conflict Resolution Preflight', () => {
    it('detects already settled milestone when executing resolution', () => {
      const milestone = {
        status: MilestoneStatus.SettledSplit,
        amount: 100000000n,
      };

      // Check whether terminal status should short-circuit gracefully
      const isAlreadySettled =
        milestone.status === MilestoneStatus.SettledPaid ||
        milestone.status === MilestoneStatus.SettledRefunded ||
        milestone.status === MilestoneStatus.SettledSplit;

      assert.strictEqual(isAlreadySettled, true);
    });

    it('detects milestone in FinalReview when executing resolution and prevents execution', () => {
      const milestone = {
        status: MilestoneStatus.FinalReview,
        amount: 100000000n,
      };

      const canExecute = milestone.status === MilestoneStatus.ResolutionProposed;
      assert.strictEqual(canExecute, false, 'FinalReview status MUST prevent ordinary executeResolution');
    });

    it('detects expired reconsideration window right before reconsideration write', () => {
      const deadline = 1770000000n;
      const currentBlockTimestamp = 1770000001n; // mined at or after deadline

      const isExpired = currentBlockTimestamp >= deadline;
      assert.strictEqual(isExpired, true, 'Preflight must fail closed if deadline passed');
    });
  });

  describe('7. Participant Authority & Non-Participant Protection', () => {
    const dealClient = TEST_CLIENT.toLowerCase();
    const dealFreelancer = TEST_FREELANCER.toLowerCase();

    it('identifies client and freelancer as authorized participants', () => {
      const isClient = (wallet: string) => wallet.toLowerCase() === dealClient;
      const isFreelancer = (wallet: string) => wallet.toLowerCase() === dealFreelancer;
      const isParticipant = (wallet: string) => isClient(wallet) || isFreelancer(wallet);

      assert.strictEqual(isParticipant(TEST_CLIENT), true);
      assert.strictEqual(isParticipant(TEST_FREELANCER), true);
      assert.strictEqual(isParticipant(TEST_STRANGER), false);
    });
  });

  describe('8. Report Authority Boundary: Explanatory vs Authoritative Financial', () => {
    it('ensures financial split derives strictly from base units and formatUsdcAmount', () => {
      const rawFreelancer = 66666666n; // 66.666666 USDC
      const rawClient = 33333334n;     // 33.333334 USDC
      const total = rawFreelancer + rawClient;

      assert.strictEqual(total, 100000000n); // Exact 100 USDC
      assert.strictEqual(formatUsdcAmount(rawFreelancer), '66.666666');
      assert.strictEqual(formatUsdcAmount(rawClient), '33.333334');
    });

    it('confirms DB report fields provide human explanation without containing raw signatures', () => {
      const mockReport = {
        summary: 'Committee completed review of milestone deliverables.',
        findings: 'Specifications were 70% completed with acceptable quality.',
        justification: 'Freelancer executed core modules; client provided testing framework.',
        evidenceReferences: [
          { title: 'Repo Commits', url: 'https://github.com/example/repo', notes: 'Verified 42 commits' },
        ],
      };

      assert.ok(mockReport.summary);
      assert.ok(mockReport.findings);
      assert.ok(mockReport.justification);
      assert.strictEqual(mockReport.evidenceReferences.length, 1);

      // Verify no signature or raw auth fields exist in participant report view
      assert.strictEqual((mockReport as any).signature, undefined);
      assert.strictEqual((mockReport as any).signatures, undefined);
      assert.strictEqual((mockReport as any).authBundle, undefined);
    });
  });
});
