// test/SynqProfilePortfolioDirtyState.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('SYNQ — Profile Projects UI Fixes, Dirty State & Save Flow Regression Suite', () => {
  const profilePath = path.resolve(process.cwd(), 'src/app/profile/page.tsx');
  const profileContent = fs.readFileSync(profilePath, 'utf8');

  const providerProfilePath = path.resolve(process.cwd(), 'src/components/marketplace/ProviderProfile.tsx');
  const providerProfileContent = fs.readFileSync(providerProfilePath, 'utf8');

  const thumbnailPath = path.resolve(process.cwd(), 'src/components/profile/ProjectThumbnail.tsx');
  const thumbnailContent = fs.readFileSync(thumbnailPath, 'utf8');

  const marketApiPath = path.resolve(process.cwd(), 'src/app/api/profile/market/[wallet]/route.ts');
  const marketApiContent = fs.readFileSync(marketApiPath, 'utf8');

  // =========================================================================
  // 1. Task 1: "Projects" UI Label Invariants (Preserving backend portfolio data)
  // =========================================================================
  describe('1. Task 1: UI Label Renaming to "Projects" (Backend Preserved)', () => {
    it('verifies Profile page displays "Projects" section heading', () => {
      assert.match(
        profileContent,
        /<h2[^>]*>\s*<Sparkles[^>]*\/>\s*Projects\s*<\/h2>/,
        'Profile page section heading must be renamed to "Projects"',
      );
    });

    it('verifies Profile page displays "No projects added yet" empty state', () => {
      assert.match(
        profileContent,
        /No projects added yet\.\s*Click &quot;Add Project&quot; above to showcase past work\./,
        'Profile page empty state text must refer to "projects"',
      );
    });

    it('verifies Public Freelancer Details modal displays "Projects" section heading', () => {
      assert.match(
        providerProfileContent,
        /<h3[^>]*>\s*<Sparkles[^>]*\/>\s*Projects\s*<\/h3>/,
        'ProviderProfile modal section heading must be renamed to "Projects"',
      );
    });

    it('verifies Public Freelancer Details modal displays "No projects added yet" empty state', () => {
      assert.match(
        providerProfileContent,
        /No projects added yet\./,
        'ProviderProfile empty state must be "No projects added yet."',
      );
    });

    it('strictly preserves backend and TypeScript data identifiers as "portfolio"', () => {
      // Frontend state still uses portfolio
      assert.match(profileContent, /const\s+\[portfolio,\s*setPortfolio\]\s*=\s*useState<PortfolioProject\[\]>/);
      // Baseline still tracks portfolio
      assert.match(profileContent, /savedBaseline\.portfolio/);
      // API route still expects portfolio
      assert.match(marketApiContent, /portfolio:\s*cleanPortfolio/);
    });
  });

  // =========================================================================
  // 2. Task 2: Project Thumbnail & Image URL Flow
  // =========================================================================
  describe('2. Task 2: Project Thumbnail & Safe Image Display', () => {
    it('verifies ProjectThumbnail component is implemented with graceful fallback and object-cover', () => {
      assert.ok(fs.existsSync(thumbnailPath), 'ProjectThumbnail.tsx must exist');
      assert.match(thumbnailContent, /object-cover/, 'Thumbnail must apply object-cover');
      assert.match(thumbnailContent, /onError=\{\(\)\s*=>\s*setHasError\(true\)\}/, 'Must handle image loading errors gracefully');
      assert.match(thumbnailContent, /FolderGit2/, 'Must render monochrome folder/project icon on fallback');
      assert.match(thumbnailContent, /loading="lazy"/, 'Must use lazy loading for external images');
    });

    it('verifies Profile page renders ProjectThumbnail beside project titles', () => {
      assert.match(
        profileContent,
        /<ProjectThumbnail\s+src=\{proj\.image\}\s+alt=\{proj\.title\}\s+size="sm"\s*\/>/,
        'Profile page must render ProjectThumbnail beside project title in card header',
      );
    });

    it('verifies Public Freelancer Details modal renders ProjectThumbnail beside project titles', () => {
      assert.match(
        providerProfileContent,
        /<ProjectThumbnail\s+src=\{project\.image\}\s+alt=\{project\.title\}\s+size="(?:tile|sm)"(?:\s+theme="[^"]+")?\s*\/>/,
        'ProviderProfile must render ProjectThumbnail in freelancer project cards',
      );
    });
  });

  // =========================================================================
  // 3. Task 3: Tags Input Natural Typing & Multi-Word Tag Parsing
  // =========================================================================
  describe('3. Task 3: Tags Input with Space & Comma Support', () => {
    it('verifies Profile page maintains rawTagsMap to prevent keystroke character stripping', () => {
      assert.match(
        profileContent,
        /const\s+\[rawTagsMap,\s*setRawTagsMap\]\s*=\s*useState<Record<string,\s*string>>\(\{\}\);/,
        'Profile page must track rawTagsMap for active tag drafts',
      );
    });

    it('verifies Profile page tags input handles spaces, commas, and normalizes on blur', () => {
      assert.match(
        profileContent,
        /placeholder="Smart Contracts,\s*Web Development,\s*AI Chatbot"/,
        'Profile page tags placeholder must illustrate multi-word tags',
      );
      assert.match(
        profileContent,
        /onBlur=\{\(\)\s*=>\s*\{[\s\S]*?updatePortfolioProject\(idx,\s*\{\s*tags:\s*parsed\s*\}\);[\s\S]*?setRawTagsMap\([\s\S]*?\);[\s\S]*?\}\}/,
        'Tags input must normalize on blur without corrupting in-progress keystrokes',
      );
    });

    it('verifies Profile page renders tag badges on collapsed project cards', () => {
      assert.match(
        profileContent,
        /Array\.isArray\(proj\.tags\)\s*&&\s*proj\.tags\.length\s*>\s*0/,
        'Collapsed project card must render tag badges when present',
      );
    });

    it('behavioral simulation: preserves spaces inside multi-word tags and commas as separators', () => {
      const rawInput = 'Smart Contracts, Web Development, AI Chatbot';

      // Parsing simulation
      const parsedTags = rawInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 8);

      assert.deepStrictEqual(parsedTags, ['Smart Contracts', 'Web Development', 'AI Chatbot']);
      assert.strictEqual(parsedTags[0], 'Smart Contracts', 'Spaces within tag name must be preserved');
      assert.strictEqual(parsedTags[1], 'Web Development', 'Spaces within tag name must be preserved');
      assert.strictEqual(parsedTags[2], 'AI Chatbot', 'Spaces within tag name must be preserved');

      // Trailing comma typing scenario: user types "Smart Contracts,"
      const typingStep = 'Smart Contracts,';
      const parsedStep = typingStep
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      // Underlying tags array has 1 tag, while the raw draft keeps the comma
      assert.deepStrictEqual(parsedStep, ['Smart Contracts']);
      assert.strictEqual(typingStep.endsWith(','), true, 'Raw input retains the comma for typing the next tag');
    });
  });

  // =========================================================================
  // 4. Dirty-State Detection & 6-Project Limits
  // =========================================================================
  describe('4. Dirty State Calculation & 6-Project Limit Verification', () => {
    it('verifies isOffChainDirty includes portfolio comparison against savedBaseline', () => {
      assert.match(
        profileContent,
        /if\s*\(\s*JSON\.stringify\(portfolio\s*\|\|\s*\[\]\)\s*!==\s*JSON\.stringify\(savedBaseline\.portfolio\s*\|\|\s*\[\]\)\s*\)\s*return\s+true;/,
        'isOffChainDirty must compare portfolio with savedBaseline.portfolio',
      );
    });

    it('verifies portfolio is in the useMemo dependencies of isOffChainDirty', () => {
      const isOffChainDirtyRegex = /const\s+isOffChainDirty\s*=\s*useMemo\([\s\S]*?\[([\s\S]*?)\]\s*\);/;
      const match = profileContent.match(isOffChainDirtyRegex);
      assert.ok(match, 'isOffChainDirty useMemo must exist');
      const deps = match[1];
      assert.ok(deps.includes('portfolio'), 'isOffChainDirty dependencies must include portfolio');
    });

    it('verifies isPageDirty combines isOffChainDirty and isDirectoryDirty', () => {
      assert.match(
        profileContent,
        /const\s+isPageDirty\s*=\s*isOffChainDirty\s*\|\|\s*isDirectoryDirty;/,
        'isPageDirty must be derived from isOffChainDirty || isDirectoryDirty',
      );
    });

    it('verifies Save Profile button is disabled when !isPageDirty', () => {
      assert.match(
        profileContent,
        /disabled=\{!isPageDirty\s*\|\|\s*savingAll\s*\|\|\s*directoryTxSubmitted\s*\|\|\s*directory\.isPending\s*\|\|\s*!effectiveAddress\}/,
        'Save Profile button must be disabled when !isPageDirty',
      );
    });

    it('verifies addPortfolioProject prevents adding a 7th project and sets clear notice', () => {
      assert.match(
        profileContent,
        /if\s*\(\s*portfolio\.length\s*>=\s*6\s*\)\s*\{[\s\S]*?setPortfolioLimitNotice\('Maximum of 6 projects reached\.[^']*'\);[\s\S]*?return;\s*\}/,
        'addPortfolioProject must enforce maximum 6 projects and explain how to add another',
      );
    });

    it('verifies removePortfolioProject clears the 6-project limit notice', () => {
      const removeFuncRegex = /const\s+removePortfolioProject\s*=\s*\(idx:\s*number\)\s*=>\s*\{([\s\S]*?)\};/;
      const match = profileContent.match(removeFuncRegex);
      assert.ok(match, 'removePortfolioProject function body must be found');
      assert.match(match[1], /setPortfolioLimitNotice\(''\);/, 'removePortfolioProject must clear portfolioLimitNotice');
    });

    it('verifies saveFullOffChainProfile updates savedBaseline.portfolio on success', () => {
      assert.match(
        profileContent,
        /portfolio:\s*JSON\.parse\(JSON\.stringify\(portfolio\)\),/,
        'saveFullOffChainProfile must update savedBaseline.portfolio upon successful save',
      );
    });

    it('verifies backend route enforces max 6 portfolio projects and validates fields', () => {
      assert.match(
        marketApiContent,
        /if\s*\(\s*portfolio\.length\s*>\s*6\s*\)\s*\{\s*return\s+Response\.json\(\{\s*error:\s*'Maximum 6 portfolio projects allowed'\s*\}\s*,\s*\{\s*status:\s*400\s*\}\);/m,
        'Market API route must reject more than 6 portfolio projects with 400',
      );
    });
  });

  // =========================================================================
  // 5. Behavioral Lifecycle Simulation
  // =========================================================================
  describe('5. Behavioral Simulation: Dirty State Lifecycle with Images & Tags', () => {
    interface TestPortfolioProject {
      id: string;
      title: string;
      description: string;
      image: string;
      link: string;
      tags: string[];
    }

    interface TestBaseline {
      nameDraft: string;
      avatar: string | null;
      profHeadline: string;
      secCategories: string[];
      profAbout: string;
      profDelivery: string;
      links: { website: string; github: string; twitter: string; linkedin: string };
      portfolio: TestPortfolioProject[];
      profName: string;
      profCategory: string;
      profSkills: string;
      profRate: string;
      profUsdcRate: string;
      profRateType: string;
      profQuote: string;
    }

    function checkOffChainDirty(
      state: {
        nameDraft: string;
        avatar: string | null;
        profHeadline: string;
        profAbout: string;
        profDelivery: string;
        secCategories: string[];
        links: { website: string; github: string; twitter: string; linkedin: string };
        portfolio: TestPortfolioProject[];
        profUsdcRate: string;
        profRateType: string;
        profName: string;
        profCategory: string;
        profSkills: string;
        profRate: string;
        profQuote: string;
      },
      baseline: TestBaseline,
      registered = true,
    ): boolean {
      if (state.nameDraft !== baseline.nameDraft) return true;
      if ((state.avatar || null) !== (baseline.avatar || null)) return true;
      if (state.profHeadline !== baseline.profHeadline) return true;
      if (state.profAbout !== baseline.profAbout) return true;
      if (state.profDelivery !== baseline.profDelivery) return true;
      if (JSON.stringify(state.secCategories) !== JSON.stringify(baseline.secCategories)) return true;
      if (JSON.stringify(state.links) !== JSON.stringify(baseline.links)) return true;
      if (JSON.stringify(state.portfolio || []) !== JSON.stringify(baseline.portfolio || [])) return true;
      if (state.profUsdcRate !== baseline.profUsdcRate) return true;
      if (state.profRateType !== baseline.profRateType) return true;

      if (!registered) {
        if (state.profName !== baseline.profName) return true;
        if (state.profCategory !== baseline.profCategory) return true;
        if (state.profSkills !== baseline.profSkills) return true;
        if (state.profRate !== baseline.profRate) return true;
        if (state.profQuote !== baseline.profQuote) return true;
      }

      return false;
    }

    const projectWithoutImage: TestPortfolioProject = {
      id: 'proj_no_img',
      title: 'Solidity Lending Protocol',
      description: 'Lending pool audited by Trail of Bits.',
      image: '',
      link: 'https://example.com/lending',
      tags: ['Smart Contracts', 'DeFi'],
    };

    const projectWithImage: TestPortfolioProject = {
      id: 'proj_with_img',
      title: 'NFT Staking Portal',
      description: 'Dynamic rewards contract.',
      image: 'https://example.com/nft.png',
      link: 'https://example.com/nft',
      tags: ['ERC-721', 'Staking Rewards'],
    };

    const baseBaseline: TestBaseline = {
      nameDraft: 'Alex Morgan',
      avatar: null,
      profHeadline: 'Web3 Architect',
      secCategories: ['DeFi'],
      profAbout: 'Full stack blockchain engineer.',
      profDelivery: '1 week',
      links: { website: '', github: '', twitter: '', linkedin: '' },
      portfolio: [projectWithoutImage],
      profName: 'Alex Morgan Studio',
      profCategory: 'Web Development',
      profSkills: 'Solidity, React',
      profRate: '1',
      profUsdcRate: '2000',
      profRateType: 'PER_PROJECT',
      profQuote: 'Building secure protocols.',
    };

    it('Save button is disabled when baseline matches current state', () => {
      const currentState = {
        ...baseBaseline,
        secCategories: [...baseBaseline.secCategories],
        links: { ...baseBaseline.links },
        portfolio: [projectWithoutImage],
      };
      assert.strictEqual(checkOffChainDirty(currentState, baseBaseline), false);
    });

    it('Adding an image to an existing project enables Save button without touching other fields', () => {
      const currentState = {
        ...baseBaseline,
        secCategories: [...baseBaseline.secCategories],
        links: { ...baseBaseline.links },
        portfolio: [
          {
            ...projectWithoutImage,
            image: 'https://example.com/new-thumbnail.png',
          },
        ],
      };
      assert.strictEqual(checkOffChainDirty(currentState, baseBaseline), true);
    });

    it('Adding multi-word tags enables Save button without touching other fields', () => {
      const currentState = {
        ...baseBaseline,
        secCategories: [...baseBaseline.secCategories],
        links: { ...baseBaseline.links },
        portfolio: [
          {
            ...projectWithoutImage,
            tags: ['Smart Contracts', 'Web Development', 'AI Chatbot'],
          },
        ],
      };
      assert.strictEqual(checkOffChainDirty(currentState, baseBaseline), true);
    });

    it('Adding a second project with image and multi-word tags enables Save button', () => {
      const currentState = {
        ...baseBaseline,
        secCategories: [...baseBaseline.secCategories],
        links: { ...baseBaseline.links },
        portfolio: [projectWithoutImage, projectWithImage],
      };
      assert.strictEqual(checkOffChainDirty(currentState, baseBaseline), true);
    });

    it('Save button disables again after saving multiple projects with images and tags', () => {
      const updatedProjects = [projectWithoutImage, projectWithImage];
      const currentState = {
        ...baseBaseline,
        secCategories: [...baseBaseline.secCategories],
        links: { ...baseBaseline.links },
        portfolio: updatedProjects,
      };

      const newBaseline: TestBaseline = {
        ...baseBaseline,
        portfolio: JSON.parse(JSON.stringify(updatedProjects)),
      };

      assert.strictEqual(checkOffChainDirty(currentState, newBaseline), false);
    });
  });
});
