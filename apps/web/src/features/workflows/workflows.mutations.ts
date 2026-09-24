import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { createWorkflow } from './workflows.api';
import { workflowKeys } from './workflows.queries';

export function useCreateWorkflow(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Readonly<{ name: string; idempotencyKey: string }>) =>
      createWorkflow(apiClient, workspaceId, input),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: workflowKeys.scope(userId, workspaceId),
      }),
  });
}
