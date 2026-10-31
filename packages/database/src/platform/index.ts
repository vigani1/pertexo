export type { DatabaseConfig } from '../config.js';
export {
  parseDatabaseConfig,
  parseMaintenanceDatabaseConfig,
  parseOperatorDatabaseConfig,
} from '../config.js';
export { acquireDatabasePool, createDatabaseRuntime } from './pool/runtime.js';
export type {
  DatabaseRuntime,
  DatabaseRuntimeOptions,
} from './pool/runtime.js';
export { generatePersistedId } from './persisted-id.js';
export {
  DEFAULT_INSTANCE_LIMITS,
  type InstanceCapacity,
} from '../runs/capacity/instance-limits.js';
export {
  IdempotencyConflictError,
  credentialCommandScope,
} from './idempotency/repository.js';
export type { DatabaseReadiness } from './contract.js';
export {
  prepareStoredExecutionValue,
  STORED_EXECUTION_VALUE_LIMITS,
  StoredExecutionValueInvalidError,
} from './stored-execution-value.js';
export { createWorkspaceDatabase } from '../database.js';
export type { WorkspaceDatabase } from '../database.js';

export { createEncryptionKeyRepository } from './encryption/keys.repository.js';
export type { EncryptionKeyRepository } from './encryption/contract.js';

export {
  createSystemMailDeliveryStore,
  createSystemMailEnqueueStore,
} from './mail/repository.js';

export type {
  SystemMailDeliveryClaim,
  SystemMailDeliveryStore,
  SystemMailEnqueueStore,
  SystemMailInput,
  SystemMailPurpose,
  SealedSystemMailPayload,
} from './mail/contract.js';

export { authenticationMailAssociatedData } from './mail/payload.js';

export { insertSystemMail } from './mail/repository.js';

export { withPlatformTransaction } from '../tenant-access/transactions.js';
