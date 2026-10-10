// scripts/verify-factory-rotation-sepolia.cjs
const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

const CANONICAL_FACTORY = '0x9b7C5B529A420d015a85fD77040eF63b0e6cbdb0';
const EXPECTED_OWNER = '0xD2D4d415a4730b1490c9Ce27944529B83ff76319';
const OLD_IMPLEMENTATION = '0x2a3C8A880398FF6DD8e6F9976c8BE6C8aBef2435';
const NEW_IMPLEMENTATION = '0x7E376b006Db7798165a6b8E6B191E20e791E4419';
const CANONICAL_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const PRIMARY_RESOLVER = '0xd60bBCc7c8aCA633A6D158B6f7F7367E36207676';
const EMERGENCY_RESOLVER = '0x5dcB412bA5f032Bc9095CDc95046168A076Ff952';
const HISTORICAL_SMOKE_DEAL_1 = '0x142Ee9d2b5B6758F4D00439f3583fDcB89309807';

const ROTATION_TX = '0x0ec636b3ee4bc007d2ff763f20235b6065fadf9c5778230cf6627b8cf5b5e561';

async function main() {
  console.log('=== PHASE 3G-D: VERIFY FACTORY ROTATION & STALE PROPOSAL SIMULATION ===\n');

  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  console.log(`Network chainId: ${chainId}`);
  if (chainId !== 11155111) {
    throw new Error(`STOP: Expected Sepolia (11155111), got ${chainId}`);
  }

  const deployerAddr = await deployer.getAddress();
  console.log(`Deployer address: ${deployerAddr}`);

  const factory = await ethers.getContractAt('SynqFactoryV2', CANONICAL_FACTORY, deployer);
  const oldDeal = await ethers.getContractAt('SynqDealV1', HISTORICAL_SMOKE_DEAL_1);

  // 1. Verify Rotation Receipt and Event
  console.log('--- 1. VERIFY ROTATION TX RECEIPT & EVENT ---');
  const receipt = await provider.getTransactionReceipt(ROTATION_TX);
  if (!receipt) {
    throw new Error(`STOP: Rotation tx ${ROTATION_TX} receipt not found!`);
  }
  console.log(`Rotation Tx: ${ROTATION_TX}`);
  console.log(`Block Number: ${receipt.blockNumber}`);
  console.log(`Gas Used: ${receipt.gasUsed.toString()}`);
  console.log(`Status: ${receipt.status === 1 ? 'SUCCESS' : 'FAILED'}`);
  if (receipt.status !== 1) {
    throw new Error('STOP: Rotation tx failed!');
  }

  const updatedEvent = receipt.logs
    .map(log => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find(parsed => parsed && parsed.name === 'DealImplementationUpdated');

  if (!updatedEvent) {
    throw new Error('STOP: DealImplementationUpdated event not found in receipt!');
  }

  const eventOldImpl = updatedEvent.args.oldImplementation || updatedEvent.args[0];
  const eventNewImpl = updatedEvent.args.newImplementation || updatedEvent.args[1];

  console.log(`Event emitted: DealImplementationUpdated`);
  console.log(`  emitter: ${receipt.to}`);
  console.log(`  oldImpl: ${eventOldImpl}`);
  console.log(`  newImpl: ${eventNewImpl}`);

  if (receipt.to.toLowerCase() !== CANONICAL_FACTORY.toLowerCase()) {
    throw new Error(`STOP: Emitter mismatch: ${receipt.to} != ${CANONICAL_FACTORY}`);
  }
  if (eventOldImpl.toLowerCase() !== OLD_IMPLEMENTATION.toLowerCase()) {
    throw new Error(`STOP: Event oldImpl mismatch: ${eventOldImpl} != ${OLD_IMPLEMENTATION}`);
  }
  if (eventNewImpl.toLowerCase() !== NEW_IMPLEMENTATION.toLowerCase()) {
    throw new Error(`STOP: Event newImpl mismatch: ${eventNewImpl} != ${NEW_IMPLEMENTATION}`);
  }
  console.log('✅ Factory rotation transaction and event verified.\n');

  // 2. Post-rotation readback
  console.log('--- 2. FACTORY POST-ROTATION READBACK ---');
  const postImpl = await factory.dealImplementation();
  const postUsdc = await factory.canonicalUsdc();
  const postPrimary = await factory.defaultPrimaryResolver();
  const postEmergency = await factory.defaultEmergencyResolver();
  const postOwner = await factory.owner();

  console.log(`dealImplementation: ${postImpl}`);
  console.log(`canonicalUsdc:      ${postUsdc}`);
  console.log(`defaultPrimary:     ${postPrimary}`);
  console.log(`defaultEmergency:   ${postEmergency}`);
  console.log(`owner:              ${postOwner}`);

  if (postImpl.toLowerCase() !== NEW_IMPLEMENTATION.toLowerCase()) {
    throw new Error(`STOP: Post-rotation dealImplementation mismatch: ${postImpl} != ${NEW_IMPLEMENTATION}`);
  }
  if (postUsdc.toLowerCase() !== CANONICAL_USDC.toLowerCase()) {
    throw new Error(`STOP: Post-rotation canonicalUsdc changed: ${postUsdc} != ${CANONICAL_USDC}`);
  }
  if (postPrimary.toLowerCase() !== PRIMARY_RESOLVER.toLowerCase()) {
    throw new Error(`STOP: Post-rotation defaultPrimaryResolver changed: ${postPrimary} != ${PRIMARY_RESOLVER}`);
  }
  if (postEmergency.toLowerCase() !== EMERGENCY_RESOLVER.toLowerCase()) {
    throw new Error(`STOP: Post-rotation defaultEmergencyResolver changed: ${postEmergency} != ${EMERGENCY_RESOLVER}`);
  }
  if (postOwner.toLowerCase() !== EXPECTED_OWNER.toLowerCase()) {
    throw new Error(`STOP: Post-rotation owner changed: ${postOwner} != ${EXPECTED_OWNER}`);
  }
  console.log('✅ Factory post-rotation readback verified: ONLY dealImplementation updated.\n');

  // 3. Verify Old Deal #1 is Unchanged
  console.log('--- 3. VERIFY HISTORICAL DEAL #1 UNCHANGED ---');
  const d1IsSynqDeal = await factory.isSynqDeal(HISTORICAL_SMOKE_DEAL_1);
  const d1Client = await oldDeal.client();
  const d1Freelancer = await oldDeal.freelancer();
  const d1Usdc = await oldDeal.usdc();
  const d1State = await oldDeal.state();
  const d1MilestoneCount = await oldDeal.milestoneCount();
  const d1TotalEscrow = await oldDeal.totalEscrow();
  const d1TotalSettled = await oldDeal.totalSettled();
  const d1Code = await provider.getCode(HISTORICAL_SMOKE_DEAL_1);

  console.log(`Deal #1 isSynqDeal: ${d1IsSynqDeal}`);
  console.log(`Deal #1 client: ${d1Client}`);
  console.log(`Deal #1 freelancer: ${d1Freelancer}`);
  console.log(`Deal #1 usdc: ${d1Usdc}`);
  console.log(`Deal #1 state: ${d1State}`);
  console.log(`Deal #1 milestoneCount: ${d1MilestoneCount}`);
  console.log(`Deal #1 totalEscrow: ${d1TotalEscrow}`);
  console.log(`Deal #1 totalSettled: ${d1TotalSettled}`);
  console.log(`Deal #1 bytecode length: ${(d1Code.length - 2) / 2} bytes`);

  if (!d1IsSynqDeal) throw new Error('STOP: Deal #1 isSynqDeal is not true!');
  if (d1Usdc.toLowerCase() !== CANONICAL_USDC.toLowerCase()) throw new Error('STOP: Deal #1 usdc mismatch!');
  if (Number(d1State) !== 2) throw new Error(`STOP: Deal #1 state mismatch, expected 2 (Completed), got ${d1State}`);
  const oldImplClean = OLD_IMPLEMENTATION.toLowerCase().replace('0x', '');
  if (!d1Code.toLowerCase().includes(oldImplClean)) {
    throw new Error('STOP: Deal #1 clone code does not contain old implementation!');
  }
  console.log('✅ Historical Deal #1 completely verified: unchanged, still recognized, still points to old implementation.\n');

  // 4. Stale Proposal Safety (Simulation)
  console.log('--- 4. STALE PROPOSAL SAFETY (SIMULATION) ---');
  const staleProposal = {
    client: '0x1111111111111111111111111111111111111111',
    freelancer: deployerAddr,
    canonicalUsdc: CANONICAL_USDC,
    dealImplementation: OLD_IMPLEMENTATION, // Old implementation!
    primaryResolver: PRIMARY_RESOLVER,
    emergencyResolver: EMERGENCY_RESOLVER,
    milestonesHash: ethers.ZeroHash,
    isProtected: false,
    protectionModule: ethers.ZeroAddress,
    policyId: ethers.ZeroHash,
    proposalNonce: 999999n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
  };

  const dummyMilestones = [
    {
      amount: 500000n,
      workDeadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
      reviewWindow: 86400n,
      gracePeriod: 0n,
      specHash: ethers.keccak256(ethers.toUtf8Bytes('milestone-0'))
    }
  ];

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encodedMilestones = abiCoder.encode(
    ['tuple(uint256 amount, uint64 workDeadline, uint64 reviewWindow, uint64 gracePeriod, bytes32 specHash)[]'],
    [dummyMilestones]
  );
  staleProposal.milestonesHash = ethers.keccak256(encodedMilestones);

  const dummySig = '0x' + '11'.repeat(65);

  try {
    await factory.acceptDealProposal.staticCall(staleProposal, dummyMilestones, dummySig);
    throw new Error('STOP: Stale proposal simulation unexpectedly succeeded!');
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('Deal implementation mismatch')) {
      console.log('✅ Stale proposal correctly rejected with: "Deal implementation mismatch"');
    } else {
      console.log(`Revert message: ${msg}`);
      if (!msg.includes('Deal implementation mismatch')) {
        throw new Error(`STOP: Expected revert reason "Deal implementation mismatch", got: ${msg}`);
      }
    }
  }

  // Write rotation artifact
  const rotationData = {
    rotationTx: ROTATION_TX,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    oldImpl: OLD_IMPLEMENTATION,
    newImpl: NEW_IMPLEMENTATION,
    factory: CANONICAL_FACTORY
  };
  fs.writeFileSync(path.join(__dirname, '..', 'scratch', 'factory-rotation-receipt.json'), JSON.stringify(rotationData, null, 2));

  console.log('\n=== VERIFICATION STEPS 6-10 COMPLETED SUCCESSFULLY ===');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
