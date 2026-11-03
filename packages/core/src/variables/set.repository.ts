import type { WorkspaceVariablesResponse } from '@pertexo/contracts';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workspaceVariables,
  workspaceVariableSetRevisions,
} from '@pertexo/database/schema';
import { EMPTY_VARIABLE_SNAPSHOT } from '@pertexo/workflow-model';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

/** Settings read one committed head/set view; a missing head is an untouched workspace. */
export async function readWorkspaceVariables(
  client: PoolClient,
  workspaceId: string,
): Promise<WorkspaceVariablesResponse> {
  const [row] = await drizzle(client)
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
    .where(eq(workspaceVariables.workspaceId, workspaceId))
    .catch(rethrowQueryFailure);
  return row ?? { ...EMPTY_VARIABLE_SNAPSHOT, descriptions: {} };
}
