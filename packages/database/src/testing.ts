// Broad test and migration-fixture surface; production code must use role-owned package subpaths instead.
export type { WorkflowDefinitionPlacementIssue } from '@pertexo/workflow-model';
export {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
  outboxChecksumSchema,
} from './outbox/events.repository.js';
export type {
  InsertedOutboxEvent,
  OutboxEventInput,
} from './outbox/events.repository.js';
export {
  parseDatabaseConfig,
  parseMaintenanceDatabaseConfig,
  parseMigrationConfig,
  parseOperatorDatabaseConfig,
  parseOutboxDispatcherConfig,
} from './config.js';
export type { DatabaseConfig, MigrationConfig } from './config.js';
export {
  createDatabasePool,
  DATABASE_METRIC_NAME,
  type DatabasePoolOptions,
  type DatabasePoolRole,
} from './platform/pool/telemetry/create-pool.js';
export { createWorkspaceDatabase } from './database.js';
export type { WorkspaceDatabase } from './database.js';
export {
  EXPECTED_MIGRATION_HEAD,
  checkDatabaseReadiness,
} from './platform/readiness.queries.js';
export type { DatabaseReadiness } from './platform/contract.js';
export {
  artifacts,
  auditEvents,
  authAccounts,
  authSessions,
  authVerifications,
  databaseSchema,
  idempotencyRecords,
  inboxReceipts,
  nodeAttempts,
  nodeRuns,
  outboxEvents,
  rlsProbeRecords,
  runCheckpoints,
  runEvents,
  transportSecurityAuditFacts,
  triggerScheduleOccurrences,
  triggerSchedules,
  usageEvents,
  users,
  workspaceMemberships,
  workspaces,
  workspaceCreationIdempotencyRecords,
  workflowDrafts,
  workflowIntegrationUsage,
  workflowVersions,
  workflows,
  workflowRuns,
  workflowTriggers,
  webhookTriggerDeliveries,
  webhookTriggerEndpoints,
  webhookTriggerReplayRecords,
  webhookTriggerSecretVersions,
} from './schema.js';
export { migrateDatabase, MIGRATIONS_DIRECTORY } from './migrations.js';
export { withDatabaseDeadlineBudget } from './platform/pool/policy.js';
export {
  insertTokenRow,
  OAUTH2_TABLES,
  rowCounts,
  seedOAuth2Connection,
  seedWorkspace,
  type StoredConnection,
} from './testing/connections/oauth2/fixture.js';
export { createPostgresCommitAckProxy } from './testing/postgres/commit-ack-proxy.js';
export {
  createDisposableDatabaseFixture,
  dropDisconnectedDatabase,
} from './testing/postgres/disposable-database.js';
