'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Press_Start_2P } from 'next/font/google';
import InteractivePixelArtwork from '@/components/landing/InteractivePixelArtwork';
import { RainbowButton } from '@/components/ui/rainbow-button';

const pressStart2P = Press_Start_2P({ weight: '400', subsets: ['latin'] });

export type LensRenderMode = 'A' | 'B' | 'C' | 'D' | 'E';

export interface LiquidLensDiagnosticData {
  renderer: string;
  contextLost: boolean;
  alpha: boolean;
  premultipliedAlpha: boolean;
  preserveDrawingBuffer: boolean;
  antialias: boolean;
  vertexShaderStatus: 'OK' | 'FAILED' | 'N/A';
  fragmentShaderStatus: 'OK' | 'FAILED' | 'N/A';
  programLinkStatus: 'OK' | 'FAILED' | 'N/A';
  vsErrorLog: string;
  fsErrorLog: string;
  linkErrorLog: string;
  renderMode: LensRenderMode;
  cssSize: string;
  backingBuffer: string;
  dpr: number;
  blendingEnabled: boolean;
  lastGlError: string;
}

interface LiquidLensSurfaceProps {
  size: number;
  radius: number;
  active: boolean;
  mode?: LensRenderMode;
  onDiagnostic?: (data: LiquidLensDiagnosticData) => void;
}

const LENS_VS = `
  attribute vec2 aPos;
  void main() {
    gl_Position = vec4(aPos, 0.0, 1.0);
  }
`;

// Diagnostic Mode C: Constant Transparent Shader (RGB red, alpha ZERO -> completely invisible in straight alpha)
const FS_MODE_C = `
  precision mediump float;
  void main() {
    gl_FragColor = vec4(1.0, 0.0, 0.0, 0.0);
  }
`;

// Diagnostic Mode D: Constant Low-Alpha Test (RGB red, alpha 0.10 -> faint transparent red overlay)
const FS_MODE_D = `
  precision mediump float;
  void main() {
    gl_FragColor = vec4(1.0, 0.0, 0.0, 0.10);
  }
`;

// Diagnostic Mode E: Current Liquid Shader with straight-alpha blending
const LENS_FS = `
  precision mediump float;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform float uRadius;
  uniform float uDpr;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float roundedBoxSDF(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + vec2(r, r);
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0, 0.0))) - r;
  }

  void main() {
    vec2 pixelPos = gl_FragCoord.xy - uResolution * 0.5;
    vec2 halfSize = uResolution * 0.5;

    float distPhysical = roundedBoxSDF(pixelPos, halfSize, uRadius * uDpr);
    float distCss = distPhysical / uDpr;

    // Lens outer boundary mask (1.5px soft antialiasing)
    float outerMask = 1.0 - smoothstep(-1.5, 0.5, distCss);
    if (outerMask <= 0.001) {
      discard;
    }

    // Normalized coordinate inside lens: p in [-1.0, 1.0]
    vec2 p = pixelPos / halfSize;

    // Procedural multi-frequency liquid flow for microscopic glancing highlight cue
    float t = uTime * 0.22;
    float n1 = vNoise(p * 2.1 + vec2(t * 0.14, t * 0.10));
    float n2 = vNoise(p * 3.8 - vec2(t * 0.12, -t * 0.15));

    // Sparse, microscopic caustic light trace (target ~0-1.5% max highlight, zero white/black shapes)
    float ridgeNoise = clamp(1.0 - abs(n2 - 0.5) * 2.0, 0.0, 1.0);
    float ridge = pow(ridgeNoise, 4.0);
    float caustic = smoothstep(0.72, 0.98, ridge * (n1 * 0.6 + 0.5)) * 0.012;

    // Faint irregular optical meniscus along outer rim (pure light bending cue, no border)
    float rimZone = smoothstep(-10.0, -1.0, distCss);
    float rimAngle = atan(p.y, p.x);
    float rimNoise = vNoise(vec2(rimAngle * 2.2, t * 0.25));
    float rimVisibility = smoothstep(0.48, 0.80, rimNoise);
    float meniscus = sin(rimZone * 3.14159) * rimVisibility * 0.010;

    // Microscopic optical sheen (strictly <= 1.5% maximum, zero black, zero opaque shapes)
    float highlight = clamp((caustic + meniscus) * outerMask, 0.0, 0.015);

    gl_FragColor = vec4(1.0, 1.0, 1.0, highlight);
  }
`;

