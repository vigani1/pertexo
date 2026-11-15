import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  primaryKey,
  uuid,
  varchar,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import type { ConnectionAuthType } from '../stored-shapes.js';
import { appSchema } from '../namespace.js';
import { nodeAttempts } from './node-executions.js';

/** The connection a run attempt dispatched through. */
export const nodeAttemptConnectionDispatches = appSchema.table(
  'node_attempt_connection_dispatches',
  {
    workspaceId: uuid('workspace_id').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    providerKey: varchar('provider_key', { length: 64 }).notNull(),
    authType: varchar('auth_type', { length: 64 })
      .$type<ConnectionAuthType>()
      .notNull(),
    secretVersionId: uuid('secret_version_id').notNull(),
    healthRevision: bigint('health_revision', { mode: 'number' }).notNull(),
    workerId: varchar('worker_id', { length: 128 }).notNull(),
    fenceToken: bigint('fence_token', { mode: 'number' }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'node_attempt_connection_dispatches_auth_type_check',
      sql`((auth_type)::text = 'slack_bot_token'::text)`,
    ),
    check(
      'node_attempt_connection_dispatches_fence_token_check',
      sql`(fence_token > 0)`,
    ),
    check(
      'node_attempt_connection_dispatches_health_revision_check',
      sql`(health_revision > 0)`,
    ),
    check(
      'node_attempt_connection_dispatches_provider_key_check',
      sql`((provider_key)::text = 'slack'::text)`,
    ),
    primaryKey({
      name: 'node_attempt_connection_dispatches_pkey',
      columns: [table.workspaceId, table.attemptId],
    }),
    foreignKey({
      name: 'node_attempt_connection_dispatches_attempt_fk',
      columns: [table.workspaceId, table.attemptId],
      foreignColumns: [nodeAttempts.workspaceId, nodeAttempts.id],
    }).onDelete('cascade'),
  ],
);
