import { appendAuditFact } from '../../../governance/audit/facts.js';
import type { PoolClient } from 'pg';

import { planWorkflowLifecycleCommand } from '@pertexo/workflow-model';

import { enqueueTriggerReconciliation } from '../../publication/trigger-reconciliation.repository.js';
import type {
  TransitionWorkflowLifecycleInput,
  TransitionWorkflowLifecycleResult,
} from '../workflow-commands.types.js';
import {
  WorkflowLifecycleRevisionConflictError,
  WorkflowNotFoundError,
} from '../workflow-authoring.errors.js';
import {
  claimWorkflowCommand,
  completeWorkflowCommand,
  type WorkflowCommand,
} from '../receipts.repository.js';
import { lockWorkflowRecord, shareLockWorkflow } from './locks.repository.js';
import { transitionAtRevision } from './workflow-revisions.repository.js';

export async function transitionWorkflowLifecycle(
  client: PoolClient,
  input: TransitionWorkflowLifecycleInput,
): Promise<TransitionWorkflowLifecycleResult> {
  const command = input.command;
  const workspaceId = input.workspaceId;
  const workflowId = input.workflowId;
  const actorId = input.actorId;
  const expectedLifecycleRevision = input.expectedLifecycleRevision;
  const requestId = input.requestId;
  const traceId = input.traceId;

  const claim: WorkflowCommand = {
    workspaceId,
    workflowId,
    actorId,
    operation: `workflow.${command}`,
    idempotencyKey: input.idempotencyKey,
    ...(input.commandCredentialId === undefined
      ? {}
      : { commandCredentialId: input.commandCredentialId }),
    request: { expectedLifecycleRevision },
  };
  const replay = await claimWorkflowCommand(client, claim);
  if (replay !== null) {
    if (!(await shareLockWorkflow(client, { workspaceId, workflowId })))
      throw new WorkflowNotFoundError('Workflow is not visible');
    return Object.freeze({ replayed: true, workflow: replay });
  }

  const currentRow = await lockWorkflowRecord(
    client,
    { workspaceId, workflowId },
    { active: false },
  );
  if (currentRow === undefined)
    throw new WorkflowNotFoundError('Workflow is not visible');
  const current = Object.freeze(currentRow);
  if (current.lifecycleRevision !== expectedLifecycleRevision)
    throw new WorkflowLifecycleRevisionConflictError(current.lifecycleRevision);

  const decision = planWorkflowLifecycleCommand({
    activationStatus: current.activationStatus,
    command,
    hasPublishedVersion: current.publishedVersionId !== null,
    lifecycleStatus: current.lifecycleStatus,
  });
  let workflow = current;
  if (decision.changed) {
    const updatedRow = await transitionAtRevision(client, {
      workspaceId,
      workflowId,
      lifecycleStatus: decision.lifecycleStatus,
      activationStatus: decision.activationStatus,
      expectedLifecycleRevision,
    });
    if (updatedRow === undefined)
      throw new WorkflowLifecycleRevisionConflictError(
        current.lifecycleRevision,
      );
    workflow = Object.freeze(updatedRow);

    if (decision.reconcileTriggers) {
      await enqueueLifecycleReconciliation(client, {
        workspaceId,
        workflowId,
        publishedVersionId: current.publishedVersionId,
        traceparent: input.traceparent,
      });
    }

    await appendAuditFact(client, {
      workspaceId,
      actorId: actorId,
      action: command === 'archive' ? 'workflow.archived' : 'workflow.restored',
      targetType: 'workflow',
      targetId: workflowId,
      requestId: requestId ?? null,
      traceId: traceId ?? null,
      metadata: {
        activationStatus: workflow.activationStatus,
        lifecycleRevision: workflow.lifecycleRevision,
        lifecycleStatus: workflow.lifecycleStatus,
        previousActivationStatus: current.activationStatus,
        previousLifecycleRevision: current.lifecycleRevision,
        previousLifecycleStatus: current.lifecycleStatus,
        publishedVersionId: current.publishedVersionId,
      },
    });
  }

  await completeWorkflowCommand(client, claim, workflow);
  return Object.freeze({ replayed: false, workflow });
}

async function enqueueLifecycleReconciliation(
  client: PoolClient,
  {
    workspaceId,
    workflowId,
    publishedVersionId,
    traceparent,
  }: Readonly<{
    workspaceId: string;
    workflowId: string;
    publishedVersionId: string | null;
    traceparent: string | undefined;
  }>,
) {
  if (publishedVersionId === null)
    throw new Error(
      'Workflow lifecycle reconciliation requires a published version',
    );
  await enqueueTriggerReconciliation(client, {
    workspaceId,
    workflowId,
    publishedVersionId,
    traceparent,
  });
}
