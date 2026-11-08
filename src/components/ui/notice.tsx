import type { ComponentProps, ReactNode } from 'react';
import { CircleAlert, CircleCheck, Clock3, Info } from 'lucide-react';
import { cn } from '../../lib/utils';

const tones = {
  error: { box: 'border-destructive/30 bg-destructive/8', Icon: CircleAlert, icon: 'text-destructive' },
  warn: { box: 'border-warn/30 bg-warn/8', Icon: Clock3, icon: 'text-warn' },
  info: { box: 'border-info/30 bg-info/8', Icon: Info, icon: 'text-info' },
  success: { box: 'border-border-strong bg-elevated', Icon: CircleCheck, icon: 'text-good' },
};

type Props = ComponentProps<'div'> & { tone?: keyof typeof tones; action?: ReactNode };

/** Inline message. Callers keep role="alert" / role="status" on it or around it. */
function Notice({ tone = 'error', action, className, children, ...props }: Props) {
  const { box, Icon, icon } = tones[tone];
  return <div data-slot="notice" className={cn('flex items-start gap-3 rounded-xl border px-3.5 py-3 text-sm leading-relaxed text-foreground', box, className)} {...props}>
    <Icon aria-hidden="true" className={cn('mt-0.5 size-[18px] shrink-0', icon)} />
    <div className="min-w-0 flex-1">{children}</div>
    {action && <div className="shrink-0">{action}</div>}
  </div>;
}

export { Notice };
