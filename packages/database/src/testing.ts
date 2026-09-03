// Broad test and migration-fixture surface; production code must use role-owned package subpaths instead.
export {
  createOperatorRunReplayStore,
  OperatorRunReplayMismatchError,
  OperatorRunReplayNotExecutableError,
  type OperatorRunReplayCheckpointFactory,
  type OperatorRunReplayStore,
} from './operator-run-replay.js';
export {
  reconcileUnknownOutcomeEvidence,
  UnknownOutcomeReconciliationMismatchError,
  UnknownOutcomeReconciliationStateError,
  type UnknownOutcomeReconciliationResult,
} from './unknown-outcome-reconciliation.js';
export {
  createWorkflowTriggerReconciliationDatabase,
  WorkflowTriggerReconciliationMismatchError,
  WorkflowTriggerStalePublicationError,
  type WorkflowTriggerHealth,
  type WorkflowTriggerReconciliationDatabase,
} from './workflow-triggers.js';
export {
  createWebhookTriggerDatabase,
  WebhookDeliveryIneligibleError,
  WebhookDeliveryReplayMismatchError,
  WebhookIngressRateLimitExceededError,
  WebhookTriggerIdempotencyConflictError,
  WebhookTriggerNotFoundError,
  type AcceptVerifiedWebhookDeliveryInput,
  type SealedWebhookTriggerSecret,
  type WebhookCheckpointFactory,
  type WebhookTriggerDatabase,
  type WebhookVerificationReference,
} from './webhook-triggers.js';
export { workflowTriggerProjection } from './workflow-trigger-projection.js';
export {
  createScheduleTriggerScanner,
  createScheduleTriggerDatabase,
  ScheduleClaimLostError,
  ScheduleTriggerError,
  type ScanDueSchedulesResult,
  type ScheduleCheckpointFactory,
  type ScheduleTriggerScanner,
  type ScheduleTriggerDatabase,
  type ScheduleTriggerCommandResult,
  type ScheduleTriggerRecord,
} from './schedule-triggers.js';
export {
  parseScheduleRecurrence,
  resolveScheduleObservation,
  SCHEDULE_CRON_PARSER_VERSION,
  type ScheduleObservation,
  type ScheduleRecurrence,
} from './schedule-recurrence.js';
export type { WorkflowTriggerProjection } from './workflow-trigger-projection.js';
export {
  createFailureNotificationDestinationDatabase,
  FailureNotificationDestinationError,
  type FailureNotificationDestinationDatabase,
  type FailureNotificationDestinationRecord,
} from './failure-notification-destinations.js';
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
} from './postgres-telemetry.js';
export {
  createWorkspaceLifecycleCommandCoordinator,
  type WorkspaceLifecycleCommandCoordinator,
  type WorkspaceLifecycleCommandOutcome,
  type WorkspaceLifecycleCommandType,
  type WorkspaceLifecycleLedger,
  type WorkspaceLifecycleLedgerRecord,
} from './workspace-lifecycle-commands.js';
export {
  CONTROL_LEDGER_ZERO_HASH,
  ControlLedgerCommandConflictError,
  ControlLedgerReconciliationBoundError,
  ControlLedgerReconciliationError,
  createControlLedgerCoordinator,
  type AppendControlLedgerRecord,
  type CommittedArtifactInventoryPage,
  type CommittedArtifactInventoryRecord,
  type CommittedArtifactInventoryInput,
  type ControlLedger,
  type ControlLedgerCommandType,
  type ControlLedgerCoordinator,
  type ControlLedgerInventoryResult,
  type ControlLedgerReconcileResult,
  type ControlLedgerReconciliation,
  type ControlLedgerRecord,
  type LegalHoldCommandInput,
  type LegalHoldCommandResult,
  type LegalHoldCommandType,
} from './control-ledger-coordinator.js';
export { createDueNodeWakeupScanner } from './due-node-wakeup-scanner.js';
export type { DueNodeWakeupScanner } from './due-node-wakeup-scanner.js';
export {
  createFailureNotificationStore,
  FailureNotificationStateError,
} from './failure-notifications.js';
export type {
  FailureNotificationClaimResult,
  FailureNotificationDelivery,
  FailureNotificationResolvedDestination,
  FailureNotificationStore,
} from './failure-notifications.js';
export { createDeadlineWakeupScanner } from './deadline-wakeup-scanner.js';
export type { DeadlineWakeupScanner } from './deadline-wakeup-scanner.js';
export {
  CONNECTION_AUTH_TYPE,
  CONNECTION_EVENT_TYPE,
  CONNECTION_STATUS,
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionNotFoundError,
  ConnectionSecretVersionConflictError,
  ConnectionTestInProgressError,
  ConnectionUnavailableError,
  createConnectionDatabase,
  createApiConnectionDatabase,
  createWorkerConnectionResolutionDatabase,
} from './connections.js';
export type {
  ConnectionAuthType,
  ConnectionDatabase,
  ApiConnectionDatabase,
  ConnectionManagementDatabase,
  ConnectionResolutionDatabase,
  ConnectionTestDatabase,
  WorkerConnectionResolutionDatabase,
  ConnectionRecord,
  ConnectionStatus,
  ConnectionTestOutcome,
  ConnectionTestResult,
  StartConnectionTestInput,
  StartConnectionTestResult,
  MarkConnectionTestDispatchedInput,
  CompleteConnectionTestInput,
  AbandonConnectionTestInput,
  AssertConnectionSecretCurrentInput,
  CreateConnectionInput,
  FindConnectionCreateReplayInput,
  FindConnectionRotateReplayInput,
  RecordConnectionHealthInput,
  ResolveConnectionSecretInput,
  ResolveConnectionTestSecretInput,
  ResolvedConnectionSecretRecord,
  RevokeConnectionInput,
  RotateConnectionSecretInput,
  SealedConnectionSecretRecord,
} from './connections.js';
export {
  checkCompatibilityReleasePreactivationTarget,
  checkExpectedCompatibilityRelease,
  checkExpectedCompatibilityReleaseSet,
  CompatibilityReleaseMismatchError,
  lockExpectedCompatibilityRelease,
  lockExpectedCompatibilityReleaseSet,
  lockExpectedCompatibilityReleaseSetWithClient,
  parseCompatibilityReleaseExpectation,
  parseCompatibilityReleaseExpectationSet,
  parseCompatibilityReleaseExpectationHistory,
} from './compatibility-release.js';
export type {
  CompatibilityReleaseExpectation,
  CompatibilityReleaseExpectationSet,
} from './compatibility-release.js';
export { createCompatibilityReleaseMaintenance } from './compatibility-release-maintenance.js';
export type { CompatibilityReleaseMaintenance } from './compatibility-release-maintenance.js';
export { createCompatibilityReleaseReadinessProbe } from './compatibility-release-readiness.js';
export type { CompatibilityReleaseReadinessProbe } from './compatibility-release-readiness.js';
export {
  ARTIFACT_STATUS,
  ArtifactFinalizeConflictError,
  ArtifactLifecycleConflictError,
  ArtifactMetadataNotFoundError,
  artifactStorageKey,
  claimDueUnfinalizedArtifact,
  claimDueUnfinalizedArtifacts,
  completeArtifactRemoval,
  createPendingArtifact,
  createPendingPreviewArtifact,
  finalizeArtifactUpload,
  readArtifactCapacity,
  readExecutionStorageCapacity,
} from './artifacts.js';
export type {
  ArtifactCapacityObservation,
  ExecutionStorageObservation,
  ArtifactRecord,
  ArtifactStatus,
  ClaimDueUnfinalizedArtifactInput,
  ClaimDueUnfinalizedArtifactsInput,
  CompleteArtifactRemovalInput,
  CreatePendingArtifactInput,
  CreatePendingPreviewArtifactInput,
  FinalizeArtifactInput,
} from './artifacts.js';
export { createWorkspaceDatabase } from './database.js';
export type { WorkspaceDatabase } from './database.js';
export {
  createRetentionDatabase,
  createRetentionEnforcementCoordinator,
} from './retention.js';
export { createRunArtifactRetentionCoordinator } from './run-artifact-retention.js';
export { createWorkspacePurgeCoordinator } from './workspace-purge.js';
export type {
  WorkspacePurgeCoordinator,
  WorkspacePurgeLedger,
  WorkspacePurgeObjectStore,
  WorkspacePurgeProcessResult,
} from './workspace-purge.js';
export type {
  RunArtifactRetentionCoordinator,
  RunArtifactRetentionCoordinatorOptions,
  RunArtifactRetentionProcessResult,
  RunArtifactRetentionStore,
} from './run-artifact-retention.js';
export type {
  OperatorMaintenanceRerunResult,
  RegionalReplicaLagObservation,
  RetentionDatabase,
  RetentionDatabaseOptions,
  RetentionDryRunClaim,
  RetentionDryRunPageResult,
  RetentionDryRunProcessResult,
  RetentionDryRunTuple,
  RetentionEnforcementCoordinator,
  RetentionEnforcementCoordinatorOptions,
  RetentionEnforcementProcessResult,
  RetentionKind,
  RetentionScheduleResult,
  StartWorkflowRunInputRetentionDryRunInput,
  StartWorkflowRunInputRetentionInput,
} from './retention.js';
export {
  createIdentityWorkspaceDatabase,
  IdentityConflictError,
  IdentityNotFoundError,
  MEMBERSHIP_ROLE,
  USER_STATUS,
  WORKSPACE_STATUS,
  WorkspaceLifecycleConflictError,
} from './identity-workspace.js';
export type {
  AuthIdentityRecord,
  CreateAuthIdentityInput,
  CreateSessionInput,
  CreateUserInput,
  IdentityWorkspaceDatabase,
  IdentityConflictReason,
  MembershipRole,
  ResolveOrCreateIdentityInput,
  RequestWorkspaceLifecycleOperationInput,
  ResolvedIdentity,
  SessionRecord,
  UserStatus,
  UserRecord,
  WorkspaceAccessRecord,
  WorkspaceLifecycleOperation,
  WorkspaceLifecycleConflictReason,
  WorkspaceRecord,
  WorkspaceStatus,
  WorkspaceWithOwnerInput,
} from './identity-workspace.js';
export {
  createOidcLoginTransactionStore,
  OidcTransactionCapacityError,
  OidcTransactionSealingError,
} from './oidc-login-transactions.js';
export type {
  OidcLoginTransaction,
  OidcLoginTransactionStore,
  OidcSecretEncryptionAdapter,
  OidcTransactionConsumeResult,
  SealedOidcSecret,
} from './oidc-login-transactions.js';
export {
  acceptWorkflowRun,
  IDEMPOTENCY_STATUS,
  IDEMPOTENCY_STATUS_VALUES,
  IdempotencyRecordCorruptError,
  IdempotencyRequestConflictError,
  RegionalWriteAdmissionPausedError,
  RUN_STATUS,
  RUN_STATUS_VALUES,
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from './execution-acceptance.js';
export {
  acceptPreviewRun,
  readPreviewRun,
  claimPreviewDelivery,
  markPreviewDispatched,
  heartbeatPreviewLease,
  completePreviewAttempt,
  reconcileExpiredPreviewAttempt,
  reconcilePreviewDelivery,
  PreviewAcceptanceCorruptError,
  PreviewAdmissionDeniedError,
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
  PreviewIdempotencyConflictError,
  PriorPreviewInputUnavailableError,
} from './preview-execution.js';
export {
  claimPreviewCleanupDelivery,
  completePreviewArtifactDeletion,
  finishPreviewCleanupDelivery,
  PreviewCleanupStateError,
} from './preview-cleanup.js';
export type {
  PreviewCleanupArtifact,
  PreviewCleanupClaimResult,
  PreviewCleanupFinishResult,
} from './preview-cleanup.js';
export { createPreviewRetentionCoordinator } from './preview-retention.js';
export type {
  PreviewRetentionArtifactStore,
  PreviewRetentionCoordinator,
  PreviewRetentionCoordinatorOptions,
  PreviewRetentionProcessResult,
} from './preview-retention.js';
export type {
  AcceptedPreviewRun,
  AcceptPreviewRunInput,
  PreviewStatus,
  PreviewRunRecord,
  PreviewDelivery,
  PreviewAttemptLease,
  PreviewClaimResult,
  PreviewTerminalOutcome,
  PreviewCompletionResult,
  PreviewHeartbeatResult,
  PreviewReconciliationOutcome,
  PreviewDeliveryReconciliationResult,
} from './preview-execution.js';
export type {
  AcceptedWorkflowRun,
  AcceptWorkflowRunInput,
  IdempotencyStatus,
  RunStatus,
  WorkflowRunAcceptanceReplayInput,
} from './execution-acceptance.js';
export {
  appendRunEvent,
  readRunEventsAfter,
  RUN_EVENT_TYPE,
} from './run-events.js';
export type {
  PersistedRunEvent,
  RunEventPage,
  RunEventType,
} from './run-events.js';
export {
  ExecutionStateConflictError,
  RunEventGapError,
} from './execution-state.js';
export { requestWorkflowRunCancellation } from './workflow-run-cancellation.js';
export {
  EXPECTED_MIGRATION_HEAD,
  checkDatabaseReadiness,
  checkDatabaseServingReadiness,
  checkDatabasePreactivationReadiness,
} from './readiness.js';
export type { DatabaseReadiness, ReadinessOptions } from './readiness.js';
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
  createPublishedWorkflowReader,
  PublishedWorkflowVersionCorruptError,
} from './published-workflow-reader.js';
export type {
  PublishedWorkflowReader,
  PublishedWorkflowReadResult,
  PublishedWorkflowV2Projection,
  PublishedWorkflowVersionIdentity,
  ReadPublishedWorkflowForExecutionInput,
} from './published-workflow-reader.js';
export { createOutboxDispatcherDatabase } from './dispatcher.js';
export {
  createOperatorCommandDatabase,
  OperatorCommandConflictError,
  type GetOperatorCommandInput,
  type GenericOperatorCommandResult,
  type OperatorRunCommandInput,
  type OperatorMaintenanceRerunInput,
  type OperatorWorkflowCommandInput,
  type ReplayOperatorRunInput,
  type OperatorCommandDatabase,
  type OperatorCommandDatabaseOptions,
  type OperatorCommandOutcome,
  type OperatorCommandRecord,
  type OperatorCommandResult,
  type ReconcileOperatorAttemptInput,
  type RecordUnknownOutcomeEvidenceInput,
  type RedispatchFailedOutboxInput,
} from './operator-commands.js';
export type {
  ClaimOutboxBatchInput,
  ClaimOutboxBatchResult,
  LeasedOutboxEvent,
  OutboxBacklogSnapshot,
  OutboxDispatcherDatabase,
  ReleaseOutboxResult,
} from './dispatcher.js';
export {
  consumeInboxMessage,
  InboxChecksumMismatchError,
  InboxReceiptUnavailableError,
} from './inbox.js';
export type { InboxConsumeResult, InboxMessage } from './inbox.js';
export {
  canonicalOutboxPayloadChecksum,
  insertOutboxEvent,
  outboxChecksumSchema,
} from './outbox.js';
export {
  parseStoredExecutionValueV1,
  serializeStoredExecutionValueV1,
} from './stored-execution-value.js';
export {
  isValidStoredExecutionOutput,
  PREVIEW_RETENTION_MAX_MS,
  PREVIEW_STATUS,
} from './preview-execution.js';
export type { InsertedOutboxEvent, OutboxEventInput } from './outbox.js';
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
export {
  parseWorkspaceId,
  withPlatformTransaction,
  withTenantScopedReadClient,
  withTenantScopedClient,
  withWorkspaceTransaction,
  type WorkspaceTransactionOptions,
} from './workspace.js';
export {
  createWorkflowAuthoringDatabase,
  reconcileWorkflowTriggersPayload,
  WorkflowNotFoundError,
  WorkflowIdempotencyConflictError,
  WorkflowDefinitionPlacementError,
  WorkflowRevisionConflictError,
} from './workflow-authoring.js';
export { createWorkflowIntegrationUsageDatabase } from './workflow-integration-usage.js';
export type {
  FindConnectionImpactInput,
  FindProviderOperationImpactInput,
  WorkflowIntegrationImpactPage,
  WorkflowIntegrationImpactRecord,
  WorkflowIntegrationUsageDatabase,
} from './workflow-integration-usage.js';
export type {
  CreateWorkflowInput,
  CreateWorkflowResult,
  ListWorkflowVersionsInput,
  ListWorkflowsInput,
  PublishWorkflowInput,
  PublishWorkflowResult,
  SaveWorkflowDraftInput,
  WorkflowAuthoringDatabase,
  WorkflowAuthoringDatabaseOptions,
  WorkflowAuthoringTestHooks,
  WorkflowDefinitionPlacementIssue,
  WorkflowDraftRecord,
  WorkflowPage,
  WorkflowRecord,
  WorkflowVersionPage,
  WorkflowVersionRecord,
} from './workflow-authoring.js';
export type {
  WorkspaceDrizzle,
  WorkspaceId,
  WorkspaceTransaction,
} from './workspace.js';
export {
  createNodeAttemptRunStore,
  NodeAttemptConnectionFenceError,
  NodeAttemptControlActiveError,
  NodeAttemptDeliveryMismatchError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptOutputInvalidError,
  NodeAttemptReconciliationRequiredError,
  NodeAttemptStateCorruptError,
} from './node-attempt-run-store.js';
export type {
  CompleteNodeAttemptResult,
  NodeAttemptCompletion,
  NodeAttemptClaimResult,
  NodeAttemptInputs,
  NodeAttemptLease,
  NodeAttemptRunStore,
} from './node-attempt-run-store.js';
export {
  createWorkflowRunDatabase,
  WorkflowRunNotExecutableError,
  WorkflowRunNotFoundError,
  WorkflowRunReadCapacityError,
} from './workflow-run-api.js';
export type {
  CancelWorkflowRunInput,
  GetWorkflowRunInput,
  StartPublishedWorkflowRunInput,
  WorkflowNodeRunRecord as ApiWorkflowNodeRunRecord,
  WorkflowRunCheckpointFactory,
  WorkflowRunDatabase,
  WorkflowRunReadModel as ApiWorkflowRunReadModel,
  WorkflowRunRecord as ApiWorkflowRunRecord,
} from './workflow-run-api.js';
