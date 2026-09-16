import {
  useLoaderData,
  useNavigate,
  useParams,
  useRouteContext,
} from '@tanstack/react-router';
import { RunDetailPage } from '@/features/workflow-runs/public';
import { WorkspaceUnavailablePage } from './root-layout';
import { WorkspaceRouteShell } from './workspace-route-shell';

export function RunDetailRoute() {
  const { apiClient } = useRouteContext({
    from: '/w/$workspaceId/runs/$runId',
  });
  const data = useLoaderData({ from: '/w/$workspaceId/runs/$runId' });
  const params = useParams({ from: '/w/$workspaceId/runs/$runId' });
  const navigate = useNavigate();
  if (data.workspace === null) return <WorkspaceUnavailablePage />;
  const workspace = data.workspace;
  return (
    <WorkspaceRouteShell
      apiClient={apiClient}
      user={data.user}
      workspace={workspace}
      pageTitle="Run detail"
    >
      <RunDetailPage
        apiClient={apiClient}
        user={data.user}
        workspace={workspace}
        runId={params.runId}
        onBackToWorkflow={(workflowId) => {
          void navigate({
            to: '/w/$workspaceId/workflows/$workflowId',
            params: { workspaceId: workspace.id, workflowId },
          });
        }}
        onRunAccepted={(runId) => {
          void navigate({
            to: '/w/$workspaceId/runs/$runId',
            params: { workspaceId: workspace.id, runId },
          });
        }}
      />
    </WorkspaceRouteShell>
  );
}
