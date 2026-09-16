import {
  useLoaderData,
  useNavigate,
  useParams,
  useRouteContext,
} from '@tanstack/react-router';
import { WorkflowEditorPage } from '@/features/workflow-editor/public';
import { WorkspaceUnavailablePage } from './root-layout';
import { WorkspaceRouteShell } from './workspace-route-shell';

export function WorkflowEditorRoute() {
  const { apiClient } = useRouteContext({
    from: '/w/$workspaceId/workflows/$workflowId',
  });
  const data = useLoaderData({
    from: '/w/$workspaceId/workflows/$workflowId',
  });
  const params = useParams({
    from: '/w/$workspaceId/workflows/$workflowId',
  });
  const navigate = useNavigate();
  if (data.workspace === null) return <WorkspaceUnavailablePage />;
  const workspace = data.workspace;
  return (
    <WorkspaceRouteShell
      apiClient={apiClient}
      user={data.user}
      workspace={workspace}
      pageTitle="Workflow editor"
      layout="editor"
    >
      <WorkflowEditorPage
        apiClient={apiClient}
        user={data.user}
        workspace={workspace}
        workflowId={params.workflowId}
        onBack={() =>
          void navigate({
            to: '/w/$workspaceId/workflows',
            params: { workspaceId: workspace.id },
          })
        }
        onRunAccepted={(runId) => {
          void navigate({
            to: '/w/$workspaceId/runs/$runId',
            params: { workspaceId: workspace.id, runId },
          });
        }}
        onOpenSettings={() => {
          void navigate({
            to: '/w/$workspaceId/workflows/$workflowId/settings',
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
