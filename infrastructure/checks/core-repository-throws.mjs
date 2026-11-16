/**
 * Errors a core repository may throw: storage integrity assertions (core's
 * AGENTS.md, Exceptions). Each says the row the flow holds is corrupt, was
 * lost, or changed under its lock or fence; none is a product decision.
 */
export const STORAGE_INTEGRITY_ERRORS = Object.freeze({
  StoredExecutionValueInvalidError:
    'The stored execution-value descriptor or JSON payload cannot be represented in the bounded persisted format; operations validate external input before persistence.',
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
  'packages/core/src/identity/federation/management/authority.repository.ts: imports readWorkspaceAuthority from packages/core/src/shared/workspace-authority.ts, which throws a domain error (packages/core/src/identity/federation/management/authority.repository.ts → readWorkspaceAuthority → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/inbox/mail/authorize.repository.ts: imports lockWorkspaceAuthority from packages/core/src/shared/workspace-authority.ts, which throws a domain error (packages/core/src/inbox/mail/authorize.repository.ts → lockWorkspaceAuthority → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/inbox/mail/prepare.repository.ts: imports lockWorkspaceAuthority from packages/core/src/shared/workspace-authority.ts, which throws a domain error (packages/core/src/inbox/mail/prepare.repository.ts → lockWorkspaceAuthority → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/queries/history/details.repository.ts: imports withResourceRunRead from packages/core/src/runs/access.ts, which throws a domain error (packages/core/src/runs/queries/history/details.repository.ts → withResourceRunRead → withResourceOwnerRead → withRetainedRunRead → withWorkspaceAccess → lockWorkspaceAuthorityInStatuses → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/queries/history/list.repository.ts: imports withRetainedRunRead from packages/core/src/runs/access.ts, which throws a domain error (packages/core/src/runs/queries/history/list.repository.ts → withRetainedRunRead → withWorkspaceAccess → lockWorkspaceAuthorityInStatuses → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/queries/history/statistics.repository.ts: imports withRetainedRunRead from packages/core/src/runs/access.ts, which throws a domain error (packages/core/src/runs/queries/history/statistics.repository.ts → withRetainedRunRead → withWorkspaceAccess → lockWorkspaceAuthorityInStatuses → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/runs/queries/history/steps.repository.ts: imports withResourceWorkflowRead from packages/core/src/runs/access.ts, which throws a domain error (packages/core/src/runs/queries/history/steps.repository.ts → withResourceWorkflowRead → withResourceOwnerRead → withRetainedRunRead → withWorkspaceAccess → lockWorkspaceAuthorityInStatuses → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/shared/resources/connection-scope.repository.ts: imports readWorkspaceAuthority from packages/core/src/shared/workspace-authority.ts, which throws a domain error (packages/core/src/shared/resources/connection-scope.repository.ts → readWorkspaceAuthority → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/shared/resources/workflow-authority.repository.ts: imports lockBrowsableWorkspaceAuthority from packages/core/src/shared/workspace-authority.ts, which throws a domain error (packages/core/src/shared/resources/workflow-authority.repository.ts → lockBrowsableWorkspaceAuthority → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/shared/resources/workflow-authority.repository.ts: imports lockWorkspaceAuthority from packages/core/src/shared/workspace-authority.ts, which throws a domain error (packages/core/src/shared/resources/workflow-authority.repository.ts → lockWorkspaceAuthority → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
  'packages/core/src/shared/resources/workflow-authority.repository.ts: imports readWorkspaceAuthority from packages/core/src/shared/workspace-authority.ts, which throws a domain error (packages/core/src/shared/resources/workflow-authority.repository.ts → readWorkspaceAuthority → requireAuthority). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.',
]);
