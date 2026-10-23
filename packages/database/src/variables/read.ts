import type { PoolClient } from 'pg';
import type { WorkspaceVariablesResponse } from '@pertexo/contracts';
import { and, eq } from 'drizzle-orm';
import { EMPTY_VARIABLE_SNAPSHOT } from '@pertexo/workflow-model';
import {
  workspaceVariables,
  workspaceVariableSetRevisions,
} from '../schema/variables.js';
import type { WorkspaceTransaction } from '../tenant-access/transactions.js';
/** Settings read one committed head/set view; a missing head is an untouched workspace. */
export async function readWorkspaceVariables(
  transaction: WorkspaceTransaction,
): Promise<WorkspaceVariablesResponse> {
  const [row] = await transaction.db
    .select({
      revision: workspaceVariables.revision,
      values: workspaceVariableSetRevisions.values,
      descriptions: workspaceVariableSetRevisions.descriptions,
    })
    .from(workspaceVariables)
    .innerJoin(
      workspaceVariableSetRevisions,
      and(
        eq(
          workspaceVariableSetRevisions.workspaceId,
          workspaceVariables.workspaceId,
        ),
        eq(workspaceVariableSetRevisions.revision, workspaceVariables.revision),
      ),
    )
    .where(eq(workspaceVariables.workspaceId, transaction.workspaceId))
    .limit(1);
  return row ?? { ...EMPTY_VARIABLE_SNAPSHOT, descriptions: {} };
}

/** Admission holds the head until its immutable reference has been inserted. */
export async function captureWorkspaceVariableRevision(
  transaction: WorkspaceTransaction,
): Promise<number | null> {
  const [row] = await transaction.db
    .select({ revision: workspaceVariables.revision })
    .from(workspaceVariables)
    .where(eq(workspaceVariables.workspaceId, transaction.workspaceId))
    .limit(1)
    .for('share');
  return row?.revision ?? null;
}

/** Lock only the mutable head, then read its exact immutable set after any wait. */
export async function lockWorkspaceVariableNames(
  client: PoolClient,
  workspaceId: string,
): Promise<readonly string[]> {
  const head = await client.query<{ revision: number }>(
    'select revision from app.workspace_variables where workspace_id=$1 for share',
    [workspaceId],
  );
  const revision = head.rows[0]?.revision;
  if (revision === undefined) return [];
  const found = await client.query<{ names: string[] }>(
    `select array(select jsonb_object_keys(values_json)) names
     from app.workspace_variable_set_revisions where workspace_id=$1 and revision=$2`,
    [workspaceId, revision],
  );
  const row = found.rows[0];
  if (row === undefined)
    throw new Error('Workspace variable revision is missing');
  return row.names;
}
