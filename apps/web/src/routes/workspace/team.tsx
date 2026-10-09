import { useNavigate, useSearch } from '@tanstack/react-router';
import { WorkspaceMembersPage } from '@/features/workspaces/workspace-members.public';
import { useWorkspaceScope } from './use-workspace-scope';

export function TeamRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const search = useSearch({ from: '/w/$workspaceId/shell/team' });
  const navigate = useNavigate({ from: '/w/$workspaceId/team' });
  return (
    <WorkspaceMembersPage
      key={`${user.id}:${workspace.id}`}
      apiClient={apiClient}
      user={user}
      workspace={workspace}
      search={search}
      onSearchChange={(next) => void navigate({ search: next })}
    />
  );
}
