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
 * Core repositories that still throw domain errors, with how many; the list
 * only shrinks (validate-core-repository-throws.mjs). Each moves its
 * decisions and throws into the operation that calls it.
 */
export const REPOSITORY_THROW_BACKLOG = Object.freeze({
  'packages/core/src/authoring/input-cases/commands/mutations.repository.ts': 1,
  'packages/core/src/authoring/input-cases/read.repository.ts': 1,
  'packages/core/src/authoring/organization/folders/commands/mutations.repository.ts': 4,
  'packages/core/src/authoring/organization/folders/hierarchy.repository.ts': 4,
  'packages/core/src/authoring/organization/sharing/audience.repository.ts': 5,
  'packages/core/src/authoring/organization/sharing/grants.repository.ts': 3,
  'packages/core/src/authoring/organization/tags/commands/mutations.repository.ts': 2,
  'packages/core/src/authoring/organization/tags/list.repository.ts': 1,
  'packages/core/src/authoring/organization/tags/tag-state.repository.ts': 3,
  'packages/core/src/authoring/portability/source-authority.repository.ts': 5,
  'packages/core/src/authoring/portability/template-origin.repository.ts': 2,
  'packages/core/src/authoring/promotion/authority.repository.ts': 5,
  'packages/core/src/authoring/promotion/preparation/connections.repository.ts': 1,
  'packages/core/src/authoring/promotion/preparation/source.repository.ts': 3,
  'packages/core/src/authoring/promotion/preparation/target.repository.ts': 1,
  'packages/core/src/authoring/promotion/preparation/target/inspect-workflow.repository.ts': 2,
  'packages/core/src/authoring/promotion/receipt.repository.ts': 2,
  'packages/core/src/authoring/promotion/settings.repository.ts': 4,
  'packages/core/src/authoring/publication/calls.repository.ts': 4,
  'packages/core/src/authoring/publication/pending-tasks.repository.ts': 1,
  'packages/core/src/authoring/reviews/read.repository.ts': 3,
  'packages/core/src/authoring/settings/auto-pause/auto-pause-state.repository.ts': 2,
  'packages/core/src/authoring/step-samples/source.repository.ts': 4,
  'packages/core/src/authoring/step-samples/step-sample-commands.repository.ts': 5,
  'packages/core/src/authoring/step-samples/step-sample-state.repository.ts': 4,
  'packages/core/src/authoring/step-samples/webhook-test-events/authority.repository.ts': 2,
  'packages/core/src/authoring/step-samples/webhook-test-events/ingress.repository.ts': 3,
  'packages/core/src/authoring/workflows/commands/locks.repository.ts': 1,
  'packages/core/src/authoring/workflows/reads/versions.repository.ts': 2,
  'packages/core/src/identity/federation/management/domains.repository.ts': 6,
  'packages/core/src/identity/federation/management/enforcement.repository.ts': 4,
  'packages/core/src/identity/federation/management/organizations.repository.ts': 4,
  'packages/core/src/identity/federation/management/providers.repository.ts': 2,
  'packages/core/src/identity/federation/management/reads.repository.ts': 2,
  'packages/core/src/identity/federation/provisioning/authority.repository.ts': 4,
  'packages/core/src/identity/federation/provisioning/management/adoption.repository.ts': 2,
  'packages/core/src/identity/federation/provisioning/management/commands.repository.ts': 6,
  'packages/core/src/identity/federation/provisioning/management/credentials.repository.ts': 4,
  'packages/core/src/identity/federation/provisioning/management/mappings.repository.ts': 10,
  'packages/core/src/identity/federation/provisioning/management/unlink.repository.ts': 4,
  'packages/core/src/identity/federation/provisioning/resources/groups.repository.ts': 3,
  'packages/core/src/identity/federation/provisioning/resources/users.repository.ts': 2,
  'packages/core/src/identity/federation/provisioning/sign-in.repository.ts': 3,
});
