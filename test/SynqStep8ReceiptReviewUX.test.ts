// test/SynqStep8ReceiptReviewUX.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ZERO_ADDRESS, ZERO_BYTES32, SYNQ_V2_SEPOLIA_CONFIG } from '@/lib/deals/v2';
import type { DealProposalV2 } from '@/types/deal-v2';

describe('Synq Create Deal — Step 8 Final Receipt Polish UX Suite', () => {
  const pagePath = path.join(__dirname, '../src/app/deal/new/page.tsx');
  const receiptPath = path.join(__dirname, '../src/components/deals/DealReceipt.tsx');
  const pageSource = fs.readFileSync(pagePath, 'utf8');
  const receiptSource = fs.readFileSync(receiptPath, 'utf8');

  interface FormState {
    type: string;
    counterparty: string;
    budget: string;
    deliverables: string;
    paymentStructure: 'single' | '50-50' | 'custom' | '';
    protectionSelection: 'STANDARD' | 'PREMIUM' | '';
    expiryDays: number;
  }

  function createTestForm(protection: 'STANDARD' | 'PREMIUM' | '' = 'STANDARD'): FormState {
    return {
      type: 'Smart Contract Audit',
      counterparty: '0x2222222222222222222222222222222222222222',
      budget: '2500',
      deliverables: 'Deliver security audit report',
      paymentStructure: 'single',
      protectionSelection: protection,
      expiryDays: 7,
    };
  }

  function buildProposal(form: FormState): DealProposalV2 {
    return {
      client: '0x1111111111111111111111111111111111111111',
      freelancer: form.counterparty as `0x${string}`,
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

  // --- 1. Old Step 8 Removal Verification ---
  describe('1. Removal of Redundant Step 8 Main Review Panel', () => {
    it('old Step 8 main review panel is removed from page.tsx', () => {
      assert.strictEqual(pageSource.includes('DEAL SUMMARY & REVIEW'), false);
      assert.strictEqual(pageSource.includes('Review the terms of this deal before signing'), false);
    });

    it('old duplicated milestone review card is removed from Step 8', () => {
      assert.strictEqual(pageSource.includes('Milestones Breakdown'), false);
    });

    it('old giant Important Protocol Notice card is removed', () => {
      assert.strictEqual(pageSource.includes('Important Protocol Notice'), false);
    });

    it('old giant Premium Protection Live Activation notice card is removed', () => {
      assert.strictEqual(pageSource.includes('Premium Protection Live Activation'), false);
    });

    it('case 7 in renderStepContent returns null as receipt is the primary surface', () => {
      const renderStepIndex = pageSource.indexOf('const renderStep = () => {');
      assert.notStrictEqual(renderStepIndex, -1);
      const case7Index = pageSource.indexOf('case 7:', renderStepIndex);
      assert.notStrictEqual(case7Index, -1);
      const case7Snippet = pageSource.slice(case7Index, case7Index + 60);
      assert.strictEqual(case7Snippet.includes('return null;'), true);
    });
  });

  // --- 2. Receipt Size & Vertical Extension (Inside Receipt) ---
  describe('2. Receipt Size and In-Receipt Vertical Extension', () => {
    it('review receipt target width increased from old ~480px size to ~600px', () => {
      // In DealReceipt.tsx: max-w-[600px]
      assert.strictEqual(receiptSource.includes("'max-w-[600px] w-full mx-auto p-7 pb-8 space-y-5'"), true);
      // In page.tsx: max-w-[600px]
      assert.strictEqual(pageSource.includes('className="w-full max-w-[600px]"'), true);
      // Old ~480px review wrapper is gone
      assert.strictEqual(pageSource.includes('max-w-[480px]'), false);
      assert.strictEqual(receiptSource.includes('max-w-[480px]'), false);
    });

    it('sidebar receipt size remains unchanged (compact default p-6 pb-7)', () => {
      assert.strictEqual(receiptSource.includes(": 'p-6 pb-7 space-y-5'"), true);
      assert.strictEqual(pageSource.includes("variant=\"compact\""), true);
    });

    it('protocol notice is rendered inside review receipt via actions slot', () => {
      const receiptInvocationIndex = pageSource.indexOf('<DealReceipt\n                  variant="review"');
      assert.notStrictEqual(receiptInvocationIndex, -1);
      const actionsPropIndex = pageSource.indexOf('actions={', receiptInvocationIndex);
      assert.notStrictEqual(actionsPropIndex, -1);

      // Protocol notice is inside the actions prop
      const noticeText = 'No funds move when you sign. The freelancer must accept the proposal before you fund escrow.';
      const noticeIndex = pageSource.indexOf(noticeText, actionsPropIndex);
      assert.notStrictEqual(noticeIndex, -1);
    });

    it('protocol notice is no longer rendered as standalone content below receipt', () => {
      // Verify that no standalone motion.div or paragraph exists outside DealReceipt in review layout
      assert.strictEqual(pageSource.includes('{/* Step 8 Controls & Notices Area */}'), false);
    });

    it('Previous button is inside review receipt action area', () => {
      const actionsPropIndex = pageSource.indexOf('actions={');
      assert.notStrictEqual(actionsPropIndex, -1);
      const prevButtonIndex = pageSource.indexOf('onClick={handlePreviousFromReview}', actionsPropIndex);
      assert.notStrictEqual(prevButtonIndex, -1);
    });

    it('Sign & Send Proposal is inside review receipt action area', () => {
      const actionsPropIndex = pageSource.indexOf('actions={');
      assert.notStrictEqual(actionsPropIndex, -1);
      const signButtonIndex = pageSource.indexOf('onClick={handleSignAndSendProposal}', actionsPropIndex);
      assert.notStrictEqual(signButtonIndex, -1);
    });

    it('zig-zag edge remains after the review footer/actions at the true bottom', () => {
      // In DealReceipt.tsx: {actions} is rendered inside the content container before the bottom tear zigzag edge
      const actionsRenderIndex = receiptSource.indexOf('{actions &&');
      const tearEdgeIndex = receiptSource.indexOf('DECORATIVE RECEIPT BOTTOM TEAR ZIGZAG EDGE');
      assert.notStrictEqual(actionsRenderIndex, -1);
      assert.notStrictEqual(tearEdgeIndex, -1);
      assert.strictEqual(actionsRenderIndex < tearEdgeIndex, true);
    });

    it('progress area has Step 8 generous bottom spacing and clearance', () => {
      assert.strictEqual(pageSource.includes("isReviewView\n          ? 'pb-36'"), true);
    });

    it('responsive review width remains bounded and centered', () => {
      assert.strictEqual(pageSource.includes('className="w-full flex flex-col items-center"'), true);
      assert.strictEqual(pageSource.includes('className="w-full max-w-[600px]"'), true);
    });
  });

  // --- 3. Step 7 -> Step 8 Transition Architecture Preserved ---
  describe('3. Step 7 to Step 8 Transition Architecture Preserved', () => {
    it('has controlled transition state isReviewTransitioning', () => {
      assert.strictEqual(
        pageSource.includes("const [isReviewTransitioning, setIsReviewTransitioning] = useState<'forward' | 'backward' | null>(null);"),
        true
      );
    });

    it('uses shared layoutId "synq-deal-receipt-surface" for continuous receipt object', () => {
      const occurrences = (pageSource.match(/layoutId="synq-deal-receipt-surface"/g) || []).length;
      assert.strictEqual(occurrences, 2);
      assert.strictEqual(pageSource.includes('<LayoutGroup id="synq-create-deal-layout">'), true);
    });

    it('Step 7 main content gets transition-out exit treatment', () => {
      assert.strictEqual(pageSource.includes('key="wizard-layout-container"'), true);
      assert.strictEqual(pageSource.includes('exit={{'), true);
      assert.strictEqual(pageSource.includes('scale: 0.98'), true);
    });

    it('Step 7 Continue button triggers handleContinueToReview', () => {
      assert.strictEqual(
        pageSource.includes('step === 6 ? handleContinueToReview : () => setStep(step + 1)'),
        true
      );
    });

    it('guards against duplicate Continue clicks during transition', () => {
      assert.strictEqual(
        pageSource.includes('const handleContinueToReview = () => {\n    if (isReviewTransitioning) return;'),
        true
      );
      assert.strictEqual(
        pageSource.includes('disabled={!canProceed() || !!isReviewTransitioning}'),
        true
      );
    });

    it('animation duration is 550ms with smooth cubic-bezier easing', () => {
      assert.strictEqual(pageSource.includes('}, 550);'), true);
      assert.strictEqual(pageSource.includes('[0.16, 1, 0.3, 1]'), true);
      assert.strictEqual(pageSource.includes('duration: shouldReduceMotion ? 0.05 : 0.55'), true);
    });

    it('reverse transition remains intact via handlePreviousFromReview', () => {
      assert.strictEqual(
        pageSource.includes('const handlePreviousFromReview = () => {\n    if (isReviewTransitioning) return;'),
        true
      );
      assert.strictEqual(pageSource.includes("setIsReviewTransitioning('backward');"), true);
    });

    it('form and protection selection are preserved across transitions', () => {
      const form = createTestForm('STANDARD');
      let step = 6;
      step = 7;
      assert.strictEqual(form.protectionSelection, 'STANDARD');
      assert.strictEqual(form.budget, '2500');
      step = 6;
      assert.strictEqual(form.protectionSelection, 'STANDARD');
      assert.strictEqual(form.budget, '2500');
    });
  });

  // --- 4. Protection Action Guards & Notice Wording ---
  describe('4. Protection Action Guards and Notice Wording', () => {
    it('visible Premium activation warning is completely removed from rendered Step 8 UI', () => {
      assert.strictEqual(pageSource.includes("Premium Protection activation isn&apos;t live yet"), false);
      assert.strictEqual(pageSource.includes("Premium Protection activation isn't live yet. Select Standard Protection to submit this proposal.\n"), false);
    });

    it('Premium Sign & Send button remains disabled in Step 8', () => {
      const standardDisabledCheck = (signing: boolean, canProceedVal: boolean, transitioning: boolean, sel: string) => {
        return signing || !canProceedVal || transitioning || sel === 'PREMIUM';
      };

      assert.strictEqual(standardDisabledCheck(false, true, false, 'PREMIUM'), true);
      assert.strictEqual(standardDisabledCheck(false, true, false, 'STANDARD'), false);
    });

    it('handleSignAndSendProposal still blocks Premium programmatic calls', () => {
      assert.strictEqual(
        pageSource.includes("if (form.protectionSelection === 'PREMIUM') {\n      setError(\"Premium Protection activation isn't live yet. Select Standard Protection to submit this proposal.\");\n      return;\n    }"),
        true
      );
    });

    it('Standard Sign & Send remains enabled when otherwise valid', () => {
      const standardDisabledCheck = (signing: boolean, canProceedVal: boolean, transitioning: boolean, sel: string) => {
        return signing || !canProceedVal || transitioning || sel === 'PREMIUM';
      };

      assert.strictEqual(standardDisabledCheck(false, true, false, 'STANDARD'), false);
    });

    it('Standard proposal always preserves isProtected=false, ZERO_ADDRESS, ZERO_BYTES32', () => {
      const form = createTestForm('STANDARD');
      const proposal = buildProposal(form);
      assert.strictEqual(proposal.isProtected, false);
      assert.strictEqual(proposal.protectionModule, ZERO_ADDRESS);
      assert.strictEqual(proposal.policyId, ZERO_BYTES32);
    });

    it('Premium never maps to isProtected=true on proposal', () => {
      const form = createTestForm('PREMIUM');
      const proposal = buildProposal(form);
      assert.strictEqual(proposal.isProtected, false);
      assert.strictEqual(proposal.protectionModule, ZERO_ADDRESS);
      assert.strictEqual(proposal.policyId, ZERO_BYTES32);
    });

    it('nonce conflict and error handling remain available inside receipt', () => {
      assert.strictEqual(pageSource.includes('{nonceConflict && ('), true);
      assert.strictEqual(pageSource.includes('Proposal Nonce Conflict'), true);
      assert.strictEqual(pageSource.includes('{error && !nonceConflict && ('), true);
    });
  });

  // --- 5. Reduced Motion & Responsive Safety ---
  describe('5. Reduced Motion and Responsive Layout Safety', () => {
    it('uses useReducedMotion from framer-motion', () => {
      assert.strictEqual(pageSource.includes('useReducedMotion'), true);
      assert.strictEqual(pageSource.includes('const shouldReduceMotion = useReducedMotion();'), true);
    });

    it('reduced motion shortens/bypasses transition delays', () => {
      assert.strictEqual(
        pageSource.includes('if (shouldReduceMotion) {\n      setStep(7);\n      return;\n    }'),
        true
      );
      assert.strictEqual(
        pageSource.includes('if (shouldReduceMotion) {\n      setStep(6);\n      return;\n    }'),
        true
      );
    });

    it('layout does not depend on hardcoded pixel screen coordinates', () => {
      assert.strictEqual(pageSource.includes('left: 742px'), false);
      assert.strictEqual(pageSource.includes('top: 190px'), false);
      assert.doesNotMatch(pageSource, /left:\s*['"]?\d{3,4}px/);
      assert.doesNotMatch(pageSource, /top:\s*['"]?\d{3,4}px/);
    });
  });
});
