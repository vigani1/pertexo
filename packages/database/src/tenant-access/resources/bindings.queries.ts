import type { PoolClient } from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import {
  canonicalJson,
  InvalidWorkflowGraphError,
  isWorkflowCallDefinition,
  workflowCallConfigSchema,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflows } from '../../schema/authoring/workflows.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { readFolderScope } from './facts.queries.js';
import { workflowScopeSql } from './scope.queries.js';
import type { ResourceActor } from './contract.js';

function callTargets(graph: WorkflowGraph): Map<string, string> {
  const targets = new Map<string, string>();
  const pending: { graph: WorkflowGraph; path: readonly string[] }[] = [
    { graph, path: [] },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const node of current.graph.nodes) {
      if (isWorkflowCallDefinition(node.definition)) {
        // Incomplete draft configuration is not an executable binding yet.
        const parsed = workflowCallConfigSchema.safeParse(node.config);
        if (parsed.success)
          targets.set(
            canonicalJson([
              [...current.path, node.id],
              node.definition,
              parsed.data.target,
            ]),
            parsed.data.target.workflowId,
          );
      }
      if (node.structured !== undefined)
        pending.push({
          graph: node.structured.body,
          path: [...current.path, node.id],
        });
    }
  }
  return targets;
}

/** Only direct bindings are admitted; immutable child versions delegate their own closure. */
export async function requireWorkflowCallTargets(
  client: PoolClient,
  actor: ResourceActor,
  graph: WorkflowGraph,
  previous?: WorkflowGraph,
): Promise<void> {
  const existing =
    previous === undefined ? new Map<string, string>() : callTargets(previous);
  const targets = [
    ...new Set(
      [...callTargets(graph)]
        .filter(([key]) => !existing.has(key))
        .map(([, id]) => id),
    ),
  ];
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
