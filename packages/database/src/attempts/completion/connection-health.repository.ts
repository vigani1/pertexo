import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  connectionHealthObservations,
  nodeAttemptConnectionDispatches,
} from '../../schema/connections.js';
import { outboxEvents } from '../../schema/transport.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import type { z } from 'zod';

import { generatePersistedId } from '../../platform/persisted-id.js';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.repository.js';
import { serializeStoredExecutionJsonValue } from '../../platform/stored-execution-value.js';
import {
  type completionSchema,
  NodeAttemptStateCorruptError,
} from '../contract.js';

type CompletionInput = z.output<typeof completionSchema>;

/** Completion replay compares evidence; absence is a meaningful identity too. */
export async function assertConnectionHealthReplay(
  client: PoolClient,
  input: CompletionInput,
): Promise<void> {
  const result = await drizzle(client)
    .select({
      kind: connectionHealthObservations.kind,
      reasonCode: connectionHealthObservations.reasonCode,
    })
    .from(connectionHealthObservations)
    .where(
      and(
        eq(connectionHealthObservations.workspaceId, input.lease.workspaceId),
        eq(connectionHealthObservations.attemptId, input.lease.attemptId),
      ),
    )
    .catch(rethrowQueryFailure);
  const actual = result[0];
  const expected = input.connectionHealthObservation;
  if (actual === undefined && expected === undefined) return;
  if (actual === undefined || expected === undefined)
    throw new NodeAttemptStateCorruptError();
  if (
    actual.kind !== expected.kind ||
    actual.reasonCode !==
      (expected.kind === 'healthy' ? null : expected.reasonCode)
  )
    throw new NodeAttemptStateCorruptError();
}

/** Called only after the owned lease is accepted, in its outcome transaction. */
export async function persistConnectionHealthObservation(
  client: PoolClient,
  input: CompletionInput,
): Promise<void> {
  const observation = input.connectionHealthObservation;
  if (observation === undefined) return;
  const observationId = generatePersistedId();
  const outboxEventId = generatePersistedId();
  // Only an attempt that dispatched with a recorded connection can report on it.
  const db = drizzle(client);
  const dispatch = nodeAttemptConnectionDispatches;
  const recorded = await db
    .insert(connectionHealthObservations)
    .select(
      db
        .select({
          id: sql<string>`${observationId}`.as('id'),
          workspaceId: dispatch.workspaceId,
          attemptId: dispatch.attemptId,
          kind: sql<string>`${observation.kind}`.as('kind'),
          reasonCode: sql<
            string | null
          >`${observation.kind === 'healthy' ? null : observation.reasonCode}`.as(
            'reason_code',
          ),
          outboxEventId: sql<string>`${outboxEventId}`.as('outbox_event_id'),
          observedAt: sql<string>`clock_timestamp()`.as('observed_at'),
          appliedAt: sql<null>`null`.as('applied_at'),
        })
        .from(dispatch)
        .where(
          and(
            eq(dispatch.workspaceId, input.lease.workspaceId),
            eq(dispatch.attemptId, input.lease.attemptId),
            eq(dispatch.workerId, input.lease.workerId),
            eq(dispatch.fenceToken, input.lease.fenceToken),
          ),
        ),
    )
    .returning({ id: connectionHealthObservations.id })
    .catch(rethrowQueryFailure);
  if (recorded.length !== 1) throw new NodeAttemptStateCorruptError();
  const payload = {
    workspaceId: input.lease.workspaceId,
    outboxEventId,
    observationId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  };
  await db
    .insert(outboxEvents)
    .values({
      id: outboxEventId,
      workspaceId: input.lease.workspaceId,
      jobName: 'apply-connection-health-observation',
      aggregateType: 'connection-health-observation',
      aggregateId: observationId,
      payload: sql`${serializeStoredExecutionJsonValue(payload)}::jsonb`,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
    })
    .catch(rethrowQueryFailure);
}
