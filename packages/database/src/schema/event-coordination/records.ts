import {
  char,
  check,
  foreignKey,
  index,
  integer,
  json,
  jsonb,
  timestamp,
  type PgTableExtraConfigValue,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';
import { workspaces } from '../foundation.js';
import { workflows, workflowVersions } from '../authoring/workflows.js';
import { workflowRuns } from '../runs/execution.js';
import { webhookTriggerEndpoints } from '../triggers/endpoints.js';
import type { EventCoordinationPolicy } from '@pertexo/workflow-model';

export const triggerEventWindows = appSchema.table(
  'trigger_event_windows',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    nodeId: varchar('node_id', { length: 128 }).notNull(),
    policyHash: char('policy_hash', { length: 64 }).notNull(),
    keyHash: char('key_hash', { length: 64 }).notNull(),
    windowStartedAt: timestamp('window_started_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    usedCount: integer('used_count').default(0).notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('trigger_event_windows_identity').on(table.workspaceId, table.id),
    unique('trigger_event_windows_key').on(
      table.workspaceId,
      table.workflowId,
      table.nodeId,
      table.policyHash,
      table.keyHash,
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('restrict'),
    check(
      'trigger_event_windows_bounds',
      sql`policy_hash ~ '^[0-9a-f]{64}$' and key_hash ~ '^[0-9a-f]{64}$' and used_count between 0 and 1000 and expires_at>window_started_at`,
    ),
    index('trigger_event_windows_expiry').on(
      table.workspaceId,
      table.expiresAt,
    ),
  ],
);
export const triggerCoordinatedEvents = appSchema.table(
  'trigger_coordinated_events',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    nodeId: varchar('node_id', { length: 128 }).notNull(),
    source: varchar('source', { length: 16 }).notNull(),
    mode: varchar('mode', { length: 16 }).notNull(),
    initialOutcome: varchar('initial_outcome', { length: 16 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    initialStatus: varchar('initial_status', { length: 16 }).notNull(),
    reason: varchar('reason', { length: 32 }),
    runId: uuid('run_id'),
    versionNumber: integer('version_number').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()+interval '90 days'`)
      .notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    keyId: uuid('key_id'),
    workflowVersionId: uuid('workflow_version_id'),
    endpointId: uuid('endpoint_id'),
    policy: jsonb('policy').$type<EventCoordinationPolicy>(),
    inputRef: json('input_ref'),
    inputBytes: integer('input_bytes').default(0).notNull(),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true, mode: 'date' }),
    capacityWaitStartedAt: timestamp('capacity_wait_started_at', {
      withTimezone: true,
      mode: 'date',
    }),
    startedBy: uuid('started_by'),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('trigger_coordinated_events_identity').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.keyId],
      foreignColumns: [triggerEventWindows.workspaceId, triggerEventWindows.id],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.workflowVersionId],
      foreignColumns: [workflowVersions.workspaceId, workflowVersions.id],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.endpointId],
      foreignColumns: [
        webhookTriggerEndpoints.workspaceId,
        webhookTriggerEndpoints.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.runId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('restrict'),
    check(
      'trigger_coordinated_events_kind',
      sql`source in ('webhook','form') and mode in ('deduplicate','debounce','throttle') and initial_outcome in ('accepted','skipped','deduplicated','debounced','throttled','refused') and initial_status in ('pending','started','skipped','refused') and status in ('pending','started','skipped','coalesced','refused') and (reason is null or reason in ('duplicate_key','newer_event','throttle_limit','invalid_key','coordination_full','coordination_timeout','queue_full','concurrency_limit','workflow_unavailable','publication_changed','endpoint_disabled')) and version_number>0`,
    ),
    check(
      'trigger_coordinated_events_state',
      sql`((status='pending' and key_id is not null and workflow_version_id is not null and policy is not null and input_ref is not null and input_ref->>'kind'='inline' and octet_length(input_ref::text)<=4194304 and octet_length(policy::text)<=65536 and input_bytes between 1 and 262144 and due_at is not null and deadline_at is not null and finished_at is null and run_id is null and ((source='webhook')=(endpoint_id is not null))) or (status<>'pending' and key_id is null and workflow_version_id is null and endpoint_id is null and policy is null and input_ref is null and input_bytes=0 and due_at is null and deadline_at is null and capacity_wait_started_at is null and started_by is null and finished_at is not null)) and ((status='started')=(run_id is not null))`,
    ),
    check(
      'trigger_coordinated_events_retention',
      sql`expires_at between received_at+interval '89 days 23:59:59' and received_at+interval '90 days 00:00:01'`,
    ),
    index('trigger_coordinated_events_history').on(
      table.workspaceId,
      table.workflowId,
      table.nodeId,
      table.receivedAt,
      table.id,
    ),
    index('trigger_coordinated_events_expiry').on(table.expiresAt, table.id),
    uniqueIndex('trigger_coordinated_events_debounce')
      .on(table.keyId)
      .where(sql`status='pending' and mode='debounce'`),
    index('trigger_coordinated_events_due')
      .on(table.dueAt, table.id)
      .where(sql`status='pending'`),
    index('trigger_coordinated_events_head')
      .on(table.keyId, table.receivedAt, table.id)
      .where(sql`status='pending'`),
    index('trigger_coordinated_events_budget')
      .on(table.workspaceId)
      .where(sql`status='pending'`),
    index('trigger_coordinated_events_run')
      .on(table.workspaceId, table.runId)
      .where(sql`run_id is not null`),
  ],
);
