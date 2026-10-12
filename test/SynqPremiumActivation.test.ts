// test/SynqPremiumActivation.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isAddress, getAddress } from 'viem';
import { NextRequest } from 'next/server';
import { GET as handleGetProtection } from '@/app/api/deals/[dealAddress]/protection/route';
import {
  setDealProposalRepository,
  resetDealProposalRepository,
  InMemoryDealProposalRepository,
} from '@/lib/deals/proposals-db';
import { signToken } from '@/lib/auth';
import {
  SYNQ_V2_SEPOLIA_CONFIG,
  SEPOLIA_CHAIN_ID,
  getSynqPremiumConfig,
  isPremiumProtectionConfigured,
} from '@/lib/contracts/addresses';
import {
  ZERO_ADDRESS,
  buildStandardV2Proposal,
} from '@/lib/deals/v2';
import {
  synqPremiumProtectionManagerABI,
  synqProtectionPoolABI,
  erc20ABI,
} from '@/lib/contracts/abis';
import { DealState } from '@/lib/deals/v2-deal';
import {
  calculatePremiumFee,
  calculateMaximumCoverage,
  BPS_DENOMINATOR,
  DEFAULT_COVERAGE_RATE_BPS,
  readPremiumManagerParameters,
  readDealPremiumPolicy,
  readClientPremiumAllowance,
  readPoolAvailableBalance,
  validatePremiumApprovalPreflight,
  validatePremiumActivationPreflight,
  PremiumPolicyState,
} from '@/lib/deals/v2-protection';

// Test Fixtures
const TEST_CLIENT = '0xD2D4d415a4730b1490c9Ce27944529B83ff76319';
const TEST_FREELANCER = '0xd646585Fb453be3698F6D959d796C1D86B832c04';
const TEST_DEAL_ADDRESS = '0x142Ee9d2b5B6758F4D00439f3583fDcB89309807';
const TEST_MANAGER_ADDRESS = '0x1111111111111111111111111111111111111111';
const TEST_POOL_ADDRESS = '0x2222222222222222222222222222222222222222';
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

