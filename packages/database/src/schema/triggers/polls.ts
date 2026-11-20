import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  integer,
  foreignKey,
  index,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { workflowTriggers } from '../authoring/workflows.js';
import { appSchema, bytea } from '../namespace.js';
import { triggerLeaseColumns } from './trigger-lease.js';

export const triggerPolls = appSchema.table(
  'trigger_polls',
  {
    triggerId: uuid('trigger_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    seenKeys: bytea('seen_keys').array(),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    failurePauseRevision: bigint('failure_pause_revision', { mode: 'bigint' }),
    nextPollAt: timestamp('next_poll_at', { withTimezone: true })
      .notNull()
      .default(sql`statement_timestamp()`),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    ...triggerLeaseColumns(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`statement_timestamp()`),
  },
  (table) => [
    primaryKey({
      name: 'trigger_polls_pkey',
      columns: [table.workspaceId, table.triggerId],
    }),
    foreignKey({
      name: 'trigger_polls_trigger_fk',
      columns: [table.workspaceId, table.triggerId],
      foreignColumns: [workflowTriggers.workspaceId, workflowTriggers.id],
    }).onDelete('restrict'),
    check(
      'trigger_polls_lease_valid',
      sql`((((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_acquired_at IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_acquired_at IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (lease_expires_at > lease_acquired_at) AND (lease_expires_at <= (lease_acquired_at + '00:05:00'::interval)))) IS TRUE)`,
    ),
    check(
      'trigger_polls_failure_streak_valid',
      sql`consecutive_failures >= 0 and (consecutive_failures = 0 or failure_pause_revision is not null)`,
    ),
    index('trigger_polls_due_idx')
      .on(table.nextPollAt, table.workspaceId, table.triggerId)
      .where(sql`(retired_at IS NULL)`),
  ],
);
