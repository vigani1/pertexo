import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { workspaceInboxFailureDays as days } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

/** The run/checkpoint transaction is the idempotency fence for this increment. */
export async function recordInboxFailureDay(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    workflowId: string;
    completedAt: string;
  }>,
) {
  await drizzle(client)
    .insert(days)
    .values({
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      day: sql`(${input.completedAt}::timestamptz at time zone 'UTC')::date`,
      count: 1n,
    })
    .onConflictDoUpdate({
      target: [days.workspaceId, days.workflowId, days.day],
      set: { count: sql`${days.count}+1` },
    })
    .catch(rethrowQueryFailure);
}
