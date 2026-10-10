import {
  type PgTableExtraConfigValue,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema } from './app-schema.js';
import { workflows } from './authoring/workflows.js';
import { users, workspaces } from './foundation.js';

export const failureNotificationDestinations = appSchema.table(
  'failure_notification_destinations',
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    kind: varchar({ length: 16 }).notNull(),
    status: varchar({ length: 16 }).default('enabled').notNull(),
    currentConfigVersion: integer('current_config_version')
      .default(1)
      .notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  // Mutual foreign key with the version table; the explicit return type breaks
  // the inference cycle.
  (table): PgTableExtraConfigValue[] => [
    check(
      'failure_notification_destinations_kind_valid',
      sql`((kind)::text = ANY (ARRAY[('slack'::character varying)::text, ('email'::character varying)::text]))`,
    ),
    check(
      'failure_notification_destinations_status_valid',
      sql`((status)::text = ANY (ARRAY[('enabled'::character varying)::text, ('disabled'::character varying)::text]))`,
    ),
    check(
      'failure_notification_destinations_version_positive',
      sql`(current_config_version > 0)`,
    ),
    unique(
      'failure_notification_destinations_workspace_identity_kind_uniqu',
    ).on(table.workspaceId, table.id, table.kind),
    unique('failure_notification_destinations_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'failure_notification_destinations_creator_fk',
      columns: [table.createdBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    // The baseline sets this foreign key DEFERRABLE INITIALLY DEFERRED.
    foreignKey({
      name: 'failure_notification_destinations_current_version_fk',
      columns: [table.workspaceId, table.id, table.currentConfigVersion],
      foreignColumns: [
        failureNotificationDestinationVersions.workspaceId,
        failureNotificationDestinationVersions.destinationId,
        failureNotificationDestinationVersions.version,
      ],
    }),
    foreignKey({
      name: 'failure_notification_destinations_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
    index('failure_notification_destinations_workspace_status_idx').on(
      table.workspaceId,
      table.status,
      table.createdAt,
      table.id,
    ),
  ],
);

export const failureNotificationDestinationVersions = appSchema.table(
  'failure_notification_destination_versions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    destinationId: uuid('destination_id').notNull(),
    version: integer().notNull(),
    kind: varchar({ length: 16 }).notNull(),
    sideEffectClass: varchar('side_effect_class', { length: 32 }).notNull(),
    config: jsonb().notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'failure_notification_destination_versions_config_strict',
      sql`(((jsonb_typeof(config) = 'object'::text) AND ((((kind)::text = 'slack'::text) AND (jsonb_typeof((config -> 'connectionId'::text)) = 'string'::text) AND (jsonb_typeof((config -> 'channelId'::text)) = 'string'::text) AND (((config - 'connectionId'::text) - 'channelId'::text) = '{}'::jsonb) AND ((config ->> 'connectionId'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((config ->> 'channelId'::text) ~ '^[CDGU][A-Z0-9]{1,79}$'::text)) OR (((kind)::text = 'email'::text) AND (jsonb_typeof((config -> 'connectionId'::text)) = 'string'::text) AND (jsonb_typeof((config -> 'toEmail'::text)) = 'string'::text) AND (((config - 'connectionId'::text) - 'toEmail'::text) = '{}'::jsonb) AND ((config ->> 'connectionId'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((length((config ->> 'toEmail'::text)) >= 3) AND (length((config ->> 'toEmail'::text)) <= 254)) AND ((config ->> 'toEmail'::text) ~ '^[!-~]+@[A-Za-z0-9.-]+$'::text)))) IS TRUE)`,
    ),
    check(
      'failure_notification_destination_versions_kind_valid',
      sql`((kind)::text = ANY (ARRAY[('slack'::character varying)::text, ('email'::character varying)::text]))`,
    ),
    check(
      'failure_notification_destination_versions_side_effect_valid',
      sql`((((kind)::text = 'slack'::text) AND ((side_effect_class)::text = 'unsafe'::text)) OR (((kind)::text = 'email'::text) AND ((side_effect_class)::text = 'idempotent_with_key'::text)))`,
    ),
    check(
      'failure_notification_destination_versions_version_positive',
      sql`(version > 0)`,
    ),
    primaryKey({
      name: 'failure_notification_destination_versions_pkey',
      columns: [table.destinationId, table.version],
    }),
    unique(
      'failure_notification_destination_versions_workspace_identity_ef',
    ).on(
      table.workspaceId,
      table.destinationId,
      table.version,
      table.sideEffectClass,
    ),
    unique(
      'failure_notification_destination_versions_workspace_identity_un',
    ).on(table.workspaceId, table.destinationId, table.version),
    foreignKey({
      name: 'failure_notification_destination_versions_creator_fk',
      columns: [table.createdBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'failure_notification_destination_versions_destination_kind_fk',
      columns: [table.workspaceId, table.destinationId, table.kind],
      foreignColumns: [
        failureNotificationDestinations.workspaceId,
        failureNotificationDestinations.id,
        failureNotificationDestinations.kind,
      ],
    }).onDelete('restrict'),
    index('failure_notification_destination_versions_workspace_idx').on(
      table.workspaceId,
      table.destinationId,
      table.version.desc().nullsFirst(),
    ),
  ],
);

export const workflowFailureNotificationPolicies = appSchema.table(
  'workflow_failure_notification_policies',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').primaryKey().notNull(),
    destinationId: uuid('destination_id').notNull(),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique(
      'workflow_failure_notification_policies_workspace_workflow_uniqu',
    ).on(table.workspaceId, table.workflowId),
    foreignKey({
      name: 'workflow_failure_notification_policies_destination_fk',
      columns: [table.workspaceId, table.destinationId],
      foreignColumns: [
        failureNotificationDestinations.workspaceId,
        failureNotificationDestinations.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workflow_failure_notification_policies_updater_fk',
      columns: [table.updatedBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workflow_failure_notification_policies_workflow_fk',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
    index('workflow_failure_notification_policies_destination_idx').on(
      table.workspaceId,
      table.destinationId,
      table.workflowId,
    ),
  ],
);
