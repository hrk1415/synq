import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsdcAmount, formatUsdcAmount } from '@/lib/deals/v2';
import { formatPublicPricing } from '@/lib/deals/pricing';

// Helper mirror functions matching the implementation in src/app/deal/new/page.tsx
interface FormMilestone {
  title: string;
  description: string;
  amountUsdc: string;
  deadlineDate: string;
  deadlineTime: string;
  reviewWindowSeconds: number;
  gracePeriodSeconds: number;
}

function applyPaymentStructure(
  struct: 'single' | '50-50' | 'custom',
  budgetStr: string,
  type = '',
  deliverables = '',
  deadlineDate = '2026-10-20',
  deadlineTime = '23:59'
): FormMilestone[] {
  const rawBudget = (budgetStr || '').trim();
  let hasValidBudget = false;
  let singleAmount = '';
  let half1Amount = '';
  let half2Amount = '';

  if (rawBudget && !isNaN(Number(rawBudget)) && Number(rawBudget) > 0) {
    try {
      const total = parseUsdcAmount(rawBudget);
      hasValidBudget = true;
      singleAmount = formatUsdcAmount(total);
      const half1 = total / 2n;
      const half2 = total - half1;
      half1Amount = formatUsdcAmount(half1);
      half2Amount = formatUsdcAmount(half2);
    } catch {}
  }

  if (struct === 'single') {
    return [
      {
        title: type ? `${type} — Final Delivery` : 'Final Deliverable',
        description: deliverables || 'Complete deliverable according to agreed scope.',
        amountUsdc: hasValidBudget ? singleAmount : '',
        deadlineDate,
        deadlineTime,
        reviewWindowSeconds: 86400,
        gracePeriodSeconds: 0,
      },
    ];
  } else if (struct === '50-50') {
    return [
      {
        title: 'Milestone 1 — Initial Deliverable',
        description: 'Initial deliverables and progress demo.',
        amountUsdc: hasValidBudget ? half1Amount : '',
        deadlineDate: '2026-10-12',
        deadlineTime: '23:59',
        reviewWindowSeconds: 86400,
        gracePeriodSeconds: 0,
      },
      {
        title: 'Milestone 2 — Final Deliverable',
        description: deliverables || 'Final delivery and documentation.',
        amountUsdc: hasValidBudget ? half2Amount : '',
        deadlineDate,
        deadlineTime,
        reviewWindowSeconds: 86400,
        gracePeriodSeconds: 0,
      },
    ];
  } else {
    // custom: starts with exactly 1 genuine blank milestone
    return [
      {
        title: '',
        description: '',
        amountUsdc: '',
        deadlineDate: '',
        deadlineTime: '23:59',
        reviewWindowSeconds: 86400,
        gracePeriodSeconds: 0,
      },
    ];
  }
}

function addCustomMilestone(current: FormMilestone[]): { milestones: FormMilestone[]; expandedIndex: number } {
  if (current.length >= 10) return { milestones: current, expandedIndex: current.length - 1 };
  const newM: FormMilestone = {
    title: '',
    description: '',
    amountUsdc: '',
    deadlineDate: '',
    deadlineTime: '23:59',
    reviewWindowSeconds: 86400,
    gracePeriodSeconds: 0,
  };
  const updated = [...current, newM];
  return { milestones: updated, expandedIndex: current.length };
}

function removeCustomMilestone(
  current: FormMilestone[],
  indexToRemove: number,
  currentExpanded: number | null
): { milestones: FormMilestone[]; expandedIndex: number | null } {
  if (current.length <= 1) {
    return { milestones: current, expandedIndex: currentExpanded };
  }
  const updated = current.filter((_, i) => i !== indexToRemove);
  let nextExpanded = currentExpanded;
  if (currentExpanded !== null) {
    if (currentExpanded === indexToRemove) {
      nextExpanded = Math.max(0, indexToRemove - 1);
    } else if (currentExpanded > indexToRemove) {
      nextExpanded = currentExpanded - 1;
    }
  }
  return { milestones: updated, expandedIndex: nextExpanded };
}

function getMilestoneDisplayTitle(title: string, index: number): string {
  const prefix = `Milestone ${index + 1}`;
  const trimmed = (title || '').trim();
  if (!trimmed) return prefix;
  if (new RegExp(`^milestone\\s*${index + 1}\\s*([—:\\-]\\s*)?`, 'i').test(trimmed)) {
    const stripped = trimmed.replace(new RegExp(`^milestone\\s*${index + 1}\\s*([—:\\-]\\s*)?`, 'i'), '').trim();
    return stripped ? `${prefix} — ${stripped}` : prefix;
  }
  return `${prefix} — ${trimmed}`;
}

