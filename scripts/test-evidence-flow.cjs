const { ethers } = require('hardhat');

const ZERO = '0x0000000000000000000000000000000000000000';
const FACTORY_ADDRESS = '0x569146151D79B30087B27B6D3Df1FD16a846ae23';
const EVIDENCE = 'ipfs://QmTestEvidence1234567890abcdef';

async function main() {
  const [signer] = await ethers.getSigners();
  console.log('Wallet:', signer.address);
  console.log('Balance:', ethers.formatEther(await ethers.provider.getBalance(signer.address)), 'ETH\n');

  const Factory = await ethers.getContractFactory('NexotiqFactory');
  const factory = Factory.attach(FACTORY_ADDRESS);
  const Deal = await ethers.getContractFactory('NexotiqDeal');

  // ---------- 1) Close the disputed deal via admin force-resolve ----------
  console.log('=== 1) Resolve the disputed deal ===');
  const userDeals = await factory.getUserDeals(signer.address);
  const seen = new Set();
  for (const d of userDeals) {
    const key = d.dealAddress.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const deal = Deal.attach(d.dealAddress);
    const status = Number(await deal.status());
    if (status === 3) {
      const bal = await deal.escrowBalance();
      console.log(`Disputed deal ${d.dealAddress} — escrow: ${ethers.formatEther(bal)} ETH`);
      let resolved = false;
      try {
        const tx = await factory.forceResolve(d.dealAddress, 'refund_buyer');
        const rec = await tx.wait();
        console.log(`  forceResolve(refund_buyer) tx: ${rec.hash}`);
        resolved = true;
      } catch {
        console.log('  forceResolve not available (legacy implementation) — using both-approve path');
        let r = await (await deal.approveDisputeResolution()).wait();
        console.log('  approveDisputeResolution (both sides) tx:', r.hash);
        const dp = await deal.dispute();
        console.log(`  buyerApproved: ${dp.buyerApproved}, sellerApproved: ${dp.sellerApproved}`);
        r = await (await deal.executeDisputeResolution('refund_buyer')).wait();
        console.log('  executeDisputeResolution(refund_buyer) tx:', r.hash);
        resolved = true;
      }
      console.log(`  new status: ${Number(await deal.status())} (2 = Completed), escrow left: ${ethers.formatEther(await deal.escrowBalance())} ETH (${resolved ? 'refunded' : '??'})`);
    }
  }

  // ---------- 2) Create a new deal (self-test: buyer = seller = wallet) ----------
  console.log('\n=== 2) Create new deal with milestone ===');
  const totalValue = ethers.parseEther('0.01');
  const deadline = Math.floor(Date.now() / 1000) + 7 * 86400;
  const tx = await factory.createDeal(signer.address, 'Evidence Flow Test', 'Test milestone + evidence cycle', totalValue, deadline, false, ZERO);
  const rec = await tx.wait();
  const event = rec.logs.map((l) => {
    try { return factory.interface.parseLog(l); } catch { return null; }
  }).find((e) => e && e.name === 'DealCreated');
  const dealAddr = event.args.dealAddress;
  console.log('Deal created:', dealAddr, 'tx:', rec.hash);

  const deal = Deal.attach(dealAddr);

  // ---------- 3) Add milestone ----------
  console.log('\n=== 3) Buyer adds milestone ===');
  let r = await (await deal.addMilestone('Website Landing Page', 'Design + build landing page', totalValue, deadline)).wait();
  console.log('addMilestone tx:', r.hash);
  console.log('milestone count:', (await deal.getMilestoneCount()).toString());

  // ---------- 4) Fund escrow ----------
  console.log('\n=== 4) Buyer funds escrow (0.01 ETH) ===');
  r = await (await deal.fundEscrow({ value: totalValue })).wait();
  console.log('fundEscrow tx:', r.hash);
  console.log('escrow balance:', ethers.formatEther(await deal.escrowBalance()), 'ETH');

  // ---------- 5) Seller starts work ----------
  console.log('\n=== 5) Seller starts work ===');
  r = await (await deal.startMilestone(0)).wait();
  console.log('startMilestone tx:', r.hash);

  // ---------- 6) Seller submits work WITH EVIDENCE ----------
  console.log('\n=== 6) Seller submits work with evidence ===');
  r = await (await deal.submitMilestone(0, EVIDENCE)).wait();
  console.log('submitMilestone tx:', r.hash);
  const ms = await deal.getMilestones();
  console.log('  milestone status:', Number(ms[0].msStatus), '(2 = Completed/submitted)');
  console.log('  evidenceHash:', ms[0].evidenceHash);

  // ---------- 7) Buyer verifies evidence and approves ----------
  console.log('\n=== 7) Buyer approves -> payment released to seller ===');
  r = await (await deal.approveMilestone(0)).wait();
  console.log('approveMilestone tx:', r.hash);
  console.log('  milestone status:', Number((await deal.getMilestones())[0].msStatus), '(3 = Approved)');
  console.log('  deal status:', Number(await deal.status()), '(2 = Completed)');
  console.log('  deal escrow left:', ethers.formatEther(await deal.escrowBalance()), 'ETH');

  console.log('\n✅ FULL EVIDENCE CYCLE DONE');
}

main().catch((e) => { console.error(e); process.exit(1); });
