import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { useQuery } from '@tanstack/react-query';
import { connectionDiscoveryQueryOptions } from '@/features/connections/queries.public';
import { failureNotificationDestinationsQueryOptions } from '@/features/failure-notifications/queries.public';
import type { ApiClient } from '@/lib/api/client';

/**
 * Connections and failure-alert destinations, each read only when the role
 * may see them. Home uses both for "Needs attention" and the first-run
 * checklist; the Query cache shares the reads.
 */
export function useSetupReads({
  apiClient,
  userId,
  workspace,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
}>) {
  const canReadConnections = workspace.capabilities.includes('connection:read');
  const canReadDestinations =
    workspace.capabilities.includes('workflow:update');
  const connections = useQuery({
    ...connectionDiscoveryQueryOptions(apiClient, userId, workspace.id),
    enabled: canReadConnections,
  });
  const destinations = useQuery({
    ...failureNotificationDestinationsQueryOptions(
      apiClient,
      userId,
      workspace.id,
    ),
    enabled: canReadDestinations,
  });
  return {
    connections,
    destinations,
    canReadConnections,
    canReadDestinations,
  } as const;
}
