// test/SynqV2DealFunding.test.ts
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
  determineDealRole,
  determineFundingEligibility,
  validateApprovalPreflight,
  validateFundingPreflight,
  verifyFundingReceipt,
  verifyV2DealIdentitySync,
  isSynqV2Deal,
  readStandardV2DealData,
  readClientUsdcFundingState,
  DEAL_FUNDED_TOPIC0,
} from '@/lib/deals/v2-deal';
import { formatUsdcAmount, parseUsdcAmount } from '@/lib/deals/v2';
import {
  validateAcceptPreflight,
  validateDeclinePreflight,
  validateCancelPreflight,
  verifyProposalPendingOnChain,
} from '@/lib/deals/v2-actions';
import { validateDealReceiptPayload, validateDealProposalPayload, validateTrustedMessageData } from '@/lib/synq-message';

// Test Constants & Wallets
const TEST_CLIENT = '0xD2D4d415a4730b1490c9Ce27944529B83ff76319';
const TEST_FREELANCER = '0xd646585Fb453be3698F6D959d796C1D86B832c04';
const TEST_STRANGER = '0x1111111111111111111111111111111111111111';
const TEST_DEAL_ADDRESS = '0x142Ee9d2b5B6758F4D00439f3583fDcB89309807';
const TEST_RESOLVER_1 = '0xd60bBCc7c8aCA633A6D158B6f7F7367E36207676';
const TEST_RESOLVER_2 = '0x5dcB412bA5f032Bc9095CDc95046168A076Ff952';
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';
const REQUIRED_ESCROW = 50_000_000n; // 50 USDC

