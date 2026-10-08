// test/SynqWalletDiscovery.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyConnectors,
  isSafeIconUri,
  getWalletDisplayName,
  KNOWN_WALLETS_BY_RDNS,
} from '../src/lib/wallet/discovery';
import type { Connector } from 'wagmi';

function makeMockConnector(overrides: Partial<Connector>): Connector {
  return {
    id: overrides.id || 'injected',
    name: overrides.name || 'Mock Wallet',
    type: overrides.type || 'injected',
    uid: overrides.uid || `uid-${Math.random().toString(36).slice(2)}`,
    icon: overrides.icon,
    rdns: overrides.rdns || overrides.id,
    connect: async () => ({ accounts: ['0x1234567890123456789012345678901234567890' as `0x${string}`], chainId: 11155111 }),
    disconnect: async () => {},
    getAccounts: async () => ['0x1234567890123456789012345678901234567890' as `0x${string}`],
    getChainId: async () => 11155111,
    getProvider: async () => ({}),
    isAuthorized: async () => true,
    emitter: { emit: () => {}, on: () => {}, off: () => {} } as any,
    setup: async () => {},
    ...overrides,
  } as unknown as Connector;
}

describe('SYNQ — B.10.3 Dynamic Wallet Discovery Suite (Option C)', () => {
  const rootDir = path.resolve(__dirname, '..');
  const walletStatusPath = path.join(rootDir, 'src/components/layout/WalletStatus.tsx');
  const landingPagePath = path.join(rootDir, 'src/app/page.tsx');
  const appLayoutPath = path.join(rootDir, 'src/components/layout/AppLayout.tsx');

  const walletStatusContent = fs.readFileSync(walletStatusPath, 'utf8');
  const landingContent = fs.readFileSync(landingPagePath, 'utf8');
  const appLayoutContent = fs.readFileSync(appLayoutPath, 'utf8');

  it('1. Scenario: MetaMask only detected', () => {
    const metamask = makeMockConnector({
      id: 'io.metamask',
      name: 'MetaMask',
      type: 'injected',
      rdns: 'io.metamask',
    });
    const fallbackInjected = makeMockConnector({
      id: 'injected',
      name: 'Injected',
      type: 'injected',
    });

    const result = classifyConnectors([metamask, fallbackInjected]);
    assert.equal(result.detectedWallets.length, 1);
    assert.equal(result.detectedWallets[0].id, 'io.metamask');
    assert.equal(result.detectedWallets[0].name, 'MetaMask');
    assert.equal(KNOWN_WALLETS_BY_RDNS['io.metamask'].src, '/wallets/metamask.png');
  });

  it('2. Scenario: Rabby only detected', () => {
    const rabby = makeMockConnector({
      id: 'io.rabby',
      name: 'Rabby Wallet',
      type: 'injected',
      rdns: 'io.rabby',
    });

    const result = classifyConnectors([rabby]);
    assert.equal(result.detectedWallets.length, 1);
    assert.equal(result.detectedWallets[0].id, 'io.rabby');
    assert.equal(result.detectedWallets[0].name, 'Rabby Wallet');
    assert.equal(KNOWN_WALLETS_BY_RDNS['io.rabby'].src, '/wallets/rabby.jpg');
  });

  it('3. Scenario: MetaMask and Rabby simultaneously coexisting (zero collision)', () => {
    const metamask = makeMockConnector({
      id: 'io.metamask',
      name: 'MetaMask',
      type: 'injected',
      rdns: 'io.metamask',
      uid: 'uid-mm',
    });
    const rabby = makeMockConnector({
      id: 'io.rabby',
      name: 'Rabby Wallet',
      type: 'injected',
      rdns: 'io.rabby',
      uid: 'uid-rabby',
    });
    const generic = makeMockConnector({
      id: 'injected',
      name: 'Injected',
      type: 'injected',
    });

    const result = classifyConnectors([metamask, rabby, generic]);
    assert.equal(result.detectedWallets.length, 2);
    assert.equal(result.detectedWallets[0].id, 'io.metamask');
    assert.equal(result.detectedWallets[1].id, 'io.rabby');
    // Ensure distinct UIDs are preserved for direct connector dispatch
    assert.notEqual(result.detectedWallets[0].uid, result.detectedWallets[1].uid);
  });

  it('4. Scenario: Unknown EIP-6963 wallet announced', () => {
    const rainbow = makeMockConnector({
      id: 'me.rainbow',
      name: 'Rainbow',
      type: 'injected',
      rdns: 'me.rainbow',
      icon: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    });

    const result = classifyConnectors([rainbow]);
    assert.equal(result.detectedWallets.length, 1);
    assert.equal(result.detectedWallets[0].id, 'me.rainbow');
    assert.equal(getWalletDisplayName(result.detectedWallets[0].name), 'Rainbow');
    assert.equal(isSafeIconUri(result.detectedWallets[0].icon), true);
  });

  it('5. Scenario: No extensions installed', () => {
    const generic = makeMockConnector({
      id: 'injected',
      name: 'Injected',
      type: 'injected',
    });
    const coinbaseSdk = makeMockConnector({
      id: 'coinbaseWalletSDK',
      name: 'Coinbase Wallet',
      type: 'coinbaseWallet',
    });

    const result = classifyConnectors([generic, coinbaseSdk]);
    assert.equal(result.detectedWallets.length, 0);
    assert.ok(result.genericInjected);
    assert.ok(result.coinbaseSdk);
  });

  it('6. Scenario: Coinbase extension plus Coinbase SDK coexistence', () => {
    const cbExtension = makeMockConnector({
      id: 'com.coinbase.wallet',
      name: 'Coinbase Wallet',
      type: 'injected',
      rdns: 'com.coinbase.wallet',
    });
    const cbSdk = makeMockConnector({
      id: 'coinbaseWalletSDK',
      name: 'Coinbase Wallet',
      type: 'coinbaseWallet',
    });

    const result = classifyConnectors([cbExtension, cbSdk]);
    assert.equal(result.detectedWallets.length, 1);
    assert.equal(result.detectedWallets[0].id, 'com.coinbase.wallet');
    assert.ok(result.coinbaseSdk);
    assert.equal(result.coinbaseSdk.id, 'coinbaseWalletSDK');
  });

  it('7. Scenario: WalletConnect configured vs missing', () => {
    const wcConnector = makeMockConnector({
      id: 'walletConnect',
      name: 'WalletConnect',
      type: 'walletConnect',
    });

    const configured = classifyConnectors([wcConnector]);
    assert.ok(configured.walletConnect);

    const missing = classifyConnectors([]);
    assert.equal(missing.walletConnect, undefined);
  });

  it('8. Scenario: Duplicate and malformed provider announcements', () => {
    const dup1 = makeMockConnector({
      id: 'io.metamask',
      name: 'MetaMask',
      type: 'injected',
      uid: 'uid-1',
    });
    const dup2 = makeMockConnector({
      id: 'io.metamask',
      name: 'MetaMask Duplicate',
      type: 'injected',
      uid: 'uid-2',
    });
    const malformed1 = makeMockConnector({
      id: '',
      type: 'injected',
    });

    const result = classifyConnectors([dup1, dup2, malformed1]);
    // Deduplication by ID retains only the first unique instance
    assert.equal(result.detectedWallets.length, 1);
    assert.equal(result.detectedWallets[0].uid, 'uid-1');
  });

  it('9. Metadata safety: icon scheme validation and name sanitization', () => {
    // Valid icons
    assert.equal(isSafeIconUri('https://example.com/icon.png'), true);
    assert.equal(isSafeIconUri('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='), true);
    assert.equal(isSafeIconUri('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), true);

    // Malicious or invalid icons rejected
    assert.equal(isSafeIconUri('javascript:alert(1)'), false);
    assert.equal(isSafeIconUri('data:text/html;<script>alert(1)</script>'), false);
    assert.equal(isSafeIconUri('data:image/svg+xml,<svg onload=alert(1)>'), false);
    assert.equal(isSafeIconUri('vbscript:msgbox'), false);
    assert.equal(isSafeIconUri('https://example.com/icon.png" onerror="alert(1)'), false);
    assert.equal(isSafeIconUri(undefined), false);
    assert.equal(isSafeIconUri(''), false);

    // Name sanitization
    assert.equal(getWalletDisplayName('   MetaMask   '), 'MetaMask');
    assert.equal(getWalletDisplayName(''), 'Browser Wallet');
    assert.equal(getWalletDisplayName(undefined), 'Browser Wallet');
    assert.equal(
      getWalletDisplayName('A'.repeat(80)),
      'A'.repeat(40),
      'Must truncate long wallet names to 40 characters'
    );
  });

  it('10. WalletStatus component integration: direct connector dispatch and two-section layout', () => {
    // Replaced hardcoded idMap string routing with direct connector dispatch
    assert.ok(!walletStatusContent.includes("idMap['metaMask'] = 'injected'"));
    assert.ok(!walletStatusContent.includes("const idMap: Record<string, string>"));
    assert.match(walletStatusContent, /handleConnect\s*=\s*async\s*\(\s*targetConnector:\s*Connector\s*\)/);
    assert.match(walletStatusContent, /await\s+connectAsync\(\{\s*connector:\s*targetConnector\s*\}\)/);

    // Section 1: Detected Wallets
    assert.match(walletStatusContent, /Detected Wallets/);
    assert.match(walletStatusContent, /Installed/);
    assert.match(walletStatusContent, /No browser wallet detected/);

    // Section 2: Other Connection Methods
    assert.match(walletStatusContent, /Other Connection Methods/);

    // Bounded scrolling for wallet list
    assert.match(walletStatusContent, /overflow-y-auto/);

    // Safe icon rendering via WalletItemIcon
    assert.match(walletStatusContent, /<WalletItemIcon/);
  });

  it('11. Stacking and portal preservation from B.10.1', () => {
    // Portaled into document.body
    assert.match(walletStatusContent, /createPortal\(\s*<AnimatePresence>[\s\S]*?showModal\s*&&/);
    assert.match(walletStatusContent, /key="wallet-modal-portal-root"/);
    assert.match(walletStatusContent, /key="wallet-modal-backdrop"/);
    assert.match(walletStatusContent, /key="wallet-modal-panel"/);

    // Proper z-index levels
    assert.match(walletStatusContent, /key="wallet-modal-backdrop"[\s\S]*?z-\[100\]/);
    assert.match(walletStatusContent, /key="wallet-modal-panel"[\s\S]*?z-\[101\]/);

    // Escape dismissal and open change notification
    assert.match(walletStatusContent, /handleOpenModal/);
    assert.match(walletStatusContent, /handleCloseModal/);
    assert.match(walletStatusContent, /e\.key\s*===\s*'Escape'[\s\S]*?handleCloseModal\(\)/);
  });

  it('12. Landing page six-cube reveal and internal pages normal capsule behavior unchanged', () => {
    // Six cubes on landing
    assert.match(landingContent, /wallet-square-a/);
    assert.match(landingContent, /wallet-square-b/);
    assert.match(landingContent, /wallet-square-c/);
    assert.match(landingContent, /wallet-square-d/);
    assert.match(landingContent, /wallet-square-e/);
    assert.match(landingContent, /wallet-square-f/);

    // Internal pages AppLayout has no cubes
    assert.ok(!appLayoutContent.includes('wallet-square'));
    assert.match(appLayoutContent, /<WalletStatus\s*\/>/);
  });
});
