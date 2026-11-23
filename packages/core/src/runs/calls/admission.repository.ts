import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, exists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import {
  databaseSchema,
  workflowCalls,
  workflowRuns,
  workflowVersions,
  workflows,
  runCheckpoints,
} from '@pertexo/database/schema';
import {
  parseWorkspaceId,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
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
      scheduler_state: checkpoint.schedulerState,
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

/** A call's acceptance runs on the parent's client as a workspace transaction. */
export function callAcceptanceTransaction(
  client: PoolClient,
  workspaceId: string,
): WorkspaceTransaction {
  return {
    db: drizzle(client, { schema: databaseSchema }),
    workspaceId: parseWorkspaceId(workspaceId),
  };
}

export async function lockCallTarget(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; workflowId: string }>,
) {
  const [target] = await drizzle(client)
    .select({
      lifecycle_status: workflows.lifecycleStatus,
      published_version_id: workflows.publishedVersionId,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, input.workflowId),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  return target;
}

/** Whether another call of this parent already holds the parent's lent slot. */
export async function parentSlotLent(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; parentRunId: string }>,
) {
  const lent = await drizzle(client)
    .select({ id: c.id })
    .from(c)
    .where(
      and(
        eq(c.workspaceId, input.workspaceId),
        eq(c.parentRunId, input.parentRunId),
        eq(c.slotLent, true),
      ),
    )
    .catch(rethrowQueryFailure);
  return lent.length > 0;
}

export async function openCallCandidate(client: PoolClient) {
  await drizzle(client)
    .execute(sql`savepoint workflow_call_candidate`)
    .catch(rethrowQueryFailure);
}

export async function keepCallCandidate(client: PoolClient) {
  await drizzle(client)
    .execute(sql`release savepoint workflow_call_candidate`)
    .catch(rethrowQueryFailure);
}

export async function discardCallCandidate(client: PoolClient) {
  await drizzle(client)
    .execute(sql`rollback to savepoint workflow_call_candidate`)
    .catch(rethrowQueryFailure);
  await keepCallCandidate(client);
}

/** Binds the accepted child to its pending call; false when the call moved on. */
export async function bindAcceptedCall(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; callId: string; childRunId: string }>,
) {
  const bound = await drizzle(client)
    .update(c)
    .set({
      status: 'accepted',
      childRunId: input.childRunId,
      liveChildRunId: input.childRunId,
    })
    .where(
      and(
        eq(c.workspaceId, input.workspaceId),
        eq(c.id, input.callId),
        eq(c.status, 'pending'),
      ),
    )
    .catch(rethrowQueryFailure);
  return bound.rowCount === 1;
}

/** Lends the parent's slot to its child; false when no slot can be lent. */
export async function lendCallSlot(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    callId: string;
    childRunId: string;
    outboxEventId: string;
  }>,
) {
  const transfer = await drizzle(client)
    .execute<{ granted: boolean }>(
      sql`select app.lend_workflow_run_slot(${input.workspaceId},${input.callId},${input.childRunId},${input.outboxEventId}) granted`,
    )
    .catch(rethrowQueryFailure);
  return transfer.rows[0]?.granted ?? false;
}

export async function refusePendingCall(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; callId: string; refusal: string }>,
) {
  await drizzle(client)
    .update(c)
    .set({
      status: 'refused',
      safeErrorCode: input.refusal,
      completedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(c.workspaceId, input.workspaceId),
        eq(c.id, input.callId),
        eq(c.status, 'pending'),
      ),
    )
    .catch(rethrowQueryFailure);
}

export async function readCallParentPublisher(
  client: PoolClient,
  workspaceId: string,
  runId: string,
) {
  const r = workflowRuns;
  const v = workflowVersions;
  const [version] = await drizzle(client)
    .select({ actorId: v.publishedBy })
    .from(r)
    .innerJoin(
      v,
      and(eq(v.workspaceId, r.workspaceId), eq(v.id, r.workflowVersionId)),
    )
    .where(and(eq(r.workspaceId, workspaceId), eq(r.id, runId)))
    .catch(rethrowQueryFailure);
  return version;
}
