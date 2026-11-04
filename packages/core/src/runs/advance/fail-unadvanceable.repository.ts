import type { RunFailureCode } from '@pertexo/workflow-model';
import { priorProviderDispatchUnresolved } from '../../attempts/dispatch/uncertainty.repository.js';
import {
  lockCompletionAttempt,
  isCurrentAttemptLease,
} from '../../attempts/completion/attempt-completion.repository.js';
import {
  validateDelivery,
  claimReceipt,
  completeReceipt,
} from '../../attempts/completion/receipts.repository.js';
import { isCurrentClaimRefusal } from '../../attempts/leases/claim-refusal.repository.js';
import type {
  NodeAttemptClaimRefusal,
  NodeAttemptLease,
} from '../../attempts/node-attempt.js';
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
import {
  nodeAttempts,
  nodeRuns,
  runCheckpoints,
} from '@pertexo/database/schema';
import type { CoordinatorAdvanceDelivery } from './run-advance.types.js';
import { lockRunForSettlement } from './load/locks.repository.js';
import { persistCoordinatorRunTransition } from './persist/run-transition.repository.js';
import type { RunTransitionPlan } from './plan.js';
import {
  claimCoordinatorReceipt,
  validateAuthoritativeAdvanceDelivery,
  DeliveryMismatch,
  auditCoordinatorDeliveryMismatch,
  completeCoordinatorReceipt,
} from './receipts.repository.js';
import { withCoordinatorWriteClient } from './coordinator-transaction.js';

const OPEN_STATUSES = ['pending', 'ready', 'running', 'waiting'] as const;

export type FailUnadvanceableInput = Readonly<{
  workspaceId: string;
  runId: string;
  safeErrorCode: RunFailureCode;
  expectedRevision: number | null | undefined;
  /** The advance that found the run unadvanceable, whose slot binding ends here. */
  delivery?: CoordinatorAdvanceDelivery;
  attemptLease?: NodeAttemptLease;
  claimRefusal?: NodeAttemptClaimRefusal;
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
): Promise<'failed' | 'outcome_unknown' | 'not_active' | 'stale'> {
  const { workspaceId, runId, signal, delivery } = input;
  return withCoordinatorWriteClient(
    pool,
    workspaceId,
    signal,
    async (client) => {
      const [selected] = await lockRunForSettlement(client, workspaceId, runId);
      if (
        selected === undefined ||
        TERMINAL_RUN_STATUSES.has(selected.run.status)
      )
        return 'not_active';
      const { run } = selected;
      const revision = run.revision ?? 0;
      const safeErrorCode =
        run.revision === null
          ? 'execution.checkpoint_missing'
          : input.safeErrorCode;
      if (delivery !== undefined)
        await validateAuthoritativeAdvanceDelivery(
          client,
          workspaceId,
          runId,
          delivery,
        );
      if (isStaleEmergencyReport(run.revision, input)) return 'stale';
      if (
        delivery !== undefined &&
        (await claimCoordinatorReceipt(client, workspaceId, delivery)) ===
          'duplicate'
      )
        return 'stale';
      if (
        !(await claimEmergencyAttemptReceipt(
          client,
          input,
          run.workflow_version_id,
        ))
      )
        return 'stale';

      if (run.revision === null)
        await drizzle(client)
          .insert(runCheckpoints)
          .values({
            workspaceId,
            workflowRunId: runId,
            workflowVersionId: run.workflow_version_id,
            revision,
            schedulerState: createCheckpoint({
              workflowVersionId: run.workflow_version_id,
              iterationBudget: 0,
            }),
          })
          .catch(rethrowQueryFailure);
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
        expectedRevision: revision,
        expectedNextEventSequence: sequence,
        consumedThroughEventSequence: sequence,
        checkpoint: {
          ...createCheckpoint({
            workflowVersionId: run.workflow_version_id,
            iterationBudget: 0,
            nextEventSequence: sequence + 1,
          }),
          revision: revision + 1,
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
        row: { ...run, revision },
        runId,
        workflowVersionId: run.workflow_version_id,
        workspaceId,
      });
      if (delivery !== undefined)
        await completeCoordinatorReceipt(client, workspaceId, delivery);
      if (input.attemptLease !== undefined)
        await completeReceipt(client, workspaceId, input.attemptLease.delivery);
      if (input.claimRefusal !== undefined)
        await completeReceipt(client, workspaceId, input.claimRefusal.delivery);
      return status;
    },
  ).catch((error: unknown) => {
    if (error instanceof DeliveryMismatch && delivery !== undefined)
      return auditCoordinatorDeliveryMismatch(
        pool,
        workspaceId,
        delivery,
        signal,
      );
    throw error;
  });
}

