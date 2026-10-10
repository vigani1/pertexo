import type { ReactNode } from 'react';
import { StaleLine } from '@/components/patterns/states/stale-line';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { SkeletonThread } from '@/components/ui/skeleton';
import { describeReadError } from '@/lib/api/error-copy';
import { formatDateTime } from '@/lib/format/time';

/** Independent recovery keeps a failed capacity read from hiding activity. */
export function UsageSnapshot({
  title,
  asOf,
  error,
  pending,
  retrying,
  onRetry,
  children,
}: Readonly<{
  title: string;
  asOf: string | undefined;
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
        <Button variant="ghost" size="sm" disabled={retrying} onClick={onRetry}>
          {retrying ? 'Refreshing…' : `Refresh ${title.toLowerCase()}`}
        </Button>
      </div>
      {asOf === undefined ? (
        pending ? (
          <div role="status" aria-label={`Loading ${title.toLowerCase()}`}>
            <SkeletonThread order={0} />
          </div>
        ) : (
          <Notice tone="destructive">{describeReadError(error, title)}</Notice>
        )
      ) : (
        <>
          <p className="break-all text-xs text-subtle-foreground">
            As of{' '}
            <time dateTime={asOf} title={asOf} className="font-mono">
              {formatDateTime(asOf)}
            </time>
          </p>
          {error === null || error === undefined ? null : (
            <StaleLine
              updatedAt={Date.parse(asOf)}
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
