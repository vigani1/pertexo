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

/**
 * False when the revision already exists: with no head to lock yet, two first
 * saves meet at the revision's primary key.
 */
export async function insertVariableSetRevision(
  client: PoolClient,
  input: ReplaceWorkspaceVariablesInput,
  set: Readonly<{
    revision: number;
    descriptions: Readonly<Record<string, string>>;
  }>,
): Promise<boolean> {
  const inserted = await drizzle(client)
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
  return inserted.length === 1;
}

/** False when the head moved past the expected revision. */
export async function advanceVariablesHead(
  client: PoolClient,
  input: ReplaceWorkspaceVariablesInput,
  revision: number,
): Promise<boolean> {
  const saved = await drizzle(client)
    .insert(workspaceVariables)
    .values({ workspaceId: input.workspaceId, revision })
    .onConflictDoUpdate({
      target: workspaceVariables.workspaceId,
      set: { revision, updatedAt: sql`clock_timestamp()` },
      setWhere: eq(workspaceVariables.revision, input.expectedRevision),
    })
    .returning({ revision: workspaceVariables.revision })
    .catch(rethrowQueryFailure);
  return saved.length === 1;
}