function getReceiptPaymentProp(step: number, paymentStructureSelected: boolean, paymentStructure: string | undefined) {
  return step >= 5 && paymentStructureSelected && paymentStructure ? paymentStructure : undefined;
}

function isMilestonesCardVisible(paymentStructureSelected: boolean, paymentStructure: string, milestoneCount: number): boolean {
  return paymentStructureSelected && !!paymentStructure && milestoneCount > 0;
}

function canProceedStep6(
  paymentStructureSelected: boolean,
  paymentStructure: string,
  milestones: FormMilestone[],
  budget: string,
  nowSec: number
): boolean {
  if (!paymentStructureSelected || !paymentStructure) return false;
  if (!['single', '50-50', 'custom'].includes(paymentStructure)) return false;
  if (milestones.length === 0 || milestones.length > 10) return false;
  if (paymentStructure === 'single' && milestones.length !== 1) return false;
  if (paymentStructure === '50-50' && milestones.length !== 2) return false;
  if (paymentStructure === 'custom' && (milestones.length < 1 || milestones.length > 10)) return false;

  let sumUnits = 0n;
  for (const m of milestones) {
    if (!m.title.trim()) return false;
    if (!m.amountUsdc || isNaN(Number(m.amountUsdc)) || Number(m.amountUsdc) <= 0) return false;
    try {
      const units = parseUsdcAmount(m.amountUsdc);
      if (units <= 0n) return false;
      sumUnits += units;
    } catch {
      return false;
    }
    if (!m.deadlineDate) return false;
    const ts = Math.floor(new Date(`${m.deadlineDate}T${m.deadlineTime || '23:59'}`).getTime() / 1000);
    if (isNaN(ts) || ts <= nowSec) return false;
    if (m.reviewWindowSeconds < 3600 || m.reviewWindowSeconds > 2592000) return false;
  }

  if (budget && !isNaN(Number(budget)) && Number(budget) > 0) {
    try {
      const expectedBudgetUnits = parseUsdcAmount(budget);
      if (sumUnits !== expectedBudgetUnits) return false;
    } catch {
      return false;
    }
  }

  return true;
}

// AI Freelancer Card helper mirrors
function getAiCardSkillChips(skills: string[]) {
  const maxSkills = 2; // compactAiVariant shows max 2
  const topSkills = skills.slice(0, maxSkills);
  const extraSkillsCount = skills.length - topSkills.length;
  return { topSkills, extraSkillsCount };
}

function getAiCardRateDisplay(pricing: any) {
  const publicPricing = formatPublicPricing(pricing);
  if (!publicPricing) {
    return { isSkeleton: true, text: null };
  }
  return { isSkeleton: false, text: `$${publicPricing.amountDisplay}` };
}

function getPageBottomPaddingClass(aiPanelExpanded: boolean, step: number) {
  if (!aiPanelExpanded || step < 1 || step >= 7) {
    return 'pb-36';
  }
  if (step === 1) {
    return 'pb-40 lg:pb-[460px]';
  }
  return 'pb-36 sm:pb-40';
}

