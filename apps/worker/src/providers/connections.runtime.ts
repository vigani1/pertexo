import { createWorkerConnectionResolutionStore } from '@pertexo/core/connections';
import {
  generatePersistedId,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit/server';
import {
  createConnectionEnvelopeEncryption,
  type ConnectionEnvelopeEncryption,
  type ConnectionEnvelopeEncryptionConfig,
  type SecureHttpAddressPolicy,
} from '@pertexo/secrets/server';

import {
  createProviderConnectionRuntimeFactory,
  type ProviderRateLimiter,
} from './connections.js';
import { ProviderConnectionConfigurationError } from './connections.errors.js';
import { createNodeProviderHttpClient } from './http-client.js';
import { createOAuth2TokenService } from './oauth2-token.runtime.js';

export type ProviderConnectionFactory = ReturnType<
  typeof createProviderConnectionRuntimeFactory
>;

export type ProviderConnectionRuntime = Readonly<{
  connections: ProviderConnectionFactory;
  close(): Promise<void>;
}>;

type ConnectionOptions = Readonly<{
  database: DatabaseConfig;
  redisUrl?: string;
  connectionEncryption?: ConnectionEnvelopeEncryptionConfig;
  addressPolicy: SecureHttpAddressPolicy;
}>;

type ConnectionDependencies = Readonly<{
  databaseRuntime?: DatabaseRuntime;
  connectionStore?: Parameters<
    typeof createProviderConnectionRuntimeFactory
  >[0];
  connectionEncryption?: Pick<ConnectionEnvelopeEncryption, 'open'>;
  providerRateLimiter?: ProviderRateLimiter;
}>;

export async function createProviderConnectionRuntime(
  options: ConnectionOptions,
  dependencies: ConnectionDependencies = {},
): Promise<ProviderConnectionRuntime> {
  let rateLimiter: RedisRateLimitRuntime | undefined;
  let store:
    ReturnType<typeof createWorkerConnectionResolutionStore> | undefined;
  let encryption:
    ReturnType<typeof createConnectionEnvelopeEncryption> | undefined;
  let tokens: ReturnType<typeof createOAuth2TokenService> | undefined;
  let closePromise: Promise<void> | undefined;
  const close = () => {
    closePromise ??= closeResources();
    return closePromise;
  };

  try {
    rateLimiter =
      dependencies.providerRateLimiter === undefined &&
      options.redisUrl !== undefined
        ? new RedisRateLimitRuntime(options.redisUrl)
        : undefined;
    const limiter = dependencies.providerRateLimiter ?? rateLimiter;
    if (limiter === undefined)
      throw new ProviderConnectionConfigurationError(
        'Worker provider rate limiter is incomplete',
      );

    store =
      dependencies.connectionStore === undefined
        ? createWorkerConnectionResolutionStore(
            options.database,
            dependencies.databaseRuntime,
          )
        : undefined;
    const database = dependencies.connectionStore ?? store;
    encryption =
      dependencies.connectionEncryption === undefined &&
      options.connectionEncryption !== undefined
        ? createConnectionEnvelopeEncryption(options.connectionEncryption)
        : undefined;
    const envelope =
      dependencies.connectionEncryption ?? encryption?.encryption;
    if (database === undefined || envelope === undefined)
      throw new ProviderConnectionConfigurationError(
        'Worker connection capability is incomplete',
      );

    if (store !== undefined && encryption !== undefined)
      tokens = createOAuth2TokenService({
        store,
        encryption: encryption.encryption,
        httpClient: createNodeProviderHttpClient(options.addressPolicy),
        newId: generatePersistedId,
      });

    return {
      connections: createProviderConnectionRuntimeFactory(
        database,
        envelope,
        limiter,
        tokens,
      ),
      close,
    };
  } catch (error: unknown) {
    try {
      await close();
    } catch (cleanupError: unknown) {
      const failures =
        cleanupError instanceof AggregateError
          ? (cleanupError.errors as unknown[])
          : [cleanupError];
      throw new AggregateError(
        [error, ...failures],
        'Worker provider connection construction and cleanup failed',
      );
    }
    throw error;
  }

  async function closeResources(): Promise<void> {
    // Refreshes must finish writing their tokens before the store closes.
    await tokens?.drain();
    const results = await Promise.allSettled(
      [store, encryption, rateLimiter].map(async (owner) => owner?.close()),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        'Worker provider connection shutdown failed',
      );
  }
}
