import type { ComponentProps } from 'react';
import { cn } from '@/lib/class-names';

export function RuleHeading({
  className,
  children,
  ...props
}: ComponentProps<'h2'>) {
  return (
    <h2
      className={cn(
        'flex min-w-0 flex-1 items-center gap-3 font-heading text-section font-semibold',
        className,
      )}
      {...props}
    >
      {children}
      <span
        aria-hidden="true"
        className="relative h-px min-w-3 flex-1 bg-linear-to-r from-border-strong to-border after:absolute after:top-1/2 after:right-0 after:size-1.25 after:-translate-y-1/2 after:rounded-full after:bg-subtle-foreground"
      />
    </h2>
  );
}
