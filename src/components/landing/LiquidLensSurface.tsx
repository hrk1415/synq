'use client';

import React, { useEffect, useRef } from 'react';

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

export interface LiquidLensSurfaceProps {
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

// Diagnostic Mode E: Production Liquid Shader with straight-alpha blending
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

export function LiquidLensSurface({
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

export default LiquidLensSurface;
