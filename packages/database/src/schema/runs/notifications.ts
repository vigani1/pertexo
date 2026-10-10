import {
  type PgTableExtraConfigValue,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';
import { failureNotificationDestinationVersions } from '../notifications.js';
import { workflowRuns } from './execution.js';

export const runFailureNotificationIntents = appSchema.table(
  'run_failure_notification_intents',
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowRunId: uuid('workflow_run_id').notNull(),
    terminalEventSequence: integer('terminal_event_sequence').notNull(),
    destinationId: uuid('destination_id').notNull(),
    destinationConfigVersion: integer('destination_config_version').notNull(),
    sideEffectClass: varchar('side_effect_class', { length: 32 }).notNull(),
    context: jsonb().notNull(),
    contextChecksum: char('context_checksum', { length: 64 }).notNull(),
    status: varchar({ length: 32 }).default('pending').notNull(),
    deliveryAttempts: integer('delivery_attempts').default(0).notNull(),
    dispatchMarkedAt: timestamp('dispatch_marked_at', {
      withTimezone: true,
      mode: 'string',
    }),
    recoveryAt: timestamp('recovery_at', {
      withTimezone: true,
      mode: 'string',
    }),
    nextDeliveryAt: timestamp('next_delivery_at', {
      withTimezone: true,
      mode: 'string',
    }),
    safeErrorCode: varchar('safe_error_code', { length: 128 }),
    possiblyDispatched: boolean('possibly_dispatched'),
    providerReference: varchar('provider_reference', { length: 256 }),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    connectionSecretVersionId: uuid('connection_secret_version_id'),
    deliveryBinding: varchar('delivery_binding', { length: 128 }),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'run_failure_notification_intents_attempts_bounded',
      sql`((delivery_attempts >= 0) AND (delivery_attempts <= 10))`,
    ),
    check(
      'run_failure_notification_intents_checksum_format',
      sql`(context_checksum ~ '^[0-9a-f]{64}$'::text)`,
    ),
    check(
      'run_failure_notification_intents_context_bounded',
      sql`(octet_length((context)::text) <= 4096)`,
    ),
    check(
      'run_failure_notification_intents_context_object',
      sql`(jsonb_typeof(context) = 'object'::text)`,
    ),
    check(
      'run_failure_notification_intents_delivery_binding_format',
      sql`((delivery_binding IS NULL) OR ((delivery_binding)::text ~ '^email:sha256:[0-9a-f]{64}$'::text))`,
    ),
    check(
      'run_failure_notification_intents_destination_version_positive',
      sql`(destination_config_version > 0)`,
    ),
    check(
      'run_failure_notification_intents_lifecycle_valid',
      sql`((((status)::text = 'pending'::text) AND (delivery_attempts = 0) AND (dispatch_marked_at IS NULL) AND (recovery_at IS NULL) AND (next_delivery_at IS NULL) AND (completed_at IS NULL)) OR (((status)::text = 'claimed'::text) AND (delivery_attempts > 0) AND (dispatch_marked_at IS NULL) AND (recovery_at IS NOT NULL) AND (next_delivery_at IS NULL) AND (completed_at IS NULL)) OR (((status)::text = 'dispatching'::text) AND (delivery_attempts > 0) AND (dispatch_marked_at IS NOT NULL) AND (recovery_at IS NOT NULL) AND (next_delivery_at IS NULL) AND (completed_at IS NULL)) OR (((status)::text = 'retry'::text) AND (delivery_attempts > 0) AND (dispatch_marked_at IS NULL) AND (recovery_at IS NULL) AND (next_delivery_at IS NOT NULL) AND (completed_at IS NULL)) OR (((status)::text = ANY (ARRAY[('delivered'::character varying)::text, ('dead_letter'::character varying)::text, ('outcome_unknown'::character varying)::text])) AND (dispatch_marked_at IS NULL) AND (recovery_at IS NULL) AND (next_delivery_at IS NULL) AND (completed_at IS NOT NULL)))`,
    ),
    check(
      'run_failure_notification_intents_safe_error_code_format',
      sql`((safe_error_code IS NULL) OR ((safe_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))`,
    ),
    check(
      'run_failure_notification_intents_sequence_positive',
      sql`(terminal_event_sequence > 0)`,
    ),
    check(
      'run_failure_notification_intents_side_effect_class_valid',
      sql`((side_effect_class)::text = ANY (ARRAY[('safe'::character varying)::text, ('idempotent_with_key'::character varying)::text, ('unsafe'::character varying)::text]))`,
    ),
    check(
      'run_failure_notification_intents_status_valid',
      sql`((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('claimed'::character varying)::text, ('dispatching'::character varying)::text, ('retry'::character varying)::text, ('delivered'::character varying)::text, ('dead_letter'::character varying)::text, ('outcome_unknown'::character varying)::text]))`,
    ),
    unique('run_failure_notification_intents_logical_unique').on(
      table.workflowRunId,
      table.terminalEventSequence,
    ),
    unique('run_failure_notification_intents_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'run_failure_notification_intents_destination_version_fk',
      columns: [
        table.workspaceId,
        table.destinationId,
        table.destinationConfigVersion,
      ],
      foreignColumns: [
        failureNotificationDestinationVersions.workspaceId,
        failureNotificationDestinationVersions.destinationId,
        failureNotificationDestinationVersions.version,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'run_failure_notification_intents_run_pin_fk',
      columns: [
        table.workspaceId,
        table.workflowRunId,
        table.destinationId,
        table.destinationConfigVersion,
        table.sideEffectClass,
        table.connectionSecretVersionId,
      ],
      foreignColumns: [
        workflowRuns.workspaceId,
        workflowRuns.id,
        workflowRuns.failureNotificationDestinationId,
        workflowRuns.failureNotificationDestinationConfigVersion,
        workflowRuns.failureNotificationSideEffectClass,
        workflowRuns.failureNotificationConnectionSecretVersionId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'run_failure_notification_intents_run_workspace_fk',
      columns: [table.workspaceId, table.workflowRunId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('cascade'),
    index('run_failure_notification_intents_recovery_idx')
      .on(table.recoveryAt, table.id)
      .where(
        sql`((status)::text = ANY (ARRAY[('claimed'::character varying)::text, ('dispatching'::character varying)::text]))`,
      ),
    index('run_failure_notification_intents_retry_idx')
      .on(table.nextDeliveryAt, table.id)
      .where(sql`((status)::text = 'retry'::text)`),
    index('run_failure_notification_intents_workspace_run_idx').on(
      table.workspaceId,
      table.workflowRunId,
      table.id,
    ),
  ],
);

export const runFailureNotificationAuditFacts = appSchema.table(
  'run_failure_notification_audit_facts',
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    notificationIntentId: uuid('notification_intent_id').notNull(),
    factType: varchar('fact_type', { length: 64 }).notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    safeErrorCode: varchar('safe_error_code', { length: 128 }),
    possiblyDispatched: boolean('possibly_dispatched').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'run_failure_notification_audit_attempt_nonnegative',
      sql`(attempt_number >= 0)`,
    ),
    check(
      'run_failure_notification_audit_fact_type_valid',
      sql`((fact_type)::text = ANY (ARRAY[('intent_created'::character varying)::text, ('dispatch_marked'::character varying)::text, ('delivered'::character varying)::text, ('retry_scheduled'::character varying)::text, ('dead_lettered'::character varying)::text, ('outcome_unknown'::character varying)::text]))`,
    ),
    check(
      'run_failure_notification_audit_safe_error_code_format',
      sql`((safe_error_code IS NULL) OR ((safe_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))`,
    ),
    foreignKey({
      name: 'run_failure_notification_audit_intent_workspace_fk',
      columns: [table.workspaceId, table.notificationIntentId],
      foreignColumns: [
        runFailureNotificationIntents.workspaceId,
        runFailureNotificationIntents.id,
      ],
    }).onDelete('cascade'),
    index('run_failure_notification_audit_workspace_intent_idx').on(
      table.workspaceId,
      table.notificationIntentId,
      table.occurredAt,
      table.id,
    ),
  ],
);
