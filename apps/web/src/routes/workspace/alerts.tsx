import { FailureNotificationDestinationsPage } from '@/features/failure-notifications/destinations-page.public';
import { useWorkspaceScope } from './use-workspace-scope';

export function AlertsRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  return (
    <FailureNotificationDestinationsPage
      key={`${user.id}:${workspace.id}`}
      apiClient={apiClient}
      user={user}
      workspace={workspace}
    />
  );
}
