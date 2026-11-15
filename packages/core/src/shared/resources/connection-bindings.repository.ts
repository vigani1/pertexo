import { and, sql } from 'drizzle-orm';
import { connections } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { connectionReferenceIds } from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import {
  connectionScopeSql,
  type ConnectionScope,
} from './connection-scope.repository.js';

export {
  workflowConnectionReferences,
  connectionReferenceIds,
} from '@pertexo/workflow-model';

/** The source is checked before a new reference can authorize any use of it. */
export async function connectionUseIssues(
  transaction: Pick<WorkspaceTransaction, 'db'>,
  scope: ConnectionScope,
  references: readonly { id: string; path: string }[],
  locking: 'share' | 'none' = 'none',
) {
  if (references.length === 0) return [];
  const ids = connectionReferenceIds(references);
  const query = transaction.db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        sql`${connections.id}=any(${sql.param(ids)}::uuid[])`,
        connectionScopeSql(scope, connections),
      ),
    )
    .orderBy(connections.id);
  const allowed =
    ids.length === 0
      ? []
      : await (locking === 'share' ? query.for('share') : query).catch(
          rethrowQueryFailure,
        );
  const permitted = new Set(allowed.map((row) => row.id));
  const issues = references
    .filter((reference) => !permitted.has(reference.id.toLowerCase()))
    .map((reference) => ({
      code: 'invalid_graph' as const,
      path: reference.path,
      message:
        'This connection is unavailable. Choose a connection you can use.',
    }));
  return issues;
}
