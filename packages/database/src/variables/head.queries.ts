import { rethrowQueryFailure } from '../platform/query-errors.js';
import type { PoolClient } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { workspaceVariables } from '../schema/variables.js';
import type { WorkspaceTransaction } from '../tenant-access/transactions.js';
import { readVariableSet } from './values.queries.js';

type HeadLock = 'share' | 'update';

/** Admission holds the head until its immutable reference has been inserted. */
export function captureWorkspaceVariableRevision(
  transaction: WorkspaceTransaction,
): Promise<number | null> {
  return lockHead(transaction.db, transaction.workspaceId, 'share');
}

/** Lock only the mutable head, then read its exact immutable set after any wait. */
export async function lockVariableSet(
  client: PoolClient,
  workspaceId: string,
  lock: HeadLock,
) {
  const db = drizzle(client);
  const revision = await lockHead(db, workspaceId, lock);
  if (revision === null) return null;
  return { revision, ...(await readVariableSet(db, workspaceId, revision)) };
}

export async function lockWorkspaceVariableNames(
  client: PoolClient,
  workspaceId: string,
): Promise<readonly string[]> {
  const set = await lockVariableSet(client, workspaceId, 'share');
  return set === null ? [] : Object.keys(set.values);
}

async function lockHead(
  db: Pick<NodePgDatabase, 'select'>,
  workspaceId: string,
  lock: HeadLock,
): Promise<number | null> {
  const [head] = await db
    .select({ revision: workspaceVariables.revision })
    .from(workspaceVariables)
    .where(eq(workspaceVariables.workspaceId, workspaceId))
    .for(lock)
    .catch(rethrowQueryFailure);
  return head?.revision ?? null;
}
