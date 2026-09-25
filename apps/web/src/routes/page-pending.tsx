import { Skeleton, SkeletonThread } from '@/components/ui/skeleton';

const ROWS = [72, 38, 90, 24, 56, 64] as const;

/**
 * A page loading: a title bar and spooling thread rows. The router shows it
 * after 150 ms, so its skeletons don't wait again.
 */
export function PagePending() {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="flex flex-col gap-8 [--skeleton-wait:0ms]"
    >
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

/**
 * A workflow hub page loading: the floating bar's outline, then the page
 * skeleton inside the hub's own margins.
 */
export function WorkflowHubPending() {
  return (
    <div className="[--skeleton-wait:0ms]">
      <div className="px-3 pt-3">
        <div className="lens flex min-h-14 items-center gap-3 rounded-xl px-3">
          <Skeleton className="size-7 rounded-sm" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-2 w-16" />
          </div>
        </div>
      </div>
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 sm:px-6">
        <PagePending />
      </div>
    </div>
  );
}
