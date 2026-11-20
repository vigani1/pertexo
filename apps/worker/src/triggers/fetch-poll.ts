import { fetchDatabasePollItems } from '@pertexo/integrations/server';
import {
  createSecurePostgresClient,
  type SecureHttpAddressPolicy,
} from '@pertexo/secrets/server';
import type { MaterializedPollConfig } from '@pertexo/workflow-model';

import type { ProviderConnectionFactory } from '../providers/connections.runtime.js';
import { createHttpPollFetcher } from './fetch-http-poll.js';

export function createPollFetcher(
  addressPolicy: SecureHttpAddressPolicy,
  workerId: string,
  connections?: ProviderConnectionFactory,
) {
  const fetchHttp = createHttpPollFetcher(addressPolicy, workerId, connections);
  const postgres = createSecurePostgresClient(
    addressPolicy.allowedPrivateNetworks,
  );
  return ({
    config,
    ...input
  }: Omit<Parameters<typeof fetchHttp>[0], 'config' | 'connectionId'> &
    Readonly<{ config: MaterializedPollConfig }>) => {
    if ('source' in config) {
      const { connectionId, source: _source, ...settings } = config;
      return fetchDatabasePollItems(
        { ...input, config: settings, connectionId },
        postgres,
        connections?.({ workspaceId: input.workspaceId, workerId }),
      );
    }
    const { connectionId, ...settings } = config;
    return fetchHttp({
      ...input,
      config: settings,
      ...(connectionId === undefined ? {} : { connectionId }),
    });
  };
}
