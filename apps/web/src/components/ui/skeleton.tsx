import type { ComponentProps, CSSProperties } from 'react';
import { cn } from '@/lib/utils';

/**
 * A resting placeholder block. Pages compose these into their own shape.
 * Like every skeleton it shows only once loading has taken 150 ms.
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('skeleton-blink rounded-sm bg-white/6', className)}
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
        'relative skeleton-wait h-0.5 overflow-hidden rounded-full bg-white/7',
        'after:absolute after:inset-y-[-1px] after:left-[-45%] after:w-[45%] after:bg-linear-to-r after:from-transparent after:via-accent-foreground after:to-transparent after:content-[""] motion-safe:after:animate-spool after:[animation-delay:var(--spool-delay)]',
        className,
      )}
      {...props}
    />
  );
}

const ROW_WIDTHS = [64, 40, 78, 52] as const;

/**
 * A list loading in the shape of its rows — a mark, a name and a spooling
 * thread per row — announced once with `label`, e.g. "Loading members".
 */
export function SkeletonRows({
  label,
  rows = 3,
  mark = 'tile',
}: Readonly<{
  label: string;
  rows?: number;
  /** People lists show round avatars; everything else square tiles. */
  mark?: 'tile' | 'avatar';
}>) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-5 py-2">
      {ROW_WIDTHS.slice(0, rows).map((width, order) => (
        <div
          key={width}
          className="grid grid-cols-[2rem_minmax(0,12rem)_minmax(0,1fr)] items-center gap-4"
        >
          <Skeleton
            className={cn(
              'size-8',
              mark === 'avatar' ? 'rounded-full' : 'rounded-md',
            )}
          />
          <Skeleton className="h-2.5" />
          <SkeletonThread
            order={order}
            style={{ width: `${String(width)}%` }}
          />
        </div>
      ))}
    </div>
  );
}
