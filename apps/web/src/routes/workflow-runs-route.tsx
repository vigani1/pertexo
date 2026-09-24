import { useNavigate } from '@tanstack/react-router';
import { RunHistoryPage } from '@/features/workflow-runs/public';
import { WorkflowHubTabFrame } from './workflow-hub-frame';
import { useWorkflowHubScope } from './workflow-hub-scope';

export function WorkflowRunsRoute() {
  const { apiClient, user, workspace, workflowId } = useWorkflowHubScope();
  const navigate = useNavigate();
  return (
    <WorkflowHubTabFrame tab="runs">
      <RunHistoryPage
        apiClient={apiClient}
        user={user}
        workspace={workspace}
        filters={{ workflowId }}
        onFiltersChange={(search) => {
          void navigate({
            to: '/w/$workspaceId/runs',
            params: { workspaceId: workspace.id },
            search,
          });
        }}
      />
    </WorkflowHubTabFrame>
  );
}
