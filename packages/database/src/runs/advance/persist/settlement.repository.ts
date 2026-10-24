import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { nodeRuns } from '../../../schema/runs/execution.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { PoolClient } from 'pg';

import type { WorkflowCheckpoint } from '@pertexo/workflow-engine';

import { CoordinatorRunStateCorruptError } from '../contract.js';
import type { RunTransitionPlan } from '../plan.js';

/**
 * A For Each whose collection exceeded its limit fails the node that produced
 * the collection. That node already succeeded, so its row moves to failed here
 * instead of through the ordinary terminal update.
 */
export async function settleRejectedForEachDeclarations(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  plan: RunTransitionPlan,
): Promise<ReadonlySet<string>> {
  const settled = new Set<string>();
  for (const event of plan.events) {
    const ignoresIterationFailure =
      event.name !== 'node.failed' ||
      event.reasonCode !== 'loop_limit_exceeded' ||
      event.invocationKey === undefined;
    if (ignoresIterationFailure) continue;
    const updated = await drizzle(client)
      .update(nodeRuns)
      .set({
        status: 'failed',
        outputRef: null,
        safeErrorCode: 'loop_limit_exceeded',
        completedAt: sql`clock_timestamp()`,
        resumeAt: null,
        retryDueAt: null,
        dueWakeupAt: null,
        waitKind: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(nodeRuns.workspaceId, workspaceId),
          eq(nodeRuns.workflowRunId, runId),
          eq(nodeRuns.invocationKey, event.invocationKey),
          eq(nodeRuns.status, 'succeeded'),
          isNull(nodeRuns.controlKind),
        ),
      )
      .catch(rethrowQueryFailure);
    if (updated.rowCount === 1) settled.add(event.invocationKey);
  }
  return settled;
}

export async function persistLoopBarrierTransitions(
  client: PoolClient,
  workspaceId: string,
  {
    runId,
    current,
    next,
  }: Readonly<{
    runId: string;
    current: WorkflowCheckpoint;
    next: WorkflowCheckpoint;
  }>,
): Promise<void> {
  const currentLoops = new Set(
    current.loops.map(({ controlInvocationKey }) => controlInvocationKey),
  );
  const barriers = next.loops.filter(
    ({ controlInvocationKey }) => !currentLoops.has(controlInvocationKey),
  );
  if (barriers.length === 0) return;
  const updated = await drizzle(client)
    .update(nodeRuns)
    .set({
      status: 'waiting',
      controlKind: 'for_each_barrier',
      completedAt: null,
      resumeAt: null,
      retryDueAt: null,
      dueWakeupAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(nodeRuns.workspaceId, workspaceId),
        eq(nodeRuns.workflowRunId, runId),
        inArray(
          nodeRuns.invocationKey,
          barriers.map(({ controlInvocationKey }) => controlInvocationKey),
        ),
        eq(nodeRuns.status, 'succeeded'),
      ),
    )
    .catch(rethrowQueryFailure);
  if (updated.rowCount !== barriers.length)
    throw new CoordinatorRunStateCorruptError();
}

export async function persistDueReadyTransitions(
  client: PoolClient,
  workspaceId: string,
  {
    runId,
    current,
    next,
  }: Readonly<{
    runId: string;
    current: WorkflowCheckpoint;
    next: WorkflowCheckpoint;
  }>,
): Promise<void> {
  const currentInvocations = new Map(
    current.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const transitions = next.invocations.filter(
    (invocation) =>
      invocation.status === 'ready' &&
      currentInvocations.get(invocation.invocationKey)?.status === 'waiting',
  );
  if (transitions.length === 0) return;
  const updated = await drizzle(client)
    .update(nodeRuns)
    .set({
      status: 'ready',
      resumeAt: null,
      retryDueAt: null,
      dueWakeupAt: null,
      waitKind: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(nodeRuns.workspaceId, workspaceId),
        eq(nodeRuns.workflowRunId, runId),
        inArray(
          nodeRuns.invocationKey,
          transitions.map(({ invocationKey }) => invocationKey),
        ),
        eq(nodeRuns.status, 'waiting'),
      ),
    )
    .catch(rethrowQueryFailure);
  if (updated.rowCount !== transitions.length)
    throw new CoordinatorRunStateCorruptError();
}
