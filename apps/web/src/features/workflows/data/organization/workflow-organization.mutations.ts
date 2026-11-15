import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { setWorkflowFavorite } from './workflow-organization.api';
import { workflowOrganizationKeys } from './workflow-organization.queries';

/**
 * Marks a workflow as a favorite for the signed-in person. The organization
 * lists refetch either way, so a refused change shows the stored state.
 */
export function useWorkflowFavorite(
  input: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspaceId: string;
    workflowId: string;
  }>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ favorite }: Readonly<{ favorite: boolean }>) =>
      setWorkflowFavorite(input.apiClient, {
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        favorite,
      }),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: workflowOrganizationKeys.scope(
          input.userId,
          input.workspaceId,
        ),
      }),
  });
}
