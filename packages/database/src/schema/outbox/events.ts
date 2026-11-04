import type { JsonValue } from '@pertexo/workflow-model';
import {
  type PgTableExtraConfigValue,
  char,
  check,
  index,
  integer,
  jsonb,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';

export const outboxEvents = appSchema.table(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    jobName: varchar('job_name', { length: 128 }).notNull(),
    aggregateType: varchar('aggregate_type', { length: 64 }).notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    payload: jsonb('payload')
      .$type<JsonValue | Readonly<Record<string, unknown>>>()
      .notNull(),
    payloadChecksum: char('payload_checksum', { length: 64 }).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    leaseOwner: varchar('lease_owner', { length: 128 }),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    publishAttempts: integer('publish_attempts').default(0).notNull(),
    publishedAt: timestamp('published_at', {
      withTimezone: true,
      mode: 'date',
    }),
    failedAt: timestamp('failed_at', { withTimezone: true, mode: 'date' }),
    lastErrorCode: varchar('last_error_code', { length: 128 }),
    /** When a published job must have been confirmed; see stalled work. */
    deliveryDueAt: timestamp('delivery_due_at', {
      withTimezone: true,
      mode: 'date',
    }),
    /** How many times stalled work asked for it again; part of its BullMQ job ID. */
    redeliveries: integer('redeliveries').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'outbox_events_aggregate_type_format',
      sql`((aggregate_type)::text ~ '^[a-z][a-z0-9.-]{0,63}$'::text)`,
    ),
    check('outbox_events_attempts_nonnegative', sql`(publish_attempts >= 0)`),
    check('outbox_events_redeliveries_nonnegative', sql`(redeliveries >= 0)`),
    check(
      'outbox_events_checksum_format',
      sql`(payload_checksum ~ '^[0-9a-f]{64}$'::text)`,
    ),
    check(
      'outbox_events_error_code_format',
      sql`((last_error_code IS NULL) OR ((last_error_code)::text ~ '^[a-z][a-z0-9._:-]{0,127}$'::text))`,
    ),
    check(
      'outbox_events_job_name_format',
      sql`((job_name)::text ~ '^[a-z][a-z0-9-]{0,127}$'::text)`,
    ),
    check(
      'outbox_events_lease_complete',
      sql`(((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL)))`,
    ),
    check(
      'outbox_events_lease_owner_format',
      sql`((lease_owner IS NULL) OR ((lease_owner)::text ~ '^[A-Za-z0-9._:-]{1,128}$'::text))`,
    ),
    check(
      'outbox_events_payload_bounded',
      sql`(octet_length((payload)::text) <= 4096)`,
    ),
    check(
      'outbox_events_terminal_state_exclusive',
      sql`(NOT ((published_at IS NOT NULL) AND (failed_at IS NOT NULL)))`,
    ),
    index('outbox_events_error_workflow_repair_idx')
      .on(table.deliveryDueAt, table.id)
      .where(
        sql`(job_name='start-error-workflow' AND failed_at IS NOT NULL AND delivery_due_at IS NOT NULL)`,
      ),
    index('outbox_events_delivery_due_idx')
      .on(table.deliveryDueAt, table.id)
      .where(sql`(delivery_due_at IS NOT NULL)`),
    index('outbox_events_dispatch_job_due_idx')
      .on(table.jobName, table.availableAt, table.id)
      .where(sql`((published_at IS NULL) AND (failed_at IS NULL))`),
    index('outbox_events_due_idx')
      .on(table.availableAt, table.id)
      .where(sql`((published_at IS NULL) AND (failed_at IS NULL))`),
    index('outbox_events_expired_lease_idx')
      .on(table.leaseExpiresAt, table.id)
      .where(
        sql`((lease_expires_at IS NOT NULL) AND (published_at IS NULL) AND (failed_at IS NULL))`,
      ),
    index('outbox_events_workspace_idx').on(table.workspaceId, table.id),
    // Retention's pages. Rows still watched for a receipt aren't in them.
    index('outbox_events_published_retention_idx')
      .on(table.publishedAt, table.id)
      .where(
        sql`((published_at IS NOT NULL) AND (failed_at IS NULL) AND (delivery_due_at IS NULL))`,
      ),
    index('outbox_events_failed_retention_idx')
      .on(table.failedAt, table.id)
      .where(sql`((failed_at IS NOT NULL) AND (delivery_due_at IS NULL))`),
  ],
);
