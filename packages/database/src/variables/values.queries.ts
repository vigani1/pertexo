import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { EMPTY_VARIABLE_SNAPSHOT } from '@pertexo/workflow-model';
import { and, eq } from 'drizzle-orm';
import { workspaceVariableSetRevisions } from '../schema/variables.js';

/** Callable completion reads values lazily, rather than on every coordinator advance. */
export async function readVariableSetValues(
  db: Pick<NodePgDatabase, 'select'>,
  workspaceId: string,
  revision: number | null,
) {
  if (revision === null) return EMPTY_VARIABLE_SNAPSHOT.values;
  const [stored] = await db
    .select({ values: workspaceVariableSetRevisions.values })
    .from(workspaceVariableSetRevisions)
    .where(
      and(
        eq(workspaceVariableSetRevisions.workspaceId, workspaceId),
        eq(workspaceVariableSetRevisions.revision, revision),
      ),
    );
  if (stored === undefined)
    throw new Error('Workspace variable revision is missing');
  return stored.values;
}
