import type { Pool } from 'pg';

function quoteIdentifier(value: string): string {
  if (value.length === 0 || value.includes('\0'))
    throw new Error('Disposable database name is invalid');
  return `"${value.replaceAll('"', '""')}"`;
}

export async function dropDisconnectedDatabase(
  admin: Pool,
  databaseName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await admin.query<{ connections: number }>(
      `select count(*)::int connections from pg_stat_activity
        where datname=$1 and pid<>pg_backend_pid()`,
      [databaseName],
    );
    if (result.rows[0]?.connections === 0) {
      await admin.query(
        `drop database if exists ${quoteIdentifier(databaseName)}`,
      );
      return;
    }
    await admin.query('select pg_sleep(0.02)');
  }
  throw new Error(`Disposable database still has clients: ${databaseName}`);
}
