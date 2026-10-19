import type { PoolClient } from 'pg';
import type {
  GraphValidationIssue,
  WorkflowGraph,
} from '@pertexo/workflow-model';
import { CONNECTION_STATUS } from '../../connections/records.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Every chosen connection must still exist in this workspace and not be
 * revoked. Locking the rows keeps a revoke from landing between this check
 * and the version that records them.
 */
export async function connectionReferenceIssues(
  client: PoolClient,
  workspaceId: string,
  graph: WorkflowGraph,
): Promise<readonly GraphValidationIssue[]> {
  const references: { path: string; connectionId: string }[] = [];
  const levels = [{ graph, path: '$' }];
  for (const level of levels)
    for (const node of level.graph.nodes) {
      const path = `${level.path}.nodes.${node.id}`;
      if (node.structured !== undefined)
        levels.push({
          graph: node.structured.body,
          path: `${path}.structured.body`,
        });
      for (const [slot, connectionId] of Object.entries(node.connectionRefs))
        references.push({
          path: `${path}.connectionRefs.${slot}`,
          connectionId,
        });
    }
  if (references.length === 0) return [];
  const ids = [
    ...new Set(
      references
        .map((reference) => reference.connectionId)
        .filter((id) => UUID.test(id)),
    ),
  ];
  const usable = new Set(
    ids.length === 0
      ? []
      : (
          await client.query<{ id: string }>(
            'select id from app.connections where workspace_id=$1 and id=any($2::uuid[]) and status<>$3 order by id for share',
            [workspaceId, ids, CONNECTION_STATUS.revoked],
          )
        ).rows.map((row) => row.id),
  );
  return references
    .filter((reference) => !usable.has(reference.connectionId.toLowerCase()))
    .map((reference) => ({
      code: 'invalid_graph',
      path: reference.path,
      message:
        'This connection was removed or belongs to another workspace. Choose another.',
    }));
}
