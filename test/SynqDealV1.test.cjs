const assert = require("node:assert");
const { ethers } = require("hardhat");

describe("SynqDealV1 Phase 1A Comprehensive Test Suite", function () {
  let usdc;
  let deal;
  let client, freelancer, primaryResolver, emergencyResolver, thirdParty;
  let now;
  const ONE_DAY = 86400;
  const ONE_HOUR = 3600;

  const M1_AMOUNT = 400_000_000n; // 400 USDC (6 decimals)
  const M2_AMOUNT = 600_000_000n; // 600 USDC (6 decimals)
  const TOTAL_ESCROW = 1_000_000_000n;

  const SPEC_HASH_1 = ethers.keccak256(ethers.toUtf8Bytes("Spec 1: API Endpoints"));
  const SPEC_HASH_2 = ethers.keccak256(ethers.toUtf8Bytes("Spec 2: Frontend Dashboard"));
  const EVIDENCE_HASH_1 = ethers.keccak256(ethers.toUtf8Bytes("Evidence 1: Manifest Commit SHA"));
  const EVIDENCE_HASH_2 = ethers.keccak256(ethers.toUtf8Bytes("Evidence 2: Revised Commit SHA"));

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

  let implementation;

  async function deployClone(implAddress) {
    const cleanAddr = implAddress.toLowerCase().replace("0x", "");
    const byteCode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${cleanAddr}5af43d82803e903d91602b57fd5bf3`;
    const tx = await client.sendTransaction({ data: byteCode });
    const receipt = await tx.wait();
    const cloneAddress = receipt.contractAddress;
    return await ethers.getContractAt("SynqDealV1", cloneAddress);
  }

  async function deployAndInitDeal(customMilestones, tokenAddress) {
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
    ];

    if (!implementation) {
      const DealFactory = await ethers.getContractFactory("SynqDealV1");
      implementation = await DealFactory.deploy();
      await implementation.waitForDeployment();
    }

    const d = await deployClone(await implementation.getAddress());

    const initParams = {
      client: client.address,
      freelancer: freelancer.address,
      usdc: tokenAddress || (await usdc.getAddress()),
      primaryResolver: primaryResolver.address,
      emergencyResolver: emergencyResolver.address,
      isProtected: false,
      protectionModule: ethers.ZeroAddress,
      policyId: ethers.ZeroHash,
    };

    await d.initialize(initParams, milestones);
    return d;
  }

  beforeEach(async function () {
    [client, freelancer, primaryResolver, emergencyResolver, thirdParty] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6, ethers.parseUnits("1000000", 6));
    await usdc.waitForDeployment();

    // Mint USDC to client and thirdParty
    await usdc.mint(client.address, ethers.parseUnits("50000", 6));
    await usdc.mint(thirdParty.address, ethers.parseUnits("1000", 6));

    deal = await deployAndInitDeal();
    await usdc.connect(client).approve(await deal.getAddress(), TOTAL_ESCROW);
  });

  describe("1. Initialization & Invariants", function () {
    it("implementation contract initializers disabled", async function () {
      const initParams = {
        client: client.address,
        freelancer: freelancer.address,
        usdc: await usdc.getAddress(),
        primaryResolver: primaryResolver.address,
        emergencyResolver: emergencyResolver.address,
        isProtected: false,
        protectionModule: ethers.ZeroAddress,
        policyId: ethers.ZeroHash,
      };
      await expectRevert(implementation.initialize(initParams, []), "InvalidInitialization");
    });

    it("initialization only once on clone", async function () {
      const initParams = {
        client: client.address,
        freelancer: freelancer.address,
        usdc: await usdc.getAddress(),
        primaryResolver: primaryResolver.address,
        emergencyResolver: emergencyResolver.address,
        isProtected: false,
        protectionModule: ethers.ZeroAddress,
        policyId: ethers.ZeroHash,
      };
      await expectRevert(deal.initialize(initParams, []), "InvalidInitialization");
    });

    it("invalid client/freelancer rejected", async function () {
      const d = await deployClone(await implementation.getAddress());
      now = await getLatestBlockTimestamp();

      const m = [{
        amount: M1_AMOUNT,
        workDeadline: now + 5 * ONE_DAY,
        reviewWindow: 3 * ONE_DAY,
        gracePeriod: 1 * ONE_DAY,
        specHash: SPEC_HASH_1,
      }];

      // Zero client
      await expectRevert(
        d.initialize(
          {
            client: ethers.ZeroAddress,
            freelancer: freelancer.address,
            usdc: await usdc.getAddress(),
            primaryResolver: primaryResolver.address,
            emergencyResolver: emergencyResolver.address,
            isProtected: false,
            protectionModule: ethers.ZeroAddress,
            policyId: ethers.ZeroHash,
          },
          m
        ),
        "Zero client address"
      );

      // Zero freelancer
      await expectRevert(
        d.initialize(
          {
            client: client.address,
            freelancer: ethers.ZeroAddress,
            usdc: await usdc.getAddress(),
            primaryResolver: primaryResolver.address,
            emergencyResolver: emergencyResolver.address,
            isProtected: false,
            protectionModule: ethers.ZeroAddress,
            policyId: ethers.ZeroHash,
          },
          m
        ),
        "Zero freelancer address"
      );
    });

    it("client != freelancer required", async function () {
      const d = await deployClone(await implementation.getAddress());
      now = await getLatestBlockTimestamp();

      const m = [{
        amount: M1_AMOUNT,
        workDeadline: now + 5 * ONE_DAY,
        reviewWindow: 3 * ONE_DAY,
        gracePeriod: 1 * ONE_DAY,
        specHash: SPEC_HASH_1,
      }];

      await expectRevert(
        d.initialize(
          {
            client: client.address,
            freelancer: client.address,
            usdc: await usdc.getAddress(),
            primaryResolver: primaryResolver.address,
            emergencyResolver: emergencyResolver.address,
            isProtected: false,
            protectionModule: ethers.ZeroAddress,
            policyId: ethers.ZeroHash,
          },
          m
        ),
        "Client equals freelancer"
      );
    });

    it("EOA as USDC address rejected", async function () {
      const d = await deployClone(await implementation.getAddress());
      now = await getLatestBlockTimestamp();

      const m = [{
        amount: M1_AMOUNT,
        workDeadline: now + 5 * ONE_DAY,
        reviewWindow: 3 * ONE_DAY,
        gracePeriod: 1 * ONE_DAY,
        specHash: SPEC_HASH_1,
      }];

      await expectRevert(
        d.initialize(
          {
            client: client.address,
            freelancer: freelancer.address,
            usdc: thirdParty.address, // EOA has no code
            primaryResolver: primaryResolver.address,
            emergencyResolver: emergencyResolver.address,
            isProtected: false,
            protectionModule: ethers.ZeroAddress,
            policyId: ethers.ZeroHash,
          },
          m
        ),
        "USDC must be a contract"
      );
    });

    it("zero-value milestone rejected", async function () {
      const d = await deployClone(await implementation.getAddress());
      now = await getLatestBlockTimestamp();

      const m = [{
        amount: 0n,
        workDeadline: now + 5 * ONE_DAY,
        reviewWindow: 3 * ONE_DAY,
        gracePeriod: 1 * ONE_DAY,
        specHash: SPEC_HASH_1,
      }];

      await expectRevert(
        d.initialize(
          {
            client: client.address,
            freelancer: freelancer.address,
            usdc: await usdc.getAddress(),
            primaryResolver: primaryResolver.address,
            emergencyResolver: emergencyResolver.address,
            isProtected: false,
            protectionModule: ethers.ZeroAddress,
            policyId: ethers.ZeroHash,
          },
          m
        ),
        "Zero milestone amount"
      );
    });

    it("milestone sum accounting equals totalEscrow", async function () {
      assert.strictEqual(await deal.totalEscrow(), TOTAL_ESCROW);
      assert.strictEqual(await deal.milestoneCount(), 2n);
      assert.strictEqual(await deal.state(), 0n); // DealState.Draft
    });
  });

  describe("2. Funding & Collateralization", function () {
    it("exact funding transitions state to Active", async function () {
      const dealAddr = await deal.getAddress();
      const initialClientBal = await usdc.balanceOf(client.address);

      const tx = await deal.connect(client).fundDeal();
      await tx.wait();

      assert.strictEqual(await deal.state(), 1n); // DealState.Active
      assert.strictEqual(await usdc.balanceOf(dealAddr), TOTAL_ESCROW);
      assert.strictEqual(await usdc.balanceOf(client.address), initialClientBal - TOTAL_ESCROW);
    });

    it("prior unsolicited transfer does not satisfy funding", async function () {
      const dealAddr = await deal.getAddress();
      // Send 500 unsolicited USDC to deal prior to funding
      await usdc.connect(thirdParty).transfer(dealAddr, ethers.parseUnits("500", 6));

      // Client must still provide 100% of TOTAL_ESCROW for funding to succeed
      await deal.connect(client).fundDeal();
      assert.strictEqual(await deal.state(), 1n);
      assert.strictEqual(await usdc.balanceOf(dealAddr), TOTAL_ESCROW + ethers.parseUnits("500", 6));
    });

    it("fee-on-transfer / short transfer token fails collateralization check", async function () {
      const MockFeeToken = await ethers.getContractFactory("MockFeeToken");
      const feeToken = await MockFeeToken.deploy();
      await feeToken.waitForDeployment();
      await feeToken.mint(client.address, ethers.parseUnits("5000", 6));

      const feeDeal = await deployAndInitDeal(null, await feeToken.getAddress());
      await feeToken.connect(client).approve(await feeDeal.getAddress(), TOTAL_ESCROW);

      // Attempting to fund with 10% fee token transfers 900 instead of 1000
      await expectRevert(feeDeal.connect(client).fundDeal(), "Incomplete collateralization");

      // Deal remains in Draft state
      assert.strictEqual(await feeDeal.state(), 0n); // DealState.Draft
    });

    it("unauthorized funding rejected", async function () {
      await expectRevert(deal.connect(freelancer).fundDeal(), "Only client");
      await expectRevert(deal.connect(thirdParty).fundDeal(), "Only client");
    });

    it("cancelBeforeFunding by client or freelancer finality", async function () {
      const tx = await deal.connect(client).cancelBeforeFunding();
      await tx.wait();
      assert.strictEqual(await deal.state(), 4n); // DealState.Cancelled

      // Cannot fund or start milestones after cancellation
      await expectRevert(deal.connect(client).fundDeal(), "Invalid deal state");
      await expectRevert(deal.connect(freelancer).startMilestone(0), "Invalid deal state");
    });
  });

  describe("3. Milestone Lifecycle & Standard Settlement", function () {
    beforeEach(async function () {
      await deal.connect(client).fundDeal();
    });

    it("start milestone valid transition", async function () {
      const tx = await deal.connect(freelancer).startMilestone(0);
      await tx.wait();

      const m = await deal.getMilestone(0);
      assert.strictEqual(m.status, 1n); // InProgress
    });

    it("only freelancer can start milestone", async function () {
      await expectRevert(deal.connect(client).startMilestone(0), "Only freelancer");
      await expectRevert(deal.connect(thirdParty).startMilestone(0), "Only freelancer");
    });

    it("submission before deadline is valid", async function () {
      await deal.connect(freelancer).startMilestone(0);

      const tx = await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await tx.wait();

      const m = await deal.getMilestone(0);
      assert.strictEqual(m.status, 2n); // Submitted
      assert.strictEqual(m.evidenceRootHash, EVIDENCE_HASH_1);
      assert.strictEqual(m.version, 1n);
    });

    it("submission at exact deadline boundary is accepted", async function () {
      await deal.connect(freelancer).startMilestone(0);
      const m = await deal.getMilestone(0);
      const exactBoundary = Number(m.workDeadline + m.gracePeriod);

      await ethers.provider.send("evm_setNextBlockTimestamp", [exactBoundary]);
      const tx = await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await tx.wait();

      const mAfter = await deal.getMilestone(0);
      assert.strictEqual(mAfter.status, 2n); // Submitted
    });

    it("submission after deadline + grace is rejected", async function () {
      await deal.connect(freelancer).startMilestone(0);
      const m = await deal.getMilestone(0);

      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(m.workDeadline + m.gracePeriod) + 10]);
      await ethers.provider.send("evm_mine");

      await expectRevert(
        deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1),
        "Work deadline and grace expired"
      );
    });

    it("expired unsubmitted refund works permissionlessly", async function () {
      await deal.connect(freelancer).startMilestone(0);
      const m = await deal.getMilestone(0);

      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(m.workDeadline + m.gracePeriod) + 10]);
      await ethers.provider.send("evm_mine");

      const initialClientBal = await usdc.balanceOf(client.address);

      const tx = await deal.connect(thirdParty).claimExpiredRefund(0);
      await tx.wait();

      const finalClientBal = await usdc.balanceOf(client.address);
      assert.strictEqual(finalClientBal - initialClientBal, M1_AMOUNT);

      const updated = await deal.getMilestone(0);
      assert.strictEqual(updated.status, 8n); // SettledRefunded
    });

    it("client approval pays exactly once and releases 100% to freelancer", async function () {
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);

      const initialFreelancerBal = await usdc.balanceOf(freelancer.address);

      const tx = await deal.connect(client).clientApprove(0);
      await tx.wait();

      const finalFreelancerBal = await usdc.balanceOf(freelancer.address);
      assert.strictEqual(finalFreelancerBal - initialFreelancerBal, M1_AMOUNT);

      const m = await deal.getMilestone(0);
      assert.strictEqual(m.status, 7n); // SettledPaid

      // Settled milestone cannot settle twice
      await expectRevert(deal.connect(client).clientApprove(0), "Milestone not submitted");
    });

    it("review timeout pays freelancer permissionlessly after review window", async function () {
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);

      const m = await deal.getMilestone(0);
      await expectRevert(deal.connect(thirdParty).settleReviewTimeout(0), "Review window not expired");

      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(m.submittedAt + m.reviewWindow) + 10]);
      await ethers.provider.send("evm_mine");

      const initialFreelancerBal = await usdc.balanceOf(freelancer.address);

      const tx = await deal.connect(thirdParty).settleReviewTimeout(0);
      await tx.wait();

      const finalFreelancerBal = await usdc.balanceOf(freelancer.address);
      assert.strictEqual(finalFreelancerBal - initialFreelancerBal, M1_AMOUNT);
    });
  });

  describe("4. Revision Mutuality, Versioning & Spec Immutability", function () {
    beforeEach(async function () {
      await deal.connect(client).fundDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
    });

    it("client proposes deadline; freelancer accepts exact deadline (mutuality)", async function () {
      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("Fix navigation responsive layout"));
      const currentBlockTime = await getLatestBlockTimestamp();
      const proposedDeadline = currentBlockTime + 7 * ONE_DAY;

      // Invalid proposed deadlines rejected
      await expectRevert(
        deal.connect(client).requestRevision(0, reasonHash, currentBlockTime - 10),
        "Proposed deadline in past"
      );
      await expectRevert(
        deal.connect(client).requestRevision(0, reasonHash, currentBlockTime + 400 * ONE_DAY),
        "Proposed deadline exceeds max bound"
      );

      // Valid revision request
      const txReq = await deal.connect(client).requestRevision(0, reasonHash, proposedDeadline);
      await txReq.wait();

      const mRev = await deal.getMilestone(0);
      assert.strictEqual(mRev.status, 3n); // RevisionRequested
      assert.strictEqual(mRev.version, 1n); // Version does NOT increment on request
      assert.strictEqual(await deal.proposedRevisionDeadlines(0), BigInt(proposedDeadline));

      // Freelancer accepts without passing arbitrary deadline; exact proposed deadline is bound
      const txAccept = await deal.connect(freelancer).acceptRevision(0);
      await txAccept.wait();

      const mAfter = await deal.getMilestone(0);
      assert.strictEqual(mAfter.status, 1n); // InProgress
      assert.strictEqual(mAfter.workDeadline, BigInt(proposedDeadline));
      assert.strictEqual(mAfter.version, 1n); // Version does NOT increment on accept
      assert.strictEqual(mAfter.specHash, SPEC_HASH_1); // Spec hash is strictly preserved
    });

    it("resubmission increments version and preserves original specHash", async function () {
      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("Revision 1"));
      const currentBlockTime = await getLatestBlockTimestamp();
      const proposedDeadline = currentBlockTime + 5 * ONE_DAY;

      await deal.connect(client).requestRevision(0, reasonHash, proposedDeadline);
      await deal.connect(freelancer).acceptRevision(0);

      // Resubmit with new evidence
      const txResubmit = await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_2);
      await txResubmit.wait();

      const mResubmit = await deal.getMilestone(0);
      assert.strictEqual(mResubmit.status, 2n); // Submitted
      assert.strictEqual(mResubmit.version, 2n); // Version cleanly incremented to 2
      assert.strictEqual(mResubmit.evidenceRootHash, EVIDENCE_HASH_2);
      assert.strictEqual(mResubmit.specHash, SPEC_HASH_1); // Original specHash immutable
    });

    it("freelancer declines revision -> transitions to Disputed", async function () {
      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("Scope creep"));
      const currentBlockTime = await getLatestBlockTimestamp();
      await deal.connect(client).requestRevision(0, reasonHash, currentBlockTime + 3 * ONE_DAY);

      const tx = await deal.connect(freelancer).declineRevision(0);
      await tx.wait();

      const m = await deal.getMilestone(0);
      assert.strictEqual(m.status, 4n); // Disputed
    });

    it("freelancer timeout on revision response -> transitions to Disputed", async function () {
      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("Missing tests"));
      const currentBlockTime = await getLatestBlockTimestamp();
      await deal.connect(client).requestRevision(0, reasonHash, currentBlockTime + 3 * ONE_DAY);

      // Fast forward past 48 hours
      await ethers.provider.send("evm_increaseTime", [49 * ONE_HOUR]);
      await ethers.provider.send("evm_mine");

      const tx = await deal.connect(thirdParty).timeoutRevisionResponse(0);
      await tx.wait();

      const m = await deal.getMilestone(0);
      assert.strictEqual(m.status, 4n); // Disputed
    });
  });

  describe("5. Serious Dispute & State Freezing", function () {
    beforeEach(async function () {
      await deal.connect(client).fundDeal();
      await deal.connect(freelancer).startMilestone(0);
    });

    it("participant opens serious dispute and freezes passive settlement", async function () {
      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("Fabricated deliverables"));

      const tx = await deal.connect(client).openSeriousDispute(0, reasonHash);
      await tx.wait();

      const m = await deal.getMilestone(0);
      assert.strictEqual(m.status, 4n); // Disputed

      // Passive submission is blocked
      await expectRevert(deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1), "Milestone not in progress");

      // Expired refund is blocked
      await ethers.provider.send("evm_increaseTime", [30 * ONE_DAY]);
      await ethers.provider.send("evm_mine");
      await expectRevert(deal.connect(thirdParty).claimExpiredRefund(0), "Invalid status for expiration refund");
    });
  });

  describe("6. Proposer-Scoped Mutual Settlement (EIP-712)", function () {
    let domain;
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

    beforeEach(async function () {
      await deal.connect(client).fundDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).openSeriousDispute(0, ethers.keccak256(ethers.toUtf8Bytes("Disagreement")));

      const chainId = (await ethers.provider.getNetwork()).chainId;
      domain = {
        name: "SynqDealV1",
        version: "1",
        chainId: chainId,
        verifyingContract: await deal.getAddress(),
      };
    });

    it("client proposes and freelancer executes exact split", async function () {
      const currentBlockTime = await getLatestBlockTimestamp();
      const validUntil = currentBlockTime + 2 * ONE_DAY;

      const proposal = {
        dealAddress: await deal.getAddress(),
        chainId: (await ethers.provider.getNetwork()).chainId,
        milestoneId: 0,
        proposer: client.address,
        freelancerAmount: 250_000_000n,
        clientAmount: 150_000_000n,
        proposalNonce: 1n,
        validUntil: validUntil,
      };

      const signature = await client.signTypedData(domain, types, proposal);

      const initialFreelancerBal = await usdc.balanceOf(freelancer.address);
      const initialClientBal = await usdc.balanceOf(client.address);

      const tx = await deal.connect(freelancer).executeMutualSettlement(proposal, signature);
      await tx.wait();

      assert.strictEqual((await usdc.balanceOf(freelancer.address)) - initialFreelancerBal, 250_000_000n);
      assert.strictEqual((await usdc.balanceOf(client.address)) - initialClientBal, 150_000_000n);

      const m = await deal.getMilestone(0);
      assert.strictEqual(m.status, 9n); // SettledSplit
    });

    it("proposer cannot execute own proposal", async function () {
      const currentBlockTime = await getLatestBlockTimestamp();
      const proposal = {
        dealAddress: await deal.getAddress(),
        chainId: (await ethers.provider.getNetwork()).chainId,
        milestoneId: 0,
        proposer: client.address,
        freelancerAmount: 250_000_000n,
        clientAmount: 150_000_000n,
        proposalNonce: 1n,
        validUntil: currentBlockTime + ONE_DAY,
      };

      const signature = await client.signTypedData(domain, types, proposal);

      // Client cannot execute client's own proposal
      await expectRevert(
        deal.connect(client).executeMutualSettlement(proposal, signature),
        "Proposer cannot execute own proposal"
      );
    });

    it("proposer cancels proposal via cancelProposal()", async function () {
      const currentBlockTime = await getLatestBlockTimestamp();
      const proposal = {
        dealAddress: await deal.getAddress(),
        chainId: (await ethers.provider.getNetwork()).chainId,
        milestoneId: 0,
        proposer: client.address,
        freelancerAmount: 250_000_000n,
        clientAmount: 150_000_000n,
        proposalNonce: 2n,
        validUntil: currentBlockTime + ONE_DAY,
      };

      const signature = await client.signTypedData(domain, types, proposal);

      // Client cancels proposal nonce 2
      const txCancel = await deal.connect(client).cancelProposal(0, 2n);
      await txCancel.wait();

      // Freelancer attempts to execute cancelled proposal -> fails
      await expectRevert(
        deal.connect(freelancer).executeMutualSettlement(proposal, signature),
        "Nonce already used"
      );
    });

    it("proposer-scoped nonces are independent", async function () {
      const currentBlockTime = await getLatestBlockTimestamp();
      // Client has proposal with nonce 5
      const clientProposal = {
        dealAddress: await deal.getAddress(),
        chainId: (await ethers.provider.getNetwork()).chainId,
        milestoneId: 0,
        proposer: client.address,
        freelancerAmount: 200_000_000n,
        clientAmount: 200_000_000n,
        proposalNonce: 5n,
        validUntil: currentBlockTime + ONE_DAY,
      };
      // Freelancer separately has proposal with nonce 5
      const freelancerProposal = {
        dealAddress: await deal.getAddress(),
        chainId: (await ethers.provider.getNetwork()).chainId,
        milestoneId: 0,
        proposer: freelancer.address,
        freelancerAmount: 300_000_000n,
        clientAmount: 100_000_000n,
        proposalNonce: 5n,
        validUntil: currentBlockTime + ONE_DAY,
      };

      // Client cancels client proposal nonce 5
      await deal.connect(client).cancelProposal(0, 5n);

      // Freelancer's proposal with nonce 5 remains valid and executable by client!
      const freelancerSig = await freelancer.signTypedData(domain, types, freelancerProposal);
      const tx = await deal.connect(client).executeMutualSettlement(freelancerProposal, freelancerSig);
      await tx.wait();

      const m = await deal.getMilestone(0);
      assert.strictEqual(m.status, 9n); // SettledSplit
    });

    it("invalid split amount rejected", async function () {
      const currentBlockTime = await getLatestBlockTimestamp();
      const proposal = {
        dealAddress: await deal.getAddress(),
        chainId: (await ethers.provider.getNetwork()).chainId,
        milestoneId: 0,
        proposer: client.address,
        freelancerAmount: 300_000_000n,
        clientAmount: 200_000_000n, // Total = 500 != 400
        proposalNonce: 3n,
        validUntil: currentBlockTime + ONE_DAY,
      };

      const signature = await client.signTypedData(domain, types, proposal);
      await expectRevert(
        deal.connect(freelancer).executeMutualSettlement(proposal, signature),
        "Split does not equal milestone amount"
      );
    });

    it("expired proposal rejected", async function () {
      const currentBlockTime = await getLatestBlockTimestamp();
      const proposal = {
        dealAddress: await deal.getAddress(),
        chainId: (await ethers.provider.getNetwork()).chainId,
        milestoneId: 0,
        proposer: client.address,
        freelancerAmount: 200_000_000n,
        clientAmount: 200_000_000n,
        proposalNonce: 4n,
        validUntil: currentBlockTime - 10,
      };

      const signature = await client.signTypedData(domain, types, proposal);
      await expectRevert(
        deal.connect(freelancer).executeMutualSettlement(proposal, signature),
        "Proposal expired"
      );
    });

    it("cross-deal replay rejected", async function () {
      const otherDeal = await deployAndInitDeal();
      await usdc.connect(client).approve(await otherDeal.getAddress(), TOTAL_ESCROW);
      await otherDeal.connect(client).fundDeal();
      await otherDeal.connect(freelancer).startMilestone(0);
      await otherDeal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await otherDeal.connect(client).openSeriousDispute(0, ethers.keccak256(ethers.toUtf8Bytes("Disputed")));

      const currentBlockTime = await getLatestBlockTimestamp();
      const proposal = {
        dealAddress: await deal.getAddress(), // Bound to first deal
        chainId: (await ethers.provider.getNetwork()).chainId,
        milestoneId: 0,
        proposer: client.address,
        freelancerAmount: 200_000_000n,
        clientAmount: 200_000_000n,
        proposalNonce: 6n,
        validUntil: currentBlockTime + ONE_DAY,
      };

      const signature = await client.signTypedData(domain, types, proposal);

      await expectRevert(
        otherDeal.connect(freelancer).executeMutualSettlement(proposal, signature),
        "Mismatched dealAddress"
      );
    });
  });

  describe("7. Reentrancy Resistance & Mixed Completion", function () {
    it("reentrancy attempt during payout transfer is strictly prevented", async function () {
      const MockReentrantToken = await ethers.getContractFactory("MockReentrantToken");
      const reentrantToken = await MockReentrantToken.deploy();
      await reentrantToken.waitForDeployment();
      await reentrantToken.mint(client.address, ethers.parseUnits("5000", 6));

      const reentrantDeal = await deployAndInitDeal(null, await reentrantToken.getAddress());
      await reentrantToken.connect(client).approve(await reentrantDeal.getAddress(), TOTAL_ESCROW);
      await reentrantDeal.connect(client).fundDeal();

      await reentrantDeal.connect(freelancer).startMilestone(0);
      await reentrantDeal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);

      // Arm the reentrant token to reenter clientApprove on the deal during transfer payout
      await reentrantToken.setAttack(await reentrantDeal.getAddress(), 0);

      // When client approves, payout transfer triggers reentrancy -> reverts with ReentrancyGuardReentrantCall
      await expectRevert(
        reentrantDeal.connect(client).clientApprove(0),
        "ReentrancyGuardReentrantCall"
      );
    });

    it("deal completes only when EVERY milestone is terminal (mixed states)", async function () {
      // 3 milestones: 200, 300, 500 USDC
      const nowTime = await getLatestBlockTimestamp();
      const threeMilestones = [
        { amount: 200_000_000n, workDeadline: nowTime + 5 * ONE_DAY, reviewWindow: 2 * ONE_DAY, gracePeriod: ONE_DAY, specHash: SPEC_HASH_1 },
        { amount: 300_000_000n, workDeadline: nowTime + 10 * ONE_DAY, reviewWindow: 2 * ONE_DAY, gracePeriod: ONE_DAY, specHash: SPEC_HASH_2 },
        { amount: 500_000_000n, workDeadline: nowTime + 15 * ONE_DAY, reviewWindow: 2 * ONE_DAY, gracePeriod: ONE_DAY, specHash: SPEC_HASH_1 },
      ];

      const multiDeal = await deployAndInitDeal(threeMilestones);
      await usdc.connect(client).approve(await multiDeal.getAddress(), 1_000_000_000n);
      await multiDeal.connect(client).fundDeal();

      // Settle Milestone 0 via approval -> Paid
      await multiDeal.connect(freelancer).startMilestone(0);
      await multiDeal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await multiDeal.connect(client).clientApprove(0);
      assert.strictEqual(await multiDeal.state(), 1n); // Still Active!

      // Settle Milestone 1 via expired refund -> Refunded
      await multiDeal.connect(freelancer).startMilestone(1);
      const m1 = await multiDeal.getMilestone(1);
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(m1.workDeadline + m1.gracePeriod) + 10]);
      await ethers.provider.send("evm_mine");
      await multiDeal.connect(thirdParty).claimExpiredRefund(1);
      assert.strictEqual(await multiDeal.state(), 1n); // Still Active!

      // Settle Milestone 2 via review timeout -> Paid
      await multiDeal.connect(freelancer).startMilestone(2);
      await multiDeal.connect(freelancer).submitWork(2, EVIDENCE_HASH_1);
      const m2 = await multiDeal.getMilestone(2);
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(m2.submittedAt + m2.reviewWindow) + 10]);
      await ethers.provider.send("evm_mine");

      const txFinal = await multiDeal.connect(thirdParty).settleReviewTimeout(2);
      await txFinal.wait();

      // ALL 3 milestones now terminal -> Deal completes!
      assert.strictEqual(await multiDeal.state(), 2n); // DealState.Completed
      assert.strictEqual(await multiDeal.totalSettled(), 1_000_000_000n);
    });
  });
});
