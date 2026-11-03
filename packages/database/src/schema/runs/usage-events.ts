import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { workspaces } from '../tenant-access/workspaces.js';

export const usageEvents = appSchema.table(
  'usage_events',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    category: varchar('category', { length: 64 }).notNull(),
    quantity: bigint('quantity', { mode: 'number' }).notNull(),
    resourceType: varchar('resource_type', { length: 64 }).notNull(),
    resourceId: uuid('resource_id').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index('usage_events_coordinated_history_idx')
      .on(table.workspaceId, table.occurredAt, table.id)
      .where(sql`category='trigger.coordinated'`),
    index('usage_events_coordinated_retention_idx')
      .on(table.occurredAt, table.id)
      .where(sql`category='trigger.coordinated'`),
    index('usage_events_trigger_skip_history_idx')
      .on(
        table.workspaceId,
        table.resourceId,
        table.occurredAt.desc(),
        table.id,
      )
      .where(sql`category='trigger.skipped' AND resource_type='workflow'`),
    index('usage_events_trigger_skip_retention_idx')
      .on(table.occurredAt, table.id)
      .where(sql`category='trigger.skipped'`),
    check(
      'usage_events_category_format',
      sql`((category)::text ~ '^[a-z][a-z0-9._:-]{0,63}$'::text)`,
    ),
    check(
      'usage_events_idempotency_key_format',
      sql`((idempotency_key)::text ~ '^[A-Za-z0-9._:-]{1,128}$'::text)`,
    ),
    check(
      'usage_events_metadata_bounded',
      sql`(octet_length((metadata)::text) <= 4096)`,
    ),
    check(
      'usage_events_preview_uuid_v7',
      sql`(((category)::text <> 'preview_execution'::text) OR (uuid_extract_version(id) = 7))`,
    ),
    check('usage_events_quantity_positive', sql`(quantity > 0)`),
    check(
      'usage_events_resource_type_format',
      sql`((resource_type)::text ~ '^[a-z][a-z0-9._:-]{0,63}$'::text)`,
    ),
    unique('usage_events_workspace_idempotency_unique').on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: 'usage_events_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
    index('usage_events_resource_idx').on(
      table.workspaceId,
      table.resourceType,
      table.resourceId,
      table.id,
    ),
    index('usage_events_workspace_period_idx').on(
      table.workspaceId,
      table.occurredAt.desc().nullsFirst(),
      table.id,
    ),
  ],
);
