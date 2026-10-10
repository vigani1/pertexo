import { generatePersistedId } from '../../../platform/persisted-id.js';

import { canonicalOutboxPayloadChecksum } from '../../../outbox/events.js';
import { z } from 'zod';
import { planWorkflowLifecycleCommand } from '@pertexo/workflow-model';

import {
  claimWorkflowCommand,
  completeWorkflowCommand,
  type WorkflowCommand,
} from '../command-receipts.js';
import {
  WorkflowLifecycleRevisionConflictError,
  WorkflowNotFoundError,
} from '../errors.js';
import type {
  TransitionWorkflowLifecycleInput,
  TransitionWorkflowLifecycleResult,
  WorkflowAuthoringDatabase,
} from '../contracts.js';
import type { WorkflowAuthoringWriteContext } from '../context.js';
import { mapWorkflow, workflowRowSelection } from '../representation/rows.js';
import { reconcileWorkflowTriggersPayload } from '../../publication/trigger-reconciliation.js';

const uuidSchema = z.uuid();
const commandSchema = z.enum(['archive', 'restore']);
const lifecycleRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const requestIdSchema = z.string().max(128);

type WorkflowLifecycleStore = Pick<
  WorkflowAuthoringDatabase,
  'transitionWorkflowLifecycle'
>;

type WorkflowLifecycleContext = Pick<
  WorkflowAuthoringWriteContext,
  'requireAuthor' | 'transact'
>;

async function transitionWorkflowLifecycle(
  context: WorkflowLifecycleContext,
  input: TransitionWorkflowLifecycleInput,
): Promise<TransitionWorkflowLifecycleResult> {
  const command = commandSchema.parse(input.command);
  const workspaceId = uuidSchema.parse(input.workspaceId);
  const workflowId = uuidSchema.parse(input.workflowId);
  const actorId = uuidSchema.parse(input.actorId);
  const expectedLifecycleRevision = lifecycleRevisionSchema.parse(
    input.expectedLifecycleRevision,
  );
  const requestId =
    input.requestId === undefined
      ? undefined
      : requestIdSchema.parse(input.requestId);
  const traceId =
    input.traceId === undefined
      ? undefined
      : requestIdSchema.parse(input.traceId);

  return context.transact(workspaceId, actorId, async (client) => {
    await context.requireAuthor(client, workspaceId, actorId);
    const claim: WorkflowCommand = {
      workspaceId,
      workflowId,
      actorId,
      operation: `workflow.${command}`,
      idempotencyKey: input.idempotencyKey,
      request: { expectedLifecycleRevision },
    };
    const replay = await claimWorkflowCommand(client, claim);
    if (replay !== null) {
      const visible = await client.query(
        `select 1 from app.workflows where workspace_id=$1 and id=$2 for share`,
        [workspaceId, workflowId],
      );
      if (visible.rowCount !== 1)
        throw new WorkflowNotFoundError('Workflow is not visible');
      return Object.freeze({ replayed: true, workflow: replay });
    }

    const currentResult = await client.query<Record<string, unknown>>(
      `select ${workflowRowSelection} from app.workflows
       where workspace_id=$1 and id=$2 for update`,
      [workspaceId, workflowId],
    );
    const currentRow = currentResult.rows[0];
    if (currentRow === undefined)
      throw new WorkflowNotFoundError('Workflow is not visible');
    const current = mapWorkflow(currentRow);
    if (current.lifecycleRevision !== expectedLifecycleRevision)
      throw new WorkflowLifecycleRevisionConflictError(
        current.lifecycleRevision,
      );

    const decision = planWorkflowLifecycleCommand({
      activationStatus: current.activationStatus,
      command,
      hasPublishedVersion: current.publishedVersionId !== null,
      lifecycleStatus: current.lifecycleStatus,
    });
    let workflow = current;
    if (decision.changed) {
      const updatedResult = await client.query<Record<string, unknown>>(
        `update app.workflows set lifecycle_status=$3,activation_status=$4,
           lifecycle_revision=lifecycle_revision+1,updated_at=transaction_timestamp()
         where workspace_id=$1 and id=$2 and lifecycle_revision=$5
         returning ${workflowRowSelection}`,
        [
          workspaceId,
          workflowId,
          decision.lifecycleStatus,
          decision.activationStatus,
          expectedLifecycleRevision,
        ],
      );
      const updatedRow = updatedResult.rows[0];
      if (updatedRow === undefined)
        throw new WorkflowLifecycleRevisionConflictError(
          current.lifecycleRevision,
        );
      workflow = mapWorkflow(updatedRow);

      if (decision.reconcileTriggers) {
        if (current.publishedVersionId === null)
          throw new Error(
            'Workflow lifecycle reconciliation requires a published version',
          );
        const outboxEventId = generatePersistedId();
        const payload = reconcileWorkflowTriggersPayload({
          outboxEventId,
          publishedVersionId: current.publishedVersionId,
          ...(input.traceparent === undefined
            ? {}
            : { traceparent: input.traceparent }),
          workflowId,
          workspaceId,
        });
        await client.query(
          `insert into app.outbox_events
             (id,workspace_id,job_name,aggregate_type,aggregate_id,
              payload,payload_checksum)
           values($1,$2,'reconcile-workflow-triggers','workflow',$3,$4::jsonb,$5)`,
          [
            outboxEventId,
            workspaceId,
            workflowId,
            JSON.stringify(payload),
            canonicalOutboxPayloadChecksum(payload),
          ],
        );
      }

      await client.query(
        `insert into app.audit_events
           (id,workspace_id,actor_user_id,action,target_type,target_id,request_id,
            trace_id,metadata)
         values($1,$2,$3,$4,'workflow',$5,$6,$7,$8::jsonb)`,
        [
          generatePersistedId(),
          workspaceId,
          actorId,
          command === 'archive' ? 'workflow.archived' : 'workflow.restored',
          workflowId,
          requestId ?? null,
          traceId ?? null,
          JSON.stringify({
            activationStatus: workflow.activationStatus,
            lifecycleRevision: workflow.lifecycleRevision,
            lifecycleStatus: workflow.lifecycleStatus,
            previousActivationStatus: current.activationStatus,
            previousLifecycleRevision: current.lifecycleRevision,
            previousLifecycleStatus: current.lifecycleStatus,
            publishedVersionId: current.publishedVersionId,
          }),
        ],
      );
    }

    await completeWorkflowCommand(client, claim, workflow);
    return Object.freeze({ replayed: false, workflow });
  });
}

export function createWorkflowAuthoringLifecycleStore(
  context: WorkflowLifecycleContext,
): WorkflowLifecycleStore {
  return Object.freeze({
    transitionWorkflowLifecycle: (input) =>
      transitionWorkflowLifecycle(context, input),
  });
}
