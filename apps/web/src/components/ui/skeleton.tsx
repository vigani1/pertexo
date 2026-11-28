import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, CSSProperties } from 'react';
import { cn } from '@/lib/class-names';

const skeletonVariants = cva('skeleton-wait skeleton-shimmer', {
  variants: {
    shape: {
      line: 'rounded-xs',
      control: 'rounded-md',
      tile: 'rounded-lg',
      round: 'rounded-full',
    },
  },
  defaultVariants: { shape: 'line' },
});

const threadVariants = cva('relative skeleton-wait overflow-hidden', {
  variants: {
    appearance: {
      line: 'h-0.5 rounded-full bg-surface-ink/7',
      navigation:
        'h-[3px] bg-surface-ink/8 after:shadow-live motion-reduce:bg-accent-foreground/45',
    },
  },
  defaultVariants: { appearance: 'line' },
});

/**
 * A resting placeholder block. Pages compose these into their own shape.
 * Like every skeleton it shows only once loading has taken 150 ms.
 */
export function Skeleton({
  className,
  shape,
  ...props
}: ComponentProps<'div'> & VariantProps<typeof skeletonVariants>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(skeletonVariants({ shape }), className)}
      {...props}
    />
  );
}

/**
 * A spooling thread: a light travels along a placeholder line. `order`
 * staggers rows so the light passes down a list one line after another.
 */
export function SkeletonThread({
  className,
  order = 0,
  appearance,
  style,
  ...props
}: ComponentProps<'div'> &
  VariantProps<typeof threadVariants> & { order?: number }) {
  return (
    <div
      data-slot="skeleton-thread"
      aria-hidden="true"
      style={
        {
          '--spool-delay': `${String(order * 90)}ms`,
          ...style,
        } as CSSProperties
      }
      className={cn(
        threadVariants({ appearance }),
        'after:absolute after:inset-y-[-1px] after:left-[-45%] after:w-[45%] after:bg-linear-to-r after:from-transparent after:via-accent-foreground after:to-transparent after:content-[""] motion-safe:after:animate-spool after:[animation-delay:var(--spool-delay)]',
        className,
      )}
      {...props}
    />
  );
}
