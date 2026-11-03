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
