import {
  readBrowsableFolderScope,
  rethrowQueryFailure,
  workflowScopeSql,
} from '@pertexo/database/primitives';
import {
  workflows,
  workflowDrafts,
  workflowVersions,
} from '@pertexo/database/schema';
import { and, eq, exists, gt, gte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';

import type { VariableUsageInput, VariableUsagePage } from './contract.js';
import { scanVariableUsage } from './usage-scan.js';

export async function readVariableUsage(
  client: PoolClient,
  input: VariableUsageInput,
): Promise<VariableUsagePage> {
  const workflow = await readUsageWorkflow(client, input);
  if (workflow === undefined)
    return { items: [], next: null, incomplete: false };
  return scanVariableUsage(workflow, input);
}

/** The next visible workflow: a page never spans two, which bounds its graphs. */
async function readUsageWorkflow(
  client: PoolClient,
  input: VariableUsageInput,
) {
  const resources = await readBrowsableFolderScope(client, input);
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
      ).mapWith(Boolean),
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
        afterWorkflow(input.after),
      ),
    )
    .orderBy(workflows.id)
    .limit(1)
    .catch(rethrowQueryFailure);
  return workflow;
}

/** A partly scanned workflow is read again; a finished one is passed. */
function afterWorkflow(cursor: VariableUsageInput['after']) {
  if (cursor === undefined) return undefined;
  return cursor.offset > 0
    ? gte(workflows.id, cursor.workflowId)
    : gt(workflows.id, cursor.workflowId);
}
