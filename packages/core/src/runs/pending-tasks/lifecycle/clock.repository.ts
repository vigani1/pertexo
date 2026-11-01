import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import { workflowRuns, workflowCalls } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

export async function pauseHumanWait(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; runId: string }>,
) {
  const db = drizzle(client),
    r = workflowRuns;
  await db
    .execute(
      sql`select app.lock_workspace_execution_counter(${input.workspaceId})`,
    )
    .catch(rethrowQueryFailure);
  const update = db
    .update(r)
    .set({
      humanWaitStartedAt: sql`observed.time`,
      remainingExecutionMs: sql`case when ${r.deadlineAt} is null or ${r.deadlineAt} is not distinct from ${r.absoluteDeadlineAt} then null else ceil(extract(epoch from (${r.deadlineAt}-observed.time))*1000)::integer end`,
      deadlineAt: r.absoluteDeadlineAt,
      deadlineWakeupAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .from(sql`observed`)
    .where(
      and(
        eq(r.workspaceId, input.workspaceId),
        eq(r.id, input.runId),
        isNull(r.humanWaitStartedAt),
        or(isNull(r.deadlineAt), sql`${r.deadlineAt}>observed.time`),
      ),
    );
  // Keep one materialized post-lock clock observation; the update itself uses the builder.
  await db
    .execute(
      sql`with observed as materialized (select clock_timestamp() time) ${update.getSQL()}`,
    )
    .catch(rethrowQueryFailure);
}
export async function resumeHumanWait(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; runId: string }>,
) {
  const db = drizzle(client),
    r = workflowRuns,
    c = workflowCalls;
  const incoming = alias(workflowCalls, 'incoming'),
    parent = alias(workflowRuns, 'parent');
  const parentDeadline = db
    .select({ deadline: sql<Date | null>`min(${parent.deadlineAt})` })
    .from(incoming)
    .innerJoin(
      parent,
      and(
        eq(parent.workspaceId, incoming.workspaceId),
        eq(parent.id, incoming.parentRunId),
      ),
    )
    .where(
      and(
        eq(incoming.workspaceId, input.workspaceId),
        eq(incoming.childRunId, input.runId),
        eq(incoming.status, 'accepted'),
      ),
    );
  // Declared sibling calls share the paused budget; a previously expired deadline stays expired.
  await db
    .update(c)
    .set({
      deadlineAt: sql`least(${c.deadlineAt}+(clock_timestamp()-${r.humanWaitStartedAt}),${r.absoluteDeadlineAt},case when ${r.remainingExecutionMs} is null then null else clock_timestamp()+${r.remainingExecutionMs}*interval '1 millisecond' end,(${parentDeadline}))`,
    })
    .from(r)
    .where(
      and(
        eq(r.workspaceId, input.workspaceId),
        eq(r.id, input.runId),
        eq(c.workspaceId, r.workspaceId),
        eq(c.parentRunId, r.id),
        eq(c.status, 'pending'),
        sql`${c.deadlineAt}>${r.humanWaitStartedAt}`,
      ),
    )
    .catch(rethrowQueryFailure);
  await db
    .update(r)
    .set({
      humanWaitStartedAt: null,
      deadlineAt: sql`least(${r.absoluteDeadlineAt},case when ${r.remainingExecutionMs} is null then null else clock_timestamp()+${r.remainingExecutionMs}*interval '1 millisecond' end,(${parentDeadline}))`,
      deadlineWakeupAt: null,
      remainingExecutionMs: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(and(eq(r.workspaceId, input.workspaceId), eq(r.id, input.runId)))
    .catch(rethrowQueryFailure);
}
