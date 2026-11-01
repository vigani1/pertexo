import type {
  WebhookDeliveryOutcome,
  WebhookSignatureCheck,
  WebhookReplayCheck,
} from '../stored-shapes.js';
import { triggerCoordinatedEvents } from '../event-coordination/records.js';
import { workflowRuns } from '../runs/execution.js';
import {
  type PgTableExtraConfigValue,
  char,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  smallint,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../namespace.js';
import { webhookTriggerEndpoints } from './endpoints.js';

export const webhookTriggerDeliveries = appSchema.table(
  'webhook_trigger_deliveries',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    endpointId: uuid('endpoint_id').notNull(),
    workflowRunId: uuid('workflow_run_id'),
    skipReason: varchar('skip_reason', { length: 32 }),
    coordinationEventId: uuid('coordination_event_id'),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()+interval '90 days'`)
      .notNull(),
    outcome: varchar('outcome', { length: 32 })
      .$type<WebhookDeliveryOutcome>()
      .default('accepted')
      .notNull(),
    httpStatus: smallint('http_status').default(202).notNull(),
    signatureCheck: varchar('signature_check', { length: 16 })
      .$type<WebhookSignatureCheck>()
      .default('verified')
      .notNull(),
    replayCheck: varchar('replay_check', { length: 16 })
      .$type<WebhookReplayCheck>()
      .default('new')
      .notNull(),
    bodyBytes: integer('body_bytes'),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.workspaceId, table.coordinationEventId],
      foreignColumns: [
        triggerCoordinatedEvents.workspaceId,
        triggerCoordinatedEvents.id,
      ],
    }).onDelete('restrict'),
    check(
      'webhook_trigger_deliveries_body_bytes_valid',
      sql`((body_bytes IS NULL) OR ((body_bytes >= 0) AND (body_bytes <= 262144)))`,
    ),
    check(
      'webhook_trigger_deliveries_outcome_valid',
      sql`(((outcome='coordinated' and http_status=202 and signature_check='verified' and replay_check in ('new','duplicate') and workflow_run_id is null and skip_reason is null and coordination_event_id is not null) OR (outcome='skipped' AND http_status=202 AND signature_check='verified' AND replay_check IN ('new','duplicate') AND workflow_run_id IS NULL AND skip_reason='concurrency_limit') OR (skip_reason IS NULL AND ((((outcome)::text = 'accepted'::text) AND (http_status = 202) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text) AND (workflow_run_id IS NOT NULL)) OR (((outcome)::text = 'replayed'::text) AND (http_status = 202) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'duplicate'::text) AND (workflow_run_id IS NOT NULL)) OR ((workflow_run_id IS NULL) AND ((((outcome)::text = 'authentication_failed'::text) AND (http_status = 401) AND ((((signature_check)::text = 'not_checked'::text) AND ((replay_check)::text = 'stale_timestamp'::text)) OR (((signature_check)::text = 'mismatch'::text) AND ((replay_check)::text = 'not_checked'::text)) OR (((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text)))) OR (((outcome)::text = 'invalid_request'::text) AND (http_status = 400) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'not_checked'::text)) OR (((outcome)::text = 'conflict'::text) AND (http_status = 409) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'conflict'::text)) OR (((outcome)::text = 'rate_limited'::text) AND (http_status = 429) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text)) OR (((outcome)::text = 'paused'::text) AND (http_status = 423) AND ((signature_check)::text = 'verified'::text) AND ((replay_check)::text = 'new'::text)))))))) IS TRUE`,
    ),
    check(
      'webhook_trigger_deliveries_retention_valid',
      sql`((expires_at >= (received_at + '89 days 23:59:59'::interval)) AND (expires_at <= (received_at + '90 days 00:00:01'::interval)))`,
    ),
    unique('webhook_trigger_deliveries_workspace_identity_unique').on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: 'webhook_trigger_deliveries_endpoint_fk',
      columns: [table.workspaceId, table.endpointId],
      foreignColumns: [
        webhookTriggerEndpoints.workspaceId,
        webhookTriggerEndpoints.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'webhook_trigger_deliveries_run_fk',
      columns: [table.workspaceId, table.workflowRunId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('restrict'),
    index('webhook_deliveries_retention_dry_run_idx').on(
      table.workspaceId,
      table.expiresAt,
      table.id,
    ),
    index('webhook_deliveries_run_retention_idx')
      .on(table.workspaceId, table.workflowRunId)
      .where(sql`(workflow_run_id IS NOT NULL)`),
    index('webhook_trigger_deliveries_expiry_idx').on(
      table.expiresAt,
      table.id,
    ),
    index('webhook_trigger_deliveries_endpoint_time_idx').on(
      table.workspaceId,
      table.endpointId,
      table.receivedAt.desc().nullsFirst(),
      table.id,
    ),
  ],
);

export const webhookEndpointIngressLimits = appSchema.table(
  'webhook_endpoint_ingress_limits',
  {
    endpointId: uuid('endpoint_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    bucketStartedAt: timestamp('bucket_started_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    requestCount: integer('request_count').notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'webhook_endpoint_ingress_limits_count_valid',
      sql`(request_count >= 1)`,
    ),
    foreignKey({
      name: 'webhook_endpoint_ingress_limits_endpoint_fk',
      columns: [table.workspaceId, table.endpointId],
      foreignColumns: [
        webhookTriggerEndpoints.workspaceId,
        webhookTriggerEndpoints.id,
      ],
    }).onDelete('cascade'),
  ],
);

export const webhookTriggerReplayRecords = appSchema.table(
  'webhook_trigger_replay_records',
  {
    workspaceId: uuid('workspace_id').notNull(),
    endpointId: uuid('endpoint_id').notNull(),
    dedupeKeyHash: char('dedupe_key_hash', { length: 64 }).notNull(),
    requestFingerprint: char('request_fingerprint', {
      length: 64,
    }).notNull(),
    deliveryId: uuid('delivery_id').notNull(),
    workflowRunId: uuid('workflow_run_id'),
    skipReason: varchar('skip_reason', { length: 32 }),
    coordinationEventId: uuid('coordination_event_id'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.workspaceId, table.coordinationEventId],
      foreignColumns: [
        triggerCoordinatedEvents.workspaceId,
        triggerCoordinatedEvents.id,
      ],
    }).onDelete('restrict'),
    check(
      'webhook_replay_skip_valid',
      sql`skip_reason IS NULL OR (skip_reason='concurrency_limit' AND workflow_run_id IS NULL)`,
    ),
    check(
      'webhook_trigger_replay_records_expiry_valid',
      sql`(expires_at > created_at)`,
    ),
    check(
      'webhook_trigger_replay_records_hashes_valid',
      sql`((dedupe_key_hash ~ '^[0-9a-f]{64}$'::text) AND (request_fingerprint ~ '^[0-9a-f]{64}$'::text))`,
    ),
    check(
      'webhook_trigger_replay_retention_valid',
      sql`((expires_at >= (created_at + '23:59:59'::interval)) AND (expires_at <= (created_at + '24:00:01'::interval)))`,
    ),
    primaryKey({
      name: 'webhook_trigger_replay_records_pkey',
      columns: [table.endpointId, table.dedupeKeyHash],
    }),
    // The baseline sets this foreign key DEFERRABLE INITIALLY DEFERRED.
    foreignKey({
      name: 'webhook_trigger_replay_records_delivery_fk',
      columns: [table.workspaceId, table.deliveryId],
      foreignColumns: [
        webhookTriggerDeliveries.workspaceId,
        webhookTriggerDeliveries.id,
      ],
    }),
    foreignKey({
      name: 'webhook_trigger_replay_records_endpoint_fk',
      columns: [table.workspaceId, table.endpointId],
      foreignColumns: [
        webhookTriggerEndpoints.workspaceId,
        webhookTriggerEndpoints.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'webhook_trigger_replay_records_run_fk',
      columns: [table.workspaceId, table.workflowRunId],
      foreignColumns: [workflowRuns.workspaceId, workflowRuns.id],
    }).onDelete('restrict'),
    index('webhook_replay_delivery_retention_idx')
      .on(table.workspaceId, table.deliveryId, table.expiresAt)
      .where(sql`(delivery_id IS NOT NULL)`),
    index('webhook_replay_retention_dry_run_idx').on(
      table.workspaceId,
      table.expiresAt,
      table.endpointId,
      table.dedupeKeyHash,
    ),
    index('webhook_replay_run_retention_idx')
      .on(table.workspaceId, table.workflowRunId)
      .where(sql`(workflow_run_id IS NOT NULL)`),
    index('webhook_trigger_replay_records_expiry_idx').on(
      table.expiresAt,
      table.endpointId,
    ),
  ],
);
