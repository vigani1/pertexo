import { shareLockPublishedVersionId } from './execution-sources.repository.js';
import { readWorkflowRunAcceptanceReplay } from './acceptance/replay.repository.js';
import { lockRunAcceptanceCommand } from './acceptance/lock.repository.js';
import {
  readManualStartRejection,
  recordManualStartRejection,
  type ManualStartRejection,
} from './start-rejections.repository.js';
import { findPublishedWorkflow } from '../queries/execution/published.repository.js';
import type { PublishedWorkflow } from '../queries/execution/workflow-execution.types.js';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { IdempotencyRequestConflictError } from '../../shared/command-receipt.errors.js';
import {
  WorkflowRunNotExecutableError,
  WorkflowRunNotFoundError,
} from '../workflow-run.errors.js';
import {
  acceptWorkflowRunWithAudit,
  readWorkflowRunRecord,
} from './workflow-run-records.repository.js';
import type { WorkflowRunRecord } from './workflow-run-records.repository.js';
import type { StartPublishedWorkflowRunInput } from './run-commands.types.js';

export async function startInTransaction(
  transaction: WorkspaceTransaction,
  input: StartPublishedWorkflowRunInput,
): Promise<
  Readonly<{ run: WorkflowRunRecord; replayed: boolean }> | ManualStartRejection
> {
  await lockRunAcceptanceCommand(transaction, input);
  const identity = {
    keyHash: input.idempotencyKeyHash,
    operation: 'workflow.run.accept' as const,
    requestHash: input.requestHash,
    scope: input.scope,
  };
  const replay = await readWorkflowRunAcceptanceReplay(transaction, identity);
  if (replay !== null) {
    const run = await readWorkflowRunRecord(transaction, replay.runId);
    if (run === undefined) throw new WorkflowRunNotFoundError();
    return Object.freeze({ run, replayed: true });
  }
  const stored = await readManualStartRejection(transaction, input);
  if (stored !== undefined) {
    if (stored.requestHash !== input.requestHash)
      throw new IdempotencyRequestConflictError();
    return stored.rejection;
  }

  const projection = await lockPublishedExecution(
    transaction,
    input.workflowId,
  );
  if (
    input.expectedPublishedVersionId !== undefined &&
    input.expectedPublishedVersionId !== projection.id
  ) {
    return recordManualStartRejection(
      transaction,
      input,
      input.expectedPublishedVersionId,
      projection.id,
    );
  }
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
      scope: input.scope,
      triggerType: 'manual',
      workflowId: input.workflowId,
      workflowVersionId: projection.id,
      ...(input.input === undefined ? {} : { runInput: input.input }),
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.deadlineAt }),
      ...(input.traceparent === undefined
        ? {}
        : { traceparent: input.traceparent }),
    },
    actorId: input.actorId,
    auditAction: 'workflow.run.started',
    auditMetadata: {
      workflowId: input.workflowId,
      workflowVersionId: projection.id,
    },
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
  });
}

async function lockPublishedExecution(
  transaction: WorkspaceTransaction,
  workflowId: string,
): Promise<PublishedWorkflow> {
  const publishedVersionId = await shareLockPublishedVersionId(
    transaction,
    workflowId,
  );
  if (publishedVersionId === undefined || publishedVersionId === null)
    throw new WorkflowRunNotExecutableError();
  const version = await findPublishedWorkflow(transaction.db, {
    workspaceId: transaction.workspaceId,
    workflowId,
    id: publishedVersionId,
  });
  if (
    version?.workflowId !== workflowId ||
    version.workspaceId !== transaction.workspaceId
  )
    throw new WorkflowRunNotExecutableError();
  return version;
}
