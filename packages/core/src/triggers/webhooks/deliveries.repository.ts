import type { CoordinatedEvent } from '@pertexo/contracts';
import { WORKFLOW_EDITOR_ROLES } from '@pertexo/workflow-model';
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { Pool, PoolClient } from 'pg';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
  withWorkspaceTransaction,
  type WorkspaceTransaction,
} from '@pertexo/database/primitives';
import {
  workflowTriggers,
  triggerCoordinatedEvents,
  webhookTriggerDeliveries as deliveries,
  webhookTriggerEndpoints as endpoints,
} from '@pertexo/database/schema';
import { COORDINATED_EVENT_METADATA } from '../coordination/history.queries.js';
import type {
  ListWebhookDeliveriesInput,
  RejectedWebhookDelivery,
  WebhookDeliveryEndpoint,
  WebhookDeliveryLog,
  WebhookDeliveryOutcome,
  WebhookDeliveryPage,
  WebhookDeliveryPosition,
  WebhookReplayCheck,
  WebhookSignatureCheck,
} from './contract.js';
import { HTTP_STATUS } from './delivery.js';

import { generatePersistedId } from '@pertexo/database/platform';
import { authorizeWorkflowResource } from '../../tenant-access/resources/authority.js';
import { WebhookTriggerNotFoundError } from './errors.js';
const DEFAULT_PAGE_LIMIT = 25;

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
        browsing: true,
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
    coordinationEventId?: string;
  }>,
): Promise<void> {
  await transaction.db.insert(deliveries).values({
    id: delivery.id ?? generatePersistedId(),
    workspaceId: transaction.workspaceId,
    endpointId: endpoint.endpointId,
    workflowRunId: delivery.runId ?? null,
    outcome: delivery.outcome,
    httpStatus: HTTP_STATUS[delivery.outcome],
    signatureCheck: delivery.signatureCheck,
    replayCheck: delivery.replayCheck,
    bodyBytes: delivery.bodyBytes,
    skipReason: delivery.outcome === 'skipped' ? 'concurrency_limit' : null,
    coordinationEventId: delivery.coordinationEventId ?? null,
  });
}

async function readDeliveryPage(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    endpointId: string;
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
        eq(deliveries.endpointId, input.endpointId),
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
      const workspaceId = input.workspaceId;
      const actorId = input.actorId;
      const workflowId = input.workflowId;
      const triggerId = input.triggerId;
      const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
      const after = input.after;
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
          // History follows the endpoint, so a trigger row of any version finds all of it.
          const trigger = await drizzle(client)
            .select({ endpointId: endpoints.id })
            .from(workflowTriggers)
            .leftJoin(
              endpoints,
              and(
                eq(endpoints.workspaceId, workflowTriggers.workspaceId),
                eq(endpoints.workflowId, workflowTriggers.workflowId),
                eq(endpoints.nodeId, workflowTriggers.nodeId),
              ),
            )
            .where(
              and(
                eq(workflowTriggers.workspaceId, workspaceId),
                eq(workflowTriggers.id, triggerId),
                eq(workflowTriggers.workflowId, workflowId),
                eq(workflowTriggers.kind, 'webhook'),
              ),
            )
            .catch(rethrowQueryFailure);
          const found = trigger[0];
          if (found === undefined) throw new WebhookTriggerNotFoundError();
          if (found.endpointId === null) return Object.freeze({ items: [] });
          return readDeliveryPage(client, {
            workspaceId,
            endpointId: found.endpointId,
            limit,
            after,
          });
        },
      );
    },
    recordRejectedDelivery: async (input: RejectedWebhookDelivery) => {
      const outcome = input.outcome;
      await withWorkspaceTransaction(
        pool,
        input.endpoint.workspaceId,
        (transaction) =>
          insertWebhookDelivery(transaction, input.endpoint, {
            outcome,
            signatureCheck: input.signatureCheck,
            replayCheck: input.replayCheck,
            bodyBytes: input.bodyBytes,
          }),
      );
    },
  });
}
