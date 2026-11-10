import type { WorkflowSummary } from '@pertexo/contracts';
import { workflowDrafts, workflowRuns } from '@pertexo/database/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { decodeStoredValue } from '../../../shared/stored-values.js';
import type { FolderScope } from '../../../shared/folder-access.types.js';
import { workflowScopeSql } from '../../../shared/folder-scope.repository.js';
import { ordinaryRunSql } from '../../../runs/data-policy.js';

type Summary = NonNullable<WorkflowSummary['listSummary']>;

/** Only IDs from the authorized page enter this bounded query. No configuration leaves it. */
export async function readListSummaries(
  client: PoolClient,
  access: FolderScope,
  ids: string[],
) {
  if (ids.length === 0) return new Map<string, Summary>();
  const rows = await drizzle(client)
    .select({
      id: workflowDrafts.workflowId,
      graph: workflowDrafts.graphJson,
      runs: sql<NonNullable<
        Summary['recentRuns']
      > | null>`case when ${workflowScopeSql(access, sql`workflow_drafts.workflow_id`, 'run:read')} then (
      select coalesce(json_agg(recent), '[]'::json) from (
        select workflow_runs.status as status, to_char(workflow_runs.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
        from ${workflowRuns}
        where workflow_runs.workspace_id=workflow_drafts.workspace_id
          and workflow_runs.workflow_id=workflow_drafts.workflow_id
          and ${ordinaryRunSql('workflow_runs')}
        order by workflow_runs.created_at desc, workflow_runs.id desc limit 20
      ) recent
    ) else null end`,
    })
    .from(workflowDrafts)
    .where(
      and(
        eq(workflowDrafts.workspaceId, access.workspaceId),
        inArray(workflowDrafts.workflowId, ids),
      ),
    )
    .catch(rethrowQueryFailure);
  return new Map<string, Summary>(
    rows.map((row) => {
      const graph = decodeStoredValue(() => parseWorkflowGraphDraft(row.graph));
      return [
        row.id,
        {
          shape: {
            nodes: graph.nodes.map(
              ({ id, definition, position, label, structured }) => ({
                id,
                definition,
                position,
                ...(label === undefined ? {} : { label }),
                ...(structured === undefined
                  ? {}
                  : { structured: { kind: structured.kind } }),
              }),
            ),
            edges: graph.edges.map(({ id, source, target }) => ({
              id,
              source,
              target,
            })),
          },
          ...(row.runs == null ? {} : { recentRuns: row.runs }),
        },
      ];
    }),
  );
}
