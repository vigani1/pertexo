import { useLoaderData, useRouteContext } from '@tanstack/react-router';
import { WorkspaceMembersPage } from '@/features/workspaces/workspace-members.public';
import { WorkspaceUnavailablePage } from './root-layout';
import { WorkspaceRouteShell } from './workspace-route-shell';

export function WorkspaceMembersRoute() {
  const { apiClient } = useRouteContext({
    from: '/w/$workspaceId/settings/members',
  });
  const data = useLoaderData({ from: '/w/$workspaceId/settings/members' });
  if (data.workspace === null) return <WorkspaceUnavailablePage />;

  return (
    <WorkspaceRouteShell
      apiClient={apiClient}
      user={data.user}
      workspace={data.workspace}
      pageTitle="Workspace members"
    >
      <WorkspaceMembersPage
        key={`${data.user.id}:${data.workspace.id}`}
        apiClient={apiClient}
        user={data.user}
        workspace={data.workspace}
      />
    </WorkspaceRouteShell>
  );
}
