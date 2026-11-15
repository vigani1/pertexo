import { sql, type SQL } from 'drizzle-orm';

/** Follow only declared graph structure; configuration and mapping values are data. */
export function workflowGraphStepSql(graph: SQL, nodeId: SQL): SQL {
  return sql`with recursive graph_nodes(value) as (
    select value from jsonb_array_elements((${graph})::jsonb->'nodes') entry(value)
    union all
    select child.value from graph_nodes parent
      cross join lateral jsonb_array_elements(parent.value#>'{structured,body,nodes}') child(value)
  ) select value from graph_nodes where value->>'id'=${nodeId} limit 1`;
}
