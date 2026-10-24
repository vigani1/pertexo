import { rethrowQueryFailure } from '../platform/query-errors.js';
import { and, eq, exists, gt, gte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import {
  workflows,
  workflowDrafts,
  workflowVersions,
} from '../schema/authoring/workflows.js';
import { readFolderScope } from '../tenant-access/resources/facts.queries.js';
import { workflowScopeSql } from '../tenant-access/resources/scope.queries.js';
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
  const workflow = await readUsageWorkflow(client, input);
  if (workflow === undefined)
    return { items: [], next: null, incomplete: false };
  const stamp = variableUsageDigest([
    workflow.draftRevision,
    workflow.versionId,
  ]);
  const offset = cursor?.offset ?? 0;
  const staleCursor =
    offset > 0 &&
    (cursor?.workflowId !== workflow.id || cursor.stamp !== stamp);
  if (staleCursor) throw new WorkspaceVariableUsageChangedError();
  return scanVariableUsage(workflow, input, { offset, stamp });
}

async function readUsageWorkflow(
  client: PoolClient,
  input: Parameters<WorkspaceVariablesStore['usage']>[0],
) {
  const cursor = input.after;
  const resources = await readFolderScope(client, input);
  const db = drizzle(client);
  const later = alias(workflows, 'later');
  const [workflow] = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      lifecycleStatus: workflows.lifecycleStatus,
      draftRevision: workflowDrafts.revision,
      draftGraph: workflowDrafts.graphJson,
      versionId: workflowVersions.id,
      publishedGraph: workflowVersions.graphJson,
      hasMore: exists(
        db
          .select({ id: later.id })
          .from(later)
          .where(
            and(
              eq(later.workspaceId, workflows.workspaceId),
              gt(later.id, workflows.id),
              workflowScopeSql(resources, sql`${later.id}`),
            ),
          ),
      ),
    })
    .from(workflows)
    .leftJoin(
      workflowDrafts,
      and(
        eq(workflowDrafts.workspaceId, workflows.workspaceId),
        eq(workflowDrafts.workflowId, workflows.id),
      ),
    )
    .leftJoin(
      workflowVersions,
      and(
        eq(workflowVersions.workspaceId, workflows.workspaceId),
        eq(workflowVersions.workflowId, workflows.id),
        eq(workflowVersions.id, workflows.publishedVersionId),
      ),
    )
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        workflowScopeSql(resources, sql`${workflows.id}`),
        afterWorkflow(cursor),
      ),
    )
    .orderBy(workflows.id)
    .limit(1)
    .catch(rethrowQueryFailure);
  return workflow;
}
type VariableUsageRow = NonNullable<
  Awaited<ReturnType<typeof readUsageWorkflow>>
>;
function variableUsageDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function scanVariableUsage(
  workflow: VariableUsageRow,
  input: Parameters<WorkspaceVariablesStore['usage']>[0],
  { offset, stamp }: Readonly<{ offset: number; stamp: string }>,
): Awaited<ReturnType<WorkspaceVariablesStore['usage']>> {
  let incomplete = false,
    position = 0,
    scanned = 0,
    bytes = 0;
  let next: { workflowId: string; offset: number; stamp: string } | null =
    workflow.hasMore ? { workflowId: workflow.id, offset: 0, stamp } : null;
  const items = [];
  scan: for (const [stage, graph] of [
    ['draft', workflow.draftGraph],
    ['published', workflow.publishedGraph],
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
          id: variableUsageDigest([
            stage,
            stage === 'draft' ? workflow.draftRevision : workflow.versionId,
            ordinal,
          ]),
          workflowId: workflow.id,
          workflowName: workflow.name.slice(0, 160),
          archived: workflow.lifecycleStatus === 'archived',
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

function afterWorkflow(
  cursor: Parameters<WorkspaceVariablesStore['usage']>[0]['after'],
) {
  if (cursor === undefined) return undefined;
  return cursor.offset > 0
    ? gte(workflows.id, cursor.workflowId)
    : gt(workflows.id, cursor.workflowId);
}
