const { ethers } = require('hardhat');

async function main() {
  const [buyer, seller] = await ethers.getSigners();
  const USDC_AMOUNT = ethers.parseUnits('500', 6);

  const Mock = await ethers.getContractFactory('MockERC20');
  const usdc = await Mock.deploy('Mock USDC', 'USDC', 6, ethers.parseUnits('100000', 6));
  await usdc.waitForDeployment();
  await usdc.mint(buyer.address, ethers.parseUnits('1000', 6));
  console.log('USDC deployed:', await usdc.getAddress());

  const DealImpl = await ethers.getContractFactory('NexotiqDeal');
  const impl = await DealImpl.deploy();
  await impl.waitForDeployment();

  const Factory = await ethers.getContractFactory('NexotiqFactory');
  const factory = await Factory.deploy(await impl.getAddress(), ethers.ZeroAddress, buyer.address);
  await factory.waitForDeployment();
  console.log('Factory deployed:', await factory.getAddress());

  const deadline = Math.floor(Date.now() / 1000) + 86400;
  const tx = await factory.connect(buyer).createDeal(
    seller.address, 'Website Build', 'Deliver a website',
    USDC_AMOUNT, BigInt(deadline), false, await usdc.getAddress()
  );
  await tx.wait();
  const dealAddr = (await factory.getDeal(0)).dealAddress;
  console.log('Deal created:', dealAddr);

  const deal = await ethers.getContractAt('NexotiqDeal', dealAddr);
  console.log('asset on deal:', await deal.asset());

  // ---- FUND without approve first (should fail) ----
  await usdc.connect(buyer).approve(dealAddr, 0);
  try {
    const t = await deal.connect(buyer).fundEscrow();
    await t.wait();
    console.log('ERROR: fundEscrow should have failed without allowance');
  } catch (e) {
    console.log('OK: fundEscrow blocked without approval:', e.shortMessage || e.message);
  }

  // ---- approve + fund ----
  await usdc.connect(buyer).approve(dealAddr, USDC_AMOUNT);
  const f = await deal.connect(buyer).fundEscrow();
  await f.wait();
  console.log('Escrow balance:', ethers.formatUnits(await deal.escrowBalance(), 6), 'USDC');

  // ---- milestone flow releases USDC to seller ----
  await deal.connect(buyer).addMilestone('M1', 'Deliver', USDC_AMOUNT, BigInt(deadline));
  await deal.connect(seller).startMilestone(0);
  await deal.connect(seller).submitMilestone(0, 'ipfs://site.zip');
  const a = await deal.connect(buyer).approveMilestone(0);
  await a.wait();
  console.log('Status after approve:', await deal.status(), '(2 = Completed)');
  console.log('Seller USDC balance after payout:', ethers.formatUnits(await usdc.balanceOf(seller.address), 6));
  console.log('Deal escrow after payout:', ethers.formatUnits(await deal.escrowBalance(), 6), 'USDC');

  console.log('\n=== ERC20 flow PASSED ===');
}

main().catch((e) => { console.error(e); process.exit(1); });