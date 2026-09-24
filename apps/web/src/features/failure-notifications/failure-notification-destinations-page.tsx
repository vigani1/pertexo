import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { connectionDiscoveryQueryOptions } from '@/features/connections/public';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import { DestinationFormDialog } from './components/destination-form-dialog';
import { DestinationRow } from './components/destination-row';
import { destinationListErrorMessage } from './failure-notification-errors';
import { failureNotificationDestinationsQueryOptions } from './failure-notifications.queries';

export function FailureNotificationDestinationsPage({
  apiClient,
  user,
  workspace,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
}>) {
  const canRead = workspace.capabilities.includes('workflow:update');
  const canManage = workspace.capabilities.includes('connection:manage');
  const canReadConnections = workspace.capabilities.includes('connection:read');
  const destinations = useQuery({
    ...failureNotificationDestinationsQueryOptions(
      apiClient,
      user.id,
      workspace.id,
    ),
    enabled: canRead,
  });
  const connections = useQuery({
    ...connectionDiscoveryQueryOptions(apiClient, user.id, workspace.id),
    enabled: canManage && canReadConnections,
  });
  const items = destinations.data?.items ?? [];
  const collectionUnavailable =
    destinations.isError &&
    isApiError(destinations.error) &&
    [401, 403, 404].includes(destinations.error.status ?? 0);

  if (!canRead)
    return (
      <Empty>
        <EmptyTitle>Notification destinations are unavailable</EmptyTitle>
        <EmptyDescription>
          Your workspace role does not allow you to view workflow notification
          destinations.
        </EmptyDescription>
      </Empty>
    );

  if (collectionUnavailable)
    return (
      <Empty>
        <EmptyTitle>Notification destinations are unavailable</EmptyTitle>
        <EmptyDescription>
          This collection is not available for the current workspace or session.
          It may not exist or may be outside your account access.
        </EmptyDescription>
      </Empty>
    );

  const availableConnections = connections.data?.items ?? [];
  const retryDestinationRefresh = () => {
    void destinations.refetch();
  };
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
        <div>
          <h1 className="sr-only text-3xl font-semibold tracking-tight lg:not-sr-only lg:block lg:text-4xl">
            Notifications
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Configure versioned Slack or email destinations that workflows can
            select for failure notifications.
          </p>
        </div>
        {canManage && !connections.isPending ? (
          <DestinationFormDialog
            apiClient={apiClient}
            userId={user.id}
            workspaceId={workspace.id}
            connections={availableConnections}
            listRefreshFailed={destinations.isError && items.length > 0}
            listRefreshPending={destinations.isRefetching}
            onRetryListRefresh={retryDestinationRefresh}
          />
        ) : null}
      </header>

      {destinations.isError && items.length > 0 ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"
        >
          <p className="text-sm text-destructive">
            These destinations may be stale because the latest refresh failed.
            Open edits are preserved.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={destinations.isRefetching}
            onClick={retryDestinationRefresh}
          >
            {destinations.isRefetching ? 'Retrying…' : 'Retry refresh'}
          </Button>
        </div>
      ) : null}

      {destinations.isPending ? (
        <p role="status" className="py-16 text-sm text-muted-foreground">
          Loading notification destinations…
        </p>
      ) : destinations.isError && items.length === 0 ? (
        <Empty>
          <EmptyTitle>Notification destinations could not be loaded</EmptyTitle>
          <EmptyDescription>
            {destinationListErrorMessage(destinations.error)}
          </EmptyDescription>
          <Button
            className="mt-6"
            type="button"
            variant="outline"
            onClick={() => void destinations.refetch()}
          >
            Try again
          </Button>
        </Empty>
      ) : items.length === 0 ? (
        <Empty>
          <EmptyTitle>No notification destinations</EmptyTitle>
          <EmptyDescription>
            Add a destination to deliver workflow failure notifications through
            an existing connection.
          </EmptyDescription>
        </Empty>
      ) : (
        <ul>
          {items.map((destination) => (
            <DestinationRow
              key={destination.id}
              apiClient={apiClient}
              userId={user.id}
              workspaceId={workspace.id}
              destination={destination}
              connections={availableConnections}
              canManage={canManage}
              listRefreshFailed={destinations.isError && items.length > 0}
              listRefreshPending={destinations.isRefetching}
              onRetryListRefresh={retryDestinationRefresh}
            />
          ))}
        </ul>
      )}
      {canManage && connections.isError ? (
        <p role="alert" className="mt-5 text-sm text-destructive">
          Connections could not be loaded. Destination status remains available,
          but creation and version editing require a refreshed connection list.
        </p>
      ) : null}
    </div>
  );
}
