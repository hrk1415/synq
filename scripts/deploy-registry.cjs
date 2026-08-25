const { ethers } = require('hardhat');

async function main() {
  const Registry = await ethers.getContractFactory('NexotiqRegistry');
  const reg = await Registry.deploy();
  await reg.waitForDeployment();
  const addr = await reg.getAddress();
  console.log('NexotiqRegistry:', addr);
}

main().catch(console.error);
