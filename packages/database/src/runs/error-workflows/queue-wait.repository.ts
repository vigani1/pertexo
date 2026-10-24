import { runErrorWorkflowIntents } from '../../schema/runs/completion/error-workflow.js';
import { outboxEvents } from '../../schema/transport.js';
import { and, asc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { canonicalOutboxPayloadChecksum } from '../../outbox/events.repository.js';
import {
  ErrorWorkflowDeliveryMismatchError,
  type ErrorWorkflowDeliveryInput,
} from './contract.js';

const waitSeconds = 15 * 60;

/** The locked intent and claimed receipt make replacement delivery atomic. */
export async function deferErrorWorkflowForQueue(
  client: PoolClient,
  input: ErrorWorkflowDeliveryInput,
): Promise<boolean> {
  const db = drizzle(client);
  // The update sets a non-null expiry; the column decoder preserves the public Date values.
  const [observation] = await db
    .update(runErrorWorkflowIntents)
    .set({
      queueWaitExpiresAt: sql`coalesce(${runErrorWorkflowIntents.queueWaitExpiresAt},clock_timestamp()+make_interval(secs=>${waitSeconds}))`,
    })
    .where(
      and(
        eq(runErrorWorkflowIntents.workspaceId, input.workspaceId),
        eq(runErrorWorkflowIntents.sourceRunId, input.sourceRunId),
        eq(runErrorWorkflowIntents.status, 'pending'),
      ),
    )
    .returning({
      expires_at:
        sql<Date>`${runErrorWorkflowIntents.queueWaitExpiresAt}`.mapWith(
          runErrorWorkflowIntents.queueWaitExpiresAt,
        ),
      now: sql<Date>`clock_timestamp()`.mapWith(
        runErrorWorkflowIntents.queueWaitExpiresAt,
      ),
    })
    .catch(rethrowQueryFailure);
  if (observation === undefined) throw new ErrorWorkflowDeliveryMismatchError();
  if (observation.expires_at <= observation.now) return false;
  const outboxEventId = generatePersistedId();
  const payload = {
    workspaceId: input.workspaceId,
    sourceRunId: input.sourceRunId,
    outboxEventId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  };
  await db
    .insert(outboxEvents)
    .values({
      id: outboxEventId,
      workspaceId: input.workspaceId,
      jobName: 'start-error-workflow',
      aggregateType: 'workflow-run',
      aggregateId: input.sourceRunId,
      payload,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
      availableAt: observation.expires_at,
    })
    .catch(rethrowQueryFailure);
  const updated = await db
    .update(runErrorWorkflowIntents)
    .set({ outboxEventId })
    .where(
      and(
        eq(runErrorWorkflowIntents.workspaceId, input.workspaceId),
        eq(runErrorWorkflowIntents.sourceRunId, input.sourceRunId),
        eq(runErrorWorkflowIntents.outboxEventId, input.outboxEventId),
      ),
    )
    .returning({ id: runErrorWorkflowIntents.sourceRunId })
    .catch(rethrowQueryFailure);
  if (updated.length !== 1) throw new ErrorWorkflowDeliveryMismatchError();
  return true;
}

/** The run transition holds the execution counter until these wakeups commit. */
export async function wakeErrorWorkflowsForCapacity(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  const db = drizzle(client);
  const ready = db.$with('ready').as(
    db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .innerJoin(
        runErrorWorkflowIntents,
        and(
          eq(runErrorWorkflowIntents.workspaceId, outboxEvents.workspaceId),
          eq(runErrorWorkflowIntents.outboxEventId, outboxEvents.id),
        ),
      )
      .where(
        and(
          eq(runErrorWorkflowIntents.workspaceId, workspaceId),
          eq(runErrorWorkflowIntents.status, 'pending'),
          gt(
            runErrorWorkflowIntents.queueWaitExpiresAt,
            sql`clock_timestamp()`,
          ),
          gt(outboxEvents.availableAt, sql`clock_timestamp()`),
          isNull(outboxEvents.publishedAt),
          isNull(outboxEvents.failedAt),
          or(
            isNull(outboxEvents.leaseExpiresAt),
            lte(outboxEvents.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        ),
      )
      .orderBy(
        asc(runErrorWorkflowIntents.createdAt),
        asc(runErrorWorkflowIntents.sourceRunId),
      )
      .limit(100),
  );
  await db
    .with(ready)
    .update(outboxEvents)
    .set({
      availableAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .from(ready)
    .where(
      and(
        eq(outboxEvents.workspaceId, workspaceId),
        eq(outboxEvents.id, ready.id),
      ),
    )
    .catch(rethrowQueryFailure);
}
