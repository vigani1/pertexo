import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

type AuroraLoadingPanelProps = ComponentProps<'div'> & { active: boolean };

// Decorative only: callers provide their own loading text and aria-busy when
// real work is pending. The live edge never intercepts input or claims progress.
export function AuroraLoadingPanel({
  active,
  className,
  children,
  ...props
}: AuroraLoadingPanelProps) {
  return (
    <div
      data-slot="aurora-loading-panel"
      className={cn(
        'relative isolate min-w-0 rounded-xl',
        active && 'live-edge',
        className,
      )}
      {...props}
    >
      {active ? (
        <span data-slot="aurora-border" aria-hidden="true" hidden />
      ) : null}
      {children}
    </div>
  );
}
