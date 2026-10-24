import { WORKFLOW_EDITOR_ROLES } from '@pertexo/workflow-model';
import type { CoordinatedEvent } from '@pertexo/contracts';
import { COORDINATED_EVENT_METADATA_SQL } from '../coordination/history.queries.js';
import { sql } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { generatePersistedId } from '../../platform/persisted-id.js';
import {
  withTenantScopedClient,
  withWorkspaceTransaction,
  type WorkspaceTransaction,
} from '../../tenant-access/transactions.js';
import { authorizeWorkflowResource } from '../../tenant-access/resources/authority.js';
import { WebhookTriggerNotFoundError } from './errors.js';

/**
 * ADR 045: one metadata-only row per attributed webhook attempt. Each outcome
 * fixes the HTTP status the ingress returned; the migration's check
 * constraint binds the same pairs.
 */
const HTTP_STATUS = Object.freeze({
  accepted: 202,
  coordinated: 202,
  skipped: 202,
  replayed: 202,
  authentication_failed: 401,
  invalid_request: 400,
  conflict: 409,
  rate_limited: 429,
  paused: 423,
} as const);
const OUTCOMES = [
  'accepted',
  'coordinated',
  'skipped',
  'replayed',
  'authentication_failed',
  'invalid_request',
  'conflict',
  'rate_limited',
  'paused',
] as const satisfies readonly (keyof typeof HTTP_STATUS)[];
const SIGNATURE_CHECKS = ['verified', 'mismatch', 'not_checked'] as const;
const REPLAY_CHECKS = [
  'new',
  'duplicate',
  'conflict',
  'stale_timestamp',
  'not_checked',
] as const;
const DEFAULT_PAGE_LIMIT = 25;

export type WebhookDeliveryOutcome = (typeof OUTCOMES)[number];
export type WebhookSignatureCheck = (typeof SIGNATURE_CHECKS)[number];
export type WebhookReplayCheck = (typeof REPLAY_CHECKS)[number];

/** The resolved endpoint an attempt is attributed to. */
export type WebhookDeliveryEndpoint = Readonly<{
  workspaceId: string;
  triggerId: string;
  endpointId: string;
}>;

export type RejectedWebhookDelivery = Readonly<{
  endpoint: WebhookDeliveryEndpoint;
  outcome: Exclude<
    WebhookDeliveryOutcome,
    'accepted' | 'replayed' | 'skipped' | 'coordinated'
  >;
  signatureCheck: WebhookSignatureCheck;
  replayCheck: WebhookReplayCheck;
  bodyBytes: number;
}>;

export type WebhookDeliveryRecord = Readonly<{
  id: string;
  receivedAt: string;
  outcome: WebhookDeliveryOutcome;
  httpStatus: number;
  signatureCheck: WebhookSignatureCheck;
  replayCheck: WebhookReplayCheck;
  bodyBytes: number | null;
  runId: string | null;
  skipReason?: 'concurrency_limit';
  coordination?: CoordinatedEvent;
}>;

/** Newest-first keyset position: `(received_at desc, id asc)`. */
export type WebhookDeliveryPosition = Readonly<{
  receivedAt: string;
  id: string;
}>;

export type WebhookDeliveryPage = Readonly<{
  items: readonly WebhookDeliveryRecord[];
  nextCursor?: WebhookDeliveryPosition;
}>;

export type ListWebhookDeliveriesInput = Readonly<{
  workspaceId: string;
  actorId: string;
  workflowId: string;
  triggerId: string;
  limit?: number;
  after?: WebhookDeliveryPosition;
}>;

export interface WebhookDeliveryLog {
  listDeliveries(
    input: ListWebhookDeliveriesInput,
  ): Promise<WebhookDeliveryPage>;
  recordRejectedDelivery(input: RejectedWebhookDelivery): Promise<void>;
}

const uuidSchema = z.uuid();
const bodyBytesSchema = z
  .number()
  .int()
  .min(0)
  .max(256 * 1024);
const pageLimitSchema = z.number().int().positive().max(100);
const receivedAtSchema = z.iso
  .datetime({ precision: 6 })
  .refine((value) => !value.startsWith('0000-'), {
    message: 'PostgreSQL timestamps do not support year zero',
  });
const positionSchema = z
  .object({ receivedAt: receivedAtSchema, id: uuidSchema })
  .strict();
const rejectedOutcomeSchema = z.enum([
  'authentication_failed',
  'invalid_request',
  'conflict',
  'rate_limited',
  'paused',
]);

/** Owners, admins and builders of an active workspace read trigger state. */
export async function authorizeWebhookTriggerReader(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  workflowId: string,
): Promise<void> {
  if (
    !(await authorizeWorkflowResource(
      client,
      { workspaceId, actorId, workflowId },
      {
        capability: 'workflow:read',
        locking: false,
        roles: WORKFLOW_EDITOR_ROLES,
      },
    ))
  )
    throw new WebhookTriggerNotFoundError();
}

