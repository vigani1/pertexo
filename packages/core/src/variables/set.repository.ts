import { decodeStoredVariableSet } from './stored-variable-set.js';
import type { WorkspaceVariablesResponse } from '@pertexo/contracts';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workspaceVariables,
  workspaceVariableSetRevisions,
} from '@pertexo/database/schema';
import { EMPTY_VARIABLE_SNAPSHOT } from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type { ReplaceWorkspaceVariablesInput } from './workspace-variables.types.js';
import { WorkspaceVariablesConflictError } from './workspace-variables.errors.js';

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
  return row === undefined
    ? { ...EMPTY_VARIABLE_SNAPSHOT, descriptions: {} }
    : { revision: row.revision, ...decodeStoredVariableSet(row) };
}

/** With no head to lock yet, two first saves meet at the revision's primary key. */
export async function saveVariableSet(
  client: PoolClient,
  input: ReplaceWorkspaceVariablesInput,
  set: Readonly<{
    revision: number;
    descriptions: Readonly<Record<string, string>>;
  }>,
): Promise<void> {
  const db = drizzle(client);
  const inserted = await db
    .insert(workspaceVariableSetRevisions)
    .values({
      workspaceId: input.workspaceId,
      revision: set.revision,
      values: input.values,
      descriptions: set.descriptions,
    })
    .onConflictDoNothing()
    .returning({ revision: workspaceVariableSetRevisions.revision })
    .catch(rethrowQueryFailure);
  if (inserted.length !== 1) throw new WorkspaceVariablesConflictError();
  const saved = await db
    .insert(workspaceVariables)
    .values({ workspaceId: input.workspaceId, revision: set.revision })
    .onConflictDoUpdate({
      target: workspaceVariables.workspaceId,
      set: { revision: set.revision, updatedAt: sql`clock_timestamp()` },
      setWhere: eq(workspaceVariables.revision, input.expectedRevision),
    })
    .returning({ revision: workspaceVariables.revision })
    .catch(rethrowQueryFailure);
  if (saved.length !== 1) throw new WorkspaceVariablesConflictError();
}
