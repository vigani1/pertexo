import { sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  appendLockedRunEvent,
  RUN_EVENT_TYPE,
} from '../../runs/queries/history/events.js';
import { operatorUnknownOutcomeEvidence } from '../../schema/runs/operator.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import type { OperatorDecision } from './contract.js';
import { withoutNulls, enqueue, enqueueAdvance } from './enqueue.js';

const attemptRowSchema = z.object({
  dispatch_marked_at: z.unknown(),
  fence_token: z.coerce.number().int(),
  lease_expired: z.boolean().nullable(),
  node_run_id: z.uuid(),
  run_id: z.uuid(),
  side_effect_class: z.string(),
  status: z.string(),
});

/**
 * Settles a running attempt whose lease expired: either back to ready for
 * another worker (never once an unsafe side effect may have been dispatched)
 * or to an unknown outcome the run then advances past.
 */
export async function reconcileAttempt(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    commandId: string;
    attemptId: string;
    expectedFenceToken: number;
    action: 'reclaim' | 'outcome_unknown';
    dryRun: boolean;
  }>,
): Promise<OperatorDecision> {
  const { attemptId, action, expectedFenceToken: fence } = input;
  // The run lock comes first, as it does for every run writer.
  await transaction.db.execute(sql`
    select 1 from app.workflow_runs
    where workspace_id = ${transaction.workspaceId}
      and id = (select node.workflow_run_id from app.node_attempts attempt
        join app.node_runs node on node.workspace_id = attempt.workspace_id
          and node.id = attempt.node_run_id
        where attempt.workspace_id = ${transaction.workspaceId}
          and attempt.id = ${attemptId})
    for update
  `);
  const rows = await transaction.db.execute(sql`
    select attempt.status, attempt.fence_token, attempt.dispatch_marked_at,
      attempt.side_effect_class, node.id node_run_id, node.workflow_run_id run_id,
      attempt.lease_expires_at <= clock_timestamp() lease_expired
    from app.node_attempts attempt
    join app.node_runs node on node.workspace_id = attempt.workspace_id
      and node.id = attempt.node_run_id
    where attempt.workspace_id = ${transaction.workspaceId} and attempt.id = ${attemptId}
    for update of attempt, node
  `);
  const attempt =
    rows.rows[0] === undefined
      ? undefined
      : attemptRowSchema.parse(rows.rows[0]);
  const outcome = attemptReconciliationOutcome(attempt, input);

  let outboxEventId: string | undefined;
  if (attempt !== undefined && outcome === 'reclaimed') {
    await transaction.db.execute(sql`
      update app.node_attempts
      set status = 'ready', fence_token = ${fence + 1}, lease_owner = null,
          lease_expires_at = null, completed_at = null, updated_at = clock_timestamp()
      where workspace_id = ${transaction.workspaceId} and id = ${attemptId}
    `);
    const node = await transaction.db.execute(sql`
      update app.node_runs
      set status = 'ready', updated_at = clock_timestamp()
      where workspace_id = ${transaction.workspaceId} and id = ${attempt.node_run_id}
        and current_attempt_id = ${attemptId} and status = 'running'
    `);
    if (node.rowCount !== 1)
      throw new Error('Reclaimed attempt does not own a running node');
    outboxEventId = await enqueue(transaction, {
      jobName: 'execute-node-attempt',
      aggregateType: 'node-attempt',
      aggregateId: attemptId,
      fields: {
        attemptId,
        nodeRunId: attempt.node_run_id,
        runId: attempt.run_id,
      },
    });
  } else if (attempt !== undefined && outcome === 'marked_unknown') {
    await transaction.db.execute(sql`
      update app.node_attempts
      set status = 'outcome_unknown', fence_token = ${fence + 1}, lease_owner = null,
          lease_expires_at = null,
          reconciliation_ref = jsonb_build_object('operatorCommandId', ${input.commandId}::uuid),
          completed_at = clock_timestamp(), updated_at = clock_timestamp()
      where workspace_id = ${transaction.workspaceId} and id = ${attemptId}
    `);
    await transaction.db.execute(sql`
      update app.node_runs
      set status = 'outcome_unknown', completed_at = clock_timestamp(),
          updated_at = clock_timestamp()
      where workspace_id = ${transaction.workspaceId} and id = ${attempt.node_run_id}
        and current_attempt_id = ${attemptId}
    `);
    await appendLockedRunEvent(transaction, attempt.run_id, {
      type: RUN_EVENT_TYPE.nodeOutcomeUnknown,
      payload: {
        attemptId,
        nodeRunId: attempt.node_run_id,
        operatorCommandId: input.commandId,
        reconciliation: true,
      },
    });
    outboxEventId = await enqueueAdvance(transaction, attempt.run_id);
  }
  const changed = outcome === 'reclaimed' || outcome === 'marked_unknown';
  return {
    outcome,
    result: withoutNulls({
      action,
      fenceToken: changed ? fence + 1 : fence,
      outboxEventId,
      outcome,
    }),
  };
}

/** Records what an operator learned about an unknown outcome and asks a worker to reconcile it. */
export async function recordUnknownOutcomeEvidence(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    commandId: string;
    attemptId: string;
    evidenceKind: string;
    evidenceRef: string;
  }>,
): Promise<OperatorDecision> {
  const rows = await transaction.db.execute<{ status: string }>(sql`
    select status from app.node_attempts
    where workspace_id = ${transaction.workspaceId} and id = ${input.attemptId}
    for update
  `);
  const status = rows.rows[0]?.status;
  const outcome = evidenceOutcome(status);

  let outboxEventId: string | null = null;
  if (outcome === 'evidence_recorded') {
    await transaction.db.insert(operatorUnknownOutcomeEvidence).values({
      commandId: input.commandId,
      workspaceId: transaction.workspaceId,
      attemptId: input.attemptId,
      evidenceKind: input.evidenceKind,
      evidenceRef: sql`${input.evidenceRef}::jsonb`,
    });
    outboxEventId = await enqueue(transaction, {
      jobName: 'reconcile-unknown-outcome',
      aggregateType: 'node-attempt',
      aggregateId: input.attemptId,
      fields: {
        attemptId: input.attemptId,
        evidenceCommandId: input.commandId,
      },
    });
  }
  return {
    outcome,
    result: {
      evidenceKind: input.evidenceKind,
      outboxEventId,
      outcome,
    },
  };
}

function attemptReconciliationOutcome(
  attempt: z.output<typeof attemptRowSchema> | undefined,
  input: Readonly<{
    expectedFenceToken: number;
    action: 'reclaim' | 'outcome_unknown';
    dryRun: boolean;
  }>,
): string {
  if (attempt === undefined) return 'not_found';
  if (attempt.status !== 'running') return 'not_running';
  if (attempt.fence_token !== input.expectedFenceToken) return 'fence_conflict';
  if (!(attempt.lease_expired ?? false)) return 'lease_active';
  const unsafeReclaim =
    input.action === 'reclaim' &&
    attempt.dispatch_marked_at !== null &&
    attempt.side_effect_class === 'unsafe';
  if (unsafeReclaim) return 'reclaim_unsafe';
  if (input.dryRun)
    return input.action === 'reclaim' ? 'would_reclaim' : 'would_mark_unknown';
  return input.action === 'reclaim' ? 'reclaimed' : 'marked_unknown';
}
function evidenceOutcome(status: string | undefined): string {
  if (status === undefined) return 'not_found';
  if (status !== 'outcome_unknown') return 'not_unknown';
  return 'evidence_recorded';
}
