import { createCheckpoint } from '@pertexo/workflow-engine';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { appendAttemptEvent } from '../../attempts/events.repository.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { nodeAttempts, nodeRuns } from '../../schema/runs/execution.js';
import type { CoordinatorAdvanceDelivery } from './contract.js';
import { lockRunForAdvance } from './load/locks.queries.js';
import { persistCoordinatorRunTransition } from './persist/run-transition.repository.js';
import { terminalRunStatuses, type RunTransitionPlan } from './plan.js';
import {
  claimCoordinatorReceipt,
  completeCoordinatorReceipt,
} from './receipts.repository.js';
import { withCoordinatorWriteClient } from './transactions.repository.js';

const OPEN_STATUSES = ['pending', 'ready', 'running', 'waiting'] as const;

/**
 * Ends a run the engine can never move, so it stops holding a slot and someone
 * finds out. Its checkpoint may be the very thing that's broken, so this reads
 * nothing from it. A dispatched unsafe step makes the outcome unknown, as ever.
 */
export function failUnadvanceableRun(
  pool: Pool,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    safeErrorCode: string;
    /** The advance that found the run unadvanceable, whose slot binding ends here. */
    delivery?: CoordinatorAdvanceDelivery;
    signal: AbortSignal;
  }>,
): Promise<'failed' | 'outcome_unknown' | 'not_active'> {
  const { workspaceId, runId, safeErrorCode, signal, delivery } = input;
  return withCoordinatorWriteClient(
    pool,
    workspaceId,
    signal,
    async (client) => {
      const [selected] = await lockRunForAdvance(client, workspaceId, runId);
      if (
        selected === undefined ||
        terminalRunStatuses.has(selected.run.status)
      )
        return 'not_active';
      const { run } = selected;
      const status = (await closeOpenWork(client, input))
        ? 'outcome_unknown'
        : 'failed';
      const type = status === 'failed' ? 'run.failed' : 'run.outcome_unknown';
      const sequence = await appendAttemptEvent(client, {
        workspaceId,
        runId,
        type,
        payload: { reasonCode: safeErrorCode },
      });
      const occurredAt = new Date().toISOString();
      const plan: RunTransitionPlan = {
        expectedRevision: run.revision,
        expectedNextEventSequence: sequence,
        consumedThroughEventSequence: sequence,
        checkpoint: {
          ...createCheckpoint({
            workflowVersionId: run.workflow_version_id,
            iterationBudget: 0,
            nextEventSequence: sequence + 1,
          }),
          revision: run.revision + 1,
          runStatus: status,
        },
        events: [
          { name: type, sequence, occurredAt, reasonCode: safeErrorCode },
        ],
        nodeRunAdmissions: [],
        attempts: [],
      };
      await persistCoordinatorRunTransition(client, {
        authoritativeCancellation: run.cancel_requested_at !== null,
        plan,
        row: run,
        runId,
        workflowVersionId: run.workflow_version_id,
        workspaceId,
      });
      if (
        delivery !== undefined &&
        (await claimCoordinatorReceipt(client, workspaceId, delivery)) === 'new'
      )
        await completeCoordinatorReceipt(client, workspaceId, delivery);
      return status;
    },
  );
}

/** Returns whether a possibly dispatched unsafe step was among them. */
async function closeOpenWork(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; runId: string }>,
): Promise<boolean> {
  const db = drizzle(client);
  const nodes = await db
    .select({ id: nodeRuns.id })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.workspaceId, input.workspaceId),
        eq(nodeRuns.workflowRunId, input.runId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const nodeIds = nodes.map(({ id }) => id);
  if (nodeIds.length === 0) return false;
  const closed = await db
    .update(nodeAttempts)
    .set({
      status: sql`case when ${nodeAttempts.dispatchMarkedAt} is not null and ${nodeAttempts.sideEffectClass}='unsafe' then 'outcome_unknown' else 'canceled' end`,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(nodeAttempts.workspaceId, input.workspaceId),
        inArray(nodeAttempts.nodeRunId, nodeIds),
        inArray(nodeAttempts.status, OPEN_STATUSES),
      ),
    )
    .returning({
      status: nodeAttempts.status,
      nodeRunId: nodeAttempts.nodeRunId,
    })
    .catch(rethrowQueryFailure);
  const unknownNodes = closed
    .filter(({ status }) => status === 'outcome_unknown')
    .map(({ nodeRunId }) => nodeRunId);
  await db
    .update(nodeRuns)
    .set({
      status: sql`case when ${nodeRuns.id} in ${unknownNodes.length === 0 ? sql`(null::uuid)` : unknownNodes} then 'outcome_unknown' else 'canceled' end`,
      resumeAt: null,
      retryDueAt: null,
      dueWakeupAt: null,
      waitKind: null,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(nodeRuns.workspaceId, input.workspaceId),
        inArray(nodeRuns.id, nodeIds),
        inArray(nodeRuns.status, OPEN_STATUSES),
      ),
    )
    .catch(rethrowQueryFailure);
  return unknownNodes.length > 0;
}
