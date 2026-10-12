const assert = require("node:assert");
const { ethers } = require("hardhat");

describe("SynqFactoryV1 Phase 1B Comprehensive Test Suite", function () {
  let factory;
  let dealImplementation;
  let mockUsdc;
  let mockPrimaryResolver;
  let mockEmergencyResolver;
  let mockResolverV2;
  let mockDealImplV2;

  let owner, client, freelancer, thirdParty, newOwner;
  const ONE_DAY = 86400;
  const ONE_HOUR = 3600;

  const M1_AMOUNT = 400_000_000n; // 400 USDC (6 decimals)
  const M2_AMOUNT = 600_000_000n; // 600 USDC (6 decimals)
  const TOTAL_ESCROW = 1_000_000_000n;

  const SPEC_HASH_1 = ethers.keccak256(ethers.toUtf8Bytes("Spec 1: Core API"));
  const SPEC_HASH_2 = ethers.keccak256(ethers.toUtf8Bytes("Spec 2: UI Dashboard"));

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

  async function buildValidMilestones(count = 2) {
    const nowTime = await getLatestBlockTimestamp();
    const list = [
      {
        amount: M1_AMOUNT,
        workDeadline: BigInt(nowTime + 7 * ONE_DAY),
        reviewWindow: BigInt(3 * ONE_DAY),
        gracePeriod: BigInt(ONE_DAY),
        specHash: SPEC_HASH_1,
      },
    ];
    if (count > 1) {
      list.push({
        amount: M2_AMOUNT,
        workDeadline: BigInt(nowTime + 14 * ONE_DAY),
        reviewWindow: BigInt(3 * ONE_DAY),
        gracePeriod: BigInt(ONE_DAY),
        specHash: SPEC_HASH_2,
      });
    }
    return list;
  }

  beforeEach(async function () {
    [owner, client, freelancer, thirdParty, newOwner] = await ethers.getSigners();

    // Deploy Mock USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockUsdc = await MockERC20.deploy("USD Coin", "USDC", 6, ethers.parseUnits("1000000", 6));
    await mockUsdc.waitForDeployment();

    // Deploy SynqDealV1 Master Implementation
    const SynqDealV1 = await ethers.getContractFactory("SynqDealV1");
    dealImplementation = await SynqDealV1.deploy();
    await dealImplementation.waitForDeployment();

    // Deploy Mock Resolvers
    const MockResolver = await ethers.getContractFactory("MockResolver");
    mockPrimaryResolver = await MockResolver.deploy();
    await mockPrimaryResolver.waitForDeployment();
    mockEmergencyResolver = await MockResolver.deploy();
    await mockEmergencyResolver.waitForDeployment();

    mockResolverV2 = await MockResolver.deploy();
    await mockResolverV2.waitForDeployment();

    // Deploy alternate Deal implementation (for future update testing)
    mockDealImplV2 = await SynqDealV1.deploy();
    await mockDealImplV2.waitForDeployment();

    // Deploy SynqFactoryV1
    const SynqFactoryV1 = await ethers.getContractFactory("SynqFactoryV1");
    factory = await SynqFactoryV1.deploy(
      owner.address,
      await mockUsdc.getAddress(),
      await dealImplementation.getAddress(),
      await mockPrimaryResolver.getAddress(),
      await mockEmergencyResolver.getAddress()
    );
    await factory.waitForDeployment();

    // Fund client with mock USDC
    await mockUsdc.mint(client.address, ethers.parseUnits("50000", 6));
  });

  describe("1. Factory Deployment & Constructor Validations", function () {
    it("initializes state variables correctly", async function () {
      assert.equal(await factory.owner(), owner.address);
      assert.equal(await factory.canonicalUsdc(), await mockUsdc.getAddress());
      assert.equal(await factory.dealImplementation(), await dealImplementation.getAddress());
      assert.equal(await factory.defaultPrimaryResolver(), await mockPrimaryResolver.getAddress());
      assert.equal(await factory.defaultEmergencyResolver(), await mockEmergencyResolver.getAddress());
      assert.equal(await factory.getDealCount(), 0n);
    });

    it("rejects zero owner address", async function () {
      const SynqFactoryV1 = await ethers.getContractFactory("SynqFactoryV1");
      await expectRevert(
        SynqFactoryV1.deploy(
          ethers.ZeroAddress,
          await mockUsdc.getAddress(),
          await dealImplementation.getAddress(),
          await mockPrimaryResolver.getAddress(),
          await mockEmergencyResolver.getAddress()
        ),
        "OwnableInvalidOwner"
      );
    });

    it("rejects zero USDC address", async function () {
      const SynqFactoryV1 = await ethers.getContractFactory("SynqFactoryV1");
      await expectRevert(
        SynqFactoryV1.deploy(
          owner.address,
          ethers.ZeroAddress,
          await dealImplementation.getAddress(),
          await mockPrimaryResolver.getAddress(),
          await mockEmergencyResolver.getAddress()
        ),
        "Zero USDC address"
      );
    });

    it("rejects EOA as USDC address", async function () {
      const SynqFactoryV1 = await ethers.getContractFactory("SynqFactoryV1");
      await expectRevert(
        SynqFactoryV1.deploy(
          owner.address,
          thirdParty.address,
          await dealImplementation.getAddress(),
          await mockPrimaryResolver.getAddress(),
          await mockEmergencyResolver.getAddress()
        ),
        "USDC must be a contract"
      );
    });

    it("rejects zero deal implementation address", async function () {
      const SynqFactoryV1 = await ethers.getContractFactory("SynqFactoryV1");
      await expectRevert(
        SynqFactoryV1.deploy(
          owner.address,
          await mockUsdc.getAddress(),
          ethers.ZeroAddress,
          await mockPrimaryResolver.getAddress(),
          await mockEmergencyResolver.getAddress()
        ),
        "Zero implementation address"
      );
    });

    it("rejects EOA as deal implementation address", async function () {
      const SynqFactoryV1 = await ethers.getContractFactory("SynqFactoryV1");
      await expectRevert(
        SynqFactoryV1.deploy(
          owner.address,
          await mockUsdc.getAddress(),
          thirdParty.address,
          await mockPrimaryResolver.getAddress(),
          await mockEmergencyResolver.getAddress()
        ),
        "Implementation must be a contract"
      );
    });

    it("rejects zero primary resolver address", async function () {
      const SynqFactoryV1 = await ethers.getContractFactory("SynqFactoryV1");
      await expectRevert(
        SynqFactoryV1.deploy(
          owner.address,
          await mockUsdc.getAddress(),
          await dealImplementation.getAddress(),
          ethers.ZeroAddress,
          await mockEmergencyResolver.getAddress()
        ),
        "Zero primary resolver"
      );
    });

    it("rejects EOA as primary resolver address", async function () {
      const SynqFactoryV1 = await ethers.getContractFactory("SynqFactoryV1");
      await expectRevert(
        SynqFactoryV1.deploy(
          owner.address,
          await mockUsdc.getAddress(),
          await dealImplementation.getAddress(),
          thirdParty.address,
          await mockEmergencyResolver.getAddress()
        ),
        "Primary resolver must be a contract"
      );
    });

    it("rejects zero emergency resolver address", async function () {
      const SynqFactoryV1 = await ethers.getContractFactory("SynqFactoryV1");
      await expectRevert(
        SynqFactoryV1.deploy(
          owner.address,
          await mockUsdc.getAddress(),
          await dealImplementation.getAddress(),
          await mockPrimaryResolver.getAddress(),
          ethers.ZeroAddress
        ),
        "Zero emergency resolver"
      );
    });

    it("rejects EOA as emergency resolver address", async function () {
      const SynqFactoryV1 = await ethers.getContractFactory("SynqFactoryV1");
      await expectRevert(
        SynqFactoryV1.deploy(
          owner.address,
          await mockUsdc.getAddress(),
          await dealImplementation.getAddress(),
          await mockPrimaryResolver.getAddress(),
          thirdParty.address
        ),
        "Emergency resolver must be a contract"
      );
    });
  });

  describe("2. Deal Creation Permissions & Validations", function () {
    it("client can create a deal", async function () {
      const milestones = await buildValidMilestones();
      const tx = await factory.connect(client).createDeal(client.address, freelancer.address, milestones);
      const receipt = await tx.wait();
      assert.equal(await factory.getDealCount(), 1n);

      const dealAddr = await factory.allDeals(0);
      assert.notEqual(dealAddr, ethers.ZeroAddress);
      assert.equal(await factory.isSynqDeal(dealAddr), true);
    });

    it("freelancer can create a deal", async function () {
      const milestones = await buildValidMilestones();
      const tx = await factory.connect(freelancer).createDeal(client.address, freelancer.address, milestones);
      await tx.wait();
      assert.equal(await factory.getDealCount(), 1n);
    });

    it("unrelated third party cannot create a deal", async function () {
      const milestones = await buildValidMilestones();
      await expectRevert(
        factory.connect(thirdParty).createDeal(client.address, freelancer.address, milestones),
        "Only participant can create deal"
      );
    });

    it("rejects zero client address", async function () {
      const milestones = await buildValidMilestones();
      await expectRevert(
        factory.connect(freelancer).createDeal(ethers.ZeroAddress, freelancer.address, milestones),
        "Zero client address"
      );
    });

    it("rejects zero freelancer address", async function () {
      const milestones = await buildValidMilestones();
      await expectRevert(
        factory.connect(client).createDeal(client.address, ethers.ZeroAddress, milestones),
        "Zero freelancer address"
      );
    });

    it("rejects client equals freelancer", async function () {
      const milestones = await buildValidMilestones();
      await expectRevert(
        factory.connect(client).createDeal(client.address, client.address, milestones),
        "Client equals freelancer"
      );
    });

    it("rejects empty milestones array", async function () {
      await expectRevert(
        factory.connect(client).createDeal(client.address, freelancer.address, []),
        "Zero milestones provided"
      );
    });

    it("rejects zero-value milestone amount", async function () {
      const nowTime = await getLatestBlockTimestamp();
      const badMilestones = [
        {
          amount: 0n,
          workDeadline: BigInt(nowTime + 7 * ONE_DAY),
          reviewWindow: BigInt(3 * ONE_DAY),
          gracePeriod: BigInt(ONE_DAY),
          specHash: SPEC_HASH_1,
        },
      ];
      await expectRevert(
        factory.connect(client).createDeal(client.address, freelancer.address, badMilestones),
        "Zero milestone amount"
      );
    });
  });

  describe("3. Atomic Clone Initialization & State Isolation", function () {
    let dealContract;
    let dealAddress;

    beforeEach(async function () {
      const milestones = await buildValidMilestones();
      const tx = await factory.connect(client).createDeal(client.address, freelancer.address, milestones);
      const receipt = await tx.wait();

      dealAddress = await factory.allDeals(0);
      dealContract = await ethers.getContractAt("SynqDealV1", dealAddress);
    });

    it("clone initializes with Draft state and snapshot parameters", async function () {
      assert.equal(await dealContract.state(), 0n); // DealState.Draft
      assert.equal(await dealContract.client(), client.address);
      assert.equal(await dealContract.freelancer(), freelancer.address);
      assert.equal(await dealContract.usdc(), await mockUsdc.getAddress());
      assert.equal(await dealContract.primaryResolver(), await mockPrimaryResolver.getAddress());
      assert.equal(await dealContract.emergencyResolver(), await mockEmergencyResolver.getAddress());
      assert.equal(await dealContract.totalEscrow(), TOTAL_ESCROW);
      assert.equal(await dealContract.milestoneCount(), 2n);
      assert.equal(await dealContract.isProtected(), false);
    });

    it("clone cannot be reinitialized or hijacked", async function () {
      const milestones = await buildValidMilestones();
      const params = {
        client: thirdParty.address,
        freelancer: thirdParty.address,
        usdc: await mockUsdc.getAddress(),
        primaryResolver: await mockPrimaryResolver.getAddress(),
        emergencyResolver: await mockEmergencyResolver.getAddress(),
        isProtected: false,
        protectionModule: ethers.ZeroAddress,
        policyId: ethers.ZeroHash,
      };

      await expectRevert(
        dealContract.connect(thirdParty).initialize(params, milestones),
        "InvalidInitialization"
      );
    });

    it("clone starts unfunded and only client can fund it", async function () {
      assert.equal(await mockUsdc.balanceOf(dealAddress), 0n);

      // Freelancer cannot fund
      await mockUsdc.mint(freelancer.address, TOTAL_ESCROW);
      await mockUsdc.connect(freelancer).approve(dealAddress, TOTAL_ESCROW);
      await expectRevert(
        dealContract.connect(freelancer).fundDeal(),
        "Only client"
      );

      // Client funds successfully
      await mockUsdc.connect(client).approve(dealAddress, TOTAL_ESCROW);
      await dealContract.connect(client).fundDeal();

      assert.equal(await dealContract.state(), 1n); // DealState.Active
      assert.equal(await mockUsdc.balanceOf(dealAddress), TOTAL_ESCROW);
    });

    it("failed initialization does not register deal (atomicity)", async function () {
      const initialCount = await factory.getDealCount();
      const nowTime = await getLatestBlockTimestamp();

      // Milestone with workDeadline in past causes deal.initialize to revert
      const invalidMilestones = [
        {
          amount: M1_AMOUNT,
          workDeadline: BigInt(nowTime - 100), // in past!
          reviewWindow: BigInt(3 * ONE_DAY),
          gracePeriod: BigInt(ONE_DAY),
          specHash: SPEC_HASH_1,
        },
      ];

      await expectRevert(
        factory.connect(client).createDeal(client.address, freelancer.address, invalidMilestones),
        "Work deadline in past"
      );

      // Deal count unchanged
      assert.equal(await factory.getDealCount(), initialCount);
    });
  });

  describe("4. Registry & Discovery Queries", function () {
    let deal1Addr, deal2Addr, deal3Addr;

    beforeEach(async function () {
      const milestones = await buildValidMilestones();

      // Deal 1: client & freelancer
      const tx1 = await factory.connect(client).createDeal(client.address, freelancer.address, milestones);
      await tx1.wait();
      deal1Addr = await factory.allDeals(0);

      // Deal 2: client & thirdParty
      const tx2 = await factory.connect(client).createDeal(client.address, thirdParty.address, milestones);
      await tx2.wait();
      deal2Addr = await factory.allDeals(1);

      // Deal 3: thirdParty & freelancer
      const tx3 = await factory.connect(freelancer).createDeal(thirdParty.address, freelancer.address, milestones);
      await tx3.wait();
      deal3Addr = await factory.allDeals(2);
    });

    it("tracks global deal count and allDeals array", async function () {
      assert.equal(await factory.getDealCount(), 3n);
      assert.equal(await factory.allDeals(0), deal1Addr);
      assert.equal(await factory.allDeals(1), deal2Addr);
      assert.equal(await factory.allDeals(2), deal3Addr);
    });

    it("paginates allDeals correctly", async function () {
      const page1 = await factory.getDeals(0, 2);
      assert.equal(page1.length, 2);
      assert.equal(page1[0], deal1Addr);
      assert.equal(page1[1], deal2Addr);

      const page2 = await factory.getDeals(2, 2);
      assert.equal(page2.length, 1);
      assert.equal(page2[0], deal3Addr);

      // Offset beyond bounds
      const emptyPage = await factory.getDeals(5, 2);
      assert.equal(emptyPage.length, 0);

      // Limit 0 returns empty
      const zeroLimit = await factory.getDeals(0, 0);
      assert.equal(zeroLimit.length, 0);
    });

    it("tracks deals by client correctly with pagination", async function () {
      assert.equal(await factory.getDealsCountByClient(client.address), 2n);
      assert.equal(await factory.getDealsCountByClient(thirdParty.address), 1n);
      assert.equal(await factory.getDealsCountByClient(freelancer.address), 0n);

      const clientDeals = await factory.getDealsByClient(client.address, 0, 10);
      assert.equal(clientDeals.length, 2);
      assert.equal(clientDeals[0], deal1Addr);
      assert.equal(clientDeals[1], deal2Addr);
    });

    it("tracks deals by freelancer correctly with pagination", async function () {
      assert.equal(await factory.getDealsCountByFreelancer(freelancer.address), 2n);
      assert.equal(await factory.getDealsCountByFreelancer(thirdParty.address), 1n);
      assert.equal(await factory.getDealsCountByFreelancer(client.address), 0n);

      const freelancerDeals = await factory.getDealsByFreelancer(freelancer.address, 0, 10);
      assert.equal(freelancerDeals.length, 2);
      assert.equal(freelancerDeals[0], deal1Addr);
      assert.equal(freelancerDeals[1], deal3Addr);
    });
  });

  describe("5. Immutable Snapshot Principle & Future Configuration Updates", function () {
    let deal1Addr;

    beforeEach(async function () {
      const milestones = await buildValidMilestones();
      const tx = await factory.connect(client).createDeal(client.address, freelancer.address, milestones);
      await tx.wait();
      deal1Addr = await factory.allDeals(0);
    });

    it("updating defaultPrimaryResolver affects future deals but leaves previous deals intact", async function () {
      const deal1 = await ethers.getContractAt("SynqDealV1", deal1Addr);
      const oldResolver = await factory.defaultPrimaryResolver();
      const newResolver = await mockResolverV2.getAddress();

      // Owner updates defaultPrimaryResolver
      const tx = await factory.connect(owner).setDefaultPrimaryResolver(newResolver);
      const receipt = await tx.wait();

      // Verify event emission
      const event = receipt.logs.find((log) => {
        try {
          return factory.interface.parseLog(log).name === "PrimaryResolverUpdated";
        } catch {
          return false;
        }
      });
      assert(event, "PrimaryResolverUpdated event not emitted");
      const parsed = factory.interface.parseLog(event);
      assert.equal(parsed.args.oldResolver, oldResolver);
      assert.equal(parsed.args.newResolver, newResolver);

      // Previous deal remains unchanged
      assert.equal(await deal1.primaryResolver(), oldResolver);

      // Create new deal
      const milestones = await buildValidMilestones();
      const tx2 = await factory.connect(client).createDeal(client.address, freelancer.address, milestones);
      await tx2.wait();
      const deal2Addr = await factory.allDeals(1);
      const deal2 = await ethers.getContractAt("SynqDealV1", deal2Addr);

      // New deal snapshots new resolver
      assert.equal(await deal2.primaryResolver(), newResolver);
      // Old deal still has old resolver
      assert.equal(await deal1.primaryResolver(), oldResolver);
    });

    it("updating defaultEmergencyResolver affects future deals only", async function () {
      const deal1 = await ethers.getContractAt("SynqDealV1", deal1Addr);
      const oldResolver = await factory.defaultEmergencyResolver();
      const newResolver = await mockResolverV2.getAddress();

      await factory.connect(owner).setDefaultEmergencyResolver(newResolver);

      assert.equal(await deal1.emergencyResolver(), oldResolver);

      const milestones = await buildValidMilestones();
      await factory.connect(client).createDeal(client.address, freelancer.address, milestones);
      const deal2Addr = await factory.allDeals(1);
      const deal2 = await ethers.getContractAt("SynqDealV1", deal2Addr);

      assert.equal(await deal2.emergencyResolver(), newResolver);
      assert.equal(await deal1.emergencyResolver(), oldResolver);
    });

    it("updating dealImplementation affects future deals only", async function () {
      const oldImpl = await factory.dealImplementation();
      const newImpl = await mockDealImplV2.getAddress();

      const tx = await factory.connect(owner).setDealImplementation(newImpl);
      const receipt = await tx.wait();

      assert.equal(await factory.dealImplementation(), newImpl);

      // Event emitted
      const event = receipt.logs.find((log) => {
        try {
          return factory.interface.parseLog(log).name === "DealImplementationUpdated";
        } catch {
          return false;
        }
      });
      assert(event, "DealImplementationUpdated event not emitted");

      // Future deal clones the new implementation
      const milestones = await buildValidMilestones();
      await factory.connect(client).createDeal(client.address, freelancer.address, milestones);
      assert.equal(await factory.getDealCount(), 2n);
    });

    it("rejects unauthorized configuration update attempts", async function () {
      const newResolver = await mockResolverV2.getAddress();
      await expectRevert(
        factory.connect(thirdParty).setDefaultPrimaryResolver(newResolver),
        "OwnableUnauthorizedAccount"
      );
      await expectRevert(
        factory.connect(thirdParty).setDefaultEmergencyResolver(newResolver),
        "OwnableUnauthorizedAccount"
      );
      await expectRevert(
        factory.connect(thirdParty).setDealImplementation(await mockDealImplV2.getAddress()),
        "OwnableUnauthorizedAccount"
      );
    });

    it("rejects invalid configuration parameters", async function () {
      // Zero address
      await expectRevert(
        factory.connect(owner).setDefaultPrimaryResolver(ethers.ZeroAddress),
        "Zero primary resolver"
      );
      // EOA address
      await expectRevert(
        factory.connect(owner).setDefaultPrimaryResolver(thirdParty.address),
        "Primary resolver must be a contract"
      );
      // Identical address
      await expectRevert(
        factory.connect(owner).setDefaultPrimaryResolver(await factory.defaultPrimaryResolver()),
        "Identical primary resolver"
      );

      // Emergency resolver validations
      await expectRevert(
        factory.connect(owner).setDefaultEmergencyResolver(ethers.ZeroAddress),
        "Zero emergency resolver"
      );
      await expectRevert(
        factory.connect(owner).setDefaultEmergencyResolver(thirdParty.address),
        "Emergency resolver must be a contract"
      );
      await expectRevert(
        factory.connect(owner).setDefaultEmergencyResolver(await factory.defaultEmergencyResolver()),
        "Identical emergency resolver"
      );

      // Deal implementation validations
      await expectRevert(
        factory.connect(owner).setDealImplementation(ethers.ZeroAddress),
        "Zero implementation address"
      );
      await expectRevert(
        factory.connect(owner).setDealImplementation(thirdParty.address),
        "Implementation must be a contract"
      );
      await expectRevert(
        factory.connect(owner).setDealImplementation(await factory.dealImplementation()),
        "Identical implementation"
      );
    });
  });

  describe("6. Ownable2Step Governance Mechanics", function () {
    it("ownership transfer requires acceptance by pending owner", async function () {
      assert.equal(await factory.owner(), owner.address);

      // Step 1: initiate transfer
      await factory.connect(owner).transferOwnership(newOwner.address);
      assert.equal(await factory.pendingOwner(), newOwner.address);
      assert.equal(await factory.owner(), owner.address); // owner unchanged until acceptance

      // Third party cannot accept
      await expectRevert(
        factory.connect(thirdParty).acceptOwnership(),
        "OwnableUnauthorizedAccount"
      );

      // Step 2: pending owner accepts
      await factory.connect(newOwner).acceptOwnership();
      assert.equal(await factory.owner(), newOwner.address);
      assert.equal(await factory.pendingOwner(), ethers.ZeroAddress);

      // Old owner can no longer execute admin calls
      await expectRevert(
        factory.connect(owner).setDefaultPrimaryResolver(await mockResolverV2.getAddress()),
        "OwnableUnauthorizedAccount"
      );

      // New owner can execute admin calls
      await factory.connect(newOwner).setDefaultPrimaryResolver(await mockResolverV2.getAddress());
      assert.equal(await factory.defaultPrimaryResolver(), await mockResolverV2.getAddress());
    });
  });

  describe("7. Escrow Custody & Deal Administration Safety (Zero-Admin Invariant)", function () {
    let dealAddress;
    let dealContract;

    beforeEach(async function () {
      const milestones = await buildValidMilestones();
      await factory.connect(client).createDeal(client.address, freelancer.address, milestones);
      dealAddress = await factory.allDeals(0);
      dealContract = await ethers.getContractAt("SynqDealV1", dealAddress);

      // Fund deal
      await mockUsdc.connect(client).approve(dealAddress, TOTAL_ESCROW);
      await dealContract.connect(client).fundDeal();
    });

    it("factory holds zero balance and cannot receive funds", async function () {
      assert.equal(await mockUsdc.balanceOf(await factory.getAddress()), 0n);
    });

    it("factory has no authority over deal funds or settlement", async function () {
      // Factory address is not client, freelancer, or resolver on the deal
      const factoryAddr = await factory.getAddress();
      assert.notEqual(await dealContract.client(), factoryAddr);
      assert.notEqual(await dealContract.freelancer(), factoryAddr);
      assert.notEqual(await dealContract.primaryResolver(), factoryAddr);
      assert.notEqual(await dealContract.emergencyResolver(), factoryAddr);

      // Factory has no function to withdraw or skim from any deal
      assert.equal(typeof factory.withdraw, "undefined");
      assert.equal(typeof factory.sweep, "undefined");
      assert.equal(typeof factory.settleMilestone, "undefined");
    });
  });
});
