/**
 * Errors a core repository may throw: storage integrity assertions (core's
 * AGENTS.md, Exceptions). Each says the row the flow holds is corrupt, was
 * lost, or changed under its lock or fence; none is a product decision.
 */
export const STORAGE_INTEGRITY_ERRORS = Object.freeze({
  CoordinatorRunStateCorruptError:
    "A run's stored checkpoint or facts fail their own invariants.",
  CoordinatorDeliveryMismatchError:
    'A coordinator delivery no longer matches its durable outbox row.',
  DeliveryMismatch:
    "A coordinator delivery no longer matches its outbox row or the run's lease.",
  NodeAttemptStateCorruptError:
    "A node attempt's stored state fails its own invariants.",
  NodeAttemptDeliveryMismatchError:
    'A node attempt delivery no longer matches its durable outbox row.',
  ExecutionCapabilityExpiredError:
    "The attempt's execution fence moved on under it.",
  ExecutionStateConflictError:
    'A run event or state write lost its expected sequence or revision.',
  RunEventGapError: "A run's stored event sequence has a gap.",
  PreviewAttemptStateError:
    "A preview attempt's lease, receipt or fence was lost or is corrupt.",
  PreviewDeliveryMismatchError:
    'A preview delivery no longer matches its durable outbox aggregate.',
  PreviewAcceptanceCorruptError:
    "A preview acceptance's stored receipt is corrupt.",
  ErrorWorkflowDeliveryMismatchError:
    'An error-workflow delivery no longer matches its stored intent.',
  FailureNotificationStateError:
    "A failure notification's stored intent, claim or checksum is corrupt or lost.",
  InboxReceiptUnavailableError:
    'An inbox receipt sits outside the workspace or is incomplete.',
  InboxChecksumMismatchError:
    "A redelivered inbox message's checksum differs from the one it was consumed with.",
  IdempotencyRecordCorruptError:
    'A stored command receipt no longer reads (refused as a conflict).',
  FolderSharingCorruptError: "A folder's stored sharing hierarchy is corrupt.",
  ConnectionSharingCorruptError:
    "A connection's stored sharing grants are corrupt.",
  StoredTableDefinitionError:
    "A data table's stored definition fails its schema.",
  ScheduleClaimLostError:
    "The schedule claim's lease lapsed or moved to another worker.",
  WorkflowTriggerReconciliationMismatchError:
    "A trigger reconciliation's durable outbox identity is inconsistent.",
});

/**
 * Functions outside the repositories that a repository may call although they
 * throw: each only refuses a stored value that no longer reads, so the error
 * is storage integrity, not a decision (validate-core-repository-throws.mjs).
 */
export const STORAGE_INTEGRITY_DECODERS = Object.freeze({
  decodeStoredValue:
    'The one decoder of stored JSON: a stored value that no longer parses.',
  executableNodeSchema:
    "A stored preview executable node that isn't a bounded JSON object.",
  requireReadableReceipt:
    'A stored command receipt no longer matches its shape (refused as a conflict).',
  decodeAcceptanceReceipt:
    "An invitation acceptance's stored receipt no longer reads.",
  resolveScheduleObservation:
    "A stored schedule recurrence the parser can't run, or a parser invariant broke.",
});

/** L5c temporary debt: more than twenty findings; migrate decisions in a separate batch.
 * Exact diagnostics keep new call paths and constructions enforced. */
