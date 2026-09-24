import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import type { WorkflowRunListResponse } from '@pertexo/contracts/schemas/workflow-runs';
import { workflowRunsInfiniteQueryOptions } from '@/features/workflow-runs/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { groupRecentRuns } from './model/run-strip';

const NO_FILTERS = {};

function selectRecentRuns(data: InfiniteData<WorkflowRunListResponse>) {
  const runs = data.pages.flatMap((page) => page.items);
  return { ticks: groupRecentRuns(runs), runCount: runs.length };
}

/**
 * Run strips come from the workspace's latest runs (the same pages the Runs
 * page shows), grouped by workflow. It's a window, not a complete history.
 */
export function useRecentRunTicks(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  enabled: boolean,
) {
  const runs = useInfiniteQuery({
    ...workflowRunsInfiniteQueryOptions(
      apiClient,
      userId,
      workspaceId,
      NO_FILTERS,
    ),
    select: selectRecentRuns,
    enabled,
  });
  return {
    enabled,
    pending: enabled && runs.isPending,
    failed: runs.isError && runs.data === undefined,
    runCount: runs.data?.runCount ?? 0,
    ticksFor: (workflowId: string) => runs.data?.ticks.get(workflowId) ?? [],
  };
}

export type RecentRunTicks = ReturnType<typeof useRecentRunTicks>;
