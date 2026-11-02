import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { generatePersistedId } from '@pertexo/database/platform';
import {
  canonicalOutboxPayloadChecksum,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import { outboxEvents } from '@pertexo/database/schema';
import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

/**
 * The one way a run gets advanced: a durable job in the writer's own transaction.
 * The outbox's recovery of a lost slot builds the same payload in SQL (queue claiming
 * stays in the database), and a test holds the two together.
 */
export async function enqueueAdvance(
  db: Pick<NodePgDatabase, 'insert'>,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    /** For a caller that records the job's id before writing it. */
    outboxEventId?: string;
    traceparent?: string | undefined;
    delaySeconds?: number;
  }>,
): Promise<string> {
  const { workspaceId, runId, traceparent, delaySeconds } = input;
  const outboxEventId = input.outboxEventId ?? generatePersistedId();
  const payload = {
    workspaceId,
    runId,
    outboxEventId,
    ...(traceparent === undefined ? {} : { traceparent }),
  };
  await db
    .insert(outboxEvents)
    .values({
      id: outboxEventId,
      workspaceId,
      jobName: 'advance-workflow-run',
      aggregateType: 'workflow-run',
      aggregateId: runId,
      payload,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
      ...(delaySeconds === undefined
        ? {}
        : {
            availableAt: sql`clock_timestamp()+make_interval(secs=>${delaySeconds})`,
          }),
    })
    .catch(rethrowQueryFailure);
  return outboxEventId;
}

/** Now, for work that's ready. */
export function wakeWorkflowRun(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  traceparent?: string,
): Promise<string> {
  return enqueueAdvance(drizzle(client), {
    workspaceId,
    runId,
    traceparent,
    delaySeconds: 0,
  });
}

/** In a moment, for a run that can't move until capacity frees up. */
export function deferWorkflowRun(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  traceparent?: string,
): Promise<string> {
  return enqueueAdvance(drizzle(client), {
    workspaceId,
    runId,
    traceparent,
    delaySeconds: 5,
  });
}
