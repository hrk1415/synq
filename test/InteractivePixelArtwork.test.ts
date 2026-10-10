// test/InteractivePixelArtwork.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

describe('SYNQ — Interactive Pixel Artwork Prototype Suite (Phase 7: Monochrome Pixel Hands + Dynamic Liquid Color Reveal)', () => {
  const rootDir = path.resolve(__dirname, '..');
  const componentPath = path.join(rootDir, 'src/components/landing/InteractivePixelArtwork.tsx');
  const oldComponentPath = path.join(rootDir, 'src/components/landing/InteractivePixelHands.tsx');
  const oldMaskPath = path.join(rootDir, 'src/components/landing/pixel-hands-mask.ts');
  const pixelLabRoutePath = path.join(rootDir, 'src/app/pixel-lab/page.tsx');
  const img01Path = path.join(rootDir, 'public/01.jpg');
  const img02Path = path.join(rootDir, 'public/02.jpg');
  const img03Path = path.join(rootDir, 'public/03.png');
  const landingPagePath = path.join(rootDir, 'src/app/page.tsx');
  const agentControllerPath = path.join(rootDir, 'src/app/agent-controller/page.tsx');
  const swapPath = path.join(rootDir, 'src/app/swap/page.tsx');

  it('1. Old Phase 2 mask and 2D canvas files remain completely retired', () => {
    assert.ok(!fs.existsSync(oldMaskPath), 'pixel-hands-mask.ts must no longer exist');
    assert.ok(!fs.existsSync(oldComponentPath), 'InteractivePixelHands.tsx must no longer exist');
  });

  it('2. Three.js component, isolated /pixel-lab prototype route, and public/03.png exist', () => {
    assert.ok(fs.existsSync(componentPath), 'InteractivePixelArtwork.tsx must exist');
    assert.ok(fs.existsSync(pixelLabRoutePath), 'src/app/pixel-lab/page.tsx must exist');
    assert.ok(fs.existsSync(img01Path), 'public/01.jpg must exist');
    assert.ok(fs.existsSync(img02Path), 'public/02.jpg must exist');
    assert.ok(fs.existsSync(img03Path), 'public/03.png must exist');
  });

  const componentContent = fs.readFileSync(componentPath, 'utf8');
  const pixelLabContent = fs.readFileSync(pixelLabRoutePath, 'utf8');

  it('3. Source remains /03.png with proper dimensions and sRGB color space', () => {
    assert.match(componentContent, /REFERENCE_IMAGE_SRC\s*=\s*['"]\/03\.png['"]/);
    assert.match(componentContent, /TEXTURE_WIDTH\s*=\s*666/);
    assert.match(componentContent, /TEXTURE_HEIGHT\s*=\s*374/);
    assert.match(componentContent, /texture\.colorSpace\s*=\s*THREE\.SRGBColorSpace/);
  });

  it('4. Base artwork is completely static: zero pointer displacement, no repulsion, no Z-lift', () => {
    assert.ok(!componentContent.includes('uPointerActive') || !componentContent.includes('pos.xy +='), 'Base geometry must not have pointer displacement');
    assert.ok(!componentContent.includes('uMaxDepth'), 'uMaxDepth must be retired');
    assert.ok(!componentContent.includes('pos.xy +='), 'pos.xy must never be displaced');
    assert.ok(!componentContent.includes('pos.z +='), 'pos.z must never be displaced');
  });

  it('5. Base shader respects PNG alpha and discards transparent background', () => {
    assert.match(componentContent, /texColor\.a\s*<\s*0\.08/);
    assert.match(componentContent, /discard;/);
  });

  it('6. Base point size target is ~7.0 CSS px for crisp square pixel tiles', () => {
    assert.match(componentContent, /DEFAULT_DESKTOP_POINT_SIZE\s*=\s*7\.0/);
    assert.match(componentContent, /uPointSize/);
  });

  it('7. Phase 6 particle pool and emitter infrastructure are retired', () => {
    assert.ok(!componentContent.includes('PARTICLE_POOL_SIZE'), 'Particle pool must be retired');
    assert.ok(!componentContent.includes('spawnParticle'), 'spawnParticle must be retired');
    assert.ok(!componentContent.includes('CLICK_BURST_COUNT'), 'Click burst must be retired');
  });

  it('8. Resting monochrome transformation maps luminance into restricted dark range (0.05 to 0.38) with NO white pixels', () => {
    assert.match(componentContent, /dot\(texColor\.rgb,\s*vec3\(0\.299,\s*0\.587,\s*0\.114\)\)/);
    assert.match(componentContent, /0\.05\s*\+\s*lum\s*\*\s*0\.33/);
  });

  it('9. Original RGB remains available and is mixed with monochrome via liquid field', () => {
    assert.match(componentContent, /mix\(monoColor,\s*texColor\.rgb,\s*revealAmount\)/);
    assert.match(componentContent, /smoothstep\(0\.15,\s*0\.65,\s*liquidVal\)/);
  });

  it('10. Ping-Pong render targets exist for low-resolution GPU liquid simulation (256x144)', () => {
    assert.match(componentContent, /SIM_WIDTH\s*=\s*256/);
    assert.match(componentContent, /SIM_HEIGHT\s*=\s*144/);
    assert.match(componentContent, /new\s+THREE\.WebGLRenderTarget\(SIM_WIDTH,\s*SIM_HEIGHT/);
    assert.match(componentContent, /rtRead/);
    assert.match(componentContent, /rtWrite/);
  });

  it('11. Liquid simulation shader combines cursor injection, inertia/advection, diffusion, noise, and decay', () => {
    assert.match(componentContent, /SIM_VERTEX_SHADER/);
    assert.match(componentContent, /SIM_FRAGMENT_SHADER/);
    assert.match(componentContent, /uPrevField/);
    assert.match(componentContent, /uVelocity/);
    assert.match(componentContent, /uDecay/);
    assert.match(componentContent, /diffused/);
    assert.match(componentContent, /noise/);
  });

  it('11b. Phase 7.3 injection brush radius remains approved at 70px', () => {
    assert.match(componentContent, /INJECTION_RADIUS_CSS\s*=\s*70/);
  });

  it('11c. Swept capsule is retired and primary organic droplet head is dominant at live pointer', () => {
    assert.ok(
      !componentContent.includes('dist = length(pa - ba * h)'),
      'Single swept capsule must be retired as the primary brush'
    );
    assert.match(componentContent, /vec2\s+headDiff\s*=\s*vUv\s*-\s*uPointer/);
    assert.match(componentContent, /float\s+headInjection\s*=\s*smoothstep\(headRadius,\s*headRadius\s*\*\s*0\.20,\s*headDist\)/);
  });

  it('11d. Bounded intermediate trail droplet stamps exist with MAX_TRAIL_SAMPLES = 6 and tapering', () => {
    assert.match(componentContent, /const\s+int\s+MAX_TRAIL_SAMPLES\s*=\s*6/);
    assert.match(componentContent, /uniform\s+float\s+uTrailSamples/);
    assert.match(componentContent, /float\s+radiusScale\s*=\s*mix\(0\.75,\s*0\.95,\s*t\)/);
    assert.match(componentContent, /float\s+stampStrength\s*=\s*mix\(0\.45,\s*0\.78,\s*t\)/);
  });

  it('12. Camera is OrthographicCamera', () => {
    assert.match(componentContent, /new\s+THREE\.OrthographicCamera/);
    assert.ok(!componentContent.includes('new THREE.PerspectiveCamera'), 'Perspective camera must remain retired');
  });

  it('13. Debug mode contains four distinct diagnostic views (A, B, C, D) and exposes trail sample diagnostics', () => {
    assert.match(componentContent, /A\.\s*Final Artwork/);
    assert.match(componentContent, /B\.\s*Liquid Field/);
    assert.match(componentContent, /C\.\s*Original Color/);
    assert.match(componentContent, /D\.\s*Resting Mono/);
    assert.match(componentContent, /Trail Mode/);
    assert.match(componentContent, /Trail Samples/);
    assert.match(componentContent, /Head Injection/);
    assert.match(componentContent, /uDebugMode/);
  });

  it('14. Lifecycle disposal cleans up all geometries, materials, render targets, and renderer', () => {
    assert.match(componentContent, /baseGeometry\.dispose\(\)/);
    assert.match(componentContent, /simGeometry\.dispose\(\)/);
    assert.match(componentContent, /baseMaterial\.dispose\(\)/);
    assert.match(componentContent, /simMaterial\.dispose\(\)/);
    assert.match(componentContent, /rtRead\.dispose\(\)/);
    assert.match(componentContent, /rtWrite\.dispose\(\)/);
    assert.match(componentContent, /renderer\.dispose\(\)/);
  });

  it('15. prefers-reduced-motion disables liquid simulation', () => {
    assert.match(componentContent, /prefers-reduced-motion/);
    assert.match(componentContent, /reducedMotionQuery\.matches/);
  });

  const landingPageContent = fs.readFileSync(landingPagePath, 'utf8');

  it('16. Prototype route /pixel-lab remains isolated and renders InteractivePixelArtwork', () => {
    assert.match(pixelLabContent, /InteractivePixelArtwork/);
  });

  it('17. Production landing page imports and renders InteractivePixelArtwork with #242424 charcoal background and approved layered sandwich', () => {
    const currentLandingContent = fs.readFileSync(landingPagePath, 'utf8');
    assert.match(
      currentLandingContent,
      /import\s+InteractivePixelArtwork\s+from\s+['"]@\/components\/landing\/InteractivePixelArtwork['"]/,
      'Production landing must import InteractivePixelArtwork'
    );
    assert.match(
      currentLandingContent,
      /<InteractivePixelArtwork[\s\S]*?artworkScale=\{(?:1\.25|1\.60)\}[\s\S]*?colorMode=["']original-color["']/,
      'Production landing must render InteractivePixelArtwork with approved scale and original-color mode'
    );
    assert.match(currentLandingContent, /#242424/, 'Production landing must have #242424 charcoal background');
  });

  it('18. Old visual system (01.jpg, InteractiveGlassGrid, parallax, sweep, cutouts) is completely removed from production landing', () => {
    const currentLandingContent = fs.readFileSync(landingPagePath, 'utf8');
    assert.ok(!currentLandingContent.includes('/01.jpg'), 'src/app/page.tsx must not reference /01.jpg');
    assert.ok(!currentLandingContent.includes('InteractiveGlassGrid'), 'src/app/page.tsx must not import or render InteractiveGlassGrid');
    assert.ok(!currentLandingContent.includes('backgroundRef'), 'Old backgroundRef for image parallax must be absent');
    assert.ok(!currentLandingContent.includes('applyTransform'), 'Old applyTransform for image parallax must be absent');
    assert.ok(!currentLandingContent.includes('light-sweep'), 'Old light-sweep effect must be absent');
    assert.ok(!currentLandingContent.includes('synq-glass'), 'Old synq-glass surface styling must be absent');
    assert.ok(!currentLandingContent.includes('synq-glass-cutout-mask'), 'Old SVG cutout mask must be absent');
  });

  it('19. Production foreground UI (WalletStatus, Synq typography sandwich, CTA reveal, /negotiator?new=1) remains intact above artwork (with top-left logo removed in B.9)', () => {
    const currentLandingContent = fs.readFileSync(landingPagePath, 'utf8');
    assert.ok(!currentLandingContent.includes('src="/logo.jpg"'), 'Synq top-left logo must be removed from production landing');
    assert.match(currentLandingContent, /<WalletStatus[\s\S]*?\/>/, 'WalletStatus header control must remain present on production landing');
    assert.match(currentLandingContent, />\s*Synq\s*</, 'Word "Synq" must remain in registered typography');
    assert.match(currentLandingContent, /\/negotiator\?new=1/, 'Enter CTA must navigate to /negotiator?new=1');
    assert.match(currentLandingContent, /z-0/, 'Artwork layer must be at background layer (z-0)');
    assert.match(currentLandingContent, /z-10|z-20/, 'Foreground hero and CTA must layer above artwork');
  });

  it('20. Asset files, Agent Controller, and Swap remain untouched', () => {
    const gitDiff01 = execSync(`git status --short public/01.jpg`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.equal(gitDiff01, '', 'public/01.jpg must not have any git changes');

    const gitDiff02 = execSync(`git status --short public/02.jpg`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.ok(!gitDiff02.startsWith('M'), 'public/02.jpg must not be modified');

    const gitDiff03 = execSync(`git status --short public/03.png`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.ok(!gitDiff03.startsWith('M'), 'public/03.png must not be modified');

    const agentDiff = execSync(`git status --short src/app/agent-controller/page.tsx`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.equal(agentDiff, '', 'src/app/agent-controller/page.tsx must not have any git changes');

    const swapDiff = execSync(`git status --short src/app/swap/page.tsx`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.equal(swapDiff, '', 'src/app/swap/page.tsx must not have any git changes');
  });

  it('21. Artwork scale architecture: component supports artworkScale prop and scales geometry proportionally', () => {
    // Component supports artworkScale prop with default 1.0
    assert.match(componentContent, /artworkScale\?:\s*number/);
    assert.match(componentContent, /artworkScale\s*=\s*1\.0/);

    // Geometry calculation scales width and height while maintaining aspect ratio
    assert.match(componentContent, /Math\.min\(width\s*\*\s*0\.94,\s*height\s*\*\s*ASPECT_RATIO\s*\*\s*0\.90\)\s*\*\s*currentScale/);
    assert.match(componentContent, /artworkHeight\s*=\s*artworkWidth\s*\/\s*ASPECT_RATIO/);

    // Simulation radius uniform scales inversely with artworkWidth to preserve exact 70px display radius
    assert.match(componentContent, /simMaterial\.uniforms\.uRadius\.value\s*=\s*INJECTION_RADIUS_CSS\s*\/\s*artworkWidth/);

    // Production landing sets artworkScale={1.60} and transparentBackground={true}
    const currentLandingContent = fs.readFileSync(landingPagePath, 'utf8');
    assert.match(currentLandingContent, /artworkScale=\{(?:1\.25|1\.60)\}/);
    assert.match(currentLandingContent, /transparentBackground=\{true\}/);
  });

  it('22. Experiment B.1 / Promotion: Refined layered sandwich composition with smaller registered typography, enlarged hands, 0.75px outline, and #242424 charcoal background', () => {
    const currentCompContent = fs.readFileSync(componentPath, 'utf8');
    const currentPixelLabContent = fs.readFileSync(pixelLabRoutePath, 'utf8');
    const currentLandingContent = fs.readFileSync(landingPagePath, 'utf8');

    // 1. Production landing uses approved Experiment B layered sandwich composition
    assert.match(currentLandingContent, /artworkScale=\{(?:1\.25|1\.60)\}/);
    assert.match(currentLandingContent, /#242424/);
    assert.match(currentLandingContent, /transparentBackground=\{true\}/);
    assert.match(currentLandingContent, /colorMode=["']original-color["']/);

    // 2. Pixel-lab and production landing both use 03.png via InteractivePixelArtwork
    assert.match(currentPixelLabContent, /<InteractivePixelArtwork/);
    assert.match(currentLandingContent, /<InteractivePixelArtwork/);
    assert.match(currentCompContent, /REFERENCE_IMAGE_SRC\s*=\s*['"]\/03\.png['"]/);

    // 3. Component supports clean opt-in props for Experiment B.1 & B.2 with production-safe defaults
    assert.match(currentCompContent, /transparentBackground\?:\s*boolean/);
    assert.match(currentCompContent, /transparentBackground\s*=\s*false/);
    assert.match(currentCompContent, /colorMode\?:\s*['"]monochrome-reveal['"]\s*\|\s*['"]original-color['"]/);
    assert.match(currentCompContent, /colorMode\s*=\s*['"]monochrome-reveal['"]/);
    assert.match(currentCompContent, /disableLiquid\?:\s*boolean/);
    assert.match(currentCompContent, /disableLiquid\s*=\s*false/);
    assert.match(currentCompContent, /preservePixelSize\?:\s*boolean/);
    assert.match(currentCompContent, /preservePixelSize\s*=\s*false/);
    assert.match(currentCompContent, /enableFlicker\?:\s*boolean/);
    assert.match(currentCompContent, /enableFlicker\s*=\s*false/);
    assert.match(currentCompContent, /lensActive\?:\s*boolean/);
    assert.match(currentCompContent, /lensActive\s*=\s*false/);
    assert.match(currentCompContent, /lensSize\?:\s*number/);
    assert.match(currentCompContent, /lensRadius\?:\s*number/);

    // 4. Experiment hands use enlarged scale (1.25x or 1.60x), preserve pixel tile sizing, original RGB, bypass liquid, and lens/flicker integration
    assert.match(currentPixelLabContent, /artworkScale=\{(?:1\.25|1\.60)\}/);
    assert.match(currentPixelLabContent, /preservePixelSize=\{true\}/);
    assert.match(currentPixelLabContent, /colorMode=["']original-color["']/);
    assert.match(currentPixelLabContent, /disableLiquid=\{true\}/);
    assert.match(currentPixelLabContent, /transparentBackground=\{true\}/);
    assert.match(currentPixelLabContent, /enableFlicker=\{true\}/);
    assert.match(currentPixelLabContent, /lensActive=\{lensActive\}/);
    assert.match(currentCompContent, /uOriginalColor/);
    assert.match(currentCompContent, /uLensActive/);
    assert.match(currentCompContent, /roundedBoxSDF/);
    assert.match(currentCompContent, /uEnableFlicker/);

    // 5. Back, outline, and lens-revealed front Synq typography exist and use Press_Start_2P
    assert.match(currentPixelLabContent, /import\s*\{\s*Press_Start_2P\s*\}\s*from\s*['"]next\/font\/google['"]/);
    assert.match(currentPixelLabContent, />\s*Synq\s*</);

    // 6. Slightly enlarged typography metrics shared identically across layers for exact registration
    assert.match(currentPixelLabContent, /typographyStyle/);
    assert.match(currentPixelLabContent, /clamp\((?:84px|108px),\s*(?:14vw|18vw),\s*(?:225px|288px)\)/);

    // 7. Layer 1: Back text is solid/glowing (z-10)
    assert.match(currentPixelLabContent, /z-10/);
    assert.match(currentPixelLabContent, /textShadow/);
    assert.match(currentPixelLabContent, /#ffffff/);

    // 8. Layer 2: Hands layer between back and front (z-20)
    assert.match(currentPixelLabContent, /z-20/);

    // 9. Layer 3: Outline text is delicate 0.75px outline (z-30)
    assert.match(currentPixelLabContent, /z-30/);
    assert.match(currentPixelLabContent, /WebkitTextStroke/);
    assert.match(currentPixelLabContent, /0\.75px\s*rgba\(255,\s*255,\s*255,\s*0\.82\)/);
    assert.match(currentPixelLabContent, /color:\s*['"]transparent['"]/);

    // 10. Layer 4: Foreground solid glowing text revealed inside liquid lens bounds (z-35)
    assert.match(currentPixelLabContent, /z-35/);
    assert.match(currentPixelLabContent, /clipPath/);
    assert.match(currentPixelLabContent, /inset\(/);

    // 11. Layer 5: Screen-surface liquid membrane lens overlay (z-40) with 14px rounded corners
    assert.match(currentPixelLabContent, /z-40/);
    assert.match(currentPixelLabContent, /rounded-\[14px\]/);
    assert.ok(!currentPixelLabContent.includes('backdrop-blur'), 'Lens overlay must not use backdrop-blur');

    // 12. Background is refined charcoal black (#242424)
    assert.match(currentPixelLabContent, /bg-\[#242424\]|#242424/);

    // 13. No old InteractiveGlassGrid, no new particle system
    assert.ok(!currentPixelLabContent.includes('InteractiveGlassGrid'));
    assert.ok(!currentCompContent.includes('particlePool'));

    // 14. 03.png untouched
    const gitDiff03 = execSync(`git status --short public/03.png`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.ok(!gitDiff03.startsWith('M'), 'public/03.png must not be modified');
  });

  it('23. Experiment B.3/B.4: Borderless screen-surface liquid lens with procedural refraction, DOM typography displacement, and amplified flicker rates', () => {
    const currentCompContent = fs.readFileSync(componentPath, 'utf8');
    const currentPixelLabContent = fs.readFileSync(pixelLabRoutePath, 'utf8');
    const currentLandingContent = fs.readFileSync(landingPagePath, 'utf8');

    // 1. Production landing uses promoted artwork configuration
    assert.match(currentLandingContent, /artworkScale=\{(?:1\.25|1\.60)\}/);
    assert.match(currentLandingContent, /transparentBackground=\{true\}/);
    assert.match(currentLandingContent, /colorMode=["']original-color["']/);

    // 2. Protected routes remain completely untouched
    const agentDiff = execSync(`git status --short src/app/agent-controller/page.tsx`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.equal(agentDiff, '', 'src/app/agent-controller/page.tsx must not have any git changes');

    const swapDiff = execSync(`git status --short src/app/swap/page.tsx`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.equal(swapDiff, '', 'src/app/swap/page.tsx must not have any git changes');

    // 3. Clean surface: borders, rings, box shadows, and blur are completely removed
    assert.ok(!currentPixelLabContent.includes('border-white/20'), 'Lens overlay must not have border-white/20');
    assert.ok(!currentPixelLabContent.includes('ring-1 ring-inset ring-white/10'), 'Lens overlay must not have ring-1 border');
    assert.ok(!currentPixelLabContent.includes('backdrop-blur'), 'Lens overlay must not have backdrop-blur');
    assert.match(currentPixelLabContent, /rounded-\[14px\]/);

    // 4. DOM typography ("Synq") refraction via SVG displacement filter
    assert.match(currentPixelLabContent, /id=["']synq-liquid-displacement["']/);
    assert.match(currentPixelLabContent, /<feTurbulence/);
    assert.match(currentPixelLabContent, /<feDisplacementMap/);
    assert.match(currentPixelLabContent, /scale=["']6\.5["']/);
    assert.match(currentPixelLabContent, /url\(#synq-liquid-displacement\)/);

    // 5. WebGL hand artwork procedural viscous refraction
    assert.match(currentCompContent, /getViscousRefraction/);
    assert.match(currentCompContent, /vNoise/);
    assert.match(currentCompContent, /totalDisplaceCss/);
    assert.match(currentCompContent, /refractedTex/);

    // 6. Amplified flicker rates: ~5.0-9.0% outside lens, ~20.0% inside lens
    assert.match(currentCompContent, /float\s+threshold\s*=\s*mix\((?:0\.050|0\.090),\s*0\.200,\s*lensMask\);/);
    assert.match(currentCompContent, /lensBrightMod\s*=\s*mix\(0\.22,\s*1\.90,\s*variation\);/);

    // 7. Composition preserved: #242424 charcoal background and hand scale
    assert.match(currentPixelLabContent, /#242424/);
    assert.match(currentPixelLabContent, /artworkScale=\{(?:1\.25|1\.60)\}/);
    assert.match(currentPixelLabContent, /clamp\((?:84px|108px),\s*(?:14vw|18vw),\s*(?:225px|288px)\)/);
  });

  it('24. Experiment B.5.1: True transparent LiquidLensSurface with microscopic optical sheen, zero white/black topology shapes, and 2-4px/5-7px/8px hand refraction', () => {
    const currentCompContent = fs.readFileSync(componentPath, 'utf8');
    const currentPixelLabContent = fs.readFileSync(pixelLabRoutePath, 'utf8');
    const currentLandingContent = fs.readFileSync(landingPagePath, 'utf8');

    // 1. Production landing uses promoted artwork configuration with transparentBackground
    assert.match(currentLandingContent, /artworkScale=\{(?:1\.25|1\.60)\}/);
    assert.match(currentLandingContent, /transparentBackground=\{true\}/);

    // 2. Procedural liquid topology membrane component exists in Layer 5
    assert.match(currentPixelLabContent, /LiquidLensSurface/);
    assert.match(currentPixelLabContent, /<LiquidLensSurface[\s\S]*?size=\{lensSize\}[\s\S]*?radius=\{lensRadius\}[\s\S]*?active=\{lensActive\}/);

    // 3. True transparent surface: zero white/black topology shapes, microscopic highlight <= 1.5%
    assert.ok(!currentPixelLabContent.includes('outRgb = vec3(0.0)'), 'Must not render black topology shapes');
    assert.ok(!currentPixelLabContent.includes('lumDelta'), 'Must not render visible luminance blob fields');
    assert.match(currentPixelLabContent, /clamp\([\s\S]*?0\.015\)/, 'Highlight contribution must be clamped to <= 1.5%');
    assert.match(currentPixelLabContent, /ridgeNoise/);
    assert.match(currentPixelLabContent, /caustic/);
    assert.match(currentPixelLabContent, /rimZone/);
    assert.match(currentPixelLabContent, /rimVisibility/);

    // 4. Clean surface preserved: no border, ring, blur, outer drop shadow, or card fill
    assert.ok(!currentPixelLabContent.includes('backdrop-blur'), 'Must not have backdrop-blur');
    assert.ok(!currentPixelLabContent.includes('drop-shadow'), 'Must not have outer drop-shadow on lens');
    assert.ok(!currentPixelLabContent.includes('border-white'), 'Must not have border');
    assert.ok(!currentPixelLabContent.includes('ring-'), 'Must not have ring');

    // 5. Imperfect magnifying lens spatial warping in hand artwork shader (target 2-4 CSS px, strong 5-7px, peaks ~8px)
    assert.match(currentCompContent, /lensCurvature\s*=\s*\(1\.0\s*-\s*clamp\(r\s*\*\s*0\.50,\s*0\.0,\s*0\.85\)\)/);
    assert.match(currentCompContent, /lensBulge\s*=\s*-p\s*\*\s*lensCurvature/);
    assert.match(currentCompContent, /imperfectMagnifier/);
    assert.match(currentCompContent, /flowOffsetCss\s*=\s*flow\s*\*\s*4\.2/);

    // 6. Geometry preserved: 180x180, radius 14px
    assert.match(currentPixelLabContent, /lensSize\s*=\s*180/);
    assert.match(currentPixelLabContent, /lensRadius\s*=\s*14/);
    assert.match(currentPixelLabContent, /rounded-\[14px\]/);

    // 7. Regression coverage: LiquidLensSurface uses direct transparent canvas with zero img/Image/data/blob sources
    assert.match(currentPixelLabContent, /<canvas[\s\S]*?ref=\{canvasRef\}/);
    assert.ok(!currentPixelLabContent.includes('<img'), 'Liquid lens must not render <img> tags');
    assert.ok(!currentPixelLabContent.includes('<Image'), 'Liquid lens must not render Next.js <Image> tags');
    assert.ok(!currentPixelLabContent.includes('next/image'), 'Must not import next/image');
    assert.ok(!currentPixelLabContent.includes('data:image'), 'Must not use data:image URLs');
    assert.ok(!currentPixelLabContent.includes('blob:'), 'Must not use blob URLs');
    assert.ok(!currentPixelLabContent.includes('loseContext()'), 'Must not force loseContext() in cleanup');
    assert.match(currentPixelLabContent, /clearColor\(0\.0,\s*0\.0,\s*0\.0,\s*0\.0\)/, 'Must clear WebGL buffer to transparent zero');
    assert.match(currentPixelLabContent, /backgroundColor:\s*['"]transparent['"]/, 'Canvas must be styled with transparent background');
  });

  it('25. Experiment B.5.2: Diagnostic Modes A-E, Straight-Alpha Compositing, Verification of Shaders/Link, and Fail-Safe Transparent Fallback', () => {
    const currentPixelLabContent = fs.readFileSync(pixelLabRoutePath, 'utf8');

    // 1. Diagnostic render modes A through E defined and supported
    assert.match(currentPixelLabContent, /type\s+LensRenderMode\s*=\s*['"]A['"]\s*\|\s*['"]B['"]\s*\|\s*['"]C['"]\s*\|\s*['"]D['"]\s*\|\s*['"]E['"]/);
    assert.match(currentPixelLabContent, /mode === ['"]A['"]/);
    assert.match(currentPixelLabContent, /mode === ['"]B['"]/);
    assert.match(currentPixelLabContent, /mode === ['"]C['"]/);
    assert.match(currentPixelLabContent, /mode === ['"]D['"]/);
    assert.match(currentPixelLabContent, /mode === ['"]E['"]/);

    // 2. Straight-alpha compositing explicitly configured to prevent additive white blowout
    assert.match(currentPixelLabContent, /premultipliedAlpha:\s*false/);
    assert.match(currentPixelLabContent, /gl\.enable\(gl\.BLEND\)/);
    assert.match(currentPixelLabContent, /gl\.blendFunc\(gl\.SRC_ALPHA,\s*gl\.ONE_MINUS_SRC_ALPHA\)/);

    // 3. Shader compilation and program link status explicitly verified
    assert.match(currentPixelLabContent, /gl\.getShaderParameter\([\s\S]*?gl\.COMPILE_STATUS\)/);
    assert.match(currentPixelLabContent, /gl\.getProgramParameter\([\s\S]*?gl\.LINK_STATUS\)/);
    assert.match(currentPixelLabContent, /gl\.getShaderInfoLog/);
    assert.match(currentPixelLabContent, /gl\.getProgramInfoLog/);

    // 4. Fallback is strictly transparent clear: zero fallback gradients or sheens
    assert.ok(!currentPixelLabContent.includes('createRadialGradient'), 'Fallback must not draw radial gradients');
    assert.ok(!currentPixelLabContent.includes('addColorStop'), 'Fallback must not add color stops');

    // 5. Diagnostic HUD outside lens with mode switcher and telemetry
    assert.match(currentPixelLabContent, /LiquidLensSurface Diagnostic HUD/);
    assert.match(currentPixelLabContent, /gl\.getError\(\)/);
  });

  it('26. Experiment B.6: Subtle inner white edge shadow and bottom-right Rainbow Enter button', () => {
    const currentPixelLabContent = fs.readFileSync(pixelLabRoutePath, 'utf8');
    const rainbowButtonPath = path.join(process.cwd(), 'src', 'components', 'ui', 'rainbow-button.tsx');
    const currentRainbowContent = fs.readFileSync(rainbowButtonPath, 'utf8');

    // 1. Lens geometry preserved: 180x180, 14px radius
    assert.match(currentPixelLabContent, /lensSize\s*=\s*180/);
    assert.match(currentPixelLabContent, /lensRadius\s*=\s*14/);
    assert.match(currentPixelLabContent, /rounded-\[14px\]/);

    // 2. No outer shadow, no CSS border, no ring, no backdrop blur
    assert.ok(!currentPixelLabContent.includes('backdrop-blur'), 'Lens must not have backdrop-blur');
    assert.ok(!currentPixelLabContent.includes('border-white'), 'Lens must not have border-white');
    assert.ok(!currentPixelLabContent.includes('ring-'), 'Lens must not have ring');
    assert.ok(!currentPixelLabContent.includes('drop-shadow'), 'Lens must not have drop-shadow');

    // 3. Subtle inner white edge shadow exists (strictly inset)
    assert.match(currentPixelLabContent, /boxShadow[\s\S]*?inset\s+1px\s+1\.5px/, 'Must have optical inner edge shadow on lens');
    assert.match(currentPixelLabContent, /rgba\(255,\s*255,\s*255,\s*0\.09\)/, 'Inner edge shadow opacity in 0.06-0.11 range');

    // 4. B.5.2 straight-alpha configuration preserved
    assert.match(currentPixelLabContent, /premultipliedAlpha:\s*false/);
    assert.match(currentPixelLabContent, /gl\.enable\(gl\.BLEND\)/);
    assert.match(currentPixelLabContent, /gl\.blendFunc\(gl\.SRC_ALPHA,\s*gl\.ONE_MINUS_SRC_ALPHA\)/);

    // 5. Bottom-right Rainbow Enter button exists with white surface and charcoal text
    assert.match(currentPixelLabContent, /RainbowButton/);
    assert.match(currentPixelLabContent, /href=["']\/negotiator\?new=1["']/);
    assert.match(currentPixelLabContent, /<RainbowButton[\s\S]*?>[\s\S]*?Enter[\s\S]*?<\/RainbowButton>/);
    assert.match(currentPixelLabContent, /text-\[#242424\]/, 'Enter button text must be charcoal #242424');
    assert.match(currentPixelLabContent, /bottom-7.*left-1\/2|bottom-9.*left-1\/2|bottom-7\s+right-8|bottom-9\s+right-12/, 'Enter button positioned near bottom');

    // 6. Enter button has no arrow icon
    assert.ok(!currentPixelLabContent.includes('ArrowRight'), 'Enter button must not contain arrow icon');
    assert.ok(!currentPixelLabContent.includes('arrow'), 'Enter button must not contain arrow');

    // 7. Experiment B.6.1: Internal diffused rainbow light bleed underneath white button surface
    assert.match(currentRainbowContent, /bg-white/, 'Button must have white base surface');
    assert.match(currentRainbowContent, /overflow-hidden/, 'Button must clip internal glow with overflow-hidden');
    assert.match(currentRainbowContent, /text-\[#242424\]/, 'Button interior text must default to charcoal #242424');
    assert.match(currentRainbowContent, /blur-\[14px\]|blur/, 'Internal rainbow layer must be strongly blurred');
    assert.match(currentRainbowContent, /radial-gradient/, 'White diffusion layer must cover rainbow layer');
    assert.match(currentRainbowContent, /speed\s*=\s*4/, 'RainbowButton defaults to 3.5-5s animation range');
    assert.ok(!currentRainbowContent.includes('bg-[#1a1a1c]'), 'Must not have dark button interior');
    assert.ok(!currentRainbowContent.includes('p-[1.5px]'), 'Must not have exposed 1.5px perimeter border');
  });

  it('27. Experiment B.7.1: Reliable public squares indicator, perpetual deterministic pixel flicker, and 172px CTA width', () => {
    const currentPixelLabContent = fs.readFileSync(pixelLabRoutePath, 'utf8');
    const currentCompContent = fs.readFileSync(componentPath, 'utf8');
    const rainbowButtonPath = path.join(process.cwd(), 'src', 'components', 'ui', 'rainbow-button.tsx');
    const currentRainbowContent = fs.readFileSync(rainbowButtonPath, 'utf8');

    // 1. RainbowButton width approximately 160px (height 44px, intentional width/min-width)
    assert.match(currentRainbowContent, /w-\[160px\]/, 'RainbowButton width must be ~160px');
    assert.match(currentRainbowContent, /min-w-\[160px\]/, 'RainbowButton min-width must be ~160px');
    assert.match(currentRainbowContent, /h-\[44px\]/, 'RainbowButton height must be 44px');

    // 2. White surface remains
    assert.match(currentRainbowContent, /bg-white/, 'Base button surface must be white');

    // 3. Charcoal Enter text remains
    assert.match(currentPixelLabContent, /text-\[#242424\]/, 'Enter button text must be charcoal #242424');
    assert.match(currentRainbowContent, /text-\[#242424\]/, 'Default RainbowButton text must be charcoal #242424');

    // 4. Internal rainbow light bleed remains present
    assert.match(currentRainbowContent, /opacity-90/, 'Internal rainbow layer opacity at 0.90');
    assert.match(currentRainbowContent, /0\.64\)/, 'White diffusion radial gradient edge tuned to 0.64');

    // 5. No rainbow border
    assert.ok(!currentRainbowContent.includes('p-[1.5px]'), 'Must not have rainbow border');

    // 6. No dark button interior
    assert.ok(!currentRainbowContent.includes('bg-[#1a1a1c]'), 'Must not have dark interior');

    // 7 & 8. Exactly three public squares exist (□ □ □) and are NOT hidden by default
    assert.match(currentPixelLabContent, /cta-square-a/, 'Square A must exist');
    assert.match(currentPixelLabContent, /cta-square-b/, 'Square B must exist');
    assert.match(currentPixelLabContent, /cta-square-c/, 'Square C must exist');
    const squareMatches = currentPixelLabContent.match(/cta-square-[abc]/g);
    assert.ok(squareMatches && squareMatches.length >= 3, 'Must render squares A, B, and C');

    // Public state does NOT rely on a broken/unbounded SVG mask
    assert.ok(!currentPixelLabContent.includes('id="cta-squares-lens-cutout"'), 'Must remove fragile SVG mask definition');
    assert.ok(!currentPixelLabContent.includes('cta-squares-lens-cutout'), 'Public squares must not use broken SVG mask URL');

    // Dimensions: 10px x 10px, gap 8px, 3px radius, pure white
    assert.match(currentPixelLabContent, /w-\[10px\]\s+h-\[10px\]/, 'Square size approximately 10px');
    assert.match(currentPixelLabContent, /rounded-\[3px\]/, 'Square radius approximately 3px');
    assert.match(currentPixelLabContent, /gap-2/, 'Gap approximately 8px');
    assert.match(currentPixelLabContent, /bg-white/, 'Squares must be white');

    // Square container footprint matches 160px CTA region
    assert.match(currentPixelLabContent, /w-\[160px\]\s+h-\[44px\]/, 'Square footprint matches 160px button width');

    // 9 & 10. Independent animation timelines (not in sync, hold ranges for pauses)
    assert.match(currentPixelLabContent, /@keyframes\s+cta-square-spin-a/, 'Square A keyframe defined');
    assert.match(currentPixelLabContent, /@keyframes\s+cta-square-spin-b/, 'Square B keyframe defined');
    assert.match(currentPixelLabContent, /@keyframes\s+cta-square-spin-c/, 'Square C keyframe defined');
    assert.match(currentPixelLabContent, /cta-square-spin-a\s+4\.8s/, 'Square A timeline duration 4.8s');
    assert.match(currentPixelLabContent, /cta-square-spin-b\s+6\.1s/, 'Square B timeline duration 6.1s');
    assert.match(currentPixelLabContent, /cta-square-spin-c\s+5\.4s/, 'Square C timeline duration 5.4s');

    // 11. Reduced motion disables square spinning
    assert.match(currentPixelLabContent, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, 'Must include reduced motion query');
    assert.match(currentPixelLabContent, /animation:\s*none\s*!important/, 'Squares must not animate when reduced motion preferred');

    // 12. Secret button revealed spatially via existing lens coordinates and 180x180 14px radius clipPath
    assert.match(currentPixelLabContent, /clipPath:\s*lensActive\s*\?\s*`inset\(\$\{topClip\}px\s+\$\{rightClip\}px\s+\$\{bottomClip\}px\s+\$\{leftClip\}px\s+round\s+\$\{lensRadius\}px\)`\s*:\s*'inset\(100%\)'/);

    // 13. Revealed Enter links to /negotiator?new=1
    assert.match(currentPixelLabContent, /href="\/negotiator\?new=1"/, 'Secret Enter button links to /negotiator?new=1');

    // 14. Whole lens is NOT an invisible link (lens has pointer-events-none, button has pointer-events-auto)
    assert.match(currentPixelLabContent, /pointer-events-none[\s\S]*?z-40[\s\S]*?LiquidLensSurface/, 'Liquid lens container must be pointer-events-none');

    // 15, 16, 17, 18. Perpetual deterministic pixel flicker in shader:
    // Driven by uTime, autonomous without pointer dependency, bounded cycles, non-overflowing hash
    assert.match(currentCompContent, /hash21/, 'Non-overflowing GLSL hash mapping inputs to fract first');
    assert.match(currentCompContent, /mod\(cycle,\s*10000\.0\)/, 'Bounded cycle seed prevents float precision exhaustion');
    assert.match(currentCompContent, /0\.090,\s*0\.200/, 'Colored-state flicker is ~9% (8-10% range) and lens state is ~20% (18-22% range)');
    assert.match(currentCompContent, /uEnableFlicker/, 'Shader consumes uEnableFlicker uniform');
    assert.ok(!currentCompContent.includes('setInterval'), 'Flicker must not use setInterval React churn');

    // 19. Reduced motion disables flicker
    assert.match(currentCompContent, /reducedMotionQuery\.matches[\s\S]*?uEnableFlicker\.value\s*=\s*\(!reducedMotionQuery\.matches/, 'Reduced motion turns off flicker');

    // 20. LiquidLensSurface unchanged & B.5.2 alpha fix preserved
    assert.match(currentPixelLabContent, /function\s+LiquidLensSurface/, 'LiquidLensSurface remains intact');
    assert.match(currentPixelLabContent, /premultipliedAlpha:\s*false/, 'B.5.2 straight alpha fix preserved');

    // 21, 22, 23. Production /, Agent Controller, Swap untouched
    const landingContent = fs.readFileSync(landingPagePath, 'utf8');
    const agentControllerContent = fs.readFileSync(agentControllerPath, 'utf8');
    const swapContent = fs.readFileSync(swapPath, 'utf8');

    assert.ok(!landingContent.includes('/pixel-lab'), 'Production landing must not reference /pixel-lab');
    assert.ok(!agentControllerContent.includes('LiquidLensSurface'), 'Agent Controller must remain untouched');
    assert.ok(!swapContent.includes('LiquidLensSurface'), 'Swap must remain untouched');
  });

  it('28. B.8 Promotion: Production landing / renders approved pixel-lab experience with 160x44px RainbowButton, tuned inner edge, and zero debug UI', () => {
    const currentLandingContent = fs.readFileSync(landingPagePath, 'utf8');
    const currentCompContent = fs.readFileSync(componentPath, 'utf8');
    const rainbowButtonPath = path.join(process.cwd(), 'src', 'components', 'ui', 'rainbow-button.tsx');
    const currentRainbowContent = fs.readFileSync(rainbowButtonPath, 'utf8');
    const liquidLensCompPath = path.join(process.cwd(), 'src', 'components', 'landing', 'LiquidLensSurface.tsx');
    const currentLiquidLensContent = fs.readFileSync(liquidLensCompPath, 'utf8');

    // 1. Production / uses the approved pixel artwork system
    assert.match(currentLandingContent, /<InteractivePixelArtwork/);
    assert.match(currentLandingContent, /artworkScale=\{1\.60\}/);
    assert.match(currentLandingContent, /preservePixelSize=\{true\}/);
    assert.match(currentLandingContent, /transparentBackground=\{true\}/);
    assert.match(currentLandingContent, /colorMode=["']original-color["']/);
    assert.match(currentLandingContent, /enableFlicker=\{true\}/);

    // 2. /03.png is the artwork source
    assert.match(currentCompContent, /REFERENCE_IMAGE_SRC\s*=\s*['"]\/03\.png['"]/);

    // 3. Old /01.jpg landing implementation is no longer active
    assert.ok(!currentLandingContent.includes('01.jpg'));
    assert.ok(!currentLandingContent.includes('02.jpg'));
    assert.ok(!currentLandingContent.includes('InteractiveGlassGrid'));

    // 4. Production contains approved Synq typography composition (Press_Start_2P, z-10 glow, z-30 outline, z-35 displaced)
    assert.match(currentLandingContent, /Press_Start_2P/);
    assert.match(currentLandingContent, /clamp\(108px,\s*18vw,\s*288px\)/);
    assert.match(currentLandingContent, /WebkitTextStroke:\s*['"]0\.75px rgba\(255, 255, 255, 0\.82\)['"]/);
    assert.match(currentLandingContent, /id=["']synq-liquid-displacement["']/);

    // 5. LiquidLensSurface exists on production
    assert.match(currentLandingContent, /<LiquidLensSurface/);

    // 6, 7, 8. Lens remains 180x180, radius 14px, transparent center
    assert.match(currentLandingContent, /lensSize\s*=\s*180/);
    assert.match(currentLandingContent, /lensRadius\s*=\s*14/);
    assert.match(currentLandingContent, /rounded-\[14px\]/);
    assert.ok(!currentLandingContent.includes('bg-white/5'), 'Lens must not have translucent white card fill');
    assert.ok(!currentLandingContent.includes('bg-white/10'), 'Lens must not have translucent white card fill');

    // 9. Stronger inner white edge exists (inset 1px 1.5px 3.5px 0px rgba(255, 255, 255, 0.14) and 0.09)
    assert.match(currentLandingContent, /rgba\(255,\s*255,\s*255,\s*0\.14\)/);
    assert.match(currentLandingContent, /rgba\(255,\s*255,\s*255,\s*0\.09\)/);

    // 10, 11, 12. No lens outer border, outer shadow, or backdrop blur
    assert.ok(!currentLandingContent.includes('border-white/20'), 'Lens must not have border');
    assert.ok(!currentLandingContent.includes('ring-1 ring-inset'), 'Lens must not have ring');
    assert.ok(!currentLandingContent.includes('backdrop-blur'), 'Lens must not have backdrop blur');

    // 13. B.5.2 straight-alpha fix remains
    assert.match(currentLiquidLensContent, /premultipliedAlpha:\s*false/);
    assert.match(currentLiquidLensContent, /gl\.blendFunc\(gl\.SRC_ALPHA,\s*gl\.ONE_MINUS_SRC_ALPHA\)/);

    // 14, 15, 16. Permanent time-driven flicker remains, colored flicker increased (~9%), lens flicker stronger (~20%)
    assert.match(currentCompContent, /0\.090,\s*0\.200/);
    assert.match(currentCompContent, /lensBrightMod/);

    // 17, 18. Three-square public indicator exists with independent animations
    assert.match(currentLandingContent, /cta-square-a/);
    assert.match(currentLandingContent, /cta-square-b/);
    assert.match(currentLandingContent, /cta-square-c/);
    assert.match(currentLandingContent, /cta-square-spin-a\s+4\.8s/);
    assert.match(currentLandingContent, /cta-square-spin-b\s+6\.1s/);
    assert.match(currentLandingContent, /cta-square-spin-c\s+5\.4s/);

    // 19. Secret CTA reveal remains lens-clipped
    assert.match(currentLandingContent, /clipPath:\s*lensActive\s*\?\s*`inset\(/);

    // 20, 21, 22, 23. Enter width = 160px, height = 44px, no arrow, href = /negotiator?new=1
    assert.match(currentRainbowContent, /w-\[160px\]/);
    assert.match(currentRainbowContent, /min-w-\[160px\]/);
    assert.match(currentRainbowContent, /h-\[44px\]/);
    assert.match(currentLandingContent, /w-\[160px\]\s+h-\[44px\]/);
    assert.match(currentLandingContent, /href="\/negotiator\?new=1"/);
    assert.ok(!currentLandingContent.includes('ArrowRight'));

    // 24. RainbowButton retains white surface and internal rainbow
    assert.match(currentRainbowContent, /bg-white/);
    assert.match(currentRainbowContent, /text-\[#242424\]/);
    assert.match(currentRainbowContent, /opacity-90/);

    // 25, 26. Debug HUD and diagnostic controls do NOT render on production /
    assert.ok(!currentLandingContent.includes('Diagnostic HUD'));
    assert.ok(!currentLandingContent.includes('Pixel Lab'));
    assert.ok(!currentLandingContent.includes('Mode A'));
    assert.ok(!currentLandingContent.includes('Mode B'));
    assert.ok(!currentLandingContent.includes('activeMode'));

    // 27. Wallet/app shell remains intact (landing logo removed in B.9)
    assert.match(currentLandingContent, /<WalletStatus/);
    assert.ok(!currentLandingContent.includes('src="/logo.jpg"'), 'Landing top-left logo must be removed');

    // 28. Reduced motion support remains
    assert.match(currentLandingContent, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);

    // 29, 30. Agent Controller and Swap untouched
    const agentDiff = execSync(`git status --short src/app/agent-controller/page.tsx`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.equal(agentDiff, '', 'src/app/agent-controller/page.tsx must not have any git changes');

    const swapDiff = execSync(`git status --short src/app/swap/page.tsx`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.equal(swapDiff, '', 'src/app/swap/page.tsx must not have any git changes');
  });

  it('29. B.8.2 Lifecycle & Scaling: No forceContextLoss, key-guarded canvas instance, async texture cancellation cleanup, and 1.60x immersive hero scale', () => {
    const currentCompContent = fs.readFileSync(componentPath, 'utf8');
    const currentLandingContent = fs.readFileSync(landingPagePath, 'utf8');
    const currentPixelLabContent = fs.readFileSync(pixelLabRoutePath, 'utf8');

    // 1. Zero forceContextLoss or artificial context destruction in InteractivePixelArtwork
    assert.ok(!currentCompContent.includes('forceContextLoss'), 'Must not call forceContextLoss');
    assert.ok(!currentCompContent.includes('WEBGL_lose_context'), 'Must not acquire or call WEBGL_lose_context');
    assert.ok(!currentCompContent.includes('loseContext()'), 'Must not invoke loseContext');

    // 2. Each mount owns its own unique canvas key to prevent stale context reuse across route transitions
    assert.match(currentCompContent, /<canvas\s+key=\{instanceId\}\s+ref=\{canvasRef\}/, 'Canvas must be keyed by instanceId');

    // 3. Temporary development diagnostics with incrementing IPA #ID exist
    assert.match(currentCompContent, /\[IPA\s+#\$\{id\}\]\s+MOUNT/, 'Must log MOUNT diagnostic');
    assert.match(currentCompContent, /\[IPA\s+#\$\{id\}\]\s+renderer\s+create\s+begin/, 'Must log renderer create begin');
    assert.match(currentCompContent, /\[IPA\s+#\$\{id\}\]\s+renderer\s+create\s+success/, 'Must log renderer create success');
    assert.match(currentCompContent, /\[IPA\s+#\$\{id\}\]\s+CLEANUP/, 'Must log CLEANUP diagnostic');
    assert.match(currentCompContent, /\[IPA\s+#\$\{id\}\]\s+renderer\s+disposed/, 'Must log renderer disposed');
    assert.match(currentCompContent, /webglcontextlost/, 'Must listen to webglcontextlost');
    assert.match(currentCompContent, /webglcontextrestored/, 'Must listen to webglcontextrestored');

    // 4. Async texture load callback verifies mount is alive and disposes abandoned textures
    assert.match(currentCompContent, /if\s*\(destroyed\)\s*\{\s*texture\.dispose\(\);\s*return;\s*\}/, 'Abandoned texture must be disposed if component unmounted');

    // 5. Immersive hero scale: 1.60x artworkScale with corresponding clamp(108px, 18vw, 288px) typography
    assert.match(currentLandingContent, /artworkScale=\{1\.60\}/, 'Production landing hero must use 1.60x artworkScale');
    assert.match(currentLandingContent, /clamp\(108px,\s*18vw,\s*288px\)/, 'Production landing typography must use clamp(108px, 18vw, 288px)');
    assert.match(currentPixelLabContent, /artworkScale=\{1\.60\}/, 'Pixel lab must use 1.60x artworkScale');
    assert.match(currentPixelLabContent, /clamp\(108px,\s*18vw,\s*288px\)/, 'Pixel lab typography must use clamp(108px, 18vw, 288px)');

    // 6. LiquidLensSurface remains 180x180 and CTA remains 160x44 (unaffected by hero scale)
    assert.match(currentLandingContent, /lensSize\s*=\s*180/);
    assert.match(currentLandingContent, /lensRadius\s*=\s*14/);
    assert.match(currentLandingContent, /w-\[160px\]\s+h-\[44px\]/);
  });

  it('30. B.9 Landing & Global Wallet UI: Landing logo removed, centered CTA footprint, white/charcoal shared wallet capsule, and portal dropdown stacking', () => {
    const currentLandingContent = fs.readFileSync(landingPagePath, 'utf8');
    const currentPixelLabContent = fs.readFileSync(pixelLabRoutePath, 'utf8');
    const rainbowButtonPath = path.join(process.cwd(), 'src', 'components', 'ui', 'rainbow-button.tsx');
    const currentRainbowContent = fs.readFileSync(rainbowButtonPath, 'utf8');
    const walletStatusPath = path.join(process.cwd(), 'src', 'components', 'layout', 'WalletStatus.tsx');
    const currentWalletContent = fs.readFileSync(walletStatusPath, 'utf8');
    const sidebarPath = path.join(process.cwd(), 'src', 'components', 'layout', 'Sidebar.tsx');
    const currentSidebarContent = fs.readFileSync(sidebarPath, 'utf8');

    // 1. Production landing logo removed, but sidebar brand mark preserved
    assert.ok(!currentLandingContent.includes('src="/logo.jpg"'), 'Production landing top-left logo must be removed');
    assert.match(currentSidebarContent, /\/synq-logo\.png/, 'Sidebar brand logo must remain intact');

    // 2. Centered CTA on landing: Layer 5.5 public indicator and Layer 6 secret Enter occupy identical centered coordinates
    assert.match(currentLandingContent, /bottom-7\s+md:bottom-9\s+left-1\/2\s+-translate-x-1\/2\s+w-\[160px\]\s+h-\[44px\]\s+flex\s+items-center\s+justify-center/, 'Public indicator container must be centered at bottom-7 md:bottom-9 left-1/2 -translate-x-1/2');
    assert.match(currentLandingContent, /bottom-7\s+md:bottom-9\s+left-1\/2\s+-translate-x-1\/2\s+w-\[160px\]\s+h-\[44px\]\s+pointer-events-auto/, 'Secret Enter container must be centered at bottom-7 md:bottom-9 left-1/2 -translate-x-1/2');
    assert.match(currentPixelLabContent, /bottom-7\s+md:bottom-9\s+left-1\/2\s+-translate-x-1\/2\s+w-\[160px\]\s+h-\[44px\]/, 'Pixel lab CTA must maintain identical centered footprint');

    // 3. CTA dimensions and style preserved (160x44, Press_Start_2P, text #242424, /negotiator?new=1)
    assert.match(currentRainbowContent, /w-\[160px\]\s+min-w-\[160px\]/, 'RainbowButton width 160px');
    assert.match(currentRainbowContent, /h-\[44px\]/, 'RainbowButton height 44px');
    assert.match(currentLandingContent, /Press_Start_2P/);
    assert.match(currentLandingContent, /text-\[#242424\]/);
    assert.match(currentLandingContent, /href="\/negotiator\?new=1"/);

    // 4. Shared WalletStatus capsule: White #FFFFFF background, charcoal #242424 text, divider, chevron
    assert.match(currentWalletContent, /bg-\[#FFFFFF\]/, 'Capsule button background must be pure white #FFFFFF');
    assert.match(currentWalletContent, /text-\[#242424\]\s+font-medium/, 'Balance text must be charcoal #242424');
    assert.match(currentWalletContent, /text-\[#242424\]\s+font-semibold/, 'Username text must be charcoal #242424');
    assert.match(currentWalletContent, /text-\[#242424\]\/30/, 'Divider must use matching charcoal #242424 with restrained opacity');
    assert.match(currentWalletContent, /text-\[#242424\]\/70/, 'ChevronDown must use matching charcoal #242424 with restrained opacity');
    assert.ok(!currentWalletContent.includes("text-blue-400 font-mono"), 'Capsule button must not contain leftover blue username styling');

    // 5. Dropdown stacking: Uses createPortal(..., document.body) with z-[100] backdrop and z-[101] dropdown
    assert.match(currentWalletContent, /import\s*\{\s*createPortal\s*\}\s*from\s*['"]react-dom['"]/, 'Must import createPortal from react-dom');
    assert.match(currentWalletContent, /createPortal\([\s\S]*?document\.body\s*\)/, 'Must render dropdown inside document.body portal');
    assert.match(currentWalletContent, /z-\[100\]/, 'Backdrop must have z-[100]');
    assert.match(currentWalletContent, /z-\[101\]/, 'Dropdown panel must have z-[101]');
    assert.match(currentLandingContent, /top-6\s+right-6[\s\S]*?z-50/, 'Landing wallet container must be elevated to z-50');

    // 6. Dropdown dynamic anchoring, resize, scroll, and escape key behavior
    assert.match(currentWalletContent, /updateDropdownPos/, 'Must calculate dynamic dropdown position');
    assert.match(currentWalletContent, /window\.addEventListener\('resize',\s*updateDropdownPos\)/, 'Must track window resize');
    assert.match(currentWalletContent, /window\.addEventListener\('scroll',\s*updateDropdownPos,\s*true\)/, 'Must track window scroll');
    assert.match(currentWalletContent, /e\.key\s*===\s*'Escape'/, 'Must close dropdown on Escape key');

    // 7. Wallet connection logic & hooks remain untouched
    assert.match(currentWalletContent, /useAccount/);
    assert.match(currentWalletContent, /useConnect/);
    assert.match(currentWalletContent, /useDisconnect/);
    assert.match(currentWalletContent, /useBalance/);
    assert.match(currentWalletContent, /useSepoliaNetwork/);

    // 8. Agent Controller and Swap untouched
    const agentDiff = execSync(`git status --short src/app/agent-controller/page.tsx`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.equal(agentDiff, '', 'src/app/agent-controller/page.tsx must not have any git changes');

    const swapDiff = execSync(`git status --short src/app/swap/page.tsx`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.equal(swapDiff, '', 'src/app/swap/page.tsx must not have any git changes');
  });

  it('31. B.10: Wallet dropdown repair (portal wraps AnimatePresence), complete white/charcoal capsule states, and landing four-cube secret wallet reveal', () => {
    const currentLandingContent = fs.readFileSync(landingPagePath, 'utf8');
    const walletStatusPath = path.join(process.cwd(), 'src', 'components', 'layout', 'WalletStatus.tsx');
    const currentWalletContent = fs.readFileSync(walletStatusPath, 'utf8');
    const appLayoutPath = path.join(process.cwd(), 'src', 'components', 'layout', 'AppLayout.tsx');
    const currentAppLayoutContent = fs.readFileSync(appLayoutPath, 'utf8');

    // 1. Dropdown repair: createPortal wraps AnimatePresence so portal is not discarded by React.isValidElement
    assert.match(currentWalletContent, /createPortal\(\s*<AnimatePresence>/, 'createPortal must wrap AnimatePresence directly');
    assert.match(currentWalletContent, /key="wallet-dropdown-portal-root"/, 'Direct child inside AnimatePresence must have key prop');
    assert.match(currentWalletContent, /key="wallet-dropdown-backdrop"/, 'Backdrop element inside portal must have unique key');
    assert.match(currentWalletContent, /key="wallet-dropdown-panel"/, 'Motion dropdown panel must have unique key');

    // 2. All capsule states audited and styled with white #FFFFFF background and #242424 charcoal:
    // Disconnected state
    assert.match(currentWalletContent, /Connect Wallet/);
    assert.match(currentWalletContent, /bg-\[#FFFFFF\]\s+text-\[#242424\][\s\S]*?Connect Wallet/, 'Disconnected button must use white capsule with charcoal text');
    assert.ok(!currentWalletContent.includes('bg-blue-600 text-white'), 'Old blue disconnected button must be completely retired');
    // Wrong network state retains white capsule
    assert.match(currentWalletContent, /bg-amber-500 shrink-0[\s\S]*?Wrong Network/, 'Wrong network must use restrained amber indicator inside white capsule');
    assert.ok(!currentWalletContent.includes('bg-amber-50/90 border-amber-300 text-amber-800'), 'Wrong network must not use old full amber card fill');

    // 3. Landing four-cube secret wallet concealment:
    assert.match(currentLandingContent, /wallet-square-a/, 'Square A must exist');
    assert.match(currentLandingContent, /wallet-square-b/, 'Square B must exist');
    assert.match(currentLandingContent, /wallet-square-c/, 'Square C must exist');
    assert.match(currentLandingContent, /wallet-square-d/, 'Square D must exist');
    assert.match(currentLandingContent, /w-\[10px\]\s+h-\[10px\]\s+rounded-\[3px\]\s+bg-white/, 'Four cubes must be 10x10px, 3px radius, pure white');
    assert.match(currentLandingContent, /gap-2/, 'Four cubes gap must be 8px');

    // 4. Four independent animation timelines never rotating in sync:
    assert.match(currentLandingContent, /@keyframes\s+wallet-square-spin-a/);
    assert.match(currentLandingContent, /@keyframes\s+wallet-square-spin-b/);
    assert.match(currentLandingContent, /@keyframes\s+wallet-square-spin-c/);
    assert.match(currentLandingContent, /@keyframes\s+wallet-square-spin-d/);
    assert.match(currentLandingContent, /wallet-square-spin-a\s+5\.1s/);
    assert.match(currentLandingContent, /wallet-square-spin-b\s+6\.7s/);
    assert.match(currentLandingContent, /wallet-square-spin-c\s+4\.5s/);
    assert.match(currentLandingContent, /wallet-square-spin-d\s+5\.8s/);
    assert.match(currentLandingContent, /\.wallet-square-a[\s\S]*?animation:\s*none\s*!important/, 'Reduced motion must disable wallet square animations');

    // 5. Secret wallet lens reveal and suspension when dropdown is open:
    assert.match(currentLandingContent, /clipPath:\s*walletDropdownOpen\s*\?\s*['"]none['"]\s*:\s*lensActive\s*\?\s*`inset\(/, 'Lens reveals wallet capsule when closed, and suspends clipping when dropdown is open');
    assert.match(currentLandingContent, /!walletDropdownOpen\s*&&\s*\(/, 'Four-cube indicator is suspended when dropdown is open');
    assert.match(currentLandingContent, /<WalletStatus\s+onOpenChange=\{setWalletDropdownOpen\}\s*\/>/, 'Landing must pass onOpenChange to WalletStatus');

    // 6. Internal pages show normal wallet capsule without cubes:
    assert.ok(!currentAppLayoutContent.includes('wallet-square'), 'Internal pages AppLayout must not render cubes');
    assert.match(currentAppLayoutContent, /<WalletStatus\s*\/>/, 'Internal pages AppLayout renders standard WalletStatus');

    // 7. Protected routes remain untouched
    const agentDiff = execSync(`git status --short src/app/agent-controller/page.tsx`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.equal(agentDiff, '', 'src/app/agent-controller/page.tsx must not have any git changes');

    const swapDiff = execSync(`git status --short src/app/swap/page.tsx`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.equal(swapDiff, '', 'src/app/swap/page.tsx must not have any git changes');
  });

  it('32. B.10.1: Six-cube wallet indicator with independent animations and wallet connection modal stacking repair in document.body portal', () => {
    const currentLandingContent = fs.readFileSync(landingPagePath, 'utf8');
    const walletStatusPath = path.join(process.cwd(), 'src', 'components', 'layout', 'WalletStatus.tsx');
    const currentWalletContent = fs.readFileSync(walletStatusPath, 'utf8');
    const appLayoutPath = path.join(process.cwd(), 'src', 'components', 'layout', 'AppLayout.tsx');
    const currentAppLayoutContent = fs.readFileSync(appLayoutPath, 'utf8');

    // 1. Landing wallet indicator changed from 4 cubes to exactly SIX white 10x10px cubes with 3px rounded corners
    assert.match(currentLandingContent, /wallet-square-a/, 'Square A must exist');
    assert.match(currentLandingContent, /wallet-square-b/, 'Square B must exist');
    assert.match(currentLandingContent, /wallet-square-c/, 'Square C must exist');
    assert.match(currentLandingContent, /wallet-square-d/, 'Square D must exist');
    assert.match(currentLandingContent, /wallet-square-e/, 'Square E must exist');
    assert.match(currentLandingContent, /wallet-square-f/, 'Square F must exist');

    const walletSquareMatches = currentLandingContent.match(/wallet-square-[a-z]/g) || [];
    // Keyframes, classes, reduced motion, and JSX elements: JSX elements should have all 6
    const jsxWalletSquareMatches = currentLandingContent.match(/className="wallet-square-[a-z]\s+w-\[10px\]\s+h-\[10px\]\s+rounded-\[3px\]\s+bg-white/g) || [];
    assert.equal(jsxWalletSquareMatches.length, 6, 'Must render exactly six wallet cubes in JSX');

    // 2. Arrangement: Horizontal row with 8px spacing (gap-2), centered in existing wallet trigger footprint
    assert.match(currentLandingContent, /gap-2/, 'Cubes spacing must be 8px (gap-2)');
    assert.match(currentLandingContent, /top-6\s+right-6\s+md:top-8\s+md:right-10\s+z-20\s+pointer-events-none\s+select-none\s+h-10\s+px-4\s+flex\s+items-center\s+justify-center/, 'Indicator group must be centered in wallet trigger footprint');

    // 3. Six independently staggered smooth rotation/pause animations with distinct durations
    assert.match(currentLandingContent, /@keyframes\s+wallet-square-spin-a/);
    assert.match(currentLandingContent, /@keyframes\s+wallet-square-spin-b/);
    assert.match(currentLandingContent, /@keyframes\s+wallet-square-spin-c/);
    assert.match(currentLandingContent, /@keyframes\s+wallet-square-spin-d/);
    assert.match(currentLandingContent, /@keyframes\s+wallet-square-spin-e/);
    assert.match(currentLandingContent, /@keyframes\s+wallet-square-spin-f/);
    assert.match(currentLandingContent, /wallet-square-spin-a\s+5\.1s/);
    assert.match(currentLandingContent, /wallet-square-spin-b\s+6\.7s/);
    assert.match(currentLandingContent, /wallet-square-spin-c\s+4\.5s/);
    assert.match(currentLandingContent, /wallet-square-spin-d\s+5\.8s/);
    assert.match(currentLandingContent, /wallet-square-spin-e\s+6\.3s/);
    assert.match(currentLandingContent, /wallet-square-spin-f\s+4\.9s/);

    // 4. prefers-reduced-motion disables all six wallet square animations
    assert.match(currentLandingContent, /\.wallet-square-e/);
    assert.match(currentLandingContent, /\.wallet-square-f/);
    assert.match(currentLandingContent, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.wallet-square-f[\s\S]*?animation:\s*none\s*!important/);

    // 5. Enter indicator remains strictly THREE cubes (unchanged)
    const ctaMatches = currentLandingContent.match(/className="cta-square-[a-z]\s+w-\[10px\]\s+h-\[10px\]/g) || [];
    assert.equal(ctaMatches.length, 3, 'Enter CTA indicator must remain strictly three cubes');

    // 6. Modal Stacking Fix: Wallet connection modal portaled into document.body
    assert.match(currentWalletContent, /createPortal\(\s*<AnimatePresence>[\s\S]*?showModal\s*&&/, 'showModal must be rendered inside document.body portal');
    assert.match(currentWalletContent, /key="wallet-modal-portal-root"/, 'Modal portal root must have unique key');
    assert.match(currentWalletContent, /key="wallet-modal-backdrop"/, 'Modal backdrop must have unique key');
    assert.match(currentWalletContent, /key="wallet-modal-panel"/, 'Modal panel must have unique key');

    // 7. Stacking hierarchy: Modal overlay has z-[100] and modal dialog panel has z-[101] (above all landing layers)
    assert.match(currentWalletContent, /key="wallet-modal-backdrop"[\s\S]*?z-\[100\]/, 'Modal backdrop must have z-[100]');
    assert.match(currentWalletContent, /key="wallet-modal-panel"[\s\S]*?z-\[101\]/, 'Modal panel must have z-[101]');

    // 8. Pointer events and Escape keyboard interaction preserved on modal
    assert.match(currentWalletContent, /handleOpenModal/, 'Must have handleOpenModal callback');
    assert.match(currentWalletContent, /handleCloseModal/, 'Must have handleCloseModal callback');
    assert.match(currentWalletContent, /if\s*\(!showModal\)\s*return;[\s\S]*?e\.key\s*===\s*'Escape'[\s\S]*?handleCloseModal\(\)/, 'Must dismiss modal on Escape key');

    // 9. Lens suspension while modal or dropdown is active
    assert.match(currentLandingContent, /if\s*\(walletDropdownOpen\)\s*return;/, 'Pointer tracking must be suspended while modal/dropdown is open');
    assert.match(currentLandingContent, /targetPosRef\.current\.active\s*=\s*false;\s*setLensActive\(false\);/, 'Lens must be deactivated when modal/dropdown is open');

    // 10. Connected wallet dropdown remains working in document.body portal
    assert.match(currentWalletContent, /key="wallet-dropdown-portal-root"/);
    assert.match(currentWalletContent, /key="wallet-dropdown-backdrop"/);
    assert.match(currentWalletContent, /key="wallet-dropdown-panel"/);

    // 11. Internal pages retain normal wallet capsule without cubes
    assert.ok(!currentAppLayoutContent.includes('wallet-square'), 'Internal pages AppLayout must not render cubes');
    assert.match(currentAppLayoutContent, /<WalletStatus\s*\/>/, 'Internal pages AppLayout renders standard WalletStatus');

    // 12. Protected routes remain untouched
    const agentDiff = execSync(`git status --short src/app/agent-controller/page.tsx`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.equal(agentDiff, '', 'src/app/agent-controller/page.tsx must not have any git changes');

    const swapDiff = execSync(`git status --short src/app/swap/page.tsx`, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    assert.equal(swapDiff, '', 'src/app/swap/page.tsx must not have any git changes');
  });
});