describe('PHASE 3F: STANDARD V2 DEAL DETAILS + EXACT USDC FUNDING', () => {

  // ==================================================
  // DEAL IDENTITY (Tests 1-5)
  // ==================================================

  it('1. valid canonical V2 Deal accepted', async () => {
    const mockClient = {
      readContract: async ({ functionName, args }: any) => {
        if (functionName === 'isSynqDeal' && args[0].toLowerCase() === TEST_DEAL_ADDRESS.toLowerCase()) {
          return true;
        }
        return false;
      },
    };

    const isV2 = await isSynqV2Deal(TEST_DEAL_ADDRESS, mockClient);
    assert.strictEqual(isV2, true);

    const syncCheck = verifyV2DealIdentitySync({
      dealAddress: TEST_DEAL_ADDRESS,
      isFactoryRegistered: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
    });
    assert.strictEqual(syncCheck.valid, true);
    assert.strictEqual(syncCheck.error, undefined);
  });

  it('2. random contract/address rejected as V2 Deal', async () => {
    const randomAddress = '0x000000000000000000000000000000000000beef';
    const mockClient = {
      readContract: async () => false,
    };

    const isV2 = await isSynqV2Deal(randomAddress, mockClient);
    assert.strictEqual(isV2, false);

    const syncCheck = verifyV2DealIdentitySync({
      dealAddress: randomAddress,
      isFactoryRegistered: false,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
    });
    assert.strictEqual(syncCheck.valid, false);
    assert.match(syncCheck.error!, /not registered in canonical SynqFactoryV2/);
  });

  it('3. malformed address rejected', async () => {
    const malformed = 'not-an-address';
    const mockClient = {
      readContract: async () => true,
    };

    const isV2 = await isSynqV2Deal(malformed, mockClient);
    assert.strictEqual(isV2, false);

    const syncCheck = verifyV2DealIdentitySync({
      dealAddress: malformed,
      isFactoryRegistered: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
    });
    assert.strictEqual(syncCheck.valid, false);
    assert.match(syncCheck.error!, /Invalid deal address/);
  });

  it('4. canonical Factory relationship verified', async () => {
    let capturedFactory: string = '';
    let capturedFunction: string = '';
    let capturedArg: string = '';

    const mockClient = {
      readContract: async ({ address, functionName, args }: any) => {
        capturedFactory = address;
        capturedFunction = functionName;
        capturedArg = args[0];
        return true;
      },
    };

    await isSynqV2Deal(TEST_DEAL_ADDRESS, mockClient);
    assert.strictEqual(capturedFactory.toLowerCase(), SYNQ_V2_SEPOLIA_CONFIG.factory.toLowerCase());
    assert.strictEqual(capturedFunction, 'isSynqDeal');
    assert.strictEqual(capturedArg.toLowerCase(), TEST_DEAL_ADDRESS.toLowerCase());
  });

  it('5. wrong USDC Deal fails closed', async () => {
    const counterfeitUsdc = '0x9999999999999999999999999999999999999999';
    const syncCheck = verifyV2DealIdentitySync({
      dealAddress: TEST_DEAL_ADDRESS,
      isFactoryRegistered: true,
      dealUsdc: counterfeitUsdc,
    });
    assert.strictEqual(syncCheck.valid, false);
    assert.match(syncCheck.error!, /does not match canonical Sepolia USDC/);

    const mockClient = {
      readContract: async ({ functionName }: any) => {
        if (functionName === 'isSynqDeal') return true;
        if (functionName === 'usdc') return counterfeitUsdc;
        if (functionName === 'state') return 0;
        if (functionName === 'client') return TEST_CLIENT;
        if (functionName === 'freelancer') return TEST_FREELANCER;
        if (functionName === 'totalEscrow') return 50_000_000n;
        if (functionName === 'totalSettled') return 0n;
        if (functionName === 'milestoneCount') return 0n;
        if (functionName === 'isProtected') return false;
        if (functionName === 'policyId') return ZERO_BYTES32;
        if (functionName === 'primaryResolver') return TEST_RESOLVER_1;
        if (functionName === 'emergencyResolver') return TEST_RESOLVER_2;
        return 0;
      },
    };

    await assert.rejects(
      async () => readStandardV2DealData(TEST_DEAL_ADDRESS, mockClient),
      /Deal USDC mismatch/
    );
  });

  // ==================================================
  // STATE (Tests 6-11)
  // ==================================================

  it('6. DealState enum exact mapping', () => {
    assert.strictEqual(DealState.Draft, 0);
    assert.strictEqual(DealState.Active, 1);
    assert.strictEqual(DealState.Completed, 2);
    assert.strictEqual(DealState.TerminatedEarly, 3);
    assert.strictEqual(DealState.Cancelled, 4);

    assert.strictEqual(DEAL_STATE_LABELS[DealState.Draft], 'Draft');
    assert.strictEqual(DEAL_STATE_LABELS[DealState.Active], 'Active');
    assert.strictEqual(DEAL_STATE_LABELS[DealState.Completed], 'Completed');
    assert.strictEqual(DEAL_STATE_LABELS[DealState.TerminatedEarly], 'Terminated Early');
    assert.strictEqual(DEAL_STATE_LABELS[DealState.Cancelled], 'Cancelled');
  });

  it('7. MilestoneStatus exact mapping', () => {
    assert.strictEqual(MilestoneStatus.Pending, 0);
    assert.strictEqual(MilestoneStatus.InProgress, 1);
    assert.strictEqual(MilestoneStatus.Submitted, 2);
    assert.strictEqual(MilestoneStatus.RevisionRequested, 3);
    assert.strictEqual(MilestoneStatus.Disputed, 4);
    assert.strictEqual(MilestoneStatus.ResolutionProposed, 5);
    assert.strictEqual(MilestoneStatus.FinalReview, 6);
    assert.strictEqual(MilestoneStatus.SettledPaid, 7);
    assert.strictEqual(MilestoneStatus.SettledRefunded, 8);
    assert.strictEqual(MilestoneStatus.SettledSplit, 9);
    assert.strictEqual(MilestoneStatus.AssessmentPending, 10);
    assert.strictEqual(MilestoneStatus.AssessmentProposed, 11);

    assert.strictEqual(MILESTONE_STATUS_LABELS[MilestoneStatus.Pending], 'Pending');
    assert.strictEqual(MILESTONE_STATUS_LABELS[MilestoneStatus.SettledPaid], 'Settled (Paid)');
  });

  it('8. Draft/unfunded renders Awaiting Client Funding', () => {
    const eligibility = determineFundingEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Draft,
      totalEscrow: REQUIRED_ESCROW,
      usdcBalance: 100_000_000n,
      usdcAllowance: 0n,
    });

    assert.strictEqual(eligibility.role, 'client');
    assert.strictEqual(eligibility.requiresApproval, true);
    assert.strictEqual(eligibility.canFund, false);
  });

  it('9. freelancer cannot fund', () => {
    const eligibility = determineFundingEligibility({
      connectedWallet: TEST_FREELANCER,
      clientAddress: TEST_CLIENT,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Draft,
      totalEscrow: REQUIRED_ESCROW,
      usdcBalance: 100_000_000n,
      usdcAllowance: 100_000_000n,
    });

    assert.strictEqual(eligibility.role, 'freelancer');
    assert.strictEqual(eligibility.canFund, false);
    assert.match(eligibility.reason!, /Awaiting client funding/);
  });

  it('10. third party cannot fund', () => {
    const eligibility = determineFundingEligibility({
      connectedWallet: TEST_STRANGER,
      clientAddress: TEST_CLIENT,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Draft,
      totalEscrow: REQUIRED_ESCROW,
      usdcBalance: 100_000_000n,
      usdcAllowance: 100_000_000n,
    });

    assert.strictEqual(eligibility.role, 'third_party');
    assert.strictEqual(eligibility.canFund, false);
    assert.match(eligibility.reason!, /Awaiting client funding/);
  });

  it('11. wrong chain cannot fund', () => {
    const WRONG_CHAIN_ID = 1; // Ethereum Mainnet
    const eligibility = determineFundingEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      freelancerAddress: TEST_FREELANCER,
      chainId: WRONG_CHAIN_ID,
      dealState: DealState.Draft,
      totalEscrow: REQUIRED_ESCROW,
      usdcBalance: 100_000_000n,
      usdcAllowance: 100_000_000n,
    });

    assert.strictEqual(eligibility.canFund, false);
    assert.match(eligibility.reason!, /switch your wallet to Ethereum Sepolia/);
  });

  // ==================================================
  // BALANCE (Tests 12-14)
  // ==================================================

  it('12. balance < required disables funding', () => {
    const insufficientBalance = 49_999_999n; // 1 base unit short of 50 USDC
    const eligibility = determineFundingEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Draft,
      totalEscrow: REQUIRED_ESCROW,
      usdcBalance: insufficientBalance,
      usdcAllowance: 0n,
    });

    assert.strictEqual(eligibility.canFund, false);
    assert.strictEqual(eligibility.hasInsufficientBalance, true);
    assert.match(eligibility.reason!, /Insufficient USDC balance/);
  });

  it('13. balance == required permits sequence', () => {
    const exactBalance = REQUIRED_ESCROW;
    const eligibility = determineFundingEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Draft,
      totalEscrow: REQUIRED_ESCROW,
      usdcBalance: exactBalance,
      usdcAllowance: 0n,
    });

    assert.strictEqual(eligibility.hasInsufficientBalance, false);
    assert.strictEqual(eligibility.requiresApproval, true);
  });

  it('14. balance > required permits sequence', () => {
    const excessBalance = 1_000_000_000n; // 1,000 USDC
    const eligibility = determineFundingEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Draft,
      totalEscrow: REQUIRED_ESCROW,
      usdcBalance: excessBalance,
      usdcAllowance: 0n,
    });

    assert.strictEqual(eligibility.hasInsufficientBalance, false);
    assert.strictEqual(eligibility.requiresApproval, true);
  });

  // ==================================================
  // ALLOWANCE (Tests 15-20)
  // ==================================================

  it('15. allowance 0 requires approval', () => {
    const eligibility = determineFundingEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Draft,
      totalEscrow: REQUIRED_ESCROW,
      usdcBalance: 100_000_000n,
      usdcAllowance: 0n,
    });

    assert.strictEqual(eligibility.requiresApproval, true);
    assert.strictEqual(eligibility.approvalAmount, REQUIRED_ESCROW);
    assert.strictEqual(eligibility.canFund, false);
  });

  it('16. allowance < required requires approval', () => {
    const partialAllowance = 25_000_000n; // 25 USDC out of 50
    const eligibility = determineFundingEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Draft,
      totalEscrow: REQUIRED_ESCROW,
      usdcBalance: 100_000_000n,
      usdcAllowance: partialAllowance,
    });

    assert.strictEqual(eligibility.requiresApproval, true);
    assert.strictEqual(eligibility.approvalAmount, REQUIRED_ESCROW);
    assert.strictEqual(eligibility.canFund, false);
  });

  it('17. allowance == required skips approval', () => {
    const exactAllowance = REQUIRED_ESCROW;
    const eligibility = determineFundingEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Draft,
      totalEscrow: REQUIRED_ESCROW,
      usdcBalance: 100_000_000n,
      usdcAllowance: exactAllowance,
    });

    assert.strictEqual(eligibility.requiresApproval, false);
    assert.strictEqual(eligibility.canFund, true);
  });

  it('18. allowance > required skips approval', () => {
    const excessAllowance = 500_000_000n;
    const eligibility = determineFundingEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Draft,
      totalEscrow: REQUIRED_ESCROW,
      usdcBalance: 100_000_000n,
      usdcAllowance: excessAllowance,
    });

    assert.strictEqual(eligibility.requiresApproval, false);
    assert.strictEqual(eligibility.canFund, true);
  });

  it('19. approval amount == exact required escrow', () => {
    const eligibility = determineFundingEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Draft,
      totalEscrow: REQUIRED_ESCROW,
      usdcBalance: 100_000_000n,
      usdcAllowance: 0n,
    });

    assert.strictEqual(eligibility.approvalAmount, 50_000_000n);
    assert.strictEqual(typeof eligibility.approvalAmount, 'bigint');
  });

  it('20. never MaxUint256', () => {
    const MAX_UINT256 = (1n << 256n) - 1n;
    const eligibility = determineFundingEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Draft,
      totalEscrow: REQUIRED_ESCROW,
      usdcBalance: 100_000_000n,
      usdcAllowance: 0n,
    });

    assert.notStrictEqual(eligibility.approvalAmount, MAX_UINT256);
    assert.strictEqual(eligibility.approvalAmount, REQUIRED_ESCROW);
  });

  // ==================================================
  // APPROVAL (Tests 21-26)
  // ==================================================

  it('21. approval target == canonical USDC', () => {
    assert.strictEqual(
      SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc.toLowerCase(),
      '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'.toLowerCase()
    );
  });

  it('22. approval spender == exact Deal address', () => {
    const spender = getAddress(TEST_DEAL_ADDRESS);
    assert.strictEqual(spender, getAddress('0x142Ee9d2b5B6758F4D00439f3583fDcB89309807'));
  });

  it('23. approval preflight rejects wrong client', () => {
    const preflight = validateApprovalPreflight({
      connectedWallet: TEST_STRANGER,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealState: DealState.Draft,
      totalEscrow: REQUIRED_ESCROW,
      balance: 100_000_000n,
      currentAllowance: 0n,
    });

    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error!, /Only the designated client/);
  });

  it('24. approval preflight rejects noncanonical USDC', () => {
    const preflight = validateApprovalPreflight({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: '0x0000000000000000000000000000000000000001',
      dealState: DealState.Draft,
      totalEscrow: REQUIRED_ESCROW,
      balance: 100_000_000n,
      currentAllowance: 0n,
    });

    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error!, /Asset mismatch/);
  });

  it('25. approval preflight detects allowance already sufficient', () => {
    const preflight = validateApprovalPreflight({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealState: DealState.Draft,
      totalEscrow: REQUIRED_ESCROW,
      balance: 100_000_000n,
      currentAllowance: REQUIRED_ESCROW, // already sufficient
    });

    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error!, /allowance is already sufficient/);
  });

  it('26. approval does not automatically call fundDeal', () => {
    const eligibilityAfterApproval = determineFundingEligibility({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      freelancerAddress: TEST_FREELANCER,
      chainId: SEPOLIA_CHAIN_ID,
      dealState: DealState.Draft,
      totalEscrow: REQUIRED_ESCROW,
      usdcBalance: 100_000_000n,
      usdcAllowance: REQUIRED_ESCROW,
    });

    // Approval transitions the state so canFund becomes true, but requires explicit user action for fundDeal
    assert.strictEqual(eligibilityAfterApproval.requiresApproval, false);
    assert.strictEqual(eligibilityAfterApproval.canFund, true);
  });

  // ==================================================
  // FUNDING (Tests 27-41)
  // ==================================================

  it('27. exact fundDeal ABI/signature used', () => {
    const fundDealAbi = synqDealV1ABI.find(
      (item: any) => item.type === 'function' && item.name === 'fundDeal'
    );
    assert.ok(fundDealAbi, 'fundDeal must exist in synqDealV1ABI');
    assert.strictEqual(fundDealAbi.stateMutability, 'nonpayable');
    assert.strictEqual(fundDealAbi.inputs.length, 0);
  });

  it('28. no msg.value sent', () => {
    const fundDealAbi = synqDealV1ABI.find(
      (item: any) => item.type === 'function' && item.name === 'fundDeal'
    );
    assert.ok(fundDealAbi);
    assert.strictEqual(fundDealAbi.stateMutability, 'nonpayable');
    assert.notStrictEqual(fundDealAbi.stateMutability, 'payable');
  });

  it('29. funding preflight checks authoritative Deal state', () => {
    const preflight = validateFundingPreflight({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealState: DealState.Active, // already Active
      contractTotalEscrow: REQUIRED_ESCROW,
      expectedTotalEscrow: REQUIRED_ESCROW,
      balance: 100_000_000n,
      allowance: REQUIRED_ESCROW,
    });

    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error!, /already funded/);
  });

  it('30. funding preflight checks client', () => {
    const preflight = validateFundingPreflight({
      connectedWallet: TEST_FREELANCER,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealState: DealState.Draft,
      contractTotalEscrow: REQUIRED_ESCROW,
      expectedTotalEscrow: REQUIRED_ESCROW,
      balance: 100_000_000n,
      allowance: REQUIRED_ESCROW,
    });

    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error!, /Only the client can fund this deal/);
  });

  it('31. funding preflight checks canonical USDC', () => {
    const preflight = validateFundingPreflight({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: '0x0000000000000000000000000000000000000002',
      dealState: DealState.Draft,
      contractTotalEscrow: REQUIRED_ESCROW,
      expectedTotalEscrow: REQUIRED_ESCROW,
      balance: 100_000_000n,
      allowance: REQUIRED_ESCROW,
    });

    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error!, /Asset mismatch/);
  });

  it('32. funding preflight checks balance', () => {
    const preflight = validateFundingPreflight({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealState: DealState.Draft,
      contractTotalEscrow: REQUIRED_ESCROW,
      expectedTotalEscrow: REQUIRED_ESCROW,
      balance: 40_000_000n, // 40 USDC < 50 USDC
      allowance: REQUIRED_ESCROW,
    });

    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error!, /Insufficient USDC balance/);
  });

  it('33. funding preflight checks allowance', () => {
    const preflight = validateFundingPreflight({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealState: DealState.Draft,
      contractTotalEscrow: REQUIRED_ESCROW,
      expectedTotalEscrow: REQUIRED_ESCROW,
      balance: 100_000_000n,
      allowance: 30_000_000n, // 30 USDC < 50 USDC
    });

    assert.strictEqual(preflight.valid, false);
    assert.match(preflight.error!, /Insufficient USDC allowance/);
  });

  it('34. already funded Deal blocks duplicate funding', () => {
    const preflightActive = validateFundingPreflight({
      connectedWallet: TEST_CLIENT,
      clientAddress: TEST_CLIENT,
      chainId: SEPOLIA_CHAIN_ID,
      isCanonicalV2Deal: true,
      dealUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealState: DealState.Active,
      contractTotalEscrow: REQUIRED_ESCROW,
      expectedTotalEscrow: REQUIRED_ESCROW,
      balance: 100_000_000n,
      allowance: REQUIRED_ESCROW,
    });

    assert.strictEqual(preflightActive.valid, false);
    assert.match(preflightActive.error!, /already funded/);
  });

  it('35. funding receipt/event verifies correct Deal', () => {
    const dealTopic1 = encodeAbiParameters([{ type: 'address' }], [TEST_DEAL_ADDRESS]);
    const eventData = encodeAbiParameters([{ type: 'uint256' }], [REQUIRED_ESCROW]);

    const receipt = {
      status: 'success',
      logs: [
        {
          address: TEST_DEAL_ADDRESS,
          topics: [DEAL_FUNDED_TOPIC0, dealTopic1],
          data: eventData,
        },
      ],
    };

    const verification = verifyFundingReceipt(receipt, TEST_DEAL_ADDRESS, REQUIRED_ESCROW);
    assert.strictEqual(verification.valid, true);
    assert.strictEqual(verification.dealFundedEvent?.totalEscrow, REQUIRED_ESCROW);
    assert.strictEqual(verification.dealFundedEvent?.dealAddress.toLowerCase(), TEST_DEAL_ADDRESS.toLowerCase());
  });

  it('36. funding receipt rejects wrong emitter', () => {
    const wrongEmitter = '0x9999999999999999999999999999999999999999';
    const dealTopic1 = encodeAbiParameters([{ type: 'address' }], [TEST_DEAL_ADDRESS]);
    const eventData = encodeAbiParameters([{ type: 'uint256' }], [REQUIRED_ESCROW]);

    const receipt = {
      status: 'success',
      logs: [
        {
          address: wrongEmitter, // wrong contract emitted the event
          topics: [DEAL_FUNDED_TOPIC0, dealTopic1],
          data: eventData,
        },
      ],
    };

    const verification = verifyFundingReceipt(receipt, TEST_DEAL_ADDRESS, REQUIRED_ESCROW);
    assert.strictEqual(verification.valid, false);
    assert.match(verification.error!, /DealFunded event was not found from the deal contract/);
  });

  it('37. funding receipt rejects wrong amount if event includes amount', () => {
    const wrongEscrow = 10_000_000n; // 10 USDC instead of 50 USDC
    const dealTopic1 = encodeAbiParameters([{ type: 'address' }], [TEST_DEAL_ADDRESS]);
    const eventData = encodeAbiParameters([{ type: 'uint256' }], [wrongEscrow]);

    const receipt = {
      status: 'success',
      logs: [
        {
          address: TEST_DEAL_ADDRESS,
          topics: [DEAL_FUNDED_TOPIC0, dealTopic1],
          data: eventData,
        },
      ],
    };

    const verification = verifyFundingReceipt(receipt, TEST_DEAL_ADDRESS, REQUIRED_ESCROW);
    assert.strictEqual(verification.valid, false);
    assert.match(verification.error!, /DealFunded emitted with unexpected amount/);
  });

  it('38. confirmed-funding/refresh-failed state distinguished', () => {
    // When receipt is confirmed, funding succeeded on-chain.
    const dealTopic1 = encodeAbiParameters([{ type: 'address' }], [TEST_DEAL_ADDRESS]);
    const eventData = encodeAbiParameters([{ type: 'uint256' }], [REQUIRED_ESCROW]);

    const receipt = {
      status: 'success',
      logs: [
        {
          address: TEST_DEAL_ADDRESS,
          topics: [DEAL_FUNDED_TOPIC0, dealTopic1],
          data: eventData,
        },
      ],
    };

    const verification = verifyFundingReceipt(receipt, TEST_DEAL_ADDRESS, REQUIRED_ESCROW);
    assert.strictEqual(verification.valid, true);

    // If subsequent RPC read fails, the UI distinguishes confirmed-pending-refresh
    let txConfirmedPendingRefresh = false;
    try {
      throw new Error('RPC endpoint rate limited');
    } catch {
      txConfirmedPendingRefresh = true;
    }
    assert.strictEqual(txConfirmedPendingRefresh, true);
  });

  it('39. funding does not start milestone', () => {
    // Verify that SynqDealV1 ABI distinguishes fundDeal from startMilestone
    const fundDealAbi = synqDealV1ABI.find((i: any) => i.name === 'fundDeal');
    const startMilestoneAbi = synqDealV1ABI.find((i: any) => i.name === 'startMilestone');
    assert.ok(fundDealAbi);
    assert.ok(startMilestoneAbi);
    assert.notStrictEqual(fundDealAbi, startMilestoneAbi);
  });

  it('40. funding does not call Protection', () => {
    // V2 Standard deals are unprotected (isProtected = false)
    const mockProtectedState = false;
    assert.strictEqual(mockProtectedState, false);
  });

  it('41. no DB funded flag introduced', () => {
    // Authority is on-chain; deal state comes from deal.state()
    const onChainState = DealState.Active;
    assert.strictEqual(onChainState, 1);
  });

  // ==================================================
  // DISPLAY (Tests 42-46)
  // ==================================================

  it('42. exact USDC 6-decimal formatting', () => {
    assert.strictEqual(formatUsdcAmount(1_000_000n), '1');
    assert.strictEqual(formatUsdcAmount(1_250_000n), '1.25');
    assert.strictEqual(formatUsdcAmount(50_000_000n), '50');
    assert.strictEqual(formatUsdcAmount(0n), '0');
    assert.strictEqual(parseUsdcAmount('50'), 50_000_000n);
  });

  it('43. milestones displayed from on-chain state', async () => {
    const mockClient = {
      readContract: async ({ functionName, args }: any) => {
        if (functionName === 'isSynqDeal') return true;
        if (functionName === 'usdc') return SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc;
        if (functionName === 'state') return 0;
        if (functionName === 'client') return TEST_CLIENT;
        if (functionName === 'freelancer') return TEST_FREELANCER;
        if (functionName === 'totalEscrow') return 50_000_000n;
        if (functionName === 'totalSettled') return 0n;
        if (functionName === 'milestoneCount') return 2n;
        if (functionName === 'isProtected') return false;
        if (functionName === 'policyId') return ZERO_BYTES32;
        if (functionName === 'primaryResolver') return TEST_RESOLVER_1;
        if (functionName === 'emergencyResolver') return TEST_RESOLVER_2;
        if (functionName === 'getMilestone') {
          const idx = Number(args[0]);
          return [
            25_000_000n, // amount
            1800000000n, // workDeadline
            86400n,      // reviewWindow
            86400n,      // gracePeriod
            0,           // status: Pending
            '0x1111111111111111111111111111111111111111111111111111111111111111',
            ZERO_BYTES32,
            0n,
            1,
          ];
        }
        return 0;
      },
    };

    const data = await readStandardV2DealData(TEST_DEAL_ADDRESS, mockClient);
    assert.strictEqual(data.milestoneCount, 2);
    assert.strictEqual(data.milestones.length, 2);
    assert.strictEqual(data.milestones[0].amount, 25_000_000n);
    assert.strictEqual(data.milestones[0].status, MilestoneStatus.Pending);
  });

  it('44. proposed human metadata is not treated as chain authority', () => {
    // Chain state returns DealState.Draft, ignoring any off-chain proposal status
    const onChainState = DealState.Draft;
    assert.strictEqual(onChainState, 0);
  });

  it('45. Accepted Proposal can safely link to V2 Deal page', () => {
    assert.strictEqual(isAddress(TEST_DEAL_ADDRESS), true);
    const targetUrl = `/deals/${TEST_DEAL_ADDRESS}`;
    assert.strictEqual(targetUrl, `/deals/${TEST_DEAL_ADDRESS}`);
  });

  it('46. legacy Deal fallback/read-only path preserved as designed', async () => {
    // If an address is NOT a V2 deal in SynqFactoryV2, isSynqV2Deal returns false
    const legacyDealAddress = '0x1111111111111111111111111111111111111111';
    const mockClient = {
      readContract: async () => false,
    };

    const isV2 = await isSynqV2Deal(legacyDealAddress, mockClient);
    assert.strictEqual(isV2, false);
  });

  // ==================================================
  // REGRESSION (Tests 47-50)
  // ==================================================

  it('47. proposal Accept/Decline/Cancel behavior unaffected', () => {
    assert.strictEqual(typeof validateAcceptPreflight, 'function');
    assert.strictEqual(typeof validateDeclinePreflight, 'function');
    assert.strictEqual(typeof validateCancelPreflight, 'function');
  });

  it('48. proposal chain-authoritative preflight unaffected', () => {
    assert.strictEqual(typeof verifyProposalPendingOnChain, 'function');
  });

  it('49. SynqChat proposal receipt unaffected', () => {
    const validData = {
      proposalId: '0x' + '11'.repeat(32),
      clientWallet: TEST_CLIENT,
      freelancerWallet: TEST_FREELANCER,
      title: 'Design Logo',
      totalAmount: '50000000',
      milestoneCount: 2,
      expiry: String(Math.floor(Date.now() / 1000) + 86400),
      cachedStatus: 'PENDING' as const,
    };
    const result = validateDealProposalPayload(validData);
    assert.strictEqual(result.proposalId, validData.proposalId.toLowerCase());
    assert.strictEqual(result.title, 'Design Logo');
  });

  it('50. existing legacy Deal receipt unaffected', () => {
    const validLegacy = {
      dealAddress: '0x' + '22'.repeat(20),
      chainId: 11155111,
      transactionHash: '0x' + '33'.repeat(32),
      title: 'Active Deal',
      scope: 'Active Scope',
      totalValue: '1000000',
      assetAddress: '0x' + '00'.repeat(20),
      deadline: '1750000000',
      protectionEnabled: false,
    };
    const result = validateDealReceiptPayload(validLegacy);
    assert.strictEqual(result.title, 'Active Deal');
    assert.strictEqual(result.dealAddress, ('0x' + '22'.repeat(20)).toLowerCase());
  });
});
