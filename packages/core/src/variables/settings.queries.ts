import type { WorkspaceVariablesResponse } from '@pertexo/contracts';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import {
  workspaceVariables,
  workspaceVariableSetRevisions,
} from '@pertexo/database/schema';
import { EMPTY_VARIABLE_SNAPSHOT } from '@pertexo/workflow-model';
import { and, eq } from 'drizzle-orm';

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
