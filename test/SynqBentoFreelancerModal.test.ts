// test/SynqBentoFreelancerModal.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('SYNQ — Freelancer Profile Details Bento Modal Suite (Sketch Alignment)', () => {
  const providerProfilePath = path.resolve(process.cwd(), 'src/components/marketplace/ProviderProfile.tsx');
  const providerProfileContent = fs.readFileSync(providerProfilePath, 'utf8');

  const modalPath = path.resolve(process.cwd(), 'src/components/marketplace/ProviderProfileModal.tsx');
  const modalContent = fs.readFileSync(modalPath, 'utf8');

  // =========================================================================
  // 1. Bento Grid Architecture & Sketch Proportions
  // =========================================================================
  describe('1. Bento Grid Layout & Proportions', () => {
    it('declares 12-column grid with strict 3-row equal-height definitions on desktop', () => {
      assert.match(
        providerProfileContent,
        /grid-cols-1\s+lg:grid-cols-12/,
        'Bento layout must use 12-column grid on desktop',
      );
      assert.match(
        providerProfileContent,
        /lg:grid-rows-3/,
        'Bento layout must enforce 3 strict equal-height desktop rows (repeat(3, minmax(0, 1fr)))',
      );
    });

    it('enforces desktop modal bounds without outer modal scrolling in normal conditions', () => {
      assert.match(
        modalContent,
        /max-w-\[1080px\]/,
        'Modal container must constrain desktop width around 1080px',
      );
      assert.match(
        modalContent,
        /lg:h-\[720px\]/,
        'Modal container must constrain compact desktop height around 680-760px',
      );
      assert.match(
        modalContent,
        /max-h-\[90vh\]|max-h-\[92vh\]/,
        'Modal container must cap height to viewport height',
      );
      assert.match(
        modalContent,
        /lg:overflow-hidden/,
        'Modal container must prevent outer scrolling on desktop to keep all 6 bento sections in view',
      );
      assert.match(
        modalContent,
        /overflow-y-auto/,
        'Modal container must allow vertical scrolling on smaller laptop/mobile viewports',
      );
    });

    it('implements all 6 distinct bento cards matching the sketch layout', () => {
      assert.match(providerProfileContent, /data-testid="bento-card-identity"/, 'Must contain Card 1: Identity');
      assert.match(providerProfileContent, /data-testid="bento-card-deal"/, 'Must contain Card 2: Deal Info');
      assert.match(providerProfileContent, /data-testid="bento-card-about"/, 'Must contain Card 3: About');
      assert.match(providerProfileContent, /data-testid="bento-card-expertise"/, 'Must contain Card 4: Expertise');
      assert.match(providerProfileContent, /data-testid="bento-card-reviews"/, 'Must contain Card 5: Client Reviews');
      assert.match(providerProfileContent, /data-testid="bento-card-projects"/, 'Must contain Card 6: Projects');
    });

    it('allocates correct grid row and column spans to match sketch proportions', () => {
      // Card 1: Upper Left (cols 1-8, row 1)
      assert.match(
        providerProfileContent,
        /lg:col-span-8\s+lg:row-start-1\s+lg:row-end-2/,
        'Card 1 (Identity) must span 8 columns in Row 1',
      );
      // Card 2: Upper Right (cols 9-12, rows 1-3)
      assert.match(
        providerProfileContent,
        /lg:col-span-4\s+lg:row-start-1\s+lg:row-end-3/,
        'Card 2 (Deal Terms) must span 4 columns vertically across Rows 1 & 2',
      );
      // Card 3: Middle Left (cols 1-4, row 2)
      assert.match(
        providerProfileContent,
        /lg:col-span-4\s+lg:row-start-2\s+lg:row-end-3/,
        'Card 3 (About) must occupy cols 1-4 in Row 2',
      );
      // Card 5: Middle Center (cols 5-8, row 2)
      assert.match(
        providerProfileContent,
        /lg:col-span-4\s+lg:row-start-2\s+lg:row-end-3/,
        'Card 5 (Reviews) must occupy cols 5-8 in Row 2',
      );
      // Card 4: Lower Left (cols 1-4, row 3)
      assert.match(
        providerProfileContent,
        /lg:col-span-4\s+lg:row-start-3\s+lg:row-end-4/,
        'Card 4 (Expertise) must occupy cols 1-4 in Row 3',
      );
      // Card 6: Lower Center/Right (cols 5-12, row 3)
      assert.match(
        providerProfileContent,
        /lg:col-span-8\s+lg:row-start-3\s+lg:row-end-4/,
        'Card 6 (Projects) must span 8 columns in Row 3 under Reviews and Deal Info',
      );
    });
  });

  // =========================================================================
  // 2. Section 1 — Identity Card Requirements
  // =========================================================================
  describe('2. Identity Card (Upper Left)', () => {
    it('includes Avatar, display name, handle, professional title, availability and compact wallet', () => {
      assert.match(providerProfileContent, /<Avatar[\s\S]*?name=\{directoryName\}/, 'Renders user avatar');
      assert.match(providerProfileContent, /\{directoryName\}/, 'Renders display name');
      assert.match(providerProfileContent, /@\{registryUsername\}/, 'Renders @handle badge');
      assert.match(providerProfileContent, /richMeta\?\.headline\s*\|\|\s*category/, 'Renders professional title');
      assert.match(providerProfileContent, /Available|Busy/, 'Renders availability badge');
      assert.match(providerProfileContent, /shortenAddress\(validAddress\)/, 'Renders shortened wallet address');
      assert.match(providerProfileContent, /copyWallet/, 'Includes wallet copy trigger');
      assert.match(
        providerProfileContent,
        /className="[^"]*(?:lg:w-\[11[2-9]px\]|lg:w-\[120px\])[^"]*rounded-2xl[^"]*"/,
        'Avatar desktop size must be increased to approximately 112-120px with rounded corners',
      );
      assert.match(
        providerProfileContent,
        /pressStart2P\.className[\s\S]*?\{directoryName\}/,
        'Freelancer display name must use Synq Press Start 2P pixel brand typography',
      );
    });

    it('aligns 4 clickable social icons on the right in 2x2 grid with circular white backgrounds', () => {
      assert.match(
        providerProfileContent,
        /data-testid="bento-social-icons"[\s\S]*?grid\s+grid-cols-2/,
        'Social icons must be arranged in a 2x2 grid on the right',
      );
      assert.match(
        providerProfileContent,
        /rounded-full\s+bg-white[\s\S]*?text-\[#171717\]/,
        'Active social icons must have circular white backgrounds and charcoal icons',
      );
      assert.match(providerProfileContent, /Globe/, 'Includes Website icon');
      assert.match(providerProfileContent, /GithubIcon/, 'Includes GitHub icon');
      assert.match(providerProfileContent, /XTwitterIcon/, 'Includes X/Twitter icon');
      assert.match(providerProfileContent, /LinkedInIcon/, 'Includes LinkedIn icon');
    });

    it('safely opens active social links in new tab and disables unlinked socials without broken links', () => {
      assert.match(
        providerProfileContent,
        /target="_blank"\s+rel="noopener noreferrer"/,
        'Active social links must open safely in new tab',
      );
      assert.match(
        providerProfileContent,
        /cursor-not-allowed[\s\S]*?opacity-40/,
        'Unavailable social icons must display disabled without creating clickable dead links',
      );
    });

    it('completely removes separate Connect/Social links card', () => {
      assert.doesNotMatch(
        providerProfileContent,
        /Connect\s*&?\s*Social/i,
        'Old separate Connect/Social card must be completely removed',
      );
    });

    it('omits on-chain quote from UI while preserving underlying data', () => {
      assert.match(
        providerProfileContent,
        /const\s+directoryBio\s*=\s*String\(profile\?\.bio\s*\|\|\s*''\)\.trim\(\);/,
        'Preserves directoryBio in component scope for underlying contract data integrity',
      );
      // Ensure directoryBio is NOT rendered in JSX
      assert.doesNotMatch(
        providerProfileContent,
        /\{directoryBio\}/,
        'On-chain quote {directoryBio} must NOT be rendered in modal UI',
      );
      assert.doesNotMatch(
        providerProfileContent,
        /Personal Quote/i,
        'Personal Quote label must NOT be rendered in modal UI',
      );
    });
  });

  // =========================================================================
  // 3. Section 2 — Deal Information Requirements
  // =========================================================================
  describe('3. Deal Information Card (Upper Right)', () => {
    it('displays Starting Rate with USDC currency and rate type', () => {
      assert.match(providerProfileContent, /Starting Rate/, 'Displays Starting Rate heading');
      assert.match(providerProfileContent, /USDC/, 'Displays USDC currency');
      assert.match(providerProfileContent, /formattedPricing\.amountDisplay/, 'Displays formatted starting rate amount');
    });

    it('displays Typical Delivery, Completed Deals, and Availability', () => {
      assert.match(providerProfileContent, /Typical Delivery/, 'Displays Typical Delivery');
      assert.match(providerProfileContent, /Completed Deals/, 'Displays Completed Deals');
      assert.match(providerProfileContent, /authCompletedDeals/, 'Binds to authenticated completed deals count');
      assert.match(providerProfileContent, /available\s*\?\s*'Available'\s*:\s*'Busy'/, 'Displays availability status');
    });

    it('positions prominent order button near bottom inside card padding with no overflow', () => {
      assert.match(providerProfileContent, /Order This Freelancer/, 'Includes Order This Freelancer button');
      assert.match(providerProfileContent, /Edit Profile/, 'Includes Edit Profile button for self');
      assert.match(providerProfileContent, /Select This Freelancer|selectButtonLabel/, 'Supports custom select button label');
      assert.match(providerProfileContent, /mt-auto\s+shrink-0\s+border-t/, 'Action button stays cleanly at the bottom inside card padding');
    });

    it('removes visible close X icon from Deal Terms header while preserving backdrop/escape dismissal', () => {
      assert.doesNotMatch(
        providerProfileContent,
        /aria-label="Close"|<X\s+/i,
        'Deal terms card must not contain a visible close X icon',
      );
      assert.match(modalContent, /onClick=\{onClose\}/, 'Preserves backdrop dismissal');
      assert.match(modalContent, /e\.key === 'Escape'/, 'Preserves Escape key dismissal');
    });
  });

  // =========================================================================
  // 4. Section 3 — About Card Requirements
  // =========================================================================
  describe('4. About Card (Middle Left)', () => {
    it('shows off-chain biography without substituting the on-chain quote', () => {
      assert.match(
        providerProfileContent,
        /const\s+aboutContent\s*=\s*richMeta\?\.about/,
        'Strictly sources biography from off-chain richMeta.about',
      );
      assert.match(
        providerProfileContent,
        /No biography provided yet/,
        'Shows gentle placeholder if biography is empty without falling back to quote',
      );
      assert.match(
        providerProfileContent,
        /whitespace-pre-line\s+break-words/,
        'Applies proper typography wrapping for bio text',
      );
    });
  });

  // =========================================================================
  // 5. Section 4 — Expertise Card Requirements
  // =========================================================================
  describe('5. Expertise Card (Lower Left)', () => {
    it('displays primary category, focus specializations, and skill badges', () => {
      assert.match(providerProfileContent, /Primary:/, 'Displays Primary category header');
      assert.match(providerProfileContent, /\{category\}/, 'Renders primary category');
      assert.match(providerProfileContent, /Focus:/, 'Displays Focus header for specializations');
      assert.match(providerProfileContent, /secondaryCategories/, 'Maps specializations from richMeta');
      assert.match(providerProfileContent, /skills\.map/, 'Renders skill badges');
    });
  });

  // =========================================================================
  // 6. Section 5 — Reviews Card Requirements
  // =========================================================================
  describe('6. Reviews Card (Middle Center)', () => {
    it('displays average star rating and review count once at top', () => {
      assert.match(providerProfileContent, /reviewsData\.summary\.average/, 'Displays average rating');
      assert.match(providerProfileContent, /reviewsData\.summary\.count/, 'Displays total review count');
      assert.match(
        providerProfileContent,
        /<StarRating\s+value=\{reviewsData\.summary\.average\}\s+count=\{reviewsData\.summary\.count\}\s+readOnly/,
        'Renders average rating and count exactly once in StarRating without duplicate heading text',
      );
    });

    it('displays compact review rows with reviewer handle/abbreviated wallet and star rating', () => {
      assert.match(
        providerProfileContent,
        /displayName\s*=\s*identity\?\.displayHandle\s*\|\|\s*r\.reviewerName\s*\|\|\s*shortenAddress/,
        'Uses display handle with wallet fallback for reviewer',
      );
      assert.match(providerProfileContent, /<StarRating\s+value=\{r\.rating\}/, 'Renders star rating per review');
    });

    it('implements unclipped fixed-positioned popover on hover and keyboard focus', () => {
      assert.match(providerProfileContent, /onMouseEnter=\{\(e\)\s*=>\s*showReviewPopover/, 'Supports mouse hover');
      assert.match(providerProfileContent, /onFocus=\{\(e\)\s*=>\s*showReviewPopover/, 'Supports keyboard focus');
      assert.match(providerProfileContent, /onClick=\{\(e\)\s*=>\s*toggleReviewPopover/, 'Supports touch click/tap');
      assert.match(
        providerProfileContent,
        /position:\s*'fixed'/,
        'Popover uses fixed positioning to escape overflow boundaries and avoid clipping',
      );
      assert.match(providerProfileContent, /formatTimeAgo/, 'Displays review timestamp');
      assert.match(providerProfileContent, /activeReviewPopover\.review\.comment/, 'Displays full review comment in popover');
    });

    it('allows internal scrolling within reviews card only', () => {
      assert.match(
        providerProfileContent,
        /overflow-y-auto[\s\S]*?reviewsList\.map/,
        'Client reviews list scrolls internally without stretching modal',
      );
    });
  });

  // =========================================================================
  // 7. Section 6 — Projects Card Requirements
  // =========================================================================
  describe('7. Projects Card (Lower Center/Right)', () => {
    it('displays projects up to 6 limit with thumbnails and titles', () => {
      assert.match(providerProfileContent, /portfolioList\.length\}\s*\/\s*6/, 'Displays project counter out of 6');
      assert.match(providerProfileContent, /ProjectThumbnail/, 'Renders ProjectThumbnail component');
      assert.match(providerProfileContent, /project\.title/, 'Renders project title');
    });

    it('reveals description, tags, and clickable visit link on hover or keyboard focus', () => {
      assert.match(
        providerProfileContent,
        /group-hover:opacity-100\s+group-focus:opacity-100\s+group-focus-within:opacity-100/,
        'Details overlay appears on hover or focus',
      );
      assert.match(providerProfileContent, /project\.description/, 'Displays project description in overlay');
      assert.match(providerProfileContent, /project\.tags/, 'Displays project tags in overlay');
      assert.match(
        providerProfileContent,
        /href=\{project\.link\}[\s\S]*?target="_blank"\s+rel="noopener noreferrer"/,
        'Project link opens safely in new tab',
      );
    });

    it('uses horizontal scroll track without stretching modal vertically', () => {
      assert.match(
        providerProfileContent,
        /overflow-x-auto\s+overflow-y-hidden/,
        'Projects card scrolls horizontally when needed',
      );
    });
  });

  // =========================================================================
  // 8. Visual Aesthetics & Styling Requirements
  // =========================================================================
  describe('8. Visual Palette & Brand Consistency', () => {
    it('uses charcoal black (#101010) modal container and charcoal (#1B1B1B) bento cards with thin white outlines (border-white/75)', () => {
      assert.match(modalContent, /bg-\[#(101010|141414)\]/, 'Uses solid charcoal black #101010 or #141414 for modal container');
      assert.match(providerProfileContent, /bg-\[#1B1B1B\]/, 'Uses solid charcoal-black #1B1B1B for bento cards');
      assert.match(providerProfileContent, /border-white\/75/, 'Uses thin white outline border-white/75 for bento cards');
    });

    it('styles action buttons with white background (#FFFFFF) and charcoal-black text (#171717)', () => {
      assert.match(
        providerProfileContent,
        /bg-white[\s\S]*?text-\[#171717\]/,
        'Action buttons inside charcoal cards use white background with charcoal-black text',
      );
    });

    it('uses slightly lighter charcoal (#252525) for nested cards, panels, and badges', () => {
      assert.match(
        providerProfileContent,
        /bg-\[#252525\]/,
        'Nested elements (tags, rate box, review rows, wallet badge) use #252525 lighter charcoal',
      );
    });

    it('applies Synq Press Start 2P pixel font selectively to section headings without affecting body text', () => {
      assert.match(
        providerProfileContent,
        /pressStart2P\.className[\s\S]*?Deal Terms/,
        'Deal Terms heading uses Press Start 2P font',
      );
      assert.match(
        providerProfileContent,
        /pressStart2P\.className[\s\S]*?About/,
        'About heading uses Press Start 2P font',
      );
      assert.match(
        providerProfileContent,
        /pressStart2P\.className[\s\S]*?Reviews/,
        'Reviews heading uses Press Start 2P font',
      );
      assert.match(
        providerProfileContent,
        /pressStart2P\.className[\s\S]*?Expertise/,
        'Expertise heading uses Press Start 2P font',
      );
      assert.match(
        providerProfileContent,
        /pressStart2P\.className[\s\S]*?Projects/,
        'Projects heading uses Press Start 2P font',
      );
    });

    it('avoids bright blue accents on buttons and surfaces in favor of clean monochrome styling', () => {
      assert.doesNotMatch(
        providerProfileContent,
        /bg-blue-600|bg-blue-500/,
        'Must avoid blue buttons or backgrounds in bento dashboard',
      );
    });
  });
});
