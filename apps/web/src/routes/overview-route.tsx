import { useLoaderData, useRouteContext } from '@tanstack/react-router';
import { OverviewPage } from '@/features/overview/public';
import { WorkspaceUnavailablePage } from './root-layout';
import { WorkspaceRouteShell } from './workspace-route-shell';

export function OverviewRoute() {
  const { apiClient } = useRouteContext({ from: '/w/$workspaceId/overview' });
  const data = useLoaderData({ from: '/w/$workspaceId/overview' });
  if (data.workspace === null) return <WorkspaceUnavailablePage />;
  return (
    <WorkspaceRouteShell
      apiClient={apiClient}
      user={data.user}
      workspace={data.workspace}
      pageTitle="Overview"
    >
      <OverviewPage
        apiClient={apiClient}
        user={data.user}
        workspace={data.workspace}
      />
    </WorkspaceRouteShell>
  );
}
