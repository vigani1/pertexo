import {
  type PgTableExtraConfigValue,
  char,
  check,
  index,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';

export const inboxReceipts = appSchema.table(
  'inbox_receipts',
  {
    consumerName: varchar('consumer_name', { length: 128 }).notNull(),
    messageId: uuid('message_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    payloadChecksum: char('payload_checksum', { length: 64 }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'inbox_receipts_checksum_format',
      sql`(payload_checksum ~ '^[0-9a-f]{64}$'::text)`,
    ),
    check(
      'inbox_receipts_completion_order',
      sql`((completed_at IS NULL) OR (completed_at >= received_at))`,
    ),
    check(
      'inbox_receipts_consumer_name_format',
      sql`((consumer_name)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text)`,
    ),
    primaryKey({
      name: 'inbox_receipts_pkey',
      columns: [table.consumerName, table.messageId],
    }),
    index('inbox_receipts_retention_idx').on(table.receivedAt, table.messageId),
    index('inbox_receipts_workspace_idx').on(
      table.workspaceId,
      table.receivedAt.desc().nullsFirst(),
    ),
  ],
);
