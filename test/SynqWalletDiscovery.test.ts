// test/SynqWalletDiscovery.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyConnectors,
  buildGridWalletItems,
  isSafeIconUri,
  getWalletDisplayName,
  getCompactWalletName,
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

  it('10. WalletStatus component integration: direct connector dispatch and compact icon grid layout', () => {
    // Direct connector dispatch
    assert.match(walletStatusContent, /handleConnect\s*=\s*async\s*\(\s*targetConnector:\s*Connector\s*\)/);
    assert.match(walletStatusContent, /await\s+connectAsync\(\{\s*connector:\s*targetConnector\s*\}\)/);

    // Build compact grid items from connectors
    assert.match(walletStatusContent, /buildGridWalletItems\(connectors\)/);

    // Bounded scrolling for wallet grid
    assert.match(walletStatusContent, /overflow-y-auto/);

    // Safe icon rendering via WalletItemIcon inside smooth white tile
    assert.match(walletStatusContent, /<WalletItemIcon/);
    assert.match(walletStatusContent, /bg-white/);
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

  it('13. B.10.4 UI Redesign: Five-column desktop grid and responsive three-column mobile grid', () => {
    // Modal shell visual styles
    assert.match(walletStatusContent, /bg-\[#303030\]/);
    assert.match(walletStatusContent, /rounded-3xl/);
    assert.match(walletStatusContent, /border-\[#444444\]/);

    // Desktop 5-column, tablet 4-column, mobile 3-column
    assert.match(walletStatusContent, /grid-cols-3/);
    assert.match(walletStatusContent, /md:grid-cols-5/);

    // White rounded-square tiles with centered icons and name underneath
    assert.match(walletStatusContent, /rounded-2xl bg-white/);
    assert.match(walletStatusContent, /truncate/);
  });

  it('14. B.10.4 UI Redesign: Exact heading, subtitle, and local word-spacing reduction', () => {
    // Exact heading and subtitle
    assert.match(walletStatusContent, /Synq your wallet\.\.\./);
    assert.match(walletStatusContent, /Choose a wallet to connect and continue\./);

    // Pixel font applied to heading
    assert.match(walletStatusContent, /pressStart2P\.className/);

    // Local word-spacing reduction on heading without touching letter-spacing
    assert.match(walletStatusContent, /wordSpacing:\s*'-0\.35em'/);

    // Thin horizontal divider separating header from grid
    assert.match(walletStatusContent, /border-b border-\[#404040\]/);
  });

  it('15. B.10.4 UI Redesign: Dynamic grid rendering with >10 detected wallets', () => {
    // Test with 15 discovered EIP-6963 wallets
    const manyWallets = Array.from({ length: 15 }, (_, i) =>
      makeMockConnector({
        id: `wallet.provider.${i}`,
        name: `Wallet Provider ${i}`,
        type: 'injected',
        rdns: `org.wallet.${i}`,
      })
    );

    const items = buildGridWalletItems(manyWallets);
    // All 15 wallets rendered without arbitrary capping
    assert.equal(items.length, 15);
    assert.equal(items[0].name, 'Wallet Provider 0');
    assert.equal(items[14].name, 'Wallet Provider 14');
  });

  it('16. B.10.4 UI Redesign: WalletConnect presence when configured and omission when unconfigured', () => {
    const wcConnector = makeMockConnector({
      id: 'walletConnect',
      name: 'WalletConnect',
      type: 'walletConnect',
    });

    // When configured: present as a grid item
    const configuredItems = buildGridWalletItems([wcConnector]);
    const wcItem = configuredItems.find((i) => i.name === 'WalletConnect');
    assert.ok(wcItem, 'WalletConnect must be included in grid items when configured');
    assert.equal(wcItem.iconSrc, '/wallets/walletconnect.png');

    // When unconfigured: omitted from grid items (no fake placeholder)
    const unconfiguredItems = buildGridWalletItems([]);
    const unconfiguredWc = unconfiguredItems.find((i) => i.name === 'WalletConnect');
    assert.equal(unconfiguredWc, undefined, 'WalletConnect must NOT be displayed when unconfigured');
  });

  it('17. B.10.4 UI Redesign: Fixed header and footer with bounded scrollable grid', () => {
    // Fixed header with shrink-0
    assert.match(walletStatusContent, /border-b border-\[#404040\][\s\S]*?shrink-0/);

    // Scrollable grid area with max-h and overflow-y-auto
    assert.match(walletStatusContent, /overflow-y-auto[\s\S]*?max-h-\[380px\]/);

    // Fixed footer with shrink-0
    assert.match(walletStatusContent, /border-t border-\[#404040\] shrink-0/);
  });

  it('18. B.10.4 UI Redesign: Terms of Service footer text preservation', () => {
    assert.match(walletStatusContent, /By connecting, you agree to Synq(?:'|&apos;)s Terms of Service/);
  });

  it('19. B.10.5 Visual Refinement: Press_Start_2P applied across subtitle, wallet names, and footer', () => {
    // Subtitle uses pressStart2P at 9-10px
    assert.match(walletStatusContent, /pressStart2P\.className[\s\S]*?text-\[9px\]/);
    assert.match(walletStatusContent, /Choose a wallet to connect and continue\./);

    // Wallet names use pressStart2P at 8-8.5px with controlled two-line wrapping
    assert.match(walletStatusContent, /pressStart2P\.className[\s\S]*?text-\[8px\][\s\S]*?line-clamp-2/);
    assert.match(walletStatusContent, /break-words/);

    // Footer uses pressStart2P at 8px
    assert.match(walletStatusContent, /pressStart2P\.className[\s\S]*?text-\[8px\][\s\S]*?By connecting, you agree to Synq/);
  });

  it('20. B.10.5 Visual Refinement: Per-wallet icon sizing and smooth rounding rules', () => {
    // MetaMask scaled to match perceived size
    assert.match(walletStatusContent, /'io\.metamask'[\s\S]*?scale-\[1\.85\]/);

    // Coinbase scaled to compensate for canvas transparent margins
    assert.match(walletStatusContent, /'com\.coinbase\.wallet'[\s\S]*?scale-\[2\.35\]/);

    // Rabby solid JPEG has smooth rounded corners
    assert.match(walletStatusContent, /'io\.rabby'[\s\S]*?rounded-xl/);

    // Phantom solid square badge has smooth rounded corners
    assert.match(walletStatusContent, /'app\.phantom'[\s\S]*?rounded-xl/);

    // White tiles maintain overflow-hidden to clip scaled icons seamlessly
    assert.match(walletStatusContent, /rounded-2xl bg-white[\s\S]*?overflow-hidden/);
  });

  it('21. B.10.6 Compact Names: Formatter extracts first word safely across name variants', () => {
    // Multiword wallet names -> first word only
    assert.equal(getCompactWalletName('Bitget Wallet'), 'Bitget');
    assert.equal(getCompactWalletName('Trust Wallet'), 'Trust');
    assert.equal(getCompactWalletName('Coinbase Wallet'), 'Coinbase');
    assert.equal(getCompactWalletName('Rainbow Wallet'), 'Rainbow');
    assert.equal(getCompactWalletName('Brave Wallet'), 'Brave');

    // Single-word wallet names -> unchanged
    assert.equal(getCompactWalletName('Phantom'), 'Phantom');
    assert.equal(getCompactWalletName('MetaMask'), 'MetaMask');
    assert.equal(getCompactWalletName('WalletConnect'), 'WalletConnect');
    assert.equal(getCompactWalletName('Zerion'), 'Zerion');

    // Unknown multi-word wallet names
    assert.equal(getCompactWalletName('Some Random Extension Wallet'), 'Some');
    assert.equal(getCompactWalletName('Exodus Web3'), 'Exodus');

    // Safe handling of empty, whitespace, malformed, or unusual inputs
    assert.equal(getCompactWalletName(''), 'Browser');
    assert.equal(getCompactWalletName('   '), 'Browser');
    assert.equal(getCompactWalletName(undefined), 'Browser');
    assert.equal(getCompactWalletName(null), 'Browser');
    assert.equal(getCompactWalletName({} as any), 'Browser');
    assert.equal(getCompactWalletName('SuperLongSingleWordWalletNameThatIsExtremelyLong'), 'SuperLongSingleWordWalletNameThatIsExtre');
  });

  it('22. B.10.6 Grid Items: Compact label used for display while preserving full name in metadata', () => {
    const bitget = makeMockConnector({
      id: 'com.bitget.web3',
      name: 'Bitget Wallet',
      type: 'injected',
      rdns: 'com.bitget.web3',
    });
    const coinbase = makeMockConnector({
      id: 'com.coinbase.wallet',
      name: 'Coinbase Wallet',
      type: 'injected',
      rdns: 'com.coinbase.wallet',
    });
    const phantom = makeMockConnector({
      id: 'app.phantom',
      name: 'Phantom',
      type: 'injected',
      rdns: 'app.phantom',
    });

    const items = buildGridWalletItems([bitget, coinbase, phantom]);

    // Bitget: full name preserved, compact name has first word
    const bitgetItem = items.find((i) => i.rdns === 'com.bitget.web3');
    assert.ok(bitgetItem);
    assert.equal(bitgetItem.name, 'Bitget Wallet');
    assert.equal(bitgetItem.compactName, 'Bitget');
    assert.equal(bitgetItem.connector, bitget, 'Connector object identity must remain intact');

    // Coinbase: full name preserved, compact name has first word
    const coinbaseItem = items.find((i) => i.rdns === 'com.coinbase.wallet');
    assert.ok(coinbaseItem);
    assert.equal(coinbaseItem.name, 'Coinbase Wallet');
    assert.equal(coinbaseItem.compactName, 'Coinbase');
    assert.equal(coinbaseItem.connector, coinbase, 'Connector object identity must remain intact');

    // Phantom: single word remains identical
    const phantomItem = items.find((i) => i.rdns === 'app.phantom');
    assert.ok(phantomItem);
    assert.equal(phantomItem.name, 'Phantom');
    assert.equal(phantomItem.compactName, 'Phantom');
    assert.equal(phantomItem.connector, phantom, 'Connector object identity must remain intact');
  });

  it('23. B.10.6 Modal Accessibility: Full accessible name preserved and exact-provider dispatch maintained', () => {
    // Accessible button label retains full connector name
    assert.match(
      walletStatusContent,
      /aria-label=\{`Connect with \$\{item\.name\}`\}/,
      'Full wallet name must be retained in aria-label'
    );

    // Tooltip retains full connector name
    assert.match(
      walletStatusContent,
      /title=\{item\.name\}/,
      'Full wallet name must be retained in title tooltip'
    );

    // Visual button label renders compact name
    assert.match(
      walletStatusContent,
      /\{item\.compactName\}/,
      'Visual label must render item.compactName'
    );

    // Exact-provider dispatch passes unchanged targetConnector
    assert.match(
      walletStatusContent,
      /onClick=\{\(\) => handleConnect\(item\.connector\)\}/,
      'Direct dispatch of item.connector to handleConnect must remain unchanged'
    );
  });
});
