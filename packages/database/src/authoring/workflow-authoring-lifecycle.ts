import { generatePersistedId } from '../platform/persisted-id.js';

import { canonicalOutboxPayloadChecksum } from '../execution/outbox.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { planWorkflowLifecycleCommand } from '@pertexo/workflow-model/lifecycle';

import {
  claimWorkflowCommand,
  completeWorkflowCommand,
  type WorkflowCommandClaim,
} from './workflow-authoring-command-receipts.js';
import {
  WorkflowLifecycleRevisionConflictError,
  WorkflowNotFoundError,
} from './workflow-authoring-errors.js';
import type {
  TransitionWorkflowLifecycleInput,
  TransitionWorkflowLifecycleResult,
  WorkflowAuthoringDatabase,
} from './workflow-authoring-contracts.js';
import type { WorkflowAuthoringTestHooks } from './workflow-authoring-types.js';
import type { WorkflowRecord } from './workflow-authoring-records.js';
import { workflowRowSelection } from './workflow-authoring-rows.js';
import { reconcileWorkflowTriggersPayload } from './workflow-trigger-reconciliation.js';

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

export type WorkflowAuthoringLifecycleContext = Readonly<{
  keyDigest(key: string): string;
  mapWorkflow(row: Record<string, unknown>): WorkflowRecord;
  requireAuthor(
    client: PoolClient,
    workspaceId: string,
    actorId: string,
  ): Promise<void>;
  testHooks?: WorkflowAuthoringTestHooks;
  transact<T>(
    workspaceId: string,
    actorId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T>;
}>;

async function claimLifecycle(
  client: PoolClient,
  input: TransitionWorkflowLifecycleInput,
  context: WorkflowAuthoringLifecycleContext,
): Promise<WorkflowCommandClaim> {
  const command = commandSchema.parse(input.command);
  const workspaceId = uuidSchema.parse(input.workspaceId);
  const workflowId = uuidSchema.parse(input.workflowId);
  const actorId = uuidSchema.parse(input.actorId);
  return claimWorkflowCommand(client, {
    label: 'lifecycle',
    operation: `workflow.${command}`,
    digest: context.keyDigest(input.idempotencyKey),
    requestHash: canonicalOutboxPayloadChecksum({
      actorId,
      command,
      expectedLifecycleRevision: lifecycleRevisionSchema.parse(
        input.expectedLifecycleRevision,
      ),
      workflowId,
      workspaceId,
    }),
    workflowId,
    workspaceId,
    actorId,
  });
}

async function transitionWorkflowLifecycle(
  context: WorkflowAuthoringLifecycleContext,
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
    const claim = await claimLifecycle(client, input, context);
    await context.testHooks?.afterLifecycleStep?.('claim');
    if (claim.replay !== null)
      return Object.freeze({ replayed: true, workflow: claim.replay });

    const currentResult = await client.query<Record<string, unknown>>(
      `select ${workflowRowSelection} from app.workflows
       where workspace_id=$1 and id=$2 for update`,
      [workspaceId, workflowId],
    );
    const currentRow = currentResult.rows[0];
    if (currentRow === undefined)
      throw new WorkflowNotFoundError('Workflow is not visible');
    const current = context.mapWorkflow(currentRow);
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
      workflow = context.mapWorkflow(updatedRow);
      await context.testHooks?.afterLifecycleStep?.('workflow');

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
             (id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,
              payload,payload_checksum)
           values($1,$2,'reconcile-workflow-triggers',1,'workflow',$3,$4::jsonb,$5)`,
          [
            outboxEventId,
            workspaceId,
            workflowId,
            JSON.stringify(payload),
            canonicalOutboxPayloadChecksum(payload),
          ],
        );
        await context.testHooks?.afterLifecycleStep?.('outbox');
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
      await context.testHooks?.afterLifecycleStep?.('audit');
    }

    await completeWorkflowCommand(client, claim, workflow);
    await context.testHooks?.afterLifecycleStep?.('idempotency');
    return Object.freeze({ replayed: false, workflow });
  });
}

export function createWorkflowAuthoringLifecycleStore(
  context: WorkflowAuthoringLifecycleContext,
): WorkflowLifecycleStore {
  return Object.freeze({
    transitionWorkflowLifecycle: (input) =>
      transitionWorkflowLifecycle(context, input),
  });
}
