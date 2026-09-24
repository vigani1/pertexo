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
      {active ? <AuroraBorder /> : null}
      {children}
    </div>
  );
}

export function AuroraBorder() {
  return (
    <div data-slot="aurora-border" className="aurora-border" aria-hidden="true">
      <div className="aurora-border-glow">
        <div className="aurora-border-glow-gradient" />
      </div>
      <div className="aurora-border-ring">
        <div className="aurora-border-ring-mask">
          <div className="aurora-border-ring-gradient" />
        </div>
      </div>
    </div>
  );
}
