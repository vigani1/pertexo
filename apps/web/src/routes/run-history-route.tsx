import {
  useLoaderData,
  useNavigate,
  useRouteContext,
  useSearch,
} from '@tanstack/react-router';
import { RunHistoryPage } from '@/features/workflow-runs/public';
import { WorkspaceUnavailablePage } from './root-layout';
import { WorkspaceRouteShell } from './workspace-route-shell';

export function RunHistoryRoute() {
  const { apiClient } = useRouteContext({ from: '/w/$workspaceId/runs' });
  const data = useLoaderData({ from: '/w/$workspaceId/runs' });
  const filters = useSearch({ from: '/w/$workspaceId/runs' });
  const navigate = useNavigate();
  if (data.workspace === null) return <WorkspaceUnavailablePage />;
  const workspace = data.workspace;
  return (
    <WorkspaceRouteShell
      apiClient={apiClient}
      user={data.user}
      workspace={workspace}
      pageTitle="Run history"
    >
      <RunHistoryPage
        apiClient={apiClient}
        user={data.user}
        workspace={workspace}
        filters={filters}
        onFiltersChange={(search) => {
          void navigate({
            to: '/w/$workspaceId/runs',
            params: { workspaceId: workspace.id },
            search,
          });
        }}
        onOpenRun={(runId) => {
          void navigate({
            to: '/w/$workspaceId/runs/$runId',
            params: { workspaceId: workspace.id, runId },
          });
        }}
      />
    </WorkspaceRouteShell>
  );
}
