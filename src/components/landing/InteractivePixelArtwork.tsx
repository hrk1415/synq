'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { LANDING_INTRO_TIMING, LANDING_EXIT_TIMING } from './landing-intro-constants';

interface InteractivePixelArtworkProps {
  className?: string;
  debug?: boolean;
  artworkScale?: number;
  preservePixelSize?: boolean;
  transparentBackground?: boolean;
  colorMode?: 'monochrome-reveal' | 'original-color';
  disableLiquid?: boolean;
  enableFlicker?: boolean;
  lensActive?: boolean;
  lensX?: number;
  lensY?: number;
  lensSize?: number;
  lensRadius?: number;
  enableIntro?: boolean;
  introStartTime?: number;
  exitActive?: boolean;
  exitStartTime?: number;
}

// Master reference image: transparent PNG cutout of Creation of Adam hands
const REFERENCE_IMAGE_SRC = '/03.png';
const TEXTURE_WIDTH = 666;
const TEXTURE_HEIGHT = 374;
const ASPECT_RATIO = TEXTURE_WIDTH / TEXTURE_HEIGHT; // ≈ 1.780748

// Base grid density: 240 columns x 135 rows = 32,400 GPU sample points
const DESKTOP_COLS = 240;
const DESKTOP_ROWS = 135;
const MOBILE_COLS = 160;
const MOBILE_ROWS = 90;

// Base pixel size
const DEFAULT_DESKTOP_POINT_SIZE = 7.0; // 6.5–8.0 CSS px target (deliberate digital square mosaic tiles)

// Phase 7 Liquid Simulation Resolution (Low-res for maximum 60fps performance)
const SIM_WIDTH = 256;
const SIM_HEIGHT = 144;
const INJECTION_RADIUS_CSS = 70.0; // Phase 7.2: Substantially wider injection radius in CSS px (70px)
const LIQUID_DECAY_RATE = 0.983; // Decay per frame (~1.0-1.2s persistence at 60fps)

// Fullscreen Quad Vertex Shader for Ping-Pong Liquid Simulation
const SIM_VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Ping-Pong Liquid Simulation Fragment Shader
// Combines primary droplet injection, bounded intermediate trail stamps, subtle advection, diffusion, and decay
const SIM_FRAGMENT_SHADER = `
  uniform sampler2D uPrevField;
  uniform vec2 uPointer;
  uniform vec2 uPrevPointer;
  uniform float uTrailSamples;
  uniform vec2 uVelocity;
  uniform float uPointerActive;
  uniform float uAspect;
  uniform float uRadius;
  uniform float uDecay;
  uniform float uTime;
  uniform vec2 uTexelSize;

  varying vec2 vUv;

  // Lightweight 2D procedural noise for organic fluid boundary
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  void main() {
    // 1. Directional Advection: subtle trailing flow along pointer velocity
    // Bounded flow offset to prevent stale velocity or fast motions from shooting streaks
    vec2 flowOffset = -clamp(uVelocity * 0.035, vec2(-0.015), vec2(0.015));
    float n = noise(vUv * 7.0 + uTime * 0.4);
    vec2 curl = vec2(sin(n * 6.28), cos(n * 6.28)) * 0.0015;
    vec2 sampleUv = clamp(vUv + flowOffset + curl, 0.0, 1.0);

    // 2. Diffusion: 4-neighborhood blur
    vec4 prev = texture2D(uPrevField, sampleUv);
    vec4 nUp = texture2D(uPrevField, clamp(sampleUv + vec2(0.0, uTexelSize.y), 0.0, 1.0));
    vec4 nDown = texture2D(uPrevField, clamp(sampleUv - vec2(0.0, uTexelSize.y), 0.0, 1.0));
    vec4 nLeft = texture2D(uPrevField, clamp(sampleUv - vec2(uTexelSize.x, 0.0), 0.0, 1.0));
    vec4 nRight = texture2D(uPrevField, clamp(sampleUv + vec2(uTexelSize.x, 0.0), 0.0, 1.0));
    vec4 diffused = mix(prev, (nUp + nDown + nLeft + nRight) * 0.25, 0.20);

    // 3. Natural liquid dissipation decay
    float energy = diffused.r * uDecay;

    // 4. Cursor Injection: Primary Organic Droplet Head + Bounded Interpolated Trail Stamps
    if (uPointerActive > 0.5) {
      // --- A. Primary Droplet Head at Current Pointer ---
      vec2 headDiff = vUv - uPointer;
      headDiff.x *= uAspect;
      float headDist = length(headDiff);

      // Organic wobbling boundary: soft, irregular, rounded droplet
      float headNoise = (noise(vUv * 12.0 - uTime * 1.2) - 0.5) * 0.35;
      float headRadius = max(uRadius * (1.0 + headNoise), 0.005);

      // Strong center (innerFactor 0.20), soft organic droplet falloff
      float headInjection = smoothstep(headRadius, headRadius * 0.20, headDist);

      // --- B. Trail Continuity via Bounded Intermediate Droplet Stamps ---
      float trailEnergy = 0.0;
      const int MAX_TRAIL_SAMPLES = 6;

      for (int i = 1; i <= MAX_TRAIL_SAMPLES; i++) {
        if (float(i) > uTrailSamples) break;

        // Interpolate along path from previous to current pointer
        float t = float(i) / (uTrailSamples + 1.0);
        vec2 samplePos = mix(uPrevPointer, uPointer, t);

        vec2 sampleDiff = vUv - samplePos;
        sampleDiff.x *= uAspect;
        float sampleDist = length(sampleDiff);

        // Trail radius taper: older samples slightly smaller (~75% to ~95% of head)
        float radiusScale = mix(0.75, 0.95, t);

        // Restrained organic variation per sample using index & noise
        float sampleNoise = (noise(vUv * 12.0 + float(i) * 1.7 - uTime * 1.0) - 0.5) * 0.30;
        float sampleRadius = max(uRadius * radiusScale * (1.0 + sampleNoise), 0.005);

        float stamp = smoothstep(sampleRadius, sampleRadius * 0.20, sampleDist);

        // Trail strength taper: older stamps are weaker (~0.45 to ~0.78), head remains dominant
        float stampStrength = mix(0.45, 0.78, t);
        trailEnergy = max(trailEnergy, stamp * stampStrength);
      }

      // Combine head and trail impressions
      float totalInjection = max(headInjection, trailEnergy);
      energy = max(energy, totalInjection * 0.98);
    }

    gl_FragColor = vec4(clamp(energy, 0.0, 1.0), 0.0, 0.0, 1.0);
  }
`;

