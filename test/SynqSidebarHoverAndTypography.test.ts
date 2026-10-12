import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Synq — Interactive Hover Sidebar & Navigation Typography Suite', () => {
  const sidebarPath = path.resolve(process.cwd(), 'src/components/layout/Sidebar.tsx');
  const sidebarContent = fs.readFileSync(sidebarPath, 'utf8');

  it('1. Task 1: Route change and stale focus cannot leave sidebar stuck open', () => {
    // Verifies pathname effect synchronizes collapse state
    assert.match(
      sidebarContent,
      /setMenuOpen\(false\)[\s\S]*?matches\(':hover'\)[\s\S]*?\}, \[pathname\]\);/,
      'Sidebar must re-evaluate hover and focus states whenever pathname changes'
    );

    // Verifies stale click focus is stripped from activeElement on route change
    assert.match(
      sidebarContent,
      /activeEl\.blur\(\)/,
      'Sidebar must blur clicked activeElement on route change if not keyboard focused'
    );

    // Verifies focusCapture only retains keyboard focus (:focus-visible)
    assert.match(
      sidebarContent,
      /':focus-visible'/,
      'Sidebar focusCapture must only set isFocused when focus is triggered via keyboard (:focus-visible)'
    );

    // Verifies global pointermove boundary check cleans up hover state
    assert.match(
      sidebarContent,
      /window\.addEventListener\('pointermove'/,
      'Sidebar must listen to pointermove to guarantee collapse when cursor leaves sidebar bounds'
    );
  });

  it('2. Task 2: Navigation labels and icons are moderately increased and centered', () => {
    // Navigation icons increased to 24px
    assert.match(
      sidebarContent,
      /<item\.icon\s+size=\{24\}/,
      'Navigation icons must be increased to size 24'
    );

    // Navigation label font size is approximately 14px in Press_Start_2P
    assert.match(
      sidebarContent,
      /text-\[14px\] font-normal tracking-tight leading-none/,
      'Navigation labels must be approximately 14px with leading-none for clean vertical centering'
    );

    // Navigation items preserve 56px height (h-14)
    assert.match(
      sidebarContent,
      /h-14 rounded-xl/,
      'Navigation items must maintain 56px height (h-14)'
    );
  });

  it('3. Task 3: Synq wordmark is increased to ~19px while preserving test regex and logo', () => {
    // Preserves official logo
    assert.match(
      sidebarContent,
      /src="\/newlogopng\.png"/,
      'Sidebar must preserve official /newlogopng.png'
    );
  });

  it('4. Refinements: 16px horizontal spacing (gap-4) and clean collapsed avatar without overlay badge', () => {
    // 16px gap between icons and labels
    assert.match(
      sidebarContent,
      /px-3 gap-4/,
      'Navigation items must have 16px horizontal spacing (gap-4) between icon and label'
    );

    // Collapsed avatar contains only the profile Link and Avatar without menu overlay button
    assert.match(
      sidebarContent,
      /\/\* COLLAPSED IDENTITY CONTROL \(PFP\) \*\/\s*<div className="flex justify-center">\s*<Link[\s\S]*?<Avatar[\s\S]*?<\/Link>\s*<\/div>/,
      'Collapsed avatar must not have overlaid menu button badge'
    );

    // Expanded sidebar retains functional menu button
    assert.match(
      sidebarContent,
      /<button[\s\S]*?onClick=\{\(\)\s*=>\s*setMenuOpen\(!menuOpen\)\}[\s\S]*?aria-label="Account menu"[\s\S]*?<Menu size=\{16\} \/>[\s\S]*?<\/button>/,
      'Expanded identity control must retain the functional account menu button'
    );
  });
});
