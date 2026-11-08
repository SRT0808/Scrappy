import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

type Props = { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string; headingLevel?: 'h2' | 'h3' | 'p' };

function EmptyState({ icon, title, description, action, className, headingLevel: Heading = 'h2' }: Props) {
  return <div className={cn('flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-6 py-10 text-center', className)}>
    {icon && <span aria-hidden="true" className="mb-1 text-subtle-foreground [&_svg]:size-7">{icon}</span>}
    <Heading className="text-[15px] font-medium">{title}</Heading>
    {description && <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>}
    {action && <div className="mt-2">{action}</div>}
  </div>;
}

export { EmptyState };
