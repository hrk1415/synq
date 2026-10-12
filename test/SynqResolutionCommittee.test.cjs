const assert = require("node:assert");
const { ethers } = require("hardhat");

describe("SynqResolutionCommittee Phase 1C Comprehensive Test Suite", function () {
  let factory;
  let dealImpl;
  let usdc;
  let primaryCommittee;
  let emergencyCommittee;
  let deal;
  let dealAddress;

  let owner, client, freelancer, thirdParty;
  let signerA, signerB, signerC, signerD;
  let emSignerA, emSignerB, emSignerC;

  const ONE_DAY = 86400;
  const ONE_HOUR = 3600;
  const PRIMARY_RESOLVER_SLA = 14 * ONE_DAY;
  const RECONSIDERATION_WINDOW = 72 * ONE_HOUR;

  const M1_AMOUNT = 500_000_000n; // 500 USDC
  const M2_AMOUNT = 500_000_000n; // 500 USDC
  const TOTAL_ESCROW = 1_000_000_000n;

  const SPEC_HASH_1 = ethers.keccak256(ethers.toUtf8Bytes("Agreed Milestone 1 Acceptance Criteria"));
  const SPEC_HASH_2 = ethers.keccak256(ethers.toUtf8Bytes("Agreed Milestone 2 Acceptance Criteria"));
  const EVIDENCE_HASH_1 = ethers.keccak256(ethers.toUtf8Bytes("Evidence Commit #1"));
  const JUSTIFICATION_HASH_1 = ethers.keccak256(ethers.toUtf8Bytes("Resolution Justification: Partial delivery 60/40"));
  const JUSTIFICATION_HASH_FINAL = ethers.keccak256(ethers.toUtf8Bytes("Final Justification: Reconsidered 70/30"));

  async function getLatestBlockTimestamp() {
    const block = await ethers.provider.getBlock("latest");
    return block.timestamp;
  }

  async function increaseTime(seconds) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine");
  }

  async function setBlockTime(targetTime) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [targetTime]);
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

  async function signProposalAuth(signer, committeeAddr, auth) {
    const domain = {
      name: "SynqResolutionCommittee",
      version: "1",
      chainId: auth.chainId,
      verifyingContract: committeeAddr,
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
    return await signer.signTypedData(domain, types, auth);
  }

  async function signFinalAuth(signer, committeeAddr, auth) {
    const domain = {
      name: "SynqResolutionCommittee",
      version: "1",
      chainId: auth.chainId,
      verifyingContract: committeeAddr,
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
    return await signer.signTypedData(domain, types, auth);
  }

  async function signRotationOp(signer, committeeAddr, op) {
    const domain = {
      name: "SynqResolutionCommittee",
      version: "1",
      chainId: op.chainId,
      verifyingContract: committeeAddr,
    };
    const types = {
      SignerRotationOp: [
        { name: "committee", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "committeeEpoch", type: "uint64" },
        { name: "oldSigner", type: "address" },
        { name: "newSigner", type: "address" },
        { name: "rotationNonce", type: "uint64" },
        { name: "validUntil", type: "uint64" },
      ],
    };
    return await signer.signTypedData(domain, types, op);
  }

  beforeEach(async function () {
    [
      owner,
      client,
      freelancer,
      thirdParty,
      signerA,
      signerB,
      signerC,
      signerD,
      emSignerA,
      emSignerB,
      emSignerC,
    ] = await ethers.getSigners();

    // 1. Deploy Mock USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6, ethers.parseUnits("1000000", 6));
    await usdc.waitForDeployment();

    // 2. Deploy SynqDealV1 Master Implementation
    const SynqDealV1 = await ethers.getContractFactory("SynqDealV1");
    dealImpl = await SynqDealV1.deploy();
    await dealImpl.waitForDeployment();

    // 3. We deploy a temporary Factory or placeholder to initialize committees,
    // or deploy a MockFactory then deploy the real factory.
    // Notice SynqResolutionCommittee takes `address _factory`.
    // Since Factory also takes `defaultPrimaryResolver` and `defaultEmergencyResolver`,
    // let's compute or deploy cleanly:
    // We can deploy Factory with MockResolvers, deploy Committees pointing to Factory,
    // and then update Factory default resolvers to the committees!
    const MockResolver = await ethers.getContractFactory("MockResolver");
    const tempResolver1 = await MockResolver.deploy();
    const tempResolver2 = await MockResolver.deploy();
    await tempResolver1.waitForDeployment();
    await tempResolver2.waitForDeployment();

    const SynqFactoryV1 = await ethers.getContractFactory("SynqFactoryV1");
    factory = await SynqFactoryV1.deploy(
      owner.address,
      await usdc.getAddress(),
      await dealImpl.getAddress(),
      await tempResolver1.getAddress(),
      await tempResolver2.getAddress()
    );
    await factory.waitForDeployment();

    // Deploy Primary Resolution Committee
    const SynqResolutionCommittee = await ethers.getContractFactory("SynqResolutionCommittee");
    primaryCommittee = await SynqResolutionCommittee.deploy(
      await factory.getAddress(),
      signerA.address,
      signerB.address,
      signerC.address
    );
    await primaryCommittee.waitForDeployment();

    // Deploy Emergency Resolution Committee
    emergencyCommittee = await SynqResolutionCommittee.deploy(
      await factory.getAddress(),
      emSignerA.address,
      emSignerB.address,
      emSignerC.address
    );
    await emergencyCommittee.waitForDeployment();

    // Set Factory defaults to the actual deployed committees
    await factory.connect(owner).setDefaultPrimaryResolver(await primaryCommittee.getAddress());
    await factory.connect(owner).setDefaultEmergencyResolver(await emergencyCommittee.getAddress());

    // Mint USDC to client
    await usdc.mint(client.address, ethers.parseUnits("100000", 6));

    // Create standard deal via Factory
    const nowTime = await getLatestBlockTimestamp();
    const milestones = [
      {
        amount: M1_AMOUNT,
        workDeadline: BigInt(nowTime + 10 * ONE_DAY),
        reviewWindow: BigInt(3 * ONE_DAY),
        gracePeriod: BigInt(ONE_DAY),
        specHash: SPEC_HASH_1,
      },
      {
        amount: M2_AMOUNT,
        workDeadline: BigInt(nowTime + 20 * ONE_DAY),
        reviewWindow: BigInt(3 * ONE_DAY),
        gracePeriod: BigInt(ONE_DAY),
        specHash: SPEC_HASH_2,
      },
    ];

    const tx = await factory.connect(client).createDeal(client.address, freelancer.address, milestones);
    await tx.wait();

    dealAddress = await factory.allDeals(0);
    deal = await ethers.getContractAt("SynqDealV1", dealAddress);

    // Fund deal
    await usdc.connect(client).approve(dealAddress, TOTAL_ESCROW);
    await deal.connect(client).fundDeal();
  });

  describe("1. Committee Signer Configuration & Deployment", function () {
    it("deploys with exactly 3 unique signers and threshold 2", async function () {
      const signers = await primaryCommittee.getSigners();
      assert.equal(signers.length, 3);
      assert.equal(signers[0], signerA.address);
      assert.equal(signers[1], signerB.address);
      assert.equal(signers[2], signerC.address);
      assert.equal(await primaryCommittee.THRESHOLD(), 2n);
      assert.equal(await primaryCommittee.isSigner(signerA.address), true);
      assert.equal(await primaryCommittee.isSigner(signerB.address), true);
      assert.equal(await primaryCommittee.isSigner(signerC.address), true);
      assert.equal(await primaryCommittee.isSigner(signerD.address), false);
    });

    it("rejects zero signer address", async function () {
      const SynqResolutionCommittee = await ethers.getContractFactory("SynqResolutionCommittee");
      await expectRevert(
        SynqResolutionCommittee.deploy(await factory.getAddress(), ethers.ZeroAddress, signerB.address, signerC.address),
        "Zero signer A"
      );
      await expectRevert(
        SynqResolutionCommittee.deploy(await factory.getAddress(), signerA.address, ethers.ZeroAddress, signerC.address),
        "Zero signer B"
      );
      await expectRevert(
        SynqResolutionCommittee.deploy(await factory.getAddress(), signerA.address, signerB.address, ethers.ZeroAddress),
        "Zero signer C"
      );
    });

    it("rejects duplicate signer addresses", async function () {
      const SynqResolutionCommittee = await ethers.getContractFactory("SynqResolutionCommittee");
      await expectRevert(
        SynqResolutionCommittee.deploy(await factory.getAddress(), signerA.address, signerA.address, signerC.address),
        "Duplicate signer A and B"
      );
      await expectRevert(
        SynqResolutionCommittee.deploy(await factory.getAddress(), signerA.address, signerB.address, signerA.address),
        "Duplicate signer A and C"
      );
      await expectRevert(
        SynqResolutionCommittee.deploy(await factory.getAddress(), signerA.address, signerB.address, signerB.address),
        "Duplicate signer B and C"
      );
    });
  });

  describe("2. Resolution Proposal Authorization & EIP-712 Invariants", function () {
    let nowTime;
    let authBase;

    beforeEach(async function () {
      // Move milestone 0 into DISPUTED
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).openSeriousDispute(0, ethers.keccak256(ethers.toUtf8Bytes("Dispute Reason")));

      nowTime = await getLatestBlockTimestamp();
      const network = await ethers.provider.getNetwork();

      authBase = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        deal: dealAddress,
        milestoneId: 0n,
        freelancerAmount: 300_000_000n, // 300 USDC to freelancer
        clientAmount: 200_000_000n,     // 200 USDC to client
        justificationHash: JUSTIFICATION_HASH_1,
        resolutionNonce: 1n,
        validUntil: BigInt(nowTime + ONE_DAY),
        evidenceRootHash: EVIDENCE_HASH_1,
        specHash: SPEC_HASH_1,
        submissionVersion: 1,
      };
    });

    it("valid 2-of-3 proposal is accepted and sets state to ResolutionProposed", async function () {
      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), authBase);
      const sigB = await signProposalAuth(signerB, await primaryCommittee.getAddress(), authBase);

      const tx = await primaryCommittee.submitResolutionProposal(authBase, sigA, sigB);
      const receipt = await tx.wait();

      const m = await deal.getMilestone(0);
      assert.equal(m.status, 5n); // MilestoneStatus.ResolutionProposed

      const prop = await deal.getResolutionProposal(0);
      assert.equal(prop.freelancerAmount, 300_000_000n);
      assert.equal(prop.clientAmount, 200_000_000n);
      assert.equal(prop.resolver, await primaryCommittee.getAddress());
      assert.equal(prop.justificationHash, JUSTIFICATION_HASH_1);
    });

    it("third signature is unnecessary (2-of-3 sufficiency)", async function () {
      const sigB = await signProposalAuth(signerB, await primaryCommittee.getAddress(), authBase);
      const sigC = await signProposalAuth(signerC, await primaryCommittee.getAddress(), authBase);

      await primaryCommittee.submitResolutionProposal(authBase, sigB, sigC);
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 5n);
    });

    it("same signer twice is strictly rejected", async function () {
      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), authBase);
      await expectRevert(
        primaryCommittee.submitResolutionProposal(authBase, sigA, sigA),
        "Duplicate signer signature"
      );
    });

    it("non-signer signature is rejected", async function () {
      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), authBase);
      const sigThird = await signProposalAuth(thirdParty, await primaryCommittee.getAddress(), authBase);

      await expectRevert(
        primaryCommittee.submitResolutionProposal(authBase, sigA, sigThird),
        "Signer 2 not authorized"
      );
    });

    it("expired authorization is rejected", async function () {
      const expiredAuth = { ...authBase, validUntil: BigInt(nowTime - 10) };
      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), expiredAuth);
      const sigB = await signProposalAuth(signerB, await primaryCommittee.getAddress(), expiredAuth);

      await expectRevert(
        primaryCommittee.submitResolutionProposal(expiredAuth, sigA, sigB),
        "Authorization expired"
      );
    });

    it("nonce replay is strictly rejected", async function () {
      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), authBase);
      const sigB = await signProposalAuth(signerB, await primaryCommittee.getAddress(), authBase);

      await primaryCommittee.submitResolutionProposal(authBase, sigA, sigB);

      // Second attempt with same nonce reverts
      await expectRevert(
        primaryCommittee.submitResolutionProposal(authBase, sigA, sigB),
        "Resolution nonce used"
      );
    });

    it("cross-chain / domain mismatch is rejected", async function () {
      const wrongChainAuth = { ...authBase, chainId: 999999n };
      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), wrongChainAuth);
      const sigB = await signProposalAuth(signerB, await primaryCommittee.getAddress(), wrongChainAuth);

      await expectRevert(
        primaryCommittee.submitResolutionProposal(wrongChainAuth, sigA, sigB),
        "Mismatched chainId"
      );
    });

    it("cross-deal replay is rejected", async function () {
      const fakeDeal = ethers.Wallet.createRandom().address;
      const fakeAuth = { ...authBase, deal: fakeDeal };
      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), fakeAuth);
      const sigB = await signProposalAuth(signerB, await primaryCommittee.getAddress(), fakeAuth);

      await expectRevert(
        primaryCommittee.submitResolutionProposal(fakeAuth, sigA, sigB),
        "Deal not registered with Factory"
      );
    });

    it("cross-milestone replay is rejected", async function () {
      const wrongMilestoneAuth = { ...authBase, milestoneId: 1n };
      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), wrongMilestoneAuth);
      const sigB = await signProposalAuth(signerB, await primaryCommittee.getAddress(), wrongMilestoneAuth);

      // Milestone 1 has not even started/disputed and has different evidence/spec
      await expectRevert(
        primaryCommittee.submitResolutionProposal(wrongMilestoneAuth, sigA, sigB),
        "Mismatched evidenceRootHash"
      );
    });

    it("stale evidence or version snapshot is rejected", async function () {
      const staleAuth = { ...authBase, submissionVersion: 2 };
      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), staleAuth);
      const sigB = await signProposalAuth(signerB, await primaryCommittee.getAddress(), staleAuth);

      await expectRevert(
        primaryCommittee.submitResolutionProposal(staleAuth, sigA, sigB),
        "Mismatched submissionVersion"
      );
    });

    it("initial proposal authorization cannot be used as final resolution authorization", async function () {
      // Attempting to submit authBase as a final resolution fails typehash verification
      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), authBase);
      const sigB = await signProposalAuth(signerB, await primaryCommittee.getAddress(), authBase);

      await expectRevert(
        primaryCommittee.submitFinalResolution(authBase, sigA, sigB),
        "Signer 1 not authorized"
      );
    });
  });

  describe("3. Signer Rotation & Governance Invariants", function () {
    let network;
    let nowTime;

    beforeEach(async function () {
      network = await ethers.provider.getNetwork();
      nowTime = await getLatestBlockTimestamp();
    });

    it("rotates signer with valid 2-of-3 signatures", async function () {
      const initialEpoch = await primaryCommittee.committeeEpoch();
      assert.equal(initialEpoch, 0n);

      const op = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        committeeEpoch: initialEpoch,
        oldSigner: signerC.address,
        newSigner: signerD.address,
        rotationNonce: 1n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };

      const sigA = await signRotationOp(signerA, await primaryCommittee.getAddress(), op);
      const sigB = await signRotationOp(signerB, await primaryCommittee.getAddress(), op);

      const tx = await primaryCommittee.rotateSigner(op, sigA, sigB);
      await tx.wait();

      assert.equal(await primaryCommittee.committeeEpoch(), 1n);
      assert.equal(await primaryCommittee.isSigner(signerC.address), false);
      assert.equal(await primaryCommittee.isSigner(signerD.address), true);

      const signers = await primaryCommittee.getSigners();
      assert.equal(signers[2], signerD.address);
    });

    it("single signer cannot rotate another signer alone", async function () {
      const op = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        committeeEpoch: await primaryCommittee.committeeEpoch(),
        oldSigner: signerC.address,
        newSigner: signerD.address,
        rotationNonce: 2n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };

      const sigA = await signRotationOp(signerA, await primaryCommittee.getAddress(), op);
      await expectRevert(
        primaryCommittee.rotateSigner(op, sigA, sigA),
        "Duplicate signer signature"
      );
    });

    it("duplicate replacement signer rejected", async function () {
      const op = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        committeeEpoch: await primaryCommittee.committeeEpoch(),
        oldSigner: signerC.address,
        newSigner: signerA.address, // already a signer!
        rotationNonce: 3n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };

      const sigA = await signRotationOp(signerA, await primaryCommittee.getAddress(), op);
      const sigB = await signRotationOp(signerB, await primaryCommittee.getAddress(), op);

      await expectRevert(
        primaryCommittee.rotateSigner(op, sigA, sigB),
        "newSigner is already a signer"
      );
    });

    it("zero replacement signer rejected", async function () {
      const op = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        committeeEpoch: await primaryCommittee.committeeEpoch(),
        oldSigner: signerC.address,
        newSigner: ethers.ZeroAddress,
        rotationNonce: 4n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };

      const sigA = await signRotationOp(signerA, await primaryCommittee.getAddress(), op);
      const sigB = await signRotationOp(signerB, await primaryCommittee.getAddress(), op);

      await expectRevert(
        primaryCommittee.rotateSigner(op, sigA, sigB),
        "Zero new signer"
      );
    });

    it("rotation nonce replay rejected", async function () {
      const op = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        committeeEpoch: await primaryCommittee.committeeEpoch(),
        oldSigner: signerC.address,
        newSigner: signerD.address,
        rotationNonce: 5n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };

      const sigA = await signRotationOp(signerA, await primaryCommittee.getAddress(), op);
      const sigB = await signRotationOp(signerB, await primaryCommittee.getAddress(), op);

      await primaryCommittee.rotateSigner(op, sigA, sigB);

      // Replay same nonce
      await expectRevert(
        primaryCommittee.rotateSigner(op, sigA, sigB),
        "Mismatched committee epoch"
      );
    });

    it("mismatched committee epoch rejected", async function () {
      const op = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        committeeEpoch: 99n, // wrong epoch
        oldSigner: signerC.address,
        newSigner: signerD.address,
        rotationNonce: 7n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };

      const sigA = await signRotationOp(signerA, await primaryCommittee.getAddress(), op);
      const sigB = await signRotationOp(signerB, await primaryCommittee.getAddress(), op);

      await expectRevert(
        primaryCommittee.rotateSigner(op, sigA, sigB),
        "Mismatched committee epoch"
      );
    });

    it("two competing rotation authorizations created from same signer set: first executes, stale competing fails", async function () {
      const currentEpoch = await primaryCommittee.committeeEpoch();

      // Authorization X: replace C -> D (nonce 10)
      const opX = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        committeeEpoch: currentEpoch,
        oldSigner: signerC.address,
        newSigner: signerD.address,
        rotationNonce: 10n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };
      const sigA_X = await signRotationOp(signerA, await primaryCommittee.getAddress(), opX);
      const sigB_X = await signRotationOp(signerB, await primaryCommittee.getAddress(), opX);

      // Authorization Y: replace C -> thirdParty (nonce 11)
      const opY = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        committeeEpoch: currentEpoch,
        oldSigner: signerC.address,
        newSigner: thirdParty.address,
        rotationNonce: 11n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };
      const sigA_Y = await signRotationOp(signerA, await primaryCommittee.getAddress(), opY);
      const sigB_Y = await signRotationOp(signerB, await primaryCommittee.getAddress(), opY);

      // Execute Y first
      await primaryCommittee.rotateSigner(opY, sigA_Y, sigB_Y);
      assert.equal(await primaryCommittee.committeeEpoch(), currentEpoch + 1n);
      assert.equal(await primaryCommittee.isSigner(thirdParty.address), true);

      // Attempt to execute stale X afterward: must fail due to epoch mismatch (and oldSigner C no longer current)
      await expectRevert(
        primaryCommittee.rotateSigner(opX, sigA_X, sigB_X),
        "Mismatched committee epoch"
      );
    });

    it("stale rotation authorization where oldSigner and signers remain valid is blocked by committeeEpoch", async function () {
      const currentEpoch = await primaryCommittee.committeeEpoch();

      // Authorization 1: A and B sign to replace A -> signerD (nonce 20)
      const op1 = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        committeeEpoch: currentEpoch,
        oldSigner: signerA.address,
        newSigner: signerD.address,
        rotationNonce: 20n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };
      const sigA_1 = await signRotationOp(signerA, await primaryCommittee.getAddress(), op1);
      const sigB_1 = await signRotationOp(signerB, await primaryCommittee.getAddress(), op1);

      // Authorization 2: A and B sign to replace C -> thirdParty (nonce 21)
      const op2 = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        committeeEpoch: currentEpoch,
        oldSigner: signerC.address,
        newSigner: thirdParty.address,
        rotationNonce: 21n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };
      const sigA_2 = await signRotationOp(signerA, await primaryCommittee.getAddress(), op2);
      const sigB_2 = await signRotationOp(signerB, await primaryCommittee.getAddress(), op2);

      // Op2 executes first: C is replaced by thirdParty. Signers are now A, B, thirdParty.
      await primaryCommittee.rotateSigner(op2, sigA_2, sigB_2);
      assert.equal(await primaryCommittee.committeeEpoch(), currentEpoch + 1n);

      // Notice: In Op1, oldSigner is A (still a signer!), s1 is A (still a signer!), s2 is B (still a signer!).
      // Without committeeEpoch, Op1 would successfully execute against the new committee configuration!
      // With committeeEpoch, it is strictly rejected:
      await expectRevert(
        primaryCommittee.rotateSigner(op1, sigA_1, sigB_1),
        "Mismatched committee epoch"
      );
    });

    it("cycle rotation cannot resurrect stale authorization from initial epoch", async function () {
      const epoch0 = await primaryCommittee.committeeEpoch();

      // Stale Op created at epoch 0: replace C -> signerD (nonce 30)
      const opStale = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        committeeEpoch: epoch0,
        oldSigner: signerC.address,
        newSigner: signerD.address,
        rotationNonce: 30n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };
      const sigA_stale = await signRotationOp(signerA, await primaryCommittee.getAddress(), opStale);
      const sigB_stale = await signRotationOp(signerB, await primaryCommittee.getAddress(), opStale);

      // Step 1: Rotate C -> thirdParty at epoch 0
      const opRot1 = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        committeeEpoch: epoch0,
        oldSigner: signerC.address,
        newSigner: thirdParty.address,
        rotationNonce: 31n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };
      const sigA_r1 = await signRotationOp(signerA, await primaryCommittee.getAddress(), opRot1);
      const sigB_r1 = await signRotationOp(signerB, await primaryCommittee.getAddress(), opRot1);
      await primaryCommittee.rotateSigner(opRot1, sigA_r1, sigB_r1);
      assert.equal(await primaryCommittee.committeeEpoch(), 1n);

      // Step 2: Rotate thirdParty -> C back at epoch 1 (bringing C back to committee)
      const opRot2 = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        committeeEpoch: 1n,
        oldSigner: thirdParty.address,
        newSigner: signerC.address,
        rotationNonce: 32n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };
      const sigA_r2 = await signRotationOp(signerA, await primaryCommittee.getAddress(), opRot2);
      const sigB_r2 = await signRotationOp(signerB, await primaryCommittee.getAddress(), opRot2);
      await primaryCommittee.rotateSigner(opRot2, sigA_r2, sigB_r2);
      assert.equal(await primaryCommittee.committeeEpoch(), 2n);
      assert.equal(await primaryCommittee.isSigner(signerC.address), true);

      // Now C is a signer again, A is a signer, B is a signer, nonce 30 was never used.
      // Without committeeEpoch, opStale would execute and evict C!
      // With committeeEpoch, opStale is strictly rejected:
      await expectRevert(
        primaryCommittee.rotateSigner(opStale, sigA_stale, sigB_stale),
        "Mismatched committee epoch"
      );
    });

    it("already-submitted Deal resolution remains valid after signer rotation", async function () {
      // Setup dispute on milestone 0
      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).openSeriousDispute(0, ethers.keccak256(ethers.toUtf8Bytes("Dispute Reason")));

      const auth = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        deal: dealAddress,
        milestoneId: 0n,
        freelancerAmount: 300_000_000n,
        clientAmount: 200_000_000n,
        justificationHash: JUSTIFICATION_HASH_1,
        resolutionNonce: 501n,
        validUntil: BigInt(nowTime + ONE_DAY),
        evidenceRootHash: EVIDENCE_HASH_1,
        specHash: SPEC_HASH_1,
        submissionVersion: 1,
      };

      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), auth);
      const sigB = await signProposalAuth(signerB, await primaryCommittee.getAddress(), auth);

      // Submit resolution proposal on-chain BEFORE rotation
      await primaryCommittee.submitResolutionProposal(auth, sigA, sigB);
      let m = await deal.getMilestone(0);
      assert.equal(m.status, 5n); // ResolutionProposed

      // Rotate signerC -> signerD
      const rotOp = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        committeeEpoch: await primaryCommittee.committeeEpoch(),
        oldSigner: signerC.address,
        newSigner: signerD.address,
        rotationNonce: 40n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };
      const rSigA = await signRotationOp(signerA, await primaryCommittee.getAddress(), rotOp);
      const rSigB = await signRotationOp(signerB, await primaryCommittee.getAddress(), rotOp);
      await primaryCommittee.rotateSigner(rotOp, rSigA, rSigB);

      // Deal proposal remains completely valid and executes after 72h
      await increaseTime(RECONSIDERATION_WINDOW + 1);
      await deal.executeResolution(0);

      m = await deal.getMilestone(0);
      assert.equal(m.status, 9n); // SettledSplit
    });

    it("off-chain resolution authorization using removed signer fails if submitted after rotation", async function () {
      // Setup dispute on milestone 1
      await deal.connect(freelancer).startMilestone(1);
      await deal.connect(freelancer).submitWork(1, EVIDENCE_HASH_1);
      await deal.connect(client).openSeriousDispute(1, ethers.keccak256(ethers.toUtf8Bytes("Dispute Reason 2")));

      const auth = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        deal: dealAddress,
        milestoneId: 1n,
        freelancerAmount: 250_000_000n,
        clientAmount: 250_000_000n,
        justificationHash: JUSTIFICATION_HASH_1,
        resolutionNonce: 601n,
        validUntil: BigInt(nowTime + ONE_DAY),
        evidenceRootHash: EVIDENCE_HASH_1,
        specHash: SPEC_HASH_2,
        submissionVersion: 1,
      };

      // Signatures collected off-chain using signerA and signerC (before rotation)
      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), auth);
      const sigC = await signProposalAuth(signerC, await primaryCommittee.getAddress(), auth);

      // Now rotate signerC -> signerD on-chain
      const rotOp = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        committeeEpoch: await primaryCommittee.committeeEpoch(),
        oldSigner: signerC.address,
        newSigner: signerD.address,
        rotationNonce: 41n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };
      const rSigA = await signRotationOp(signerA, await primaryCommittee.getAddress(), rotOp);
      const rSigB = await signRotationOp(signerB, await primaryCommittee.getAddress(), rotOp);
      await primaryCommittee.rotateSigner(rotOp, rSigA, rSigB);

      // Now submit the off-chain auth that was signed by removed signerC
      await expectRevert(
        primaryCommittee.submitResolutionProposal(auth, sigA, sigC),
        "Signer 2 not authorized"
      );
    });

    it("new signer can participate in future authorizations (both rotation and resolution)", async function () {
      // 1. Rotate signerC -> signerD
      const rotOp = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        committeeEpoch: await primaryCommittee.committeeEpoch(),
        oldSigner: signerC.address,
        newSigner: signerD.address,
        rotationNonce: 42n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };
      const rSigA = await signRotationOp(signerA, await primaryCommittee.getAddress(), rotOp);
      const rSigB = await signRotationOp(signerB, await primaryCommittee.getAddress(), rotOp);
      await primaryCommittee.rotateSigner(rotOp, rSigA, rSigB);

      const newEpoch = await primaryCommittee.committeeEpoch();

      // 2. New signer D participates in rotating signerB -> thirdParty at newEpoch
      const rotOp2 = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        committeeEpoch: newEpoch,
        oldSigner: signerB.address,
        newSigner: thirdParty.address,
        rotationNonce: 43n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };
      const r2SigA = await signRotationOp(signerA, await primaryCommittee.getAddress(), rotOp2);
      const r2SigD = await signRotationOp(signerD, await primaryCommittee.getAddress(), rotOp2);
      await primaryCommittee.rotateSigner(rotOp2, r2SigA, r2SigD);

      assert.equal(await primaryCommittee.isSigner(thirdParty.address), true);
      assert.equal(await primaryCommittee.isSigner(signerB.address), false);
    });
  });

  describe("4. Deal Dispute SLA & Resolver Role Boundary", function () {
    let network;
    let disputeTime;

    beforeEach(async function () {
      network = await ethers.provider.getNetwork();

      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).openSeriousDispute(0, ethers.keccak256(ethers.toUtf8Bytes("Dispute Reason")));

      disputeTime = await deal.milestoneDisputeOpenedAt(0);
      assert(disputeTime > 0n);
    });

    it("primary resolver can propose before SLA (within 14 days)", async function () {
      const auth = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        deal: dealAddress,
        milestoneId: 0n,
        freelancerAmount: 300_000_000n,
        clientAmount: 200_000_000n,
        justificationHash: JUSTIFICATION_HASH_1,
        resolutionNonce: 201n,
        validUntil: BigInt(disputeTime + 7n * BigInt(ONE_DAY)),
        evidenceRootHash: EVIDENCE_HASH_1,
        specHash: SPEC_HASH_1,
        submissionVersion: 1,
      };

      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), auth);
      const sigB = await signProposalAuth(signerB, await primaryCommittee.getAddress(), auth);

      await primaryCommittee.submitResolutionProposal(auth, sigA, sigB);
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 5n);
    });

    it("emergency resolver cannot propose before SLA expires", async function () {
      const auth = {
        committee: await emergencyCommittee.getAddress(),
        chainId: network.chainId,
        deal: dealAddress,
        milestoneId: 0n,
        freelancerAmount: 300_000_000n,
        clientAmount: 200_000_000n,
        justificationHash: JUSTIFICATION_HASH_1,
        resolutionNonce: 202n,
        validUntil: BigInt(disputeTime + 7n * BigInt(ONE_DAY)),
        evidenceRootHash: EVIDENCE_HASH_1,
        specHash: SPEC_HASH_1,
        submissionVersion: 1,
      };

      const sigA = await signProposalAuth(emSignerA, await emergencyCommittee.getAddress(), auth);
      const sigB = await signProposalAuth(emSignerB, await emergencyCommittee.getAddress(), auth);

      await expectRevert(
        emergencyCommittee.submitResolutionProposal(auth, sigA, sigB),
        "Only primary resolver within SLA"
      );
    });

    it("primary resolver cannot propose at or after SLA; emergency resolver can", async function () {
      // Fast forward past 14 days SLA
      await setBlockTime(Number(disputeTime + BigInt(PRIMARY_RESOLVER_SLA)));

      const authPrimary = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        deal: dealAddress,
        milestoneId: 0n,
        freelancerAmount: 300_000_000n,
        clientAmount: 200_000_000n,
        justificationHash: JUSTIFICATION_HASH_1,
        resolutionNonce: 203n,
        validUntil: BigInt(disputeTime + 20n * BigInt(ONE_DAY)),
        evidenceRootHash: EVIDENCE_HASH_1,
        specHash: SPEC_HASH_1,
        submissionVersion: 1,
      };

      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), authPrimary);
      const sigB = await signProposalAuth(signerB, await primaryCommittee.getAddress(), authPrimary);

      // Primary rejected after SLA
      await expectRevert(
        primaryCommittee.submitResolutionProposal(authPrimary, sigA, sigB),
        "Only emergency resolver after SLA"
      );

      // Emergency succeeds after SLA
      const authEmergency = {
        ...authPrimary,
        committee: await emergencyCommittee.getAddress(),
        resolutionNonce: 204n,
      };

      const emSigA = await signProposalAuth(emSignerA, await emergencyCommittee.getAddress(), authEmergency);
      const emSigB = await signProposalAuth(emSignerB, await emergencyCommittee.getAddress(), authEmergency);

      await emergencyCommittee.submitResolutionProposal(authEmergency, emSigA, emSigB);
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 5n); // ResolutionProposed
    });

    it("unrelated third party resolver contract cannot act", async function () {
      const MockResolver = await ethers.getContractFactory("MockResolver");
      const rogue = await MockResolver.deploy();
      await rogue.waitForDeployment();

      await expectRevert(
        deal.connect(thirdParty).proposeMilestoneResolution(0, 250_000_000n, 250_000_000n, JUSTIFICATION_HASH_1),
        "Only primary resolver within SLA"
      );
    });
  });

  describe("5. Resolution Proposal Lifecycle, Reconsideration & Execution", function () {
    let network;
    let auth;

    beforeEach(async function () {
      network = await ethers.provider.getNetwork();

      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).openSeriousDispute(0, ethers.keccak256(ethers.toUtf8Bytes("Dispute Reason")));

      const nowTime = await getLatestBlockTimestamp();
      auth = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        deal: dealAddress,
        milestoneId: 0n,
        freelancerAmount: 350_000_000n,
        clientAmount: 150_000_000n,
        justificationHash: JUSTIFICATION_HASH_1,
        resolutionNonce: 301n,
        validUntil: BigInt(nowTime + ONE_DAY),
        evidenceRootHash: EVIDENCE_HASH_1,
        specHash: SPEC_HASH_1,
        submissionVersion: 1,
      };

      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), auth);
      const sigB = await signProposalAuth(signerB, await primaryCommittee.getAddress(), auth);
      await primaryCommittee.submitResolutionProposal(auth, sigA, sigB);
    });

    it("proposal does not immediately transfer funds", async function () {
      assert.equal(await usdc.balanceOf(dealAddress), TOTAL_ESCROW);
    });

    it("executeResolution before 72h reconsideration window expires is rejected", async function () {
      await expectRevert(
        deal.connect(thirdParty).executeResolution(0),
        "Reconsideration window active"
      );
    });

    it("permissionless executeResolution succeeds after 72h without reconsideration", async function () {
      await increaseTime(RECONSIDERATION_WINDOW + 1);

      const fBalBefore = await usdc.balanceOf(freelancer.address);
      const cBalBefore = await usdc.balanceOf(client.address);

      // Anyone (thirdParty) can trigger execution
      await deal.connect(thirdParty).executeResolution(0);

      const m = await deal.getMilestone(0);
      assert.equal(m.status, 9n); // SettledSplit

      assert.equal(await usdc.balanceOf(freelancer.address) - fBalBefore, 350_000_000n);
      assert.equal(await usdc.balanceOf(client.address) - cBalBefore, 150_000_000n);
    });

    it("participant may request reconsideration before deadline, moving to FINAL_REVIEW", async function () {
      // Freelancer requests reconsideration
      await deal.connect(freelancer).requestFinalReconsideration(0);
      const m = await deal.getMilestone(0);
      assert.equal(m.status, 6n); // FinalReview

      // Once in FinalReview, executeResolution cannot be called even after 72h
      await increaseTime(RECONSIDERATION_WINDOW + 10);
      await expectRevert(
        deal.connect(thirdParty).executeResolution(0),
        "No proposed resolution to execute"
      );
    });

    it("unrelated party cannot request reconsideration", async function () {
      await expectRevert(
        deal.connect(thirdParty).requestFinalReconsideration(0),
        "Only participant"
      );
    });

    it("reconsideration after 72h deadline is rejected", async function () {
      await increaseTime(RECONSIDERATION_WINDOW + 1);
      await expectRevert(
        deal.connect(client).requestFinalReconsideration(0),
        "Reconsideration window expired"
      );
    });

    it("only one reconsideration allowed (cannot request twice)", async function () {
      await deal.connect(client).requestFinalReconsideration(0);
      await expectRevert(
        deal.connect(freelancer).requestFinalReconsideration(0),
        "No active resolution proposed"
      );
    });
  });

  describe("6. Final Review & Terminal Settlement", function () {
    let network;
    let authFinal;

    beforeEach(async function () {
      network = await ethers.provider.getNetwork();

      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).openSeriousDispute(0, ethers.keccak256(ethers.toUtf8Bytes("Dispute Reason")));

      const nowTime = await getLatestBlockTimestamp();
      const auth = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        deal: dealAddress,
        milestoneId: 0n,
        freelancerAmount: 350_000_000n,
        clientAmount: 150_000_000n,
        justificationHash: JUSTIFICATION_HASH_1,
        resolutionNonce: 401n,
        validUntil: BigInt(nowTime + ONE_DAY),
        evidenceRootHash: EVIDENCE_HASH_1,
        specHash: SPEC_HASH_1,
        submissionVersion: 1,
      };

      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), auth);
      const sigB = await signProposalAuth(signerB, await primaryCommittee.getAddress(), auth);
      await primaryCommittee.submitResolutionProposal(auth, sigA, sigB);

      // Participant requests reconsideration
      await deal.connect(client).requestFinalReconsideration(0);

      authFinal = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        deal: dealAddress,
        milestoneId: 0n,
        freelancerAmount: 400_000_000n, // revised to 400/100
        clientAmount: 100_000_000n,
        justificationHash: JUSTIFICATION_HASH_FINAL,
        resolutionNonce: 402n,
        validUntil: BigInt(nowTime + 2 * ONE_DAY),
        evidenceRootHash: EVIDENCE_HASH_1,
        specHash: SPEC_HASH_1,
        submissionVersion: 1,
      };
    });

    it("submits final resolution and executes terminal settlement", async function () {
      const fBalBefore = await usdc.balanceOf(freelancer.address);
      const cBalBefore = await usdc.balanceOf(client.address);

      const sigA = await signFinalAuth(signerA, await primaryCommittee.getAddress(), authFinal);
      const sigC = await signFinalAuth(signerC, await primaryCommittee.getAddress(), authFinal);

      await primaryCommittee.submitFinalResolution(authFinal, sigA, sigC);

      const m = await deal.getMilestone(0);
      assert.equal(m.status, 9n); // SettledSplit

      assert.equal(await usdc.balanceOf(freelancer.address) - fBalBefore, 400_000_000n);
      assert.equal(await usdc.balanceOf(client.address) - cBalBefore, 100_000_000n);
    });

    it("final resolution split must exactly conserve milestone escrow", async function () {
      const badSplitAuth = { ...authFinal, freelancerAmount: 300_000_000n, clientAmount: 100_000_000n }; // sum 400 != 500
      const sigA = await signFinalAuth(signerA, await primaryCommittee.getAddress(), badSplitAuth);
      const sigB = await signFinalAuth(signerB, await primaryCommittee.getAddress(), badSplitAuth);

      await expectRevert(
        primaryCommittee.submitFinalResolution(badSplitAuth, sigA, sigB),
        "Split does not equal milestone amount"
      );
    });

    it("cannot reconsider or execute again after final resolution", async function () {
      const sigA = await signFinalAuth(signerA, await primaryCommittee.getAddress(), authFinal);
      const sigB = await signFinalAuth(signerB, await primaryCommittee.getAddress(), authFinal);
      await primaryCommittee.submitFinalResolution(authFinal, sigA, sigB);

      // Cannot request reconsideration
      await expectRevert(
        deal.connect(client).requestFinalReconsideration(0),
        "No active resolution proposed"
      );

      // Cannot execute resolution
      await expectRevert(
        deal.connect(thirdParty).executeResolution(0),
        "No proposed resolution to execute"
      );
    });
  });

  describe("7. Mutual Settlement Priority & Concurrency Races", function () {
    let network;
    let nowTime;

    beforeEach(async function () {
      network = await ethers.provider.getNetwork();
      nowTime = await getLatestBlockTimestamp();

      await deal.connect(freelancer).startMilestone(0);
      await deal.connect(freelancer).submitWork(0, EVIDENCE_HASH_1);
      await deal.connect(client).openSeriousDispute(0, ethers.keccak256(ethers.toUtf8Bytes("Dispute Reason")));
    });

    async function signMutualSettlement(signer, proposal) {
      const domain = {
        name: "SynqDealV1",
        version: "1",
        chainId: proposal.chainId,
        verifyingContract: proposal.dealAddress,
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
      return await signer.signTypedData(domain, types, proposal);
    }

    it("mutual settlement works while milestone is DISPUTED", async function () {
      const prop = {
        dealAddress: dealAddress,
        chainId: network.chainId,
        milestoneId: 0n,
        proposer: client.address,
        freelancerAmount: 300_000_000n,
        clientAmount: 200_000_000n,
        proposalNonce: 501n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };

      const sig = await signMutualSettlement(client, prop);
      await deal.connect(freelancer).executeMutualSettlement(prop, sig);

      const m = await deal.getMilestone(0);
      assert.equal(m.status, 9n); // SettledSplit
    });

    it("mutual settlement works during RESOLUTION_PROPOSED", async function () {
      // Primary resolver proposes first
      const auth = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        deal: dealAddress,
        milestoneId: 0n,
        freelancerAmount: 250_000_000n,
        clientAmount: 250_000_000n,
        justificationHash: JUSTIFICATION_HASH_1,
        resolutionNonce: 502n,
        validUntil: BigInt(nowTime + ONE_DAY),
        evidenceRootHash: EVIDENCE_HASH_1,
        specHash: SPEC_HASH_1,
        submissionVersion: 1,
      };
      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), auth);
      const sigB = await signProposalAuth(signerB, await primaryCommittee.getAddress(), auth);
      await primaryCommittee.submitResolutionProposal(auth, sigA, sigB);

      // Now participants execute a mutual settlement instead
      const prop = {
        dealAddress: dealAddress,
        chainId: network.chainId,
        milestoneId: 0n,
        proposer: freelancer.address,
        freelancerAmount: 350_000_000n,
        clientAmount: 150_000_000n,
        proposalNonce: 503n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };
      const sig = await signMutualSettlement(freelancer, prop);
      await deal.connect(client).executeMutualSettlement(prop, sig);

      const m = await deal.getMilestone(0);
      assert.equal(m.status, 9n); // SettledSplit

      // Stored resolver proposal can no longer execute
      await increaseTime(RECONSIDERATION_WINDOW + 10);
      await expectRevert(
        deal.connect(thirdParty).executeResolution(0),
        "No proposed resolution to execute"
      );
    });

    it("mutual settlement works during FINAL_REVIEW and invalidates final resolution", async function () {
      // 1. Proposal
      const auth = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        deal: dealAddress,
        milestoneId: 0n,
        freelancerAmount: 250_000_000n,
        clientAmount: 250_000_000n,
        justificationHash: JUSTIFICATION_HASH_1,
        resolutionNonce: 504n,
        validUntil: BigInt(nowTime + ONE_DAY),
        evidenceRootHash: EVIDENCE_HASH_1,
        specHash: SPEC_HASH_1,
        submissionVersion: 1,
      };
      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), auth);
      const sigB = await signProposalAuth(signerB, await primaryCommittee.getAddress(), auth);
      await primaryCommittee.submitResolutionProposal(auth, sigA, sigB);

      // 2. Request Reconsideration
      await deal.connect(client).requestFinalReconsideration(0);
      assert.equal((await deal.getMilestone(0)).status, 6n); // FinalReview

      // 3. Mutual Settlement executes
      const prop = {
        dealAddress: dealAddress,
        chainId: network.chainId,
        milestoneId: 0n,
        proposer: client.address,
        freelancerAmount: 280_000_000n,
        clientAmount: 220_000_000n,
        proposalNonce: 505n,
        validUntil: BigInt(nowTime + ONE_DAY),
      };
      const sig = await signMutualSettlement(client, prop);
      await deal.connect(freelancer).executeMutualSettlement(prop, sig);

      assert.equal((await deal.getMilestone(0)).status, 9n); // SettledSplit

      // 4. Subsequent final resolution submission reverts
      const authFinal = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        deal: dealAddress,
        milestoneId: 0n,
        freelancerAmount: 300_000_000n,
        clientAmount: 200_000_000n,
        justificationHash: JUSTIFICATION_HASH_FINAL,
        resolutionNonce: 506n,
        validUntil: BigInt(nowTime + ONE_DAY),
        evidenceRootHash: EVIDENCE_HASH_1,
        specHash: SPEC_HASH_1,
        submissionVersion: 1,
      };
      const fSigA = await signFinalAuth(signerA, await primaryCommittee.getAddress(), authFinal);
      const fSigB = await signFinalAuth(signerB, await primaryCommittee.getAddress(), authFinal);

      await expectRevert(
        primaryCommittee.submitFinalResolution(authFinal, fSigA, fSigB),
        "Milestone not in final review"
      );
    });

    it("deal completes after every milestone settles (including via resolver)", async function () {
      // Settle milestone 0 via resolver
      const auth = {
        committee: await primaryCommittee.getAddress(),
        chainId: network.chainId,
        deal: dealAddress,
        milestoneId: 0n,
        freelancerAmount: 250_000_000n,
        clientAmount: 250_000_000n,
        justificationHash: JUSTIFICATION_HASH_1,
        resolutionNonce: 507n,
        validUntil: BigInt(nowTime + ONE_DAY),
        evidenceRootHash: EVIDENCE_HASH_1,
        specHash: SPEC_HASH_1,
        submissionVersion: 1,
      };
      const sigA = await signProposalAuth(signerA, await primaryCommittee.getAddress(), auth);
      const sigB = await signProposalAuth(signerB, await primaryCommittee.getAddress(), auth);
      await primaryCommittee.submitResolutionProposal(auth, sigA, sigB);

      await increaseTime(RECONSIDERATION_WINDOW + 10);
      await deal.connect(thirdParty).executeResolution(0);

      // Milestone 0 settled, milestone 1 still in Draft/Pending -> Deal still Active
      assert.equal(await deal.state(), 1n); // DealState.Active

      // Now complete milestone 1 normally
      await deal.connect(freelancer).startMilestone(1);
      await deal.connect(freelancer).submitWork(1, EVIDENCE_HASH_1);
      await deal.connect(client).clientApprove(1);

      // Now EVERY milestone is terminal -> Deal is Completed
      assert.equal(await deal.state(), 2n); // DealState.Completed
    });
  });
});
