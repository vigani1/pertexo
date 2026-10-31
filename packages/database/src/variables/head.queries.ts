import { rethrowQueryFailure } from '../platform/query-errors.js';
import type { PoolClient } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { workspaceVariables } from '../schema/variables.js';
import type { WorkspaceTransaction } from '../tenant-access/transactions.js';
import { readVariableSetValues } from './values.queries.js';

/** Admission holds the head until its immutable reference has been inserted. */
export function captureWorkspaceVariableRevision(
  transaction: WorkspaceTransaction,
): Promise<number | null> {
  return shareHead(transaction.db, transaction.workspaceId);
}

/** Lock only the mutable head, then read its exact immutable set after any wait. */
export async function lockWorkspaceVariableNames(
  client: PoolClient,
  workspaceId: string,
): Promise<readonly string[]> {
  const db = drizzle(client);
  const revision = await shareHead(db, workspaceId);
  if (revision === null) return [];
  return Object.keys(await readVariableSetValues(db, workspaceId, revision));
}

async function shareHead(
  db: Pick<NodePgDatabase, 'select'>,
  workspaceId: string,
): Promise<number | null> {
  const [head] = await db
    .select({ revision: workspaceVariables.revision })
    .from(workspaceVariables)
    .where(eq(workspaceVariables.workspaceId, workspaceId))
    .for('share')
    .catch(rethrowQueryFailure);
  return head?.revision ?? null;
}
