export type { DatabaseConfig } from '../config.js';
export {
  parseDatabaseConfig,
  parseMaintenanceDatabaseConfig,
  parseOperatorDatabaseConfig,
} from '../config.js';
export { acquireDatabasePool, createDatabaseRuntime } from './pool/runtime.js';
export { surviveConnectionLoss } from './pool/connection-loss.js';
export type {
  DatabaseRuntime,
  DatabaseRuntimeOptions,
} from './pool/runtime.js';
export { generatePersistedId } from './persisted-id.js';
export { isTransientDatabaseFailure } from './query-errors.js';
export {
  IdempotencyConflictError,
  credentialCommandScope,
} from './idempotency/repository.js';
export type { DatabaseReadiness, InstanceCapacity } from './contract.js';
export { createWorkspaceDatabase } from '../database.js';
export type { WorkspaceDatabase } from '../database.js';

export { withPlatformTransaction } from '../tenant-access/transactions.js';
