// Broad test and migration-fixture surface; production code must use role-owned package subpaths instead.
export * from './authoring/testing.js';
export * from './compatibility/testing.js';
export * from './connections/testing.js';
export * from './execution/testing.js';
export * from './lifecycle/testing.js';
export * from './operator/testing.js';
export * from './tenant-access/testing.js';
export * from './triggers/testing.js';
export {
  parseDatabaseConfig,
  parseMaintenanceDatabaseConfig,
  parseLifecycleCommandDatabaseConfig,
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
} from './platform/postgres-telemetry.js';
export { createWorkspaceDatabase } from './database.js';
export type { WorkspaceDatabase } from './database.js';
export {
  EXPECTED_MIGRATION_HEAD,
  checkDatabaseReadiness,
  checkDatabaseServingReadiness,
  checkDatabasePreactivationReadiness,
} from './platform/readiness.js';
export type {
  DatabaseReadiness,
  ReadinessOptions,
} from './platform/readiness.js';
export {
  CoordinatorDeliveryMismatchError,
  CoordinatorPlanInvalidError,
  CoordinatorRunStateCorruptError,
  createCoordinatorRunStore,
} from './coordinator-run-store.js';
export type {
  AcknowledgeAdvanceDeliveryResult,
  CommitAdvancePlanResult,
  CoordinatorAdvanceDelivery,
  CoordinatorRunStore,
  LoadAdvanceStateResult,
} from './coordinator-run-store.js';
export {
  artifacts,
  auditEvents,
  authIdentities,
  databaseSchema,
  idempotencyRecords,
  inboxReceipts,
  nodeAttempts,
  nodeCompatibilityCurrent,
  nodeCompatibilityReleases,
  nodeRuns,
  outboxEvents,
  rlsProbeRecords,
  runCheckpoints,
  runEvents,
  sessions,
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
