import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  check,
  foreignKey,
  index,
  jsonb,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { users } from '../identity/users.js';
import { workspaces } from '../tenant-access/workspaces.js';

export const auditEvents = appSchema.table(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    actorUserId: uuid('actor_user_id'),
    action: varchar('action', { length: 128 }).notNull(),
    targetType: varchar('target_type', { length: 64 }).notNull(),
    targetId: uuid('target_id'),
    requestId: varchar('request_id', { length: 128 }),
    traceId: varchar('trace_id', { length: 128 }),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'audit_events_action_format',
      sql`((action)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text)`,
    ),
    check(
      'audit_events_metadata_bounded',
      sql`(octet_length((metadata)::text) <= 8192)`,
    ),
    check(
      'audit_events_preview_terminal_uuid_v7',
      sql`(((action)::text <> 'preview.execution_terminal'::text) OR (uuid_extract_version(id) = 7))`,
    ),
    check(
      'audit_events_request_id_bounded',
      sql`((request_id IS NULL) OR ((length((request_id)::text) >= 1) AND (length((request_id)::text) <= 128)))`,
    ),
    check(
      'audit_events_target_type_format',
      sql`((target_type)::text ~ '^[a-z][a-z0-9._:-]{0,63}$'::text)`,
    ),
    check(
      'audit_events_trace_id_bounded',
      sql`((trace_id IS NULL) OR ((length((trace_id)::text) >= 1) AND (length((trace_id)::text) <= 128)))`,
    ),
    foreignKey({
      name: 'audit_events_actor_fk',
      columns: [table.actorUserId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'audit_events_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
    index('audit_events_workspace_target_idx').on(
      table.workspaceId,
      table.targetType,
      table.targetId,
      table.occurredAt.desc().nullsFirst(),
    ),
    index('audit_events_workspace_time_idx').on(
      table.workspaceId,
      table.occurredAt.desc().nullsFirst(),
      table.id,
    ),
  ],
);
