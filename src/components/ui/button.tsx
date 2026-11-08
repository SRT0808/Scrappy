import type { ComponentProps } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium outline-none transition-colors motion-safe:duration-150 focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary font-semibold text-primary-foreground hover:bg-primary/85',
        outline: 'border border-border-strong bg-transparent text-foreground hover:bg-elevated',
        ghost: 'text-muted-foreground hover:bg-elevated hover:text-foreground',
        destructive: 'border border-destructive/35 bg-transparent text-destructive hover:bg-destructive/10',
        nav: 'w-full justify-start px-3 text-muted-foreground hover:bg-elevated hover:text-foreground aria-[current=page]:bg-elevated aria-[current=page]:text-foreground',
        link: 'min-h-0 px-0 py-0 text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground',
      },
      size: {
        default: '',
        sm: 'min-h-9 px-3 text-[13px]',
        icon: 'size-11 px-0 py-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

function Button({ className, variant, size, asChild = false, ...props }:
  ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
