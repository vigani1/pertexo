import { WORKSPACE_INBOX_FAILURE_KINDS } from './threads/workspace-inbox-thread.js';
import { and, eq, sql } from 'drizzle-orm';
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

/** Deletion already owns each run; daily rows follow in deterministic key order. */
export async function removeInboxFailureDays(
  client: PoolClient,
  removed: readonly Readonly<{
    workspaceId: string;
    workflowId: string;
    day: string | null;
    status: string;
    triggerType: string;
  }>[],
) {
  const groups = new Map<
    string,
    { workspaceId: string; workflowId: string; day: string; count: bigint }
  >();
  for (const run of removed) {
    if (
      run.triggerType === 'test' ||
      run.day === null ||
      !new Set<string>(WORKSPACE_INBOX_FAILURE_KINDS).has(run.status)
    )
      continue;
    const key = `${run.workspaceId}:${run.workflowId}:${run.day}`;
    const group = groups.get(key) ?? { ...run, day: run.day, count: 0n };
    group.count++;
    groups.set(key, group);
  }
  const db = drizzle(client);
  for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const scope = and(
      eq(days.workspaceId, group.workspaceId),
      eq(days.workflowId, group.workflowId),
      eq(days.day, group.day),
    );
    const [row] = await db
      .select({ count: days.count })
      .from(days)
      .where(scope)
      .for('update')
      .catch(rethrowQueryFailure);
    // Rows outside the displayed window may already have been pruned.
    if (row === undefined) continue;
    if (row.count <= group.count)
      await db.delete(days).where(scope).catch(rethrowQueryFailure);
    else
      await db
        .update(days)
        .set({ count: row.count - group.count })
        .where(scope)
        .catch(rethrowQueryFailure);
  }
}
