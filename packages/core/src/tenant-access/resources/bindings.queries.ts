import type { PoolClient } from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import {
  addedWorkflowCallTargets,
  InvalidWorkflowGraphError,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflows } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { readFolderScope } from '../../shared/facts.queries.js';
import { workflowScopeSql } from '../../shared/scope.queries.js';
import type { ResourceActor } from './contract.js';

/** Only direct bindings are admitted; immutable child versions delegate their own closure. */
export async function requireWorkflowCallTargets(
  client: PoolClient,
  actor: ResourceActor,
  graph: WorkflowGraph,
  previous?: WorkflowGraph,
): Promise<void> {
  const targets = addedWorkflowCallTargets(graph, previous);
  if (targets.length === 0) return;
  const scope = await readFolderScope(client, actor);
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
  if (found.length !== targets.length)
    throw new InvalidWorkflowGraphError([
      {
        code: 'invalid_graph',
        path: '$.nodes',
        message:
          'A Call target is unavailable. Choose a workflow you can read.',
      },
    ]);
}
