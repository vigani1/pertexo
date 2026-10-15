import type { PoolClient } from 'pg';
import { eq } from 'drizzle-orm';
import {
  EMPTY_VARIABLE_SNAPSHOT,
  workspaceVariableSnapshotSchema,
  type WorkspaceVariableSnapshot,
} from '@pertexo/workflow-model';
import { workspaceVariables } from '../schema/variables.js';
import type { WorkspaceTransaction } from '../tenant-access/transactions.js';
/** Admission and settings share the same current-set projection. A missing row is an untouched workspace. */
export async function readWorkspaceVariables(
  transaction: WorkspaceTransaction,
): Promise<WorkspaceVariableSnapshot> {
  const [row] = await transaction.db
    .select({
      revision: workspaceVariables.revision,
      values: workspaceVariables.values,
    })
    .from(workspaceVariables)
    .where(eq(workspaceVariables.workspaceId, transaction.workspaceId))
    .limit(1);
  return row === undefined
    ? EMPTY_VARIABLE_SNAPSHOT
    : workspaceVariableSnapshotSchema.parse(row);
}

/** A publication must keep its checked names current until it commits. */
export async function lockWorkspaceVariableNames(
  client: PoolClient,
  workspaceId: string,
): Promise<readonly string[]> {
  const found = await client.query<{ names: string[] }>(
    `select array(select jsonb_object_keys(values_json)) names
     from app.workspace_variables where workspace_id=$1 for share`,
    [workspaceId],
  );
  return found.rows[0]?.names ?? [];
}
