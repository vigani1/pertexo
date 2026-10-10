import { users, workspaces } from '../foundation.js';
import {
  type PgTableExtraConfigValue,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  smallint,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from '../app-schema.js';

export const workflows = appSchema.table(
  'workflows',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    nameRevision: integer('name_revision').default(1).notNull(),
    lifecycleStatus: varchar('lifecycle_status', { length: 32 })
      .default('active')
      .notNull(),
    lifecycleRevision: integer('lifecycle_revision').default(1).notNull(),
    activationStatus: varchar('activation_status', { length: 32 })
      .default('inactive')
      .notNull(),
    publishedVersionId: uuid('published_version_id'),
    // ADR 056: operational auto-pause settings and trigger pause state.
    autoPauseEnabled: boolean('auto_pause_enabled').default(true).notNull(),
    autoPauseThreshold: smallint('auto_pause_threshold'),
    autoPauseSettingsRevision: integer('auto_pause_settings_revision')
      .default(1)
      .notNull(),
    triggerPauseState: varchar('trigger_pause_state', { length: 16 })
      .default('none')
      .notNull(),
    triggerPausedAt: timestamp('trigger_paused_at', {
      withTimezone: true,
      mode: 'date',
    }),
    triggerPauseReason: varchar('trigger_pause_reason', { length: 32 }),
    triggerPauseFailures: integer('trigger_pause_failures'),
    triggerPauseLastRunId: uuid('trigger_pause_last_run_id'),
    triggerPauseRevision: bigint('trigger_pause_revision', { mode: 'bigint' })
      .default(sql`1`)
      .notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`date_trunc('milliseconds', clock_timestamp())`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflows_activation_status_valid',
      sql`((activation_status)::text = ANY (ARRAY[('inactive'::character varying)::text, ('activating'::character varying)::text, ('active'::character varying)::text, ('deactivating'::character varying)::text, ('degraded'::character varying)::text, ('error'::character varying)::text]))`,
    ),
    check(
      'workflows_auto_pause_settings_revision_check',
      sql`(auto_pause_settings_revision > 0)`,
    ),
    check(
      'workflows_auto_pause_threshold_valid',
      sql`((auto_pause_threshold IS NULL) OR ((auto_pause_threshold >= 3) AND (auto_pause_threshold <= 100)))`,
    ),
    check(
      'workflows_created_at_millisecond_precision',
      sql`(created_at = date_trunc('milliseconds'::text, created_at))`,
    ),
    check(
      'workflows_lifecycle_revision_positive',
      sql`(lifecycle_revision > 0)`,
    ),
    check(
      'workflows_lifecycle_status_valid',
      sql`((lifecycle_status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text]))`,
    ),
    check(
      'workflows_name_nonempty',
      sql`((length(btrim((name)::text)) >= 1) AND (length(btrim((name)::text)) <= 128))`,
    ),
    check('workflows_name_revision_positive', sql`(name_revision > 0)`),
    check(
      'workflows_trigger_pause_valid',
      sql`((trigger_pause_revision > 0) AND ((((trigger_pause_state)::text = 'none'::text) AND (trigger_paused_at IS NULL) AND (trigger_pause_reason IS NULL) AND (trigger_pause_failures IS NULL) AND (trigger_pause_last_run_id IS NULL)) OR (((trigger_pause_state)::text = 'paused'::text) AND (trigger_paused_at IS NOT NULL) AND ((trigger_pause_reason)::text = 'consecutive_failures'::text) AND (trigger_pause_failures > 0) AND (trigger_pause_last_run_id IS NOT NULL))))`,
    ),
    unique('workflows_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'workflows_created_by_fk',
      columns: [table.createdBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workflows_published_version_workspace_fk',
      columns: [table.workspaceId, table.id, table.publishedVersionId],
      foreignColumns: [
        workflowVersions.workspaceId,
        workflowVersions.workflowId,
        workflowVersions.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workflows_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
    index('workflows_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
    index('workflows_workspace_name_idx').on(
      table.workspaceId,
      table.name,
      table.id,
    ),
    index('workflows_workspace_updated_idx').on(
      table.workspaceId,
      table.updatedAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
  ],
);
export const workflowDrafts = appSchema.table(
  'workflow_drafts',
  {
    workflowId: uuid('workflow_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    revision: integer('revision').default(1).notNull(),
    graphJson: jsonb('graph_json').notNull(),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflow_drafts_graph_bounded',
      sql`(octet_length((graph_json)::text) <= 2097152)`,
    ),
    check(
      'workflow_drafts_graph_object',
      sql`(jsonb_typeof(graph_json) = 'object'::text)`,
    ),
    check('workflow_drafts_revision_positive', sql`(revision > 0)`),
    foreignKey({
      name: 'workflow_drafts_updated_by_fk',
      columns: [table.updatedBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workflow_drafts_workflow_workspace_fk',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
    index('workflow_drafts_workspace_idx').on(
      table.workspaceId,
      table.workflowId,
    ),
  ],
);
export const workflowVersions = appSchema.table(
  'workflow_versions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    graphJson: jsonb('graph_json').notNull(),
    checksum: varchar('checksum', { length: 74 }).notNull(),
    executableJson: jsonb('executable_json').notNull(),
    publishedBy: uuid('published_by').notNull(),
    publishedAt: timestamp('published_at', {
      withTimezone: true,
      mode: 'date',
    })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflow_versions_checksum_format',
      sql`((checksum)::text ~ '^wf:sha256:[0-9a-f]{64}$'::text)`,
    ),
    check(
      'workflow_versions_executable_object',
      sql`((jsonb_typeof(executable_json) = 'object'::text) AND (octet_length((executable_json)::text) <= 1048576))`,
    ),
    check(
      'workflow_versions_graph_bounded',
      sql`(octet_length((graph_json)::text) <= 2097152)`,
    ),
    check(
      'workflow_versions_graph_object',
      sql`(jsonb_typeof(graph_json) = 'object'::text)`,
    ),
    check('workflow_versions_number_positive', sql`(version_number > 0)`),
    unique('workflow_versions_checksum_unique').on(
      table.workflowId,
      table.checksum,
    ),
    unique('workflow_versions_number_unique').on(
      table.workflowId,
      table.versionNumber,
    ),
    unique('workflow_versions_workspace_identity_unique').on(
      table.workspaceId,
      table.workflowId,
      table.id,
    ),
    unique('workflow_versions_workspace_version_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'workflow_versions_published_by_fk',
      columns: [table.publishedBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workflow_versions_workflow_workspace_fk',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('restrict'),
    index('workflow_versions_workspace_workflow_idx').on(
      table.workspaceId,
      table.workflowId,
      table.versionNumber.desc().nullsFirst(),
    ),
  ],
);
export const workflowTriggers = appSchema.table(
  'workflow_triggers',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    workflowVersionId: uuid('workflow_version_id').notNull(),
    nodeId: varchar('node_id', { length: 128 }).notNull(),
    kind: varchar('kind', { length: 16 }).notNull(),
    status: varchar('status', { length: 32 })
      .notNull()
      .default(sql`'desired'::character varying`),
    desiredConfig: jsonb('desired_config').notNull(),
    configFingerprint: varchar('config_fingerprint', { length: 79 }).notNull(),
    healthStatus: varchar('health_status', { length: 32 })
      .notNull()
      .default(sql`'pending'::character varying`),
    lastErrorCode: varchar('last_error_code', { length: 128 }),
    reconciledAt: timestamp('reconciled_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflow_triggers_config_bounded',
      sql`(octet_length((desired_config)::text) <= 4096)`,
    ),
    check(
      'workflow_triggers_config_strict',
      sql`((((kind)::text = 'webhook'::text) AND (desired_config = '{}'::jsonb)) OR (((kind)::text = 'schedule'::text) AND (jsonb_typeof(desired_config) = 'object'::text)))`,
    ),
    check(
      'workflow_triggers_fingerprint_valid',
      sql`((config_fingerprint)::text ~ '^trigger:sha256:[0-9a-f]{64}$'::text)`,
    ),
    check(
      'workflow_triggers_health_valid',
      sql`((health_status)::text = ANY (ARRAY[('pending'::character varying)::text, ('healthy'::character varying)::text, ('degraded'::character varying)::text, ('unhealthy'::character varying)::text, ('disabled'::character varying)::text]))`,
    ),
    check(
      'workflow_triggers_kind_valid',
      sql`((kind)::text = ANY (ARRAY[('webhook'::character varying)::text, ('schedule'::character varying)::text]))`,
    ),
    check(
      'workflow_triggers_status_valid',
      sql`((status)::text = ANY (ARRAY[('desired'::character varying)::text, ('configuration_required'::character varying)::text, ('pending'::character varying)::text, ('active'::character varying)::text, ('degraded'::character varying)::text, ('disabled'::character varying)::text, ('error'::character varying)::text]))`,
    ),
    unique('workflow_triggers_version_node_unique').on(
      table.workflowVersionId,
      table.nodeId,
    ),
    unique('workflow_triggers_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'workflow_triggers_version_fk',
      columns: [table.workspaceId, table.workflowId, table.workflowVersionId],
      foreignColumns: [
        workflowVersions.workspaceId,
        workflowVersions.workflowId,
        workflowVersions.id,
      ],
    }).onDelete('restrict'),
    index('workflow_triggers_active_kind_idx')
      .on(table.workspaceId, table.kind, table.status, table.id)
      .where(
        sql`((status)::text = ANY (ARRAY[('configuration_required'::character varying)::text, ('pending'::character varying)::text, ('active'::character varying)::text, ('degraded'::character varying)::text]))`,
      ),
    index('workflow_triggers_workflow_version_idx').on(
      table.workspaceId,
      table.workflowId,
      table.workflowVersionId,
      table.nodeId,
    ),
  ],
);
