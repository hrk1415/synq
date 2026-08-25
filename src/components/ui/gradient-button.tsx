'use client';

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';

interface GradientButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'variant';
  size?: 'default' | 'sm';
  asChild?: boolean;
}

const variants: Record<NonNullable<GradientButtonProps['variant']>, string> = {
  default:
    'bg-gradient-to-r from-blue-600 to-violet-600 text-white shadow-lg shadow-blue-600/25 hover:shadow-blue-500/40 hover:brightness-110 active:scale-[0.98]',
  variant:
    'bg-gradient-to-r from-blue-600/10 to-violet-600/10 text-blue-400 border border-blue-500/40 hover:border-blue-500/70 hover:from-blue-600/20 hover:to-violet-600/20 hover:text-white active:scale-[0.98]',
};

const sizes: Record<NonNullable<GradientButtonProps['size']>, string> = {
  default: 'h-10 px-5 text-sm font-semibold rounded-xl',
  sm: 'h-8 px-4 text-xs font-medium rounded-lg',
};

export const GradientButton = forwardRef<HTMLButtonElement, GradientButtonProps>(
  ({ className, variant = 'default', size = 'default', asChild, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center gap-2 transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:pointer-events-none',
          variants[variant],
          sizes[size],
          className
        )}
        {...props}
      />
    );
  }
);

GradientButton.displayName = 'GradientButton';

export { GradientButton as Demo };