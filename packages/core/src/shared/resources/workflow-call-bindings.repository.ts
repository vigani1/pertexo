import type { Role } from '@pertexo/policy';
import type { PoolClient } from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflows } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { readFolderScope } from '../access/folder-access-facts.repository.js';
import { workflowScopeSql } from '../access/folder-scope.repository.js';
import type { ResourceActor } from '../access/folder-access.types.js';

/** How many of `targets` the actor's folder scope lets it read. */
export async function countReadableWorkflows(
  client: PoolClient,
  actor: ResourceActor,
  targets: readonly string[],
  role?: Role | null,
): Promise<number> {
  const scope = await readFolderScope(client, actor, role);
  const found = await drizzle(client)
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, actor.workspaceId),
        sql`${workflows.id}=any(${sql.param(targets)}::uuid[])`,
        workflowScopeSql(scope, sql`${workflows.id}`),
      ),
    )
    .catch(rethrowQueryFailure);
  return found.length;
}
