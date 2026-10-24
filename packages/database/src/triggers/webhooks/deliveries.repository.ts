import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { webhookTriggerDeliveries as deliveries } from '../../schema/triggers/deliveries.js';
import { triggerCoordinatedEvents } from '../../schema/event-coordination/records.js';
import { workflowTriggers } from '../../schema/authoring/workflows.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { WORKFLOW_EDITOR_ROLES } from '@pertexo/workflow-model';
import type { CoordinatedEvent } from '@pertexo/contracts';
import { COORDINATED_EVENT_METADATA } from '../coordination/history.queries.js';
import { and, desc, eq, sql } from 'drizzle-orm';
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
const SIGNATURE_CHECKS = ['verified', 'mismatch', 'not_checked'] as const;
const REPLAY_CHECKS = [
  'new',
  'duplicate',
  'conflict',
  'stale_timestamp',
  'not_checked',
] as const;
const DEFAULT_PAGE_LIMIT = 25;

export type WebhookDeliveryOutcome = keyof typeof HTTP_STATUS;
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
  await transaction.db.insert(deliveries).values({
    id: delivery.id ?? generatePersistedId(),
    workspaceId: transaction.workspaceId,
    triggerId: uuidSchema.parse(endpoint.triggerId),
    endpointId: uuidSchema.parse(endpoint.endpointId),
    workflowRunId: delivery.runId ?? null,
    dedupeKind: delivery.dedupeKind ?? null,
    outcome: delivery.outcome,
    httpStatus: HTTP_STATUS[delivery.outcome],
    signatureCheck: delivery.signatureCheck,
    replayCheck: delivery.replayCheck,
    bodyBytes: bodyBytesSchema.parse(delivery.bodyBytes),
    skipReason: delivery.outcome === 'skipped' ? 'concurrency_limit' : null,
    coordinationEventId: delivery.coordinationEventId ?? null,
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
  const event = alias(triggerCoordinatedEvents, 'event');
  const result = await drizzle(client)
    .select({
      id: deliveries.id,
      outcome: deliveries.outcome,
      httpStatus: deliveries.httpStatus,
      signatureCheck: deliveries.signatureCheck,
      replayCheck: deliveries.replayCheck,
      bodyBytes: deliveries.bodyBytes,
      runId: sql<
        string | null
      >`coalesce(${deliveries.workflowRunId},${event.runId})`,
      coordination: sql<CoordinatedEvent | null>`case when ${event.id} is null then null else ${COORDINATED_EVENT_METADATA} end`,
      receivedAt: sql<string>`to_char(${deliveries.receivedAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(deliveries)
    .leftJoin(
      event,
      and(
        eq(event.workspaceId, deliveries.workspaceId),
        eq(event.id, deliveries.coordinationEventId),
        sql`${event.expiresAt}>clock_timestamp()`,
      ),
    )
    .where(
      and(
        eq(deliveries.workspaceId, input.workspaceId),
        eq(deliveries.triggerId, input.triggerId),
        sql`${deliveries.expiresAt}>clock_timestamp()`,
        sql`(${input.after?.receivedAt ?? null}::timestamptz is null or ${deliveries.receivedAt}<${input.after?.receivedAt ?? null}::timestamptz or
        (${deliveries.receivedAt}=${input.after?.receivedAt ?? null}::timestamptz and ${deliveries.id}>${input.after?.id ?? null}::uuid))`,
      ),
    )
    .orderBy(desc(deliveries.receivedAt), deliveries.id)
    .limit(input.limit + 1)
    .catch(rethrowQueryFailure);
  const items = Object.freeze(
    result.slice(0, input.limit).map(({ coordination, ...row }) =>
      Object.freeze({
        ...row,
        ...(coordination === null ? {} : { coordination }),
        ...(row.outcome === 'skipped'
          ? { skipReason: 'concurrency_limit' as const }
          : {}),
      }),
    ),
  );
  const last = items.at(-1);
  return Object.freeze({
    items,
    ...(result.length > input.limit && last !== undefined
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
          const trigger = await drizzle(client)
            .select({ one: sql`1` })
            .from(workflowTriggers)
            .where(
              and(
                eq(workflowTriggers.workspaceId, workspaceId),
                eq(workflowTriggers.id, triggerId),
                eq(workflowTriggers.workflowId, workflowId),
                eq(workflowTriggers.kind, 'webhook'),
              ),
            )
            .catch(rethrowQueryFailure);
          if (trigger.length !== 1) throw new WebhookTriggerNotFoundError();
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