// Base Artwork Shaders: Horizontal programmatic separation for intro entrance
const BASE_VERTEX_SHADER = `
  uniform float uPointSize;
  uniform float uPixelRatio;
  uniform float uLeftHandOffset;
  uniform float uRightHandOffset;

  varying vec2 vUv;

  void main() {
    vUv = uv;

    vec3 pos = position;
    if (uv.x < 0.492) {
      pos.x += uLeftHandOffset;
    } else {
      pos.x += uRightHandOffset;
    }

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = uPointSize * uPixelRatio;
  }
`;

const BASE_FRAGMENT_SHADER = `
  uniform sampler2D uTexture;
  uniform sampler2D uLiquidTexture;
  uniform float uTextureLoaded;
  uniform float uDebugMode; // 0=normal reveal, 1=show liquid field, 2=full original, 3=full mono
  uniform float uOriginalColor; // 1.0 = direct original RGB output, 0.0 = monochrome + liquid reveal
  uniform float uTextureFade; // late-loading catch-up fade multiplier (0.0 to 1.0)

  uniform float uTime;
  uniform float uEnableFlicker;
  uniform float uLensActive;
  uniform vec2 uLensCenter; // in CSS pixels relative to container center
  uniform vec2 uLensHalfSize; // in CSS pixels
  uniform float uLensRadius; // in CSS pixels
  uniform vec2 uArtworkDimensions; // in CSS pixels (artworkWidth, artworkHeight)

  varying vec2 vUv;

  float hash1(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float hash2(vec2 p) {
    p = fract(p * vec2(234.56, 789.01));
    p += dot(p, p + 67.89);
    return fract(p.x * p.y);
  }

  // Non-overflowing GLSL hash mapping inputs to fract first, preserving precision for perpetual time
  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float vNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash1(i);
    float b = hash1(i + vec2(1.0, 0.0));
    float c = hash1(i + vec2(0.0, 1.0));
    float d = hash1(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  vec2 getViscousRefraction(vec2 worldPos, vec2 lensCenter, vec2 lensHalfSize, float time) {
    vec2 p = (worldPos - lensCenter) / lensHalfSize;
    float r = length(p);

    // 1. Subtle imperfect non-linear magnifying lens curvature (center expansion, adjacent compression)
    float lensCurvature = (1.0 - clamp(r * 0.50, 0.0, 0.85));
    vec2 lensBulge = -p * lensCurvature;

    // 2. Multi-frequency viscous liquid noise layers drifting slowly
    float n1 = vNoise(p * 2.2 + vec2(time * 0.16, time * 0.11));
    float n2 = vNoise(p * 3.7 - vec2(time * 0.13, -time * 0.15));
    float n3 = vNoise(p * 5.4 + vec2(time * 0.09, time * 0.20));

    vec2 viscousFlow = vec2(
      (n1 - 0.5) * 1.25 + (n2 - 0.5) * 0.75,
      (n2 - 0.5) * 1.25 + (n3 - 0.5) * 0.75
    );

    // Imperfect optical lens: non-linear expansion/compression modulated organically + viscous lateral flow
    // Non-uniform distortion: some areas expand, adjacent areas compress, pulled sideways by liquid
    vec2 imperfectMagnifier = lensBulge * (0.35 + (n1 - 0.5) * 0.35) + viscousFlow * 0.65;
    return imperfectMagnifier;
  }

  float roundedBoxSDF(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + vec2(r);
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  }

  void main() {
    if (uTextureLoaded < 0.5) {
      discard;
    }

    vec4 texColor = texture2D(uTexture, vUv);

    // PNG Alpha threshold: discard transparent background pixels
    if (texColor.a < 0.08) {
      discard;
    }

    // Direct original RGB bypass (Experiment B: Layered Colored Hands + Lens Transformation)
    if (uOriginalColor > 0.5) {
      // Calculate lens geometry
      float lensMask = 0.0;
      vec2 sampleUv = vUv;
      float alphaOut = texColor.a;

      if (uLensActive > 0.5) {
        vec2 pointWorldPos = (vUv - 0.5) * uArtworkDimensions;
        float dist = roundedBoxSDF(pointWorldPos - uLensCenter, uLensHalfSize, uLensRadius);
        lensMask = 1.0 - smoothstep(-1.5, 1.5, dist);

        if (lensMask > 0.001) {
          // B.5.1 Imperfect liquid magnifying lens refraction (target 2-4 CSS px, strong 5-7px, peaks ~8px)
          vec2 flow = getViscousRefraction(pointWorldPos, uLensCenter, uLensHalfSize, uTime);
          vec2 flowOffsetCss = flow * 4.2;

          // Subtle irregular optical meniscus deflection near outer lens boundary
          float rimFactor = smoothstep(-18.0, -2.0, dist) * (1.0 - smoothstep(-2.0, 1.0, dist));
          vec2 rimNormal = normalize(pointWorldPos - uLensCenter + vec2(0.001, 0.001));
          float rimIrreg = vNoise(pointWorldPos * 0.06 + vec2(uTime * 0.12));
          vec2 rimOffsetCss = rimNormal * rimFactor * (1.8 + rimIrreg * 1.0);

          vec2 totalDisplaceCss = (flowOffsetCss + rimOffsetCss) * lensMask;
          sampleUv = vUv + (totalDisplaceCss / uArtworkDimensions);

          vec4 refractedTex = texture2D(uTexture, sampleUv);
          if (refractedTex.a > 0.02) {
            texColor = refractedTex;
            alphaOut = refractedTex.a;
          }
        }
      }

      vec3 color = texColor.rgb;

      // 1. Base photographic monochrome inside lens
      float lum = dot(color, vec3(0.299, 0.587, 0.114));
      float monoLum = clamp((lum - 0.5) * 1.35 + 0.5, 0.0, 1.0);
      monoLum = monoLum * monoLum * (3.0 - 2.0 * monoLum); // smooth photographic S-curve
      vec3 monoColor = vec3(monoLum);

      // Mix outside (original RGB) and inside (monochrome) based on lensMask
      vec3 blendedColor = mix(color, monoColor, lensMask);

      // 2. Perpetual deterministic pseudo-random flicker (autonomous, never decays or stops while page is active)
      if (uEnableFlicker > 0.5) {
        // Stable per-pixel coordinates and seeds from discrete texture grid
        vec2 pixelCoord = floor(vUv * vec2(666.0, 374.0));
        float seed1 = hash21(pixelCoord + vec2(13.7, 71.9));
        float seed2 = hash21(pixelCoord + vec2(43.1, 29.3));
        float seed3 = hash21(pixelCoord + vec2(97.5, 53.1));

        // Individual speed per pixel (7.0 to 19.0 Hz for crisp asynchronous digital ticking)
        float speed = mix(7.0, 19.0, seed1);

        // Continuous advancing phase with individual offset
        float continuousPhase = uTime * speed + seed2 * 200.0;
        float cycle = floor(continuousPhase);
        float localPhase = fract(continuousPhase);

        // Bounded cycle seed that wraps periodically to prevent float precision exhaustion forever
        float boundedCycle = mod(cycle, 10000.0);

        // Deterministic random test for this cycle
        float cycleRand = hash21(vec2(seed1 * 100.0 + seed3 * 7.0, boundedCycle * 1.13));

        // Target active flicker probability:
        // Outside lens (colored state): ~8.5-9.5% active flicker (increased from previous ~5%)
        // Inside lens (monochrome state): ~19-21% active flicker
        float threshold = mix(0.090, 0.200, lensMask);

        if (cycleRand < threshold) {
          // Short digital pulse: active during middle fraction of the cycle window
          float pulse = smoothstep(0.0, 0.20, localPhase) * (1.0 - smoothstep(0.80, 1.0, localPhase));

          // Deterministic variations for this specific flicker event
          float variation = hash21(vec2(boundedCycle * 2.37, seed2 * 131.0));
          float baseBrightMod = mix(0.65, 1.38, variation);
          float lensBrightMod = mix(0.22, 1.90, variation);
          float targetBrightMod = mix(baseBrightMod, lensBrightMod, lensMask);
          float brightMod = mix(1.0, targetBrightMod, pulse);

          float baseSatMod = mix(0.70, 1.25, variation);
          float satMod = mix(1.0, mix(baseSatMod, 1.0, lensMask), pulse);

          float curLum = dot(blendedColor, vec3(0.299, 0.587, 0.114));
          blendedColor = clamp(mix(vec3(curLum), blendedColor, satMod) * brightMod, 0.0, 1.0);
        }
      }

      gl_FragColor = vec4(blendedColor, alphaOut * uTextureFade);
      return;
    }

    // 1. Resting Dark Monochrome transformation
    // Source luminance (0.0 to 1.0) mapped into restricted dark grayscale (0.05 to 0.38)
    // NO pure white pixels, ensuring readability on white background in future
    float lum = dot(texColor.rgb, vec3(0.299, 0.587, 0.114));
    float darkMono = 0.05 + lum * 0.33;
    vec3 monoColor = vec3(darkMono);

    // 2. Liquid Field Sample (reveals original color wherever liquid flows)
    float liquidVal = texture2D(uLiquidTexture, vUv).r;

    // 3. Reveal response: smoothstep thresholds create defined fluid body with soft borders
    float revealAmount = smoothstep(0.15, 0.65, liquidVal);

    // 4. Color mixing: crisp tiles transition seamlessly from dark mono to original RGB
    vec3 finalColor = mix(monoColor, texColor.rgb, revealAmount);

    // Debug View Overrides
    if (uDebugMode > 0.5 && uDebugMode < 1.5) {
      // View B: SHOW LIQUID FIELD (rendered visibly as grayscale on the hand points)
      finalColor = vec3(liquidVal);
    } else if (uDebugMode > 1.5 && uDebugMode < 2.5) {
      // View C: FULL ORIGINAL COLOR (bypass mono/reveal)
      finalColor = texColor.rgb;
    } else if (uDebugMode > 2.5 && uDebugMode < 3.5) {
      // View D: FULL MONOCHROME (bypass liquid, resting state)
      finalColor = monoColor;
    }

    gl_FragColor = vec4(finalColor, texColor.a * uTextureFade);
  }
`;

