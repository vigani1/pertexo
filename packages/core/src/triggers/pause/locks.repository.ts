import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

/** Workspace settings exclude folds and workflow commands, which share this key. */
export async function lockAutoPauseWorkspace(
  client: PoolClient,
  workspaceId: string,
  exclusive: boolean,
) {
  const key = `auto-pause-workspace:${workspaceId}`;
  await drizzle(client)
    .execute(
      exclusive
        ? sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`
        : sql`select pg_advisory_xact_lock_shared(hashtextextended(${key},0))`,
    )
    .catch(rethrowQueryFailure);
}

/** The evaluator, resume and workflow settings serialize before taking the workflow row. */
export async function lockAutoPauseWorkflow(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
) {
  await drizzle(client)
    .execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`auto-pause-workflow:${workspaceId}:${workflowId}`},0))`,
    )
    .catch(rethrowQueryFailure);
}