function LiquidLensSurface({
  size,
  radius,
  active,
  mode = 'E',
  onDiagnostic,
}: LiquidLensSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active || mode === 'A') return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    // Phase 5: Straight-alpha configuration (premultipliedAlpha: false) prevents compositor additive white blowout
    const contextAttrs: WebGLContextAttributes = {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    };

    let rendererType = 'WebGL2';
    let gl = canvas.getContext('webgl2', contextAttrs) as WebGLRenderingContext | null;
    if (!gl) {
      rendererType = 'WebGL1';
      gl = canvas.getContext('webgl', contextAttrs) as WebGLRenderingContext | null;
    }

    if (!gl) {
      // Phase 6: Strictly transparent fallback. Zero gradients, zero fallback visuals.
      rendererType = 'Transparent fallback (2D)';
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      onDiagnostic?.({
        renderer: rendererType,
        contextLost: false,
        alpha: true,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        antialias: false,
        vertexShaderStatus: 'N/A',
        fragmentShaderStatus: 'N/A',
        programLinkStatus: 'N/A',
        vsErrorLog: '',
        fsErrorLog: '',
        linkErrorLog: '',
        renderMode: mode,
        cssSize: `${size}px × ${size}px`,
        backingBuffer: `${canvas.width} × ${canvas.height}`,
        dpr,
        blendingEnabled: false,
        lastGlError: 'NO_GL_CONTEXT',
      });
      return;
    }

    const attrs = gl.getContextAttributes() || {
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      antialias: false,
    };

    // Phase 5: Enable straight alpha blending
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const blendingEnabled = gl.isEnabled(gl.BLEND);

    let vsStatus: 'OK' | 'FAILED' | 'N/A' = 'N/A';
    let fsStatus: 'OK' | 'FAILED' | 'N/A' = 'N/A';
    let programStatus: 'OK' | 'FAILED' | 'N/A' = 'N/A';
    let vsErrorLog = '';
    let fsErrorLog = '';
    let linkErrorLog = '';

    let animId: number;
    let program: WebGLProgram | null = null;
    let vs: WebGLShader | null = null;
    let fs: WebGLShader | null = null;
    let posBuffer: WebGLBuffer | null = null;

    if (mode === 'B') {
      // Phase 1 Mode B: CANVAS TRANSPARENT CLEAR ONLY.
      // Every frame only gl.clearColor(0,0,0,0) and gl.clear(gl.COLOR_BUFFER_BIT). No drawArrays.
      const renderB = () => {
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        animId = requestAnimationFrame(renderB);
      };
      animId = requestAnimationFrame(renderB);
    } else {
      // Phase 1 Modes C, D, E: Compile and link shader program
      const createShader = (type: number, src: string) => {
        const s = gl.createShader(type);
        if (!s) return null;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        const ok = gl.getShaderParameter(s, gl.COMPILE_STATUS);
        if (!ok) {
          const log = gl.getShaderInfoLog(s) || 'Shader compilation failed';
          if (type === gl.VERTEX_SHADER) {
            vsStatus = 'FAILED';
            vsErrorLog = log;
          } else {
            fsStatus = 'FAILED';
            fsErrorLog = log;
          }
          gl.deleteShader(s);
          return null;
        }
        if (type === gl.VERTEX_SHADER) {
          vsStatus = 'OK';
        } else {
          fsStatus = 'OK';
        }
        return s;
      };

      vs = createShader(gl.VERTEX_SHADER, LENS_VS);
      const fsSource = mode === 'C' ? FS_MODE_C : mode === 'D' ? FS_MODE_D : LENS_FS;
      fs = createShader(gl.FRAGMENT_SHADER, fsSource);

      if (vs && fs) {
        program = gl.createProgram();
        if (program) {
          gl.attachShader(program, vs);
          gl.attachShader(program, fs);
          gl.linkProgram(program);
          const linkOk = gl.getProgramParameter(program, gl.LINK_STATUS);
          if (linkOk) {
            programStatus = 'OK';
          } else {
            programStatus = 'FAILED';
            linkErrorLog = gl.getProgramInfoLog(program) || 'Program link failed';
            gl.deleteProgram(program);
            program = null;
          }
        }
      }

      if (program && programStatus === 'OK') {
        gl.useProgram(program);

        posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
          gl.STATIC_DRAW
        );

        const aPos = gl.getAttribLocation(program, 'aPos');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        gl.viewport(0, 0, canvas.width, canvas.height);

        let uTimeLoc: WebGLUniformLocation | null = null;
        if (mode === 'E') {
          uTimeLoc = gl.getUniformLocation(program, 'uTime');
          const uResLoc = gl.getUniformLocation(program, 'uResolution');
          const uRadiusLoc = gl.getUniformLocation(program, 'uRadius');
          const uDprLoc = gl.getUniformLocation(program, 'uDpr');
          gl.uniform2f(uResLoc, canvas.width, canvas.height);
          gl.uniform1f(uRadiusLoc, radius);
          gl.uniform1f(uDprLoc, dpr);
        }

        const render = (time: number) => {
          gl.clearColor(0.0, 0.0, 0.0, 0.0);
          gl.clear(gl.COLOR_BUFFER_BIT);

          if (mode === 'E' && uTimeLoc) {
            const t = reducedMotionQuery.matches ? 0.0 : time * 0.001;
            gl.uniform1f(uTimeLoc, t);
          }
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          animId = requestAnimationFrame(render);
        };

        animId = requestAnimationFrame(render);
      } else {
        // Fallback if shader compile/link fails: strictly transparent clear
        const renderFailSafe = () => {
          gl.clearColor(0.0, 0.0, 0.0, 0.0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          animId = requestAnimationFrame(renderFailSafe);
        };
        animId = requestAnimationFrame(renderFailSafe);
      }
    }

    const glErr = gl.getError();
    const lastGlError = glErr === gl.NO_ERROR ? 'NO_ERROR' : `0x${glErr.toString(16)}`;

    onDiagnostic?.({
      renderer: rendererType,
      contextLost: gl.isContextLost(),
      alpha: !!attrs.alpha,
      premultipliedAlpha: !!attrs.premultipliedAlpha,
      preserveDrawingBuffer: !!attrs.preserveDrawingBuffer,
      antialias: !!attrs.antialias,
      vertexShaderStatus: vsStatus,
      fragmentShaderStatus: fsStatus,
      programLinkStatus: programStatus,
      vsErrorLog,
      fsErrorLog,
      linkErrorLog,
      renderMode: mode,
      cssSize: `${size}px × ${size}px`,
      backingBuffer: `${canvas.width} × ${canvas.height}`,
      dpr,
      blendingEnabled,
      lastGlError,
    });

    return () => {
      cancelAnimationFrame(animId);
      if (posBuffer && gl) gl.deleteBuffer(posBuffer);
      if (program && gl) gl.deleteProgram(program);
      if (vs && gl) gl.deleteShader(vs);
      if (fs && gl) gl.deleteShader(fs);
    };
  }, [size, radius, active, mode]);

  if (mode === 'A') {
    return null;
  }

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        backgroundColor: 'transparent',
      }}
    />
  );
}

