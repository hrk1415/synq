const { ethers } = require('hardhat');

const FACTORY_ADDRESS = '0x569146151D79B30087B27B6D3Df1FD16a846ae23';

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deployer:', deployer.address);
  console.log('Balance:', ethers.formatEther(await ethers.provider.getBalance(deployer.address)), 'ETH\n');

  const DealImpl = await ethers.getContractFactory('NexotiqDeal');
  const dealImpl = await DealImpl.deploy();
  await dealImpl.waitForDeployment();
  const dealImplAddr = await dealImpl.getAddress();
  console.log('New NexotiqDeal implementation:', dealImplAddr);

  const Factory = await ethers.getContractFactory('NexotiqFactory');
  const factory = Factory.attach(FACTORY_ADDRESS);

  const oldImpl = await factory.dealImplementation();
  console.log('Old implementation:', oldImpl);
  console.log('feeCollector:', await factory.feeCollector());

  const tx = await factory.connect(deployer).updateDealImplementation(dealImplAddr);
  const receipt = await tx.wait();
  console.log('updateDealImplementation tx:', receipt.hash);

  const newImpl = await factory.dealImplementation();
  console.log('\nNew implementation on factory:', newImpl);
  console.log(newImpl.toLowerCase() === dealImplAddr.toLowerCase() ? '\n\u2705 FACTORY IMPLEMENTATION UPDATED' : '\n\u274c MISMATCH');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
