import { Skeleton, SkeletonThread } from '@/components/ui/skeleton';

const ROWS = [72, 38, 90, 24, 56, 64] as const;

/** A page loading: a title bar and spooling thread rows. */
export function PagePending() {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-3 w-80 max-w-full" />
      </div>
      <div className="flex flex-col gap-5">
        {ROWS.map((width, order) => (
          <div
            key={order}
            className="grid grid-cols-[1rem_minmax(0,14rem)_minmax(0,1fr)_3rem] items-center gap-4"
          >
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-2.5" />
            <SkeletonThread
              order={order}
              style={{ width: `${String(width)}%` }}
            />
            <Skeleton className="h-2.5" />
          </div>
        ))}
      </div>
    </div>
  );
}
