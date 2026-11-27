import type { ComponentProps } from 'react';
import { cn } from '@/lib/class-names';

/**
 * A section heading drawn on a rule: the words, an optional count, then a
 * hairline that ends in a knot.
 */
export function RuleHeading({
  className,
  children,
  count,
  ...props
}: ComponentProps<'h2'> & Readonly<{ count?: number }>) {
  return (
    <h2
      className={cn(
        'flex min-w-0 flex-1 items-center gap-3 font-heading text-section font-semibold',
        className,
      )}
      {...props}
    >
      {children}
      {count === undefined ? null : (
        <span className="font-mono text-caption font-medium text-subtle-foreground">
          {String(count)}
        </span>
      )}
      <span
        aria-hidden="true"
        className="relative h-px min-w-3 flex-1 bg-linear-to-r from-border-strong to-border after:absolute after:top-1/2 after:right-0 after:size-1.25 after:-translate-y-1/2 after:rounded-full after:bg-subtle-foreground"
      />
    </h2>
  );
}
