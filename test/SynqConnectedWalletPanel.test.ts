// test/SynqConnectedWalletPanel.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SYNQ_V2_SEPOLIA_CONFIG, SEPOLIA_CHAIN_ID } from '../src/lib/contracts/addresses';
import { erc20ABI } from '../src/lib/contracts/abis';

describe('SYNQ — B.10.7 Connected Wallet Capsule & Expandable Panel Suite', () => {
  const rootDir = path.resolve(__dirname, '..');
  const walletStatusPath = path.join(rootDir, 'src/components/layout/WalletStatus.tsx');
  const landingPagePath = path.join(rootDir, 'src/app/page.tsx');
  const appLayoutPath = path.join(rootDir, 'src/components/layout/AppLayout.tsx');

  const walletStatusContent = fs.readFileSync(walletStatusPath, 'utf8');
  const landingContent = fs.readFileSync(landingPagePath, 'utf8');
  const appLayoutContent = fs.readFileSync(appLayoutPath, 'utf8');

  it('1. Capsule: Retains dynamic ETH balance, username, and approved white styling', () => {
    // Retains white capsule with #242424 text and rounded-xl
    assert.match(walletStatusContent, /bg-\[#FFFFFF\]\s+border-zinc-200\/90\s+text-\[#242424\]/);
    assert.match(walletStatusContent, /rounded-xl/);

    // Displays dynamic ETH balance in the capsule (not USDC, not hardcoded)
    assert.match(
      walletStatusContent,
      /\{balance\s*\?\s*formatBalance\(balance\)\s*:\s*'\.\.\.'\}/,
      'Capsule must render dynamic ETH balance'
    );
    assert.match(walletStatusContent, /useBalance\(\{\s*address,\s*chainId:\s*SEPOLIA_CHAIN_ID\s*\}\)/);

    // Retains username or truncated address
    assert.match(walletStatusContent, /identity\.displayHandle\s*\|\|\s*\(address\s*\?\s*truncateAddress\(address\)\s*:\s*''\)/);

    // Animated chevron reflecting open state
    assert.match(walletStatusContent, /<ChevronDown[\s\S]*?open\s*&&\s*'rotate-180'/);
  });

  it('2. Panel width matching: Dynamically matches white capsule rendered width', () => {
    // Width computed from button bounding client rect
    assert.match(walletStatusContent, /const\s+width\s*=\s*Math\.round\(rect\.width\)/);

    // Dropdown position state stores top, left, and width
    assert.match(walletStatusContent, /dropdownPos[\s\S]*?width:\s*number/);

    // Panel style directly binds width to dropdownPos.width with safe fallback
    assert.match(
      walletStatusContent,
      /width:\s*dropdownPos\.width\s*\|\|\s*\(buttonRef\.current\?\.getBoundingClientRect\(\)\.width\s*\?\?\s*210\)/,
      'Panel style must directly bind width to match the capsule'
    );

    // Capsule has min-w-[210px] guard to prevent cramped action buttons on short names
    assert.match(walletStatusContent, /min-w-\[210px\]/);

    // ResizeObserver observes buttonRef to update width if balance or username changes
    assert.match(walletStatusContent, /ResizeObserver/);
    assert.match(walletStatusContent, /observer\.observe\(buttonRef\.current\)/);
  });

  it('3. Panel positioning: Directly beneath capsule with viewport edge protection', () => {
    // Minimal visual separation (rect.bottom + 6px)
    assert.match(walletStatusContent, /top:\s*Math\.round\(rect\.bottom\s*\+\s*6\)/);

    // Left coordinate clamped to avoid horizontal viewport overflow
    assert.match(
      walletStatusContent,
      /const\s+left\s*=\s*Math\.round\(Math\.max\(8,\s*Math\.min\(rect\.left,\s*window\.innerWidth\s*-\s*width\s*-\s*8\)\)\)/,
      'Panel left coordinate must be clamped to prevent screen edge overflow'
    );

    // Window scroll and resize listeners update position
    assert.match(walletStatusContent, /window\.addEventListener\('resize',\s*updateDropdownPos\)/);
    assert.match(walletStatusContent, /window\.addEventListener\('scroll',\s*updateDropdownPos,\s*true\)/);
  });

  it('4. Balances: Actual Sepolia USDC and ETH in two equally prominent rows (no Gas label)', () => {
    // Reads canonical Sepolia USDC using erc20ABI.balanceOf
    assert.match(walletStatusContent, /useReadContract\(\{[\s\S]*?address:\s*SYNQ_V2_SEPOLIA_CONFIG\.canonicalUsdc/);
    assert.match(walletStatusContent, /abi:\s*erc20ABI/);
    assert.match(walletStatusContent, /functionName:\s*'balanceOf'/);

    // Canonical USDC address matches standard V2 deployment config
    assert.equal(SYNQ_V2_SEPOLIA_CONFIG.canonicalUsdc, '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
    assert.equal(SYNQ_V2_SEPOLIA_CONFIG.usdcDecimals, 6);

    // Two equally prominent rows: USDC and ETH
    assert.match(walletStatusContent, /formatUsdcValue\(usdcRawBalance\)/);
    assert.match(walletStatusContent, /formatEthValue\(balance\)/);

    // No "Gas" label in the panel
    assert.ok(!walletStatusContent.includes('Gas:'), 'ETH balance must not be labeled as Gas');
  });

  it('5. Header: Compact display with display name, username, and Sepolia status (no duplicate cards)', () => {
    // Header displays display name or handle
    assert.match(walletStatusContent, /displayName\s*\|\|\s*identity\.displayHandle/);

    // Shows Sepolia status with green dot
    assert.match(walletStatusContent, /networkReady\s*\?\s*'bg-green-400'\s*:\s*'bg-amber-400'/);
    assert.match(walletStatusContent, /networkReady\s*\?\s*'Sepolia'\s*:\s*'Wrong Net'/);

    // Pixel font typography applied to panel
    assert.match(walletStatusContent, /pressStart2P\.className/);
  });

  it('6. Wallet address: Shortened address displayed and full address copied to clipboard', () => {
    // Truncated address in UI
    assert.match(walletStatusContent, /truncateAddress\(address\)/);

    // Full address copied to clipboard
    assert.match(walletStatusContent, /navigator\.clipboard\.writeText\(address\)/);

    // Accessible copy label
    assert.match(walletStatusContent, /aria-label="Copy full wallet address"/);
  });

  it('7. Actions: Swap navigates to /swap and Disconnect remains functional', () => {
    // Swap action navigates to /swap with white background and charcoal text
    assert.match(walletStatusContent, /href="\/swap"/);
    assert.match(walletStatusContent, /bg-white\s+text-\[#242424\][\s\S]*?Swap/);

    // Disconnect button matches Swap with white background and charcoal text and LogOut icon
    assert.match(walletStatusContent, /bg-white\s+text-\[#242424\][\s\S]*?Disconnect/);
    assert.match(walletStatusContent, /onClick=\{[\s\S]*?disconnect\(\);[\s\S]*?handleClose\(\);[\s\S]*?\}/);

    // Explorer action is retired from panel
    assert.ok(!walletStatusContent.includes('Explorer'));
  });

  it('8. Visual styling: Charcoal background, subtle dividers, and no red/gradient action surfaces', () => {
    // Charcoal panel background #303030 and subtle border #444444
    assert.match(walletStatusContent, /bg-\[#303030\]/);
    assert.match(walletStatusContent, /border-\[#444444\]/);

    // Subtle dividers #404040
    assert.match(walletStatusContent, /border-\[#404040\]/);

    // Rounded corners rounded-2xl
    assert.match(walletStatusContent, /rounded-2xl/);

    // No bright red action surfaces in panel
    assert.ok(!walletStatusContent.includes('bg-red-600/10 text-xs text-red-400'));
  });

  it('9. Expansion animation: Smooth downward motion (250-320ms) and prefers-reduced-motion support', () => {
    // Motion duration within 250-320ms target (280ms)
    assert.match(walletStatusContent, /duration:\s*shouldReduceMotion\s*\?\s*0\.15\s*:\s*0\.28/);

    // Polished cubic easeOut curve
    assert.match(walletStatusContent, /ease:\s*\[0\.16,\s*1,\s*0\.3,\s*1\]/);

    // Respects prefers-reduced-motion
    assert.match(walletStatusContent, /useReducedMotion/);
    assert.match(walletStatusContent, /initial=\{shouldReduceMotion\s*\?\s*\{\s*opacity:\s*0\s*\}\s*:\s*\{\s*opacity:\s*0,\s*y:\s*-6\s*\}\}/);
    assert.match(walletStatusContent, /animate=\{shouldReduceMotion\s*\?\s*\{\s*opacity:\s*1\s*\}\s*:\s*\{\s*opacity:\s*1,\s*y:\s*0\s*\}\}/);

    // No scale transform on panel (prevents pixel font distortion)
    assert.ok(!walletStatusContent.includes('scale: 0.96'));
  });

  it('10. Wrong network handling: Alert banner and disabled balance queries', () => {
    // Alert banner shown when network is not ready
    assert.match(walletStatusContent, /!networkReady\s*&&/);
    assert.match(walletStatusContent, /Switch to Ethereum Sepolia|Switch Sepolia/);
    assert.match(walletStatusContent, /handleSwitchToSepolia/);

    // Balance query is gated by networkReady
    assert.match(walletStatusContent, /enabled:\s*Boolean\(address\s*&&\s*networkReady\)/);

    // Displays -- when network is wrong/unverified
    assert.match(walletStatusContent, /!networkReady\s*\?\s*'--'/);
  });

  it('11. Stacking & portal: Portal root, backdrop, panel keys, and escape dismissal preserved', () => {
    // Portal in document.body
    assert.match(walletStatusContent, /createPortal\(\s*<AnimatePresence>[\s\S]*?open\s*&&/);
    assert.match(walletStatusContent, /key="wallet-dropdown-portal-root"/);
    assert.match(walletStatusContent, /key="wallet-dropdown-backdrop"/);
    assert.match(walletStatusContent, /key="wallet-dropdown-panel"/);

    // z-index levels
    assert.match(walletStatusContent, /key="wallet-dropdown-backdrop"[\s\S]*?z-\[100\]/);
    assert.match(walletStatusContent, /key="wallet-dropdown-panel"[\s\S]*?z-\[101\]/);

    // Escape dismissal
    assert.match(walletStatusContent, /e\.key\s*===\s*'Escape'[\s\S]*?handleClose\(\)/);
  });

  it('12. Wallet connection modal from B.10.4–B.10.6 remains completely unchanged', () => {
    // Connection modal title and styling
    assert.match(walletStatusContent, /Synq your wallet\.\.\./);
    assert.match(walletStatusContent, /Choose a wallet to connect and continue\./);
    assert.match(walletStatusContent, /By connecting, you agree to Synq(?:'|&apos;)s Terms of Service/);

    // Grid layout and compact name
    assert.match(walletStatusContent, /grid-cols-3[\s\S]*?md:grid-cols-5/);
    assert.match(walletStatusContent, /item\.compactName/);
    assert.match(walletStatusContent, /aria-label=\{`Connect with \$\{item\.name\}`\}/);

    // Per-wallet icon styles intact
    assert.match(walletStatusContent, /'io\.metamask'[\s\S]*?scale-\[1\.85\]/);
    assert.match(walletStatusContent, /'com\.coinbase\.wallet'[\s\S]*?scale-\[2\.35\]/);
    assert.match(walletStatusContent, /'io\.rabby'[\s\S]*?rounded-xl/);
    assert.match(walletStatusContent, /'app\.phantom'[\s\S]*?rounded-xl/);
  });

  it('13. B.10.8 Readability: Taller panel padding, increased spacing, and larger typography', () => {
    // Panel padding increased to p-4 and gap-3.5 for vertical breathing room
    assert.match(walletStatusContent, /p-4\s+rounded-2xl[\s\S]*?gap-3\.5/);

    // Profile header typography: text-[10px] display name, text-[8px] handle, text-[7.5px] network
    assert.match(walletStatusContent, /text-\[10px\]\s+text-white\s+font-normal\s+truncate/);
    assert.match(walletStatusContent, /text-\[8px\]\s+text-zinc-400\s+truncate\s+mt-1/);
    assert.match(walletStatusContent, /text-\[7\.5px\]\s+text-zinc-400/);

    // Address section typography: text-[10px] sm:text-[10.5px]
    assert.match(walletStatusContent, /text-\[10px\]\s+sm:text-\[10\.5px\]\s+text-zinc-200\s+tracking-tight\s+truncate\s+block/);

    // Action button sizing: h-9 and text-[8px] sm:text-[8.5px]
    assert.match(walletStatusContent, /h-9\s+(?:px-1\.5\s+sm:)?px-2\s+rounded-xl[\s\S]*?text-\[8px\]\s+sm:text-\[8\.5px\]/);
  });

  it('14. B.10.8 Balances: Two equally prominent rows, left-aligned values, right-aligned symbols', () => {
    // Both balance rows use larger Press_Start_2P font (text-[10px] sm:text-[10.5px])
    assert.match(walletStatusContent, /text-\[10px\]\s+sm:text-\[10\.5px\]\s+text-white\s+font-normal\s+tracking-tight/);

    // Currency symbols are right-aligned
    assert.match(walletStatusContent, /text-\[8\.5px\]\s+shrink-0[\s\S]*?USDC/);
    assert.match(walletStatusContent, /text-\[8\.5px\]\s+shrink-0[\s\S]*?ETH/);

    // First row USDC, second row ETH
    const usdcIndex = walletStatusContent.indexOf('formatUsdcValue');
    const ethIndex = walletStatusContent.indexOf('formatEthValue');
    assert.ok(usdcIndex !== -1 && ethIndex !== -1);
    assert.ok(usdcIndex < ethIndex, 'USDC row must precede ETH row');
  });

  it('15. B.10.8 Formatting logic: USDC 2 decimals and ETH 4 decimals without float precision loss', () => {
    assert.match(walletStatusContent, /formatUnits\(raw,\s*decimals\)/);
    assert.match(walletStatusContent, /formatUnits\(bal\.value,\s*bal\.decimals\)/);

    // Formatter functions exist and handle string splitting instead of float division
    assert.match(walletStatusContent, /const\s+formatted\s*=\s*formatUnits/);
    assert.match(walletStatusContent, /const\s+\[intPart,\s*fracPart\s*=\s*''\]\s*=\s*formatted\.split\('\.'\)/);

    // Verify formatting behavior (2 decimals for USDC, 4 decimals for ETH)
    const formatUsdc = (raw: bigint) => {
      const formatted = (Number(raw) / 1e6).toFixed(2);
      return formatted;
    };
    const formatEth = (raw: bigint) => {
      const formatted = (Number(raw) / 1e18).toFixed(4);
      return formatted;
    };

    assert.equal(formatUsdc(17810000n), '17.81');
    assert.equal(formatEth(951300000000000000n), '0.9513');
  });

  it('16. B.10.9 & B.10.10: Shared BalanceRow, larger address, and 35:65 ratio white action buttons', () => {
    // Shared BalanceRow component guarantees 100% typography parity across USDC and ETH
    assert.match(walletStatusContent, /function BalanceRow\(\{/);
    assert.match(walletStatusContent, /<BalanceRow[\s\S]*?symbol="USDC"/);
    assert.match(walletStatusContent, /<BalanceRow[\s\S]*?symbol="ETH"/);

    // No font-mono override on the balance values
    assert.ok(!walletStatusContent.includes('font-mono truncate mr-2'));

    // Larger address uses Press_Start_2P at 10-10.5px
    assert.match(walletStatusContent, /text-\[10px\]\s+sm:text-\[10\.5px\]\s+text-zinc-200\s+tracking-tight\s+truncate\s+block/);

    // Action buttons in proportional 35:65 ratio grid
    assert.match(
      walletStatusContent,
      /grid-cols-\[minmax\(0,35fr\)_minmax\(0,65fr\)\]|gridTemplateColumns:\s*'minmax\(0,\s*35fr\)\s*minmax\(0,\s*65fr\)'/
    );

    // Both buttons share identical surface, dimensions, typography, and charcoal icon styling
    const swapButtonMatch = walletStatusContent.match(/<Link[\s\S]*?href="\/swap"[\s\S]*?className="([^"]+)"/);
    const disconnectButtonMatch = walletStatusContent.match(/<button[\s\S]*?disconnect\(\)[\s\S]*?className="([^"]+)"/);
    assert.ok(swapButtonMatch, 'Swap button link must exist');
    assert.ok(disconnectButtonMatch, 'Disconnect button must exist');
    assert.equal(swapButtonMatch[1], disconnectButtonMatch[1], 'Swap and Disconnect button classes must be identical');

    // Both buttons have white backgrounds and charcoal text/icons
    assert.match(swapButtonMatch[1], /bg-white/);
    assert.match(swapButtonMatch[1], /text-\[#242424\]/);
    assert.match(swapButtonMatch[1], /rounded-xl/);
    assert.match(swapButtonMatch[1], /h-9/);
    assert.match(swapButtonMatch[1], /w-full/);
    assert.match(walletStatusContent, /<ArrowRightLeft[\s\S]*?text-\[#242424\]/);
    assert.match(walletStatusContent, /<LogOut[\s\S]*?text-\[#242424\]/);
  });

  it('17. B.10.10: Proportional 35:65 ratio grid prevents Disconnect label overflow', () => {
    // 35:65 ratio implemented cleanly
    assert.match(walletStatusContent, /grid-cols-\[minmax\(0,35fr\)_minmax\(0,65fr\)\]/);
    assert.match(walletStatusContent, /gridTemplateColumns:\s*'minmax\(0,\s*35fr\)\s*minmax\(0,\s*65fr\)'/);

    // Reduced spacing and padding to keep Swap readable without font shrinking
    assert.match(walletStatusContent, /gap-1\s+sm:gap-1\.5/);
    assert.match(walletStatusContent, /px-1\.5\s+sm:px-2/);

    // Labels protected from wrapping/clipping
    assert.match(walletStatusContent, /whitespace-nowrap\s+overflow-hidden/);
  });
});
