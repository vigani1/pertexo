import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { readWorkflowRunAcceptanceReplay } from './acceptance.js';
import {
  parsePublishedWorkflowRow,
  type PublishedWorkflow,
} from '../published-workflow.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import {
  WorkflowRunNotExecutableError,
  WorkflowRunNotFoundError,
} from '../errors.js';
import {
  acceptWorkflowRunWithAudit,
  requireWorkflowRunRecord,
} from './records.js';
import type { ReplayPublishedWorkflowRunInput } from '../runs.repository.js';
import type { WorkflowRunRecord } from './records.js';

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

async function lockReplaySource(
  transaction: WorkspaceTransaction,
  sourceRunId: string,
): Promise<Readonly<{ workflowId: string }>> {
  const result = await transaction.db.execute<{
    workflow_id: string;
    lifecycle_status: string;
  }>(sql`
    select workflow_id, lifecycle_status
    from app.lock_workflow_run_replay_source(
      ${transaction.workspaceId}, ${sourceRunId}
    )
  `);
  const source = result.rows[0];
  if (source === undefined) throw new WorkflowRunNotFoundError();
  if (source.lifecycle_status !== 'active')
    throw new WorkflowRunNotExecutableError();
  return Object.freeze({ workflowId: z.uuid().parse(source.workflow_id) });
}

async function lockReplayVersion(
  transaction: WorkspaceTransaction,
  workflowId: string,
  workflowVersionId: string,
): Promise<PublishedWorkflow> {
  const result = await transaction.db.execute(sql<Record<string, unknown>>`
    select
      id,
      workspace_id,
      workflow_id,
      version_number,
      checksum,
      executable_json
    from app.lock_workflow_run_replay_version(
      ${transaction.workspaceId}, ${workflowId}, ${workflowVersionId}
    )
  `);
  const version = parsePublishedWorkflowRow(result.rows[0]);
  if (
    version?.workflowId !== workflowId ||
    version.workspaceId !== transaction.workspaceId
  )
    throw new WorkflowRunNotFoundError();
  return version;
}
