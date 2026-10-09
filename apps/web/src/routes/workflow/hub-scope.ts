import { useRouteContext } from '@tanstack/react-router';

/**
 * The workflow ID for tabs rendered inside the hub. The hub only renders its
 * tabs for a valid ID, so a null here is a routing invariant violation.
 */
export function useWorkflowHubScope() {
  const { apiClient, user, workspace, workflowId } = useRouteContext({
    from: '/w/$workspaceId/workflows/$workflowId',
  });
  if (workflowId === null)
    throw new Error('Workflow hub tab rendered without a workflow');
  return { apiClient, user, workspace, workflowId };
}
