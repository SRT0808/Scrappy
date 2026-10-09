import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return <input type={type} data-slot="input"
    className={cn('flex min-h-12 w-full rounded-lg border border-input bg-background px-3 py-3 text-base text-foreground shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50 aria-invalid:border-destructive', className)}
    {...props} />;
}

export { Input };