describe('Synq Step 6 Payment Structure & Collapsible Milestone UX Suite', () => {
  it('1. Initial Step 6 starts unselected with no milestones and receipt skeleton', () => {
    const paymentStructureSelected = false;
    const paymentStructure = '';
    const milestones: FormMilestone[] = [];

    assert.equal(paymentStructureSelected, false);
    assert.equal(paymentStructure, '');
    assert.equal(milestones.length, 0);

    // Milestones card is NOT visible
    assert.equal(isMilestonesCardVisible(paymentStructureSelected, paymentStructure, milestones.length), false);

    // Receipt Payment remains skeleton (undefined)
    assert.equal(getReceiptPaymentProp(5, paymentStructureSelected, paymentStructure), undefined);
  });

  it('2. Single Release creates exactly 1 milestone with 100% of budget', () => {
    const m = applyPaymentStructure('single', '250.00', 'Full Stack App');
    assert.equal(m.length, 1);
    assert.equal(parseUsdcAmount(m[0].amountUsdc), parseUsdcAmount('250.00'));
    assert.equal(m[0].title, 'Full Stack App — Final Delivery');
    assert.equal(isMilestonesCardVisible(true, 'single', m.length), true);
  });

  it('3. 50/50 Milestones creates exactly 2 milestones with equal budget split', () => {
    const m = applyPaymentStructure('50-50', '300.00');
    assert.equal(m.length, 2);
    assert.equal(parseUsdcAmount(m[0].amountUsdc), parseUsdcAmount('150.00'));
    assert.equal(parseUsdcAmount(m[1].amountUsdc), parseUsdcAmount('150.00'));
    const sum = parseUsdcAmount(m[0].amountUsdc) + parseUsdcAmount(m[1].amountUsdc);
    assert.equal(sum, parseUsdcAmount('300.00'));
  });

  it('4. 50/50 Milestones correctly reconciles odd-cent budget split down to 6 decimals', () => {
    const m = applyPaymentStructure('50-50', '100.01');
    assert.equal(m.length, 2);
    const sum = parseUsdcAmount(m[0].amountUsdc) + parseUsdcAmount(m[1].amountUsdc);
    assert.equal(sum, parseUsdcAmount('100.01'));
  });

  it('5. Custom Stages initializes with exactly 1 genuine blank milestone', () => {
    const m = applyPaymentStructure('custom', '500.00');
    assert.equal(m.length, 1);
    assert.equal(m[0].title, '');
    assert.equal(m[0].amountUsdc, '');
    assert.equal(m[0].description, '');
    assert.equal(m[0].deadlineDate, '');
    assert.notEqual(m[0].title, 'Initial Stage');
    assert.notEqual(m[0].amountUsdc, '250.00');
  });

  it('6. Adding custom milestones increments count to 2, then 3, with blank terms and auto-expansion', () => {
    let state = applyPaymentStructure('custom', '400.00');
    assert.equal(state.length, 1);

    // Click Add Milestone -> 2
    const add1 = addCustomMilestone(state);
    assert.equal(add1.milestones.length, 2);
    assert.equal(add1.expandedIndex, 1); // auto-expanded index 1
    assert.equal(add1.milestones[1].title, '');
    assert.equal(add1.milestones[1].amountUsdc, '');

    // Click Add Milestone again -> 3
    const add2 = addCustomMilestone(add1.milestones);
    assert.equal(add2.milestones.length, 3);
    assert.equal(add2.expandedIndex, 2); // auto-expanded index 2
    assert.equal(add2.milestones[2].title, '');
  });

  it('7. Custom milestone removal cannot go below 1 milestone', () => {
    let state = applyPaymentStructure('custom', '400.00');
    assert.equal(state.length, 1);

    // Attempting removal at 1 milestone is blocked
    const noop = removeCustomMilestone(state, 0, 0);
    assert.equal(noop.milestones.length, 1);

    // Add up to 2 milestones
    const add1 = addCustomMilestone(state);
    assert.equal(add1.milestones.length, 2);

    // Remove one milestone from 2 -> returns 1
    const removed = removeCustomMilestone(add1.milestones, 1, 1);
    assert.equal(removed.milestones.length, 1);

    // Try removing again -> blocked at minimum 1
    const blocked = removeCustomMilestone(removed.milestones, 0, 0);
    assert.equal(blocked.milestones.length, 1);
  });

  it('8. Accordion expanded state changes do NOT mutate milestone payload data', () => {
    const original = applyPaymentStructure('50-50', '200.00');
    let expandedIndex: number | null = 0;

    expandedIndex = null;
    assert.equal(parseUsdcAmount(original[0].amountUsdc), parseUsdcAmount('100.00'));
    assert.equal(parseUsdcAmount(original[1].amountUsdc), parseUsdcAmount('100.00'));

    expandedIndex = 1;
    assert.equal(parseUsdcAmount(original[0].amountUsdc), parseUsdcAmount('100.00'));
    assert.equal(parseUsdcAmount(original[1].amountUsdc), parseUsdcAmount('100.00'));
  });

  it('9. Collapsed milestone header title formats correctly and updates dynamically', () => {
    assert.equal(getMilestoneDisplayTitle('', 0), 'Milestone 1');
    assert.equal(getMilestoneDisplayTitle('   ', 1), 'Milestone 2');

    assert.equal(getMilestoneDisplayTitle('UI Design', 0), 'Milestone 1 — UI Design');
    assert.equal(getMilestoneDisplayTitle('Backend Implementation', 1), 'Milestone 2 — Backend Implementation');

    assert.equal(getMilestoneDisplayTitle('Milestone 1 — UI Design', 0), 'Milestone 1 — UI Design');
    assert.equal(getMilestoneDisplayTitle('Milestone 1: UI Design', 0), 'Milestone 1 — UI Design');
  });

  it('10. Step 6 canProceed blocks unselected or incomplete custom milestones and requires budget reconciliation', () => {
    const nowSec = 1700000000;

    // Unselected -> blocked
    assert.equal(canProceedStep6(false, '', [], '200', nowSec), false);

    // Blank custom milestone -> blocked
    const blankCustom = applyPaymentStructure('custom', '200');
    assert.equal(canProceedStep6(true, 'custom', blankCustom, '200', nowSec), false);

    // Valid custom milestone with mismatched budget sum -> blocked
    const filledMismatched: FormMilestone[] = [
      {
        title: 'Design',
        description: 'Figma mockups',
        amountUsdc: '150.00',
        deadlineDate: '2026-11-01',
        deadlineTime: '23:59',
        reviewWindowSeconds: 86400,
        gracePeriodSeconds: 0,
      },
    ];
    assert.equal(canProceedStep6(true, 'custom', filledMismatched, '200', nowSec), false);

    // Valid custom milestone with matching budget sum -> passes
    const filledMatching: FormMilestone[] = [
      {
        title: 'Full Delivery',
        description: 'Full scope deliverable',
        amountUsdc: '200.00',
        deadlineDate: '2026-11-01',
        deadlineTime: '23:59',
        reviewWindowSeconds: 86400,
        gracePeriodSeconds: 0,
      },
    ];
    assert.equal(canProceedStep6(true, 'custom', filledMatching, '200', nowSec), true);
  });

  it('11. Deal Receipt Payment prop remains undefined (skeleton) until explicitly selected', () => {
    assert.equal(getReceiptPaymentProp(5, false, '50-50'), undefined);
    assert.equal(getReceiptPaymentProp(5, true, '50-50'), '50-50');
    assert.equal(getReceiptPaymentProp(5, true, 'single'), 'single');
    assert.equal(getReceiptPaymentProp(5, true, 'custom'), 'custom');
    assert.equal(getReceiptPaymentProp(3, true, '50-50'), undefined);
  });

  it('12. AI recommendation mini-card displays maximum 2 skill chips and accurate +N badge', () => {
    // 2 skills
    const c2 = getAiCardSkillChips(['Next.js', 'TypeScript']);
    assert.deepEqual(c2.topSkills, ['Next.js', 'TypeScript']);
    assert.equal(c2.extraSkillsCount, 0);

    // 3 skills -> 2 chips, +1
    const c3 = getAiCardSkillChips(['Next.js', 'TypeScript', 'Tailwind']);
    assert.deepEqual(c3.topSkills, ['Next.js', 'TypeScript']);
    assert.equal(c3.extraSkillsCount, 1);

    // 5 skills -> 2 chips, +3
    const c5 = getAiCardSkillChips(['Next.js', 'TypeScript', 'Tailwind', 'Solidity', 'GraphQL']);
    assert.deepEqual(c5.topSkills, ['Next.js', 'TypeScript']);
    assert.equal(c5.extraSkillsCount, 3);
  });

  it('13. AI mini-card renders neutral skeleton when USDC rate is missing instead of "Rate not set"', () => {
    // Missing pricing
    const missing = getAiCardRateDisplay(null);
    assert.equal(missing.isSkeleton, true);
    assert.equal(missing.text, null);

    // Configured USDC pricing
    const configured = getAiCardRateDisplay({
      amount: '150',
      currency: 'USDC',
      rateType: 'PER_PROJECT',
    });
    assert.equal(configured.isSkeleton, false);
    assert.equal(configured.text, '$150');
  });

  it('14. Page bottom scroll padding dynamically expands with separate Step 2 and Steps 3-7 handling', () => {
    // Collapsed AI panel
    assert.equal(getPageBottomPaddingClass(false, 1), 'pb-36');
    assert.equal(getPageBottomPaddingClass(false, 5), 'pb-36');

    // Expanded AI panel on Step 2 (anchored-growth out of flow on desktop: extra clearance)
    assert.equal(getPageBottomPaddingClass(true, 1), 'pb-40 lg:pb-[460px]');

    // Expanded AI panel on Steps 3-7 (in normal document flow: normal obstruction clearance + breathing room, no giant gap)
    assert.equal(getPageBottomPaddingClass(true, 2), 'pb-36 sm:pb-40');
    assert.equal(getPageBottomPaddingClass(true, 5), 'pb-36 sm:pb-40');
    assert.equal(getPageBottomPaddingClass(true, 6), 'pb-36 sm:pb-40');

    // Outside AI panel steps (Step 1 index 0 or Step 8 index 7)
    assert.equal(getPageBottomPaddingClass(true, 0), 'pb-36');
    assert.equal(getPageBottomPaddingClass(true, 7), 'pb-36');
  });
});
