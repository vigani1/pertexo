import { useNavigate, useSearch } from '@tanstack/react-router';
import { FailureNotificationDestinationsPage } from '@/features/failure-notifications/destinations-page.public';
import { useWorkspaceScope } from './shell/use-workspace-scope';

export function AlertsRoute() {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const { destination } = useSearch({
    from: '/w/$workspaceId/shell/settings-hub/settings/alerts',
  });
  const navigate = useNavigate({ from: '/w/$workspaceId/settings/alerts' });
  return (
    <FailureNotificationDestinationsPage
      key={`${user.id}:${workspace.id}`}
      apiClient={apiClient}
      user={user}
      workspace={workspace}
      {...(destination === undefined
        ? {}
        : { linkedDestinationId: destination })}
      onLinkedDestinationClosed={() => void navigate({ search: {} })}
    />
  );
}
