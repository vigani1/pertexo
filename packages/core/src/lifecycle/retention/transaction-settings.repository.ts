import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

/** Writes and counters in a maintenance transaction belong to this workspace. */
export async function scopeToWorkspace(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await drizzle(client)
    .execute(sql`select set_config('app.workspace_id',${workspaceId},true)`)
    .catch(rethrowQueryFailure);
}

/** How long this transaction waits for any lock before it fails. */
export async function setLockTimeout(
  client: PoolClient,
  lockTimeoutMs: number,
): Promise<void> {
  await drizzle(client)
    .execute(
      sql`select set_config('lock_timeout',${`${String(lockTimeoutMs)}ms`},true)`,
    )
    .catch(rethrowQueryFailure);
}
