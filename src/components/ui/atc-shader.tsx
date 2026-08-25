"use client"

import { useEffect, useRef } from "react"

const VERT = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

const FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 2; i++) {
    v += amp * noise(p);
    p *= 2.1;
    amp *= 0.55;
  }
  return v;
}

vec3 palette(float t) {
  return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time * 0.08;

  float n1 = fbm(uv * 3.0 + vec2(t, -t * 0.5));
  float n2 = fbm(uv * 2.0 - vec2(t * 0.6, t * 0.3) + n1 * 1.2);

  vec3 col = palette(0.42 + n1 * 0.5 + n2 * 0.3);
  float vignette = 1.0 - 0.35 * length(uv);
  col *= vignette;
  gl_FragColor = vec4(col, 1.0);
}
`

export default function ShaderDemo_ATC({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = (canvas.getContext("webgl", { antialias: false }) || canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null
    if (!gl) return
    const GL: WebGLRenderingContext = gl

    function compile(type: number, src: string) {
      const sh = GL.createShader(type)
      if (!sh) return null
      GL.shaderSource(sh, src)
      GL.compileShader(sh)
      if (!GL.getShaderParameter(sh, GL.COMPILE_STATUS)) {
        console.error(GL.getShaderInfoLog(sh))
        GL.deleteShader(sh)
        return null
      }
      return sh
    }

    const vs = compile(GL.VERTEX_SHADER, VERT)
    const fs = compile(GL.FRAGMENT_SHADER, FRAG)
    if (!vs || !fs) return

    const prog = GL.createProgram()
    if (!prog) return
    GL.attachShader(prog, vs)
    GL.attachShader(prog, fs)
    GL.linkProgram(prog)
    if (!GL.getProgramParameter(prog, GL.LINK_STATUS)) {
      console.error(GL.getProgramInfoLog(prog))
      return
    }
    // eslint-disable-next-line react-hooks/rules-of-hooks -- WebGL's gl.useProgram(), not a React hook; the linter matches on the "use" prefix.
    GL.useProgram(prog)

    const buf = GL.createBuffer()
    GL.bindBuffer(GL.ARRAY_BUFFER, buf)
    GL.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), GL.STATIC_DRAW)
    const loc = GL.getAttribLocation(prog, "a_pos")
    GL.enableVertexAttribArray(loc)
    GL.vertexAttribPointer(loc, 2, GL.FLOAT, false, 0, 0)

    const uRes = GL.getUniformLocation(prog, "u_res")
    const uTime = GL.getUniformLocation(prog, "u_time")

    const resize = () => {
      // Half-resolution render + DPR cap keeps the page light on GPU
      const dpr = Math.min(window.devicePixelRatio || 1, 1)
      const scale = 0.5
      canvas.width = Math.floor(window.innerWidth * dpr * scale)
      canvas.height = Math.floor(window.innerHeight * dpr * scale)
      GL.viewport(0, 0, canvas.width, canvas.height)
    }
    resize()
    window.addEventListener("resize", resize)

    let raf = 0
    let frame = 0
    const start = performance.now()
    const render = () => {
      // Cap at ~30fps to keep the effect gentle on GPU
      frame++
      if (frame % 2 === 0) {
        raf = requestAnimationFrame(render)
        return
      }
      GL.uniform2f(uRes, canvas.width, canvas.height)
      GL.uniform1f(uTime, (performance.now() - start) / 1000)
      GL.drawArrays(GL.TRIANGLE_STRIP, 0, 4)
      raf = requestAnimationFrame(render)
    }
    const onVisibility = () => {
      cancelAnimationFrame(raf)
      if (!document.hidden) raf = requestAnimationFrame(render)
    }
    document.addEventListener("visibilitychange", onVisibility)
    render()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("resize", resize)
      document.removeEventListener("visibilitychange", onVisibility)
      GL.deleteProgram(prog)
    }
  }, [])

  return <canvas ref={canvasRef} className={`fixed inset-0 w-full h-full ${className}`} />
}