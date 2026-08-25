const { ethers } = require('hardhat');

const ADDR = process.argv[2] || '0xaf49f0F835De0FFf0a9D79CA41E0a7f74271101F';

async function main() {
  const provider = ethers.provider;
  const code = await provider.getCode(ADDR);
  console.log(`Address: ${ADDR}`);
  console.log(`Code size: ${code.length ? (code.length - 2) / 2 : 0} bytes\n`);

  if (!code || code === '0x' || code.length <= 2) {
    console.log('=> NOTHING DEPLOYED at this address (or wrong network).');
    return;
  }

  const registryABI = [
    'function isUsernameTaken(string) view returns (bool)',
    'function getUsername(address) view returns (string)',
    'function getAddress(string) view returns (address)',
  ];
  const factoryABI = [
    'function getDealCount() view returns (uint256)',
    'function dealImplementation() view returns (address)',
    'function feeBps() view returns (uint256)',
  ];
  const directoryABI = [
    'function getProfileCount() view returns (uint256)',
    'function isRegistered(address) view returns (bool)',
  ];
  const reputationABI = ['function getReputation(address) view returns (tuple)'];
  const protectionABI = ['function getCoverage(address) view returns (tuple)'];
  const dealABI = [
    'function milestoneCount() view returns (uint256)',
    'function escrowBalance() view returns (uint256)',
  ];
  const erc20ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
  ];

  const calls = [
    ['NexotiqRegistry', registryABI, 'getUsername', [ethers.ZeroAddress]],
    ['NexotiqFactory', factoryABI, 'getDealCount', []],
    ['NexotiqDirectory', directoryABI, 'getProfileCount', []],
    ['NexotiqReputation', reputationABI, 'getReputation', [ethers.ZeroAddress]],
    ['NexotiqProtection', protectionABI, 'getCoverage', [ethers.ZeroAddress]],
    ['NexotiqDeal (impl)', dealABI, 'escrowBalance', []],
    ['ERC20 token', erc20ABI, 'symbol', []],
  ];

  const probeABI = [
    ['owner', 'function owner() view returns (address)'],
    ['name', 'function name() view returns (string)'],
    ['decimals', 'function decimals() view returns (uint8)'],
    ['paused', 'function paused() view returns (bool)'],
    ['admin', 'function admin() view returns (address)'],
    ['implementation', 'function implementation() view returns (address)'],
    ['getUser', 'function getUser(address) view returns (address)'],
    ['isMember', 'function isMember(address) view returns (bool)'],
  ];

  let found = [];
  for (const [label, abi, fn, args] of calls) {
    try {
      const c = new ethers.Contract(ADDR, abi, provider);
      const res = await c[fn](...args);
      console.log(`✅ ${label}: ${fn}() -> ${typeof res === 'object' && res !== null ? JSON.stringify(res) : String(res)}`);
      found.push(label);
    } catch (e) {
      console.log(`❌ ${label}: ${fn}() failed`);
    }
  }

  console.log(`\n-- Standard probes --`);
  for (const [label, sig] of probeABI) {
    try {
      const c = new ethers.Contract(ADDR, [sig], provider);
      const res = await c[label](...([sig.includes('(address)') || sig.includes('(uint256)')] ? [ethers.ZeroAddress] : []));
      console.log(`✅ ${label}() -> ${typeof res === 'object' && res !== null ? JSON.stringify(res) : String(res)}`);
    } catch {
      console.log(`❌ ${label}()`);
    }
  }

  console.log(`\n=> Matches: ${found.length ? found.join(', ') : 'unknown contract (not part of Nexotiq)'}`);
}

main().catch(console.error);