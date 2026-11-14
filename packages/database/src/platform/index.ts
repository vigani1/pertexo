export type { DatabaseConfig } from '../config.js';
export {
  parseDatabaseConfig,
  parseMaintenanceDatabaseConfig,
  parseOperatorDatabaseConfig,
} from '../config.js';
export {
  acquireDatabasePool,
  createDatabaseRuntime,
} from './pool/database-pool.runtime.js';
export { surviveConnectionLoss } from './pool/connection-loss.js';
export { checkClientConnection } from './pool/connection-check.js';
export { InheritedSessionContextError } from './pool/inherited-session-context.errors.js';
export { DATABASE_POOL_ROLES } from './pool/policy.js';
export { APP_SETTING_NAMES } from '../tenant-access/app-settings.js';
export type {
  DatabaseRuntime,
  DatabaseRuntimeOptions,
} from './pool/database-pool.runtime.js';
export { generatePersistedId } from './persisted-id.js';
export { isTransientDatabaseFailure } from './query.errors.js';
export { credentialCommandScope } from './idempotency/repository.js';
export { IdempotencyConflictError } from './idempotency/idempotency.errors.js';
export type {
  DatabaseReadiness,
  InstanceCapacity,
} from './database-platform.types.js';
export { createWorkspaceDatabase } from './workspace-database.js';
export type { WorkspaceDatabase } from './workspace-database.js';

export { withPlatformTransaction } from '../tenant-access/transactions.js';
