'use client';

import { useState } from 'react';
import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StarRatingProps {
  /** Rating value, 0–5. */
  value: number;
  /** When provided, stars become interactive and call this with 1–5. */
  onChange?: (rating: number) => void;
  size?: number;
  /** Number of reviews — shown as "(N)" and drives the empty state in display mode. */
  count?: number;
  readOnly?: boolean;
  className?: string;
}

/**
 * Star rating used both to display a seller's aggregate rating (readOnly) and to
 * collect a buyer's rating (interactive). Distinct from the on-chain trust score
 * in useReputation — this is a human 1–5 review score.
 */
export function StarRating({ value, onChange, size = 14, count, readOnly = false, className }: StarRatingProps) {
  const [hover, setHover] = useState(0);
  const interactive = !readOnly && !!onChange;

  // Display, no reviews yet.
  if (readOnly && count === 0) {
    return (
      <span className={cn('flex items-center gap-1 text-xs text-zinc-500', className)}>
        <Star size={size} className="text-zinc-600" /> No ratings yet
      </span>
    );
  }

  const active = interactive ? (hover || value) : value;

  return (
    <span className={cn('flex items-center gap-1', className)}>
      <span className="flex items-center">
        {[0, 1, 2, 3, 4].map((i) => {
          const filled = i < Math.round(active);
          const star = (
            <Star
              size={size}
              className={cn(
                'transition-colors',
                filled ? 'fill-amber-400 text-amber-400' : 'text-zinc-600',
              )}
            />
          );
          if (!interactive) return <span key={i}>{star}</span>;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onChange!(i + 1)}
              onMouseEnter={() => setHover(i + 1)}
              onMouseLeave={() => setHover(0)}
              className="p-0.5 -m-0.5 cursor-pointer hover:scale-110 transition-transform"
              aria-label={`${i + 1} star${i ? 's' : ''}`}
            >
              {star}
            </button>
          );
        })}
      </span>
      {readOnly && (
        <span className="text-xs text-zinc-400">
          {value.toFixed(1)}
          {typeof count === 'number' && <span className="text-zinc-500"> ({count})</span>}
        </span>
      )}
    </span>
  );
}
