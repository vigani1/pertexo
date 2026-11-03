import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { workflowRuns } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

export function resolveCallback(pool: Pool, tokenHash: string) {
  // The retained privacy guard returns the captured callback identity, never a table row.
  return drizzle(pool)
    .select({
      id: sql<string>`resolved.id`,
      workspace_id: sql<string>`resolved.workspace_id`,
      run_id: sql<string>`resolved.run_id`,
      callback_node_id: sql<string>`resolved.callback_node_id`,
      callback_scope_hash: sql<string>`resolved.callback_scope_hash`,
      callback_token_hash: sql<string>`resolved.callback_token_hash`,
      callback_key_version: sql<string>`resolved.callback_key_version`,
      config: sql<unknown>`resolved.config`,
      database_time: sql<Date>`resolved.database_time`.mapWith(
        workflowRuns.createdAt,
      ),
    })
    .from(
      sql`app.resolve_public_pending_callback(${tokenHash}::char(64)) resolved`,
    )
    .catch(rethrowQueryFailure);
}
export function callbackKeysInUse(pool: Pool, after: string | null) {
  return drizzle(pool)
    .select({
      id: sql<string>`inventory.id`,
      keyVersion: sql<string>`inventory.callback_key_version`,
      tokenHash: sql<string>`inventory.callback_token_hash`,
    })
    .from(sql`app.pending_callback_key_inventory(${after}::text) inventory`)
    .catch(rethrowQueryFailure);
}
