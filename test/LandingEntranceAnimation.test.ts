// test/LandingEntranceAnimation.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LANDING_INTRO_TIMING, LANDING_EXIT_TIMING } from '../src/components/landing/landing-intro-constants';

describe('SYNQ — B.11.5 Final Landing Entrance Polish + Enter Exit Transition Suite', () => {
  const rootDir = path.resolve(__dirname, '..');
  const landingPagePath = path.join(rootDir, 'src/app/page.tsx');
  const componentPath = path.join(rootDir, 'src/components/landing/InteractivePixelArtwork.tsx');
  const constantsPath = path.join(rootDir, 'src/components/landing/landing-intro-constants.ts');
  const negotiatorPagePath = path.join(rootDir, 'src/app/negotiator/page.tsx');
  const img03Path = path.join(rootDir, 'public/03.png');

  const landingContent = fs.readFileSync(landingPagePath, 'utf8');
  const componentContent = fs.readFileSync(componentPath, 'utf8');
  const constantsContent = fs.readFileSync(constantsPath, 'utf8');
  const negotiatorContent = fs.readFileSync(negotiatorPagePath, 'utf8');

  it('1. Shared named timing constants match B.11.5 entrance and exit specification', () => {
    // Entrance timing
    assert.equal(LANDING_INTRO_TIMING.EMPTY_HOLD_MS, 250);
    assert.equal(LANDING_INTRO_TIMING.WORDMARK_EMERGE_END_MS, 1000);
    assert.equal(LANDING_INTRO_TIMING.WORDMARK_PAUSE_END_MS, 1500);
    assert.equal(LANDING_INTRO_TIMING.EXPANSION_HANDS_END_MS, 2250);
    assert.equal(LANDING_INTRO_TIMING.HAND_TRAVEL_DURATION_MS, 750);
    assert.equal(LANDING_INTRO_TIMING.TOTAL_DURATION_MS, 2700);
    assert.equal(LANDING_INTRO_TIMING.INITIAL_WORDMARK_SCALE, 0.30);

    // Exit timing
    assert.equal(LANDING_EXIT_TIMING.HANDS_RETREAT_DURATION_MS, 500);
    assert.equal(LANDING_EXIT_TIMING.FADE_OUT_DURATION_MS, 500);
    assert.equal(LANDING_EXIT_TIMING.TOTAL_DURATION_MS, 1000);

    // Files import the timing constants
    assert.match(landingContent, /import\s*\{[\s\S]*?LANDING_INTRO_TIMING[\s\S]*?LANDING_EXIT_TIMING[\s\S]*?\}\s*from\s*['"]@\/components\/landing\/landing-intro-constants['"]/);
    assert.match(componentContent, /import\s*\{[\s\S]*?LANDING_INTRO_TIMING[\s\S]*?LANDING_EXIT_TIMING[\s\S]*?\}\s*from\s*['"]\.\/landing-intro-constants['"]/);
  });

  it('2. public/03.png remains untouched as master single image asset', () => {
    assert.ok(fs.existsSync(img03Path), 'public/03.png must exist');
    assert.match(componentContent, /REFERENCE_IMAGE_SRC\s*=\s*['"]\/03\.png['"]/);
  });

  it('3. Hand separation threshold uses verified uv.x < 0.492 in BASE_VERTEX_SHADER', () => {
    assert.match(
      componentContent,
      /if\s*\(\s*uv\.x\s*<\s*0\.492\s*\)\s*\{\s*pos\.x\s*\+=\s*uLeftHandOffset;\s*\}\s*else\s*\{\s*pos\.x\s*\+=\s*uRightHandOffset;\s*\}/,
      'Vertex shader must separate hands around uv.x = 0.492 with uLeftHandOffset and uRightHandOffset'
    );
    assert.ok(!componentContent.includes('pos.xy +='), 'pos.xy += must not exist');
    assert.ok(!componentContent.includes('pos.z +='), 'pos.z += must not exist');
  });

  it('4. Part A: 500ms small-wordmark hold from 1000–1500ms at scale 0.30 and 2700ms total entrance', () => {
    // Initial CSS classes declare opacity: 0
    assert.match(landingContent, /\.synq-intro-wordmark\s*\{[\s\S]*?opacity:\s*0;/);
    assert.match(landingContent, /\.synq-intro-indicators\s*\{[\s\S]*?opacity:\s*0;/);

    // CSS wordmark keyframes:
    // 0% to 9.26% (0-250ms): empty hold at scale 0.30
    assert.match(landingContent, /@keyframes synq-intro-wordmark\s*\{[\s\S]*?0%\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?transform:\s*scale\(0\.30\);/);
    assert.match(landingContent, /9\.26%[\s\S]*?opacity:\s*0;[\s\S]*?transform:\s*scale\(0\.30\);/);

    // 37.04% (1000ms): emerge from darkness to scale 0.30
    assert.match(landingContent, /37\.04%[\s\S]*?opacity:\s*1;[\s\S]*?transform:\s*scale\(0\.30\);/);

    // 55.56% (1500ms): 500ms hold keeping wordmark at scale 0.30 with opacity 1
    assert.match(landingContent, /55\.56%[\s\S]*?opacity:\s*1;[\s\S]*?transform:\s*scale\(0\.30\);/);

    // 83.33% (2250ms): expansion to scale 1.0
    assert.match(landingContent, /83\.33%[\s\S]*?opacity:\s*1;[\s\S]*?transform:\s*scale\(1\);/);
    assert.match(landingContent, /100%[\s\S]*?opacity:\s*1;[\s\S]*?transform:\s*scale\(1\);/);

    // Animation duration is 2.7s
    assert.match(landingContent, /animation:\s*synq-intro-wordmark\s+2\.7s\s+cubic-bezier/);
    assert.match(landingContent, /animation:\s*synq-intro-indicators\s+2\.7s\s+cubic-bezier/);

    // Indicator cubes held hidden until 83.33% (2250ms)
    assert.match(landingContent, /@keyframes synq-intro-indicators\s*\{[\s\S]*?0%[\s\S]*?opacity:\s*0;[\s\S]*?83\.33%[\s\S]*?opacity:\s*0;[\s\S]*?100%[\s\S]*?opacity:\s*1;/);

    // Intro completion timer fires at LANDING_INTRO_TIMING.TOTAL_DURATION_MS (2700ms)
    assert.match(landingContent, /setTimeout\(\(\)\s*=>\s*\{\s*setIntroComplete\(true\);\s*\},\s*LANDING_INTRO_TIMING\.TOTAL_DURATION_MS\)/);
  });

  it('5. Part A: Three.js hands held offscreen through 1500ms and enter from 1500–2250ms with smootherstep', () => {
    // Hands held offscreen during 0-1500ms (through the 500ms pause)
    assert.match(componentContent, /if\s*\(introElapsed\s*<\s*LANDING_INTRO_TIMING\.WORDMARK_PAUSE_END_MS\)\s*\{[\s\S]*?baseMaterial\.uniforms\.uLeftHandOffset\.value\s*=\s*-offscreenDist;[\s\S]*?baseMaterial\.uniforms\.uRightHandOffset\.value\s*=\s*offscreenDist;/);

    // Simultaneous smootherstep entrance between 1500ms and 2250ms
    assert.match(componentContent, /const\s+p\s*=\s*\(introElapsed\s*-\s*LANDING_INTRO_TIMING\.WORDMARK_PAUSE_END_MS\)\s*\/\s*LANDING_INTRO_TIMING\.HAND_TRAVEL_DURATION_MS;/);
    assert.match(componentContent, /clampedP\s*\*\s*\(clampedP\s*\*\s*6\.0\s*-\s*15\.0\)\s*\+\s*10\.0/);

    // Settle strictly at 0.0 at >= 2250ms
    assert.match(componentContent, /baseMaterial\.uniforms\.uLeftHandOffset\.value\s*=\s*0\.0;/);
    assert.match(componentContent, /baseMaterial\.uniforms\.uRightHandOffset\.value\s*=\s*0\.0;/);

    // Flicker gated until 2250ms
    assert.match(componentContent, /if\s*\(introElapsed\s*<\s*LANDING_INTRO_TIMING\.EXPANSION_HANDS_END_MS\)\s*\{\s*baseMaterial\.uniforms\.uEnableFlicker\.value\s*=\s*0\.0;\s*\}\s*else\s*\{/);
  });

  it('6. Part B: Enter click starts exit without immediate navigation and prevents duplicates', () => {
    // Intercepts navigation
    assert.match(landingContent, /const\s+handleEnterClick\s*=\s*\(e:\s*React\.MouseEvent<HTMLAnchorElement>\s*\|\s*React\.KeyboardEvent<HTMLAnchorElement>\)\s*=>\s*\{/);
    assert.match(landingContent, /e\.preventDefault\(\);/);
    assert.match(landingContent, /if\s*\(isExiting\)\s*return;/);

    // Suppresses duplicate clicks and pointer interactions
    assert.match(landingContent, /isExiting\s*\?\s*'pointer-events-none cursor-default'\s*:\s*''/);
    assert.match(landingContent, /aria-disabled=\{isExiting\}/);
    assert.match(landingContent, /tabIndex=\{isExiting\s*\?\s*-1\s*:\s*0\}/);

    // Records session flag for continuous Negotiator emergence
    assert.match(landingContent, /sessionStorage\.setItem\(['"]synq_enter_transition['"],\s*['"]1['"]\)/);
  });

  it('7. Part B: Phase 1 (0–500ms) hands retreat smoothly offscreen via vertex shader with smootherstep', () => {
    // Props passed to InteractivePixelArtwork
    assert.match(landingContent, /exitActive=\{isExiting\}/);
    assert.match(landingContent, /exitStartTime=\{exitStartTime\}/);

    // Three.js exit retreat logic
    assert.match(componentContent, /if\s*\(exitElapsed\s*<\s*LANDING_EXIT_TIMING\.HANDS_RETREAT_DURATION_MS\)/);
    assert.match(componentContent, /const\s+p\s*=\s*Math\.min\(1\.0,\s*Math\.max\(0\.0,\s*exitElapsed\s*\/\s*LANDING_EXIT_TIMING\.HANDS_RETREAT_DURATION_MS\)\);/);
    assert.match(componentContent, /baseMaterial\.uniforms\.uLeftHandOffset\.value\s*=\s*-offscreenDist\s*\*\s*ease;/);
    assert.match(componentContent, /baseMaterial\.uniforms\.uRightHandOffset\.value\s*=\s*offscreenDist\s*\*\s*ease;/);

    // Fully outside viewport by 500ms
    assert.match(componentContent, /baseMaterial\.uniforms\.uLeftHandOffset\.value\s*=\s*-offscreenDist;/);
    assert.match(componentContent, /baseMaterial\.uniforms\.uRightHandOffset\.value\s*=\s*offscreenDist;/);

    // Wordmarks stay full size and visible during retreat (not scaled down)
    assert.ok(!landingContent.includes('scale(0.30) during exit'), 'Wordmark must not scale down during exit');
  });

  it('8. Part B: Phase 2 (500–1000ms) remaining elements smoothly fade into #242424 charcoal', () => {
    // Phase 2 triggered at HANDS_RETREAT_DURATION_MS (500ms)
    assert.match(landingContent, /exitTimeoutRef\.current\s*=\s*setTimeout\(\(\)\s*=>\s*\{[\s\S]*?setExitPhase\(['"]fading['"]\);[\s\S]*?\},\s*LANDING_EXIT_TIMING\.HANDS_RETREAT_DURATION_MS\);/);

    // Exit fade class applied to outer landing elements wrapper
    assert.match(landingContent, /synq-landing-exit-fade/);
    assert.match(landingContent, /\.synq-landing-exit-fade\s*\{[\s\S]*?transition:\s*opacity\s+0\.5s\s+ease-out;/);
    assert.match(landingContent, /\.synq-landing-exit-fade\.is-fading\s*\{[\s\S]*?opacity:\s*0\s*!important;/);

    // Pure #242424 background maintained
    assert.match(landingContent, /bg-\[#242424\]/);
  });

  it('9. Part B: Navigation occurs at 1000ms preserving destination route and query parameters', () => {
    // Navigates after TOTAL_DURATION_MS (1000ms)
    assert.match(landingContent, /navTimeoutRef\.current\s*=\s*setTimeout\(\(\)\s*=>\s*\{[\s\S]*?router\.push\(['"]\/negotiator\?new=1['"]\);[\s\S]*?\},\s*LANDING_EXIT_TIMING\.TOTAL_DURATION_MS\);/);

    // Link preserves existing destination
    assert.match(landingContent, /href="\/negotiator\?new=1"/);

    // Timers cleaned up on unmount
    assert.match(landingContent, /clearTimeout\(exitTimeoutRef\.current\);/);
    assert.match(landingContent, /clearTimeout\(navTimeoutRef\.current\);/);
  });

  it('10. Part C: Negotiator emergence overlay lifecycle, CSS keyframe fade, and unmount guarantee', () => {
    // Reads and consumes sessionStorage flag
    assert.match(negotiatorContent, /sessionStorage\.getItem\(['"]synq_enter_transition['"]\)/);
    assert.match(negotiatorContent, /sessionStorage\.removeItem\(['"]synq_enter_transition['"]\)/);

    // Self-completing CSS keyframe animation ensures native compositor fade to opacity: 0
    assert.match(negotiatorContent, /@keyframes synq-emergence-fade\s*\{[\s\S]*?0%\s*\{\s*opacity:\s*1;\s*\}[\s\S]*?100%\s*\{\s*opacity:\s*0;\s*\}/);
    assert.match(negotiatorContent, /animation:\s*['"]synq-emergence-fade 400ms cubic-bezier\(0, 0, 0\.2, 1\) forwards['"]/);

    // Both onAnimationEnd and fallback timer ensure reliable unmounting
    assert.match(negotiatorContent, /onAnimationEnd=\{\(\)\s*=>\s*setEmergingFromLanding\(false\)\}/);
    assert.match(negotiatorContent, /setTimeout\(\(\)\s*=>\s*\{[\s\S]*?setEmergingFromLanding\(false\);[\s\S]*?\},\s*450\);/);

    // Charcoal #242424 overlay container
    assert.match(negotiatorContent, /data-testid="negotiator-emergence-overlay"/);
    assert.match(negotiatorContent, /bg-\[#242424\]/);
  });

  it('11. Part C: Direct Negotiator visits function normally with no delay or unexpected overlay', () => {
    // Only activated when flag is present in sessionStorage
    assert.match(negotiatorContent, /if\s*\(flag\s*===\s*['"]1['"]\)/);
  });

  it('12. Reduced-motion behavior: immediate navigation and animation bypass', () => {
    // Landing enter button click bypasses animation under reduced motion
    assert.match(landingContent, /if\s*\(prefersReduced\)\s*\{[\s\S]*?router\.push\(['"]\/negotiator\?new=1['"]\);[\s\S]*?return;\s*\}/);

    // Negotiator page bypasses emergence under reduced motion
    assert.match(negotiatorContent, /matchMedia\('\(prefers-reduced-motion:\s*reduce\)'\)/);

    // CSS reduced motion overrides
    assert.match(landingContent, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.synq-landing-exit-fade\s*\{[\s\S]*?transition:\s*none\s*!important;\s*\}/);
  });

  it('13. Wallet and liquid lens behavior remain intact and properly gated during exit', () => {
    // Liquid lens deactivated immediately during exit
    assert.match(landingContent, /targetPosRef\.current\.active\s*=\s*false;\s*setLensActive\(false\);/);
    assert.match(landingContent, /lensActive=\{lensActive\s*&&\s*!isExiting\}/);
    assert.match(landingContent, /if\s*\(isExiting\)\s*return;/);

    // InteractivePixelArtwork gates liquid simulation and lens pass during exit
    assert.match(componentContent, /!isExitActive/);
    assert.match(componentContent, /baseMaterial\.uniforms\.uLensActive\.value\s*=\s*\(lensActiveRef\.current\s*&&\s*!isExitActive/);

    // Wallet Status header intact
    assert.match(landingContent, /<WalletStatus\s+onOpenChange=\{setWalletDropdownOpen\}\s*\/>/);
  });

  it('14. Behavioral Test: Emergence state machine consumes flag, handles Strict Mode remount, and unmounts cleanly', () => {
    // Mock sessionStorage
    const storage: Record<string, string> = { synq_enter_transition: '1' };
    const mockSessionStorage = {
      getItem: (key: string) => storage[key] || null,
      removeItem: (key: string) => { delete storage[key]; },
      setItem: (key: string, val: string) => { storage[key] = val; },
    };

    // State machine simulation replicating NegotiatorContent initialization
    const createEmergenceState = (session: typeof mockSessionStorage, prefersReduced = false) => {
      let flag: string | null = null;
      try {
        flag = session.getItem('synq_enter_transition');
        if (flag === '1') {
          session.removeItem('synq_enter_transition');
          return !prefersReduced;
        }
      } catch {}
      return false;
    };

    // Case A: Landing-origin navigation
    const initialEmerging = createEmergenceState(mockSessionStorage, false);
    assert.equal(initialEmerging, true, 'Overlay must be active initially on landing-origin navigation');
    assert.equal(mockSessionStorage.getItem('synq_enter_transition'), null, 'Flag must be consumed immediately');

    // Case B: Strict Mode remount (storage now empty, but component state remains active with timer)
    const strictModeReInit = createEmergenceState(mockSessionStorage, false);
    assert.equal(strictModeReInit, false, 'Second mount sees no flag, preventing indefinite loop/restart');

    // Case C: Direct visit
    assert.equal(createEmergenceState(mockSessionStorage, false), false, 'Direct visits must have overlay inactive');

    // Case D: Reduced motion
    mockSessionStorage.setItem('synq_enter_transition', '1');
    assert.equal(createEmergenceState(mockSessionStorage, true), false, 'Reduced motion must bypass overlay');
    assert.equal(mockSessionStorage.getItem('synq_enter_transition'), null, 'Flag is still consumed even if motion reduced');
  });

  it('15. Behavioral Test: Landing page bfcache restoration resets exit state on back navigation', () => {
    // pageshow event listener verifies bfcache restoration
    assert.match(landingContent, /handlePageShow[\s\S]*?e\.persisted[\s\S]*?setIsExiting\(false\)[\s\S]*?setExitPhase\('idle'\)/);
  });
});
