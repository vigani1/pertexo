import { useLoaderData, useRouteContext } from '@tanstack/react-router';
import { ConnectionsPage } from '@/features/connections/public';
import { WorkspaceUnavailablePage } from './root-layout';
import { WorkspaceRouteShell } from './workspace-route-shell';

export function ConnectionsRoute() {
  const { apiClient } = useRouteContext({
    from: '/w/$workspaceId/connections',
  });
  const data = useLoaderData({ from: '/w/$workspaceId/connections' });
  if (data.workspace === null) return <WorkspaceUnavailablePage />;
  return (
    <WorkspaceRouteShell
      apiClient={apiClient}
      user={data.user}
      workspace={data.workspace}
      pageTitle="Connections"
    >
      <ConnectionsPage
        apiClient={apiClient}
        user={data.user}
        workspace={data.workspace}
      />
    </WorkspaceRouteShell>
  );
}
