import { WorkflowVersionsPage } from '@/features/workflow-settings/public';
import { WorkflowHubTabFrame } from './workflow-hub-frame';
import { useWorkflowHubScope } from './workflow-hub-scope';

export function WorkflowVersionsRoute() {
  const { apiClient, user, workspace, workflowId } = useWorkflowHubScope();
  return (
    <WorkflowHubTabFrame tab="versions">
      <WorkflowVersionsPage
        apiClient={apiClient}
        user={user}
        workspace={workspace}
        workflowId={workflowId}
      />
    </WorkflowHubTabFrame>
  );
}
