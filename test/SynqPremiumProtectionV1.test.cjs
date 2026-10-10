const assert = require("node:assert");
const { ethers } = require("hardhat");

describe("Synq Premium Protection V1 Contract Suite", function () {
  let usdc;
  let dealImpl;
  let factoryV2;
  let pool;
  let committee;
  let manager;

  let owner, client, freelancer, attacker, stranger;
  let signerA, signerB, signerC, signerD;

  const ONE_DAY = 86400;
  const ONE_HOUR = 3600;
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

  const TEST_FEE_BPS = 500; // 5% test fee (500 BPS)
  const TOTAL_DEAL_ESCROW = 1_000_000_000n; // 1,000 USDC
  const M1_AMOUNT = 400_000_000n; // 400 USDC
  const M2_AMOUNT = 600_000_000n; // 600 USDC

  const SPEC_HASH_1 = ethers.id("Milestone 1 Acceptance Criteria");
  const SPEC_HASH_2 = ethers.id("Milestone 2 Acceptance Criteria");
  const EVIDENCE_HASH_1 = ethers.id("Evidence Manifest 1");
  const EVIDENCE_HASH_2 = ethers.id("Evidence Manifest 2");
  const REPORT_HASH_1 = ethers.id("Committee Decision Report 1");
  const REPORT_HASH_2 = ethers.id("Committee Decision Report 2");

  async function getLatestBlockTimestamp() {
    const block = await ethers.provider.getBlock("latest");
    return block.timestamp;
  }

  async function setBlockTime(targetTime) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [targetTime]);
    await ethers.provider.send("evm_mine");
  }

  async function increaseTime(seconds) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine");
  }

  async function expectRevert(promise, expectedReason) {
    try {
      const tx = await promise;
      if (tx && typeof tx.wait === "function") {
        await tx.wait();
      }
      assert.fail(`Expected transaction to revert with "${expectedReason || ""}", but it succeeded`);
    } catch (err) {
      if (err.message.includes("Expected transaction to revert")) {
        throw err;
      }
      if (expectedReason) {
        assert(
          err.message.includes(expectedReason),
          `Expected error message to contain "${expectedReason}", got: "${err.message}"`
        );
      }
    }
  }

  function computeMilestonesHash(milestoneInits) {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encoded = abiCoder.encode(
      ["tuple(uint256 amount,uint64 workDeadline,uint64 reviewWindow,uint64 gracePeriod,bytes32 specHash)[]"],
      [milestoneInits]
    );
    return ethers.keccak256(encoded);
  }

  async function signClaimDecision(signer, committeeAddr, auth) {
    const domain = {
      name: "SynqProtectionCommittee",
      version: "1",
      chainId: auth.chainId,
      verifyingContract: committeeAddr,
    };
    const types = {
      ProtectionClaimDecisionAuth: [
        { name: "committee", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "manager", type: "address" },
        { name: "deal", type: "address" },
        { name: "milestoneId", type: "uint256" },
        { name: "decision", type: "uint8" },
        { name: "decisionReportHash", type: "bytes32" },
        { name: "decisionNonce", type: "uint64" },
        { name: "validUntil", type: "uint64" },
      ],
    };
    return await signer.signTypedData(domain, types, auth);
  }

  async function deployStandardV2Deal(dealClient, dealFreelancer, m1 = M1_AMOUNT, m2 = M2_AMOUNT) {
    const nowTime = await getLatestBlockTimestamp();
    const milestones = [
      {
        amount: m1,
        workDeadline: BigInt(nowTime + 5 * ONE_DAY),
        reviewWindow: BigInt(2 * ONE_DAY),
        gracePeriod: BigInt(ONE_DAY),
        specHash: SPEC_HASH_1,
      },
      {
        amount: m2,
        workDeadline: BigInt(nowTime + 15 * ONE_DAY),
        reviewWindow: BigInt(2 * ONE_DAY),
        gracePeriod: BigInt(ONE_DAY),
        specHash: SPEC_HASH_2,
      },
    ];

    const milestonesHash = computeMilestonesHash(milestones);
    const domain = {
      name: "SynqFactoryV2",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await factoryV2.getAddress(),
    };
    const types = {
      DealProposal: [
        { name: "client", type: "address" },
        { name: "freelancer", type: "address" },
        { name: "canonicalUsdc", type: "address" },
        { name: "dealImplementation", type: "address" },
        { name: "primaryResolver", type: "address" },
        { name: "emergencyResolver", type: "address" },
        { name: "milestonesHash", type: "bytes32" },
        { name: "isProtected", type: "bool" },
        { name: "protectionModule", type: "address" },
        { name: "policyId", type: "bytes32" },
        { name: "proposalNonce", type: "uint256" },
        { name: "expiry", type: "uint256" },
      ],
    };

    const nonce = BigInt(Math.floor(Math.random() * 1_000_000) + 1);
    const proposal = {
      client: dealClient.address,
      freelancer: dealFreelancer.address,
      canonicalUsdc: await usdc.getAddress(),
      dealImplementation: await dealImpl.getAddress(),
      primaryResolver: await factoryV2.defaultPrimaryResolver(),
      emergencyResolver: await factoryV2.defaultEmergencyResolver(),
      milestonesHash: milestonesHash,
      isProtected: false,
      protectionModule: ZERO_ADDRESS,
      policyId: ZERO_BYTES32,
      proposalNonce: nonce,
      expiry: BigInt(nowTime + 86400 * 2),
    };

    const signature = await dealClient.signTypedData(domain, types, proposal);
    const tx = await factoryV2.connect(dealFreelancer).acceptDealProposal(proposal, milestones, signature);
    const receipt = await tx.wait();

    // Find DealCreated event
    const event = receipt.logs.find((l) => {
      try {
        const parsed = factoryV2.interface.parseLog(l);
        return parsed && parsed.name === "DealCreated";
      } catch {
        return false;
      }
    });

    const parsedLog = factoryV2.interface.parseLog(event);
    const dealAddr = parsedLog.args.dealAddress;
    return await ethers.getContractAt("SynqDealV1Sequential", dealAddr);
  }

  beforeEach(async function () {
    [owner, client, freelancer, attacker, stranger, signerA, signerB, signerC, signerD] = await ethers.getSigners();

    // 1. Deploy Mock USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6, ethers.parseUnits("10000000", 6));
    await usdc.waitForDeployment();

    // 2. Deploy SynqDealV1Sequential Master Implementation
    const SynqDealV1Sequential = await ethers.getContractFactory("SynqDealV1Sequential");
    dealImpl = await SynqDealV1Sequential.deploy();
    await dealImpl.waitForDeployment();

    // 3. Deploy Mock Resolvers for Factory
    const mockResolver1 = await MockERC20.deploy("Mock Resolver 1", "MR1", 18, 0);
    const mockResolver2 = await MockERC20.deploy("Mock Resolver 2", "MR2", 18, 0);

    // 4. Deploy SynqFactoryV2
    const SynqFactoryV2 = await ethers.getContractFactory("SynqFactoryV2");
    factoryV2 = await SynqFactoryV2.deploy(
      owner.address,
      await usdc.getAddress(),
      await dealImpl.getAddress(),
      await mockResolver1.getAddress(),
      await mockResolver2.getAddress()
    );
    await factoryV2.waitForDeployment();

    // 5. Deploy Protection Committee (2-of-3 multisig)
    const SynqProtectionCommittee = await ethers.getContractFactory("SynqProtectionCommittee");
    committee = await SynqProtectionCommittee.deploy(signerA.address, signerB.address, signerC.address);
    await committee.waitForDeployment();

    // 6. Deploy Protection Pool (vault) in bootstrap mode (manager = address(0))
    const SynqProtectionPool = await ethers.getContractFactory("SynqProtectionPool");
    pool = await SynqProtectionPool.deploy(owner.address, await usdc.getAddress(), ethers.ZeroAddress);
    await pool.waitForDeployment();

    // 7. Deploy Premium Protection Manager
    const SynqPremiumProtectionManager = await ethers.getContractFactory("SynqPremiumProtectionManager");
    manager = await SynqPremiumProtectionManager.deploy(
      owner.address,
      await factoryV2.getAddress(),
      await usdc.getAddress(),
      await pool.getAddress(),
      await committee.getAddress(),
      TEST_FEE_BPS
    );
    await manager.waitForDeployment();

    // 8. Set Pool's authorized manager to the deployed Manager contract
    await pool.connect(owner).setManager(await manager.getAddress());

    // 9. Fund client with USDC
    await usdc.transfer(client.address, ethers.parseUnits("100000", 6));
  });

  describe("1. Policy Purchase", function () {
    let deal, dealAddr;

    beforeEach(async function () {
      deal = await deployStandardV2Deal(client, freelancer);
      dealAddr = await deal.getAddress();
    });

    it("cannot purchase policy before deal is funded (in Draft state)", async function () {
      await usdc.connect(client).approve(await manager.getAddress(), ethers.parseUnits("1000", 6));
      await expectRevert(manager.connect(client).purchasePolicy(dealAddr), "Deal must be active and funded");
    });

    it("rejects policy purchase from non-authentic fake deal", async function () {
      await expectRevert(manager.connect(client).purchasePolicy(stranger.address), "Deal not registered with Factory");
    });

    it("rejects policy purchase from caller other than the canonical client", async function () {
      // Fund deal first
      await usdc.connect(client).approve(dealAddr, TOTAL_DEAL_ESCROW);
      await deal.connect(client).fundDeal();

      await usdc.connect(attacker).approve(await manager.getAddress(), ethers.parseUnits("1000", 6));
      await expectRevert(manager.connect(attacker).purchasePolicy(dealAddr), "Only deal client can purchase");
    });

    it("successfully purchases policy for funded deal and snapshots terms", async function () {
      // Fund deal
      await usdc.connect(client).approve(dealAddr, TOTAL_DEAL_ESCROW);
      await deal.connect(client).fundDeal();

      // Approve manager for fee: 5% of 1,000 USDC = 50 USDC
      const expectedFee = (TOTAL_DEAL_ESCROW * BigInt(TEST_FEE_BPS)) / 10000n; // 50 USDC
      const expectedMaxCoverage = (TOTAL_DEAL_ESCROW * 2000n) / 10000n; // 200 USDC (20%)

      await usdc.connect(client).approve(await manager.getAddress(), expectedFee);

      const clientBalanceBefore = await usdc.balanceOf(client.address);
      const poolBalanceBefore = await pool.availableBalance();

      const tx = await manager.connect(client).purchasePolicy(dealAddr);
      await tx.wait();

      const clientBalanceAfter = await usdc.balanceOf(client.address);
      const poolBalanceAfter = await pool.availableBalance();

      assert.strictEqual(clientBalanceBefore - clientBalanceAfter, expectedFee);
      assert.strictEqual(poolBalanceAfter - poolBalanceBefore, expectedFee);

      const policy = await manager.getPolicy(dealAddr);
      assert.strictEqual(policy.client, client.address);
      assert.strictEqual(policy.premiumPaid, expectedFee);
      assert.strictEqual(policy.maxCoverage, expectedMaxCoverage);
      assert.strictEqual(policy.totalPaid, 0n);
      assert.strictEqual(policy.active, true);
    });

    it("cannot purchase policy twice for the same deal", async function () {
      await usdc.connect(client).approve(dealAddr, TOTAL_DEAL_ESCROW);
      await deal.connect(client).fundDeal();

      const fee = (TOTAL_DEAL_ESCROW * BigInt(TEST_FEE_BPS)) / 10000n;
      await usdc.connect(client).approve(await manager.getAddress(), fee * 2n);

      await manager.connect(client).purchasePolicy(dealAddr);
      await expectRevert(manager.connect(client).purchasePolicy(dealAddr), "Policy already exists for deal");
    });

    it("future fee-rate change does not alter existing policy snapshot", async function () {
      await usdc.connect(client).approve(dealAddr, TOTAL_DEAL_ESCROW);
      await deal.connect(client).fundDeal();

      const fee = (TOTAL_DEAL_ESCROW * BigInt(TEST_FEE_BPS)) / 10000n;
      await usdc.connect(client).approve(await manager.getAddress(), fee);
      await manager.connect(client).purchasePolicy(dealAddr);

      // Owner updates fee rate to 10% (1000 BPS)
      await manager.connect(owner).setPremiumFeeBps(1000);

      const policy = await manager.getPolicy(dealAddr);
      assert.strictEqual(policy.premiumPaid, fee); // Remains 50 USDC, not 100 USDC
    });

    it("enforces fee rate upper bound of 30% (3000 BPS)", async function () {
      await expectRevert(manager.connect(owner).setPremiumFeeBps(3001), "Fee exceeds maximum");
      await manager.connect(owner).setPremiumFeeBps(3000); // 30% succeeds
      assert.strictEqual(Number(await manager.premiumFeeBps()), 3000);
    });

    it("cannot purchase policy if premium fee is 0", async function () {
      await manager.connect(owner).setPremiumFeeBps(0);
      await usdc.connect(client).approve(dealAddr, TOTAL_DEAL_ESCROW);
      await deal.connect(client).fundDeal();

      await expectRevert(manager.connect(client).purchasePolicy(dealAddr), "Premium fee not configured");
    });
  });

  describe("2. Claim Submission & Eligibility", function () {
    let deal, dealAddr;

    beforeEach(async function () {
      deal = await deployStandardV2Deal(client, freelancer);
      dealAddr = await deal.getAddress();

      // Fund deal & purchase policy
      await usdc.connect(client).approve(dealAddr, TOTAL_DEAL_ESCROW);
      await deal.connect(client).fundDeal();

      const fee = (TOTAL_DEAL_ESCROW * BigInt(TEST_FEE_BPS)) / 10000n;
      await usdc.connect(client).approve(await manager.getAddress(), fee);
      await manager.connect(client).purchasePolicy(dealAddr);
    });

    it("rejects claim from non-client", async function () {
      await expectRevert(
        manager.connect(attacker).submitClaim(dealAddr, 0, EVIDENCE_HASH_1),
        "Only policy client can submit claim"
      );
    });

    it("rejects claim for unsettled/in-progress milestone", async function () {
      // Milestone 0 is in Progress or Pending
      await expectRevert(
        manager.connect(client).submitClaim(dealAddr, 0, EVIDENCE_HASH_1),
        "Milestone not eligible: not SettledRefunded"
      );
    });

    it("rejects claim for ordinary completed/paid milestone (ClientApproval)", async function () {
      // Start, submit, and approve milestone 0
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).clientApprove(0);

      // Milestone 0 is now SettledPaid
      await expectRevert(
        manager.connect(client).submitClaim(dealAddr, 0, EVIDENCE_HASH_1),
        "Milestone not eligible: not SettledRefunded"
      );
    });

    it("rejects claim for milestone settled via StandardReviewTimeout", async function () {
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);

      // Fast-forward past review window (2 days)
      await increaseTime(2 * ONE_DAY + 10);
      await deal.connect(freelancer).settleReviewTimeout(0);

      // Milestone 0 is SettledPaid
      await expectRevert(
        manager.connect(client).submitClaim(dealAddr, 0, EVIDENCE_HASH_1),
        "Milestone not eligible: not SettledRefunded"
      );
    });

    it("rejects claim for merely overdue milestone before claimExpiredRefund", async function () {
      // Deadline + grace expires without submission
      await increaseTime(6 * ONE_DAY + 10);

      // Milestone is still InProgress / Pending on-chain until claimExpiredRefund is called
      await expectRevert(
        manager.connect(client).submitClaim(dealAddr, 0, EVIDENCE_HASH_1),
        "Milestone not eligible: not SettledRefunded"
      );
    });

    it("accepts claim when milestone reaches SettledRefunded via ExpiredRefund", async function () {
      // Freelancer starts milestone 0
      await deal.connect(freelancer).startMilestone(0);

      // Deadline (5 days) + Grace (1 day) = 6 days expire without submission
      await increaseTime(6 * ONE_DAY + 10);

      // Client executes claimExpiredRefund
      await deal.connect(client).claimExpiredRefund(0);

      const m = await deal.getMilestone(0);
      assert.strictEqual(Number(m.status), 8); // MilestoneStatus.SettledRefunded

      // Client submits claim to PremiumProtectionManager
      const tx = await manager.connect(client).submitClaim(dealAddr, 0, EVIDENCE_HASH_1);
      await tx.wait();

      const claim = await manager.getClaim(dealAddr, 0);
      assert.strictEqual(Number(claim.status), 1); // ClaimStatus.Submitted
      assert.strictEqual(claim.milestoneId, 0n);
      assert.strictEqual(claim.milestoneAmount, M1_AMOUNT); // 400 USDC sourced directly from Deal
      assert.strictEqual(claim.evidenceHash, EVIDENCE_HASH_1);
      assert.strictEqual(claim.payout, 0n);
    });

    it("rejects duplicate claim on already submitted milestone", async function () {
      await deal.connect(freelancer).startMilestone(0);
      await increaseTime(6 * ONE_DAY + 10);
      await deal.connect(client).claimExpiredRefund(0);

      await manager.connect(client).submitClaim(dealAddr, 0, EVIDENCE_HASH_1);
      await expectRevert(
        manager.connect(client).submitClaim(dealAddr, 0, EVIDENCE_HASH_1),
        "Claim already recorded"
      );
    });
  });

  describe("3. Protection Committee Decision & 2-of-3 Multisig", function () {
    let deal, dealAddr;
    let chainId;

    beforeEach(async function () {
      chainId = (await ethers.provider.getNetwork()).chainId;
      deal = await deployStandardV2Deal(client, freelancer);
      dealAddr = await deal.getAddress();

      await usdc.connect(client).approve(dealAddr, TOTAL_DEAL_ESCROW);
      await deal.connect(client).fundDeal();

      const fee = (TOTAL_DEAL_ESCROW * BigInt(TEST_FEE_BPS)) / 10000n;
      await usdc.connect(client).approve(await manager.getAddress(), fee);
      await manager.connect(client).purchasePolicy(dealAddr);

      // Milestone 0 expires and client refunds
      await deal.connect(freelancer).startMilestone(0);
      await increaseTime(6 * ONE_DAY + 10);
      await deal.connect(client).claimExpiredRefund(0);

      await manager.connect(client).submitClaim(dealAddr, 0, EVIDENCE_HASH_1);
    });

    it("approves claim with valid 2-of-3 committee signatures and calculates deterministic payout", async function () {
      const nowTime = await getLatestBlockTimestamp();
      const auth = {
        committee: await committee.getAddress(),
        chainId: chainId,
        manager: await manager.getAddress(),
        deal: dealAddr,
        milestoneId: 0,
        decision: 1, // Approve
        decisionReportHash: REPORT_HASH_1,
        decisionNonce: 1n,
        validUntil: BigInt(nowTime + 86400),
      };

      const sigA = await signClaimDecision(signerA, await committee.getAddress(), auth);
      const sigB = await signClaimDecision(signerB, await committee.getAddress(), auth);

      const tx = await committee.connect(stranger).submitClaimDecision(auth, sigA, sigB);
      await tx.wait();

      const claim = await manager.getClaim(dealAddr, 0);
      assert.strictEqual(Number(claim.status), 2); // ClaimStatus.Approved
      assert.strictEqual(claim.decisionReportHash, REPORT_HASH_1);

      // Expected deterministic payout: 20% of M1 (400 USDC) = 80 USDC
      const expectedPayout = (M1_AMOUNT * 2000n) / 10000n;
      assert.strictEqual(claim.payout, expectedPayout);
    });

    it("rejects claim with valid 2-of-3 committee signatures", async function () {
      const nowTime = await getLatestBlockTimestamp();
      const auth = {
        committee: await committee.getAddress(),
        chainId: chainId,
        manager: await manager.getAddress(),
        deal: dealAddr,
        milestoneId: 0,
        decision: 2, // Reject
        decisionReportHash: REPORT_HASH_1,
        decisionNonce: 2n,
        validUntil: BigInt(nowTime + 86400),
      };

      const sigB = await signClaimDecision(signerB, await committee.getAddress(), auth);
      const sigC = await signClaimDecision(signerC, await committee.getAddress(), auth);

      const tx = await committee.connect(stranger).submitClaimDecision(auth, sigB, sigC);
      await tx.wait();

      const claim = await manager.getClaim(dealAddr, 0);
      assert.strictEqual(Number(claim.status), 3); // ClaimStatus.Rejected
      assert.strictEqual(claim.payout, 0n);
    });

    it("fails with duplicate signer signature", async function () {
      const nowTime = await getLatestBlockTimestamp();
      const auth = {
        committee: await committee.getAddress(),
        chainId: chainId,
        manager: await manager.getAddress(),
        deal: dealAddr,
        milestoneId: 0,
        decision: 1,
        decisionReportHash: REPORT_HASH_1,
        decisionNonce: 3n,
        validUntil: BigInt(nowTime + 86400),
      };

      const sigA = await signClaimDecision(signerA, await committee.getAddress(), auth);
      await expectRevert(
        committee.submitClaimDecision(auth, sigA, sigA),
        "Duplicate signer signature"
      );
    });

    it("fails with unauthorized signer signature", async function () {
      const nowTime = await getLatestBlockTimestamp();
      const auth = {
        committee: await committee.getAddress(),
        chainId: chainId,
        manager: await manager.getAddress(),
        deal: dealAddr,
        milestoneId: 0,
        decision: 1,
        decisionReportHash: REPORT_HASH_1,
        decisionNonce: 4n,
        validUntil: BigInt(nowTime + 86400),
      };

      const sigA = await signClaimDecision(signerA, await committee.getAddress(), auth);
      const sigAttacker = await signClaimDecision(attacker, await committee.getAddress(), auth);

      await expectRevert(
        committee.submitClaimDecision(auth, sigA, sigAttacker),
        "Signer 2 not authorized"
      );
    });

    it("fails replay of identical decision nonce", async function () {
      const nowTime = await getLatestBlockTimestamp();
      const auth = {
        committee: await committee.getAddress(),
        chainId: chainId,
        manager: await manager.getAddress(),
        deal: dealAddr,
        milestoneId: 0,
        decision: 1,
        decisionReportHash: REPORT_HASH_1,
        decisionNonce: 5n,
        validUntil: BigInt(nowTime + 86400),
      };

      const sigA = await signClaimDecision(signerA, await committee.getAddress(), auth);
      const sigB = await signClaimDecision(signerB, await committee.getAddress(), auth);

      await committee.submitClaimDecision(auth, sigA, sigB);
      await expectRevert(
        committee.submitClaimDecision(auth, sigA, sigB),
        "Decision nonce already used"
      );
    });

    it("fails when decision authorization is expired", async function () {
      const nowTime = await getLatestBlockTimestamp();
      const auth = {
        committee: await committee.getAddress(),
        chainId: chainId,
        manager: await manager.getAddress(),
        deal: dealAddr,
        milestoneId: 0,
        decision: 1,
        decisionReportHash: REPORT_HASH_1,
        decisionNonce: 6n,
        validUntil: BigInt(nowTime - 10), // in past
      };

      const sigA = await signClaimDecision(signerA, await committee.getAddress(), auth);
      const sigB = await signClaimDecision(signerB, await committee.getAddress(), auth);

      await expectRevert(
        committee.submitClaimDecision(auth, sigA, sigB),
        "Authorization expired"
      );
    });

    it("committee authorization cannot be used across another deal", async function () {
      const deal2 = await deployStandardV2Deal(client, freelancer);
      const dealAddr2 = await deal2.getAddress();

      const nowTime = await getLatestBlockTimestamp();
      const auth = {
        committee: await committee.getAddress(),
        chainId: chainId,
        manager: await manager.getAddress(),
        deal: dealAddr, // signed for deal 1
        milestoneId: 0,
        decision: 1,
        decisionReportHash: REPORT_HASH_1,
        decisionNonce: 7n,
        validUntil: BigInt(nowTime + 86400),
      };

      const sigA = await signClaimDecision(signerA, await committee.getAddress(), auth);
      const sigB = await signClaimDecision(signerB, await committee.getAddress(), auth);

      // Attempt to submit against deal2
      const tamperedAuth = { ...auth, deal: dealAddr2 };
      await expectRevert(
        committee.submitClaimDecision(tamperedAuth, sigA, sigB),
        "Signer 1 not authorized"
      );
    });
  });

  describe("4. Claim Payout & Solvency", function () {
    let deal, dealAddr;
    let chainId;

    beforeEach(async function () {
      chainId = (await ethers.provider.getNetwork()).chainId;
      deal = await deployStandardV2Deal(client, freelancer);
      dealAddr = await deal.getAddress();

      await usdc.connect(client).approve(dealAddr, TOTAL_DEAL_ESCROW);
      await deal.connect(client).fundDeal();

      const fee = (TOTAL_DEAL_ESCROW * BigInt(TEST_FEE_BPS)) / 10000n; // 50 USDC
      await usdc.connect(client).approve(await manager.getAddress(), fee);
      await manager.connect(client).purchasePolicy(dealAddr);

      // Milestone 0 expires and client refunds
      await deal.connect(freelancer).startMilestone(0);
      await increaseTime(6 * ONE_DAY + 10);
      await deal.connect(client).claimExpiredRefund(0);

      await manager.connect(client).submitClaim(dealAddr, 0, EVIDENCE_HASH_1);

      // Committee approves claim for milestone 0
      const nowTime = await getLatestBlockTimestamp();
      const auth = {
        committee: await committee.getAddress(),
        chainId: chainId,
        manager: await manager.getAddress(),
        deal: dealAddr,
        milestoneId: 0,
        decision: 1, // Approve
        decisionReportHash: REPORT_HASH_1,
        decisionNonce: 10n,
        validUntil: BigInt(nowTime + 86400),
      };

      const sigA = await signClaimDecision(signerA, await committee.getAddress(), auth);
      const sigB = await signClaimDecision(signerB, await committee.getAddress(), auth);
      await committee.submitClaimDecision(auth, sigA, sigB);
    });

    it("reverts disburseClaim cleanly if pool liquidity is insufficient, leaving claim Approved", async function () {
      // Pool currently only has 50 USDC from fee, but payout is 80 USDC (20% of 400 USDC)
      const claim = await manager.getClaim(dealAddr, 0);
      assert.strictEqual(claim.payout, 80_000_000n);
      assert.strictEqual(await pool.availableBalance(), 50_000_000n);

      await expectRevert(
        manager.connect(stranger).disburseClaim(dealAddr, 0),
        "Insufficient pool liquidity"
      );

      // Claim status must remain Approved (not Paid, not lost)
      const claimAfter = await manager.getClaim(dealAddr, 0);
      assert.strictEqual(Number(claimAfter.status), 2); // Approved
    });

    it("disburses claim once pool is capitalized with sufficient liquidity", async function () {
      // Capitalize pool with extra 1,000 USDC
      await usdc.connect(owner).approve(await pool.getAddress(), ethers.parseUnits("1000", 6));
      await pool.connect(owner).fundPool(ethers.parseUnits("1000", 6));

      const clientBalanceBefore = await usdc.balanceOf(client.address);
      const poolBalanceBefore = await pool.availableBalance();

      // Anyone can trigger disburse
      const tx = await manager.connect(stranger).disburseClaim(dealAddr, 0);
      await tx.wait();

      const clientBalanceAfter = await usdc.balanceOf(client.address);
      const poolBalanceAfter = await pool.availableBalance();

      const expectedPayout = 80_000_000n; // 80 USDC
      assert.strictEqual(clientBalanceAfter - clientBalanceBefore, expectedPayout);
      assert.strictEqual(poolBalanceBefore - poolBalanceAfter, expectedPayout);

      const claim = await manager.getClaim(dealAddr, 0);
      assert.strictEqual(Number(claim.status), 4); // ClaimStatus.Paid

      const policy = await manager.getPolicy(dealAddr);
      assert.strictEqual(policy.totalPaid, expectedPayout);
      assert.strictEqual(policy.active, true);
    });

    it("cannot disburse an already Paid claim a second time", async function () {
      await usdc.connect(owner).approve(await pool.getAddress(), ethers.parseUnits("1000", 6));
      await pool.connect(owner).fundPool(ethers.parseUnits("1000", 6));

      await manager.connect(stranger).disburseClaim(dealAddr, 0);

      await expectRevert(
        manager.connect(stranger).disburseClaim(dealAddr, 0),
        "Claim not in Approved status"
      );
    });

    it("cannot disburse a Rejected claim", async function () {
      // Create a second claim on another deal and reject it
      const deal2 = await deployStandardV2Deal(client, freelancer);
      const dealAddr2 = await deal2.getAddress();
      await usdc.connect(client).approve(dealAddr2, TOTAL_DEAL_ESCROW);
      await deal2.connect(client).fundDeal();

      const fee = (TOTAL_DEAL_ESCROW * BigInt(TEST_FEE_BPS)) / 10000n;
      await usdc.connect(client).approve(await manager.getAddress(), fee);
      await manager.connect(client).purchasePolicy(dealAddr2);

      await deal2.connect(freelancer).startMilestone(0);
      await increaseTime(6 * ONE_DAY + 10);
      await deal2.connect(client).claimExpiredRefund(0);
      await manager.connect(client).submitClaim(dealAddr2, 0, EVIDENCE_HASH_1);

      const nowTime = await getLatestBlockTimestamp();
      const auth = {
        committee: await committee.getAddress(),
        chainId: chainId,
        manager: await manager.getAddress(),
        deal: dealAddr2,
        milestoneId: 0,
        decision: 2, // Reject
        decisionReportHash: REPORT_HASH_1,
        decisionNonce: 20n,
        validUntil: BigInt(nowTime + 86400),
      };
      const sigA = await signClaimDecision(signerA, await committee.getAddress(), auth);
      const sigB = await signClaimDecision(signerB, await committee.getAddress(), auth);
      await committee.submitClaimDecision(auth, sigA, sigB);

      await expectRevert(
        manager.connect(stranger).disburseClaim(dealAddr2, 0),
        "Claim not in Approved status"
      );
    });

    it("enforces policy maxCoverage cap across multiple milestone claims", async function () {
      // Capitalize pool with plenty of USDC
      await usdc.connect(owner).approve(await pool.getAddress(), ethers.parseUnits("10000", 6));
      await pool.connect(owner).fundPool(ethers.parseUnits("10000", 6));

      // Disburse milestone 0: M1 = 400 USDC -> 80 USDC paid (maxCoverage is 200 USDC, remaining = 120 USDC)
      await manager.connect(stranger).disburseClaim(dealAddr, 0);

      // Now milestone 1 expires and client claims refund
      // Milestone 1 amount = 600 USDC.
      // Raw 20% payout would be 120 USDC.
      // 80 USDC + 120 USDC = exactly 200 USDC (maxCoverage)
      await deal.connect(freelancer).startMilestone(1);
      await increaseTime(16 * ONE_DAY + 10);
      await deal.connect(client).claimExpiredRefund(1);

      await manager.connect(client).submitClaim(dealAddr, 1, EVIDENCE_HASH_1);

      const nowTime = await getLatestBlockTimestamp();
      const auth = {
        committee: await committee.getAddress(),
        chainId: chainId,
        manager: await manager.getAddress(),
        deal: dealAddr,
        milestoneId: 1,
        decision: 1, // Approve
        decisionReportHash: REPORT_HASH_1,
        decisionNonce: 30n,
        validUntil: BigInt(nowTime + 86400),
      };
      const sigA = await signClaimDecision(signerA, await committee.getAddress(), auth);
      const sigB = await signClaimDecision(signerB, await committee.getAddress(), auth);
      await committee.submitClaimDecision(auth, sigA, sigB);

      const claim1 = await manager.getClaim(dealAddr, 1);
      assert.strictEqual(claim1.payout, 120_000_000n); // exactly 120 USDC (capped at remaining coverage)

      await manager.connect(stranger).disburseClaim(dealAddr, 1);

      const policyAfter = await manager.getPolicy(dealAddr);
      assert.strictEqual(policyAfter.totalPaid, 200_000_000n); // 200 USDC (100% of maxCoverage)
      assert.strictEqual(policyAfter.active, false); // exhausted
    });
  });

  describe("5. Protection Pool Vault Security", function () {
    it("non-manager caller cannot trigger payout from pool", async function () {
      await expectRevert(
        pool.connect(attacker).payout(attacker.address, 100_000_000n),
        "Only manager"
      );
    });

    it("committee cannot directly trigger payout from pool", async function () {
      await expectRevert(
        pool.connect(signerA).payout(signerA.address, 100_000_000n),
        "Only manager"
      );
    });

    it("owner cannot arbitrarily withdraw capital (no withdrawal function in V1 pool)", async function () {
      // Pool does not expose a withdrawal function in V1, protecting active policy reserves
      assert.strictEqual(typeof pool.withdraw, "undefined");
      assert.strictEqual(typeof pool.withdrawCapital, "undefined");
    });

    it("pool rejects setting manager to an EOA", async function () {
      await expectRevert(
        pool.connect(owner).setManager(stranger.address),
        "Manager must be a contract"
      );
    });

    it("pool rejects setting manager to address(0)", async function () {
      await expectRevert(
        pool.connect(owner).setManager(ethers.ZeroAddress),
        "Zero manager address"
      );
    });

    it("supports manager rotation by owner to a contract, and old manager immediately loses payout authority", async function () {
      // Deploy a mock contract to serve as new manager
      const MockContract = await ethers.getContractFactory("MockERC20");
      const newManagerContract = await MockContract.deploy("New Manager", "NM", 18, 0);
      await newManagerContract.waitForDeployment();
      const newManagerAddr = await newManagerContract.getAddress();

      await pool.connect(owner).setManager(newManagerAddr);
      assert.strictEqual(await pool.manager(), newManagerAddr);

      // Old manager immediately loses payout authority
      // Note: Calling manager.disburseClaim will fail at pool.payout with "Only manager"
      const deal = await deployStandardV2Deal(client, freelancer);
      const dealAddr = await deal.getAddress();
      await usdc.connect(client).approve(dealAddr, TOTAL_DEAL_ESCROW);
      await deal.connect(client).fundDeal();
      const fee = (TOTAL_DEAL_ESCROW * BigInt(TEST_FEE_BPS)) / 10000n;
      await usdc.connect(client).approve(await manager.getAddress(), fee);
      await manager.connect(client).purchasePolicy(dealAddr);

      await deal.connect(freelancer).startMilestone(0);
      await increaseTime(6 * ONE_DAY + 10);
      await deal.connect(client).claimExpiredRefund(0);
      await manager.connect(client).submitClaim(dealAddr, 0, EVIDENCE_HASH_1);

      const nowTime = await getLatestBlockTimestamp();
      const auth = {
        committee: await committee.getAddress(),
        chainId: (await ethers.provider.getNetwork()).chainId,
        manager: await manager.getAddress(),
        deal: dealAddr,
        milestoneId: 0,
        decision: 1,
        decisionReportHash: REPORT_HASH_1,
        decisionNonce: 9999n,
        validUntil: BigInt(nowTime + 86400),
      };
      const sigA = await signClaimDecision(signerA, await committee.getAddress(), auth);
      const sigB = await signClaimDecision(signerB, await committee.getAddress(), auth);
      await committee.submitClaimDecision(auth, sigA, sigB);

      // Fund pool with sufficient USDC so that disburse reaches pool.payout()
      await usdc.connect(owner).approve(await pool.getAddress(), ethers.parseUnits("500", 6));
      await pool.connect(owner).fundPool(ethers.parseUnits("500", 6));

      // Now attempt disburse via old manager (must revert at pool with "Only manager")
      await expectRevert(
        manager.connect(stranger).disburseClaim(dealAddr, 0),
        "Only manager"
      );
    });

    it("manager rejects deployment if pool USDC mismatches manager USDC", async function () {
      const MockContract = await ethers.getContractFactory("MockERC20");
      const otherToken = await MockContract.deploy("Other", "OTH", 6, 1000);
      await otherToken.waitForDeployment();

      const SynqPremiumProtectionManager = await ethers.getContractFactory("SynqPremiumProtectionManager");
      await expectRevert(
        SynqPremiumProtectionManager.deploy(
          owner.address,
          await factoryV2.getAddress(),
          await otherToken.getAddress(), // mismatched USDC
          await pool.getAddress(),
          await committee.getAddress(),
          TEST_FEE_BPS
        ),
        "Mismatched pool USDC"
      );
    });

    it("cannot purchase policy if deal is Completed", async function () {
      const deal = await deployStandardV2Deal(client, freelancer);
      const dealAddr = await deal.getAddress();
      await usdc.connect(client).approve(dealAddr, TOTAL_DEAL_ESCROW);
      await deal.connect(client).fundDeal();

      // Complete milestone 0
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).clientApprove(0);

      // Complete milestone 1
      await deal.connect(freelancer).startMilestone(1);
      await deal.connect(freelancer).submitWork(1, EVIDENCE_HASH_2);
      await deal.connect(client).clientApprove(1);

      // Deal is now Completed (DealState 2)
      assert.strictEqual(Number(await deal.state()), 2);

      const fee = (TOTAL_DEAL_ESCROW * BigInt(TEST_FEE_BPS)) / 10000n;
      await usdc.connect(client).approve(await manager.getAddress(), fee);
      await expectRevert(
        manager.connect(client).purchasePolicy(dealAddr),
        "Deal must be active and funded"
      );
    });

    it("cannot submit claim after policy coverage is exhausted (active == false)", async function () {
      const deal = await deployStandardV2Deal(client, freelancer);
      const dealAddr = await deal.getAddress();
      await usdc.connect(client).approve(dealAddr, TOTAL_DEAL_ESCROW);
      await deal.connect(client).fundDeal();

      const fee = (TOTAL_DEAL_ESCROW * BigInt(TEST_FEE_BPS)) / 10000n;
      await usdc.connect(client).approve(await manager.getAddress(), fee);
      await manager.connect(client).purchasePolicy(dealAddr);

      // Milestone 0 expires and refunds
      await deal.connect(freelancer).startMilestone(0);
      await increaseTime(6 * ONE_DAY + 10);
      await deal.connect(client).claimExpiredRefund(0);
      await manager.connect(client).submitClaim(dealAddr, 0, EVIDENCE_HASH_1);

      // Approve claim 0
      const nowTime = await getLatestBlockTimestamp();
      const auth0 = {
        committee: await committee.getAddress(),
        chainId: (await ethers.provider.getNetwork()).chainId,
        manager: await manager.getAddress(),
        deal: dealAddr,
        milestoneId: 0,
        decision: 1,
        decisionReportHash: REPORT_HASH_1,
        decisionNonce: 10001n,
        validUntil: BigInt(nowTime + 86400),
      };
      const sigA0 = await signClaimDecision(signerA, await committee.getAddress(), auth0);
      const sigB0 = await signClaimDecision(signerB, await committee.getAddress(), auth0);
      await committee.submitClaimDecision(auth0, sigA0, sigB0);

      // Milestone 1 also expires and refunds
      await deal.connect(freelancer).startMilestone(1);
      await increaseTime(16 * ONE_DAY + 10);
      await deal.connect(client).claimExpiredRefund(1);
      await manager.connect(client).submitClaim(dealAddr, 1, EVIDENCE_HASH_2);

      // Approve claim 1
      const nowTime2 = await getLatestBlockTimestamp();
      const auth1 = {
        committee: await committee.getAddress(),
        chainId: (await ethers.provider.getNetwork()).chainId,
        manager: await manager.getAddress(),
        deal: dealAddr,
        milestoneId: 1,
        decision: 1,
        decisionReportHash: REPORT_HASH_2,
        decisionNonce: 10002n,
        validUntil: BigInt(nowTime2 + 86400),
      };
      const sigA1 = await signClaimDecision(signerA, await committee.getAddress(), auth1);
      const sigB1 = await signClaimDecision(signerB, await committee.getAddress(), auth1);
      await committee.submitClaimDecision(auth1, sigA1, sigB1);

      // Capitalize pool and disburse claim 0 (80 USDC) and claim 1 (120 USDC)
      await usdc.connect(owner).approve(await pool.getAddress(), ethers.parseUnits("1000", 6));
      await pool.connect(owner).fundPool(ethers.parseUnits("1000", 6));

      await manager.connect(stranger).disburseClaim(dealAddr, 0);
      await manager.connect(stranger).disburseClaim(dealAddr, 1);

      // Policy is now exhausted
      const pol = await manager.getPolicy(dealAddr);
      assert.strictEqual(pol.active, false);
      assert.strictEqual(pol.totalPaid, pol.maxCoverage);

      // Attempting to submit another claim on this deal reverts with "Policy not active"
      await expectRevert(
        manager.connect(client).submitClaim(dealAddr, 0, EVIDENCE_HASH_1),
        "Policy not active"
      );
    });
  });
});
