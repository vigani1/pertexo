import type { PoolClient } from 'pg';
import type { WorkflowTransitionPlan } from '@pertexo/workflow-engine';
import { generatePersistedId } from '@pertexo/database/platform';
import {
  errorWorkflowInput,
  errorWorkflowFailure,
} from '@pertexo/workflow-engine/server';
import { readErrorWorkflowStep } from './step.repository.js';
import {
  enqueueErrorWorkflowStart,
  insertErrorWorkflowIntent,
  insertRefusedErrorWorkflowIntent,
  readErrorWorkflowPolicy,
} from './intents.repository.js';
import { transitionStartsErrorWorkflow } from './refusal.js';

/** The terminal transition and its unique intent/outbox either all commit or none do. */
export async function persistErrorWorkflowIntent(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    workflowId: string;
    workflowVersionId: string;
    cancellationRequested: boolean;
    plan: WorkflowTransitionPlan;
    traceparent?: string;
  }>,
): Promise<void> {
  if (!transitionStartsErrorWorkflow(input)) return;
  const row = await readErrorWorkflowPolicy(client, input);
  if (row === undefined) return;
  const failed = errorWorkflowFailure(input.plan);
  const context = errorWorkflowInput({
    ...input,
    workflowName: row.workflow_name,
    ...(failed === undefined
      ? {}
      : {
          step: await readErrorWorkflowStep(client, {
            ...input,
            invocationKey: failed.invocationKey,
            nodeId: failed.nodeId,
          }),
        }),
  });
  if (row.target_version_id === null) {
    await insertRefusedErrorWorkflowIntent(client, {
      ...input,
      targetWorkflowId: row.target_workflow_id,
      context,
    });
    return;
  }
  const outboxEventId = generatePersistedId();
  const inserted = await insertErrorWorkflowIntent(client, {
    ...input,
    targetWorkflowId: row.target_workflow_id,
    targetVersionId: row.target_version_id,
    context,
    outboxEventId,
  });
  if (!inserted) return;
  const payload = {
    workspaceId: input.workspaceId,
    sourceRunId: input.runId,
    outboxEventId,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  };
  await enqueueErrorWorkflowStart(client, {
    ...input,
    outboxEventId,
    payload,
  });
}
