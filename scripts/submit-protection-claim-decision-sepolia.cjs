// scripts/submit-protection-claim-decision-sepolia.cjs
/**
 * Synq Premium Protection V1 — Committee Claim Determination Operator Tooling
 * Target: Ethereum Sepolia (chainId: 11155111)
 *
 * Sequence:
 * 1. Strictly enforce Sepolia network and chainId 11155111
 * 2. Load and validate canonical deployment manifest (sepolia-premium-protection-v1.json)
 * 3. Construct EIP-712 ProtectionClaimDecisionAuth structure
 * 4. Sign with 2 distinct authorized committee members
 * 5. Verify signatures locally before any transaction construction
 * 6. Dry-run mode (default): prints plan, asserts parameters, halts safely with ZERO transactions
 * 7. Live mode: requires explicit --live flag, calls committee.submitClaimDecision(auth, sig1, sig2)
 *
 * ZERO automatic payout disbursement. ZERO private key exposure.
 */

if (!process.env.HARDHAT_NETWORK) {
  process.env.HARDHAT_NETWORK = 'sepolia';
}

const { ethers, network } = require('hardhat');
const {
  SEPOLIA_CHAIN_ID,
  EXPECTED_CANONICAL_COMMITTEE,
  EXPECTED_CANONICAL_MANAGER,
  assertSepoliaNetwork,
  loadAndValidatePremiumManifest,
  buildClaimDecisionAuth,
  verifyCommitteeSignatures,
  parseDecision,
  isValidAddress,
  isValidBytes32,
} = require('./lib/premium-committee-config.cjs');

const COMMITTEE_ABI = [
  'function submitClaimDecision((address committee,uint256 chainId,address manager,address deal,uint256 milestoneId,uint8 decision,bytes32 decisionReportHash,uint64 decisionNonce,uint64 validUntil) auth, bytes sig1, bytes sig2) external',
  'function isSigner(address) external view returns (bool)',
  'function usedDecisionNonces(bytes32) external view returns (bool)',
];

const MANAGER_ABI = [
  'function getClaim(address deal, uint256 milestoneId) external view returns (tuple(uint8 status, uint256 milestoneId, uint256 milestoneAmount, bytes32 evidenceHash, bytes32 decisionReportHash, uint64 submittedAt, uint64 resolvedAt, uint256 payout))',
  'function claims(address, uint256) external view returns (uint8 status, uint256 milestoneId, uint256 milestoneAmount, bytes32 evidenceHash, bytes32 decisionReportHash, uint64 submittedAt, uint64 resolvedAt, uint256 payout)',
  'function protectionCommittee() external view returns (address)',
];

