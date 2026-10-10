import { WorkflowVersionsPage } from '@/features/workflow-settings/public';
import { WorkflowHubTabFrame } from './hub/frame';
import { useWorkflowHubScope } from './hub/scope';

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
