import { createWorkerConnectionResolutionStore } from '@pertexo/core/connections';
import { generatePersistedId } from '@pertexo/database/platform';

import {
  createConnectionEnvelopeEncryption,
  createNodeSecureHttpClient,
  createOAuth2TokenService,
} from '@pertexo/integrations/server';
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
  const ownedDatabase =
    state.dependencies.connectionStore === undefined
      ? (state.resources.ownedConnectionStore =
          createWorkerConnectionResolutionStore(
            state.options.database,
            state.dependencies.databaseRuntime,
          ))
      : undefined;
  const connectionStore = state.dependencies.connectionStore ?? ownedDatabase;
  if (connectionStore === undefined)
    throw new Error('Worker connection capability is incomplete');
  const ownedEncryption =
    state.dependencies.connectionEncryption === undefined &&
    state.options.connectionEncryption !== undefined
      ? (state.resources.encryptionRuntime = createConnectionEnvelopeEncryption(
          state.options.connectionEncryption,
        )).encryption
      : undefined;
  const encryption = state.dependencies.connectionEncryption ?? ownedEncryption;
  if (encryption === undefined)
    throw new Error('Worker connection capability is incomplete');
  // S17: an address policy is always passed, because the transport only refuses
  // plain http to a public address when one exists.
  const tokens =
    ownedDatabase === undefined || ownedEncryption === undefined
      ? undefined
      : createOAuth2TokenService({
          store: ownedDatabase,
          encryption: ownedEncryption,
          httpClient: createNodeSecureHttpClient({
            allowedPrivateNetworks: state.options.allowedPrivateNetworks ?? [],
          }),
          newId: generatePersistedId,
        });
  state.resources.oauth2Tokens = tokens;
  state.factories.connections = createProviderConnectionRuntimeFactory(
    connectionStore,
    encryption,
    providerRateLimiter,
    tokens,
  );
}
