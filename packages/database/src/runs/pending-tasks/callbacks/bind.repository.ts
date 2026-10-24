import type { PoolClient } from 'pg';
import type { PendingTaskIntent } from '@pertexo/workflow-engine';
import { CoordinatorRunStateCorruptError } from '../../advance/contract.js';
import { callbackScopeHash } from './identity.repository.js';

export async function bindCallbackTask(
  client: PoolClient,
  workspaceId: string,
  {
    runId,
    intent,
    closed,
  }: Readonly<{
    runId: string;
    intent: Extract<PendingTaskIntent, { kind: 'callback' }>;
    closed: boolean;
  }>,
): Promise<Readonly<{ id: string; expires_at: Date; status: string }>> {
  const node = await client.query<{
    id: string;
    node_id: string;
    branch_context: Readonly<{ iterationPath?: unknown }>;
  }>(
    `select id,node_id,branch_context from app.node_runs where workspace_id=$1 and workflow_run_id=$2 and invocation_key=$3 and status='succeeded'`,
    [workspaceId, runId, intent.invocationKey],
  );
  const owner = node.rows[0];
  if (owner === undefined) throw new CoordinatorRunStateCorruptError();
  const updated = await client.query<{
    id: string;
    expires_at: Date;
    status: string;
  }>(
    `update app.pending_run_tasks set node_run_id=$6,invocation_key=$3,opened_at=observed.time,expires_at=observed.time+make_interval(secs=>$7),status=case when $8 then 'canceled' when status='prepared' then 'pending' else status end,output_ref=case when $8 then null else output_ref end,completed_at=case when $8 then coalesce(completed_at,observed.time) else completed_at end from (select clock_timestamp() time) observed where workspace_id=$1 and run_id=$2 and callback_node_id=$4 and callback_scope_hash=$5 and node_run_id is null and status in ('prepared','submitted') returning id,expires_at,status`,
    [
      workspaceId,
      runId,
      intent.invocationKey,
      owner.node_id,
      callbackScopeHash(owner.branch_context.iterationPath ?? []),
      owner.id,
      intent.config.timeoutSeconds,
      closed,
    ],
  );
  const row = updated.rows[0];
  if (row === undefined) throw new CoordinatorRunStateCorruptError();
  return row;
}
