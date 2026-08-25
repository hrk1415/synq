const { ethers } = require('hardhat');

async function main() {
  const [signer] = await ethers.getSigners();
  console.log('Testing on Sepolia with:', signer.address);

  const Registry = await ethers.getContractFactory('NexotiqRegistry');
  const registry = Registry.attach('0xa852fec557145E94B0A3A63339e2e97fD71dc1ec');

  const existing = await registry.getUsername(signer.address);
  let username;
  if (existing && existing.length > 0) {
    console.log('1) wallet already registered as:', JSON.stringify(existing));
    username = existing;
  } else {
    username = 'synqtest_' + Date.now().toString().slice(-6);
    console.log('1) isUsernameTaken("' + username + '") =', await registry.isUsernameTaken(username));
    console.log('2) registering...');
    const tx = await registry.connect(signer).register(username);
    const receipt = await tx.wait();
    console.log('   tx:', receipt.hash);
  }

  const stored = await registry.getUsername(signer.address);
  console.log('3) getUsername(wallet) =', JSON.stringify(stored));
  const addr = await registry.getFunction('getAddress')(username);
  console.log('4) getAddress("' + username + '") =', addr);

  const ok = stored === username && addr.toLowerCase() === signer.address.toLowerCase();
  console.log(ok ? '\n✅ REGISTRY WORKS ON SEPOLIA' : '\n❌ MISMATCH');

  const Factory = await ethers.getContractFactory('NexotiqFactory');
  const factory = Factory.attach('0x72584579BD7992Cf097d9749aE85bA25DcbC5F70');
  console.log('5) Factory.getDealCount() =', (await factory.getDealCount()).toString());
  console.log('6) Factory.feeBps() =', (await factory.feeBps()).toString());
}

main().catch(console.error);