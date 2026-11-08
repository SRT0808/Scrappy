import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div aria-hidden="true" data-slot="skeleton" className={cn('rounded-lg bg-elevated motion-safe:animate-pulse', className)} {...props} />;
}

export { Skeleton };
