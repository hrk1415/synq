import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[#101010] disabled:pointer-events-none disabled:opacity-40 select-none',
  {
    variants: {
      variant: {
        default: 'bg-white text-[#101010] hover:bg-neutral-200 active:bg-neutral-300 shadow-sm',
        destructive: 'bg-red-600 text-white hover:bg-red-500 active:bg-red-700 shadow-sm',
        outline: 'border border-white/40 bg-[#1B1B1B] text-white hover:bg-[#252525] hover:border-white/80 active:bg-[#2A2A2A]',
        secondary: 'bg-[#252525] text-white hover:bg-[#303030] border border-white/20 active:bg-[#383838]',
        ghost: 'text-[#A3A3A3] hover:text-white hover:bg-white/10 active:bg-white/15',
        link: 'text-white underline-offset-4 hover:underline hover:text-neutral-200',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 rounded-lg px-3 text-xs',
        lg: 'h-12 rounded-xl px-6 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
