import { useQueryClient } from '@tanstack/react-query';
import { workflowSettingsKeys } from '../workflow-settings.queries';

/** Reads every workflow setting again (after a lifecycle change elsewhere). */
export function useWorkflowSettingsRefresh(
  userId: string,
  workspaceId: string,
  workflowId: string,
) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: workflowSettingsKeys.root(userId, workspaceId, workflowId),
    });
  };
}
