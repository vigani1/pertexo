import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { workflowRunKeys } from '@/features/workflow-runs/workflow-runs-queries.public';
import { workflowKeys } from '@/features/workflows/workflows-queries.public';

/** Home's Refresh: reads again what the person may see, runs and workflows. */
export function useHomeRefresh(
  userId: string,
  workspaceId: string,
  canRead: Readonly<{ runs: boolean; workflows: boolean }>,
) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  function refresh() {
    setRefreshing(true);
    const scopes = [
      ...(canRead.runs ? [workflowRunKeys.scope(userId, workspaceId)] : []),
      ...(canRead.workflows ? [workflowKeys.scope(userId, workspaceId)] : []),
    ];
    void Promise.allSettled(
      scopes.map((queryKey) =>
        queryClient.refetchQueries({ queryKey, type: 'active' }),
      ),
    ).finally(() => {
      setRefreshing(false);
    });
  }
  return { refreshing, refresh };
}
