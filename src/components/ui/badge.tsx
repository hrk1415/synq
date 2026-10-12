import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'border border-white/20 bg-[#252525] text-white',
        secondary: 'border border-[#383838] bg-[#1B1B1B] text-[#A3A3A3]',
        destructive: 'border-transparent bg-red-600/20 text-red-400',
        success: 'border-transparent bg-emerald-600/20 text-emerald-400',
        warning: 'border-transparent bg-amber-600/20 text-amber-400',
        info: 'border border-white/30 bg-[#252525] text-white',
        outline: 'text-white border-white/40 bg-transparent',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
