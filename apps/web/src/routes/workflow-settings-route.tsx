import { useNavigate } from '@tanstack/react-router';
import type { WorkflowHubTab } from '@/features/workflows/hub.public';
import { WorkflowSettingsPage } from '@/features/workflow-settings/public';
import { WorkflowHubTabFrame } from './workflow-hub-frame';
import { useWorkflowHubScope } from './workflow-hub-scope';

function WorkflowOperationsTab({ tab }: Readonly<{ tab: WorkflowHubTab }>) {
  const { apiClient, user, workspace, workflowId } = useWorkflowHubScope();
  const navigate = useNavigate();
  return (
    <WorkflowHubTabFrame tab={tab}>
      <WorkflowSettingsPage
        apiClient={apiClient}
        user={user}
        workspace={workspace}
        workflowId={workflowId}
        onBack={() => {
          void navigate({
            to: '/w/$workspaceId/workflows/$workflowId',
            params: { workspaceId: workspace.id, workflowId },
          });
        }}
      />
    </WorkflowHubTabFrame>
  );
}

export function WorkflowTriggersRoute() {
  return <WorkflowOperationsTab tab="triggers" />;
}

export function WorkflowVersionsRoute() {
  return <WorkflowOperationsTab tab="versions" />;
}

export function WorkflowSettingsRoute() {
  return <WorkflowOperationsTab tab="settings" />;
}
