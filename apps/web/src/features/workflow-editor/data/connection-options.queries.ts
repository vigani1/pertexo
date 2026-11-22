import { queryOptions } from '@tanstack/react-query';
import {
  connectionLookupPath,
  connectionLookupResponseSchema,
  type ConnectionLookupField,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';

export function connectionOptions(
  scope: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspaceId: string;
  }>,
  connectionId: string,
  { providerKey, lookup }: ConnectionLookupField,
) {
  return queryOptions({
    queryKey: [
      'connection-options',
      scope.userId,
      scope.workspaceId,
      connectionId,
      providerKey,
      lookup,
    ],
    retry: false,
    queryFn: ({ signal }) =>
      scope.apiClient.request({
        path: connectionLookupPath(scope.workspaceId, connectionId),
        method: 'POST',
        body: { providerKey, lookup },
        signal,
        response: {
          kind: 'json',
          decode: (value) => connectionLookupResponseSchema.parse(value),
        },
      }),
  });
}
