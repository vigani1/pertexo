// Broad test and migration-fixture surface; production code must use role-owned package subpaths instead.
export {
  parseDatabaseConfig,
  parseMaintenanceDatabaseConfig,
  parseMigrationConfig,
  parseOperatorDatabaseConfig,
} from './config.js';
export type { DatabaseConfig, MigrationConfig } from './config.js';
export { createWorkspaceDatabase } from './database.js';
export type { WorkspaceDatabase } from './database.js';
export { MIGRATIONS_DIRECTORY, migrateDatabase } from './migrations.js';
export {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
} from './outbox/events.repository.js';
export type {
  InsertedOutboxEvent,
  OutboxEventInput,
} from './outbox/events.repository.js';
export type { DatabaseReadiness } from './platform/database-platform.types.js';
export { withDatabaseDeadlineBudget } from './platform/pool/policy.js';
export {
  DATABASE_METRIC_NAME,
  createDatabasePool,
  type DatabasePoolOptions,
  type DatabasePoolRole,
} from './platform/pool/telemetry/create-pool.js';
export {
  EXPECTED_MIGRATION_HEAD,
  checkDatabaseReadiness,
} from './platform/readiness.repository.js';
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
  runCheckpoints,
  runEvents,
  transportSecurityAuditFacts,
  triggerScheduleOccurrences,
  triggerSchedules,
  usageEvents,
  users,
  webhookTriggerDeliveries,
  webhookTriggerEndpoints,
  webhookTriggerReplayRecords,
  webhookTriggerSecretVersions,
  workflowDrafts,
  workflowIntegrationUsage,
  workflowRuns,
  workflowTriggers,
  workflowVersions,
  workflows,
  workspaceCreationIdempotencyRecords,
  workspaceMemberships,
  workspaces,
} from './schema.js';
export {
  OAUTH2_TABLES,
  insertTokenRow,
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
export { createDatabaseWithInheritedAppSetting } from './testing/postgres/inherited-app-setting.js';
