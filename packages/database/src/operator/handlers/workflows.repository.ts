import {
  triggerReconciliationOutcome,
  runReplayOutcome,
} from '@pertexo/workflow-engine';
import { ordinaryRunSql } from '../../runs/data-policy.js';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import {
  workflows,
  workflowVersions,
} from '../../schema/authoring/workflows.js';
import { workflowRuns } from '../../schema/runs/execution.js';
import { operatorRunReplayRequests } from '../../schema/runs/operator.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import type { OperatorDecision } from './contract.js';
import { withoutNulls, enqueue } from './enqueue.js';

/** Asks a worker to reconcile a published workflow's triggers again. */
export async function retryTriggerReconciliation(
  transaction: WorkspaceTransaction,
  input: Readonly<{ workflowId: string; dryRun: boolean }>,
): Promise<OperatorDecision> {
  const [workflow] = await transaction.db
    .select({ publishedVersionId: workflows.publishedVersionId })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, transaction.workspaceId),
        eq(workflows.id, input.workflowId),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    )
    .for('share');
  const publishedVersionId = workflow?.publishedVersionId ?? null;
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
  const target = transaction.db
    .select({ workflowId: workflowVersions.workflowId })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workspaceId, workflowRuns.workspaceId),
        eq(workflowVersions.id, input.workflowVersionId),
        isNotNull(workflowVersions.executableJson),
      ),
    );
  const [found] = await transaction.db
    .select({
      sourceWorkflowId: workflowRuns.workflowId,
      targetWorkflowId: sql<string | null>`(${target})`,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, input.sourceRunId),
        ordinaryRunSql('workflow_runs'),
      ),
    );
  const outcome = runReplayOutcome(found, input);

  let outboxEventId: string | undefined;
  if (found !== undefined && outcome === 'replay_requested') {
    await transaction.db.insert(operatorRunReplayRequests).values({
      commandId: input.commandId,
      workspaceId: transaction.workspaceId,
      sourceRunId: input.sourceRunId,
      workflowId: found.sourceWorkflowId,
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
