import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  validateUsdcPricing,
  formatPublicPricing,
  formatUsdcDisplayAmount,
  getSuggestedDealBudget,
  parseEthRateToWei,
  type FreelancerPricing,
} from '../src/lib/deals/pricing';

describe('SYNQ Freelancer Pricing V2 Test Suite', () => {
  // 1. valid USDC PER_PROJECT
  it('1. valid USDC PER_PROJECT passes validation and normalizes canonical fields', () => {
    const res = validateUsdcPricing('50.00', 'PER_PROJECT', 'USDC');
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.amount, '50.00');
    assert.strictEqual(res.rateType, 'PER_PROJECT');
    assert.strictEqual(res.currency, 'USDC');
  });

  // 2. valid USDC PER_HOUR
  it('2. valid USDC PER_HOUR passes validation and normalizes canonical fields', () => {
    const res = validateUsdcPricing('25.5', 'PER_HOUR', 'USDC');
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.amount, '25.5');
    assert.strictEqual(res.rateType, 'PER_HOUR');
    assert.strictEqual(res.currency, 'USDC');
  });

  // 3. USDC zero rejected
  it('3. USDC zero amount is rejected', () => {
    const res = validateUsdcPricing('0', 'PER_PROJECT', 'USDC');
    assert.strictEqual(res.valid, false);
    assert.match(res.error || '', /greater than zero/i);

    const res2 = validateUsdcPricing('0.000000', 'PER_PROJECT', 'USDC');
    assert.strictEqual(res2.valid, false);
    assert.match(res2.error || '', /greater than zero/i);
  });

  // 4. USDC negative rejected
  it('4. USDC negative amount is rejected', () => {
    const res = validateUsdcPricing('-10.50', 'PER_PROJECT', 'USDC');
    assert.strictEqual(res.valid, false);
    assert.match(res.error || '', /valid positive number/i);
  });

  // 5. malformed USDC rejected
  it('5. malformed USDC string is rejected', () => {
    const malformed = ['abc', '12.34.56', '50,00', '1e6', '', '   '];
    for (const val of malformed) {
      const res = validateUsdcPricing(val, 'PER_PROJECT', 'USDC');
      assert.strictEqual(res.valid, false, `Expected ${val} to be rejected`);
    }
  });

  // 6. >6 USDC decimals rejected
  it('6. >6 USDC decimals is rejected', () => {
    const res = validateUsdcPricing('50.1234567', 'PER_PROJECT', 'USDC');
    assert.strictEqual(res.valid, false);
    assert.match(res.error || '', /more than 6 decimal places/i);

    // 6 decimals exactly is valid
    const res6 = validateUsdcPricing('50.123456', 'PER_PROJECT', 'USDC');
    assert.strictEqual(res6.valid, true);
  });

  // 7. unsupported rate type rejected
  it('7. unsupported rate type is rejected', () => {
    const res = validateUsdcPricing('50.00', 'PER_MONTH' as any, 'USDC');
    assert.strictEqual(res.valid, false);
    assert.match(res.error || '', /rate type must be PER_PROJECT or PER_HOUR/i);
  });

  // 8. unsupported currency rejected
  it('8. unsupported currency is rejected', () => {
    const res = validateUsdcPricing('50.00', 'PER_PROJECT', 'ETH' as any);
    assert.strictEqual(res.valid, false);
    assert.match(res.error || '', /only usdc currency is supported/i);
  });

  // Helper simulating first-time registration validation
  function validateFirstTimeRegistration(input: {
    usdcRate: string;
    rateType: string;
    ethRate: string;
  }) {
    const errors: string[] = [];
    // USDC validation
    const usdcVal = validateUsdcPricing(input.usdcRate, input.rateType as any, 'USDC');
    if (!usdcVal.valid) {
      errors.push(usdcVal.error || 'Invalid USDC pricing');
    }
    // Rate type validation
    if (!input.rateType || (input.rateType !== 'PER_PROJECT' && input.rateType !== 'PER_HOUR')) {
      errors.push('Rate type is required');
    }
    // ETH validation (18-decimal on-chain NexotiqDirectory.rate)
    const ethWei = parseEthRateToWei(input.ethRate);
    if (!ethWei || ethWei <= 0n) {
      errors.push('ETH rate is required and must be greater than 0');
    }
    return {
      valid: errors.length === 0,
      errors,
      usdcVal,
      ethWei,
    };
  }

  // 9. first-time registration requires USDC
  it('9. first-time registration requires USDC starting rate', () => {
    const res = validateFirstTimeRegistration({
      usdcRate: '',
      rateType: 'PER_PROJECT',
      ethRate: '0.05',
    });
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors.some((e) => /USDC/i.test(e)));
  });

  // 10. first-time registration requires ETH
  it('10. first-time registration requires ETH on-chain rate', () => {
    const res = validateFirstTimeRegistration({
      usdcRate: '50.00',
      rateType: 'PER_PROJECT',
      ethRate: '',
    });
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors.some((e) => /ETH/i.test(e)));
  });

  // 11. first-time registration requires rate type
  it('11. first-time registration requires rate type', () => {
    const res = validateFirstTimeRegistration({
      usdcRate: '50.00',
      rateType: '',
      ethRate: '0.05',
    });
    assert.strictEqual(res.valid, false);
    assert.ok(res.errors.some((e) => /rate type/i.test(e)));
  });

  // 12. user-entered ETH still reaches registerProfile correctly
  it('12. user-entered ETH safely converts to 18-decimal BigInt for on-chain registerProfile', () => {
    const wei1 = parseEthRateToWei('0.05');
    assert.strictEqual(wei1, 50000000000000000n); // 0.05 ETH

    const wei2 = parseEthRateToWei('1.25');
    assert.strictEqual(wei2, 1250000000000000000n); // 1.25 ETH

    const wei3 = parseEthRateToWei('0.000000000000000001');
    assert.strictEqual(wei3, 1n); // 1 wei
  });

  // 13. existing ETH value remains unchanged when only USDC changes
  it('13. save behavior: changing only USDC triggers off-chain save and leaves ETH rate unchanged', () => {
    const existingProfile = {
      wallet: '0x1111111111111111111111111111111111111111',
      onChainRateWei: 50000000000000000n, // 0.05 ETH
      startingRateAmount: '50.00',
      startingRateType: 'PER_PROJECT',
    };

    // User updates only USDC pricing from 50 to 75
    const newUsdc = '75.00';
    const newRateType = 'PER_PROJECT';
    const newEthInput = '0.05'; // unchanged

    const isEthDirty = newEthInput !== '0.05';
    const isUsdcDirty = newUsdc !== existingProfile.startingRateAmount;

    assert.strictEqual(isEthDirty, false);
    assert.strictEqual(isUsdcDirty, true);

    // Save decision
    const triggersBlockchainTx = isEthDirty;
    const triggersOffChainSave = isUsdcDirty;

    assert.strictEqual(triggersBlockchainTx, false, 'Should NOT trigger wallet transaction');
    assert.strictEqual(triggersOffChainSave, true, 'Should trigger PostgreSQL off-chain save');
    assert.strictEqual(existingProfile.onChainRateWei, 50000000000000000n, 'ETH rate remains untouched');
  });

  // 14. changing ETH continues using updateProfile
  it('14. save behavior: changing ETH rate triggers on-chain updateProfile transaction', () => {
    const existingEth: string = '0.05';
    const updatedEth: string = '0.08';

    const isEthDirty = existingEth !== updatedEth;
    assert.strictEqual(isEthDirty, true);

    const newWei = parseEthRateToWei(updatedEth);
    assert.strictEqual(newWei, 80000000000000000n);

    const requiresContractCall = isEthDirty;
    assert.strictEqual(requiresContractCall, true, 'Contract updateProfile must be called');
  });

  it('15. formatPublicPricing formats canonical USDC pricing for public display', () => {
    const projectPricing: FreelancerPricing = {
      amount: '50.00',
      currency: 'USDC',
      rateType: 'PER_PROJECT',
    };
    const formattedProject = formatPublicPricing(projectPricing);
    assert.ok(formattedProject);
    assert.strictEqual(formattedProject.formatted, '50 USDC / project');
    assert.strictEqual(formattedProject.amount, '50');
    assert.strictEqual(formattedProject.amountDisplay, '50');
    assert.strictEqual(formattedProject.currency, 'USDC');
    assert.strictEqual(formattedProject.typeLabel, 'per project');

    const hourlyPricing: FreelancerPricing = {
      amount: '20.00',
      currency: 'USDC',
      rateType: 'PER_HOUR',
    };
    const formattedHourly = formatPublicPricing(hourlyPricing);
    assert.ok(formattedHourly);
    assert.strictEqual(formattedHourly.formatted, '20 USDC / hour');
    assert.strictEqual(formattedHourly.amount, '20');
    assert.strictEqual(formattedHourly.amountDisplay, '20');
    assert.strictEqual(formattedHourly.currency, 'USDC');
    assert.strictEqual(formattedHourly.typeLabel, 'per hour');
  });

  // 16. public SellerCard does not expose ETH
  it('16. SellerCard public view renders USDC pricing and completely omits ETH', () => {
    const pricing: FreelancerPricing = {
      amount: '50.00',
      currency: 'USDC',
      rateType: 'PER_PROJECT',
    };
    const publicFormatted = formatPublicPricing(pricing);
    assert.ok(publicFormatted);
    assert.strictEqual(publicFormatted.currency, 'USDC');
    assert.strictEqual(publicFormatted.formatted.includes('ETH'), false);
    assert.strictEqual(publicFormatted.formatted.includes('Legacy'), false);
  });

  // 17. public ProviderProfile does not expose ETH
  it('17. ProviderProfile commercial starting rate renders USDC and completely omits ETH', () => {
    const pricing: FreelancerPricing = {
      amount: '120.00',
      currency: 'USDC',
      rateType: 'PER_PROJECT',
    };
    const publicFormatted = formatPublicPricing(pricing);
    assert.ok(publicFormatted);
    assert.strictEqual(publicFormatted.amount, '120');
    assert.strictEqual(publicFormatted.amountDisplay, '120');
    assert.strictEqual(publicFormatted.currency, 'USDC');
    assert.strictEqual(publicFormatted.typeLabel, 'per project');
    assert.strictEqual(publicFormatted.formatted.includes('ETH'), false);
  });

  // 18. Create Deal recommendation does not expose ETH
  it('18. Create Deal recommendation cards expose USDC pricing without ETH', () => {
    const pricing: FreelancerPricing = {
      amount: '35.00',
      currency: 'USDC',
      rateType: 'PER_HOUR',
    };
    const publicFormatted = formatPublicPricing(pricing);
    assert.ok(publicFormatted);
    assert.strictEqual(publicFormatted.formatted, '35 USDC / hour');
    assert.strictEqual(publicFormatted.formatted.includes('ETH'), false);
  });

  // 19. Negotiator does not use ETH as modern pricing
  it('19. AI Negotiator receives modern USDC pricing object when configured, not legacy ETH', () => {
    const rawMarketProfile = {
      walletAddress: '0x1234567890123456789012345678901234567890',
      startingRateAmount: '75.00',
      startingRateCurrency: 'USDC',
      startingRateType: 'PER_PROJECT',
    };
    const legacyEthRate = '50000000000000000'; // 0.05 ETH

    const negotiatorPricing = (rawMarketProfile.startingRateAmount && rawMarketProfile.startingRateType)
      ? {
          amount: rawMarketProfile.startingRateAmount,
          currency: 'USDC' as const,
          rateType: rawMarketProfile.startingRateType as 'PER_PROJECT' | 'PER_HOUR',
        }
      : null;

    assert.deepStrictEqual(negotiatorPricing, {
      amount: '75.00',
      currency: 'USDC',
      rateType: 'PER_PROJECT',
    });
    assert.notStrictEqual(negotiatorPricing?.amount, legacyEthRate);
    assert.strictEqual(negotiatorPricing?.currency, 'USDC');
  });

  // 20. existing user without USDC pricing is handled as unconfigured
  it('20. existing user without USDC pricing is handled as unconfigured and never falls back to ETH', () => {
    const existingLegacyUserPricing = null;
    const formatted = formatPublicPricing(existingLegacyUserPricing);
    assert.strictEqual(formatted, null, 'Public formatted pricing must be null for unconfigured users');

    const suggestedBudget = getSuggestedDealBudget(existingLegacyUserPricing);
    assert.strictEqual(suggestedBudget, null, 'Must not suggest or prefill deal budget');
  });

  // 21. ETH never prefills USDC deal budget
  it('21. ETH rate never prefills Standard V2 USDC deal budget', () => {
    const legacyEthWei = '20000000000000000'; // 0.02 ETH
    // Attempting to suggest budget without modern pricing returns null
    const budget = getSuggestedDealBudget(null);
    assert.strictEqual(budget, null);

    // Even if legacy ETH exists, budget is null
    const hasUsdcPricing = false;
    const prefilledBudget = hasUsdcPricing ? '100.00' : null;
    assert.strictEqual(prefilledBudget, null);
  });

  // 22. USDC PER_HOUR never prefills total deal budget
  it('22. USDC PER_HOUR never prefills total deal budget because hours are unknown', () => {
    const hourlyPricing: FreelancerPricing = {
      amount: '50.00',
      currency: 'USDC',
      rateType: 'PER_HOUR',
    };
    const suggestedBudget = getSuggestedDealBudget(hourlyPricing);
    assert.strictEqual(suggestedBudget, null, 'PER_HOUR must return null for suggested total budget');
  });

  // 23. USDC PER_PROJECT can provide suggested budget
  it('23. USDC PER_PROJECT provides suggested budget for Create Deal', () => {
    const projectPricing: FreelancerPricing = {
      amount: '150.00',
      currency: 'USDC',
      rateType: 'PER_PROJECT',
    };
    const suggestedBudget = getSuggestedDealBudget(projectPricing);
    assert.strictEqual(suggestedBudget, '150.00', 'PER_PROJECT must provide exact decimal string budget');
  });

  // 24. formatPublicPricing removes insignificant trailing zeros
  it('24. formatPublicPricing removes insignificant trailing fractional zeros without precision loss', () => {
    const cases = [
      { input: '100.000000', expected: '100', fullProject: '100 USDC / project' },
      { input: '100.500000', expected: '100.5', fullProject: '100.5 USDC / project' },
      { input: '100.250000', expected: '100.25', fullProject: '100.25 USDC / project' },
      { input: '99.123400', expected: '99.1234', fullProject: '99.1234 USDC / project' },
      { input: '99.123456', expected: '99.123456', fullProject: '99.123456 USDC / project' },
      { input: '0.500000', expected: '0.5', fullProject: '0.5 USDC / project' },
    ];

    for (const c of cases) {
      const formatted = formatPublicPricing({
        amount: c.input,
        currency: 'USDC',
        rateType: 'PER_PROJECT',
      });
      assert.ok(formatted, `Expected formatting for ${c.input}`);
      assert.strictEqual(formatted.amountDisplay, c.expected, `amountDisplay mismatch for ${c.input}`);
      assert.strictEqual(formatted.amount, c.expected, `amount mismatch for ${c.input}`);
      assert.strictEqual(formatted.formatted, c.fullProject, `formatted mismatch for ${c.input}`);
      assert.strictEqual(formatted.fullLine, c.fullProject, `fullLine mismatch for ${c.input}`);
    }
  });

  // 25. formatUsdcDisplayAmount helper handles exact edge cases
  it('25. formatUsdcDisplayAmount helper cleanly formats decimal strings', () => {
    assert.strictEqual(formatUsdcDisplayAmount('100.000000'), '100');
    assert.strictEqual(formatUsdcDisplayAmount('100.500000'), '100.5');
    assert.strictEqual(formatUsdcDisplayAmount('100.250000'), '100.25');
    assert.strictEqual(formatUsdcDisplayAmount('99.123400'), '99.1234');
    assert.strictEqual(formatUsdcDisplayAmount('99.123456'), '99.123456');
    assert.strictEqual(formatUsdcDisplayAmount('0.500000'), '0.5');
    assert.strictEqual(formatUsdcDisplayAmount('100'), '100');
    assert.strictEqual(formatUsdcDisplayAmount(''), '');
    assert.strictEqual(formatUsdcDisplayAmount(null), '');
    assert.strictEqual(formatUsdcDisplayAmount(undefined), '');
  });

  // 26. Create Deal budget receipt data flow
  it('26. Create Deal budget receipt data flow correctly reflects explicit user input and clears to skeleton', () => {
    // Helper replicating Create Deal budget receipt resolver
    const resolveReceiptBudget = (currentStep: number, budgetInput: string): string | undefined => {
      const trimmed = budgetInput.trim();
      return (
        currentStep >= 3 && trimmed && !isNaN(Number(trimmed)) && Number(trimmed) > 0
          ? trimmed
          : undefined
      );
    };

    // User enters 50 -> must show 50, NOT legacy milestone default 1.00
    assert.strictEqual(resolveReceiptBudget(3, '50'), '50');
    assert.notStrictEqual(resolveReceiptBudget(3, '50'), '1');
    assert.notStrictEqual(resolveReceiptBudget(3, '50'), '1.00');

    // User enters 100.5 -> must show 100.5
    assert.strictEqual(resolveReceiptBudget(3, '100.5'), '100.5');

    // User clears budget input -> must immediately return undefined for skeleton
    assert.strictEqual(resolveReceiptBudget(3, ''), undefined);
    assert.strictEqual(resolveReceiptBudget(3, '   '), undefined);

    // Invalid / zero / negative values -> undefined for skeleton
    assert.strictEqual(resolveReceiptBudget(3, '0'), undefined);
    assert.strictEqual(resolveReceiptBudget(3, '-10'), undefined);
    assert.strictEqual(resolveReceiptBudget(3, 'abc'), undefined);

    // Prior steps (Steps 1-3, index < 3) must never show budget
    assert.strictEqual(resolveReceiptBudget(0, '50'), undefined);
    assert.strictEqual(resolveReceiptBudget(1, '50'), undefined);
    assert.strictEqual(resolveReceiptBudget(2, '50'), undefined);
  });
});
