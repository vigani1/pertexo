import { useNavigate, useSearch } from '@tanstack/react-router';
import { ConnectionsPage } from '@/features/connections/connections-page.public';
import { useWorkspaceScope } from './use-workspace-scope';

export function ConnectionsRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const search = useSearch({ from: '/w/$workspaceId/shell/connections' });
  const navigate = useNavigate({ from: '/w/$workspaceId/connections' });
  return (
    <ConnectionsPage
      key={`${user.id}:${workspace.id}`}
      apiClient={apiClient}
      user={user}
      workspace={workspace}
      search={search}
      onSearchChange={(next) => void navigate({ search: next })}
    />
  );
}
