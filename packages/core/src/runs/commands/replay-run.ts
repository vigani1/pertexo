import { isTestRun } from '../../shared/run-retention.repository.js';
import {
  findLockedReplayVersion,
  lockReplaySourceRow,
  readRunTriggerType,
} from './execution-sources.repository.js';

import { readWorkflowRunAcceptanceReplay } from './acceptance/replay.repository.js';
import type { PublishedWorkflow } from '../queries/execution/workflow-execution.types.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { generatePersistedId } from '@pertexo/database/platform';
import {
  WorkflowRunNotExecutableError,
  WorkflowRunNotFoundError,
} from '../workflow-run.errors.js';
import {
  acceptWorkflowRunWithAudit,
  requireWorkflowRunRecord,
} from './workflow-run-records.repository.js';
import type { ReplayPublishedWorkflowRunInput } from './run-commands.types.js';
import type { WorkflowRunRecord } from './workflow-run-records.repository.js';

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
    auditMetadata: {
      sourceRunId: input.sourceRunId,
      workflowId: source.workflowId,
      workflowVersionId: projection.id,
    },
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
  });
}

export async function lockReplaySource(
  transaction: WorkspaceTransaction,
  sourceRunId: string,
): Promise<Readonly<{ workflowId: string }>> {
  const source = await lockReplaySourceRow(transaction, sourceRunId);
  const triggerType = await readRunTriggerType(transaction, sourceRunId);
  if (isTestRun(triggerType)) throw new WorkflowRunNotExecutableError();
  if (source === undefined) throw new WorkflowRunNotFoundError();
  if (source.lifecycleStatus !== 'active')
    throw new WorkflowRunNotExecutableError();
  return Object.freeze({ workflowId: source.workflowId });
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