/** A missing checkpoint is re-established corruption; other reports need their observed revision. */
function isStaleEmergencyReport(
  revision: number | null,
  input: FailUnadvanceableInput,
): boolean {
  if (revision === null) return false;
  return (
    input.expectedRevision === undefined || input.expectedRevision !== revision
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
      priorDispatchUnresolved: priorProviderDispatchUnresolved(nodeAttempts),
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
          attempt.sideEffectClass !== 'safe' &&
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
  const groups = new Map<TerminalStatus, string[]>();
  let uncertain = nodes.some((node) => node.status === 'outcome_unknown');
  for (const node of nodes) {
    if (!OPEN_STATUSES.some((status) => status === node.status)) continue;
    const current =
      node.currentAttemptId === null
        ? undefined
        : byId.get(node.currentAttemptId);
    const status = emergencyNodeStatus(node.status, current, newlyUnknown);
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

type TerminalStatus =
  'succeeded' | 'failed' | 'canceled' | 'timed_out' | 'outcome_unknown';

function emergencyNodeStatus(
  nodeStatus: typeof nodeRuns.$inferSelect.status,
  current:
    | (Pick<
        typeof nodeAttempts.$inferSelect,
        'id' | 'status' | 'executorFailureKind'
      > &
        Readonly<{ priorDispatchUnresolved: boolean }>)
    | undefined,
  newlyUnknown: ReadonlySet<string>,
): TerminalStatus {
  if (current === undefined) return 'canceled';
  // A confirmed success resolves the earlier keyed uncertainty.
  if (current.status === 'succeeded')
    return nodeStatus === 'running' ? 'succeeded' : 'canceled';
  if (
    current.priorDispatchUnresolved ||
    current.status === 'outcome_unknown' ||
    current.executorFailureKind === 'outcome_unknown' ||
    newlyUnknown.has(current.id)
  )
    return 'outcome_unknown';
  if (current.status === 'failed') return 'failed';
  if (current.status === 'timed_out' || current.status === 'canceled')
    return current.status;
  return 'canceled';
}

/** Match the authority that observed the failure before ending any attempt work. */
async function claimEmergencyAttemptReceipt(
  client: PoolClient,
  input: FailUnadvanceableInput,
  workflowVersionId: string,
): Promise<boolean> {
  const { workspaceId, runId } = input;
  if (input.attemptLease !== undefined) {
    const lease = input.attemptLease;
    if (
      lease.workspaceId !== workspaceId ||
      lease.runId !== runId ||
      lease.workflowVersionId !== workflowVersionId
    )
      return false;
    await validateDelivery(client, lease);
    const [attempt] = await lockCompletionAttempt(client, { lease });
    if (!isCurrentAttemptLease(lease, attempt)) return false;
    if (
      (await claimReceipt(client, workspaceId, lease.delivery)) === 'completed'
    )
      return false;
  }

  if (input.claimRefusal !== undefined) {
    const report = input.claimRefusal;
    if (
      report.workspaceId !== workspaceId ||
      report.runId !== runId ||
      !(await isCurrentClaimRefusal(client, report))
    )
      return false;
    if (
      (await claimReceipt(client, workspaceId, report.delivery)) === 'completed'
    )
      return false;
  }

  return true;
}