/** Writes one delivery row inside the caller's workspace transaction. */
export async function insertWebhookDelivery(
  transaction: WorkspaceTransaction,
  endpoint: WebhookDeliveryEndpoint,
  delivery: Readonly<{
    id?: string;
    outcome: WebhookDeliveryOutcome;
    signatureCheck: WebhookSignatureCheck;
    replayCheck: WebhookReplayCheck;
    bodyBytes: number;
    runId?: string;
    dedupeKind?: 'keyed' | 'fingerprint';
    coordinationEventId?: string;
  }>,
): Promise<void> {
  await transaction.db.execute(sql`
    insert into app.webhook_trigger_deliveries
      (id,workspace_id,trigger_id,endpoint_id,workflow_run_id,dedupe_kind,
       outcome,http_status,signature_check,replay_check,body_bytes,skip_reason,coordination_event_id)
    values(${delivery.id ?? generatePersistedId()},${transaction.workspaceId},
      ${uuidSchema.parse(endpoint.triggerId)},${uuidSchema.parse(endpoint.endpointId)},
      ${delivery.runId ?? null},${delivery.dedupeKind ?? null},${delivery.outcome},
      ${HTTP_STATUS[delivery.outcome]},${delivery.signatureCheck},
      ${delivery.replayCheck},${bodyBytesSchema.parse(delivery.bodyBytes)},${delivery.outcome === 'skipped' ? 'concurrency_limit' : null},${delivery.coordinationEventId ?? null})
  `);
}

function mapDelivery(row: Record<string, unknown>): WebhookDeliveryRecord {
  const outcome = z.enum(OUTCOMES).parse(row.outcome);
  return Object.freeze({
    id: uuidSchema.parse(row.id),
    receivedAt: receivedAtSchema.parse(row.received_at_cursor),
    outcome,
    httpStatus: z.literal(HTTP_STATUS[outcome]).parse(row.http_status),
    signatureCheck: z.enum(SIGNATURE_CHECKS).parse(row.signature_check),
    replayCheck: z.enum(REPLAY_CHECKS).parse(row.replay_check),
    bodyBytes: bodyBytesSchema.nullable().parse(row.body_bytes),
    runId: uuidSchema.nullable().parse(row.workflow_run_id),
    ...(row.coordination === null || row.coordination === undefined
      ? {}
      : { coordination: row.coordination as CoordinatedEvent }),
    ...(outcome === 'skipped'
      ? { skipReason: z.literal('concurrency_limit').parse(row.skip_reason) }
      : {}),
  });
}

async function readDeliveryPage(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    triggerId: string;
    limit: number;
    after: WebhookDeliveryPosition | undefined;
  }>,
): Promise<WebhookDeliveryPage> {
  // Rows past their ADR 013 expiry are never served, even before the bounded
  // retention stage removes them.
  const result = await client.query<Record<string, unknown>>(
    `select delivery.id,delivery.outcome,delivery.http_status,delivery.signature_check,delivery.replay_check,delivery.body_bytes,delivery.skip_reason,
            coalesce(delivery.workflow_run_id,event.run_id) workflow_run_id,
            case when event.id is null then null else ${COORDINATED_EVENT_METADATA_SQL} end coordination,
            to_char(delivery.received_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') received_at_cursor
       from app.webhook_trigger_deliveries delivery
       left join app.trigger_coordinated_events event on event.workspace_id=delivery.workspace_id and event.id=delivery.coordination_event_id and event.expires_at>clock_timestamp()
      where delivery.workspace_id=$1 and delivery.trigger_id=$2 and delivery.expires_at>clock_timestamp()
        and ($3::timestamptz is null or delivery.received_at<$3::timestamptz
          or (delivery.received_at=$3::timestamptz and delivery.id>$4::uuid))
      order by delivery.received_at desc,delivery.id asc
      limit $5`,
    [
      input.workspaceId,
      input.triggerId,
      input.after?.receivedAt ?? null,
      input.after?.id ?? null,
      input.limit + 1,
    ],
  );
  const items = Object.freeze(
    result.rows.slice(0, input.limit).map(mapDelivery),
  );
  const last = items.at(-1);
  return Object.freeze({
    items,
    ...(result.rows.length > input.limit && last !== undefined
      ? {
          nextCursor: Object.freeze({
            receivedAt: last.receivedAt,
            id: last.id,
          }),
        }
      : {}),
  });
}

export function createWebhookDeliveryLog(pool: Pool): WebhookDeliveryLog {
  return Object.freeze({
    listDeliveries: (input: ListWebhookDeliveriesInput) => {
      const workspaceId = uuidSchema.parse(input.workspaceId);
      const actorId = uuidSchema.parse(input.actorId);
      const workflowId = uuidSchema.parse(input.workflowId);
      const triggerId = uuidSchema.parse(input.triggerId);
      const limit = pageLimitSchema.parse(input.limit ?? DEFAULT_PAGE_LIMIT);
      const after =
        input.after === undefined
          ? undefined
          : positionSchema.parse(input.after);
      return withTenantScopedClient(
        pool,
        { workspaceId, actorId },
        async (client) => {
          await authorizeWebhookTriggerReader(
            client,
            workspaceId,
            actorId,
            workflowId,
          );
          const trigger = await client.query(
            `select 1 from app.workflow_triggers
              where workspace_id=$1 and id=$2 and workflow_id=$3
                and kind='webhook'`,
            [workspaceId, triggerId, workflowId],
          );
          if (trigger.rowCount !== 1) throw new WebhookTriggerNotFoundError();
          return readDeliveryPage(client, {
            workspaceId,
            triggerId,
            limit,
            after,
          });
        },
      );
    },
    recordRejectedDelivery: async (input: RejectedWebhookDelivery) => {
      const outcome = rejectedOutcomeSchema.parse(input.outcome);
      await withWorkspaceTransaction(
        pool,
        uuidSchema.parse(input.endpoint.workspaceId),
        (transaction) =>
          insertWebhookDelivery(transaction, input.endpoint, {
            outcome,
            signatureCheck: z
              .enum(SIGNATURE_CHECKS)
              .parse(input.signatureCheck),
            replayCheck: z.enum(REPLAY_CHECKS).parse(input.replayCheck),
            bodyBytes: input.bodyBytes,
          }),
      );
    },
  });
}
