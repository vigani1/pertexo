import {
  validateDelivery,
  claimReceipt,
  completeReceipt,
} from '../../attempts/completion/receipts.repository.js';
import type { NodeAttemptDeliveryIdentity } from '../../attempts/node-attempt.js';
import { persistConsumedCalls } from '../calls/persist.repository.js';
import { persistConsumedTasks } from '../pending-tasks/lifecycle/persist.repository.js';
import { TERMINAL_NODE_FIELDS } from './persist/settlement.repository.js';
import { TERMINAL_RUN_STATUSES } from '../statuses.js';
import { createCheckpoint } from '@pertexo/workflow-engine';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import { appendAttemptEvent } from '../../attempts/events.repository.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { nodeAttempts, nodeRuns } from '@pertexo/database/schema';
import type { CoordinatorAdvanceDelivery } from './run-advance.types.js';
import { lockRunForAdvance } from './load/locks.repository.js';
import { persistCoordinatorRunTransition } from './persist/run-transition.repository.js';
import type { RunTransitionPlan } from './plan.js';
import {
  claimCoordinatorReceipt,
  completeCoordinatorReceipt,
} from './receipts.repository.js';
import { withCoordinatorWriteClient } from './coordinator-transaction.js';

const OPEN_STATUSES = ['pending', 'ready', 'running', 'waiting'] as const;

export type FailUnadvanceableInput = Readonly<{
  workspaceId: string;
  runId: string;
  safeErrorCode: string;
  /** The advance that found the run unadvanceable, whose slot binding ends here. */
  delivery?: CoordinatorAdvanceDelivery;
  attemptDelivery?: NodeAttemptDeliveryIdentity;
  signal: AbortSignal;
}>;

/**
 * Ends a run the engine can never move, so it stops holding a slot and someone
 * finds out. Its checkpoint may be the very thing that's broken, so this reads
 * nothing from it. A dispatched unsafe step makes the outcome unknown, as ever.
 */
export function failUnadvanceableRun(
  pool: Pool,
  input: FailUnadvanceableInput,
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
        TERMINAL_RUN_STATUSES.has(selected.run.status)
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
      const occurredAt = await readDatabaseTime(client);
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
      await persistConsumedCalls(client, workspaceId, runId, plan);
      await persistConsumedTasks(client, workspaceId, runId, plan);
      await persistCoordinatorRunTransition(client, {
        authoritativeCancellation: run.cancel_requested_at !== null,
        hadWaitingStep: false,
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
      if (input.attemptDelivery !== undefined) {
        await validateDelivery(client, input.attemptDelivery);
        const receipt = await claimReceipt(
          client,
          workspaceId,
          input.attemptDelivery.delivery,
        );
        if (receipt !== 'completed')
          await completeReceipt(
            client,
            workspaceId,
            input.attemptDelivery.delivery,
          );
      }
      return status;
    },
  );
}

async function readDatabaseTime(client: PoolClient): Promise<string> {
  const { rows } = await drizzle(client)
    .execute<{ now: string }>(sql`select clock_timestamp() now`)
    .catch(rethrowQueryFailure);
  return new Date(rows[0]?.now ?? Number.NaN).toISOString();
}

/** Close physical work while preserving the current durable outcome, even before consumption. */
async function closeOpenWork(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; runId: string }>,
): Promise<boolean> {
  const db = drizzle(client);
  const nodes = await db
    .select({
      id: nodeRuns.id,
      status: nodeRuns.status,
      currentAttemptId: nodeRuns.currentAttemptId,
    })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.workspaceId, input.workspaceId),
        eq(nodeRuns.workflowRunId, input.runId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const nodeIds = nodes.map((node) => node.id);
  if (nodeIds.length === 0) return false;
  const attempts = await db
    .select({
      id: nodeAttempts.id,
      status: nodeAttempts.status,
      sideEffectClass: nodeAttempts.sideEffectClass,
      dispatchMarkedAt: nodeAttempts.dispatchMarkedAt,
      executorFailureKind: nodeAttempts.executorFailureKind,
    })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.workspaceId, input.workspaceId),
        inArray(nodeAttempts.nodeRunId, nodeIds),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const newlyUnknown = new Set(
    attempts
      .filter(
        (attempt) =>
          OPEN_STATUSES.some((status) => status === attempt.status) &&
          attempt.sideEffectClass === 'unsafe' &&
          attempt.dispatchMarkedAt !== null,
      )
      .map((attempt) => attempt.id),
  );
  for (const status of ['canceled', 'outcome_unknown'] as const) {
    const ids = attempts
      .filter(
        (attempt) =>
          OPEN_STATUSES.some((open) => open === attempt.status) &&
          newlyUnknown.has(attempt.id) === (status === 'outcome_unknown'),
      )
      .map((attempt) => attempt.id);
    if (ids.length === 0) continue;
    await db
      .update(nodeAttempts)
      .set({
        status,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(nodeAttempts.workspaceId, input.workspaceId),
          inArray(nodeAttempts.id, ids),
        ),
      )
      .catch(rethrowQueryFailure);
  }
  const byId = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  type TerminalStatus =
    'succeeded' | 'failed' | 'canceled' | 'timed_out' | 'outcome_unknown';
  const groups = new Map<TerminalStatus, string[]>();
  let uncertain = nodes.some((node) => node.status === 'outcome_unknown');
  for (const node of nodes) {
    if (!OPEN_STATUSES.some((status) => status === node.status)) continue;
    const current =
      node.currentAttemptId === null
        ? undefined
        : byId.get(node.currentAttemptId);
    let status: TerminalStatus = 'canceled';
    if (
      current?.status === 'outcome_unknown' ||
      current?.executorFailureKind === 'outcome_unknown' ||
      (current !== undefined && newlyUnknown.has(current.id))
    )
      status = 'outcome_unknown';
    else if (current?.status === 'failed') status = 'failed';
    else if (current?.status === 'timed_out' || current?.status === 'canceled')
      status = current.status;
    // A succeeded wait attempt leaves unfinished logical work; a running node carries its result.
    else if (current?.status === 'succeeded' && node.status === 'running')
      status = 'succeeded';
    uncertain ||= status === 'outcome_unknown';
    const ids = groups.get(status) ?? [];
    ids.push(node.id);
    groups.set(status, ids);
  }
  for (const [status, ids] of groups)
    await db
      .update(nodeRuns)
      .set({
        status,
        ...TERMINAL_NODE_FIELDS,
        ...(status === 'succeeded'
          ? {
              outputRef: sql`(select output_ref from app.node_attempts where workspace_id=${input.workspaceId} and id=${nodeRuns.currentAttemptId})`,
            }
          : {}),
        safeErrorCode: sql`coalesce(${nodeRuns.safeErrorCode},(select safe_error_code from app.node_attempts where workspace_id=${input.workspaceId} and id=${nodeRuns.currentAttemptId}))`,
      })
      .where(
        and(
          eq(nodeRuns.workspaceId, input.workspaceId),
          inArray(nodeRuns.id, ids),
        ),
      )
      .catch(rethrowQueryFailure);
  return uncertain;
}
