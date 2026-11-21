import type { FetchPoll } from '@pertexo/core/triggers';
import { resolvePlatformPollFetcher } from '@pertexo/node-catalog/server';
import {
  createSecurePostgresClient,
  type SecureHttpAddressPolicy,
} from '@pertexo/secrets/server';

import type { ProviderConnectionFactory } from '../providers/connections.runtime.js';
import { createNodeProviderHttpClient } from '../providers/http-client.js';

export function createPollFetcher(
  addressPolicy: SecureHttpAddressPolicy,
  workerId: string,
  connections?: ProviderConnectionFactory,
): FetchPoll {
  const httpClient = createNodeProviderHttpClient(addressPolicy);
  const database = createSecurePostgresClient(
    addressPolicy.allowedPrivateNetworks,
  );
  return async ({ definition, workspaceId, ...input }) =>
    resolvePlatformPollFetcher(definition)(input, {
      httpClient,
      database,
      ...(connections === undefined
        ? {}
        : { connections: () => connections({ workspaceId, workerId }) }),
    });
}
