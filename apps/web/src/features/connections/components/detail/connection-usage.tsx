import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { LoadMore } from '@/components/patterns/load-more';
import { ReadFailure } from '@/components/patterns/read-failure';
import { SkeletonRows } from '@/components/ui/skeleton';
import { describeStep } from '@/features/catalog/presentation.public';
import type { ConnectionMutationScope } from '../../data/connections.mutations';
import { connectionUsageQueryOptions } from '../../data/connections.queries';

/** Retained published versions, not drafts or an inferred current graph. */
export function ConnectionUsage({
  scope,
  connectionId,
  canRead,
}: Readonly<{
  scope: ConnectionMutationScope;
  connectionId: string;
  canRead: boolean;
}>) {
  const usage = useInfiniteQuery({
    ...connectionUsageQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspaceId,
      connectionId,
    ),
    enabled: canRead,
  });
  const items = usage.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section aria-label="Used by" className="flex flex-col gap-3">
      <div>
        <h3 className="font-semibold">Used by</h3>
        <p className="text-xs text-muted-foreground">
          Retained published versions, including historical versions used by
          pinned runs. Drafts aren’t included.
        </p>
      </div>
      {!canRead ? (
        <p className="text-sm text-muted-foreground">
          Workflow-read permission is needed to see usage.
        </p>
      ) : (
        <>
          {usage.isError && !usage.isFetchNextPageError ? (
            <ReadFailure
              resource="Connection usage"
              error={usage.error}
              showing={items.length > 0}
              updatedAt={usage.dataUpdatedAt}
              retrying={usage.isRefetching}
              onRetry={() => void usage.refetch()}
            />
          ) : null}
          {usage.isPending ? (
            <SkeletonRows label="Loading connection usage" />
          ) : null}
          {usage.isSuccess && items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No retained published versions use this connection.
            </p>
          ) : null}
          <ul className="flex flex-col gap-3">
            {items.map((item) => (
              <li key={item.workflowVersionId} className="min-w-0 text-sm">
                <Link
                  to="/w/$workspaceId/workflows/$workflowId/settings"
                  params={{
                    workspaceId: scope.workspaceId,
                    workflowId: item.workflowId,
                  }}
                  className="block truncate rounded-sm text-action underline-offset-4 hover:underline focus-ring"
                >
                  {item.workflowName}
                </Link>
                <p className="text-xs text-muted-foreground">
                  Version {item.versionNumber} ·{' '}
                  {item.isCurrentPublication
                    ? 'Current publication'
                    : 'Historical version'}
                  {item.workflowLifecycleStatus === 'archived'
                    ? ' · Archived workflow'
                    : ''}
                </p>
                <p className="text-xs text-subtle-foreground">
                  {item.operationKeys
                    .map((key) => describeStep(key).name)
                    .join(', ')}
                </p>
              </li>
            ))}
          </ul>
          <LoadMore
            subject="published versions"
            hasNextPage={usage.hasNextPage}
            loading={usage.isFetchingNextPage}
            failed={usage.isFetchNextPageError}
            onLoadMore={() => void usage.fetchNextPage()}
          />
        </>
      )}
    </section>
  );
}
