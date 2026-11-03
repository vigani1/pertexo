import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { EMPTY_VARIABLE_SNAPSHOT } from '@pertexo/workflow-model';
import { and, eq } from 'drizzle-orm';
import { workspaceVariableSetRevisions } from '@pertexo/database/schema';

/** Callable completion reads values lazily, rather than on every coordinator advance. */
export async function readVariableSetValues(
  db: Pick<NodePgDatabase, 'select'>,
  workspaceId: string,
  revision: number | null,
) {
  if (revision === null) return EMPTY_VARIABLE_SNAPSHOT.values;
  return (await readVariableSet(db, workspaceId, revision)).values;
}

export async function readVariableSet(
  db: Pick<NodePgDatabase, 'select'>,
  workspaceId: string,
  revision: number,
) {
  const [stored] = await db
    .select({
      values: workspaceVariableSetRevisions.values,
      descriptions: workspaceVariableSetRevisions.descriptions,
    })
    .from(workspaceVariableSetRevisions)
    .where(
      and(
        eq(workspaceVariableSetRevisions.workspaceId, workspaceId),
        eq(workspaceVariableSetRevisions.revision, revision),
      ),
    )
    .catch(rethrowQueryFailure);
  if (stored === undefined)
    throw new Error('Workspace variable revision is missing');
  return stored;
}
