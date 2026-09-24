import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@/lib/api/api-error';
import { describeCommandError } from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import { cancelWorkflowRun } from '../workflow-runs.api';
import { workflowRunKeys } from '../workflow-runs.queries';

export function useRunCancellation({
  apiClient,
  userId,
  workspaceId,
  runId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  runId: string;
}>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      cancelWorkflowRun(
        apiClient,
        workspaceId,
        runId,
        'Canceled from the run page',
      ),
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: workflowRunKeys.scope(userId, workspaceId),
      });
    },
  });
}

export function runCancellationError(error: unknown): string {
  if (isApiError(error) && error.status === 409)
    return 'This run already finished, so there’s nothing to stop.';
  return describeCommandError(error, 'stopping this run');
}
