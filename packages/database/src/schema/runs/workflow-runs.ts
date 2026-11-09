import type {
  StoredExecutionValue,
  AcceptanceInput,
} from '../stored-shapes.js';
import type { RunStatus } from '@pertexo/workflow-engine';
import type { WorkflowRecoveryEffectRisk } from '@pertexo/workflow-model';
import { workspaceVariableSetRevisions } from '../variables.js';
import { workspaceExecutionEntitlementVersions } from './capacity/entitlements.js';
import { failureNotificationDestinationVersions } from '../notifications.js';
import { users } from '../identity/users.js';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  json,
  timestamp,
  type PgTableExtraConfigValue,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';

export const workflowRuns = appSchema.table(
  'workflow_runs',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    workflowVersionId: uuid('workflow_version_id').notNull(),
    replaySourceRunId: uuid('replay_source_run_id'),
    replayCommandId: uuid('replay_command_id'),
    handledFailureCount: integer('handled_failure_count').notNull().default(0),
    recoveryTargetNodeRunId: uuid('recovery_target_node_run_id'),
    recoveryTargetNodeId: varchar('recovery_target_node_id', { length: 128 }),
    recoveryReusedCount: integer('recovery_reused_count'),
    recoveryEffectRisk: varchar('recovery_effect_risk', {
      length: 32,
    }).$type<WorkflowRecoveryEffectRisk>(),
    recoveryEffectsAcknowledged: boolean('recovery_effects_acknowledged'),
    errorWorkflowOrigin: boolean('error_workflow_origin')
      .notNull()
      .default(false),
    startedBy: uuid('started_by'),
    absoluteDeadlineAt: timestamp('absolute_deadline_at', {
      withTimezone: true,
      mode: 'date',
    }),
    humanWaitStartedAt: timestamp('human_wait_started_at', {
      withTimezone: true,
      mode: 'date',
    }),
    remainingExecutionMs: integer('remaining_execution_ms'),
    // Waiting only on timers, so it holds no workspace slot. Unlike a human wait the
    // clock keeps running and it keeps its place in the workflow's own limit.
    timedWaitStartedAt: timestamp('timed_wait_started_at', {
      withTimezone: true,
      mode: 'date',
    }),
    triggerType: varchar('trigger_type', { length: 32 })
      .$type<AcceptanceInput['triggerType']>()
      .notNull(),
    failureNotificationDestinationId: uuid(
      'failure_notification_destination_id',
    ),
    failureNotificationDestinationConfigVersion: integer(
      'failure_notification_destination_config_version',
    ),
    failureNotificationSideEffectClass: varchar(
      'failure_notification_side_effect_class',
      { length: 32 },
    ),
    failureNotificationConnectionSecretVersionId: uuid(
      'failure_notification_connection_secret_version_id',
    ),
    executionEntitlementVersion: integer('execution_entitlement_version'),
    // Assigned by the admission trigger under the workspace counter, never by
    // an application/default sequence call before that serialization lock.
    admissionTicket: bigint('admission_ticket', { mode: 'bigint' })
      .notNull()
      .$defaultFn(() => sql`null`),
    status: varchar('status', { length: 32 }).$type<RunStatus>().notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true, mode: 'date' }),
    deadlineWakeupAt: timestamp('deadline_wakeup_at', {
      withTimezone: true,
      mode: 'date',
    }),
    cancelRequestedAt: timestamp('cancel_requested_at', {
      withTimezone: true,
      mode: 'date',
    }),
    cancelRequestedBy: varchar('cancel_requested_by', { length: 128 }),
    cancelReason: varchar('cancel_reason', { length: 512 }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    variableSetRevision: integer('variable_set_revision'),
    inputRef: json('input_ref').$type<StoredExecutionValue>(),
    inputRefExpiresAt: timestamp('input_ref_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    detailsPurgedAt: timestamp('details_purged_at', {
      withTimezone: true,
      mode: 'date',
    }),
    outputRef: json('output_ref').$type<StoredExecutionValue>(),
    errorSummary: varchar('error_summary', { length: 2048 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  // eslint-disable-next-line max-lines-per-function -- Keep this table's ordered constraints in one declaration.
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'workflow_runs_variable_set_fk',
      columns: [table.workspaceId, table.variableSetRevision],
      foreignColumns: [
        workspaceVariableSetRevisions.workspaceId,
        workspaceVariableSetRevisions.revision,
      ],
    }),
    index('workflow_runs_variable_set_idx')
      .on(table.workspaceId, table.variableSetRevision)
      .where(sql`variable_set_revision IS NOT NULL`),
    foreignKey({
      name: 'workflow_runs_starter_fk',
      columns: [table.startedBy],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    check(
      'workflow_runs_human_wait_valid',
      sql`((human_wait_started_at IS NULL AND remaining_execution_ms IS NULL)
      OR (human_wait_started_at IS NOT NULL AND (remaining_execution_ms IS NULL OR (remaining_execution_ms > 0 AND remaining_execution_ms <= 3600000)) AND status IN ('waiting','succeeded','failed','canceled','timed_out','outcome_unknown') AND deadline_at IS NOT DISTINCT FROM absolute_deadline_at)) IS TRUE`,
    ),
    check(
      'workflow_runs_handled_failure_count_valid',
      sql`handled_failure_count >= 0 AND handled_failure_count <= 200`,
    ),
    check(
      'workflow_runs_admission_ticket_positive',
      sql`(admission_ticket > 0)`,
    ),
    check(
      'workflow_runs_cancel_actor_format',
      sql`((cancel_requested_by IS NULL) OR ((cancel_requested_by)::text ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'::text))`,
    ),
    check(
      'workflow_runs_cancel_metadata_complete',
      sql`(((cancel_requested_at IS NULL) AND (cancel_requested_by IS NULL) AND (cancel_reason IS NULL)) OR ((cancel_requested_at IS NOT NULL) AND (cancel_requested_by IS NOT NULL)))`,
    ),
    check(
      'workflow_runs_deadline_valid',
      sql`((deadline_at IS NULL) OR (deadline_at > created_at))`,
    ),
    check(
      'workflow_runs_deadline_wakeup_consistent',
      sql`(((deadline_wakeup_at IS NULL) OR ((deadline_at IS NOT NULL) AND (deadline_wakeup_at = deadline_at))) IS TRUE)`,
    ),
    check(
      'workflow_runs_failure_notification_policy_complete',
      sql`((((failure_notification_destination_id IS NULL) AND (failure_notification_destination_config_version IS NULL) AND (failure_notification_side_effect_class IS NULL) AND (failure_notification_connection_secret_version_id IS NULL)) OR ((failure_notification_destination_id IS NOT NULL) AND (failure_notification_destination_config_version IS NOT NULL) AND (failure_notification_destination_config_version > 0) AND (failure_notification_side_effect_class IS NOT NULL) AND ((failure_notification_side_effect_class)::text = ANY ((ARRAY['safe'::character varying, 'idempotent_with_key'::character varying, 'unsafe'::character varying])::text[])))) IS TRUE)`,
    ),
    check(
      'workflow_runs_variable_set_retention',
      sql`details_purged_at IS NULL OR variable_set_revision IS NULL`,
    ),
    check(
      'workflow_runs_input_ref_expiry_valid',
      sql`(((input_ref IS NULL) AND (input_ref_expires_at IS NULL)) OR ((input_ref IS NOT NULL) AND (input_ref_expires_at IS NOT NULL) AND (input_ref_expires_at > created_at) AND (input_ref_expires_at <= (created_at + '30 days'::interval))))`,
    ),
    check(
      'workflow_runs_replay_lineage_valid',
      sql`(((trigger_type)::text = 'replay'::text) = ((replay_source_run_id IS NOT NULL) AND (replay_command_id IS NOT NULL)))`,
    ),
    check(
      'workflow_runs_recovery_summary_complete',
      sql`(((recovery_target_node_run_id IS NULL) AND (recovery_target_node_id IS NULL) AND (recovery_reused_count IS NULL) AND (recovery_effect_risk IS NULL) AND (recovery_effects_acknowledged IS NULL)) OR ((trigger_type = 'replay') AND (recovery_target_node_run_id IS NOT NULL) AND (recovery_target_node_id IS NOT NULL) AND (recovery_reused_count IS NOT NULL) AND (recovery_reused_count >= 0) AND (recovery_reused_count <= 200) AND (recovery_effect_risk IN ('ordinary', 'possible_effects', 'unknown_outcome')) AND (recovery_effects_acknowledged IS NOT NULL))) IS TRUE`,
    ),
    check(
      'workflow_runs_status_valid',
      sql`((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('waiting'::character varying)::text, ('succeeded'::character varying)::text, ('failed'::character varying)::text, ('canceled'::character varying)::text, ('timed_out'::character varying)::text, ('outcome_unknown'::character varying)::text]))`,
    ),
    check(
      'workflow_runs_trigger_type_valid',
      sql`((trigger_type)::text = ANY (ARRAY[('test'::character varying)::text,('form'::character varying)::text, ('workflow_error'::character varying)::text, ('api'::character varying)::text, ('manual'::character varying)::text, ('replay'::character varying)::text, ('schedule'::character varying)::text, ('webhook'::character varying)::text, ('workflow_call'::character varying)::text]))`,
    ),
    unique('workflow_runs_failure_notification_pin_unique').on(
      table.workspaceId,
      table.id,
      table.failureNotificationDestinationId,
      table.failureNotificationDestinationConfigVersion,
      table.failureNotificationSideEffectClass,
      table.failureNotificationConnectionSecretVersionId,
    ),
    unique('workflow_runs_replay_command_unique').on(table.replayCommandId),
    unique('workflow_runs_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    unique('workflow_runs_workspace_version_identity_unique').on(
      table.workspaceId,
      table.id,
      table.workflowVersionId,
    ),
    foreignKey({
      name: 'workflow_runs_execution_entitlement_fk',
      columns: [table.workspaceId, table.executionEntitlementVersion],
      foreignColumns: [
        workspaceExecutionEntitlementVersions.workspaceId,
        workspaceExecutionEntitlementVersions.version,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workflow_runs_failure_notification_destination_version_fk',
      columns: [
        table.workspaceId,
        table.failureNotificationDestinationId,
        table.failureNotificationDestinationConfigVersion,
      ],
      foreignColumns: [
        failureNotificationDestinationVersions.workspaceId,
        failureNotificationDestinationVersions.destinationId,
        failureNotificationDestinationVersions.version,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workflow_runs_replay_source_fk',
      columns: [table.workspaceId, table.replaySourceRunId],
      foreignColumns: [table.workspaceId, table.id],
    }),
    index('workflow_runs_test_source_idx')
      .on(table.workspaceId, table.workflowVersionId)
      .where(sql`trigger_type='test'`),
    uniqueIndex('workflow_runs_one_active_test')
      .on(table.workspaceId, table.workflowId, table.startedBy)
      .where(
        sql`trigger_type='test' AND status IN ('queued','running','waiting')`,
      ),
    index('workflow_runs_detail_retention_idx')
      .on(table.workspaceId, table.completedAt, table.id)
      .where(sql`((completed_at IS NOT NULL) AND (details_purged_at IS NULL))`),
    index('workflow_runs_due_deadline_idx')
      .on(table.deadlineAt, table.id)
      .where(
        sql`((deadline_at IS NOT NULL) AND ((status)::text = ANY (ARRAY[('queued'::character varying)::text, ('running'::character varying)::text, ('waiting'::character varying)::text])) AND (deadline_wakeup_at IS NULL))`,
      ),
    index('workflow_runs_due_input_ref_retention_idx')
      .on(table.workspaceId, table.inputRefExpiresAt, table.id)
      .where(sql`(input_ref IS NOT NULL)`),
    index('workflow_runs_queued_admission_order_idx')
      .on(table.workspaceId, table.workflowId, table.admissionTicket, table.id)
      .where(sql`((status)::text = 'queued'::text)`),
    index('workflow_runs_replay_source_idx')
      .on(table.workspaceId, table.replaySourceRunId, table.id)
      .where(sql`(replay_source_run_id IS NOT NULL)`),
    index('workflow_runs_summary_retention_idx')
      .on(table.workspaceId, table.completedAt, table.id)
      .where(sql`(completed_at IS NOT NULL)`),
    index('workflow_runs_workflow_active_idx')
      .on(table.workspaceId, table.workflowId, table.id)
      .where(
        sql`((status)::text = ANY (ARRAY[('running'::character varying)::text, ('waiting'::character varying)::text]))`,
      ),
    index('workflow_runs_workflow_version_idx').on(
      table.workspaceId,
      table.workflowVersionId,
      table.id,
    ),
    index('workflow_runs_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
    // The baseline adds INCLUDE coverage; drizzle-orm cannot declare it.
    index('workflow_runs_workspace_created_statistics_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    index('workflow_runs_workspace_status_created_idx').on(
      table.workspaceId,
      table.status,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index('workflow_runs_workspace_workflow_created_idx').on(
      table.workspaceId,
      table.workflowId,
      table.createdAt,
      table.id,
    ),
  ],
);
