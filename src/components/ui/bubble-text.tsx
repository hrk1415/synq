'use client';

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

interface BubbleTextProps {
  text?: string;
  className?: string;
}

/**
 * Each letter is its own spring: hovering a letter makes it bubble up
 * (rise + scale) and settle back down.
 */
export function BubbleText({ text = 'Bubble Text', className }: BubbleTextProps) {
  const [hoveredLetter, setHoveredLetter] = useState<string | null>(null);

  const letters = useMemo(() => {
    return text.split('').map((l, idx) => ({
      char: l === ' ' ? '\u00A0' : l,
      id: `${idx}-${l}`,
    }));
  }, [text]);

  return (
    <div
      className={cn(
        'flex justify-center overflow-hidden py-1 font-bold tracking-tight',
        className
      )}
    >
      {letters.map((letterObject, idx) => (
        <BubbleLetter
          key={`${letterObject.id}-${idx}`}
          letter={letterObject.char}
          hoveredLetter={hoveredLetter}
          onMouseEnter={setHoveredLetter}
          onMouseLeave={() => setHoveredLetter(null)}
        />
      ))}
    </div>
  );
}

function BubbleLetter({
  letter,
  hoveredLetter,
  onMouseEnter,
  onMouseLeave,
}: {
  letter: string;
  hoveredLetter: string | null;
  onMouseEnter: (letter: string) => void;
  onMouseLeave: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isHovered = hovered || letter === hoveredLetter;

  return (
    <motion.span
      className="inline-block"
      animate={isHovered ? { y: -18, scale: 1.25 } : { y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 260, damping: 10 }}
      onMouseEnter={() => {
        setHovered(true);
        onMouseEnter(letter);
      }}
      onMouseLeave={() => {
        setHovered(false);
        onMouseLeave();
      }}
    >
      {letter}
    </motion.span>
  );
}