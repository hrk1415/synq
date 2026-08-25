'use client';

import { useState } from 'react';
import { motion, useMotionValue, useAnimationFrame } from 'framer-motion';
import { cn } from '@/lib/utils';

interface BorderBeamPanelProps {
  className?: string;
  children?: React.ReactNode;
  beams?: number;
  thickness?: number;
  radius?: number;
  glow?: boolean;
  color?: string;
  speed?: number;
}

export function BorderBeamPanel({
  className,
  children,
  beams = 2,
  thickness = 2,
  radius = 18,
  glow = false,
  color = '#8b5cf6',
  speed = 1,
}: BorderBeamPanelProps) {
  const [hovered, setHovered] = useState(false);
  const rotate = useMotionValue(0);
  const speedVal = useMotionValue(0.06);

  useAnimationFrame((_, delta) => {
    const target = hovered ? 0.4 : 0.06;
    const cur = speedVal.get();
    const eased = cur + (target - cur) * Math.min(1, delta / 220);
    speedVal.set(eased);
    rotate.set(rotate.get() + eased * delta * speed);
  });

  const ringMask = 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)';

  return (
    <div
      className={cn('group relative', className)}
      style={{ borderRadius: radius }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {Array.from({ length: Math.max(1, beams) }).map((_, i) => (
        <motion.div
          key={i}
          className="absolute inset-0 pointer-events-none"
          style={{
            padding: thickness,
            borderRadius: radius,
            background: `conic-gradient(from ${(i * 360) / beams}deg, transparent 0deg, ${color} 26deg, transparent 64deg)`,
            WebkitMask: ringMask,
            WebkitMaskComposite: 'xor',
            mask: ringMask,
            maskComposite: 'exclude',
            rotate,
            filter: glow ? `drop-shadow(0 0 6px ${color})` : undefined,
          }}
        />
      ))}
      {glow && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ borderRadius: radius, boxShadow: `0 0 26px -4px ${color}, 0 0 64px -14px ${color}` }}
        />
      )}
      <div className="relative h-full">{children}</div>
    </div>
  );
}
