'use client';

import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

interface GradientBlobCardProps {
  children?: React.ReactNode;
  className?: string;
  colors?: string[];
  intensity?: number;
}

export function GradientBlobCard({
  children,
  className,
  colors = ['#5C447A', '#9C6A97', '#CB8E9F', '#F3B294', '#FFEAA9'],
  intensity = 0.35,
}: GradientBlobCardProps) {
  return (
    <div className={cn('relative overflow-hidden rounded-xl border border-white/10 bg-zinc-900/80 backdrop-blur-sm', className)}>
      <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
        {colors.map((c, i) => (
          <motion.div
            key={i}
            className="absolute rounded-full blur-3xl"
            style={{
              background: c,
              width: '60%',
              height: '60%',
              left: `${(i * 37) % 70}%`,
              top: `${(i * 53) % 60}%`,
              opacity: intensity,
            }}
            animate={{
              x: [0, 30, -20, 0],
              y: [0, -25, 20, 0],
              scale: [1, 1.25, 0.9, 1],
            }}
            transition={{
              duration: 12 + i * 3,
              repeat: Infinity,
              ease: 'easeInOut',
            }}
          />
        ))}
      </div>
      <div className="relative z-10 h-full">{children}</div>
    </div>
  );
}

export default GradientBlobCard;
