import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// A lightweight echo of Pertexo's execution orb. It deliberately uses CSS
// rather than mounting a WebGL canvas inside short-lived button interactions.
export function LoadingOrb({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="loading-orb"
      aria-hidden="true"
      className={cn('loading-orb', className)}
      {...props}
    >
      <span className="loading-orb-core" />
      <span className="loading-orb-ring loading-orb-ring-primary" />
      <span className="loading-orb-ring loading-orb-ring-secondary" />
      <span className="loading-orb-particle" />
    </span>
  );
}
