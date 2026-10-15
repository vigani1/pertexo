import { WorkspaceVariablesPage } from '@/features/workspace-variables/public';
import { useWorkspaceScope } from './shell/use-workspace-scope';
export function WorkspaceVariablesRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  return (
    <WorkspaceVariablesPage
      key={`${user.id}:${workspace.id}`}
      scope={{ apiClient, userId: user.id, workspaceId: workspace.id }}
      workspace={workspace}
    />
  );
}
