import type { Pool } from 'pg';
import type { PoolClient } from 'pg';

import { ownerRole, workflowLifecycleDatabaseConfig } from './environment.js';

export async function withOwnerClient<T>(
  ownerPool: Pool,
  workspaceId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role "${ownerRole.replaceAll('"', '""')}"`);
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function withApiClient<T>(
  apiPool: Pool,
  workspaceId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await apiPool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function databaseUrl(base: string, databaseName: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function databaseNameFromUrl(): string {
  const value = workflowLifecycleDatabaseConfig.connectionString;
  return new URL(value).pathname.slice(1);
}
