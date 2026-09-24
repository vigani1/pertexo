import { useLoaderData, useRouteContext } from '@tanstack/react-router';
import { WorkflowListPage } from '@/features/workflows/list.public';
import { WorkspaceUnavailablePage } from './root-layout';
import { WorkspaceRouteShell } from './workspace-route-shell';

export function WorkflowListRoute() {
  const { apiClient } = useRouteContext({
    from: '/w/$workspaceId/workflows',
  });
  const data = useLoaderData({ from: '/w/$workspaceId/workflows' });
  if (data.workspace === null) return <WorkspaceUnavailablePage />;
  const workspace = data.workspace;
  return (
    <WorkspaceRouteShell
      apiClient={apiClient}
      user={data.user}
      workspace={workspace}
      pageTitle="Workflows"
    >
      <WorkflowListPage
        apiClient={apiClient}
        user={data.user}
        workspace={workspace}
      />
    </WorkspaceRouteShell>
  );
}
