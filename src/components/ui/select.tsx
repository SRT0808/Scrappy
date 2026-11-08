import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';
import { fieldClass } from './input';

/** Class for native selects; same skin as Input. */
export const selectClass = cn('h-11 text-sm', fieldClass);

function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select data-slot="select" className={cn(selectClass, className)} {...props} />;
}

export { Select };
