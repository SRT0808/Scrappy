import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

/** Shared skin for text inputs and native selects. */
export const fieldClass = 'w-full min-w-0 rounded-lg border border-input bg-background px-3 text-foreground outline-none transition-colors placeholder:text-subtle-foreground hover:border-subtle-foreground focus-visible:border-ring focus-visible:focus-ring disabled:opacity-50 aria-invalid:border-destructive';

function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn('flex min-h-11 py-2.5 text-base', fieldClass, className)} {...props} />;
}

export { Input };
