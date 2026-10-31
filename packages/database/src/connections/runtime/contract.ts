import type { ConnectionSharingDatabase } from '../commands/contract.js';
import type { ConnectionUsageDatabase } from '../discovery/contract.js';
import type {
  OAuth2ConsentDatabase,
  OAuth2TokenStoreDatabase,
} from '../oauth2/contract.js';
import type {
  ConnectionDatabase,
  ConnectionManagementDatabase,
  ConnectionReadDatabase,
  ConnectionResolutionDatabase,
  ConnectionTestDatabase,
  RequestMetadata,
  ResolvedConnectionSecretRecord,
} from '../contract.js';

/** API capability plus the lifecycle operation owned by its runtime factory. */
export type ApiConnectionDatabase = ConnectionSharingDatabase &
  ConnectionManagementDatabase &
  ConnectionReadDatabase &
  ConnectionTestDatabase &
  ConnectionLookupDatabase &
  ConnectionUsageDatabase &
  OAuth2ConsentDatabase &
  OAuth2TokenStoreDatabase &
  Pick<ConnectionDatabase, 'close'>;

/** Worker resolution capability plus the lifecycle operation owned by its runtime factory. */
export type WorkerConnectionResolutionDatabase = ConnectionResolutionDatabase &
  OAuth2TokenStoreDatabase &
  Pick<ConnectionDatabase, 'close'>;

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

export type ConnectionLookupDatabase = Readonly<{
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
