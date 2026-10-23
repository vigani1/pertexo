import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { requestWorkflowRunCancellation } from '../../runs/commands/cancel.js';

import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import {
  type OperatorDecision,
  TERMINAL_RUN_STATUSES,
  RESUME_PAGE,
} from './contract.js';
import { withoutNulls, enqueueAdvance } from './enqueue.js';

const dueStateSchema = z.object({
  due_nodes: z.coerce.number().int().nonnegative(),
  due_wait: z.boolean(),
});

/**
 * Wakes a run's due node retries and resumes, one page at a time, and its
 * due workflow wait, then asks the run to advance.
 */
export async function resumeDueWork(
  transaction: WorkspaceTransaction,
  input: Readonly<{ runId: string; dryRun: boolean }>,
): Promise<OperatorDecision> {
  const { runId } = input;
  const runs = await transaction.db.execute<{ status: string }>(sql`
    select status from app.workflow_runs
    where workspace_id = ${transaction.workspaceId} and id = ${runId}
    for update
  `);
  const run = runs.rows[0];
  if (run === undefined)
    return {
      outcome: 'not_found',
      result: {
        dueNodeCount: 0,
        dueWorkflowWait: false,
        outcome: 'not_found',
      },
    };
  const rows = await transaction.db.execute(sql`
    select
      (select count(*) from (
        select 1 from app.node_runs
        where workspace_id = ${transaction.workspaceId} and workflow_run_id = ${runId}
          and status = 'waiting' and coalesce(retry_due_at, resume_at) <= clock_timestamp()
          and due_wakeup_at is distinct from coalesce(retry_due_at, resume_at)
        limit ${RESUME_PAGE + 1}) due) due_nodes,
      exists(select 1 from app.run_checkpoints
        where workspace_id = ${transaction.workspaceId} and workflow_run_id = ${runId}
          and resume_at <= clock_timestamp()
          and (resume_lease_expires_at is null
            or resume_lease_expires_at <= clock_timestamp())) due_wait
  `);
  const state = dueStateSchema.parse(rows.rows[0]);
  const dueNodeCount = Math.min(state.due_nodes, RESUME_PAGE);
  const outcome = resumeOutcome(run.status, {
    dueNodeCount,
    dueWait: state.due_wait,
    dryRun: input.dryRun,
  });

  let outboxEventId: string | undefined;
  if (outcome === 'resumed') {
    await transaction.db.execute(sql`
      with due as (
        select id from app.node_runs
        where workspace_id = ${transaction.workspaceId} and workflow_run_id = ${runId}
          and status = 'waiting' and coalesce(retry_due_at, resume_at) <= clock_timestamp()
          and due_wakeup_at is distinct from coalesce(retry_due_at, resume_at)
        order by coalesce(retry_due_at, resume_at), id
        for update limit ${RESUME_PAGE}
      )
      update app.node_runs node
      set due_wakeup_at = coalesce(node.retry_due_at, node.resume_at),
          updated_at = clock_timestamp()
      from due
      where node.workspace_id = ${transaction.workspaceId} and node.id = due.id
    `);
    await transaction.db.execute(sql`
      update app.run_checkpoints
      set resume_at = null, resume_lease_owner = null, resume_lease_token = null,
          resume_lease_expires_at = null, updated_at = clock_timestamp()
      where workspace_id = ${transaction.workspaceId} and workflow_run_id = ${runId}
        and resume_at <= clock_timestamp()
        and (resume_lease_expires_at is null
          or resume_lease_expires_at <= clock_timestamp())
    `);
    outboxEventId = await enqueueAdvance(transaction, runId);
  }
  return {
    outcome,
    result: withoutNulls({
      dueNodeCount,
      dueNodesRemaining: state.due_nodes > RESUME_PAGE,
      dueWorkflowWait: state.due_wait,
      outboxEventId,
      outcome,
    }),
  };
}

const cancelStateSchema = z.object({
  cancel_requested: z.boolean(),
  status: z.string(),
});

/** Requests cancellation through the same path the API uses. */
export async function cancelRun(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    runId: string;
    actorRef: string;
    reason: string;
    dryRun: boolean;
  }>,
): Promise<OperatorDecision> {
  const rows = await transaction.db.execute(sql`
    select status, cancel_requested_at is not null cancel_requested
    from app.workflow_runs
    where workspace_id = ${transaction.workspaceId} and id = ${input.runId}
    for update
  `);
  const run =
    rows.rows[0] === undefined
      ? undefined
      : cancelStateSchema.parse(rows.rows[0]);
  const outcome = cancellationOutcome(run, input);

  let eventSequence: number | null = null;
  let outboxEventId: string | undefined;
  if (outcome === 'cancel_requested') {
    ({ eventSequence } = await requestWorkflowRunCancellation(transaction, {
      actor: input.actorRef,
      reason: input.reason,
      runId: input.runId,
    }));
    outboxEventId = await enqueueAdvance(transaction, input.runId);
  }
  return {
    outcome,
    result: withoutNulls({
      eventSequence,
      outboxEventId,
      outcome,
    }),
  };
}

function resumeOutcome(
  status: string,
  input: Readonly<{ dueNodeCount: number; dueWait: boolean; dryRun: boolean }>,
): string {
  if (TERMINAL_RUN_STATUSES.has(status)) return 'terminal';
  if (input.dueNodeCount === 0 && !input.dueWait) return 'not_due';
  return input.dryRun ? 'would_resume' : 'resumed';
}
function cancellationOutcome(
  run: z.output<typeof cancelStateSchema> | undefined,
  input: Readonly<{ dryRun: boolean }>,
): string {
  if (run === undefined) return 'not_found';
  if (TERMINAL_RUN_STATUSES.has(run.status)) return 'terminal';
  if (run.cancel_requested) return 'already_requested';
  return input.dryRun ? 'would_cancel' : 'cancel_requested';
}
