const assert = require('node:assert');
const { ethers } = require('hardhat');

describe('SynqFactoryV2 Freelancer Consent & Proposal Lifecycle', function () {
  let deployer, client, freelancer, freelancer2, attacker, pendingOwner;
  let usdc, dealImpl, primaryResolver, emergencyResolver;
  let factoryV2;
  let chainId;

  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

  const ProposalStatus = {
    Pending: 0,
    Accepted: 1,
    Declined: 2,
    Cancelled: 3,
    Expired: 4,
  };

  const DEAL_PROPOSAL_TYPE = {
    DealProposal: [
      { name: 'client', type: 'address' },
      { name: 'freelancer', type: 'address' },
      { name: 'canonicalUsdc', type: 'address' },
      { name: 'dealImplementation', type: 'address' },
      { name: 'primaryResolver', type: 'address' },
      { name: 'emergencyResolver', type: 'address' },
      { name: 'milestonesHash', type: 'bytes32' },
      { name: 'isProtected', type: 'bool' },
      { name: 'protectionModule', type: 'address' },
      { name: 'policyId', type: 'bytes32' },
      { name: 'proposalNonce', type: 'uint256' },
      { name: 'expiry', type: 'uint256' },
    ],
  };

  async function expectRevert(promise, expectedReason) {
    try {
      const tx = await promise;
      if (tx && typeof tx.wait === 'function') {
        await tx.wait();
      }
      assert.fail(`Expected transaction to revert with "${expectedReason || ''}", but it succeeded`);
    } catch (err) {
      if (err.message.includes('Expected transaction to revert')) {
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

  beforeEach(async function () {
    [deployer, client, freelancer, freelancer2, attacker, pendingOwner] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

    // Deploy Mock USDC
    const MockERC20 = await ethers.getContractFactory('MockERC20');
    usdc = await MockERC20.deploy('USD Coin', 'USDC', 6, ethers.parseUnits('1000000', 6));
    await usdc.waitForDeployment();

    // Deploy SynqDealV1 implementation
    const DealImpl = await ethers.getContractFactory('SynqDealV1');
    dealImpl = await DealImpl.deploy();
    await dealImpl.waitForDeployment();

    // Deploy Resolvers as Mock Contracts
    primaryResolver = await MockERC20.deploy('Primary Resolver Placeholder', 'PRP', 18, 0);
    emergencyResolver = await MockERC20.deploy('Emergency Resolver Placeholder', 'ERP', 18, 0);

    // Deploy SynqFactoryV2
    const FactoryV2 = await ethers.getContractFactory('SynqFactoryV2');
    factoryV2 = await FactoryV2.deploy(
      deployer.address,
      await usdc.getAddress(),
      await dealImpl.getAddress(),
      await primaryResolver.getAddress(),
      await emergencyResolver.getAddress()
    );
    await factoryV2.waitForDeployment();

    // Fund client with USDC
    await usdc.transfer(client.address, 100000000n); // 100 USDC
  });

  function computeMilestonesHash(milestoneInits) {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encoded = abiCoder.encode(
      ['tuple(uint256 amount,uint64 workDeadline,uint64 reviewWindow,uint64 gracePeriod,bytes32 specHash)[]'],
      [milestoneInits]
    );
    return ethers.keccak256(encoded);
  }

  async function createValidProposalParams(overrides = {}) {
    const block = await ethers.provider.getBlock('latest');
    const now = BigInt(block.timestamp);

    const milestoneInits = overrides.milestones || [
      {
        amount: 1000000n, // 1 USDC
        workDeadline: now + 86400n * 7n,
        reviewWindow: 86400n, // 24h
        gracePeriod: 86400n,
        specHash: ethers.id('Milestone 1 Deliverable Spec'),
      },
    ];

    const milestonesHash = overrides.milestonesHash !== undefined
      ? overrides.milestonesHash
      : computeMilestonesHash(milestoneInits);

    const proposal = {
      client: overrides.client !== undefined ? overrides.client : client.address,
      freelancer: overrides.freelancer !== undefined ? overrides.freelancer : freelancer.address,
      canonicalUsdc: overrides.canonicalUsdc !== undefined ? overrides.canonicalUsdc : (await usdc.getAddress()),
      dealImplementation: overrides.dealImplementation !== undefined ? overrides.dealImplementation : (await dealImpl.getAddress()),
      primaryResolver: overrides.primaryResolver !== undefined ? overrides.primaryResolver : (await primaryResolver.getAddress()),
      emergencyResolver: overrides.emergencyResolver !== undefined ? overrides.emergencyResolver : (await emergencyResolver.getAddress()),
      milestonesHash: milestonesHash,
      isProtected: overrides.isProtected !== undefined ? overrides.isProtected : false,
      protectionModule: overrides.protectionModule !== undefined ? overrides.protectionModule : ZERO_ADDRESS,
      policyId: overrides.policyId !== undefined ? overrides.policyId : ZERO_BYTES32,
      proposalNonce: overrides.proposalNonce !== undefined ? overrides.proposalNonce : 1n,
      expiry: overrides.expiry !== undefined ? overrides.expiry : now + 86400n * 3n,
    };

    return { proposal, milestoneInits };
  }

  async function signProposal(signer, factoryContract, proposal) {
    const domain = {
      name: 'SynqFactoryV2',
      version: '1',
      chainId: chainId,
      verifyingContract: await factoryContract.getAddress(),
    };
    return signer.signTypedData(domain, DEAL_PROPOSAL_TYPE, proposal);
  }

  describe('1. Happy Path: Proposal Signing & Acceptance', function () {
    it('freelancer accepts valid client proposal, creating Deal in Draft', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams();
      const signature = await signProposal(client, factoryV2, proposal);

      const proposalId = await factoryV2.hashDealProposal(proposal);

      // Check initial status is Pending
      const statusBefore = await factoryV2.getProposalStatus(proposal);
      assert.equal(statusBefore, ProposalStatus.Pending);

      // Freelancer accepts
      const tx = await factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature);
      await tx.wait();

      // Check proposal status is Accepted
      const statusAfter = await factoryV2.getProposalStatus(proposal);
      assert.equal(statusAfter, ProposalStatus.Accepted);
      assert.equal(await factoryV2.isProposalNonceUsed(client.address, proposal.proposalNonce), true);

      // Extract deal address
      const dealAddress = await factoryV2.allDeals(0);
      assert.notEqual(dealAddress, ZERO_ADDRESS);
      assert.equal(await factoryV2.isSynqDeal(dealAddress), true);
      assert.equal(await factoryV2.getDealCount(), 1n);

      // Inspect created deal state
      const Deal = await ethers.getContractFactory('SynqDealV1');
      const deal = Deal.attach(dealAddress);

      assert.equal(await deal.client(), client.address);
      assert.equal(await deal.freelancer(), freelancer.address);
      assert.equal(await deal.usdc(), await usdc.getAddress());
      assert.equal(await deal.primaryResolver(), await primaryResolver.getAddress());
      assert.equal(await deal.emergencyResolver(), await emergencyResolver.getAddress());
      assert.equal(await deal.totalEscrow(), 1000000n);
      assert.equal(await deal.state(), 0); // DealState.Draft

      // Client can now fund the deal
      await usdc.connect(client).approve(dealAddress, 1000000n);
      const fundTx = await deal.connect(client).fundDeal();
      await fundTx.wait();

      assert.equal(await deal.state(), 1); // DealState.Active
    });
  });

  describe('2. Nonce Model & Sibling Proposals (One Client Nonce = One Slot Invariant)', function () {
    it('sibling proposals sharing a nonce: accept Proposal A invalidates Proposal B', async function () {
      // Proposal A for Freelancer 1
      const { proposal: propA, milestoneInits: mInitsA } = await createValidProposalParams({
        freelancer: freelancer.address,
        proposalNonce: 7n,
      });
      // Proposal B for Freelancer 2 (same client, same nonce, different freelancer)
      const { proposal: propB, milestoneInits: mInitsB } = await createValidProposalParams({
        freelancer: freelancer2.address,
        proposalNonce: 7n,
      });

      const sigA = await signProposal(client, factoryV2, propA);
      const sigB = await signProposal(client, factoryV2, propB);

      // Before any action, both report Pending
      assert.equal(await factoryV2.getProposalStatus(propA), ProposalStatus.Pending);
      assert.equal(await factoryV2.getProposalStatus(propB), ProposalStatus.Pending);

      // Freelancer 1 accepts Proposal A
      await (await factoryV2.connect(freelancer).acceptDealProposal(propA, mInitsA, sigA)).wait();

      // Proposal A is Accepted
      assert.equal(await factoryV2.getProposalStatus(propA), ProposalStatus.Accepted);

      // Proposal B view status is Cancelled (NOT Pending) because nonce 7 is consumed!
      assert.equal(await factoryV2.getProposalStatus(propB), ProposalStatus.Cancelled);

      // Freelancer 2 attempts to accept Proposal B -> REVERTS
      await expectRevert(
        factoryV2.connect(freelancer2).acceptDealProposal(propB, mInitsB, sigB),
        'Proposal nonce already used'
      );

      // Exactly ONE deal exists
      assert.equal(await factoryV2.getDealCount(), 1n);
    });

    it('sibling proposals sharing a nonce: decline Proposal A invalidates Proposal B', async function () {
      const { proposal: propA } = await createValidProposalParams({
        freelancer: freelancer.address,
        proposalNonce: 8n,
      });
      const { proposal: propB, milestoneInits: mInitsB } = await createValidProposalParams({
        freelancer: freelancer2.address,
        proposalNonce: 8n,
      });

      const sigA = await signProposal(client, factoryV2, propA);
      const sigB = await signProposal(client, factoryV2, propB);

      // Freelancer 1 declines Proposal A
      await (await factoryV2.connect(freelancer).declineDealProposal(propA, sigA)).wait();

      assert.equal(await factoryV2.getProposalStatus(propA), ProposalStatus.Declined);
      assert.equal(await factoryV2.getProposalStatus(propB), ProposalStatus.Cancelled);

      // Freelancer 2 cannot accept Proposal B
      await expectRevert(
        factoryV2.connect(freelancer2).acceptDealProposal(propB, mInitsB, sigB),
        'Proposal nonce already used'
      );
    });

    it('sibling proposals sharing a nonce: cancel Proposal A invalidates Proposal B', async function () {
      const { proposal: propA } = await createValidProposalParams({
        freelancer: freelancer.address,
        proposalNonce: 9n,
      });
      const { proposal: propB, milestoneInits: mInitsB } = await createValidProposalParams({
        freelancer: freelancer2.address,
        proposalNonce: 9n,
      });

      const sigB = await signProposal(client, factoryV2, propB);

      // Client cancels Proposal A
      await (await factoryV2.connect(client).cancelDealProposal(propA)).wait();

      assert.equal(await factoryV2.getProposalStatus(propA), ProposalStatus.Cancelled);
      assert.equal(await factoryV2.getProposalStatus(propB), ProposalStatus.Cancelled);

      // Freelancer 2 cannot accept Proposal B
      await expectRevert(
        factoryV2.connect(freelancer2).acceptDealProposal(propB, mInitsB, sigB),
        'Proposal nonce already used'
      );
    });

    it('direct nonce cancellation invalidates all proposals sharing that nonce', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams({ proposalNonce: 77n });
      const signature = await signProposal(client, factoryV2, proposal);

      await (await factoryV2.connect(client).cancelProposalNonce(77n)).wait();

      assert.equal(await factoryV2.getProposalStatus(proposal), ProposalStatus.Cancelled);

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature),
        'Proposal nonce already used'
      );
    });
  });

  describe('3. Complete Configuration Commitment & Governance Rotation Defenses', function () {
    it('signed proposal bounds dealImplementation: owner rotation blocks stale acceptance', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams({ proposalNonce: 101n });
      const signature = await signProposal(client, factoryV2, proposal);

      // Owner rotates dealImplementation to a new contract
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const newImpl = await MockERC20.deploy('New Impl', 'NI', 18, 0);
      await newImpl.waitForDeployment();

      await (await factoryV2.connect(deployer).setDealImplementation(await newImpl.getAddress())).wait();

      // Freelancer attempts acceptance -> REVERTS with Deal implementation mismatch
      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature),
        'Deal implementation mismatch'
      );
    });

    it('signed proposal bounds primaryResolver: owner rotation blocks stale acceptance', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams({ proposalNonce: 102n });
      const signature = await signProposal(client, factoryV2, proposal);

      // Owner rotates defaultPrimaryResolver
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const newPrimary = await MockERC20.deploy('New Primary', 'NP', 18, 0);
      await newPrimary.waitForDeployment();

      await (await factoryV2.connect(deployer).setDefaultPrimaryResolver(await newPrimary.getAddress())).wait();

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature),
        'Primary resolver mismatch'
      );
    });

    it('signed proposal bounds emergencyResolver: owner rotation blocks stale acceptance', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams({ proposalNonce: 103n });
      const signature = await signProposal(client, factoryV2, proposal);

      // Owner rotates defaultEmergencyResolver
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const newEmergency = await MockERC20.deploy('New Emergency', 'NE', 18, 0);
      await newEmergency.waitForDeployment();

      await (await factoryV2.connect(deployer).setDefaultEmergencyResolver(await newEmergency.getAddress())).wait();

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature),
        'Emergency resolver mismatch'
      );
    });
  });

  describe('4. Expiry Boundary & Status View Precedence', function () {
    it('exact boundary: accepts at expiry, reverts at expiry + 1', async function () {
      const block = await ethers.provider.getBlock('latest');
      const current = BigInt(block.timestamp);
      const targetExpiry = current + 100n;

      const { proposal, milestoneInits } = await createValidProposalParams({
        proposalNonce: 201n,
        expiry: targetExpiry,
      });
      const signature = await signProposal(client, factoryV2, proposal);

      // Set next block timestamp to targetExpiry
      await ethers.provider.send('evm_setNextBlockTimestamp', [Number(targetExpiry)]);
      await ethers.provider.send('evm_mine', []);

      // At timestamp == expiry: getProposalStatus is still Pending
      assert.equal(await factoryV2.getProposalStatus(proposal), ProposalStatus.Pending);

      // Advance by 1 second: timestamp > expiry
      await ethers.provider.send('evm_setNextBlockTimestamp', [Number(targetExpiry + 1n)]);
      await ethers.provider.send('evm_mine', []);

      // At timestamp == expiry + 1: getProposalStatus is Expired
      assert.equal(await factoryV2.getProposalStatus(proposal), ProposalStatus.Expired);

      // Acceptance reverts
      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature),
        'Proposal expired'
      );
    });

    it('terminal status takes precedence over derived expiry', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams({ proposalNonce: 202n });
      const signature = await signProposal(client, factoryV2, proposal);

      // Accept proposal
      await (await factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature)).wait();

      // Fast forward past expiry
      await ethers.provider.send('evm_increaseTime', [86400 * 10]);
      await ethers.provider.send('evm_mine', []);

      // Must remain Accepted, NOT Expired!
      assert.equal(await factoryV2.getProposalStatus(proposal), ProposalStatus.Accepted);
    });

    it('declined status takes precedence over derived expiry', async function () {
      const { proposal } = await createValidProposalParams({ proposalNonce: 203n });
      const signature = await signProposal(client, factoryV2, proposal);

      await (await factoryV2.connect(freelancer).declineDealProposal(proposal, signature)).wait();

      await ethers.provider.send('evm_increaseTime', [86400 * 10]);
      await ethers.provider.send('evm_mine', []);

      assert.equal(await factoryV2.getProposalStatus(proposal), ProposalStatus.Declined);
    });

    it('cancelled status takes precedence over derived expiry', async function () {
      const { proposal } = await createValidProposalParams({ proposalNonce: 204n });
      await (await factoryV2.connect(client).cancelDealProposal(proposal)).wait();

      await ethers.provider.send('evm_increaseTime', [86400 * 10]);
      await ethers.provider.send('evm_mine', []);

      assert.equal(await factoryV2.getProposalStatus(proposal), ProposalStatus.Cancelled);
    });
  });

  describe('5. Milestone Hash Canonicalization: JS vs Solidity', function () {
    it('JS keccak256(abi.encode(milestones)) matches Solidity hashMilestones byte-for-byte', async function () {
      const block = await ethers.provider.getBlock('latest');
      const now = BigInt(block.timestamp);

      const milestones = [
        {
          amount: 500000n,
          workDeadline: now + 86400n * 3n,
          reviewWindow: 86400n,
          gracePeriod: 3600n,
          specHash: ethers.id('Milestone 1'),
        },
        {
          amount: 1500000n,
          workDeadline: now + 86400n * 10n,
          reviewWindow: 172800n,
          gracePeriod: 7200n,
          specHash: ethers.id('Milestone 2'),
        },
      ];

      const jsHash = computeMilestonesHash(milestones);
      const onChainHash = await factoryV2.hashMilestones(milestones);

      assert.equal(jsHash, onChainHash, 'JS milestone hash must equal Solidity hashMilestones');
    });
  });

  describe('6. Fund Isolation & Legacy Bypass Defenses', function () {
    it('accept, decline, and cancel move ZERO funds', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams({ proposalNonce: 301n });
      const signature = await signProposal(client, factoryV2, proposal);

      const balanceBefore = await usdc.balanceOf(client.address);
      const factoryBalanceBefore = await usdc.balanceOf(await factoryV2.getAddress());

      const tx = await factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature);
      await tx.wait();

      const dealAddress = await factoryV2.allDeals(0);

      // Zero USDC moved
      assert.equal(await usdc.balanceOf(client.address), balanceBefore);
      assert.equal(await usdc.balanceOf(await factoryV2.getAddress()), factoryBalanceBefore);
      assert.equal(await usdc.balanceOf(dealAddress), 0n);

      // Deal is in Draft
      const Deal = await ethers.getContractFactory('SynqDealV1');
      const deal = Deal.attach(dealAddress);
      assert.equal(await deal.state(), 0); // Draft
    });

    it('legacy createDeal reverts for ALL callers (client, freelancer, owner, attacker)', async function () {
      const m = [{
        amount: 1000000n,
        workDeadline: BigInt((await ethers.provider.getBlock('latest')).timestamp + 86400),
        reviewWindow: 86400n,
        gracePeriod: 0n,
        specHash: ethers.id('X'),
      }];

      for (const caller of [client, freelancer, deployer, attacker]) {
        await expectRevert(
          factoryV2.connect(caller).createDeal(client.address, freelancer.address, m),
          'Direct creation disabled: use acceptDealProposal'
        );
      }
    });

    it('legacy createProtectedDeal reverts for ALL callers', async function () {
      const m = [{
        amount: 1000000n,
        workDeadline: BigInt((await ethers.provider.getBlock('latest')).timestamp + 86400),
        reviewWindow: 86400n,
        gracePeriod: 0n,
        specHash: ethers.id('X'),
      }];

      for (const caller of [client, freelancer, deployer, attacker]) {
        await expectRevert(
          factoryV2.connect(caller).createProtectedDeal(client.address, freelancer.address, m),
          'Direct creation disabled: use acceptDealProposal'
        );
      }
    });
  });

  describe('7. Signature Edge Cases & Malleability', function () {
    it('empty signature reverts', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams({ proposalNonce: 401n });

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, '0x'),
        'ECDSAInvalidSignatureLength'
      );
    });

    it('malformed signature length reverts', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams({ proposalNonce: 402n });

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, '0x1234'),
        'ECDSAInvalidSignatureLength'
      );
    });

    it('wrong signer reverts with Invalid client signature', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams({ proposalNonce: 403n });
      // Attacker signs instead of client
      const signature = await signProposal(attacker, factoryV2, proposal);

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature),
        'Invalid client signature'
      );
    });
  });

  describe('8. Replay Protection & Comprehensive Parameter Tampering', function () {
    it('same proposal cannot be accepted twice', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams({ proposalNonce: 501n });
      const signature = await signProposal(client, factoryV2, proposal);

      await (await factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature)).wait();

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature),
        'Proposal not pending'
      );
    });

    it('same signature against a different factory deployment fails', async function () {
      const FactoryV2 = await ethers.getContractFactory('SynqFactoryV2');
      const factory2 = await FactoryV2.deploy(
        deployer.address,
        await usdc.getAddress(),
        await dealImpl.getAddress(),
        await primaryResolver.getAddress(),
        await emergencyResolver.getAddress()
      );
      await factory2.waitForDeployment();

      const { proposal, milestoneInits } = await createValidProposalParams({ proposalNonce: 502n });
      const signature = await signProposal(client, factoryV2, proposal);

      await expectRevert(
        factory2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature),
        'Invalid client signature'
      );
    });

    it('tampered freelancer address reverts', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams();
      const signature = await signProposal(client, factoryV2, proposal);

      const tamperedProposal = { ...proposal, freelancer: attacker.address };

      await expectRevert(
        factoryV2.connect(attacker).acceptDealProposal(tamperedProposal, milestoneInits, signature),
        'Invalid client signature'
      );
    });

    it('tampered client address reverts', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams();
      const signature = await signProposal(client, factoryV2, proposal);

      const tamperedProposal = { ...proposal, client: attacker.address };

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(tamperedProposal, milestoneInits, signature),
        'Invalid client signature'
      );
    });

    it('tampered proposal nonce reverts', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams({ proposalNonce: 503n });
      const signature = await signProposal(client, factoryV2, proposal);

      const tamperedProposal = { ...proposal, proposalNonce: 504n };

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(tamperedProposal, milestoneInits, signature),
        'Invalid client signature'
      );
    });

    it('tampered canonicalUsdc address reverts', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams();
      const signature = await signProposal(client, factoryV2, proposal);

      const tamperedProposal = { ...proposal, canonicalUsdc: attacker.address };

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(tamperedProposal, milestoneInits, signature),
        'Invalid canonical USDC'
      );
    });

    it('tampered milestone amount reverts with hash mismatch', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams();
      const signature = await signProposal(client, factoryV2, proposal);

      const tamperedMilestones = [{ ...milestoneInits[0], amount: 2000000n }];

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, tamperedMilestones, signature),
        'Milestones hash mismatch'
      );
    });

    it('tampered milestone deadline reverts with hash mismatch', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams();
      const signature = await signProposal(client, factoryV2, proposal);

      const tamperedMilestones = [{ ...milestoneInits[0], workDeadline: milestoneInits[0].workDeadline + 3600n }];

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, tamperedMilestones, signature),
        'Milestones hash mismatch'
      );
    });

    it('tampered reviewWindow reverts with hash mismatch', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams();
      const signature = await signProposal(client, factoryV2, proposal);

      const tamperedMilestones = [{ ...milestoneInits[0], reviewWindow: 172800n }];

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, tamperedMilestones, signature),
        'Milestones hash mismatch'
      );
    });

    it('tampered gracePeriod reverts with hash mismatch', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams();
      const signature = await signProposal(client, factoryV2, proposal);

      const tamperedMilestones = [{ ...milestoneInits[0], gracePeriod: 0n }];

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, tamperedMilestones, signature),
        'Milestones hash mismatch'
      );
    });

    it('tampered specHash reverts with hash mismatch', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams();
      const signature = await signProposal(client, factoryV2, proposal);

      const tamperedMilestones = [{ ...milestoneInits[0], specHash: ethers.id('Fake Spec') }];

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, tamperedMilestones, signature),
        'Milestones hash mismatch'
      );
    });

    it('reordered milestones revert with hash mismatch', async function () {
      const block = await ethers.provider.getBlock('latest');
      const now = BigInt(block.timestamp);

      const m1 = {
        amount: 1000000n,
        workDeadline: now + 86400n * 7n,
        reviewWindow: 86400n,
        gracePeriod: 86400n,
        specHash: ethers.id('M1'),
      };
      const m2 = {
        amount: 2000000n,
        workDeadline: now + 86400n * 14n,
        reviewWindow: 86400n,
        gracePeriod: 86400n,
        specHash: ethers.id('M2'),
      };

      const { proposal } = await createValidProposalParams({ milestones: [m1, m2] });
      const signature = await signProposal(client, factoryV2, proposal);

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, [m2, m1], signature),
        'Milestones hash mismatch'
      );
    });

    it('appended milestone reverts with hash mismatch', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams();
      const signature = await signProposal(client, factoryV2, proposal);

      const block = await ethers.provider.getBlock('latest');
      const now = BigInt(block.timestamp);
      const extraMilestone = {
        amount: 500000n,
        workDeadline: now + 86400n * 2n,
        reviewWindow: 86400n,
        gracePeriod: 86400n,
        specHash: ethers.id('Extra'),
      };

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, [...milestoneInits, extraMilestone], signature),
        'Milestones hash mismatch'
      );
    });

    it('unauthorized Standard -> Protected substitution reverts', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams({ isProtected: true });
      const signature = await signProposal(client, factoryV2, proposal);

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature),
        'Protection module not configured'
      );
    });

    it('standard proposal with non-zero protection module reverts', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams({
        isProtected: false,
        protectionModule: attacker.address,
      });
      const signature = await signProposal(client, factoryV2, proposal);

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature),
        'Non-zero protection module in standard proposal'
      );
    });
  });

  describe('9. Malicious Actor & Authorization Boundaries', function () {
    it('attacker cannot accept someone else proposal', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams();
      const signature = await signProposal(client, factoryV2, proposal);

      await expectRevert(
        factoryV2.connect(attacker).acceptDealProposal(proposal, milestoneInits, signature),
        'Only designated freelancer can accept'
      );
    });

    it('client cannot accept their own proposal', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams();
      const signature = await signProposal(client, factoryV2, proposal);

      await expectRevert(
        factoryV2.connect(client).acceptDealProposal(proposal, milestoneInits, signature),
        'Only designated freelancer can accept'
      );
    });

    it('attacker cannot decline someone else proposal', async function () {
      const { proposal } = await createValidProposalParams();
      const signature = await signProposal(client, factoryV2, proposal);

      await expectRevert(
        factoryV2.connect(attacker).declineDealProposal(proposal, signature),
        'Only designated freelancer can decline'
      );
    });

    it('attacker cannot cancel client proposal', async function () {
      const { proposal } = await createValidProposalParams();

      await expectRevert(
        factoryV2.connect(attacker).cancelDealProposal(proposal),
        'Only client can cancel'
      );
    });

    it('freelancer cannot cancel client proposal', async function () {
      const { proposal } = await createValidProposalParams();

      await expectRevert(
        factoryV2.connect(freelancer).cancelDealProposal(proposal),
        'Only client can cancel'
      );
    });

    it('decline with invalid client signature reverts', async function () {
      const { proposal } = await createValidProposalParams();
      const fakeSignature = await signProposal(attacker, factoryV2, proposal);

      await expectRevert(
        factoryV2.connect(freelancer).declineDealProposal(proposal, fakeSignature),
        'Invalid client signature'
      );
    });

    it('self-deal (client == freelancer) reverts', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams({
        client: client.address,
        freelancer: client.address,
      });
      const signature = await signProposal(client, factoryV2, proposal);

      await expectRevert(
        factoryV2.connect(client).acceptDealProposal(proposal, milestoneInits, signature),
        'Client equals freelancer'
      );
    });

    it('zero client address reverts', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams({ client: ZERO_ADDRESS });
      const signature = await signProposal(client, factoryV2, proposal);

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature),
        'Zero client address'
      );
    });

    it('zero freelancer address reverts', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams({ freelancer: ZERO_ADDRESS });
      const signature = await signProposal(client, factoryV2, proposal);

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature),
        'Only designated freelancer can accept'
      );
    });

    it('zero milestone amount reverts', async function () {
      const block = await ethers.provider.getBlock('latest');
      const now = BigInt(block.timestamp);
      const invalidMilestone = {
        amount: 0n,
        workDeadline: now + 86400n * 7n,
        reviewWindow: 86400n,
        gracePeriod: 86400n,
        specHash: ethers.id('Zero Amount'),
      };

      const { proposal, milestoneInits } = await createValidProposalParams({ milestones: [invalidMilestone] });
      const signature = await signProposal(client, factoryV2, proposal);

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature),
        'Zero milestone amount'
      );
    });

    it('review window under 1 hour reverts', async function () {
      const block = await ethers.provider.getBlock('latest');
      const now = BigInt(block.timestamp);
      const invalidMilestone = {
        amount: 1000000n,
        workDeadline: now + 86400n * 7n,
        reviewWindow: 1800n,
        gracePeriod: 86400n,
        specHash: ethers.id('Short Review'),
      };

      const { proposal, milestoneInits } = await createValidProposalParams({ milestones: [invalidMilestone] });
      const signature = await signProposal(client, factoryV2, proposal);

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature),
        'Invalid review window'
      );
    });

    it('zero specHash reverts', async function () {
      const block = await ethers.provider.getBlock('latest');
      const now = BigInt(block.timestamp);
      const invalidMilestone = {
        amount: 1000000n,
        workDeadline: now + 86400n * 7n,
        reviewWindow: 86400n,
        gracePeriod: 86400n,
        specHash: ZERO_BYTES32,
      };

      const { proposal, milestoneInits } = await createValidProposalParams({ milestones: [invalidMilestone] });
      const signature = await signProposal(client, factoryV2, proposal);

      await expectRevert(
        factoryV2.connect(freelancer).acceptDealProposal(proposal, milestoneInits, signature),
        'Zero specHash'
      );
    });
  });

  describe('10. Governance Boundaries in Factory V2', function () {
    it('owner can update defaults for future deals', async function () {
      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const newResolver = await MockERC20.deploy('R2', 'R2', 18, 0);
      await newResolver.waitForDeployment();

      const tx = await factoryV2.connect(deployer).setDefaultPrimaryResolver(await newResolver.getAddress());
      await tx.wait();

      assert.equal(await factoryV2.defaultPrimaryResolver(), await newResolver.getAddress());
    });

    it('non-owner cannot update defaults', async function () {
      await expectRevert(
        factoryV2.connect(attacker).setDefaultPrimaryResolver(attacker.address),
        'OwnableUnauthorizedAccount'
      );
    });

    it('owner cannot accept, decline, or cancel participant proposals', async function () {
      const { proposal, milestoneInits } = await createValidProposalParams();
      const signature = await signProposal(client, factoryV2, proposal);

      await expectRevert(
        factoryV2.connect(deployer).acceptDealProposal(proposal, milestoneInits, signature),
        'Only designated freelancer can accept'
      );

      await expectRevert(
        factoryV2.connect(deployer).declineDealProposal(proposal, signature),
        'Only designated freelancer can decline'
      );

      await expectRevert(
        factoryV2.connect(deployer).cancelDealProposal(proposal),
        'Only client can cancel'
      );
    });
  });
});
