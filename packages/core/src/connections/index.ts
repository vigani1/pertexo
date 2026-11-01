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
} from './contract.js';
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
} from './store.js';
export type { OAuth2TokenStore } from './oauth2/tokens.repository.js';
export type {
  ConnectionPage,
  ConnectionRecord,
  ConnectionTestOutcome,
  ConnectionTestResult,
  ListConnectionsInput,
  ReadConnectionInput,
  ResolvedConnectionSecretRecord,
} from './contract.js';
export type {
  ConnectionUsageCursor,
  ConnectionUsagePage,
  ConnectionUsageRecord,
  ListConnectionUsageInput,
} from './discovery/contract.js';
export type { ConsumedOAuth2Authorization } from './oauth2/contract.js';
export { applyConnectionHealthObservation } from './health/observations.repository.js';
export type { ConnectionHealthApplicationResult } from './health/contract.js';

// Attempts, authoring, lifecycle, notifications and previews use these directly (ADR 091).
export type {} from './oauth2/clients.repository.js';
export type {} from './runtime/credential-use.repository.js';
