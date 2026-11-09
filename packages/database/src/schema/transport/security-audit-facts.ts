import {
  type PgTableExtraConfigValue,
  check,
  index,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';

export const transportSecurityAuditFacts = appSchema.table(
  'transport_security_audit_facts',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    factType: varchar('fact_type', { length: 64 }).notNull(),
    consumerName: varchar('consumer_name', { length: 128 }).notNull(),
    messageId: uuid('message_id').notNull(),
    occurredAt: timestamp('occurred_at', {
      withTimezone: true,
      mode: 'date',
    })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'transport_security_audit_consumer_name_format',
      sql`((consumer_name)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text)`,
    ),
    check(
      'transport_security_audit_fact_type',
      sql`((fact_type)::text = 'inbox_checksum_mismatch'::text)`,
    ),
    index('transport_audit_retention_dry_run_idx').on(
      table.workspaceId,
      table.occurredAt,
      table.id,
    ),
    index('transport_security_audit_facts_message_idx').on(
      table.workspaceId,
      table.messageId,
    ),
  ],
);
