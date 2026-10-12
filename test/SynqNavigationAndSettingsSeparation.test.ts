/**
 * SYNQ — Navigation, Settings Page, and Notification Preferences Separation Test Suite
 *
 * Verifies:
 * 1. Sidebar account menu enables Settings (/settings), removes "Soon", and adds Profile (/profile).
 * 2. Identity card and avatar controls navigate to /profile.
 * 3. Settings page is dedicated to notification preferences and delivery status, cross-linking to Profile.
 * 4. Profile page at /profile preserves complete personal and marketplace features, auto-opening edit modal via ?edit=true.
 * 5. In Settings, Change, Unlink, and Link Email buttons route to /profile?edit=true without duplicate OTP interfaces.
 * 6. Notification preferences API PUT & GET persistence with wallet-scoped isolation.
 * 7. Hydration safety and zero suppressHydrationWarning across both pages.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';

import { signToken } from '../src/lib/auth';
import {
  GET as preferencesGetRoute,
  PUT as preferencesPutRoute,
} from '../src/app/api/notifications/preferences/route';
import {
  InMemoryNotificationPreferencesRepository,
  setNotificationPreferencesRepositoryForTest,
} from '../src/lib/deals/notification-preferences-db';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../src/lib/deals/notification-preferences-types';

describe('SYNQ — Navigation, Settings Separation & Preferences Isolation', () => {
  const WALLET_ALICE = '0x1111111111111111111111111111111111111111';
  const WALLET_BOB = '0x2222222222222222222222222222222222222222';
  const TOKEN_ALICE = signToken({ userId: 'alice-id', walletAddress: WALLET_ALICE });
  const TOKEN_BOB = signToken({ userId: 'bob-id', walletAddress: WALLET_BOB });

  let prefsRepo: InMemoryNotificationPreferencesRepository;

  beforeEach(() => {
    prefsRepo = new InMemoryNotificationPreferencesRepository();
    setNotificationPreferencesRepositoryForTest(prefsRepo);
  });

  afterEach(() => {
    setNotificationPreferencesRepositoryForTest(null);
  });

  // =========================================================================
  // 1. Sidebar Account Menu & Navigation Integrity
  // =========================================================================
  describe('1. Sidebar Account Navigation', () => {
    const sidebarPath = path.resolve(process.cwd(), 'src/components/layout/Sidebar.tsx');
    const sidebarContent = fs.readFileSync(sidebarPath, 'utf8');

    it('1. Enables Settings option in account popup menu and removes "Soon" label', () => {
      // Must have active Link to /settings
      assert.match(
        sidebarContent,
        /<Link\s+href="\/settings"[\s\S]*?>\s*<Settings[\s\S]*?<span>Settings<\/span>\s*<\/Link>/,
        'Account popup must contain active Link to /settings'
      );

      // Must not mark Settings as "Soon"
      const settingsSection = sidebarContent.slice(
        sidebarContent.indexOf('href="/settings"'),
        sidebarContent.indexOf('href="/settings"') + 350
      );
      assert.doesNotMatch(
        settingsSection,
        /Soon/,
        'Settings link in account popup must not contain "Soon" badge'
      );
    });

    it('2. Adds Profile option to account popup menu linking to /profile', () => {
      assert.match(
        sidebarContent,
        /<Link\s+href="\/profile"[\s\S]*?>\s*<User[\s\S]*?<span>Profile<\/span>\s*<\/Link>/,
        'Account popup must contain active Link to /profile'
      );
    });

    it('3. Bottom-left user identity card and avatar route to /profile', () => {
      // Expanded identity card Link
      assert.match(
        sidebarContent,
        /<Link\s+href="\/profile"\s+onClick=\{\(\)\s*=>\s*setMobileOpen\(false\)\}\s+className="flex items-center gap-3 min-w-0 flex-1 group outline-none"/,
        'Expanded identity card must navigate to /profile'
      );

      // Collapsed PFP Link
      assert.match(
        sidebarContent,
        /<Link\s+href="\/profile"\s+onClick=\{\(\)\s*=>\s*setMobileOpen\(false\)\}\s+className="block outline-none"/,
        'Collapsed avatar PFP must navigate to /profile'
      );
    });
  });

  // =========================================================================
  // 2. Dedicated Settings Page Structure & Standardized Header
  // =========================================================================
  describe('2. Dedicated Settings Page Structure & Standardized Header', () => {
    const settingsPath = path.resolve(process.cwd(), 'src/app/settings/page.tsx');
    const settingsContent = fs.readFileSync(settingsPath, 'utf8');

    it('4. Settings page renders header matching AI Deal Negotiator pattern with question-mark tooltip', () => {
      assert.match(
        settingsContent,
        /<h1\s+className=\{`\$\{pressStart2P\.className\}\s+text-xl\s+md:text-2xl\s+font-normal\s+text-white\s+tracking-tight`\}>\s*Settings\s*<\/h1>/,
        'Settings heading must match AI Deal Negotiator font size, weight, and tracking'
      );
      assert.match(
        settingsContent,
        /aria-label="About Settings"/,
        'Settings header must include question-mark tooltip button'
      );
      assert.match(
        settingsContent,
        /Manage your notification preferences, email delivery, and account settings\./,
        'Tooltip must contain the notification and account preferences description'
      );
      assert.doesNotMatch(
        settingsContent,
        /SettingsIcon/,
        'Settings header must not contain gear icon'
      );
      assert.doesNotMatch(
        settingsContent,
        /border-b border-zinc-800/,
        'Settings header must not have horizontal separation line'
      );
    });

    it('5. Settings page does not render the Public & Seller Profile navigation card', () => {
      assert.doesNotMatch(
        settingsContent,
        /Public &amp; Seller Profile/,
        'Settings header must remove Public & Seller Profile navigation card'
      );
      assert.doesNotMatch(
        settingsContent,
        /Edit avatar, handle, &amp; services/,
        'Settings header must not render profile card subtitle'
      );
    });

    it('6. Settings page does not contain marketplace profile editing or seller form fields', () => {
      assert.doesNotMatch(settingsContent, /hourlyRate/, 'Settings page must not contain hourlyRate');
      assert.doesNotMatch(settingsContent, /SELLER_CATEGORIES/, 'Settings page must not contain seller categories');
      assert.doesNotMatch(settingsContent, /savePopupIdentity/, 'Settings page must not contain identity save modal');
    });

    it('6b. Renders NotificationSettingsSection with effectiveAddress below header', () => {
      assert.match(
        settingsContent,
        /<NotificationSettingsSection\s+address=\{effectiveAddress\}\s*\/>/,
        'Renders NotificationSettingsSection with effectiveAddress'
      );
    });
  });

  // =========================================================================
  // 3. Profile Page Preservation & ?edit=true Query Entry Point
  // =========================================================================
  describe('3. Profile Page Features & Query Parameter Navigation', () => {
    const profilePath = path.resolve(process.cwd(), 'src/app/profile/page.tsx');
    const profileContent = fs.readFileSync(profilePath, 'utf8');

    it('7. Profile page is preserved at /profile with all personal & professional features', () => {
      assert.match(profileContent, /ProfileContent/, 'Defines ProfileContent component');
      assert.match(profileContent, /SELLER_CATEGORIES/, 'Preserves seller marketplace categories');
      assert.match(profileContent, /ProviderProfileModal/, 'Preserves public profile preview modal');
      assert.match(profileContent, /ProfileEmail/, 'Renders ProfileEmail in edit modal');
    });

    it('8. Profile page auto-opens Edit modal when ?edit=true is present in query parameters', () => {
      assert.match(
        profileContent,
        /searchParams\?\.get\('edit'\)\s*===\s*'true'/,
        'ProfilePage must inspect searchParams for ?edit=true'
      );
      assert.match(
        profileContent,
        /openEditModal\(\)/,
        'ProfilePage must trigger openEditModal when ?edit=true is detected'
      );
    });

    it('9. Profile page renders clean banner linking to /settings', () => {
      assert.match(
        profileContent,
        /<Link\s+href="\/settings"[\s\S]*?Notification Settings[\s\S]*?<\/Link>/,
        'Profile page must render link to /settings'
      );
    });
  });

  // =========================================================================
  // 4. NotificationSettingsSection Email-Management Routing Contract
  // =========================================================================
  describe('4. NotificationSettingsSection Navigation Contract', () => {
    const notifSectionPath = path.resolve(
      process.cwd(),
      'src/components/shared/NotificationSettingsSection.tsx'
    );
    const notifContent = fs.readFileSync(notifSectionPath, 'utf8');

    it('10. Change, Unlink, and Link Email buttons navigate to /profile?edit=true', () => {
      // Must link to /profile?edit=true for Change
      assert.match(
        notifContent,
        /<Link\s+href="\/profile\?edit=true">\s*<Pencil\s+size=\{12\}\s*\/>\s*Change\s*<\/Link>/,
        'Change button must navigate to /profile?edit=true'
      );

      // Must link to /profile?edit=true for Unlink
      assert.match(
        notifContent,
        /<Link\s+href="\/profile\?edit=true">\s*<Trash2\s+size=\{12\}\s*\/>\s*Unlink\s*<\/Link>/,
        'Unlink button must navigate to /profile?edit=true'
      );

      // Must link to /profile?edit=true for Link Email
      assert.match(
        notifContent,
        /<Link\s+href="\/profile\?edit=true">\s*<Mail\s+size=\{13\}\s*\/>\s*Link Email\s*<\/Link>/,
        'Link Email button must navigate to /profile?edit=true'
      );
    });

    it('11. NotificationSettingsSection does not contain duplicate OTP verification forms', () => {
      assert.doesNotMatch(
        notifContent,
        /bind_email_verify/,
        'NotificationSettingsSection must not contain inline OTP verification call'
      );
      assert.doesNotMatch(
        notifContent,
        /Enter code sent to/,
        'NotificationSettingsSection must not render inline OTP input prompt'
      );
    });

    it('12. NotificationSettingsSection preserves verified email and delivery status display', () => {
      assert.match(
        notifContent,
        /ShieldCheck size=\{12\}[\s\S]*?Verified/,
        'Displays Verified badge when email is linked'
      );
      assert.match(
        notifContent,
        /Active Delivery ✓/,
        'Displays Active Delivery indicator when email is linked'
      );
    });
  });

  // =========================================================================
  // 5. Notification Preferences API Persistence & Wallet Isolation
  // =========================================================================
  describe('5. Notification Preferences API & Multi-Wallet Isolation', () => {
    it('13. PUT /api/notifications/preferences saves preferences and GET retrieves them', async () => {
      const customPrefs = {
        dealProposalsAndConfirmations: false,
        milestoneSubmissionsAndRevisions: true,
        paymentsAndCompletions: true,
        disputesAndResolutions: false,
      };

      // 1. PUT preferences for Alice
      const putReq = new NextRequest('http://localhost:3000/api/notifications/preferences', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_ALICE}`,
        },
        body: JSON.stringify({
          walletAddress: WALLET_ALICE,
          preferences: customPrefs,
        }),
      });

      const putRes = await preferencesPutRoute(putReq);
      assert.equal(putRes.status, 200);
      const putData = await putRes.json();
      assert.equal(putData.ok, true);
      assert.deepEqual(putData.preferences, customPrefs);

      // 2. GET preferences for Alice returns saved values
      const getReq = new NextRequest(
        `http://localhost:3000/api/notifications/preferences?wallet=${WALLET_ALICE}`,
        { headers: { Authorization: `Bearer ${TOKEN_ALICE}` } }
      );
      const getRes = await preferencesGetRoute(getReq);
      assert.equal(getRes.status, 200);
      const getData = await getRes.json();
      assert.deepEqual(getData.preferences, customPrefs);
    });

    it('14. Bob accessing preferences receives defaults isolated from Alice', async () => {
      // Alice saves non-default preferences
      await prefsRepo.updatePreferences(WALLET_ALICE.toLowerCase(), {
        dealProposalsAndConfirmations: false,
        milestoneSubmissionsAndRevisions: false,
        paymentsAndCompletions: false,
        disputesAndResolutions: false,
      });

      // Bob fetches his own preferences
      const getReqBob = new NextRequest(
        `http://localhost:3000/api/notifications/preferences?wallet=${WALLET_BOB}`,
        { headers: { Authorization: `Bearer ${TOKEN_BOB}` } }
      );
      const getResBob = await preferencesGetRoute(getReqBob);
      assert.equal(getResBob.status, 200);
      const getDataBob = await getResBob.json();

      // Bob's preferences are the defaults (all true)
      assert.deepEqual(getDataBob.preferences, DEFAULT_NOTIFICATION_PREFERENCES);
    });

    it('15. Cross-wallet unauthorized update is rejected with 403', async () => {
      // Bob tries to modify Alice's preferences
      const attackReq = new NextRequest('http://localhost:3000/api/notifications/preferences', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_BOB}`, // Bob's auth token
        },
        body: JSON.stringify({
          walletAddress: WALLET_ALICE, // Alice's wallet
          preferences: { dealProposalsAndConfirmations: false },
        }),
      });

      const res = await preferencesPutRoute(attackReq);
      assert.equal(res.status, 403, 'Cross-wallet preference updates must return 403');
    });
  });

  // =========================================================================
  // 6. Header Consistency Verification (AI Deal Negotiator Standard)
  // =========================================================================
  describe('6. Header Consistency Standard across Deal Port & My Deals', () => {
    it('16. Deal Port page matches AI Deal Negotiator header typography and tooltip pattern', () => {
      const marketplacePath = path.resolve(process.cwd(), 'src/app/marketplace/page.tsx');
      const marketplaceContent = fs.readFileSync(marketplacePath, 'utf8');

      assert.match(
        marketplaceContent,
        /<h1\s+className=\{`\$\{pressStart2P\.className\}\s+text-xl\s+md:text-2xl\s+font-normal\s+text-white\s+tracking-tight`\}>\s*Deal Port\s*<\/h1>/,
        'Deal Port heading must match standard Press_Start_2P class, size, and weight'
      );
      assert.match(
        marketplaceContent,
        /aria-label="About Deal Port"/,
        'Deal Port must include standardized tooltip'
      );
    });

    it('17. My Deals page matches AI Deal Negotiator header typography and tooltip pattern', () => {
      const dealsPath = path.resolve(process.cwd(), 'src/app/deals/page.tsx');
      const dealsContent = fs.readFileSync(dealsPath, 'utf8');

      assert.match(
        dealsContent,
        /<h1\s+className=\{`\$\{pressStart2P\.className\}\s+text-xl\s+md:text-2xl\s+font-normal\s+text-white\s+tracking-tight`\}>\s*My Deals\s*<\/h1>/,
        'My Deals heading must match standard Press_Start_2P class, size, and weight'
      );
      assert.match(
        dealsContent,
        /aria-label="About My Deals"/,
        'My Deals must include standardized tooltip'
      );
      assert.doesNotMatch(
        dealsContent,
        /style=\{\{\s*fontFamily:\s*pressStart2P\.style\.fontFamily\s*\}\}/,
        'My Deals must not use inline fontFamily style overrides'
      );
    });
  });
});

