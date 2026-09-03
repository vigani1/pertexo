import type { Pool } from 'pg';

export async function queryAsWorkspaceRole<
  Row extends Record<string, unknown>,
>(
  pool: Pool,
  workspaceId: string,
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<readonly Row[]> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await client.query<Row>(statement, [...parameters]);
    await client.query('commit');
    return result.rows;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
