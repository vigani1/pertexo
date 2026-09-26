import { useNavigate, useSearch } from '@tanstack/react-router';
import { WorkflowRunsPage } from '@/features/workflow-runs/public';
import { sanitizeWorkflowRunSearch } from '@/features/workflow-runs/queries.public';
import { WorkflowHubTabFrame } from './workflow-hub-frame';
import { useWorkflowHubScope } from './workflow-hub-scope';

export function WorkflowRunsRoute() {
  const { apiClient, user, workspace, workflowId } = useWorkflowHubScope();
  // The router keeps unrecognized URL keys next to validated ones.
  const search = sanitizeWorkflowRunSearch(
    useSearch({ from: '/w/$workspaceId/workflows/$workflowId/runs' }),
  );
  const navigate = useNavigate();
  return (
    <WorkflowHubTabFrame tab="runs">
      <WorkflowRunsPage
        apiClient={apiClient}
        user={user}
        workspace={workspace}
        workflowId={workflowId}
        search={search}
        onSearchChange={(next) => {
          void navigate({
            to: '/w/$workspaceId/workflows/$workflowId/runs',
            params: { workspaceId: workspace.id, workflowId },
            search: next,
          });
        }}
      />
    </WorkflowHubTabFrame>
  );
}
