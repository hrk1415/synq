'use client';

import { useEffect, useRef } from 'react';

const SOURCE_WIDTH = 1185;
const SOURCE_HEIGHT = 696;
const CELL_SIZE = 10;
const HOVER_RADIUS = 52;
const HOVER_WHITE_ALPHA = 0.22;
const HOVER_CYAN_ALPHA = 0.12;
const HOVER_VIOLET_ALPHA = 0.06;
const MAX_DPR = 1.5;
const REST_THRESHOLD = 0.002;
const MAX_ACTIVE_BLINKS = 1800;
const MIN_BLINK_DELAY = 180;
const MAX_BLINK_DELAY = 340;
const MAX_LOCAL_BLINKS = 220;
const MIN_LOCAL_BLINK_DELAY = 35;
const MAX_LOCAL_BLINK_DELAY = 85;
const MAX_OUTSIDE_DISTANCE = 30;
const COLUMN_COUNT = Math.ceil(SOURCE_WIDTH / CELL_SIZE);
const ROW_COUNT = Math.ceil(SOURCE_HEIGHT / CELL_SIZE);

interface Point { x: number; y: number }

interface CanvasMetrics {
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  left: number;
  top: number;
  dpr: number;
}

type BlinkColor = 'white' | 'cyan' | 'violet';

interface BlinkRecord {
  row: number;
  column: number;
  startTime: number;
  duration: number;
  intensity: number;
  color: BlinkColor;
}

interface BlinkVisual {
  alpha: number;
  color: [number, number, number];
}

const smoothstep = (value: number) => value * value * (3 - 2 * value);
const blinkColor = (color: BlinkColor): [number, number, number] =>
  color === 'white' ? [226, 248, 255] : color === 'cyan' ? [88, 224, 255] : [174, 142, 255];

