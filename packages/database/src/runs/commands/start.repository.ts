import { workflows } from '../../schema/authoring/workflows.js';
import { and, eq } from 'drizzle-orm';
import { readWorkflowRunAcceptanceReplay } from './acceptance/replay.repository.js';
import { lockRunAcceptanceCommand } from './lock-acceptance.repository.js';
import {
  readManualStartRejection,
  recordManualStartRejection,
  type ManualStartRejection,
} from './manual-start.repository.js';
import { findPublishedWorkflow } from '../queries/execution/published.queries.js';
import type { PublishedWorkflow } from '../queries/execution/contract.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import {
  WorkflowRunNotExecutableError,
  WorkflowRunNotFoundError,
} from '../errors.js';
import {
  acceptWorkflowRunWithAudit,
  readWorkflowRunRecord,
} from './records.repository.js';
import type { WorkflowRunRecord } from './records.repository.js';
import type { StartInput } from './input.js';

export async function startInTransaction(
  transaction: WorkspaceTransaction,
  input: StartInput,
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
  const rejection = await readManualStartRejection(transaction, input);
  if (rejection !== null) return rejection;

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
  // Lock the workflow on its own. A locked join that waits on a concurrent
  // publication re-checks the new workflow row against the old version row,
  // finds nothing and would report an executable workflow as unavailable.
  const [locked] = await transaction.db
    .select({ publishedVersionId: workflows.publishedVersionId })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, transaction.workspaceId),
        eq(workflows.id, workflowId),
        eq(workflows.lifecycleStatus, 'active'),
      ),
    )
    .for('share');
  const publishedVersionId = locked?.publishedVersionId;
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
