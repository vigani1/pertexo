import type { ComponentProps, CSSProperties } from 'react';
import { cn } from '@/lib/utils';

/** A resting placeholder block. Pages compose these into their own shape. */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        'rounded-sm bg-white/6 motion-safe:animate-[blink_1.8s_ease-in-out_infinite]',
        className,
      )}
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
  style,
  ...props
}: ComponentProps<'div'> & { order?: number }) {
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
        'relative h-0.5 overflow-hidden rounded-full bg-white/7',
        'after:absolute after:inset-y-[-1px] after:left-[-45%] after:w-[45%] after:bg-linear-to-r after:from-transparent after:via-accent-foreground after:to-transparent after:content-[""] motion-safe:after:animate-spool after:[animation-delay:var(--spool-delay)]',
        className,
      )}
      {...props}
    />
  );
}
