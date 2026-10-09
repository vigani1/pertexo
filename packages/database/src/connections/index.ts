export {
  CONNECTION_AUTH_TYPE,
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionNotFoundError,
  ConnectionSecretVersionConflictError,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
  createApiConnectionDatabase,
  createWorkerConnectionResolutionDatabase,
} from './database.js';
export type {
  ApiConnectionDatabase,
  ConnectionLookupDatabase,
  ConnectionManagementDatabase,
  ConnectionPage,
  ConnectionReadDatabase,
  ConnectionRecord,
  ConnectionResolutionDatabase,
  ConnectionTestDatabase,
  ConnectionTestOutcome,
  ConnectionTestResult,
  ConnectionUsageCursor,
  ConnectionUsageDatabase,
  ConnectionUsagePage,
  ConnectionUsageRecord,
  ListConnectionsInput,
  ListConnectionUsageInput,
  ReadConnectionInput,
  ResolvedConnectionSecretRecord,
  WorkerConnectionResolutionDatabase,
} from './database.js';
export { applyConnectionHealthObservation } from './health/observations.js';
export type { ConnectionHealthApplicationResult } from './health/observations.js';
