// scripts/deploy-sequential-impl-sepolia.cjs
const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('=== PHASE 3G-D STEP 3: DEPLOY SYNQDEALV1SEQUENTIAL IMPLEMENTATION ===\n');

  const provider = ethers.provider;
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId !== 11155111) {
    throw new Error(`STOP: Expected Sepolia chainId 11155111, got ${chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  const deployerAddr = deployer.address;
  console.log(`Deployer: ${deployerAddr}`);
  if (deployerAddr.toLowerCase() !== '0xD2D4d415a4730b1490c9Ce27944529B83ff76319'.toLowerCase()) {
    throw new Error(`STOP: Unauthorized deployer ${deployerAddr}`);
  }

  const DealSequentialFactory = await ethers.getContractFactory('SynqDealV1Sequential');
  console.log('Deploying SynqDealV1Sequential to Sepolia...');
  const contract = await DealSequentialFactory.deploy();

  const deployTx = contract.deploymentTransaction();
  console.log(`Deployment transaction submitted: ${deployTx.hash}`);

  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();
  const receipt = await deployTx.wait(1);

  console.log('\n--- DEPLOYMENT SUCCESSFUL ---');
  console.log(`Contract Address: ${contractAddress}`);
  console.log(`Transaction Hash: ${receipt.hash}`);
  console.log(`Block Number:     ${receipt.blockNumber}`);
  console.log(`Gas Used:         ${receipt.gasUsed.toString()}`);

  const outDir = path.join(__dirname, '..', 'scratch');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'deployed-sequential-impl.json'),
    JSON.stringify(
      {
        contractAddress,
        transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        deployedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log('\nSaved deployment record to scratch/deployed-sequential-impl.json');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
