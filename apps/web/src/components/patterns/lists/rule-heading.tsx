import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/class-names';

const headingVariants = cva(
  'flex min-w-0 flex-1 items-center gap-3 font-heading font-semibold',
  {
    variants: {
      appearance: {
        section: 'text-section',
        compact: 'text-lead',
        quota: 'text-section',
      },
    },
    defaultVariants: { appearance: 'section' },
  },
);

/**
 * A section heading drawn as a thread that ends in a knot. The optional count
 * is a glance in mono; the section's own content states it, so the heading's
 * name stays the title alone.
 */
export function RuleHeading({
  className,
  children,
  count,
  appearance,
  ...props
}: ComponentProps<'h2'> &
  VariantProps<typeof headingVariants> &
  Readonly<{ count?: ReactNode }>) {
  return (
    <h2 className={cn(headingVariants({ appearance }), className)} {...props}>
      {children}
      {count === undefined ? null : (
        <span
          aria-hidden="true"
          className="font-mono text-meta font-medium text-subtle-foreground"
        >
          {count}
        </span>
      )}
      <span
        aria-hidden="true"
        className={cn(
          'relative h-px min-w-3 flex-1 bg-linear-to-r from-border-strong to-border',
          appearance !== 'quota' &&
            'after:absolute after:top-1/2 after:right-0 after:size-1.25 after:-translate-y-1/2 after:rounded-full after:bg-subtle-foreground',
        )}
      />
    </h2>
  );
}
