import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflows } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { CollaborationScope } from './workflow-collaboration.types.js';

/** Holds the workflow so it can't be deleted under a discussion's writes; false when it is gone. */
export async function lockCollaborationWorkflow(
  client: PoolClient,
  input: CollaborationScope,
  lock: 'share' | 'update',
) {
  const row = await drizzle(client)
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, input.workflowId),
      ),
    )
    .for(lock)
    .catch(rethrowQueryFailure);
  return row.length === 1;
}
