import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import {
  acceptWorkflowRun,
  type AcceptWorkflowRunInput,
  type WorkspaceTransaction,
} from '@pertexo/database/testing';

/** Keep worker admission fixtures on the same actor/key protocol as manual API writers. */
export async function acceptManualFixtureRun(
  transaction: WorkspaceTransaction,
  actorId: string,
  input: AcceptWorkflowRunInput,
) {
  if (input.triggerType !== 'manual')
    throw new Error('Manual fixture admission requires a manual trigger');
  const scope = `workflow:${input.workflowId}:manual`;
  if (input.scope !== scope)
    throw new Error(
      'Manual fixture command identity must match the canonical scope',
    );
  await transaction.db.execute(
    sql`select set_config('app.actor_id',${actorId},true)`,
  );
  await transaction.db.execute(sql`select app.lock_manual_workflow_run_start(
    ${actorId}::uuid,${input.workflowId}::uuid,${scope},${input.keyHash})`);
  return acceptWorkflowRun(transaction, input);
}

/** Direct state fixtures still acquire real authority/key locks in their insertion transaction. */
export async function lockManualFixtureClient(
  client: PoolClient,
  actorId: string,
  workflowId: string,
  keyHash: string,
): Promise<void> {
  await client.query("select set_config('app.actor_id',$1,true)", [actorId]);
  await client.query('select app.lock_manual_workflow_run_start($1,$2,$3,$4)', [
    actorId,
    workflowId,
    `workflow:${workflowId}:manual`,
    keyHash,
  ]);
}