export const TEMPORARY_TRANSITIVE_FINDINGS = Object.freeze([
  'packages/core/src/triggers/schedules/management/receipts.repository.ts:44: ScheduleTriggerError thrown in a repository. Return the row, boolean or nothing and throw in the operation, or list a storage integrity error in STORAGE_INTEGRITY_ERRORS with its reason.',
  'packages/core/src/triggers/webhooks/runtime/receipts.repository.ts:34: WebhookTriggerIdempotencyConflictError thrown in a repository. Return the row, boolean or nothing and throw in the operation, or list a storage integrity error in STORAGE_INTEGRITY_ERRORS with its reason.',
  'packages/core/src/attempts/completion/connection-health.repository.ts: imports serializeStoredExecutionJsonValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/attempts/completion/connection-health.repository.ts → serializeStoredExecutionJsonValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/attempts/completion/outcomes.repository.ts: imports serializeStoredExecutionJsonValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/attempts/completion/outcomes.repository.ts → serializeStoredExecutionJsonValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/attempts/outputs.repository.ts: imports parseStoredExecutionValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/attempts/outputs.repository.ts → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/attempts/outputs.repository.ts: imports storedExecutionValuesEqual from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/attempts/outputs.repository.ts → storedExecutionValuesEqual → storedValueJson → serializeJson → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/authoring/promotion/preparation/requirements.repository.ts: imports dataTableReferenceIssues from packages/core/src/data-tables/columns/table-references.ts, which throws a domain error (packages/core/src/authoring/promotion/preparation/requirements.repository.ts → dataTableReferenceIssues → issuesFor). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/identity/federation/management/authority.repository.ts: imports readWorkspaceAuthority from packages/core/src/shared/workspace-authority.ts, which throws a domain error (packages/core/src/identity/federation/management/authority.repository.ts → readWorkspaceAuthority → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/inbox/mail/authorize.repository.ts: imports lockWorkspaceAuthority from packages/core/src/shared/workspace-authority.ts, which throws a domain error (packages/core/src/inbox/mail/authorize.repository.ts → lockWorkspaceAuthority → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/inbox/mail/prepare.repository.ts: imports lockWorkspaceAuthority from packages/core/src/shared/workspace-authority.ts, which throws a domain error (packages/core/src/inbox/mail/prepare.repository.ts → lockWorkspaceAuthority → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/notifications/delivery/claim.repository.ts: imports serializeStoredExecutionJsonValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/notifications/delivery/claim.repository.ts → serializeStoredExecutionJsonValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/previews/attempts/preview-claim.repository.ts: imports parseStoredExecutionValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/previews/attempts/preview-claim.repository.ts → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/previews/runs/acceptance/accepted-preview.repository.ts: imports serializeStoredExecutionValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/previews/runs/acceptance/accepted-preview.repository.ts → serializeStoredExecutionValue → prepareStoredExecutionValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/previews/runs/preview-runs.repository.ts: imports parseStoredExecutionValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/previews/runs/preview-runs.repository.ts → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/previews/suites/evaluate.repository.ts: imports parseStoredExecutionValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/previews/suites/evaluate.repository.ts → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/advance/fail-unadvanceable.repository.ts: imports persistCoordinatorRunTransition from packages/core/src/runs/advance/persist/persist-run-transition.ts, which throws a domain error (packages/core/src/runs/advance/fail-unadvanceable.repository.ts → persistCoordinatorRunTransition → scheduledOccurrence → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/advance/load/completion.repository.ts: imports parseStoredExecutionValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/runs/advance/load/completion.repository.ts → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/advance/load/event-facts.repository.ts: imports parseStoredExecutionValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/runs/advance/load/event-facts.repository.ts → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/advance/load/event-facts.repository.ts: imports storedExecutionValuesEqual from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/runs/advance/load/event-facts.repository.ts → storedExecutionValuesEqual → storedValueJson → serializeJson → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/advance/load/event-facts.repository.ts: imports record from packages/core/src/runs/advance/load/fact-admission.ts, which throws a domain error (packages/core/src/runs/advance/load/event-facts.repository.ts → record → normalizedJson → serializeStoredExecutionJsonValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/advance/load/event-facts.repository.ts: imports eventPayloadRecord from packages/core/src/runs/advance/load/fact-admission.ts, which throws a domain error (packages/core/src/runs/advance/load/event-facts.repository.ts → eventPayloadRecord → canonicalEventPayload → serializeStoredExecutionJsonValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/advance/load/facts.repository.ts: imports canonicalEventPayload from packages/core/src/runs/advance/load/fact-admission.ts, which throws a domain error (packages/core/src/runs/advance/load/facts.repository.ts → canonicalEventPayload → serializeStoredExecutionJsonValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/advance/persist/admissions/create-executions.repository.ts: imports serializeStoredExecutionJsonValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/runs/advance/persist/admissions/create-executions.repository.ts → serializeStoredExecutionJsonValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/advance/persist/admissions/events.repository.ts: imports serializeStoredExecutionJsonValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/runs/advance/persist/admissions/events.repository.ts → serializeStoredExecutionJsonValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/advance/persist/failure-handling.repository.ts: imports serializeStoredExecutionJsonValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/runs/advance/persist/failure-handling.repository.ts → serializeStoredExecutionJsonValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/advance/persist/failure-notification.repository.ts: imports serializeStoredExecutionJsonValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/runs/advance/persist/failure-notification.repository.ts → serializeStoredExecutionJsonValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/advance/persist/run-transitions.repository.ts: imports serializeStoredExecutionJsonValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/runs/advance/persist/run-transitions.repository.ts → serializeStoredExecutionJsonValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/advance/receipts.repository.ts: imports serializeStoredExecutionJsonValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/runs/advance/receipts.repository.ts → serializeStoredExecutionJsonValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/pending-tasks/lifecycle/expire.repository.ts: imports serializeStoredExecutionValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/runs/pending-tasks/lifecycle/expire.repository.ts → serializeStoredExecutionValue → prepareStoredExecutionValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/pending-tasks/responses/pending-task-records.repository.ts: imports parseStoredExecutionValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/runs/pending-tasks/responses/pending-task-records.repository.ts → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/pending-tasks/responses/task-responses.repository.ts: imports serializeStoredExecutionValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/runs/pending-tasks/responses/task-responses.repository.ts → serializeStoredExecutionValue → prepareStoredExecutionValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/queries/execution/source.repository.ts: imports parseStoredExecutionValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/runs/queries/execution/source.repository.ts → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/queries/history/details.repository.ts: imports withResourceRunRead from packages/core/src/runs/access.ts, which throws a domain error (packages/core/src/runs/queries/history/details.repository.ts → withResourceRunRead → withResourceOwnerRead → withRetainedRunRead → withWorkspaceAccess → lockWorkspaceAuthorityInStatuses → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/queries/history/details.repository.ts: imports parseStoredExecutionValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/runs/queries/history/details.repository.ts → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/queries/history/list.repository.ts: imports withRetainedRunRead from packages/core/src/runs/access.ts, which throws a domain error (packages/core/src/runs/queries/history/list.repository.ts → withRetainedRunRead → withWorkspaceAccess → lockWorkspaceAuthorityInStatuses → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/queries/history/statistics.repository.ts: imports withRetainedRunRead from packages/core/src/runs/access.ts, which throws a domain error (packages/core/src/runs/queries/history/statistics.repository.ts → withRetainedRunRead → withWorkspaceAccess → lockWorkspaceAuthorityInStatuses → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/queries/history/steps.repository.ts: imports withResourceWorkflowRead from packages/core/src/runs/access.ts, which throws a domain error (packages/core/src/runs/queries/history/steps.repository.ts → withResourceWorkflowRead → withResourceOwnerRead → withRetainedRunRead → withWorkspaceAccess → lockWorkspaceAuthorityInStatuses → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/recovery/reused-nodes.repository.ts: imports prepareStoredExecutionValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/runs/recovery/reused-nodes.repository.ts → prepareStoredExecutionValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/shared/resources/connection-scope.repository.ts: imports readWorkspaceAuthority from packages/core/src/shared/workspace-authority.ts, which throws a domain error (packages/core/src/shared/resources/connection-scope.repository.ts → readWorkspaceAuthority → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/shared/resources/workflow-authority.repository.ts: imports lockBrowsableWorkspaceAuthority from packages/core/src/shared/workspace-authority.ts, which throws a domain error (packages/core/src/shared/resources/workflow-authority.repository.ts → lockBrowsableWorkspaceAuthority → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/shared/resources/workflow-authority.repository.ts: imports lockWorkspaceAuthority from packages/core/src/shared/workspace-authority.ts, which throws a domain error (packages/core/src/shared/resources/workflow-authority.repository.ts → lockWorkspaceAuthority → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/shared/resources/workflow-authority.repository.ts: imports readWorkspaceAuthority from packages/core/src/shared/workspace-authority.ts, which throws a domain error (packages/core/src/shared/resources/workflow-authority.repository.ts → readWorkspaceAuthority → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/shared/run-records/run-events.repository.ts: imports serializeStoredExecutionJsonValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/shared/run-records/run-events.repository.ts → serializeStoredExecutionJsonValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/tenant-access/invitations/delivery/identity.repository.ts: imports serializeStoredExecutionJsonValue from packages/core/src/shared/stored-execution.ts, which throws a domain error (packages/core/src/tenant-access/invitations/delivery/identity.repository.ts → serializeStoredExecutionJsonValue → parseStoredExecutionValue → invalid). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/variables/usage.repository.ts: imports walkVariableUsage from packages/core/src/variables/walk-usage.ts, which throws a domain error (packages/core/src/variables/usage.repository.ts → walkVariableUsage → scanVariableUsage). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
]);
