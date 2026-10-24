import { callbackScopeHash } from './identity.js';
import {
  readPendingTaskAllowance,
  hasPendingTaskCapacity,
} from '../lifecycle/allowance.js';
import { callbackWaitConfigSchema } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import {
  lockCapabilityExecution,
  assertCapabilityExecution,
} from '../../../attempts/dispatch/fence.repository.js';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import {
  CallbackCapacityError,
  type CallbackStore,
  type PreparedCallback,
} from './contract.js';
export async function prepareCallbacks(
  client: PoolClient,
  input: Parameters<CallbackStore['prepare']>[0],
): Promise<readonly PreparedCallback[]> {
  await lockCapabilityExecution(client, input);
  await assertCapabilityExecution(client, input);
  if (input.previewRunId !== undefined)
    throw new Error('Previews cannot issue live callback URLs.');
  const scope = await client.query<{
    branch_context: Readonly<{ iterationPath?: unknown }>;
  }>(
    `select node.branch_context from app.node_runs node join app.workflow_runs run on run.workspace_id=node.workspace_id and run.id=node.workflow_run_id where node.workspace_id=$1 and node.id=$2 and run.id=$3`,
    [input.workspaceId, input.nodeRunId, input.runId],
  );
  const owner = scope.rows[0];
  if (owner === undefined)
    throw new Error('The callback execution scope is unavailable.');
  const iteration = owner.branch_context.iterationPath ?? [];
  const scopeHash = callbackScopeHash(iteration);
  await client.query('select app.lock_workspace_execution_counter($1)', [
    input.workspaceId,
  ]);
  const allowance = await readPendingTaskAllowance(client, input.workspaceId);
  let count = allowance.count;
  const result: PreparedCallback[] = [];
  for (const target of input.targets) {
    const existing = await client.query<{
      id: string;
      callback_key_version: string;
      callback_token_hash: string;
      config: unknown;
    }>(
      `select id,callback_key_version,callback_token_hash,config from app.pending_run_tasks where workspace_id=$1 and run_id=$2 and callback_node_id=$3 and callback_scope_hash=$4`,
      [input.workspaceId, input.runId, target.nodeId, scopeHash],
    );
    const found = existing.rows[0];
    const identity = {
      id: found?.id ?? generatePersistedId(),
      workspaceId: input.workspaceId,
      runId: input.runId,
      nodeId: target.nodeId,
      scopeHash,
    };
    if (found !== undefined) {
      result.push({
        ...identity,
        id: found.id,
        keyVersion: found.callback_key_version,
        tokenHash: found.callback_token_hash,
        config: callbackWaitConfigSchema.parse(found.config),
      });
      continue;
    }
    if (!hasPendingTaskCapacity({ ...allowance, count }))
      throw new CallbackCapacityError();
    count++;
    const id = identity.id,
      tokenHash = input.tokenHash(identity);
    await client.query(
      `insert into app.pending_run_tasks(id,workspace_id,run_id,workflow_version_id,invocation_key,kind,config,status,callback_node_id,callback_scope,callback_scope_hash,callback_token_hash,callback_key_version) select $1,$2,$3,workflow_version_id,$4,'callback',$5::jsonb,'prepared',$6,$7::jsonb,$8,$9,$10 from app.workflow_runs where workspace_id=$2 and id=$3`,
      [
        id,
        input.workspaceId,
        input.runId,
        `callback:${target.nodeId}:${scopeHash}`,
        JSON.stringify(target.config),
        target.nodeId,
        JSON.stringify(iteration),
        scopeHash,
        tokenHash,
        input.keyVersion,
      ],
    );
    result.push({
      ...identity,
      id,
      keyVersion: input.keyVersion,
      tokenHash,
      config: target.config,
    });
  }
  await assertCapabilityExecution(client, input);
  return result;
}
