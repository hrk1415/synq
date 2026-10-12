// test/SynqSettingsHydration.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { shortenAddress } from '../src/lib/utils';

describe('SYNQ — Profile & Settings Page Wallet Hydration Safety Suite', () => {
  const profilePath = path.resolve(process.cwd(), 'src/app/profile/page.tsx');
  const profileContent = fs.readFileSync(profilePath, 'utf8');

  const settingsPath = path.resolve(process.cwd(), 'src/app/settings/page.tsx');
  const settingsContent = fs.readFileSync(settingsPath, 'utf8');

  // =========================================================================
  // 1. Structural Invariants in src/app/profile/page.tsx
  // =========================================================================
  it('1. Enforces mounted lifecycle state and account restoring guards in ProfilePage', () => {
    // mounted state initialized to false
    assert.match(
      profileContent,
      /const\s*\[mounted,\s*setMounted\]\s*=\s*useState\(false\);/,
      'ProfilePage must declare a mounted state initialized to false',
    );

    // useEffect sets mounted to true after initial client hydration
    assert.match(
      profileContent,
      /useEffect\(\(\)\s*=>\s*\{\s*setMounted\(true\);\s*\},?\s*\[\]\);/,
      'ProfilePage must set mounted to true inside an empty-dependency useEffect',
    );

    // Checks isAccountRestoring to prevent transient reconnecting states
    assert.match(
      profileContent,
      /const\s+isAccountRestoring\s*=\s*status\s*===\s*'connecting'\s*\|\|\s*status\s*===\s*'reconnecting';/,
      'ProfilePage must track account restoring state',
    );

    // effectiveAddress is gated by mounted, isConnected, address, and !isAccountRestoring
    assert.match(
      profileContent,
      /const\s+effectiveAddress\s*=\s*\(mounted\s*&&\s*isConnected\s*&&\s*!!address\s*&&\s*!isAccountRestoring\)\s*\?\s*address\s*:\s*undefined;/,
      'effectiveAddress must be guarded by mounted to ensure deterministic SSR and initial render',
    );
  });

  it('2. Guards hero header <h2> and wallet identity elements with effectiveAddress in ProfilePage', () => {
    // The h2 element must use effectiveAddress rather than raw address
    assert.match(
      profileContent,
      /<h2 className="text-2xl md:text-3xl font-bold text-white truncate">\s*\{username \|\| \(effectiveAddress \? \(registry\.username \? `@\$\{registry\.username\}` : shortenAddress\(effectiveAddress\)\) : 'Guest User'\)\}\s*<\/h2>/,
      'Hero <h2> must evaluate effectiveAddress to guarantee server and initial client match',
    );

    // Wallet disconnected indicator uses effectiveAddress
    assert.match(
      profileContent,
      /<span>\{effectiveAddress \? shortenAddress\(effectiveAddress\) : 'Wallet disconnected'\}<\/span>/,
      'Hero wallet indicator must use effectiveAddress',
    );

    // Copy button is only rendered when effectiveAddress is defined
    assert.match(
      profileContent,
      /\{effectiveAddress && \(\s*<button[\s\S]*?onClick=\{copyAddress\}/,
      'Copy button must be guarded by effectiveAddress',
    );

    // Read-only wallet section uses effectiveAddress
    assert.match(
      profileContent,
      /<span>\{effectiveAddress \? shortenAddress\(effectiveAddress\) : 'Not connected'\}<\/span>/,
      'Read-only wallet section must use effectiveAddress',
    );
  });

  it('3. Passes effectiveAddress to on-chain contracts in ProfilePage', () => {
    assert.match(
      profileContent,
      /const\s+registry\s*=\s*useRegistry\(effectiveAddress\);/,
      'useRegistry must receive effectiveAddress',
    );
    assert.match(
      profileContent,
      /const\s+directory\s*=\s*useDirectoryContract\(effectiveAddress\);/,
      'useDirectoryContract must receive effectiveAddress',
    );
  });

  it('4. Enforces hydration guards in SettingsPage and passes effectiveAddress to NotificationSettingsSection', () => {
    assert.match(
      settingsContent,
      /const\s*\[mounted,\s*setMounted\]\s*=\s*useState\(false\);/,
      'SettingsPage must declare mounted state',
    );
    assert.match(
      settingsContent,
      /effectiveAddress/,
      'SettingsPage must compute effectiveAddress',
    );
    assert.match(
      settingsContent,
      /<NotificationSettingsSection\s+address=\{effectiveAddress\}\s*\/>/,
      'SettingsPage must pass effectiveAddress to NotificationSettingsSection',
    );
  });

  it('5. Strictly does NOT use suppressHydrationWarning in ProfilePage or SettingsPage', () => {
    assert.doesNotMatch(
      profileContent,
      /suppressHydrationWarning/,
      'ProfilePage must not suppress hydration warnings with suppressHydrationWarning',
    );
    assert.doesNotMatch(
      settingsContent,
      /suppressHydrationWarning/,
      'SettingsPage must not suppress hydration warnings with suppressHydrationWarning',
    );
  });

  // =========================================================================
  // 2. Behavioral Reproduction and Determinism Simulation
  // =========================================================================
  describe('2. Behavioral Simulation: SSR vs Initial Client vs Post-Mount', () => {
    const testWallet = '0xD2D420a8F7504fE52Eb550b06b645258380D6319' as const;
    const expectedShortened = shortenAddress(testWallet); // '0xD2D4...6319'

    function renderHeroText(effectiveAddr?: string, username: string = '', registryUsername: string = ''): string {
      return username || (effectiveAddr ? (registryUsername ? `@${registryUsername}` : shortenAddress(effectiveAddr)) : 'Guest User');
    }

    it('reproduces the bug: un-guarded address causes SSR ("Guest User") vs Client ("0xD2D4...6319") mismatch', () => {
      const ssrAddress: string | undefined = undefined;
      const ssrText = renderHeroText(ssrAddress);
      assert.equal(ssrText, 'Guest User');

      const buggyInitialClientAddress: string | undefined = testWallet;
      const buggyInitialClientText = renderHeroText(buggyInitialClientAddress);
      assert.equal(buggyInitialClientText, expectedShortened);

      assert.notEqual(ssrText, buggyInitialClientText, 'Confirms the un-guarded pattern creates a hydration mismatch');
    });

    it('verifies the fix: effectiveAddress guarantees identical output on SSR and initial client render', () => {
      // 1. SSR Pass: mounted = false
      const ssrMounted = false;
      const ssrIsConnected = false;
      const ssrAddress = undefined;
      const ssrEffective = (ssrMounted && ssrIsConnected && !!ssrAddress) ? ssrAddress : undefined;
      const ssrOutput = renderHeroText(ssrEffective);

      // 2. Client Initial Hydration Pass: mounted = false (before useEffect runs)
      const clientMounted = false;
      const clientIsConnected = true;
      const clientAddress = testWallet;
      const clientInitialEffective = (clientMounted && clientIsConnected && !!clientAddress) ? clientAddress : undefined;
      const clientInitialOutput = renderHeroText(clientInitialEffective);

      // Invariant: Both render 'Guest User'
      assert.equal(ssrOutput, 'Guest User');
      assert.equal(clientInitialOutput, 'Guest User');
      assert.equal(ssrOutput, clientInitialOutput, 'SSR and initial client render must be identical');

      // 3. Post-Mount Client Pass: mounted = true (after useEffect runs)
      const postMountMounted = true;
      const postMountEffective = (postMountMounted && clientIsConnected && !!clientAddress) ? clientAddress : undefined;
      const postMountOutput = renderHeroText(postMountEffective);

      assert.equal(postMountOutput, expectedShortened);
    });

    it('supports wallet switching post-mount without breaking hydration guarantees', () => {
      const switchedWallet = '0x1111111111111111111111111111111111111111' as const;
      const isMounted = true;
      const isConnected = true;

      const effectiveSwitched = (isMounted && isConnected && !!switchedWallet) ? switchedWallet : undefined;
      const output = renderHeroText(effectiveSwitched);

      assert.equal(output, shortenAddress(switchedWallet));
    });
  });
});
