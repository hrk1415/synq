const assert = require("node:assert");
const { ethers } = require("hardhat");

describe("SynqProtectionModule Phase 1D Comprehensive Test Suite", function () {
  let usdc, factory, dealImplementation, protectionModule;
  let owner, client, freelancer, verifier, alternateVerifier, thirdParty;
  let primaryResolver, emergencyResolver;
  let defaultPolicyId;

  const ONE_DAY = 86400;
  const ONE_HOUR = 3600;
  const M1_AMOUNT = 100_000_000n; // 100 USDC (6 decimals)
  const TOTAL_ESCROW = 100_000_000n;

  const SPEC_HASH = ethers.keccak256(ethers.toUtf8Bytes("Spec 1: Measurable acceptance criteria"));
  const EVIDENCE_HASH = ethers.keccak256(ethers.toUtf8Bytes("Evidence 1: Delivery artifact hash"));
  const REPORT_HASH = ethers.keccak256(ethers.toUtf8Bytes("Report 1: Off-chain AI verification report"));

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

  async function signAttestation(signer, att, moduleAddress) {
    const domain = {
      name: "SynqProtectionModule",
      version: "1",
      chainId: 31337,
      verifyingContract: moduleAddress || (await protectionModule.getAddress()),
    };

    const types = {
      AssessmentAttestation: [
        { name: "protectionModule", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "deal", type: "address" },
        { name: "milestoneId", type: "uint256" },
        { name: "evidenceRootHash", type: "bytes32" },
        { name: "specHash", type: "bytes32" },
        { name: "policyId", type: "bytes32" },
        { name: "submissionVersion", type: "uint8" },
        { name: "completionBps", type: "uint16" },
        { name: "reportHash", type: "bytes32" },
        { name: "assessmentNonce", type: "uint64" },
        { name: "validUntil", type: "uint64" },
        { name: "trigger", type: "uint8" },
      ],
    };

    return await signer.signTypedData(domain, types, att);
  }

  async function createAndFundProtectedDeal(customAmount, customSpecHash) {
    const now = await getLatestBlockTimestamp();
    const milestoneAmount = customAmount !== undefined ? customAmount : M1_AMOUNT;
    const spec = customSpecHash || SPEC_HASH;

    const milestones = [
      {
        amount: milestoneAmount,
        workDeadline: now + 5 * ONE_DAY,
        reviewWindow: 3 * ONE_DAY,
        gracePeriod: 1 * ONE_DAY,
        specHash: spec,
      },
    ];

    const tx = await factory.connect(client).createProtectedDeal(
      client.address,
      freelancer.address,
      milestones
    );
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((log) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "DealCreated");

    const dealAddr = event.args.dealAddress;
    const dealContract = await ethers.getContractAt("SynqDealV1", dealAddr);

    // Fund deal
    await usdc.mint(client.address, milestoneAmount);
    await usdc.connect(client).approve(dealAddr, milestoneAmount);
    await dealContract.connect(client).fundDeal();

    return dealContract;
  }

  async function createAndFundStandardDeal() {
    const now = await getLatestBlockTimestamp();
    const milestones = [
      {
        amount: M1_AMOUNT,
        workDeadline: now + 5 * ONE_DAY,
        reviewWindow: 3 * ONE_DAY,
        gracePeriod: 1 * ONE_DAY,
        specHash: SPEC_HASH,
      },
    ];

    const tx = await factory.connect(client).createDeal(
      client.address,
      freelancer.address,
      milestones
    );
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((log) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "DealCreated");

    const dealAddr = event.args.dealAddress;
    const dealContract = await ethers.getContractAt("SynqDealV1", dealAddr);

    await usdc.mint(client.address, M1_AMOUNT);
    await usdc.connect(client).approve(dealAddr, M1_AMOUNT);
    await dealContract.connect(client).fundDeal();

    return dealContract;
  }

  beforeEach(async function () {
    [
      owner,
      client,
      freelancer,
      verifier,
      alternateVerifier,
      thirdParty,
      primaryResolver,
      emergencyResolver,
    ] = await ethers.getSigners();

    defaultPolicyId = ethers.keccak256(ethers.toUtf8Bytes("SYNQ_PROTECTION_POLICY_V1"));

    // Deploy Mock USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6, ethers.parseUnits("1000000", 6));
    await usdc.waitForDeployment();

    // Deploy SynqDealV1 implementation
    const DealFactory = await ethers.getContractFactory("SynqDealV1");
    dealImplementation = await DealFactory.deploy();
    await dealImplementation.waitForDeployment();

    // Deploy Mock Resolvers
    const MockResolver = await ethers.getContractFactory("MockResolver");
    const mockPrimary = await MockResolver.deploy();
    await mockPrimary.waitForDeployment();
    const mockEmergency = await MockResolver.deploy();
    await mockEmergency.waitForDeployment();
    primaryResolver = mockPrimary;
    emergencyResolver = mockEmergency;

    // Deploy SynqFactoryV1
    const FactoryContract = await ethers.getContractFactory("SynqFactoryV1");
    factory = await FactoryContract.deploy(
      owner.address,
      await usdc.getAddress(),
      await dealImplementation.getAddress(),
      await primaryResolver.getAddress(),
      await emergencyResolver.getAddress()
    );
    await factory.waitForDeployment();

    // Deploy SynqProtectionModule
    const ModuleFactory = await ethers.getContractFactory("SynqProtectionModule");
    protectionModule = await ModuleFactory.deploy(
      owner.address,
      await factory.getAddress(),
      verifier.address
    );
    await protectionModule.waitForDeployment();

    // Configure Factory defaults for Protected deals
    await factory.connect(owner).setDefaultProtectionModule(await protectionModule.getAddress());
    await factory.connect(owner).setDefaultProtectionPolicyId(defaultPolicyId);
  });

  // ==================================================
  // 29. PROTECTION MODULE GOVERNANCE TESTS (1 - 10)
  // ==================================================
  describe("29. Protection Module Governance Tests", function () {
    it("1. module binds trusted Factory", async function () {
      assert.equal(await protectionModule.factory(), await factory.getAddress());
    });

    it("2. invalid Factory rejected", async function () {
      const ModuleFactory = await ethers.getContractFactory("SynqProtectionModule");
      await expectRevert(
        ModuleFactory.deploy(owner.address, ethers.ZeroAddress, verifier.address),
        "Zero factory address"
      );
      await expectRevert(
        ModuleFactory.deploy(owner.address, thirdParty.address, verifier.address),
        "Factory must be a contract"
      );
    });

    it("3. verifier configured correctly", async function () {
      assert.equal(await protectionModule.isVerifier(verifier.address), true);
      assert.equal(await protectionModule.isVerifier(alternateVerifier.address), false);
    });

    it("4. unauthorized verifier rejected", async function () {
      assert.equal(await protectionModule.isVerifier(thirdParty.address), false);
    });

    it("5. verifier rotation/add/remove authorization", async function () {
      // Non-owner cannot add
      await expectRevert(
        protectionModule.connect(thirdParty).addVerifier(alternateVerifier.address),
        "OwnableUnauthorizedAccount"
      );

      // Owner adds alternateVerifier
      await protectionModule.connect(owner).addVerifier(alternateVerifier.address);
      assert.equal(await protectionModule.isVerifier(alternateVerifier.address), true);

      // Duplicate add rejected
      await expectRevert(
        protectionModule.connect(owner).addVerifier(alternateVerifier.address),
        "Already verifier"
      );

      // Non-owner cannot remove
      await expectRevert(
        protectionModule.connect(thirdParty).removeVerifier(verifier.address),
        "OwnableUnauthorizedAccount"
      );

      // Owner removes verifier
      await protectionModule.connect(owner).removeVerifier(verifier.address);
      assert.equal(await protectionModule.isVerifier(verifier.address), false);

      // Removing non-verifier rejected
      await expectRevert(
        protectionModule.connect(owner).removeVerifier(verifier.address),
        "Not verifier"
      );
    });

    it("6. revoked verifier cannot sign new accepted assessment", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);
      await deal.connect(client).rejectWorkProtected(0, ethers.keccak256(ethers.toUtf8Bytes("Ordinary rejection")));

      // Revoke verifier
      await protectionModule.connect(owner).removeVerifier(verifier.address);

      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 7500,
        reportHash: REPORT_HASH,
        assessmentNonce: 1,
        validUntil: now + 3600,
        trigger: 1, // Rejection
      };

      const sig = await signAttestation(verifier, att);
      await expectRevert(
        protectionModule.connect(thirdParty).submitAssessment(att, sig),
        "Signer not authorized verifier"
      );
    });

    it("7. already-registered valid assessment survives later verifier revocation", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);
      await deal.connect(client).rejectWorkProtected(0, ethers.keccak256(ethers.toUtf8Bytes("Ordinary rejection")));

      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 7500,
        reportHash: REPORT_HASH,
        assessmentNonce: 1,
        validUntil: now + 3600,
        trigger: 1,
      };

      const sig = await signAttestation(verifier, att);
      await protectionModule.connect(thirdParty).submitAssessment(att, sig);

      // Proposal registered
      const mBefore = await deal.getMilestone(0);
      assert.equal(mBefore.status, 11); // AssessmentProposed

      // Revoke verifier
      await protectionModule.connect(owner).removeVerifier(verifier.address);

      // Proposal is still active in Deal
      const prop = await deal.getAssessmentProposal(0);
      assert.equal(prop.completionBps, 7500);

      // 48h elapses and settlement still executes successfully
      await ethers.provider.send("evm_increaseTime", [48 * ONE_HOUR + 1]);
      await ethers.provider.send("evm_mine");

      await deal.executeAssessmentSettlement(0);
      const mAfter = await deal.getMilestone(0);
      assert.equal(mAfter.status, 9); // SettledSplit
    });

    it("8. Protection admin cannot directly settle Deal", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);

      // Protection owner cannot call Deal entrypoints directly
      await expectRevert(
        deal.connect(owner).registerAssessmentProposal(0, 5000, REPORT_HASH),
        "Only protection module"
      );
    });

    it("9. Protection admin cannot transfer Deal escrow", async function () {
      const deal = await createAndFundProtectedDeal();
      const dealBalance = await usdc.balanceOf(await deal.getAddress());
      assert.equal(dealBalance, M1_AMOUNT);

      // Protection module has no withdraw or transfer authority over Deal or USDC
      assert.equal(await usdc.balanceOf(await protectionModule.getAddress()), 0n);
    });

    it("10. arbitrary non-Synq Deal rejected", async function () {
      // Deploy an arbitrary contract or fake deal
      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: thirdParty.address,
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 5000,
        reportHash: REPORT_HASH,
        assessmentNonce: 1,
        validUntil: now + 3600,
        trigger: 1,
      };

      const sig = await signAttestation(verifier, att);
      await expectRevert(
        protectionModule.connect(thirdParty).submitAssessment(att, sig),
        "Deal not registered with Factory"
      );
    });
  });

  // ==================================================
  // 30. PROTECTED FACTORY TESTS (11 - 21)
  // ==================================================
  describe("30. Protected Factory Tests", function () {
    it("11. Standard createDeal still creates Standard Deal", async function () {
      const deal = await createAndFundStandardDeal();
      assert.equal(await deal.isProtected(), false);
      assert.equal(await deal.protectionModule(), ethers.ZeroAddress);
      assert.equal(await deal.policyId(), ethers.ZeroHash);
    });

    it("12. Protected Deal creation snapshots protectionModule", async function () {
      const deal = await createAndFundProtectedDeal();
      assert.equal(await deal.isProtected(), true);
      assert.equal(await deal.protectionModule(), await protectionModule.getAddress());
    });

    it("13. Protected Deal snapshots policyId", async function () {
      const deal = await createAndFundProtectedDeal();
      assert.equal(await deal.policyId(), defaultPolicyId);
    });

    it("14. Factory future module update does not alter existing Protected Deal", async function () {
      const deal = await createAndFundProtectedDeal();
      const originalModule = await deal.protectionModule();

      // Deploy new module and update factory default
      const ModuleFactory = await ethers.getContractFactory("SynqProtectionModule");
      const newModule = await ModuleFactory.deploy(owner.address, await factory.getAddress(), verifier.address);
      await factory.connect(owner).setDefaultProtectionModule(await newModule.getAddress());

      // Existing deal still references originalModule
      assert.equal(await deal.protectionModule(), originalModule);
    });

    it("15. Factory future policy update does not alter existing Protected Deal", async function () {
      const deal = await createAndFundProtectedDeal();
      const originalPolicy = await deal.policyId();

      const newPolicy = ethers.keccak256(ethers.toUtf8Bytes("POLICY_V2"));
      await factory.connect(owner).setDefaultProtectionPolicyId(newPolicy);

      // Existing deal unchanged
      assert.equal(await deal.policyId(), originalPolicy);
    });

    it("16. future Protected Deal receives updated defaults", async function () {
      const newPolicy = ethers.keccak256(ethers.toUtf8Bytes("POLICY_V2"));
      await factory.connect(owner).setDefaultProtectionPolicyId(newPolicy);

      const deal = await createAndFundProtectedDeal();
      assert.equal(await deal.policyId(), newPolicy);
    });

    it("17. caller cannot inject arbitrary Protection Module", async function () {
      // createProtectedDeal has no parameter to specify arbitrary protection module
      // It always snapshots factory defaultProtectionModule
      const deal = await createAndFundProtectedDeal();
      assert.equal(await deal.protectionModule(), await factory.defaultProtectionModule());
    });

    it("18. zero policy rejected", async function () {
      const FactoryContract = await ethers.getContractFactory("SynqFactoryV1");
      const unconfiguredFactory = await FactoryContract.deploy(
        owner.address,
        await usdc.getAddress(),
        await dealImplementation.getAddress(),
        await primaryResolver.getAddress(),
        await emergencyResolver.getAddress()
      );
      await unconfiguredFactory.connect(owner).setDefaultProtectionModule(await protectionModule.getAddress());

      const now = await getLatestBlockTimestamp();
      const milestones = [
        {
          amount: M1_AMOUNT,
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH,
        },
      ];
      await expectRevert(
        unconfiguredFactory.connect(client).createProtectedDeal(client.address, freelancer.address, milestones),
        "Protection policy not configured"
      );
    });

    it("19. invalid module rejected", async function () {
      const FactoryContract = await ethers.getContractFactory("SynqFactoryV1");
      const unconfiguredFactory = await FactoryContract.deploy(
        owner.address,
        await usdc.getAddress(),
        await dealImplementation.getAddress(),
        await primaryResolver.getAddress(),
        await emergencyResolver.getAddress()
      );
      await unconfiguredFactory.connect(owner).setDefaultProtectionPolicyId(defaultPolicyId);

      const now = await getLatestBlockTimestamp();
      const milestones = [
        {
          amount: M1_AMOUNT,
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH,
        },
      ];
      await expectRevert(
        unconfiguredFactory.connect(client).createProtectedDeal(client.address, freelancer.address, milestones),
        "Protection module not configured"
      );
    });

    it("20. Standard Deal creation works even if Protection defaults unavailable", async function () {
      const FactoryContract = await ethers.getContractFactory("SynqFactoryV1");
      const unconfiguredFactory = await FactoryContract.deploy(
        owner.address,
        await usdc.getAddress(),
        await dealImplementation.getAddress(),
        await primaryResolver.getAddress(),
        await emergencyResolver.getAddress()
      );

      const now = await getLatestBlockTimestamp();
      const milestones = [
        {
          amount: M1_AMOUNT,
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH,
        },
      ];
      const tx = await unconfiguredFactory.connect(client).createDeal(client.address, freelancer.address, milestones);
      const receipt = await tx.wait();
      assert(receipt.status === 1);
    });

    it("21. only participant can create Protected Deal", async function () {
      const now = await getLatestBlockTimestamp();
      const milestones = [
        {
          amount: M1_AMOUNT,
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH,
        },
      ];
      // thirdParty trying to create a deal between client and freelancer
      await expectRevert(
        factory.connect(thirdParty).createProtectedDeal(client.address, freelancer.address, milestones),
        "Only participant can create deal"
      );
      // Zero client when caller is freelancer
      await expectRevert(
        factory.connect(freelancer).createProtectedDeal(ethers.ZeroAddress, freelancer.address, milestones),
        "Zero client address"
      );
      // Zero freelancer when caller is client
      await expectRevert(
        factory.connect(client).createProtectedDeal(client.address, ethers.ZeroAddress, milestones),
        "Zero freelancer address"
      );
      // Client equals freelancer
      await expectRevert(
        factory.connect(client).createProtectedDeal(client.address, client.address, milestones),
        "Client equals freelancer"
      );
    });
  });

  // ==================================================
  // 31. ASSESSMENT REQUEST TESTS (22 - 30)
  // ==================================================
  describe("31. Assessment Request Tests", function () {
    it("22. Protected ordinary rejection -> ASSESSMENT_PENDING", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);

      await deal.connect(client).rejectWorkProtected(0, ethers.keccak256(ethers.toUtf8Bytes("Ordinary rejection")));
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 10); // AssessmentPending
    });

    it("23. rejection records trigger REJECTION", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);

      const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("Reasons"));
      await deal.connect(client).rejectWorkProtected(0, reasonHash);

      const req = await deal.getAssessmentRequest(0);
      assert.equal(req.trigger, 1); // AssessmentTrigger.Rejection
      assert.equal(req.reasonHash, reasonHash);
      assert(req.requestedAt > 0);
    });

    it("24. Protected review timeout trigger -> ASSESSMENT_PENDING", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);

      // Advance past review window (3 days)
      await ethers.provider.send("evm_increaseTime", [3 * ONE_DAY + 10]);
      await ethers.provider.send("evm_mine");

      await deal.connect(thirdParty).triggerReviewTimeoutProtected(0);
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 10); // AssessmentPending
    });

    it("25. inactivity records trigger INACTIVITY", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);

      await ethers.provider.send("evm_increaseTime", [3 * ONE_DAY + 10]);
      await ethers.provider.send("evm_mine");

      await deal.connect(thirdParty).triggerReviewTimeoutProtected(0);
      const req = await deal.getAssessmentRequest(0);
      assert.equal(req.trigger, 2); // AssessmentTrigger.Inactivity
      assert.equal(req.reasonHash, ethers.ZeroHash);
    });

    it("26. Standard review timeout still pays freelancer", async function () {
      const deal = await createAndFundStandardDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);

      await ethers.provider.send("evm_increaseTime", [3 * ONE_DAY + 10]);
      await ethers.provider.send("evm_mine");

      const freelancerBalBefore = await usdc.balanceOf(freelancer.address);
      await deal.connect(thirdParty).settleReviewTimeout(0);
      const freelancerBalAfter = await usdc.balanceOf(freelancer.address);

      assert.equal(freelancerBalAfter - freelancerBalBefore, M1_AMOUNT);
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 7); // SettledPaid
    });

    it("27. Standard Deal cannot enter assessment path", async function () {
      const deal = await createAndFundStandardDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);

      await expectRevert(
        deal.connect(client).rejectWorkProtected(0, ethers.ZeroHash),
        "Only protected deals"
      );
      await expectRevert(
        deal.connect(thirdParty).triggerReviewTimeoutProtected(0),
        "Only protected deals"
      );
    });

    it("28. rejection does not immediately refund client", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);

      const clientBalBefore = await usdc.balanceOf(client.address);
      await deal.connect(client).rejectWorkProtected(0, ethers.ZeroHash);
      const clientBalAfter = await usdc.balanceOf(client.address);

      assert.equal(clientBalAfter, clientBalBefore);
      assert.equal(await usdc.balanceOf(await deal.getAddress()), M1_AMOUNT);
    });

    it("29. serious dispute bypasses AI", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);

      await deal.connect(client).openSeriousDispute(0, ethers.keccak256(ethers.toUtf8Bytes("Serious fraud")));
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 4); // Disputed
    });

    it("30. serious dispute during assessment pending freezes Protection", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);
      await deal.connect(client).rejectWorkProtected(0, ethers.ZeroHash);

      // Open serious dispute during AssessmentPending
      await deal.connect(freelancer).openSeriousDispute(0, ethers.keccak256(ethers.toUtf8Bytes("Dispute")));
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 4); // Disputed

      // Module assessment submission now rejected because status is no longer AssessmentPending
      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 5000,
        reportHash: REPORT_HASH,
        assessmentNonce: 1,
        validUntil: now + 3600,
        trigger: 1,
      };
      const sig = await signAttestation(verifier, att);
      await expectRevert(
        protectionModule.connect(thirdParty).submitAssessment(att, sig),
        "Milestone not awaiting assessment"
      );
    });
  });

  // ==================================================
  // 32. ASSESSMENT ATTESTATION TESTS (31 - 46)
  // ==================================================
  describe("32. Assessment Attestation Tests", function () {
    let deal;

    beforeEach(async function () {
      deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);
      await deal.connect(client).rejectWorkProtected(0, ethers.keccak256(ethers.toUtf8Bytes("Rejection")));
    });

    it("31. valid verifier assessment accepted", async function () {
      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 6000,
        reportHash: REPORT_HASH,
        assessmentNonce: 1,
        validUntil: now + 3600,
        trigger: 1,
      };

      const sig = await signAttestation(verifier, att);
      await protectionModule.connect(thirdParty).submitAssessment(att, sig);

      const m = await deal.getMilestone(0);
      assert.equal(m.status, 11); // AssessmentProposed
    });

    it("32. completionBps 0 accepted", async function () {
      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 0,
        reportHash: REPORT_HASH,
        assessmentNonce: 2,
        validUntil: now + 3600,
        trigger: 1,
      };
      const sig = await signAttestation(verifier, att);
      await protectionModule.connect(thirdParty).submitAssessment(att, sig);
      const prop = await deal.getAssessmentProposal(0);
      assert.equal(prop.completionBps, 0);
    });

    it("33. completionBps 10000 accepted", async function () {
      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 10000,
        reportHash: REPORT_HASH,
        assessmentNonce: 3,
        validUntil: now + 3600,
        trigger: 1,
      };
      const sig = await signAttestation(verifier, att);
      await protectionModule.connect(thirdParty).submitAssessment(att, sig);
      const prop = await deal.getAssessmentProposal(0);
      assert.equal(prop.completionBps, 10000);
    });

    it("34. completionBps >10000 rejected", async function () {
      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 10001,
        reportHash: REPORT_HASH,
        assessmentNonce: 4,
        validUntil: now + 3600,
        trigger: 1,
      };
      const sig = await signAttestation(verifier, att);
      await expectRevert(
        protectionModule.connect(thirdParty).submitAssessment(att, sig),
        "completionBps exceeds 10000"
      );
    });

    it("35. wrong verifier rejected", async function () {
      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 5000,
        reportHash: REPORT_HASH,
        assessmentNonce: 5,
        validUntil: now + 3600,
        trigger: 1,
      };
      // Signed by thirdParty
      const sig = await signAttestation(thirdParty, att);
      await expectRevert(
        protectionModule.connect(thirdParty).submitAssessment(att, sig),
        "Signer not authorized verifier"
      );
    });

    it("36. expired attestation rejected", async function () {
      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 5000,
        reportHash: REPORT_HASH,
        assessmentNonce: 6,
        validUntil: now - 10, // expired
        trigger: 1,
      };
      const sig = await signAttestation(verifier, att);
      await expectRevert(
        protectionModule.connect(thirdParty).submitAssessment(att, sig),
        "Attestation expired"
      );
    });

    it("37. nonce replay rejected", async function () {
      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 5000,
        reportHash: REPORT_HASH,
        assessmentNonce: 7,
        validUntil: now + 3600,
        trigger: 1,
      };
      const sig = await signAttestation(verifier, att);
      await protectionModule.connect(thirdParty).submitAssessment(att, sig);

      // Replay attempt with same nonce
      await expectRevert(
        protectionModule.connect(thirdParty).submitAssessment(att, sig),
        "Assessment nonce used"
      );
    });

    it("38. cross-Deal replay rejected", async function () {
      // Create second deal
      const deal2 = await createAndFundProtectedDeal();
      await deal2.connect(freelancer).startMilestone(0);
      await deal2.connect(freelancer).submitWork(0, EVIDENCE_HASH);
      await deal2.connect(client).rejectWorkProtected(0, ethers.ZeroHash);

      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 5000,
        reportHash: REPORT_HASH,
        assessmentNonce: 8,
        validUntil: now + 3600,
        trigger: 1,
      };
      const sig = await signAttestation(verifier, att);

      // Try to submit with deal2 address but signature for deal1
      const attTampered = { ...att, deal: await deal2.getAddress() };
      await expectRevert(
        protectionModule.connect(thirdParty).submitAssessment(attTampered, sig),
        "Signer not authorized verifier"
      );
    });

    it("39. cross-milestone replay rejected", async function () {
      const now = await getLatestBlockTimestamp();
      const milestones = [
        {
          amount: 50_000_000n,
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH,
        },
        {
          amount: 50_000_000n,
          workDeadline: now + 10 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH,
        },
      ];
      const tx = await factory.connect(client).createProtectedDeal(client.address, freelancer.address, milestones);
      const receipt = await tx.wait();
      const event = receipt.logs
        .map((log) => {
          try {
            return factory.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "DealCreated");
      const d = await ethers.getContractAt("SynqDealV1", event.args.dealAddress);

      await usdc.mint(client.address, 100_000_000n);
      await usdc.connect(client).approve(await d.getAddress(), 100_000_000n);
      await d.connect(client).fundDeal();

      await d.connect(freelancer).startMilestone(0);
      await d.connect(freelancer).submitWork(0, EVIDENCE_HASH);
      await d.connect(client).rejectWorkProtected(0, ethers.ZeroHash);

      await d.connect(freelancer).startMilestone(1);
      await d.connect(freelancer).submitWork(1, EVIDENCE_HASH);
      await d.connect(client).rejectWorkProtected(1, ethers.ZeroHash);

      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await d.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 5000,
        reportHash: REPORT_HASH,
        assessmentNonce: 9,
        validUntil: now + 3600,
        trigger: 1,
      };
      const sig = await signAttestation(verifier, att);

      const attTampered = { ...att, milestoneId: 1 };
      await expectRevert(
        protectionModule.connect(thirdParty).submitAssessment(attTampered, sig),
        "Signer not authorized verifier"
      );
    });

    it("40. cross-chain replay rejected", async function () {
      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 1, // Mainnet chainId instead of 31337
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 5000,
        reportHash: REPORT_HASH,
        assessmentNonce: 10,
        validUntil: now + 3600,
        trigger: 1,
      };
      const sig = await signAttestation(verifier, att);
      await expectRevert(
        protectionModule.connect(thirdParty).submitAssessment(att, sig),
        "Mismatched chainId"
      );
    });

    it("41. wrong policy rejected", async function () {
      const now = await getLatestBlockTimestamp();
      const wrongPolicy = ethers.keccak256(ethers.toUtf8Bytes("WRONG_POLICY"));
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: wrongPolicy,
        submissionVersion: 1,
        completionBps: 5000,
        reportHash: REPORT_HASH,
        assessmentNonce: 11,
        validUntil: now + 3600,
        trigger: 1,
      };
      const sig = await signAttestation(verifier, att);
      await expectRevert(
        protectionModule.connect(thirdParty).submitAssessment(att, sig),
        "Mismatched policyId"
      );
    });

    it("42. stale evidence hash rejected", async function () {
      const now = await getLatestBlockTimestamp();
      const staleEvidence = ethers.keccak256(ethers.toUtf8Bytes("stale"));
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: staleEvidence,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 5000,
        reportHash: REPORT_HASH,
        assessmentNonce: 12,
        validUntil: now + 3600,
        trigger: 1,
      };
      const sig = await signAttestation(verifier, att);
      await expectRevert(
        protectionModule.connect(thirdParty).submitAssessment(att, sig),
        "Mismatched evidenceRootHash"
      );
    });

    it("43. stale specHash rejected", async function () {
      const now = await getLatestBlockTimestamp();
      const staleSpec = ethers.keccak256(ethers.toUtf8Bytes("stale spec"));
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: staleSpec,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 5000,
        reportHash: REPORT_HASH,
        assessmentNonce: 13,
        validUntil: now + 3600,
        trigger: 1,
      };
      const sig = await signAttestation(verifier, att);
      await expectRevert(
        protectionModule.connect(thirdParty).submitAssessment(att, sig),
        "Mismatched specHash"
      );
    });

    it("44. stale submissionVersion rejected", async function () {
      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 2, // Deal has version 1
        completionBps: 5000,
        reportHash: REPORT_HASH,
        assessmentNonce: 14,
        validUntil: now + 3600,
        trigger: 1,
      };
      const sig = await signAttestation(verifier, att);
      await expectRevert(
        protectionModule.connect(thirdParty).submitAssessment(att, sig),
        "Mismatched submissionVersion"
      );
    });

    it("45. wrong trigger rejected", async function () {
      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 5000,
        reportHash: REPORT_HASH,
        assessmentNonce: 15,
        validUntil: now + 3600,
        trigger: 2, // Inactivity instead of Rejection
      };
      const sig = await signAttestation(verifier, att);
      await expectRevert(
        protectionModule.connect(thirdParty).submitAssessment(att, sig),
        "Mismatched trigger"
      );
    });

    it("46. arbitrary fake Deal rejected", async function () {
      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: owner.address,
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 5000,
        reportHash: REPORT_HASH,
        assessmentNonce: 16,
        validUntil: now + 3600,
        trigger: 1,
      };
      const sig = await signAttestation(verifier, att);
      await expectRevert(
        protectionModule.connect(thirdParty).submitAssessment(att, sig),
        "Deal not registered with Factory"
      );
    });
  });

  // ==================================================
  // 33. ASSESSMENT SETTLEMENT TESTS (47 - 67)
  // ==================================================
  describe("33. Assessment Settlement Tests", function () {
    async function setupProposedAssessment(bps) {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);
      await deal.connect(client).rejectWorkProtected(0, ethers.keccak256(ethers.toUtf8Bytes("Ordinary rejection")));

      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: bps !== undefined ? bps : 5000,
        reportHash: REPORT_HASH,
        assessmentNonce: Math.floor(Math.random() * 1000000) + 1,
        validUntil: now + 3600,
        trigger: 1,
      };

      const sig = await signAttestation(verifier, att);
      await protectionModule.connect(thirdParty).submitAssessment(att, sig);
      return deal;
    }

    it("47. valid assessment -> ASSESSMENT_PROPOSED", async function () {
      const deal = await setupProposedAssessment(5000);
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 11); // AssessmentProposed
    });

    it("48. proposal does not immediately transfer", async function () {
      const clientBefore = await usdc.balanceOf(client.address);
      const freelancerBefore = await usdc.balanceOf(freelancer.address);
      const deal = await setupProposedAssessment(5000);

      assert.equal(await usdc.balanceOf(client.address), clientBefore);
      assert.equal(await usdc.balanceOf(freelancer.address), freelancerBefore);
      assert.equal(await usdc.balanceOf(await deal.getAddress()), M1_AMOUNT);
    });

    it("49. challenge deadline = 48h", async function () {
      const deal = await setupProposedAssessment(5000);
      const prop = await deal.getAssessmentProposal(0);
      assert.equal(Number(prop.challengeDeadline - prop.proposedAt), 48 * ONE_HOUR);
    });

    it("50. client can challenge", async function () {
      const deal = await setupProposedAssessment(5000);
      await deal.connect(client).challengeAssessment(0);
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 4); // Disputed
    });

    it("51. freelancer can challenge", async function () {
      const deal = await setupProposedAssessment(5000);
      await deal.connect(freelancer).challengeAssessment(0);
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 4); // Disputed
    });

    it("52. unrelated wallet cannot challenge", async function () {
      const deal = await setupProposedAssessment(5000);
      await expectRevert(
        deal.connect(thirdParty).challengeAssessment(0),
        "Only participant"
      );
    });

    it("53. challenge -> DISPUTED", async function () {
      const deal = await setupProposedAssessment(5000);
      await deal.connect(client).challengeAssessment(0);
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 4); // Disputed
    });

    it("54. disputeOpenedAt recorded", async function () {
      const deal = await setupProposedAssessment(5000);
      await deal.connect(client).challengeAssessment(0);
      const openedAt = await deal.milestoneDisputeOpenedAt(0);
      assert(openedAt > 0n);
    });

    it("55. assessment execution before 48h rejected", async function () {
      const deal = await setupProposedAssessment(5000);
      await expectRevert(
        deal.connect(thirdParty).executeAssessmentSettlement(0),
        "Challenge window active"
      );
    });

    it("56. assessment execution after 48h permissionless", async function () {
      const deal = await setupProposedAssessment(5000);
      await ethers.provider.send("evm_increaseTime", [48 * ONE_HOUR + 1]);
      await ethers.provider.send("evm_mine");

      await deal.connect(thirdParty).executeAssessmentSettlement(0);
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 9); // SettledSplit
    });

    it("57. 0 BPS -> full client refund", async function () {
      const deal = await setupProposedAssessment(0);
      await ethers.provider.send("evm_increaseTime", [48 * ONE_HOUR + 1]);
      await ethers.provider.send("evm_mine");

      const clientBefore = await usdc.balanceOf(client.address);
      const freelancerBefore = await usdc.balanceOf(freelancer.address);

      await deal.connect(thirdParty).executeAssessmentSettlement(0);

      const clientAfter = await usdc.balanceOf(client.address);
      const freelancerAfter = await usdc.balanceOf(freelancer.address);

      assert.equal(clientAfter - clientBefore, M1_AMOUNT);
      assert.equal(freelancerAfter, freelancerBefore);
    });

    it("58. 1900 BPS -> exact 19/81 split", async function () {
      const deal = await setupProposedAssessment(1900);
      await ethers.provider.send("evm_increaseTime", [48 * ONE_HOUR + 1]);
      await ethers.provider.send("evm_mine");

      const clientBefore = await usdc.balanceOf(client.address);
      const freelancerBefore = await usdc.balanceOf(freelancer.address);

      await deal.connect(thirdParty).executeAssessmentSettlement(0);

      const expectedFreelancer = (M1_AMOUNT * 1900n) / 10000n; // 19 USDC
      const expectedClient = M1_AMOUNT - expectedFreelancer; // 81 USDC

      assert.equal((await usdc.balanceOf(freelancer.address)) - freelancerBefore, expectedFreelancer);
      assert.equal((await usdc.balanceOf(client.address)) - clientBefore, expectedClient);
    });

    it("59. 5000 BPS -> exact 50/50", async function () {
      const deal = await setupProposedAssessment(5000);
      await ethers.provider.send("evm_increaseTime", [48 * ONE_HOUR + 1]);
      await ethers.provider.send("evm_mine");

      const clientBefore = await usdc.balanceOf(client.address);
      const freelancerBefore = await usdc.balanceOf(freelancer.address);

      await deal.connect(thirdParty).executeAssessmentSettlement(0);

      const expectedFreelancer = (M1_AMOUNT * 5000n) / 10000n;
      const expectedClient = M1_AMOUNT - expectedFreelancer;

      assert.equal((await usdc.balanceOf(freelancer.address)) - freelancerBefore, expectedFreelancer);
      assert.equal((await usdc.balanceOf(client.address)) - clientBefore, expectedClient);
    });

    it("60. 8325 BPS -> exact linear split", async function () {
      const deal = await setupProposedAssessment(8325);
      await ethers.provider.send("evm_increaseTime", [48 * ONE_HOUR + 1]);
      await ethers.provider.send("evm_mine");

      const clientBefore = await usdc.balanceOf(client.address);
      const freelancerBefore = await usdc.balanceOf(freelancer.address);

      await deal.connect(thirdParty).executeAssessmentSettlement(0);

      const expectedFreelancer = (M1_AMOUNT * 8325n) / 10000n; // 83.25 USDC
      const expectedClient = M1_AMOUNT - expectedFreelancer; // 16.75 USDC

      assert.equal((await usdc.balanceOf(freelancer.address)) - freelancerBefore, expectedFreelancer);
      assert.equal((await usdc.balanceOf(client.address)) - clientBefore, expectedClient);
    });

    it("61. 10000 BPS -> full freelancer payout", async function () {
      const deal = await setupProposedAssessment(10000);
      await ethers.provider.send("evm_increaseTime", [48 * ONE_HOUR + 1]);
      await ethers.provider.send("evm_mine");

      const clientBefore = await usdc.balanceOf(client.address);
      const freelancerBefore = await usdc.balanceOf(freelancer.address);

      await deal.connect(thirdParty).executeAssessmentSettlement(0);

      assert.equal((await usdc.balanceOf(freelancer.address)) - freelancerBefore, M1_AMOUNT);
      assert.equal((await usdc.balanceOf(client.address)) - clientBefore, 0n);
    });

    it("62. rounding remainder goes to client", async function () {
      // 3333 BPS on 100 USDC (100,000,000 units)
      // freelancer: floor(100,000,000 * 3333 / 10000) = 33,330,000
      // client gets exactly the remainder: 100,000,000 - 33,330,000 = 66,670,000
      const deal = await setupProposedAssessment(3333);
      await ethers.provider.send("evm_increaseTime", [48 * ONE_HOUR + 1]);
      await ethers.provider.send("evm_mine");

      const clientBefore = await usdc.balanceOf(client.address);
      const freelancerBefore = await usdc.balanceOf(freelancer.address);

      await deal.connect(thirdParty).executeAssessmentSettlement(0);

      const fGain = (await usdc.balanceOf(freelancer.address)) - freelancerBefore;
      const cGain = (await usdc.balanceOf(client.address)) - clientBefore;

      assert.equal(fGain + cGain, M1_AMOUNT);
      assert.equal(fGain, 33_330_000n);
      assert.equal(cGain, 66_670_000n);
    });

    it("63. cannot execute assessment twice", async function () {
      const deal = await setupProposedAssessment(5000);
      await ethers.provider.send("evm_increaseTime", [48 * ONE_HOUR + 1]);
      await ethers.provider.send("evm_mine");

      await deal.connect(thirdParty).executeAssessmentSettlement(0);
      try {
        await deal.connect(thirdParty).executeAssessmentSettlement(0);
        assert.fail("Expected transaction to revert");
      } catch (err) {
        assert(
          err.message.includes("No proposed assessment to execute") ||
          err.message.includes("Invalid deal state"),
          `Unexpected error: ${err.message}`
        );
      }
    });

    it("64. cannot execute after challenge", async function () {
      const deal = await setupProposedAssessment(5000);
      await deal.connect(client).challengeAssessment(0);

      await ethers.provider.send("evm_increaseTime", [48 * ONE_HOUR + 1]);
      await ethers.provider.send("evm_mine");

      await expectRevert(
        deal.connect(thirdParty).executeAssessmentSettlement(0),
        "No proposed assessment to execute"
      );
    });

    it("65. mutual settlement during ASSESSMENT_PENDING", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);
      await deal.connect(client).rejectWorkProtected(0, ethers.ZeroHash);

      const now = await getLatestBlockTimestamp();
      const proposal = {
        dealAddress: await deal.getAddress(),
        chainId: 31337,
        milestoneId: 0,
        proposer: client.address,
        freelancerAmount: 70_000_000n,
        clientAmount: 30_000_000n,
        proposalNonce: 1,
        validUntil: now + 3600,
      };

      const domain = {
        name: "SynqDealV1",
        version: "1",
        chainId: 31337,
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
      const sig = await client.signTypedData(domain, types, proposal);

      await deal.connect(freelancer).executeMutualSettlement(proposal, sig);
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 9); // SettledSplit
    });

    it("66. mutual settlement during ASSESSMENT_PROPOSED", async function () {
      const deal = await setupProposedAssessment(5000);

      const now = await getLatestBlockTimestamp();
      const proposal = {
        dealAddress: await deal.getAddress(),
        chainId: 31337,
        milestoneId: 0,
        proposer: client.address,
        freelancerAmount: 80_000_000n,
        clientAmount: 20_000_000n,
        proposalNonce: 2,
        validUntil: now + 3600,
      };

      const domain = {
        name: "SynqDealV1",
        version: "1",
        chainId: 31337,
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
      const sig = await client.signTypedData(domain, types, proposal);

      await deal.connect(freelancer).executeMutualSettlement(proposal, sig);
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 9); // SettledSplit
    });

    it("67. outstanding assessment invalid after mutual settlement", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);
      await deal.connect(client).rejectWorkProtected(0, ethers.ZeroHash);

      // Execute mutual settlement
      const now = await getLatestBlockTimestamp();
      const proposal = {
        dealAddress: await deal.getAddress(),
        chainId: 31337,
        milestoneId: 0,
        proposer: client.address,
        freelancerAmount: 50_000_000n,
        clientAmount: 50_000_000n,
        proposalNonce: 3,
        validUntil: now + 3600,
      };

      const domain = {
        name: "SynqDealV1",
        version: "1",
        chainId: 31337,
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
      const sig = await client.signTypedData(domain, types, proposal);
      await deal.connect(freelancer).executeMutualSettlement(proposal, sig);

      // Verifier assessment attestation is now rejected
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 5000,
        reportHash: REPORT_HASH,
        assessmentNonce: 999,
        validUntil: now + 3600,
        trigger: 1,
      };
      const attSig = await signAttestation(verifier, att);
      try {
        await protectionModule.connect(thirdParty).submitAssessment(att, attSig);
        assert.fail("Expected transaction to revert");
      } catch (err) {
        assert(
          err.message.includes("Milestone not awaiting assessment") ||
          err.message.includes("Invalid deal state"),
          `Unexpected error: ${err.message}`
        );
      }
    });

    it("both parties accept assessment -> immediate settlement before 48h", async function () {
      const deal = await setupProposedAssessment(5000);
      await deal.connect(client).acceptAssessment(0);
      await deal.connect(freelancer).acceptAssessment(0);

      // Now immediately executable before 48h
      await deal.connect(thirdParty).executeAssessmentSettlement(0);
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 9); // SettledSplit
    });
  });

  // ==================================================
  // 34. AI FAILURE TESTS (68 - 74)
  // ==================================================
  describe("34. AI Failure Tests", function () {
    it("68. assessment cannot register at/after 72h timeout", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);
      await deal.connect(client).rejectWorkProtected(0, ethers.ZeroHash);

      // Advance 72 hours
      await ethers.provider.send("evm_increaseTime", [72 * ONE_HOUR]);
      await ethers.provider.send("evm_mine");

      const now = await getLatestBlockTimestamp();
      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: await deal.getAddress(),
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH,
        specHash: SPEC_HASH,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 5000,
        reportHash: REPORT_HASH,
        assessmentNonce: 1,
        validUntil: now + 3600,
        trigger: 1,
      };
      const sig = await signAttestation(verifier, att);
      await expectRevert(
        protectionModule.connect(thirdParty).submitAssessment(att, sig),
        "Assessment timeout expired"
      );
    });

    it("69. inactivity-trigger timeout -> 100% freelancer", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);

      // Review window expires (3 days)
      await ethers.provider.send("evm_increaseTime", [3 * ONE_DAY + 10]);
      await ethers.provider.send("evm_mine");

      // Trigger assessment for inactivity
      await deal.connect(thirdParty).triggerReviewTimeoutProtected(0);

      // Advance 72 hours without AI response
      await ethers.provider.send("evm_increaseTime", [72 * ONE_HOUR + 1]);
      await ethers.provider.send("evm_mine");

      const freelancerBefore = await usdc.balanceOf(freelancer.address);
      await deal.connect(thirdParty).timeoutAssessment(0);
      const freelancerAfter = await usdc.balanceOf(freelancer.address);

      assert.equal(freelancerAfter - freelancerBefore, M1_AMOUNT);
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 7); // SettledPaid
    });

    it("70. rejection-trigger timeout -> DISPUTED", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);
      await deal.connect(client).rejectWorkProtected(0, ethers.ZeroHash);

      // Advance 72 hours
      await ethers.provider.send("evm_increaseTime", [72 * ONE_HOUR + 1]);
      await ethers.provider.send("evm_mine");

      const clientBefore = await usdc.balanceOf(client.address);
      const freelancerBefore = await usdc.balanceOf(freelancer.address);

      await deal.connect(thirdParty).timeoutAssessment(0);

      // Zero payout
      assert.equal(await usdc.balanceOf(client.address), clientBefore);
      assert.equal(await usdc.balanceOf(freelancer.address), freelancerBefore);

      const m = await deal.getMilestone(0);
      assert.equal(m.status, 4); // Disputed
    });

    it("71. timeout fallback before 72h rejected", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);
      await deal.connect(client).rejectWorkProtected(0, ethers.ZeroHash);

      // Advance only 71 hours
      await ethers.provider.send("evm_increaseTime", [71 * ONE_HOUR]);
      await ethers.provider.send("evm_mine");

      await expectRevert(
        deal.connect(thirdParty).timeoutAssessment(0),
        "Assessment timeout not reached"
      );
    });

    it("72. timeout fallback permissionless", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);
      await deal.connect(client).rejectWorkProtected(0, ethers.ZeroHash);

      await ethers.provider.send("evm_increaseTime", [72 * ONE_HOUR + 1]);
      await ethers.provider.send("evm_mine");

      // Called by completely unrelated wallet
      await deal.connect(thirdParty).timeoutAssessment(0);
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 4); // Disputed
    });

    it("73. rejection timeout starts resolver dispute SLA", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);
      await deal.connect(client).rejectWorkProtected(0, ethers.ZeroHash);

      await ethers.provider.send("evm_increaseTime", [72 * ONE_HOUR + 1]);
      await ethers.provider.send("evm_mine");

      await deal.connect(thirdParty).timeoutAssessment(0);
      const openedAt = await deal.milestoneDisputeOpenedAt(0);
      assert(openedAt > 0n);
    });

    it("74. inactivity timeout settles exactly once", async function () {
      const deal = await createAndFundProtectedDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH);

      await ethers.provider.send("evm_increaseTime", [3 * ONE_DAY + 10]);
      await ethers.provider.send("evm_mine");
      await deal.connect(thirdParty).triggerReviewTimeoutProtected(0);

      await ethers.provider.send("evm_increaseTime", [72 * ONE_HOUR + 1]);
      await ethers.provider.send("evm_mine");

      await deal.connect(thirdParty).timeoutAssessment(0);
      try {
        await deal.connect(thirdParty).timeoutAssessment(0);
        assert.fail("Expected transaction to revert");
      } catch (err) {
        assert(
          err.message.includes("Milestone not awaiting assessment") ||
          err.message.includes("Invalid deal state"),
          `Unexpected error: ${err.message}`
        );
      }
    });
  });
});
