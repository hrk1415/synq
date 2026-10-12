// scripts/rotate-and-verify-factory-sepolia.cjs
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

async function main() {
  console.log('=== PHASE 3G-D STEP 6-10: FACTORY ROTATION & VERIFICATION ===\n');

  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  console.log(`Network chainId: ${chainId}`);
  if (chainId !== 11155111) {
    throw new Error(`STOP: Expected Sepolia (11155111), got ${chainId}`);
  }

  const deployerAddr = await deployer.getAddress();
  console.log(`Deployer / Owner address: ${deployerAddr}`);
  if (deployerAddr.toLowerCase() !== EXPECTED_OWNER.toLowerCase()) {
    throw new Error(`STOP: Deployer ${deployerAddr} does not match expected owner ${EXPECTED_OWNER}`);
  }

  const factory = await ethers.getContractAt('SynqFactoryV2', CANONICAL_FACTORY, deployer);
  const oldDeal = await ethers.getContractAt('SynqDealV1', HISTORICAL_SMOKE_DEAL_1);

  // =========================================================================
  // STEP 6: FACTORY ROTATION PREFLIGHT
  // =========================================================================
  console.log('--- STEP 6: FACTORY ROTATION PREFLIGHT ---');
  const factoryOwner = await factory.owner();
  const currentImpl = await factory.dealImplementation();
  const currentUsdc = await factory.canonicalUsdc();
  const currentPrimary = await factory.defaultPrimaryResolver();
  const currentEmergency = await factory.defaultEmergencyResolver();

  console.log(`Factory owner: ${factoryOwner}`);
  console.log(`Current dealImplementation: ${currentImpl}`);
  console.log(`Canonical USDC: ${currentUsdc}`);
  console.log(`Default primary resolver: ${currentPrimary}`);
  console.log(`Default emergency resolver: ${currentEmergency}`);

  if (factoryOwner.toLowerCase() !== EXPECTED_OWNER.toLowerCase()) {
    throw new Error(`STOP: Factory owner mismatch: ${factoryOwner} != ${EXPECTED_OWNER}`);
  }
  if (currentImpl.toLowerCase() !== OLD_IMPLEMENTATION.toLowerCase()) {
    throw new Error(`STOP: Current implementation mismatch: ${currentImpl} != ${OLD_IMPLEMENTATION}`);
  }
  if (NEW_IMPLEMENTATION.toLowerCase() === OLD_IMPLEMENTATION.toLowerCase()) {
    throw new Error('STOP: New implementation equals old implementation');
  }

  const newImplCode = await provider.getCode(NEW_IMPLEMENTATION);
  if (newImplCode === '0x' || newImplCode.length <= 2) {
    throw new Error(`STOP: New implementation ${NEW_IMPLEMENTATION} has no code`);
  }
  console.log('✅ Factory rotation preflight passed.\n');

  // =========================================================================
  // STEP 9 (PRE-CHECK): RECORD HISTORICAL DEAL #1 STATE BEFORE ROTATION
  // =========================================================================
  console.log('--- STEP 9 (PRE-CHECK): INSPECTING HISTORICAL DEAL #1 ---');
  const d1IsSynqDealPre = await factory.isSynqDeal(HISTORICAL_SMOKE_DEAL_1);
  const d1ClientPre = await oldDeal.client();
  const d1FreelancerPre = await oldDeal.freelancer();
  const d1UsdcPre = await oldDeal.usdc();
  const d1StatePre = await oldDeal.state();
  const d1MilestoneCountPre = await oldDeal.milestoneCount();
  const d1TotalEscrowPre = await oldDeal.totalEscrow();
  const d1TotalSettledPre = await oldDeal.totalSettled();
  const d1CodePre = await provider.getCode(HISTORICAL_SMOKE_DEAL_1);

  console.log(`Deal #1 isSynqDeal: ${d1IsSynqDealPre}`);
  console.log(`Deal #1 client: ${d1ClientPre}`);
  console.log(`Deal #1 freelancer: ${d1FreelancerPre}`);
  console.log(`Deal #1 usdc: ${d1UsdcPre}`);
  console.log(`Deal #1 state: ${d1StatePre}`);
  console.log(`Deal #1 milestoneCount: ${d1MilestoneCountPre}`);
  console.log(`Deal #1 totalEscrow: ${d1TotalEscrowPre}`);
  console.log(`Deal #1 totalSettled: ${d1TotalSettledPre}`);
  console.log(`Deal #1 bytecode length: ${(d1CodePre.length - 2) / 2} bytes`);

  // Verify ERC-1167 target implementation inside clone bytecode
  const oldImplClean = OLD_IMPLEMENTATION.toLowerCase().replace('0x', '');
  if (!d1CodePre.toLowerCase().includes(oldImplClean)) {
    throw new Error(`STOP: Deal #1 clone code does not contain old implementation ${OLD_IMPLEMENTATION}`);
  }
  console.log(`✅ Deal #1 clone delegates to old implementation: 0x${oldImplClean}\n`);

  // =========================================================================
  // STEP 7: ROTATE FACTORY
  // =========================================================================
  console.log('--- STEP 7: ROTATING FACTORY IMPLEMENTATION ---');
  console.log(`Calling factory.setDealImplementation(${NEW_IMPLEMENTATION})...`);

  const tx = await factory.setDealImplementation(NEW_IMPLEMENTATION);
  console.log(`Transaction broadcast: ${tx.hash}`);
  console.log('Waiting for confirmation...');
  const receipt = await tx.wait(1);
  console.log(`Transaction confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}`);

  // Find DealImplementationUpdated event
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
  console.log(`  oldImpl: ${eventOldImpl}`);
  console.log(`  newImpl: ${eventNewImpl}`);

  if (eventOldImpl.toLowerCase() !== OLD_IMPLEMENTATION.toLowerCase()) {
    throw new Error(`STOP: Event oldImpl mismatch: ${eventOldImpl} != ${OLD_IMPLEMENTATION}`);
  }
  if (eventNewImpl.toLowerCase() !== NEW_IMPLEMENTATION.toLowerCase()) {
    throw new Error(`STOP: Event newImpl mismatch: ${eventNewImpl} != ${NEW_IMPLEMENTATION}`);
  }
  console.log('✅ Factory rotation transaction and event verified successfully.\n');

  // =========================================================================
  // STEP 8: FACTORY POST-ROTATION READBACK
  // =========================================================================
  console.log('--- STEP 8: FACTORY POST-ROTATION READBACK ---');
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
  console.log('✅ Factory post-rotation readback confirmed: ONLY dealImplementation changed.\n');

  // =========================================================================
  // STEP 9 (POST-CHECK): VERIFY OLD DEAL #1 IS UNCHANGED
  // =========================================================================
  console.log('--- STEP 9 (POST-CHECK): VERIFYING OLD DEAL #1 UNCHANGED ---');
  const d1IsSynqDealPost = await factory.isSynqDeal(HISTORICAL_SMOKE_DEAL_1);
  const d1ClientPost = await oldDeal.client();
  const d1FreelancerPost = await oldDeal.freelancer();
  const d1UsdcPost = await oldDeal.usdc();
  const d1StatePost = await oldDeal.state();
  const d1MilestoneCountPost = await oldDeal.milestoneCount();
  const d1TotalEscrowPost = await oldDeal.totalEscrow();
  const d1TotalSettledPost = await oldDeal.totalSettled();
  const d1CodePost = await provider.getCode(HISTORICAL_SMOKE_DEAL_1);

  if (d1IsSynqDealPost !== d1IsSynqDealPre) throw new Error('STOP: Deal #1 isSynqDeal changed!');
  if (d1ClientPost !== d1ClientPre) throw new Error('STOP: Deal #1 client changed!');
  if (d1FreelancerPost !== d1FreelancerPre) throw new Error('STOP: Deal #1 freelancer changed!');
  if (d1UsdcPost !== d1UsdcPre) throw new Error('STOP: Deal #1 usdc changed!');
  if (d1StatePost !== d1StatePre) throw new Error('STOP: Deal #1 state changed!');
  if (d1MilestoneCountPost !== d1MilestoneCountPre) throw new Error('STOP: Deal #1 milestoneCount changed!');
  if (d1TotalEscrowPost !== d1TotalEscrowPre) throw new Error('STOP: Deal #1 totalEscrow changed!');
  if (d1TotalSettledPost !== d1TotalSettledPre) throw new Error('STOP: Deal #1 totalSettled changed!');
  if (d1CodePost !== d1CodePre) throw new Error('STOP: Deal #1 runtime code changed!');
  if (!d1CodePost.toLowerCase().includes(oldImplClean)) {
    throw new Error('STOP: Deal #1 no longer delegates to old implementation!');
  }
  console.log('✅ Old Deal #1 verified completely unchanged and still delegating to old implementation.\n');

  // =========================================================================
  // STEP 10: STALE PROPOSAL SAFETY (SIMULATION)
  // =========================================================================
  console.log('--- STEP 10: STALE PROPOSAL SAFETY (SIMULATION) ---');
  // Construct a proposal targeting the OLD implementation
  // We set freelancer to deployerAddr so msg.sender matches proposal.freelancer
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
      paymentWindow: 0n,
      specHash: ethers.keccak256(ethers.toUtf8Bytes('milestone-0'))
    }
  ];
  // Calculate matching milestonesHash
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encodedMilestones = abiCoder.encode(
    ['tuple(uint256 amount, uint64 workDeadline, uint64 reviewWindow, uint64 paymentWindow, bytes32 specHash)[]'],
    [dummyMilestones]
  );
  staleProposal.milestonesHash = ethers.keccak256(encodedMilestones);

  const dummySig = '0x' + '11'.repeat(65);

  try {
    await factory.acceptDealProposal.staticCall(staleProposal, dummyMilestones, dummySig);
    throw new Error('STOP: Stale proposal simulation unexpectedly succeeded!');
  } catch (err) {
    if (err.message.includes('Deal implementation mismatch')) {
      console.log('✅ Stale proposal correctly rejected with: "Deal implementation mismatch"');
    } else {
      console.log(`✅ Stale proposal rejected: ${err.message}`);
      if (!err.message.includes('Deal implementation mismatch') && !err.data?.includes('Deal implementation mismatch')) {
        throw new Error(`STOP: Expected revert reason "Deal implementation mismatch", got: ${err.message}`);
      }
    }
  }

  // Save rotation receipt data to scratch
  const rotationData = {
    rotationTx: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    oldImpl: OLD_IMPLEMENTATION,
    newImpl: NEW_IMPLEMENTATION,
    factory: CANONICAL_FACTORY
  };
  fs.writeFileSync(path.join(__dirname, '..', 'scratch', 'factory-rotation-receipt.json'), JSON.stringify(rotationData, null, 2));

  console.log('\n=== STEPS 6-10 COMPLETE: ALL PASS ===');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
