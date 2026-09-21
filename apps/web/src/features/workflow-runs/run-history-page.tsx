import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useInfiniteQuery } from '@tanstack/react-query';
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
    <div>
      <header>
        <p className="font-mono text-xs tracking-[0.2em] text-secondary">
          EXECUTION LEDGER
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
          Run history
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Inspect accepted workflow versions and execution outcomes across{' '}
          {workspace.name}. History contains safe run metadata only.
        </p>
      </header>

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
          className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"
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

      <div className="mt-7 flex flex-wrap gap-x-5 gap-y-2 border-y border-border py-3 font-mono text-[0.68rem] tracking-[0.1em] text-muted-foreground uppercase">
        <span>{runs.length} loaded</span>
        <span>Newest first</span>
        <span>UTC date boundaries</span>
      </div>

      {query.isPending ? (
        <p role="status" className="py-16 text-sm text-muted-foreground">
          Loading run history…
        </p>
      ) : query.isError && runs.length === 0 ? (
        <Empty>
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
        <Empty>
          <EmptyTitle>No matching runs</EmptyTitle>
          <EmptyDescription>
            Runs will appear after a published workflow accepts an execution.
            Clear filters to search the full workspace history.
          </EmptyDescription>
        </Empty>
      ) : (
        <>
          <RunHistoryTable runs={runs} workspaceId={workspace.id} />
          {query.hasNextPage ? (
            <div className="mt-6 flex justify-center">
              <Button
                type="button"
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
          {query.isFetchNextPageError ? (
            <p
              role="alert"
              className="mt-4 text-center text-sm text-destructive"
            >
              The next history page could not be loaded. Try again.
            </p>
          ) : null}
        </>
      )}
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
