import { and, eq, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowVersions } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

/** Follow only declared graph structure; configuration and mapping values are data. */
export function workflowGraphStepSql(graph: SQL, nodeId: SQL): SQL {
  return sql`with recursive graph_nodes(value) as (
    select value from jsonb_array_elements((${graph})::jsonb->'nodes') entry(value)
    union all
    select child.value from graph_nodes parent
      cross join lateral jsonb_array_elements(parent.value#>'{structured,body,nodes}') child(value)
  ) select value from graph_nodes where value->>'id'=${nodeId} limit 1`;
}

export async function readPublishedStepLabel(
  client: PoolClient,
  {
    workspaceId,
    workflowVersionId,
    nodeId,
  }: Readonly<{
    workspaceId: string;
    workflowVersionId: string;
    nodeId: string;
  }>,
): Promise<string> {
  const graph = workflowGraphStepSql(
    sql`${workflowVersions.graphJson}`,
    sql`${nodeId}::text`,
  );
  const [row] = await drizzle(client)
    .select({
      label: sql<string | null>`nullif(btrim(graph_node.value->>'label'), '')`,
    })
    .from(workflowVersions)
    .leftJoinLateral(sql`(${graph}) as graph_node`, sql`true`)
    .where(
      and(
        eq(workflowVersions.workspaceId, workspaceId),
        eq(workflowVersions.id, workflowVersionId),
      ),
    )
    .catch(rethrowQueryFailure);
  return row?.label ?? nodeId;
}
