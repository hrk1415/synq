// scripts/predeployment-check-sepolia.cjs
const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('=== PHASE 3G-D: PREDEPLOYMENT SAFETY CHECK ===\n');

  const provider = ethers.provider;
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  console.log(`1. Chain ID: ${chainId}`);
  if (chainId !== 11155111) {
    throw new Error(`STOP: Expected Sepolia chainId 11155111, got ${chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  const deployerAddr = deployer.address;
  console.log(`2. Deployer Address: ${deployerAddr}`);
  const EXPECTED_OWNER = '0xD2D4d415a4730b1490c9Ce27944529B83ff76319';
  if (deployerAddr.toLowerCase() !== EXPECTED_OWNER.toLowerCase()) {
    throw new Error(`STOP: Expected deployer ${EXPECTED_OWNER}, got ${deployerAddr}`);
  }

  const deployerEth = await provider.getBalance(deployerAddr);
  console.log(`3. Deployer Sepolia ETH Balance: ${ethers.formatEther(deployerEth)} ETH`);
  if (deployerEth < ethers.parseEther('0.02')) {
    throw new Error(`STOP: Insufficient ETH for deployment & rotation: ${ethers.formatEther(deployerEth)} ETH`);
  }

  const FACTORY_ADDR = '0x9b7C5B529A420d015a85fD77040eF63b0e6cbdb0';
  const factoryCode = await provider.getCode(FACTORY_ADDR);
  console.log(`4. Factory contract code length: ${(factoryCode.length - 2) / 2} bytes`);
  if (factoryCode === '0x' || factoryCode.length <= 2) {
    throw new Error(`STOP: Factory address ${FACTORY_ADDR} has no code`);
  }

  const FactoryV2 = await ethers.getContractFactory('SynqFactoryV2');
  const factory = FactoryV2.attach(FACTORY_ADDR);

  const currentImpl = await factory.dealImplementation();
  console.log(`5. Current factory.dealImplementation(): ${currentImpl}`);
  const EXPECTED_OLD_IMPL = '0x2a3C8A880398FF6DD8e6F9976c8BE6C8aBef2435';
  if (currentImpl.toLowerCase() !== EXPECTED_OLD_IMPL.toLowerCase()) {
    throw new Error(`STOP: Current implementation is not expected old impl: got ${currentImpl}, expected ${EXPECTED_OLD_IMPL}`);
  }

  const factoryOwner = await factory.owner();
  console.log(`6. factory.owner(): ${factoryOwner}`);
  if (factoryOwner.toLowerCase() !== EXPECTED_OWNER.toLowerCase()) {
    throw new Error(`STOP: Factory owner mismatch: got ${factoryOwner}, expected ${EXPECTED_OWNER}`);
  }

  const CANONICAL_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
  const usdcCode = await provider.getCode(CANONICAL_USDC);
  console.log(`7. Canonical USDC code length: ${(usdcCode.length - 2) / 2} bytes`);
  if (usdcCode === '0x' || usdcCode.length <= 2) {
    throw new Error(`STOP: Canonical USDC ${CANONICAL_USDC} has no code`);
  }

  const artifactPath = path.join(__dirname, '..', 'src', 'lib', 'contracts', 'artifacts', 'contracts', 'v1', 'SynqDealV1Sequential.sol', 'SynqDealV1Sequential.json');
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`STOP: Artifact not found at ${artifactPath}`);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const runtimeBytecodeSize = (artifact.deployedBytecode.length - 2) / 2;
  console.log(`8. SynqDealV1Sequential runtime bytecode size: ${runtimeBytecodeSize} bytes (limit: 24576)`);
  if (runtimeBytecodeSize >= 24576) {
    throw new Error(`STOP: Runtime bytecode exceeds EIP-170 limit: ${runtimeBytecodeSize}`);
  }

  console.log('\n=== ALL PREDEPLOYMENT SAFETY CHECKS PASSED ===');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
