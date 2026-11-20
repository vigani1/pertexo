import { createWorkerConnectionResolutionStore } from '@pertexo/core/connections';
import {
  generatePersistedId,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { fetchHttpPollItems } from '@pertexo/integrations/server';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit/server';
import {
  createConnectionEnvelopeEncryption,
  type ConnectionEnvelopeEncryptionConfig,
  type SecureHttpAddressPolicy,
} from '@pertexo/secrets/server';

import { createProviderConnectionRuntimeFactory } from '../providers/connections.js';
import { createNodeProviderHttpClient } from '../providers/http-client.js';
import { createOAuth2TokenService } from '../providers/oauth2-token.runtime.js';
import { closeOwners } from '../runtime/scanner.js';

type PollingHttpOptions = Readonly<{
  addressPolicy: SecureHttpAddressPolicy;
  connectionEncryption?: ConnectionEnvelopeEncryptionConfig;
  database: DatabaseConfig;
  databaseRuntime?: DatabaseRuntime;
  redisUrl: string;
  workerId: string;
  shutdownTimeoutMillis: number;
}>;

export async function createPollingHttpRuntime(options: PollingHttpOptions) {
  const httpClient = createNodeProviderHttpClient(options.addressPolicy);
  const config = options.connectionEncryption;
  if (config === undefined)
    return {
      fetchPoll: (input: Parameters<typeof fetchHttpPollItems>[0]) =>
        fetchHttpPollItems(input, { httpClient }),
      close: () => Promise.resolve(),
    };

  const encryption = createConnectionEnvelopeEncryption(config);
  let store:
    ReturnType<typeof createWorkerConnectionResolutionStore> | undefined;
  let rateLimiter: RedisRateLimitRuntime | undefined;
  try {
    store = createWorkerConnectionResolutionStore(
      options.database,
      options.databaseRuntime,
    );
    rateLimiter = new RedisRateLimitRuntime(options.redisUrl);
    const tokens = createOAuth2TokenService({
      store,
      encryption: encryption.encryption,
      httpClient,
      newId: generatePersistedId,
    });
    const connectionRuntime = createProviderConnectionRuntimeFactory(
      store,
      encryption.encryption,
      rateLimiter,
      tokens,
    );
    return {
      fetchPoll: (
        input: Parameters<typeof fetchHttpPollItems>[0] &
          Readonly<{ workspaceId: string }>,
      ) =>
        fetchHttpPollItems(input, {
          httpClient,
          ...(input.connectionId === undefined
            ? {}
            : {
                connections: connectionRuntime({
                  workspaceId: input.workspaceId,
                  workerId: options.workerId,
                }),
              }),
        }),
      close: async () => {
        await tokens.drain();
        const failures = await closeOwners(
          [rateLimiter, store, encryption],
          options.shutdownTimeoutMillis,
        );
        if (failures.length > 0)
          throw new AggregateError(failures, 'Polling HTTP cleanup failed');
      },
    };
  } catch (error: unknown) {
    const failures = await closeOwners(
      [rateLimiter, store, encryption],
      options.shutdownTimeoutMillis,
    );
    if (failures.length > 0)
      throw new AggregateError(
        [error, ...failures],
        'Polling HTTP construction and cleanup failed',
      );
    throw error;
  }
}
