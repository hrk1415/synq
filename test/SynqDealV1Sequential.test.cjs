const assert = require("node:assert");
const { ethers } = require("hardhat");

describe("SynqDealV1Sequential Protocol Correction & Adversarial Test Suite", function () {
  let usdc;
  let client, freelancer, thirdParty;
  let primaryResolverContract, emergencyResolverContract, protectionModuleContract;
  let primaryResolver, emergencyResolver, protectionModule;
  let now;
  const ONE_DAY = 86400;
  const ONE_HOUR = 3600;

  const M1_AMOUNT = 300_000_000n; // 300 USDC
  const M2_AMOUNT = 300_000_000n; // 300 USDC
  const M3_AMOUNT = 400_000_000n; // 400 USDC
  const TOTAL_ESCROW_3M = 1_000_000_000n;

  const SPEC_HASH_1 = ethers.keccak256(ethers.toUtf8Bytes("Spec 1: API"));
  const SPEC_HASH_2 = ethers.keccak256(ethers.toUtf8Bytes("Spec 2: UI"));
  const SPEC_HASH_3 = ethers.keccak256(ethers.toUtf8Bytes("Spec 3: Docs"));
  const EVIDENCE_HASH_1 = ethers.keccak256(ethers.toUtf8Bytes("Evidence 1"));
  const EVIDENCE_HASH_2 = ethers.keccak256(ethers.toUtf8Bytes("Evidence 2"));
  const EVIDENCE_HASH_3 = ethers.keccak256(ethers.toUtf8Bytes("Evidence 3"));

  async function getLatestBlockTimestamp() {
    const block = await ethers.provider.getBlock("latest");
    return block.timestamp;
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

  let sequentialImplementation;
  let oldImplementation;

  async function deployClone(implAddress) {
    const cleanAddr = implAddress.toLowerCase().replace("0x", "");
    const byteCode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${cleanAddr}5af43d82803e903d91602b57fd5bf3`;
    const tx = await client.sendTransaction({ data: byteCode });
    const receipt = await tx.wait();
    return await ethers.getContractAt("SynqDealV1Sequential", receipt.contractAddress);
  }

  async function deployAndInitDeal(customMilestones, isProtected = false) {
    now = await getLatestBlockTimestamp();

    const milestones = customMilestones || [
      {
        amount: M1_AMOUNT,
        workDeadline: now + 5 * ONE_DAY,
        reviewWindow: 3 * ONE_DAY,
        gracePeriod: 1 * ONE_DAY,
        specHash: SPEC_HASH_1,
      },
      {
        amount: M2_AMOUNT,
        workDeadline: now + 10 * ONE_DAY,
        reviewWindow: 3 * ONE_DAY,
        gracePeriod: 1 * ONE_DAY,
        specHash: SPEC_HASH_2,
      },
      {
        amount: M3_AMOUNT,
        workDeadline: now + 15 * ONE_DAY,
        reviewWindow: 3 * ONE_DAY,
        gracePeriod: 1 * ONE_DAY,
        specHash: SPEC_HASH_3,
      },
    ];

    if (!sequentialImplementation) {
      const DealFactory = await ethers.getContractFactory("SynqDealV1Sequential");
      sequentialImplementation = await DealFactory.deploy();
      await sequentialImplementation.waitForDeployment();
    }

    const d = await deployClone(await sequentialImplementation.getAddress());

    const initParams = {
      client: client.address,
      freelancer: freelancer.address,
      usdc: await usdc.getAddress(),
      primaryResolver: await primaryResolverContract.getAddress(),
      emergencyResolver: await emergencyResolverContract.getAddress(),
      isProtected: isProtected,
      protectionModule: isProtected ? await protectionModuleContract.getAddress() : ethers.ZeroAddress,
      policyId: isProtected ? ethers.keccak256(ethers.toUtf8Bytes("Policy-1")) : ethers.ZeroHash,
    };

    await d.initialize(initParams, milestones);
    return d;
  }

  beforeEach(async function () {
    [client, freelancer, thirdParty] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6, ethers.parseUnits("1000000", 6));
    await usdc.waitForDeployment();

    await usdc.mint(client.address, ethers.parseUnits("50000", 6));
    await usdc.mint(thirdParty.address, ethers.parseUnits("1000", 6));

    primaryResolverContract = await MockERC20.deploy("Primary Resolver Placeholder", "PRP", 18, 0);
    await primaryResolverContract.waitForDeployment();
    emergencyResolverContract = await MockERC20.deploy("Emergency Resolver Placeholder", "ERP", 18, 0);
    await emergencyResolverContract.waitForDeployment();
    protectionModuleContract = await MockERC20.deploy("Protection Module Placeholder", "PMP", 18, 0);
    await protectionModuleContract.waitForDeployment();

    const primaryResolverAddr = await primaryResolverContract.getAddress();
    const emergencyResolverAddr = await emergencyResolverContract.getAddress();
    const protectionModuleAddr = await protectionModuleContract.getAddress();

    await ethers.provider.send("hardhat_impersonateAccount", [primaryResolverAddr]);
    await ethers.provider.send("hardhat_impersonateAccount", [emergencyResolverAddr]);
    await ethers.provider.send("hardhat_impersonateAccount", [protectionModuleAddr]);

    primaryResolver = await ethers.getSigner(primaryResolverAddr);
    emergencyResolver = await ethers.getSigner(emergencyResolverAddr);
    protectionModule = await ethers.getSigner(protectionModuleAddr);

    await ethers.provider.send("hardhat_setBalance", [primaryResolverAddr, "0x1000000000000000000"]);
    await ethers.provider.send("hardhat_setBalance", [emergencyResolverAddr, "0x1000000000000000000"]);
    await ethers.provider.send("hardhat_setBalance", [protectionModuleAddr, "0x1000000000000000000"]);

    const DealFactory = await ethers.getContractFactory("SynqDealV1Sequential");
    sequentialImplementation = await DealFactory.deploy();
    await sequentialImplementation.waitForDeployment();

    const OldDealFactory = await ethers.getContractFactory("SynqDealV1");
    oldImplementation = await OldDealFactory.deploy();
    await oldImplementation.waitForDeployment();
  });

  describe("1. Master Implementation & Clone Initialization", function () {
    it("master implementation initializer disabled", async function () {
      const initParams = {
        client: client.address,
        freelancer: freelancer.address,
        usdc: await usdc.getAddress(),
        primaryResolver: await primaryResolverContract.getAddress(),
        emergencyResolver: await emergencyResolverContract.getAddress(),
        isProtected: false,
        protectionModule: ethers.ZeroAddress,
        policyId: ethers.ZeroHash,
      };
      await expectRevert(sequentialImplementation.initialize(initParams, []), "InvalidInitialization");
    });

    it("clone initializes exactly once", async function () {
      const deal = await deployAndInitDeal();
      const initParams = {
        client: client.address,
        freelancer: freelancer.address,
        usdc: await usdc.getAddress(),
        primaryResolver: await primaryResolverContract.getAddress(),
        emergencyResolver: await emergencyResolverContract.getAddress(),
        isProtected: false,
        protectionModule: ethers.ZeroAddress,
        policyId: ethers.ZeroHash,
      };
      await expectRevert(deal.initialize(initParams, []), "InvalidInitialization");
    });

    it("clone initialization fails with zero milestones", async function () {
      const d = await deployClone(await sequentialImplementation.getAddress());
      const initParams = {
        client: client.address,
        freelancer: freelancer.address,
        usdc: await usdc.getAddress(),
        primaryResolver: await primaryResolverContract.getAddress(),
        emergencyResolver: await emergencyResolverContract.getAddress(),
        isProtected: false,
        protectionModule: ethers.ZeroAddress,
        policyId: ethers.ZeroHash,
      };
      await expectRevert(d.initialize(initParams, []), "Zero milestones provided");
    });
  });

  describe("2. Strict Sequential Milestone Start Invariant", function () {
    let deal;

    beforeEach(async function () {
      deal = await deployAndInitDeal();
      await usdc.connect(client).approve(await deal.getAddress(), TOTAL_ESCROW_3M);
      await deal.connect(client).fundDeal();
    });

    it("milestone 0 starts normally when Deal is Active and status is Pending", async function () {
      const tx = await deal.connect(freelancer).startMilestone(0);
      await tx.wait();
      const m0 = await deal.getMilestone(0);
      assert.strictEqual(m0.status, 1n); // InProgress
    });

    it("milestone 1 cannot start while milestone 0 is Pending", async function () {
      await expectRevert(deal.connect(freelancer).startMilestone(1), "Preceding milestone not settled");
    });

    it("milestone 1 cannot start while milestone 0 is InProgress", async function () {
      await deal.connect(freelancer).startMilestone(0);
      await expectRevert(deal.connect(freelancer).startMilestone(1), "Preceding milestone not settled");
    });

    it("milestone 1 cannot start while milestone 0 is Submitted", async function () {
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      const m0 = await deal.getMilestone(0);
      assert.strictEqual(m0.status, 2n); // Submitted
      await expectRevert(deal.connect(freelancer).startMilestone(1), "Preceding milestone not settled");
    });

    it("milestone 1 cannot start while milestone 0 is RevisionRequested", async function () {
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      const currentBlockTime = await getLatestBlockTimestamp();
      await deal.connect(client).requestRevision(0, ethers.keccak256(ethers.toUtf8Bytes("Rev 1")), currentBlockTime + 5 * ONE_DAY);
      const m0 = await deal.getMilestone(0);
      assert.strictEqual(m0.status, 3n); // RevisionRequested
      await expectRevert(deal.connect(freelancer).startMilestone(1), "Preceding milestone not settled");
    });

    it("milestone 1 cannot start while milestone 0 is Disputed", async function () {
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).openSeriousDispute(0, ethers.keccak256(ethers.toUtf8Bytes("Dispute 0")));
      const m0 = await deal.getMilestone(0);
      assert.strictEqual(m0.status, 4n); // Disputed
      await expectRevert(deal.connect(freelancer).startMilestone(1), "Preceding milestone not settled");
    });

    it("milestone 1 cannot start while milestone 0 is ResolutionProposed", async function () {
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).openSeriousDispute(0, ethers.keccak256(ethers.toUtf8Bytes("Dispute 0")));
      await deal.connect(primaryResolver).proposeMilestoneResolution(
        0,
        150_000_000n,
        150_000_000n,
        ethers.keccak256(ethers.toUtf8Bytes("Justification"))
      );
      const m0 = await deal.getMilestone(0);
      assert.strictEqual(m0.status, 5n); // ResolutionProposed
      await expectRevert(deal.connect(freelancer).startMilestone(1), "Preceding milestone not settled");
    });

    it("milestone 1 cannot start while milestone 0 is FinalReview", async function () {
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).openSeriousDispute(0, ethers.keccak256(ethers.toUtf8Bytes("Dispute 0")));
      await deal.connect(primaryResolver).proposeMilestoneResolution(
        0,
        150_000_000n,
        150_000_000n,
        ethers.keccak256(ethers.toUtf8Bytes("Justification"))
      );
      await deal.connect(client).requestFinalReconsideration(0);
      const m0 = await deal.getMilestone(0);
      assert.strictEqual(m0.status, 6n); // FinalReview
      await expectRevert(deal.connect(freelancer).startMilestone(1), "Preceding milestone not settled");
    });

    it("milestone 1 cannot start while milestone 0 is AssessmentPending (protected deal)", async function () {
      const protectedDeal = await deployAndInitDeal(undefined, true);
      await usdc.connect(client).approve(await protectedDeal.getAddress(), TOTAL_ESCROW_3M);
      await protectedDeal.connect(client).fundDeal();

      await protectedDeal.connect(freelancer).startMilestone(0);
      await protectedDeal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await protectedDeal.connect(client).rejectWorkProtected(0, ethers.keccak256(ethers.toUtf8Bytes("Reject reason")));
      const m0 = await protectedDeal.getMilestone(0);
      assert.strictEqual(m0.status, 10n); // AssessmentPending
      await expectRevert(protectedDeal.connect(freelancer).startMilestone(1), "Preceding milestone not settled");
    });

    it("milestone 1 cannot start while milestone 0 is AssessmentProposed (protected deal)", async function () {
      const protectedDeal = await deployAndInitDeal(undefined, true);
      await usdc.connect(client).approve(await protectedDeal.getAddress(), TOTAL_ESCROW_3M);
      await protectedDeal.connect(client).fundDeal();

      await protectedDeal.connect(freelancer).startMilestone(0);
      await protectedDeal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await protectedDeal.connect(client).rejectWorkProtected(0, ethers.keccak256(ethers.toUtf8Bytes("Reject reason")));
      await protectedDeal.connect(protectionModule).registerAssessmentProposal(0, 5000, ethers.keccak256(ethers.toUtf8Bytes("Report")));
      const m0 = await protectedDeal.getMilestone(0);
      assert.strictEqual(m0.status, 11n); // AssessmentProposed
      await expectRevert(protectedDeal.connect(freelancer).startMilestone(1), "Preceding milestone not settled");
    });

    it("milestone 1 starts after milestone 0 SettledPaid via client approval", async function () {
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).clientApprove(0);
      const m0 = await deal.getMilestone(0);
      assert.strictEqual(m0.status, 7n); // SettledPaid
      assert.strictEqual(await deal.state(), 1n); // Still Active

      // Milestone 1 start now succeeds!
      const tx = await deal.connect(freelancer).startMilestone(1);
      await tx.wait();
      const m1 = await deal.getMilestone(1);
      assert.strictEqual(m1.status, 1n); // InProgress
    });

    it("milestone 1 starts after milestone 0 SettledPaid via review timeout", async function () {
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      const m0 = await deal.getMilestone(0);

      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(m0.submittedAt + m0.reviewWindow) + 10]);
      await ethers.provider.send("evm_mine");

      await deal.connect(thirdParty).settleReviewTimeout(0);
      const m0Settled = await deal.getMilestone(0);
      assert.strictEqual(m0Settled.status, 7n); // SettledPaid

      // Milestone 1 start succeeds
      await deal.connect(freelancer).startMilestone(1);
      const m1 = await deal.getMilestone(1);
      assert.strictEqual(m1.status, 1n);
    });

    it("milestone 1 starts after milestone 0 SettledRefunded if Deal Active", async function () {
      const m0 = await deal.getMilestone(0);
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(m0.workDeadline + m0.gracePeriod) + 10]);
      await ethers.provider.send("evm_mine");

      // Claim expired refund on milestone 0
      await deal.connect(thirdParty).claimExpiredRefund(0);
      const m0Settled = await deal.getMilestone(0);
      assert.strictEqual(m0Settled.status, 8n); // SettledRefunded
      assert.strictEqual(await deal.state(), 1n); // Active

      // Milestone 1 start succeeds
      await deal.connect(freelancer).startMilestone(1);
      const m1 = await deal.getMilestone(1);
      assert.strictEqual(m1.status, 1n);
    });

    it("milestone 1 starts after milestone 0 SettledSplit via mutual settlement if Deal Active", async function () {
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const domain = {
        name: "SynqDealV1",
        version: "1",
        chainId: chainId,
        verifyingContract: await deal.getAddress(),
      };
      const types = {
        MutualSettlementProposal: [
          { name: "dealAddress", type: "address" },
          { name: "chainId", type: "uint256" },
          { name: "milestoneId", type: "uint256" },
          { name: "proposer", type: "address" },
          { name: "freelancerAmount", type: "uint256" },
          { name: "clientAmount", type: "uint256" },
          { name: "proposalNonce", type: "uint64" },
          { name: "validUntil", type: "uint64" },
        ],
      };

      const currentBlockTime = await getLatestBlockTimestamp();
      const proposal = {
        dealAddress: await deal.getAddress(),
        chainId: chainId,
        milestoneId: 0n,
        proposer: client.address,
        freelancerAmount: 150_000_000n,
        clientAmount: 150_000_000n,
        proposalNonce: 1n,
        validUntil: BigInt(currentBlockTime + 2 * ONE_DAY),
      };

      const sig = await client.signTypedData(domain, types, proposal);
      await deal.connect(freelancer).executeMutualSettlement(proposal, sig);

      const m0 = await deal.getMilestone(0);
      assert.strictEqual(m0.status, 9n); // SettledSplit
      assert.strictEqual(await deal.state(), 1n); // Active

      // Milestone 1 start succeeds
      await deal.connect(freelancer).startMilestone(1);
      const m1 = await deal.getMilestone(1);
      assert.strictEqual(m1.status, 1n);
    });

    it("milestone 2 cannot bypass Pending milestone 1", async function () {
      // Settle milestone 0
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).clientApprove(0);

      // Milestone 1 is still Pending
      const m1 = await deal.getMilestone(1);
      assert.strictEqual(m1.status, 0n); // Pending

      // Trying to start milestone 2 must revert
      await expectRevert(deal.connect(freelancer).startMilestone(2), "Preceding milestone not settled");
    });

    it("milestone 2 cannot bypass InProgress milestone 1", async function () {
      // Settle milestone 0
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).clientApprove(0);

      // Start milestone 1
      await deal.connect(freelancer).startMilestone(1);
      const m1 = await deal.getMilestone(1);
      assert.strictEqual(m1.status, 1n); // InProgress

      // Trying to start milestone 2 must revert
      await expectRevert(deal.connect(freelancer).startMilestone(2), "Preceding milestone not settled");
    });

    it("multiple InProgress milestones impossible via startMilestone", async function () {
      await deal.connect(freelancer).startMilestone(0);
      await expectRevert(deal.connect(freelancer).startMilestone(1), "Preceding milestone not settled");
      await expectRevert(deal.connect(freelancer).startMilestone(2), "Preceding milestone not settled");
    });

    it("re-starting InProgress milestone fails", async function () {
      await deal.connect(freelancer).startMilestone(0);
      await expectRevert(deal.connect(freelancer).startMilestone(0), "Milestone not pending");
    });

    it("re-starting settled milestone fails", async function () {
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).clientApprove(0);
      await expectRevert(deal.connect(freelancer).startMilestone(0), "Milestone not pending");
    });

    it("unauthorized client cannot start", async function () {
      await expectRevert(deal.connect(client).startMilestone(0), "Only freelancer");
    });

    it("third party cannot start", async function () {
      await expectRevert(deal.connect(thirdParty).startMilestone(0), "Only freelancer");
    });

    it("Draft Deal cannot start", async function () {
      const draftDeal = await deployAndInitDeal();
      await expectRevert(draftDeal.connect(freelancer).startMilestone(0), "Invalid deal state");
    });

    it("Completed Deal cannot start", async function () {
      // Fast settle all 3 milestones
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).clientApprove(0);

      await deal.connect(freelancer).startMilestone(1);
      await deal.connect(freelancer).submitWork(1, EVIDENCE_HASH_2);
      await deal.connect(client).clientApprove(1);

      await deal.connect(freelancer).startMilestone(2);
      await deal.connect(freelancer).submitWork(2, EVIDENCE_HASH_3);
      await deal.connect(client).clientApprove(2);

      assert.strictEqual(await deal.state(), 2n); // DealState.Completed
      await expectRevert(deal.connect(freelancer).startMilestone(0), "Invalid deal state");
      await expectRevert(deal.connect(freelancer).startMilestone(1), "Invalid deal state");
    });

    it("invalid milestone ID fails", async function () {
      await expectRevert(deal.connect(freelancer).startMilestone(99), "Invalid milestone ID");
    });

    it("1-milestone Deal works", async function () {
      now = await getLatestBlockTimestamp();
      const singleMilestoneDeal = await deployAndInitDeal([
        {
          amount: 500_000_000n,
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 2 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH_1,
        },
      ]);
      await usdc.connect(client).approve(await singleMilestoneDeal.getAddress(), 500_000_000n);
      await singleMilestoneDeal.connect(client).fundDeal();

      await singleMilestoneDeal.connect(freelancer).startMilestone(0);
      await singleMilestoneDeal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await singleMilestoneDeal.connect(client).clientApprove(0);

      assert.strictEqual(await singleMilestoneDeal.state(), 2n); // Completed
    });

    it("3-milestone sequential happy path completes", async function () {
      // Milestone 0
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).clientApprove(0);
      assert.strictEqual(await deal.state(), 1n);

      // Milestone 1
      await deal.connect(freelancer).startMilestone(1);
      await deal.connect(freelancer).submitWork(1, EVIDENCE_HASH_2);
      await deal.connect(client).clientApprove(1);
      assert.strictEqual(await deal.state(), 1n);

      // Milestone 2
      await deal.connect(freelancer).startMilestone(2);
      await deal.connect(freelancer).submitWork(2, EVIDENCE_HASH_3);
      await deal.connect(client).clientApprove(2);

      assert.strictEqual(await deal.state(), 2n); // DealState.Completed
      assert.strictEqual(await deal.totalSettled(), TOTAL_ESCROW_3M);
    });
  });

  describe("3. Regression Verifications", function () {
    let deal;

    beforeEach(async function () {
      deal = await deployAndInitDeal();
    });

    it("funding regression: client only, exact totalEscrow transfer, state becomes Active", async function () {
      assert.strictEqual(await deal.state(), 0n); // Draft
      await usdc.connect(client).approve(await deal.getAddress(), TOTAL_ESCROW_3M);

      await expectRevert(deal.connect(thirdParty).fundDeal(), "Only client");
      await deal.connect(client).fundDeal();
      assert.strictEqual(await deal.state(), 1n); // Active
      assert.strictEqual(await usdc.balanceOf(await deal.getAddress()), TOTAL_ESCROW_3M);
    });

    it("submission regression: valid evidence before deadline, increments version", async function () {
      await usdc.connect(client).approve(await deal.getAddress(), TOTAL_ESCROW_3M);
      await deal.connect(client).fundDeal();

      await deal.connect(freelancer).startMilestone(0);
      const tx = await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await tx.wait();

      const m0 = await deal.getMilestone(0);
      assert.strictEqual(m0.status, 2n); // Submitted
      assert.strictEqual(m0.evidenceRootHash, EVIDENCE_HASH_1);
      assert.strictEqual(m0.version, 1n);
    });

    it("approval/settlement regression: releases only target milestone amount", async function () {
      await usdc.connect(client).approve(await deal.getAddress(), TOTAL_ESCROW_3M);
      await deal.connect(client).fundDeal();

      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);

      const balBefore = await usdc.balanceOf(freelancer.address);
      await deal.connect(client).clientApprove(0);
      const balAfter = await usdc.balanceOf(freelancer.address);

      assert.strictEqual(balAfter - balBefore, M1_AMOUNT);
      assert.strictEqual(await deal.totalSettled(), M1_AMOUNT);
    });

    it("expired refund regression: claimExpiredRefund on unsubmitted milestone after deadline+grace", async function () {
      await usdc.connect(client).approve(await deal.getAddress(), TOTAL_ESCROW_3M);
      await deal.connect(client).fundDeal();

      const m0 = await deal.getMilestone(0);
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(m0.workDeadline + m0.gracePeriod) + 10]);
      await ethers.provider.send("evm_mine");

      const clientBalBefore = await usdc.balanceOf(client.address);
      await deal.connect(thirdParty).claimExpiredRefund(0);
      const clientBalAfter = await usdc.balanceOf(client.address);

      assert.strictEqual(clientBalAfter - clientBalBefore, M1_AMOUNT);
      const m0Settled = await deal.getMilestone(0);
      assert.strictEqual(m0Settled.status, 8n); // SettledRefunded
    });
  });

  describe("4. Factory V2 Local Compatibility & Rotation Defenses", function () {
    let factoryV2;
    let chainId;

    function computeMilestonesHash(milestoneInits) {
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const encoded = abiCoder.encode(
        ['tuple(uint256 amount,uint64 workDeadline,uint64 reviewWindow,uint64 gracePeriod,bytes32 specHash)[]'],
        [milestoneInits]
      );
      return ethers.keccak256(encoded);
    }

    beforeEach(async function () {
      chainId = (await ethers.provider.getNetwork()).chainId;

      const FactoryV2 = await ethers.getContractFactory("SynqFactoryV2");
      factoryV2 = await FactoryV2.deploy(
        client.address, // owner
        await usdc.getAddress(),
        await oldImplementation.getAddress(), // initially old implementation
        await primaryResolverContract.getAddress(),
        await emergencyResolverContract.getAddress()
      );
      await factoryV2.waitForDeployment();
    });

    it("Factory V2 rotates locally to corrected implementation via setDealImplementation", async function () {
      assert.strictEqual(await factoryV2.dealImplementation(), await oldImplementation.getAddress());

      const tx = await factoryV2.connect(client).setDealImplementation(await sequentialImplementation.getAddress());
      await tx.wait();

      assert.strictEqual(await factoryV2.dealImplementation(), await sequentialImplementation.getAddress());
    });

    it("fresh proposal with corrected implementation accepts and creates Deal clone", async function () {
      // Rotate Factory to sequential implementation
      await factoryV2.connect(client).setDealImplementation(await sequentialImplementation.getAddress());

      const block = await ethers.provider.getBlock("latest");
      const nowTs = BigInt(block.timestamp);
      const milestoneInits = [
        {
          amount: 500_000_000n,
          workDeadline: nowTs + 86400n * 7n,
          reviewWindow: 86400n,
          gracePeriod: 86400n,
          specHash: ethers.id("Milestone 1 Spec"),
        },
      ];

      const proposal = {
        client: client.address,
        freelancer: freelancer.address,
        canonicalUsdc: await usdc.getAddress(),
        dealImplementation: await sequentialImplementation.getAddress(),
        primaryResolver: await primaryResolverContract.getAddress(),
        emergencyResolver: await emergencyResolverContract.getAddress(),
        milestonesHash: computeMilestonesHash(milestoneInits),
        isProtected: false,
        protectionModule: ethers.ZeroAddress,
        policyId: ethers.ZeroHash,
        proposalNonce: 1n,
        expiry: nowTs + 86400n,
      };

      const domain = {
        name: "SynqFactoryV2",
        version: "1",
        chainId: chainId,
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

      const sig = await client.signTypedData(domain, types, proposal);
      const tx = await factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, sig);
      const receipt = await tx.wait();

      const dealCreatedEvent = receipt.logs.find(
        (log) => log.fragment && log.fragment.name === "DealCreated"
      );
      assert.ok(dealCreatedEvent, "DealCreated event emitted");
      const dealAddress = dealCreatedEvent.args.dealAddress;

      assert.strictEqual(await factoryV2.isSynqDeal(dealAddress), true);

      // Verify clone points to sequentialImplementation
      const code = await ethers.provider.getCode(dealAddress);
      const implHex = (await sequentialImplementation.getAddress()).toLowerCase().replace("0x", "");
      assert(code.toLowerCase().includes(implHex), "Clone must delegate to sequential implementation");
    });

    it("stale old-implementation proposal rejects after rotation", async function () {
      const block = await ethers.provider.getBlock("latest");
      const nowTs = BigInt(block.timestamp);
      const milestoneInits = [
        {
          amount: 500_000_000n,
          workDeadline: nowTs + 86400n * 7n,
          reviewWindow: 86400n,
          gracePeriod: 86400n,
          specHash: ethers.id("Milestone 1 Spec"),
        },
      ];

      // Client signs proposal referencing oldImplementation
      const staleProposal = {
        client: client.address,
        freelancer: freelancer.address,
        canonicalUsdc: await usdc.getAddress(),
        dealImplementation: await oldImplementation.getAddress(),
        primaryResolver: await primaryResolverContract.getAddress(),
        emergencyResolver: await emergencyResolverContract.getAddress(),
        milestonesHash: computeMilestonesHash(milestoneInits),
        isProtected: false,
        protectionModule: ethers.ZeroAddress,
        policyId: ethers.ZeroHash,
        proposalNonce: 2n,
        expiry: nowTs + 86400n,
      };

      const domain = {
        name: "SynqFactoryV2",
        version: "1",
        chainId: chainId,
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

      const sig = await client.signTypedData(domain, types, staleProposal);

      // Now Factory rotates to sequential implementation
      await factoryV2.connect(client).setDealImplementation(await sequentialImplementation.getAddress());

      // Trying to accept the stale proposal must revert with "Deal implementation mismatch"
      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(staleProposal, milestoneInits, sig),
        "Deal implementation mismatch"
      );
    });

    it("existing old Deal unaffected by Factory rotation and new Deal enforces sequentiality", async function () {
      // 1. Deploy old deal while Factory has old implementation
      const block = await ethers.provider.getBlock("latest");
      const nowTs = BigInt(block.timestamp);
      const milestoneInits = [
        {
          amount: 300_000_000n,
          workDeadline: nowTs + 86400n * 7n,
          reviewWindow: 86400n,
          gracePeriod: 86400n,
          specHash: ethers.id("Milestone 1 Spec"),
        },
        {
          amount: 300_000_000n,
          workDeadline: nowTs + 86400n * 14n,
          reviewWindow: 86400n,
          gracePeriod: 86400n,
          specHash: ethers.id("Milestone 2 Spec"),
        },
      ];

      const oldProposal = {
        client: client.address,
        freelancer: freelancer.address,
        canonicalUsdc: await usdc.getAddress(),
        dealImplementation: await oldImplementation.getAddress(),
        primaryResolver: await primaryResolverContract.getAddress(),
        emergencyResolver: await emergencyResolverContract.getAddress(),
        milestonesHash: computeMilestonesHash(milestoneInits),
        isProtected: false,
        protectionModule: ethers.ZeroAddress,
        policyId: ethers.ZeroHash,
        proposalNonce: 10n,
        expiry: nowTs + 86400n,
      };

      const domain = {
        name: "SynqFactoryV2",
        version: "1",
        chainId: chainId,
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

      const sigOld = await client.signTypedData(domain, types, oldProposal);
      const txOld = await factoryV2.connect(freelancer).acceptDealProposal(oldProposal, milestoneInits, sigOld);
      const receiptOld = await txOld.wait();
      const oldDealAddr = receiptOld.logs.find((l) => l.fragment && l.fragment.name === "DealCreated").args.dealAddress;
      const oldDeal = await ethers.getContractAt("SynqDealV1", oldDealAddr);

      // 2. Rotate Factory to sequential implementation
      await factoryV2.connect(client).setDealImplementation(await sequentialImplementation.getAddress());

      // 3. Fund old deal & test that old deal STILL allows out-of-order start (original bytecode)
      await usdc.connect(client).approve(oldDealAddr, 600_000_000n);
      await oldDeal.connect(client).fundDeal();
      // On oldDeal, startMilestone(1) succeeds even while milestone 0 is pending!
      const txStart1 = await oldDeal.connect(freelancer).startMilestone(1);
      await txStart1.wait();
      const m1Old = await oldDeal.getMilestone(1);
      assert.strictEqual(m1Old.status, 1n); // InProgress on old deal!

      // 4. Create new deal on Factory V2 with sequentialImplementation
      const newProposal = {
        client: client.address,
        freelancer: freelancer.address,
        canonicalUsdc: await usdc.getAddress(),
        dealImplementation: await sequentialImplementation.getAddress(),
        primaryResolver: await primaryResolverContract.getAddress(),
        emergencyResolver: await emergencyResolverContract.getAddress(),
        milestonesHash: computeMilestonesHash(milestoneInits),
        isProtected: false,
        protectionModule: ethers.ZeroAddress,
        policyId: ethers.ZeroHash,
        proposalNonce: 11n,
        expiry: nowTs + 86400n,
      };
      const sigNew = await client.signTypedData(domain, types, newProposal);
      const txNew = await factoryV2.connect(freelancer).acceptDealProposal(newProposal, milestoneInits, sigNew);
      const receiptNew = await txNew.wait();
      const newDealAddr = receiptNew.logs.find((l) => l.fragment && l.fragment.name === "DealCreated").args.dealAddress;
      const newDeal = await ethers.getContractAt("SynqDealV1Sequential", newDealAddr);

      await usdc.connect(client).approve(newDealAddr, 600_000_000n);
      await newDeal.connect(client).fundDeal();

      // On newDeal, startMilestone(1) REVERTS because milestone 0 is pending!
      await expectRevert(newDeal.connect(freelancer).startMilestone(1), "Preceding milestone not settled");
    });

    it("Factory isSynqDeal recognizes corrected clone", async function () {
      await factoryV2.connect(client).setDealImplementation(await sequentialImplementation.getAddress());

      const block = await ethers.provider.getBlock("latest");
      const nowTs = BigInt(block.timestamp);
      const milestoneInits = [
        {
          amount: 200_000_000n,
          workDeadline: nowTs + 86400n * 7n,
          reviewWindow: 86400n,
          gracePeriod: 86400n,
          specHash: ethers.id("Milestone 1 Spec"),
        },
      ];

      const proposal = {
        client: client.address,
        freelancer: freelancer.address,
        canonicalUsdc: await usdc.getAddress(),
        dealImplementation: await sequentialImplementation.getAddress(),
        primaryResolver: await primaryResolverContract.getAddress(),
        emergencyResolver: await emergencyResolverContract.getAddress(),
        milestonesHash: computeMilestonesHash(milestoneInits),
        isProtected: false,
        protectionModule: ethers.ZeroAddress,
        policyId: ethers.ZeroHash,
        proposalNonce: 20n,
        expiry: nowTs + 86400n,
      };

      const domain = {
        name: "SynqFactoryV2",
        version: "1",
        chainId: chainId,
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

      const sig = await client.signTypedData(domain, types, proposal);
      const tx = await factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, sig);
      const receipt = await tx.wait();
      const dealAddr = receipt.logs.find((l) => l.fragment && l.fragment.name === "DealCreated").args.dealAddress;

      assert.strictEqual(await factoryV2.isSynqDeal(dealAddr), true);
      assert.strictEqual(await factoryV2.isSynqDeal(thirdParty.address), false);
    });

    it("proposal EIP-712 schema unchanged", async function () {
      const typehash = await factoryV2.DEAL_PROPOSAL_TYPEHASH();
      const expectedTypehash = ethers.keccak256(
        ethers.toUtf8Bytes(
          "DealProposal(address client,address freelancer,address canonicalUsdc,address dealImplementation,address primaryResolver,address emergencyResolver,bytes32 milestonesHash,bool isProtected,address protectionModule,bytes32 policyId,uint256 proposalNonce,uint256 expiry)"
        )
      );
      assert.strictEqual(typehash, expectedTypehash);
    });

    it("no new storage requirement / initialization compatible", async function () {
      const deal = await deployAndInitDeal();
      assert.strictEqual(await deal.milestoneCount(), 3n);
      assert.strictEqual(await deal.totalEscrow(), TOTAL_ESCROW_3M);
      assert.strictEqual(await deal.totalSettled(), 0n);
      assert.strictEqual(await deal.state(), 0n); // Draft
      assert.strictEqual(await deal.client(), client.address);
      assert.strictEqual(await deal.freelancer(), freelancer.address);
      assert.strictEqual(await deal.usdc(), await usdc.getAddress());
    });

    it("ABI compatibility: sequential implementation exposes all ISynqDeal functions", async function () {
      const deal = await deployAndInitDeal();
      assert.strictEqual(typeof deal.initialize, "function");
      assert.strictEqual(typeof deal.fundDeal, "function");
      assert.strictEqual(typeof deal.cancelBeforeFunding, "function");
      assert.strictEqual(typeof deal.startMilestone, "function");
      assert.strictEqual(typeof deal.submitWork, "function");
      assert.strictEqual(typeof deal.clientApprove, "function");
      assert.strictEqual(typeof deal.settleReviewTimeout, "function");
      assert.strictEqual(typeof deal.triggerReviewTimeoutProtected, "function");
      assert.strictEqual(typeof deal.rejectWorkProtected, "function");
      assert.strictEqual(typeof deal.claimExpiredRefund, "function");
      assert.strictEqual(typeof deal.requestRevision, "function");
      assert.strictEqual(typeof deal.acceptRevision, "function");
      assert.strictEqual(typeof deal.declineRevision, "function");
      assert.strictEqual(typeof deal.timeoutRevisionResponse, "function");
      assert.strictEqual(typeof deal.openSeriousDispute, "function");
      assert.strictEqual(typeof deal.cancelProposal, "function");
      assert.strictEqual(typeof deal.executeMutualSettlement, "function");
      assert.strictEqual(typeof deal.proposeMilestoneResolution, "function");
      assert.strictEqual(typeof deal.requestFinalReconsideration, "function");
      assert.strictEqual(typeof deal.executeResolution, "function");
      assert.strictEqual(typeof deal.executeFinalResolution, "function");
      assert.strictEqual(typeof deal.getResolutionProposal, "function");
      assert.strictEqual(typeof deal.registerAssessmentProposal, "function");
      assert.strictEqual(typeof deal.challengeAssessment, "function");
      assert.strictEqual(typeof deal.acceptAssessment, "function");
      assert.strictEqual(typeof deal.executeAssessmentSettlement, "function");
      assert.strictEqual(typeof deal.timeoutAssessment, "function");
      assert.strictEqual(typeof deal.getAssessmentRequest, "function");
      assert.strictEqual(typeof deal.getAssessmentProposal, "function");
      assert.strictEqual(typeof deal.getMilestone, "function");
      assert.strictEqual(typeof deal.milestoneCount, "function");
      assert.strictEqual(typeof deal.client, "function");
      assert.strictEqual(typeof deal.freelancer, "function");
      assert.strictEqual(typeof deal.usdc, "function");
      assert.strictEqual(typeof deal.state, "function");
      assert.strictEqual(typeof deal.totalEscrow, "function");
      assert.strictEqual(typeof deal.totalSettled, "function");
    });
  });
});
