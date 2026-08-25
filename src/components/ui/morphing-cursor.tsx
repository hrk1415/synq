'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

interface MorphingCursorProps {
  text: string;
  /** Total sweep time in ms */
  duration?: number;
  className?: string;
  animateOnLoad?: boolean;
}

/**
 * A cursor sweeps across the text: letters solidify as it passes, the letter
 * under the cursor flickers through random characters, upcoming letters stay
 * ghosted. The cursor blinks at the end. Re-runs on hover.
 */
export function MorphingCursor({ text, duration = 1400, className, animateOnLoad = true }: MorphingCursorProps) {
  const [cursor, setCursor] = useState(0);
  const [morphChar, setMorphChar] = useState('A');
  const rafRef = useRef<number | null>(null);
  const flickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef(0);

  const run = useCallback(() => {
    if (flickerRef.current) clearInterval(flickerRef.current);
    flickerRef.current = setInterval(() => {
      setMorphChar(LETTERS[Math.floor(Math.random() * LETTERS.length)]);
    }, 50);
    startRef.current = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startRef.current) / duration);
      setCursor(Math.floor(progress * text.length));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setCursor(text.length);
        if (flickerRef.current) clearInterval(flickerRef.current);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [text, duration]);

  useEffect(() => {
    if (animateOnLoad) run();
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (flickerRef.current) clearInterval(flickerRef.current);
    };
  }, [run, animateOnLoad]);

  return (
    <span
      onMouseEnter={run}
      className={cn('inline-block cursor-default whitespace-pre', className)}
      aria-label={text}
    >
      {text.split('').map((ch, i) => {
        if (ch === ' ') return <span key={i}> </span>;
        if (i < cursor) return <span key={i}>{ch}</span>;
        if (i === cursor) return <span key={i} className="opacity-70">{morphChar}</span>;
        return <span key={i} className="opacity-25">{ch}</span>;
      })}
      <span
        aria-hidden
        className="inline-block align-baseline ml-1 w-[0.07em] h-[0.9em] bg-current animate-pulse"
      />
    </span>
  );
}

interface MagneticTextProps {
  text: string;
  /** What the text morphs into while hovered */
  hoverText: string;
  duration?: number;
  className?: string;
}

/**
 * On hover the text scrambles and morphs into `hoverText`; on leave it
 * morphs back to `text`.
 */
export function MagneticText({ text, hoverText, duration = 600, className }: MagneticTextProps) {
  const [displayed, setDisplayed] = useState(text);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const morphTo = useCallback((target: string) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    const totalFrames = Math.max(1, Math.ceil(duration / 30));
    let frame = 0;
    intervalRef.current = setInterval(() => {
      frame += 1;
      const settled = Math.floor((frame / totalFrames) * target.length);
      setDisplayed(
        target
          .split('')
          .map((ch, i) => {
            if (i < settled || ch === ' ') return ch;
            return LETTERS[Math.floor(Math.random() * LETTERS.length)];
          })
          .join('')
      );
      if (frame >= totalFrames) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        setDisplayed(target);
      }
    }, 30);
  }, [duration]);

  useEffect(() => () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
  }, []);

  return (
    <span
      onMouseEnter={() => morphTo(hoverText)}
      onMouseLeave={() => morphTo(text)}
      className={cn('inline-block cursor-default', className)}
    >
      {displayed}
    </span>
  );
}