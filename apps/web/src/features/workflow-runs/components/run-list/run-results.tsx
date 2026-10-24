import type {
  AccessibleWorkspace,
  WorkflowRunListItem,
} from '@pertexo/contracts';
import type { ReactNode } from 'react';
import { LoadMore } from '@/components/patterns/lists/load-more';
import {
  FailedReadState,
  QueryView,
} from '@/components/patterns/states/query-view';
import { SkeletonThread } from '@/components/ui/skeleton';
import { isApiError } from '@/lib/api/error';
import type { ApiClient } from '@/lib/api/client';
import { filterRunsByTrigger } from '../../model/list/runs';
import {
  clearedRunSearch,
  hasRunFilters,
  type RunSearch,
} from '../../model/list/run-search';
import type { RunHistoryQuery } from '../../hooks/use-run-history';
import { useNow } from '@/lib/hooks/use-now';
import { RunLoom } from '../loom/view';
import { RunList } from './list';
import { NoMatchingRuns, RunListSkeleton, RunsUnavailable } from './states';
import type { RunListVariant } from './run-row-layout';

const HOUR_MS = 3_600_000;

/**
 * Loading, failure, empty, stale and loaded states for a run list, shared by
 * the workspace Runs page and a workflow's Runs tab.
 */
/** A 404 means the runs aren't there for this person, not a failed read. */
function runsUnavailable(error: unknown) {
  return isApiError(error) && error.status === 404 ? (
    <RunsUnavailable />
  ) : undefined;
}

export function RunResults({
  apiClient,
  userId,
  workspace,
  search,
  onSearchChange,
  query,
  runs,
  variant,
  noRuns,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  search: RunSearch;
  onSearchChange: (search: RunSearch) => void;
  query: RunHistoryQuery;
  runs: readonly WorkflowRunListItem[];
  variant: RunListVariant;
  /** What to say, and where to go, before anything has run here. */
  noRuns: ReactNode;
}>) {
  const visible = filterRunsByTrigger(runs, search.trigger);
  const refreshing = query.isRefetching && !query.isFetchingNextPage;
  return (
    <QueryView
      query={query}
      resource="Runs"
      loading={<RunListSkeleton />}
      failure={runsUnavailable}
      error={(failed) => (
        <FailedReadState title="Runs couldn’t be loaded" {...failed} />
      )}
    >
      {() => (
        <div
          className="relative flex flex-col gap-4"
          aria-busy={query.isFetching}
        >
          {/* Laid over the top edge, so a refresh never moves the list. */}
          {refreshing ? (
            <SkeletonThread className="absolute inset-x-0 -top-3" />
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
              noRuns
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
          <LoadMore
            subject="runs"
            hasNextPage={query.hasNextPage}
            loading={query.isFetchingNextPage}
            failed={query.isFetchNextPageError}
            onLoadMore={() => void query.fetchNextPage()}
          />
        </div>
      )}
    </QueryView>
  );
}

/** The Runs page's Loom view: the loaded runs, from the filter start to now. */
function RunsLoomView({
  runs,
  search,
  workspaceId,
}: Readonly<{
  runs: readonly WorkflowRunListItem[];
  search: RunSearch;
  workspaceId: string;
}>) {
  const nowMs = useNow({ intervalMs: 60_000, enabled: true });
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