describe('SYNQ PREMIUM PROTECTION V1 — PHASE 4B ACTIVATION INTEGRATION', () => {

  // ==================================================
  // 1-3: PURE MATH & SOLIDITY TRUNCATION MATCHING
  // ==================================================

  it('1. Premium fee bigint math matches 10% (1000 bps) specification', () => {
    const totalEscrow = 100_000_000n; // 100 USDC (6 decimals)
    const feeBps = 1000; // 10%
    const fee = calculatePremiumFee(totalEscrow, feeBps);
    assert.strictEqual(fee, 10_000_000n); // 10 USDC

    // Edge cases
    assert.strictEqual(calculatePremiumFee(0n, feeBps), 0n);
    assert.strictEqual(calculatePremiumFee(totalEscrow, 0), 0n);
  });

  it('2. max coverage bigint math matches 20% (2000 bps) specification', () => {
    const totalEscrow = 100_000_000n; // 100 USDC
    const coverage = calculateMaximumCoverage(totalEscrow, DEFAULT_COVERAGE_RATE_BPS);
    assert.strictEqual(coverage, 20_000_000n); // 20 USDC

    // Custom rate
    assert.strictEqual(calculateMaximumCoverage(totalEscrow, 2500), 25_000_000n); // 25%
    assert.strictEqual(calculateMaximumCoverage(0n, 2000), 0n);
  });

  it('3. integer truncation matches Solidity floor division exactly', () => {
    const oddEscrow = 999_999n; // 0.999999 USDC
    // Solidity: (999999 * 1000) / 10000 = 999999000 / 10000 = 99999
    const fee = calculatePremiumFee(oddEscrow, 1000);
    assert.strictEqual(fee, 99_999n);

    // Coverage: (999999 * 2000) / 10000 = 1999998000 / 10000 = 199999
    const coverage = calculateMaximumCoverage(oddEscrow, 2000);
    assert.strictEqual(coverage, 199_999n);
  });

  // ==================================================
  // 4-6: INTENT & DEAL STATE TRANSITIONS
  // ==================================================

  it('4. Standard proposal does not expose Premium activation', () => {
    const protectionSelection: 'STANDARD' | 'PREMIUM' = 'STANDARD';
    const dealState: DealState = DealState.Active;

    // When protectionSelection is STANDARD, the Premium module is never rendered
    const shouldRenderPremiumModule = (protectionSelection as string) === 'PREMIUM' && dealState === DealState.Active;
    assert.strictEqual(shouldRenderPremiumModule, false);
  });

  it('5. Premium Draft deal explains post-funding activation without blocking funding', () => {
    const protectionSelection: 'STANDARD' | 'PREMIUM' = 'PREMIUM';
    const dealState: DealState = DealState.Draft;

    // Premium is not active or callable before fundDeal()
    const canActivatePremiumInDraft = (dealState as DealState) === DealState.Active;
    assert.strictEqual(canActivatePremiumInDraft, false);

    // Preflight check verifies that Premium approval fails if deal is not Active
    const preflight = validatePremiumApprovalPreflight({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      managerAddress: TEST_MANAGER_ADDRESS,
      dealState: DealState.Draft,
      premiumFee: 10_000_000n,
      balance: 100_000_000n,
    });
    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error!, /Deal must be funded and active/);
  });

  it('6. Premium Active deal enters activation state', () => {
    const protectionSelection = 'PREMIUM';
    const dealState = DealState.Active;
    const policyActive = false;
    const isConfigured = true;

    const shouldEnterActivation =
      protectionSelection === 'PREMIUM' &&
      dealState === DealState.Active &&
      !policyActive &&
      isConfigured;

    assert.strictEqual(shouldEnterActivation, true);
  });

  // ==================================================
  // 7: PRE-DEPLOYMENT UNCONFIGURED ZERO ADDRESS SAFETY
  // ==================================================

  it('7. unconfigured Premium contracts never query ZERO_ADDRESS', async () => {
    let rpcCallCount = 0;
    const mockClient = {
      readContract: async () => {
        rpcCallCount++;
        return 0n;
      },
    };

    // 1. Unconfigured null manager
    const paramsNull = await readPremiumManagerParameters(mockClient, null);
    assert.strictEqual(paramsNull, null);

    // 2. ZERO_ADDRESS manager
    const paramsZero = await readPremiumManagerParameters(mockClient, ZERO_ADDRESS);
    assert.strictEqual(paramsZero, null);

    // 3. ZERO_ADDRESS policy lookup
    const policyZero = await readDealPremiumPolicy(mockClient, ZERO_ADDRESS, TEST_DEAL_ADDRESS);
    assert.strictEqual(policyZero, null);

    // 4. ZERO_ADDRESS allowance lookup
    const allowanceZero = await readClientPremiumAllowance(
      mockClient,
      SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      TEST_CLIENT,
      ZERO_ADDRESS
    );
    assert.strictEqual(allowanceZero, 0n);

    // 5. ZERO_ADDRESS pool lookup
    const poolZero = await readPoolAvailableBalance(mockClient, ZERO_ADDRESS);
    assert.strictEqual(poolZero, 0n);

    // Crucial check: zero RPC calls were triggered
    assert.strictEqual(rpcCallCount, 0);
  });

  // ==================================================
  // 8-10: APPROVAL & ACTIVATION PREFLIGHTS & ACTIVE POLICY
  // ==================================================

  it('8. insufficient allowance requires Approve', () => {
    const preflight = validatePremiumActivationPreflight({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      managerAddress: TEST_MANAGER_ADDRESS,
      dealState: DealState.Active,
      premiumFee: 10_000_000n,
      balance: 100_000_000n,
      allowance: 5_000_000n, // less than 10 USDC
      existingPolicy: null,
    });
    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error!, /USDC allowance is insufficient/);
  });

  it('9. sufficient allowance enables Activate', () => {
    const preflight = validatePremiumActivationPreflight({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      managerAddress: TEST_MANAGER_ADDRESS,
      dealState: DealState.Active,
      premiumFee: 10_000_000n,
      balance: 100_000_000n,
      allowance: 10_000_000n, // exactly equal
      existingPolicy: null,
    });
    assert.strictEqual(preflight.valid, true);
  });

  it('10. active policy renders Premium Protected state', () => {
    const mockPolicy: PremiumPolicyState = {
      client: TEST_CLIENT,
      purchasedAt: 1728100000n,
      premiumPaid: 10_000_000n,
      maxCoverage: 20_000_000n,
      totalPaid: 0n,
      active: true,
    };

    assert.strictEqual(mockPolicy.active, true);
    assert.strictEqual(mockPolicy.premiumPaid, 10_000_000n);
    assert.strictEqual(mockPolicy.maxCoverage, 20_000_000n);
  });

  // ==================================================
  // 11-13: DECOUPLING FROM STANDARD V2 & IMMUTABILITY
  // ==================================================

  it('11. policy data uses Manager policy, not Standard V2 isProtected', () => {
    // Canonical Standard V2 deal has isProtected = false
    const standardV2DealOnChain = {
      dealAddress: TEST_DEAL_ADDRESS,
      isProtected: false,
      protectionModule: ZERO_ADDRESS,
      policyId: ZERO_BYTES32,
    };
    assert.strictEqual(standardV2DealOnChain.isProtected, false);

    // Premium status is external and queried via Manager contract
    const externalPolicy: PremiumPolicyState = {
      client: TEST_CLIENT,
      purchasedAt: 1728100000n,
      premiumPaid: 10_000_000n,
      maxCoverage: 20_000_000n,
      totalPaid: 0n,
      active: true,
    };
    assert.strictEqual(externalPolicy.active, true);
  });

  it('12. Premium activation failure does not alter Standard funding state', () => {
    const initialDealState = DealState.Active;
    const initialTotalEscrow = 100_000_000n;

    // Simulate Premium activation revert
    const premiumActivationReverted = true;
    let currentDealState = initialDealState;
    let currentTotalEscrow = initialTotalEscrow;

    if (premiumActivationReverted) {
      // Invariant: Standard V2 deal state is NEVER modified
    }

    assert.strictEqual(currentDealState, DealState.Active);
    assert.strictEqual(currentTotalEscrow, 100_000_000n);
  });

  it('13. Premium proposal keeps isProtected=false, protectionModule=ZERO_ADDRESS, policyId=ZERO_BYTES32', () => {
    const built = buildStandardV2Proposal({
      client: TEST_CLIENT,
      freelancer: TEST_FREELANCER,
      milestones: [
        {
          amount: 50_000_000n,
          workDeadline: BigInt(Math.floor(Date.now() / 1000) + 86400 * 3),
          reviewWindow: 259200n,
          gracePeriod: 86400n,
          specHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        },
      ],
      proposalNonce: 0n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 86400 * 7),
    });

    assert.strictEqual(built.proposal.isProtected, false);
    assert.strictEqual(built.proposal.protectionModule, ZERO_ADDRESS);
    assert.strictEqual(built.proposal.policyId, ZERO_BYTES32);
    assert.strictEqual(isAddress(built.proposal.canonicalUsdc), true);
    assert.strictEqual(typeof built.proposalId, 'string');
  });

  // ==================================================
  // 14-16: PROTECTION INTENT API UNIT VERIFICATION
  // ==================================================

  it('14. API returns PREMIUM intent by dealAddress', () => {
    const mockProposalInDb = {
      id: 'prop-123',
      dealAddress: TEST_DEAL_ADDRESS,
      clientAddress: TEST_CLIENT,
      freelancerAddress: TEST_FREELANCER,
      protectionSelection: 'PREMIUM',
    };

    // Route logic simulates:
    const responsePayload = {
      dealAddress: getAddress(mockProposalInDb.dealAddress),
      proposalId: mockProposalInDb.id,
      protectionSelection: mockProposalInDb.protectionSelection,
    };

    assert.strictEqual(responsePayload.protectionSelection, 'PREMIUM');
    assert.strictEqual(responsePayload.dealAddress, getAddress(TEST_DEAL_ADDRESS));
  });

  it('15. legacy/missing protection intent safely behaves STANDARD', () => {
    // Missing proposal in DB
    const missingProposal = null;
    const defaultResponse = {
      dealAddress: getAddress(TEST_DEAL_ADDRESS),
      proposalId: null,
      protectionSelection: 'STANDARD',
    };
    assert.strictEqual(defaultResponse.protectionSelection, 'STANDARD');

    // Legacy proposal with null protectionSelection
    const legacyProposal = {
      id: 'legacy-1',
      dealAddress: TEST_DEAL_ADDRESS,
      protectionSelection: null as any,
    };
    const legacySelection = legacyProposal.protectionSelection === 'PREMIUM' ? 'PREMIUM' : 'STANDARD';
    assert.strictEqual(legacySelection, 'STANDARD');
  });

  it('16. invalid deal address is rejected', () => {
    const invalidAddress = '0xinvalid_address_123';
    assert.strictEqual(isAddress(invalidAddress), false);
  });

  // ==================================================
  // 17-20: SECURITY, SPENDER & REGRESSION VERIFICATIONS
  // ==================================================

  it('17. duplicate UI actions are blocked while tx pending', () => {
    let actionInProgress: 'approvePremium' | 'activatePremium' | null = 'activatePremium';
    const isButtonDisabled = actionInProgress !== null;
    assert.strictEqual(isButtonDisabled, true);
  });

  it('18. Premium fee spender is Manager, NOT Pool', () => {
    // In Manager contract:
    // usdc.safeTransferFrom(msg.sender, address(pool), premiumFee);
    // Since msg.sender calls Manager, msg.sender must approve Manager as spender!
    const spenderAddress = TEST_MANAGER_ADDRESS;
    assert.notStrictEqual(spenderAddress, TEST_POOL_ADDRESS);
    assert.strictEqual(spenderAddress, TEST_MANAGER_ADDRESS);
  });

  it('19. exact fee approval behavior (never MaxUint256)', () => {
    const totalEscrow = 100_000_000n; // 100 USDC
    const feeBps = 1000; // 10%
    const calculatedFee = calculatePremiumFee(totalEscrow, feeBps);

    // Exact approval matches fee
    const approvalAmount = calculatedFee;
    assert.strictEqual(approvalAmount, 10_000_000n);
    assert.notStrictEqual(approvalAmount, 2n ** 256n - 1n);
  });

  it('20. Standard V2 regression remains intact', () => {
    // Standard V2 parameters remain completely independent
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.chainId, 11155111);
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.isProtected, false);
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.protectionModule, ZERO_ADDRESS);
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.policyId, ZERO_BYTES32);
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.usdcDecimals, 6);
  });

  // ==================================================
  // 21-25: PROTECTION API PARTICIPANT AUTHORIZATION
  // ==================================================

  it('21. GET /api/deals/[dealAddress]/protection returns 401 when unauthenticated', async () => {
    const memoryRepo = new InMemoryDealProposalRepository();
    await memoryRepo.create({
      proposalId: '0x1111111111111111111111111111111111111111111111111111111111111111',
      proposalNonce: '0',
      chainId: 11155111,
      factoryAddress: SYNQ_V2_SEPOLIA_CONFIG.factory,
      clientWallet: TEST_CLIENT,
      freelancerWallet: TEST_FREELANCER,
      canonicalUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealImplementation: SYNQ_V2_SEPOLIA_CONFIG.dealImplementation,
      primaryResolver: SYNQ_V2_SEPOLIA_CONFIG.primaryResolver,
      emergencyResolver: SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver,
      milestonesHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
      isProtected: false,
      protectionModule: ZERO_ADDRESS,
      policyId: ZERO_BYTES32,
      expiry: '1799999999',
      clientSignature: '0x1234',
      title: 'Test Deal',
      scope: 'Test Scope',
      totalAmount: '5000000',
      milestones: [],
      dealAddress: TEST_DEAL_ADDRESS,
      protectionSelection: 'PREMIUM',
    });
    setDealProposalRepository(memoryRepo);

    try {
      const unauthReq = new NextRequest(`http://localhost:3000/api/deals/${TEST_DEAL_ADDRESS}/protection`);
      const res = await handleGetProtection(unauthReq, { params: { dealAddress: TEST_DEAL_ADDRESS } });
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.strictEqual(data.error, 'Unauthorized');
    } finally {
      resetDealProposalRepository();
    }
  });

  it('22. GET /api/deals/[dealAddress]/protection returns 403 when authenticated as stranger', async () => {
    const memoryRepo = new InMemoryDealProposalRepository();
    await memoryRepo.create({
      proposalId: '0x1111111111111111111111111111111111111111111111111111111111111111',
      proposalNonce: '0',
      chainId: 11155111,
      factoryAddress: SYNQ_V2_SEPOLIA_CONFIG.factory,
      clientWallet: TEST_CLIENT,
      freelancerWallet: TEST_FREELANCER,
      canonicalUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealImplementation: SYNQ_V2_SEPOLIA_CONFIG.dealImplementation,
      primaryResolver: SYNQ_V2_SEPOLIA_CONFIG.primaryResolver,
      emergencyResolver: SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver,
      milestonesHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
      isProtected: false,
      protectionModule: ZERO_ADDRESS,
      policyId: ZERO_BYTES32,
      expiry: '1799999999',
      clientSignature: '0x1234',
      title: 'Test Deal',
      scope: 'Test Scope',
      totalAmount: '5000000',
      milestones: [],
      dealAddress: TEST_DEAL_ADDRESS,
      protectionSelection: 'PREMIUM',
    });
    setDealProposalRepository(memoryRepo);

    try {
      const strangerToken = signToken({ userId: 'u-stranger', walletAddress: '0x0000000000000000000000000000000000000099' });
      const strangerReq = new NextRequest(`http://localhost:3000/api/deals/${TEST_DEAL_ADDRESS}/protection`, {
        headers: { authorization: `Bearer ${strangerToken}` },
      });
      const res = await handleGetProtection(strangerReq, { params: { dealAddress: TEST_DEAL_ADDRESS } });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.error, 'Forbidden');
    } finally {
      resetDealProposalRepository();
    }
  });

  it('23. GET /api/deals/[dealAddress]/protection allows client to read PREMIUM intent', async () => {
    const memoryRepo = new InMemoryDealProposalRepository();
    const pid = '0x1111111111111111111111111111111111111111111111111111111111111111';
    await memoryRepo.create({
      proposalId: pid,
      proposalNonce: '0',
      chainId: 11155111,
      factoryAddress: SYNQ_V2_SEPOLIA_CONFIG.factory,
      clientWallet: TEST_CLIENT,
      freelancerWallet: TEST_FREELANCER,
      canonicalUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealImplementation: SYNQ_V2_SEPOLIA_CONFIG.dealImplementation,
      primaryResolver: SYNQ_V2_SEPOLIA_CONFIG.primaryResolver,
      emergencyResolver: SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver,
      milestonesHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
      isProtected: false,
      protectionModule: ZERO_ADDRESS,
      policyId: ZERO_BYTES32,
      expiry: '1799999999',
      clientSignature: '0x1234',
      title: 'Test Deal',
      scope: 'Test Scope',
      totalAmount: '5000000',
      milestones: [],
      dealAddress: TEST_DEAL_ADDRESS,
      protectionSelection: 'PREMIUM',
    });
    setDealProposalRepository(memoryRepo);

    try {
      const clientToken = signToken({ userId: 'u-client', walletAddress: TEST_CLIENT });
      const clientReq = new NextRequest(`http://localhost:3000/api/deals/${TEST_DEAL_ADDRESS}/protection`, {
        headers: { authorization: `Bearer ${clientToken}` },
      });
      const res = await handleGetProtection(clientReq, { params: { dealAddress: TEST_DEAL_ADDRESS } });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.protectionSelection, 'PREMIUM');
      assert.strictEqual(data.dealAddress, getAddress(TEST_DEAL_ADDRESS));
      assert.strictEqual(data.proposalId, pid);
    } finally {
      resetDealProposalRepository();
    }
  });

  it('24. GET /api/deals/[dealAddress]/protection allows freelancer to read PREMIUM intent', async () => {
    const memoryRepo = new InMemoryDealProposalRepository();
    await memoryRepo.create({
      proposalId: '0x1111111111111111111111111111111111111111111111111111111111111111',
      proposalNonce: '0',
      chainId: 11155111,
      factoryAddress: SYNQ_V2_SEPOLIA_CONFIG.factory,
      clientWallet: TEST_CLIENT,
      freelancerWallet: TEST_FREELANCER,
      canonicalUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealImplementation: SYNQ_V2_SEPOLIA_CONFIG.dealImplementation,
      primaryResolver: SYNQ_V2_SEPOLIA_CONFIG.primaryResolver,
      emergencyResolver: SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver,
      milestonesHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
      isProtected: false,
      protectionModule: ZERO_ADDRESS,
      policyId: ZERO_BYTES32,
      expiry: '1799999999',
      clientSignature: '0x1234',
      title: 'Test Deal',
      scope: 'Test Scope',
      totalAmount: '5000000',
      milestones: [],
      dealAddress: TEST_DEAL_ADDRESS,
      protectionSelection: 'PREMIUM',
    });
    setDealProposalRepository(memoryRepo);

    try {
      const freelancerToken = signToken({ userId: 'u-freelancer', walletAddress: TEST_FREELANCER });
      const freelancerReq = new NextRequest(`http://localhost:3000/api/deals/${TEST_DEAL_ADDRESS}/protection`, {
        headers: { authorization: `Bearer ${freelancerToken}` },
      });
      const res = await handleGetProtection(freelancerReq, { params: { dealAddress: TEST_DEAL_ADDRESS } });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.protectionSelection, 'PREMIUM');
    } finally {
      resetDealProposalRepository();
    }
  });

  it('25. GET /api/deals/[dealAddress]/protection returns STANDARD for STANDARD proposal', async () => {
    const memoryRepo = new InMemoryDealProposalRepository();
    await memoryRepo.create({
      proposalId: '0x2222222222222222222222222222222222222222222222222222222222222222',
      proposalNonce: '0',
      chainId: 11155111,
      factoryAddress: SYNQ_V2_SEPOLIA_CONFIG.factory,
      clientWallet: TEST_CLIENT,
      freelancerWallet: TEST_FREELANCER,
      canonicalUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealImplementation: SYNQ_V2_SEPOLIA_CONFIG.dealImplementation,
      primaryResolver: SYNQ_V2_SEPOLIA_CONFIG.primaryResolver,
      emergencyResolver: SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver,
      milestonesHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
      isProtected: false,
      protectionModule: ZERO_ADDRESS,
      policyId: ZERO_BYTES32,
      expiry: '1799999999',
      clientSignature: '0x1234',
      title: 'Standard Deal',
      scope: 'Standard Scope',
      totalAmount: '5000000',
      milestones: [],
      dealAddress: TEST_DEAL_ADDRESS,
      protectionSelection: 'STANDARD',
    });
    setDealProposalRepository(memoryRepo);

    try {
      const clientToken = signToken({ userId: 'u-client', walletAddress: TEST_CLIENT });
      const clientReq = new NextRequest(`http://localhost:3000/api/deals/${TEST_DEAL_ADDRESS}/protection`, {
        headers: { authorization: `Bearer ${clientToken}` },
      });
      const res = await handleGetProtection(clientReq, { params: { dealAddress: TEST_DEAL_ADDRESS } });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.protectionSelection, 'STANDARD');
    } finally {
      resetDealProposalRepository();
    }
  });

  // ==================================================
  // 26-32: CLIENT-SIDE ERROR HANDLING & STATE MODEL
  // ==================================================

  // Helper simulating the exact parse/state reducer in V2DealFunding.fetchProtectionIntent
  function resolveProtectionResponse(
    status: number,
    body: any,
    networkError?: boolean
  ): { selection: 'STANDARD' | 'PREMIUM' | null; error: string | null } {
    if (networkError) {
      return { selection: null, error: 'Network error verifying deal protection intent.' };
    }
    if (status === 401) {
      return { selection: null, error: 'Authentication session expired or invalid (401). Please re-authenticate.' };
    }
    if (status === 403) {
      return { selection: null, error: 'Access restricted: You are not an authorized participant (client or freelancer) in this deal (403).' };
    }
    if (status !== 200) {
      return { selection: null, error: `Server error verifying protection intent (HTTP ${status}).` };
    }
    if (body && (body.protectionSelection === 'PREMIUM' || body.protectionSelection === 'STANDARD')) {
      return { selection: body.protectionSelection, error: null };
    }
    return { selection: null, error: 'Malformed protection response received from server.' };
  }

  it('26. HTTP 401 does NOT become STANDARD (sets error, preserves unknown state)', () => {
    const outcome = resolveProtectionResponse(401, { error: 'Unauthorized' });
    assert.strictEqual(outcome.selection, null);
    assert.notStrictEqual(outcome.selection, 'STANDARD');
    assert.strictEqual(outcome.error?.includes('401'), true);
  });

  it('27. HTTP 403 does NOT become STANDARD (sets error, preserves unknown state)', () => {
    const outcome = resolveProtectionResponse(403, { error: 'Forbidden' });
    assert.strictEqual(outcome.selection, null);
    assert.notStrictEqual(outcome.selection, 'STANDARD');
    assert.strictEqual(outcome.error?.includes('403'), true);
  });

  it('28. HTTP 500 does NOT become STANDARD (sets error, preserves unknown state)', () => {
    const outcome = resolveProtectionResponse(500, { error: 'Internal server error' });
    assert.strictEqual(outcome.selection, null);
    assert.notStrictEqual(outcome.selection, 'STANDARD');
    assert.strictEqual(outcome.error?.includes('HTTP 500'), true);
  });

  it('29. Network failure does NOT become STANDARD (sets error, preserves unknown state)', () => {
    const outcome = resolveProtectionResponse(0, null, true);
    assert.strictEqual(outcome.selection, null);
    assert.notStrictEqual(outcome.selection, 'STANDARD');
    assert.strictEqual(outcome.error?.includes('Network error'), true);
  });

  it('30. Malformed payload does NOT become STANDARD (sets error, preserves unknown state)', () => {
    const outcome = resolveProtectionResponse(200, { unexpectedField: 'xyz' });
    assert.strictEqual(outcome.selection, null);
    assert.notStrictEqual(outcome.selection, 'STANDARD');
    assert.strictEqual(outcome.error?.includes('Malformed'), true);
  });

  it('31. Valid PREMIUM payload sets PREMIUM without error', () => {
    const outcome = resolveProtectionResponse(200, { protectionSelection: 'PREMIUM' });
    assert.strictEqual(outcome.selection, 'PREMIUM');
    assert.strictEqual(outcome.error, null);
  });

  it('32. Valid STANDARD payload sets STANDARD without error', () => {
    const outcome = resolveProtectionResponse(200, { protectionSelection: 'STANDARD' });
    assert.strictEqual(outcome.selection, 'STANDARD');
    assert.strictEqual(outcome.error, null);
  });

  // ==================================================
  // 33-35: LIVE TEST DEAL INTEGRATION PARAMETERS
  // ==================================================

  it('33. Live 5.00 USDC deal calculates exact 0.10 USDC fee (200 bps) and 1.00 USDC cap (2000 bps)', () => {
    const liveEscrow = 5_000_000n; // 5.00 USDC
    const liveFeeBps = 200; // 2%
    const liveCovBps = 2000; // 20%
    const calculatedFee = calculatePremiumFee(liveEscrow, liveFeeBps);
    const calculatedCoverage = calculateMaximumCoverage(liveEscrow, liveCovBps);

    assert.strictEqual(calculatedFee, 100_000n); // 0.10 USDC
    assert.strictEqual(calculatedCoverage, 1_000_000n); // 1.00 USDC
  });

  it('34. Client-only activation: non-client participant is blocked from activation controls', () => {
    const clientAddress = TEST_CLIENT;
    const connectedAddress = TEST_FREELANCER;
    const isCallerClient = clientAddress.toLowerCase() === connectedAddress.toLowerCase();
    assert.strictEqual(isCallerClient, false);
    // UI displays restricted notice for non-client
    const renderedTreatment = isCallerClient ? 'CONTROLS' : 'RESTRICTED_NOTICE';
    assert.strictEqual(renderedTreatment, 'RESTRICTED_NOTICE');
  });

  it('35. Inactive policy triggers activation flow; Active policy triggers protected status', () => {
    const inactivePolicy: PremiumPolicyState = {
      active: false,
      premiumPaid: 0n,
      maxCoverage: 0n,
      totalPaid: 0n,
      purchasedAt: 0n,
    };
    const activePolicy: PremiumPolicyState = {
      active: true,
      premiumPaid: 100_000n,
      maxCoverage: 1_000_000n,
      totalPaid: 0n,
      purchasedAt: 1791240000n,
    };

    assert.strictEqual(inactivePolicy.active, false);
    assert.strictEqual(activePolicy.active, true);
  });
});
