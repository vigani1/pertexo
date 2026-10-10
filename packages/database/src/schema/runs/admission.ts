import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from '../app-schema.js';
import { workflowRuns } from './execution.js';
import { workspaces } from '../foundation.js';
import { outboxEvents } from '../transport.js';

export const workspaceExecutionEntitlements = appSchema.table(
  'workspace_execution_entitlements',
  {
    workspaceId: uuid('workspace_id').primaryKey().notNull(),
    currentVersion: integer('current_version').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'workspace_execution_entitlements_version_fk',
      columns: [table.workspaceId, table.currentVersion],
      foreignColumns: [
        workspaceExecutionEntitlementVersions.workspaceId,
        workspaceExecutionEntitlementVersions.version,
      ],
    }).onDelete('restrict'),
  ],
);

export const workspaceExecutionEntitlementVersions = appSchema.table(
  'workspace_execution_entitlement_versions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    version: integer().notNull(),
    status: varchar({ length: 16 }).default('active').notNull(),
    activeRunLimit: integer('active_run_limit').notNull(),
    queuedRunLimit: integer('queued_run_limit').notNull(),
    effectiveAt: timestamp('effective_at', {
      withTimezone: true,
      mode: 'string',
    })
      .default(sql`clock_timestamp()`)
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    check(
      'workspace_execution_entitlement_versions_limits_valid',
      sql`(active_run_limit >= 1) AND (active_run_limit <= 10000) AND ((queued_run_limit >= 1) AND (queued_run_limit <= 100000))`,
    ),
    check(
      'workspace_execution_entitlement_versions_status_valid',
      sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text])`,
    ),
    check(
      'workspace_execution_entitlement_versions_time_valid',
      sql`(expires_at IS NULL) OR (expires_at > effective_at)`,
    ),
    check(
      'workspace_execution_entitlement_versions_version_positive',
      sql`version > 0`,
    ),
    primaryKey({
      name: 'workspace_execution_entitlement_versions_pkey',
      columns: [table.workspaceId, table.version],
    }),
    index('workspace_execution_entitlement_versions_workspace_time_idx').on(
      table.workspaceId,
      table.effectiveAt.desc().nullsFirst(),
      table.version.desc().nullsFirst(),
    ),
    foreignKey({
      name: 'workspace_execution_entitlement_versions_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
  ],
);

export const workspaceExecutionAdmissionCounters = appSchema.table(
  'workspace_execution_admission_counters',
  {
    workspaceId: uuid('workspace_id').primaryKey().notNull(),
    queuedRuns: integer('queued_runs').default(0).notNull(),
    activeRuns: integer('active_runs').default(0).notNull(),
    reconciledAt: timestamp('reconciled_at', {
      withTimezone: true,
      mode: 'string',
    })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    check(
      'workspace_execution_admission_counters_nonnegative',
      sql`(queued_runs >= 0) AND (active_runs >= 0)`,
    ),
    foreignKey({
      name: 'workspace_execution_admission_counters_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
  ],
);

export const workflowRunActiveAdmissions = appSchema.table(
  'workflow_run_active_admissions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowRunId: uuid('workflow_run_id').primaryKey().notNull(),
    outboxEventId: uuid('outbox_event_id').notNull(),
    recoverAfter: timestamp('recover_after', {
      withTimezone: true,
      mode: 'string',
    }),
    recoveryCount: bigint('recovery_count', { mode: 'number' })
      .default(0)
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    workflowConcurrencyOrderExempt: boolean('workflow_concurrency_order_exempt')
      .default(true)
      .notNull(),
  },
  (table) => [
    check(
      'workflow_run_active_admissions_recovery_count_valid',
      sql`recovery_count >= 0`,
    ),
    unique('workflow_run_active_admissions_outbox_event_id_key').on(
      table.outboxEventId,
    ),
    index('workflow_run_active_admissions_workspace_idx').on(table.workspaceId),
    foreignKey({
      name: 'workflow_run_active_admissions_outbox_fk',
      columns: [table.outboxEventId],
      foreignColumns: [outboxEvents.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workflow_run_active_admissions_run_fk',
      columns: [table.workflowRunId],
      foreignColumns: [workflowRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workflow_run_active_admissions_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
  ],
);
