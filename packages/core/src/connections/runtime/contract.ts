import type { ConnectionSharingStore } from '../commands/contract.js';
import type { ConnectionUsageStore } from '../discovery/contract.js';
import type {
  OAuth2ConsentStore,
  OAuth2TokenStore,
} from '../oauth2/contract.js';
import type {
  ConnectionStore,
  ConnectionManagementStore,
  ConnectionReadStore,
  ConnectionResolutionStore,
  ConnectionTestStore,
  RequestMetadata,
  ResolvedConnectionSecretRecord,
} from '../contract.js';

/** API capability plus the lifecycle operation owned by its runtime factory. */
export type ApiConnectionStore = ConnectionSharingStore &
  ConnectionManagementStore &
  ConnectionReadStore &
  ConnectionTestStore &
  ConnectionLookupStore &
  ConnectionUsageStore &
  OAuth2ConsentStore &
  OAuth2TokenStore &
  Pick<ConnectionStore, 'close'>;

/** Worker resolution capability plus the lifecycle operation owned by its runtime factory. */
export type WorkerConnectionResolutionStore = ConnectionResolutionStore &
  OAuth2TokenStore &
  Pick<ConnectionStore, 'close'>;

/**
 * Owns API credential resolution for ADR 046 read-only provider lookups and
 * its access audit fact. A lookup never changes connection health.
 */

export type ResolveConnectionLookupSecretInput = RequestMetadata &
  Readonly<{
    workspaceId: string;
    actorId: string;
    connectionId: string;
    expectedProviderKey: string;
    purpose: string;
    signal?: AbortSignal;
  }>;

export type ConnectionLookupStore = Readonly<{
  resolveConnectionLookupSecret(
    input: ResolveConnectionLookupSecretInput,
  ): Promise<ResolvedConnectionSecretRecord>;
}>;

/** The connection secret a run or preview was given to use. */
export type ConnectionFence = Readonly<{
  connectionId: string;
  providerKey: string;
  authType: string;
  secretVersionId: string;
}>;
