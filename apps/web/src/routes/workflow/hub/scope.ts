import { workflowWorkspaceAccess } from '@/features/workflows/access.public';
import { useQuery } from '@tanstack/react-query';
import { workflowSummaryQueryOptions } from '@/features/workflows/queries.public';
import { useRouteContext } from '@tanstack/react-router';

/**
 * The workflow ID for tabs rendered inside the hub. The hub only renders its
 * tabs for a valid ID, so a null here is a routing invariant violation.
 */
export function useWorkflowHubScope() {
  const { apiClient, user, workspace, workflowId } = useRouteContext({
    from: '/w/$workspaceId/workflows/$workflowId',
  });
  const summary = useQuery({
    ...workflowSummaryQueryOptions(
      apiClient,
      user.id,
      workspace.id,
      workflowId ?? '',
    ),
    enabled: workflowId !== null,
  });
  const access = summary.data?.resourceAccess;
  const scopedWorkspace = workflowWorkspaceAccess(workspace, access);
  if (workflowId === null)
    throw new Error('Workflow hub tab rendered without a workflow');
  return { apiClient, user, workspace: scopedWorkspace, workflowId };
}