function getArgValue(flag) {
  const prefix = `${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

async function main() {
  console.log('====================================================');
  console.log('  SYNQ PROTECTION COMMITTEE DECISION TOOLING');
  console.log('====================================================\n');

  const isLive = process.argv.includes('--live') || process.env.SYNQ_COMMITTEE_LIVE === 'true';
  const isDryRun = !isLive || process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

  // 1. Network Hard Stop
  const configuredNetwork = network.name;
  const net = await ethers.provider.getNetwork();
  const observedChainId = Number(net.chainId);

  assertSepoliaNetwork(configuredNetwork, observedChainId);

  // 2. Load Manifest
  const manifestData = loadAndValidatePremiumManifest();

  // 3. Parse Command Line Arguments
  const dealAddress =
    process.env.DEAL_ADDRESS ||
    getArgValue('--deal') ||
    '0x0000000000000000000000000000000000000001'; // Fallback preview placeholder for dry-run inspection

  const milestoneId = BigInt(
    process.env.MILESTONE_ID || getArgValue('--milestone') || '0'
  );

  const decisionInput =
    process.env.DECISION || getArgValue('--decision') || 'APPROVE';
  const decisionEnum = parseDecision(decisionInput);

  const decisionReportHash =
    process.env.REPORT_HASH ||
    getArgValue('--reportHash') ||
    ethers.keccak256(ethers.toUtf8Bytes(`SYNQ_COMMITTEE_DECISION_REPORT_${Date.now()}`));

  const decisionNonce = BigInt(
    process.env.DECISION_NONCE || getArgValue('--nonce') || '1'
  );

  const validDays = Number(
    process.env.VALID_DAYS || getArgValue('--validDays') || '7'
  );
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + validDays * 86400);

  // 4. Build EIP-712 Auth Payload
  const authPayload = buildClaimDecisionAuth({
    committee: manifestData.committee,
    manager: manifestData.manager,
    deal: dealAddress,
    milestoneId,
    decision: decisionEnum,
    decisionReportHash,
    decisionNonce,
    validUntil,
    chainId: observedChainId,
  });

  // 5. Load Committee Signing Wallets
  const key1 =
    process.env.COMMITTEE_KEY_1 ||
    process.env.SYNQ_COMMITTEE_KEY_A ||
    process.env.PROTECTION_SIGNER_A_KEY;
  const key2 =
    process.env.COMMITTEE_KEY_2 ||
    process.env.SYNQ_COMMITTEE_KEY_B ||
    process.env.PROTECTION_SIGNER_B_KEY;

  let signerWallet1 = null;
  let signerWallet2 = null;

  if (key1 && key2) {
    try {
      signerWallet1 = new ethers.Wallet(key1.trim(), ethers.provider);
      signerWallet2 = new ethers.Wallet(key2.trim(), ethers.provider);
    } catch (err) {
      throw new Error(`Failed to initialize committee wallets from provided keys: ${err.message}`);
    }
  }

  // 6. Display Structured Plan
  console.log(`Execution Mode:            ${isDryRun ? 'DRY-RUN (Validation & Inspection Only)' : 'LIVE SEPOLIA BROADCAST'}`);
  console.log(`Configured Network:        ${configuredNetwork}`);
  console.log(`Observed Provider ChainId: ${observedChainId}`);
  console.log(`Target Network:            sepolia (chainId: ${SEPOLIA_CHAIN_ID})`);
  console.log(`Protection Committee:      ${authPayload.auth.committee}`);
  console.log(`Protection Manager:        ${authPayload.auth.manager}`);
  console.log(`Target Deal Address:       ${authPayload.auth.deal}`);
  console.log(`Target Milestone ID:       ${authPayload.auth.milestoneId.toString()}`);
  console.log(`Committee Determination:   ${decisionEnum === 1 ? 'APPROVE (1)' : 'REJECT (2)'}`);
  console.log(`Decision Report Hash:      ${authPayload.auth.decisionReportHash}`);
  console.log(`Decision Nonce:            ${authPayload.auth.decisionNonce.toString()}`);
  console.log(`Valid Until (Unix):        ${authPayload.auth.validUntil.toString()} (~${validDays} days)`);
  console.log(`Authorized Committee Set:`);
  for (let i = 0; i < manifestData.signers.length; i++) {
    console.log(`  - Signer [${i + 1}]:        ${manifestData.signers[i]}`);
  }
  if (signerWallet1 && signerWallet2) {
    console.log(`Loaded Signers:`);
    console.log(`  - Signer 1:              ${signerWallet1.address}`);
    console.log(`  - Signer 2:              ${signerWallet2.address}`);
  } else {
    console.log(`Loaded Signers:            [KEYLESS PREVIEW — committee signer keys not loaded]`);
  }
  console.log('');

  // 7. Check In-Flight Signatures if Keys Loaded
  let sig1 = null;
  let sig2 = null;

  if (signerWallet1 && signerWallet2) {
    console.log('Generating EIP-712 committee signatures...');
    sig1 = await signerWallet1.signTypedData(
      authPayload.domain,
      authPayload.types,
      authPayload.auth
    );
    sig2 = await signerWallet2.signTypedData(
      authPayload.domain,
      authPayload.types,
      authPayload.auth
    );

    console.log('Verifying recovered signer identities locally...');
    const verification = verifyCommitteeSignatures(
      authPayload,
      sig1,
      sig2,
      manifestData.signers
    );
    console.log(`Signatures verified successfully:`);
    console.log(`  - Recovered Signer 1:    ${verification.signer1}`);
    console.log(`  - Recovered Signer 2:    ${verification.signer2}\n`);
  }

  // 8. DRY RUN HALT
  if (isDryRun) {
    console.log('====================================================');
    console.log('  DRY RUN ONLY — NO TRANSACTIONS BROADCAST');
    console.log('  ZERO ON-CHAIN DETERMINATIONS SUBMITTED');
    console.log('====================================================');
    return {
      status: 'dry-run-completed',
      authPayload,
      hasSignatures: Boolean(sig1 && sig2),
    };
  }

  // 9. LIVE EXECUTION
  if (!signerWallet1 || !signerWallet2 || !sig1 || !sig2) {
    throw new Error('Committee private keys are required for live execution. Configure COMMITTEE_KEY_1 and COMMITTEE_KEY_2.');
  }

  if (dealAddress === '0x0000000000000000000000000000000000000001' || !isValidAddress(dealAddress)) {
    throw new Error('Valid target deal address is required for live execution via --deal=<address>.');
  }

  console.log('Connecting to SynqProtectionCommittee on Sepolia...');
  const [broadcaster] = await ethers.getSigners();
  const committee = new ethers.Contract(manifestData.committee, COMMITTEE_ABI, broadcaster || signerWallet1);

  console.log('Broadcasting submitClaimDecision to Sepolia...');
  const tx = await committee.submitClaimDecision(
    [
      authPayload.auth.committee,
      authPayload.auth.chainId,
      authPayload.auth.manager,
      authPayload.auth.deal,
      authPayload.auth.milestoneId,
      authPayload.auth.decision,
      authPayload.auth.decisionReportHash,
      authPayload.auth.decisionNonce,
      authPayload.auth.validUntil,
    ],
    sig1,
    sig2
  );

  console.log(`Transaction broadcast: ${tx.hash}`);
  const receipt = await tx.wait(1);
  console.log(`Transaction confirmed. Status: ${receipt.status === 1 ? 'SUCCESS (1)' : receipt.status}\n`);

  console.log('====================================================');
  console.log('  COMMITTEE DECISION RECORDED SUCCESSFULLY');
  console.log('  AUTOMATIC DISBURSEMENT: NONE (Manual Checkpoint)');
  console.log('====================================================\n');

  return {
    status: 'submitted',
    txHash: tx.hash,
    receiptStatus: receipt.status,
  };
}

if (require.main === module) {
  main()
    .then(() => {
      // Clean exit
    })
    .catch((err) => {
      console.error('\n[!] COMMITTEE TOOLING ERROR:', err.message);
      process.exitCode = 1;
    });
}

module.exports = { main };
