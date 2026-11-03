export {
  CONNECTION_AUTH_TYPE,
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionNotFoundError,
  ConnectionNotOAuth2Error,
  ConnectionOAuth2NotConnectedError,
  ConnectionOAuth2RevokedError,
  ConnectionSharingRevisionConflictError,
  ConnectionSecretVersionConflictError,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
} from './connection.js';
export {
  createConnectionStore,
  createWorkerConnectionResolutionStore,
  type ApiConnectionStore,
  type ConnectionLookupStore,
  type ConnectionManagementStore,
  type ConnectionReadStore,
  type ConnectionResolutionStore,
  type ConnectionSharingStore,
  type ConnectionTestStore,
  type ConnectionUsageStore,
  type OAuth2ConsentStore,
  type WorkerConnectionResolutionStore,
} from './connection.store.js';
export type { OAuth2TokenStore } from './oauth2/tokens.repository.js';
export type {
  ConnectionPage,
  ConnectionRecord,
  ConnectionTestOutcome,
  ConnectionTestResult,
  ListConnectionsInput,
  ReadConnectionInput,
  ResolvedConnectionSecretRecord,
} from './connection.js';
export type {
  ConnectionUsageCursor,
  ConnectionUsagePage,
  ConnectionUsageRecord,
  ListConnectionUsageInput,
} from './discovery/connection-usage.types.js';
export type { ConsumedOAuth2Authorization } from './oauth2/oauth2-grant.types.js';
export { applyConnectionHealthObservation } from './health/observations.repository.js';
export type { ConnectionHealthApplicationResult } from './health/connection-health.types.js';

// Attempts, authoring, lifecycle, notifications and previews use these directly (ADR 091).
export type {} from './oauth2/clients.repository.js';
export type {} from './runtime/credential-use.repository.js';

export { createOAuth2TokenService } from './oauth2/access-token.js';

export { withCommitAttempts } from './oauth2/refresh.js';

export type {
  OAuth2TokenScope,
  OAuth2TokenService,
} from './oauth2/access-token.js';

export {
  decodeStoredClientSecret,
  decodeStoredTokens,
  encodeStoredClientSecret,
  encodeStoredTokens,
  isRenewable,
} from './oauth2/stored.js';

export type { OAuth2StoredTokens } from './oauth2/stored.js';

export type { OAuth2TokenServiceDependencies } from './oauth2/refresh.js';
export type { OAuth2AccessToken } from './oauth2/token-renewal.js';
export type { OAuth2GrantLossActor } from './oauth2/oauth2-grant.types.js';

export type {
  IssuedOAuth2Tokens,
  OAuth2TokenRecord,
} from './oauth2/oauth2-grant.types.js';
