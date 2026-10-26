import { sql } from 'drizzle-orm';
import {
  check,
  char,
  foreignKey,
  index,
  json,
  jsonb,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { users } from '../foundation.js';
import { nodeRuns, workflowRuns } from './execution.js';

export const pendingRunTasks = appSchema.table(
  'pending_run_tasks',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    runId: uuid('run_id').notNull(),
    workflowVersionId: uuid('workflow_version_id').notNull(),
    nodeRunId: uuid('node_run_id'),
    callbackNodeId: varchar('callback_node_id', { length: 64 }),
    callbackScope: jsonb('callback_scope'),
    callbackScopeHash: char('callback_scope_hash', { length: 64 }),
    callbackTokenHash: char('callback_token_hash', { length: 64 }),
    callbackKeyVersion: varchar('callback_key_version', { length: 64 }),
    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' }),
    invocationKey: varchar('invocation_key', { length: 256 }).notNull(),
    kind: varchar({ length: 32 }).notNull(),
    config: jsonb().notNull(),
    context: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: varchar({ length: 16 }).notNull().default('pending'),
    outputRef: json('output_ref'),
    decidedBy: uuid('decided_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    unique('pending_run_tasks_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    unique('pending_run_tasks_invocation_unique').on(
      table.workspaceId,
      table.runId,
      table.invocationKey,
    ),
    check(
      'pending_run_tasks_kind_valid',
      sql`kind IN ('approval', 'input_request','callback')`,
    ),
    check(
      'pending_run_tasks_result_kind_valid',
      sql`(status NOT IN ('approved','rejected','submitted') OR (kind='approval' AND status IN ('approved','rejected')) OR (kind IN ('input_request','callback') AND status='submitted')) IS TRUE`,
    ),
    check(
      'pending_run_tasks_config_bounded',
      sql`jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 16384`,
    ),
    check(
      'pending_run_tasks_output_bounded',
      sql`output_ref IS NULL OR octet_length(output_ref::text) <= 4194304`,
    ),
    check(
      'pending_run_tasks_context_bounded',
      sql`jsonb_typeof(context) = 'object' AND octet_length(context::text) <= 73728`,
    ),
    check(
      'pending_run_tasks_expiry_valid',
      sql`((kind<>'callback' AND expires_at > created_at AND expires_at <= created_at + interval '30 days') OR (kind='callback' AND ((opened_at IS NULL AND expires_at IS NULL) OR (opened_at IS NOT NULL AND expires_at>opened_at AND expires_at<=opened_at+interval '30 days')))) IS TRUE`,
    ),
    check(
      'pending_run_tasks_state_valid',
      sql`((kind='callback' AND status='prepared' AND node_run_id IS NULL AND opened_at IS NULL AND output_ref IS NULL AND decided_by IS NULL AND completed_at IS NULL AND consumed_at IS NULL)
    OR (status = 'pending' AND output_ref IS NULL AND decided_by IS NULL AND completed_at IS NULL AND consumed_at IS NULL)
    OR (status IN ('approved','rejected','submitted') AND output_ref IS NOT NULL AND ((kind='callback' AND decided_by IS NULL) OR (kind<>'callback' AND decided_by IS NOT NULL)) AND completed_at IS NOT NULL)
    OR (status = 'expired' AND kind IN ('approval','input_request') AND output_ref IS NOT NULL AND decided_by IS NULL AND completed_at IS NOT NULL)
    OR (status IN ('expired','refused','canceled') AND output_ref IS NULL AND decided_by IS NULL AND completed_at IS NOT NULL)) IS TRUE`,
    ),
    check(
      'pending_run_tasks_binding_valid',
      sql`((kind<>'callback' AND node_run_id IS NOT NULL AND callback_node_id IS NULL AND callback_scope IS NULL AND callback_scope_hash IS NULL AND callback_token_hash IS NULL AND callback_key_version IS NULL AND opened_at IS NULL) OR (kind='callback' AND (status<>'pending' OR node_run_id IS NOT NULL) AND callback_node_id IS NOT NULL AND jsonb_typeof(callback_scope)='array' AND octet_length(callback_scope::text)<=8192 AND callback_scope_hash ~ '^[0-9a-f]{64}$' AND callback_token_hash ~ '^[0-9a-f]{64}$' AND callback_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' AND ((node_run_id IS NULL AND opened_at IS NULL) OR (node_run_id IS NOT NULL AND opened_at IS NOT NULL)))) IS TRUE`,
    ),
    unique('pending_run_tasks_callback_token_unique').on(
      table.callbackTokenHash,
    ),
    unique('pending_run_tasks_callback_scope_unique').on(
      table.workspaceId,
      table.runId,
      table.callbackNodeId,
      table.callbackScopeHash,
    ),
    foreignKey({
      name: 'pending_run_tasks_run_fk',
      columns: [table.workspaceId, table.runId, table.workflowVersionId],
      foreignColumns: [
        workflowRuns.workspaceId,
        workflowRuns.id,
        workflowRuns.workflowVersionId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'pending_run_tasks_node_fk',
      columns: [table.workspaceId, table.nodeRunId],
      foreignColumns: [nodeRuns.workspaceId, nodeRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'pending_run_tasks_decider_fk',
      columns: [table.decidedBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    index('pending_run_tasks_callback_inventory_idx')
      .on(sql`${table.callbackKeyVersion} collate "C"`, table.id)
      .where(
        sql`kind='callback' and consumed_at is null and status in ('prepared','pending','submitted')`,
      ),
    index('pending_run_tasks_unconsumed_run_idx')
      .on(table.workspaceId, table.runId)
      .where(sql`consumed_at IS NULL`),
    index('pending_run_tasks_workspace_status_idx').on(
      table.workspaceId,
      table.status,
      table.id,
    ),
  ],
);
