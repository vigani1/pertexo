import { cn } from '@/lib/class-names';
import { Skeleton, SkeletonThread } from '@/components/ui/skeleton';

const ROW_WIDTHS = [64, 40, 78, 52] as const;

/**
 * Text or data loading as spooling lines, announced once with `label`.
 * Use it where the content has no row shape: values, previews, timestamps.
 */
export function SkeletonLines({
  label,
  lines = 3,
  className,
}: Readonly<{ label: string; lines?: number; className?: string }>) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn('flex flex-col gap-3 py-1.5', className)}
    >
      {ROW_WIDTHS.slice(0, lines).map((width, order) => (
        <SkeletonThread
          key={width}
          order={order}
          style={{ width: `${String(width)}%` }}
        />
      ))}
    </div>
  );
}

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
            shape={mark === 'avatar' ? 'round' : 'control'}
            className="size-8"
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
