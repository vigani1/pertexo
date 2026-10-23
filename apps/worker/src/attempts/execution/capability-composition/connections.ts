import { createWorkerConnectionResolutionDatabase } from '@pertexo/database/connections';

import { createConnectionEnvelopeEncryption } from '@pertexo/integrations/server';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';

import { createProviderConnectionRuntimeFactory } from '../../../providers/connections.js';

import type { CapabilityAssembly } from './contract.js';

export function prepareConnectionCapability(state: CapabilityAssembly): void {
  const providerRateLimiter =
    state.dependencies.providerRateLimiter ??
    (state.options.redisUrl === undefined
      ? undefined
      : (state.resources.ownedProviderRateLimiter = new RedisRateLimitRuntime(
          state.options.redisUrl,
        )));
  if (providerRateLimiter === undefined)
    throw new Error('Worker provider rate limiter is incomplete');
  const connectionDatabase =
    state.dependencies.connectionDatabase ??
    (state.resources.ownedConnectionDatabase =
      createWorkerConnectionResolutionDatabase(
        state.options.database,
        state.dependencies.databaseRuntime,
      ));
  const encryption =
    state.dependencies.connectionEncryption ??
    (state.options.connectionEncryption === undefined
      ? undefined
      : (state.resources.encryptionRuntime = createConnectionEnvelopeEncryption(
          state.options.connectionEncryption,
        )).encryption);
  if (encryption === undefined)
    throw new Error('Worker connection capability is incomplete');
  state.factories.connections = createProviderConnectionRuntimeFactory(
    connectionDatabase,
    encryption,
    providerRateLimiter,
  );
}
