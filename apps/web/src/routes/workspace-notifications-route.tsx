import { useLoaderData, useRouteContext } from '@tanstack/react-router';
import { FailureNotificationDestinationsPage } from '@/features/failure-notifications/public';
import { WorkspaceUnavailablePage } from './root-layout';
import { WorkspaceRouteShell } from './workspace-route-shell';

export function WorkspaceNotificationsRoute() {
  const { apiClient } = useRouteContext({
    from: '/w/$workspaceId/settings/notifications',
  });
  const data = useLoaderData({
    from: '/w/$workspaceId/settings/notifications',
  });
  if (data.workspace === null) return <WorkspaceUnavailablePage />;

  return (
    <WorkspaceRouteShell
      apiClient={apiClient}
      user={data.user}
      workspace={data.workspace}
      pageTitle="Notification destinations"
    >
      <FailureNotificationDestinationsPage
        apiClient={apiClient}
        user={data.user}
        workspace={data.workspace}
      />
    </WorkspaceRouteShell>
  );
}
