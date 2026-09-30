import { RotateCcwIcon } from 'lucide-react';
import { StaleLine } from '@/components/patterns/stale-line';
import { Button } from '@/components/ui/button';
import { Skeleton, SkeletonThread } from '@/components/ui/skeleton';
import { Notice } from '@/components/ui/notice';
import { describeReadError } from '@/lib/api/api-error-copy';
import {
  settingsQueryIsUnavailable,
  type SettingsQuery,
} from '../model/settings-query';

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
      <Notice tone="destructive" action={<RetryButton query={query} />}>
        {describeReadError(query.error, resource)}
      </Notice>
    );
  return (
    <StaleLine
      updatedAt={query.dataUpdatedAt}
      retrying={query.isFetching}
      onRetry={() => void query.refetch()}
    />
  );
}
