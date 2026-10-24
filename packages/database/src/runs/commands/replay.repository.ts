import { workflowRuns } from '../../schema/runs/execution.js';
import { isTestRun } from '../data-policy.js';
import { and, eq, sql } from 'drizzle-orm';

import { readWorkflowRunAcceptanceReplay } from './acceptance/replay.repository.js';
import type { PublishedWorkflow } from '../queries/execution/contract.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import {
  WorkflowRunNotExecutableError,
  WorkflowRunNotFoundError,
} from '../errors.js';
import {
  acceptWorkflowRunWithAudit,
  requireWorkflowRunRecord,
} from './records.repository.js';
import type { ReplayPublishedWorkflowRunInput } from './contract.js';
import type { WorkflowRunRecord } from './records.repository.js';

export async function replayWorkflowRunInTransaction(
  transaction: WorkspaceTransaction,
  input: ReplayPublishedWorkflowRunInput,
): Promise<Readonly<{ run: WorkflowRunRecord; replayed: boolean }>> {
  const identity = {
    keyHash: input.idempotencyKeyHash,
    operation: 'workflow.run.accept' as const,
    requestHash: input.requestHash,
    scope: input.scope,
  };
  const replay = await readWorkflowRunAcceptanceReplay(transaction, identity);
  if (replay !== null) {
    const run = await requireWorkflowRunRecord(transaction, replay.runId);
    return Object.freeze({ run, replayed: true });
  }

  const source = await lockReplaySource(transaction, input.sourceRunId);
  const projection = await lockReplayVersion(
    transaction,
    source.workflowId,
    input.workflowVersionId,
  );
  const initial = input.checkpointFactory(projection);
  return acceptWorkflowRunWithAudit(transaction, {
    acceptance: {
      initialCheckpoint: initial.checkpoint,
      ...(initial.validateInput === undefined
        ? {}
        : { validateInput: initial.validateInput }),
      keyHash: input.idempotencyKeyHash,
      operation: 'workflow.run.accept',
      requestHash: input.requestHash,
      replayCommandId: generatePersistedId(),
      replaySourceRunId: input.sourceRunId,
      runInput: input.input,
      scope: input.scope,
      triggerType: 'replay',
      workflowId: source.workflowId,
      workflowVersionId: projection.id,
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.deadlineAt }),
      ...(input.traceparent === undefined
        ? {}
        : { traceparent: input.traceparent }),
    },
    actorId: input.actorId,
    auditAction: 'workflow.run.replayed',
    auditMetadata: sql`jsonb_build_object('sourceRunId', ${input.sourceRunId}::text, 'workflowId', ${source.workflowId}::text, 'workflowVersionId', ${projection.id}::text)`,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
  });
}

export async function lockReplaySource(
  transaction: WorkspaceTransaction,
  sourceRunId: string,
): Promise<Readonly<{ workflowId: string }>> {
  const [source] = await transaction.db
    .select({
      workflow_id: sql<string>`source.workflow_id`,
      lifecycle_status: sql<string>`source.lifecycle_status`,
    })
    .from(
      sql`app.lock_workflow_run_replay_source(${transaction.workspaceId},${sourceRunId}) as source`,
    );
  const [run] = await transaction.db
    .select({ trigger_type: workflowRuns.triggerType })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, transaction.workspaceId),
        eq(workflowRuns.id, sourceRunId),
      ),
    );
  if (isTestRun(run?.trigger_type)) throw new WorkflowRunNotExecutableError();
  if (source === undefined) throw new WorkflowRunNotFoundError();
  if (source.lifecycle_status !== 'active')
    throw new WorkflowRunNotExecutableError();
  return Object.freeze({ workflowId: source.workflow_id });
}

export async function lockReplayVersion(
  transaction: WorkspaceTransaction,
  workflowId: string,
  workflowVersionId: string,
): Promise<PublishedWorkflow> {
  const version = await findLockedReplayVersion(
    transaction,
    workflowId,
    workflowVersionId,
  );
  if (
    version?.workflowId !== workflowId ||
    version.workspaceId !== transaction.workspaceId
  )
    throw new WorkflowRunNotFoundError();
  return version;
}

export async function findLockedReplayVersion(
  transaction: WorkspaceTransaction,
  workflowId: string,
  workflowVersionId: string,
): Promise<PublishedWorkflow | null> {
  // The app cannot update immutable version rows; this retained guard owns their share lock.
  const [row] = await transaction.db
    .select({
      id: sql<string>`version.id`,
      workspaceId: sql<string>`version.workspace_id`,
      workflowId: sql<string>`version.workflow_id`,
      versionNumber: sql<number>`version.version_number`,
      checksum: sql<string>`version.checksum`,
      executableJson: sql<unknown>`version.executable_json`,
    })
    .from(
      sql`app.lock_workflow_run_replay_version(${transaction.workspaceId},${workflowId},${workflowVersionId}) as version`,
    );
  return row === undefined ? null : Object.freeze(row);
}
