// What core areas and secrets build on: applications never import this (a check enforces it).
export {
  appendAuditFact,
  appendAuditFacts,
  type AuditFact,
  type AuditMetadata,
} from './governance/audit/events.repository.js';
export {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from './outbox/events.repository.js';
export {
  IDEMPOTENCY_STATUS,
  IDEMPOTENCY_STATUS_VALUES,
  type IdempotencyStatus,
  type CommandIdentity,
} from './platform/idempotency/command-identity.types.js';
export {
  claimCommand,
  completeCommand,
  findCommandResult,
} from './platform/idempotency/repository.js';
export { sha256HexSchema } from './platform/persisted-primitives.js';
export { acquireAbortablePoolClient } from './platform/pool/abortable-checkout.js';
export { createDedicatedClient } from './platform/pool/dedicated-client.js';
export { destroyCanceledPoolClient } from './platform/pool/client-disposal.js';
export {
  isUniqueConstraintFailure,
  postgresFailure,
  queryFailure,
  rethrowQueryFailure,
} from './platform/query-errors.js';
export { checkDatabaseReadiness } from './platform/readiness.repository.js';
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
} from './tenant-access/transactions/workspace-transaction.types.js';
export {
  installTransactionScope,
  parseWorkspaceId,
} from './tenant-access/transactions/scope.js';
export {
  canonicalJson,
  BoundedJsonInvalidError,
} from './outbox/canonical-json.js';
