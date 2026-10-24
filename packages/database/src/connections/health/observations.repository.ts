import type { ConnectionHealthApplicationResult } from './contract.js';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  connectionHealthObservations as observations,
  nodeAttemptConnectionDispatches as dispatches,
  connections,
  connectionEvents,
} from '../../schema/connections.js';
import { nodeAttempts } from '../../schema/runs/execution.js';
import { outboxEvents } from '../../schema/transport.js';
import { z } from 'zod';

import type { WorkspaceDatabase } from '../../database.js';
import { sha256HexSchema } from '../../platform/persisted-primitives.js';
import {
  consumeInboxMessage,
  InboxReceiptUnavailableError,
} from '../../outbox/receipts.js';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.js';

const payloadSchema = z
  .object({
    workspaceId: z.uuid(),
    outboxEventId: z.uuid(),
    observationId: z.uuid(),
    traceparent: z
      .string()
      .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
      .optional(),
  })
  .strict();
const inputSchema = z
  .object({
    workspaceId: z.uuid(),
    observationId: z.uuid(),
    delivery: z
      .object({ outboxEventId: z.uuid(), payloadChecksum: sha256HexSchema })
      .strict(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();

type Transaction = Parameters<
  Parameters<typeof consumeInboxMessage>[2]['operation']
>[0];

/**
 * Applies one run's observation once. Only an observation about the exact
 * connection secret and health revision the attempt dispatched with,
 * after the attempt ended, changes the connection: a healthy one refreshes
 * it, any other marks it as needing reauthorization.
 */
async function applyObservation(
  transaction: Transaction,
  input: z.output<typeof inputSchema>,
): Promise<boolean> {
  const workspaceId = transaction.workspaceId;
  const db = transaction.db;
  const source = and(
    eq(observations.workspaceId, workspaceId),
    eq(observations.id, input.observationId),
  );
  const [observation] = await db
    .select({
      attempt_id: observations.attemptId,
      kind: observations.kind,
      reason_code: observations.reasonCode,
      observed_at: observations.observedAt,
      outbox_event_id: observations.outboxEventId,
      applied: sql<boolean>`${observations.appliedAt} is not null`,
    })
    .from(observations)
    .where(source)
    .for('update');
  if (observation === undefined || observation.applied) return false;
  if (observation.outbox_event_id !== input.delivery.outboxEventId)
    throw new InboxReceiptUnavailableError();
  const [dispatch] = await db
    .select({
      connection_id: dispatches.connectionId,
      secret_version_id: dispatches.secretVersionId,
      health_revision: sql<string>`${dispatches.healthRevision}::text`,
    })
    .from(dispatches)
    .where(
      and(
        eq(dispatches.workspaceId, workspaceId),
        eq(dispatches.attemptId, observation.attempt_id),
      ),
    );
  if (dispatch === undefined) return false;
  await db
    .update(observations)
    .set({ appliedAt: sql`clock_timestamp()` })
    .where(source);
  const predicate = and(
    eq(connections.workspaceId, workspaceId),
    eq(connections.id, dispatch.connection_id),
  );
  const [connection] = await db
    .select({
      status: connections.status,
      current_secret_version_id: connections.currentSecretVersionId,
      health_revision: sql<string>`${connections.healthRevision}::text`,
      provider_key: connections.providerKey,
      auth_type: connections.authType,
    })
    .from(connections)
    .where(predicate)
    .for('update');
  const staleObservation =
    connection === undefined ||
    connection.status === 'revoked' ||
    connection.current_secret_version_id !== dispatch.secret_version_id ||
    connection.health_revision !== dispatch.health_revision ||
    connection.provider_key !== 'slack' ||
    connection.auth_type !== 'slack_bot_token';
  if (staleObservation) return false;
  const ended = await db
    .select({ id: nodeAttempts.id })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.workspaceId, workspaceId),
        eq(nodeAttempts.id, observation.attempt_id),
        isNotNull(nodeAttempts.dispatchMarkedAt),
        inArray(nodeAttempts.status, [
          'succeeded',
          'failed',
          'canceled',
          'timed_out',
          'outcome_unknown',
        ]),
      ),
    );
  if (ended.length !== 1) return false;
  if (observation.kind === 'healthy') {
    if (connection.status !== 'active') return false;
    await db
      .update(connections)
      .set({
        lastHealthyAt: sql`greatest(${connections.lastHealthyAt},${observation.observed_at}::timestamptz)`,
        lastRunObservedAt: sql`greatest(${connections.lastRunObservedAt},${observation.observed_at}::timestamptz)`,
        lastErrorCode: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(predicate);
    return true;
  }
  await db
    .update(connections)
    .set({
      status: 'reauthorization_required',
      healthRevision: sql`${connections.healthRevision}+1`,
      lastErrorCode: observation.reason_code,
      lastRunObservedAt: sql`${observation.observed_at}::timestamptz`,
      lastHealthTransitionAt: sql`clock_timestamp()`,
      lastHealthTransitionSource: 'run',
      updatedAt: sql`clock_timestamp()`,
    })
    .where(predicate);
  await db.insert(connectionEvents).values({
    id: input.observationId,
    workspaceId,
    connectionId: dispatch.connection_id,
    eventType: 'connection.reauthorization_required',
    actorKind: 'worker',
    actorId: 'connection-health-worker',
    metadata: {
      source: 'run',
      status: 'reauthorization_required',
      reasonCode: observation.reason_code,
    },
  });
  return true;
}

/** Consumes persisted IDs, never a caller-chosen connection/status/reason. */
export async function applyConnectionHealthObservation(
  database: WorkspaceDatabase,
  input: Readonly<z.input<typeof inputSchema>>,
): Promise<ConnectionHealthApplicationResult> {
  const parsed = inputSchema.parse(input);
  parsed.signal?.throwIfAborted();
  const consumed = await consumeInboxMessage(database, parsed.workspaceId, {
    message: {
      consumerName: 'connection-health-worker',
      messageId: parsed.delivery.outboxEventId,
      payloadChecksum: parsed.delivery.payloadChecksum,
    },
    operation: async (transaction) => {
      const [row] = await transaction.db
        .select({
          aggregate_id: outboxEvents.aggregateId,
          aggregate_type: outboxEvents.aggregateType,
          job_name: outboxEvents.jobName,
          payload: outboxEvents.payload,
          payload_checksum: outboxEvents.payloadChecksum,
        })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.workspaceId, transaction.workspaceId),
            eq(outboxEvents.id, parsed.delivery.outboxEventId),
          ),
        );
      if (row === undefined) {
        const remaining = await transaction.db
          .select({ id: observations.id })
          .from(observations)
          .where(
            and(
              eq(observations.workspaceId, transaction.workspaceId),
              eq(observations.id, parsed.observationId),
            ),
          );
        if (remaining.length !== 0) throw new InboxReceiptUnavailableError();
        // Retention deletes source evidence and its command together. A delayed
        // delivery cannot resurrect either or modify a connection.
        return false;
      }
      const payload = payloadSchema.safeParse(row.payload);
      const invalidDelivery =
        !payload.success ||
        row.aggregate_id !== parsed.observationId ||
        row.aggregate_type !== 'connection-health-observation' ||
        row.job_name !== 'apply-connection-health-observation' ||
        row.payload_checksum !== parsed.delivery.payloadChecksum ||
        canonicalOutboxPayloadChecksum(payload.data) !== row.payload_checksum ||
        payload.data.workspaceId !== transaction.workspaceId ||
        payload.data.outboxEventId !== parsed.delivery.outboxEventId ||
        payload.data.observationId !== parsed.observationId;
      if (invalidDelivery) throw new InboxReceiptUnavailableError();
      return applyObservation(transaction, parsed);
    },
    options: {
      lockWorkspace: true,
      ...(parsed.signal === undefined ? {} : { signal: parsed.signal }),
    },
  });
  if (consumed.status === 'duplicate')
    return Object.freeze({ kind: 'duplicate' });
  return Object.freeze({ kind: consumed.value ? 'applied' : 'stale' });
}