export default function InteractiveGlassGrid() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const metricsRef = useRef<CanvasMetrics>({
    width: 0, height: 0, scale: 1, offsetX: 0, offsetY: 0, left: 0, top: 0, dpr: 1,
  });
  const targetPointerRef = useRef<Point>({ x: 0, y: 0 });
  const visualPointerRef = useRef<Point>({ x: 0, y: 0 });
  const pointerActiveRef = useRef(false);
  const interactionStrengthRef = useRef(0);
  const pointerEnabledRef = useRef(false);
  const ambientEnabledRef = useRef(false);
  const animationFrameRef = useRef<number | null>(null);
  const previousFrameRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas?.parentElement;
    const context = canvas?.getContext('2d');
    if (!canvas || !container || !context) return;

    animationFrameRef.current = null;
    previousFrameRef.current = 0;

    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finePointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
    const globalBlinks: BlinkRecord[] = [];
    const globalBlinkKeys = new Set<number>();
    const localBlinks: BlinkRecord[] = [];
    const localBlinkKeys = new Set<number>();
    const localBlinkVisuals = new Map<number, BlinkVisual>();
    let blinkTimer: ReturnType<typeof setTimeout> | null = null;
    let localBlinkTimer: ReturnType<typeof setTimeout> | null = null;

    const getHoverInfluence = (centerX: number, centerY: number, strength: number) => {
      const pointer = visualPointerRef.current;
      const normalized = Math.max(0, 1 - Math.hypot(centerX - pointer.x, centerY - pointer.y) / HOVER_RADIUS);
      return smoothstep(normalized) * strength;
    };

    const getHoverCandidates = (metrics: CanvasMetrics, strength: number) => {
      const candidates = new Set<number>();
      if (strength <= REST_THRESHOLD) return candidates;
      const pointer = visualPointerRef.current;
      const minColumn = Math.max(0, Math.floor((((pointer.x - HOVER_RADIUS) - metrics.offsetX) / metrics.scale) / CELL_SIZE));
      const maxColumn = Math.min(COLUMN_COUNT - 1, Math.floor((((pointer.x + HOVER_RADIUS) - metrics.offsetX) / metrics.scale) / CELL_SIZE));
      const minRow = Math.max(0, Math.floor((((pointer.y - HOVER_RADIUS) - metrics.offsetY) / metrics.scale) / CELL_SIZE));
      const maxRow = Math.min(ROW_COUNT - 1, Math.floor((((pointer.y + HOVER_RADIUS) - metrics.offsetY) / metrics.scale) / CELL_SIZE));
      for (let row = minRow; row <= maxRow; row++) {
        for (let column = minColumn; column <= maxColumn; column++) {
          candidates.add(row * COLUMN_COUNT + column);
        }
      }
      return candidates;
    };

    const drawBlinkCell = (
      row: number,
      column: number,
      alpha: number,
      color: [number, number, number],
      metrics: CanvasMetrics
    ) => {
      const sourceLeft = column * CELL_SIZE;
      const sourceTop = row * CELL_SIZE;
      const width = Math.min(CELL_SIZE, SOURCE_WIDTH - sourceLeft) * metrics.scale;
      const height = Math.min(CELL_SIZE, SOURCE_HEIGHT - sourceTop) * metrics.scale;
      const x = metrics.offsetX + sourceLeft * metrics.scale;
      const y = metrics.offsetY + sourceTop * metrics.scale;
      context.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha * 0.48})`;
      context.fillRect(x + 0.5, y + 0.5, Math.max(1, width - 1), Math.max(1, height - 1));
      context.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
      context.fillRect(x + 0.5, y + height - 1, Math.max(1, width - 1), 0.75);
    };

    const drawGlobalBlinks = (timestamp: number, metrics: CanvasMetrics) => {
      let writeIndex = 0;
      for (let readIndex = 0; readIndex < globalBlinks.length; readIndex++) {
        const blink = globalBlinks[readIndex];
        const progress = (timestamp - blink.startTime) / blink.duration;
        const key = blink.row * COLUMN_COUNT + blink.column;
        if (progress >= 1) {
          globalBlinkKeys.delete(key);
          continue;
        }
        globalBlinks[writeIndex++] = blink;
        if (progress <= 0) continue;
        drawBlinkCell(
          blink.row,
          blink.column,
          blink.intensity * Math.sin(progress * Math.PI),
          blinkColor(blink.color),
          metrics
        );
      }
      globalBlinks.length = writeIndex;
    };

    const spawnGlobalBlinks = () => {
      if (!ambientEnabledRef.current) return;
      const metrics = metricsRef.current;
      const minColumn = Math.max(0, Math.floor((-metrics.offsetX / metrics.scale) / CELL_SIZE));
      const maxColumn = Math.min(COLUMN_COUNT - 1, Math.ceil(((metrics.width - metrics.offsetX) / metrics.scale) / CELL_SIZE) - 1);
      const minRow = Math.max(0, Math.floor((-metrics.offsetY / metrics.scale) / CELL_SIZE));
      const maxRow = Math.min(ROW_COUNT - 1, Math.ceil(((metrics.height - metrics.offsetY) / metrics.scale) / CELL_SIZE) - 1);
      const target = Math.min(MAX_ACTIVE_BLINKS - globalBlinks.length, 250 + Math.floor(Math.random() * 151));
      const now = performance.now();
      let spawned = 0;
      let attempts = 0;
      while (spawned < target && attempts < target * 3) {
        attempts++;
        const column = minColumn + Math.floor(Math.random() * Math.max(1, maxColumn - minColumn + 1));
        const row = minRow + Math.floor(Math.random() * Math.max(1, maxRow - minRow + 1));
        const key = row * COLUMN_COUNT + column;
        if (globalBlinkKeys.has(key)) continue;
        const colorRoll = Math.random();
        const intensityRoll = Math.random();
        const intensity = intensityRoll > 0.98
          ? 0.3 + Math.random() * 0.04
          : intensityRoll > 0.88 ? 0.2 + Math.random() * 0.1 : 0.06 + Math.random() * 0.12;
        globalBlinkKeys.add(key);
        globalBlinks.push({
          row,
          column,
          startTime: now + Math.random() * 220,
          duration: intensityRoll > 0.94 ? 900 + Math.random() * 300 : 250 + Math.random() * 600,
          intensity,
          color: colorRoll < 0.65 ? 'white' : colorRoll < 0.9 ? 'cyan' : 'violet',
        });
        spawned++;
      }
    };

    const spawnLocalBlinks = (timestamp: number) => {
      if (!pointerEnabledRef.current || !pointerActiveRef.current || localBlinks.length >= MAX_LOCAL_BLINKS) return;
      const metrics = metricsRef.current;
      const pointer = visualPointerRef.current;
      const spawnCount = Math.min(MAX_LOCAL_BLINKS - localBlinks.length, 5 + Math.floor(Math.random() * 8));

      for (let blinkIndex = 0; blinkIndex < spawnCount; blinkIndex++) {
        const zoneRoll = Math.random();
        const angle = Math.random() * Math.PI * 2;
        const radius = zoneRoll < 0.5
          ? Math.sqrt(Math.random()) * HOVER_RADIUS
          : zoneRoll < 0.85
            ? HOVER_RADIUS + 10 + Math.random() * 10
            : HOVER_RADIUS + 20 + Math.random() * (MAX_OUTSIDE_DISTANCE - 20);
        const localX = pointer.x + Math.cos(angle) * radius;
        const localY = pointer.y + Math.sin(angle) * radius;
        const column = Math.max(0, Math.min(COLUMN_COUNT - 1, Math.floor(((localX - metrics.offsetX) / metrics.scale) / CELL_SIZE)));
        const row = Math.max(0, Math.min(ROW_COUNT - 1, Math.floor(((localY - metrics.offsetY) / metrics.scale) / CELL_SIZE)));
        const key = row * COLUMN_COUNT + column;
        if (localBlinkKeys.has(key)) continue;

        const durationRoll = Math.random();
        const duration = durationRoll < 0.2
          ? 100 + Math.random() * 120
          : durationRoll < 0.9
            ? 220 + Math.random() * 300
            : 520 + Math.random() * 280;
        const intensityRoll = Math.random();
        const intensity = intensityRoll > 0.97
          ? 0.48 + Math.random() * 0.1
          : intensityRoll > 0.82
            ? 0.34 + Math.random() * 0.14
            : 0.2 + Math.random() * 0.14;
        const colorRoll = Math.random();
        localBlinkKeys.add(key);
        localBlinks.push({
          row,
          column,
          startTime: timestamp + Math.random() * 60,
          duration,
          intensity,
          color: colorRoll < 0.6 ? 'white' : colorRoll < 0.88 ? 'cyan' : 'violet',
        });
      }
    };

    const collectLocalBlinkVisuals = (timestamp: number) => {
      localBlinkVisuals.clear();
      let writeIndex = 0;
      for (let readIndex = 0; readIndex < localBlinks.length; readIndex++) {
        const blink = localBlinks[readIndex];
        const progress = (timestamp - blink.startTime) / blink.duration;
        const key = blink.row * COLUMN_COUNT + blink.column;
        if (progress >= 1) {
          localBlinkKeys.delete(key);
          continue;
        }
        localBlinks[writeIndex++] = blink;
        if (progress <= 0) continue;
        localBlinkVisuals.set(key, {
          alpha: blink.intensity * Math.sin(progress * Math.PI),
          color: blinkColor(blink.color),
        });
      }
      localBlinks.length = writeIndex;
    };

    const draw = (timestamp: number) => {
      animationFrameRef.current = null;
      if (!pointerEnabledRef.current && !ambientEnabledRef.current) {
        context.clearRect(0, 0, metricsRef.current.width, metricsRef.current.height);
        return;
      }
      const metrics = metricsRef.current;
      const target = targetPointerRef.current;
      const pointer = visualPointerRef.current;
      const elapsed = previousFrameRef.current ? Math.min(timestamp - previousFrameRef.current, 50) : 16;
      const frameScale = elapsed / 16.67;
      const pointerEasing = 1 - Math.pow(0.3, frameScale);
      const strengthTarget = pointerEnabledRef.current && pointerActiveRef.current ? 1 : 0;
      const strengthEasing = 1 - Math.pow(strengthTarget > interactionStrengthRef.current ? 0.55 : 0.82, frameScale);
      pointer.x += (target.x - pointer.x) * pointerEasing;
      pointer.y += (target.y - pointer.y) * pointerEasing;
      interactionStrengthRef.current += (strengthTarget - interactionStrengthRef.current) * strengthEasing;
      if (interactionStrengthRef.current <= REST_THRESHOLD) interactionStrengthRef.current = 0;
      previousFrameRef.current = timestamp;

      const strength = interactionStrengthRef.current;
      const candidates = getHoverCandidates(metrics, strength);
      context.clearRect(0, 0, metrics.width, metrics.height);
      drawGlobalBlinks(timestamp, metrics);

      for (const key of candidates) {
        const row = Math.floor(key / COLUMN_COUNT);
        const column = key % COLUMN_COUNT;
        const sourceLeft = column * CELL_SIZE;
        const sourceTop = row * CELL_SIZE;
        const width = Math.min(CELL_SIZE, SOURCE_WIDTH - sourceLeft) * metrics.scale;
        const height = Math.min(CELL_SIZE, SOURCE_HEIGHT - sourceTop) * metrics.scale;
        const x = metrics.offsetX + sourceLeft * metrics.scale;
        const y = metrics.offsetY + sourceTop * metrics.scale;
        const influence = getHoverInfluence(x + width / 2, y + height / 2, strength);
        if (influence <= REST_THRESHOLD) continue;
        context.fillStyle = `rgba(226, 248, 255, ${HOVER_WHITE_ALPHA * influence})`;
        context.fillRect(x + 0.5, y + 0.5, Math.max(1, width - 1), Math.max(1, height - 1));
        context.fillStyle = `rgba(88, 224, 255, ${HOVER_CYAN_ALPHA * influence})`;
        context.fillRect(x + 0.5, y + height - 1, Math.max(1, width - 1), 0.75);
        context.fillStyle = `rgba(174, 142, 255, ${HOVER_VIOLET_ALPHA * influence})`;
        context.fillRect(x + width - 1, y + 0.5, 0.75, Math.max(1, height - 1));
      }

      collectLocalBlinkVisuals(timestamp);
      for (const [key, visual] of localBlinkVisuals) {
        const row = Math.floor(key / COLUMN_COUNT);
        const column = key % COLUMN_COUNT;
        const sourceLeft = column * CELL_SIZE;
        const sourceTop = row * CELL_SIZE;
        const width = Math.min(CELL_SIZE, SOURCE_WIDTH - sourceLeft) * metrics.scale;
        const height = Math.min(CELL_SIZE, SOURCE_HEIGHT - sourceTop) * metrics.scale;
        const x = metrics.offsetX + sourceLeft * metrics.scale;
        const y = metrics.offsetY + sourceTop * metrics.scale;
        const hoverAlpha = HOVER_WHITE_ALPHA * getHoverInfluence(x + width / 2, y + height / 2, strength);
        const alpha = Math.max(0, Math.min(0.6 - hoverAlpha, visual.alpha));
        if (alpha > 0) drawBlinkCell(row, column, alpha, visual.color, metrics);
      }

      const pointerDistance = Math.hypot(target.x - pointer.x, target.y - pointer.y);
      const strengthDistance = Math.abs(strengthTarget - interactionStrengthRef.current);
      if (pointerDistance > 0.1 || strengthDistance > REST_THRESHOLD || localBlinks.length > 0 || globalBlinks.length > 0) {
        animationFrameRef.current = requestAnimationFrame(draw);
      } else {
        previousFrameRef.current = 0;
      }
    };

    const requestDraw = () => {
      if ((pointerEnabledRef.current || ambientEnabledRef.current) && animationFrameRef.current === null) {
        animationFrameRef.current = requestAnimationFrame(draw);
      }
    };

    const scheduleAmbientBlinks = () => {
      if (blinkTimer !== null) clearTimeout(blinkTimer);
      if (!ambientEnabledRef.current) return;
      const delay = MIN_BLINK_DELAY + Math.random() * (MAX_BLINK_DELAY - MIN_BLINK_DELAY);
      blinkTimer = setTimeout(() => {
        blinkTimer = null;
        spawnGlobalBlinks();
        requestDraw();
        scheduleAmbientBlinks();
      }, delay);
    };

    const scheduleLocalBlinks = () => {
      if (localBlinkTimer !== null) clearTimeout(localBlinkTimer);
      if (!pointerEnabledRef.current || !pointerActiveRef.current) return;
      const delay = MIN_LOCAL_BLINK_DELAY + Math.random() * (MAX_LOCAL_BLINK_DELAY - MIN_LOCAL_BLINK_DELAY);
      localBlinkTimer = setTimeout(() => {
        localBlinkTimer = null;
        spawnLocalBlinks(performance.now());
        requestDraw();
        scheduleLocalBlinks();
      }, delay);
    };

    const resize = () => {
      const bounds = container.getBoundingClientRect();
      const width = bounds.width;
      const height = bounds.height;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const scale = Math.max(width / SOURCE_WIDTH, height / SOURCE_HEIGHT);
      metricsRef.current = {
        width,
        height,
        scale,
        offsetX: (width - SOURCE_WIDTH * scale) / 2,
        offsetY: (height - SOURCE_HEIGHT * scale) / 2,
        left: bounds.left,
        top: bounds.top,
        dpr,
      };
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      requestDraw();
    };

    const deactivatePointer = () => {
      if (!pointerActiveRef.current) return;
      pointerActiveRef.current = false;
      if (localBlinkTimer !== null) clearTimeout(localBlinkTimer);
      localBlinkTimer = null;
      requestDraw();
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!pointerEnabledRef.current || event.pointerType === 'touch') return;
      const metrics = metricsRef.current;
      const x = event.clientX - metrics.left;
      const y = event.clientY - metrics.top;
      const isInside = x >= 0 && y >= 0 && x <= metrics.width && y <= metrics.height;
      targetPointerRef.current = { x, y };
      if (isInside && !pointerActiveRef.current) {
        if (interactionStrengthRef.current === 0) visualPointerRef.current = { x, y };
        pointerActiveRef.current = true;
        scheduleLocalBlinks();
      } else if (!isInside) {
        deactivatePointer();
      }
      requestDraw();
    };

    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) deactivatePointer();
    };

    const updateCapability = () => {
      const motionAllowed = !reducedMotionQuery.matches;
      pointerEnabledRef.current = finePointerQuery.matches && motionAllowed;
      ambientEnabledRef.current = motionAllowed;
      if (!pointerEnabledRef.current) {
        pointerActiveRef.current = false;
        interactionStrengthRef.current = 0;
        localBlinks.length = 0;
        localBlinkKeys.clear();
        if (localBlinkTimer !== null) clearTimeout(localBlinkTimer);
        localBlinkTimer = null;
      }
      if (!ambientEnabledRef.current) {
        globalBlinks.length = 0;
        globalBlinkKeys.clear();
      }
      if (!pointerEnabledRef.current && !ambientEnabledRef.current) {
        context.clearRect(0, 0, metricsRef.current.width, metricsRef.current.height);
        if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
        previousFrameRef.current = 0;
      }
      scheduleAmbientBlinks();
      scheduleLocalBlinks();
      requestDraw();
    };

    const resizeObserver = new ResizeObserver(resize);
    updateCapability();
    resize();
    resizeObserver.observe(container);
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('pointerout', handlePointerOut);
    window.addEventListener('blur', deactivatePointer);
    finePointerQuery.addEventListener('change', updateCapability);
    reducedMotionQuery.addEventListener('change', updateCapability);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerout', handlePointerOut);
      window.removeEventListener('blur', deactivatePointer);
      finePointerQuery.removeEventListener('change', updateCapability);
      reducedMotionQuery.removeEventListener('change', updateCapability);
      if (blinkTimer !== null) clearTimeout(blinkTimer);
      if (localBlinkTimer !== null) clearTimeout(localBlinkTimer);
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
      previousFrameRef.current = 0;
      pointerActiveRef.current = false;
      interactionStrengthRef.current = 0;
      targetPointerRef.current = { x: 0, y: 0 };
      visualPointerRef.current = { x: 0, y: 0 };
      pointerEnabledRef.current = false;
      ambientEnabledRef.current = false;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 h-full w-full pointer-events-none"
    />
  );
}
