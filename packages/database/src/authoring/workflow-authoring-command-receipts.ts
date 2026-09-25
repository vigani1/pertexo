import { generatePersistedId } from '../platform/persisted-id.js';

import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  workflowActivationStatusSchema,
  workflowLifecycleStatusSchema,
} from '@pertexo/workflow-model/lifecycle';

import { WorkflowIdempotencyConflictError } from './workflow-authoring-errors.js';
import type { WorkflowRecord } from './workflow-authoring-records.js';

const uuidSchema = z.uuid();
const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * The accepted workflow summary an exact command retry replays. Receipts
 * completed before ADR 041 carry no name revision; every workflow still had
 * its initial name revision then, so a missing value replays as one.
 */
const durableWorkflowSchema = z
  .object({
    id: uuidSchema,
    workspaceId: uuidSchema,
    name: z.string().trim().min(1).max(128),
    nameRevision: revisionSchema.default(1),
    lifecycleStatus: workflowLifecycleStatusSchema,
    lifecycleRevision: revisionSchema,
    activationStatus: workflowActivationStatusSchema,
    publishedVersionId: uuidSchema.nullable(),
    createdBy: uuidSchema,
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .strict();

const durableCommandResultSchema = z
  .object({ workflow: durableWorkflowSchema })
  .strict();

/** A claimed actor-, workspace-, workflow- and operation-scoped command key. */
export type WorkflowCommandClaim = Readonly<{
  label: string;
  digest: string;
  operation: string;
  replay: WorkflowRecord | null;
  scope: string;
}>;

function serializeWorkflow(workflow: WorkflowRecord): Record<string, unknown> {
  return {
    id: workflow.id,
    workspaceId: workflow.workspaceId,
    name: workflow.name,
    nameRevision: workflow.nameRevision,
    lifecycleStatus: workflow.lifecycleStatus,
    lifecycleRevision: workflow.lifecycleRevision,
    activationStatus: workflow.activationStatus,
    publishedVersionId: workflow.publishedVersionId,
    createdBy: workflow.createdBy,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
  };
}

function durableCommandResult(
  label: string,
  value: unknown,
  expectedWorkspaceId: string,
  expectedWorkflowId: string,
): WorkflowRecord {
  const parsed = durableCommandResultSchema.parse(value).workflow;
  if (
    parsed.workspaceId !== expectedWorkspaceId ||
    parsed.id !== expectedWorkflowId
  )
    throw new Error(
      `Durable workflow ${label} result identity does not match its claim`,
    );
  return Object.freeze({ ...parsed });
}

/**
 * Claims the command key under a row lock, or returns the completed result for
 * an exact retry. A different request under the same key conflicts.
 */
export async function claimWorkflowCommand(
  client: PoolClient,
  input: Readonly<{
    /** Names the command in diagnostics, e.g. `lifecycle`. */
    label: string;
    operation: `workflow.${string}`;
    digest: string;
    requestHash: string;
    workflowId: string;
    workspaceId: string;
    actorId: string;
  }>,
): Promise<WorkflowCommandClaim> {
  const workspaceId = uuidSchema.parse(input.workspaceId);
  const workflowId = uuidSchema.parse(input.workflowId);
  const actorId = uuidSchema.parse(input.actorId);
  const operation = input.operation;
  const scope = `${actorId}:${workflowId}`;
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
      input.digest,
      input.requestHash,
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
    [workspaceId, operation, scope, input.digest],
  );
  const claim = result.rows[0];
  if (claim === undefined)
    throw new Error(`Workflow ${input.label} idempotency claim is unavailable`);
  if (claim.request_hash !== input.requestHash)
    throw new WorkflowIdempotencyConflictError(
      'Idempotency key request mismatch',
    );
  return Object.freeze({
    label: input.label,
    digest: input.digest,
    operation,
    replay:
      claim.status === 'completed'
        ? durableCommandResult(
            input.label,
            claim.result_ref,
            workspaceId,
            workflowId,
          )
        : null,
    scope,
  });
}

/** Records the accepted summary so an exact retry replays it unchanged. */
export async function completeWorkflowCommand(
  client: PoolClient,
  claim: WorkflowCommandClaim,
  workflow: WorkflowRecord,
): Promise<void> {
  const result = await client.query(
    `update app.idempotency_records set status='completed',result_ref=$1::jsonb,
       updated_at=transaction_timestamp()
     where workspace_id=$2 and operation=$3 and scope=$4 and key_hash=$5`,
    [
      JSON.stringify({ workflow: serializeWorkflow(workflow) }),
      workflow.workspaceId,
      claim.operation,
      claim.scope,
      claim.digest,
    ],
  );
  if (result.rowCount !== 1)
    throw new Error(
      `Workflow ${claim.label} idempotency completion is unavailable`,
    );
}
