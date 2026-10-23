import { Pool } from 'pg';

import { expect, it } from 'vitest';

import { apiUrl, workspaceA, recordA } from './fixture.js';

export function registerClearsTransactionLocalContextBefore(): void {
  it('clears transaction-local context before the same client is reused', async () => {
    const pool = new Pool({ connectionString: apiUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const scoped = await client.query<{ id: string }>(
        'select id from app.rls_probe_records',
      );
      expect(scoped.rows.some((row) => row.id === recordA)).toBe(true);
      await client.query('commit');

      await client.query('begin');
      const context = await client.query<{ workspace_id: string }>(
        "select current_setting('app.workspace_id', true) as workspace_id",
      );
      const unscoped = await client.query(
        'select id from app.rls_probe_records',
      );
      await client.query('commit');

      expect(context.rows[0]?.workspace_id ?? '').toBe('');
      expect(unscoped.rows).toEqual([]);

      await client.query('begin');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      await client.query('rollback');
      await client.query('begin');
      const afterRollback = await client.query<{ workspace_id: string }>(
        "select current_setting('app.workspace_id', true) as workspace_id",
      );
      const rollbackUnscoped = await client.query(
        'select id from app.rls_probe_records',
      );
      await client.query('commit');

      expect(afterRollback.rows[0]?.workspace_id ?? '').toBe('');
      expect(rollbackUnscoped.rows).toEqual([]);
    } finally {
      client.release();
      await pool.end();
    }
  });
}
