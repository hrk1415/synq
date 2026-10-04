// scripts/smoke-v2-sequential-deal2.cjs
const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

const CANONICAL_FACTORY = '0x9b7C5B529A420d015a85fD77040eF63b0e6cbdb0';
const CANONICAL_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const PRIMARY_RESOLVER = '0xd60bBCc7c8aCA633A6D158B6f7F7367E36207676';
const EMERGENCY_RESOLVER = '0x5dcB412bA5f032Bc9095CDc95046168A076Ff952';
const NEW_IMPLEMENTATION = '0x7E376b006Db7798165a6b8E6B191E20e791E4419';

// Read env for freelancer key
const envPath = path.join(__dirname, '..', '.env.local');
let freelancerKey = null;
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.replace(/\r$/, '').match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m && m[1] === 'SEPOLIA_FREELANCER_PRIVATE_KEY') {
      freelancerKey = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

async function main() {
  console.log('=== PHASE 3G-D: SMOKE DEAL #2 SEQUENTIAL VERIFICATION ===\n');

  const provider = ethers.provider;
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId !== 11155111) {
    throw new Error(`STOP: Expected Sepolia chainId 11155111, got ${chainId}`);
  }

  const [clientSigner] = await ethers.getSigners();
  const clientAddr = await clientSigner.getAddress();

  if (!freelancerKey) {
    throw new Error('STOP: Missing SEPOLIA_FREELANCER_PRIVATE_KEY in .env.local');
  }
  const freelancerSigner = new ethers.Wallet(freelancerKey, provider);
  const freelancerAddr = await freelancerSigner.getAddress();

  console.log(`Client:     ${clientAddr}`);
  console.log(`Freelancer: ${freelancerAddr}`);

  const factory = await ethers.getContractAt('SynqFactoryV2', CANONICAL_FACTORY, clientSigner);
  const factoryFreelancer = factory.connect(freelancerSigner);

  const erc20Abi = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address, address) view returns (uint256)',
    'function approve(address, uint256) returns (bool)'
  ];
  const usdc = new ethers.Contract(CANONICAL_USDC, erc20Abi, clientSigner);

  // Read current factory implementation
  const currentImpl = await factory.dealImplementation();
  console.log(`Factory current implementation: ${currentImpl}`);
  if (currentImpl.toLowerCase() !== NEW_IMPLEMENTATION.toLowerCase()) {
    throw new Error(`STOP: Factory implementation ${currentImpl} does not match expected ${NEW_IMPLEMENTATION}`);
  }

  const results = {
    steps: {},
    txs: []
  };

  // =========================================================================
  // STEP 13: CREATE FRESH SMOKE PROPOSAL
  // =========================================================================
  console.log('\n--- STEP 13: CREATE FRESH SMOKE PROPOSAL ---');

  // Find unused nonce
  let proposalNonce = 100n;
  while (await factory.usedClientNonces(clientAddr, proposalNonce)) {
    proposalNonce += 1n;
  }
  console.log(`Using proposalNonce: ${proposalNonce}`);

  const latestBlock = await provider.getBlock('latest');
  const now = latestBlock.timestamp;
  const expiry = BigInt(now + 86400 * 3); // 3 days expiry

  const specHash0 = ethers.keccak256(ethers.toUtf8Bytes('Synq Sequential Smoke Milestone 0'));
  const specHash1 = ethers.keccak256(ethers.toUtf8Bytes('Synq Sequential Smoke Milestone 1'));

  const milestones = [
    {
      amount: 500000n, // 0.50 USDC
      workDeadline: BigInt(now + 86400 * 7),
      reviewWindow: 86400n, // 1 day
      gracePeriod: 0n,
      specHash: specHash0
    },
    {
      amount: 500000n, // 0.50 USDC
      workDeadline: BigInt(now + 86400 * 14),
      reviewWindow: 86400n, // 1 day
      gracePeriod: 0n,
      specHash: specHash1
    }
  ];

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encodedMilestones = abiCoder.encode(
    ['tuple(uint256 amount, uint64 workDeadline, uint64 reviewWindow, uint64 gracePeriod, bytes32 specHash)[]'],
    [milestones]
  );
  const milestonesHash = ethers.keccak256(encodedMilestones);
  console.log(`Milestones Hash: ${milestonesHash}`);

  const proposal = {
    client: clientAddr,
    freelancer: freelancerAddr,
    canonicalUsdc: CANONICAL_USDC,
    dealImplementation: NEW_IMPLEMENTATION,
    primaryResolver: PRIMARY_RESOLVER,
    emergencyResolver: EMERGENCY_RESOLVER,
    milestonesHash: milestonesHash,
    isProtected: false,
    protectionModule: ethers.ZeroAddress,
    policyId: ethers.ZeroHash,
    proposalNonce: proposalNonce,
    expiry: expiry
  };

  // Sign EIP-712 proposal with client
  const domain = {
    name: 'SynqFactoryV2',
    version: '1',
    chainId: chainId,
    verifyingContract: CANONICAL_FACTORY
  };

  const types = {
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
      { name: 'expiry', type: 'uint256' }
    ]
  };

  const clientSignature = await clientSigner.signTypedData(domain, types, proposal);
  console.log(`Client signature generated.`);

  const proposalId = await factory.hashDealProposal(proposal);
  console.log(`Fresh Proposal ID: ${proposalId}`);
  results.proposalId = proposalId;
  results.proposalImplementation = NEW_IMPLEMENTATION;

  // =========================================================================
  // STEP 14: ACCEPT FRESH PROPOSAL (FREELANCER)
  // =========================================================================
  console.log('\n--- STEP 14: ACCEPT FRESH PROPOSAL ---');
  console.log('Broadcasting factory.acceptDealProposal from freelancer...');
  const acceptTx = await factoryFreelancer.acceptDealProposal(proposal, milestones, clientSignature);
  console.log(`Accept Tx: ${acceptTx.hash}`);
  const acceptReceipt = await acceptTx.wait(1);
  console.log(`Confirmed in block ${acceptReceipt.blockNumber}, gas used: ${acceptReceipt.gasUsed.toString()}`);
  results.acceptTx = acceptTx.hash;
  results.txs.push({ name: 'acceptDealProposal', hash: acceptTx.hash, gas: acceptReceipt.gasUsed.toString() });

  // Extract DealProposalAccepted event
  const acceptedLog = acceptReceipt.logs
    .map(log => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find(p => p && p.name === 'DealProposalAccepted');

  if (!acceptedLog) {
    throw new Error('STOP: DealProposalAccepted event not found in receipt!');
  }

  const dealAddress = acceptedLog.args.dealAddress || acceptedLog.args[1];
  console.log(`Smoke Deal #2 Address: ${dealAddress}`);
  results.dealAddress = dealAddress;

  // Verify factory.isSynqDeal
  const isSynq = await factory.isSynqDeal(dealAddress);
  console.log(`factory.isSynqDeal(SmokeDeal2): ${isSynq}`);
  if (!isSynq) throw new Error('STOP: factory.isSynqDeal returned false!');

  // Verify clone points to NEW_IMPLEMENTATION
  const cloneCode = await provider.getCode(dealAddress);
  const cleanNewImpl = NEW_IMPLEMENTATION.toLowerCase().replace('0x', '');
  console.log(`Smoke Deal #2 bytecode length: ${(cloneCode.length - 2) / 2} bytes`);
  if (!cloneCode.toLowerCase().includes(cleanNewImpl)) {
    throw new Error(`STOP: Smoke Deal #2 does not delegate to new sequential implementation ${NEW_IMPLEMENTATION}`);
  }
  console.log(`✅ Smoke Deal #2 clone verified delegating to ${NEW_IMPLEMENTATION}`);

  // Attach deal contract
  const deal = await ethers.getContractAt('SynqDealV1Sequential', dealAddress, clientSigner);
  const dealFreelancer = deal.connect(freelancerSigner);

  // =========================================================================
  // STEP 15: VERIFY NEW DEAL INITIALIZATION
  // =========================================================================
  console.log('\n--- STEP 15: VERIFY NEW DEAL INITIALIZATION ---');
  const dClient = await deal.client();
  const dFreelancer = await deal.freelancer();
  const dUsdc = await deal.usdc();
  const dState = await deal.state();
  const dTotalEscrow = await deal.totalEscrow();
  const dMilestoneCount = await deal.milestoneCount();
  const dPrimary = await deal.primaryResolver();
  const dEmergency = await deal.emergencyResolver();
  const dProtected = await deal.isProtected();

  console.log(`deal.client:            ${dClient}`);
  console.log(`deal.freelancer:        ${dFreelancer}`);
  console.log(`deal.usdc:              ${dUsdc}`);
  console.log(`deal.state:             ${dState} (0 = Draft)`);
  console.log(`deal.totalEscrow:       ${dTotalEscrow} (1,000,000 base units)`);
  console.log(`deal.milestoneCount:    ${dMilestoneCount}`);
  console.log(`deal.primaryResolver:   ${dPrimary}`);
  console.log(`deal.emergencyResolver: ${dEmergency}`);
  console.log(`deal.isProtected:       ${dProtected}`);

  if (dClient.toLowerCase() !== clientAddr.toLowerCase()) throw new Error('Client mismatch');
  if (dFreelancer.toLowerCase() !== freelancerAddr.toLowerCase()) throw new Error('Freelancer mismatch');
  if (dUsdc.toLowerCase() !== CANONICAL_USDC.toLowerCase()) throw new Error('USDC mismatch');
  if (Number(dState) !== 0) throw new Error('State not Draft (0)');
  if (dTotalEscrow !== 1000000n) throw new Error('Total escrow not 1,000,000');
  if (Number(dMilestoneCount) !== 2) throw new Error('Milestone count not 2');
  if (dPrimary.toLowerCase() !== PRIMARY_RESOLVER.toLowerCase()) throw new Error('Primary resolver mismatch');
  if (dEmergency.toLowerCase() !== EMERGENCY_RESOLVER.toLowerCase()) throw new Error('Emergency resolver mismatch');
  if (dProtected !== false) throw new Error('Protected not false');

  const m0 = await deal.getMilestone(0);
  const m1 = await deal.getMilestone(1);
  if (m0.amount !== 500000n || m1.amount !== 500000n) throw new Error('Milestone amounts mismatch');
  if (m0.amount + m1.amount !== dTotalEscrow) throw new Error('Milestone sum != totalEscrow');
  console.log('✅ Initialization verified completely.');

  // =========================================================================
  // STEP 16: FUND SMOKE DEAL #2
  // =========================================================================
  console.log('\n--- STEP 16: FUND SMOKE DEAL #2 ---');
  const currentAllowance = await usdc.allowance(clientAddr, dealAddress);
  console.log(`Current USDC allowance: ${currentAllowance}`);
  if (currentAllowance < 1000000n) {
    console.log(`Approving exact 1,000,000 base units (1.00 USDC) to ${dealAddress}...`);
    const appTx = await usdc.approve(dealAddress, 1000000n);
    console.log(`Approve Tx: ${appTx.hash}`);
    const appReceipt = await appTx.wait(1);
    console.log(`Approve confirmed in block ${appReceipt.blockNumber}, gas used: ${appReceipt.gasUsed.toString()}`);
    results.approveTx = appTx.hash;
    results.txs.push({ name: 'usdc.approve', hash: appTx.hash, gas: appReceipt.gasUsed.toString() });
  }

  console.log('Broadcasting deal.fundDeal() from client...');
  const fundTx = await deal.fundDeal();
  console.log(`Fund Tx: ${fundTx.hash}`);
  const fundReceipt = await fundTx.wait(1);
  console.log(`Fund confirmed in block ${fundReceipt.blockNumber}, gas used: ${fundReceipt.gasUsed.toString()}`);
  results.fundTx = fundTx.hash;
  results.txs.push({ name: 'fundDeal', hash: fundTx.hash, gas: fundReceipt.gasUsed.toString() });

  const fundEvent = fundReceipt.logs
    .map(log => {
      try {
        return deal.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find(p => p && p.name === 'DealFunded');

  if (!fundEvent) throw new Error('STOP: DealFunded event missing!');
  console.log('✅ DealFunded event verified.');

  const stateAfterFund = await deal.state();
  const dealUsdcBal = await usdc.balanceOf(dealAddress);
  console.log(`State after funding: ${stateAfterFund} (1 = Active)`);
  console.log(`Deal USDC Balance:   ${dealUsdcBal} (expected 1,000,000)`);
  if (Number(stateAfterFund) !== 1) throw new Error('State not Active');
  if (dealUsdcBal !== 1000000n) throw new Error('Deal USDC balance != 1,000,000');

  // =========================================================================
  // STEP 17: CRITICAL SEQUENTIAL NEGATIVE TEST (SIMULATION)
  // =========================================================================
  console.log('\n--- STEP 17: CRITICAL SEQUENTIAL NEGATIVE TEST ---');
  console.log('Simulating startMilestone(1) before milestone 0 has started...');
  try {
    await dealFreelancer.startMilestone.staticCall(1);
    throw new Error('FATAL STOP: startMilestone(1) simulation unexpectedly SUCCEEDED before milestone 0!');
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('Preceding milestone not settled')) {
      console.log('✅ Simulation correctly REVERTED: "Preceding milestone not settled"');
      results.preStartNegativeSimulationReverted = true;
    } else {
      console.log(`Simulation reverted with: ${msg}`);
      if (!msg.includes('Preceding milestone not settled')) {
        throw new Error(`STOP: Expected "Preceding milestone not settled", got: ${msg}`);
      }
    }
  }

  // =========================================================================
  // STEP 18: START MILESTONE 0
  // =========================================================================
  console.log('\n--- STEP 18: START MILESTONE 0 ---');
  console.log('Broadcasting startMilestone(0) from freelancer...');
  const start0Tx = await dealFreelancer.startMilestone(0);
  console.log(`Start Milestone 0 Tx: ${start0Tx.hash}`);
  const start0Receipt = await start0Tx.wait(1);
  console.log(`Confirmed in block ${start0Receipt.blockNumber}, gas used: ${start0Receipt.gasUsed.toString()}`);
  results.start0Tx = start0Tx.hash;
  results.txs.push({ name: 'startMilestone(0)', hash: start0Tx.hash, gas: start0Receipt.gasUsed.toString() });

  const m0Status = (await deal.getMilestone(0)).status;
  const m1Status = (await deal.getMilestone(1)).status;
  const dealState18 = await deal.state();
  console.log(`Milestone 0 status: ${m0Status} (1 = InProgress)`);
  console.log(`Milestone 1 status: ${m1Status} (0 = Pending)`);
  console.log(`Deal state:         ${dealState18} (1 = Active)`);
  if (Number(m0Status) !== 1) throw new Error('Milestone 0 not InProgress');
  if (Number(m1Status) !== 0) throw new Error('Milestone 1 not Pending');
  if (Number(dealState18) !== 1) throw new Error('Deal state not Active');

  // =========================================================================
  // STEP 19: CRITICAL PARALLEL NEGATIVE TEST (SIMULATION)
  // =========================================================================
  console.log('\n--- STEP 19: CRITICAL PARALLEL NEGATIVE TEST ---');
  console.log('Simulating startMilestone(1) while milestone 0 is InProgress...');
  try {
    await dealFreelancer.startMilestone.staticCall(1);
    throw new Error('FATAL STOP: startMilestone(1) simulation SUCCEEDED while milestone 0 is InProgress!');
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('Preceding milestone not settled')) {
      console.log('✅ Parallel start simulation correctly REVERTED: "Preceding milestone not settled"');
      results.parallelNegativeSimulationReverted = true;
    } else {
      console.log(`Simulation reverted with: ${msg}`);
      if (!msg.includes('Preceding milestone not settled')) {
        throw new Error(`STOP: Expected "Preceding milestone not settled", got: ${msg}`);
      }
    }
  }

  // =========================================================================
  // STEP 20: COMPLETE MILESTONE 0
  // =========================================================================
  console.log('\n--- STEP 20: COMPLETE MILESTONE 0 ---');
  const evidence0 = ethers.keccak256(ethers.toUtf8Bytes('Milestone 0 smoke deliverable verified'));
  console.log('Broadcasting submitWork(0) from freelancer...');
  const submit0Tx = await dealFreelancer.submitWork(0, evidence0);
  console.log(`Submit 0 Tx: ${submit0Tx.hash}`);
  const submit0Receipt = await submit0Tx.wait(1);
  console.log(`Confirmed in block ${submit0Receipt.blockNumber}, gas used: ${submit0Receipt.gasUsed.toString()}`);
  results.submit0Tx = submit0Tx.hash;
  results.txs.push({ name: 'submitWork(0)', hash: submit0Tx.hash, gas: submit0Receipt.gasUsed.toString() });

  const m0StatusSubmitted = (await deal.getMilestone(0)).status;
  console.log(`Milestone 0 status: ${m0StatusSubmitted} (2 = Submitted)`);
  if (Number(m0StatusSubmitted) !== 2) throw new Error('Milestone 0 not Submitted');

  console.log('Broadcasting clientApprove(0) from client...');
  const approve0Tx = await deal.clientApprove(0);
  console.log(`Approve 0 Tx: ${approve0Tx.hash}`);
  const approve0Receipt = await approve0Tx.wait(1);
  console.log(`Confirmed in block ${approve0Receipt.blockNumber}, gas used: ${approve0Receipt.gasUsed.toString()}`);
  results.approve0Tx = approve0Tx.hash;
  results.txs.push({ name: 'clientApprove(0)', hash: approve0Tx.hash, gas: approve0Receipt.gasUsed.toString() });

  const m0StatusSettled = (await deal.getMilestone(0)).status;
  const totalSettled20 = await deal.totalSettled();
  const dealState20 = await deal.state();
  const dealUsdcBal20 = await usdc.balanceOf(dealAddress);

  console.log(`Milestone 0 status: ${m0StatusSettled} (7 = SettledPaid)`);
  console.log(`Total settled:      ${totalSettled20} (500,000 base units)`);
  console.log(`Deal state:         ${dealState20} (1 = Active)`);
  console.log(`Deal USDC balance:  ${dealUsdcBal20} (500,000 base units)`);

  if (Number(m0StatusSettled) !== 7) throw new Error('Milestone 0 not SettledPaid');
  if (totalSettled20 !== 500000n) throw new Error('totalSettled != 500,000');
  if (Number(dealState20) !== 1) throw new Error('Deal state not Active');
  if (dealUsdcBal20 !== 500000n) throw new Error('USDC balance != 500,000');
  console.log('✅ Milestone 0 settled paid; Deal remains Active.');

  // =========================================================================
  // STEP 21: VERIFY MILESTONE 1 UNLOCKS & START IT
  // =========================================================================
  console.log('\n--- STEP 21: VERIFY MILESTONE 1 UNLOCKS & START ---');
  console.log('Simulating startMilestone(1) now that milestone 0 is SettledPaid...');
  try {
    await dealFreelancer.startMilestone.staticCall(1);
    console.log('✅ Simulation SUCCEEDED: milestone 1 is officially unlocked!');
    results.milestone1UnlockSimulationSucceeded = true;
  } catch (err) {
    throw new Error(`STOP: startMilestone(1) simulation failed after milestone 0 settlement: ${err.message}`);
  }

  console.log('Broadcasting startMilestone(1) from freelancer...');
  const start1Tx = await dealFreelancer.startMilestone(1);
  console.log(`Start Milestone 1 Tx: ${start1Tx.hash}`);
  const start1Receipt = await start1Tx.wait(1);
  console.log(`Confirmed in block ${start1Receipt.blockNumber}, gas used: ${start1Receipt.gasUsed.toString()}`);
  results.start1Tx = start1Tx.hash;
  results.txs.push({ name: 'startMilestone(1)', hash: start1Tx.hash, gas: start1Receipt.gasUsed.toString() });

  const m1StatusStarted = (await deal.getMilestone(1)).status;
  console.log(`Milestone 1 status: ${m1StatusStarted} (1 = InProgress)`);
  if (Number(m1StatusStarted) !== 1) throw new Error('Milestone 1 not InProgress');

  // =========================================================================
  // STEP 22: COMPLETE MILESTONE 1 & COMPLETE DEAL
  // =========================================================================
  console.log('\n--- STEP 22: COMPLETE MILESTONE 1 & COMPLETE DEAL ---');
  const evidence1 = ethers.keccak256(ethers.toUtf8Bytes('Milestone 1 smoke deliverable verified'));
  console.log('Broadcasting submitWork(1) from freelancer...');
  const submit1Tx = await dealFreelancer.submitWork(1, evidence1);
  console.log(`Submit 1 Tx: ${submit1Tx.hash}`);
  const submit1Receipt = await submit1Tx.wait(1);
  console.log(`Confirmed in block ${submit1Receipt.blockNumber}, gas used: ${submit1Receipt.gasUsed.toString()}`);
  results.submit1Tx = submit1Tx.hash;
  results.txs.push({ name: 'submitWork(1)', hash: submit1Tx.hash, gas: submit1Receipt.gasUsed.toString() });

  console.log('Broadcasting clientApprove(1) from client...');
  const approve1Tx = await deal.clientApprove(1);
  console.log(`Approve 1 Tx: ${approve1Tx.hash}`);
  const approve1Receipt = await approve1Tx.wait(1);
  console.log(`Confirmed in block ${approve1Receipt.blockNumber}, gas used: ${approve1Receipt.gasUsed.toString()}`);
  results.approve1Tx = approve1Tx.hash;
  results.txs.push({ name: 'clientApprove(1)', hash: approve1Tx.hash, gas: approve1Receipt.gasUsed.toString() });

  // Final assertions
  const m1StatusFinal = (await deal.getMilestone(1)).status;
  const finalState = await deal.state();
  const finalSettled = await deal.totalSettled();
  const finalBalance = await usdc.balanceOf(dealAddress);

  console.log(`\nFinal Milestone 0 status: ${(await deal.getMilestone(0)).status} (7 = SettledPaid)`);
  console.log(`Final Milestone 1 status: ${m1StatusFinal} (7 = SettledPaid)`);
  console.log(`Final Deal state:         ${finalState} (2 = Completed)`);
  console.log(`Final totalSettled:       ${finalSettled} (1,000,000 base units)`);
  console.log(`Final Deal USDC balance:  ${finalBalance} (0 base units)`);

  if (Number(m1StatusFinal) !== 7) throw new Error('Milestone 1 not SettledPaid');
  if (Number(finalState) !== 2) throw new Error('Deal state not Completed');
  if (finalSettled !== 1000000n) throw new Error('totalSettled != totalEscrow');
  if (finalBalance !== 0n) throw new Error('Trapped USDC balance remaining!');

  results.finalMilestone0Status = 7;
  results.finalMilestone1Status = 7;
  results.finalDealState = Number(finalState);
  results.finalTotalSettled = finalSettled.toString();
  results.finalDealUsdcBalance = finalBalance.toString();

  // Save complete report to scratch
  fs.writeFileSync(path.join(__dirname, '..', 'scratch', 'smoke-deal2-results.json'), JSON.stringify(results, null, 2));
  console.log('\n=== SMOKE DEAL #2 VERIFICATION COMPLETED WITH 100% SUCCESS ===');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
