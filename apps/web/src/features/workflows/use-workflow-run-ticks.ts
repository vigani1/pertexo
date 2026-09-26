import { useQuery } from '@tanstack/react-query';
import { workflowLatestRunsQueryOptions } from '@/features/workflow-runs/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { RUN_STRIP_LENGTH, runTicks } from './model/run-strip';

/**
 * One workflow's run strip: its own latest runs, read once its row is seen,
 * so a busy workflow elsewhere never pushes it out of the column.
 */
export function useWorkflowRunTicks(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  workflowId: string,
  enabled: boolean,
) {
  const runs = useQuery({
    ...workflowLatestRunsQueryOptions(
      apiClient,
      userId,
      workspaceId,
      workflowId,
      RUN_STRIP_LENGTH,
    ),
    select: runTicks,
    enabled,
  });
  return {
    pending: runs.isPending,
    failed: runs.isError && runs.data === undefined,
    ticks: runs.data ?? [],
  };
}
