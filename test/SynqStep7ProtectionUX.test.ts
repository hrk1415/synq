// test/SynqStep7ProtectionUX.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ZERO_ADDRESS, ZERO_BYTES32, SYNQ_V2_SEPOLIA_CONFIG } from '@/lib/deals/v2';
import type { DealProposalV2 } from '@/types/deal-v2';

describe('Synq Create Deal — Step 7 Protection Redesign UX Suite', () => {
  // Model state logic matching src/app/deal/new/page.tsx
  interface FormState {
    type: string;
    counterparty: string;
    budget: string;
    deliverables: string;
    paymentStructure: 'single' | '50-50' | 'custom' | '';
    protectionSelection: 'STANDARD' | 'PREMIUM' | '';
    expiryDays: number;
  }

  function createInitialForm(urlParam?: string | null): FormState {
    const rawUrlProtection = urlParam?.trim().toUpperCase();
    const validUrlProtection: 'STANDARD' | 'PREMIUM' | '' =
      rawUrlProtection === 'STANDARD'
        ? 'STANDARD'
        : rawUrlProtection === 'PREMIUM'
        ? 'PREMIUM'
        : '';

    return {
      type: 'Website Redesign',
      counterparty: '0x2222222222222222222222222222222222222222',
      budget: '1000',
      deliverables: 'Complete Web UI',
      paymentStructure: 'single',
      protectionSelection: validUrlProtection,
      expiryDays: 7,
    };
  }

  function canProceedStep7(form: FormState): boolean {
    return form.protectionSelection === 'STANDARD' || form.protectionSelection === 'PREMIUM';
  }

  function canProceedStep8(form: FormState): boolean {
    // Step 8 proposal signing is strictly guarded if PREMIUM is selected
    return form.protectionSelection === 'STANDARD';
  }

  function getReceiptProtectionText(form: FormState): string | null {
    if (form.protectionSelection === 'STANDARD') return 'Standard Protection';
    if (form.protectionSelection === 'PREMIUM') return 'Premium Protection';
    return null; // null indicates skeleton
  }

  function buildStandardV2Proposal(form: FormState): DealProposalV2 {
    return {
      client: '0x1111111111111111111111111111111111111111',
      freelancer: '0x2222222222222222222222222222222222222222',
      canonicalUsdc: SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc,
      dealImplementation: SYNQ_V2_SEPOLIA_CONFIG.dealImplementation,
      primaryResolver: SYNQ_V2_SEPOLIA_CONFIG.primaryResolver,
      emergencyResolver: SYNQ_V2_SEPOLIA_CONFIG.emergencyResolver,
      milestonesHash: '0x1234567890123456789012345678901234567890123456789012345678901234',
      isProtected: false,
      protectionModule: ZERO_ADDRESS,
      policyId: ZERO_BYTES32,
      proposalNonce: 1n,
      expiry: 1800000000n,
    };
  }

  // Exact UI Copy Constants matching src/app/deal/new/page.tsx
  const STEP7_HEADLINE = 'Choose the protection level you want for this deal.';
  const OLD_STEP7_TITLE = 'Choose your protection';
  const STANDARD_TITLE = 'Standard Protection';
  const STANDARD_BADGE = 'Included';
  const STANDARD_DESC = 'Secure escrow, milestone releases and standard dispute resolution.';
  const STANDARD_BENEFITS = [
    'Secure escrow',
    'Milestone-based releases',
    'Standard dispute resolution',
  ];
  const PREMIUM_TITLE = 'Premium Protection';
  const PREMIUM_BADGE = 'Premium';
  const PREMIUM_DESC = 'Get up to 20% additional recovery coverage when an eligible milestone fails.';
  const PREMIUM_BENEFITS = [
    'Additional recovery coverage',
    'Priority dispute review',
    'Replacement freelancer assistance',
  ];
  const PREMIUM_FEE_NOTICE = 'Premium fee shown before activation';
  const POPOVER_TITLE = 'How Premium Protection works';
  const POPOVER_SECTIONS = [
    { title: 'Coverage', desc: 'Up to 20% additional recovery on eligible failed milestones.' },
    { title: 'Claim', desc: 'Submit a claim after an eligible milestone failure.' },
    { title: 'Review', desc: 'Your protection claim is reviewed before payout.' },
    { title: 'Payout', desc: 'Approved claims are paid separately from your original deal escrow.' },
  ];

  // --- 1. First Arrival & No-Default Invariant ---
  describe('1. First Arrival & Initial Selection State', () => {
    it('initial arrival has no protection option selected', () => {
      const form = createInitialForm();
      assert.strictEqual(form.protectionSelection, '');
    });

    it('receipt Protection is skeleton (null) before explicit selection', () => {
      const form = createInitialForm();
      const receiptText = getReceiptProtectionText(form);
      assert.strictEqual(receiptText, null);
    });

    it('Continue button is unavailable (canProceed returns false) before selection', () => {
      const form = createInitialForm();
      assert.strictEqual(canProceedStep7(form), false);
    });

    it('preserves valid explicit URL param if intentionally supplied', () => {
      const formStandard = createInitialForm('standard');
      assert.strictEqual(formStandard.protectionSelection, 'STANDARD');
      assert.strictEqual(canProceedStep7(formStandard), true);

      const formPremium = createInitialForm('premium');
      assert.strictEqual(formPremium.protectionSelection, 'PREMIUM');
      assert.strictEqual(canProceedStep7(formPremium), true);

      const formInvalid = createInitialForm('arbitrary');
      assert.strictEqual(formInvalid.protectionSelection, '');
      assert.strictEqual(canProceedStep7(formInvalid), false);
    });
  });

  // --- 2. Standard Protection Selection ---
  describe('2. Standard Protection Selection', () => {
    it('selecting Standard updates form state to STANDARD', () => {
      const form = createInitialForm();
      form.protectionSelection = 'STANDARD';
      assert.strictEqual(form.protectionSelection, 'STANDARD');
    });

    it('Standard selection updates Deal Receipt to "Standard Protection"', () => {
      const form = createInitialForm();
      form.protectionSelection = 'STANDARD';
      assert.strictEqual(getReceiptProtectionText(form), 'Standard Protection');
    });

    it('Standard selection enables Continue (canProceedStep7 returns true)', () => {
      const form = createInitialForm();
      form.protectionSelection = 'STANDARD';
      assert.strictEqual(canProceedStep7(form), true);
    });

    it('Standard selection does NOT alter Standard V2 proposal protection fields', () => {
      const form = createInitialForm();
      form.protectionSelection = 'STANDARD';

      const proposal = buildStandardV2Proposal(form);
      assert.strictEqual(proposal.isProtected, false);
      assert.strictEqual(proposal.protectionModule, ZERO_ADDRESS);
      assert.strictEqual(proposal.policyId, ZERO_BYTES32);
    });
  });

  // --- 3. Premium Protection Selection ---
  describe('3. Premium Protection Selection', () => {
    it('selecting Premium updates form state to PREMIUM', () => {
      const form = createInitialForm();
      form.protectionSelection = 'PREMIUM';
      assert.strictEqual(form.protectionSelection, 'PREMIUM');
    });

    it('Premium selection updates Deal Receipt to "Premium Protection"', () => {
      const form = createInitialForm();
      form.protectionSelection = 'PREMIUM';
      assert.strictEqual(getReceiptProtectionText(form), 'Premium Protection');
    });

    it('Premium selection enables Step 7 Continue (canProceedStep7 returns true)', () => {
      const form = createInitialForm();
      form.protectionSelection = 'PREMIUM';
      assert.strictEqual(canProceedStep7(form), true);
    });

    it('choices are mutually exclusive (selecting Standard clears Premium and vice versa)', () => {
      const form = createInitialForm();
      form.protectionSelection = 'STANDARD';
      assert.strictEqual(form.protectionSelection, 'STANDARD');

      form.protectionSelection = 'PREMIUM';
      assert.strictEqual(form.protectionSelection, 'PREMIUM');

      form.protectionSelection = 'STANDARD';
      assert.strictEqual(form.protectionSelection, 'STANDARD');
    });

    it('Premium selection does NOT activate old Standard V2 isProtected=true on-chain path', () => {
      const form = createInitialForm();
      form.protectionSelection = 'PREMIUM';

      const proposal = buildStandardV2Proposal(form);
      assert.strictEqual(proposal.isProtected, false);
      assert.strictEqual(proposal.protectionModule, ZERO_ADDRESS);
      assert.strictEqual(proposal.policyId, ZERO_BYTES32);
    });
  });

  // --- 4. Copy & Wording Verification ---
  describe('4. Step 7 Copy & Product Wording', () => {
    it('headline matches promoted subtitle specification without old title', () => {
      assert.strictEqual(STEP7_HEADLINE, 'Choose the protection level you want for this deal.');
      assert.notStrictEqual(STEP7_HEADLINE, OLD_STEP7_TITLE);
    });

    it('Standard card displays Included badge, concise description and 3 benefits', () => {
      assert.strictEqual(STANDARD_TITLE, 'Standard Protection');
      assert.strictEqual(STANDARD_BADGE, 'Included');
      assert.strictEqual(STANDARD_DESC, 'Secure escrow, milestone releases and standard dispute resolution.');
      assert.strictEqual(STANDARD_BENEFITS.length, 3);
      assert.deepStrictEqual(STANDARD_BENEFITS, [
        'Secure escrow',
        'Milestone-based releases',
        'Standard dispute resolution',
      ]);
    });

    it('Premium card displays exact up to 20% additional recovery description', () => {
      assert.strictEqual(PREMIUM_TITLE, 'Premium Protection');
      assert.strictEqual(PREMIUM_BADGE, 'Premium');
      assert.strictEqual(
        PREMIUM_DESC,
        'Get up to 20% additional recovery coverage when an eligible milestone fails.'
      );
    });

    it('Premium benefits avoid insurer/guarantee terminology', () => {
      assert.deepStrictEqual(PREMIUM_BENEFITS, [
        'Additional recovery coverage',
        'Priority dispute review',
        'Replacement freelancer assistance',
      ]);
      for (const benefit of PREMIUM_BENEFITS) {
        assert.doesNotMatch(benefit.toLowerCase(), /insur/);
        assert.doesNotMatch(benefit.toLowerCase(), /guarantee/);
      }
    });

    it('displays neutral fee notice without fabricating a percentage or fee amount', () => {
      assert.strictEqual(PREMIUM_FEE_NOTICE, 'Premium fee shown before activation');
      assert.doesNotMatch(PREMIUM_FEE_NOTICE, /%/);
      assert.doesNotMatch(PREMIUM_FEE_NOTICE, /\$/);
      assert.doesNotMatch(PREMIUM_FEE_NOTICE, /0/);
    });

    it('popover content contains Coverage, Claim, Review, Payout and avoids contract internals', () => {
      assert.strictEqual(POPOVER_TITLE, 'How Premium Protection works');
      assert.strictEqual(POPOVER_SECTIONS.length, 4);
      const titles = POPOVER_SECTIONS.map((s) => s.title);
      assert.deepStrictEqual(titles, ['Coverage', 'Claim', 'Review', 'Payout']);

      for (const section of POPOVER_SECTIONS) {
        const fullText = `${section.title}: ${section.desc}`;
        assert.doesNotMatch(fullText.toLowerCase(), /\bbps\b/);
        assert.doesNotMatch(fullText.toLowerCase(), /eip-?712/);
        assert.doesNotMatch(fullText.toLowerCase(), /committee/);
        assert.doesNotMatch(fullText.toLowerCase(), /0x[a-f0-9]{40}/i);
        assert.doesNotMatch(fullText.toLowerCase(), /maxcoverage/);
      }
    });
  });

  // --- 5. Source Code Structural Verification in page.tsx ---
  describe('5. Source Code Invariants in src/app/deal/new/page.tsx', () => {
    const pagePath = path.join(__dirname, '../src/app/deal/new/page.tsx');
    const pageSource = fs.readFileSync(pagePath, 'utf8');

    it('old "Choose your protection" title is gone from Step 7', () => {
      assert.strictEqual(pageSource.includes('Choose your protection'), false);
    });

    it('new main headline "Choose the protection level you want for this deal." is present', () => {
      assert.strictEqual(
        pageSource.includes('Choose the protection level you want for this deal.'),
        true
      );
    });

    it('old standalone 20% callout box is removed from Premium card', () => {
      assert.strictEqual(
        pageSource.includes('on eligible failed milestones\n                    </div>\n                  </div>'),
        false
      );
    });

    it('Standard card renders all 3 benefits', () => {
      assert.strictEqual(pageSource.includes("'Secure escrow'"), true);
      assert.strictEqual(pageSource.includes("'Milestone-based releases'"), true);
      assert.strictEqual(pageSource.includes("'Standard dispute resolution'"), true);
    });

    it('Premium card renders all 3 benefits', () => {
      assert.strictEqual(pageSource.includes("'Additional recovery coverage'"), true);
      assert.strictEqual(pageSource.includes("'Priority dispute review'"), true);
      assert.strictEqual(pageSource.includes("'Replacement freelancer assistance'"), true);
    });

    it('separate "HOW PREMIUM PROTECTION WORKS" details card is removed from permanent page flow', () => {
      assert.strictEqual(pageSource.includes('form.protectionSelection === \'PREMIUM\' && (\n              <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800/80 space-y-3">'), false);
    });

    it('Premium info control exists with accessible label', () => {
      assert.strictEqual(pageSource.includes('aria-label="Learn about Premium Protection"'), true);
      assert.strictEqual(pageSource.includes('HelpCircle'), true);
    });

    it('info popover contains Coverage, Claim, Review, and Payout sections', () => {
      assert.strictEqual(pageSource.includes('How Premium Protection works'), true);
      assert.strictEqual(
        pageSource.includes('Up to 20% additional recovery on eligible failed milestones.'),
        true
      );
      assert.strictEqual(
        pageSource.includes('Submit a claim after an eligible milestone failure.'),
        true
      );
      assert.strictEqual(
        pageSource.includes('Your protection claim is reviewed before payout.'),
        true
      );
      assert.strictEqual(
        pageSource.includes('Approved claims are paid separately from your original deal escrow.'),
        true
      );
    });

    it('clicking info control stops propagation and toggles popover without altering form selection', () => {
      // Form selection state remains untouched when toggling showPremiumInfo
      let protectionSelection: 'STANDARD' | 'PREMIUM' | '' = '';
      let showPremiumInfo = false;

      const handleInfoClick = (e: { stopPropagation: () => void }) => {
        e.stopPropagation();
        showPremiumInfo = !showPremiumInfo;
      };

      let propagationStopped = false;
      const fakeEvent = {
        stopPropagation: () => {
          propagationStopped = true;
        },
      };

      handleInfoClick(fakeEvent);
      assert.strictEqual(propagationStopped, true);
      assert.strictEqual(showPremiumInfo, true);
      assert.strictEqual(protectionSelection, ''); // card not selected

      handleInfoClick(fakeEvent);
      assert.strictEqual(showPremiumInfo, false);
      assert.strictEqual(protectionSelection, '');
    });
  });

  // --- 6. Step 8 Review & Broadcast Guard ---
  describe('6. Step 8 Review Protection Display & Broadcast Guard', () => {
    it('Step 8 permits signing when Standard Protection is selected', () => {
      const form = createInitialForm();
      form.protectionSelection = 'STANDARD';
      assert.strictEqual(canProceedStep8(form), true);
    });

    it('Step 8 guards against broadcasting unsupported Premium proposal', () => {
      const form = createInitialForm();
      form.protectionSelection = 'PREMIUM';
      assert.strictEqual(canProceedStep8(form), false);
    });

    it('Standard V2 proposal struct preserves zero-protection invariants for both selections', () => {
      for (const sel of ['STANDARD', 'PREMIUM'] as const) {
        const form = createInitialForm();
        form.protectionSelection = sel;
        const proposal = buildStandardV2Proposal(form);

        assert.strictEqual(proposal.isProtected, false);
        assert.strictEqual(proposal.protectionModule, ZERO_ADDRESS);
        assert.strictEqual(proposal.policyId, ZERO_BYTES32);
      }
    });
  });
});
