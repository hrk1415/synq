'use client';

import React from 'react';
import { cn } from '@/lib/utils';

export interface RainbowButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  speed?: number;
  children?: React.ReactNode;
}

export const RainbowButton = React.forwardRef<HTMLButtonElement, RainbowButtonProps>(
  ({ className, speed = 4, children, style, ...props }, ref) => {
    return (
      <>
        <style>{`
          @keyframes rainbow-internal-flow {
            0% {
              transform: translate3d(-18%, 8%, 0) rotate(0deg);
            }
            50% {
              transform: translate3d(18%, 2%, 0) rotate(180deg);
            }
            100% {
              transform: translate3d(-18%, 8%, 0) rotate(360deg);
            }
          }
        `}</style>
        <button
          ref={ref}
          type="button"
          className={cn(
            'group relative inline-flex items-center justify-center h-[44px] w-[160px] min-w-[160px] px-6 rounded-xl overflow-hidden cursor-pointer select-none bg-white transition-all duration-200 active:scale-[0.98] hover:-translate-y-0.5 shadow-[0_4px_16px_rgba(0,0,0,0.25)] border border-white/80',
            className
          )}
          style={style}
          {...props}
        >
          {/* Layer 1: Internal Animated Rainbow Light Layer (underneath white surface, clipped by button overflow) */}
          <span
            className="absolute -inset-10 pointer-events-none opacity-90 group-hover:opacity-100 transition-opacity duration-300 blur-[12px] motion-safe:animate-[rainbow-internal-flow_linear_infinite] motion-reduce:hidden"
            style={{
              animationDuration: `${speed}s`,
              background:
                'conic-gradient(from 0deg at 50% 68%, #ec4899 0deg, #c084fc 40deg, #6366f1 85deg, #38bdf8 135deg, #10b981 185deg, #facc15 235deg, #fb923c 285deg, #f43f5e 325deg, #ec4899 360deg)',
            }}
            aria-hidden="true"
          />

          {/* Static restrained rainbow fallback for prefers-reduced-motion */}
          <span
            className="absolute -inset-6 pointer-events-none hidden motion-reduce:block opacity-85 blur-[11px]"
            style={{
              background:
                'linear-gradient(90deg, #ec4899, #c084fc, #38bdf8, #10b981, #facc15, #fb923c)',
            }}
            aria-hidden="true"
          />

          {/* Layer 2: White Surface & Light Diffusion (Allows 8-18px soft rainbow bleed at bottom/corners, center remains pure white) */}
          <span
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'radial-gradient(ellipse 94% 76% at 50% 22%, rgba(255, 255, 255, 0.98) 0%, rgba(255, 255, 255, 0.88) 50%, rgba(255, 255, 255, 0.64) 100%)',
            }}
            aria-hidden="true"
          />

          {/* Microscopic inner white rim ensuring physical outer edge always reads crisp white */}
          <span
            className="absolute inset-0 pointer-events-none rounded-xl"
            style={{
              boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.95)',
            }}
            aria-hidden="true"
          />

          {/* Layer 3: Text Content (Highest layer, charcoal #242424) */}
          <span className="relative z-10 flex items-center justify-center text-[#242424] font-medium tracking-wider text-xs">
            {children}
          </span>
        </button>
      </>
    );
  }
);

RainbowButton.displayName = 'RainbowButton';
export default RainbowButton;
