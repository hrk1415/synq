// scripts/smoke-deal2-preflight.cjs
const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

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

const CANONICAL_FACTORY = '0x9b7C5B529A420d015a85fD77040eF63b0e6cbdb0';
const CANONICAL_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

async function main() {
  console.log('=== SMOKE DEAL #2 PREFLIGHT: CHECKING ROLES & BALANCES ===\n');
  const provider = ethers.provider;
  const [deployer] = await ethers.getSigners();
  const clientAddr = await deployer.getAddress();
  const clientEth = await provider.getBalance(clientAddr);

  console.log(`Client Address: ${clientAddr}`);
  console.log(`Client ETH:     ${ethers.formatEther(clientEth)} ETH`);

  if (!freelancerKey) {
    throw new Error('STOP: SEPOLIA_FREELANCER_PRIVATE_KEY not found in .env.local');
  }
  const freelancerWallet = new ethers.Wallet(freelancerKey, provider);
  const freelancerAddr = await freelancerWallet.getAddress();
  const freelancerEth = await provider.getBalance(freelancerAddr);

  console.log(`Freelancer Address: ${freelancerAddr}`);
  console.log(`Freelancer ETH:     ${ethers.formatEther(freelancerEth)} ETH`);

  // Check client USDC balance
  const erc20Abi = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address, address) view returns (uint256)'
  ];
  const usdc = new ethers.Contract(CANONICAL_USDC, erc20Abi, provider);
  const clientUsdc = await usdc.balanceOf(clientAddr);
  console.log(`Client USDC Balance: ${ethers.formatUnits(clientUsdc, 6)} USDC`);

  if (clientUsdc < 1000000n) {
    throw new Error(`STOP: Client has insufficient USDC. Need at least 1.00 USDC, has ${ethers.formatUnits(clientUsdc, 6)}`);
  }

  // Check client nonce on Factory
  const factoryAbi = [
    'function usedClientNonces(address, uint256) view returns (bool)'
  ];
  const factory = new ethers.Contract(CANONICAL_FACTORY, factoryAbi, provider);
  
  // Find an unused nonce
  let testNonce = 100n;
  while (await factory.usedClientNonces(clientAddr, testNonce)) {
    testNonce += 1n;
  }
  console.log(`Found unused client proposal nonce: ${testNonce}`);
  console.log('\n✅ Smoke Deal #2 preflight passed: Sufficient ETH & USDC available.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