type DebugView = 'final' | 'field' | 'original' | 'mono';

let ipaInstanceCounter = 0;

export default function InteractivePixelArtwork({
  className = '',
  debug = false,
  artworkScale = 1.0,
  preservePixelSize = false,
  transparentBackground = false,
  colorMode = 'monochrome-reveal',
  disableLiquid = false,
  enableFlicker = false,
  lensActive = false,
  lensX = -9999,
  lensY = -9999,
  lensSize = 180,
  lensRadius = 24,
  enableIntro = false,
  introStartTime = 0,
  exitActive = false,
  exitStartTime = 0,
}: InteractivePixelArtworkProps) {
  const [instanceId] = useState(() => ++ipaInstanceCounter);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameIdRef = useRef<number | null>(null);
  const artworkScaleRef = useRef(artworkScale);
  artworkScaleRef.current = artworkScale;
  const preservePixelSizeRef = useRef(preservePixelSize);
  preservePixelSizeRef.current = preservePixelSize;
  const enableFlickerRef = useRef(enableFlicker);
  enableFlickerRef.current = enableFlicker;
  const lensActiveRef = useRef(lensActive);
  lensActiveRef.current = lensActive;
  const lensXRef = useRef(lensX);
  lensXRef.current = lensX;
  const lensYRef = useRef(lensY);
  lensYRef.current = lensY;
  const lensSizeRef = useRef(lensSize);
  lensSizeRef.current = lensSize;
  const lensRadiusRef = useRef(lensRadius);
  lensRadiusRef.current = lensRadius;
  const enableIntroRef = useRef(enableIntro);
  enableIntroRef.current = enableIntro;
  const introStartTimeRef = useRef(introStartTime);
  introStartTimeRef.current = introStartTime;
  const exitActiveRef = useRef(exitActive);
  exitActiveRef.current = exitActive;
  const exitStartTimeRef = useRef(exitStartTime);
  exitStartTimeRef.current = exitStartTime;

  const [debugView, setDebugView] = useState<DebugView>('final');
  const [webglError, setWebglError] = useState(false);
  const [internalDebug, setInternalDebug] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('debug') === '1' || params.get('debug') === 'true') {
        setInternalDebug(true);
      }
    }
  }, []);

  const isDebugActive = debug || internalDebug;
  const debugRef = useRef(isDebugActive);
  debugRef.current = isDebugActive;

  // Live diagnostics for ?debug=1 HUD
  const [diag, setDiag] = useState({
    fps: 60,
    pointCount: 0,
    visiblePoints: ~5600,
    simResolution: `${SIM_WIDTH}×${SIM_HEIGHT}`,
    basePointSize: DEFAULT_DESKTOP_POINT_SIZE,
    pointerUv: '0.00, 0.00',
    pointerVelocity: '0.00, 0.00',
    travelDistance: '0.0px',
    trailMode: 'Interpolated Droplets',
    trailSamples: 0,
    headInjection: '0.0',
    injectionRadiusCss: INJECTION_RADIUS_CSS,
    decayRate: LIQUID_DECAY_RATE,
    revealThresholds: '0.15 → 0.65',
    activeMode: 'Final Artwork (Mono → Color Reveal)',
    reducedMotion: false,
  });

  const debugViewRef = useRef<number>(0);

  const switchDebugView = (view: DebugView) => {
    setDebugView(view);
    const modeIdx = view === 'final' ? 0 : view === 'field' ? 1 : view === 'original' ? 2 : 3;
    debugViewRef.current = modeIdx;
  };

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    let destroyed = false;
    let renderer: THREE.WebGLRenderer | null = null;

    const id = instanceId;
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[IPA #${id}] MOUNT`);
      console.log(`[IPA #${id}] canvas exists:`, !!canvas);
      console.log(`[IPA #${id}] canvas.isConnected:`, canvas.isConnected);
      console.log(`[IPA #${id}] canvas.width:`, canvas.width, 'canvas.height:', canvas.height);
      console.log(`[IPA #${id}] canvas.clientWidth:`, canvas.clientWidth, 'canvas.clientHeight:', canvas.clientHeight);
      console.log(`[IPA #${id}] document.contains(canvas):`, typeof document !== 'undefined' ? document.contains(canvas) : false);
      console.log(`[IPA #${id}] whether effect is already disposed:`, destroyed);
      console.log(`[IPA #${id}] renderer ref/state:`, renderer);
      console.log(`[IPA #${id}] active RAF ownership:`, animFrameIdRef.current);
      console.log(`[IPA #${id}] renderer create begin`);
    }

    const onCtxLost = (e: Event) => {
      console.warn(`[IPA #${id}] webglcontextlost event received:`, e);
    };
    const onCtxRestored = (e: Event) => {
      console.log(`[IPA #${id}] webglcontextrestored event received:`, e);
    };
    canvas.addEventListener('webglcontextlost', onCtxLost, false);
    canvas.addEventListener('webglcontextrestored', onCtxRestored, false);

    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: false,
        alpha: transparentBackground,
        powerPreference: 'high-performance',
      });
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(`[IPA #${id}] WebGL initialization failed:`, err);
      }
      setWebglError(true);
      return;
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log(`[IPA #${id}] renderer create success`);
    }

    const scene = new THREE.Scene();
    if (!transparentBackground) {
      scene.background = new THREE.Color('#000000'); // Pure black Synq background
    } else {
      renderer.setClearColor(0x000000, 0); // Transparent background for Experiment B
    }

    // OrthographicCamera for 2D crisp pixel presentation
    const camera = new THREE.OrthographicCamera(-500, 500, 300, -300, 0.1, 2000);
    camera.position.set(0, 0, 500);
    camera.lookAt(0, 0, 0);

    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    // Base Grid setup: 240 x 135 = 32,400 points
    const initialWidth = container.clientWidth || window.innerWidth;
    const isMobileInitial = initialWidth < 768;
    const cols = isMobileInitial ? MOBILE_COLS : DESKTOP_COLS;
    const rows = isMobileInitial ? MOBILE_ROWS : DESKTOP_ROWS;
    const totalPoints = cols * rows;

    const baseGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(totalPoints * 3);
    const uvs = new Float32Array(totalPoints * 2);

    baseGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    baseGeometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

    // Ping-Pong Render Targets for Liquid Feedback Simulation
    const rtOptions: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    };

    let rtRead = new THREE.WebGLRenderTarget(SIM_WIDTH, SIM_HEIGHT, rtOptions);
    let rtWrite = new THREE.WebGLRenderTarget(SIM_WIDTH, SIM_HEIGHT, rtOptions);

    // Fullscreen quad for ping-pong liquid simulation pass
    const simScene = new THREE.Scene();
    const simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const simGeometry = new THREE.PlaneGeometry(2, 2);

    const simMaterial = new THREE.ShaderMaterial({
      vertexShader: SIM_VERTEX_SHADER,
      fragmentShader: SIM_FRAGMENT_SHADER,
      uniforms: {
        uPrevField: { value: rtRead.texture },
        uPointer: { value: new THREE.Vector2(-1, -1) },
        uPrevPointer: { value: new THREE.Vector2(-1, -1) },
        uTrailSamples: { value: 0.0 },
        uVelocity: { value: new THREE.Vector2(0, 0) },
        uPointerActive: { value: 0.0 },
        uAspect: { value: ASPECT_RATIO },
        uRadius: { value: INJECTION_RADIUS_CSS / 1000.0 },
        uDecay: { value: LIQUID_DECAY_RATE },
        uTime: { value: 0.0 },
        uTexelSize: { value: new THREE.Vector2(1.0 / SIM_WIDTH, 1.0 / SIM_HEIGHT) },
      },
      depthTest: false,
      depthWrite: false,
    });

    const simMesh = new THREE.Mesh(simGeometry, simMaterial);
    simScene.add(simMesh);

    // Base Artwork Material: Monochrome resting state + Liquid Color Reveal
    const placeholderTexture = new THREE.DataTexture(
      new Uint8Array([0, 0, 0, 0]),
      1,
      1,
      THREE.RGBAFormat
    );
    placeholderTexture.needsUpdate = true;

    const initialIntroActive = enableIntroRef.current && !reducedMotionQuery.matches;
    const baseMaterial = new THREE.ShaderMaterial({
      vertexShader: BASE_VERTEX_SHADER,
      fragmentShader: BASE_FRAGMENT_SHADER,
      uniforms: {
        uPointSize: { value: DEFAULT_DESKTOP_POINT_SIZE },
        uPixelRatio: { value: 1.0 },
        uLeftHandOffset: { value: initialIntroActive ? -10000.0 : 0.0 },
        uRightHandOffset: { value: initialIntroActive ? 10000.0 : 0.0 },
        uTextureFade: { value: initialIntroActive ? 0.0 : 1.0 },
        uTexture: { value: placeholderTexture },
        uLiquidTexture: { value: rtRead.texture },
        uTextureLoaded: { value: 0.0 },
        uDebugMode: { value: 0.0 },
        uOriginalColor: { value: colorMode === 'original-color' ? 1.0 : 0.0 },
        uTime: { value: 0.0 },
        uEnableFlicker: { value: 0.0 },
        uLensActive: { value: 0.0 },
        uLensCenter: { value: new THREE.Vector2(0, 0) },
        uLensHalfSize: { value: new THREE.Vector2(90, 90) },
        uLensRadius: { value: 24.0 },
        uArtworkDimensions: { value: new THREE.Vector2(1, 1) },
      },
      depthTest: true,
      depthWrite: true,
      transparent: true,
    });

    const basePointsMesh = new THREE.Points(baseGeometry, baseMaterial);
    basePointsMesh.frustumCulled = false;
    scene.add(basePointsMesh);

    // Load /03.png texture into Three.js
    let textureLoadedTimestamp = 0;
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(
      REFERENCE_IMAGE_SRC,
      (texture) => {
        if (destroyed) {
          texture.dispose();
          return;
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;

        textureLoadedTimestamp = performance.now();
        baseMaterial.uniforms.uTexture.value = texture;
        baseMaterial.uniforms.uTextureLoaded.value = 1.0;
        baseMaterial.needsUpdate = true;
      },
      undefined,
      (err) => {
        if (destroyed) return;
        console.error('Failed to load artwork texture:', err);
        setWebglError(true);
      }
    );

    // Layout tracking
    let currentArtworkWidth = 0;
    let currentArtworkHeight = 0;

    const updateGeometryAndLayout = () => {
      if (!renderer || !container) return;
      const rect = container.getBoundingClientRect();
      const width = Math.max(container.clientWidth || rect.width || window.innerWidth, 320);
      const height = Math.max(container.clientHeight || rect.height || 500, 320);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      renderer.setPixelRatio(dpr);
      renderer.setSize(width, height, false);

      camera.left = -width / 2;
      camera.right = width / 2;
      camera.top = height / 2;
      camera.bottom = -height / 2;
      camera.updateProjectionMatrix();

      const isMobile = width < 768;
      const currentScale = artworkScaleRef.current;
      let artworkWidth: number;
      let artworkHeight: number;

      if (!isMobile) {
        artworkWidth = Math.min(width * 0.94, height * ASPECT_RATIO * 0.90) * currentScale;
        artworkHeight = artworkWidth / ASPECT_RATIO;
      } else {
        artworkWidth = width * 0.96 * currentScale;
        artworkHeight = artworkWidth / ASPECT_RATIO;
      }

      currentArtworkWidth = artworkWidth;
      currentArtworkHeight = artworkHeight;

      // Update simulation radius uniform relative to artwork width (preserves 70px in CSS/display space)
      simMaterial.uniforms.uRadius.value = INJECTION_RADIUS_CSS / artworkWidth;
      simMaterial.uniforms.uAspect.value = artworkWidth / artworkHeight;

      const posAttr = baseGeometry.getAttribute('position') as THREE.BufferAttribute;
      const posArr = posAttr.array as Float32Array;
      const uvAttr = baseGeometry.getAttribute('uv') as THREE.BufferAttribute;
      const uvArr = uvAttr.array as Float32Array;

      let pIdx = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const u = c / (cols - 1);
          const v = 1.0 - (r / (rows - 1));
          const x = (u - 0.5) * artworkWidth;
          const y = (v - 0.5) * artworkHeight;

          posArr[pIdx * 3] = x;
          posArr[pIdx * 3 + 1] = y;
          posArr[pIdx * 3 + 2] = 0; // Canonical static resting plane at Z = 0

          uvArr[pIdx * 2] = u;
          uvArr[pIdx * 2 + 1] = v;

          pIdx++;
        }
      }

      posAttr.needsUpdate = true;
      uvAttr.needsUpdate = true;
      baseGeometry.computeBoundingSphere();

      const pointSize = (isMobile ? 5.5 : DEFAULT_DESKTOP_POINT_SIZE) * (preservePixelSizeRef.current ? 1.0 : currentScale);
      baseMaterial.uniforms.uPointSize.value = pointSize;
      baseMaterial.uniforms.uPixelRatio.value = dpr;
    };

    updateGeometryAndLayout();

    const resizeObserver = new ResizeObserver(() => {
      updateGeometryAndLayout();
    });
    resizeObserver.observe(container);

    // Pointer Interaction State for Liquid Field
    let pointerUvX = -1;
    let pointerUvY = -1;
    let prevUvX = -1;
    let prevUvY = -1;
    let velocityUvX = 0;
    let velocityUvY = 0;
    let pointerActive = 0;
    const simPrevPointerUv = new THREE.Vector2(-1, -1);
    let currentTravelDistCss = 0;
    let currentIsSweptActive = false;

    const handlePointerMove = (e: PointerEvent) => {
      if (reducedMotionQuery.matches) return;
      if (exitActiveRef.current) return;
      if (enableIntroRef.current) {
        const elapsed = introStartTimeRef.current > 0
          ? performance.now() - introStartTimeRef.current
          : localIntroStart > 0
          ? performance.now() - localIntroStart
          : 0;
        if (elapsed < LANDING_INTRO_TIMING.TOTAL_DURATION_MS) return;
      }
      const rect = canvas.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const clientY = e.clientY - rect.top;

      const worldX = clientX - rect.width / 2;
      const worldY = rect.height / 2 - clientY;

      if (currentArtworkWidth <= 0 || currentArtworkHeight <= 0) return;

      // UV Coordinates across artwork (-0.5 to +0.5 mapped to 0 to 1)
      const u = worldX / currentArtworkWidth + 0.5;
      const v = worldY / currentArtworkHeight + 0.5;

      const inside = u >= -0.05 && u <= 1.05 && v >= -0.05 && v <= 1.05;

      if (inside) {
        pointerActive = 1;
        pointerUvX = u;
        pointerUvY = v;

        if (prevUvX >= 0 && prevUvY >= 0) {
          const dU = u - prevUvX;
          const dV = v - prevUvY;
          // Responsive velocity with fast convergence to prevent stale perpendicular drift
          velocityUvX = velocityUvX * 0.40 + dU * 0.60;
          velocityUvY = velocityUvY * 0.40 + dV * 0.60;
        }

        prevUvX = u;
        prevUvY = v;
      } else {
        pointerActive = 0;
      }
    };

    let currentTrailSampleCount = 0;
    let currentHeadInjection = 0.0;

    const handlePointerLeave = () => {
      pointerActive = 0;
      prevUvX = -1;
      prevUvY = -1;
      simPrevPointerUv.set(-1, -1);
      currentTravelDistCss = 0;
      currentTrailSampleCount = 0;
      currentHeadInjection = 0.0;
      velocityUvX = 0;
      velocityUvY = 0;
    };

    if (!disableLiquid) {
      window.addEventListener('pointermove', handlePointerMove, { passive: true });
      window.addEventListener('pointerleave', handlePointerLeave);
      window.addEventListener('blur', handlePointerLeave);
      canvas.addEventListener('pointermove', handlePointerMove, { passive: true });
      canvas.addEventListener('pointerleave', handlePointerLeave);
      container.addEventListener('pointermove', handlePointerMove, { passive: true });
      container.addEventListener('pointerleave', handlePointerLeave);
    }

    // Render Loop
    let localIntroStart = 0;
    let fpsFrames = 0;
    let fpsTimer = performance.now();
    let diagTimer = performance.now();

    const renderLoop = (time: number) => {
      if (destroyed || !renderer) return;

      const timeSeconds = time * 0.001;

      // Dampen velocity when cursor slows or stops to prevent stale directional drift
      velocityUvX *= 0.80;
      velocityUvY *= 0.80;

      const isIntroActive = enableIntroRef.current && !reducedMotionQuery.matches;
      let introElapsed = 999999;
      if (isIntroActive) {
        if (introStartTimeRef.current > 0) {
          introElapsed = time - introStartTimeRef.current;
        } else {
          if (localIntroStart === 0) localIntroStart = time;
          introElapsed = time - localIntroStart;
        }
      }

      const isExitActive = exitActiveRef.current && !reducedMotionQuery.matches;
      let exitElapsed = 0;
      if (isExitActive) {
        if (exitStartTimeRef.current > 0) {
          exitElapsed = time - exitStartTimeRef.current;
        }
      }

      // Compute hand offsets, flicker gating, and texture fade during intro or exit
      if (isExitActive) {
        const viewportW = container.clientWidth || window.innerWidth || 1200;
        const offscreenDist = viewportW * 0.5 + currentArtworkWidth * 0.5 + 100;

        if (exitElapsed < LANDING_EXIT_TIMING.HANDS_RETREAT_DURATION_MS) {
          // Phase 1 (0–500ms): Both hands retreat offscreen using smootherstep
          const p = Math.min(1.0, Math.max(0.0, exitElapsed / LANDING_EXIT_TIMING.HANDS_RETREAT_DURATION_MS));
          // Ken Perlin's smootherstep: 6t^5 - 15t^4 + 10t^3 (visually symmetrical reverse movement)
          const ease = p * p * p * (p * (p * 6.0 - 15.0) + 10.0);
          baseMaterial.uniforms.uLeftHandOffset.value = -offscreenDist * ease;
          baseMaterial.uniforms.uRightHandOffset.value = offscreenDist * ease;
        } else {
          // Phase 2 (500–1000ms): Both hands remain completely outside viewport
          baseMaterial.uniforms.uLeftHandOffset.value = -offscreenDist;
          baseMaterial.uniforms.uRightHandOffset.value = offscreenDist;
        }

        baseMaterial.uniforms.uEnableFlicker.value = 0.0;
        baseMaterial.uniforms.uTextureFade.value = 1.0;
      } else if (isIntroActive && introElapsed < LANDING_INTRO_TIMING.TOTAL_DURATION_MS) {
        const viewportW = container.clientWidth || window.innerWidth || 1200;
        const offscreenDist = viewportW * 0.5 + currentArtworkWidth * 0.5 + 100;

        if (introElapsed < LANDING_INTRO_TIMING.WORDMARK_PAUSE_END_MS) {
          // 0–1500ms (0–250ms hold, 250–1000ms small wordmark emerge, 1000–1500ms pause): hands held offscreen
          baseMaterial.uniforms.uLeftHandOffset.value = -offscreenDist;
          baseMaterial.uniforms.uRightHandOffset.value = offscreenDist;
        } else if (introElapsed < LANDING_INTRO_TIMING.EXPANSION_HANDS_END_MS) {
          // Phase (1500–2250ms): simultaneous smootherstep ease-in-out entrance
          const p = (introElapsed - LANDING_INTRO_TIMING.WORDMARK_PAUSE_END_MS) / LANDING_INTRO_TIMING.HAND_TRAVEL_DURATION_MS;
          const clampedP = Math.min(1.0, Math.max(0.0, p));
          // Ken Perlin's smootherstep: 6t^5 - 15t^4 + 10t^3 (zero initial/final velocity, gentle acceleration & deceleration)
          const ease = clampedP * clampedP * clampedP * (clampedP * (clampedP * 6.0 - 15.0) + 10.0);
          baseMaterial.uniforms.uLeftHandOffset.value = -offscreenDist * (1.0 - ease);
          baseMaterial.uniforms.uRightHandOffset.value = offscreenDist * (1.0 - ease);
        } else {
          // Phase (2250ms+): strictly settled at canonical resting position
          baseMaterial.uniforms.uLeftHandOffset.value = 0.0;
          baseMaterial.uniforms.uRightHandOffset.value = 0.0;
        }

        // Flicker gating: activate autonomous flicker around 2250ms as hands settle
        if (introElapsed < LANDING_INTRO_TIMING.EXPANSION_HANDS_END_MS) {
          baseMaterial.uniforms.uEnableFlicker.value = 0.0;
        } else {
          baseMaterial.uniforms.uEnableFlicker.value = enableFlickerRef.current ? 1.0 : 0.0;
        }

        // Texture fade catch-up for smooth late-loading appearance
        if (baseMaterial.uniforms.uTextureLoaded.value > 0.5) {
          if (textureLoadedTimestamp > 0) {
            const fadeProgress = Math.min(1.0, Math.max(0.0, (time - textureLoadedTimestamp) / 200.0));
            baseMaterial.uniforms.uTextureFade.value = fadeProgress;
          } else {
            baseMaterial.uniforms.uTextureFade.value = 1.0;
          }
        }
      } else {
        // Animation finished or reduced motion or intro disabled: resting state
        baseMaterial.uniforms.uLeftHandOffset.value = 0.0;
        baseMaterial.uniforms.uRightHandOffset.value = 0.0;
        baseMaterial.uniforms.uTextureFade.value = 1.0;
        baseMaterial.uniforms.uEnableFlicker.value = (!reducedMotionQuery.matches && enableFlickerRef.current) ? 1.0 : 0.0;
      }

      // Pass 1: Ping-Pong Liquid Simulation (if not reduced motion and not disabled, gated during intro and exit)
      if (!disableLiquid && !reducedMotionQuery.matches && !isExitActive && (!isIntroActive || introElapsed >= LANDING_INTRO_TIMING.TOTAL_DURATION_MS)) {
        if (pointerActive > 0.5) {
          if (simPrevPointerUv.x < 0 || simPrevPointerUv.y < 0) {
            simPrevPointerUv.set(pointerUvX, pointerUvY);
          }

          const travelDistUv = Math.hypot(pointerUvX - simPrevPointerUv.x, pointerUvY - simPrevPointerUv.y);
          currentTravelDistCss = travelDistUv * currentArtworkWidth;

          // Determine trail sample count based on physical spacing (~42px, roughly 0.6 * 70px)
          // If stationary or tiny movement (< 12px), 0 trail samples (head only, pure organic droplet)
          // For faster movements, clamp to MAX_TRAIL_SAMPLES (6)
          if (currentTravelDistCss < 12.0) {
            currentTrailSampleCount = 0;
          } else {
            currentTrailSampleCount = Math.min(6, Math.max(1, Math.round(currentTravelDistCss / 42.0)));
          }
          currentHeadInjection = 1.0;

          simMaterial.uniforms.uPrevPointer.value.set(simPrevPointerUv.x, simPrevPointerUv.y);
          simMaterial.uniforms.uPointer.value.set(pointerUvX, pointerUvY);
          simMaterial.uniforms.uTrailSamples.value = currentTrailSampleCount;
        } else {
          currentTravelDistCss = 0;
          currentTrailSampleCount = 0;
          currentHeadInjection = 0.0;
          simMaterial.uniforms.uPrevPointer.value.set(pointerUvX, pointerUvY);
          simMaterial.uniforms.uPointer.value.set(pointerUvX, pointerUvY);
          simMaterial.uniforms.uTrailSamples.value = 0.0;
        }

        simMaterial.uniforms.uPrevField.value = rtRead.texture;
        simMaterial.uniforms.uVelocity.value.set(velocityUvX, velocityUvY);
        simMaterial.uniforms.uPointerActive.value = pointerActive;
        simMaterial.uniforms.uTime.value = timeSeconds;

        renderer.setRenderTarget(rtWrite);
        renderer.render(simScene, simCamera);

        // Ping-pong swap
        const temp = rtRead;
        rtRead = rtWrite;
        rtWrite = temp;

        if (pointerActive > 0.5) {
          simPrevPointerUv.set(pointerUvX, pointerUvY);
        }
      }

      // Pass 2: Base Artwork Render
      renderer.setRenderTarget(null);
      baseMaterial.uniforms.uLiquidTexture.value = rtRead.texture;
      baseMaterial.uniforms.uDebugMode.value = debugViewRef.current;
      baseMaterial.uniforms.uOriginalColor.value = colorMode === 'original-color' ? 1.0 : 0.0;
      baseMaterial.uniforms.uTime.value = reducedMotionQuery.matches ? 0.0 : timeSeconds;
      baseMaterial.uniforms.uLensActive.value = (lensActiveRef.current && !isExitActive && (!isIntroActive || introElapsed >= LANDING_INTRO_TIMING.TOTAL_DURATION_MS)) ? 1.0 : 0.0;
      const cWidth = container.clientWidth || 1;
      const cHeight = container.clientHeight || 1;
      const worldLensX = lensXRef.current - cWidth / 2;
      const worldLensY = cHeight / 2 - lensYRef.current;
      baseMaterial.uniforms.uLensCenter.value.set(worldLensX, worldLensY);
      baseMaterial.uniforms.uLensHalfSize.value.set(lensSizeRef.current / 2, lensSizeRef.current / 2);
      baseMaterial.uniforms.uLensRadius.value = lensRadiusRef.current;
      baseMaterial.uniforms.uArtworkDimensions.value.set(currentArtworkWidth, currentArtworkHeight);
      renderer.render(scene, camera);

      // FPS and Diagnostics Update
      fpsFrames++;
      if (time - fpsTimer > 1000) {
        const currentFps = Math.round((fpsFrames * 1000) / (time - fpsTimer));
        fpsFrames = 0;
        fpsTimer = time;

        if (debugRef.current && time - diagTimer > 100) {
          const viewTitle =
            debugViewRef.current === 0
              ? 'Final Artwork (Mono → Liquid Reveal)'
              : debugViewRef.current === 1
                ? 'Liquid Field View (Grayscale)'
                : debugViewRef.current === 2
                  ? 'Full Original Color'
                  : 'Full Resting Monochrome';

          setDiag({
            fps: currentFps,
            pointCount: totalPoints,
            visiblePoints: 5600,
            simResolution: `${SIM_WIDTH}×${SIM_HEIGHT}`,
            basePointSize: DEFAULT_DESKTOP_POINT_SIZE,
            pointerUv: `${pointerUvX.toFixed(2)}, ${pointerUvY.toFixed(2)}`,
            pointerVelocity: `${(velocityUvX * 100).toFixed(1)}, ${(velocityUvY * 100).toFixed(1)}`,
            travelDistance: `${currentTravelDistCss.toFixed(1)}px`,
            trailMode: 'Interpolated Droplets',
            trailSamples: currentTrailSampleCount,
            headInjection: currentHeadInjection.toFixed(1),
            injectionRadiusCss: INJECTION_RADIUS_CSS,
            decayRate: LIQUID_DECAY_RATE,
            revealThresholds: '0.15 → 0.65',
            activeMode: viewTitle,
            reducedMotion: reducedMotionQuery.matches,
          });
          diagTimer = time;
        }
      }

      animFrameIdRef.current = requestAnimationFrame(renderLoop);
    };

    animFrameIdRef.current = requestAnimationFrame(renderLoop);

    return () => {
      destroyed = true;
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[IPA #${id}] CLEANUP`);
      }
      if (animFrameIdRef.current !== null) {
        cancelAnimationFrame(animFrameIdRef.current);
        animFrameIdRef.current = null;
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[IPA #${id}] RAF cancelled`);
        }
      }
      resizeObserver.disconnect();
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[IPA #${id}] observer disconnected`);
      }
      canvas.removeEventListener('webglcontextlost', onCtxLost, false);
      canvas.removeEventListener('webglcontextrestored', onCtxRestored, false);

      if (!disableLiquid) {
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerleave', handlePointerLeave);
        window.removeEventListener('blur', handlePointerLeave);
        canvas.removeEventListener('pointermove', handlePointerMove);
        canvas.removeEventListener('pointerleave', handlePointerLeave);
        container.removeEventListener('pointermove', handlePointerMove);
        container.removeEventListener('pointerleave', handlePointerLeave);
      }

      baseGeometry.dispose();
      simGeometry.dispose();
      baseMaterial.dispose();
      simMaterial.dispose();
      rtRead.dispose();
      rtWrite.dispose();
      if (baseMaterial.uniforms.uTexture.value && baseMaterial.uniforms.uTexture.value !== placeholderTexture) {
        baseMaterial.uniforms.uTexture.value.dispose();
      }
      placeholderTexture.dispose();
      if (renderer) {
        renderer.dispose();
        // Clean GPU resource release; context loss is NOT simulated on unmount
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[IPA #${id}] renderer disposed`);
        }
      }
    };
  }, [artworkScale, preservePixelSize, transparentBackground, colorMode, disableLiquid]);

  if (webglError) {
    return (
      <div
        ref={containerRef}
        className={`relative w-full h-full min-h-[500px] ${transparentBackground ? 'bg-transparent' : 'bg-black'} flex items-center justify-center p-8 ${className}`}
      >
        <div
          role="img"
          aria-label="Creation of Adam fallback"
          style={{
            backgroundImage: `url(${REFERENCE_IMAGE_SRC})`,
            backgroundSize: 'contain',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            width: '90vw',
            height: '85vh',
            maxWidth: `${TEXTURE_WIDTH}px`,
            maxHeight: `${TEXTURE_HEIGHT}px`,
            opacity: 0.8,
          }}
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full min-h-[500px] ${transparentBackground ? 'bg-transparent' : 'bg-black'} overflow-hidden select-none pointer-events-none ${className}`}
    >
      <canvas key={instanceId} ref={canvasRef} className="absolute inset-0 block w-full h-full pointer-events-none" />

      {isDebugActive && (
        <div className="absolute bottom-4 left-4 z-30 font-mono text-[11px] text-zinc-300 bg-zinc-900/95 border border-zinc-700/80 p-3.5 rounded-lg space-y-2 backdrop-blur-md shadow-2xl max-w-lg pointer-events-auto">
          <div className="flex items-center justify-between pb-1 border-b border-zinc-800">
            <span className="text-cyan-400 font-bold">PHASE 7 LIQUID COLOR REVEAL</span>
            <span className="text-emerald-400 font-bold">{diag.fps} FPS</span>
          </div>

          <div className="text-[10px] text-zinc-400">
            Active View: <span className="text-white font-bold">{diag.activeMode}</span>
          </div>

          {/* Diagnostic View Toggles (A, B, C, D) */}
          <div className="flex items-center gap-1.5 pt-0.5">
            <button
              onClick={() => switchDebugView('final')}
              type="button"
              className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wide transition-colors ${
                debugView === 'final'
                  ? 'bg-emerald-500 text-black'
                  : 'bg-zinc-800 text-emerald-300 hover:bg-zinc-700 border border-zinc-700'
              }`}
            >
              A. Final Artwork
            </button>
            <button
              onClick={() => switchDebugView('field')}
              type="button"
              className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wide transition-colors ${
                debugView === 'field'
                  ? 'bg-cyan-500 text-black'
                  : 'bg-zinc-800 text-cyan-300 hover:bg-zinc-700 border border-zinc-700'
              }`}
            >
              B. Liquid Field
            </button>
            <button
              onClick={() => switchDebugView('original')}
              type="button"
              className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wide transition-colors ${
                debugView === 'original'
                  ? 'bg-cyan-500 text-black'
                  : 'bg-zinc-800 text-cyan-300 hover:bg-zinc-700 border border-zinc-700'
              }`}
            >
              C. Original Color
            </button>
            <button
              onClick={() => switchDebugView('mono')}
              type="button"
              className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wide transition-colors ${
                debugView === 'mono'
                  ? 'bg-cyan-500 text-black'
                  : 'bg-zinc-800 text-cyan-300 hover:bg-zinc-700 border border-zinc-700'
              }`}
            >
              D. Resting Mono
            </button>
          </div>

          {/* Liquid Simulation Diagnostics Matrix */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] pt-1.5 border-t border-zinc-800/80">
            <div>Source: <span className="text-white font-bold">/03.png ({TEXTURE_WIDTH}×{TEXTURE_HEIGHT})</span></div>
            <div>Visible Points: <span className="text-cyan-300 font-bold">~{diag.visiblePoints}</span></div>
            <div>Simulation Res: <span className="text-white font-bold">{diag.simResolution}</span></div>
            <div>Base Tile Size: <span className="text-white font-bold">{diag.basePointSize}px</span></div>
            <div>Pointer UV: <span className="text-white font-bold">{diag.pointerUv}</span></div>
            <div>Pointer Velocity: <span className="text-white font-bold">{diag.pointerVelocity}</span></div>
            <div>Reveal Radius: <span className="text-emerald-400 font-bold">{diag.injectionRadiusCss}px</span></div>
            <div>Travel Distance: <span className="text-white font-bold">{diag.travelDistance}</span></div>
            <div>Trail Mode: <span className="text-emerald-400 font-bold">{diag.trailMode}</span></div>
            <div>Trail Samples: <span className="text-cyan-300 font-bold">{diag.trailSamples} / 6</span></div>
            <div>Head Injection: <span className="text-white font-bold">{diag.headInjection}</span></div>
            <div>Decay Rate: <span className="text-white font-bold">{diag.decayRate} (~1.0s)</span></div>
            <div>Reveal Thresholds: <span className="text-emerald-400 font-bold">{diag.revealThresholds}</span></div>
            <div>Reduced Motion: <span className={diag.reducedMotion ? 'text-amber-400' : 'text-zinc-400'}>{diag.reducedMotion ? 'ACTIVE' : 'OFF'}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}
