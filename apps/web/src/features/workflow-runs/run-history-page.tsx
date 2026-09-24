import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useInfiniteQuery } from '@tanstack/react-query';
import { AuroraLoadingPanel } from '@/components/patterns/aurora-loading-panel';
import { GlassSection } from '@/components/patterns/glass-section';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import { RunHistoryFiltersForm } from './components/run-history-filters';
import { RunHistoryTable } from './components/run-history-table';
import type { RunHistoryFilters } from './run-history.types';
import { workflowRunsInfiniteQueryOptions } from './workflow-runs.queries';

export function RunHistoryPage({
  apiClient,
  user,
  workspace,
  filters,
  onFiltersChange,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  filters: RunHistoryFilters;
  onFiltersChange: (filters: RunHistoryFilters) => void;
}>) {
  const canRead = workspace.capabilities.includes('run:read');
  const query = useInfiniteQuery({
    ...workflowRunsInfiniteQueryOptions(
      apiClient,
      user.id,
      workspace.id,
      filters,
    ),
    enabled: canRead,
  });
  const runs = query.data?.pages.flatMap((page) => page.items) ?? [];
  const collectionUnavailable =
    query.isError && isApiError(query.error) && query.error.status === 404;

  if (!canRead)
    return (
      <Empty>
        <EmptyTitle>Run history is unavailable</EmptyTitle>
        <EmptyDescription>
          Your workspace role does not allow you to view workflow runs.
        </EmptyDescription>
      </Empty>
    );

  if (collectionUnavailable)
    return (
      <Empty>
        <EmptyTitle>Run history is unavailable</EmptyTitle>
        <EmptyDescription>
          This run collection is not available for the current workspace. It may
          not exist or may be outside your account access.
        </EmptyDescription>
      </Empty>
    );

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="sr-only text-3xl font-semibold tracking-tight lg:not-sr-only lg:block lg:text-4xl">
          Run history
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Find accepted workflow versions and execution outcomes across{' '}
          {workspace.name}.
        </p>
      </header>
      <AuroraLoadingPanel
        active={
          query.isPending || query.isRefetching || query.isFetchingNextPage
        }
      >
        <GlassSection
          className="overflow-hidden"
          aria-busy={
            query.isPending || query.isRefetching || query.isFetchingNextPage
          }
        >
          <RunHistoryFiltersForm
            key={JSON.stringify(filters)}
            filters={filters}
            canFilterByWorkflowName={workspace.capabilities.includes(
              'workflow:read',
            )}
            onApply={onFiltersChange}
          />

          {query.isError && runs.length > 0 && !query.isFetchNextPageError ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 border-b border-destructive/25 bg-destructive/5 px-4 py-3 sm:px-5"
            >
              <p className="text-sm text-destructive">
                These runs may be stale because the latest refresh failed.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={query.isRefetching}
                onClick={() => void query.refetch()}
              >
                {query.isRefetching ? 'Retrying…' : 'Retry refresh'}
              </Button>
            </div>
          ) : null}

          {query.isPending ? (
            <p
              role="status"
              className="px-5 py-16 text-sm text-muted-foreground"
            >
              Loading run history…
            </p>
          ) : query.isError && runs.length === 0 ? (
            <Empty className="border-0 px-5">
              <EmptyTitle>Run history could not be loaded</EmptyTitle>
              <EmptyDescription>{historyError(query.error)}</EmptyDescription>
              <Button
                className="mt-6"
                type="button"
                variant="outline"
                onClick={() => void query.refetch()}
              >
                Try again
              </Button>
            </Empty>
          ) : runs.length === 0 ? (
            <Empty className="border-0 px-5">
              <EmptyTitle>No matching runs</EmptyTitle>
              <EmptyDescription>
                Runs will appear after a published workflow accepts an
                execution. Clear filters to search the full workspace history.
              </EmptyDescription>
            </Empty>
          ) : (
            <>
              <RunHistoryTable runs={runs} workspaceId={workspace.id} />
              {query.hasNextPage || query.isFetchNextPageError ? (
                <div className="border-t px-4 py-4 text-center sm:px-5">
                  {query.hasNextPage ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={query.isFetchingNextPage}
                      onClick={() => void query.fetchNextPage()}
                    >
                      {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
                    </Button>
                  ) : null}
                  {query.isFetchNextPageError ? (
                    <p role="alert" className="mt-3 text-sm text-destructive">
                      The next history page could not be loaded. Try again.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </GlassSection>
      </AuroraLoadingPanel>
    </div>
  );
}

function historyError(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 403)
      return 'You no longer have access to run history in this workspace.';
    if (error.kind === 'network')
      return 'Run history could not be reached. Check your network and try again.';
    if (error.kind === 'timeout')
      return 'Run history took too long to load. Try again.';
  }
  return 'Run history could not be loaded. Try again.';
}
