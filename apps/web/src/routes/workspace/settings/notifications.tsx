import { NotificationPreferencesPage } from '@/features/inbox/settings.public';
import { useWorkspaceScope } from '../shell/use-workspace-scope';
export function NotificationPreferencesRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  return (
    <NotificationPreferencesPage
      key={`${user.id}:${workspace.id}`}
      paused={workspace.status !== 'active'}
      scope={{ apiClient, userId: user.id, workspaceId: workspace.id }}
    />
  );
}
