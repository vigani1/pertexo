import { Pool, type PoolClient } from 'pg';

import { adminBaseUrl, migrationBaseUrl, databaseUrl } from './context.js';

export async function waitForApplicationLocks(
  applicationName: string,
  minimum: number,
): Promise<void> {
  const observer = new Pool({
    connectionString: databaseUrl(adminBaseUrl),
    max: 1,
  });
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await observer.query<{ waiting: number }>(
        `select count(*)::int waiting from pg_stat_activity
         where datname=current_database() and application_name=$1
           and wait_event_type='Lock'`,
        [applicationName],
      );
      if ((result.rows[0]?.waiting ?? 0) >= minimum) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(
      `Expected ${String(minimum)} PostgreSQL lock waiters for ${applicationName}`,
    );
  } finally {
    await observer.end();
  }
}

export async function asOwner<T>(
  workspaceId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new Pool({
    connectionString: databaseUrl(migrationBaseUrl),
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    try {
      client.release();
    } finally {
      await pool.end();
    }
  }
}

export async function asAdmin<T>(
  operation: (client: Pool) => Promise<T>,
): Promise<T> {
  const client = new Pool({
    connectionString: databaseUrl(adminBaseUrl),
    max: 1,
  });
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

export async function asRuntime<T>(
  baseUrl: string,
  workspaceId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: databaseUrl(baseUrl), max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    try {
      client.release();
    } finally {
      await pool.end();
    }
  }
}
