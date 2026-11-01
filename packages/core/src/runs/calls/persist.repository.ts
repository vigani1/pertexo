import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { workflowCalls, nodeRuns } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { CoordinatorRunStateCorruptError } from '../state-errors.js';
import {
  terminalRunStatuses,
  type RunTransitionPlan,
} from '../advance/plan.js';
import { wakeWorkflowRun } from './wakeup.repository.js';

/** Child facts never take the existing parent's run or checkpoint lock. */
export async function persistCallCompletion(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    plan: RunTransitionPlan;
    traceparent?: string;
  }>,
): Promise<void> {
  if (
    !input.plan.events.some(
      ({ name }) =>
        name.startsWith('run.') && terminalRunStatuses.has(name.slice(4)),
    )
  )
    return;
  const failure = input.plan.events.find(
    ({ name }) => name === `run.${input.plan.checkpoint.runStatus}`,
  )?.reasonCode;
  const c = workflowCalls;
  // The terminal run event guards this assignment; the original table CHECK still rejects inconsistent plans.
  const rows = await drizzle(client)
    .update(c)
    .set({
      status: sql`${input.plan.checkpoint.runStatus}`,
      resultRef: sql`${input.plan.runResult === undefined ? null : JSON.stringify({ kind: 'inline', value: input.plan.runResult })}::json`,
      safeErrorCode: failure ?? null,
      completedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(c.workspaceId, input.workspaceId),
        eq(c.childRunId, input.runId),
        eq(c.status, 'accepted'),
      ),
    )
    .returning({ parent_run_id: c.parentRunId })
    .catch(rethrowQueryFailure);
  const missingCallResult =
    rows.length > 0 &&
    input.plan.checkpoint.runStatus === 'succeeded' &&
    input.plan.runResult === undefined;
  if (missingCallResult) throw new CoordinatorRunStateCorruptError();
  for (const row of rows)
    await wakeWorkflowRun(
      client,
      input.workspaceId,
      row.parent_run_id,
      input.traceparent,
    );
}

/** Logical Call output is the child result; SDK declaration output stays private. */
export async function persistConsumedCalls(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  plan: RunTransitionPlan,
): Promise<void> {
  const settledKeys = plan.events.flatMap(({ name, invocationKey }) =>
    invocationKey !== undefined &&
    [
      'node.succeeded',
      'node.failed',
      'node.canceled',
      'node.timed_out',
      'node.outcome_unknown',
    ].includes(name)
      ? [invocationKey]
      : [],
  );
  for (const invocation of [
    ...plan.checkpoint.invocations,
    ...(plan.prunedInvocations ?? []),
  ]) {
    if (
      invocation.output?.kind !== 'call' ||
      !settledKeys.includes(invocation.invocationKey)
    )
      continue;
    const n = nodeRuns,
      c = workflowCalls;
    const updated = await drizzle(client)
      .update(n)
      .set({ outputRef: c.resultRef })
      .from(c)
      .where(
        and(
          eq(c.workspaceId, workspaceId),
          eq(c.parentRunId, runId),
          eq(c.id, invocation.output.callId),
          eq(c.invocationKey, invocation.invocationKey),
          eq(c.status, 'succeeded'),
          sql`${c.resultRef} is not null`,
          eq(n.workspaceId, c.workspaceId),
          eq(n.workflowRunId, c.parentRunId),
          eq(n.invocationKey, c.invocationKey),
          eq(n.status, 'succeeded'),
        ),
      )
      .catch(rethrowQueryFailure);
    if (updated.rowCount !== 1) throw new CoordinatorRunStateCorruptError();
  }
  const c = workflowCalls;
  await drizzle(client)
    .update(c)
    .set({ consumedAt: sql`coalesce(${c.consumedAt},clock_timestamp())` })
    .where(
      and(
        eq(c.workspaceId, workspaceId),
        eq(c.parentRunId, runId),
        inArray(c.invocationKey, settledKeys),
        notInArray(c.status, ['pending', 'accepted']),
      ),
    )
    .catch(rethrowQueryFailure);
  if (terminalRunStatuses.has(plan.checkpoint.runStatus)) {
    const controls = await drizzle(client)
      .update(c)
      .set({
        status: sql`case when ${c.status}='pending' then 'refused' else ${c.status} end`,
        safeErrorCode: sql`case when ${c.status}='pending' then 'call_parent_closed' else ${c.safeErrorCode} end`,
        completedAt: sql`case when ${c.status}='pending' then clock_timestamp() else ${c.completedAt} end`,
        consumedAt: sql`coalesce(${c.consumedAt},clock_timestamp())`,
        cancelRequestedAt: sql`case when ${c.status}='accepted' then coalesce(${c.cancelRequestedAt},clock_timestamp()) else ${c.cancelRequestedAt} end`,
      })
      .where(
        and(
          eq(c.workspaceId, workspaceId),
          eq(c.parentRunId, runId),
          isNull(c.consumedAt),
        ),
      )
      .returning({ child_run_id: c.childRunId })
      .catch(rethrowQueryFailure);
    for (const row of controls)
      if (row.child_run_id !== null)
        await wakeWorkflowRun(client, workspaceId, row.child_run_id);
    return;
  }
  if (plan.checkpoint.invocations.some(({ status }) => status === 'running'))
    return;
  const [continuation] = await drizzle(client)
    .select({
      needed: sql<boolean>`count(*) filter(where ${c.status}='pending' or (${c.status}='refused' and ${c.consumedAt} is null))>0 and count(*) filter(where ${c.slotLent})=0`,
    })
    .from(c)
    .where(and(eq(c.workspaceId, workspaceId), eq(c.parentRunId, runId)))
    .catch(rethrowQueryFailure);
  if (continuation?.needed ?? false)
    await wakeWorkflowRun(client, workspaceId, runId);
}
