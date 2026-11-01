// What core areas build on: applications never import this (a check enforces it).
export {
  appendAuditFact,
  appendAuditFacts,
  type AuditFact,
  type AuditMetadata,
} from './governance/audit/events.repository.js';
export { projectAuditMetadata } from './governance/audit/projection.js';
export {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
  serializeBoundedPlainJson,
} from './outbox/events.repository.js';
export { type CommandIdentity } from './platform/idempotency/contract.js';
export {
  claimCommand,
  completeCommand,
  findCommandResult,
} from './platform/idempotency/repository.js';
export {
  isIntegerInRange,
  sha256HexSchema,
} from './platform/persisted-primitives.js';
export { destroyCanceledPoolClient } from './platform/pool/client-disposal.js';
export {
  isUniqueConstraintFailure,
  postgresFailure,
  queryFailure,
  rethrowQueryFailure,
} from './platform/query-errors.js';
export { checkDatabaseReadiness } from './platform/readiness.queries.js';
export {
  parseStoredExecutionValue,
  serializeStoredExecutionJsonValue,
  serializeStoredExecutionValue,
  serializeWrittenJsonValue,
  type StoredExecutionJsonValue,
  type StoredExecutionValue,
  storedExecutionValuesEqual,
} from './platform/stored-execution-value.js';
export {
  withActorDiscoveryScope,
  withActorScopedClient,
  withMultiWorkspaceTransaction,
  withTenantScopedClient,
  withTenantScopedReadClient,
  withWorkspaceReadTransaction,
  withWorkspaceScope,
  withWorkspaceTransaction,
} from './tenant-access/transactions.js';
export {
  type WorkspaceDrizzle,
  type WorkspaceId,
  type WorkspaceScopeRunner,
  type WorkspaceTransaction,
  type WorkspaceTransactionOptions,
} from './tenant-access/transactions/contract.js';
export {
  installTransactionScope,
  parseWorkspaceId,
} from './tenant-access/transactions/scope.js';
