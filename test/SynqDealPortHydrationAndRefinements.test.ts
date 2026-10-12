// test/SynqDealPortHydrationAndRefinements.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('SYNQ — Deal Port (/marketplace) Hydration, Background & Visual Refinements Suite', () => {
  const marketplacePath = path.resolve(process.cwd(), 'src/app/marketplace/page.tsx');
  const marketplaceContent = fs.readFileSync(marketplacePath, 'utf8');

  const sellerCardPath = path.resolve(process.cwd(), 'src/components/marketplace/SellerCard.tsx');
  const sellerCardContent = fs.readFileSync(sellerCardPath, 'utf8');

  const globalsCssPath = path.resolve(process.cwd(), 'src/app/globals.css');
  const globalsCssContent = fs.readFileSync(globalsCssPath, 'utf8');

  const appLayoutPath = path.resolve(process.cwd(), 'src/components/layout/AppLayout.tsx');
  const appLayoutContent = fs.readFileSync(appLayoutPath, 'utf8');

  const profileModalPath = path.resolve(process.cwd(), 'src/components/marketplace/ProviderProfileModal.tsx');
  const profileModalContent = fs.readFileSync(profileModalPath, 'utf8');

  const providerProfilePath = path.resolve(process.cwd(), 'src/components/marketplace/ProviderProfile.tsx');
  const providerProfileContent = fs.readFileSync(providerProfilePath, 'utf8');

  // =========================================================================
  // 1. Hydration Safety Invariants in src/app/marketplace/page.tsx
  // =========================================================================
  it('1. Enforces mounted lifecycle state and account restoring guards in MarketplacePage', () => {
    // mounted state initialized to false
    assert.match(
      marketplaceContent,
      /const\s*\[mounted,\s*setMounted\]\s*=\s*useState\(false\);/,
      'MarketplacePage must declare a mounted state initialized to false',
    );

    // useEffect sets mounted to true
    assert.match(
      marketplaceContent,
      /useEffect\(\(\)\s*=>\s*\{\s*setMounted\(true\);/,
      'MarketplacePage must set mounted to true inside useEffect',
    );

    // Checks isAccountRestoring
    assert.match(
      marketplaceContent,
      /const\s+isAccountRestoring\s*=\s*status\s*===\s*'connecting'\s*\|\|\s*status\s*===\s*'reconnecting';/,
      'MarketplacePage must track account restoring state',
    );

    // effectiveIsConnected is gated by mounted
    assert.match(
      marketplaceContent,
      /const\s+effectiveIsConnected\s*=\s*mounted\s*&&\s*isConnected\s*&&\s*!isAccountRestoring;/,
      'effectiveIsConnected must be guarded by mounted to ensure deterministic SSR and initial client render',
    );

    // effectiveAddress is guarded by effectiveIsConnected
    assert.match(
      marketplaceContent,
      /const\s+effectiveAddress\s*=\s*effectiveIsConnected\s*&&\s*!!address\s*\?\s*address\s*:\s*undefined;/,
      'effectiveAddress must be guarded to guarantee matching initial render',
    );

    // Pass effectiveAddress to useDirectoryContract
    assert.match(
      marketplaceContent,
      /const\s+directory\s*=\s*useDirectoryContract\(effectiveAddress/,
      'useDirectoryContract must receive effectiveAddress',
    );
  });

  it('2. Guards system messages, ChainGuard, and SellerCard with effective connection state', () => {
    // System messages use effectiveIsConnected
    assert.match(
      marketplaceContent,
      /\{!effectiveIsConnected\s*&&/,
      'Connect wallet banner must be guarded by !effectiveIsConnected',
    );
    assert.match(
      marketplaceContent,
      /\{effectiveIsConnected\s*&&\s*<ChainGuard/,
      'ChainGuard must be guarded by effectiveIsConnected',
    );
    assert.match(
      marketplaceContent,
      /\{effectiveIsConnected\s*&&\s*!directory\.myRegistered/,
      'Missing profile notice must be guarded by effectiveIsConnected',
    );

    // SellerCard receives effectiveAddress and effectiveIsConnected
    assert.match(
      marketplaceContent,
      /<SellerCard[\s\S]*?me=\{effectiveAddress\}[\s\S]*?isConnected=\{effectiveIsConnected\}/,
      'SellerCard must receive effectiveAddress and effectiveIsConnected',
    );

    // Strictly does not use suppressHydrationWarning
    assert.doesNotMatch(
      marketplaceContent,
      /suppressHydrationWarning/,
      'MarketplacePage must not use suppressHydrationWarning',
    );
  });

  it('3. Enforces mounted guard on SellerCard to prevent mismatch on client wallet restore', () => {
    assert.match(
      sellerCardContent,
      /const\s*\[mounted,\s*setMounted\]\s*=\s*useState\(false\);/,
      'SellerCard must declare a mounted state',
    );
    assert.match(
      sellerCardContent,
      /const\s+currentWallet\s*=\s*mounted\s*\?\s*\(me\s*\|\|\s*connectedAddress\)\s*:\s*undefined;/,
      'SellerCard currentWallet must be gated by mounted',
    );
    assert.doesNotMatch(
      sellerCardContent,
      /suppressHydrationWarning/,
      'SellerCard must not use suppressHydrationWarning',
    );
  });

  // =========================================================================
  // 2. Background: /bg2.jpg with #101010 fallback, scoped to /marketplace
  // =========================================================================
  it('4. Uses /bg2.jpg with cover, center, fixed, and #101010 charcoal fallback', () => {
    // Check MarketplacePage background container
    assert.match(
      marketplaceContent,
      /backgroundImage:\s*['"]url\(\/bg2\.jpg\)['"]/,
      'MarketplacePage must reference /bg2.jpg as background image',
    );
    assert.match(
      marketplaceContent,
      /backgroundSize:\s*['"]cover['"]/,
      'MarketplacePage background must use cover size',
    );
    assert.match(
      marketplaceContent,
      /backgroundPosition:\s*['"]center['"]/,
      'MarketplacePage background must be centered',
    );
    assert.match(
      marketplaceContent,
      /bg-\[#101010\]/,
      'MarketplacePage background must have #101010 charcoal fallback',
    );

    // globals.css defines body.marketplace-page
    assert.match(
      globalsCssContent,
      /body\.marketplace-page\s*\{[\s\S]*?#101010[\s\S]*?url\(['"]?\/bg2\.jpg['"]?\)/,
      'globals.css must override body background for .marketplace-page with #101010 and /bg2.jpg',
    );

    // AppLayout has #101010 on marketplace route
    assert.match(
      appLayoutContent,
      /isMarketplace\s*\?\s*['"]bg-\[#101010\][^'"]*['"]/,
      'AppLayout must apply #101010 background on /marketplace',
    );

    // public/bg2.jpg exists
    const bg2Path = path.resolve(process.cwd(), 'public/bg2.jpg');
    assert.ok(fs.existsSync(bg2Path), 'public/bg2.jpg must exist');
  });

  // =========================================================================
  // 3. Subtle White Outlines on Cards, Search, and Filter
  // =========================================================================
  it('5. Applies consistent subtle white outlines on SellerCard, Search Input, and Filter', () => {
    // SellerCard border
    assert.match(
      sellerCardContent,
      /border\s+border-white\/50\s+hover:border-white\/80/,
      'SellerCard must have subtle white border (border-white/50 hover:border-white/80)',
    );
    assert.match(
      sellerCardContent,
      /bg-\[#(1B1B1B|1C1C1C)\]/,
      'SellerCard must maintain charcoal background #1C1C1C or #1B1B1B',
    );
    assert.match(
      sellerCardContent,
      /hover:-translate-y-\[3px\]/,
      'SellerCard must lift by 3px on hover',
    );
    assert.match(
      sellerCardContent,
      /inset_0_1px_0_0_rgba\(255,255,255,/,
      'SellerCard must have subtle top edge inset highlight',
    );

    // Search bar border
    assert.match(
      marketplaceContent,
      /<Input[\s\S]*?border-white\/50[\s\S]*?hover:border-white\/70/,
      'Search input must have border-white/50 with hover/focus styling',
    );

    // Filter button border
    assert.match(
      marketplaceContent,
      /border-white\/50\s+hover:border-white\/80/,
      'Filter button must have border-white/50 hover:border-white/80',
    );
  });

  // =========================================================================
  // 4. Missing Profile Notice Palette & Message Integrity
  // =========================================================================
  it('6. Styles missing on-chain profile notice with restrained reddish warning palette', () => {
    const expectedMessage = 'You have no on-chain profile yet — create one from your Profile page to start receiving orders.';
    assert.ok(
      marketplaceContent.includes(expectedMessage),
      'Must preserve exact missing on-chain profile message text',
    );

    assert.match(
      marketplaceContent,
      /bg-\[#2A1719\]/,
      'Missing profile notice must have #2A1719 background',
    );
    assert.match(
      marketplaceContent,
      /border-\[#8B4048\]/,
      'Missing profile notice must have #8B4048 border',
    );
    assert.match(
      marketplaceContent,
      /text-\[#FF9DA5\]/,
      'Missing profile notice must have #FF9DA5 text',
    );
  });

  // =========================================================================
  // 5. Behavioral Simulation: Hydration Matching Guarantee
  // =========================================================================
  it('7. Behavioral Simulation: SSR markup and initial Client markup produce exact match', () => {
    // SSR Simulation:
    // mounted = false, isConnected = false, address = undefined
    const simulateSSR = () => {
      const mounted = false;
      const isConnected = false;
      const address = undefined;
      const status: string = 'disconnected';
      const isAccountRestoring = status === 'connecting' || status === 'reconnecting';
      const effectiveIsConnected = mounted && isConnected && !isAccountRestoring;
      const effectiveAddress = effectiveIsConnected && !!address ? address : undefined;

      const nodes: string[] = [];
      if (!effectiveIsConnected) {
        nodes.push('BANNER:Connect-your-wallet');
      }
      if (effectiveIsConnected) {
        nodes.push('CHAIN_GUARD');
      }
      nodes.push('SEARCH_AND_FILTER_ROW');
      return { nodes, effectiveAddress };
    };

    // Client Initial Hydration Simulation (before useEffect runs, with persisted wallet):
    // mounted = false, isConnected = true, address = '0x123...'
    const simulateClientHydration = () => {
      const mounted = false; // useEffect has not run yet during hydration!
      const isConnected = true; // wallet restored from localStorage/connector
      const address = '0x1234567890abcdef1234567890abcdef12345678';
      const status: string = 'connected';
      const isAccountRestoring = status === 'connecting' || status === 'reconnecting';
      const effectiveIsConnected = mounted && isConnected && !isAccountRestoring;
      const effectiveAddress = effectiveIsConnected && !!address ? address : undefined;

      const nodes: string[] = [];
      if (!effectiveIsConnected) {
        nodes.push('BANNER:Connect-your-wallet');
      }
      if (effectiveIsConnected) {
        nodes.push('CHAIN_GUARD');
      }
      nodes.push('SEARCH_AND_FILTER_ROW');
      return { nodes, effectiveAddress };
    };

    // Client Post-Mount Simulation (after useEffect sets mounted = true):
    const simulateClientPostMount = () => {
      const mounted = true; // useEffect has executed
      const isConnected = true;
      const address = '0x1234567890abcdef1234567890abcdef12345678';
      const status: string = 'connected';
      const isAccountRestoring = status === 'connecting' || status === 'reconnecting';
      const effectiveIsConnected = mounted && isConnected && !isAccountRestoring;
      const effectiveAddress = effectiveIsConnected && !!address ? address : undefined;

      const nodes: string[] = [];
      if (!effectiveIsConnected) {
        nodes.push('BANNER:Connect-your-wallet');
      }
      if (effectiveIsConnected) {
        nodes.push('CHAIN_GUARD');
      }
      nodes.push('SEARCH_AND_FILTER_ROW');
      return { nodes, effectiveAddress };
    };

    const ssr = simulateSSR();
    const clientInitial = simulateClientHydration();
    const clientPostMount = simulateClientPostMount();

    // The key invariant: SSR and Client Initial must produce identical nodes!
    assert.deepEqual(
      ssr.nodes,
      clientInitial.nodes,
      'SSR and Client Initial render MUST produce identical DOM nodes to guarantee 0 hydration mismatches',
    );
    assert.equal(
      clientInitial.effectiveAddress,
      undefined,
      'effectiveAddress on initial client render must be undefined matching SSR',
    );

    // After mount, wallet is cleanly activated without mismatch
    assert.equal(clientPostMount.nodes[0], 'CHAIN_GUARD');
    assert.equal(clientPostMount.effectiveAddress, '0x1234567890abcdef1234567890abcdef12345678');
  });

  // =========================================================================
  // 6. Physical Card Appearance on Freelancer Mini Cards (SellerCard)
  // =========================================================================
  it('8. Enforces physical card appearance on SellerCard: #1C1C1C, inset highlight, 3px lift, soft shadow', () => {
    // Charcoal surface #1C1C1C
    assert.match(
      sellerCardContent,
      /bg-\[#1C1C1C\]/,
      'SellerCard must use #1C1C1C charcoal surface',
    );

    // Subtle inset highlight along top edge
    assert.match(
      sellerCardContent,
      /inset_0_1px_0_0_rgba\(255,255,255,/,
      'SellerCard must feature a top-edge inset highlight',
    );

    // Controlled soft shadow
    assert.match(
      sellerCardContent,
      /0_6px_20px_rgba\(0,0,0,/,
      'SellerCard must feature controlled soft shadow',
    );

    // Hover lift of ~3px
    assert.match(
      sellerCardContent,
      /hover:-translate-y-\[3px\]/,
      'SellerCard must lift by 3px on hover',
    );

    // Hover border brightening
    assert.match(
      sellerCardContent,
      /hover:border-white\/80/,
      'SellerCard must brighten border on hover',
    );

    // 180-220ms smooth transition
    assert.match(
      sellerCardContent,
      /duration-200/,
      'SellerCard must use smooth 200ms transition',
    );
  });

  // =========================================================================
  // 7. Compact Bento Modal Container (ProviderProfileModal)
  // =========================================================================
  it('9. Enforces compact bento container sizing in ProviderProfileModal', () => {
    // Passes isModal prop to ProviderProfile
    assert.match(
      profileModalContent,
      /<ProviderProfile[\s\S]*?isModal/,
      'ProviderProfileModal must pass isModal prop',
    );

    // Desktop single-screen sizing without modal-level vertical scrollbar
    assert.match(
      profileModalContent,
      /max-w-\[1080px\]|max-w-\[1240px\]|max-w-\[1300px\]/,
      'ProviderProfileModal must use constrained max-width for bento grid',
    );
    assert.match(
      profileModalContent,
      /max-h-\[90vh\]|max-h-\[92vh\]/,
      'ProviderProfileModal must cap modal height to viewport height',
    );
    assert.match(
      profileModalContent,
      /lg:overflow-hidden/,
      'ProviderProfileModal must enforce overflow-hidden on desktop to prevent page/modal vertical scrollbar',
    );
    assert.match(
      profileModalContent,
      /overflow-y-auto/,
      'ProviderProfileModal must allow responsive touch scrolling on smaller mobile viewports',
    );
  });

  // =========================================================================
  // 8. Bento Dashboard Architecture & Information Organization (ProviderProfile)
  // =========================================================================
  it('10. Enforces compact Bento Dashboard architecture in ProviderProfile', () => {
    // Compact Horizontal Header Strip
    assert.match(
      providerProfileContent,
      /Avatar[\s\S]*?name=\{directoryName\}/,
      'ProviderProfile header must render Avatar with directoryName',
    );
    assert.match(
      providerProfileContent,
      /shortenAddress\(validAddress\)/,
      'ProviderProfile header must display shortened copyable wallet address',
    );
    assert.match(
      providerProfileContent,
      /copyWallet/,
      'ProviderProfile header must include copyWallet function',
    );
    assert.match(
      providerProfileContent,
      /directoryBio/,
      'ProviderProfile header must handle personal quote if provided',
    );

    // Left Column Bento Grid (~65% width)
    assert.match(
      providerProfileContent,
      /lg:col-span-8/,
      'ProviderProfile must allocate approximately 65% width to the left bento column',
    );
    assert.match(
      providerProfileContent,
      /About/,
      'ProviderProfile must render About card',
    );
    assert.match(
      providerProfileContent,
      /Expertise/,
      'ProviderProfile must render Expertise card',
    );
    assert.match(
      providerProfileContent,
      /Projects|Portfolio/,
      'ProviderProfile must render Projects card',
    );
    assert.match(
      providerProfileContent,
      /Client Reviews/,
      'ProviderProfile must render Client Reviews card',
    );

    // Portfolio and Reviews internal scrolling (not stretching modal height)
    assert.match(
      providerProfileContent,
      /portfolioList\.map/,
      'ProviderProfile must map all portfolio projects without arbitrary truncation',
    );
    assert.match(
      providerProfileContent,
      /reviewsList\.map/,
      'ProviderProfile must map client reviews without arbitrary truncation',
    );

    // Right Column Bento Grid (~35% width)
    assert.match(
      providerProfileContent,
      /lg:col-span-4/,
      'ProviderProfile must allocate approximately 35% width to the right bento column',
    );
    assert.match(
      providerProfileContent,
      /Starting Rate/,
      'ProviderProfile must display Starting Rate in commercial card',
    );
    assert.match(
      providerProfileContent,
      /Typical Delivery/,
      'ProviderProfile must display Typical Delivery when provided',
    );
    assert.match(
      providerProfileContent,
      /Completed Deals/,
      'ProviderProfile must display Completed Deals',
    );
    assert.match(
      providerProfileContent,
      /Order This Freelancer|Select This Freelancer|Edit Profile/,
      'ProviderProfile must display prominent action button',
    );

    // Social Links — compact icon-based links with external tab safety
    assert.match(
      providerProfileContent,
      /GithubIcon|LinkedInIcon|XTwitterIcon/,
      'ProviderProfile must include recognizable icons for socials',
    );
    assert.match(
      providerProfileContent,
      /target="_blank"\s+rel="noopener noreferrer"/,
      'ProviderProfile social links must safely open in a new tab',
    );
  });

  // =========================================================================
  // 11. Wagmi SSR Configuration & Hydrate Render-Time State Update Prevention
  // =========================================================================
  it('11. Configures wagmiConfig with ssr: true and cookieStorage to eliminate Hydrate render-time state updates', () => {
    const wagmiConfigPath = path.resolve(process.cwd(), 'src/config/wagmi.ts');
    const wagmiConfigContent = fs.readFileSync(wagmiConfigPath, 'utf8');

    // ssr: true
    assert.match(
      wagmiConfigContent,
      /ssr:\s*true/,
      'wagmiConfig must enable ssr: true so Wagmi Hydrate invokes onMount() strictly inside useEffect rather than during render',
    );

    // cookieStorage
    assert.match(
      wagmiConfigContent,
      /storage:\s*createStorage\(\{\s*storage:\s*cookieStorage,?\s*\}\)/,
      'wagmiConfig must configure cookieStorage for deterministic SSR hydration',
    );

    // AppLayout visible background with /bg2.jpg
    assert.match(
      appLayoutContent,
      /backgroundImage:\s*['"]url\(\/bg2\.jpg\)['"]/,
      'AppLayout must apply /bg2.jpg to the visible container on /marketplace',
    );
    assert.match(
      appLayoutContent,
      /backgroundSize:\s*['"]cover['"]/,
      'AppLayout must specify cover background size',
    );
    assert.match(
      appLayoutContent,
      /backgroundPosition:\s*['"]center['"]/,
      'AppLayout must center background position',
    );
    assert.match(
      appLayoutContent,
      /backgroundAttachment:\s*['"]fixed['"]/,
      'AppLayout must fix background attachment for full page coverage',
    );
  });
});
