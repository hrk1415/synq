'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

interface HyperTextProps {
  text: string;
  /** Total scramble time in ms */
  duration?: number;
  className?: string;
  animateOnLoad?: boolean;
}

/**
 * Scrambles the text with random letters, then settles left-to-right.
 * Re-runs on hover.
 */
export function HyperText({ text, duration = 800, className, animateOnLoad = true }: HyperTextProps) {
  const [displayed, setDisplayed] = useState(text);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameRef = useRef(0);

  const start = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    frameRef.current = 0;
    const totalFrames = Math.max(1, Math.ceil(duration / 30));
    intervalRef.current = setInterval(() => {
      frameRef.current += 1;
      const settled = Math.floor((frameRef.current / totalFrames) * text.length);
      setDisplayed(
        text
          .split('')
          .map((ch, i) => {
            if (ch === ' ') return ' ';
            if (i < settled) return ch;
            return LETTERS[Math.floor(Math.random() * LETTERS.length)];
          })
          .join('')
      );
      if (frameRef.current >= totalFrames) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        setDisplayed(text);
      }
    }, 30);
  };

  useEffect(() => {
    if (animateOnLoad) start();
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <span onMouseEnter={start} className={cn('inline-block cursor-default', className)}>
      {displayed}
    </span>
  );
}