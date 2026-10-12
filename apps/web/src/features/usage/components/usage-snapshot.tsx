import { RefreshCwIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { StaleLine } from '@/components/patterns/states/stale-line';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { SkeletonThread } from '@/components/ui/skeleton';
import { describeReadError } from '@/lib/api/error-copy';
import { cn } from '@/lib/utils';

/**
 * One section of the Usage page with its own refresh, so a failed capacity
 * read never hides run counts. The page header says how fresh they are.
 */
export function UsageSnapshot({
  title,
  actions,
  snapshotAt,
  error,
  pending,
  retrying,
  onRetry,
  children,
}: Readonly<{
  title: string;
  /** Controls beside the refresh button, such as a time window. */
  actions?: ReactNode;
  snapshotAt: string | undefined;
  error: unknown;
  pending: boolean;
  retrying: boolean;
  onRetry: () => void;
  children: ReactNode;
}>) {
  return (
    <section aria-label={title} className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-lg font-semibold">{title}</h2>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Refresh ${title.toLowerCase()}`}
            title="Refresh"
            disabled={retrying}
            onClick={onRetry}
          >
            <RefreshCwIcon
              aria-hidden="true"
              className={cn(retrying && 'motion-safe:animate-spin')}
            />
          </Button>
        </div>
      </div>
      {snapshotAt === undefined ? (
        pending ? (
          <div role="status" aria-label={`Loading ${title.toLowerCase()}`}>
            <SkeletonThread order={0} />
          </div>
        ) : (
          <Notice tone="destructive">{describeReadError(error, title)}</Notice>
        )
      ) : (
        <>
          {error === null || error === undefined ? null : (
            <StaleLine
              updatedAt={Date.parse(snapshotAt)}
              retrying={retrying}
              onRetry={onRetry}
            />
          )}
          {children}
        </>
      )}
    </section>
  );
}
