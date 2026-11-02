import { createDatabaseRuntime } from '@pertexo/database/platform';
import { Pool, type PoolClient } from 'pg';
import { vi } from 'vitest';

type Statement = string | { text: string; rowMode?: 'array' };
type Answer = { rows: unknown[]; rowCount?: number };

export const CONNECTION = {
  connectionString: 'postgresql://invalid.invalid/pertexo',
  connectionTimeoutMillis: 1000,
  idleTimeoutMillis: 1000,
  max: 1,
  ownerRole: 'pertexo_owner',
} as const;

const textOf = (statement: Statement) =>
  (typeof statement === 'string' ? statement : statement.text).replaceAll(
    '"',
    '',
  );

/**
 * Checks out a client that answers the transaction's own statements and passes an
 * owner's authority, so a flow's statements reach `query` through the real store.
 */
export function authorizedCheckout(
  query: (statement: Statement) => Promise<Answer>,
  { workspaceId, actorId }: Readonly<{ workspaceId: string; actorId: string }>,
) {
  let transaction = false;
  const answered = vi.fn((statement: Statement): Promise<Answer> => {
    const sql = textOf(statement);
    if (sql === 'begin') transaction = true;
    if (sql === 'commit' || sql === 'rollback') transaction = false;
    if (sql.startsWith("select current_setting('app.workspace_id'"))
      return Promise.resolve({
        rows: [
          {
            workspace_id: transaction ? workspaceId : null,
            actor_id: transaction ? actorId : null,
            discovery_scope: null,
            statement_timeout_millis: 30000,
          },
        ],
      });
    const arrays =
      typeof statement !== 'string' && statement.rowMode === 'array';
    if (
      arrays &&
      sql.includes('for share') &&
      /from app\.(workspaces|users|workspace_memberships)\b/u.test(sql)
    ) {
      const rows = [sql.includes('workspace_memberships') ? ['owner'] : [1]];
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    if (arrays && sql.includes('from app.workflow_folders'))
      return Promise.resolve({ rows: [], rowCount: 0 });
    if (arrays || sql.includes('pg_settings')) return query(statement);
    return Promise.resolve({ rows: [] });
  });
  // The promise-only checkout tenant transactions use, not pg's callback overload.
  const checkout = Pool.prototype as unknown as {
    connect(): Promise<PoolClient>;
  };
  const connect = vi.spyOn(checkout, 'connect').mockResolvedValue({
    query: answered,
    release: vi.fn(),
  } as unknown as PoolClient);
  // Lock-wait monitoring would check out through the callback overload and hang.
  const runtime = createDatabaseRuntime(CONNECTION, {
    monitorLockWaits: false,
  });
  return {
    connect,
    query: answered,
    runtime,
    restore: async () => {
      await runtime.close();
      connect.mockRestore();
    },
  };
}
