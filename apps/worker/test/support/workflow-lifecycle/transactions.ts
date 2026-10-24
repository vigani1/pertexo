import type { Pool } from 'pg';
import type { PoolClient } from 'pg';

export function databaseUrl(baseUrl: string, databaseName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function bullConnection(redisUrl: string): {
  db: number;
  host: string;
  password?: string;
  port: number;
} {
  const parsed = new URL(redisUrl);
  return {
    db: Number(parsed.pathname.slice(1) || '0'),
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password === ''
      ? {}
      : { password: decodeURIComponent(parsed.password) }),
  };
}

export async function withTransaction<T>(
  pool: Pool,
  workspaceId: string,
  operation: (client: PoolClient) => Promise<T>,
  role?: string,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (role !== undefined)
      await client.query(`set local role ${quoteIdentifier(role)}`);
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
