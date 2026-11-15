import { NODE_FAILURE_FIELD_LIMITS } from '@pertexo/node-sdk';
import { TIME_ZONE_NAME_CHARACTERS } from '@pertexo/workflow-model';
import type { RecordedScheduleOccurrence } from '../stored-shapes.js';
import type { ScheduleTriggerRecord } from '../stored-shapes.js';
import { workflowTriggers } from '../authoring/workflows.js';
import { workflowRuns } from '../runs/workflow-runs.js';
import {
  type PgTableExtraConfigValue,
  check,
  foreignKey,
  index,
  integer,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';

const WIDTHS = Object.freeze({
  recurrenceKind: 16,
  // One wider than CRON_EXPRESSION_LIMITS' 255, which a Schedule step is held to:
  // narrowing needs a migration and gains nothing.
  cronExpression: 256,
  timezone: TIME_ZONE_NAME_CHARACTERS,
  misfirePolicy: 32,
  configFingerprint: 79,
  status: 16,
  healthStatus: 32,
  lastErrorCode: NODE_FAILURE_FIELD_LIMITS.safeErrorCodeCharacters,
  leaseOwner: 128,
  disposition: 16,
  skipReason: 32,
});

export const triggerSchedules = appSchema.table(
  'trigger_schedules',
  {
    triggerId: uuid('trigger_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    recurrenceKind: varchar('recurrence_kind', {
      length: WIDTHS.recurrenceKind,
    })
      .$type<'cron' | 'interval'>()
      .notNull(),
    cronExpression: varchar('cron_expression', {
      length: WIDTHS.cronExpression,
    }),
    timezone: varchar('timezone', { length: WIDTHS.timezone }),
    intervalMinutes: integer('interval_minutes'),
    misfirePolicy: varchar('misfire_policy', { length: WIDTHS.misfirePolicy })
      .$type<ScheduleTriggerRecord['misfirePolicy']>()
      .notNull(),
    configFingerprint: varchar('config_fingerprint', {
      length: WIDTHS.configFingerprint,
    }).notNull(),
    anchorAt: timestamp('anchor_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    nextFireAt: timestamp('next_fire_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    lastFireAt: timestamp('last_fire_at', { withTimezone: true, mode: 'date' }),
    status: varchar('status', { length: WIDTHS.status })
      .$type<'enabled' | 'disabled'>()
      .notNull()
      .default(sql`'enabled'::character varying`),
    retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'date' }),
    healthStatus: varchar('health_status', { length: WIDTHS.healthStatus })
      .$type<ScheduleTriggerRecord['healthStatus']>()
      .notNull()
      .default(sql`'healthy'::character varying`),
    lastErrorCode: varchar('last_error_code', { length: WIDTHS.lastErrorCode }),
    leaseOwner: varchar('lease_owner', { length: WIDTHS.leaseOwner }),
    leaseToken: uuid('lease_token'),
    leaseAcquiredAt: timestamp('lease_acquired_at', {
      withTimezone: true,
      mode: 'date',
    }),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    admissionDeferredUntil: timestamp('admission_deferred_until', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'trigger_schedules_cursor_valid',
      sql`((last_fire_at IS NULL) OR (last_fire_at < next_fire_at))`,
    ),
    check(
      'trigger_schedules_fingerprint_valid',
      sql`((config_fingerprint)::text ~ '^trigger:sha256:[0-9a-f]{64}$'::text)`,
    ),
    check(
      'trigger_schedules_health_valid',
      sql`((health_status)::text = ANY (ARRAY[('healthy'::character varying)::text, ('degraded'::character varying)::text, ('unhealthy'::character varying)::text, ('disabled'::character varying)::text]))`,
    ),
    check(
      'trigger_schedules_lease_valid',
      sql`((((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_acquired_at IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_acquired_at IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (lease_expires_at > lease_acquired_at) AND (lease_expires_at <= (lease_acquired_at + '00:05:00'::interval)))) IS TRUE)`,
    ),
    check(
      'trigger_schedules_misfire_valid',
      sql`((misfire_policy)::text = ANY (ARRAY[('catch_up_once'::character varying)::text, ('skip'::character varying)::text]))`,
    ),
    check(
      'trigger_schedules_recurrence_valid',
      sql`(((((recurrence_kind)::text = 'cron'::text) AND (cron_expression IS NOT NULL) AND (timezone IS NOT NULL) AND (interval_minutes IS NULL)) OR (((recurrence_kind)::text = 'interval'::text) AND (cron_expression IS NULL) AND (timezone IS NULL) AND (interval_minutes IS NOT NULL) AND ((interval_minutes >= 1) AND (interval_minutes <= 43200)))) IS TRUE)`,
    ),
    check(
      'trigger_schedules_status_valid',
      sql`((status)::text = ANY (ARRAY[('enabled'::character varying)::text, ('disabled'::character varying)::text]))`,
    ),
    unique('trigger_schedules_workspace_identity_unique').on(
      table.workspaceId,
      table.triggerId,
    ),
    foreignKey({
      name: 'trigger_schedules_trigger_fk',
      columns: [table.workspaceId, table.triggerId],
      foreignColumns: [workflowTriggers.workspaceId, workflowTriggers.id],
    }).onDelete('restrict'),
    index('trigger_schedules_due_idx')
      .on(table.nextFireAt, table.workspaceId, table.triggerId)
      .where(sql`((status)::text = 'enabled'::text)`),
  ],
);

export const triggerScheduleOccurrences = appSchema.table(
  'trigger_schedule_occurrences',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    triggerId: uuid('trigger_id').notNull(),
    scheduledAt: timestamp('scheduled_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    disposition: varchar('disposition', { length: WIDTHS.disposition })
      .$type<RecordedScheduleOccurrence>()
      .notNull(),
    skipReason: varchar('skip_reason', {
      length: WIDTHS.skipReason,
    }).$type<'concurrency_limit'>(),
    workflowRunId: uuid('workflow_run_id'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'schedule_occurrence_skip_valid',
      sql`skip_reason IS NULL OR (skip_reason='concurrency_limit' AND disposition='skipped' AND workflow_run_id IS NULL)`,
    ),
    check(
      'trigger_schedule_occurrences_disposition_valid',
      sql`((((disposition)::text = 'accepted'::text) AND (workflow_run_id IS NOT NULL)) OR (((disposition)::text = ANY (ARRAY[('skipped'::character varying)::text, ('paused'::character varying)::text])) AND (workflow_run_id IS NULL)))`,
    ),
    unique('trigger_schedule_occurrences_identity_unique').on(
      table.triggerId,
      table.scheduledAt,
    ),
    unique('trigger_schedule_occurrences_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'trigger_schedule_occurrences_run_fk',
      columns: [table.workspaceId, table.workflowRunId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'trigger_schedule_occurrences_schedule_fk',
      columns: [table.workspaceId, table.triggerId],
      foreignColumns: [
        triggerSchedules.workspaceId,
        triggerSchedules.triggerId,
      ],
    }).onDelete('restrict'),
    index('schedule_occurrences_retention_dry_run_idx').on(
      table.workspaceId,
      table.scheduledAt,
      table.id,
    ),
    index('schedule_occurrences_run_retention_idx')
      .on(table.workspaceId, table.workflowRunId)
      .where(sql`(workflow_run_id IS NOT NULL)`),
    index('trigger_schedule_occurrences_trigger_time_idx').on(
      table.workspaceId,
      table.triggerId,
      table.scheduledAt.desc().nullsFirst(),
      table.id,
    ),
  ],
);
