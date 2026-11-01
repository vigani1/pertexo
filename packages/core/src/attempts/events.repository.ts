import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { runEvents } from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  serializeStoredExecutionJsonValue,
} from '@pertexo/database/primitives';
import { NodeAttemptStateCorruptError } from './errors.js';

/** The caller holds the run lock, so its next event sequence cannot race. */
export async function appendAttemptEvent(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    type: string;
    payload: unknown;
  }>,
): Promise<number> {
  const db = drizzle(client);
  const rows = await db
    .select({
      sequence: sql<number>`coalesce(max(${runEvents.sequence}),0)::int+1`,
    })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.workspaceId, input.workspaceId),
        eq(runEvents.workflowRunId, input.runId),
      ),
    )
    .catch(rethrowQueryFailure);
  const sequence = rows[0]?.sequence;
  if (sequence === undefined) throw new NodeAttemptStateCorruptError();
  await db
    .insert(runEvents)
    .values({
      workspaceId: input.workspaceId,
      workflowRunId: input.runId,
      sequence,
      type: input.type,
      payload: sql`${serializeStoredExecutionJsonValue(input.payload)}::jsonb`,
    })
    .catch(rethrowQueryFailure);
  return sequence;
}
