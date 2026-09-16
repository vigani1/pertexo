import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import type { FailureNotificationDestinationResponse } from '@pertexo/contracts/schemas/failure-notifications';
import { Badge } from '@/components/ui/badge';
import type { ApiClient } from '@/lib/api/client';
import { DestinationFormDialog } from './destination-form-dialog';
import { DestinationStatusButton } from './destination-status-button';

export function DestinationRow({
  apiClient,
  userId,
  workspaceId,
  destination,
  connections,
  canManage,
  listRefreshFailed,
  listRefreshPending,
  onRetryListRefresh,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  destination: FailureNotificationDestinationResponse;
  connections: readonly ConnectionResponse[];
  canManage: boolean;
  listRefreshFailed: boolean;
  listRefreshPending: boolean;
  onRetryListRefresh: () => void;
}>) {
  return (
    <li className="grid gap-4 border-b border-border py-5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate font-medium">
            {destination.config.kind === 'email'
              ? destination.config.toEmail
              : destination.config.channelId}
          </p>
          <Badge
            variant={destination.status === 'enabled' ? 'muted' : 'secondary'}
          >
            {destination.status}
          </Badge>
          <Badge variant="secondary">{destination.kind}</Badge>
        </div>
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
          Version {destination.currentVersion} · {destination.id}
        </p>
      </div>
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <DestinationFormDialog
            apiClient={apiClient}
            userId={userId}
            workspaceId={workspaceId}
            connections={connections}
            destination={destination}
            listRefreshFailed={listRefreshFailed}
            listRefreshPending={listRefreshPending}
            onRetryListRefresh={onRetryListRefresh}
          />
          <DestinationStatusButton
            apiClient={apiClient}
            userId={userId}
            workspaceId={workspaceId}
            destinationId={destination.id}
            currentStatus={destination.status}
          />
        </div>
      ) : null}
    </li>
  );
}
