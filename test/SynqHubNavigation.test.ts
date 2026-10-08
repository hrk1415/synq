// test/SynqHubNavigation.test.ts
// In Node test runner, next/font/google is an empty module.
// Install a test mock before importing Next.js components into Node.
const nextFontGoogle = require('next/font/google');
nextFontGoogle.Press_Start_2P = () => ({
  className: '__className_pressStart2P',
  style: { fontFamily: 'Press Start 2P' },
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { NavItem } from '@/components/layout/Sidebar';
import type { HubModule } from '@/app/hub/page';

describe('Synq — Hub Navigation & Module Landing Page Suite', async () => {
  const { navItems, isNavItemActive } = await import('@/components/layout/Sidebar');
  const { HUB_MODULES } = await import('@/app/hub/page');
  const rootDir = path.resolve(__dirname, '..');
  const sidebarPath = path.join(rootDir, 'src/components/layout/Sidebar.tsx');
  const hubPagePath = path.join(rootDir, 'src/app/hub/page.tsx');
  const agentControllerPath = path.join(rootDir, 'src/app/agent-controller/page.tsx');
  const swapPath = path.join(rootDir, 'src/app/swap/page.tsx');

  const sidebarContent = fs.readFileSync(sidebarPath, 'utf8');
  const hubPageContent = fs.readFileSync(hubPagePath, 'utf8');
  const agentControllerContent = fs.readFileSync(agentControllerPath, 'utf8');
  const swapContent = fs.readFileSync(swapPath, 'utf8');

  // 1. Sidebar contains Hub (and does NOT say SynqHub).
  it('1. Sidebar contains Hub and does not say SynqHub', () => {
    const hubItem = navItems.find((item) => item.label === 'Hub');
    assert.ok(hubItem, 'Hub must exist in navItems');
    assert.equal(hubItem.label, 'Hub');
    assert.match(sidebarContent, /label:\s*['"]Hub['"]/);

    const synqHubItem = navItems.find((item) => item.label === 'SynqHub');
    assert.equal(synqHubItem, undefined, 'Sidebar must NOT say SynqHub');
    assert.ok(
      !sidebarContent.includes("label: 'SynqHub'"),
      'Sidebar nav code must not use SynqHub as label'
    );
  });

  // 2. Sidebar contains Negotiator (renamed from AI Negotiator) and links to /negotiator.
  it('2. Sidebar contains Negotiator and no longer contains AI Negotiator', () => {
    const negotiatorItem = navItems.find((item) => item.label === 'Negotiator');
    assert.ok(negotiatorItem, 'Negotiator must exist in navItems');
    assert.equal(negotiatorItem.href, '/negotiator');

    const oldItem = navItems.find((item) => item.label === 'AI Negotiator');
    assert.equal(oldItem, undefined, 'Sidebar must NOT contain AI Negotiator');
    assert.ok(
      !sidebarContent.includes("label: 'AI Negotiator'"),
      'Sidebar source must not contain AI Negotiator label'
    );
  });

  // 3. Sidebar no longer contains direct Agent Controller entry.
  it('3. Sidebar no longer contains direct Agent Controller entry', () => {
    const agentItem = navItems.find(
      (item) => item.label === 'Agent Controller' || item.href === '/agent-controller'
    );
    assert.equal(agentItem, undefined, 'Agent Controller should not be a direct sidebar item');
    assert.ok(
      !sidebarContent.includes("label: 'Agent Controller'"),
      'Sidebar code must not contain direct Agent Controller nav entry'
    );
  });

  // 4. Sidebar no longer contains direct Swap entry.
  it('4. Sidebar no longer contains direct Swap entry', () => {
    const swapItem = navItems.find((item) => item.label === 'Swap' || item.href === '/swap');
    assert.equal(swapItem, undefined, 'Swap should not be a direct sidebar item');
    assert.ok(
      !sidebarContent.includes("label: 'Swap'"),
      'Sidebar code must not contain direct Swap nav entry'
    );
  });

  // 5. Hub links to /hub.
  it('5. Hub links to /hub', () => {
    const hubItem = navItems.find((item) => item.label === 'Hub');
    assert.ok(hubItem);
    assert.equal(hubItem.href, '/hub');
  });

  // 6. Hub is active on /hub.
  it('6. Hub is active on /hub', () => {
    assert.equal(isNavItemActive('/hub', '/hub'), true);
    assert.equal(isNavItemActive('/hub', '/hub/settings'), true);
  });

  // 7. Hub is active on /agent-controller.
  it('7. Hub is active on /agent-controller', () => {
    assert.equal(isNavItemActive('/hub', '/agent-controller'), true);
    assert.equal(isNavItemActive('/hub', '/agent-controller/deploy'), true);
    assert.equal(isNavItemActive('/deals', '/agent-controller'), false);
    assert.equal(isNavItemActive('/negotiator', '/agent-controller'), false);
  });

  // 8. Hub is active on /swap.
  it('8. Hub is active on /swap', () => {
    assert.equal(isNavItemActive('/hub', '/swap'), true);
    assert.equal(isNavItemActive('/hub', '/swap/history'), true);
    assert.equal(isNavItemActive('/deals', '/swap'), false);
    assert.equal(isNavItemActive('/messages', '/swap'), false);
  });

  // 9. Hub page contains Agent Controller module and SynqHub heading.
  it('9. Hub page contains Agent Controller module and SynqHub heading', () => {
    assert.match(hubPageContent, />\s*SynqHub\s*</, 'Hub page heading must say SynqHub');
    const agentModule = HUB_MODULES.find(
      (m) => m.title === 'Agent Controller' || m.href === '/agent-controller'
    );
    assert.ok(agentModule, 'Agent Controller module must be defined in Hub modules');
    assert.equal(agentModule.title, 'Agent Controller');
    assert.match(agentModule.description, /AI agent/i);
    assert.match(hubPageContent, /Agent Controller/);
  });

  // 10. Agent Controller card links to /agent-controller.
  it('10. Agent Controller card links to /agent-controller', () => {
    const agentModule = HUB_MODULES.find((m) => m.title === 'Agent Controller');
    assert.ok(agentModule);
    assert.equal(agentModule.href, '/agent-controller');
    assert.equal(agentModule.cta, 'Open Agent Controller');
  });

  // 11. Hub page contains Swap module.
  it('11. Hub page contains Swap module', () => {
    const swapModule = HUB_MODULES.find((m) => m.title === 'Swap' || m.href === '/swap');
    assert.ok(swapModule, 'Swap module must be defined in Hub modules');
    assert.equal(swapModule.title, 'Swap');
    assert.match(swapModule.description, /Sepolia/i);
    assert.match(hubPageContent, /Swap/);
  });

  // 12. Swap card links to /swap.
  it('12. Swap card links to /swap', () => {
    const swapModule = HUB_MODULES.find((m) => m.title === 'Swap');
    assert.ok(swapModule);
    assert.equal(swapModule.href, '/swap');
    assert.equal(swapModule.cta, 'Open Swap');
  });

  // 13. Permanent Hub subtitle is replaced by About/help tooltip matching Deal Port.
  it('13. Permanent Hub subtitle is replaced by About/help tooltip matching Deal Port', () => {
    // Assert permanent subtitle paragraph is removed
    assert.ok(
      !hubPageContent.includes('<p className="text-xs sm:text-sm text-zinc-400 mt-1.5">'),
      'Permanent subtitle paragraph must be removed'
    );
    // Assert About tooltip exists with the explanatory copy
    assert.match(hubPageContent, /aria-label="About SynqHub"/);
    assert.match(hubPageContent, /Tools and utilities for managing more of your Synq workflow\./);
  });

  // 14. Top-left Synq brand text is increased to text-base.
  it('14. Top-left Synq brand text is text-base and uses Press_Start_2P', () => {
    assert.match(
      sidebarContent,
      /text-base font-normal text-white tracking-tight/,
      'Sidebar brand wordmark must be text-base'
    );
  });

  // 15. Valid module-scope Press_Start_2P font initialization without runtime guards.
  it('15. Valid module-scope Press_Start_2P font initialization without runtime guards', () => {
    assert.match(sidebarContent, /const pressStart2P = Press_Start_2P\(\{/);
    assert.match(hubPageContent, /const pressStart2P = Press_Start_2P\(\{/);
    assert.ok(!sidebarContent.includes('typeof Press_Start_2P'));
    assert.ok(!hubPageContent.includes('typeof Press_Start_2P'));
  });

  // 16. Future module architecture is configuration-driven.
  it('16. Future module architecture is configuration-driven', () => {
    assert.ok(Array.isArray(HUB_MODULES), 'HUB_MODULES must be an array');
    assert.ok(HUB_MODULES.length >= 2, 'HUB_MODULES must have at least 2 default modules');

    for (const mod of HUB_MODULES) {
      assert.ok(mod.id, 'Module must have id');
      assert.ok(mod.title, 'Module must have title');
      assert.ok(mod.description, 'Module must have description');
      assert.ok(mod.href, 'Module must have href');
      assert.ok(mod.cta, 'Module must have cta');
      assert.ok(mod.icon, 'Module must have an icon component');
    }

    assert.match(hubPageContent, /HUB_MODULES\.map/);
  });

  // 17. Existing /agent-controller route remains untouched.
  it('17. Existing /agent-controller route remains untouched', () => {
    assert.ok(fs.existsSync(agentControllerPath), 'Agent Controller page file must exist');
    const gitDiff = execSync(`git status --short src/app/agent-controller/page.tsx`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.equal(gitDiff, '', 'src/app/agent-controller/page.tsx must not have any git changes');
  });

  // 18. Existing /swap route remains untouched.
  it('18. Existing /swap route remains untouched', () => {
    assert.ok(fs.existsSync(swapPath), 'Swap page file must exist');
    const gitDiff = execSync(`git status --short src/app/swap/page.tsx`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.equal(gitDiff, '', 'src/app/swap/page.tsx must not have any git changes');
  });

  // 19. Agent Controller safety banner remains unchanged.
  it('19. Agent Controller safety banner remains unchanged', () => {
    const safetyBanner =
      'Agent Controller backend is temporarily unavailable while this feature is being upgraded. Do not enter live provider credentials at this time.';
    assert.ok(
      agentControllerContent.includes(safetyBanner),
      'Agent Controller safety banner must remain intact and verbatim'
    );
  });
});
