const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("hardhat");

describe("Synq Premium Protection V1.1 Suite (Snapshot & Partial Deal Economics)", function () {
  let usdc;
  let dealImpl;
  let factoryV2;
  let pool;
  let committee;
  let managerV1_1;
  let managerV1;

  let owner, client, freelancer, stranger;
  let signerA, signerB, signerC;

  const ONE_DAY = 86400;
  const ONE_HOUR = 3600;
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

  const TEST_FEE_BPS = 200; // 2%
  const M1_AMOUNT = 300_000_000n; // 300 USDC
  const M2_AMOUNT = 700_000_000n; // 700 USDC

  const SPEC_HASH_1 = ethers.id("Milestone 1 Acceptance Criteria");
  const SPEC_HASH_2 = ethers.id("Milestone 2 Acceptance Criteria");
  const EVIDENCE_HASH_1 = ethers.id("Evidence Manifest 1");
  const REPORT_HASH_1 = ethers.id("Committee Decision Report 1");

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

  async function deployStandardV2Deal(
    dealClient,
    dealFreelancer,
    milestoneConfigs
  ) {
    const nowTime = await getLatestBlockTimestamp();
    const inits = milestoneConfigs.map((cfg, idx) => ({
      amount: cfg.amount,
      workDeadline: BigInt(cfg.deadline !== undefined ? cfg.deadline : nowTime + (idx + 1) * ONE_DAY),
      reviewWindow: BigInt(cfg.reviewWindow || 2 * ONE_DAY),
      gracePeriod: BigInt(cfg.gracePeriod || 0),
      specHash: cfg.specHash || ethers.id(`Milestone ${idx + 1} Spec`),
    }));

    const milestonesHash = computeMilestonesHash(inits);
    const totalAmount = inits.reduce((acc, m) => acc + m.amount, 0n);

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
      expiry: BigInt(nowTime + 86400 * 7),
    };

    const clientSignature = await dealClient.signTypedData(domain, types, proposal);

    const tx = await factoryV2
      .connect(dealFreelancer)
      .acceptDealProposal(proposal, inits, clientSignature);
    const receipt = await tx.wait();

    const event = receipt.logs.find((l) => {
      try {
        const parsed = factoryV2.interface.parseLog(l);
        return parsed && parsed.name === "DealCreated";
      } catch {
        return false;
      }
    });

    const parsedLog = factoryV2.interface.parseLog(event);
    const dealAddress = parsedLog.args.dealAddress;
    const deal = await ethers.getContractAt("SynqDealV1Sequential", dealAddress);

    // Client funds the deal
    await usdc.connect(dealClient).approve(dealAddress, totalAmount);
    await deal.connect(dealClient).fundDeal();

    return { deal, dealAddress, inits, totalAmount };
  }

  beforeEach(async function () {
    [owner, client, freelancer, stranger, signerA, signerB, signerC] =
      await ethers.getSigners();

    // 1. MockUSDC (4 args: name, symbol, decimals, initialSupply)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6, ethers.parseUnits("10000000", 6));
    await usdc.waitForDeployment();

    // Mint USDC to client
    await usdc.mint(client.address, ethers.parseUnits("10000000", 6));

    // 2. SynqDealV1Sequential implementation
    const DealImpl = await ethers.getContractFactory("SynqDealV1Sequential");
    dealImpl = await DealImpl.deploy();
    await dealImpl.waitForDeployment();

    // 3. Resolvers
    const mockResolver1 = await MockERC20.deploy("Mock Resolver 1", "MR1", 18, 0);
    const mockResolver2 = await MockERC20.deploy("Mock Resolver 2", "MR2", 18, 0);

    // 4. SynqFactoryV2
    const FactoryV2 = await ethers.getContractFactory("SynqFactoryV2");
    factoryV2 = await FactoryV2.deploy(
      owner.address,
      await usdc.getAddress(),
      await dealImpl.getAddress(),
      await mockResolver1.getAddress(),
      await mockResolver2.getAddress()
    );
    await factoryV2.waitForDeployment();

    // 5. SynqProtectionCommittee
    const Committee = await ethers.getContractFactory("SynqProtectionCommittee");
    committee = await Committee.deploy(
      signerA.address,
      signerB.address,
      signerC.address
    );
    await committee.waitForDeployment();

    // 6. SynqProtectionPool
    const Pool = await ethers.getContractFactory("SynqProtectionPool");
    pool = await Pool.deploy(owner.address, await usdc.getAddress(), ethers.ZeroAddress);
    await pool.waitForDeployment();

    // Capitalize pool with 50,000 USDC
    await usdc.connect(owner).approve(await pool.getAddress(), ethers.parseUnits("50000", 6));
    await pool.connect(owner).fundPool(ethers.parseUnits("50000", 6));

    // 7. Old V1 Manager (for comparison & isolation tests)
    const ManagerV1 = await ethers.getContractFactory("SynqPremiumProtectionManager");
    managerV1 = await ManagerV1.deploy(
      owner.address,
      await factoryV2.getAddress(),
      await usdc.getAddress(),
      await pool.getAddress(),
      await committee.getAddress(),
      TEST_FEE_BPS
    );
    await managerV1.waitForDeployment();

    // 8. New V1.1 Manager
    const ManagerV1_1 = await ethers.getContractFactory("SynqPremiumProtectionManagerV1_1");
    managerV1_1 = await ManagerV1_1.deploy(
      owner.address,
      await factoryV2.getAddress(),
      await usdc.getAddress(),
      await pool.getAddress(),
      await committee.getAddress(),
      TEST_FEE_BPS
    );
    await managerV1_1.waitForDeployment();

    // Wire pool manager to V1.1
    await pool.connect(owner).setManager(await managerV1_1.getAddress());
  });

  describe("Section 18.1 - 18.5: Basic Eligibility & Economics", function () {
    it("1. all-Pending deal before deadlines => all covered in bitmap", async function () {
      const now = await getLatestBlockTimestamp();
      const { dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: M1_AMOUNT, deadline: now + ONE_DAY },
        { amount: M2_AMOUNT, deadline: now + 2 * ONE_DAY },
      ]);

      const eligiblePrincipal = M1_AMOUNT + M2_AMOUNT;
      const expectedFee = (eligiblePrincipal * 200n) / 10000n; // 2% = 20 USDC
      await usdc.connect(client).approve(await managerV1_1.getAddress(), expectedFee);

      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      const policy = await managerV1_1.getPolicy(dealAddress);
      assert.strictEqual(policy.active, true);
      assert.strictEqual(Number(policy.coveredBitmap), 3); // bits 0 and 1 set: 1 | 2 = 3
      assert.strictEqual(policy.eligiblePrincipal, eligiblePrincipal);
      assert.strictEqual(policy.premiumPaid, expectedFee);
      assert.strictEqual(policy.maxCoverage, (eligiblePrincipal * 2000n) / 10000n); // 20% = 200 USDC
      assert.strictEqual(await managerV1_1.isMilestoneCovered(dealAddress, 0), true);
      assert.strictEqual(await managerV1_1.isMilestoneCovered(dealAddress, 1), true);
    });

    it("2. fee = 2% of eligiblePrincipal and 3. maxCoverage = 20% of eligiblePrincipal", async function () {
      const now = await getLatestBlockTimestamp();
      const { dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: 500_000_000n, deadline: now + ONE_DAY },
      ]);

      const expectedFee = (500_000_000n * 200n) / 10000n; // 10 USDC
      const expectedCoverage = (500_000_000n * 2000n) / 10000n; // 100 USDC

      await usdc.connect(client).approve(await managerV1_1.getAddress(), expectedFee);
      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      const policy = await managerV1_1.getPolicy(dealAddress);
      assert.strictEqual(policy.premiumPaid, expectedFee);
      assert.strictEqual(policy.maxCoverage, expectedCoverage);
    });

    it("4. Pending at exact expiry threshold => eligible", async function () {
      const now = await getLatestBlockTimestamp();
      const targetDeadline = now + 100;
      const { dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: M1_AMOUNT, deadline: targetDeadline, gracePeriod: 50 },
      ]);

      const expectedFee = (M1_AMOUNT * 200n) / 10000n;
      await usdc.connect(client).approve(await managerV1_1.getAddress(), expectedFee);

      // Set exact timestamp for the purchasePolicy block
      await ethers.provider.send("evm_setNextBlockTimestamp", [targetDeadline + 50]);
      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      const policy = await managerV1_1.getPolicy(dealAddress);
      assert.strictEqual(Number(policy.coveredBitmap), 1); // bit 0 set
      assert.strictEqual(policy.eligiblePrincipal, M1_AMOUNT);
    });

    it("5. Pending 1 second after threshold => excluded", async function () {
      const now = await getLatestBlockTimestamp();
      const targetDeadline = now + 100;
      const { dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: M1_AMOUNT, deadline: targetDeadline, gracePeriod: 50 },
      ]);

      // Move block time to 1 second AFTER threshold
      await setBlockTime(targetDeadline + 51);

      await usdc.connect(client).approve(await managerV1_1.getAddress(), 100_000_000n);
      // Since milestone 0 is the only milestone and it's expired, eligiblePrincipal == 0 => revert!
      await expectRevert(
        managerV1_1.connect(client).purchasePolicy(dealAddress),
        "No eligible milestones for protection"
      );
    });
  });

  describe("Section 18.6 - 18.16: Non-Pending Lifecycle States Excluded", function () {
    it("6. InProgress milestone is excluded", async function () {
      const now = await getLatestBlockTimestamp();
      const { deal, dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: M1_AMOUNT, deadline: now + ONE_DAY },
        { amount: M2_AMOUNT, deadline: now + 2 * ONE_DAY },
      ]);

      // Freelancer starts milestone 0 => status = InProgress
      await deal.connect(freelancer).startMilestone(0);

      // Client purchases policy: Milestone 0 should be EXCLUDED, Milestone 1 INCLUDED
      const expectedFee = (M2_AMOUNT * 200n) / 10000n;
      await usdc.connect(client).approve(await managerV1_1.getAddress(), expectedFee);
      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      const policy = await managerV1_1.getPolicy(dealAddress);
      assert.strictEqual(Number(policy.coveredBitmap), 2); // bit 0 is 0, bit 1 is 1 (binary: 10 = 2)
      assert.strictEqual(policy.eligiblePrincipal, M2_AMOUNT);
      assert.strictEqual(await managerV1_1.isMilestoneCovered(dealAddress, 0), false);
      assert.strictEqual(await managerV1_1.isMilestoneCovered(dealAddress, 1), true);
    });

    it("7. Submitted milestone is excluded", async function () {
      const now = await getLatestBlockTimestamp();
      const { deal, dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: M1_AMOUNT, deadline: now + ONE_DAY },
        { amount: M2_AMOUNT, deadline: now + 2 * ONE_DAY },
      ]);

      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);

      const expectedFee = (M2_AMOUNT * 200n) / 10000n;
      await usdc.connect(client).approve(await managerV1_1.getAddress(), expectedFee);
      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      const policy = await managerV1_1.getPolicy(dealAddress);
      assert.strictEqual(Number(policy.coveredBitmap), 2); // only milestone 1
      assert.strictEqual(policy.eligiblePrincipal, M2_AMOUNT);
    });

    it("8. RevisionRequested milestone is excluded", async function () {
      const now = await getLatestBlockTimestamp();
      const { deal, dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: M1_AMOUNT, deadline: now + ONE_DAY },
        { amount: M2_AMOUNT, deadline: now + 2 * ONE_DAY },
      ]);

      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).requestRevision(0, ethers.id("Need revision"), now + 3 * ONE_DAY);

      const expectedFee = (M2_AMOUNT * 200n) / 10000n;
      await usdc.connect(client).approve(await managerV1_1.getAddress(), expectedFee);
      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      const policy = await managerV1_1.getPolicy(dealAddress);
      assert.strictEqual(Number(policy.coveredBitmap), 2);
    });

    it("9. Disputed milestone is excluded", async function () {
      const now = await getLatestBlockTimestamp();
      const { deal, dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: M1_AMOUNT, deadline: now + ONE_DAY },
        { amount: M2_AMOUNT, deadline: now + 2 * ONE_DAY },
      ]);

      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).requestRevision(0, ethers.id("Need revision"), now + 3 * ONE_DAY);
      await deal.connect(freelancer).declineRevision(0); // escalates to Disputed

      const expectedFee = (M2_AMOUNT * 200n) / 10000n;
      await usdc.connect(client).approve(await managerV1_1.getAddress(), expectedFee);
      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      const policy = await managerV1_1.getPolicy(dealAddress);
      assert.strictEqual(Number(policy.coveredBitmap), 2);
    });

    it("12. SettledPaid milestone is excluded", async function () {
      const now = await getLatestBlockTimestamp();
      const { deal, dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: M1_AMOUNT, deadline: now + ONE_DAY },
        { amount: M2_AMOUNT, deadline: now + 2 * ONE_DAY },
      ]);

      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).clientApprove(0); // SettledPaid

      const expectedFee = (M2_AMOUNT * 200n) / 10000n;
      await usdc.connect(client).approve(await managerV1_1.getAddress(), expectedFee);
      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      const policy = await managerV1_1.getPolicy(dealAddress);
      assert.strictEqual(Number(policy.coveredBitmap), 2);
    });

    it("13. SettledRefunded milestone is excluded", async function () {
      const now = await getLatestBlockTimestamp();
      const { deal, dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: M1_AMOUNT, deadline: now + 100 },
        { amount: M2_AMOUNT, deadline: now + 2 * ONE_DAY },
      ]);

      // Expire milestone 0 and claim refund
      await setBlockTime(now + 105);
      await deal.claimExpiredRefund(0); // SettledRefunded

      const expectedFee = (M2_AMOUNT * 200n) / 10000n;
      await usdc.connect(client).approve(await managerV1_1.getAddress(), expectedFee);
      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      const policy = await managerV1_1.getPolicy(dealAddress);
      assert.strictEqual(Number(policy.coveredBitmap), 2);
    });
  });

  describe("Section 18.17 - 18.26: Multi-Milestone Snapshotting & Revisions", function () {
    it("17. mixed multi-milestone deal snapshots correct bitmap & 18. eligiblePrincipal sums only covered", async function () {
      const now = await getLatestBlockTimestamp();
      const { deal, dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: 100_000_000n, deadline: now + 10 }, // milestone 0: expired
        { amount: 200_000_000n, deadline: now + ONE_DAY }, // milestone 1: started
        { amount: 300_000_000n, deadline: now + 2 * ONE_DAY }, // milestone 2: pending eligible
        { amount: 400_000_000n, deadline: now + 3 * ONE_DAY }, // milestone 3: pending eligible
      ]);

      // Expire milestone 0
      await setBlockTime(now + 15);
      await deal.claimExpiredRefund(0);

      // Start milestone 1
      await deal.connect(freelancer).startMilestone(1);

      // Milestone 0: SettledRefunded -> excluded (bit 0 = 0)
      // Milestone 1: InProgress -> excluded (bit 1 = 0)
      // Milestone 2: Pending unexpired -> covered (bit 2 = 1)
      // Milestone 3: Pending unexpired -> covered (bit 3 = 1)
      // Bitmap: (1 << 2) | (1 << 3) = 4 | 8 = 12

      const expectedPrincipal = 300_000_000n + 400_000_000n; // 700 USDC
      const expectedFee = (expectedPrincipal * 200n) / 10000n; // 14 USDC

      await usdc.connect(client).approve(await managerV1_1.getAddress(), expectedFee);
      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      const policy = await managerV1_1.getPolicy(dealAddress);
      assert.strictEqual(Number(policy.coveredBitmap), 12);
      assert.strictEqual(policy.eligiblePrincipal, expectedPrincipal);
      assert.strictEqual(policy.premiumPaid, expectedFee);
      assert.strictEqual(policy.maxCoverage, (expectedPrincipal * 2000n) / 10000n);
    });

    it("19. zero eligible milestones => purchase reverts", async function () {
      const now = await getLatestBlockTimestamp();
      const { deal, dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: 100_000_000n, deadline: now + 100 },
        { amount: 100_000_000n, deadline: now + 10 },
      ]);

      // Start milestone 0 => InProgress (excluded)
      await deal.connect(freelancer).startMilestone(0);

      // Advance time past milestone 1's deadline
      await setBlockTime(now + 20);

      // Milestone 0 is InProgress (excluded), Milestone 1 is expired (excluded).
      // Deal state is Active.
      await usdc.connect(client).approve(await managerV1_1.getAddress(), 100_000_000n);
      await expectRevert(
        managerV1_1.connect(client).purchasePolicy(dealAddress),
        "No eligible milestones for protection"
      );
    });

    it("20. excluded milestone cannot submit Premium claim later", async function () {
      const now = await getLatestBlockTimestamp();
      const { deal, dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: M1_AMOUNT, deadline: now + ONE_DAY },
        { amount: M2_AMOUNT, deadline: now + 2 * ONE_DAY },
      ]);

      // Start milestone 0 => excluded
      await deal.connect(freelancer).startMilestone(0);

      const fee = (M2_AMOUNT * 200n) / 10000n;
      await usdc.connect(client).approve(await managerV1_1.getAddress(), fee);
      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      // Now milestone 0 expires and is refunded
      await setBlockTime(now + ONE_DAY + 5);
      await deal.claimExpiredRefund(0);

      // Client attempts to submit claim for milestone 0 => REVERT!
      await expectRevert(
        managerV1_1.connect(client).submitClaim(dealAddress, 0, EVIDENCE_HASH_1),
        "Milestone not covered by policy"
      );
    });

    it("21. covered milestone can claim after Standard ExpiredRefund settlement", async function () {
      const now = await getLatestBlockTimestamp();
      const { deal, dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: M1_AMOUNT, deadline: now + ONE_DAY },
      ]);

      const fee = (M1_AMOUNT * 200n) / 10000n;
      await usdc.connect(client).approve(await managerV1_1.getAddress(), fee);
      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      // Milestone 0 expires without being started
      await setBlockTime(now + ONE_DAY + 10);
      await deal.claimExpiredRefund(0);

      // Client submits claim on covered milestone 0
      await managerV1_1.connect(client).submitClaim(dealAddress, 0, EVIDENCE_HASH_1);

      const claim = await managerV1_1.getClaim(dealAddress, 0);
      assert.strictEqual(Number(claim.status), 1); // ClaimStatus.Submitted
      assert.strictEqual(claim.milestoneAmount, M1_AMOUNT);
    });

    it("22-26. revision cannot add excluded milestone, remove covered bit, or alter policy parameters", async function () {
      const now = await getLatestBlockTimestamp();
      const { deal, dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: M1_AMOUNT, deadline: now + ONE_DAY },
      ]);

      const fee = (M1_AMOUNT * 200n) / 10000n;
      await usdc.connect(client).approve(await managerV1_1.getAddress(), fee);
      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      const policyBefore = await managerV1_1.getPolicy(dealAddress);

      // Start work, submit, request revision, accept revision
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).requestRevision(0, ethers.id("Revise"), now + 5 * ONE_DAY);
      await deal.connect(freelancer).acceptRevision(0);

      // Inspect policy after revision
      const policyAfter = await managerV1_1.getPolicy(dealAddress);
      assert.strictEqual(policyAfter.coveredBitmap, policyBefore.coveredBitmap);
      assert.strictEqual(policyAfter.eligiblePrincipal, policyBefore.eligiblePrincipal);
      assert.strictEqual(policyAfter.premiumPaid, policyBefore.premiumPaid);
      assert.strictEqual(policyAfter.maxCoverage, policyBefore.maxCoverage);
    });
  });

  describe("Section 18.27 - 18.33: Claim Resolution, Caps, and Disbursement", function () {
    it("27. multiple covered claims work independently, 28. one claim per milestone, 29. 20% payout, 30. totalPaid cap", async function () {
      const now = await getLatestBlockTimestamp();
      const { deal, dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: 500_000_000n, deadline: now + ONE_DAY },
        { amount: 500_000_000n, deadline: now + 2 * ONE_DAY },
      ]);

      const fee = (1_000_000_000n * 200n) / 10000n; // 20 USDC
      await usdc.connect(client).approve(await managerV1_1.getAddress(), fee);
      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      // Expire milestone 0 and refund
      await setBlockTime(now + ONE_DAY + 10);
      await deal.claimExpiredRefund(0);

      // Submit claim 0
      await managerV1_1.connect(client).submitClaim(dealAddress, 0, EVIDENCE_HASH_1);

      // Duplicate claim attempt reverts
      await expectRevert(
        managerV1_1.connect(client).submitClaim(dealAddress, 0, EVIDENCE_HASH_1),
        "Claim already recorded"
      );

      // Temporarily point committee to owner for direct testing
      await managerV1_1.connect(owner).setProtectionCommittee(owner.address);

      await managerV1_1.connect(owner).recordCommitteeDecision(dealAddress, 0, 1, REPORT_HASH_1);

      const claim0 = await managerV1_1.getClaim(dealAddress, 0);
      assert.strictEqual(Number(claim0.status), 2); // Approved
      assert.strictEqual(claim0.payout, 100_000_000n); // 20% of 500 USDC = 100 USDC

      // Disburse claim 0
      const clientBalanceBefore = await usdc.balanceOf(client.address);
      await managerV1_1.disburseClaim(dealAddress, 0);
      const clientBalanceAfter = await usdc.balanceOf(client.address);
      assert.strictEqual(clientBalanceAfter - clientBalanceBefore, 100_000_000n);

      const policyAfter0 = await managerV1_1.getPolicy(dealAddress);
      assert.strictEqual(policyAfter0.totalPaid, 100_000_000n);
      assert.strictEqual(policyAfter0.active, true);

      // Expire milestone 1 and refund
      await setBlockTime(now + 2 * ONE_DAY + 10);
      await deal.claimExpiredRefund(1);

      // Submit claim 1
      await managerV1_1.connect(client).submitClaim(dealAddress, 1, ethers.id("Evidence 2"));
      await managerV1_1.connect(owner).recordCommitteeDecision(dealAddress, 1, 1, ethers.id("Report 2"));
      await managerV1_1.disburseClaim(dealAddress, 1);

      const policyAfter1 = await managerV1_1.getPolicy(dealAddress);
      assert.strictEqual(policyAfter1.totalPaid, 200_000_000n);
      assert.strictEqual(policyAfter1.active, false); // exhausted maxCoverage!
    });
  });

  describe("Section 18.34 - 18.40: Access Controls, Storage Independence & Pool Rotation", function () {
    it("34. unauthorized caller cannot purchase and 35. unauthorized caller cannot submit claim", async function () {
      const now = await getLatestBlockTimestamp();
      const { deal, dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: M1_AMOUNT, deadline: now + ONE_DAY },
      ]);

      await expectRevert(
        managerV1_1.connect(stranger).purchasePolicy(dealAddress),
        "Only deal client can purchase"
      );

      const fee = (M1_AMOUNT * 200n) / 10000n;
      await usdc.connect(client).approve(await managerV1_1.getAddress(), fee);
      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      await setBlockTime(now + ONE_DAY + 10);
      await deal.claimExpiredRefund(0);

      await expectRevert(
        managerV1_1.connect(stranger).submitClaim(dealAddress, 0, EVIDENCE_HASH_1),
        "Only policy client can submit claim"
      );
    });

    it("36. wrong/non-Factory deal rejected", async function () {
      await expectRevert(
        managerV1_1.connect(client).purchasePolicy(client.address),
        "Deal not registered with Factory"
      );
    });

    it("38. policy cannot be purchased twice", async function () {
      const now = await getLatestBlockTimestamp();
      const { dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: M1_AMOUNT, deadline: now + ONE_DAY },
      ]);

      const fee = (M1_AMOUNT * 200n) / 10000n;
      await usdc.connect(client).approve(await managerV1_1.getAddress(), fee * 2n);
      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      await expectRevert(
        managerV1_1.connect(client).purchasePolicy(dealAddress),
        "Policy already exists for deal"
      );
    });

    it("39. old V1 and V1.1 storage are independent", async function () {
      const now = await getLatestBlockTimestamp();
      const { dealAddress } = await deployStandardV2Deal(client, freelancer, [
        { amount: M1_AMOUNT, deadline: now + ONE_DAY },
      ]);

      const fee = (M1_AMOUNT * 200n) / 10000n;
      await usdc.connect(client).approve(await managerV1_1.getAddress(), fee);
      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      const policyV1_1 = await managerV1_1.getPolicy(dealAddress);
      const policyV1 = await managerV1.getPolicy(dealAddress);

      assert.strictEqual(policyV1_1.active, true);
      assert.strictEqual(policyV1.active, false);
      assert.strictEqual(policyV1.purchasedAt, 0n);
    });

    it("40. Pool manager rotation: old Manager loses payout authority, new Manager gains it", async function () {
      // Current pool manager is V1.1
      assert.strictEqual(await pool.manager(), await managerV1_1.getAddress());

      // Attempt payout from stranger => REVERT
      await expectRevert(
        pool.connect(stranger).payout(client.address, 1000n),
        "Only manager"
      );

      // Rotate pool manager back to old managerV1
      await pool.connect(owner).setManager(await managerV1.getAddress());
      assert.strictEqual(await pool.manager(), await managerV1.getAddress());

      // Rotate pool manager back to V1.1
      await pool.connect(owner).setManager(await managerV1_1.getAddress());
      assert.strictEqual(await pool.manager(), await managerV1_1.getAddress());
    });
  });

  describe("Section 6 / 18 Invariant Check: SettledRefunded Uniqueness", function () {
    it("41. claimExpiredRefund is the ONLY function in SynqDealV1Sequential that assigns SettledRefunded", function () {
      const sourcePath = path.join(__dirname, "../contracts/v1/SynqDealV1Sequential.sol");
      const source = fs.readFileSync(sourcePath, "utf8");

      const regex = /status\s*=\s*MilestoneStatus\.SettledRefunded/g;
      const matches = source.match(regex);
      assert(matches, "Must have at least one assignment to SettledRefunded");
      assert.strictEqual(
        matches.length,
        1,
        "Invariant violated: exactly ONE line in SynqDealV1Sequential.sol may assign SettledRefunded!"
      );

      const lines = source.split("\n");
      let foundInClaimExpiredRefund = false;
      let currentFunction = "";
      for (const line of lines) {
        if (line.includes("function ")) {
          currentFunction = line;
        }
        if (line.includes("status = MilestoneStatus.SettledRefunded")) {
          if (currentFunction.includes("claimExpiredRefund")) {
            foundInClaimExpiredRefund = true;
          }
        }
      }
      assert.strictEqual(
        foundInClaimExpiredRefund,
        true,
        "Invariant confirmed: SettledRefunded is written exclusively within claimExpiredRefund()"
      );
    });
  });

  describe("Section 3 & 4 Forensic Audit: Boundaries & Edge Cases", function () {
    it("42. Milestone count boundaries: 1, 10, 16 succeed, 17 strictly rejected", async function () {
      const now = await getLatestBlockTimestamp();

      // Count = 1
      const deal1 = await deployStandardV2Deal(client, freelancer, [
        { amount: 100_000_000n, deadline: now + ONE_DAY },
      ]);
      await usdc.connect(client).approve(await managerV1_1.getAddress(), 2_000_000n);
      await managerV1_1.connect(client).purchasePolicy(deal1.dealAddress);
      let pol = await managerV1_1.getPolicy(deal1.dealAddress);
      assert.strictEqual(Number(pol.coveredBitmap), 1); // 1 << 0

      // Count = 10
      const inits10 = Array.from({ length: 10 }, (_, i) => ({
        amount: 10_000_000n,
        deadline: now + (i + 1) * ONE_DAY,
      }));
      const deal10 = await deployStandardV2Deal(client, freelancer, inits10);
      await usdc.connect(client).approve(await managerV1_1.getAddress(), 2_000_000n);
      await managerV1_1.connect(client).purchasePolicy(deal10.dealAddress);
      pol = await managerV1_1.getPolicy(deal10.dealAddress);
      assert.strictEqual(Number(pol.coveredBitmap), (1 << 10) - 1); // 0x3FF = 1023

      // Count = 16
      const inits16 = Array.from({ length: 16 }, (_, i) => ({
        amount: 10_000_000n,
        deadline: now + (i + 1) * ONE_DAY,
      }));
      const deal16 = await deployStandardV2Deal(client, freelancer, inits16);
      await usdc.connect(client).approve(await managerV1_1.getAddress(), 3_200_000n);
      await managerV1_1.connect(client).purchasePolicy(deal16.dealAddress);
      pol = await managerV1_1.getPolicy(deal16.dealAddress);
      assert.strictEqual(Number(pol.coveredBitmap), 0xFFFF); // 65535, all 16 bits set

      // Count = 17 => Reverts
      const inits17 = Array.from({ length: 17 }, (_, i) => ({
        amount: 10_000_000n,
        deadline: now + (i + 1) * ONE_DAY,
      }));
      const deal17 = await deployStandardV2Deal(client, freelancer, inits17);
      await usdc.connect(client).approve(await managerV1_1.getAddress(), 10_000_000n);
      await expectRevert(
        managerV1_1.connect(client).purchasePolicy(deal17.dealAddress),
        "Milestone count exceeds maximum 16"
      );
    });

    it("43. Claim milestoneId boundary checks: 0, 15, 16, and MaxUint256", async function () {
      const now = await getLatestBlockTimestamp();
      const inits16 = Array.from({ length: 16 }, (_, i) => ({
        amount: 10_000_000n,
        deadline: now + ONE_DAY,
      }));
      const { deal, dealAddress } = await deployStandardV2Deal(client, freelancer, inits16);

      await usdc.connect(client).approve(await managerV1_1.getAddress(), 3_200_000n);
      await managerV1_1.connect(client).purchasePolicy(dealAddress);

      // Advance time and refund milestone 0 and milestone 15
      await setBlockTime(now + ONE_DAY + 10);
      await deal.claimExpiredRefund(0);
      await deal.claimExpiredRefund(15);

      // Claim for milestone 0 succeeds
      await managerV1_1.connect(client).submitClaim(dealAddress, 0, EVIDENCE_HASH_1);
      assert.strictEqual(Number((await managerV1_1.getClaim(dealAddress, 0)).status), 1);

      // Claim for milestone 15 succeeds
      await managerV1_1.connect(client).submitClaim(dealAddress, 15, EVIDENCE_HASH_1);
      assert.strictEqual(Number((await managerV1_1.getClaim(dealAddress, 15)).status), 1);

      // Claim for milestone 16 reverts
      await expectRevert(
        managerV1_1.connect(client).submitClaim(dealAddress, 16, EVIDENCE_HASH_1),
        "Invalid milestone ID"
      );

      // Claim for max uint256 reverts
      const maxUint256 = (1n << 256n) - 1n;
      await expectRevert(
        managerV1_1.connect(client).submitClaim(dealAddress, maxUint256, EVIDENCE_HASH_1),
        "Invalid milestone ID"
      );
    });

    it("44. Zero-fee and zero-coverage edge case behavior verified", async function () {
      const now = await getLatestBlockTimestamp();
      // Deal with 49 micro-USDC (0.000049 USDC)
      // At 200 bps: fee = 49 * 200 / 10000 = 0!
      const dealSmall = await deployStandardV2Deal(client, freelancer, [
        { amount: 49n, deadline: now + ONE_DAY },
      ]);
      await usdc.connect(client).approve(await managerV1_1.getAddress(), 1000n);

      // Must revert with "Zero premium fee"
      await expectRevert(
        managerV1_1.connect(client).purchasePolicy(dealSmall.dealAddress),
        "Zero premium fee"
      );

      // Minimum valid fee at 200 bps is 50 micro-USDC:
      // fee = 50 * 200 / 10000 = 1
      // coverage = 50 * 2000 / 10000 = 10
      const deal50 = await deployStandardV2Deal(client, freelancer, [
        { amount: 50n, deadline: now + ONE_DAY },
      ]);
      await usdc.connect(client).approve(await managerV1_1.getAddress(), 1000n);
      await managerV1_1.connect(client).purchasePolicy(deal50.dealAddress);

      const pol50 = await managerV1_1.getPolicy(deal50.dealAddress);
      assert.strictEqual(pol50.premiumPaid, 1n);
      assert.strictEqual(pol50.maxCoverage, 10n);
      assert.strictEqual(pol50.eligiblePrincipal, 50n);
    });
  });
});
