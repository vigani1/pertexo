import { readFile } from 'node:fs/promises';

import { Pool, type PoolClient } from 'pg';

export function createTransportLedgerSetup(
  context: Readonly<{
    migrationUrl: string;
    workspaceId: string;
    actorId: string;
  }>,
) {
  const { migrationUrl, workspaceId, actorId } = context;
  const applyLedgerFixture = async (): Promise<void> => {
    const source = await readFile(
      new URL(
        '../../../../../packages/core/test/fixtures/queue-duplicate-proof.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const fixture = source
      .replaceAll('{{api_runtime_role}}', 'pertexo_app')
      .replaceAll('{{worker_runtime_role}}', 'pertexo_app');
    const pool = new Pool({ connectionString: migrationUrl, max: 1 });
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query(fixture);
      await client.query(
        `insert into app.users (id,email,display_name)
         values ($1,$2,'Worker transport proof') on conflict (id) do nothing`,
        [actorId, `worker-transport-${actorId}@example.test`],
      );
      await client.query(
        `insert into app.workspaces (id,name,slug,created_by)
         values ($1,'Worker transport proof',$2,$3) on conflict (id) do nothing`,
        [workspaceId, `worker-transport-${workspaceId}`, actorId],
      );
      await client.query('commit');
    } catch (error: unknown) {
      await client?.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client?.release();
      await pool.end();
    }
  };

  return { applyLedgerFixture };
}
