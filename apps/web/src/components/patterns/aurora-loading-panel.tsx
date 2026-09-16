import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

type AuroraLoadingPanelProps = ComponentProps<'div'> & { active: boolean };

// Decorative only: callers provide their own loading text and aria-busy when
// real work is pending. The border must never intercept input or claim progress.
export function AuroraLoadingPanel({
  active,
  className,
  children,
  ...props
}: AuroraLoadingPanelProps) {
  return (
    <div
      data-slot="aurora-loading-panel"
      className={cn('relative isolate min-w-0 rounded-xl', className)}
      {...props}
    >
      {children}
      {active ? (
        <div
          data-slot="aurora-border"
          className="aurora-border"
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
