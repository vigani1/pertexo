import { FailureNotificationDestinationsPage } from '@/features/failure-notifications/public';
import { useWorkspaceScope } from './use-workspace-scope';

export function AlertsRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  return (
    <FailureNotificationDestinationsPage
      apiClient={apiClient}
      user={user}
      workspace={workspace}
    />
  );
}
