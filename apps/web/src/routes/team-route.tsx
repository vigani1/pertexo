import { WorkspaceMembersPage } from '@/features/workspaces/workspace-members.public';
import { useWorkspaceScope } from './use-workspace-scope';

export function TeamRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  return (
    <WorkspaceMembersPage
      key={`${user.id}:${workspace.id}`}
      apiClient={apiClient}
      user={user}
      workspace={workspace}
    />
  );
}
