import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@/lib/api/api-error';
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
        'Canceled from run detail',
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: workflowRunKeys.detail(userId, workspaceId, runId),
      });
    },
  });
}

export function runCancellationError(error: unknown): string {
  if (isApiError(error) && error.status === 409)
    return 'This run is already terminal.';
  if (isApiError(error) && error.status === 403)
    return 'You no longer have permission to cancel this run.';
  return 'The cancel request could not be confirmed. Refresh before trying again.';
}
