import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, exists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import { workflowCalls } from '../../schema/runs/calls.js';
import { workflowRuns, runCheckpoints } from '../../schema/runs/execution.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
const c = workflowCalls;
const pendingSelection = {
  id: c.id,
  invocation_key: c.invocationKey,
  target_workflow_id: c.targetWorkflowId,
  target_version_id: c.targetVersionId,
  target_checksum: c.targetChecksum,
  input_ref: c.inputRef,
  input_checksum: c.inputChecksum,
  deadline_at: c.deadlineAt,
};
function pendingQuery(client: PoolClient) {
  return drizzle(client).select(pendingSelection).from(c);
}
export type PendingWorkflowCall = Awaited<
  ReturnType<typeof pendingQuery>
>[number];
export function readPendingCall(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; runId: string }>,
) {
  return pendingQuery(client)
    .where(
      and(
        eq(c.workspaceId, input.workspaceId),
        eq(c.parentRunId, input.runId),
        eq(c.status, 'pending'),
      ),
    )
    .orderBy(c.invocationKey)
    .limit(1)
    .catch(rethrowQueryFailure);
}
export function lockPendingCall(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; parentRunId: string; callId: string }>,
) {
  return drizzle(client)
    .select({
      ...pendingSelection,
      status: c.status,
      deadline_expired: sql<boolean | null>`${c.deadlineAt}<=clock_timestamp()`,
    })
    .from(c)
    .where(
      and(
        eq(c.workspaceId, input.workspaceId),
        eq(c.id, input.callId),
        eq(c.parentRunId, input.parentRunId),
      ),
    )
    .for('no key update')
    .catch(rethrowQueryFailure);
}
export function lockCallParent(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    parentRunId: string;
    invocationKey: string;
  }>,
) {
  const db = drizzle(client),
    run = alias(workflowRuns, 'run'),
    checkpoint = alias(runCheckpoints, 'checkpoint');
  const invocations = sql`jsonb_array_elements(${checkpoint.schedulerState}->'invocations') invocation`;
  const ordinary = db
    .select({ one: sql`1` })
    .from(invocations)
    .where(sql`invocation->>'status'='running'`);
  const waiting = db
    .select({ one: sql`1` })
    .from(invocations)
    .where(
      sql`invocation->>'invocationKey'=${input.invocationKey} and invocation->>'status'='waiting' and invocation->>'waitKind'='workflow_call'`,
    );
  return db
    .select({
      status: run.status,
      cancel_requested_at: run.cancelRequestedAt,
      error_workflow_origin: run.errorWorkflowOrigin,
      started_by: run.startedBy,
      absolute_deadline_at: run.absoluteDeadlineAt,
      variable_set_revision: run.variableSetRevision,
      deadline_expired: sql<
        boolean | null
      >`${run.deadlineAt}<=clock_timestamp()`,
      has_ordinary_work: sql<boolean>`${exists(ordinary)}`,
      has_wait: sql<boolean>`${exists(waiting)}`,
    })
    .from(run)
    .innerJoin(
      checkpoint,
      and(
        eq(checkpoint.workspaceId, run.workspaceId),
        eq(checkpoint.workflowRunId, run.id),
      ),
    )
    .where(
      and(
        eq(run.workspaceId, input.workspaceId),
        eq(run.id, input.parentRunId),
      ),
    )
    .for('no key update', { of: run })
    .catch(rethrowQueryFailure);
}
