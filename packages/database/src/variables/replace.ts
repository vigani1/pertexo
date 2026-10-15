import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  canonicalJson,
  workspaceVariableSnapshotSchema,
} from '@pertexo/workflow-model';
import { claimCommand, completeCommand } from '../platform/idempotency.js';
import { generatePersistedId } from '../platform/persisted-id.js';
import {
  WorkspaceVariablesConflictError,
  type WorkspaceVariablesStore,
} from './contract.js';
const result = z
  .object({ revision: z.number().int().nonnegative(), changed: z.boolean() })
  .strict();
export async function replaceWorkspaceVariables(
  client: PoolClient,
  input: Parameters<WorkspaceVariablesStore['replace']>[0],
) {
  const identity = {
    workspaceId: input.workspaceId,
    scope: input.actorId,
    operation: 'workspace.variables.replace',
    idempotencyKey: input.idempotencyKey,
  };
  const replay = await claimCommand(client, {
    ...identity,
    resourceId: input.workspaceId,
    requestHash: createHash('sha256')
      .update(
        canonicalJson({
          expectedRevision: input.expectedRevision,
          values: input.values,
        }),
      )
      .digest('hex'),
  });
  if (replay !== null) return { ...result.parse(replay), replayed: true };
  const found = await client.query<{ revision: number }>(
    'select revision from app.workspace_variables where workspace_id=$1 for update',
    [input.workspaceId],
  );
  const row = found.rows[0];
  const stored =
    row === undefined
      ? undefined
      : (
          await client.query<{ values_json: unknown }>(
            'select values_json from app.workspace_variable_set_revisions where workspace_id=$1 and revision=$2',
            [input.workspaceId, row.revision],
          )
        ).rows[0];
  const current = workspaceVariableSnapshotSchema.parse({
    revision: row?.revision ?? 0,
    values: row === undefined ? {} : stored?.values_json,
  });
  if (current.revision !== input.expectedRevision)
    throw new WorkspaceVariablesConflictError();
  const names = [
    ...new Set([...Object.keys(current.values), ...Object.keys(input.values)]),
  ]
    .sort()
    .filter((name) => !Object.is(current.values[name], input.values[name]));
  let revision = current.revision;
  if (names.length > 0) {
    revision = current.revision + 1;
    const inserted = await client.query<{ revision: number }>(
      `insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json)
       values($1,$2,$3::jsonb) on conflict do nothing returning revision`,
      [input.workspaceId, revision, canonicalJson(input.values)],
    );
    if (inserted.rowCount !== 1) throw new WorkspaceVariablesConflictError();
    const saved = await client.query<{ revision: number }>(
      `insert into app.workspace_variables(workspace_id,revision) values($1,$2)
       on conflict(workspace_id) do update set revision=excluded.revision,updated_at=clock_timestamp()
       where workspace_variables.revision=$3 returning revision`,
      [input.workspaceId, revision, input.expectedRevision],
    );
    if (saved.rowCount !== 1) throw new WorkspaceVariablesConflictError();
    await client.query(
      `insert into app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
   values($1,$2,$3,'workspace.variables_changed','workspace_variables',$2,$4,$5,$6::jsonb)`,
      [
        generatePersistedId(),
        input.workspaceId,
        input.actorId,
        input.requestId ?? null,
        input.traceId ?? null,
        JSON.stringify({ revision, changedNames: names }),
      ],
    );
  }
  const accepted = { revision, changed: names.length > 0 };
  await completeCommand(client, identity, accepted);
  return { ...accepted, replayed: false };
}
