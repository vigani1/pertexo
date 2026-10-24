import { ordinaryRunSql } from '../../runs/data-policy.js';
import { sql } from 'drizzle-orm';

import { operatorRunReplayRequests } from '../../schema/runs/operator.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import type { OperatorDecision } from './contract.js';
import { withoutNulls, enqueue } from './enqueue.js';

/** Asks a worker to reconcile a published workflow's triggers again. */
export async function retryTriggerReconciliation(
  transaction: WorkspaceTransaction,
  input: Readonly<{ workflowId: string; dryRun: boolean }>,
): Promise<OperatorDecision> {
  const rows = await transaction.db.execute<{
    published_version_id: string | null;
  }>(sql`
    select published_version_id from app.workflows
    where workspace_id = ${transaction.workspaceId} and id = ${input.workflowId}
      and lifecycle_status = 'active'
    for share
  `);
  const workflow = rows.rows[0];
  const publishedVersionId = workflow?.published_version_id ?? null;
  const outcome = triggerReconciliationOutcome(
    workflow,
    publishedVersionId,
    input,
  );

  let outboxEventId: string | undefined;
  if (outcome === 'retry_requested' && publishedVersionId !== null)
    outboxEventId = await enqueue(transaction, {
      jobName: 'reconcile-workflow-triggers',
      aggregateType: 'workflow',
      aggregateId: input.workflowId,
      fields: { publishedVersionId, workflowId: input.workflowId },
    });
  return {
    outcome,
    result: withoutNulls({
      outboxEventId,
      outcome,
      publishedVersionId,
    }),
  };
}

/**
 * Stores a request to run a source run's workflow again on an executable
 * version of the same workflow; the replay worker creates the run.
 */
export async function requestRunReplay(
  transaction: WorkspaceTransaction,
  input: Readonly<{
    commandId: string;
    sourceRunId: string;
    workflowVersionId: string;
    runInput: string;
    requestFingerprint: string;
    dryRun: boolean;
  }>,
): Promise<OperatorDecision> {
  const rows = await transaction.db.execute<{
    source_workflow_id: string;
    target_workflow_id: string | null;
  }>(sql`
    select run.workflow_id source_workflow_id,
      (select version.workflow_id from app.workflow_versions version
        where version.workspace_id = run.workspace_id
          and version.id = ${input.workflowVersionId}
          and version.executable_json is not null) target_workflow_id
    from app.workflow_runs run
    where run.workspace_id = ${transaction.workspaceId} and run.id = ${input.sourceRunId} and ${ordinaryRunSql('run')}
  `);
  const found = rows.rows[0];
  const outcome = runReplayOutcome(found, input);

  let outboxEventId: string | undefined;
  if (found !== undefined && outcome === 'replay_requested') {
    await transaction.db.insert(operatorRunReplayRequests).values({
      commandId: input.commandId,
      workspaceId: transaction.workspaceId,
      sourceRunId: input.sourceRunId,
      workflowId: found.source_workflow_id,
      workflowVersionId: input.workflowVersionId,
      runInput: sql`${input.runInput}::json`,
      requestFingerprint: input.requestFingerprint,
    });
    outboxEventId = await enqueue(transaction, {
      jobName: 'replay-workflow-run',
      aggregateType: 'operator-command',
      aggregateId: input.commandId,
      fields: { commandId: input.commandId },
    });
  }
  return {
    outcome,
    pending: outcome === 'replay_requested',
    result: withoutNulls({
      outboxEventId,
      outcome,
      sourceRunId: input.sourceRunId,
      workflowVersionId: input.workflowVersionId,
    }),
  };
}

function triggerReconciliationOutcome(
  workflow: Readonly<{ published_version_id: string | null }> | undefined,
  publishedVersionId: string | null,
  input: Readonly<{ dryRun: boolean }>,
): string {
  if (workflow === undefined) return 'not_found';
  if (publishedVersionId === null) return 'not_published';
  return input.dryRun ? 'would_retry' : 'retry_requested';
}
function runReplayOutcome(
  source:
    | Readonly<{
        source_workflow_id: string;
        target_workflow_id: string | null;
      }>
    | undefined,
  input: Readonly<{ dryRun: boolean }>,
): string {
  if (source === undefined) return 'source_not_found';
  if (source.target_workflow_id === null) return 'version_not_executable';
  if (source.target_workflow_id !== source.source_workflow_id)
    return 'workflow_mismatch';
  return input.dryRun ? 'would_request' : 'replay_requested';
}
