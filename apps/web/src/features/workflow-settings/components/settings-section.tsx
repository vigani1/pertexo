import { useId, type ReactNode } from 'react';
import { RotateCcwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton, SkeletonThread } from '@/components/ui/skeleton';
import { StatusGlyph } from '@/components/ui/status';
import { describeReadError } from '@/lib/api/api-error-copy';
import { formatClock } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import {
  settingsQueryIsUnavailable,
  type SettingsQuery,
} from './settings-query';

/**
 * A titled band of a hub tab: the heading and a sentence on the left, the
 * content on the right. Flat page content; only dialogs and lenses float.
 */
export function SettingsSection({
  title,
  description,
  className,
  children,
}: Readonly<{
  title: string;
  description: ReactNode;
  className?: string;
  children: ReactNode;
}>) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'grid gap-x-10 gap-y-5 border-t border-border py-8 first:border-t-0 first:pt-2 lg:grid-cols-[14rem_minmax(0,1fr)]',
        className,
      )}
    >
      <div>
        <h2 id={headingId} className="text-lg font-semibold">
          {title}
        </h2>
        <div className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {description}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  );
}

function RetryButton({ query }: Readonly<{ query: SettingsQuery<unknown> }>) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={query.isFetching}
      onClick={() => void query.refetch()}
    >
      <RotateCcwIcon aria-hidden="true" data-icon="inline-start" />
      {query.isFetching ? 'Trying again…' : 'Retry'}
    </Button>
  );
}

/**
 * Loading, unavailable, failed and stale states for one section's read.
 * Renders nothing when the data is current.
 */
export function SettingsQueryState({
  query,
  resource,
}: Readonly<{ query: SettingsQuery<unknown>; resource: string }>) {
  if (query.isPending && query.data === undefined)
    return (
      <div role="status" aria-label={`Loading ${resource.toLowerCase()}`}>
        <Skeleton className="h-3 w-1/2" />
        <SkeletonThread className="mt-3 w-3/4" />
      </div>
    );
  if (!query.isError) return null;
  if (settingsQueryIsUnavailable(query))
    return (
      <p className="text-sm text-muted-foreground">
        This isn’t available to you. The workflow may have been removed, or your
        role changed.
      </p>
    );
  if (query.data === undefined)
    return (
      <div role="alert" className="flex flex-col items-start gap-3">
        <p className="text-sm text-destructive">
          {describeReadError(query.error, resource)}
        </p>
        <RetryButton query={query} />
      </div>
    );
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 font-mono text-xs text-warning"
    >
      <StatusGlyph tone="attention" />
      Couldn’t refresh. Showing what loaded at{' '}
      {formatClock(new Date(query.dataUpdatedAt).toISOString())}.
      <RetryButton query={query} />
    </div>
  );
}
