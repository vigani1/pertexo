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
  const row = advanceOutboxRow(input);
  await db.insert(outboxEvents).values(row).catch(rethrowQueryFailure);
  return row.id;
}

/** Batch writers retain the same durable payload and checksum as one-run wakeups. */
export async function enqueueAdvances(
  db: Pick<NodePgDatabase, 'insert'>,
  input: Readonly<{ workspaceId: string; runIds: readonly string[] }>,
): Promise<void> {
  if (input.runIds.length === 0) return;
  await db
    .insert(outboxEvents)
    .values(
      input.runIds.map((runId) =>
        advanceOutboxRow({ workspaceId: input.workspaceId, runId }),
      ),
    )
    .catch(rethrowQueryFailure);
}

function advanceOutboxRow(input: Parameters<typeof enqueueAdvance>[1]) {
  const { workspaceId, runId, traceparent, delaySeconds } = input;
  const id = input.outboxEventId ?? generatePersistedId();
  const payload = {
    workspaceId,
    runId,
    outboxEventId: id,
    ...(traceparent === undefined ? {} : { traceparent }),
  };
  return {
    id,
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
  };
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
