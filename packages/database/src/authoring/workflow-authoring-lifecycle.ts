import { generatePersistedId } from '../platform/persisted-id.js';

import { canonicalOutboxPayloadChecksum } from '../execution/outbox.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  planWorkflowLifecycleCommand,
  workflowActivationStatusSchema,
  workflowLifecycleStatusSchema,
} from '@pertexo/workflow-model/lifecycle';

import {
  WorkflowIdempotencyConflictError,
  WorkflowLifecycleRevisionConflictError,
  WorkflowNotFoundError,
} from './workflow-authoring-errors.js';
import type {
  WorkflowAuthoringDatabase,
  WorkflowAuthoringTestHooks,
  WorkflowRecord,
} from './workflow-authoring.js';
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

export type WorkflowLifecycleCommand = z.output<typeof commandSchema>;

export type TransitionWorkflowLifecycleInput = Readonly<{
  command: WorkflowLifecycleCommand;
  workspaceId: string;
  workflowId: string;
  actorId: string;
  expectedLifecycleRevision: number;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
  traceparent?: string;
}>;

export type TransitionWorkflowLifecycleResult = Readonly<{
  workflow: WorkflowRecord;
  replayed: boolean;
}>;

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

type LifecycleClaim = Readonly<{
  digest: string;
  operation: string;
  replay: WorkflowRecord | null;
  scope: string;
}>;

const durableWorkflowSchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    name: z.string().trim().min(1).max(128),
    lifecycleStatus: workflowLifecycleStatusSchema,
    lifecycleRevision: lifecycleRevisionSchema,
    activationStatus: workflowActivationStatusSchema,
    publishedVersionId: uuidSchema.nullable(),
    createdBy: uuidSchema,
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .strict();

const durableLifecycleResultSchema = z
  .object({ workflow: durableWorkflowSchema })
  .strict();

function serializeWorkflow(workflow: WorkflowRecord): Record<string, unknown> {
  return {
    id: workflow.id,
    workspaceId: workflow.workspaceId,
    name: workflow.name,
    lifecycleStatus: workflow.lifecycleStatus,
    lifecycleRevision: workflow.lifecycleRevision,
    activationStatus: workflow.activationStatus,
    publishedVersionId: workflow.publishedVersionId,
    createdBy: workflow.createdBy,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
  };
}

function durableLifecycleResult(value: unknown): WorkflowRecord {
  const parsed = durableLifecycleResultSchema.parse(value).workflow;
  return Object.freeze({
    id: parsed.id,
    workspaceId: parsed.workspaceId,
    name: parsed.name,
    lifecycleStatus: parsed.lifecycleStatus,
    lifecycleRevision: parsed.lifecycleRevision,
    activationStatus: parsed.activationStatus,
    publishedVersionId: parsed.publishedVersionId,
    createdBy: parsed.createdBy,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  });
}

async function claimLifecycle(
  client: PoolClient,
  input: TransitionWorkflowLifecycleInput,
  context: WorkflowAuthoringLifecycleContext,
): Promise<LifecycleClaim> {
  const command = commandSchema.parse(input.command);
  const workspaceId = uuidSchema.parse(input.workspaceId);
  const workflowId = uuidSchema.parse(input.workflowId);
  const actorId = uuidSchema.parse(input.actorId);
  const operation = `workflow.${command}`;
  const scope = `${actorId}:${workflowId}`;
  const digest = context.keyDigest(input.idempotencyKey);
  const requestHash = canonicalOutboxPayloadChecksum({
    actorId,
    command,
    expectedLifecycleRevision: lifecycleRevisionSchema.parse(
      input.expectedLifecycleRevision,
    ),
    workflowId,
    workspaceId,
  });
  await client.query(
    `insert into app.idempotency_records
       (id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref,expires_at)
     values($1,$2,$3,$4,$5,$6,'in_progress',$7,'{}'::jsonb,
       clock_timestamp()+interval '24 hours')
     on conflict(workspace_id,operation,scope,key_hash) do nothing`,
    [
      generatePersistedId(),
      workspaceId,
      operation,
      scope,
      digest,
      requestHash,
      workflowId,
    ],
  );
  const result = await client.query<{
    request_hash: string;
    result_ref: unknown;
    status: string;
  }>(
    `select request_hash,status,result_ref from app.idempotency_records
       where workspace_id=$1 and operation=$2 and scope=$3 and key_hash=$4
       for update`,
    [workspaceId, operation, scope, digest],
  );
  const claim = result.rows[0];
  if (claim === undefined)
    throw new Error('Workflow lifecycle idempotency claim is unavailable');
  if (claim.request_hash !== requestHash)
    throw new WorkflowIdempotencyConflictError(
      'Idempotency key request mismatch',
    );
  return Object.freeze({
    digest,
    operation,
    replay:
      claim.status === 'completed'
        ? durableLifecycleResult(claim.result_ref)
        : null,
    scope,
  });
}

async function completeLifecycleClaim(
  client: PoolClient,
  claim: LifecycleClaim,
  workspaceId: string,
  workflow: WorkflowRecord,
): Promise<void> {
  const result = await client.query(
    `update app.idempotency_records set status='completed',result_ref=$1::jsonb,
       updated_at=transaction_timestamp()
     where workspace_id=$2 and operation=$3 and scope=$4 and key_hash=$5`,
    [
      JSON.stringify({ workflow: serializeWorkflow(workflow) }),
      workspaceId,
      claim.operation,
      claim.scope,
      claim.digest,
    ],
  );
  if (result.rowCount !== 1)
    throw new Error('Workflow lifecycle idempotency completion is unavailable');
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

    await completeLifecycleClaim(client, claim, workspaceId, workflow);
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
