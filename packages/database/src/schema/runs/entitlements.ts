import {
  type PgTableExtraConfigValue,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';
import { workspaces } from '../foundation.js';

export const workspaceExecutionEntitlements = appSchema.table(
  'workspace_execution_entitlements',
  {
    workspaceId: uuid('workspace_id').primaryKey().notNull(),
    currentVersion: integer('current_version').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
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
  (table): PgTableExtraConfigValue[] => [
    check(
      'workspace_execution_entitlement_versions_limits_valid',
      sql`((active_run_limit >= 1) AND (active_run_limit <= 10000) AND ((queued_run_limit >= 1) AND (queued_run_limit <= 100000)))`,
    ),
    check(
      'workspace_execution_entitlement_versions_status_valid',
      sql`((status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text]))`,
    ),
    check(
      'workspace_execution_entitlement_versions_time_valid',
      sql`((expires_at IS NULL) OR (expires_at > effective_at))`,
    ),
    check(
      'workspace_execution_entitlement_versions_version_positive',
      sql`(version > 0)`,
    ),
    primaryKey({
      name: 'workspace_execution_entitlement_versions_pkey',
      columns: [table.workspaceId, table.version],
    }),
    foreignKey({
      name: 'workspace_execution_entitlement_versions_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
    index('workspace_execution_entitlement_versions_workspace_time_idx').on(
      table.workspaceId,
      table.effectiveAt.desc().nullsFirst(),
      table.version.desc().nullsFirst(),
    ),
  ],
);
