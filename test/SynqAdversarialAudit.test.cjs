const assert = require("node:assert");
const { ethers } = require("hardhat");

describe("SynqDealV1 Phase 1E Consolidated Adversarial Audit Test Suite", function () {
  let usdc, factory, dealImplementation, protectionModule;
  let owner, client, freelancer, verifier, alternateVerifier, thirdParty;
  let primaryCommittee, emergencyResolver;
  let signer1, signer2, signer3;
  let defaultPolicyId;

  const ONE_DAY = 86400;
  const ONE_HOUR = 3600;
  const M1_AMOUNT = 100_000_000n; // 100 USDC
  const M2_AMOUNT = 200_000_000n; // 200 USDC
  const M3_AMOUNT = 300_000_000n; // 300 USDC

  const SPEC_HASH_1 = ethers.keccak256(ethers.toUtf8Bytes("Spec 1"));
  const SPEC_HASH_2 = ethers.keccak256(ethers.toUtf8Bytes("Spec 2"));
  const SPEC_HASH_3 = ethers.keccak256(ethers.toUtf8Bytes("Spec 3"));

  const EVIDENCE_HASH_1 = ethers.keccak256(ethers.toUtf8Bytes("Evidence 1"));
  const EVIDENCE_HASH_2 = ethers.keccak256(ethers.toUtf8Bytes("Evidence 2"));
  const REPORT_HASH = ethers.keccak256(ethers.toUtf8Bytes("Report 1"));

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

  async function deployClone(implAddress) {
    const cleanAddr = implAddress.toLowerCase().replace("0x", "");
    const byteCode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${cleanAddr}5af43d82803e903d91602b57fd5bf3`;
    const tx = await client.sendTransaction({ data: byteCode });
    const receipt = await tx.wait();
    return await ethers.getContractAt("SynqDealV1", receipt.contractAddress);
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

  async function signResolutionProposal(signers, auth, committeeAddress) {
    const domain = {
      name: "SynqResolutionCommittee",
      version: "1",
      chainId: 31337,
      verifyingContract: committeeAddress || (await primaryCommittee.getAddress()),
    };
    const types = {
      ResolutionProposalAuth: [
        { name: "committee", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "deal", type: "address" },
        { name: "milestoneId", type: "uint256" },
        { name: "freelancerAmount", type: "uint256" },
        { name: "clientAmount", type: "uint256" },
        { name: "justificationHash", type: "bytes32" },
        { name: "resolutionNonce", type: "uint64" },
        { name: "validUntil", type: "uint64" },
        { name: "evidenceRootHash", type: "bytes32" },
        { name: "specHash", type: "bytes32" },
        { name: "submissionVersion", type: "uint8" },
      ],
    };
    const sig1 = await signers[0].signTypedData(domain, types, auth);
    const sig2 = await signers[1].signTypedData(domain, types, auth);
    return [sig1, sig2];
  }

  async function signFinalResolution(signers, auth, committeeAddress) {
    const domain = {
      name: "SynqResolutionCommittee",
      version: "1",
      chainId: 31337,
      verifyingContract: committeeAddress || (await primaryCommittee.getAddress()),
    };
    const types = {
      FinalResolutionAuth: [
        { name: "committee", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "deal", type: "address" },
        { name: "milestoneId", type: "uint256" },
        { name: "freelancerAmount", type: "uint256" },
        { name: "clientAmount", type: "uint256" },
        { name: "justificationHash", type: "bytes32" },
        { name: "resolutionNonce", type: "uint64" },
        { name: "validUntil", type: "uint64" },
        { name: "evidenceRootHash", type: "bytes32" },
        { name: "specHash", type: "bytes32" },
        { name: "submissionVersion", type: "uint8" },
      ],
    };
    const sig1 = await signers[0].signTypedData(domain, types, auth);
    const sig2 = await signers[1].signTypedData(domain, types, auth);
    return [sig1, sig2];
  }

  beforeEach(async function () {
    [
      owner,
      client,
      freelancer,
      verifier,
      alternateVerifier,
      thirdParty,
      signer1,
      signer2,
      signer3,
    ] = await ethers.getSigners();

    defaultPolicyId = ethers.keccak256(ethers.toUtf8Bytes("SYNQ_POLICY_AUDIT_V1"));

    // Deploy Mock USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6, ethers.parseUnits("1000000", 6));
    await usdc.waitForDeployment();

    // Deploy Master Implementation
    const DealFactory = await ethers.getContractFactory("SynqDealV1");
    dealImplementation = await DealFactory.deploy();
    await dealImplementation.waitForDeployment();

    // Deploy Mock Emergency Resolver
    const MockResolver = await ethers.getContractFactory("MockResolver");
    emergencyResolver = await MockResolver.deploy();
    await emergencyResolver.waitForDeployment();

    // Deploy Mock Factory initially so committee can bind it
    const FactoryContract = await ethers.getContractFactory("SynqFactoryV1");
    factory = await FactoryContract.deploy(
      owner.address,
      await usdc.getAddress(),
      await dealImplementation.getAddress(),
      await emergencyResolver.getAddress(), // temporary primary
      await emergencyResolver.getAddress()
    );
    await factory.waitForDeployment();

    // Deploy Resolution Committee (Primary Resolver)
    const CommitteeFactory = await ethers.getContractFactory("SynqResolutionCommittee");
    primaryCommittee = await CommitteeFactory.deploy(
      await factory.getAddress(),
      signer1.address,
      signer2.address,
      signer3.address
    );
    await primaryCommittee.waitForDeployment();

    // Update Factory to point to primaryCommittee
    await factory.connect(owner).setDefaultPrimaryResolver(await primaryCommittee.getAddress());

    // Deploy SynqProtectionModule
    const ModuleFactory = await ethers.getContractFactory("SynqProtectionModule");
    protectionModule = await ModuleFactory.deploy(
      owner.address,
      await factory.getAddress(),
      verifier.address
    );
    await protectionModule.waitForDeployment();

    // Configure Factory defaults for Protected Deals
    await factory.connect(owner).setDefaultProtectionModule(await protectionModule.getAddress());
    await factory.connect(owner).setDefaultProtectionPolicyId(defaultPolicyId);
  });

  // ==================================================
  // 1. PROTECTED DEAL INITIALIZATION AUDIT
  // ==================================================
  describe("1. Protected vs Standard Deal Initialization Audit", function () {
    it("rejects direct clone initialization with Standard mode + nonzero protection module", async function () {
      const clone = await deployClone(await dealImplementation.getAddress());
      const now = await getLatestBlockTimestamp();
      const milestones = [
        {
          amount: M1_AMOUNT,
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH_1,
        },
      ];
      const params = {
        client: client.address,
        freelancer: freelancer.address,
        usdc: await usdc.getAddress(),
        primaryResolver: await primaryCommittee.getAddress(),
        emergencyResolver: await emergencyResolver.getAddress(),
        isProtected: false,
        protectionModule: await protectionModule.getAddress(), // Malformed hybrid
        policyId: ethers.ZeroHash,
      };
      await expectRevert(
        clone.initialize(params, milestones),
        "Standard deal must have zero protection module"
      );
    });

    it("rejects direct clone initialization with Standard mode + nonzero policy ID", async function () {
      const clone = await deployClone(await dealImplementation.getAddress());
      const now = await getLatestBlockTimestamp();
      const milestones = [
        {
          amount: M1_AMOUNT,
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH_1,
        },
      ];
      const params = {
        client: client.address,
        freelancer: freelancer.address,
        usdc: await usdc.getAddress(),
        primaryResolver: await primaryCommittee.getAddress(),
        emergencyResolver: await emergencyResolver.getAddress(),
        isProtected: false,
        protectionModule: ethers.ZeroAddress,
        policyId: defaultPolicyId, // Malformed hybrid
      };
      await expectRevert(
        clone.initialize(params, milestones),
        "Standard deal must have zero policy ID"
      );
    });

    it("rejects direct clone initialization with Protected mode + zero protection module", async function () {
      const clone = await deployClone(await dealImplementation.getAddress());
      const now = await getLatestBlockTimestamp();
      const milestones = [
        {
          amount: M1_AMOUNT,
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH_1,
        },
      ];
      const params = {
        client: client.address,
        freelancer: freelancer.address,
        usdc: await usdc.getAddress(),
        primaryResolver: await primaryCommittee.getAddress(),
        emergencyResolver: await emergencyResolver.getAddress(),
        isProtected: true,
        protectionModule: ethers.ZeroAddress, // Malformed
        policyId: defaultPolicyId,
      };
      await expectRevert(
        clone.initialize(params, milestones),
        "Zero protection module"
      );
    });

    it("rejects direct clone initialization with Protected mode + zero policy ID", async function () {
      const clone = await deployClone(await dealImplementation.getAddress());
      const now = await getLatestBlockTimestamp();
      const milestones = [
        {
          amount: M1_AMOUNT,
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH_1,
        },
      ];
      const params = {
        client: client.address,
        freelancer: freelancer.address,
        usdc: await usdc.getAddress(),
        primaryResolver: await primaryCommittee.getAddress(),
        emergencyResolver: await emergencyResolver.getAddress(),
        isProtected: true,
        protectionModule: await protectionModule.getAddress(),
        policyId: ethers.ZeroHash, // Malformed
      };
      await expectRevert(
        clone.initialize(params, milestones),
        "Zero policy ID"
      );
    });

    it("DealInitialized event emits correct isProtected for both modes", async function () {
      const now = await getLatestBlockTimestamp();
      const milestones = [
        {
          amount: M1_AMOUNT,
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH_1,
        },
      ];

      // Standard deal creation
      const tx1 = await factory.connect(client).createDeal(client.address, freelancer.address, milestones);
      const receipt1 = await tx1.wait();
      const cloneAddr1 = receipt1.logs
        .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "DealCreated").args.dealAddress;
      const deal1 = await ethers.getContractAt("SynqDealV1", cloneAddr1);
      assert.equal(await deal1.isProtected(), false);

      // Protected deal creation
      const tx2 = await factory.connect(client).createProtectedDeal(client.address, freelancer.address, milestones);
      const receipt2 = await tx2.wait();
      const cloneAddr2 = receipt2.logs
        .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "DealCreated").args.dealAddress;
      const deal2 = await ethers.getContractAt("SynqDealV1", cloneAddr2);
      assert.equal(await deal2.isProtected(), true);
    });
  });

  // ==================================================
  // 2. STATE MACHINE ISOLATION & REVISION BYPASS
  // ==================================================
  describe("2. State Machine Isolation & Revision Bypass Prevention", function () {
    it("Protected deal client cannot call requestRevision to bypass AI assessment", async function () {
      const now = await getLatestBlockTimestamp();
      const milestones = [
        {
          amount: M1_AMOUNT,
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH_1,
        },
      ];
      const tx = await factory.connect(client).createProtectedDeal(client.address, freelancer.address, milestones);
      const receipt = await tx.wait();
      const dealAddr = receipt.logs
        .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "DealCreated").args.dealAddress;
      const deal = await ethers.getContractAt("SynqDealV1", dealAddr);

      // Fund and submit work
      await usdc.mint(client.address, M1_AMOUNT);
      await usdc.connect(client).approve(dealAddr, M1_AMOUNT);
      await deal.connect(client).fundDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);

      // Attempting requestRevision should revert
      await expectRevert(
        deal.connect(client).requestRevision(0, ethers.keccak256(ethers.toUtf8Bytes("Revision")), now + 10 * ONE_DAY),
        "Protected deals cannot request revision"
      );

      // Client must use rejectWorkProtected
      await deal.connect(client).rejectWorkProtected(0, ethers.keccak256(ethers.toUtf8Bytes("Ordinary Rejection")));
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 10); // AssessmentPending
    });

    it("Standard deal client cannot call rejectWorkProtected or triggerReviewTimeoutProtected", async function () {
      const now = await getLatestBlockTimestamp();
      const milestones = [
        {
          amount: M1_AMOUNT,
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH_1,
        },
      ];
      const tx = await factory.connect(client).createDeal(client.address, freelancer.address, milestones);
      const receipt = await tx.wait();
      const dealAddr = receipt.logs
        .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "DealCreated").args.dealAddress;
      const deal = await ethers.getContractAt("SynqDealV1", dealAddr);

      await usdc.mint(client.address, M1_AMOUNT);
      await usdc.connect(client).approve(dealAddr, M1_AMOUNT);
      await deal.connect(client).fundDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);

      await expectRevert(
        deal.connect(client).rejectWorkProtected(0, ethers.ZeroHash),
        "Only protected deals"
      );
      await expectRevert(
        deal.connect(thirdParty).triggerReviewTimeoutProtected(0),
        "Only protected deals"
      );
    });
  });

  // ==================================================
  // 3. DISPUTE SLA RESET ATTACK & REPEATED DISPUTE
  // ==================================================
  describe("3. Dispute SLA Reset Attack Prevention", function () {
    it("cannot reopen serious dispute while milestone is already Disputed", async function () {
      const now = await getLatestBlockTimestamp();
      const milestones = [
        {
          amount: M1_AMOUNT,
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH_1,
        },
      ];
      const tx = await factory.connect(client).createDeal(client.address, freelancer.address, milestones);
      const receipt = await tx.wait();
      const dealAddr = receipt.logs
        .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "DealCreated").args.dealAddress;
      const deal = await ethers.getContractAt("SynqDealV1", dealAddr);

      await usdc.mint(client.address, M1_AMOUNT);
      await usdc.connect(client).approve(dealAddr, M1_AMOUNT);
      await deal.connect(client).fundDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);

      // Open serious dispute
      await deal.connect(client).openSeriousDispute(0, ethers.keccak256(ethers.toUtf8Bytes("Dispute 1")));
      const initialDisputeTime = await deal.milestoneDisputeOpenedAt(0);
      assert(initialDisputeTime > 0n);

      // Advance 5 days
      await ethers.provider.send("evm_increaseTime", [5 * ONE_DAY]);
      await ethers.provider.send("evm_mine");

      // Attempt to call openSeriousDispute again to reset the 14-day SLA
      await expectRevert(
        deal.connect(freelancer).openSeriousDispute(0, ethers.keccak256(ethers.toUtf8Bytes("Dispute 2"))),
        "Milestone not in eligible dispute state"
      );

      // Confirm disputeOpenedAt timestamp was NOT reset
      const postAttemptTime = await deal.milestoneDisputeOpenedAt(0);
      assert.equal(postAttemptTime, initialDisputeTime);
    });
  });

  // ==================================================
  // 4. RESOLVER BOUNDARY & FINAL REVIEW AUTHORITY
  // ==================================================
  describe("4. Resolver Boundary & Final Review Authority Invariants", function () {
    it("primary proposing resolver retains final review authority past day 14", async function () {
      const now = await getLatestBlockTimestamp();
      const milestones = [
        {
          amount: M1_AMOUNT,
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH_1,
        },
      ];
      const tx = await factory.connect(client).createDeal(client.address, freelancer.address, milestones);
      const receipt = await tx.wait();
      const dealAddr = receipt.logs
        .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "DealCreated").args.dealAddress;
      const deal = await ethers.getContractAt("SynqDealV1", dealAddr);

      await usdc.mint(client.address, M1_AMOUNT);
      await usdc.connect(client).approve(dealAddr, M1_AMOUNT);
      await deal.connect(client).fundDeal();
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).openSeriousDispute(0, ethers.ZeroHash);

      // Primary committee proposes resolution on Day 10 (within 14d SLA)
      await ethers.provider.send("evm_increaseTime", [10 * ONE_DAY]);
      await ethers.provider.send("evm_mine");

      const auth = {
        committee: await primaryCommittee.getAddress(),
        chainId: 31337,
        deal: dealAddr,
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH_1,
        specHash: SPEC_HASH_1,
        freelancerAmount: 60_000_000n,
        clientAmount: 40_000_000n,
        justificationHash: ethers.keccak256(ethers.toUtf8Bytes("Split justification")),
        resolutionNonce: 1,
        validUntil: (await getLatestBlockTimestamp()) + 3600,
        submissionVersion: 1,
      };
      const [sig1, sig2] = await signResolutionProposal([signer1, signer2], auth);
      await primaryCommittee.connect(thirdParty).submitResolutionProposal(auth, sig1, sig2);

      // Freelancer requests reconsideration within 72h window
      await deal.connect(freelancer).requestFinalReconsideration(0);
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 6); // FinalReview

      // Advance time by 6 days (now Day 16 since dispute opened, past 14-day SLA)
      await ethers.provider.send("evm_increaseTime", [6 * ONE_DAY]);
      await ethers.provider.send("evm_mine");

      // Emergency resolver cannot finalize because proposing resolver was primaryCommittee
      const emergencyAddr = await emergencyResolver.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [emergencyAddr]);
      await ethers.provider.send("hardhat_setBalance", [emergencyAddr, "0x1000000000000000000"]);
      const emergencySigner = await ethers.getSigner(emergencyAddr);

      await expectRevert(
        deal.connect(emergencySigner).executeFinalResolution(0, 50_000_000n, 50_000_000n, ethers.ZeroHash),
        "Only proposing resolver can finalize"
      );
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [emergencyAddr]);

      // Primary committee submits final resolution and succeeds
      const finalAuth = {
        committee: await primaryCommittee.getAddress(),
        chainId: 31337,
        deal: dealAddr,
        milestoneId: 0,
        evidenceRootHash: EVIDENCE_HASH_1,
        specHash: SPEC_HASH_1,
        freelancerAmount: 50_000_000n,
        clientAmount: 50_000_000n,
        justificationHash: ethers.keccak256(ethers.toUtf8Bytes("Final ruling")),
        resolutionNonce: 2,
        validUntil: (await getLatestBlockTimestamp()) + 3600,
        submissionVersion: 1,
      };
      const [fSig1, fSig2] = await signFinalResolution([signer1, signer3], finalAuth);
      await primaryCommittee.connect(thirdParty).submitFinalResolution(finalAuth, fSig1, fSig2);

      const mAfter = await deal.getMilestone(0);
      assert.equal(mAfter.status, 9); // SettledSplit
      assert.equal(await deal.state(), 2); // Completed
    });
  });

  // ==================================================
  // 5. MULTI-MILESTONE ISOLATION & INTERLEAVED ACTIONS
  // ==================================================
  describe("5. Multi-Milestone State Isolation Audit", function () {
    it("handles 3 concurrent milestones in distinct states without cross-contamination", async function () {
      const now = await getLatestBlockTimestamp();
      const milestones = [
        {
          amount: M1_AMOUNT,
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH_1,
        },
        {
          amount: M2_AMOUNT,
          workDeadline: now + 7 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH_2,
        },
        {
          amount: M3_AMOUNT,
          workDeadline: now + 10 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH_3,
        },
      ];
      const TOTAL = M1_AMOUNT + M2_AMOUNT + M3_AMOUNT;

      const tx = await factory.connect(client).createProtectedDeal(client.address, freelancer.address, milestones);
      const receipt = await tx.wait();
      const dealAddr = receipt.logs
        .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "DealCreated").args.dealAddress;
      const deal = await ethers.getContractAt("SynqDealV1", dealAddr);

      await usdc.mint(client.address, TOTAL);
      await usdc.connect(client).approve(dealAddr, TOTAL);
      await deal.connect(client).fundDeal();

      // Milestone 0: Start, Submit, Dispute
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).openSeriousDispute(0, ethers.ZeroHash);

      // Milestone 1: Start, Submit, RejectProtected -> AssessmentProposed
      await deal.connect(freelancer).startMilestone(1);
      await deal.connect(freelancer).submitWork(1, EVIDENCE_HASH_2);
      await deal.connect(client).rejectWorkProtected(1, ethers.ZeroHash);

      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: dealAddr,
        milestoneId: 1,
        evidenceRootHash: EVIDENCE_HASH_2,
        specHash: SPEC_HASH_2,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 7000,
        reportHash: REPORT_HASH,
        assessmentNonce: 101,
        validUntil: (await getLatestBlockTimestamp()) + 3600,
        trigger: 1,
      };
      const attSig = await signAttestation(verifier, att);
      await protectionModule.connect(thirdParty).submitAssessment(att, attSig);

      // Milestone 2: Start, Submit -> Submitted (waiting for review)
      await deal.connect(freelancer).startMilestone(2);
      await deal.connect(freelancer).submitWork(2, EVIDENCE_HASH_1);

      // Assert state isolation
      const m0 = await deal.getMilestone(0);
      const m1 = await deal.getMilestone(1);
      const m2 = await deal.getMilestone(2);

      assert.equal(m0.status, 4); // Disputed
      assert.equal(m1.status, 11); // AssessmentProposed
      assert.equal(m2.status, 2); // Submitted

      // Challenge on Milestone 1 should not affect 0 or 2
      await deal.connect(freelancer).challengeAssessment(1);
      assert.equal((await deal.getMilestone(1)).status, 4); // Disputed
      assert.equal((await deal.getMilestone(2)).status, 2); // Still Submitted

      // Client approval of Milestone 2 releases exactly Milestone 2 amount
      const freelancerBefore = await usdc.balanceOf(freelancer.address);
      await deal.connect(client).clientApprove(2);
      const freelancerAfter = await usdc.balanceOf(freelancer.address);
      assert.equal(freelancerAfter - freelancerBefore, M3_AMOUNT);
      assert.equal((await deal.getMilestone(2)).status, 7); // SettledPaid

      // Remaining escrow in contract must equal m0.amount + m1.amount
      assert.equal(await usdc.balanceOf(dealAddr), M1_AMOUNT + M2_AMOUNT);
    });
  });

  // ==================================================
  // 6. ECONOMIC CONSERVATION INVARIANT
  // ==================================================
  describe("6. Complete Economic Conservation Invariant", function () {
    it("conserves exact escrow across mixed settlement paths with zero leaks", async function () {
      const now = await getLatestBlockTimestamp();
      const milestones = [
        {
          amount: 150_000_000n, // M0: Approved 100%
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH_1,
        },
        {
          amount: 250_000_000n, // M1: Assessment 60% split
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH_2,
        },
        {
          amount: 100_000_000n, // M2: Mutual settlement 80/20
          workDeadline: now + 5 * ONE_DAY,
          reviewWindow: 3 * ONE_DAY,
          gracePeriod: 1 * ONE_DAY,
          specHash: SPEC_HASH_3,
        },
      ];
      const TOTAL = 500_000_000n;

      const tx = await factory.connect(client).createProtectedDeal(client.address, freelancer.address, milestones);
      const receipt = await tx.wait();
      const dealAddr = receipt.logs
        .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "DealCreated").args.dealAddress;
      const deal = await ethers.getContractAt("SynqDealV1", dealAddr);

      await usdc.mint(client.address, TOTAL);
      await usdc.connect(client).approve(dealAddr, TOTAL);
      await deal.connect(client).fundDeal();

      const initialClient = await usdc.balanceOf(client.address);
      const initialFreelancer = await usdc.balanceOf(freelancer.address);

      // M0: Full approval
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).clientApprove(0);

      // M1: Assessment 60% split
      await deal.connect(freelancer).startMilestone(1);
      await deal.connect(freelancer).submitWork(1, EVIDENCE_HASH_2);
      await deal.connect(client).rejectWorkProtected(1, ethers.ZeroHash);

      const att = {
        protectionModule: await protectionModule.getAddress(),
        chainId: 31337,
        deal: dealAddr,
        milestoneId: 1,
        evidenceRootHash: EVIDENCE_HASH_2,
        specHash: SPEC_HASH_2,
        policyId: defaultPolicyId,
        submissionVersion: 1,
        completionBps: 6000,
        reportHash: REPORT_HASH,
        assessmentNonce: 201,
        validUntil: (await getLatestBlockTimestamp()) + 3600,
        trigger: 1,
      };
      const attSig = await signAttestation(verifier, att);
      await protectionModule.connect(thirdParty).submitAssessment(att, attSig);

      // Advance 48h and settle
      await ethers.provider.send("evm_increaseTime", [48 * ONE_HOUR + 1]);
      await ethers.provider.send("evm_mine");
      await deal.connect(thirdParty).executeAssessmentSettlement(1);

      // M2: Mutual settlement 80/20
      await deal.connect(freelancer).startMilestone(2);
      await deal.connect(freelancer).submitWork(2, EVIDENCE_HASH_1);

      const prop = {
        dealAddress: dealAddr,
        chainId: 31337,
        milestoneId: 2,
        proposer: client.address,
        freelancerAmount: 80_000_000n,
        clientAmount: 20_000_000n,
        proposalNonce: 55,
        validUntil: (await getLatestBlockTimestamp()) + 3600,
      };
      const domain = {
        name: "SynqDealV1",
        version: "1",
        chainId: 31337,
        verifyingContract: dealAddr,
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
      const mutualSig = await client.signTypedData(domain, types, prop);
      await deal.connect(freelancer).executeMutualSettlement(prop, mutualSig);

      // Deal must be Completed (DealState.Completed = 2)
      assert.equal(await deal.state(), 2);

      // Total disbursements check
      const finalClient = await usdc.balanceOf(client.address);
      const finalFreelancer = await usdc.balanceOf(freelancer.address);

      const clientNet = finalClient - initialClient;
      const freelancerNet = finalFreelancer - initialFreelancer;

      // M0: 150m to freelancer, 0 to client
      // M1: 60% of 250m = 150m to freelancer, 100m to client
      // M2: 80m to freelancer, 20m to client
      // Total freelancer = 150m + 150m + 80m = 380m
      // Total client = 0 + 100m + 20m = 120m
      assert.equal(freelancerNet, 380_000_000n);
      assert.equal(clientNet, 120_000_000n);
      assert.equal(freelancerNet + clientNet, TOTAL);

      // Escrow in contract must be exactly zero
      assert.equal(await usdc.balanceOf(dealAddr), 0n);
      assert.equal(await deal.totalSettled(), TOTAL);
    });
  });
});
