import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FormAccess } from '@pertexo/contracts';
import {claimCommand, completeCommand} from '../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { FormAccessConflictError, type FormStore } from './contract.js';
export const capabilityHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export async function readFormAccess(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; workflowId: string }>,
): Promise<FormAccess> {
  const result = await client.query<FormAccess>(
    `select access,public_id "publicId",revision from app.workflow_forms where workspace_id=$1 and workflow_id=$2`,
    [input.workspaceId, input.workflowId],
  );
  return result.rows[0] ?? { access: 'members', publicId: null, revision: 0 };
}
export async function changeFormAccess(
  client: PoolClient,
  input: Parameters<FormStore['setAccess']>[0],
  nodeId: string,
): Promise<FormAccess> {
  const command = {
    workspaceId: input.workspaceId,
    operation: 'form.access',
    scope: `${input.actorId}:${input.workflowId}`,
    idempotencyKey: input.idempotencyKey,
  };
  const digest =
    input.access === 'public' ? capabilityHash(input.capability) : null;
  const replay = await claimCommand(client, {
    ...command,
    request: {
      access: input.access,
      expectedRevision: input.expectedRevision,
      capabilityHash: digest,
    },
    resourceId: input.workflowId,
  });
  if (replay !== null) return replay as FormAccess;
  const current = await readFormAccess(client, input);
  if (current.revision !== input.expectedRevision)
    throw new FormAccessConflictError();
  const result = await client.query<FormAccess>(
    `insert into app.workflow_forms(workspace_id,workflow_id,public_id,access,capability_hash,revision,node_id) values($1,$2,$3,$4,$5,1,$6)
    on conflict(workspace_id,workflow_id) do update set access=excluded.access,capability_hash=excluded.capability_hash,node_id=excluded.node_id,revision=workflow_forms.revision+1,updated_at=clock_timestamp()
    returning access,public_id "publicId",revision`,
    [
      input.workspaceId,
      input.workflowId,
      generatePersistedId(),
      input.access,
      digest,
      nodeId,
    ],
  );
  const changed = result.rows[0];
  if (changed === undefined) throw new Error('Form access write missing');
  await client.query(
    `insert into app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata) values($1,$2,$3,'form.access_changed','workflow',$4,$5,$6,$7::jsonb)`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.actorId,
      input.workflowId,
      input.requestId ?? null,
      input.traceId ?? null,
      JSON.stringify({ access: changed.access, revision: changed.revision }),
    ],
  );
  await completeCommand(client, command, changed);
  return changed;
}
