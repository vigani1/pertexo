import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { canonicalWorkflowPortableJson } from '@pertexo/workflow-model/portability-contract';
import type { ImportWorkflowInput } from './workflow-authoring-contracts.js';
import type { WorkflowAuthoringWriteContext } from './workflow-authoring-context.js';
import { generatePersistedId } from '../platform/persisted-id.js';
import { WorkflowIdempotencyConflictError } from './workflow-authoring-errors.js';

/** Hash the public command only; tenant/actor identity is its separate SQL scope. */
export function workflowImportCommandIdentity(input: ImportWorkflowInput) {
  const command = canonicalWorkflowPortableJson({
    manifest: input.manifest,
    bindings: input.bindings,
    name: input.name,
    expectedCompatibilityFingerprint: input.expectedCompatibilityFingerprint,
    ...(input.templateOrigin === undefined
      ? {}
      : { templateOrigin: input.templateOrigin }),
  });
  const requestHash = createHash('sha256').update(command).digest('hex');
  return { command, requestHash };
}

export async function claimWorkflowImport(
  client: PoolClient,
  context: WorkflowAuthoringWriteContext,
  input: ImportWorkflowInput,
) {
  const destinationId = generatePersistedId();
  const keyHash = context.keyDigest(input.idempotencyKey);
  const { command, requestHash } = workflowImportCommandIdentity(input);
  await client.query(
    `insert into app.idempotency_records(id,workspace_id,operation,scope,key_hash,request_hash,status,resource_id,result_ref,expires_at)
     values($1,$2,'workflow.import',$3,$4,$5,'in_progress',$6,'{}'::jsonb,clock_timestamp()+interval '24 hours')
     on conflict(workspace_id,operation,scope,key_hash) do nothing`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.actorId,
      keyHash,
      requestHash,
      destinationId,
    ],
  );
  const result = await client.query<{
    request_hash: string;
    status: string;
    resource_id: string;
    result_ref: unknown;
  }>(
    "select request_hash,status,resource_id,result_ref from app.idempotency_records where workspace_id=$1 and operation='workflow.import' and scope=$2 and key_hash=$3 for update",
    [input.workspaceId, input.actorId, keyHash],
  );
  const row = result.rows[0];
  if (row === undefined)
    throw new Error('Workflow import claim is unavailable');
  if (row.request_hash !== requestHash)
    throw new WorkflowIdempotencyConflictError(
      'Idempotency key request mismatch',
    );
  const replay =
    row.status === 'completed'
      ? z.object({ workflowId: z.uuid() }).strict().parse(row.result_ref)
      : null;
  if (replay !== null && replay.workflowId !== row.resource_id)
    throw new Error('Workflow import receipt identity is inconsistent');
  if (replay === null && row.resource_id !== destinationId)
    throw new Error('Workflow import claim is incomplete');
  return { destinationId, keyHash, requestHash, command, replay };
}

export async function completeWorkflowImport(
  client: PoolClient,
  input: ImportWorkflowInput,
  keyHash: string,
  workflowId: string,
) {
  const result = Object.freeze({ workflowId });
  const completed = await client.query(
    `update app.idempotency_records set status='completed',result_ref=$1::jsonb,updated_at=transaction_timestamp()
     where workspace_id=$2 and operation='workflow.import' and scope=$3 and key_hash=$4 and status='in_progress'`,
    [JSON.stringify(result), input.workspaceId, input.actorId, keyHash],
  );
  if (completed.rowCount !== 1)
    throw new Error('Workflow import completion is unavailable');
  return result;
}
