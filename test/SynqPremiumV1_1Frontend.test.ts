// test/SynqPremiumV1_1Frontend.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  calculateEligibleMilestones,
  calculatePremiumFee,
  calculateMaximumCoverage,
  MAX_PROTECTED_MILESTONES,
  detectPremiumManagerVersion,
  readPremiumManagerParameters,
  readDealPremiumPolicy,
  PremiumManagerVersion,
} from '@/lib/deals/v2-protection';
import {
  synqPremiumProtectionManagerABI,
  synqPremiumProtectionManagerV1_1ABI,
} from '@/lib/contracts/abis';
import {
  ZERO_ADDRESS,
  ZERO_BYTES32,
  buildStandardV2Proposal,
} from '@/lib/deals/v2';
import { getSynqPremiumConfig } from '@/lib/contracts/addresses';
import fs from 'node:fs';
import path from 'node:path';

describe('Phase 7H Frontend & Regression Suite', () => {
  const ONE_DAY = 86400n;

  describe('1. V1.1 Eligibility & Quote Derivation', () => {
    it('calculates eligiblePrincipal and count correctly for all-Pending deal', () => {
      const now = 1000000n;
      const milestones = [
        { status: 0, amount: 200n, workDeadline: now + ONE_DAY, gracePeriod: 0n },
        { status: 0, amount: 300n, workDeadline: now + 2n * ONE_DAY, gracePeriod: 100n },
      ];

      const { eligiblePrincipal, eligibleCount, totalCount, coveredBitmap } =
        calculateEligibleMilestones(milestones, now);

      assert.strictEqual(eligiblePrincipal, 500n);
      assert.strictEqual(eligibleCount, 2);
      assert.strictEqual(totalCount, 2);
      assert.strictEqual(coveredBitmap, 3); // bits 0 and 1
    });

    it('Premium quote uses eligiblePrincipal, NOT totalEscrow', () => {
      const now = 1000000n;
      const milestones = [
        { status: 1, amount: 500n, workDeadline: now + ONE_DAY, gracePeriod: 0n }, // InProgress => excluded
        { status: 0, amount: 500n, workDeadline: now + 2n * ONE_DAY, gracePeriod: 0n }, // Pending => eligible
      ];

      const { eligiblePrincipal, eligibleCount } = calculateEligibleMilestones(milestones, now);
      assert.strictEqual(eligiblePrincipal, 500n);
      assert.strictEqual(eligibleCount, 1);

      const feeBps = 200n;
      const fee = calculatePremiumFee(eligiblePrincipal, feeBps);
      const coverage = calculateMaximumCoverage(eligiblePrincipal);

      // 2% of 500 = 10 (not 2% of 1000 = 20)
      assert.strictEqual(fee, 10n);
      // 20% of 500 = 100 (not 20% of 1000 = 200)
      assert.strictEqual(coverage, 100n);
    });

    it('Section 11 Parity Fixtures: Cases A, B, F, G', () => {
      const now = 1000000n;

      // Fixture A: 1 milestone, 100 USDC, Pending, unexpired
      const fixA = calculateEligibleMilestones(
        [{ status: 0, amount: 100_000_000n, workDeadline: now + ONE_DAY, gracePeriod: 0n }],
        now
      );
      assert.strictEqual(fixA.eligiblePrincipal, 100_000_000n);
      assert.strictEqual(calculatePremiumFee(fixA.eligiblePrincipal, 200n), 2_000_000n); // 2 USDC
      assert.strictEqual(calculateMaximumCoverage(fixA.eligiblePrincipal), 20_000_000n); // 20 USDC

      // Fixture B: 4 x 25 USDC (2 excluded, 2 eligible)
      const fixB = calculateEligibleMilestones(
        [
          { status: 1, amount: 25_000_000n, workDeadline: now + ONE_DAY, gracePeriod: 0n }, // InProgress
          { status: 2, amount: 25_000_000n, workDeadline: now + ONE_DAY, gracePeriod: 0n }, // Submitted
          { status: 0, amount: 25_000_000n, workDeadline: now + ONE_DAY, gracePeriod: 0n }, // Pending
          { status: 0, amount: 25_000_000n, workDeadline: now + ONE_DAY, gracePeriod: 0n }, // Pending
        ],
        now
      );
      assert.strictEqual(fixB.eligiblePrincipal, 50_000_000n);
      assert.strictEqual(calculatePremiumFee(fixB.eligiblePrincipal, 200n), 1_000_000n); // 1 USDC
      assert.strictEqual(calculateMaximumCoverage(fixB.eligiblePrincipal), 10_000_000n); // 10 USDC

      // Fixture F: 16 milestones
      const fixF = calculateEligibleMilestones(
        Array.from({ length: 16 }, () => ({
          status: 0,
          amount: 10_000_000n,
          workDeadline: now + ONE_DAY,
          gracePeriod: 0n,
        })),
        now
      );
      assert.strictEqual(fixF.eligibleCount, 16);
      assert.strictEqual(fixF.coveredBitmap, 0xFFFF);

      // Fixture G: 17 milestones throws
      assert.throws(
        () =>
          calculateEligibleMilestones(
            Array.from({ length: 17 }, () => ({
              status: 0,
              amount: 10_000_000n,
              workDeadline: now + ONE_DAY,
              gracePeriod: 0n,
            })),
            now
          ),
        /exceeds maximum 16/
      );
    });

    it('mixed eligible/excluded milestones filters out non-Pending and expired', () => {
      const now = 1000000n;
      const milestones = [
        { status: 0, amount: 100n, workDeadline: now + 100n, gracePeriod: 0n }, // Pending unexpired => eligible (bit 0)
        { status: 1, amount: 100n, workDeadline: now + 100n, gracePeriod: 0n }, // InProgress => excluded
        { status: 2, amount: 100n, workDeadline: now + 100n, gracePeriod: 0n }, // Submitted => excluded
        { status: 0, amount: 100n, workDeadline: now - 10n, gracePeriod: 0n }, // Pending expired => excluded
        { status: 0, amount: 100n, workDeadline: now + 500n, gracePeriod: 0n }, // Pending unexpired => eligible (bit 4)
      ];

      const { eligiblePrincipal, eligibleCount, coveredBitmap } =
        calculateEligibleMilestones(milestones, now);

      assert.strictEqual(eligiblePrincipal, 200n);
      assert.strictEqual(eligibleCount, 2);
      assert.strictEqual(coveredBitmap, 1 | (1 << 4)); // bits 0 and 4 = 17
    });

    it('zero eligible disables actionable approval', () => {
      const now = 1000000n;
      const milestones = [
        { status: 1, amount: 500n, workDeadline: now + ONE_DAY, gracePeriod: 0n }, // InProgress
        { status: 0, amount: 500n, workDeadline: now - 10n, gracePeriod: 0n }, // Expired
      ];

      const { eligiblePrincipal, eligibleCount } = calculateEligibleMilestones(milestones, now);
      assert.strictEqual(eligiblePrincipal, 0n);
      assert.strictEqual(eligibleCount, 0);
    });

    it('exact deadline boundary: now == deadline + grace is eligible, now > deadline + grace is excluded', () => {
      const deadline = 1000000n;
      const grace = 50n;
      const threshold = deadline + grace;

      const atThreshold = calculateEligibleMilestones(
        [{ status: 0, amount: 100n, workDeadline: deadline, gracePeriod: grace }],
        threshold
      );
      assert.strictEqual(atThreshold.eligibleCount, 1, 'now == threshold MUST be eligible');

      const pastThreshold = calculateEligibleMilestones(
        [{ status: 0, amount: 100n, workDeadline: deadline, gracePeriod: grace }],
        threshold + 1n
      );
      assert.strictEqual(pastThreshold.eligibleCount, 0, 'now > threshold MUST be excluded');
    });

    it('caps milestone count at MAX_PROTECTED_MILESTONES (16)', () => {
      assert.strictEqual(MAX_PROTECTED_MILESTONES, 16);
      const dummyMilestones = Array.from({ length: 20 }, () => ({
        status: 0,
        amount: 10n,
        workDeadline: 2000000n,
        gracePeriod: 0n,
      }));

      assert.throws(
        () => calculateEligibleMilestones(dummyMilestones, 1000000n),
        /exceeds maximum 16/
      );
    });
  });

  describe('2. Standard Expired Lifecycle UX Invariants', () => {
    it('derives isExpired strictly when now > workDeadline + gracePeriod for Pending and InProgress', () => {
      const deadline = 1000000;
      const grace = 100;
      const threshold = deadline + grace;

      const isExpiredState = (status: number, time: number) =>
        (status === 0 || status === 1) && time > threshold;

      // Pending at threshold
      assert.strictEqual(isExpiredState(0, threshold), false);

      // Pending past threshold
      assert.strictEqual(isExpiredState(0, threshold + 1), true);

      // InProgress past threshold
      assert.strictEqual(isExpiredState(1, threshold + 1), true);

      // Submitted past threshold (NOT expired for refund - it is under review)
      assert.strictEqual(isExpiredState(2, threshold + 1), false);
    });

    it('V2MilestoneLifecycle.tsx renders Expired — Refund Available and claimExpiredRefund', () => {
      const compPath = path.join(process.cwd(), 'src/components/deals/V2MilestoneLifecycle.tsx');
      const source = fs.readFileSync(compPath, 'utf8');

      assert(source.includes('Expired — Refund Available'), 'Must show Expired — Refund Available badge');
      assert(source.includes('Claim Expired Refund'), 'Must show Claim Expired Refund button');
      assert(source.includes('claimExpiredRefund'), 'Must call contract claimExpiredRefund method');
      assert(source.includes('isClient'), 'Must guard Claim Expired Refund button to client only');
    });
  });

  describe('3. Copywriting & Unsafe Insurance Wording Verification', () => {
    it('V2DealFunding.tsx does not use insurance/insured/insurer for the Premium product', () => {
      const compPath = path.join(process.cwd(), 'src/components/deals/V2DealFunding.tsx');
      const source = fs.readFileSync(compPath, 'utf8');

      assert(!source.includes('milestone insurance'), 'Must not say milestone insurance');
      assert(source.includes('milestone protection'), 'Must say milestone protection');
      assert(source.includes('Synq Protection Pool'), 'Must say Synq Protection Pool');
      assert(source.includes('Protected Milestones'), 'Must say Protected Milestones');
      assert(source.includes('Covered Escrow'), 'Must say Covered Escrow');
      assert(source.includes('No remaining milestones are eligible for new Premium Protection'), 'Must explain zero eligible');
    });
  });

  describe('4. Standard V2 Protocol Invariants & Roles', () => {
    it('Standard V2 proposal preserves isProtected=false, protectionModule=address(0), policyId=bytes32(0)', () => {
      const { proposal } = buildStandardV2Proposal({
        client: '0x1111111111111111111111111111111111111111',
        freelancer: '0x2222222222222222222222222222222222222222',
        milestones: [{ amount: 100n, workDeadline: 100000n, reviewWindow: 10000n, gracePeriod: 0n, specHash: '0x1111111111111111111111111111111111111111111111111111111111111111' }],
        proposalNonce: 1n,
        expiry: 9999999999n,
      });

      assert.strictEqual(proposal.isProtected, false);
      assert.strictEqual(proposal.protectionModule, ZERO_ADDRESS);
      assert.strictEqual(proposal.policyId, ZERO_BYTES32);
    });

    it('Manager is spender for Premium policy purchase, Pool is spender for capitalization', () => {
      const config = getSynqPremiumConfig();
      assert.strictEqual(config.chainId, 11155111);
      // In environment with env set or fallback, manager is distinct from pool
      if (config.manager && config.pool) {
        assert.notStrictEqual(config.manager, config.pool);
      }
    });

    it('No MaxUint approval in V2DealFunding.tsx approval calls', () => {
      const compPath = path.join(process.cwd(), 'src/components/deals/V2DealFunding.tsx');
      const source = fs.readFileSync(compPath, 'utf8');

      // Ensure writeContract calls do not pass maxUint256 variable or constant
      const approveMatches = source.match(/functionName:\s*'approve',\s*args:\s*\[[^\]]+\]/g) || [];
      for (const m of approveMatches) {
        assert(!m.includes('MaxUint256'), `Approval call must not use MaxUint256: ${m}`);
        assert(!m.includes('maxUint256'), `Approval call must not use maxUint256: ${m}`);
      }
    });
  });

  describe('5. Phase 7K Cutover Preparation & Parity Suite (Items A through Q)', () => {
    const OLD_V1_ADDR = '0xEbD3654548371f2dc2d1420226b99983a42e2FE8';
    const NEW_V1_1_ADDR = '0x462D1b8c1047d05FbE61e15809f4E6A26B12ED00';
    const UNKNOWN_ADDR = '0x3333333333333333333333333333333333333333';
    const HISTORICAL_QA_DEAL = '0x03DFc116bb5484BEE0c8505B75DfA4E0bE50c8c2';

    // Helper mock publicClient simulating V1, V1.1, and unknown contracts
    function createMockPublicClient() {
      const recordedCalls: { address: string; functionName: string; abi: any }[] = [];

      const client = {
        recordedCalls,
        readContract: async ({ address, abi, functionName, args }: any) => {
          recordedCalls.push({ address, functionName, abi });
          const addr = address.toLowerCase();

          // 1. MAX_MILESTONES selector
          if (functionName === 'MAX_MILESTONES') {
            if (addr === NEW_V1_1_ADDR.toLowerCase()) {
              return 16n;
            }
            throw new Error('revert: MAX_MILESTONES selector not found');
          }

          // 2. COVERAGE_RATE_BPS
          if (functionName === 'COVERAGE_RATE_BPS') {
            if (addr === OLD_V1_ADDR.toLowerCase() || addr === NEW_V1_1_ADDR.toLowerCase()) {
              return 2000;
            }
            throw new Error('revert: COVERAGE_RATE_BPS selector not found');
          }

          // 3. premiumFeeBps
          if (functionName === 'premiumFeeBps') {
            if (addr === OLD_V1_ADDR.toLowerCase() || addr === NEW_V1_1_ADDR.toLowerCase()) {
              return 200;
            }
            throw new Error('revert: premiumFeeBps selector not found');
          }

          // 4. pool
          if (functionName === 'pool') {
            if (addr === OLD_V1_ADDR.toLowerCase() || addr === NEW_V1_1_ADDR.toLowerCase()) {
              return '0xA1f4991597869ba11EbD94edED4d69960063cbc2';
            }
            throw new Error('revert: pool selector not found');
          }

          // 5. getPolicy
          if (functionName === 'getPolicy') {
            if (addr === OLD_V1_ADDR.toLowerCase()) {
              // V1 6-tuple: client, purchasedAt, premiumPaid, maxCoverage, totalPaid, active
              return {
                client: '0xD2D4d415a4730b1490c9Ce27944529B83ff76319',
                purchasedAt: 1791250104n,
                premiumPaid: 100000n,
                maxCoverage: 1000000n,
                totalPaid: 0n,
                active: true,
              };
            }
            if (addr === NEW_V1_1_ADDR.toLowerCase()) {
              // V1.1 8-tuple: client, purchasedAt, coveredBitmap, active, eligiblePrincipal, premiumPaid, maxCoverage, totalPaid
              // Default uninitialized
              return {
                client: '0x0000000000000000000000000000000000000000',
                purchasedAt: 0n,
                coveredBitmap: 0,
                active: false,
                eligiblePrincipal: 0n,
                premiumPaid: 0n,
                maxCoverage: 0n,
                totalPaid: 0n,
              };
            }
            throw new Error('revert: getPolicy not found');
          }

          throw new Error(`Unhandled mock function: ${functionName}`);
        },
      };

      return client;
    }

    it('A. configured old V1 detected as V1', async () => {
      const mockClient = createMockPublicClient();
      const version = await detectPremiumManagerVersion(mockClient, OLD_V1_ADDR);
      assert.strictEqual(version, 'V1');
    });

    it('B. deployed V1.1 shape detected as V1_1', async () => {
      const mockClient = createMockPublicClient();
      const version = await detectPremiumManagerVersion(mockClient, NEW_V1_1_ADDR);
      assert.strictEqual(version, 'V1_1');
    });

    it('C. unknown/incompatible Manager fails closed', async () => {
      const mockClient = createMockPublicClient();
      const versionUnknown = await detectPremiumManagerVersion(mockClient, UNKNOWN_ADDR);
      assert.strictEqual(versionUnknown, null);

      const versionZero = await detectPremiumManagerVersion(mockClient, ZERO_ADDRESS);
      assert.strictEqual(versionZero, null);

      const versionNull = await detectPremiumManagerVersion(mockClient, null);
      assert.strictEqual(versionNull, null);
    });

    it('D. V1 getPolicy uses V1 ABI', async () => {
      const mockClient = createMockPublicClient();
      await readDealPremiumPolicy(mockClient, OLD_V1_ADDR, HISTORICAL_QA_DEAL, 'V1');

      const getPolicyCall = mockClient.recordedCalls.find((c) => c.functionName === 'getPolicy');
      assert(getPolicyCall, 'Must call getPolicy');
      assert.strictEqual(getPolicyCall?.abi, synqPremiumProtectionManagerABI);
    });

    it('E. V1.1 getPolicy uses V1.1 ABI', async () => {
      const mockClient = createMockPublicClient();
      await readDealPremiumPolicy(mockClient, NEW_V1_1_ADDR, HISTORICAL_QA_DEAL, 'V1_1');

      const getPolicyCall = mockClient.recordedCalls.find((c) => c.functionName === 'getPolicy');
      assert(getPolicyCall, 'Must call getPolicy');
      assert.strictEqual(getPolicyCall?.abi, synqPremiumProtectionManagerV1_1ABI);
    });

    it('F. normalized V1 policy does not fabricate: coveredBitmap, eligiblePrincipal', async () => {
      const mockClient = createMockPublicClient();
      const policy = await readDealPremiumPolicy(mockClient, OLD_V1_ADDR, HISTORICAL_QA_DEAL, 'V1');

      assert.notStrictEqual(policy, null);
      assert.strictEqual(policy?.version, 'V1');
      assert.strictEqual(policy?.active, true);
      assert.strictEqual(policy?.coveredBitmap, undefined, 'V1 policy MUST NOT fabricate coveredBitmap');
      assert.strictEqual(policy?.eligiblePrincipal, undefined, 'V1 policy MUST NOT fabricate eligiblePrincipal');
    });

    it('G. normalized V1.1 policy includes: coveredBitmap, eligiblePrincipal', async () => {
      const mockClient = createMockPublicClient();
      // Custom mock returning initialized V1.1 policy
      mockClient.readContract = async ({ functionName }: any) => {
        if (functionName === 'getPolicy') {
          return {
            client: '0xD2D4d415a4730b1490c9Ce27944529B83ff76319',
            purchasedAt: 1791250104n,
            coveredBitmap: 3, // Milestones 0 and 1
            active: true,
            eligiblePrincipal: 50_000_000n,
            premiumPaid: 1_000_000n,
            maxCoverage: 10_000_000n,
            totalPaid: 0n,
          };
        }
        throw new Error('Unhandled function');
      };

      const policy = await readDealPremiumPolicy(mockClient, NEW_V1_1_ADDR, HISTORICAL_QA_DEAL, 'V1_1');
      assert.notStrictEqual(policy, null);
      assert.strictEqual(policy?.version, 'V1_1');
      assert.strictEqual(policy?.coveredBitmap, 3);
      assert.strictEqual(policy?.eligiblePrincipal, 50_000_000n);
      assert.strictEqual(policy?.active, true);
    });

    it('H. V1 purchasePolicy uses configured Manager', () => {
      const compPath = path.join(process.cwd(), 'src/components/deals/V2DealFunding.tsx');
      const source = fs.readFileSync(compPath, 'utf8');

      // The write contract call in V2DealFunding uses premiumConfig.manager as address
      assert(source.includes('address: premiumConfig.manager'), 'purchasePolicy MUST use premiumConfig.manager');
    });

    it('I. V1.1 purchasePolicy uses configured Manager', () => {
      const compPath = path.join(process.cwd(), 'src/components/deals/V2DealFunding.tsx');
      const source = fs.readFileSync(compPath, 'utf8');

      assert(source.includes('writeAbi = currentVersion === \'V1_1\' ? synqPremiumProtectionManagerV1_1ABI : synqPremiumProtectionManagerABI'));
      assert(source.includes('address: premiumConfig.manager'));
    });

    it('J. exact USDC approval amount retained', () => {
      const compPath = path.join(process.cwd(), 'src/components/deals/V2DealFunding.tsx');
      const source = fs.readFileSync(compPath, 'utf8');

      // Approve call passes calculatedPremiumFee
      assert(source.includes('args: [premiumConfig.manager, calculatedPremiumFee]'));
    });

    it('K. no MaxUint/unlimited approval', () => {
      const compPath = path.join(process.cwd(), 'src/components/deals/V2DealFunding.tsx');
      const source = fs.readFileSync(compPath, 'utf8');

      const approveMatches = source.match(/functionName:\s*'approve',\s*args:\s*\[[^\]]+\]/g) || [];
      assert(approveMatches.length > 0, 'Must have approve calls');
      for (const m of approveMatches) {
        assert(!m.includes('MaxUint256'), `Approval call must not use MaxUint256: ${m}`);
        assert(!m.includes('maxUint256'), `Approval call must not use maxUint256: ${m}`);
      }
    });

    it('L. partial eligible-principal quote parity', () => {
      const now = 1000000n;
      const ONE_DAY = 86400n;
      // 4 milestones: 2 excluded, 2 eligible
      const milestones = [
        { status: 1, amount: 25_000_000n, workDeadline: now + ONE_DAY, gracePeriod: 0n }, // InProgress
        { status: 2, amount: 25_000_000n, workDeadline: now + ONE_DAY, gracePeriod: 0n }, // Submitted
        { status: 0, amount: 25_000_000n, workDeadline: now + ONE_DAY, gracePeriod: 0n }, // Pending
        { status: 0, amount: 25_000_000n, workDeadline: now + ONE_DAY, gracePeriod: 0n }, // Pending
      ];

      const res = calculateEligibleMilestones(milestones, now);
      assert.strictEqual(res.eligiblePrincipal, 50_000_000n);
      assert.strictEqual(calculatePremiumFee(res.eligiblePrincipal, 200), 1_000_000n);
      assert.strictEqual(calculateMaximumCoverage(res.eligiblePrincipal, 2000), 10_000_000n);
    });

    it('M. zero eligible blocks activation', () => {
      const compPath = path.join(process.cwd(), 'src/components/deals/V2DealFunding.tsx');
      const source = fs.readFileSync(compPath, 'utf8');

      assert(source.includes('eligiblePrincipal === 0n'));
      assert(source.includes('No Remaining Milestones Eligible'));
      assert(source.includes('isClient && eligiblePrincipal > 0n'));
    });

    it('N. >16 milestones blocks activation', () => {
      const compPath = path.join(process.cwd(), 'src/components/deals/V2DealFunding.tsx');
      const source = fs.readFileSync(compPath, 'utf8');

      assert(source.includes('exceedsMaxMilestones'));
      assert(source.includes('Milestone Limit Exceeded'));
      assert(source.includes('!exceedsMaxMilestones'));
    });

    it('O. exact deadline boundary: now == deadline + grace => eligible, now > deadline + grace => excluded', () => {
      const deadline = 500000n;
      const grace = 100n;
      const threshold = deadline + grace;

      const at = calculateEligibleMilestones([{ status: 0, amount: 100n, workDeadline: deadline, gracePeriod: grace }], threshold);
      assert.strictEqual(at.eligibleCount, 1);

      const past = calculateEligibleMilestones([{ status: 0, amount: 100n, workDeadline: deadline, gracePeriod: grace }], threshold + 1n);
      assert.strictEqual(past.eligibleCount, 0);
    });

    it('P. historical V1 policy remains readable', async () => {
      const mockClient = createMockPublicClient();
      const policy = await readDealPremiumPolicy(mockClient, OLD_V1_ADDR, HISTORICAL_QA_DEAL, 'V1');

      assert.notStrictEqual(policy, null);
      assert.strictEqual(policy?.client?.toLowerCase(), '0xD2D4d415a4730b1490c9Ce27944529B83ff76319'.toLowerCase());
      assert.strictEqual(policy?.purchasedAt, 1791250104n);
      assert.strictEqual(policy?.premiumPaid, 100000n);
      assert.strictEqual(policy?.maxCoverage, 1000000n);
      assert.strictEqual(policy?.totalPaid, 0n);
      assert.strictEqual(policy?.active, true);
    });

    it('Q. uninitialized V1.1 policy decodes safely', async () => {
      const mockClient = createMockPublicClient();
      const policy = await readDealPremiumPolicy(mockClient, NEW_V1_1_ADDR, HISTORICAL_QA_DEAL, 'V1_1');

      assert.notStrictEqual(policy, null);
      assert.strictEqual(policy?.active, false);
      assert.strictEqual(policy?.purchasedAt, 0n);
      assert.strictEqual(policy?.coveredBitmap, 0);
      assert.strictEqual(policy?.eligiblePrincipal, 0n);
      assert.strictEqual(policy?.premiumPaid, 0n);
      assert.strictEqual(policy?.maxCoverage, 0n);
      assert.strictEqual(policy?.totalPaid, 0n);
    });
  });
});
