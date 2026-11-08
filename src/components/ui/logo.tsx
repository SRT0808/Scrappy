import { cn } from '../../lib/utils';

function Logo({ className }: { className?: string }) {
  return <span className={cn('flex items-center gap-2.5', className)}>
    <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7l6 6 4-4 8 8" /><path d="M15 17h6v-6" /></svg>
    </span>
    <span className="text-lg font-semibold tracking-tight">scrappy</span>
  </span>;
}

export { Logo };
