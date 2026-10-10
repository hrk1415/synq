// test/SynqV2Foundation.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import hre from 'hardhat';
const { ethers } = hre as any;
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  SYNQ_V2_SEPOLIA_CONFIG,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  MIN_REVIEW_WINDOW_SECONDS,
  MAX_REVIEW_WINDOW_SECONDS,
  getStandardV2Eip712Domain,
  DEAL_PROPOSAL_EIP712_TYPES,
  parseUsdcAmount,
  formatUsdcAmount,
  hashStandardV2Milestones,
  hashDealProposalV2,
  recoverDealProposalSigner,
  verifyDealProposalSignature,
  validateStandardV2ProtocolRules,
  validateStandardV2UxRules,
  buildStandardV2Proposal,
} from '../src/lib/deals/v2';
import { type DealProposalV2, type StandardV2MilestoneInit } from '../src/types/deal-v2';

describe('Synq Standard V2 Integration Foundation Test Suite', () => {
  // Test Addresses
  const TEST_CLIENT = '0xD2D4d415a4730b1490c9Ce27944529B83ff76319';
  const TEST_FREELANCER = '0xd646585Fb453be3698F6D959d796C1D86B832c04';
  const KNOWN_SMOKE_SPEC_STRING = 'Synq Standard V2 Sepolia smoke test milestone v1';
  const KNOWN_SMOKE_SPEC_HASH = '0x5a9cdabccc78e0d3288ca48b531db5de6eaa9d7709f74d43fbc5da3b7fb841b9';
  const KNOWN_SMOKE_EVIDENCE_STRING = 'Synq Standard V2 Sepolia smoke test completed';
  const KNOWN_SMOKE_EVIDENCE_HASH = '0x8412f5b24e909b4111e788bcab7eca3a2bd82800438cdef656289ce8ebd8ab1e';

  // 1. Canonical config values
  it('1. canonical V2 configuration matches audited deployment manifest exactly', () => {
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.chainId, 11155111);
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.factory.toLowerCase(), '0x9b7c5b529a420d015a85fd77040ef63b0e6cbdb0');
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.dealImplementation.toLowerCase(), '0x7e376b006db7798165a6b8e6b191e20e791e4419');
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.primaryResolver.toLowerCase(), '0xd60bbcc7c8aca633a6d158b6f7f7367e36207676');
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver.toLowerCase(), '0x5dcb412ba5f032bc9095cdc95046168a076ff952');
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc.toLowerCase(), '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238');
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.usdcDecimals, 6);
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.isProtected, false);
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.protectionModule, ZERO_ADDRESS);
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.policyId, ZERO_BYTES32);
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.eip712DomainName, 'SynqFactoryV2');
    assert.strictEqual(SYNQ_V2_SEPOLIA_CONFIG.eip712DomainVersion, '1');
  });

  // 2. EIP-712 domain
  it('2. getStandardV2Eip712Domain returns canonical domain matching contract expectations', () => {
    const domain = getStandardV2Eip712Domain();
    assert.strictEqual(domain.name, 'SynqFactoryV2');
    assert.strictEqual(domain.version, '1');
    assert.strictEqual(domain.chainId, 11155111);
    assert.strictEqual(domain.verifyingContract.toLowerCase(), SYNQ_V2_SEPOLIA_CONFIG.factory.toLowerCase());

    // Custom override support
    const customDomain = getStandardV2Eip712Domain(31337, '0x1234567890123456789012345678901234567890');
    assert.strictEqual(customDomain.chainId, 31337);
    assert.strictEqual(customDomain.verifyingContract, '0x1234567890123456789012345678901234567890');
  });

  // 3. Exact DealProposal field order and types matching DEAL_PROPOSAL_TYPEHASH
  it('3. DEAL_PROPOSAL_EIP712_TYPES matches Solidity DEAL_PROPOSAL_TYPEHASH exactly', () => {
    const fields = DEAL_PROPOSAL_EIP712_TYPES.DealProposal;
    const expectedTypeString =
      'DealProposal(address client,address freelancer,address canonicalUsdc,address dealImplementation,address primaryResolver,address emergencyResolver,bytes32 milestonesHash,bool isProtected,address protectionModule,bytes32 policyId,uint256 proposalNonce,uint256 expiry)';
    const actualTypeString = `DealProposal(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;

    assert.strictEqual(actualTypeString, expectedTypeString);
    assert.strictEqual(keccak256(toUtf8Bytes(actualTypeString)), keccak256(toUtf8Bytes(expectedTypeString)));
  });

  // 4. Milestone hashing deterministic & regression vectors
  it('4. hashStandardV2Milestones computes deterministic hashes and reproduces smoke test hashes', () => {
    // Regression vector 1: smoke test specHash
    assert.strictEqual(keccak256(toUtf8Bytes(KNOWN_SMOKE_SPEC_STRING)), KNOWN_SMOKE_SPEC_HASH);

    // Regression vector 2: smoke test evidenceRootHash
    assert.strictEqual(keccak256(toUtf8Bytes(KNOWN_SMOKE_EVIDENCE_STRING)), KNOWN_SMOKE_EVIDENCE_HASH);

    const m: StandardV2MilestoneInit = {
      amount: 1_000_000n,
      workDeadline: 1775210000n,
      reviewWindow: 86400n,
      gracePeriod: 86400n,
      specHash: KNOWN_SMOKE_SPEC_HASH as `0x${string}`,
    };

    const hash1 = hashStandardV2Milestones([m]);
    const hash2 = hashStandardV2Milestones([m]);
    assert.strictEqual(hash1, hash2);
    assert.match(hash1, /^0x[0-9a-f]{64}$/);
  });

  // 5. Milestone field mutation changes hash
  it('5. mutating any milestone field produces a completely different milestonesHash', () => {
    const base: StandardV2MilestoneInit = {
      amount: 1_000_000n,
      workDeadline: 1775210000n,
      reviewWindow: 86400n,
      gracePeriod: 86400n,
      specHash: KNOWN_SMOKE_SPEC_HASH as `0x${string}`,
    };
    const baseHash = hashStandardV2Milestones([base]);

    // Mutate amount
    assert.notStrictEqual(hashStandardV2Milestones([{ ...base, amount: 2_000_000n }]), baseHash);
    // Mutate workDeadline
    assert.notStrictEqual(hashStandardV2Milestones([{ ...base, workDeadline: 1775220000n }]), baseHash);
    // Mutate reviewWindow
    assert.notStrictEqual(hashStandardV2Milestones([{ ...base, reviewWindow: 43200n }]), baseHash);
    // Mutate gracePeriod
    assert.notStrictEqual(hashStandardV2Milestones([{ ...base, gracePeriod: 43200n }]), baseHash);
    // Mutate specHash
    assert.notStrictEqual(
      hashStandardV2Milestones([
        { ...base, specHash: '0x1111111111111111111111111111111111111111111111111111111111111111' },
      ]),
      baseHash
    );
  });

  // 6. Proposal hash deterministic
  it('6. hashDealProposalV2 computes deterministic proposalId', () => {
    const { proposal, proposalId } = buildStandardV2Proposal({
      client: TEST_CLIENT,
      freelancer: TEST_FREELANCER,
      milestones: [
        {
          amount: '1000000',
          workDeadline: 1775210000,
          reviewWindow: 86400,
          gracePeriod: 86400,
          specHash: KNOWN_SMOKE_SPEC_HASH,
        },
      ],
      proposalNonce: 0,
      expiry: 1775100000,
    });

    const hash2 = hashDealProposalV2(proposal);
    assert.strictEqual(proposalId, hash2);
    assert.match(proposalId, /^0x[0-9a-f]{64}$/);
  });

  // 7. Proposal field mutation changes proposalId
  it('7. mutating any proposal field produces a different proposalId', () => {
    const { proposal, proposalId: originalId } = buildStandardV2Proposal({
      client: TEST_CLIENT,
      freelancer: TEST_FREELANCER,
      milestones: [
        {
          amount: '1000000',
          workDeadline: 1775210000,
          reviewWindow: 86400,
          gracePeriod: 86400,
          specHash: KNOWN_SMOKE_SPEC_HASH,
        },
      ],
      proposalNonce: 0,
      expiry: 1775100000,
    });

    assert.notStrictEqual(hashDealProposalV2({ ...proposal, client: TEST_FREELANCER }), originalId);
    assert.notStrictEqual(hashDealProposalV2({ ...proposal, proposalNonce: 1n }), originalId);
    assert.notStrictEqual(hashDealProposalV2({ ...proposal, expiry: 1775100001n }), originalId);
    assert.notStrictEqual(
      hashDealProposalV2({ ...proposal, milestonesHash: '0x1111111111111111111111111111111111111111111111111111111111111111' }),
      originalId
    );
  });

  // 8. Domain changes proposalId
  it('8. changing chainId or verifyingContract in domain changes proposalId', () => {
    const { proposal, proposalId } = buildStandardV2Proposal({
      client: TEST_CLIENT,
      freelancer: TEST_FREELANCER,
      milestones: [
        {
          amount: '1000000',
          workDeadline: 1775210000,
          reviewWindow: 86400,
          gracePeriod: 86400,
          specHash: KNOWN_SMOKE_SPEC_HASH,
        },
      ],
      proposalNonce: 0,
      expiry: 1775100000,
    });

    const localDomain = getStandardV2Eip712Domain(31337);
    const idLocal = hashDealProposalV2(proposal, localDomain);
    assert.notStrictEqual(idLocal, proposalId);

    const otherContractDomain = getStandardV2Eip712Domain(11155111, '0x0000000000000000000000000000000000000001');
    const idOther = hashDealProposalV2(proposal, otherContractDomain);
    assert.notStrictEqual(idOther, proposalId);
  });

  // 9. Valid EOA signature verifies using local deterministic test wallet
  it('9. valid EOA signature verifies successfully with recoverDealProposalSigner and verifyDealProposalSignature', async () => {
    const testWallet = ethers.Wallet.createRandom();
    const clientAddr = testWallet.address.toLowerCase() as `0x${string}`;

    const { proposal } = buildStandardV2Proposal({
      client: clientAddr,
      freelancer: TEST_FREELANCER,
      milestones: [
        {
          amount: '1000000',
          workDeadline: 1775210000,
          reviewWindow: 86400,
          gracePeriod: 86400,
          specHash: KNOWN_SMOKE_SPEC_HASH,
        },
      ],
      proposalNonce: 0,
      expiry: 1775100000,
    });

    const domain = getStandardV2Eip712Domain();
    const signature = (await testWallet.signTypedData(domain, DEAL_PROPOSAL_EIP712_TYPES, proposal)) as `0x${string}`;

    const recovered = await recoverDealProposalSigner(proposal, signature, domain);
    assert.strictEqual(recovered.toLowerCase(), clientAddr);

    const isValid = await verifyDealProposalSignature(proposal, signature, domain);
    assert.strictEqual(isValid, true);
  });

  // 10. Wrong signer rejected
  it('10. signature from a different wallet is rejected', async () => {
    const actualClient = ethers.Wallet.createRandom();
    const impostorWallet = ethers.Wallet.createRandom();

    const { proposal } = buildStandardV2Proposal({
      client: actualClient.address,
      freelancer: TEST_FREELANCER,
      milestones: [
        {
          amount: '1000000',
          workDeadline: 1775210000,
          reviewWindow: 86400,
          gracePeriod: 86400,
          specHash: KNOWN_SMOKE_SPEC_HASH,
        },
      ],
      proposalNonce: 0,
      expiry: 1775100000,
    });

    const domain = getStandardV2Eip712Domain();
    // Impostor signs proposal where proposal.client is actualClient
    const impostorSig = (await impostorWallet.signTypedData(domain, DEAL_PROPOSAL_EIP712_TYPES, proposal)) as `0x${string}`;

    const isValid = await verifyDealProposalSignature(proposal, impostorSig, domain);
    assert.strictEqual(isValid, false);
  });

  // 11. Malformed signature rejected
  it('11. malformed signature is safely rejected without throwing unhandled exceptions', async () => {
    const { proposal } = buildStandardV2Proposal({
      client: TEST_CLIENT,
      freelancer: TEST_FREELANCER,
      milestones: [
        {
          amount: '1000000',
          workDeadline: 1775210000,
          reviewWindow: 86400,
          gracePeriod: 86400,
          specHash: KNOWN_SMOKE_SPEC_HASH,
        },
      ],
      proposalNonce: 0,
      expiry: 1775100000,
    });

    const malformedSig = '0x12345678' as `0x${string}`;
    const isValid = await verifyDealProposalSignature(proposal, malformedSig);
    assert.strictEqual(isValid, false);
  });

  // 12. Zero client rejected
  it('12. zero client address is rejected by protocol validation', () => {
    assert.throws(
      () =>
        buildStandardV2Proposal({
          client: ZERO_ADDRESS,
          freelancer: TEST_FREELANCER,
          milestones: [
            {
              amount: '1000000',
              workDeadline: 1775210000,
              reviewWindow: 86400,
              gracePeriod: 86400,
              specHash: KNOWN_SMOKE_SPEC_HASH,
            },
          ],
          proposalNonce: 0,
          expiry: 1775100000,
        }),
      /Client address must be a valid non-zero EVM address/
    );
  });

  // 13. Zero freelancer rejected
  it('13. zero freelancer address is rejected by protocol validation', () => {
    assert.throws(
      () =>
        buildStandardV2Proposal({
          client: TEST_CLIENT,
          freelancer: ZERO_ADDRESS,
          milestones: [
            {
              amount: '1000000',
              workDeadline: 1775210000,
              reviewWindow: 86400,
              gracePeriod: 86400,
              specHash: KNOWN_SMOKE_SPEC_HASH,
            },
          ],
          proposalNonce: 0,
          expiry: 1775100000,
        }),
      /Freelancer address must be a valid non-zero EVM address/
    );
  });

  // 14. Self-deal rejected
  it('14. self-deal (client == freelancer) is rejected by protocol validation', () => {
    assert.throws(
      () =>
        buildStandardV2Proposal({
          client: TEST_CLIENT,
          freelancer: TEST_CLIENT,
          milestones: [
            {
              amount: '1000000',
              workDeadline: 1775210000,
              reviewWindow: 86400,
              gracePeriod: 86400,
              specHash: KNOWN_SMOKE_SPEC_HASH,
            },
          ],
          proposalNonce: 0,
          expiry: 1775100000,
        }),
      /Client and Freelancer must be distinct addresses/
    );
  });

  // 15. Zero milestone amount rejected
  it('15. zero milestone amount is rejected by protocol validation', () => {
    assert.throws(
      () =>
        buildStandardV2Proposal({
          client: TEST_CLIENT,
          freelancer: TEST_FREELANCER,
          milestones: [
            {
              amount: 0,
              workDeadline: 1775210000,
              reviewWindow: 86400,
              gracePeriod: 86400,
              specHash: KNOWN_SMOKE_SPEC_HASH,
            },
          ],
          proposalNonce: 0,
          expiry: 1775100000,
        }),
      /amount must be greater than zero/
    );
  });

  // 16. Invalid review window rejected
  it('16. reviewWindow outside protocol bounds [1h, 30d] is rejected', () => {
    // Under 1 hour (e.g. 1800s = 30m)
    assert.throws(
      () =>
        buildStandardV2Proposal({
          client: TEST_CLIENT,
          freelancer: TEST_FREELANCER,
          milestones: [
            {
              amount: '1000000',
              workDeadline: 1775210000,
              reviewWindow: 1800,
              gracePeriod: 86400,
              specHash: KNOWN_SMOKE_SPEC_HASH,
            },
          ],
          proposalNonce: 0,
          expiry: 1775100000,
        }),
      /reviewWindow must be between 1 hour/
    );

    // Over 30 days (e.g. 31 days = 2678400s)
    assert.throws(
      () =>
        buildStandardV2Proposal({
          client: TEST_CLIENT,
          freelancer: TEST_FREELANCER,
          milestones: [
            {
              amount: '1000000',
              workDeadline: 1775210000,
              reviewWindow: 2678400,
              gracePeriod: 86400,
              specHash: KNOWN_SMOKE_SPEC_HASH,
            },
          ],
          proposalNonce: 0,
          expiry: 1775100000,
        }),
      /reviewWindow must be between 1 hour/
    );
  });

  // 17. Zero specHash rejected
  it('17. zero or invalid specHash is rejected', () => {
    assert.throws(
      () =>
        buildStandardV2Proposal({
          client: TEST_CLIENT,
          freelancer: TEST_FREELANCER,
          milestones: [
            {
              amount: '1000000',
              workDeadline: 1775210000,
              reviewWindow: 86400,
              gracePeriod: 86400,
              specHash: ZERO_BYTES32,
            },
          ],
          proposalNonce: 0,
          expiry: 1775100000,
        }),
      /specHash must be a non-zero bytes32 hex string/
    );
  });

  // 18. Standard Protection values enforced
  it('18. builder strictly enforces isProtected=false, zero protectionModule, and zero policyId', () => {
    const { proposal } = buildStandardV2Proposal({
      client: TEST_CLIENT,
      freelancer: TEST_FREELANCER,
      milestones: [
        {
          amount: '1000000',
          workDeadline: 1775210000,
          reviewWindow: 86400,
          gracePeriod: 86400,
          specHash: KNOWN_SMOKE_SPEC_HASH,
        },
      ],
      proposalNonce: 0,
      expiry: 1775100000,
    });

    assert.strictEqual(proposal.isProtected, false);
    assert.strictEqual(proposal.protectionModule, ZERO_ADDRESS);
    assert.strictEqual(proposal.policyId, ZERO_BYTES32);
  });

  // 19. USDC conversion exact
  it('19. parseUsdcAmount and formatUsdcAmount convert exact base units without floating-point loss', () => {
    assert.strictEqual(parseUsdcAmount('1'), 1_000_000n);
    assert.strictEqual(parseUsdcAmount('1.0'), 1_000_000n);
    assert.strictEqual(parseUsdcAmount('1.25'), 1_250_000n);
    assert.strictEqual(parseUsdcAmount('0.000001'), 1n);
    assert.strictEqual(parseUsdcAmount('100.5'), 100_500_000n);
    assert.strictEqual(parseUsdcAmount('1000000'), 1_000_000_000_000n);

    assert.strictEqual(formatUsdcAmount(1_000_000n), '1');
    assert.strictEqual(formatUsdcAmount(1_250_000n), '1.25');
    assert.strictEqual(formatUsdcAmount(1n), '0.000001');
    assert.strictEqual(formatUsdcAmount(100_500_000n), '100.5');
    assert.strictEqual(formatUsdcAmount(0n), '0');
  });

  // 20. >6 decimal USDC rejected
  it('20. parseUsdcAmount rejects amounts with more than 6 decimal places', () => {
    assert.throws(() => parseUsdcAmount('1.1234567'), /cannot exceed 6 decimal places/);
    assert.throws(() => parseUsdcAmount('0.0000001'), /cannot exceed 6 decimal places/);
  });

  // 21. No floating point usage & invalid string handling
  it('21. parseUsdcAmount rejects negatives, scientific notation, and non-numeric inputs', () => {
    assert.throws(() => parseUsdcAmount('-1'), /Invalid USDC amount format/);
    assert.throws(() => parseUsdcAmount('1e6'), /Invalid USDC amount format/);
    assert.throws(() => parseUsdcAmount('abc'), /Invalid USDC amount format/);
    assert.throws(() => parseUsdcAmount(''), /cannot be empty/);
    assert.throws(() => parseUsdcAmount('   '), /cannot be empty/);
  });

  // 22. In-Memory Hardhat Contract Parity Assertions
  it('22. TypeScript library hashes match live compiled SynqFactoryV2 contract byte-for-byte', async () => {
    // Deploy local contracts in Hardhat in-memory node (zero external RPC)
    const [deployer, clientSigner, freelancerSigner] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory('MockERC20');
    const usdc = await MockERC20.deploy('USD Coin', 'USDC', 6, 1_000_000_000n);
    await usdc.waitForDeployment();

    const DealImpl = await ethers.getContractFactory('SynqDealV1');
    const dealImpl = await DealImpl.deploy();
    await dealImpl.waitForDeployment();

    const primaryResolver = await MockERC20.deploy('Primary Resolver', 'PR', 18, 0);
    const emergencyResolver = await MockERC20.deploy('Emergency Resolver', 'ER', 18, 0);

    const FactoryV2 = await ethers.getContractFactory('SynqFactoryV2');
    const factory = await FactoryV2.deploy(
      deployer.address,
      await usdc.getAddress(),
      await dealImpl.getAddress(),
      await primaryResolver.getAddress(),
      await emergencyResolver.getAddress()
    );
    await factory.waitForDeployment();

    const factoryAddress = (await factory.getAddress()) as `0x${string}`;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);

    // 22a. Verify DEAL_PROPOSAL_TYPEHASH parity
    const onChainTypehash = await factory.DEAL_PROPOSAL_TYPEHASH();
    const tsFields = DEAL_PROPOSAL_EIP712_TYPES.DealProposal;
    const tsTypeString = `DealProposal(${tsFields.map((f) => `${f.type} ${f.name}`).join(',')})`;
    const tsComputedTypehash = keccak256(toUtf8Bytes(tsTypeString));
    assert.strictEqual(tsComputedTypehash, onChainTypehash);

    // 22b. Verify milestonesHash parity between TS helper and Factory contract
    const currentBlock = await ethers.provider.getBlock('latest');
    const currentTimestamp = BigInt(currentBlock ? currentBlock.timestamp : Math.floor(Date.now() / 1000));
    const workDeadline1 = currentTimestamp + 7n * 86400n;
    const workDeadline2 = currentTimestamp + 14n * 86400n;
    const expiry = currentTimestamp + 86400n;

    const testMilestones: StandardV2MilestoneInit[] = [
      {
        amount: 1_000_000n,
        workDeadline: workDeadline1,
        reviewWindow: 86400n,
        gracePeriod: 86400n,
        specHash: KNOWN_SMOKE_SPEC_HASH as `0x${string}`,
      },
      {
        amount: 2_500_000n,
        workDeadline: workDeadline2,
        reviewWindow: 172800n,
        gracePeriod: 43200n,
        specHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      },
    ];

    const tsMilestonesHash = hashStandardV2Milestones(testMilestones);
    const onChainMilestonesHash = await factory.hashMilestones(testMilestones);
    assert.strictEqual(tsMilestonesHash, onChainMilestonesHash);

    // 22c. Verify proposalId parity between TS helper and Factory contract
    const localProposal: DealProposalV2 = {
      client: clientSigner.address.toLowerCase() as `0x${string}`,
      freelancer: freelancerSigner.address.toLowerCase() as `0x${string}`,
      canonicalUsdc: (await usdc.getAddress()).toLowerCase() as `0x${string}`,
      dealImplementation: (await dealImpl.getAddress()).toLowerCase() as `0x${string}`,
      primaryResolver: (await primaryResolver.getAddress()).toLowerCase() as `0x${string}`,
      emergencyResolver: (await emergencyResolver.getAddress()).toLowerCase() as `0x${string}`,
      milestonesHash: tsMilestonesHash,
      isProtected: false,
      protectionModule: ZERO_ADDRESS,
      policyId: ZERO_BYTES32,
      proposalNonce: 0n,
      expiry,
    };

    const localDomain = getStandardV2Eip712Domain(chainId, factoryAddress);
    const tsProposalId = hashDealProposalV2(localProposal, localDomain);
    const onChainProposalId = await factory.hashDealProposal(localProposal);
    assert.strictEqual(tsProposalId, onChainProposalId);

    // 22d. Verify client signature generated and accepted by on-chain Factory
    const sig = await clientSigner.signTypedData(localDomain, DEAL_PROPOSAL_EIP712_TYPES, localProposal);
    const isTsValid = await verifyDealProposalSignature(localProposal, sig as `0x${string}`, localDomain);
    assert.strictEqual(isTsValid, true);

    // Fund client with USDC and approve factory
    await usdc.transfer(clientSigner.address, 10_000_000n);

    // Freelancer accepts proposal on-chain
    const deployedDeal = await factory
      .connect(freelancerSigner)
      .acceptDealProposal.staticCall(localProposal, testMilestones, sig);
    assert.match(deployedDeal, /^0x[0-9a-fA-F]{40}$/);
    assert.notStrictEqual(deployedDeal, ZERO_ADDRESS);
  });

  // 23. UX validation rules
  it('23. validateStandardV2UxRules detects past deadlines and past expiries', () => {
    const fixedNow = 1775000000;
    const { proposal, milestones } = buildStandardV2Proposal({
      client: TEST_CLIENT,
      freelancer: TEST_FREELANCER,
      milestones: [
        {
          amount: '1000000',
          workDeadline: fixedNow + 86400,
          reviewWindow: 86400,
          gracePeriod: 86400,
          specHash: KNOWN_SMOKE_SPEC_HASH,
        },
      ],
      proposalNonce: 0,
      expiry: fixedNow + 3600,
    });

    const validUx = validateStandardV2UxRules(proposal, milestones, fixedNow);
    assert.strictEqual(validUx.valid, true);

    // Simulate current time past expiry
    const expiredUx = validateStandardV2UxRules(proposal, milestones, fixedNow + 7200);
    assert.strictEqual(expiredUx.valid, false);
    assert.match(expiredUx.errors[0], /Proposal expiry/);
  });
});
