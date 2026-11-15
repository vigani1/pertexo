import { useQueryClient } from '@tanstack/react-query';
import { workflowRunKeys } from '@/features/workflow-runs/workflow-runs-queries.public';
import {
  workflowKeys,
  workflowOrganizationKeys,
} from '@/features/workflows/workflows-queries.public';

/** What the editor's run and publish commands refresh once accepted. */
export function usePublicationRefresh(userId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return {
    /** A run started or replayed: the run lists change. */
    runAccepted() {
      void queryClient.invalidateQueries({
        queryKey: workflowRunKeys.scope(userId, workspaceId),
      });
    },
    /** A version published: the workflow and its list rows change. */
    publicationAccepted() {
      void queryClient.invalidateQueries({
        queryKey: workflowOrganizationKeys.scope(userId, workspaceId),
      });
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.scope(userId, workspaceId),
      });
    },
  };
}
