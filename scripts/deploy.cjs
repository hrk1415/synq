const { ethers } = require('hardhat');

async function main() {
  console.log('Deploying Nexotiq contracts...\n');

  const [deployer] = await ethers.getSigners();
  console.log('Deployer:', deployer.address);
  console.log('Balance:', ethers.formatEther(await ethers.provider.getBalance(deployer.address)), 'ETH\n');

  const DealImpl = await ethers.getContractFactory('NexotiqDeal');
  const dealImpl = await DealImpl.deploy();
  await dealImpl.waitForDeployment();
  const dealImplAddr = await dealImpl.getAddress();
  console.log('NexotiqDeal (implementation):', dealImplAddr);

  // The factory does not exist yet, so pass the deployer and re-point it below.
  // Leaving it as the deployer is what made the previous deployment's reputation
  // contract permanently unwritable by the factory.
  const Reputation = await ethers.getContractFactory('NexotiqReputation');
  const reputation = await Reputation.deploy(deployer.address);
  await reputation.waitForDeployment();
  const repAddr = await reputation.getAddress();
  console.log('NexotiqReputation:', repAddr);

  const Factory = await ethers.getContractFactory('NexotiqFactory');
  const factory = await Factory.deploy(dealImplAddr, repAddr, deployer.address);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log('NexotiqFactory:', factoryAddr);

  await (await reputation.setFactory(factoryAddr)).wait();
  console.log('Reputation -> Factory wired.');
  const wiredFactory = await reputation.factory();
  if (wiredFactory.toLowerCase() !== factoryAddr.toLowerCase()) {
    throw new Error(`Reputation.factory is ${wiredFactory}, expected ${factoryAddr}`);
  }

  const Protection = await ethers.getContractFactory('NexotiqProtection');
  const protection = await Protection.deploy(factoryAddr, deployer.address);
  await protection.waitForDeployment();
  const protAddr = await protection.getAddress();
  console.log('NexotiqProtection:', protAddr);

  await factory.setProtectionContract(protAddr);
  console.log('Factory -> Protection wired.');

  const Registry = await ethers.getContractFactory('NexotiqRegistry');
  const registry = await Registry.deploy();
  await registry.waitForDeployment();
  const regAddr = await registry.getAddress();
  console.log('NexotiqRegistry:', regAddr);

  const Directory = await ethers.getContractFactory('NexotiqDirectory');
  const directory = await Directory.deploy();
  await directory.waitForDeployment();
  const dirAddr = await directory.getAddress();
  console.log('NexotiqDirectory:', dirAddr);

  console.log('\n--- Deployment Summary ---');
  console.log(JSON.stringify({
    NexotiqDeal: dealImplAddr,
    NexotiqReputation: repAddr,
    NexotiqFactory: factoryAddr,
    NexotiqProtection: protAddr,
    NexotiqRegistry: regAddr,
    NexotiqDirectory: dirAddr,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  // Without this a failed deployment still exits 0 and looks like a success.
  process.exitCode = 1;
});
