import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowRunReadSummary } from '@pertexo/contracts/schemas/workflow-runs';
import { StaleLine } from '@/components/patterns/stale-line';
import { Button } from '@/components/ui/button';
import { SkeletonThread } from '@/components/ui/skeleton';
import { isApiError } from '@/lib/api/api-error';
import { describeReadError } from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import { filterRunsByTrigger } from '../../model/run-list';
import {
  clearedRunSearch,
  hasRunFilters,
  type RunSearch,
} from '../../model/run-search';
import type { RunHistoryQuery } from '../../use-run-history';
import { useNow } from '@/lib/use-now';
import { RunLoom } from '../loom/run-loom';
import { RunList } from './run-list';
import {
  NoMatchingRuns,
  NoRunsYet,
  RunListSkeleton,
  RunsLoadError,
  RunsUnavailable,
} from './run-list-states';
import type { RunListVariant } from './run-row';

const HOUR_MS = 3_600_000;

/**
 * Loading, failure, empty, stale and loaded states for a run list, shared by
 * the workspace Runs page and a workflow's Runs tab.
 */
export function RunResults({
  apiClient,
  userId,
  workspace,
  search,
  onSearchChange,
  query,
  runs,
  variant,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  search: RunSearch;
  onSearchChange: (search: RunSearch) => void;
  query: RunHistoryQuery;
  runs: readonly WorkflowRunReadSummary[];
  variant: RunListVariant;
}>) {
  if (query.isError && isApiError(query.error) && query.error.status === 404)
    return <RunsUnavailable />;
  if (query.isPending) return <RunListSkeleton />;
  if (runs.length === 0 && query.isError)
    return (
      <RunsLoadError
        description={describeReadError(query.error, 'Runs')}
        retrying={query.isRefetching}
        onRetry={() => void query.refetch()}
      />
    );
  const visible = filterRunsByTrigger(runs, search.trigger);
  const refreshing = query.isRefetching && !query.isFetchingNextPage;
  return (
    <div className="flex flex-col gap-4" aria-busy={query.isFetching}>
      {refreshing ? <SkeletonThread className="-mt-2" /> : null}
      {query.isError && !query.isFetchNextPageError ? (
        <StaleLine
          className="rounded-md border border-warning/25 bg-warning/6 px-3 py-2 text-sm"
          updatedAt={query.dataUpdatedAt}
          retrying={query.isRefetching}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {visible.length === 0 ? (
        hasRunFilters(search) ? (
          <NoMatchingRuns
            partial={search.trigger !== undefined && query.hasNextPage}
            onClearFilters={() => {
              onSearchChange(clearedRunSearch(search));
            }}
          />
        ) : (
          <NoRunsYet
            workspaceId={workspace.id}
            canReadWorkflows={workspace.capabilities.includes('workflow:read')}
          />
        )
      ) : search.view === 'loom' ? (
        <RunsLoomView
          runs={visible}
          search={search}
          workspaceId={workspace.id}
        />
      ) : (
        <RunList
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          runs={visible}
          variant={variant}
        />
      )}
      {query.hasNextPage || query.isFetchNextPageError ? (
        <div className="flex flex-col items-center gap-2 pt-2">
          {query.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading more…' : 'Load more'}
            </Button>
          ) : null}
          {query.isFetchNextPageError ? (
            <p role="alert" className="text-sm text-destructive">
              More runs couldn’t be loaded. Try again.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The Runs page's Loom view: the loaded runs, from the filter start to now. */
function RunsLoomView({
  runs,
  search,
  workspaceId,
}: Readonly<{
  runs: readonly WorkflowRunReadSummary[];
  search: RunSearch;
  workspaceId: string;
}>) {
  const nowMs = useNow(60_000, true);
  let earliest = nowMs - HOUR_MS;
  for (const run of runs)
    earliest = Math.min(earliest, Date.parse(run.startedAt ?? run.createdAt));
  const from =
    search.createdAtFrom === undefined
      ? earliest
      : Date.parse(search.createdAtFrom);
  const windowMs = Math.max(HOUR_MS, nowMs - from);
  return (
    <RunLoom
      runs={runs}
      windowMs={windowMs}
      windowLabel="the loaded runs’ time span"
      workspaceId={workspaceId}
    />
  );
}
