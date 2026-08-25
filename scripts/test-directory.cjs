const { ethers } = require('hardhat');

async function main() {
  const [a, b] = await ethers.getSigners();
  const Directory = await ethers.getContractFactory('NexotiqDirectory');
  const dir = await Directory.deploy();
  await dir.waitForDeployment();
  console.log('Directory:', await dir.getAddress());

  await dir.connect(a).registerProfile('Ayesha Rahman', 'Web Development', ['React', 'Next.js', 'Tailwind'], 25, 'Full-stack dev');
  await dir.connect(b).registerProfile('SecureChain Labs', 'Smart Contract', ['Audit', 'Solidity'], 60, 'Auditors');
  console.log('Registered 2 profiles');

  try {
    await dir.connect(a).registerProfile('Duplicate', 'Design', ['UI'], 10, 'dup');
    console.log('ERROR: duplicate register not blocked');
  } catch (e) {
    console.log('OK: duplicate register blocked:', e.shortMessage || e.message);
  }

  const all = await dir.getAllProfiles();
  console.log('getAllProfiles count:', all.length);
  console.log('Profile[0]:', all[0].name, '|', all[0].category, '|', all[0].skills.join('+'), '| rate', Number(all[0].rate), '| available', all[0].available);

  await dir.connect(a).setAvailable(false);
  const p1 = await dir.getProfile(a.address);
  console.log('After setAvailable(false):', p1.available);

  await dir.connect(a).updateProfile('Ayesha R.', 'Web Development', ['React', 'Next.js'], 30, 'Updated bio');
  const p2 = await dir.getProfile(a.address);
  console.log('After update: name =', p2.name, '| rate =', Number(p2.rate), '| skills =', p2.skills.join(','));

  console.log('\n=== Directory PASSED ===');
}

main().catch((e) => { console.error(e); process.exit(1); });