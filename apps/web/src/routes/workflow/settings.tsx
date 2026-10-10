import { WorkflowSettingsPage } from '@/features/workflow-settings/public';
import { WorkflowHubTabFrame } from './hub/frame';
import { useWorkflowHubScope } from './hub/scope';

export function WorkflowSettingsRoute() {
  const { apiClient, user, workspace, workflowId } = useWorkflowHubScope();
  return (
    <WorkflowHubTabFrame tab="settings">
      <WorkflowSettingsPage
        apiClient={apiClient}
        user={user}
        workspace={workspace}
        workflowId={workflowId}
      />
    </WorkflowHubTabFrame>
  );
}
