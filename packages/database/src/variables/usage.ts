import { sql } from 'drizzle-orm';
import { readFolderScope } from '../tenant-access/resources/facts.js';
import {
  bindResourcePredicate,
  workflowScopeSql,
} from '../tenant-access/resources/query-scope.js';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import {
  workflowVariableSources,
  inspectWorkflowVariableSource,
} from '@pertexo/workflow-model/server';
import {
  WorkspaceVariableUsageChangedError,
  type WorkspaceVariablesStore,
} from './contract.js';
const MAX_SOURCES_PER_PAGE = 100;
const MAX_SOURCE_BYTES_PER_PAGE = 65_536;
export async function readVariableUsage(
  client: PoolClient,
  input: Parameters<WorkspaceVariablesStore['usage']>[0],
): ReturnType<WorkspaceVariablesStore['usage']> {
  const cursor = input.after;
  const resources = await readFolderScope(client, input);
  const parameters: unknown[] = [
    input.workspaceId,
    cursor?.workflowId ?? null,
    cursor?.offset ?? 0,
  ];
  const visible = bindResourcePredicate(
    workflowScopeSql(resources, sql`workflow.id`),
    parameters,
  );
  const laterVisible = bindResourcePredicate(
    workflowScopeSql(resources, sql`later.id`),
    parameters,
  );
  const found = await client.query<{
    id: string;
    name: string;
    lifecycle_status: string;
    draft_revision: number | null;
    draft_graph: unknown;
    version_id: string | null;
    published_graph: unknown;
    has_more: boolean;
  }>(
    `select workflow.id,workflow.name,workflow.lifecycle_status,draft.revision draft_revision,draft.graph_json draft_graph,version.id version_id,version.graph_json published_graph,
 exists(select 1 from app.workflows later where later.workspace_id=workflow.workspace_id and later.id>workflow.id and ${laterVisible}) has_more
 from app.workflows workflow left join app.workflow_drafts draft on draft.workspace_id=workflow.workspace_id and draft.workflow_id=workflow.id
 left join app.workflow_versions version on version.workspace_id=workflow.workspace_id and version.workflow_id=workflow.id and version.id=workflow.published_version_id
 where workflow.workspace_id=$1 and ${visible} and ($2::uuid is null or (case when $3>0 then workflow.id>=$2::uuid else workflow.id>$2::uuid end)) order by workflow.id limit 1`,
    parameters,
  );
  const workflow = found.rows[0];
  if (workflow === undefined)
    return { items: [], next: null, incomplete: false };
  const digest = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const stamp = digest([workflow.draft_revision, workflow.version_id]);
  const offset = cursor?.offset ?? 0;
  const staleCursor =
    offset > 0 &&
    (cursor?.workflowId !== workflow.id || cursor.stamp !== stamp);
  if (staleCursor) throw new WorkspaceVariableUsageChangedError();
  let incomplete = false,
    position = 0,
    scanned = 0,
    bytes = 0;
  let next: { workflowId: string; offset: number; stamp: string } | null =
    workflow.has_more ? { workflowId: workflow.id, offset: 0, stamp } : null;
  const items = [];
  scan: for (const [stage, graph] of [
    ['draft', workflow.draft_graph],
    ['published', workflow.published_graph],
  ] as const) {
    if (graph === null) continue;
    for (const entry of workflowVariableSources(
      parseWorkflowGraphDraft(graph),
    )) {
      const ordinal = position++;
      if (ordinal < offset) continue;
      const pageBudgetReached =
        items.length >= input.limit ||
        scanned >= MAX_SOURCES_PER_PAGE ||
        (scanned > 0 && bytes + entry.costBytes > MAX_SOURCE_BYTES_PER_PAGE);
      if (pageBudgetReached) {
        next = { workflowId: workflow.id, offset: ordinal, stamp };
        break scan;
      }
      scanned++;
      bytes += entry.costBytes;
      const inspected = inspectWorkflowVariableSource(entry);
      incomplete ||= inspected.incomplete;
      const reference = inspected.reference;
      const referencesVariable =
        reference !== null &&
        (reference.dynamic || reference.names.includes(input.name));
      if (referencesVariable)
        items.push({
          id: digest([
            stage,
            stage === 'draft' ? workflow.draft_revision : workflow.version_id,
            ordinal,
          ]),
          workflowId: workflow.id,
          workflowName: workflow.name.slice(0, 160),
          archived: workflow.lifecycle_status === 'archived',
          stage,
          nodeId: reference.nodeId,
          label: reference.label,
          input: reference.input,
          kind: reference.dynamic ? ('dynamic' as const) : ('direct' as const),
        });
    }
  }
  return { items, incomplete, next };
}
