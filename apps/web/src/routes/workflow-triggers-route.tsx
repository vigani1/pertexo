import { WorkflowTriggersPage } from '@/features/workflow-settings/public';
import { WorkflowHubTabFrame } from './workflow-hub-frame';
import { useWorkflowHubScope } from './workflow-hub-scope';

export function WorkflowTriggersRoute() {
  const { apiClient, user, workspace, workflowId } = useWorkflowHubScope();
  return (
    <WorkflowHubTabFrame tab="triggers">
      <WorkflowTriggersPage
        apiClient={apiClient}
        user={user}
        workspace={workspace}
        workflowId={workflowId}
      />
    </WorkflowHubTabFrame>
  );
}
