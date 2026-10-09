import { WorkflowTriggersPage } from '@/features/workflow-settings/public';
import { WorkflowHubTabFrame } from './hub-frame';
import { useWorkflowHubScope } from './hub-scope';

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
