import {
  useLoaderData,
  useNavigate,
  useParams,
  useRouteContext,
} from '@tanstack/react-router';
import { WorkflowSettingsPage } from '@/features/workflow-settings/public';
import { WorkspaceUnavailablePage } from './root-layout';
import { WorkspaceRouteShell } from './workspace-route-shell';

export function WorkflowSettingsRoute() {
  const { apiClient } = useRouteContext({
    from: '/w/$workspaceId/workflows/$workflowId/settings',
  });
  const data = useLoaderData({
    from: '/w/$workspaceId/workflows/$workflowId/settings',
  });
  const params = useParams({
    from: '/w/$workspaceId/workflows/$workflowId/settings',
  });
  const navigate = useNavigate();
  if (data.workspace === null) return <WorkspaceUnavailablePage />;
  const workspace = data.workspace;
  return (
    <WorkspaceRouteShell
      apiClient={apiClient}
      user={data.user}
      workspace={workspace}
      pageTitle="Workflow settings"
    >
      <WorkflowSettingsPage
        apiClient={apiClient}
        user={data.user}
        workspace={workspace}
        workflowId={params.workflowId}
        onBack={() => {
          void navigate({
            to: '/w/$workspaceId/workflows/$workflowId',
            params: {
              workspaceId: workspace.id,
              workflowId: params.workflowId,
            },
          });
        }}
      />
    </WorkspaceRouteShell>
  );
}