export default function PixelLabPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [debugMode, setDebugMode] = useState(false);
  const [renderMode, setRenderMode] = useState<LensRenderMode>('E');
  const [diagnostic, setDiagnostic] = useState<LiquidLensDiagnosticData | null>(null);

  // Liquid Lens Position & State
  const [lensActive, setLensActive] = useState(false);
  const [lensPos, setLensPos] = useState({ x: -1000, y: -1000 });
  const [containerRect, setContainerRect] = useState({ width: 1200, height: 700 });

  const targetPosRef = useRef({ x: -1000, y: -1000, active: false });
  const currentPosRef = useRef({ x: -1000, y: -1000 });

  const lensSize = 180;
  const lensRadius = 14;

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('debug') === '1' || params.get('debug') === 'true') {
        setDebugMode(true);
      }
      const m = params.get('mode')?.toUpperCase();
      if (m === 'A' || m === 'B' || m === 'C' || m === 'D' || m === 'E') {
        setRenderMode(m as LensRenderMode);
      }
    }
  }, []);

  // Update container dimensions on resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateRect = () => {
      const rect = el.getBoundingClientRect();
      setContainerRect({ width: rect.width, height: rect.height });
    };

    updateRect();
    const observer = new ResizeObserver(updateRect);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Perceptual lag smoothing for the liquid lens cursor tracking (~60-80ms lag, bypassed if prefers-reduced-motion)
  useEffect(() => {
    let animId: number;

    const updateLensLoop = () => {
      if (targetPosRef.current.active) {
        const prefersReduced =
          typeof window !== 'undefined' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        if (prefersReduced) {
          currentPosRef.current.x = targetPosRef.current.x;
          currentPosRef.current.y = targetPosRef.current.y;
        } else {
          // Perceptual organic lag (~60-80ms at 60fps with alpha ≈ 0.32)
          const dx = targetPosRef.current.x - currentPosRef.current.x;
          const dy = targetPosRef.current.y - currentPosRef.current.y;
          currentPosRef.current.x += dx * 0.32;
          currentPosRef.current.y += dy * 0.32;
        }

        setLensPos({
          x: currentPosRef.current.x,
          y: currentPosRef.current.y,
        });
      }

      animId = requestAnimationFrame(updateLensLoop);
    };

    animId = requestAnimationFrame(updateLensLoop);
    return () => cancelAnimationFrame(animId);
  }, []);

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    targetPosRef.current = { x, y, active: true };
    if (!lensActive) {
      currentPosRef.current = { x, y };
      setLensPos({ x, y });
      setLensActive(true);
    }
  };

  const handlePointerLeave = () => {
    targetPosRef.current.active = false;
    setLensActive(false);
  };

  // Shared typography parameters ensuring 100% exact registration between Layer 1, Layer 3, and Layer 4
  const typographyStyle: React.CSSProperties = {
    fontSize: 'clamp(108px, 18vw, 288px)',
    lineHeight: 1,
    whiteSpace: 'nowrap',
    letterSpacing: '-0.02em',
    userSelect: 'none',
  };

  const topClip = lensPos.y - lensSize / 2;
  const rightClip = containerRect.width - (lensPos.x + lensSize / 2);
  const bottomClip = containerRect.height - (lensPos.y + lensSize / 2);
  const leftClip = lensPos.x - lensSize / 2;

  return (
    <div
      ref={containerRef}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      className="relative w-full h-[calc(100vh-7rem)] min-h-[550px] rounded-2xl overflow-hidden bg-[#242424] border border-zinc-800/80 shadow-2xl flex items-center justify-center cursor-crosshair select-none"
    >
      {/* CSS Keyframes for Experiment B.7: Independent Pseudo-Random Square Timelines with Hold Ranges */}
      <style>{`
        @keyframes cta-square-spin-a {
          0% { transform: rotate(0deg); }
          22% { transform: rotate(90deg); }
          42% { transform: rotate(90deg); }
          72% { transform: rotate(270deg); }
          86% { transform: rotate(270deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes cta-square-spin-b {
          0% { transform: rotate(0deg); }
          26% { transform: rotate(0deg); }
          50% { transform: rotate(180deg); }
          78% { transform: rotate(180deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes cta-square-spin-c {
          0% { transform: rotate(0deg); }
          30% { transform: rotate(90deg); }
          46% { transform: rotate(90deg); }
          74% { transform: rotate(270deg); }
          88% { transform: rotate(270deg); }
          100% { transform: rotate(360deg); }
        }
        .cta-square-a {
          animation: cta-square-spin-a 4.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        .cta-square-b {
          animation: cta-square-spin-b 6.1s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        .cta-square-c {
          animation: cta-square-spin-c 5.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .cta-square-a,
          .cta-square-b,
          .cta-square-c {
            animation: none !important;
            transform: none !important;
          }
        }
      `}</style>

      {/* Layer 0: Subtle centered neutral backlight for background depth */}
      <div
        className="absolute inset-0 pointer-events-none flex items-center justify-center"
        aria-hidden="true"
      >
        <div className="w-[50vw] max-w-[700px] h-[260px] rounded-full bg-white/[0.03] blur-[90px]" />
      </div>

      {/* Shared Coordinate Shell for Exact Typography Alignment */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
        {/* Layer 1: Solid Glowing Synq Typography (Behind Hands) */}
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none select-none z-10"
          aria-hidden="true"
        >
          <span
            className={`${pressStart2P.className} font-normal`}
            style={{
              ...typographyStyle,
              color: '#ffffff',
              textShadow:
                '0 0 15px rgba(255, 255, 255, 0.95), 0 0 40px rgba(255, 255, 255, 0.6), 0 0 85px rgba(255, 255, 255, 0.35)',
            }}
          >
            Synq
          </span>
        </div>

        {/* Layer 2: Colored Three.js Pixel Hands (Sandwiched Between Back and Front Typography) */}
        <div className="absolute inset-0 z-20 pointer-events-none">
          <InteractivePixelArtwork
            className="w-full h-full"
            debug={debugMode}
            artworkScale={1.60}
            preservePixelSize={true}
            transparentBackground={true}
            colorMode="original-color"
            disableLiquid={true}
            enableFlicker={true}
            lensActive={lensActive}
            lensX={lensPos.x}
            lensY={lensPos.y}
            lensSize={lensSize}
            lensRadius={lensRadius}
          />
        </div>

        {/* Layer 3: Crisp Outline Synq Typography (Over Hands) */}
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none select-none z-30"
          aria-hidden="true"
        >
          <span
            className={`${pressStart2P.className} font-normal`}
            style={{
              ...typographyStyle,
              color: 'transparent',
              WebkitTextStroke: '0.75px rgba(255, 255, 255, 0.82)',
              textShadow: 'none',
            }}
          >
            Synq
          </span>
        </div>

        {/* SVG Liquid Refraction Filter Definition */}
        <svg
          className="absolute w-0 h-0 pointer-events-none opacity-0 overflow-hidden"
          aria-hidden="true"
        >
          <defs>
            <filter id="synq-liquid-displacement" x="-20%" y="-20%" width="140%" height="140%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.013 0.016"
                numOctaves="2"
                seed="5"
                result="noise"
              >
                <animate
                  attributeName="baseFrequency"
                  dur="14s"
                  values="0.013 0.016; 0.016 0.012; 0.012 0.018; 0.013 0.016"
                  repeatCount="indefinite"
                />
              </feTurbulence>
              <feDisplacementMap
                in="SourceGraphic"
                in2="noise"
                scale="6.5"
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
          </defs>
        </svg>

        {/* Layer 4: Foreground Glowing Solid Synq Typography (Revealed Exclusively Inside the Liquid Lens Bounds with Refraction Displacement) */}
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none select-none z-35"
          style={{
            clipPath: lensActive
              ? `inset(${topClip}px ${rightClip}px ${bottomClip}px ${leftClip}px round ${lensRadius}px)`
              : 'inset(100%)',
            opacity: lensActive ? 1 : 0,
            transition: 'opacity 0.12s ease-out',
          }}
          aria-hidden="true"
        >
          <span
            className={`${pressStart2P.className} font-normal`}
            style={{
              ...typographyStyle,
              color: '#ffffff',
              textShadow:
                '0 0 15px rgba(255, 255, 255, 0.95), 0 0 40px rgba(255, 255, 255, 0.6), 0 0 85px rgba(255, 255, 255, 0.35)',
              filter: lensActive ? 'url(#synq-liquid-displacement)' : 'none',
            }}
          >
            Synq
          </span>
        </div>

        {/* Layer 5: Screen-Surface Liquid Membrane (Clean surface embedded into screen plane) */}
        {lensActive && (
          <div
            className="absolute pointer-events-none select-none z-40 rounded-[14px] overflow-hidden"
            style={{
              width: `${lensSize}px`,
              height: `${lensSize}px`,
              left: `${lensPos.x}px`,
              top: `${lensPos.y}px`,
              transform: 'translate(-50%, -50%)',
              backgroundColor: 'transparent',
              boxShadow:
                renderMode === 'A'
                  ? 'none'
                  : 'inset 1px 1.5px 3.5px 0px rgba(255, 255, 255, 0.14), inset 0 0 2.5px 0px rgba(255, 255, 255, 0.09)',
            }}
          >
            {/* Transparent liquid lens surface with microscopic optical sheen and zero opaque/translucent shapes */}
            {renderMode !== 'A' && (
              <LiquidLensSurface
                size={lensSize}
                radius={lensRadius}
                active={lensActive}
                mode={renderMode}
                onDiagnostic={setDiagnostic}
              />
            )}
          </div>
        )}
      </div>

      {/* Layer 5.5: Normal Public CTA State — Three Small Rotating White Squares (□ □ □) */}
      <div
        className="absolute bottom-7 md:bottom-9 left-1/2 -translate-x-1/2 w-[160px] h-[44px] flex items-center justify-center pointer-events-none select-none z-20"
        aria-hidden="true"
      >
        <div className="flex items-center justify-center gap-2">
          <div
            className="cta-square-a w-[10px] h-[10px] rounded-[3px] bg-white will-change-transform"
            title="Interactive indicator"
          />
          <div
            className="cta-square-b w-[10px] h-[10px] rounded-[3px] bg-white will-change-transform"
            title="Interactive indicator"
          />
          <div
            className="cta-square-c w-[10px] h-[10px] rounded-[3px] bg-white will-change-transform"
            title="Interactive indicator"
          />
        </div>
      </div>

      {/* Layer 6: Secret Layer — Rainbow Enter Button Revealed Spatially Through Liquid Lens Window */}
      <div
        className="absolute inset-0 pointer-events-none select-none z-30"
        style={{
          clipPath: lensActive
            ? `inset(${topClip}px ${rightClip}px ${bottomClip}px ${leftClip}px round ${lensRadius}px)`
            : 'inset(100%)',
        }}
        aria-hidden={!lensActive}
      >
        <div className="absolute bottom-7 md:bottom-9 left-1/2 -translate-x-1/2 w-[160px] h-[44px] pointer-events-auto">
          <Link href="/negotiator?new=1" className="inline-block no-underline">
            <RainbowButton speed={4}>
              <span className={`${pressStart2P.className} text-[11px] leading-none tracking-wider text-[#242424]`}>
                Enter
              </span>
            </RainbowButton>
          </Link>
        </div>
      </div>

      {/* Comprehensive development-only diagnostic HUD outside the lens (visible when ?debug=1) */}
      {debugMode && (
        <div className="absolute top-4 left-4 z-50 pointer-events-auto flex flex-col gap-2 p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-300 shadow-xl max-w-md select-text">
          <div className="flex items-center justify-between border-b border-zinc-800/80 pb-1.5">
            <span className="font-semibold text-zinc-100 uppercase tracking-wider text-[10px]">
              EXPERIMENT B.8 — LiquidLensSurface Diagnostic HUD
            </span>
            <span className="text-[10px] text-zinc-400">
              {lensActive ? `Tracking (${Math.round(lensPos.x)}, ${Math.round(lensPos.y)})` : 'Idle'}
            </span>
          </div>

          {/* Mode Switcher Buttons */}
          <div className="flex items-center gap-1.5 flex-wrap pt-1">
            <span className="text-[10px] text-zinc-400 uppercase tracking-wider font-semibold mr-1">Mode:</span>
            {(['A', 'B', 'C', 'D', 'E'] as LensRenderMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setRenderMode(m)}
                className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors ${
                  renderMode === m
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/60 font-bold'
                    : 'bg-zinc-900/60 text-zinc-400 border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                {m}
              </button>
            ))}
          </div>

          <div className="text-[10px] text-zinc-400 pb-1 border-b border-zinc-800/80">
            {renderMode === 'A' && 'A: Wrapper only (canvas unmounted). Expected: completely invisible.'}
            {renderMode === 'B' && 'B: Canvas clear(0,0,0,0) only. Expected: completely invisible.'}
            {renderMode === 'C' && 'C: Shader vec4(1,0,0,0). Expected: completely invisible.'}
            {renderMode === 'D' && 'D: Shader vec4(1,0,0,0.10). Expected: faint transparent red.'}
            {renderMode === 'E' && 'E: Liquid shader with straight-alpha blending.'}
          </div>

          {/* Diagnostic Telemetry Rows */}
          {diagnostic ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] pt-0.5">
              <div><span className="text-zinc-400">Renderer:</span> <span className="text-zinc-200">{diagnostic.renderer}</span></div>
              <div><span className="text-zinc-400">Context Lost:</span> <span className={diagnostic.contextLost ? 'text-red-400' : 'text-emerald-400'}>{diagnostic.contextLost ? 'YES' : 'NO'}</span></div>
              <div><span className="text-zinc-400">Alpha:</span> <span className="text-zinc-200">{diagnostic.alpha ? 'true' : 'false'}</span></div>
              <div><span className="text-zinc-400">Premultiplied:</span> <span className="text-zinc-200">{diagnostic.premultipliedAlpha ? 'true' : 'false'}</span></div>
              <div><span className="text-zinc-400">Blending:</span> <span className="text-zinc-200">{diagnostic.blendingEnabled ? 'SRC_ALPHA, 1-SRC_ALPHA' : 'DISABLED'}</span></div>
              <div><span className="text-zinc-400">Last GL Error:</span> <span className={diagnostic.lastGlError === 'NO_ERROR' ? 'text-emerald-400' : 'text-red-400'}>{diagnostic.lastGlError}</span></div>
              <div><span className="text-zinc-400">Shaders:</span> <span className="text-zinc-200">VS: {diagnostic.vertexShaderStatus} | FS: {diagnostic.fragmentShaderStatus}</span></div>
              <div><span className="text-zinc-400">Program Link:</span> <span className="text-zinc-200">{diagnostic.programLinkStatus}</span></div>
              <div><span className="text-zinc-400">Canvas CSS:</span> <span className="text-zinc-200">{diagnostic.cssSize}</span></div>
              <div><span className="text-zinc-400">Backing Buffer:</span> <span className="text-zinc-200">{diagnostic.backingBuffer}</span></div>
            </div>
          ) : (
            <div className="text-[10px] text-zinc-400">
              {renderMode === 'A' ? 'LiquidLensSurface canvas unmounted in Mode A.' : 'Waiting for canvas initialization...'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
