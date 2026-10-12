// test/SynqPremiumPhase5DVerification.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

// Ensure .env.local variables are loaded for this test
const envPath = path.join(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.replace(/\r$/, '').match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

import { createPublicClient, http, formatUnits, parseUnits } from 'viem';
import { sepolia } from 'viem/chains';
import {
  getSynqPremiumConfig,
  isPremiumProtectionConfigured,
} from '../src/lib/contracts/addresses';
import {
  readPremiumManagerParameters,
  readPoolAvailableBalance,
  calculatePremiumFee,
  calculateMaximumCoverage,
} from '../src/lib/deals/v2-protection';

describe('SYNQ PREMIUM PROTECTION V1 — PHASE 5D VERIFICATION', function () {
  const RETIRED_V1_MANAGER = '0xEbD3654548371f2dc2d1420226b99983a42e2FE8';
  const EXPECTED_MANAGER = '0x462D1b8c1047d05FbE61e15809f4E6A26B12ED00'; // V1.1 Manager post-cutover
  const EXPECTED_POOL = '0xA1f4991597869ba11EbD94edED4d69960063cbc2';
  const EXPECTED_COMMITTEE = '0x8e77aFf09Dd37EEa35d2931Ac1aA624abBF94e12';

  it('1. resolves local frontend config with valid contract addresses (cut over to V1.1)', function () {
    const config = getSynqPremiumConfig();
    assert.strictEqual(config.chainId, 11155111);
    assert.strictEqual(config.manager?.toLowerCase(), EXPECTED_MANAGER.toLowerCase());
    assert.strictEqual(config.pool?.toLowerCase(), EXPECTED_POOL.toLowerCase());
    assert.strictEqual(config.committee?.toLowerCase(), EXPECTED_COMMITTEE.toLowerCase());
    assert.strictEqual(config.isConfigured, true);
    assert.strictEqual(isPremiumProtectionConfigured(config), true);
  });

  it('2. reads live manager parameters from Sepolia (200 bps fee, 2000 bps coverage)', async function () {
    const config = getSynqPremiumConfig();
    const rpcUrl = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(rpcUrl),
    });

    const params = await readPremiumManagerParameters(publicClient, config.manager);
    assert.notStrictEqual(params, null);
    assert.strictEqual(params?.premiumFeeBps, 200);
    assert.strictEqual(params?.coverageRateBps, 2000);
  });

  it('3. reads live pool available balance from Sepolia (capitalized in Phase 6B, expanded in Phase 7N.1)', async function () {
    const config = getSynqPremiumConfig();
    const rpcUrl = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(rpcUrl),
    });

    const balance = await readPoolAvailableBalance(publicClient, config.pool);
    assert.ok(balance !== null && balance >= 10_100_000n); // 10.10 USDC seed/QA + 0.10 USDC V1.1 policy
  });

  it('4. verifies economic display math for 100 USDC escrow (2 USDC fee, 20 USDC coverage)', function () {
    const escrow = parseUnits('100', 6); // 100_000_000n
    const fee = calculatePremiumFee(escrow, 200);
    const coverage = calculateMaximumCoverage(escrow, 2000);

    assert.strictEqual(fee, parseUnits('2', 6));
    assert.strictEqual(coverage, parseUnits('20', 6));
  });

  it('5. verifies economic display math for 500 USDC escrow (10 USDC fee, 100 USDC coverage)', function () {
    const escrow = parseUnits('500', 6); // 500_000_000n
    const fee = calculatePremiumFee(escrow, 200);
    const coverage = calculateMaximumCoverage(escrow, 2000);

    assert.strictEqual(fee, parseUnits('10', 6));
    assert.strictEqual(coverage, parseUnits('100', 6));
  });

  it('6. verifies economic display math for 1000 USDC escrow (20 USDC fee, 200 USDC coverage)', function () {
    const escrow = parseUnits('1000', 6); // 1_000_000_000n
    const fee = calculatePremiumFee(escrow, 200);
    const coverage = calculateMaximumCoverage(escrow, 2000);

    assert.strictEqual(fee, parseUnits('20', 6));
    assert.strictEqual(coverage, parseUnits('200', 6));
  });
});
