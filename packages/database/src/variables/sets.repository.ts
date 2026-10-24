import type { WorkspaceVariableValues } from '@pertexo/workflow-model';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  canonicalJson,
  WORKSPACE_VARIABLE_LIMITS,
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
          ...(input.descriptions === undefined
            ? {}
            : { descriptions: input.descriptions }),
        }),
      )
      .digest('hex'),
  });
  if (replay !== null) return { ...result.parse(replay), replayed: true };
  const current = await readCurrentVariableRevision(client, input.workspaceId);
  if (current.revision !== input.expectedRevision)
    throw new WorkspaceVariablesConflictError();
  // An update without metadata keeps descriptions for the names it retains.
  const descriptions: Record<string, string> = {};
  for (const [name, description] of Object.entries(
    input.descriptions ?? current.descriptions,
  ))
    if (Object.hasOwn(input.values, name) && description !== '')
      descriptions[name] = description;
  const names = [
    ...new Set([...Object.keys(current.values), ...Object.keys(input.values)]),
  ]
    .sort()
    .filter(
      (name) =>
        !Object.is(current.values[name], input.values[name]) ||
        current.descriptions[name] !== descriptions[name],
    );
  let revision = current.revision;
  if (names.length > 0) {
    revision = current.revision + 1;
    const inserted = await client.query<{ revision: number }>(
      `insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json,descriptions_json)
       values($1,$2,$3::jsonb,$4::jsonb) on conflict do nothing returning revision`,
      [
        input.workspaceId,
        revision,
        canonicalJson(input.values),
        canonicalJson(descriptions),
      ],
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
        JSON.stringify({
          revision,
          changedNames: names.slice(0, WORKSPACE_VARIABLE_LIMITS.count),
          ...(names.length > WORKSPACE_VARIABLE_LIMITS.count
            ? { changedCount: names.length, changedNamesTruncated: true }
            : {}),
        }),
      ],
    );
  }
  const accepted = { revision, changed: names.length > 0 };
  await completeCommand(client, identity, accepted);
  return { ...accepted, replayed: false };
}

async function readCurrentVariableRevision(
  client: PoolClient,
  workspaceId: string,
) {
  const found = await client.query<{ revision: number }>(
    'select revision from app.workspace_variables where workspace_id=$1 for update',
    [workspaceId],
  );
  const row = found.rows[0];
  const stored =
    row === undefined
      ? undefined
      : (
          await client.query<{
            values_json: WorkspaceVariableValues;
            descriptions_json: Readonly<Record<string, string>>;
          }>(
            'select values_json,descriptions_json from app.workspace_variable_set_revisions where workspace_id=$1 and revision=$2',
            [workspaceId, row.revision],
          )
        ).rows[0];
  if (row !== undefined && stored === undefined)
    throw new Error('Workspace variable revision is missing');
  const current = {
    revision: row?.revision ?? 0,
    values: stored?.values_json ?? {},
    descriptions: stored?.descriptions_json ?? {},
  };

  return current;
}
