import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  char,
  check,
  foreignKey,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { users } from '../identity/users.js';
import { workspaces } from '../tenant-access/workspaces.js';

export const workspaceLifecycleOperations = appSchema.table(
  'workspace_lifecycle_operations',
  {
    id: uuid().primaryKey().notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    idempotencyKeyHash: char('idempotency_key_hash', { length: 64 }).notNull(),
    commandType: varchar('command_type', { length: 32 }).notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    reason: varchar({ length: 512 }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    occurredAt: timestamp('occurred_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workspace_lifecycle_operations_command_valid',
      sql`((command_type)::text = ANY (ARRAY[('deletion_requested'::character varying)::text, ('deletion_restored'::character varying)::text, ('reactivated'::character varying)::text]))`,
    ),
    check(
      'workspace_lifecycle_operations_idempotency_hash_valid',
      sql`(idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)`,
    ),
    check(
      'workspace_lifecycle_operations_reason_bounded',
      sql`((length(btrim((reason)::text)) >= 1) AND (length(btrim((reason)::text)) <= 512))`,
    ),
    check(
      'workspace_lifecycle_operations_request_hash_valid',
      sql`(request_hash ~ '^[0-9a-f]{64}$'::text)`,
    ),
    unique('workspace_lifecycle_operations_idempotency_unique').on(
      table.workspaceId,
      table.idempotencyKeyHash,
    ),
    foreignKey({
      name: 'workspace_lifecycle_operations_actor_fk',
      columns: [table.actorUserId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workspace_lifecycle_operations_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
  ],
);
