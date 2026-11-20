import { fetchHttpPollItems } from '@pertexo/integrations/server';
import type { SecureHttpAddressPolicy } from '@pertexo/secrets/server';

import type { ProviderConnectionFactory } from '../providers/connections.runtime.js';
import { createNodeProviderHttpClient } from '../providers/http-client.js';

export function createHttpPollFetcher(
  addressPolicy: SecureHttpAddressPolicy,
  workerId: string,
  connections?: ProviderConnectionFactory,
) {
  const httpClient = createNodeProviderHttpClient(addressPolicy);
  return (
    input: Parameters<typeof fetchHttpPollItems>[0] &
      Readonly<{ workspaceId: string }>,
  ) =>
    fetchHttpPollItems(input, {
      httpClient,
      ...(input.connectionId === undefined || connections === undefined
        ? {}
        : {
            connections: connections({
              workspaceId: input.workspaceId,
              workerId,
            }),
          }),
    });
}
