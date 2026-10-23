import { Pool, type PoolClient } from 'pg';

import { ownerRole } from './environment.js';

export async function archiveWorkflow(
  workspaceId: string,
  workflowId: string,
): Promise<void> {
  await withOwnerWorkspace(workspaceId, (client) =>
    client.query(
      `update app.workflows set lifecycle_status='archived' where id=$1`,
      [workflowId],
    ),
  );
}

export async function withOwnerWorkspace(
  workspaceId: string,
  work: (client: PoolClient) => Promise<unknown>,
): Promise<void> {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_MIGRATION_URL ??
      'postgresql://invalid:invalid@localhost/invalid',
    max: 1,
  });
  try {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role "${ownerRole.replaceAll('"', '""')}"`);
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await work(client);
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
